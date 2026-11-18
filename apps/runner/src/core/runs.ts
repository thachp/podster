/**
 * Runner's record of its work on tasks (M7 step 8): one entry per task, the run decisions as the policy returned them, and
 * the budget ledger. Pure functions over that record; the lifecycle (`lifecycle.ts`) saves it durably at every step, in
 * its own file beside the offers record, so the inbox loop and the lifecycle never overwrite each other.
 *
 * It holds IDs, versions, codes, hashes and amounts only. A task's words never reach it: a run decision carries the
 * SHA-256 of the prompt's bytes, never the bytes (`prompt.ts`).
 *
 * **The day boundary** is the UTC day, `floor(now / 86_400_000)`: one rule on every machine, with no daylight-saving
 * jumps. Spend counts against the day a run settles on. Reservations aren't a day's: each holds until its run settles,
 * whatever the day, so a run that crosses midnight still counts against the new day's cap until it settles.
 *
 * **The reservation ledger.** Issuing a run decision reserves the task's whole spend cap; settling it releases the
 * reservation and counts what was spent: the adapter's figure when it gives one, the whole reservation when it doesn't
 * (fail closed), and more than the reservation when a run overshot. A decision that never ran settles at zero.
 */
import type { RunDecisionRecord } from "./policy.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const dayOf = (now: number) => Math.floor(now / DAY_MS);

/**
 * Where a task's entry has got to. Each step is saved before the next starts, so a restart picks up from the last.
 *
 * - `accepting`: a decision is issued and an accept is owed, with its key stored before it was first sent.
 * - `ready`: the task is this agent's, accepted, with an issued decision not yet spent.
 * - `running`: the decision was consumed and stored, and a run was started under `run_ref`.
 * - `giving_up`: a decline or release is owed, with its key stored before it was first sent.
 * - `held`: a run's process wasn't confirmed stopped. Nothing is released and no new run starts until it is.
 * - `waiting`: nothing to do until `retry_at`, or a new event for the task.
 * - `finished`: a run ended successfully; its result is step 11's to submit.
 * - `done`: nothing more for this task until a new event.
 */
export type RunPhase = "accepting" | "ready" | "running" | "giving_up" | "held" | "waiting" | "finished" | "done";

/** A decline or release that's owed. `version` null: read the task's version as it stands before the key is first used. */
export type GiveUp = { capability: "decline_task" | "release_task"; reason: string; version: number | null; key: string };
/** What follows once a run's stop is confirmed. */
export type After = { kind: "release"; reason: string } | { kind: "reconsider" } | { kind: "finish" } | { kind: "none" };

export type RunEntry = {
  workspace_id: string;
  task_id: string;
  /** The offer record's marker this entry last answered. A new event changes it, and the task is evaluated afresh. */
  marker: string;
  phase: RunPhase;
  /** The latest outcome, as a reason code. */
  outcome: string | null;
  /** The run decision as `issueRunDecision` returned it, stored before anything acts on it. */
  decision: RunDecisionRecord | null;
  /** The same decision as `consumeRunDecision` returned it, stored before the run started. */
  consumed: RunDecisionRecord | null;
  /** This attempt's reservation in the ledger, when one is held. */
  reservation: string | null;
  accept_key: string | null;
  /** The version the task must still have at start: the accept's answer, or the version evaluated for a rerun. */
  expected_version: number | null;
  /** The run's own ID, chosen by Runner before the adapter starts it, so a restart can ask about it. */
  run_ref: string | null;
  /** A decline or release that's owed. */
  give_up: GiveUp | null;
  /** What to do once a held run is confirmed stopped. */
  after_stop: After | null;
  /** The input hash of the last run that finished successfully: a rerun needs other inputs. */
  ran_hash: string | null;
  retry_at: number | null;
  attempts: { day: number; count: number };
  updated_at: number;
};

export type Ledger = { day: number; spent_micro_usd: number; reservations: Record<string, number> };

export type RunsState = {
  version: 1;
  /** The Podster agent these entries are for. A record from an earlier pairing on this home has another. */
  agent_id: string | null;
  entries: Record<string, RunEntry>;
  ledger: Ledger;
  next_reservation: number;
};

export const emptyRuns = (): RunsState => ({ version: 1, agent_id: null, entries: {}, ledger: { day: 0, spent_micro_usd: 0, reservations: {} }, next_reservation: 1 });

export interface RunStore {
  load(): Promise<RunsState>;
  save(state: RunsState): Promise<void>;
}

/** For tests only. */
export class MemoryRunStore implements RunStore {
  private saved = JSON.stringify(emptyRuns());
  saves = 0;
  failSaves = false;
  async load() {
    return JSON.parse(this.saved) as RunsState;
  }
  async save(state: RunsState) {
    if (this.failSaves) throw new Error("save failed");
    this.saved = JSON.stringify(state);
    this.saves++;
  }
  /** What is on "disk", as text. */
  get text() {
    return this.saved;
  }
}

export const newEntry = (workspace_id: string, task_id: string, now: number): RunEntry => ({
  workspace_id,
  task_id,
  marker: "",
  phase: "done",
  outcome: null,
  decision: null,
  consumed: null,
  reservation: null,
  accept_key: null,
  expected_version: null,
  run_ref: null,
  give_up: null,
  after_stop: null,
  ran_hash: null,
  retry_at: null,
  attempts: { day: dayOf(now), count: 0 },
  updated_at: now,
});

/** The ledger as of `now`: a new UTC day starts its spend at zero. Reservations carry over. */
export function rolled(ledger: Ledger, now: number): Ledger {
  const today = dayOf(now);
  return ledger.day === today ? ledger : { day: today, spent_micro_usd: 0, reservations: { ...ledger.reservations } };
}

/** What the policy's `budget` input is built from: today's spend and every reservation not yet settled. */
export function budgetOf(ledger: Ledger, now: number): { spent_today_micro_usd: number; reserved_micro_usd: number } {
  const today = rolled(ledger, now);
  return { spent_today_micro_usd: today.spent_micro_usd, reserved_micro_usd: Object.values(today.reservations).reduce((a, b) => a + b, 0) };
}

/** Holds `amount` under `key` until it settles. */
export function reserve(ledger: Ledger, key: string, amount: number, now: number): Ledger {
  const today = rolled(ledger, now);
  if (!Number.isSafeInteger(amount) || amount <= 0 || Object.hasOwn(today.reservations, key)) throw new Error("reservation_invalid");
  return { ...today, reservations: { ...today.reservations, [key]: amount } };
}

/**
 * Releases `key`'s reservation and counts `spent` against today. `spent` null means the figure is unknown, which counts the
 * whole reservation. Settling a key that holds nothing changes nothing.
 */
export function settle(ledger: Ledger, key: string | null, spent: number | null, now: number): Ledger {
  const today = rolled(ledger, now);
  if (key === null || !Object.hasOwn(today.reservations, key)) return today;
  const held = today.reservations[key];
  const counted = spent === null || !Number.isSafeInteger(spent) || spent < 0 ? held : spent;
  const reservations = { ...today.reservations };
  delete reservations[key];
  return { ...today, spent_micro_usd: today.spent_micro_usd + counted, reservations };
}
