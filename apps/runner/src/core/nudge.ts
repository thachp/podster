/**
 * Runner's side of the inbound nudge (M7 step 14; RUNNER.md "Optional inbound A2A"; ADR 0007 "Nudge delivery"; S-13).
 * Everything here is **Proposed**, and off unless the owner starts `run` with `--nudge-listen` and `--nudge-url`.
 *
 * Podster's outbox sends a nudge endpoint IDs only: a signed JSON-RPC `SendMessage` with one data part
 * `{ kind: "podster.dev/nudge", workspace_id, task_id, attempt_id, attempt_kind }`. Runner treats it as a nudge and
 * nothing more: it rings `NudgeBell`, which only ends the poll loop's current wait early, so the next thing that happens is
 * the ordinary outbound poll and the ordinary run policy. The nudge's IDs are logged and never used: no task is fetched,
 * accepted or run because of what a request says. Polling stays on, and the inbox stays the source of truth, so a missed
 * or refused nudge loses nothing.
 *
 * `NudgeEndpoint.handle` checks, in this order, each before the next, and refuses at the first that fails:
 *
 * 1. the rate (a token bucket for the whole endpoint), before the body is read;
 * 2. no browser `Origin`, the method (POST) and the path (the registered URL's);
 * 3. a registration to check against;
 * 4. the size: a declared length past the bound, then the body read only up to the bound;
 * 5. the signature, `X-Podster-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, under the
 *    registration's signing secret, compared in constant time, and its time within the window either way;
 * 6. an exact replay of a signature seen within the window;
 * 7. only then the JSON, and the `A2A-Version` it asks for: only 1.0 is served, a patch of it counts as 1.0, and a missing
 *    header is 0.3 (A2A 1.0, 3.6), so anything else gets `VersionNotSupportedError` (step 15);
 * 8. a `podster.dev/verifyEndpoint` challenge for this agent and registration version, or a nudge of exactly the shape
 *    above. Anything else is refused. A retry of an attempt already taken is answered and rings nothing.
 *
 * The memory of what was seen is bounded. While it's full of entries still inside the window, a new request is refused
 * rather than an entry forgotten early, which would let it be replayed.
 *
 * Logs carry fixed words, codes and IDs only: never a body, a header, the URL or the secret.
 */
import type { Clock, Logger } from "./runtime.js";
import { isId } from "./state.js";
import type { RunnerStorage } from "./storage.js";

export const NUDGE_KIND = "podster.dev/nudge";
export const VERIFY_METHOD = "podster.dev/verifyEndpoint";
/** What the proof is an HMAC of, before the agent, version and challenge (`podster_egress::nudge::PROOF_LABEL`). */
export const PROOF_LABEL = "podster-endpoint-proof/1";
/** **Proposed:** the largest body read. A nudge is about 600 bytes and a challenge about 250. */
export const MAX_NUDGE_BODY_BYTES = 8 * 1024;
/** **Proposed:** how far a signature's time may be from Runner's clock, either way. */
export const SIGNATURE_WINDOW_S = 300;
/** **Proposed:** requests taken at once, and refilled per minute, for the whole endpoint. */
export const RATE_BURST = 30;
export const RATE_PER_MINUTE = 60;
/** **Proposed:** signatures, attempts and challenges remembered, each for twice the window. */
export const SEEN_LIMIT = 512;
/**
 * **Proposed:** the longest public URL taken, under Podster's 2,048. The key-store item holding it with the secret must fit
 * one line of macOS's keychain tool, which a test measures.
 */
export const MAX_NUDGE_URL_BYTES = 1024;
/** The shortest wait after a poll, nudged or not: Runner's shortest poll interval, so nudges never poll faster. */
export const NUDGE_GAP_MS = 5_000;

const SIGNATURE = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;
/** The A2A version Podster's nudge speaks, and the only one served (ADR 0007, decisions 108 and 192). */
export const A2A_VERSION = "1.0";
/** A2A 1.0's `VersionNotSupportedError`, as its JSON-RPC binding numbers it. */
export const VERSION_NOT_SUPPORTED = -32009;
/** `major.minor` with an optional `.patch`: digits only, no leading zeros, bounded, as the gateway reads it. */
const VERSION = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:\.(0|[1-9]\d{0,5}))?$/;
const CHALLENGE = /^[0-9a-f]{64}$/;
const ATTEMPT_KINDS = new Set(["offer", "change_request"]);
const encoder = new TextEncoder();

/** What Runner holds for its nudge endpoint, in its key store: the secret, and what it was issued for. */
export type NudgeRegistration = { url: string; agent_id: string; version: number; secret: string };

export function isRegistration(value: unknown): value is NudgeRegistration {
  const v = value as Record<string, unknown> | null;
  return !!v && typeof v === "object" && typeof v.url === "string" && isId(v.agent_id) && Number.isSafeInteger(v.version) && (v.version as number) > 0 && typeof v.secret === "string" && v.secret.length > 0;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const hmacKey = (secret: string, usage: "sign" | "verify") => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

/**
 * Whether `header` asks for A2A 1.0. A missing header is 0.3 (A2A 1.0, 3.6.2), a patch never counts (3.6), and anything
 * that isn't exactly a version is no version at all.
 */
export function asksForServedVersion(header: string | null): boolean {
  const match = header === null ? null : VERSION.exec(header);
  return match !== null && `${match[1]}.${match[2]}` === A2A_VERSION;
}

/** Lowercase hex HMAC-SHA256 of `text` under `secret`. */
export async function hmacHex(secret: string, text: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(text)));
}

/** The answer to Podster's challenge: `podster_egress::nudge::proof`. */
export function proofFor(secret: string, agent: string, version: number, challenge: string): Promise<string> {
  return hmacHex(secret, `${PROOF_LABEL}.${agent}.${version}.${challenge}`);
}

export type SignatureCheck = { ok: true; digest: string } | { ok: false; code: "unsigned" | "forged" | "stale" };

/**
 * Whether `header` signs `body` under `secret` at a time within the window of `nowMs`. The HMAC is checked first, by
 * Web Crypto's own constant-time verify, so the time is only read from a signature that's genuine.
 */
export async function checkSignature(secret: string, header: string | null, body: string, nowMs: number): Promise<SignatureCheck> {
  if (header === null || header === "") return { ok: false, code: "unsigned" };
  const match = SIGNATURE.exec(header);
  if (!match) return { ok: false, code: "forged" };
  const [, t, digest] = match;
  const given = new Uint8Array((digest.match(/../g) as string[]).map((pair) => parseInt(pair, 16)));
  const genuine = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), given, encoder.encode(`${t}.${body}`));
  if (!genuine) return { ok: false, code: "forged" };
  if (Math.abs(Number(t) - Math.floor(nowMs / 1000)) > SIGNATURE_WINDOW_S) return { ok: false, code: "stale" };
  return { ok: true, digest };
}

/**
 * The public URL the owner registers: HTTPS, a DNS name with a dot, the default port, no credentials, query or fragment.
 * Podster checks it again under its own egress rules. Answers the URL as written out, or null.
 */
export function checkNudgeUrl(value: string): string | null {
  if (encoder.encode(value).byteLength > MAX_NUDGE_URL_BYTES) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
  // The URL parser writes every IPv4 form (hex, octal, short) as dotted digits, and IPv6 in brackets.
  if (!host.includes(".") || host.startsWith("[") || /^[0-9.]+$/.test(host)) return null;
  return encoder.encode(url.href).byteLength > MAX_NUDGE_URL_BYTES ? null : url.href;
}

/**
 * The poll loop's wait, cut short by a nudge. Each wait after a good poll first waits `NUDGE_GAP_MS`, so nudges never make
 * Runner poll faster than its shortest interval; a ring before or during that ends the wait there, and a ring later ends
 * it at once. A ring is used once. Only a good poll's wait is ever shortened, so a nudge never cuts a backoff.
 */
export class NudgeBell {
  private pending = false;
  private wake: (() => void) | null = null;
  private readonly gapMs: number;

  constructor(gapMs = NUDGE_GAP_MS) {
    this.gapMs = gapMs;
  }

  ring(): void {
    this.pending = true;
    this.wake?.();
  }

  private take(): boolean {
    const was = this.pending;
    this.pending = false;
    return was;
  }

  async idle(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
    const gap = Math.min(ms, this.gapMs);
    await clock.idle(gap, signal);
    if (signal.aborted || gap >= ms || this.take()) return;
    const woken = new AbortController();
    const stop = () => woken.abort();
    signal.addEventListener("abort", stop, { once: true });
    this.wake = stop;
    try {
      await clock.idle(ms - gap, woken.signal);
    } finally {
      this.wake = null;
      signal.removeEventListener("abort", stop);
      this.take();
    }
  }
}

export type EndpointDeps = {
  /** The registration in force, or null before there is one. Read on every request. */
  registration: () => NudgeRegistration | null;
  /** The registered URL's path: the only one served. */
  path: string;
  clock: Clock;
  log: Logger;
  bell: NudgeBell;
};

const refused = (status: number) => new Response(null, { status, headers: { connection: "close" } });
const rpc = (id: unknown, answer: { result: unknown } | { error: { code: number; message: string } }) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null, ...answer }), { status: 200, headers: { "content-type": "application/json", connection: "close" } });
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Reads at most `max` bytes of a request's body as UTF-8. Null if it's longer, unreadable or not UTF-8. */
async function readUpTo(request: Request, max: number): Promise<string | null> {
  const body = request.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return null;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export class NudgeEndpoint {
  private readonly deps: EndpointDeps;
  /** Each key seen, with when it may be forgotten. Insertion order is age order. */
  private readonly seen = new Map<string, number>();
  private tokens = RATE_BURST;
  private refilledAt: number;

  constructor(deps: EndpointDeps) {
    this.deps = deps;
    this.refilledAt = deps.clock.now();
  }

  /** How many keys the replay memory holds now, for tests. */
  get remembered(): number {
    return this.seen.size;
  }

  private log(outcome: string, code?: string, ids: { workspace?: string; task?: string; attempt_id?: string } = {}) {
    this.deps.log("nudge.request", outcome, { ...ids, ...(code ? { code } : {}) });
  }

  private refuse(status: number, code: string): Response {
    this.log("refused", code);
    return refused(status);
  }

  private admit(): boolean {
    const now = this.deps.clock.now();
    this.tokens = Math.min(RATE_BURST, this.tokens + ((now - this.refilledAt) * RATE_PER_MINUTE) / 60_000);
    this.refilledAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Forgets what's past its time. Answers whether there's room for `count` more. */
  private room(count: number): boolean {
    const now = this.deps.clock.now();
    for (const [key, until] of this.seen) {
      if (until > now) break;
      this.seen.delete(key);
    }
    return this.seen.size + count <= SEEN_LIMIT;
  }

  private remember(...keys: string[]) {
    const until = this.deps.clock.now() + 2 * SIGNATURE_WINDOW_S * 1000;
    for (const key of keys) {
      this.seen.delete(key);
      this.seen.set(key, until);
    }
  }

  async handle(request: Request): Promise<Response> {
    if (!this.admit()) return this.refuse(429, "rate_limited");
    if (request.headers.get("origin") !== null) return this.refuse(403, "origin_refused");
    if (request.method !== "POST") return this.refuse(405, "wrong_method");
    if (new URL(request.url).pathname !== this.deps.path) return this.refuse(404, "wrong_path");
    const registration = this.deps.registration();
    if (registration === null) return this.refuse(503, "no_registration");
    const declared = request.headers.get("content-length");
    if (declared !== null && !(Number(declared) <= MAX_NUDGE_BODY_BYTES)) return this.refuse(413, "too_large");
    const body = await readUpTo(request, MAX_NUDGE_BODY_BYTES);
    if (body === null) return this.refuse(413, "too_large");

    // Nothing in the body is looked at until its signature and time pass.
    const signature = await checkSignature(registration.secret, request.headers.get("x-podster-signature"), body, this.deps.clock.now());
    if (!signature.ok) return this.refuse(401, signature.code);
    if (!this.room(0)) return this.refuse(503, "memory_full");
    if (this.seen.has(`sig:${signature.digest}`)) return this.refuse(409, "replayed");

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return this.refuse(400, "bad_request");
    }
    if (!isObject(parsed) || parsed.jsonrpc !== "2.0" || !isObject(parsed.params)) return this.refuse(400, "bad_request");
    const { id, method, params } = parsed;
    if (!asksForServedVersion(request.headers.get("a2a-version"))) {
      this.log("refused", "wrong_version");
      return rpc(id, { error: { code: VERSION_NOT_SUPPORTED, message: "Only A2A 1.0 is supported." } });
    }
    if (method === VERIFY_METHOD) return this.verify(registration, id, params, signature.digest);
    if (method === "SendMessage") return this.nudge(id, params, signature.digest);
    this.log("refused", "wrong_kind");
    return rpc(id, { error: { code: -32601, message: "Only a Podster nudge is taken here." } });
  }

  private async verify(registration: NudgeRegistration, id: unknown, params: Record<string, unknown>, digest: string): Promise<Response> {
    const { agent_id: agent, version, challenge } = params;
    if (agent !== registration.agent_id || version !== registration.version || typeof challenge !== "string" || !CHALLENGE.test(challenge) || id !== challenge) {
      this.log("refused", "wrong_registration");
      return rpc(id, { error: { code: -32602, message: "Not this endpoint's registration." } });
    }
    if (this.seen.has(`challenge:${challenge}`)) {
      // Refused, and not remembered: a repeat is harmless, and remembering it could fill the memory.
      this.log("refused", "replayed");
      return rpc(id, { error: { code: -32602, message: "This challenge was answered already." } });
    }
    if (!this.room(2)) return this.refuse(503, "memory_full");
    this.remember(`sig:${digest}`, `challenge:${challenge}`);
    this.log("verified");
    return rpc(id, { result: { proof: await proofFor(registration.secret, registration.agent_id, registration.version, challenge) } });
  }

  private nudge(id: unknown, params: Record<string, unknown>, digest: string): Response {
    const message = params.message;
    const parts = isObject(message) ? message.parts : undefined;
    const part = Array.isArray(parts) && parts.length === 1 && isObject(parts[0]) ? parts[0] : null;
    const data = part && isObject(part.data) ? part.data : null;
    const keys = data ? Object.keys(data).sort().join(",") : "";
    if (
      !isObject(message) ||
      !data ||
      data.kind !== NUDGE_KIND ||
      keys !== "attempt_id,attempt_kind,kind,task_id,workspace_id" ||
      !isId(data.workspace_id) ||
      !isId(data.task_id) ||
      !isId(data.attempt_id) ||
      !ATTEMPT_KINDS.has(data.attempt_kind as string) ||
      message.messageId !== data.attempt_id
    ) {
      this.log("refused", "wrong_kind");
      return rpc(id, { error: { code: -32602, message: "Only a Podster nudge is taken here." } });
    }
    // The attempt's ID ties this line to Podster's own audit of the nudge (R-18).
    const ids = { workspace: data.workspace_id as string, task: data.task_id as string, attempt_id: data.attempt_id as string };
    const taken = { result: { message: { messageId: crypto.randomUUID(), role: "ROLE_AGENT", parts: [{ text: "Nudged. Runner checks its inbox." }] } } };
    if (this.seen.has(`attempt:${data.attempt_id}`)) {
      // Podster's retry of an attempt already taken: answered, so it stops retrying, and nothing more is rung. Not
      // remembered: answering it again is harmless, and remembering it could fill the memory.
      this.log("duplicate", undefined, ids);
      return rpc(id, taken);
    }
    if (!this.room(2)) return this.refuse(503, "memory_full");
    this.remember(`sig:${digest}`, `attempt:${data.attempt_id}`);
    this.log("nudged", undefined, ids);
    this.deps.bell.ring();
    return rpc(id, taken);
  }
}

/** What `registerNudge` and `verifyNudge` call: the poller's `request`, as the agent. */
export type NudgeCalls = {
  request(capability: "set_a2a_endpoint" | "verify_a2a_endpoint", args?: Record<string, unknown>): Promise<unknown>;
  readonly agentId: string;
};

export type Registered = { registration: NudgeRegistration; control: "verified" | "unverified"; nudge_on: boolean };

/**
 * Registers `url` as this agent's nudge endpoint, keeping any registration Podster and Runner already share. The same URL
 * set again keeps its version and secret in Podster, and its proof and the owner's opt-in with them. Only if Runner holds
 * no secret for the version Podster answers does it ask for a new one (`rotate_secret`), which needs proof and the
 * owner's opt-in again. A new secret goes to the key store before anything else uses it.
 */
export async function registerNudge(calls: NudgeCalls, storage: RunnerStorage, url: string, log: Logger): Promise<Registered> {
  const held = await storage.getNudge();
  const read = async (args: Record<string, unknown>) => {
    const answer = await calls.request("set_a2a_endpoint", args);
    if (!isObject(answer) || answer.url !== url || answer.delivery !== "nudge" || !Number.isSafeInteger(answer.version)) throw new Error("bad_answer");
    return answer;
  };
  let answer = await read({ url, delivery: "nudge" });
  let secret = typeof answer.signing_secret === "string" && answer.signing_secret.length > 0 ? answer.signing_secret : null;
  const same = held !== null && held.url === url && held.agent_id === calls.agentId && held.version === answer.version;
  if (secret === null && !same) {
    answer = await read({ url, delivery: "nudge", rotate_secret: true });
    secret = typeof answer.signing_secret === "string" && answer.signing_secret.length > 0 ? answer.signing_secret : null;
    if (secret === null) throw new Error("bad_answer");
  }
  const registration: NudgeRegistration = secret === null ? (held as NudgeRegistration) : { url, agent_id: calls.agentId, version: answer.version as number, secret };
  if (secret !== null) await storage.setNudge(registration);
  log("nudge.register", secret === null ? "kept" : "new_secret", { agent: calls.agentId, count: registration.version });
  return { registration, control: answer.control === "verified" ? "verified" : "unverified", nudge_on: answer.nudge_on === true };
}

/** Asks Podster to challenge the endpoint, which must already be listening. Answers whether it proved control. */
export async function verifyNudge(calls: NudgeCalls, log: Logger): Promise<{ verified: boolean; nudge_on: boolean }> {
  const answer = await calls.request("verify_a2a_endpoint");
  const verified = isObject(answer) && answer.verified === true;
  const reason = isObject(answer) && typeof answer.reason === "string" ? answer.reason : undefined;
  log("nudge.verify", verified ? "verified" : "not_verified", { agent: calls.agentId, ...(reason ? { code: reason } : {}) });
  return { verified, nudge_on: isObject(answer) && answer.nudge_on === true };
}
