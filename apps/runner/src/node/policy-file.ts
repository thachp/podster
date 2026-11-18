/**
 * The owner's run policy on disk: `policy.json` in Runner's home, written by the owner. The lifecycle reads it afresh on
 * every evaluation (L7 on #458), so switching a room's unattended runs off counts at the next evaluation with no
 * restart. A file that's missing or can't be read is no policy, and the policy refuses.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const POLICY_FILE = "policy.json";

/** A reader for the lifecycle's `config`: each call reads the file again. */
export function policyFile(home: string): () => Promise<unknown> {
  const path = join(home, POLICY_FILE);
  return async () => JSON.parse(await readFile(path, "utf8")) as unknown;
}
