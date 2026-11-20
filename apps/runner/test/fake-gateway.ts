/**
 * A stand-in for the gateway, as a `fetch`, for Runner's own tests: discovery, the pairing redeem, the plugin's
 * registration and capability execution, with the inbox and task listing Runner reads. It checks every JWT's signature,
 * type, audience and expiry the way the real one does, and lets a test script failures. The real gateway and API are
 * apps/gateway/test/runner-core.spec.ts.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Clock } from "../src/core/runtime.js";
import { thumbprintOf } from "../src/core/thumbprint.js";

export const ORIGIN = "https://gateway.test";
export const AGENT = "agt_0123456789abcdef0123456789abcdef";
export const CODE = "c".repeat(43);

type Jwt = { header: Record<string, unknown>; payload: Record<string, unknown> };
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

async function verified(token: string, key: { x?: unknown }): Promise<Jwt | null> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s || typeof key.x !== "string") return null;
  const publicKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: key.x }, { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("Ed25519", publicKey, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`));
  return ok ? { header: decode(h), payload: decode(p) } : null;
}

/** What the test scripts for the next answers of a route: a status to refuse with, or `network` to fail the connection. */
export type Scripted = number | "network";

export type Task = { id: string; status: string; version: number; assignee: string | null; title?: string; instructions?: string };

/** A task as `get_task` answers it, for the lifecycle's tests. */
export type Detail = {
  workspace_id: string;
  task: { id: string; title: string; instructions: string; acceptance_criteria: string | null; requester: string; reviewer: string; assignee: string | null; status: string; version: number };
  provenance: unknown;
  history: Record<string, unknown>[];
  /** Anything else the answer carries, which the prompt must never take. */
  extra?: Record<string, unknown>;
};

/** A refusal a capability answers with, in the gateway's own shape. */
class Refusal extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export class FakeGateway {
  /** The real gateway's code refusal shape, `{ error: { code } }`. */
  redeemScript: Scripted[] = [];
  registerScript: Scripted[] = [];
  executeScript: Scripted[] = [];
  proofs: Jwt[] = [];
  agentJwts: Jwt[] = [];
  registrations: { capabilities: string[]; name: string }[] = [];
  /** Registrations the plugin refused as naming a capability this deployment doesn't list. */
  refusedRegistrations: string[][] = [];
  /** Whether this deployment lists a capability: all, unless a test switches managed repositories off. */
  listed: (capability: string) => boolean = () => true;
  calls: { capability: string; arguments: Record<string, unknown> }[] = [];
  /** Every URL asked, in order. */
  asked: string[] = [];

  hostKey: { x?: string } | null = null;
  agentKey: { x?: string } | null = null;
  readonly hostId = "host_one";
  readonly pluginAgent = "plugin_agent_one";
  /** What the session says: the person confirms, cancels, or the agent is later revoked. */
  session: "pending" | "redeemed" | "confirmed" | "canceled" | "revoked" = "pending";
  /** The code the session accepts. */
  code = CODE;
  /** Registration answers this status. */
  registerStatus: "active" | "pending" = "active";
  /** The identity answered once confirmed. */
  identity = AGENT;
  /** The agent's inbox and rooms. */
  events: { seq: number; event_id: string; workspace_id: string; type: string; task_id: string | null; actor_id: string; created_at: number }[] = [];
  acked = 0;
  dropped = 0;
  workspaces: string[] = [];
  tasks: Record<string, Task[]> = {};
  /** Workspaces whose listing refuses, as one the agent left would. */
  refusedWorkspaces = new Set<string>();
  /** Tasks as `get_task` answers them, by task ID. */
  details: Record<string, Detail> = {};
  /** Each command's stored answer by its idempotency key, as the API keeps them. */
  readonly stored = new Map<string, unknown>();
  /** Submissions the API took, and thread messages it posted (step 11). */
  submissions: Record<string, unknown>[] = [];
  messages: Record<string, unknown>[] = [];
  /** A refusal every submission gets, as the API's checks of the pull request would give. */
  submitRefusal: { status: number; code: string } | null = null;
  /** Capabilities whose next answer is applied, then lost on the way back, as a dropped connection would. */
  loseAnswers: string[] = [];
  /** Every call fails at the network, as Podster unreachable would. */
  unreachable = false;
  /**
   * The agent's A2A endpoint as the API keeps it (M7 step 13): a new URL or mode is a new version and secret, the same
   * URL keeps both and answers no secret, and `rotate_secret` makes a new secret for the same version. A new secret
   * clears the proof and the owner's opt-in.
   */
  endpoint: { url: string; version: number; secret: string; delivery: string; control: "verified" | "unverified"; nudge_on: boolean } | null = null;
  endpointVersion = 0;
  /** Every `set_a2a_endpoint`'s arguments, in order. */
  endpointSets: Record<string, unknown>[] = [];
  /** Where a challenge goes: the far end, as Runner's listener gets it through the owner's proxy. */
  deliver: ((request: Request) => Promise<Response>) | null = null;
  /** Each challenge sent and the proof that came back. */
  challenges: { challenge: string; proof: unknown }[] = [];
  /** Run when a capability is called, before it answers: lets a test act as the person mid-wait. */
  onCall: ((capability: string) => void | Promise<void>) | null = null;

  readonly clock: Clock;
  constructor(clock: Clock) {
    this.clock = clock;
  }

  offer(workspace: string, task: string, type = "task.offered") {
    const seq = (this.events.at(-1)?.seq ?? 0) + 1;
    this.events.push({ seq, event_id: `evt_${seq}`, workspace_id: workspace, type, task_id: task, actor_id: "per_requester", created_at: this.clock.now() });
    return seq;
  }

  private scripted(script: Scripted[]): Response | "network" | null {
    const next = script.shift();
    if (next === undefined) return null;
    if (next === "network") return "network";
    return Response.json({ error: { code: next === 429 ? "rate_limited" : next >= 500 ? "upstream_unavailable" : "not_allowed" } }, { status: next, headers: next === 429 ? { "retry-after": "2" } : {} });
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    this.asked.push(request.url);
    if (url.origin !== ORIGIN) throw new Error(`the fake was asked for another origin: ${url.origin}`);
    const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");

    if (url.pathname === "/.well-known/agent-configuration") {
      const issuer = `${ORIGIN}/api/auth`;
      return Response.json({ version: "1.0-draft", provider_name: "podster", description: "test", issuer, algorithms: ["Ed25519"], modes: ["delegated"], approval_methods: ["device_authorization"], endpoints: { register: `${issuer}/agent/register`, execute: `${issuer}/capability/execute`, status: `${issuer}/agent/status` }, default_location: `${issuer}/capability/execute` });
    }

    const redeem = /^\/pairing\/([^/]+)\/redeem$/.exec(url.pathname);
    if (redeem) {
      const scripted = this.scripted(this.redeemScript);
      if (scripted === "network") throw new TypeError("fetch failed");
      const key = decode(bearer.split(".")[1] ?? "e30").host_public_key as { x?: string } | undefined;
      const jwt = key ? await verified(bearer, key) : null;
      if (jwt) this.proofs.push(jwt);
      if (scripted) return scripted;
      if (!jwt || jwt.header.typ !== "host+jwt" || jwt.payload.sub !== redeem[1] || jwt.payload.aud !== ORIGIN || jwt.payload.agent_public_key !== undefined) return Response.json({ error: { code: "invalid_jwt" } }, { status: 401 });
      if (this.proofs.filter((p) => p.payload.jti === jwt.payload.jti).length > 1) return Response.json({ error: { code: "not_allowed" } }, { status: 403 });
      if (this.session === "canceled" || body.code !== this.code || redeem[1] !== AGENT) return Response.json({ error: { code: "not_allowed" } }, { status: 403 });
      if (this.hostKey && this.hostKey.x !== key?.x) return Response.json({ error: { code: "not_allowed" } }, { status: 403 });
      this.hostKey = { x: key?.x };
      this.session = "redeemed";
      const thumbprint = await thumbprintOf(key as { x: string; kty: string; crv: string });
      return Response.json({ agent_id: AGENT, status: "redeemed", plugin_host_id: this.hostId, key_thumbprint: thumbprint });
    }

    if (url.pathname === "/api/auth/agent/register") {
      const scripted = this.scripted(this.registerScript);
      if (scripted === "network") throw new TypeError("fetch failed");
      if (scripted) return scripted;
      const unverified = decode(bearer.split(".")[1] ?? "e30");
      const jwt = this.hostKey ? await verified(bearer, this.hostKey) : null;
      if (!jwt || (unverified.host_public_key as { x?: string })?.x !== this.hostKey?.x) return Response.json({ error: "invalid_jwt", message: "bad host" }, { status: 401 });
      this.agentKey = jwt.payload.agent_public_key as { x?: string };
      const unlisted = (body.capabilities as string[]).filter((c) => !this.listed(c));
      if (unlisted.length > 0) {
        this.refusedRegistrations.push(body.capabilities as string[]);
        return Response.json({ error: "invalid_capabilities", message: "One or more requested capability names don't exist or are blocked" }, { status: 400 });
      }
      this.registrations.push({ capabilities: body.capabilities as string[], name: body.name as string });
      const pending = this.registerStatus === "pending";
      return Response.json({ agent_id: this.pluginAgent, host_id: this.hostId, name: body.name, mode: "delegated", status: this.registerStatus, agent_capability_grants: (body.capabilities as string[]).map((capability) => ({ capability, status: pending ? "pending" : "active" })), ...(pending ? { approval: { method: "device_authorization", user_code: "ABCD", verification_uri: `${ORIGIN}/claim`, expires_in: 600, interval: 5 } } : {}) });
    }

    if (url.pathname === "/api/auth/capability/execute") {
      const capability = String(body.capability);
      const args = (body.arguments ?? {}) as Record<string, unknown>;
      if (this.unreachable) throw new TypeError("fetch failed");
      this.calls.push({ capability, arguments: args });
      await this.onCall?.(capability);
      const scripted = this.scripted(this.executeScript);
      if (scripted === "network") throw new TypeError("fetch failed");
      if (scripted) return scripted;
      const jwt = this.agentKey ? await verified(bearer, this.agentKey) : null;
      if (!jwt || jwt.header.typ !== "agent+jwt" || jwt.payload.sub !== this.pluginAgent) return Response.json({ error: "invalid_jwt", message: "Invalid JWT" }, { status: 401 });
      this.agentJwts.push(jwt);
      if (this.session === "revoked" || this.session === "canceled") return Response.json({ error: "agent_revoked", message: "Agent has been revoked." }, { status: 403 });
      if (this.session !== "confirmed") return Response.json({ message: "agent_unclaimed" }, { status: 403 });
      if (capability === "list_tasks" && this.refusedWorkspaces.has(String(args.workspace_id))) return Response.json({ message: "not_found", code: "not_found" }, { status: 404 });
      let data: unknown;
      try {
        data = capability === "verify_a2a_endpoint" ? await this.verifyEndpoint() : this.answer(capability, args);
      } catch (error) {
        if (error instanceof Refusal) return Response.json({ error: { code: error.code } }, { status: error.status });
        throw error;
      }
      const lost = this.loseAnswers.indexOf(capability);
      if (lost >= 0) {
        this.loseAnswers.splice(lost, 1);
        throw new TypeError("fetch failed");
      }
      return Response.json({ data });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }) as typeof fetch;

  /** The endpoint as a read shows it: never the secret. */
  private endpointStatus() {
    const e = this.endpoint;
    if (!e) return null;
    return { url: e.url, version: e.version, enabled: true, delivery: e.delivery, ...(e.delivery === "nudge" ? { control: e.control, nudge_on: e.nudge_on } : {}) };
  }

  /**
   * `verify_a2a_endpoint`, as the API's challenge does it: one signed `podster.dev/verifyEndpoint` request, and the
   * proof checked with this file's own HMAC, not Runner's.
   */
  private async verifyEndpoint() {
    const e = this.endpoint;
    if (!e) throw new Refusal(404, "no_endpoint");
    if (e.delivery !== "nudge") throw new Refusal(409, "not_a_nudge_endpoint");
    const challenge = randomBytes(32).toString("hex");
    const body = JSON.stringify({ jsonrpc: "2.0", id: challenge, method: "podster.dev/verifyEndpoint", params: { agent_id: this.identity, version: e.version, challenge } });
    const t = Math.floor(this.clock.now() / 1000);
    const signature = `t=${t},v1=${createHmac("sha256", e.secret).update(`${t}.${body}`).digest("hex")}`;
    let proof: unknown;
    try {
      const answer = this.deliver ? await this.deliver(new Request(e.url, { method: "POST", headers: { "content-type": "application/json", "a2a-version": "1.0", "x-podster-signature": signature }, body })) : null;
      proof = answer?.ok ? ((await answer.json()) as { result?: { proof?: unknown } }).result?.proof : undefined;
    } catch {
      proof = undefined;
    }
    this.challenges.push({ challenge, proof });
    const verified = proof === createHmac("sha256", e.secret).update(`podster-endpoint-proof/1.${this.identity}.${e.version}.${challenge}`).digest("hex");
    if (verified) e.control = "verified";
    return { ...this.endpointStatus(), verified, ...(verified ? {} : { reason: "no_proof" }) };
  }

  private answer(capability: string, args: Record<string, unknown>): unknown {
    if (capability === "set_a2a_endpoint") {
      this.endpointSets.push(structuredClone(args));
      const url = String(args.url);
      const delivery = typeof args.delivery === "string" ? args.delivery : (this.endpoint?.delivery ?? "offers");
      const secret = () => `a2asec_${randomBytes(24).toString("hex")}`;
      let fresh = false;
      if (!this.endpoint || this.endpoint.url !== url || this.endpoint.delivery !== delivery) {
        this.endpointVersion += 1;
        this.endpoint = { url, version: this.endpointVersion, secret: secret(), delivery, control: "unverified", nudge_on: false };
        fresh = true;
      } else if (args.rotate_secret === true) {
        Object.assign(this.endpoint, { secret: secret(), control: "unverified", nudge_on: false });
        fresh = true;
      }
      return { ...this.endpointStatus(), ...(fresh ? { signing_secret: this.endpoint.secret } : {}) };
    }
    if (capability === "get_identity") return { id: this.identity, org_id: "org_one" };
    if (capability === "list_workspaces") return { workspaces: this.workspaces.map((id) => ({ workspace_id: id, workspace_name: "a room", role: "member", status: "active" })) };
    if (capability === "list_tasks") {
      const room = String(args.workspace_id);
      const all = this.tasks[room] ?? [];
      const from = typeof args.cursor === "string" ? all.findIndex((t) => t.id === args.cursor) + 1 : 0;
      const page = all.slice(from, from + 2);
      return { tasks: page, next_cursor: from + 2 < all.length ? page.at(-1)?.id : null };
    }
    if (capability === "read_inbox") {
      const after = typeof args.after === "number" ? args.after : this.acked;
      const limit = typeof args.limit === "number" ? args.limit : 10;
      return { events: this.events.filter((e) => e.seq > after).slice(0, limit), acked_seq: this.acked, unread: 0, dropped: this.dropped };
    }
    if (capability === "get_task") {
      const detail = this.details[String(args.task_id)];
      if (!detail || detail.workspace_id !== args.workspace_id) throw new Refusal(404, "not_found");
      return { task: structuredClone(detail.task), provenance: structuredClone(detail.provenance), history: structuredClone(detail.history), submissions: [], artifacts: [], messages: [], visible: { submissions: "all", conversation: true }, ...structuredClone(detail.extra ?? {}) };
    }
    if (capability === "accept_task" || capability === "decline_task" || capability === "release_task") {
      const key = `${capability}:${String(args.idempotency_key)}`;
      if (typeof args.idempotency_key !== "string" || args.idempotency_key.length === 0) throw new Refusal(400, "idempotency_key_required");
      // A replay answers what the first answered, whatever the task has done since.
      if (this.stored.has(key)) return structuredClone(this.stored.get(key));
      const detail = this.details[String(args.task_id)];
      if (!detail || detail.workspace_id !== args.workspace_id || detail.task.assignee !== this.identity) throw new Refusal(403, "not_allowed");
      if (args.version !== detail.task.version) throw new Refusal(409, "version_conflict");
      const from = capability === "release_task" ? "accepted" : "offered";
      if (detail.task.status !== from) throw new Refusal(409, "invalid_transition");
      if (capability !== "accept_task" && !(typeof args.reason === "string" && args.reason.length > 0)) throw new Refusal(400, "invalid_argument");
      detail.task.version += 1;
      if (capability === "accept_task") detail.task.status = "accepted";
      else {
        detail.task.status = "open";
        detail.task.assignee = null;
      }
      detail.history.push({ id: `evt_h${detail.history.length + 1}`, type: capability === "accept_task" ? "task.accepted" : capability === "decline_task" ? "task.declined" : "task.released", reason: args.reason ?? null, actor_id: this.identity });
      this.stored.set(key, structuredClone(detail.task));
      return structuredClone(detail.task);
    }
    if (capability === "submit_task" || capability === "send_message") {
      // Step 11. A replay with the same key answers what the first did; the same key with another body is refused, as
      // the API's `idempotency_mismatch` does.
      if (typeof args.idempotency_key !== "string" || args.idempotency_key.length === 0) throw new Refusal(400, "idempotency_key_required");
      const key = `${capability}:${args.idempotency_key}`;
      const body = JSON.stringify(args);
      const held = this.stored.get(key) as { body: string; answer: unknown } | undefined;
      if (held) {
        if (held.body !== body) throw new Refusal(422, "idempotency_mismatch");
        return structuredClone(held.answer);
      }
      const detail = this.details[String(args.task_id)];
      if (!detail || detail.workspace_id !== args.workspace_id) throw new Refusal(404, "task_not_found");
      let answer: unknown;
      if (capability === "send_message") {
        if (typeof args.body !== "string" || args.body.length === 0) throw new Refusal(400, "invalid_argument");
        this.messages.push(structuredClone(args));
        answer = { id: `msg_${this.messages.length}` };
      } else {
        if (detail.task.assignee !== this.identity) throw new Refusal(403, "not_allowed");
        if (args.version !== detail.task.version) throw new Refusal(409, "version_conflict");
        if (detail.task.status !== "accepted") throw new Refusal(409, "invalid_transition");
        if (this.submitRefusal) throw new Refusal(this.submitRefusal.status, this.submitRefusal.code);
        detail.task.version += 1;
        detail.task.status = "submitted";
        detail.history.push({ id: `evt_h${detail.history.length + 1}`, type: "task.submitted", reason: null, actor_id: this.identity });
        this.submissions.push(structuredClone(args));
        answer = structuredClone(detail.task);
      }
      this.stored.set(key, { body, answer: structuredClone(answer) });
      return answer;
    }
    if (capability === "list_messages") {
      // A task's thread, oldest first, 50 at a time after the message `after` names.
      const thread = this.messages.map((m, i) => ({ id: `msg_${i + 1}`, task_id: m.task_id, from: { id: this.identity }, body: m.body })).filter((m) => m.task_id === args.task_id);
      const from = typeof args.after === "string" ? thread.findIndex((m) => m.id === args.after) + 1 : 0;
      return { messages: thread.slice(from, from + 50).map(({ task_id: _t, ...m }) => m) };
    }
    if (capability === "ack_inbox") {
      this.acked = Math.max(this.acked, Number(args.up_to));
      return { acked_seq: this.acked, unread: 0 };
    }
    return {};
  }
}

/** A clock the test moves: `idle` returns at once, having moved time on by what was asked. */
export class TestClock implements Clock {
  at = 1_800_000_000_000;
  idles: number[] = [];
  /** Run on each idle, after time moves: lets a test act while Runner waits. */
  onIdle: ((ms: number) => void | Promise<void>) | null = null;
  now() {
    return this.at;
  }
  async idle(ms: number, signal?: AbortSignal) {
    if (signal?.aborted) return;
    this.idles.push(ms);
    this.at += ms;
    await this.onIdle?.(ms);
  }
}
