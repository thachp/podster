/**
 * `run`'s loop (M7 step 9(a); step 8's notes, "what step 9 needs"). With a run engine, the lifecycle opens on this home's
 * run record (`FileRunStore`) and run policy (`policyFile(home)`, read afresh on every evaluation), asks the owner through
 * `TerminalPrompter` only when standard input and output are both terminals, and runs every task through the
 * provider-neutral `SupervisedAdapter`, then `runWithLifecycle` works the inbox.
 *
 * **With no run engine, `run` opens no lifecycle and runs nothing.** Step 9(b)'s engine (`claude-engine.ts`: the Claude
 * Agent SDK's driver, the Docker task container and the provider transport) is built by `cli.ts` only when the owner
 * names a provider key file; without one `run` is step 6's inbox loop, which records offers and accepts none, since
 * Runner accepts nothing it couldn't run. An engine with no driver counts as none.
 */
import { createInterface } from "node:readline/promises";
import { Lifecycle, runWithLifecycle, type RepositoryPath } from "../core/lifecycle.js";
import type { LoopOutcome, Poller } from "../core/poller.js";
import { SupervisedAdapter, type ProgressEvent, type SupervisedDeps } from "../core/run-interface.js";
import type { Clock, Logger } from "../core/runtime.js";
import { FileRunStore } from "./file-runs.js";
import { policyFile } from "./policy-file.js";
import { TerminalPrompter, type Terminal } from "./prompter.js";
import { hostRepositoryPath } from "./repo-path.js";

/** What runs tasks: a driver per agent SDK, the task container, and the provider transports that hold the keys. */
export type RunEngine = Pick<SupervisedDeps, "drivers" | "sandbox" | "transports">;

/** No engine: `run` records offers and runs nothing. `cli.ts` uses the Claude engine instead when given a key file. */
export const NO_ENGINE: RunEngine | null = null;

export type RunInboxDeps = {
  home: string;
  poller: Poller;
  clock: Clock;
  log: Logger;
  /** The owner's local stop or Ctrl-C. */
  signal: AbortSignal;
  terminal: Terminal;
  engine: RunEngine | null;
  /**
   * Step 10's repository path. Left out, `run` builds the host's (`hostRepositoryPath`); null runs without one, so a room
   * with a repository refuses its tasks.
   */
  repository?: RepositoryPath | null;
};

/** A run's progress, as a log line: IDs, a fixed kind, a code and the turn count. */
const progressLog = (log: Logger) => (event: ProgressEvent) =>
  log("run.progress", event.kind, { workspace: event.workspace_id, task: event.task_id, count: event.turns, code: event.code ?? undefined });

export async function runInbox(deps: RunInboxDeps): Promise<LoopOutcome> {
  const engine = deps.engine;
  if (engine === null || !Object.values(engine.drivers).some((driver) => driver !== undefined)) return deps.poller.run(deps.signal);
  const adapter = new SupervisedAdapter({ ...engine, clock: deps.clock, log: deps.log, progress: progressLog(deps.log) });
  const repository = deps.repository !== undefined ? deps.repository : await hostRepositoryPath(deps.home, (capability, args) => deps.poller.request(capability, args), deps.clock, deps.log);
  const lifecycle = await Lifecycle.open({
    poller: deps.poller,
    runs: new FileRunStore(deps.home),
    config: policyFile(deps.home),
    adapter,
    home: deps.home,
    ...(repository ? { repository } : {}),
    prompter: new TerminalPrompter(deps.terminal),
    clock: deps.clock,
    log: deps.log,
  });
  return runWithLifecycle(deps.poller, lifecycle, deps.clock, deps.signal);
}

/** This process's terminal. A question is asked only when both standard input and standard output are terminals. */
export function processTerminal(): Terminal {
  return {
    inputIsTTY: process.stdin.isTTY === true,
    outputIsTTY: process.stdout.isTTY === true,
    columns: process.stdout.columns,
    write: (text) => void process.stdout.write(text),
    question: async (prompt, signal) => {
      const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      try {
        return await input.question(prompt, signal ? { signal } : {});
      } finally {
        input.close();
      }
    },
  };
}
