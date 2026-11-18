/**
 * A stand-in for the gateway, as a `fetch`, for Runner's own tests: discovery, the pairing redeem, the plugin's
 * registration and capability execution, with the inbox and task listing Runner reads. It checks every JWT's signature,
 * type, audience and expiry the way the real one does, and lets a test script failures. The real gateway and API are
 * apps/gateway/test/runner-core.spec.ts.
 */
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

export class FakeGateway {
  /** The real gateway's code refusal shape, `{ error: { code } }`. */
  redeemScript: Scripted[] = [];
  registerScript: Scripted[] = [];
  executeScript: Scripted[] = [];
  proofs: Jwt[] = [];
  agentJwts: Jwt[] = [];
  registrations: { capabilities: string[]; name: string }[] = [];
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
      this.registrations.push({ capabilities: body.capabilities as string[], name: body.name as string });
      const pending = this.registerStatus === "pending";
      return Response.json({ agent_id: this.pluginAgent, host_id: this.hostId, name: body.name, mode: "delegated", status: this.registerStatus, agent_capability_grants: (body.capabilities as string[]).map((capability) => ({ capability, status: pending ? "pending" : "active" })), ...(pending ? { approval: { method: "device_authorization", user_code: "ABCD", verification_uri: `${ORIGIN}/claim`, expires_in: 600, interval: 5 } } : {}) });
    }

    if (url.pathname === "/api/auth/capability/execute") {
      const capability = String(body.capability);
      const args = (body.arguments ?? {}) as Record<string, unknown>;
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
      return Response.json({ data: this.answer(capability, args) });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }) as typeof fetch;

  private answer(capability: string, args: Record<string, unknown>): unknown {
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
