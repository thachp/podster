/**
 * Runner's record of its work on tasks on disk (`runs.json`, M7 step 8), beside the offers record and written the same
 * way: whole or not at all, owner-only. It holds IDs, versions, codes, hashes and amounts, never a task's words. A record
 * Runner can't read is an error, never a fresh start: a fresh start would forget accepted tasks, owed releases, held runs
 * and the day's spend.
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { emptyRuns, type RunsState, type RunStore } from "../core/runs.js";
import { writeWhole } from "./file-state.js";

const FILE = "runs.json";

export class FileRunStore implements RunStore {
  readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  private get path() {
    return join(this.home, FILE);
  }

  async load(): Promise<RunsState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRuns();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Runner's run record at ${this.path} can't be read. Nothing was changed.`);
    }
    const v = parsed as RunsState | null;
    if (!v || typeof v !== "object" || v.version !== 1 || !v.entries || typeof v.entries !== "object" || !v.ledger || typeof v.ledger !== "object") {
      throw new Error(`Runner's run record at ${this.path} isn't one this Runner reads. Nothing was changed.`);
    }
    return { ...emptyRuns(), ...v };
  }

  async save(state: RunsState): Promise<void> {
    await writeWhole(this.home, FILE, JSON.stringify(state));
  }

  async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
