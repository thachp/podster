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
import type { NudgeBell } from "../core/nudge.js";
import type { LoopOutcome, Poller } from "../core/poller.js";
import { SupervisedAdapter, type ProgressEvent, type SupervisedDeps } from "../core/run-interface.js";
import type { Clock, Diagnostics, Logger } from "../core/runtime.js";
import { FileRunStore } from "./file-runs.js";
import { policyFile, policyText } from "./policy-file.js";
import { trustFile } from "./trust-file.js";
import { TerminalPrompter, type Terminal } from "./prompter.js";
import { appOriginFor } from "../core/pull-text.js";
import { hostRepositoryPath } from "./repo-path.js";
import { retryTransient, STOPPED } from "../core/retry.js";
import { RoleInvites } from "../core/roles.js";
import { RoomFacts } from "../core/room-facts.js";

/** What runs tasks: a driver per agent SDK, the task container, and the provider transports that hold the keys. */
export type RunEngine = Pick<SupervisedDeps, "drivers" | "sandbox" | "transports">;

/** No engine: `run` records offers and runs nothing. `cli.ts` uses the Claude engine instead when given a key file. */
export const NO_ENGINE: RunEngine | null = null;

export type RunInboxDeps = {
  home: string;
  poller: Poller;
  clock: Clock;
  log: Logger;
  /** The local diagnostics file, for each failure's raw cause. */
  diagnostics?: Diagnostics;
  /** The owner's local stop or Ctrl-C. */
  signal: AbortSignal;
  terminal: Terminal;
  engine: RunEngine | null;
  /**
   * Step 10's repository path. Left out, `run` builds the host's (`hostRepositoryPath`); null runs without one, so a room
   * with a repository refuses its tasks.
   */
  repository?: RepositoryPath | null;
  /** The inbound nudge's bell (M7 step 14), only when the owner switched it on: it ends a wait early, nothing more. */
  bell?: NudgeBell;
  /** For the startup backoff's jitter: answers in [0, 1). `Math.random` when left out. */
  random?: () => number;
};

/** A run's progress, as a log line: IDs, a fixed kind, a code and the turn count. */
const progressLog = (log: Logger) => (event: ProgressEvent) =>
  log("run.progress", event.kind, { workspace: event.workspace_id, task: event.task_id, count: event.turns, code: event.code ?? undefined });

export async function runInbox(deps: RunInboxDeps): Promise<LoopOutcome> {
  const engine = deps.engine;
  if (engine === null || !Object.values(engine.drivers).some((driver) => driver !== undefined)) return deps.poller.run(deps.signal, deps.bell);
  const adapter = new SupervisedAdapter({ ...engine, clock: deps.clock, log: deps.log, progress: progressLog(deps.log), ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}) });
  const repository = deps.repository !== undefined ? deps.repository : await hostRepositoryPath(deps.home, (capability, args) => deps.poller.request(capability, args), deps.clock, deps.log, { app_origin: appOriginFor(deps.poller.origin) });
  const prompter = new TerminalPrompter(deps.terminal);
  // Role invites are answered by the same owner, on the same terminal, under the same local policy file (issue 522).
  // The owner's answer is waited for off the poll loop, so a question never holds up task work (issue 528); the bell, when on,
  // only ends the loop's wait early so the answer is used soon.
  const bell = deps.bell;
  const roles = new RoleInvites({ poller: deps.poller, config: policyFile(deps.home), home: deps.home, prompter, clock: deps.clock, log: deps.log, ...(bell ? { wake: () => bell.ring() } : {}) });
  // Room changes after setup (issue 523): a repository Podster newly names for a room, or names differently, is asked
  // about on this terminal; nothing is ever removed on what Podster doesn't say. Read off the same policy file, and never
  // waited for before task work.
  const rooms = new RoomFacts({ poller: deps.poller, policy: policyText(deps.home), home: deps.home, prompter, clock: deps.clock, log: deps.log, ...(bell ? { wake: () => bell.ring() } : {}) });
  // Opening asks Podster who this agent is. A brief network failure, a server failure or a rate limit there is waited
  // out like the poll loop's own, never a reason to exit (the 2026-11-21 report); an authority error, a refusal or a
  // policy problem still ends `run` here. The open changes nothing until that answer is in, so trying it again is safe.
  const lifecycle = await retryTransient(
    () =>
      Lifecycle.open({
        poller: deps.poller,
        runs: new FileRunStore(deps.home),
        config: policyFile(deps.home),
        trust: trustFile(deps.home),
        adapter,
        home: deps.home,
        ...(repository ? { repository } : {}),
        prompter,
        roles,
        rooms,
        clock: deps.clock,
        log: deps.log,
        ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}),
      }),
    { at: "runner.start", agent: deps.poller.agentId, clock: deps.clock, log: deps.log, signal: deps.signal, firstMs: deps.poller.intervalMs, ...(deps.random ? { random: deps.random } : {}) },
  );
  if (lifecycle === STOPPED) return "stopped";
  return runWithLifecycle(deps.poller, lifecycle, deps.clock, deps.signal, deps.bell);
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
