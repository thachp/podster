/**
 * Runner's own access to folders a task can write into, from the host (M7 step 9(b); L3 on #459). A task's commands run
 * in its container, where only its folder is mounted, so a symbolic link it plants there can't leave the container. On
 * the host it could: a link to the owner's home would be followed by any plain `open`. So every host-side touch here:
 *
 * - makes each folder itself, mode 0700, one segment at a time, and checks each with `lstat` that it is a real folder
 *   and not a link;
 * - compares `realpath` with the path it built, so no link anywhere above it redirects it;
 * - opens files with `O_NOFOLLOW`, and walks folders with `lstat`, never following a link.
 *
 * Errors carry fixed words only, never a path.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, writeSync } from "node:fs";
import { lstat, mkdir, open, opendir, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export class UnsafePath extends Error {
  constructor(what: string) {
    super(`Runner refused a folder it doesn't own outright (${what}).`);
  }
}

/** An absolute, normalised path with no `..`, or a refusal. */
function plainAbsolute(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\u0000") || normalize(path) !== path || path.split(sep).includes("..")) throw new UnsafePath("not a plain absolute path");
  return path;
}

/** A real folder, not a link, owned by this user, and writable by no one else, or a refusal (L5 on #460). */
async function realFolder(path: string, uid: number | null) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafePath("not a real folder");
  if (uid !== null && info.uid !== uid) throw new UnsafePath("not the owner's");
  if ((info.mode & 0o022) !== 0) throw new UnsafePath("writable by others");
}

const ownUid = () => (typeof process.getuid === "function" ? process.getuid() : null);

/**
 * The same checks as `realFolder`, synchronously, for the local diagnostics file (review of #489): a real folder, not a
 * link, owned by this user, writable by no one else.
 */
export function ownFolderSync(path: string): void {
  const info = lstatSync(path);
  const uid = ownUid();
  if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafePath("not a real folder");
  if (uid !== null && info.uid !== uid) throw new UnsafePath("not the owner's");
  if ((info.mode & 0o022) !== 0) throw new UnsafePath("writable by others");
}

/** An open file that is a plain file, owned by this user, with one link: not a hard link to something else. */
export function ownFileSync(fd: number): { size: number } {
  const info = fstatSync(fd);
  const uid = ownUid();
  if (!info.isFile()) throw new UnsafePath("not a plain file");
  if (uid !== null && info.uid !== uid) throw new UnsafePath("not the owner's");
  if (info.nlink !== 1) throw new UnsafePath("linked elsewhere");
  return { size: info.size };
}

/**
 * Makes `folder` under `root`, each missing segment with mode 0700, and checks every segment from `root` down with
 * `lstat`; then checks `realpath` of the result is the path built. `root` itself must already be a real folder, or is
 * made the same way when `makeRoot`.
 */
export async function ensureFolder(root: string, folder: string, opts: { makeRoot?: boolean } = {}): Promise<string> {
  plainAbsolute(root);
  plainAbsolute(folder);
  const rel = relative(root, folder);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new UnsafePath("outside its root");
  const uid = ownUid();
  // The root's own parents may be anything the owner chose; the root itself must resolve to where it says, and be
  // writable by no one else.
  try {
    await realFolder(root, null);
  } catch (error) {
    if (!opts.makeRoot || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error instanceof UnsafePath ? error : new UnsafePath("root unreadable");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await realFolder(root, uid);
  }
  const resolvedRoot = await realpath(root);
  let at = root;
  for (const segment of rel === "" ? [] : rel.split(sep)) {
    at = join(at, segment);
    try {
      await mkdir(at, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new UnsafePath("couldn't be made");
    }
    await realFolder(at, uid);
  }
  if ((await realpath(folder)) !== join(resolvedRoot, rel)) throw new UnsafePath("redirected by a link");
  return folder;
}

/** Makes a new, empty folder with mode 0700; refuses if anything is already there. */
export async function freshFolder(path: string): Promise<string> {
  plainAbsolute(path);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch {
    throw new UnsafePath("already there or couldn't be made");
  }
  await realFolder(path, ownUid());
  return path;
}

/** Reads a small file without following a link at its last segment; null when it isn't there. */
export async function readNoFollow(path: string, maxBytes: number): Promise<string | null> {
  plainAbsolute(path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UnsafePath("couldn't be opened safely");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new UnsafePath("not a small regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Writes a new file, mode 0600, never through a link, never over an existing file. */
export async function writeNew(path: string, text: string): Promise<void> {
  plainAbsolute(path);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
}

/**
 * Replaces a file whole, mode 0600: the text goes to a new file beside it (made with `O_EXCL` and `O_NOFOLLOW`, mode
 * 0600, set again whatever the umask, flushed to disk), which is then renamed over the target, and the folder is flushed
 * so the rename survives a crash. A reader sees the old file or the new one, never part of either; a link at the target
 * is replaced, never followed. An earlier write's leftover temporary file for the same target, from a crash between its
 * write and its rename, is removed first (L3 on #471's review).
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  plainAbsolute(path);
  const folder = dirname(path);
  const escaped = basename(path).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  const leftover = new RegExp("^\\." + escaped + "\\.[0-9a-f]{12}\\.tmp$");
  for (const name of await readdir(folder)) {
    if (!leftover.test(name)) continue;
    const info = await lstat(join(folder, name)).catch(() => null);
    if (info?.isFile()) await unlink(join(folder, name)).catch(() => undefined);
  }
  const temp = join(folder, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  const dir = await open(folder, constants.O_RDONLY);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/** The most entries `folderBytes` walks; more counts as over any bound (M2 on #460). **Proposed** figure. */
export const MAX_FOLDER_ENTRIES = 200_000;

/**
 * The bytes under `folder`, counted with `lstat` and never following a link, stopping once past `limit`. A link counts
 * as its own small size; whatever it points to is never read. A folder with more than `maxEntries` entries reads as
 * over the bound, so a flood of small files can't make the walk endless or hide its size. An entry that disappears
 * mid-walk is skipped.
 */
export async function folderBytes(folder: string, limit: number, maxEntries = MAX_FOLDER_ENTRIES): Promise<number> {
  plainAbsolute(folder);
  let total = 0;
  let entries = 0;
  const stack = [folder];
  while (stack.length > 0 && total <= limit) {
    if (++entries > maxEntries) return limit + 1;
    const at = stack.pop() as string;
    let info;
    try {
      info = await lstat(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && at !== folder) continue;
      throw error;
    }
    total += info.size;
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    // Read as a stream, so the entry cap applies while reading, not after a whole huge listing is in memory.
    let dir;
    try {
      dir = await opendir(at);
    } catch {
      continue;
    }
    try {
      for await (const entry of dir) {
        if (entries + stack.length >= maxEntries) return limit + 1;
        stack.push(join(at, entry.name));
      }
    } catch {
      // A folder removed while read is skipped.
    }
  }
  return total;
}

/** Removes a folder Runner made, after checking it is still a real folder and not a link. */
export async function removeOwnFolder(path: string): Promise<void> {
  plainAbsolute(path);
  try {
    await realFolder(path, ownUid());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(path, { recursive: true, force: true });
}

/** As `writeNew`, at once: for a record that must exist before the caller goes on. */
export function writeNewSync(path: string, text: string): void {
  plainAbsolute(path);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
