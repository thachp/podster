/**
 * The owner's run policy on disk: `policy.json` in Runner's home, written by the owner. The lifecycle reads it afresh on
 * every evaluation (L7 on #458), so switching a room's unattended runs off counts at the next evaluation with no
 * restart. A file that's missing or can't be read is no policy, and the policy refuses.
 *
 * Runner writes it only for the owner's `setup` and for a room change the owner approved (issue 523): whole or not at
 * all (a new file, flushed, renamed over the old one, mode 600 in Runner's own folder), and only while the file still
 * holds exactly the text the change was made from, checked once before the new file is written and again just before
 * the rename. After the rename it's read back: if it holds anything but what Runner wrote, another writer got in, and
 * the write reports `raced` so the owner is told and asked again, never left to find out. **A narrow window stays:** an
 * editor that saves between the last check and the rename, and then not again, has its save replaced by Runner's and
 * the read-back can't see it. The README says so.
 */
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PolicyText, WriteOutcome } from "../core/room-facts.js";

export const POLICY_FILE = "policy.json";

/** A reader for the lifecycle's `config`: each call reads the file again. */
export function policyFile(home: string): () => Promise<unknown> {
  const path = join(home, POLICY_FILE);
  return async () => JSON.parse(await readFile(path, "utf8")) as unknown;
}

/** The policy file as text, and a write that happens only while it still holds `expected` (null: while there's none). */
export function policyText(home: string): PolicyText {
  const path = join(home, POLICY_FILE);
  const read = async (): Promise<string | null> => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  // A link, or anything but a plain file, where the policy should be is never written through.
  const plain = async () => {
    const stat = await lstat(path).catch(() => null);
    return stat === null || stat.isFile();
  };
  return {
    path,
    read,
    write: async (text, expected): Promise<WriteOutcome> => {
      if (!(await plain()) || (await read()) !== expected) return "changed";
      await mkdir(home, { recursive: true, mode: 0o700 });
      await chmod(home, 0o700);
      const temporary = `${path}.${process.pid}.tmp`;
      const file = await open(temporary, "w", 0o600);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      // Checked again just before the rename, so an edit made while the new file was written isn't replaced.
      if (!(await plain()) || (await read()) !== expected) {
        await rm(temporary, { force: true });
        return "changed";
      }
      await rename(temporary, path);
      const folder = await open(home, "r");
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
      return (await read()) === text ? "written" : "raced";
    },
  };
}
