#!/usr/bin/env node
/**
 * Podster Runner's command line, for the owner's machine (M7 step 6). Built from source (`npm run build`, then
 * `node build/node/cli.js <command>`), or, as the owner decided on 2026-11-19 (narrowing decision 26), from the npm
 * package `podster`'s marked test pre-release for staging (`npx podster@test <command>`). The gated release is unchanged.
 *
 *   pair    --agent <agt_…> [--gateway <https://…>]   Pair this machine, with staging's gateway unless another is named.
 *                                                     The code is read from standard input, never an argument.
 *   run     [--interval <seconds>] [--grace <minutes>] [--provider-key-file <path>]
 *                                                     Poll the inbox until stopped (Ctrl-C). With a provider key
 *                                                     file, run tasks through the Claude Agent SDK; without one,
 *                                                     record offers and accept none.
 *           [--nudge-listen <port> --nudge-url <https://…>]
 *                                                     Also take Podster's nudges (M7 step 14), off unless both are
 *                                                     given: listen on loopback at the port, register the public HTTPS
 *                                                     address the owner's proxy or tunnel forwards to, and prove control.
 *   stop                                              Stop the Runner running from this home, and any run, at once.
 *   status                                            Show what this Runner's record says, by IDs.
 *   forget                                            Delete this Runner's keys and record. The agent stays connected in Podster.
 *
 * Every command takes `--home <folder>`, Runner's own folder (default `~/.podster-runner`). What the owner reads goes to
 * standard output in fixed words; log lines, IDs only, go to standard error.
 *
 * `pair`, `run` and `forget` take the home's lock (decision 227): a second one on the same home refuses while the first
 * runs. `run` with `--provider-key-file` builds the Claude engine (`claude-engine.ts`: the pinned SDK, the Docker task
 * container, the key's transport), reaps what a previous process left, then opens the lifecycle (`run-command.ts`).
 * Without a key file it opens no lifecycle and accepts nothing it couldn't run.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DEFAULT_GATEWAY, pairingGateway } from "../core/gateway.js";
import { pair, type PairingOutcome } from "../core/pairing.js";
import { clampGrace, clampInterval, DEFAULT_GRACE_MS, DEFAULT_INTERVAL_MS, Poller } from "../core/poller.js";
import { lineLogger, logLine, systemClock } from "../core/runtime.js";
import { RunnerStorage } from "../core/storage.js";
import { FileRunStore, forgetRuns } from "./file-runs.js";
import { FileStateStore } from "./file-state.js";
import { readHidden } from "./hidden-input.js";
import { chooseKeyStore } from "./key-store.js";
import { acquireLock, LockRefused } from "./lock.js";
import { clearStop, requestStop, watchStop } from "./local-stop.js";
import { claudeEngine, type ClaudeEngine } from "./claude-engine.js";
import { nudgeOptions, openNudge, type OpenNudge } from "./nudge-command.js";
import { processTerminal, runInbox } from "./run-command.js";

const USAGE = `Podster Runner (M7: pairing, the inbox loop, and tasks through the Claude Agent SDK)

  pair    --agent <agt_…> [--gateway <https://…>]  Pair this machine with the agent Podster's pairing started.
                                                   Paste the code when asked: it's never taken as an argument.
                                                   Gateway default: ${DEFAULT_GATEWAY} (staging).
  run     [--interval <seconds>] [--grace <minutes>] [--provider-key-file <path>]
                                                   Poll the inbox until you stop it (Ctrl-C). With your Anthropic
                                                   API key in a file only you can read, run tasks the run policy
                                                   allows; without one, record offers and accept none.
          [--nudge-listen <port> --nudge-url <https://…>]
                                                   Off unless you give both. Also take Podster's nudges, so offers
                                                   are picked up sooner: Runner listens on 127.0.0.1 at the port,
                                                   registers your public HTTPS address (a reverse proxy or tunnel you
                                                   run, which ends TLS and forwards to that port with the path
                                                   unchanged), and proves it holds the address's secret. An admin of
                                                   the agent's organization then switches the nudge on in Podster.
                                                   A nudge only makes Runner poll sooner. Polling stays on.
  stop                                             Stop the Runner running from this home at once, and any run.
                                                   It polls nothing until you start it again.
  status                                           Show this Runner's record, by IDs.
  forget                                           Delete this Runner's keys and record. The agent stays
                                                   connected in Podster until you disconnect it there.

  --home <folder>   Runner's own folder. Default: ~/.podster-runner
`;

const say = (line: string) => process.stdout.write(`${line}\n`);
const log = lineLogger((line) => process.stderr.write(`${line}\n`));

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

const OUTCOMES: Record<PairingOutcome, string> = {
  connected: "Paired. Runner now acts as this agent. Start it with `run`.",
  waiting: "Not confirmed yet. Confirm the thumbprint in Podster, then run `pair` again with the same --agent to keep waiting, or cancel the pairing in Podster.",
  declined: "Nothing was made or stored.",
  unreachable: "Podster couldn't be reached. Run `pair` again with the same --agent and code to try again with the same key.",
  pairing_ended: "This pairing was canceled, refused or has ended. Its key is retired and won't be used again. Start a new pairing in Podster, then run `pair` again.",
  registration_unknown: "Runner couldn't tell whether its agent was registered, so it won't register again. Cancel this pairing in Podster, start a new one, then run `pair` again.",
  already_paired: "This Runner is already paired. Run `forget` first to pair it again.",
};

async function main(argv: string[]) {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "help") {
    say(USAGE);
    return 0;
  }
  const home = resolve(option(args, "home") ?? join(homedir(), ".podster-runner"));
  const state = new FileStateStore(home);

  if (command === "status") {
    const record = await state.load();
    const runs = await new FileRunStore(home).load();
    const phases: Record<string, number> = {};
    for (const entry of Object.values(runs.entries)) phases[entry.phase] = (phases[entry.phase] ?? 0) + 1;
    say(JSON.stringify({ gateway: record.gateway, agent: record.agent_id, phase: record.phase, stopped: record.stopped, inbox_cursor: record.inbox_cursor, offers: Object.keys(record.offers).length, last_contact_at: record.last_contact_at, reconciled_at: record.reconciled_at, runs: phases }));
    return 0;
  }

  if (command === "stop") {
    // A local stop: no call to Podster, no signal to a process ID. The running Runner sees the request at once.
    say((await requestStop(home)) ? "Asked the Runner running here to stop. Any run ends at once, and it polls nothing until started again." : "No Runner is running from this home.");
    return 0;
  }

  if (command !== "pair" && command !== "run" && command !== "forget") {
    say(USAGE);
    return 2;
  }
  // One Runner per agent on this machine (decision 227). Held until this command ends.
  let lock;
  try {
    lock = await acquireLock(home, { command });
  } catch (error) {
    if (error instanceof LockRefused) {
      say(error.message);
      return 1;
    }
    throw error;
  }
  try {
    return await locked(command, args, home, state, lock.holder.nonce);
  } finally {
    await lock.release();
  }
}

async function locked(command: string, args: string[], home: string, state: FileStateStore, nonce: string): Promise<number> {
  // Which store holds the keys, said in one fixed line (S-47): macOS's keychain, the Secret Service, or files on Linux.
  const keys = await chooseKeyStore(home);
  say(keys.line);
  if (command === "forget") {
    // Never the SDK's disconnect: it only pretends to revoke. Disconnecting is the owner's act in Podster.
    // Refused while a run may still be going or budget is reserved; the day's spend is kept (L5 on #458).
    const blocked = await forgetRuns(new FileRunStore(home));
    if (blocked) {
      say(`Runner won't forget this agent while it has ${blocked}. Start it again with \`run\`: it keeps checking a held run until its stop is confirmed, then releases it and settles the budget. If this agent's connection has ended, pair again from Podster first, then \`run\`. Once nothing is held or reserved, \`forget\` goes through.`);
      return 1;
    }
    await new RunnerStorage(keys.store).deleteAll();
    await state.remove();
    say("Runner's keys and record on this machine are deleted. The agent is still connected in Podster until you disconnect it there.");
    return 0;
  }

  if (command === "pair") {
    const gateway = option(args, "gateway");
    const agent = option(args, "agent");
    if (!agent) throw new Error("pair needs --agent");
    // Staging's gateway unless the owner names another (the test pre-release of 2026-11-19).
    const origin = pairingGateway(gateway);
    const secrets = keys.store;
    const record = await state.load();
    const resuming = record.agent_id === agent && record.stopped === null && (record.phase === "registered" || record.phase === "redeemed");
    const prompt = "Paste the code Podster showed, then press Enter: ";
    // At a terminal the code is read without echo (L5), before the line reader for the consent question exists.
    const typed = resuming || !process.stdin.isTTY ? undefined : (await readHidden(prompt, process.stdin as never, process.stdout)).trim();
    const input = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    try {
      const code = resuming ? undefined : (typed ?? (await input.question(prompt)).trim());
      const result = await pair(
        {
          origin,
          fetch: globalThis.fetch,
          secrets,
          state,
          clock: systemClock,
          log,
          consent: async (details) => {
            say(`Runner will make a key on this machine for ${details.origin}, keep it in the key store named above, and use it to act as agent ${details.agentId}.`);
            say("Pairing grants no workroom access, provider login or automatic runs. Disconnect the agent in Podster to end it.");
            return /^y(es)?$/i.test((await input.question("Make and keep the key? [y/N] ")).trim());
          },
          notify: (notice) => {
            if (notice.kind === "thumbprint") say(`Key thumbprint, to match on Podster's confirm screen:\n  ${notice.grouped}`);
            else say("Waiting for you to confirm this thumbprint in Podster…");
          },
        },
        { agentId: agent, code },
      );
      say(OUTCOMES[result.outcome]);
      return result.outcome === "connected" ? 0 : 1;
    } finally {
      input.close();
    }
  }

  if (command === "run") {
    const record = await state.load();
    if (!record.gateway) throw new Error("This Runner isn't paired yet. Run `pair` first.");
    const interval = option(args, "interval");
    const grace = option(args, "grace");
    const keyFile = option(args, "provider-key-file");
    // The nudge's options are checked before anything is touched; without both, it stays off.
    const nudging = nudgeOptions(args);
    // The run engine is built, and what a previous process left is reaped, before the inbox is touched (M4 on #459).
    let engine: ClaudeEngine | null = null;
    if (keyFile !== undefined) {
      engine = await claudeEngine({ home, key_file: resolve(keyFile), log, notify: say });
      await engine.reap();
    }
    const poller = await Poller.open({
      origin: record.gateway,
      fetch: globalThis.fetch,
      secrets: keys.store,
      state,
      clock: systemClock,
      log,
      intervalMs: interval === undefined ? DEFAULT_INTERVAL_MS : clampInterval(Number(interval) * 1000),
      graceMs: grace === undefined ? DEFAULT_GRACE_MS : clampGrace(Number(grace) * 60 * 1000),
    });
    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
    // The owner's `stop`, from another terminal: a request naming this Runner's lock by its nonce, so one left for an
    // earlier Runner can't stop this one (L2 on #458).
    const unwatch = watchStop(home, nonce, () => stop.abort());
    say(nudging === null ? `Polling every ${poller.intervalMs / 1000} seconds, outbound only. Stop with Ctrl-C or \`stop\`.` : `Polling every ${poller.intervalMs / 1000} seconds. Stop with Ctrl-C or \`stop\`.`);
    if (engine === null) say("No provider key file was given, so this Runner records offers and accepts none.");
    let outcome;
    let nudge: OpenNudge | null = null;
    try {
      if (nudging !== null) nudge = await openNudge({ ...nudging, poller, secrets: keys.store, clock: systemClock, log, say, signal: stop.signal });
      outcome = await runInbox({ home, poller, clock: systemClock, log, signal: stop.signal, terminal: processTerminal(), engine, ...(nudge ? { bell: nudge.bell } : {}) });
    } finally {
      // Shutdown closes the nudge endpoint before anything else (R-15).
      await nudge?.close();
      unwatch();
      await clearStop(home);
    }
    if (outcome === "revoked") {
      say("This agent's connection ended in Podster, so Runner stopped and retired its key. To go on, pair again from Podster.");
      return 1;
    }
    say("Stopped.");
    return 0;
  }

  say(USAGE);
  return 2;
}

// A rejection or exception nothing handled fails closed: a fixed line, never its reason (which could carry agent content or a token),
// and the process ends. A run left going is held on the next start, until its stop is confirmed (M3 on #459).
process.on("unhandledRejection", () => {
  process.stderr.write(`${logLine("runner", "unhandled_rejection")}\n`);
  process.exit(70);
});
// The same for an exception nothing caught.
process.on("uncaughtException", () => {
  process.stderr.write(`${logLine("runner", "uncaught_exception")}\n`);
  process.exit(70);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Fixed words or Runner's own messages only: a refusal's body never reaches here (`errors.ts`).
    process.stderr.write(`${error instanceof Error ? error.message : "Runner stopped on an error."}\n`);
    process.exitCode = 1;
  },
);
