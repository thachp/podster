// M6-S04's kept file, for m6-staging.mjs's two phases: written by --before-deploy, read and deleted by --after-deploy.
// It holds a test session, so it lives outside the repository, in a directory only its owner can open, at mode 0600,
// and is never printed. A file or directory that someone else could read, or that is a link, is refused, not repaired.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

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

/** Writes the record, only if no file is there. Throws, with why, and writes nothing otherwise. */
export function writeKept(file, record) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const problem = directoryProblem(dir);
  if (problem) throw new Error(`the kept file wasn't written: ${problem}`);
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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
