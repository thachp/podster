/**
 * Pairing from the machine (M7 step 6; decision 222; RUNNER.md, "Pair once"). A person starts a pairing in Podster and
 * gets a code; here Runner, with the owner's consent, makes a key on this machine, shows its whole thumbprint, redeems
 * the code with a proof signed by that key, registers its one agent on the paired host, and waits for the person to
 * confirm the same thumbprint in Podster.
 *
 * - **A fresh proof each time.** Every redeem, a retry included, sends a new host JWT signed by the key, with the
 *   session's agent as its issuer and subject, the gateway's origin as its audience, and no agent key in it.
 * - **One agent, reused.** Runner registers exactly one agent on the host, naming only `RUNNER_CAPABILITIES`, and keeps
 *   using it. If registration's answer is lost, Runner can't know whether an agent exists, so it never registers again:
 *   it stops and asks the owner to cancel and pair again.
 * - **Waiting.** `agent_unclaimed` means the person hasn't confirmed yet: Runner asks again with a backoff.
 * - **Ended.** A pairing that's canceled, refused or ended (a refused redeem, a refused registration, `agent_revoked`
 *   while waiting) retires its key: its thumbprint is recorded so it's never used again, the keys are deleted, and the
 *   owner is told to start a new pairing in Podster. A new pairing always makes a new key.
 * - **Lost answers.** A redeem that can't reach the gateway keeps the key, so running `pair` again with the same agent
 *   and code tries again with the same key and a fresh proof, and the gateway answers as before.
 *
 * Runner never calls the SDK's `disconnectAgent`, `rotateAgentKey` or `rotateHostKey` (M7 plan, the architect's ruling
 * 3 on spike A). Nothing here logs a code, a key or a proof.
 */
import { AgentAuthClient, generateKeypair, signHostJWT, type Keypair } from "@auth/agent";
import { RUNNER_CAPABILITIES, SWITCHED } from "./capabilities.js";
import { Connection } from "./connection.js";
import { errorFrom, GatewayError, meaningOf } from "./errors.js";
import { gatewayFetch } from "./gateway.js";
import type { Clock, Logger } from "./runtime.js";
import { emptyState, isId, type RunnerState, type StateStore } from "./state.js";
import { RunnerStorage, type SecretStore } from "./storage.js";
import { grouped, thumbprintOf } from "./thumbprint.js";

/** A pairing code as Podster gives it: the plugin's one-time enrollment token. */
const CODE = /^[A-Za-z0-9_-]{32,128}$/;
/** Redeem tries before Runner leaves it for the owner to run again. */
const REDEEM_TRIES = 5;
/** How long Runner waits for the person's confirmation in one run of `pair`. The session itself expires sooner. */
export const CONFIRM_WITHIN_MS = 15 * 60 * 1000;
const FIRST_WAIT_MS = 2_000;
/** No wait is shorter than this, whatever a retry-after says, so a refusal can never make Runner spin. */
const MIN_WAIT_MS = 1_000;
const LONGEST_WAIT_MS = 30_000;
/** Retired thumbprints kept, newest last. */
const RETIRED_KEPT = 200;
const RUNNER_NAME = "Podster Runner";

export type PairingNotice =
  /** The key exists: show its whole thumbprint, grouped, to compare with Podster's confirm screen. */
  | { kind: "thumbprint"; thumbprint: string; grouped: string }
  /** Registered; the person now confirms in Podster. */
  | { kind: "waiting_for_confirmation"; agentId: string };

export type PairingOutcome =
  /** Confirmed: Runner now acts as the agent. */
  | "connected"
  /** Not confirmed yet. Run `pair` again to keep waiting, or cancel in Podster. */
  | "waiting"
  /** The owner said no to making a key. Nothing was stored. */
  | "declined"
  /** The gateway couldn't be reached, or kept asking to wait. Run `pair` again with the same code to try again with the same key. */
  | "unreachable"
  /** The pairing was canceled, refused or ended. Its key is retired. Start a new pairing in Podster. */
  | "pairing_ended"
  /** Registration's answer was lost. Cancel this pairing in Podster and start a new one. */
  | "registration_unknown"
  /** This Runner is already paired, or stopped, and needs `forget` first. */
  | "already_paired";

export type PairingDeps = {
  origin: string;
  fetch: typeof fetch;
  secrets: SecretStore;
  state: StateStore;
  clock: Clock;
  log: Logger;
  /** The owner's consent to make and keep a key for this gateway, asked before any key exists. */
  consent(details: { origin: string; agentId: string }): Promise<boolean>;
  notify(notice: PairingNotice): void;
  confirmWithinMs?: number;
};

export type PairingInput = { agentId: string; code?: string };

/** Pairs this Runner, or carries an interrupted pairing on from where its record says it got to. */
export async function pair(deps: PairingDeps, input: PairingInput): Promise<{ outcome: PairingOutcome; agentId: string; thumbprint: string | null }> {
  const { agentId } = input;
  if (!isId(agentId) || !agentId.startsWith("agt_")) throw new Error("The agent ID is the agt_… shown in Podster's pairing address");
  const storage = new RunnerStorage(deps.secrets);
  let state = await deps.state.load();
  // The thumbprint of the key this run used, kept for the answer even once the key is retired.
  let used: string | null = state.thumbprint;
  const done = (outcome: PairingOutcome) => ({ outcome, agentId, thumbprint: state.thumbprint ?? used });

  // A connected Runner stays as it is until the owner runs `forget`: one Runner, one agent.
  if (state.phase === "connected" && state.stopped === null) return done("already_paired");
  // The same pairing, interrupted, carries on with its own key. Anything else is a new pairing, which retires whatever key
  // came before: a key is never carried from one pairing to another.
  const resuming = state.agent_id === agentId && state.gateway === deps.origin && state.stopped === null && state.phase !== null;
  if (resuming && state.phase === "registering") {
    state = { ...state, stopped: "registration_unknown" };
    await deps.state.save(state);
    deps.log("pairing.register", "answer_lost", { agent: agentId });
    return done("registration_unknown");
  }

  if (!resuming) {
    if (typeof input.code !== "string" || !CODE.test(input.code)) throw new Error("The code is the one Podster showed when the pairing started");
    if (!(await deps.consent({ origin: deps.origin, agentId }))) return done("declined");
    state = await retire(deps, storage, state, null);
    const keypair = await freshKey(state.retired);
    const thumbprint = await thumbprintOf(keypair.publicKey);
    // The record names the key before the key is stored, so a crash between leaves a thumbprint with no key, never a key the record doesn't know.
    used = thumbprint;
    state = { ...emptyState(), retired: state.retired, gateway: deps.origin, agent_id: agentId, thumbprint, phase: "key_made" };
    await deps.state.save(state);
    await storage.installHostKey(keypair);
    deps.log("pairing.key", "made", { agent: agentId });
  }

  const host = await storage.getHostIdentity();
  if (!host || !state.thumbprint || (await thumbprintOf(host.keypair.publicKey)) !== state.thumbprint || state.retired.includes(state.thumbprint)) {
    state = await retire(deps, storage, state, "pairing_ended");
    return done("pairing_ended");
  }
  deps.notify({ kind: "thumbprint", thumbprint: state.thumbprint, grouped: grouped(state.thumbprint) });

  if (state.phase === "key_made") {
    if (typeof input.code !== "string" || !CODE.test(input.code)) throw new Error("The code is the one Podster showed when the pairing started");
    const redeemed = await redeem(deps, host.keypair, agentId, input.code, state.thumbprint);
    if (redeemed.kind === "unreachable") return done("unreachable");
    if (redeemed.kind === "ended") {
      state = await retire(deps, storage, state, "pairing_ended");
      return done("pairing_ended");
    }
    state = { ...state, phase: "redeemed", plugin_host_id: redeemed.hostId };
    await deps.state.save(state);
  }

  if (state.phase === "redeemed") {
    state = { ...state, phase: "registering" };
    await deps.state.save(state);
    const registered = await register(deps, storage);
    if (registered.kind === "retry") {
      state = { ...state, phase: "redeemed" };
      await deps.state.save(state);
      return done("unreachable");
    }
    if (registered.kind === "unknown") {
      state = { ...state, stopped: "registration_unknown" };
      await deps.state.save(state);
      deps.log("pairing.register", "answer_lost", { agent: agentId });
      return done("registration_unknown");
    }
    if (registered.kind === "ended") {
      state = await retire(deps, storage, state, "pairing_ended");
      return done("pairing_ended");
    }
    state = { ...state, phase: "registered", plugin_agent_id: registered.pluginAgentId };
    await deps.state.save(state);
    deps.log("pairing.register", "registered", { agent: agentId, plugin_agent: registered.pluginAgentId });
  }

  if (state.phase === "registered" && state.plugin_agent_id) {
    deps.notify({ kind: "waiting_for_confirmation", agentId });
    const confirmed = await waitForConfirmation(deps, storage, state.plugin_agent_id, agentId);
    if (confirmed === "waiting") return done("waiting");
    if (confirmed === "ended") {
      state = await retire(deps, storage, state, "pairing_ended");
      return done("pairing_ended");
    }
    state = { ...state, phase: "connected", last_contact_at: deps.clock.now() };
    await deps.state.save(state);
    deps.log("pairing.confirm", "connected", { agent: agentId });
    return done("connected");
  }
  return done(state.phase === "connected" ? "connected" : "pairing_ended");
}

/** A new key whose thumbprint was never retired. */
async function freshKey(retired: string[]): Promise<Keypair> {
  for (;;) {
    const keypair = await generateKeypair();
    if (!retired.includes(await thumbprintOf(keypair.publicKey))) return keypair;
  }
}

/**
 * Retires the current pairing's key, if there is one: its thumbprint goes on the retired list before the keys are
 * deleted, so a crash between still never uses it again. With `stop`, the record says why Runner stopped.
 */
export async function retire(deps: Pick<PairingDeps, "state" | "log">, storage: RunnerStorage, state: RunnerState, stop: RunnerState["stopped"]): Promise<RunnerState> {
  const retired = state.thumbprint && !state.retired.includes(state.thumbprint) ? [...state.retired, state.thumbprint].slice(-RETIRED_KEPT) : state.retired;
  const next: RunnerState = { ...state, retired, phase: null, plugin_host_id: null, plugin_agent_id: null, thumbprint: null, stopped: stop };
  await deps.state.save(next);
  await storage.deleteAll();
  if (state.thumbprint) deps.log("pairing.key", "retired", { agent: state.agent_id ?? undefined });
  return next;
}

type Redeemed = { kind: "redeemed"; hostId: string } | { kind: "ended" } | { kind: "unreachable" };

async function redeem(deps: PairingDeps, keypair: Keypair, agentId: string, code: string, thumbprint: string): Promise<Redeemed> {
  const reach = gatewayFetch(deps.origin, deps.fetch);
  let wait = FIRST_WAIT_MS;
  for (let attempt = 1; attempt <= REDEEM_TRIES; attempt++) {
    // A fresh proof every time: its own `jti`, the session's agent as issuer and subject, and no agent key.
    const proof = await signHostJWT({ hostKeypair: keypair, audience: deps.origin, issuer: agentId });
    let failure: GatewayError;
    try {
      const response = await reach(`${deps.origin}/pairing/${agentId}/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${proof}` },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (answer?.agent_id === agentId && answer.key_thumbprint === thumbprint && isId(answer.plugin_host_id)) {
          deps.log("pairing.redeem", "redeemed", { agent: agentId });
          return { kind: "redeemed", hostId: answer.plugin_host_id };
        }
        deps.log("pairing.redeem", "answer_mismatch", { agent: agentId });
        return { kind: "ended" };
      }
      failure = await errorFrom(response);
    } catch (error) {
      failure = error instanceof GatewayError ? error : new GatewayError(0, "network");
    }
    const meaning = meaningOf(failure);
    deps.log("pairing.redeem", meaning === "transient" || meaning === "rate_limited" ? "retry" : "refused", { agent: agentId, status: failure.status, code: failure.code });
    if (meaning !== "transient" && meaning !== "rate_limited") return { kind: "ended" };
    if (attempt < REDEEM_TRIES) await deps.clock.idle(failure.retryAfter !== null ? Math.max(failure.retryAfter * 1000, MIN_WAIT_MS) : wait);
    wait = Math.min(wait * 2, LONGEST_WAIT_MS);
  }
  return { kind: "unreachable" };
}

type Registered = { kind: "registered"; pluginAgentId: string } | { kind: "ended" } | { kind: "retry" } | { kind: "unknown" };

/**
 * Registers the one agent on the paired host, with the stored host key and Runner's allowlist. The paired host makes it
 * active at once; anything asking for an approval would ask for more than the pairing gives, so it ends the pairing.
 */
async function register(deps: PairingDeps, storage: RunnerStorage): Promise<Registered> {
  const stop = new AbortController();
  const client = new AgentAuthClient({
    storage,
    urls: [deps.origin],
    fetch: gatewayFetch(deps.origin, deps.fetch),
    hostName: RUNNER_NAME,
    approvalTimeoutMs: 1,
    // An approval is never Runner's to wait for: the paired host's defaults are all it asks for.
    onApprovalRequired: () => stop.abort(),
  });
  try {
    await client.init();
    const connect = (capabilities: string[]) => client.connectAgent({ provider: deps.origin, capabilities, mode: "delegated", preferredMethod: "device_authorization", name: RUNNER_NAME, signal: stop.signal });
    let connected;
    try {
      connected = await connect([...RUNNER_CAPABILITIES]);
    } catch (error) {
      // A deployment with managed repositories off doesn't list `get_repo_access` (M7 step 10): the same list without it.
      if ((error as { code?: unknown })?.code !== "invalid_capabilities" || stop.signal.aborted) throw error;
      deps.log("pairing.register", "without_switched", { code: "invalid_capabilities" });
      connected = await connect(RUNNER_CAPABILITIES.filter((c) => !(SWITCHED as readonly string[]).includes(c)));
    }
    if (connected.status !== "active" || !isId(connected.agentId)) return { kind: "ended" };
    return { kind: "registered", pluginAgentId: connected.agentId };
  } catch (error) {
    const status = typeof (error as { status?: unknown })?.status === "number" ? ((error as { status: number }).status) : 0;
    deps.log("pairing.register", "failed", { status });
    if (stop.signal.aborted) return { kind: "ended" };
    if (status === 429) return { kind: "retry" };
    if (status >= 400 && status < 500) return { kind: "ended" };
    return { kind: "unknown" };
  } finally {
    client.destroy();
  }
}

/** Asks Podster who Runner is until the person confirms, with a backoff. */
async function waitForConfirmation(deps: PairingDeps, storage: RunnerStorage, pluginAgentId: string, agentId: string): Promise<"connected" | "waiting" | "ended"> {
  const connection = new Connection({ origin: deps.origin, pluginAgentId, storage, fetch: deps.fetch });
  const until = deps.clock.now() + (deps.confirmWithinMs ?? CONFIRM_WITHIN_MS);
  let wait = FIRST_WAIT_MS;
  for (;;) {
    try {
      const identity = (await connection.call("get_identity")) as Record<string, unknown> | null;
      if (identity?.id === agentId) return "connected";
      deps.log("pairing.confirm", "wrong_agent", { agent: agentId });
      return "ended";
    } catch (error) {
      const failure = error instanceof GatewayError ? error : new GatewayError(0, "network");
      const meaning = meaningOf(failure);
      if (meaning === "authority") {
        deps.log("pairing.confirm", "ended", { agent: agentId, status: failure.status, code: failure.code });
        return "ended";
      }
      if (meaning !== "unclaimed") deps.log("pairing.confirm", "retry", { agent: agentId, status: failure.status, code: failure.code });
      if (deps.clock.now() >= until) return "waiting";
      await deps.clock.idle(failure.retryAfter !== null ? Math.max(failure.retryAfter * 1000, MIN_WAIT_MS) : wait);
      wait = Math.min(Math.round(wait * 1.5), LONGEST_WAIT_MS);
    }
  }
}
