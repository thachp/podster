/**
 * The owner's run policy on disk: `policy.json` in Runner's home, written by the owner. The lifecycle reads it afresh on
 * every evaluation (L7 on #458), so switching a room's unattended runs off counts at the next evaluation with no
 * restart. A file that's missing or can't be read is no policy, and the policy refuses.
 *
 * Runner writes it only for the owner's `setup` and for a room change (issue 523): whole or not at all (`writeWhole`,
 * mode 600 in Runner's own folder), and only while the file is still exactly the text the change was made from, so an
 * edit the owner made meanwhile is never overwritten.
 */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PolicyText } from "../core/room-facts.js";
import { writeWhole } from "./file-state.js";

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
  return {
    read,
    write: async (text, expected) => {
      // A link where the policy should be is never written through.
      const stat = await lstat(path).catch(() => null);
      if (stat !== null && !stat.isFile()) return false;
      if ((await read()) !== expected) return false;
      await writeWhole(home, POLICY_FILE, text);
      return true;
    },
  };
}
