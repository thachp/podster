// M6-S04's kept file, for m6-staging.mjs's two phases: written by --before-deploy, read and deleted by --after-deploy.
// It holds a test session, so it lives outside the repository, in a directory only its owner can open, at mode 0600,
// and is never printed. A file or directory that someone else could read, or that is a link, is refused, not repaired.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from "node:fs";
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

/** A temporary file of this module's, beside the kept file: the write's, or the probe's. Both are named alike. */
const temporaryFor = (file) => join(dirname(file), `.${basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
const isTemporaryOf = (file, name) => name.startsWith(`.${basename(file)}.`) && /^\.[^/]+\.[0-9a-f]{16}\.tmp$/.test(name) && name.length === basename(file).length + 22;

/** Removes a name, never what a link points to. True once it's gone. */
const gone = (path) => {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
};

/**
 * Deletes temporary files of this module's naming that a run killed mid-write left beside the kept file. One may hold a
 * whole record, session included. Only once the directory has passed the same checks. Answers how many it deleted, or
 * a problem.
 */
export function sweepKept(file) {
  const dir = dirname(file);
  try {
    lstatSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return { swept: 0 };
  }
  const problem = directoryProblem(dir);
  if (problem) return { problem };
  let swept = 0;
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    return { problem: `its directory couldn't be listed: ${why(error)}` };
  }
  for (const name of names.filter((each) => isTemporaryOf(file, each))) {
    if (!gone(join(dir, name))) return { problem: `a leftover temporary file couldn't be deleted` };
    swept++;
  }
  return { swept };
}

/**
 * Makes the kept file's directory if it's missing, at 0700, sweeps leftover temporary files, and proves the write: a
 * probe file is made and published the way the real write is, no-follow, exclusive and 0600, then removed. Says why the
 * file can't be written there, or null, with how many leftovers it swept. The first phase calls it before it sends
 * anything, so a directory that would refuse the file never costs a sign-up.
 */
export function keptDirectoryProblem(file) {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  } catch (error) {
    return { problem: `its directory couldn't be made: ${why(error)}` };
  }
  const sweep = sweepKept(file);
  if (sweep.problem) return sweep;
  const probe = temporaryFor(file);
  const published = temporaryFor(file);
  let fd;
  try {
    fd = openSync(probe, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeSync(fd, "{}\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(probe, published);
  } catch (error) {
    return { problem: `a test write there failed: ${why(error)}`, swept: sweep.swept };
  } finally {
    if (fd !== undefined) closeSync(fd);
    gone(probe);
    gone(published);
  }
  return { problem: null, swept: sweep.swept };
}

/**
 * Writes the record, only if no file is there. It's written whole to a new temporary file beside it, at 0600 and never
 * through a link, then published with a hard link, which, unlike a rename, never replaces a file already there. Throws,
 * with why and without a path, and leaves nothing behind otherwise.
 */
export function writeKept(file, record) {
  const { problem } = keptDirectoryProblem(file);
  if (problem) throw new Error(`the kept file wasn't written: ${problem}`);
  const temporary = temporaryFor(file);
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
    gone(temporary);
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
    // Whatever JSON it holds, `null` and `false` included, the file is there: callers test `missing`, never the record.
    return { present: true, record: JSON.parse(readFileSync(fd, "utf8")) };
  } catch {
    return { problem: "the kept file isn't JSON" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Deletes the kept file, or a link in its place, never what a link points to. Answers whether it's gone. */
export const removeKept = (file) => gone(file);
