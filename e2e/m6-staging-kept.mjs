// M6-S04's kept file, for m6-staging.mjs's two phases: written by --before-deploy, read and deleted by --after-deploy.
// It holds a test session, so it lives outside the repository, in a directory only its owner can open, at mode 0600,
// and is never printed. A file or directory that someone else could read, or that is a link, is refused, not repaired.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const mine = (stat) => typeof process.getuid !== "function" || stat.uid === process.getuid();

/** Why the kept file's directory can't hold a session, or null. */
function directoryProblem(dir) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return "its directory couldn't be read";
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "its directory is a link or not a directory";
  if (!mine(stat)) return "its directory belongs to someone else";
  if (stat.mode & 0o077) return "its directory can be opened by others: it must be mode 0700";
  return null;
}

/** Why a file operation failed, by its code: never its message, which names the full path and so the runner's home. */
const why = (error) =>
  ({ EEXIST: "a file is already there", ELOOP: "a link is in its place", EACCES: "it isn't writable", EPERM: "it isn't writable", ENOTDIR: "a file is where a directory should be", ENOSPC: "the disk is full" })[error?.code] ?? `the file system answered ${error?.code ?? "an error"}`;

/**
 * Makes the kept file's directory if it's missing, at 0700, and says why it can't hold the file, or null. The first
 * phase calls it before it sends anything, so a directory that would refuse the file never costs a sign-up.
 */
export function keptDirectoryProblem(file) {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  } catch (error) {
    return `its directory couldn't be made: ${why(error)}`;
  }
  return directoryProblem(dirname(file));
}

/**
 * Writes the record, only if no file is there. It's written whole to a new temporary file beside it, at 0600 and never
 * through a link, then published with a hard link, which, unlike a rename, never replaces a file already there. Throws,
 * with why and without a path, and leaves nothing behind otherwise.
 */
export function writeKept(file, record) {
  const problem = keptDirectoryProblem(file);
  if (problem) throw new Error(`the kept file wasn't written: ${problem}`);
  const temporary = join(dirname(file), `.${basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, file);
  } catch (error) {
    throw new Error(`the kept file wasn't written: ${why(error)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // Never made.
    }
  }
  try {
    const dirFd = openSync(dirname(file), constants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // A directory that can't be synced still holds the file.
  }
}

/**
 * The kept record: `{ record }`, `{ missing: true }`, or `{ problem }` when it's there and can't be trusted: a link,
 * someone else's, readable by others, or not JSON.
 */
export function readKept(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    return { problem: "the kept file couldn't be read" };
  }
  const problem = directoryProblem(dirname(file));
  if (problem) return { problem: `the kept file can't be trusted: ${problem}` };
  if (stat.isSymbolicLink() || !stat.isFile()) return { problem: "the kept file is a link or not a file" };
  if (!mine(stat)) return { problem: "the kept file belongs to someone else" };
  if (stat.mode & 0o077) return { problem: "the kept file can be read by others: it must be mode 0600" };
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return { problem: "the kept file is not a file" };
    return { record: JSON.parse(readFileSync(fd, "utf8")) };
  } catch {
    return { problem: "the kept file isn't JSON" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Deletes the kept file. Answers whether it's gone. */
export function removeKept(file) {
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
