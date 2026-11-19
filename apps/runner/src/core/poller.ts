/**
 * Runner's outbound loop (M7 step 6; RUNNER.md lifecycle steps 2 and 5; R-12, R-15, R-22). Runner polls its inbox at an
 * interval the owner sets, over outbound requests only: no listening port, no endpoint, nothing Podster can call.
 *
 * - **Record, then acknowledge.** Each inbox page is applied to the local record and saved durably, and only then is the
 *   cursor acknowledged to Podster. A crash between the two reads the same events again, which the record skips by
 *   sequence; it never acknowledges an offer it didn't record.
 * - **Reconcile on start.** Before polling, and again after any gap it can't account for (events Podster dropped, or a
 *   time offline past the grace period), Runner checks who it is and lists its tasks in each of its workspaces with
 *   `list_tasks`, recording any offer the inbox didn't bring. Work offered while Runner was off is found this way.
 * - **Offline grace.** If the gateway can't be reached for longer than the grace period, Runner counts its authority as
 *   stale: `authorityFresh()` is false, so nothing may start, until it reaches the gateway and reconciles again.
 * - **Authority errors stop it.** A revoked or disconnected agent, a credential whose owner left, or a key that's no
 *   longer accepted stops the loop at once: the key is retired, the record says why, the owner is told, and Runner never
 *   registers or resumes by itself. Its next step is the owner's: pair again from Podster.
 *
 * No CLI or task process starts here; that is later steps' (M7 steps 7 to 9).
 *
 * **The nudge (M7 step 14)**, only when the owner switches it on: `run` passes a `NudgeBell`, which a verified nudge
 * rings to end the wait after a good poll early (never sooner than `NUDGE_GAP_MS` after it). The next poll is this same
 * one. Polling stays on, and a missed nudge loses nothing.
 */
import { Connection } from "./connection.js";
import type { NudgeBell } from "./nudge.js";
import { GatewayError, meaningOf } from "./errors.js";
import { retire } from "./pairing.js";
import { applyEvents, applyListing, readEvents, readTask, type ListedTask } from "./record.js";
import type { Clock, Logger } from "./runtime.js";
import { isId, type RunnerState, type StateStore } from "./state.js";
import { RunnerStorage, type SecretStore } from "./storage.js";

/** The owner's poll interval is held between these. Podster allows each agent 120 calls a minute. */
export const MIN_INTERVAL_MS = 5_000;
export const MAX_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_INTERVAL_MS = 30_000;
/** The offline grace period is held between these. */
export const MIN_GRACE_MS = 60_000;
export const MAX_GRACE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_GRACE_MS = 15 * 60 * 1000;
/** Longest wait between tries while the gateway can't be reached. */
const LONGEST_BACKOFF_MS = 5 * 60 * 1000;
const PAGE = 50;
/** Pages read in one poll before waiting for the next. */
const PAGES_PER_POLL = 20;
/** Pages of one workspace's tasks read in one reconciliation. */
const TASK_PAGES = 40;

export type PollerDeps = {
  origin: string;
  fetch: typeof fetch;
  secrets: SecretStore;
  state: StateStore;
  clock: Clock;
  log: Logger;
  intervalMs?: number;
  graceMs?: number;
};

export type LoopOutcome =
  /** The owner stopped it. */
  | "stopped"
  /** The agent's authority ended. Pair again from Podster. */
  | "revoked";

export type PollResult = "ok" | "unreachable" | "revoked";

/** Thrown when the agent's authority has ended: the caller stops what it's doing, then calls `endAuthority`. */
export class AuthorityEnded extends Error {}

/** The wait after a poll: shortened by a nudge only after a good poll, so a nudge never cuts a backoff or a Retry-After. */
export function waitForNext(clock: Clock, ms: number, result: PollResult, signal: AbortSignal, bell?: NudgeBell): Promise<void> {
  return bell && result === "ok" ? bell.idle(clock, ms, signal) : clock.idle(ms, signal);
}

export const clampInterval = (ms: number) => Math.min(Math.max(Math.round(ms), MIN_INTERVAL_MS), MAX_INTERVAL_MS);
export const clampGrace = (ms: number) => Math.min(Math.max(Math.round(ms), MIN_GRACE_MS), MAX_GRACE_MS);

export class Poller {
  private readonly deps: PollerDeps;
  private readonly storage: RunnerStorage;
  private readonly connection: Connection;
  private state: RunnerState;
  readonly intervalMs: number;
  readonly graceMs: number;
  /** Set on start, after dropped events, and after a time offline past the grace period. */
  private needsReconcile = true;
  private lastDropped: number | null = null;
  private failures = 0;
  private retryAfterMs: number | null = null;

  private constructor(deps: PollerDeps, state: RunnerState) {
    this.deps = deps;
    this.state = state;
    this.storage = new RunnerStorage(deps.secrets);
    this.connection = new Connection({ origin: deps.origin, pluginAgentId: state.plugin_agent_id as string, storage: this.storage, fetch: deps.fetch });
    this.intervalMs = clampInterval(deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.graceMs = clampGrace(deps.graceMs ?? DEFAULT_GRACE_MS);
  }

  /** A poller for a connected Runner. Refuses one that isn't paired, or that stopped and needs its owner. */
  static async open(deps: PollerDeps): Promise<Poller> {
    const state = await deps.state.load();
    if (state.stopped === "revoked") throw new Error("This agent's connection ended in Podster. Pair again from Podster to go on.");
    if (state.stopped !== null) throw new Error("Pairing didn't finish. Start a new pairing in Podster, then run `pair` again.");
    if (state.phase !== "connected" || !isId(state.agent_id) || !isId(state.plugin_agent_id)) throw new Error("This Runner isn't paired yet. Run `pair` first.");
    if (state.gateway !== deps.origin) throw new Error("This Runner is paired with another gateway.");
    return new Poller(deps, state);
  }

  /** A copy of the record as it stands. */
  get record(): RunnerState {
    return structuredClone(this.state);
  }

  /**
   * Whether Runner's view of its authority is current: it reached the gateway within the grace period and has reconciled
   * since any gap. Nothing may start while this is false.
   */
  authorityFresh(): boolean {
    const last = this.state.last_contact_at;
    return this.state.stopped === null && !this.needsReconcile && last !== null && this.deps.clock.now() - last <= this.graceMs;
  }

  private async save(next: RunnerState) {
    await this.deps.state.save(next);
    this.state = next;
  }

  private async call(capability: Parameters<Connection["call"]>[0], args: Record<string, unknown> = {}) {
    try {
      return await this.connection.call(capability, args);
    } catch (error) {
      const failure = error instanceof GatewayError ? error : new GatewayError(0, "network");
      if (meaningOf(failure) === "authority" || meaningOf(failure) === "unclaimed") {
        this.deps.log("runner.authority", "ended", { agent: this.state.agent_id ?? undefined, status: failure.status, code: failure.code });
        throw new AuthorityEnded();
      }
      throw failure;
    }
  }

  /** The Podster agent this Runner acts as. */
  get agentId(): string {
    return this.state.agent_id as string;
  }

  /**
   * One call as the agent, for the lifecycle (M7 step 8). An authority error throws `AuthorityEnded` and changes nothing
   * here: the caller stops any run first, then calls `endAuthority`.
   */
  request(capability: Parameters<Connection["call"]>[0], args: Record<string, unknown> = {}): Promise<unknown> {
    return this.call(capability, args);
  }

  /** Retires the key after an authority error the lifecycle met: the same stop the loop makes for its own. */
  async endAuthority(): Promise<void> {
    if (this.state.stopped === null) this.state = await retire(this.deps, this.storage, this.state, "revoked");
  }

  /** Checks who Runner is, then records every offer its workspaces list for it. */
  async reconcile(): Promise<void> {
    const identity = (await this.call("get_identity")) as Record<string, unknown> | null;
    if (identity?.id !== this.state.agent_id) {
      this.deps.log("runner.reconcile", "wrong_agent", { agent: this.state.agent_id ?? undefined });
      throw new AuthorityEnded();
    }
    const listed = (await this.call("list_workspaces")) as { workspaces?: unknown } | null;
    const workspaces = Array.isArray(listed?.workspaces) ? listed.workspaces : [];
    let state = this.state;
    let tasks = 0;
    for (const row of workspaces) {
      const workspace = (row as Record<string, unknown> | null)?.workspace_id;
      if (!isId(workspace)) continue;
      let cursor: string | null = null;
      let whole = false;
      const found: ListedTask[] = [];
      for (let page = 0; page < TASK_PAGES; page++) {
        let answer: { tasks?: unknown; next_cursor?: unknown } | null;
        try {
          answer = (await this.call("list_tasks", { workspace_id: workspace, mine: true, ...(cursor ? { cursor } : {}) })) as typeof answer;
        } catch (error) {
          // A room this agent can no longer read is skipped; anything else ends this reconciliation, to be tried again.
          if (error instanceof GatewayError && meaningOf(error) === "refused") break;
          throw error;
        }
        for (const task of Array.isArray(answer?.tasks) ? answer.tasks : []) {
          const read = readTask(task);
          if (read) found.push(read);
        }
        cursor = isId(answer?.next_cursor) ? answer.next_cursor : null;
        if (!cursor) {
          whole = true;
          break;
        }
      }
      tasks += found.length;
      state = applyListing(state, this.state.agent_id as string, workspace, found, whole, this.deps.clock.now());
    }
    const now = this.deps.clock.now();
    await this.save({ ...state, reconciled_at: now, last_contact_at: now });
    this.needsReconcile = false;
    this.deps.log("runner.reconcile", "done", { agent: this.state.agent_id ?? undefined, count: tasks });
  }

  /** Reads the inbox to its end (or a bounded number of pages), recording each page before acknowledging it. */
  private async readInbox(): Promise<void> {
    for (let page = 0; page < PAGES_PER_POLL; page++) {
      const answer = readEvents(await this.call("read_inbox", { after: this.state.inbox_cursor, limit: PAGE }));
      if (!answer) throw new GatewayError(0, "bad_answer");
      if (this.lastDropped !== null && answer.dropped > this.lastDropped) {
        // Podster dropped events this Runner never read: only a listing can say what they were.
        this.needsReconcile = true;
        this.deps.log("runner.inbox", "dropped", { agent: this.state.agent_id ?? undefined, count: answer.dropped - this.lastDropped });
      }
      this.lastDropped = answer.dropped;
      const now = this.deps.clock.now();
      const next = applyEvents(this.state, answer.events, now);
      // Saved first, acknowledged after: an offer is never acknowledged before it's on disk.
      await this.save({ ...next, last_contact_at: now });
      if (next.inbox_cursor > 0 && answer.events.length > 0) {
        await this.call("ack_inbox", { up_to: next.inbox_cursor });
        this.deps.log("runner.inbox", "recorded", { agent: this.state.agent_id ?? undefined, seq: next.inbox_cursor, count: answer.events.length });
      }
      if (answer.events.length < PAGE) return;
    }
  }

  /** One poll: a reconciliation if one is due, then the inbox. */
  async pollOnce(): Promise<PollResult> {
    if (this.state.stopped !== null) return "revoked";
    const last = this.state.last_contact_at;
    if (last === null || this.deps.clock.now() - last > this.graceMs) this.needsReconcile = true;
    try {
      if (this.needsReconcile) await this.reconcile();
      await this.readInbox();
      this.failures = 0;
      return "ok";
    } catch (error) {
      if (error instanceof AuthorityEnded) {
        this.state = await retire(this.deps, this.storage, this.state, "revoked");
        return "revoked";
      }
      this.failures++;
      const failure = error instanceof GatewayError ? error : new GatewayError(0, "unknown");
      this.deps.log("runner.poll", "unreachable", { agent: this.state.agent_id ?? undefined, status: failure.status, code: failure.code });
      if (failure.retryAfter !== null) this.retryAfterMs = failure.retryAfter * 1000;
      return "unreachable";
    }
  }

  /** How long to wait before the next poll. */
  nextWaitMs(result: PollResult): number {
    if (result === "ok") return this.intervalMs;
    const backoff = Math.min(this.intervalMs * 2 ** Math.min(this.failures - 1, 10), LONGEST_BACKOFF_MS);
    const asked = this.retryAfterMs;
    this.retryAfterMs = null;
    return Math.max(backoff, asked ?? 0);
  }

  /** Polls until the owner stops it (`signal`) or the agent's authority ends. A nudge's `bell` may end a wait early. */
  async run(signal: AbortSignal, bell?: NudgeBell): Promise<LoopOutcome> {
    let toldOffline = false;
    while (!signal.aborted) {
      const result = await this.pollOnce();
      if (result === "revoked") return "revoked";
      if (result === "ok") toldOffline = false;
      else if (!toldOffline && !this.authorityFresh() && this.offlinePastGrace()) {
        toldOffline = true;
        this.deps.log("runner.offline", "grace_passed", { agent: this.state.agent_id ?? undefined });
      }
      await waitForNext(this.deps.clock, this.nextWaitMs(result), result, signal, bell);
    }
    return "stopped";
  }

  /** Whether the gateway hasn't answered for longer than the grace period. */
  offlinePastGrace(): boolean {
    const last = this.state.last_contact_at;
    return last === null || this.deps.clock.now() - last > this.graceMs;
  }
}
