/**
 * `run --nudge-listen <port> --nudge-url <https://…>`: the inbound nudge, switched on by the owner for this run (M7
 * step 14). Without both options nothing here runs, and `run` is the polling it always was.
 *
 * In order: the loopback listener starts (`nudge-listener.ts`), so Podster's challenge can reach it; the endpoint is
 * registered with `delivery: "nudge"` (`registerNudge`), its signing secret kept in the key store; and, unless Podster
 * already counts it as verified, Runner asks Podster to challenge it and answers with the proof (`verifyNudge`). Then
 * the owner, or another admin of the agent's organization, switches the nudge on in Podster for the version shown here.
 *
 * Polling starts first and never waits for any of this (`alongsidePolling`, the architect's ruling on #473): setup runs
 * beside the poll loop. Once the listener is up, the bell can ring for a request signed under a registration Runner
 * already holds from an earlier run, before this run's registration and challenge finish; a ring only brings the next
 * poll forward. When the run ends, or the owner stops it, setup stops where it is: no registration or challenge is
 * asked for after that, and the listener closes at once.
 *
 * Anything that fails here is said in one line and leaves polling as it was: the nudge is only ever a faster way to the
 * same poll. What the owner reads goes to standard output; log lines carry IDs and codes only, never the URL or secret.
 */
import { GatewayError } from "../core/errors.js";
import { checkNudgeUrl, NudgeBell, NudgeEndpoint, registerNudge, verifyNudge, type NudgeCalls, type NudgeRegistration } from "../core/nudge.js";
import type { Clock, Logger } from "../core/runtime.js";
import { RunnerStorage, type SecretStore } from "../core/storage.js";
import { parseListen, startNudgeListener } from "./nudge-listener.js";

export type NudgeOptions = { listen: { port: number }; url: string };

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

/** The owner's two options, checked before anything is touched. Null when neither is given: the nudge stays off. */
export function nudgeOptions(args: string[]): NudgeOptions | null {
  const listen = option(args, "nudge-listen");
  const url = option(args, "nudge-url");
  if (listen === undefined && url === undefined) return null;
  if (listen === undefined) throw new Error("--nudge-url needs --nudge-listen, the loopback port your proxy or tunnel forwards to.");
  if (url === undefined) throw new Error("--nudge-listen needs --nudge-url, the public HTTPS address you control that forwards to it.");
  const checked = checkNudgeUrl(url);
  if (checked === null) throw new Error("--nudge-url must be https:// at a DNS name, on the default port, with no user, query or fragment.");
  return { listen: parseListen(listen), url: checked };
}

export type OpenNudgeDeps = {
  listen: { port: number };
  url: string;
  poller: NudgeCalls;
  secrets: SecretStore;
  clock: Clock;
  log: Logger;
  say: (line: string) => void;
  /** The run's stop: it closes the listener too. */
  signal: AbortSignal;
  /** The poll loop's bell, already passed to the loop. A new one when left out. */
  bell?: NudgeBell;
  /** Told the port once listening (tests listen on port 0). */
  onListening?: (port: number) => void;
};

export type OpenNudge = { bell: NudgeBell; close(): Promise<void> };

const codeOf = (error: unknown) => (error instanceof GatewayError ? error.code : error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : "failed");

export async function openNudge(deps: OpenNudgeDeps): Promise<OpenNudge | null> {
  const storage = new RunnerStorage(deps.secrets);
  const bell = deps.bell ?? new NudgeBell();
  let current: NudgeRegistration | null = null;
  try {
    const held = await storage.getNudge();
    if (held && held.url === deps.url && held.agent_id === deps.poller.agentId) current = held;
  } catch {
    current = null;
  }
  const endpoint = new NudgeEndpoint({ registration: () => current, path: new URL(deps.url).pathname, clock: deps.clock, log: deps.log, bell });
  let listener;
  try {
    listener = await startNudgeListener({ port: deps.listen.port, endpoint, signal: deps.signal, log: deps.log });
  } catch {
    deps.log("nudge.listen", "failed", { agent: deps.poller.agentId });
    deps.say("Runner couldn't listen on that loopback port, so nudges are off for this run. Polling goes on as before.");
    return null;
  }
  deps.onListening?.(listener.port);
  deps.say(`Listening for nudges on 127.0.0.1:${listener.port}, for ${deps.url} (your proxy or tunnel forwards to it). Polling stays on.`);
  // Stopped or ended before setup is through: nothing more is asked of Podster.
  const ended = async () => {
    if (!deps.signal.aborted) return false;
    await listener.close();
    return true;
  };
  try {
    if (await ended()) return null;
    const registered = await registerNudge(deps.poller, storage, deps.url, deps.log);
    current = registered.registration;
    if (await ended()) return null;
    let { control, nudge_on: on } = registered;
    if (control !== "verified") {
      const verified = await verifyNudge(deps.poller, deps.log);
      control = verified.verified ? "verified" : "unverified";
      on = verified.nudge_on;
    }
    const version = registered.registration.version;
    if (control !== "verified") deps.say(`Runner couldn't prove it controls ${deps.url} (version ${version}): Podster's challenge didn't come back through your proxy or tunnel. Nudges stay off; polling goes on.`);
    else if (!on) deps.say(`Nudge endpoint version ${version} is registered and verified. It stays off until an admin of this agent's organization switches the nudge on in Podster for version ${version}.`);
    else deps.say(`Nudges are on for version ${version}. Polling stays on as well.`);
  } catch (error) {
    deps.log("nudge.register", "failed", { agent: deps.poller.agentId, code: codeOf(error) });
    deps.say("Runner couldn't register its nudge endpoint with Podster, so nudges are off for this run. Polling goes on as before.");
    await listener.close();
    return null;
  }
  return { bell, close: () => listener.close() };
}

/**
 * Runs the poll loop and, beside it, the nudge's setup. The loop starts first, with the bell already in hand, so its
 * first poll never waits for registration or the challenge. Once setup's listener is up, the bell can ring for a request
 * signed under a registration Runner already holds, which only brings the next poll forward. Setup failing (it says its
 * own line) leaves the loop as it is.
 *
 * When the loop ends, whatever its outcome (a stop, Ctrl-C or a revoked agent), `ended` is aborted: setup's listener,
 * which listens on it, closes at once, and setup asks nothing more of Podster. The run never waits for setup to finish.
 */
export async function alongsidePolling<T>(loop: (bell: NudgeBell | undefined) => Promise<T>, setUp: ((bell: NudgeBell, ended: AbortSignal) => Promise<OpenNudge | null>) | null): Promise<T> {
  if (setUp === null) return loop(undefined);
  const bell = new NudgeBell();
  const ended = new AbortController();
  const running = loop(bell);
  void Promise.resolve()
    .then(() => setUp(bell, ended.signal))
    .catch(() => null);
  try {
    return await running;
  } finally {
    ended.abort();
  }
}
