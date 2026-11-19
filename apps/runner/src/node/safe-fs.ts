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
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

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

/** A real folder, not a link, owned by this user, or a refusal. */
async function realFolder(path: string, uid: number | null) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafePath("not a real folder");
  if (uid !== null && info.uid !== uid) throw new UnsafePath("not the owner's");
}

const ownUid = () => (typeof process.getuid === "function" ? process.getuid() : null);

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
  // The root's own parents may be anything the owner chose; the root itself must resolve to where it says.
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
 * The bytes under `folder`, counted with `lstat` and never following a link, stopping once past `limit`. A link counts
 * as its own small size; whatever it points to is never read.
 */
export async function folderBytes(folder: string, limit: number): Promise<number> {
  plainAbsolute(folder);
  let total = 0;
  const stack = [folder];
  while (stack.length > 0 && total <= limit) {
    const at = stack.pop() as string;
    const info = await lstat(at);
    total += info.size;
    if (info.isDirectory() && !info.isSymbolicLink()) for (const name of await readdir(at)) stack.push(join(at, name));
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
