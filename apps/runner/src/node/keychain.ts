/**
 * Runner's keys in the OS keychain (M7 plan, the architect's ruling 3 on spike A): a `SecretStore` over the system's own
 * tool, `/usr/bin/security` on macOS and `secret-tool` (the Secret Service, as GNOME Keyring or KWallet provides it) on
 * Linux. Any other system has no supported store, and Runner refuses to pair there. *S-47, 2026-11-19:* on Linux
 * (and Windows through WSL2), when the Secret Service doesn't answer, Runner keeps its keys in owner-only files instead;
 * `key-store.ts` chooses, and macOS is unchanged.
 *
 * A secret never appears in a program's arguments, where other users' `ps` could read it: it goes in on standard input
 * and comes back on standard output. Each item is a generic password under the service `dev.podster.runner`, named for
 * this Runner's home folder and the item, and is stored as hex, so no value needs quoting. The tool runs with the
 * allow-listed environment (`child-env.ts`), from its fixed path, never found through `PATH`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { SecretStore } from "../core/storage.js";
import { childEnv } from "./child-env.js";

export const SERVICE = "dev.podster.runner";
const NAME = /^[A-Za-z0-9:._-]{1,200}$/;
const TIMEOUT_MS = 15_000;
/** Most a tool may print on either stream. More is an error, never an answer cut short. */
export const MAX_OUTPUT_BYTES = 256 * 1024;
/**
 * The longest command line Runner gives `security -i`. Its interactive mode cuts a line at about 4,096 bytes and stores
 * what's left (H1 on #454), so Runner refuses anything near that, with a 512-byte margin, before writing.
 */
export const MAC_LINE_LIMIT = 3584;
/** A test keychain file's path: plain characters only, since it goes on `security -i`'s line too. */
const KEYCHAIN_PATH = /^\/[A-Za-z0-9/._-]{1,400}$/;

/** A program's exit code and what it printed. Standard error is only ever looked at for emptiness, never logged. */
export type Ran = { code: number | null; stdout: string; stderr: string };
/** Runs a program with arguments and standard input, and answers its exit code and standard output. */
export type Runner = (file: string, args: string[], input: string, env: Record<string, string>) => Promise<Ran>;

export const run: Runner = (file, args, input, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"], timeout: TIMEOUT_MS });
    let tooMuch = false;
    const collect = (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk);
        else if (!tooMuch) {
          tooMuch = true;
          child.kill();
        }
      });
      return () => Buffer.concat(chunks).toString("utf8");
    };
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    child.on("error", reject);
    child.on("close", (code) => {
      // Never an answer cut short: a tool that printed more than the limit is an error.
      if (tooMuch) reject(new Error("the keychain tool printed more output than Runner reads"));
      else resolve({ code, stdout: stdout(), stderr: stderr() });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });

const toHex = (value: string) => Buffer.from(value, "utf8").toString("hex");
const fromHex = (hex: string) => {
  const trimmed = hex.trim();
  if (!/^(?:[0-9a-f]{2})*$/.test(trimmed)) throw new Error("the keychain returned something Runner didn't store");
  return Buffer.from(trimmed, "hex").toString("utf8");
};

/** The account name of one item, for one Runner home: two homes on one machine never share an item. */
export function accountFor(home: string, name: string): string {
  const scope = createHash("sha256").update(home).digest("hex").slice(0, 16);
  const account = `${scope}:${name}`;
  if (!NAME.test(account)) throw new Error("not a key store name Runner uses");
  return account;
}

/**
 * macOS: the login keychain, through `/usr/bin/security`. `test.keychain` names another keychain file instead, for a
 * check by hand with a throwaway file; production never passes it, and nothing Runner reads at run time sets it.
 */
export class MacKeychain implements SecretStore {
  private readonly home: string;
  private readonly runner: Runner;
  private readonly env: Record<string, string>;
  private readonly keychain: string[];

  constructor(home: string, runner: Runner = run, env = childEnv(), test: { keychain?: string } = {}) {
    this.home = home;
    this.runner = runner;
    this.env = env;
    if (test.keychain !== undefined && !KEYCHAIN_PATH.test(test.keychain)) throw new Error("not a keychain file path Runner takes");
    this.keychain = test.keychain === undefined ? [] : [test.keychain];
  }

  async get(name: string): Promise<string | null> {
    const found = await this.runner("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", accountFor(this.home, name), "-w", ...this.keychain], "", this.env);
    if (found.code === 44) return null;
    if (found.code !== 0) throw new Error("the keychain couldn't be read");
    return fromHex(found.stdout);
  }

  async set(name: string, value: string): Promise<void> {
    // `security -i` reads its command from standard input, so the secret is never in an argument.
    const command = `add-generic-password -U -s ${SERVICE} -a ${accountFor(this.home, name)} -w ${toHex(value)}${this.keychain.map((k) => ` ${k}`).join("")}\n`;
    // The tool would cut a longer line and store the rest: refused here, before anything is written.
    if (Buffer.byteLength(command) > MAC_LINE_LIMIT) throw new Error("Runner's key record is too large for the keychain tool; nothing was stored");
    const stored = await this.runner("/usr/bin/security", ["-i"], command, this.env);
    // Its interactive mode can exit 0 when the command inside failed, so what was stored is read back.
    if (stored.code !== 0 || (await this.get(name)) !== value) throw new Error("the keychain couldn't store Runner's key");
  }

  async delete(name: string): Promise<void> {
    const removed = await this.runner("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", accountFor(this.home, name), ...this.keychain], "", this.env);
    if (removed.code !== 0 && removed.code !== 44) throw new Error("the keychain couldn't delete Runner's key");
  }
}

/** Linux: the Secret Service, through `secret-tool`. */
export class SecretServiceKeychain implements SecretStore {
  private readonly home: string;
  private readonly runner: Runner;
  private readonly env: Record<string, string>;
  private readonly tool: string;

  constructor(home: string, runner: Runner = run, from: NodeJS.ProcessEnv = process.env, tool = "/usr/bin/secret-tool") {
    this.home = home;
    this.runner = runner;
    this.tool = tool;
    // The tool reaches the Secret Service over the session's D-Bus, so it needs the session's bus address.
    this.env = childEnv({ DBUS_SESSION_BUS_ADDRESS: from.DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR: from.XDG_RUNTIME_DIR }, from);
  }

  private attributes(name: string) {
    return ["service", SERVICE, "account", accountFor(this.home, name)];
  }

  async get(name: string): Promise<string | null> {
    const found = await this.runner(this.tool, ["lookup", ...this.attributes(name)], "", this.env);
    if (found.code === 0) return fromHex(found.stdout);
    // Not found is exit 1 with nothing printed on either stream. A locked collection or a missing session bus also
    // exits 1, but says why on standard error: that's an error, never "no key", so a good pairing isn't retired (L2).
    if (found.code === 1 && found.stdout.trim() === "" && found.stderr.trim() === "") return null;
    throw new Error("the keychain couldn't be read");
  }

  async set(name: string, value: string): Promise<void> {
    const stored = await this.runner(this.tool, ["store", "--label=Podster Runner", ...this.attributes(name)], toHex(value), this.env);
    if (stored.code !== 0 || (await this.get(name)) !== value) throw new Error("the keychain couldn't store Runner's key");
  }

  async delete(name: string): Promise<void> {
    const removed = await this.runner(this.tool, ["clear", ...this.attributes(name)], "", this.env);
    // Gone, or never there (exit 0 or 1 with nothing said). Anything said on standard error is a failure (L2).
    if ((removed.code !== 0 && removed.code !== 1) || removed.stderr.trim() !== "") throw new Error("the keychain couldn't delete Runner's key");
  }
}

/** The OS keychain for this system, or an error saying there's no supported one. */
export function systemKeychain(home: string, platform: NodeJS.Platform = process.platform): SecretStore {
  if (platform === "darwin") return new MacKeychain(home);
  if (platform === "linux") return new SecretServiceKeychain(home);
  throw new Error("Runner keeps its keys in the OS keychain, and has no supported keychain on this system.");
}
