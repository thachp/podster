// The spike's spend ledger, safe against a crash and against a second process. One spike process at a time holds an
// exclusive lock file (created with O_EXCL). A run's whole cap is written into the ledger as spent before the run
// starts, and replaced with the real figure only when the run ends. A run killed in between stays charged its cap,
// which is the safe side. Writes go to a temporary file and are renamed into place.

import { openSync, closeSync, writeSync, unlinkSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DAY_CAP_MICRO_USD, TOTAL_CAP_MICRO_USD } from "./profile.mjs";

const LEDGER = "spend.json";
const LOCK = "spend.lock";

const today = () => new Date().toISOString().slice(0, 10);

export class Ledger {
  #dir;
  #lockFd = null;

  constructor(dir) {
    this.#dir = dir;
  }

  get lockPath() {
    return join(this.#dir, LOCK);
  }

  /** Take the exclusive lock, or throw saying who may hold it and how to clear a stale one. */
  lock() {
    mkdirSync(this.#dir, { recursive: true });
    try {
      this.#lockFd = openSync(this.lockPath, "wx", 0o600);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let holder = "unknown";
      try {
        holder = readFileSync(this.lockPath, "utf8").trim() || "unknown";
      } catch {}
      throw new Error(
        `refused: the spend ledger is locked by another spike process (${holder}). ` +
          `If no spike run is active, a crashed run left it: check results/spend.json (that run stays charged its cap), then delete ${this.lockPath}.`,
      );
    }
    writeSync(this.#lockFd, `pid ${process.pid} at ${new Date().toISOString()}\n`);
    return this;
  }

  unlock() {
    if (this.#lockFd === null) return;
    closeSync(this.#lockFd);
    this.#lockFd = null;
    try {
      unlinkSync(this.lockPath);
    } catch {}
  }

  #assertLocked() {
    if (this.#lockFd === null) throw new Error("ledger: not locked");
  }

  read() {
    const p = join(this.#dir, LEDGER);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { total_micro_usd: 0, days: {}, runs: [] };
  }

  #write(l) {
    const p = join(this.#dir, LEDGER);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(l, null, 2) + "\n");
    renameSync(tmp, p);
  }

  /** What may still be spent: the smaller of what is left in total and what is left today. */
  left() {
    const l = this.read();
    return Math.min(TOTAL_CAP_MICRO_USD - l.total_micro_usd, DAY_CAP_MICRO_USD - (l.days[today()] ?? 0));
  }

  /** Charge a run's whole cap before it starts. Returns the run's id in the ledger. */
  reserve(scenario, capMicroUsd) {
    this.#assertLocked();
    const l = this.read();
    const day = today();
    const id = `${scenario}-${Date.now()}-${process.pid}`;
    l.total_micro_usd += capMicroUsd;
    l.days[day] = (l.days[day] ?? 0) + capMicroUsd;
    l.runs.push({ id, scenario, day, at: new Date().toISOString(), cap_micro_usd: capMicroUsd, spent_micro_usd: capMicroUsd, settled: false });
    this.#write(l);
    return id;
  }

  /** Replace a run's reserved cap with what it really spent (spent plus anything reserved that never settled). */
  settle(id, actualMicroUsd) {
    this.#assertLocked();
    const l = this.read();
    const run = l.runs.find((r) => r.id === id);
    if (!run || run.settled) throw new Error(`ledger: no open run ${id}`);
    const delta = actualMicroUsd - run.spent_micro_usd;
    l.total_micro_usd += delta;
    l.days[run.day] = (l.days[run.day] ?? 0) + delta;
    run.spent_micro_usd = actualMicroUsd;
    run.settled = true;
    this.#write(l);
  }
}

/**
 * The scratch folder: `<spike>/work` by default. M7O_SCRATCH may name only a folder inside it, so a run can't write
 * task folders or Docker config anywhere else.
 */
export function scratchDir(spikeDir, requested) {
  const work = resolve(spikeDir, "work");
  if (requested === undefined || requested === "") return work;
  const full = resolve(work, requested);
  if (full !== work && !full.startsWith(work + sep)) throw new Error("refused: M7O_SCRATCH must be inside the spike's work/ folder");
  if (existsSync(full)) {
    const real = realpathSync(full);
    const realWork = existsSync(work) ? realpathSync(work) : work;
    if (real !== realWork && !real.startsWith(realWork + sep)) throw new Error("refused: M7O_SCRATCH must be inside the spike's work/ folder");
  }
  return full;
}
