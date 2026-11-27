/**
 * Runner's record of the owner's trust-statement acceptances (`trust.json` in Runner's home; F-3 of the M7 security
 * review). Runner writes it only for the owner's `podster trust`, whole or not at all: a new file, mode 600, flushed and
 * renamed over the old one in Runner's own folder. The lifecycle reads it afresh on every evaluation, as it does the
 * policy, so an acceptance counts at the next one. A missing or unreadable file is no acceptance.
 */
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { TRUST_FILE, type TrustRecord } from "../core/trust.js";

/** A reader for the lifecycle's `trust`: each call reads the file again; a missing one reads as null. */
export function trustFile(home: string): () => Promise<unknown> {
  const path = join(home, TRUST_FILE);
  return async () => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
}

/** Writes the record whole. Refuses to write through a link or anything but a plain file. */
export async function writeTrustRecord(home: string, record: TrustRecord): Promise<void> {
  const path = join(home, TRUST_FILE);
  const stat = await lstat(path).catch(() => null);
  if (stat !== null && !stat.isFile()) throw new Error(`${TRUST_FILE} isn't a plain file, so Runner won't write it.`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  // Made new, never opened if anything is there: a link planted at this name fails the write instead of being followed.
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  await rename(temporary, path);
  const folder = await open(home, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}
