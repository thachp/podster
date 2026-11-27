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
 * - `reporting`: a run's agent answered `blocked`: its reason is owed to the room (`report`), then the task is released on
 *   a first run or kept on a change request.
 * - `finished`: a run ended successfully. While its `submission` is `owed`, step 11 submits it; once Podster took it,
 *   `submitted`.
 * - `done`: nothing more for this task until a new event.
 */
export type RunPhase = "accepting" | "ready" | "running" | "giving_up" | "held" | "waiting" | "reporting" | "finished" | "done";

/** A decline or release that's owed. `version` null: read the task's version as it stands before the key is first used. */
export type GiveUp = { capability: "decline_task" | "release_task"; reason: string; version: number | null; key: string };
/** What follows once a run's stop is confirmed. */
export type After = { kind: "release"; reason: string } | { kind: "reconsider" } | { kind: "finish" } | { kind: "blocked" } | { kind: "start_failed"; code: string } | { kind: "none" };
/**
 * What Runner last pushed for a task, in a room with a repository (M7 step 10): the task branch's commit and its pull
 * request. A rerun starts from that commit, and only while the branch on GitHub still points at it. Step 11 submits it.
 */
export type Published = { repository_id: string; branch: string; commit: string; pr_number: number };

/**
 * A finished run's submission (M7 step 11). It holds keys, codes and a hash only: the agent's words are kept in memory
 * until they're sent, never here, so a restart loses them and Runner's fixed words go instead.
 *
 * - `sharing`: what may go to Podster of the agent's words, decided once, after the run: `pending` until then; `share`
 *   when the run's facts and the room's policy as it stands both allow it; `review` while it waits for the owner on this
 *   machine, since `held_since`; then `approved` or `withheld`. It is stored once decided, so every send, a replay
 *   included, carries the same note.
 * - `key`: the submission's idempotency key, stored before it's first sent, with the SHA-256 of the note it was sent
 *   with: the same note is always sent with the same key, and a different one (the words lost at a restart) with a new
 *   one, so a replay never carries another body.
 * - `told_key`, `told`: the fixed progress message for a held result, sent once.
 */
export type Submission = {
  state: "owed" | "submitted";
  sharing: "pending" | "share" | "review" | "approved" | "withheld";
  key: string | null;
  note_hash: string | null;
  told_key: string | null;
  told: boolean;
  /** When the words were first held for the owner's review; null until then. */
  held_since: number | null;
};
export const owedSubmission = (): Submission => ({ state: "owed", sharing: "pending", key: null, note_hash: null, told_key: null, told: false, held_since: null });

/**
 * A blocked run's report to the room (the architect's ruling on the owner's report of 2026-11-20): the agent's reason, sent
 * on the task's thread with `send_message`, under the same output policy as a submission's words. Keys, codes and a hash
 * only; the words are in memory until they're sent.
 *
 * - `keep`: decided once, from a fresh read: true when the run answered a change request (the task was submitted before,
 *   so it stays with the agent for a person to answer or reassign), false on a first run (released once the reason is
 *   posted); null until then.
 * - `sharing`, `key`, `note_hash`, `held_since`: as a submission's.
 */
export type BlockedReport = {
  sharing: Submission["sharing"];
  keep: boolean | null;
  key: string | null;
  note_hash: string | null;
  held_since: number | null;
  /** Scans of the thread that couldn't be read, looking for a note that may have landed before a restart. */
  scans?: number;
  /** A run that never started: its cause, a code. Its report is Runner's fixed words only, and the task is released. */
  start_failed?: string | null;
};
export const owedReport = (): BlockedReport => ({ sharing: "pending", keep: null, key: null, note_hash: null, held_since: null });

/**
 * The inputs a run answered `blocked` to: the prompt's hash and the SHA-256 of its decision's facts. Another run on the
 * same inputs and facts waits for something new (`blocked_same_inputs`), so a re-offer never pays for the same answer.
 */
export type BlockedOn = { input_hash: string; facts_hash: string };

/**
 * F-2: a publication held for the owner's review, bound to the run it was asked for (`run_ref`): when it was first held,
 * and whether the owner said yes. A yes for one run never covers another.
 */
export type PublishReview = { run_ref: string; held_since: number; approved: boolean };

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
  /** What Runner last pushed for this task, or null; absent in a record from before step 10. */
  published?: Published | null;
  /** True once Podster answered that this task has no linked repository (`task_not_linked`): it runs without a checkout. */
  unlinked?: boolean | null;
  /** A blocked run's report, while it's owed; null or absent otherwise. */
  report?: BlockedReport | null;
  /** What the last blocked run answered on; cleared by a person's message on the task. Null or absent otherwise. */
  blocked?: BlockedOn | null;
  /** A finished run's submission (step 11); null or absent otherwise. */
  submission?: Submission | null;
  /** When a finished run's publication first failed in passing, while it is held for a retry; else null or absent. */
  publish_since?: number | null;
  /** F-2: a publication held for, or approved in, the owner's review; null or absent otherwise. */
  publish_review?: PublishReview | null;
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
  published: null,
  retry_at: null,
  attempts: { day: dayOf(now), count: 0 },
  updated_at: now,
});

/**
 * The ledger as of `now`: a new UTC day starts its spend at zero. Reservations carry over. A clock that has gone back
 * before the ledger's day never resets it (`clockWentBack`; the lifecycle refuses with `clock_invalid`, L4 on #458).
 */
export function rolled(ledger: Ledger, now: number): Ledger {
  const today = dayOf(now);
  return today <= ledger.day ? ledger : { day: today, spent_micro_usd: 0, reservations: { ...ledger.reservations } };
}

/** Whether `now` is on a day before the ledger's: the clock went back, and no evaluation may trust it. */
export const clockWentBack = (ledger: Ledger, now: number) => dayOf(now) < ledger.day;

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

const PHASES = new Set<string>(["accepting", "ready", "running", "giving_up", "held", "waiting", "reporting", "finished", "done"]);
const isCode = (x: unknown) => typeof x === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(x);
const isHash = (x: unknown) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isText = (v: unknown, max = 256) => typeof v === "string" && v.length <= max;
const orNull = (v: unknown, check: (x: unknown) => boolean) => v === null || check(v);

/**
 * Checks a run record read from disk, its ledger and every entry's shape (L8 on #458). Answers the first field that's
 * wrong, or null when it's whole. A record that fails is an error for the owner, never a silent wait or a fresh start.
 */
export function checkRuns(v: unknown): string | null {
  if (!isObj(v) || v.version !== 1) return "version";
  if (!orNull(v.agent_id, (x) => isText(x, 128))) return "agent_id";
  if (!isCount(v.next_reservation) || (v.next_reservation as number) < 1) return "next_reservation";
  const ledger = v.ledger;
  if (!isObj(ledger) || !isCount(ledger.day) || !isCount(ledger.spent_micro_usd) || !isObj(ledger.reservations)) return "ledger";
  for (const amount of Object.values(ledger.reservations)) if (!isCount(amount) || amount === 0) return "ledger.reservations";
  if (!isObj(v.entries)) return "entries";
  for (const [key, e] of Object.entries(v.entries)) {
    const at = `entries[${JSON.stringify(key.slice(0, 80))}]`;
    if (!isObj(e) || !isText(e.workspace_id, 128) || !isText(e.task_id, 128) || key !== `${e.workspace_id}/${e.task_id}`) return at;
    if (typeof e.phase !== "string" || !PHASES.has(e.phase)) return `${at}.phase`;
    if (!isText(e.marker, 512) || !orNull(e.outcome, (x) => isText(x, 128))) return `${at}.marker`;
    if (!orNull(e.decision, isObj) || !orNull(e.consumed, isObj)) return `${at}.decision`;
    if (!orNull(e.reservation, (x) => isText(x, 64)) || !orNull(e.accept_key, (x) => isText(x, 128)) || !orNull(e.run_ref, (x) => isText(x, 128))) return `${at}.keys`;
    if (!orNull(e.expected_version, isCount) || !orNull(e.retry_at, isCount) || !isCount(e.updated_at)) return `${at}.numbers`;
    if (!orNull(e.ran_hash, (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x))) return `${at}.ran_hash`;
    const pub = e.published;
    if (pub !== undefined && pub !== null && (!isObj(pub) || typeof pub.repository_id !== "string" || !/^[1-9][0-9]{0,15}$/.test(pub.repository_id) || !isText(pub.branch, 200) || typeof pub.commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pub.commit) || !isCount(pub.pr_number) || pub.pr_number < 1)) return `${at}.published`;
    if (e.publish_since !== undefined && !orNull(e.publish_since, isCount)) return `${at}.publish_since`;
    const pr = e.publish_review;
    if (pr !== undefined && pr !== null && (!isObj(pr) || typeof pr.run_ref !== "string" || pr.run_ref.length > 128 || !isCount(pr.held_since) || typeof pr.approved !== "boolean" || Object.keys(pr).length !== 3)) return `${at}.publish_review`;
    const sub = e.submission;
    if (
      sub !== undefined &&
      sub !== null &&
      (!isObj(sub) ||
        (sub.state !== "owed" && sub.state !== "submitted") ||
        !["pending", "share", "review", "approved", "withheld"].includes(sub.sharing as string) ||
        !orNull(sub.key, (x) => isText(x, 128)) ||
        !orNull(sub.note_hash, (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x)) ||
        !orNull(sub.told_key, (x) => isText(x, 128)) ||
        typeof sub.told !== "boolean" ||
        !orNull(sub.held_since, isCount))
    )
      return `${at}.submission`;
    const rep = e.report;
    if (
      rep !== undefined &&
      rep !== null &&
      (!isObj(rep) ||
        !["pending", "share", "review", "approved", "withheld"].includes(rep.sharing as string) ||
        !orNull(rep.keep, (x) => typeof x === "boolean") ||
        !orNull(rep.key, (x) => isText(x, 128)) ||
        !orNull(rep.note_hash, isHash) ||
        !orNull(rep.held_since, isCount) ||
        (rep.scans !== undefined && !isCount(rep.scans)) ||
        (rep.start_failed !== undefined && !orNull(rep.start_failed, isCode)))
    )
      return `${at}.report`;
    if (e.unlinked !== undefined && e.unlinked !== null && typeof e.unlinked !== "boolean") return `${at}.unlinked`;
    const blocked = e.blocked;
    if (blocked !== undefined && blocked !== null && (!isObj(blocked) || !isHash(blocked.input_hash) || !isHash(blocked.facts_hash))) return `${at}.blocked`;
    const give = e.give_up;
    if (give !== null && (!isObj(give) || (give.capability !== "decline_task" && give.capability !== "release_task") || !isText(give.reason, 128) || !orNull(give.version, isCount) || !isText(give.key, 128))) return `${at}.give_up`;
    const after = e.after_stop;
    if (after !== null && (!isObj(after) || !["release", "reconsider", "finish", "blocked", "start_failed", "none"].includes(after.kind as string) || (after.kind === "release" && !isText(after.reason, 128)) || (after.kind === "start_failed" && !isCode(after.code)))) return `${at}.after_stop`;
    const attempts = e.attempts;
    if (!isObj(attempts) || !isCount(attempts.day) || !isCount(attempts.count)) return `${at}.attempts`;
    // Each phase holds what it needs to go on.
    if ((e.phase === "accepting" || e.phase === "ready" || e.phase === "running") && e.decision === null) return `${at}.decision`;
    if (e.phase === "accepting" && e.accept_key === null) return `${at}.accept_key`;
    if (e.phase === "running" && (e.consumed === null || e.run_ref === null)) return `${at}.run_ref`;
    if (e.phase === "giving_up" && give === null) return `${at}.give_up`;
    if (e.phase === "reporting" && (rep === undefined || rep === null || e.consumed === null)) return `${at}.report`;
    if (e.reservation !== null && !Object.hasOwn(ledger.reservations, e.reservation as string)) return `${at}.reservation`;
  }
  return null;
}

/**
 * Why `forget` may not go on (L5 on #458): a run that may still be going, or budget still reserved. Null when it may.
 */
export function forgetBlocked(state: RunsState): string | null {
  const entries = Object.values(state.entries);
  if (entries.some((e) => e.phase === "held" || e.phase === "running")) return "a run that may still be going";
  if (entries.some((e) => e.reservation !== null) || Object.keys(state.ledger.reservations).length > 0) return "budget reserved for a run not yet settled";
  return null;
}

/** What `forget` leaves: no entries, and the day's ledger kept, so forgetting doesn't reset the day's spend (L5). */
export const afterForget = (state: RunsState): RunsState => ({ ...emptyRuns(), ledger: { day: state.ledger.day, spent_micro_usd: state.ledger.spent_micro_usd, reservations: {} }, next_reservation: state.next_reservation });
