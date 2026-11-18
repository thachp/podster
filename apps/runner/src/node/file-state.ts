/**
 * Runner's record on disk: one JSON file in Runner's own folder (mode 700), readable by its owner only (mode 600). It
 * holds IDs, states and times, never a key (`state.ts`). Each save writes a new file, flushes it to disk, renames it over
 * the old one and flushes the folder, so a crash or a power cut leaves the old record or the new one, never part of one.
 * A record Runner can't read is an error, never a fresh start: a fresh start would forget offers and the retired keys.
 */
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { emptyState, type RunnerState, type StateStore } from "../core/state.js";

const FILE = "state.json";

export class FileStateStore implements StateStore {
  readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  private get path() {
    return join(this.home, FILE);
  }

  async load(): Promise<RunnerState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Runner's record at ${this.path} can't be read. Nothing was changed.`);
    }
    if (!parsed || typeof parsed !== "object" || (parsed as RunnerState).version !== 1) throw new Error(`Runner's record at ${this.path} isn't one this Runner reads. Nothing was changed.`);
    return { ...emptyState(), ...(parsed as RunnerState) };
  }

  async save(state: RunnerState): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await chmod(this.home, 0o700);
    const temporary = `${this.path}.${process.pid}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.path);
    const folder = await open(this.home, "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  }

  /** Deletes the record. */
  async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
