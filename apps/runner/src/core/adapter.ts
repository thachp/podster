/**
 * What the lifecycle (M7 step 8) needs from a run's adapter. Step 9 builds the interface's real implementations (the
 * provider-neutral interface and the Claude Agent SDK adapter); until then only tests implement it, and Runner's command
 * line starts no run.
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

export type RunStatus = "succeeded" | "failed" | "budget_stopped" | "timed_out";
export type RunReport = { status: RunStatus; spent_micro_usd: number | null };
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
