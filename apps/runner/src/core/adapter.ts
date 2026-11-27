/**
 * What the lifecycle (M7 step 8) needs from a run's adapter. Step 9(a) implements it once, provider-neutral, as
 * `SupervisedAdapter` (`run-interface.ts`), over a driver for each agent SDK; step 9(b) adds the Claude Agent SDK driver.
 * Until a driver exists, Runner's command line opens no lifecycle and starts no run (`src/node/run-command.ts`).
 *
 * - `start` is handed the prompt's bytes (untrusted task text, for the adapter to mark so), the policy's facts, which it
 *   enforces, and a run ID Runner chose and stored first, so a restart can ask about the run by it.
 * - `stop` ends the run's whole process tree at once (spike B ruling 4: the task's container is killed) and says whether
 *   that is confirmed. It never calls Podster, so a local stop works with Podster unreachable.
 * - `confirmStopped` answers, after a restart, whether nothing is left of a run Runner started earlier.
 *
 * What the adapter reports is evidence Runner reads, never the outcome itself: Runner records its own (spike B ruling 4),
 * and a spend it doesn't report counts as the whole reservation.
 */
import type { RunFacts } from "./policy.js";
import type { RunResult } from "./tool-policy.js";

export type RunStatus = "succeeded" | "failed" | "budget_stopped" | "timed_out";
/**
 * `result` is the run's structured result, bounded, present only on a success; step 11 submits it. It is the agent's
 * content: data, never logged. `stop_reason` is Runner's own code for why the run ended, when Runner ended it.
 */
/** `stop_detail`: when the driver failed, its own fixed code (`plugins_unexpected`, `exec_exited`, `sdk_error`…), never text. */
/**
 * How many files a succeeded run left where nothing is kept: the task's HOME (`.cache/home`, written since the run opened,
 * npm's pinned cache left out) and /tmp. Counts only, never a name (2026-11-27: a run ended succeeded with nothing to commit).
 */
export type ScratchCounts = { home_files: number; tmp_files: number };
export type RunReport = { status: RunStatus; spent_micro_usd: number | null; result?: RunResult | null; stop_reason?: string | null; stop_detail?: string | null; scratch?: ScratchCounts | null };
export type StopResult = "stopped" | "unknown";

export interface RunHandle {
  /** Settles when the run ends by itself. A rejection reads as a failure with spend unknown. */
  readonly done: Promise<RunReport>;
  stop(): Promise<StopResult>;
}

export type RunStart = { run_ref: string; workspace_id: string; task_id: string; prompt: Uint8Array; facts: RunFacts };

export interface RunAdapter {
  start(run: RunStart): Promise<RunHandle>;
  confirmStopped(run_ref: string): Promise<boolean>;
}
