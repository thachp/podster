/**
 * Which store holds Runner's keys on this machine (S-47; the architect's ruling of 2026-11-19 for the Linux path, which
 * is also Windows through WSL2). Runner says which in one fixed line.
 *
 * - **macOS:** the login keychain, through `/usr/bin/security`, exactly as before (`keychain.ts`, with its line limit).
 * - **Linux:** the Secret Service, through `/usr/bin/secret-tool` with arguments and never a shell, when it answers;
 *   otherwise a file store under Runner's home (`FileSecretStore`). A WSL2 distro or a server usually has no Secret
 *   Service, so this is what most of them use. The keychain tool's line limit doesn't apply to either.
 * - **Anything else:** no supported store, and Runner refuses.
 *
 * On Linux the choice is made once and remembered in `key-store` in Runner's home, so a Secret Service that is locked
 * or unreachable later is an error, never a quiet switch to an empty file store that would read as "not paired".
 *
 * The file store: one file per item under `keys/`, the folder 0700 and each file 0600, both owned by this user, each
 * named by a hash of the item's name and replaced whole (`writeFileAtomic`). A folder or file with any other mode or
 * owner, or a link, is refused, never repaired. The file store is weaker than a keyring: anyone who can read the owner's
 * files as the owner can read it, as with the provider key file.
 */
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SecretStore } from "../core/storage.js";
import { accountFor, MacKeychain, run, SecretServiceKeychain, SERVICE, type Runner } from "./keychain.js";
import { childEnv } from "./child-env.js";
import { homeRefusal, readMounts } from "./platform.js";
import { ensureFolder, readNoFollow, writeFileAtomic, writeNew } from "./safe-fs.js";

export type KeyStoreKind = "macos_keychain" | "secret_service" | "file";

/** The one line Runner prints for each store. Fixed words. */
export const KEY_STORE_LINES: Readonly<Record<KeyStoreKind, string>> = Object.freeze({
  macos_keychain: "Runner keeps its keys in your macOS login keychain.",
  secret_service: "Runner keeps its keys in the Secret Service (your desktop keyring), through secret-tool.",
  file: "Runner keeps its keys in files only you can read, in keys/ under Runner's home (no Secret Service answered).",
});

export const SECRET_TOOL = "/usr/bin/secret-tool";
const MARKER = "key-store";
/** The most one item may hold. Runner's largest, an agent connection, is about 2 KB. **Proposed** figure. */
export const MAX_ITEM_BYTES = 256 * 1024;

const ownUid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

export class FileSecretStore implements SecretStore {
  private readonly home: string;
  private readonly folder: string;

  constructor(home: string) {
    this.home = home;
    this.folder = join(home, "keys");
  }

  /** The keys folder: made 0700 if missing, and refused unless it is a real folder, this user's, mode 0700. */
  private async ready(): Promise<string> {
    await ensureFolder(this.home, this.folder, { makeRoot: true });
    const info = await lstat(this.folder);
    if (!info.isDirectory() || info.uid !== ownUid() || (info.mode & 0o777) !== 0o700) throw new Error("Runner's keys folder must be yours alone (mode 700). Nothing was read or written.");
    return this.folder;
  }

  private path(folder: string, name: string): string {
    // Checked as the keychain's names are, then hashed: no name reaches the file system.
    accountFor(this.home, name);
    return join(folder, createHash("sha256").update(name).digest("hex"));
  }

  async get(name: string): Promise<string | null> {
    const path = this.path(await this.ready(), name);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Runner's key file must be a regular file you own, mode 600. Nothing was read.");
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== ownUid() || (info.mode & 0o777) !== 0o600 || info.size > MAX_ITEM_BYTES) throw new Error("Runner's key file must be a regular file you own, mode 600. Nothing was read.");
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  async set(name: string, value: string): Promise<void> {
    if (Buffer.byteLength(value) > MAX_ITEM_BYTES) throw new Error("Runner's key record is too large; nothing was stored");
    const path = this.path(await this.ready(), name);
    await writeFileAtomic(path, value);
    if ((await this.get(name)) !== value) throw new Error("Runner couldn't store its key");
  }

  async delete(name: string): Promise<void> {
    const path = this.path(await this.ready(), name);
    try {
      const info = await lstat(path);
      if (!info.isFile()) throw new Error("Runner's key file isn't a regular file; nothing was deleted.");
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export type ChooseOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** `/proc/self/mounts`, for tests; read from the system when left out. */
  mounts?: string | null;
  /** Whether `secret-tool` is installed at its fixed path; for tests. */
  exists?: (path: string) => boolean;
  /** Runs `secret-tool`; for tests, a stand-in. */
  runner?: Runner;
};

/**
 * Whether the Secret Service answers: a lookup of an item Runner never stores ends 0 (found) or 1 with nothing said
 * (not found). Anything said on standard error (no session bus, nothing providing the service) is "doesn't answer".
 */
async function secretServiceAnswers(home: string, env: NodeJS.ProcessEnv, runner: Runner): Promise<boolean> {
  try {
    const childEnvironment = childEnv({ DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR }, env);
    const r = await runner(SECRET_TOOL, ["lookup", "service", SERVICE, "account", accountFor(home, "probe")], "", childEnvironment);
    return r.code === 0 || (r.code === 1 && r.stdout.trim() === "" && r.stderr.trim() === "");
  } catch {
    return false;
  }
}

/** This machine's key store, which kind it is, and the line saying so. */
export async function chooseKeyStore(home: string, opts: ChooseOptions = {}): Promise<{ store: SecretStore; kind: KeyStoreKind; line: string }> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform === "darwin") return { store: new MacKeychain(home), kind: "macos_keychain", line: KEY_STORE_LINES.macos_keychain };
  if (platform !== "linux") throw new Error("Runner keeps its keys in the OS keychain, and has no supported keychain on this system.");
  const refused = homeRefusal(home, opts.mounts !== undefined ? opts.mounts : readMounts());
  if (refused) throw new Error(refused);
  await ensureFolder(home, home, { makeRoot: true });
  const runner = opts.runner ?? run;
  const marker = join(home, MARKER);
  const remembered = (await readNoFollow(marker, 64))?.trim();
  let kind: KeyStoreKind;
  if (remembered === undefined) {
    const installed = (opts.exists ?? existsSync)(SECRET_TOOL);
    kind = installed && (env.DBUS_SESSION_BUS_ADDRESS ?? "") !== "" && (await secretServiceAnswers(home, env, runner)) ? "secret_service" : "file";
    await writeNew(marker, `${kind}\n`);
  } else if (remembered === "secret_service" || remembered === "file") {
    kind = remembered;
  } else {
    throw new Error("Runner's key-store file in its home names no store Runner uses. Run `forget` and pair again, or restore it.");
  }
  const store = kind === "secret_service" ? new SecretServiceKeychain(home, runner, env, SECRET_TOOL) : new FileSecretStore(home);
  return { store, kind, line: KEY_STORE_LINES[kind] };
}
