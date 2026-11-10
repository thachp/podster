// What the journey needs to act as people and agents: a small check harness, and clients that use only public routes,
// the real `@auth/agent` signer and the official MCP SDK. Nothing here reads a database or signs an API assertion.
import { generateKeypair, signAgentJWT, signHostJWT } from "@auth/agent";
import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";

// Longer than the gateway's own 25-second limit on the API, so its answer arrives first.
const REQUEST_TIMEOUT_MS = 60_000;

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const key = () => `e2e-${randomUUID()}`;

/** Results, in the order they ran. `gap` means the driver reached something the product doesn't do yet. */
export class Report {
  results = [];

  async check(id, title, fn) {
    try {
      const detail = await fn();
      this.#add(id, title, "pass", typeof detail === "string" ? detail : undefined);
    } catch (error) {
      this.#add(id, title, "fail", error?.message ?? String(error));
    }
  }

  gap(id, title, detail) {
    this.#add(id, title, "gap", detail);
  }

  #add(id, title, status, detail) {
    this.results.push({ id, title, status, ...(detail ? { detail } : {}) });
    const mark = { pass: "ok  ", fail: "FAIL", gap: "GAP " }[status];
    console.log(`${mark} ${id.padEnd(7)} ${title}${detail ? `\n          ${detail}` : ""}`);
  }

  counts() {
    return Object.fromEntries(["pass", "fail", "gap"].map((s) => [s, this.results.filter((r) => r.status === s).length]));
  }
}

export function ok(condition, label) {
  if (!condition) throw new Error(label);
}

export function eq(actual, expected, label) {
  const [a, b] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

/** The call was refused with one of these codes. */
export function refused(result, codes, label) {
  const allowed = [codes].flat();
  if (result.ok) throw new Error(`${label}: expected a refusal (${allowed.join(" or ")}), but it succeeded`);
  if (!allowed.includes(result.code)) throw new Error(`${label}: expected ${allowed.join(" or ")}, got ${result.code ?? `HTTP ${result.status}`}`);
}

/** Refused by the server's decision, not by an outage or a limit, which would prove nothing about the check. */
export function rejected(result, label, statuses = [400, 401, 403, 404]) {
  if (result.ok) throw new Error(`${label}: it was accepted`);
  if (!statuses.includes(result.status)) throw new Error(`${label}: expected HTTP ${statuses.join(" or ")}, got ${result.status}`);
}

export class Target {
  constructor(base, { pollMs }) {
    this.base = base.replace(/\/$/, "");
    this.pollMs = pollMs;
  }

  /** A limit that's reached waits it out, as a real client would. No run should need this for long. */
  async fetch(url, { retry = true, ...init } = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { redirect: "manual", ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      // `retry: false` returns a refusal as it is, for a caller that can't wait out the limit.
      if (response.status !== 429 || attempt >= 2 || !retry) return response;
      const wait = Math.min(Number(response.headers.get("retry-after")) || 60, 70);
      console.log(`     (rate limited, waiting ${wait}s)`);
      await sleep(wait * 1000);
    }
  }

  http(path, init = {}) {
    return this.fetch(this.base + path, init);
  }

  post(path, body, headers = {}) {
    return this.http(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: this.base, ...headers } });
  }
}

export class Person {
  constructor(target, label, cookie) {
    Object.assign(this, { target, label, cookie });
  }

  /** Signs up with a password, which the gateway allows only where BASE_URL is localhost or *.test. */
  static async signUp(target, label) {
    const res = await target.post("/api/auth/sign-up/email", { email: `${key()}@example.test`, password: `pw-${key()}`, name: label });
    ok(res.status === 200, `sign-up for ${label} answered ${res.status}. Password sign-in only works on a local target.`);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return new Person(target, label, cookie).load();
  }

  /**
   * A new test person's session cookie from staging's test sign-up. The secret goes only in this header, and a failure
   * names only the status, so neither it nor the cookie can reach the output.
   */
  static async testSessionCookie(target, label, secret) {
    const res = await target.http("/api/auth/sign-up/e2e", { method: "POST", headers: { authorization: `Bearer ${secret}` } });
    ok(res.status === 200, `test sign-up for ${label} answered ${res.status}. A 404 means it's off on this deployment, or PODSTER_E2E_SIGNUP_SECRET is wrong.`);
    return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }

  /** A session someone signed in to in their browser. */
  static fromCookie(target, label, cookie) {
    return new Person(target, label, cookie).load();
  }

  async load() {
    const orgs = await this.dash("GET", "/orgs");
    ok(orgs.ok, `${this.label}'s session wasn't accepted (HTTP ${orgs.status}). Sign in again and copy a fresh cookie.`);
    this.orgs = orgs.body.organizations;
    this.org = (this.orgs.find((o) => o.personal) ?? this.orgs[0]).id;
    this.personalOrg = this.org;
    const me = await this.dash("GET", "/v1/me");
    ok(me.ok, `${this.label}: /v1/me answered ${me.status}`);
    this.id = me.body.id;
    return this;
  }

  /**
   * Acts in a new organization from here on. A deployed run reuses the same people, and leaves rooms behind that can't be
   * deleted, so each run gets its own organization rather than reaching the limit of 20 in the personal one.
   */
  async useNewOrg(name) {
    this.org = (await this.must("POST", "/orgs", { name })).id;
    this.actingOrg = this.org;
    return this;
  }

  /** A dashboard call: `/api` + path, with this person's session, from our own origin. */
  /** `timeoutMs`, when given, bounds this one request, its 429 waits included: it isn't retried, and it's aborted after that. */
  async dash(method, path, body, { idempotencyKey, org, headers = {}, timeoutMs } = {}) {
    const hasBody = !["GET", "HEAD"].includes(method);
    const res = await this.target.http(`/api${path}`, {
      method,
      headers: {
        cookie: this.cookie,
        origin: this.target.base,
        ...(hasBody ? { "content-type": "application/json", "idempotency-key": idempotencyKey ?? key() } : {}),
        ...((org ?? this.actingOrg) ? { "x-podster-org": org ?? this.actingOrg } : {}),
        ...headers,
      },
      body: hasBody ? JSON.stringify(body ?? {}) : undefined,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs), retry: false } : {}),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { ok: res.ok, status: res.status, body: parsed, code: parsed?.error?.code };
  }

  /** The same, and it must work. */
  async must(method, path, body, options) {
    const result = await this.dash(method, path, body, options);
    ok(result.ok, `${this.label} ${method} ${path}: HTTP ${result.status} ${result.code ?? ""}`);
    return result.body;
  }

  async createRoom(name, extra = {}) {
    return (await this.must("POST", "/v1/workspaces", { name, ...extra })).id;
  }

  async policyVersion(room) {
    return (await this.must("GET", `/v1/workspaces/${room}`)).policy_version;
  }

  /** Adds this person's own organization's agent. */
  async addAgent(room, agent, role = "member") {
    return this.must("POST", `/v1/workspaces/${room}/members`, { principal_id: agent.id, kind: "agent", org_id: agent.org, role, policy_version: await this.policyVersion(room) });
  }

  async invite(room, org, extra = {}) {
    return this.must("POST", `/v1/workspaces/${room}/invitations`, { role: "guest", invited_org_id: org, ...extra, policy_version: await this.policyVersion(room) });
  }

  accept(token, org, agents, options) {
    return this.dash("POST", "/v1/invitations/accept", { token, org_id: org, agents: agents.map((a) => a.id ?? a) }, options);
  }

  async revoke(room, principal) {
    return this.must("DELETE", `/v1/workspaces/${room}/members/${principal}`, { policy_version: await this.policyVersion(room) });
  }

  /** The whole log, because a count or scan of one page would miss anything past it. */
  async audit(room) {
    const entries = [];
    let after = 0;
    for (;;) {
      const page = await this.must("GET", `/v1/workspaces/${room}/audit?after=${after}`);
      entries.push(...page.audit);
      if (!page.next_cursor) return entries;
      after = page.next_cursor;
    }
  }
}

/** Calls shared by both connection methods. Each subclass answers `{ ok, data, code }`. */
class Agent {
  calls = 0;

  async call(tool, args = {}) {
    this.calls += 1;
    return this.invoke(tool, args);
  }

  /** A command that must work, with a fresh idempotency key unless one is given. */
  async must(tool, args = {}, needsKey = true) {
    const result = await this.call(tool, needsKey ? { idempotency_key: key(), ...args } : args);
    ok(result.ok, `${this.label} ${tool}: ${result.code ?? "refused"}`);
    return result.data;
  }

  /** Sends a command, then the same one again: the retry has to give the same answer. */
  async twice(tool, args) {
    const idempotency_key = key();
    const first = await this.must(tool, { ...args, idempotency_key });
    const second = await this.must(tool, { ...args, idempotency_key });
    eq(second, first, `retrying ${tool} with the same key`);
    return first;
  }

  /** Every inbox event, without moving the cursor. */
  async inbox() {
    const events = [];
    let after = 0;
    for (;;) {
      const page = await this.must("read_inbox", { after, limit: 50 }, false);
      events.push(...page.events);
      if (page.events.length < 50) return events;
      after = page.events.at(-1).seq;
    }
  }

  /** Polls the way an agent's next session would find the event. */
  async waitFor(type, taskId, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (await this.inbox()).find((e) => e.type === type && (!taskId || e.task_id === taskId));
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${this.label}: no ${type} event arrived in ${timeoutMs / 1000}s`);
      await sleep(this.target.pollMs);
    }
  }

  async identify() {
    const me = await this.must("get_identity", {}, false);
    Object.assign(this, { id: me.id, org: me.org_id });
    return this;
  }
}

/** Hosted MCP, through the official SDK: discovery, registration, consent, tokens and tool calls. */
export class McpAgent extends Agent {
  static async connect(target, person, label, { org = person.org, linkAgent = "" } = {}) {
    const agent = new McpAgent();
    Object.assign(agent, { target, label, serverUrl: new URL(`${target.base}/mcp`), sdkFetch: (url, init) => target.fetch(url, { redirect: "follow", ...init }) });
    let authorizationUrl;
    let verifier = "";
    let client;
    let tokens;
    agent.provider = {
      redirectUrl: "https://e2e-client.invalid/cb",
      clientMetadata: { client_name: `Podster e2e: ${label}`, redirect_uris: ["https://e2e-client.invalid/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
      clientInformation: () => client,
      saveClientInformation: (info) => void (client = info),
      tokens: () => tokens,
      saveTokens: (value) => void (tokens = value),
      redirectToAuthorization: (url) => void (authorizationUrl = url),
      saveCodeVerifier: (value) => void (verifier = value),
      codeVerifier: () => verifier,
    };
    agent.accessToken = () => tokens?.access_token;
    eq(await sdkAuth(agent.provider, { serverUrl: agent.serverUrl, fetchFn: agent.sdkFetch }), "REDIRECT", "SDK discovery");
    // The consent page's form, posted with the person's session. A browser would show it first.
    const approved = await target.http("/authorize", {
      method: "POST",
      headers: { cookie: person.cookie, origin: target.base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ oauth_query: authorizationUrl.search, org_id: org, agent_name: label, link_agent_id: linkAgent }),
    });
    ok(approved.status === 302, `consent for ${label}: HTTP ${approved.status}`);
    const code = new URL(approved.headers.get("location")).searchParams.get("code");
    eq(await sdkAuth(agent.provider, { serverUrl: agent.serverUrl, authorizationCode: code, fetchFn: agent.sdkFetch }), "AUTHORIZED", "SDK token exchange");
    await agent.open();
    return agent.identify();
  }

  async open() {
    this.client = new Client({ name: "podster-e2e", version: "0.0.0" });
    await this.client.connect(new StreamableHTTPClientTransport(this.serverUrl, { authProvider: this.provider, fetch: this.sdkFetch }));
  }

  /** Ends this session and starts another with the same credential. */
  async reconnect() {
    await this.client.close();
    await this.open();
  }

  async tools() {
    return (await this.client.listTools()).tools.map((t) => t.name);
  }

  async invoke(tool, args) {
    try {
      const result = await this.client.callTool({ name: tool, arguments: args });
      const text = result.content?.[0]?.text;
      if (result.isError) return { ok: false, code: text };
      return { ok: true, data: text ? JSON.parse(text) : undefined };
    } catch (error) {
      return { ok: false, code: error?.message ?? "sdk_error" };
    }
  }

  async close() {
    await this.client?.close();
  }
}

/** Agent Auth, through the real signer: a host and agent key, a pending registration, and a person's claim. */
export class AuthAgent extends Agent {
  static async register(target, label) {
    const agent = new AuthAgent();
    Object.assign(agent, { target, label, host: await generateKeypair(), keypair: await generateKeypair() });
    const jwt = await signHostJWT({ hostKeypair: agent.host, audience: target.base, agentPublicKey: agent.keypair.publicKey, hostName: "podster-e2e" });
    const res = await target.post("/api/auth/agent/register", { name: label, mode: "delegated", capabilities: ALL_CAPABILITIES, preferred_method: "device_authorization" }, { authorization: `Bearer ${jwt}` });
    const registered = await res.json();
    ok(res.ok && registered.approval?.user_code, `registering ${label}: HTTP ${res.status} ${registered?.message ?? registered?.error?.code ?? ""}`);
    Object.assign(agent, { pluginId: registered.agent_id, userCode: registered.approval.user_code, status: registered.status });
    return agent;
  }

  static async connect(target, person, label, { org = person.org, linkAgent } = {}) {
    const agent = await AuthAgent.register(target, label);
    await agent.claim(person, { org, linkAgent });
    return agent.identify();
  }

  async claim(person, { org = person.org, linkAgent } = {}) {
    const res = await this.target.post("/claim", { agent_id: this.pluginId, user_code: this.userCode, org_id: org, name: this.label, ...(linkAgent ? { link_agent_id: linkAgent } : {}) }, { cookie: person.cookie });
    ok(res.status === 200, `claiming ${this.label}: HTTP ${res.status}`);
  }

  token(capability, overrides = {}) {
    return signAgentJWT({ agentKeypair: this.keypair, agentId: this.pluginId, audience: this.target.base, capabilities: [capability], ...overrides });
  }

  async execute(capability, args, jwt) {
    const res = await this.target.post("/api/auth/capability/execute", { capability, arguments: args }, { authorization: `Bearer ${jwt ?? (await this.token(capability))}` });
    const parsed = await res.json().catch(() => null);
    return res.ok ? { ok: true, status: res.status, data: parsed?.data ?? parsed } : { ok: false, status: res.status, code: parsed?.code ?? parsed?.message ?? parsed?.error };
  }

  invoke(tool, args) {
    return this.execute(tool, args);
  }

  /** An Agent Auth agent has no connection to end: each call stands alone. */
  async reconnect() {}

  async close() {}
}

const ALL_CAPABILITIES = ["create_upload", "get_asset_link", "list_assets", "get_identity", "list_workspaces", "get_workspace", "get_workroom_brief", "list_activity", "list_role_openings", "claim_role", "release_role", "get_plan", "set_task_plan", "create_task", "list_tasks", "get_task", "update_task", "set_reviewer", "set_requester", "assign_task", "accept_task", "decline_task", "release_task", "send_message", "list_messages", "submit_task", "request_changes", "verify_task", "cancel_task", "read_inbox", "ack_inbox", "set_wake", "delete_wake", "discover_workrooms", "get_public_workroom", "claim_public_opening"];

/**
 * OAuth to `/a2a` with the MCP SDK's generic flow, since the A2A SDK runs none: discovery from the 401, registration, PKCE
 * and `resource`. The consent links this new client to `agent`, so its token acts as that agent.
 */
export async function linkedA2aToken(target, owner, agent) {
  const serverUrl = new URL(`${target.base}/a2a`);
  const sdkFetch = (url, init) => target.fetch(url, { redirect: "follow", ...init });
  let authorizationUrl;
  let verifier = "";
  let client;
  let tokens;
  const provider = {
    redirectUrl: "https://e2e-client.invalid/cb",
    clientMetadata: { client_name: `Podster e2e A2A: ${agent.label}`, redirect_uris: ["https://e2e-client.invalid/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
    clientInformation: () => client,
    saveClientInformation: (info) => void (client = info),
    tokens: () => tokens,
    saveTokens: (value) => void (tokens = value),
    redirectToAuthorization: (url) => void (authorizationUrl = url),
    saveCodeVerifier: (value) => void (verifier = value),
    codeVerifier: () => verifier,
  };
  ok((await sdkAuth(provider, { serverUrl, fetchFn: sdkFetch })) === "REDIRECT", "A2A discovery from the 401");
  ok(authorizationUrl.searchParams.get("resource") === serverUrl.href, `the authorize URL names ${serverUrl.href}`);
  const approved = await target.http("/authorize", {
    method: "POST",
    headers: { cookie: owner.cookie, origin: target.base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ oauth_query: authorizationUrl.search, org_id: owner.org, agent_name: agent.label, link_agent_id: agent.id }),
  });
  ok(approved.status === 302, `A2A consent for ${agent.label}: HTTP ${approved.status}`);
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  ok((await sdkAuth(provider, { serverUrl, authorizationCode: code, fetchFn: sdkFetch })) === "AUTHORIZED", "A2A token exchange");
  return tokens.access_token;
}
