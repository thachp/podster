/**
 * Podster Runner's command line, built from source for the owner's machine (M7 step 6). No package or install command is
 * published (decision 26). Run `npm run build`, then `node build/node/cli.js <command>`.
 *
 *   pair    --gateway <https://…> --agent <agt_…>   Pair this machine. The code is read from standard input, never an argument.
 *   run     [--interval <seconds>] [--grace <minutes>]   Poll the inbox and record offers until stopped (Ctrl-C).
 *   status                                            Show what this Runner's record says, by IDs.
 *   forget                                            Delete this Runner's keys and record. The agent stays connected in Podster.
 *
 * Every command takes `--home <folder>`, Runner's own folder (default `~/.podster-runner`). What the owner reads goes to
 * standard output in fixed words; log lines, IDs only, go to standard error.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { gatewayOrigin } from "../core/gateway.js";
import { pair, type PairingOutcome } from "../core/pairing.js";
import { clampGrace, clampInterval, DEFAULT_GRACE_MS, DEFAULT_INTERVAL_MS, Poller } from "../core/poller.js";
import { lineLogger, systemClock } from "../core/runtime.js";
import { RunnerStorage } from "../core/storage.js";
import { FileStateStore } from "./file-state.js";
import { systemKeychain } from "./keychain.js";

const USAGE = `Podster Runner (M7 step 6: pairing and the inbox loop; it runs no task yet)

  pair    --gateway <https://…> --agent <agt_…>   Pair this machine with the agent Podster's pairing started.
                                                   Paste the code when asked: it's never taken as an argument.
  run     [--interval <seconds>] [--grace <minutes>]
                                                   Poll the inbox and record offers until you stop it (Ctrl-C).
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
    say(JSON.stringify({ gateway: record.gateway, agent: record.agent_id, phase: record.phase, stopped: record.stopped, inbox_cursor: record.inbox_cursor, offers: Object.keys(record.offers).length, last_contact_at: record.last_contact_at, reconciled_at: record.reconciled_at }));
    return 0;
  }

  if (command === "forget") {
    // Never the SDK's disconnect: it only pretends to revoke. Disconnecting is the owner's act in Podster.
    await new RunnerStorage(systemKeychain(home)).deleteAll();
    await state.remove();
    say("Runner's keys and record on this machine are deleted. The agent is still connected in Podster until you disconnect it there.");
    return 0;
  }

  if (command === "pair") {
    const gateway = option(args, "gateway");
    const agent = option(args, "agent");
    if (!gateway || !agent) throw new Error("pair needs --gateway and --agent");
    const origin = gatewayOrigin(gateway);
    const secrets = systemKeychain(home);
    const input = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    try {
      const record = await state.load();
      const resuming = record.agent_id === agent && record.stopped === null && (record.phase === "registered" || record.phase === "redeemed");
      const code = resuming ? undefined : (await input.question("Paste the code Podster showed, then press Enter: ")).trim();
      const result = await pair(
        {
          origin,
          fetch: globalThis.fetch,
          secrets,
          state,
          clock: systemClock,
          log,
          consent: async (details) => {
            say(`Runner will make a key on this machine for ${details.origin}, keep it in this system's keychain, and use it to act as agent ${details.agentId}.`);
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
    const poller = await Poller.open({
      origin: record.gateway,
      fetch: globalThis.fetch,
      secrets: systemKeychain(home),
      state,
      clock: systemClock,
      log,
      intervalMs: interval === undefined ? DEFAULT_INTERVAL_MS : clampInterval(Number(interval) * 1000),
      graceMs: grace === undefined ? DEFAULT_GRACE_MS : clampGrace(Number(grace) * 60 * 1000),
    });
    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
    say(`Polling every ${poller.intervalMs / 1000} seconds, outbound only. Stop with Ctrl-C.`);
    const outcome = await poller.run(stop.signal);
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
