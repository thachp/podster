/**
 * Runner's lifecycle (M7 step 8; RUNNER.md lifecycle steps 5 to 10, "Run decisions" and "Recovery and delivery
 * semantics"; decision 29's condition 4 as the owner ruled it on 2026-11-17). For each offer the inbox loop recorded:
 *
 * 1. **A fresh `get_task`, a fresh evaluation.** Every evaluation reads the task again, builds the prompt ONLY from the
 *    inputs its `provenance` lists and the change request ONLY from the exact `event_id` it names (`prompt.ts`), and
 *    hashes the prompt's exact bytes. Every rerun, re-offer and change request is a new event, and so a new evaluation:
 *    no decision is ever reused (RUNNER.md: "Every run passes policy, not just the first").
 * 2. **Serialised policy calls.** Evaluate-then-issue, and evaluate-then-consume, each run as one step behind one gate,
 *    with nothing else evaluating or reserving between them, so the day's reservations the policy is given are right (L5
 *    on #455's review). Issuing never passes `own_reservation_micro_usd`; consuming passes the stored record's own
 *    `reserved_micro_usd`. Each record is stored durably, as returned, before anything acts on it.
 * 3. **Modes.** `run` issues at once. `ask` asks the owner on this machine, outside the gate, then issues with
 *    `approved_by_owner` only if a fresh read and evaluation still match what the owner was shown. `refuse` declines an
 *    offer or releases an accepted task, with the reason code; Runner's own local conditions (stale authority, its own
 *    configuration or clock) leave the task waiting instead, since they say nothing about the task.
 * 4. **`accept_task`** sends the evaluated version and an idempotency key stored before it was first sent. A timeout,
 *    network failure or server error is an unknown outcome: retried with the same key, now or after a restart, before
 *    anything starts. A version conflict means the task changed, and it's evaluated afresh with a new key.
 * 5. **Before any start,** a fresh `get_task` must show the task `accepted` by this agent at the version the accept
 *    answered (a retried accept can answer a stored success after a cancel), then a fresh evaluation and the consume.
 * 6. **During a run,** a check-in at a fixed maximum interval reads the task again and re-evaluates: an authority error
 *    stops the run, then the agent (revocation stops at the next check-in); a cancel, a re-offer, changed inputs or a
 *    changed policy stop the run. Cut off from Podster past the grace period, the run stops too.
 * 7. **A local stop** (the owner's `stop`, or Ctrl-C) ends the run at once: the adapter's stop, with no call to Podster
 *    first, whether Podster is reachable or not. Runner then calls nothing until restarted.
 * 8. **Release only after the old process tree is confirmed stopped.** When it isn't, the entry is held: nothing is
 *    released, no new run starts, and the owner is told, until the adapter confirms it.
 *
 * Step 9 builds the adapter; step 11 submits results.
 *
 * **The repository path (M7 step 10).** In a room whose owner named a repository, the decision is issued with that
 * repository and no base, since `get_repo_access` answers only for an accepted task. Before the consume, under the same
 * gate as the fresh evaluation, `RepositoryPath.prepare` makes a fresh, verified checkout at the commit the run starts
 * from; that commit is pinned into the stored decision (`pinRunBase`) and the consume binds it. A run that succeeds is
 * published only after its container is confirmed stopped: committed, pushed to the task's one branch and opened as a
 * pull request, through Runner's broker. Its title and commit message are a Conventional Commits line from the task's
 * title, as the run's inputs had it, and the type the agent proposed from a fixed list, both held in memory only and made
 * inert on GitHub (`pull-text.ts`). A refusal on the repository path releases the task with its code; a passing
 * failure leaves it to be evaluated afresh.
 *
 * **Results (M7 step 11).** A run that ends `succeeded` with a structured result Runner checks again, of status
 * `completed`, is finished and its submission owed; none, or a malformed one, is released, never submitted. A `blocked`
 * result is an answer, not a failure (the architect's ruling of 2026-11-20, below). The result's words are kept in memory only, until they're sent. At a later pass the submission is bound to
 * the run: what it says of the work (the pull request, its commit, the repository) comes from Runner's own records of the
 * run's publication, never from the agent's words; a fresh `get_task` must show the task still accepted by this agent at
 * the version the run started at, with the inputs the run was decided on, or nothing is submitted. The agent's words go
 * only when the run's facts and the room's policy as it stands both allow sharing; otherwise they're held for the owner's
 * review on this machine, Podster gets one fixed progress message, and the owner may share them or not; with no answer
 * within `REVIEW_HOLD_MS`, the result goes without them. Every word is
 * redacted and its hidden characters marked first (`results.ts`). The note is Runner's own. `submit_task` is sent with a
 * key stored first and bound to the note, retried with it on an unknown outcome.
 *
 * **A blocked run (the architect's ruling of 2026-11-20).** The agent's reason is reported to the room on the task's thread
 * with `send_message`, as a Runner note built like a submission's (`composeBlockedNote`) and under the same output
 * policy: shared at once where sharing is allowed, otherwise shown to the owner first, with Runner's fixed words only if
 * they decline or the hold runs out. Then, from a fresh read: a run that answered a change request (the task was
 * submitted before) keeps the task with the agent, for a person to answer or reassign; a first run is released, after
 * the report. The run's inputs and facts are recorded (`blocked`), and a later evaluation with the same ones never runs
 * again (`blocked_same_inputs`): a re-offer is declined and an accepted task left as it is. A new change request or
 * edit (new inputs), a change to the owner's policy (new facts), or a message on the task (a person acted) lets it run.
 *
 * Agent content is data: a task's words are read only to build and hash the prompt and to show the owner on an ask, and a
 * result's only to show the owner and to submit. Logs carry IDs and codes only.
 */
import type { RunAdapter, RunHandle, RunReport, StopResult } from "./adapter.js";
import { GatewayError, meaningOf } from "./errors.js";
import { consumeRunDecision, evaluate, factsKey, issueRunDecision, outputsOf, parsePolicyConfig, pinRunBase, policyProblem, repositoryOf, type AskReason, type Decision, type RunBinding, type RunFacts } from "./policy.js";
import { pullRequestUrl, RepoPathError } from "./repository.js";
import { readTaskDetail, sha256Hex, type TaskDetail } from "./prompt.js";
import { cleanResult, composeBlockedNote, composeNote, type NotePullRequest, type NoteWords, type ResultView } from "./results.js";
import { parseRunResult, type RunResult } from "./tool-policy.js";
import type { NudgeBell } from "./nudge.js";
import { AuthorityEnded, waitForNext, type Poller } from "./poller.js";
import { MAX_PROMPT_BYTES } from "./run-interface.js";
import type { Offer } from "./state.js";
import type { Clock, Logger } from "./runtime.js";
import { budgetOf, clockWentBack, dayOf, newEntry, owedReport, owedSubmission, reserve, settle, type After, type BlockedReport, type GiveUp, type Published, type RunEntry, type RunsState, type RunStore, type Submission } from "./runs.js";

/** The check-in's fixed maximum interval during a run (S-33, S-43). **Proposed** figure. */
export const CHECK_IN_MS = 60_000;
export const MIN_CHECK_IN_MS = 5_000;
/** Tries of one command within a tick before it waits for the next, always with the same key. */
const COMMAND_TRIES = 4;
const FIRST_BACKOFF_MS = 2_000;
/** Evaluations of one task in one UTC day, past which it waits for the next (S-09: re-offers are rate-limited). */
export const MAX_ATTEMPTS_PER_DAY = 20;
/** How long an ask the owner put off waits before it's asked again. */
export const ASK_AGAIN_MS = 10 * 60 * 1000;
/** How long a task waits on a local condition before it's evaluated again; also the wait between publication tries. */
export const WAIT_MS = 60_000;
/**
 * How long a finished run's publication is retried after its first passing failure before the task is released as
 * `repo_publish_failed` (the ruling on #462's held publications). **Proposed** figure.
 */
export const PUBLISH_RETRY_MS = 60 * 60 * 1000;
/** A finished run whose stop is confirmed and whose publication is held for a retry: it runs nothing. */
const publicationHeld = (e: RunEntry) => e.phase === "held" && e.after_stop?.kind === "finish" && typeof e.publish_since === "number";

/**
 * The one progress message Podster gets while a result waits for the owner's review: Runner's fixed status, with no word
 * of the agent's (RUNNER.md: "fixed status generated by Runner, with no model text").
 */
export const HELD_STATUS = "Podster Runner finished its run for this task. The result waits for review by the owner of the machine it ran on before any of it is shared.";
/**
 * How long a result's words wait for the owner's review before the result is submitted without them, with Runner's fixed
 * note only: the ruling on #465's review, for a held review with no terminal to answer it. **Proposed** figure.
 */
export const REVIEW_HOLD_MS = 24 * 60 * 60 * 1000;
/** Refusals of a submission that are safe to send again as they were. */
const SUBMIT_AGAIN = new Set(["pull_request_unread"]);

/** Refusals about Runner's own state, not the task: they leave the task waiting rather than give it up. */
const LOCAL = new Set(["authority_stale", "config_invalid", "budget_invalid", "clock_invalid"]);
/**
 * Refusals that come from the owner's own budget or configuration. Podster is told only `runner_unavailable`, so a
 * decline doesn't disclose the owner's caps or allowlists; the reason itself stays in Runner's record and log (Info on
 * #458's review).
 */
const PRIVATE = new Set([
  "day_budget_exhausted",
  "room_not_configured",
  "requester_out_of_scope",
  "author_out_of_scope",
  // The owner's repository scope and Runner's own setup (M7 step 10): Podster hears only that Runner can't do it.
  "repository_unavailable",
  "repo_repository_out_of_scope",
  "repo_clone_url_unexpected",
  "repo_repository_id_mismatch",
  "repo_repository_renamed",
  "repo_path_unsafe",
  "repo_helper_unavailable",
]);
export const GENERIC_REASON = "runner_unavailable";
/** Events that count as a new attempt at a task: an offer or re-offer, and a change request (L6 on #458). */
const TRIGGERS = new Set(["task.offered", "task.changes_requested", "offered"]);
/**
 * Events read afresh without counting as an attempt, so no task is left unconsidered (L6 liveness, re-review of #458):
 * reconciliation finding a task accepted by this agent, and an edit to a task that's still offered.
 */
const RECHECKS = new Set(["accepted", "task.updated"]);

export type AskView = {
  workspace_id: string;
  task_id: string;
  reason: AskReason;
  room_visibility: RunFacts["room_visibility"];
  requester: string;
  authors: RunFacts["authors"];
  tools: RunFacts["tools"];
  network: string[];
  caps: RunFacts["caps"];
  /** The owner's repository for the room, which the run is checked out from and published to (step 10). */
  repository: RunFacts["repository"];
  /** The task's words, untrusted, for the owner to read. Never stored or logged. */
  inputs: { input: string; text: string }[];
};
export type OwnerAnswer = "approve" | "decline" | "later";
/** Asks the owner on this machine. Silence is never approval: no answer is `later`. A local stop abandons the question. */
export interface OwnerPrompter {
  ask(view: AskView, signal?: AbortSignal): Promise<OwnerAnswer>;
  /**
   * Step 11: whether a held result's words may be shared. `approve` shares them, `decline` submits without them, and
   * `later` (or no way to ask) keeps them held. Silence is never approval.
   */
  review?(view: ResultView, signal?: AbortSignal): Promise<OwnerAnswer>;
}

export type PolicyCalls = { evaluate: typeof evaluate; issueRunDecision: typeof issueRunDecision; consumeRunDecision: typeof consumeRunDecision; pinRunBase?: typeof pinRunBase };

/** A task's repository work, as the lifecycle hands it over: the repository and branch are the decision's own facts. */
export type RepoTask = { workspace_id: string; task_id: string; task_folder: string; repository: NonNullable<RunFacts["repository"]> };
/**
 * What a publication's words are made from (`pull-text.ts`): the task's title as the run's inputs had it, untrusted, and
 * the type the agent proposed. Both are held in memory only, so after a restart they are null and the title falls back.
 */
export type PublishWords = { title: string | null; change_type: string | null };
export type Publication = { kind: "published"; branch: string; commit: string; pr_number: number } | { kind: "no_changes" };

/**
 * The repository path (M7 step 10; `src/node/repo-path.ts`). It holds the task's token in memory, outside every
 * container, and throws `RepoPathError` with a fixed code for anything it refuses or can't do.
 */
export interface RepositoryPath {
  /**
   * A fresh checkout in the task's folder, its Git folder outside it, at the commit the run starts from: the default
   * branch's head, or `continue_from` (what Runner last pushed) while the task branch on GitHub still points at it.
   * Answers that commit, verified as the checkout's head with nothing changed.
   */
  prepare(task: RepoTask & { continue_from: string | null }, signal: AbortSignal): Promise<{ repository_id: string; base_commit: string }>;
  /** After the run's container is confirmed stopped: commit on top of `base_commit`, push the task branch, open its pull request. */
  publish(task: RepoTask & { base_commit: string } & Partial<PublishWords>, signal: AbortSignal): Promise<Publication>;
  /** Drops what it holds for the task, its token included. */
  forget(workspace_id: string, task_id: string): void;
}

export type LifecyclePoller = Pick<Poller, "agentId" | "authorityFresh" | "request" | "endAuthority" | "record" | "graceMs">;

export type LifecycleDeps = {
  poller: LifecyclePoller;
  runs: RunStore;
  /**
   * The owner's run policy: a function that reads Runner's local file afresh, called on every evaluation, so a change
   * such as switching a room's unattended runs off counts at the next one with no restart (L7 on #458). A plain value is
   * used as it is, for tests. A read that throws reads as no policy, which refuses.
   */
  config: unknown | (() => unknown | Promise<unknown>);
  adapter: RunAdapter;
  /**
   * Runner's home: a policy whose workspace root overlaps it is refused (ruling 4 on #462). `run` always gives it; tests
   * may leave it out.
   */
  home?: string;
  /** The repository path; without it, a room with a repository refuses its tasks (`repository_unavailable`). */
  repository?: RepositoryPath;
  prompter: OwnerPrompter;
  clock: Clock;
  log: Logger;
  /** For tests, to watch the calls. The policy itself by default. */
  policy?: PolicyCalls;
  /** Idempotency keys and run IDs. */
  newId?: () => string;
  checkInMs?: number;
};

export type TickOutcome = "idle" | "revoked" | "stopped";


/** One at a time: each call waits for the one before it. */
class Gate {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const keyOf = (workspace: string, task: string) => `${workspace}/${task}`;
/** What marks an offer as new: its latest event, sequence, status and version, never the time it was last listed. */
export const markerOf = (offer: Offer) => `${offer.last}|${offer.seq ?? "-"}|${offer.version ?? "-"}`;
const ACTIVE = new Set(["accepting", "ready", "running", "giving_up", "held", "reporting"]);
/** The SHA-256 of a decision's facts, as a blocked run's record keeps it. */
const factsHash = (key: string) => sha256Hex(new TextEncoder().encode(key));

/** Resolves with `promise`, or with `aborted` at once when the signal fires, whichever is first. */
function orAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => undefined);
      resolve(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
const ABORTED = Symbol("aborted");

export class Lifecycle {
  private readonly deps: LifecycleDeps;
  private readonly policy: PolicyCalls;
  private readonly gate = new Gate();
  private readonly newId: () => string;
  readonly checkInMs: number;
  private state: RunsState;
  /** What the owner approved on an ask, by task, until it's issued: it holds only while a fresh read still matches. */
  private readonly approvals = new Map<string, { hash: string; version: number; facts: string }>();
  /** Each finished run's structured result, by task, until it's submitted: in memory only, never stored or logged. */
  private readonly results = new Map<string, { run_ref: string; result: RunResult }>();
  /** Each repository run's task title, as its inputs had it, by task, for its pull request: in memory only, never stored or logged. */
  private readonly titles = new Map<string, { run_ref: string; title: string }>();
  /** The agent's own organization, checked at open: a policy reread later must still name it. */
  private ownerOrg = "";

  private constructor(deps: LifecycleDeps, state: RunsState) {
    this.deps = deps;
    this.state = state;
    this.policy = { evaluate, issueRunDecision, consumeRunDecision, pinRunBase, ...deps.policy };
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.checkInMs = Math.min(Math.max(Math.round(deps.checkInMs ?? CHECK_IN_MS), MIN_CHECK_IN_MS), CHECK_IN_MS);
  }

  /**
   * The lifecycle for a connected Runner. Refuses a run policy it can't read, or one whose `owner_org` isn't the agent's
   * own organization, which would make every author of that organization read as the owner's. A run that was going when
   * Runner last stopped is held until the adapter confirms it stopped, then released: a run is never resumed.
   */
  static async open(deps: LifecycleDeps): Promise<Lifecycle> {
    const parsed = parsePolicyConfig(await readConfig(deps.config), homeOf(deps));
    if (!parsed.ok) throw new Error(`Runner's run policy can't be used: ${policyProblem(parsed.at)}. Nothing was started.`);
    const identity = (await deps.poller.request("get_identity")) as Record<string, unknown> | null;
    if (identity?.id !== deps.poller.agentId) throw new AuthorityEnded();
    if (identity?.org_id !== parsed.value.owner_org) throw new Error("The run policy's owner_org isn't this agent's organization. Nothing was started.");
    const lifecycle = new Lifecycle(deps, await deps.runs.load());
    lifecycle.ownerOrg = parsed.value.owner_org;
    await lifecycle.recover();
    return lifecycle;
  }

  /** A copy of the record as it stands. */
  get record(): RunsState {
    return structuredClone(this.state);
  }

  private now() {
    return this.deps.clock.now();
  }

  private async save(next: RunsState) {
    await this.deps.runs.save(next);
    this.state = next;
  }

  /** Saves the record with this entry, and the ledger, as given. */
  private async put(entry: RunEntry, ledger = this.state.ledger, nextReservation = this.state.next_reservation) {
    const key = keyOf(entry.workspace_id, entry.task_id);
    await this.save({ ...this.state, ledger, next_reservation: nextReservation, entries: { ...this.state.entries, [key]: { ...entry, updated_at: this.now() } } });
  }

  private log(at: string, outcome: string, entry: { workspace_id: string; task_id: string }, extra: { code?: string; status?: number; count?: number } = {}) {
    this.deps.log(at, outcome, { agent: this.deps.poller.agentId, workspace: entry.workspace_id, task: entry.task_id, ...extra });
  }

  /**
   * Ends every attempt that has no process: its reservation settles at zero, and nothing more is sent for it. A run that
   * may still be going stays held.
   */
  private async abandon(outcome: string) {
    let ledger = this.state.ledger;
    const entries = { ...this.state.entries };
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.phase !== "accepting" && entry.phase !== "ready" && entry.phase !== "giving_up" && entry.phase !== "waiting") continue;
      ledger = settle(ledger, entry.reservation, 0, this.now());
      entries[key] = { ...entry, phase: "done", outcome, decision: null, reservation: null, accept_key: null, give_up: null, expected_version: null, retry_at: null, updated_at: this.now() };
    }
    await this.save({ ...this.state, ledger, entries });
  }

  private async recover() {
    const agent = this.deps.poller.agentId;
    if (this.state.agent_id !== agent) {
      // A record left by an earlier pairing on this home: its tasks aren't this agent's. Spend so far still counts.
      if (this.state.agent_id !== null) await this.abandon("other_agent");
      await this.save({ ...this.state, agent_id: agent });
    }
    for (const entry of Object.values(this.state.entries)) {
      if (entry.phase !== "running") continue;
      // Runner stopped mid-run: whatever the run spent is unknown, so the whole reservation counts.
      const ledger = settle(this.state.ledger, entry.reservation, null, this.now());
      await this.put({ ...entry, phase: "held", outcome: "runner_restarted", reservation: null, after_stop: { kind: "release", reason: "runner_restarted" } }, ledger);
      this.log("lifecycle.run", "held", entry, { code: "runner_restarted" });
    }
  }

  /**
   * One pass: held runs, owed commands, a ready run, then new events, one task at a time. A run started here is supervised
   * to its end before this returns. `signal` is the local stop.
   */
  async tick(signal: AbortSignal): Promise<TickOutcome> {
    if (signal.aborted) return "stopped";
    // One pass at a time: a second call while one runs does nothing.
    if (this.busy) return "idle";
    this.busy = true;
    this.tickSignal = signal;
    try {
      return await this.work(signal);
    } catch (error) {
      if (error instanceof AuthorityEnded) {
        await this.abandon("revoked");
        await this.deps.poller.endAuthority();
        return "revoked";
      }
      if (signal.aborted) return "stopped";
      const failure = error instanceof GatewayError ? error : new GatewayError(0, "unknown");
      this.deps.log("lifecycle.tick", "unreachable", { agent: this.deps.poller.agentId, status: failure.status, code: failure.code });
      return "idle";
    } finally {
      this.busy = false;
    }
  }
  private busy = false;
  /** The local stop of the pass under way, so a publication after a confirmed stop never runs past it. */
  private tickSignal: AbortSignal | undefined;

  private entries(phase: RunEntry["phase"]) {
    return Object.values(this.state.entries).filter((e) => e.phase === phase);
  }

  private async work(signal: AbortSignal): Promise<TickOutcome> {
    // No run is supervised between passes, so any entry still recorded as running is an orphan: held (M2 on #458).
    for (const entry of this.entries("running")) await this.holdOrphan(entry, "run_interrupted");
    for (const entry of this.entries("held")) {
      if (publicationHeld(entry)) {
        // Its stop was confirmed before the publication was first tried: tried again once its wait is over.
        if (signal.aborted) return "stopped";
        if (entry.retry_at === null || this.now() >= entry.retry_at) await this.afterStop(entry, { kind: "finish" });
        continue;
      }
      const stopped = entry.run_ref !== null && (await this.deps.adapter.confirmStopped(entry.run_ref).catch(() => false));
      if (!stopped) continue;
      this.log("lifecycle.run", "confirmed_stopped", entry);
      await this.afterStop(entry, entry.after_stop ?? { kind: "none" });
    }
    const unconfirmed = this.entries("held").filter((e) => !publicationHeld(e));
    if (unconfirmed.length > 0) {
      // A run that may still be going: nothing is released and nothing new starts until it's confirmed stopped.
      this.deps.log("lifecycle.held", "waiting_for_owner", { agent: this.deps.poller.agentId, count: unconfirmed.length });
      return "idle";
    }
    for (const entry of this.entries("finished")) {
      // Step 11: an owed submission, once any wait for the owner's review is over.
      if (signal.aborted) return "stopped";
      if (entry.submission?.state === "owed" && (entry.retry_at === null || this.now() >= entry.retry_at)) await this.submit(entry, signal);
    }
    for (const entry of this.entries("reporting")) {
      // A blocked run's reason, owed to the room, once any wait for the owner's review is over.
      if (signal.aborted) return "stopped";
      if (entry.retry_at === null || this.now() >= entry.retry_at) await this.report(entry, signal);
    }
    for (const entry of this.entries("giving_up")) {
      if (signal.aborted) return "stopped";
      await this.sendGiveUp(entry, signal);
    }
    for (const entry of this.entries("accepting")) {
      if (signal.aborted) return "stopped";
      await this.accept(entry, signal);
    }
    // The owner's limit on tasks held at once counts every held publication, and the run that would start now.
    const waiting = Object.values(this.state.entries).filter(publicationHeld).length;
    if (waiting > 0 && waiting + 1 > (await this.maxActive())) {
      this.deps.log("lifecycle.held", "publication_waiting", { agent: this.deps.poller.agentId, count: waiting });
      return "idle";
    }
    for (const entry of this.entries("ready")) {
      if (signal.aborted) return "stopped";
      return this.start(entry, signal);
    }
    const offers = Object.values(this.deps.poller.record.offers).sort((a, b) => a.updated_at - b.updated_at);
    for (const offer of offers) {
      if (signal.aborted) return "stopped";
      const key = keyOf(offer.workspace_id, offer.task_id);
      const entry = this.state.entries[key];
      if (entry && ACTIVE.has(entry.phase)) continue;
      const marker = markerOf(offer);
      // Only an offer, a re-offer or a change request is a new attempt; a retry after a refused consume or give-up
      // (marker cleared) and a wait that's over aren't, and any other event only moves the marker (L6 on #458).
      const waitOver = !!entry && entry.phase === "waiting" && entry.retry_at !== null && this.now() >= entry.retry_at;
      let counted = false;
      let onlyIfOffered = false;
      if (!entry) counted = true;
      else if (entry.marker === "") counted = false;
      else if (entry.marker !== marker && TRIGGERS.has(offer.last)) counted = true;
      else if (entry.marker !== marker && offer.last === "task.message" && entry.blocked) {
        // A message on a task whose last run answered blocked: a person acted, so the same inputs may run again.
        await this.put({ ...entry, blocked: null });
        counted = true;
      }
      else if (entry.marker !== marker && RECHECKS.has(offer.last)) onlyIfOffered = offer.last === "task.updated";
      else {
        if (entry.marker !== marker) await this.put({ ...entry, marker });
        if (!waitOver) continue;
      }
      await this.consider(offer, marker, counted, signal, false, onlyIfOffered);
      if (signal.aborted) return "stopped";
      const now = this.state.entries[key];
      if (now?.phase === "giving_up") await this.sendGiveUp(now, signal);
      const after = this.state.entries[key];
      if (after?.phase === "accepting") await this.accept(after, signal);
      if (signal.aborted) return "stopped";
      const ready = this.state.entries[key];
      if (ready?.phase === "ready") return this.start(ready, signal);
    }
    return "idle";
  }

  /** The owner's `max_active_tasks`, read afresh; one when the policy can't be read. */
  private async maxActive(): Promise<number> {
    const parsed = parsePolicyConfig(await readConfig(this.deps.config), homeOf(this.deps));
    return parsed.ok ? parsed.value.max_active_tasks : 1;
  }

  /** A fresh `get_task`. Null when the gateway refuses the read (the task isn't this agent's to read) or it's malformed. */
  private async read(workspace: string, task: string): Promise<TaskDetail | null> {
    let answer: unknown;
    try {
      answer = await this.deps.poller.request("get_task", { workspace_id: workspace, task_id: task });
    } catch (error) {
      if (error instanceof GatewayError && meaningOf(error) === "refused") return null;
      throw error;
    }
    const detail = await readTaskDetail(answer);
    // An answer about another task is never read as this one (step 12's harness).
    return detail && detail.task.id === task ? detail : null;
  }

  private budget(ownReservation?: number) {
    const budget = budgetOf(this.state.ledger, this.now());
    return ownReservation === undefined ? budget : { ...budget, own_reservation_micro_usd: ownReservation };
  }

  private async evaluateFresh(detail: TaskDetail, entry: RunEntry, authorityFresh: boolean, ownReservation?: number): Promise<Decision> {
    const ids = { task_id: entry.task_id, workspace_id: entry.workspace_id };
    // A clock gone back before the ledger's day can't be trusted with the day's budget (L4 on #458).
    if (clockWentBack(this.state.ledger, this.now())) return { outcome: "refuse", reason: "clock_invalid", ...ids };
    const config = await readConfig(this.deps.config);
    const parsed = parsePolicyConfig(config, homeOf(this.deps));
    if (parsed.ok && parsed.value.owner_org !== this.ownerOrg) return { outcome: "refuse", reason: "config_invalid", ...ids };
    return this.policy.evaluate({
      config,
      provenance: detail.provenance,
      prompt: detail.prompt?.shape ?? null,
      task: { id: entry.task_id, workspace_id: entry.workspace_id },
      authority_fresh: authorityFresh,
      budget: this.budget(ownReservation),
      ...homeOf(this.deps),
      now: this.now(),
    });
  }

  /** A new event for a task, or a wait that's over: a fresh read and a fresh evaluation. */
  private async consider(offer: Offer, marker: string, counted: boolean, signal: AbortSignal, approvedRound = false, onlyIfOffered = false): Promise<void> {
    const key = keyOf(offer.workspace_id, offer.task_id);
    const today = dayOf(this.now());
    const known = this.state.entries[key] ?? newEntry(offer.workspace_id, offer.task_id, this.now());
    const attempts = known.attempts.day === today ? known.attempts : { day: today, count: 0 };
    if (counted && attempts.count >= MAX_ATTEMPTS_PER_DAY) {
      await this.put({ ...known, marker, phase: "waiting", outcome: "attempts_exhausted", retry_at: (today + 1) * 24 * 60 * 60 * 1000 });
      this.log("lifecycle.decision", "waiting", known, { code: "attempts_exhausted" });
      return;
    }
    const entry: RunEntry = { ...known, marker, attempts: { day: today, count: attempts.count + (counted ? 1 : 0) }, retry_at: null, decision: null, consumed: null, reservation: null, accept_key: null, expected_version: null, run_ref: null, give_up: null, after_stop: null, submission: null };
    const detail = await this.read(offer.workspace_id, offer.task_id);
    const task = detail?.task;
    if (!detail || !task || task.assignee !== this.deps.poller.agentId || (task.status !== "offered" && task.status !== "accepted")) {
      this.forgetWords(key);
      await this.put({ ...entry, phase: "done", outcome: task ? `task_${task.status}` : "not_readable" });
      return;
    }
    if (onlyIfOffered && task.status !== "offered") {
      // An edit to a task that isn't an offer any more: nothing to evaluate. A running run's check-in sees edits itself.
      await this.put({ ...known, marker, attempts: entry.attempts });
      return;
    }
    if (task.status === "accepted" && detail.prompt && entry.ran_hash === detail.prompt.hash) {
      // A run with these exact inputs finished already; nothing new to run.
      // A finished run's record is kept whole for step 11.
      if (known.phase === "finished") await this.put({ ...known, marker, attempts: entry.attempts });
      else await this.put({ ...entry, phase: "done", outcome: "already_ran" });
      return;
    }
    const asked = await this.gate.run(() => this.decide(entry, detail));
    if (!asked) return;
    // Stored before the owner is asked, so this attempt counts once whatever the answer (L6 on #458).
    const asking: RunEntry = { ...entry, phase: "waiting", outcome: "asking", retry_at: this.now() + ASK_AGAIN_MS };
    await this.put(asking);
    const answer = await this.deps.prompter.ask(asked.view, signal);
    if (signal.aborted) return;
    this.log("lifecycle.ask", answer, entry, { code: asked.decision.reason });
    if (answer === "approve" && detail.prompt && !approvedRound) {
      const facts = factsKey(asked.decision);
      if (facts) this.approvals.set(key, { hash: detail.prompt.hash, version: task.version, facts });
      // Issued only on a fresh read and evaluation that still match what the owner saw.
      await this.consider(offer, marker, false, signal, true);
      return;
    }
    if (answer === "decline") {
      await this.gate.run(() => this.giveUp(entry, task.status, "owner_declined", task.version));
      return;
    }
    await this.put({ ...entry, phase: "waiting", outcome: answer === "approve" ? "approval_stale" : "owner_later", retry_at: this.now() + ASK_AGAIN_MS });
  }

  /**
   * Evaluate, then issue, as one step behind the gate. Answers what to ask the owner when the policy asks and no matching
   * approval is held; otherwise it has stored what follows: an issued decision, a decline or release owed, or a wait.
   */
  private async decide(entry: RunEntry, detail: TaskDetail): Promise<{ view: AskView; decision: Decision & { outcome: "ask" } } | null> {
    const key = keyOf(entry.workspace_id, entry.task_id);
    const task = detail.task;
    const current = this.state.entries[key];
    // Never a second decision for a task that already has one in hand.
    if (current && ACTIVE.has(current.phase)) return null;
    if (!detail.prompt) {
      // An input provenance lists isn't in the answer: no prompt can be built from exactly those inputs.
      this.log("lifecycle.decision", "refuse", entry, { code: "prompt_unavailable" });
      await this.giveUp(entry, task.status, "prompt_unavailable", task.version);
      return null;
    }
    if (detail.prompt.bytes.byteLength > MAX_PROMPT_BYTES) {
      // Words past the most a driver is handed could never start: declined before anything is reserved or accepted
      // (step 12's harness: they were accepted, then failed at the start and were released).
      this.log("lifecycle.decision", "refuse", entry, { code: "prompt_too_large" });
      await this.giveUp(entry, task.status, "prompt_too_large", task.version);
      return null;
    }
    // Never `own_reservation_micro_usd` here: no reservation of this decision's exists before it's issued.
    const decision = await this.evaluateFresh(detail, entry, this.deps.poller.authorityFresh());
    this.log("lifecycle.decision", decision.outcome, entry, { code: decision.reason });
    if (decision.outcome === "refuse") {
      if (LOCAL.has(decision.reason)) await this.put({ ...entry, phase: "waiting", outcome: decision.reason, retry_at: this.now() + WAIT_MS });
      else await this.giveUp(entry, task.status, decision.reason, task.version);
      return null;
    }
    const blocked = entry.blocked;
    if (decision.outcome === "run" && blocked && blocked.input_hash === detail.prompt.hash && blocked.facts_hash === (await factsHash(factsKey(decision) ?? ""))) {
      // The last run on these exact inputs and facts answered blocked, and its reason went to the room: nothing new to
      // run on, so no spend. An ask still asks the owner, who may run it.
      this.log("lifecycle.decision", "refuse", entry, { code: "blocked_same_inputs" });
      if (task.status === "offered") await this.giveUp(entry, task.status, "blocked_same_inputs", task.version);
      // A first run's task is never left accepted: its release, refused or lost before, is sent again.
      else if (detail.prompt.shape.change_request_event_id === null) await this.giveUp(entry, task.status, "run_blocked", task.version);
      else await this.put({ ...entry, phase: "done", outcome: "blocked_same_inputs" });
      return null;
    }
    let approved = false;
    if (decision.outcome === "ask") {
      const held = this.approvals.get(key);
      approved = !!held && held.hash === detail.prompt.hash && held.version === task.version && held.facts === factsKey(decision);
      this.approvals.delete(key);
      if (!approved) return { view: askView(entry, decision, detail), decision };
    }
    // The owner's repository for the room, if any; its base is pinned after the accept, against a fresh checkout.
    const repository = decision.facts.repository;
    const binding: RunBinding = { task_id: entry.task_id, workspace_id: entry.workspace_id, task_version: task.version, input_hash: detail.prompt.hash, repository_id: repository === null ? null : String(repository.provider_repo_id), base_commit: null };
    const issued = this.policy.issueRunDecision(decision, binding, this.now(), approved ? { approved_by_owner: true } : {});
    if (!issued.ok) {
      await this.put({ ...entry, phase: "waiting", outcome: `issue_${issued.reason}`, retry_at: this.now() + WAIT_MS });
      this.log("lifecycle.issue", "refused", entry, { code: issued.reason });
      return null;
    }
    const reservation = `r${this.state.next_reservation}`;
    const ledger = reserve(this.state.ledger, reservation, issued.record.reserved_micro_usd, this.now());
    const offered = task.status === "offered";
    // Stored as returned, with its reservation and, for an offer, the accept's key, before anything is sent.
    await this.put(
      { ...entry, phase: offered ? "accepting" : "ready", outcome: decision.reason, decision: issued.record, reservation, accept_key: offered ? this.newId() : null, expected_version: offered ? null : task.version },
      ledger,
      this.state.next_reservation + 1,
    );
    this.log("lifecycle.issue", issued.record.mode, entry);
    return null;
  }

  /** Records that a decline (an offer) or a release (an accepted task) is owed, with its key. Sent by `sendGiveUp`. */
  private async giveUp(entry: RunEntry, status: string, reason: string, version: number | null = null) {
    if (status !== "offered" && status !== "accepted") {
      await this.put({ ...entry, phase: "done", outcome: reason });
      return;
    }
    const capability = status === "offered" ? "decline_task" : "release_task";
    // What Podster is told; the record keeps the reason itself.
    const told = PRIVATE.has(reason) ? GENERIC_REASON : reason;
    await this.put({ ...entry, phase: "giving_up", outcome: reason, give_up: { capability, reason: told, version, key: this.newId() } });
  }

  private async backoff(attempt: number, signal: AbortSignal, failure: GatewayError) {
    const wait = Math.max(FIRST_BACKOFF_MS * 2 ** attempt, (failure.retryAfter ?? 0) * 1000);
    await this.deps.clock.idle(Math.min(wait, 60_000), signal);
  }

  /** Sends an owed decline or release, retried with its stored key. */
  private async sendGiveUp(entry: RunEntry, signal: AbortSignal): Promise<void> {
    // After a local stop nothing calls Podster (L1 on #458).
    if (signal.aborted) return;
    let give = entry.give_up as GiveUp;
    if (give.version === null) {
      // A release after a stop: the task's version as it stands, read before the key is first used.
      const detail = await this.read(entry.workspace_id, entry.task_id);
      const task = detail?.task;
      if (!task || task.assignee !== this.deps.poller.agentId || task.status !== (give.capability === "decline_task" ? "offered" : "accepted")) {
        await this.put({ ...entry, phase: "done", give_up: null, outcome: task ? `task_${task.status}` : "not_readable" });
        return;
      }
      give = { ...give, version: task.version };
      entry = { ...entry, give_up: give };
      await this.put(entry);
    }
    for (let attempt = 0; attempt < COMMAND_TRIES; attempt++) {
      try {
        await this.deps.poller.request(give.capability, { workspace_id: entry.workspace_id, task_id: entry.task_id, version: give.version, reason: give.reason, idempotency_key: give.key });
        await this.put({ ...entry, phase: "done", give_up: null });
        this.log("lifecycle.give_up", give.capability === "decline_task" ? "declined" : "released", entry, { code: give.reason });
        return;
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        const meaning = meaningOf(error);
        if (meaning === "refused") {
          // The task changed under it: it's read and evaluated afresh at its next turn.
          await this.put({ ...entry, phase: "done", give_up: null, marker: "", outcome: `give_up_${error.code}` });
          this.log("lifecycle.give_up", "refused", entry, { status: error.status, code: error.code });
          return;
        }
        if (attempt + 1 < COMMAND_TRIES) await this.backoff(attempt, signal, error);
        if (signal.aborted) return;
      }
    }
    this.log("lifecycle.give_up", "unknown", entry);
  }

  /** Sends the accept, with the evaluated version and the stored key, retried with that key until it's answered. */
  private async accept(entry: RunEntry, signal: AbortSignal): Promise<void> {
    const decision = entry.decision;
    if (!decision || !entry.accept_key) throw new Error("accept_without_decision");
    if (signal.aborted) return;
    for (let attempt = 0; attempt < COMMAND_TRIES; attempt++) {
      try {
        const answer = (await this.deps.poller.request("accept_task", { workspace_id: entry.workspace_id, task_id: entry.task_id, version: decision.task_version, idempotency_key: entry.accept_key })) as Record<string, unknown> | null;
        const version = answer?.version;
        if (answer?.status === "accepted" && answer.assignee === this.deps.poller.agentId && typeof version === "number" && Number.isSafeInteger(version)) {
          await this.put({ ...entry, phase: "ready", expected_version: version });
          this.log("lifecycle.accept", "accepted", entry);
        } else {
          await this.drop(entry, "accept_unexpected");
        }
        return;
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        if (meaningOf(error) === "refused") {
          // `version_conflict`: the task changed after it was evaluated. Evaluated afresh, with a new key.
          await this.drop(entry, `accept_${error.code}`, error.code === "version_conflict" ? "" : entry.marker);
          this.log("lifecycle.accept", "refused", entry, { status: error.status, code: error.code });
          return;
        }
        // Unknown: the accept may have happened. Only the same key is ever sent for it.
        if (attempt + 1 < COMMAND_TRIES) await this.backoff(attempt, signal, error);
        if (signal.aborted) return;
      }
    }
    this.log("lifecycle.accept", "unknown", entry);
  }

  /** Ends an attempt that never ran: its reservation settles at zero. */
  private async drop(entry: RunEntry, outcome: string, marker = entry.marker) {
    const ledger = settle(this.state.ledger, entry.reservation, 0, this.now());
    await this.put({ ...entry, phase: "done", outcome, marker, decision: null, reservation: null, accept_key: null, expected_version: null }, ledger);
  }

  /** The fresh read, the fresh evaluation and the consume, then the run, supervised to its end. */
  private async start(entry: RunEntry, signal: AbortSignal): Promise<TickOutcome> {
    const decision = entry.decision;
    if (!decision) throw new Error("start_without_decision");
    const detail = await this.read(entry.workspace_id, entry.task_id);
    if (signal.aborted) return "stopped";
    const task = detail?.task;
    if (!detail || !task || task.status !== "accepted" || task.assignee !== this.deps.poller.agentId) {
      // Canceled, re-offered or taken back after the accept: a retried accept may have answered a stored success.
      await this.drop(entry, task ? `task_${task.status}` : "not_readable", task?.status === "offered" ? "" : entry.marker);
      this.log("lifecycle.start", "not_accepted", entry, { code: task?.status });
      return "idle";
    }
    const prompt = detail.prompt;
    const started = await this.gate.run(async () => {
      if (signal.aborted) return "aborted" as const;
      let fresh = await this.evaluateFresh(detail, entry, this.deps.poller.authorityFresh(), decision.reserved_micro_usd);
      if (signal.aborted) return "aborted" as const;
      // The accept moved the version by exactly itself; any other change since shows as a different version and refuses.
      const version = task.version === entry.expected_version ? decision.task_version : task.version;
      // A room with a repository: a fresh checkout, verified, and its commit pinned into the stored decision (step 10).
      let pinned = decision;
      if (decision.repository_id !== null && prompt && fresh.outcome !== "refuse") {
        const checkout = await this.checkout(entry, decision, fresh.facts, signal);
        if (checkout === "aborted") return "aborted" as const;
        if (checkout === null) return null;
        pinned = checkout;
        // The checkout took time: the policy is read and evaluated again, so anything the owner changed meanwhile
        // refuses the consume with `facts_changed` (ruling 7 on #462).
        fresh = await this.evaluateFresh(detail, entry, this.deps.poller.authorityFresh(), decision.reserved_micro_usd);
        if (signal.aborted) return "aborted" as const;
      }
      const binding: RunBinding = { task_id: entry.task_id, workspace_id: entry.workspace_id, task_version: version, input_hash: prompt?.hash ?? "", repository_id: pinned.repository_id, base_commit: pinned.base_commit };
      const consumed = prompt ? this.policy.consumeRunDecision(pinned, fresh, binding, this.now()) : ({ ok: false, reason: "binding_changed" } as const);
      if (!consumed.ok) {
        if (entry.decision?.repository_id) this.deps.repository?.forget(entry.workspace_id, entry.task_id);
        const ledger = settle(this.state.ledger, entry.reservation, 0, this.now());
        const cleared: RunEntry = { ...entry, decision: null, reservation: null, expected_version: null };
        this.state = { ...this.state, ledger };
        this.log("lifecycle.consume", "refused", entry, { code: consumed.reason });
        if (!prompt) await this.giveUp(cleared, task.status, "prompt_unavailable", task.version);
        else if (fresh.outcome === "refuse" && !LOCAL.has(fresh.reason)) await this.giveUp(cleared, task.status, fresh.reason, task.version);
        // Expired, or anything else that changed: evaluated afresh at its next turn, asking again if the policy asks.
        else await this.put({ ...cleared, phase: "done", marker: "", outcome: `consume_${consumed.reason}` });
        return null;
      }
      // A local stop while the policy decided: nothing is consumed, and the decision waits as it was (M1 on #458).
      if (signal.aborted) return "aborted" as const;
      const run_ref = this.newId();
      // Stored as returned, with the run's ID, before the adapter starts anything.
      const running: RunEntry = { ...entry, phase: "running", outcome: "started", consumed: consumed.record, run_ref };
      await this.put(running);
      const title = prompt?.inputs.find((i) => i.input === "title")?.text;
      if (consumed.record.repository_id !== null && title !== undefined) this.titles.set(keyOf(entry.workspace_id, entry.task_id), { run_ref, title });
      return { running, facts: (fresh as Decision & { facts: RunFacts }).facts };
    });
    if (started === "aborted") return "stopped";
    if (!started || !prompt) return "idle";
    const { running, facts } = started;
    this.log("lifecycle.run", "started", running);
    try {
      let handle: RunHandle;
      const starting = this.deps.adapter.start({ run_ref: running.run_ref as string, workspace_id: running.workspace_id, task_id: running.task_id, prompt: prompt.bytes, facts });
      try {
        const answered = await orAbort(starting, signal);
        if (answered === ABORTED) {
          // Stopped while the adapter was starting: whatever it starts is stopped as soon as it's there, and the run is
          // held until the adapter confirms nothing is left of it.
          starting.then((late) => this.safeStop(late), () => undefined);
          this.log("lifecycle.stop", "local_stop_unknown", running);
          await this.stopped(running, "unknown", null, "stopped_locally", { kind: "release", reason: "stopped_locally" }, false);
          return "stopped";
        }
        handle = answered;
      } catch (error) {
        // A run that never started: its cause, a code only, is logged and reported to the room before the release.
        const cause = startCause(error);
        this.log("lifecycle.run", "start_failed", running, { code: cause });
        const stopped = await this.deps.adapter.confirmStopped(running.run_ref as string).catch(() => false);
        await this.stopped(running, stopped ? "stopped" : "unknown", null, "run_failed", { kind: "start_failed", code: cause });
        return "idle";
      }
      // A local stop that came while the adapter started ends the run now, with no wait for a check-in (M1 on #458).
      if (signal.aborted) return await this.localStop(running, handle);
      return await this.supervise(running, handle, signal);
    } catch (error) {
      // Whatever went wrong, a run that may still be going is never left looking like nothing is (M2 on #458).
      await this.holdOrphan(running, "run_interrupted");
      throw error;
    }
  }

  /**
   * Step 10's checkout, inside the gate between the fresh evaluation and the consume: a fresh, verified checkout of the
   * decision's own repository, and its commit pinned into the stored decision. Answers the pinned decision, or null when
   * the task was given up, left to be evaluated afresh, or held.
   */
  private async checkout(entry: RunEntry, decision: NonNullable<RunEntry["decision"]>, facts: RunFacts, signal: AbortSignal): Promise<NonNullable<RunEntry["decision"]> | null | "aborted"> {
    const repository = facts.repository;
    const path = this.deps.repository;
    const release = async (reason: string) => {
      path?.forget(entry.workspace_id, entry.task_id);
      const ledger = settle(this.state.ledger, entry.reservation, 0, this.now());
      this.state = { ...this.state, ledger };
      await this.giveUp({ ...entry, decision: null, reservation: null, expected_version: null }, "accepted", reason);
    };
    // The fresh facts name the decision's repository, or the consume refuses them anyway; no path is never a quiet run.
    if (repository === null || String(repository.provider_repo_id) !== decision.repository_id) return decision;
    if (!path) {
      this.log("lifecycle.repository", "refused", entry, { code: "repository_unavailable" });
      await release("repository_unavailable");
      return null;
    }
    const published = entry.published && entry.published.repository_id === decision.repository_id ? entry.published : null;
    let base: string;
    try {
      const checkout = await path.prepare({ workspace_id: entry.workspace_id, task_id: entry.task_id, task_folder: facts.task_folder, repository, continue_from: published?.commit ?? null }, signal);
      if (signal.aborted) return "aborted";
      if (checkout.repository_id !== decision.repository_id) throw new RepoPathError("repository_id_mismatch");
      base = checkout.base_commit;
    } catch (error) {
      if (signal.aborted) return "aborted";
      if (!(error instanceof RepoPathError)) throw error;
      this.log("lifecycle.repository", error.transient ? "unavailable" : "refused", entry, { code: error.code });
      if (error.transient) {
        // Passing: the decision is dropped and the task evaluated afresh at its next turn, with a new checkout.
        path.forget(entry.workspace_id, entry.task_id);
        const ledger = settle(this.state.ledger, entry.reservation, 0, this.now());
        this.state = { ...this.state, ledger };
        await this.put({ ...entry, phase: "waiting", outcome: `repo_${error.code}`, decision: null, reservation: null, expected_version: null, retry_at: this.now() + WAIT_MS });
      } else await release(`repo_${error.code}`);
      return null;
    }
    const pin = (this.policy.pinRunBase ?? pinRunBase)(decision, base, this.now());
    if (!pin.ok) {
      this.log("lifecycle.repository", "pin_refused", entry, { code: pin.reason });
      path.forget(entry.workspace_id, entry.task_id);
      const ledger = settle(this.state.ledger, entry.reservation, 0, this.now());
      this.state = { ...this.state, ledger };
      await this.put({ ...entry, phase: "done", marker: "", outcome: `pin_${pin.reason}`, decision: null, reservation: null, expected_version: null });
      return null;
    }
    // Stored as returned, before the consume reads it.
    await this.put({ ...entry, decision: pin.record });
    this.log("lifecycle.repository", "checked_out", entry);
    return pin.record;
  }

  /**
   * Step 10's publication, after the run's container is confirmed stopped: committed, pushed and opened as a pull request
   * through the broker. Answers what to store, or null when the task was given up instead. After a local stop nothing
   * reaches Podster or GitHub: the finish waits, held, for a restart.
   */
  private async publish(entry: RunEntry, signal: AbortSignal | undefined): Promise<{ published: Published | null; outcome: string } | null | "wait" | { wait: string }> {
    const consumed = entry.consumed;
    const facts = consumed && consumed.repository_id !== null ? repositoryOf(consumed) : null;
    if (!consumed || consumed.repository_id === null) return { published: entry.published ?? null, outcome: entry.outcome ?? "succeeded" };
    if (!facts || consumed.base_commit === null) {
      await this.giveUp(entry, "accepted", "repo_record_invalid");
      return null;
    }
    if (signal?.aborted) return "wait";
    const path = this.deps.repository;
    if (!path) {
      await this.giveUp(entry, "accepted", "repository_unavailable");
      return null;
    }
    try {
      const key = keyOf(entry.workspace_id, entry.task_id);
      const held = this.titles.get(key);
      const kept = this.results.get(key);
      const words: PublishWords = { title: held && held.run_ref === entry.run_ref ? held.title : null, change_type: kept && kept.run_ref === entry.run_ref ? (kept.result.change_type ?? null) : null };
      const publication = await path.publish({ workspace_id: entry.workspace_id, task_id: entry.task_id, task_folder: facts.task_folder, repository: facts.repository, base_commit: consumed.base_commit, ...words }, signal ?? new AbortController().signal);
      // Published or not, the title has done its work; the result stays held for the submission.
      this.titles.delete(key);
      if (publication.kind === "no_changes") {
        this.log("lifecycle.publish", "no_changes", entry);
        return { published: entry.published ?? null, outcome: "no_changes" };
      }
      this.log("lifecycle.publish", "published", entry, { count: publication.pr_number });
      return { published: { repository_id: consumed.repository_id as string, branch: publication.branch, commit: publication.commit, pr_number: publication.pr_number }, outcome: "published" };
    } catch (error) {
      if (signal?.aborted) return "wait";
      if (!(error instanceof RepoPathError)) throw error;
      if (error.transient) {
        // Passing: the finished work is kept and published again at a later pass, never released (ruling 5 on #462).
        this.log("lifecycle.publish", "unavailable", entry, { code: error.code });
        return { wait: `repo_${error.code}` };
      }
      this.titles.delete(keyOf(entry.workspace_id, entry.task_id));
      this.log("lifecycle.publish", "refused", entry, { code: error.code });
      await this.giveUp(entry, "accepted", `repo_${error.code}`);
      return null;
    } finally {
      path.forget(entry.workspace_id, entry.task_id);
    }
  }

  /** A stop that throws counts as unconfirmed (M2 on #458). */
  private async safeStop(handle: RunHandle): Promise<StopResult> {
    try {
      return (await handle.stop()) === "stopped" ? "stopped" : "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * Holds an entry still recorded as running: its spend counts as the whole reservation, and it's released only once the
   * adapter confirms it stopped. Kept in memory if the record can't be saved, so this process starts nothing new.
   */
  private async holdOrphan(entry: RunEntry, outcome: string) {
    const key = keyOf(entry.workspace_id, entry.task_id);
    const current = this.state.entries[key];
    if (!current || current.phase !== "running") return;
    const ledger = settle(this.state.ledger, current.reservation, null, this.now());
    const next: RunsState = { ...this.state, ledger, entries: { ...this.state.entries, [key]: { ...current, phase: "held", outcome, reservation: null, after_stop: { kind: "release", reason: outcome }, updated_at: this.now() } } };
    try {
      await this.save(next);
    } catch {
      this.state = next;
    }
    this.log("lifecycle.run", "held", entry, { code: outcome });
  }

  /** Waits on the run, checking in at the fixed interval, and stops it on a local stop or anything a check-in finds. */
  private async supervise(entry: RunEntry, handle: RunHandle, signal: AbortSignal): Promise<TickOutcome> {
    const done = handle.done.then(
      (report) => ({ kind: "done" as const, report }),
      () => ({ kind: "done" as const, report: { status: "failed", spent_micro_usd: null } as RunReport }),
    );
    let lastContact = this.now();
    for (;;) {
      // Before every wait, and never a listener on a signal that already fired (M1 on #458).
      if (signal.aborted) return this.localStop(entry, handle);
      const wake = new AbortController();
      const onAbort = () => wake.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const checkIn = this.deps.clock.idle(this.checkInMs, wake.signal).then(() => ({ kind: "check_in" as const }));
      const next = await Promise.race([done, checkIn]);
      wake.abort();
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return this.localStop(entry, handle);
      if (next.kind === "done") return this.ended(entry, handle, next.report);

      let detail: TaskDetail | null | typeof ABORTED;
      try {
        detail = await orAbort(this.read(entry.workspace_id, entry.task_id), signal);
      } catch (error) {
        if (error instanceof AuthorityEnded) {
          // Revoked in Podster: the run stops at this check-in, then the agent's key is retired.
          await this.stopFor(entry, handle, "revoked", { kind: "none" });
          throw error;
        }
        if (signal.aborted) return this.localStop(entry, handle);
        if (this.now() - lastContact > this.deps.poller.graceMs) {
          await this.stopFor(entry, handle, "offline_grace", { kind: "release", reason: "offline_grace" });
          return "idle";
        }
        this.log("lifecycle.check_in", "unreachable", entry);
        continue;
      }
      if (detail === ABORTED || signal.aborted) return this.localStop(entry, handle);
      lastContact = this.now();
      const verdict = await this.gate.run(() => this.checkIn(entry, detail));
      if (verdict) {
        await this.stopFor(entry, handle, verdict.outcome, verdict.after);
        return "idle";
      }
      this.log("lifecycle.check_in", "ok", entry);
    }
  }

  /**
   * What a check-in finds: null to go on, or why to stop and what follows. The task must still be accepted by this agent
   * with the inputs the run was decided on, and a fresh evaluation must give the same facts, and `run` for an unattended
   * decision.
   */
  private async checkIn(entry: RunEntry, detail: TaskDetail | null): Promise<{ outcome: string; after: After } | null> {
    const consumed = entry.consumed as NonNullable<RunEntry["consumed"]>;
    const task = detail?.task;
    if (!detail || !task) return { outcome: "not_readable", after: { kind: "none" } };
    if (task.status === "canceled") return { outcome: "canceled", after: { kind: "none" } };
    if (task.status !== "accepted" || task.assignee !== this.deps.poller.agentId) return { outcome: `task_${task.status}`, after: { kind: "reconsider" } };
    if (!detail.prompt || detail.prompt.hash !== consumed.input_hash) return { outcome: "inputs_changed", after: { kind: "reconsider" } };
    // The read just made was answered as this agent, so its authority is fresh for this evaluation.
    const fresh = await this.evaluateFresh(detail, entry, true, consumed.reserved_micro_usd);
    if (fresh.outcome === "refuse") return { outcome: `policy_${fresh.reason}`, after: { kind: "reconsider" } };
    if (consumed.mode === "unattended" && fresh.outcome !== "run") return { outcome: "policy_changed", after: { kind: "reconsider" } };
    if (factsKey(fresh) !== consumed.facts_key) return { outcome: "policy_changed", after: { kind: "reconsider" } };
    return null;
  }

  /** The owner's local stop: the run's process tree first, with no call to Podster, then the record on this machine. */
  private async localStop(entry: RunEntry, handle: RunHandle): Promise<TickOutcome> {
    const result = await this.safeStop(handle);
    this.log("lifecycle.stop", result === "stopped" ? "local_stop" : "local_stop_unknown", entry);
    // The release is owed to Podster and sent after a restart, once the stop is confirmed.
    await this.stopped(entry, result, null, "stopped_locally", { kind: "release", reason: "stopped_locally" }, false);
    return "stopped";
  }

  private async stopFor(entry: RunEntry, handle: RunHandle, outcome: string, after: After) {
    const result = await this.safeStop(handle);
    await this.stopped(entry, result, null, outcome, after);
  }

  /** A run that ended by itself. A failure, a budget stop or a time-out is never a submission: it's released. */
  private async ended(entry: RunEntry, handle: RunHandle, report: RunReport): Promise<TickOutcome> {
    // Confirmed, not assumed: the tree is stopped before anything is released (R-24).
    const result = await this.safeStop(handle);
    const spent = typeof report.spent_micro_usd === "number" ? report.spent_micro_usd : null;
    if (report.status !== "succeeded") {
      await this.stopped(entry, result, spent, `run_${report.status}`, { kind: "release", reason: `run_${report.status}` });
      return "idle";
    }
    // Step 11: the result is evidence, checked again here, so an adapter that hands over a malformed one is caught, not
    // trusted. Only `completed` is work to submit; `blocked` is an answer whose reason the room is told; none or a
    // malformed one is released.
    const parsed = report.result ? parseRunResult(report.result) : null;
    if (parsed?.ok && parsed.value.status === "completed") {
      this.results.set(keyOf(entry.workspace_id, entry.task_id), { run_ref: entry.run_ref as string, result: parsed.value });
      await this.stopped(entry, result, spent, "succeeded", { kind: "finish" });
    } else if (parsed?.ok && parsed.value.status === "blocked") {
      this.results.set(keyOf(entry.workspace_id, entry.task_id), { run_ref: entry.run_ref as string, result: parsed.value });
      await this.stopped(entry, result, spent, "run_blocked", { kind: "blocked" });
    } else {
      const reason = !report.result ? "result_missing" : "result_invalid";
      await this.stopped(entry, result, spent, reason, { kind: "release", reason });
    }
    return "idle";
  }

  /** Settles the run's reservation and records what follows: at once if the stop is confirmed, held if it isn't. */
  private async stopped(entry: RunEntry, result: StopResult, spent: number | null, outcome: string, after: After, act = true) {
    const ledger = settle(this.state.ledger, entry.reservation, spent, this.now());
    this.state = { ...this.state, ledger };
    const settled: RunEntry = { ...entry, reservation: null, outcome };
    this.log("lifecycle.run", outcome, entry, { count: spent ?? undefined });
    if (result !== "stopped") {
      await this.put({ ...settled, phase: "held", after_stop: after });
      this.log("lifecycle.run", "held", entry, { code: outcome });
      return;
    }
    if (!act) {
      // Nothing more now: what follows waits for a restart, as a held run whose stop is already confirmed.
      await this.put({ ...settled, phase: "held", after_stop: after });
      return;
    }
    await this.afterStop(settled, after);
  }

  private async afterStop(entry: RunEntry, after: After) {
    const base: RunEntry = { ...entry, after_stop: null, run_ref: entry.run_ref };
    if (after.kind === "finish") {
      // Step 10: a run in a room with a repository is published before it counts as finished.
      const published = await this.publish(base, this.tickSignal);
      if (published === "wait") {
        // A local stop: held as it was, for a restart.
        await this.put({ ...entry, phase: "held", after_stop: after });
        return;
      }
      if (published !== null && "wait" in published) {
        // Held, its stop already confirmed and its folder and commit kept, and tried again after a wait, for at most
        // an hour from its first failure; then released (the ruling on #462's held publications).
        const since = typeof entry.publish_since === "number" ? entry.publish_since : this.now();
        if (this.now() - since >= PUBLISH_RETRY_MS) {
          this.log("lifecycle.publish", "given_up", entry, { code: "repo_publish_failed" });
          this.deps.repository?.forget(entry.workspace_id, entry.task_id);
          await this.giveUp({ ...base, publish_since: null, retry_at: null }, "accepted", "repo_publish_failed");
          return;
        }
        await this.put({ ...entry, phase: "held", after_stop: after, outcome: published.wait, publish_since: since, retry_at: this.now() + WAIT_MS });
        return;
      }
      if (published === null) return;
      const consumed = entry.consumed;
      const pub = published.published;
      // Step 11: in a room with a repository, only a commit Runner itself pushed for these inputs can be submitted: this
      // run's own, or, when it changed nothing, the one it started from. Otherwise there is no work to submit.
      if (consumed?.repository_id && !(pub && pub.repository_id === consumed.repository_id && (published.outcome === "published" || pub.commit === consumed.base_commit))) {
        this.forgetWords(keyOf(entry.workspace_id, entry.task_id));
        this.log("lifecycle.submit", "nothing_to_submit", entry, { code: "run_no_changes" });
        await this.giveUp({ ...base, publish_since: null, retry_at: null, published: pub }, "accepted", "run_no_changes");
        return;
      }
      await this.put({ ...base, phase: "finished", publish_since: null, retry_at: null, ran_hash: consumed?.input_hash ?? null, published: pub, outcome: published.outcome === "succeeded" ? entry.outcome : published.outcome, submission: owedSubmission() });
    }
    else if (after.kind === "release") {
      this.forgetWords(keyOf(entry.workspace_id, entry.task_id));
      if (entry.consumed?.repository_id) this.deps.repository?.forget(entry.workspace_id, entry.task_id);
      await this.giveUp(base, "accepted", after.reason);
    }
    else if (after.kind === "start_failed") {
      // Nothing ran: the room is told why in Runner's fixed words, then the task is released as before.
      const key = keyOf(entry.workspace_id, entry.task_id);
      this.forgetWords(key);
      if (entry.consumed?.repository_id) this.deps.repository?.forget(entry.workspace_id, entry.task_id);
      if (!entry.consumed) {
        await this.giveUp(base, "accepted", "run_failed");
        return;
      }
      await this.put({ ...base, phase: "reporting", retry_at: null, report: { ...owedReport(), sharing: "withheld", start_failed: after.code } });
    }
    else if (after.kind === "blocked") {
      // Nothing is published for a blocked run; its reason is owed to the room, and its inputs recorded.
      const key = keyOf(entry.workspace_id, entry.task_id);
      this.titles.delete(key);
      if (entry.consumed?.repository_id) this.deps.repository?.forget(entry.workspace_id, entry.task_id);
      const consumed = entry.consumed;
      if (!consumed) {
        this.forgetWords(key);
        await this.giveUp(base, "accepted", "run_blocked");
        return;
      }
      await this.put({ ...base, phase: "reporting", retry_at: null, report: owedReport(), blocked: { input_hash: consumed.input_hash, facts_hash: await factsHash(consumed.facts_key) } });
    }
    else if (after.kind === "reconsider") await this.put({ ...base, phase: "done", marker: "" });
    else await this.put({ ...base, phase: "done" });
  }

  /** Drops what is held in memory for a task's run: its result and its title. */
  private forgetWords(key: string): void {
    this.results.delete(key);
    this.titles.delete(key);
  }

  /** The entry as it stands in the record, which a step of the submission may have just saved. */
  private current(entry: RunEntry): RunEntry {
    return this.state.entries[keyOf(entry.workspace_id, entry.task_id)] ?? entry;
  }

  /**
   * Step 11: an owed submission. What it says of the work comes from Runner's records, bound to the run's decision; a
   * fresh read must show the task as the run left it; the agent's words go only where sharing is allowed or the owner
   * approved them; then `submit_task`, with a key stored first.
   */
  private async submit(entry: RunEntry, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const key = keyOf(entry.workspace_id, entry.task_id);
    const agent = this.deps.poller.agentId;
    const consumed = entry.consumed;
    const release = async (reason: string) => {
      this.forgetWords(key);
      this.log("lifecycle.submit", "refused", entry, { code: reason });
      await this.giveUp({ ...this.current(entry), submission: null, retry_at: null }, "accepted", reason);
    };
    const notSubmitted = async (why: string) => {
      this.forgetWords(key);
      this.log("lifecycle.submit", "not_submitted", entry, { code: `submit_${why}` });
      // Read and evaluated afresh at its next turn.
      await this.put({ ...this.current(entry), phase: "done", marker: "", outcome: `submit_${why}`, submission: null, retry_at: null });
    };
    if (!consumed) return release("result_record_invalid");
    // The pull request and commit are what Runner pushed and checked for this run's repository and branch (step 10).
    let pr: NotePullRequest | null = null;
    if (consumed.repository_id !== null) {
      const scope = repositoryOf(consumed);
      const pub = entry.published;
      if (!scope || !pub || pub.repository_id !== consumed.repository_id || pub.branch !== scope.repository.branch) return release("result_record_invalid");
      pr = { full_name: scope.repository.full_name, number: pub.pr_number, branch: pub.branch, commit: pub.commit };
    }

    const detail = await this.read(entry.workspace_id, entry.task_id);
    if (signal.aborted) return;
    const task = detail?.task;
    if (task && entry.submission?.key && task.status === "submitted" && task.assignee === agent && entry.expected_version !== null && task.version > entry.expected_version) {
      // An earlier send went through and its answer was lost: only this agent can have submitted it.
      return this.submitted(entry);
    }
    if (!detail || !task) return notSubmitted("not_readable");
    if (task.assignee !== agent || task.status !== "accepted") return notSubmitted(`task_${task.status}`);
    if (task.version !== entry.expected_version) return notSubmitted("version_changed");
    if (detail.prompt?.hash !== consumed.input_hash) return notSubmitted("inputs_changed");

    let sub = this.current(entry).submission as Submission;
    if (sub.sharing === "pending") {
      const share = await this.sharingAllowed(entry.workspace_id, consumed);
      sub = { ...sub, sharing: share ? "share" : "review", held_since: share ? null : this.now() };
      await this.put({ ...this.current(entry), submission: sub });
    }
    const kept = this.results.get(key);
    const result = kept && kept.run_ref === entry.run_ref ? kept.result : null;
    const cleaned = result ? cleanResult(result) : null;
    if (sub.sharing === "review" && cleaned?.ok && this.now() - (sub.held_since ?? this.now()) >= REVIEW_HOLD_MS) {
      // Held past its limit with no answer: submitted with Runner's fixed note only, never the agent's words.
      sub = { ...sub, sharing: "withheld" };
      await this.put({ ...this.current(entry), submission: sub });
      this.log("lifecycle.review", "withheld", entry, { code: "review_hold_expired" });
    }
    if (sub.sharing === "review" && cleaned?.ok) {
      await this.tellHeld(entry);
      const review = this.deps.prompter.review;
      const answer = review ? await review.call(this.deps.prompter, { workspace_id: entry.workspace_id, task_id: entry.task_id, pull_request: pr, summary: cleaned.summary, files: cleaned.files, redactions: cleaned.redactions }, signal) : "later";
      if (signal.aborted) return;
      this.log("lifecycle.review", answer, entry);
      if (answer === "later") {
        await this.put({ ...this.current(entry), retry_at: this.now() + ASK_AGAIN_MS });
        return;
      }
      sub = { ...(this.current(entry).submission as Submission), sharing: answer === "approve" ? "approved" : "withheld" };
      await this.put({ ...this.current(entry), submission: sub });
    }
    const words: NoteWords = !result || !cleaned ? { kind: "lost" } : !cleaned.ok ? { kind: "secret_hidden" } : sub.sharing === "share" || sub.sharing === "approved" ? { kind: "shared", ...cleaned } : { kind: "withheld" };
    const note = composeNote({ task_id: entry.task_id, pull_request: pr, words });
    const noteHash = await sha256Hex(new TextEncoder().encode(note));
    if (sub.key === null || sub.note_hash !== noteHash) {
      // Stored before it's first sent. A different note gets a new key, so a replay never carries another body.
      sub = { ...sub, key: this.newId(), note_hash: noteHash };
      await this.put({ ...this.current(entry), submission: sub });
    }
    const args: Record<string, unknown> = { workspace_id: entry.workspace_id, task_id: entry.task_id, version: task.version, note, idempotency_key: sub.key };
    if (pr) Object.assign(args, { commit_sha: pr.commit, pr_number: pr.number, artifacts: [{ uri: pullRequestUrl(pr.full_name, pr.number), label: "Pull request" }] });
    for (let attempt = 0; attempt < COMMAND_TRIES; attempt++) {
      try {
        const answer = (await this.deps.poller.request("submit_task", args)) as Record<string, unknown> | null;
        if (answer?.status === "submitted") return this.submitted(entry);
        return notSubmitted("unexpected");
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        if (meaningOf(error) === "refused" && !SUBMIT_AGAIN.has(error.code)) {
          this.log("lifecycle.submit", "refused", entry, { status: error.status, code: error.code });
          // The task changed under it: read afresh. Anything else the server refused can't be submitted as it is.
          if (error.code === "version_conflict") return notSubmitted("version_conflict");
          return release(`submit_${error.code}`);
        }
        if (attempt + 1 < COMMAND_TRIES) await this.backoff(attempt, signal, error);
        if (signal.aborted) return;
      }
    }
    // Unknown: it may have gone through. Only the same key is sent for this note, at a later pass.
    this.log("lifecycle.submit", "unknown", entry);
  }

  /**
   * A blocked run's report: a fresh read must show the task as the run left it, or nothing is sent; the agent's reason goes
   * only where sharing is allowed or the owner approved it; then `send_message`, with a key stored first and bound to the
   * note. Once it's posted, or the server refused it, a change request's task is kept and a first run's released.
   */
  private async report(entry: RunEntry, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const key = keyOf(entry.workspace_id, entry.task_id);
    const agent = this.deps.poller.agentId;
    const consumed = entry.consumed as NonNullable<RunEntry["consumed"]>;
    const code = entry.report?.start_failed ? "run_failed" : "run_blocked";
    const logged = (posted: boolean, status?: number) => this.log("lifecycle.blocked", posted ? "reason_posted" : "reason_not_posted", entry, { code, ...(status === undefined ? {} : { status }) });
    const detail = await this.read(entry.workspace_id, entry.task_id);
    if (signal.aborted) return;
    const task = detail?.task;
    if (!detail || !task || task.assignee !== agent || task.status !== "accepted" || task.version !== entry.expected_version || detail.prompt?.hash !== consumed.input_hash) {
      // The task moved on since the run: a reason about other inputs isn't sent, and the task is read afresh.
      this.forgetWords(key);
      logged(false);
      await this.put({ ...this.current(entry), phase: "done", marker: "", outcome: task ? `blocked_task_${task.status}` : "blocked_not_readable", report: null, retry_at: null });
      return;
    }
    let rep = this.current(entry).report as BlockedReport;
    const save = async (next: BlockedReport) => {
      rep = next;
      await this.put({ ...this.current(entry), report: next });
    };
    // From the task as it stands: a run that answered a change request keeps the task (ruling 2). A run that never
    // started answered nothing, so its task is released as before.
    if (rep.keep === null) await save({ ...rep, keep: !rep.start_failed && detail.prompt.shape.change_request_event_id !== null });
    if (rep.sharing === "pending") {
      const share = await this.sharingAllowed(entry.workspace_id, consumed);
      await save({ ...rep, sharing: share ? "share" : "review", held_since: share ? null : this.now() });
    }
    const kept = this.results.get(key);
    const result = kept && kept.run_ref === entry.run_ref ? kept.result : null;
    const cleaned = result ? cleanResult(result) : null;
    if (rep.sharing === "review" && cleaned?.ok && this.now() - (rep.held_since ?? this.now()) >= REVIEW_HOLD_MS) {
      await save({ ...rep, sharing: "withheld" });
      this.log("lifecycle.review", "withheld", entry, { code: "review_hold_expired" });
    }
    if (rep.sharing === "review" && cleaned?.ok) {
      const review = this.deps.prompter.review;
      const answer = review ? await review.call(this.deps.prompter, { workspace_id: entry.workspace_id, task_id: entry.task_id, pull_request: null, summary: cleaned.summary, files: cleaned.files, redactions: cleaned.redactions, blocked: true }, signal) : "later";
      if (signal.aborted) return;
      this.log("lifecycle.review", answer, entry, { code: "run_blocked" });
      if (answer === "later") {
        await this.put({ ...this.current(entry), retry_at: this.now() + ASK_AGAIN_MS });
        return;
      }
      await save({ ...rep, sharing: answer === "approve" ? "approved" : "withheld" });
    }
    const words: NoteWords = rep.start_failed ? { kind: "withheld" } : !result || !cleaned ? { kind: "lost" } : !cleaned.ok ? { kind: "secret_hidden" } : rep.sharing === "share" || rep.sharing === "approved" ? { kind: "shared", ...cleaned } : { kind: "withheld" };
    const compose = async (k: string) => composeBlockedNote({ task_id: entry.task_id, keep: rep.keep === true, words, start_failed: !!rep.start_failed, reference: await referenceOf(k) });
    let note = rep.key === null ? "" : await compose(rep.key);
    if (rep.key !== null && rep.note_hash !== (await sha256Hex(new TextEncoder().encode(note)))) {
      // A note was stored and may have been sent, but its body can't be made again (the words went with a restart). It
      // is never followed by a second, contradicting one: the thread is read for its reference first.
      const landed = await this.noteLanded(entry, await referenceOf(rep.key));
      if (landed === "unknown") {
        this.log("lifecycle.blocked", "unknown", entry, { code });
        return;
      }
      if (landed) {
        this.forgetWords(key);
        logged(true);
        await this.finishReport(entry, rep, code, task.version);
        return;
      }
      await save({ ...rep, key: null, note_hash: null });
    }
    if (rep.key === null) {
      const fresh = this.newId();
      note = await compose(fresh);
      await save({ ...rep, key: fresh, note_hash: await sha256Hex(new TextEncoder().encode(note)) });
    }
    let posted = false;
    let refused: number | undefined;
    for (let attempt = 0; attempt < COMMAND_TRIES; attempt++) {
      try {
        await this.deps.poller.request("send_message", { workspace_id: entry.workspace_id, task_id: entry.task_id, body: note, idempotency_key: rep.key });
        posted = true;
        break;
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        if (meaningOf(error) === "refused") {
          // The server won't take it as it is: the task goes on without it, and the log says so.
          refused = error.status;
          break;
        }
        if (attempt + 1 < COMMAND_TRIES) await this.backoff(attempt, signal, error);
        if (signal.aborted) return;
      }
    }
    if (!posted && refused === undefined) {
      // Unknown: it may have gone through. Only the same key is sent for this note, at a later pass.
      this.log("lifecycle.blocked", "unknown", entry, { code });
      return;
    }
    this.forgetWords(key);
    logged(posted, refused);
    await this.finishReport(entry, rep, code, task.version);
  }

  /** After the report: a change request's task is kept; any other is released. */
  private async finishReport(entry: RunEntry, rep: BlockedReport, code: string, version: number) {
    const done = { ...this.current(entry), report: null, retry_at: null };
    if (rep.keep) await this.put({ ...done, phase: "done", outcome: code });
    else await this.giveUp(done, "accepted", code, version);
  }

  /**
   * Whether a note with this reference is on the task's thread, sent by this agent: true, false, or `unknown` when the
   * thread can't be read now. Pages are read to the end, at most `NOTE_PAGES` of them; bodies are only searched for the
   * fixed-shape reference, never read for meaning.
   */
  private async noteLanded(entry: RunEntry, reference: string): Promise<boolean | "unknown"> {
    const agent = this.deps.poller.agentId;
    let after: string | null = null;
    for (let page = 0; page < NOTE_PAGES; page++) {
      let answer: { messages?: unknown } | null;
      try {
        answer = (await this.deps.poller.request("list_messages", { workspace_id: entry.workspace_id, task_id: entry.task_id, ...(after ? { after } : {}) })) as { messages?: unknown } | null;
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        return "unknown";
      }
      const messages = Array.isArray(answer?.messages) ? (answer.messages as Record<string, unknown>[]) : [];
      for (const m of messages) {
        const from = m && typeof m === "object" ? (m.from as Record<string, unknown> | null) : null;
        if (from?.id === agent && typeof m.body === "string" && m.body.includes(reference)) return true;
      }
      const last = messages.at(-1)?.id;
      if (messages.length < 50 || typeof last !== "string") return false;
      after = last;
    }
    return "unknown";
  }

  private async submitted(entry: RunEntry) {
    this.forgetWords(keyOf(entry.workspace_id, entry.task_id));
    const current = this.current(entry);
    await this.put({ ...current, outcome: "submitted", retry_at: null, submission: { ...(current.submission as Submission), state: "submitted" } });
    this.log("lifecycle.submit", "submitted", entry);
  }

  /** Whether the agent's words may go without the owner's review: the run's facts and the room's policy now both say so. */
  private async sharingAllowed(workspace_id: string, consumed: NonNullable<RunEntry["consumed"]>): Promise<boolean> {
    if (outputsOf(consumed) !== "share") return false;
    const parsed = parsePolicyConfig(await readConfig(this.deps.config), homeOf(this.deps));
    return parsed.ok && parsed.value.owner_org === this.ownerOrg && parsed.value.rooms.some((r) => r.room_id === workspace_id && r.outputs === "share");
  }

  /** The fixed progress message for a held result, sent once, with a key stored first; a failure is tried at a later review. */
  private async tellHeld(entry: RunEntry) {
    let sub = this.current(entry).submission as Submission;
    if (sub.told) return;
    if (sub.told_key === null) {
      sub = { ...sub, told_key: this.newId() };
      await this.put({ ...this.current(entry), submission: sub });
    }
    try {
      await this.deps.poller.request("send_message", { workspace_id: entry.workspace_id, task_id: entry.task_id, body: HELD_STATUS, idempotency_key: sub.told_key });
      await this.put({ ...this.current(entry), submission: { ...(this.current(entry).submission as Submission), told: true } });
      this.log("lifecycle.progress", "result_held", entry);
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      this.log("lifecycle.progress", "unsent", entry, { status: error.status, code: error.code });
    }
  }
}

function askView(entry: RunEntry, decision: Decision & { outcome: "ask" }, detail: TaskDetail): AskView {
  const facts = decision.facts;
  return {
    workspace_id: entry.workspace_id,
    task_id: entry.task_id,
    reason: decision.reason,
    room_visibility: facts.room_visibility,
    requester: facts.requester,
    authors: facts.authors,
    tools: facts.tools,
    network: facts.network,
    caps: facts.caps,
    repository: facts.repository,
    inputs: detail.prompt?.inputs.map(({ input, text }) => ({ input, text })) ?? [],
  };
}

export type LoopPoller = Pick<Poller, "pollOnce" | "nextWaitMs">;

/**
 * Runner's loop with the lifecycle: a poll, then a lifecycle pass, then the wait. A local stop (`signal`) ends it at once,
 * a run included, and nothing is called after it; a revoked agent ends it too.
 */
export async function runWithLifecycle(poller: LoopPoller, lifecycle: Lifecycle, clock: Clock, signal: AbortSignal, bell?: NudgeBell): Promise<"stopped" | "revoked"> {
  while (!signal.aborted) {
    const polled = await poller.pollOnce();
    if (polled === "revoked") return "revoked";
    if (signal.aborted) break;
    if (polled === "ok") {
      const outcome = await lifecycle.tick(signal);
      if (outcome !== "idle") return outcome;
    }
    // A nudge (M7 step 14) only ends this wait early: the next poll and tick are the ordinary ones.
    await waitForNext(clock, poller.nextWaitMs(polled), polled, signal, bell);
  }
  return "stopped";
}

/** The most pages of a task's thread read to find whether a note landed. */
const NOTE_PAGES = 40;
/** A note's reference: a fixed-shape tag from its key, which says nothing of the key. */
async function referenceOf(key: string): Promise<string> {
  return `rr_${(await sha256Hex(new TextEncoder().encode(`runner-report:${key}`))).slice(0, 16)}`;
}

/** A failed start's cause as a code: the adapter's `start_failed:<code>`, or its own bare code; `unknown` otherwise. */
function startCause(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const code = message.startsWith("start_failed:") ? message.slice("start_failed:".length) : message;
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "unknown";
}

const homeOf = (deps: Pick<LifecycleDeps, "home">) => (deps.home === undefined ? {} : { runner_home: deps.home });

/** The run policy as it stands: a function's answer read now, or the value given. A read that throws is no policy. */
async function readConfig(config: LifecycleDeps["config"]): Promise<unknown> {
  try {
    return typeof config === "function" ? await (config as () => unknown)() : config;
  } catch {
    return null;
  }
}
