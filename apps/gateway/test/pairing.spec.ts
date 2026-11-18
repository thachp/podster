// Runner pairing, the gateway's routes (M7 step 5(b); decision 222). The person's start, read, cancel and activate
// on their session, and Runner's redeem with a host JWT signed by the key it binds, against the real API build. Runner's
// side uses the pinned client, `@auth/agent` 0.6.2, for its key, its proof and its later connection.
import { AgentAuthClient, generateKeypair, MemoryStorage, signAgentJWT, signHostJWT, type Keypair } from "@auth/agent";
import { env, SELF } from "cloudflare:test";
import { SignJWT, importJWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { confirmEnrollment, pluginFacts, settleSession, START_PER_MINUTE, strictLimit, REDEEM_PER_MINUTE, RUNNER_CAPABILITIES, sweepPairings } from "../src/pairing";

const BASE = "https://gateway.test";
const e = env as unknown as Env & { API_DB: D1Database; TEST_DIRECTORY_SCHEMA: string; TEST_AUTH_SCHEMA: string; TEST_API_SCHEMA: string };
const statements = (sql: string) => sql.split(";").map((s) => s.trim()).filter(Boolean);
let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}-${crypto.randomUUID().slice(0, 8)}`;
// Each redemption comes from its own network unless a test says otherwise, so the per-network limit only counts where meant.
const network = () => `10.${(counter >> 8) & 255}.${counter++ & 255}.${Math.floor(Math.random() * 250) + 1}`;

type Person = { cookie: string; id: string; personal: string };
const call = (path: string, init: RequestInit = {}) => SELF.fetch(BASE + path, { redirect: "manual", ...init });
async function dash(who: { cookie: string }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await call(`/api${path}`, { method, headers: { cookie: who.cookie, origin: BASE, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, headers: res.headers, text };
}
async function signUp(name = "Pairing person"): Promise<Person> {
  const res = await call("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: `${unique("p")}@example.test`, password: "local-test-password-123", name }) });
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const me = await dash({ cookie }, "GET", "/v1/me");
  return { cookie, id: me.body.id, personal: me.body.org_id };
}
const start = (who: Person, body: unknown = {}, headers: Record<string, string> = {}) => dash(who, "POST", "/pairing", body, headers);
const read = (who: Person, agent: string) => dash(who, "GET", `/pairing/${agent}`);
const activate = (who: Person, agent: string, thumbprint: string) => dash(who, "POST", `/pairing/${agent}/activate`, { key_thumbprint: thumbprint });
const host = (id: string) => e.DB.prepare(`SELECT id, userId, status, kid, publicKey, enrollmentTokenHash, defaultCapabilities FROM agentHost WHERE id = ?`).bind(id).first<any>();

/** Runner's proof: a host JWT signed by its key, naming the session's agent as its subject and the gateway as its audience. */
const proof = (key: Keypair, agent: string, more: Record<string, unknown> = {}) => signHostJWT({ hostKeypair: key, audience: BASE, issuer: agent, ...more } as never);
async function redeem(agent: string, code: unknown, jwt: string | null, ip = network()) {
  const res = await call(`/pairing/${agent}/redeem`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(jwt === null ? {} : { authorization: `Bearer ${jwt}` }) }, body: JSON.stringify({ code }) });
  const parsed = await res.json<any>();
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}
/** Runner, holding only its key, registers its one agent on the session's host with the pinned client. */
async function runnerAgent(key: Keypair, capabilities: string[] = ["get_identity", "list_workspaces"], name = "Paired runner") {
  const storage = new MemoryStorage();
  await storage.setHostIdentity({ keypair: key, createdAt: Date.now() });
  const client = new AgentAuthClient({ storage, urls: [BASE], fetch: (input, init) => SELF.fetch(new Request(input as RequestInfo, init)), hostName: "runner" });
  await client.init();
  const connected = await client.connectAgent({ provider: BASE, capabilities, mode: "delegated", preferredMethod: "device_authorization", name });
  return { client, connected, storage };
}

async function started(who?: Person) {
  const person = who ?? (await signUp());
  const res = await start(person, { name: "Laptop runner" });
  expect(res.status).toBe(200);
  return { person, agent: res.body.agent_id as string, code: res.body.code as string, hostId: res.body.plugin_host_id as string, body: res.body };
}

beforeAll(async () => {
  for (const sql of statements(e.TEST_AUTH_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_DIRECTORY_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_API_SCHEMA)) await e.API_DB.prepare(sql).run();
});
afterEach(() => vi.restoreAllMocks());

describe("starting a pairing, on the person's session", () => {
  it("makes a plugin host with no key and Runner's allowlist, and answers the agent and the code in the body only", async () => {
    const person = await signUp();
    const res = await start(person, { name: "Laptop runner" });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toMatchObject({ org_id: person.personal, name: "Laptop runner", status: "pending", key_thumbprint: null });
    expect(res.body.agent_id).toMatch(/^agt_[0-9a-f]{32}$/);
    expect(res.body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await host(res.body.plugin_host_id);
    expect(stored).toMatchObject({ userId: person.id.slice("per_".length), status: "pending_enrollment", publicKey: "" });
    // Only the plugin's hash of the code is kept, and the session's read never answers it.
    expect(stored.enrollmentTokenHash).not.toBe(res.body.code);
    expect(JSON.parse(stored.defaultCapabilities).sort()).toEqual([...RUNNER_CAPABILITIES].sort());
    // Decision 230, ruled 2026-11-18 (L1): no merge, release or repository token until step 10's own rules.
    for (const withheld of ["merge_task", "deploy_release", "get_repo_access"]) {
      expect(RUNNER_CAPABILITIES as readonly string[]).not.toContain(withheld);
      expect(JSON.parse(stored.defaultCapabilities)).not.toContain(withheld);
    }
    const again = await read(person, res.body.agent_id);
    expect(again.status).toBe(200);
    expect(again.text).not.toContain(res.body.code);
  });

  it("takes the organization, host and code only from the server, never from the body", async () => {
    const person = await signUp();
    const before = (await e.DB.prepare(`SELECT count(*) AS n FROM agentHost WHERE userId = ?`).bind(person.id.slice(4)).first<{ n: number }>())!.n;
    for (const body of [{ org_id: person.personal }, { code: "A".repeat(43) }, { plugin_host_id: "host_1" }, { name: 7 }, [], "not json"]) {
      const res = await start(person, body);
      expect([res.status, res.code]).toEqual([400, "invalid_argument"]);
    }
    const after = (await e.DB.prepare(`SELECT count(*) AS n FROM agentHost WHERE userId = ?`).bind(person.id.slice(4)).first<{ n: number }>())!.n;
    expect(after).toBe(before);
  });

  it("needs a session and our own origin", async () => {
    const person = await signUp();
    expect((await dash({ cookie: "" }, "POST", "/pairing", {})).status).toBe(401);
    const foreign = await call("/api/pairing", { method: "POST", headers: { cookie: person.cookie, origin: "https://evil.test", "content-type": "application/json" }, body: "{}" });
    expect(foreign.status).toBe(403);
  });

  it("limits each person's starts before any plugin host is made, and refuses when it can't count", async () => {
    const person = await signUp();
    const hosts = async () => (await e.DB.prepare(`SELECT count(*) AS n FROM agentHost WHERE userId = ?`).bind(person.id.slice(4)).first<{ n: number }>())!.n;
    for (let i = 0; i < START_PER_MINUTE; i++) expect((await start(person)).status).not.toBe(429);
    const before = await hosts();
    expect(await start(person)).toMatchObject({ status: 429, code: "rate_limited" });
    expect(await hosts()).toBe(before);
    const broken = { idFromName: (name: string) => name, get: () => ({ take: async () => { throw new Error("down"); } }) };
    expect((await strictLimit(broken as never, "pairing-start:per_x", 1, 1))?.status).toBe(503);
  });

  it("lets the API decide who may start, and leaves no usable plugin host behind a refusal", async () => {
    const admin = await signUp();
    const org = (await dash(admin, "POST", "/orgs", { name: "Acme" })).body.id as string;
    const member = await signUp();
    const invitation = (await dash(admin, "POST", `/orgs/${org}/invitations`, { role: "member" })).body.token;
    expect((await dash(member, "POST", "/org-invitations/accept", { token: invitation })).status).toBe(200);
    const refused = await start(member, {}, { "x-podster-org": org });
    expect([refused.status, refused.code]).toEqual([403, "not_allowed"]);
    expect(refused.text).not.toMatch(/"code":"[A-Za-z0-9_-]{43}"/);
    const pending = await e.DB.prepare(`SELECT count(*) AS n FROM agentHost WHERE userId = ? AND (status = 'pending_enrollment' OR enrollmentTokenHash IS NOT NULL)`).bind(member.id.slice(4)).first<{ n: number }>();
    expect(pending!.n).toBe(0);
  });

  it("keeps the dashboard's passthrough closed to every pairing operation", async () => {
    const { person, agent } = await started();
    expect((await dash(person, "GET", `/v1/pairing/${agent}`)).status).toBe(404);
    expect((await dash(person, "POST", "/v1/pairing", {})).status).toBe(404);
    expect((await dash(person, "POST", `/v1/pairing/${agent}/activate`, { key_thumbprint: "A".repeat(43) })).status).toBe(404);
  });
});

describe("the person's read, cancel and activate", () => {
  it("are the starter's alone", async () => {
    const { agent } = await started();
    const stranger = await signUp();
    expect((await read(stranger, agent)).status).toBe(404);
    expect((await dash(stranger, "POST", `/pairing/${agent}/cancel`, {})).status).toBe(404);
    expect((await activate(stranger, agent, "A".repeat(43))).status).toBe(404);
  });

  it("cancel after a redeem revokes the session's plugin host and its agents, so the key can pair again", async () => {
    const { person, agent, code, hostId } = await started();
    const key = await generateKeypair();
    expect((await redeem(agent, code, await proof(key, agent))).status).toBe(200);
    const storage = new MemoryStorage();
    await storage.setHostIdentity({ keypair: key, createdAt: Date.now() });
    const client = new AgentAuthClient({ storage, urls: [BASE], fetch: (input, init) => SELF.fetch(new Request(input as RequestInfo, init)), hostName: "runner" });
    await client.init();
    const connected = await client.connectAgent({ provider: BASE, capabilities: ["get_identity"], mode: "delegated", preferredMethod: "device_authorization", name: "Before cancel" });
    client.destroy();
    const canceled = await dash(person, "POST", `/pairing/${agent}/cancel`, {});
    expect([canceled.status, canceled.body.status]).toEqual([200, "canceled"]);
    expect(await host(hostId)).toMatchObject({ status: "revoked", kid: null, publicKey: "" });
    const active = await e.DB.prepare(`SELECT count(*) AS n FROM agentHost WHERE kid = ? AND status = 'active'`).bind(key.publicKey.kid).first<{ n: number }>();
    expect(active!.n).toBe(0);
    expect(await e.DB.prepare(`SELECT status, kid FROM agent WHERE id = ?`).bind(connected.agentId).first()).toEqual({ status: "revoked", kid: null });
    const next = await started(person);
    expect((await redeem(next.agent, next.code, await proof(key, next.agent))).status).toBe(200);
    expect((await host(next.hostId))!.status).toBe("active");
  });

  it("revokes a redeemed session's host when a touch finds the session expired, and retires a waiting one", async () => {
    const { agent, code, hostId } = await started();
    const key = await generateKeypair();
    expect((await redeem(agent, code, await proof(key, agent))).status).toBe(200);
    // The session's expiry is the API's clock, so its read is given here as the person's touch would see it.
    await settleSession(e, { status: "expired", plugin_host_id: hostId, key_thumbprint: key.publicKey.kid });
    expect(await host(hostId)).toMatchObject({ status: "revoked", kid: null });
    const waiting = await started();
    await settleSession(e, { status: "expired", plugin_host_id: waiting.hostId, key_thumbprint: null });
    expect(await host(waiting.hostId)).toMatchObject({ status: "rejected", enrollmentTokenHash: null });
    // A live session's host is left alone, and a thumbprint that isn't the host's revokes nothing.
    const live = await started();
    const other = await generateKeypair();
    expect((await redeem(live.agent, live.code, await proof(other, live.agent))).status).toBe(200);
    await settleSession(e, { status: "redeemed", plugin_host_id: live.hostId, key_thumbprint: other.publicKey.kid });
    await settleSession(e, { status: "expired", plugin_host_id: live.hostId, key_thumbprint: key.publicKey.kid });
    expect((await host(live.hostId))!.status).toBe("active");
  });

  it("cancel ends the session and the plugin host that was waiting for it, so the code redeems nothing", async () => {
    const { person, agent, code, hostId } = await started();
    const canceled = await dash(person, "POST", `/pairing/${agent}/cancel`, {});
    expect([canceled.status, canceled.body.status]).toEqual([200, "canceled"]);
    expect((await host(hostId))).toMatchObject({ status: "rejected", enrollmentTokenHash: null });
    const key = await generateKeypair();
    expect((await redeem(agent, code, await proof(key, agent))).status).toBe(403);
  });

  it("activate sends only the thumbprint, and refuses a malformed one before the API", async () => {
    const { person, agent } = await started();
    for (const body of [{ key_thumbprint: "short" }, { key_thumbprint: "A".repeat(43), org_id: "x" }, {}]) {
      const res = await dash(person, "POST", `/pairing/${agent}/activate`, body);
      expect([res.status, res.code]).toEqual([400, "invalid_argument"]);
    }
    expect((await dash(person, "GET", `/pairing/${agent}/activate`)).status).toBe(404);
    expect((await dash(person, "GET", "/pairing/not..an..id")).status).toBe(404);
  });
});

describe("Runner's redeem", () => {
  it("pairs a machine end to end with the pinned client: start, redeem, register, confirm, then the linked agent acts within Runner's allowlist", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    const { person, agent, code, hostId } = await started();
    const key = await generateKeypair();
    const jwt = await proof(key, agent);
    const redeemed = await redeem(agent, code, jwt);
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toMatchObject({ agent_id: agent, status: "redeemed", key_thumbprint: key.publicKey.kid });
    // The plugin's host now holds the key, by its thumbprint.
    expect(await host(hostId)).toMatchObject({ status: "active", kid: key.publicKey.kid, enrollmentTokenHash: null });
    const seen = await read(person, agent);
    expect([seen.body.status, seen.body.key_thumbprint, seen.body.runner_ready]).toEqual(["redeemed", key.publicKey.kid, false]);

    // Runner, holding only its key, registers one agent on that host. The plugin takes it at once; Podster refuses it as
    // unclaimed until the person confirms.
    const { client, connected, storage } = await runnerAgent(key);
    expect(connected.status).toBe("active");
    const unclaimed = await client.executeCapability({ agentId: connected.agentId, capability: "get_identity", arguments: {} }).catch((error) => error);
    expect(unclaimed.status).toBe(403);
    expect((await read(person, agent)).body.runner_ready).toBe(true);

    const done = await activate(person, agent, key.publicKey.kid as string);
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ status: "activated", plugin_agent_id: connected.agentId, connection: { id: agent, generation: 1 } });
    // Visible in its organization's directory, linked by the starter.
    const listed = await dash(person, "GET", "/agents");
    expect(listed.body.agents.map((a: any) => a.id)).toContain(agent);
    expect(await e.DB.prepare(`SELECT agent_id, person_id FROM identity_link WHERE provider = 'agent_auth' AND external_id = ?`).bind(connected.agentId).first()).toEqual({ agent_id: agent, person_id: person.id });
    expect((await dash(person, "GET", `/agents/${agent}`)).body).toMatchObject({ id: agent, status: "active" });

    // Now it acts as the paired agent, within Runner's allowlist and nothing more.
    const identity = await client.executeCapability({ agentId: connected.agentId, capability: "get_identity", arguments: {} });
    expect((identity as any).data ?? identity).toMatchObject({ id: agent, org_id: person.personal });
    expect((await client.executeCapability({ agentId: connected.agentId, capability: "list_workspaces", arguments: {} }).catch((error) => error)) instanceof Error).toBe(false);
    // A capability outside the allowlist was never granted, so the plugin refuses it before Podster is asked.
    const agentKeypair = (await storage.getAgentConnection(connected.agentId))!.agentKeypair;
    const outsideJwt = await signAgentJWT({ agentKeypair, agentId: connected.agentId, audience: BASE, capabilities: ["create_task"] });
    const outside = await call("/api/auth/capability/execute", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${outsideJwt}` }, body: JSON.stringify({ capability: "create_task", arguments: { workspace_id: "ws_x", title: "x" } }) });
    const grants = await e.DB.prepare(`SELECT capability FROM agentCapabilityGrant WHERE agentId = ? AND status = 'active'`).bind(connected.agentId).all<{ capability: string }>();
    expect(grants.results.map((g) => g.capability).every((c) => (RUNNER_CAPABILITIES as readonly string[]).includes(c))).toBe(true);
    expect(grants.results.map((g) => g.capability)).not.toContain("create_task");
    expect(outside.status).toBe(403);
    expect(await outside.text()).toMatch(/not_granted|grant/i);
    expect(RUNNER_CAPABILITIES as readonly string[]).not.toContain("create_task");
    client.destroy();

    // Confirming again answers the same, links nothing twice, and the sweep leaves the activated session's host alone.
    expect((await activate(person, agent, key.publicKey.kid as string)).status).toBe(200);
    expect((await e.DB.prepare(`SELECT count(*) AS n FROM identity_link WHERE agent_id = ?`).bind(agent).first<{ n: number }>())!.n).toBe(1);
    await sweepPairings(e, Date.now() + 11 * 60 * 1000);
    expect((await host(hostId))!.status).toBe("active");

    // Runner asks for more than its allowlist with a second agent on the host: it waits for an approval, and the claim that
    // would approve it is refused, because a pairing's host is linked only by its starter's confirmation (L3).
    const greedyKey = await generateKeypair();
    const greedy = await call("/api/auth/agent/register", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await signHostJWT({ hostKeypair: key, audience: BASE, agentPublicKey: greedyKey.publicKey } as never)}` }, body: JSON.stringify({ name: "Greedy", mode: "delegated", capabilities: ["get_identity", "create_task"], preferred_method: "device_authorization" }) });
    const asked = await greedy.json<any>();
    expect(greedy.status).toBe(200);
    expect(asked.status).not.toBe("active");
    expect(typeof asked.approval?.user_code).toBe("string");
    const claimed = await call("/claim", { method: "POST", headers: { cookie: person.cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ agent_id: asked.agent_id, user_code: asked.approval.user_code, org_id: person.personal }) });
    expect(claimed.status).toBe(403);
    const greedyGrants = await e.DB.prepare(`SELECT capability FROM agentCapabilityGrant WHERE agentId = ? AND status = 'active'`).bind(asked.agent_id).all<{ capability: string }>();
    expect(greedyGrants.results.map((g) => g.capability)).not.toContain("create_task");
    expect(await e.DB.prepare(`SELECT count(*) AS n FROM identity_link WHERE external_id = ?`).bind(asked.agent_id).first<{ n: number }>()).toEqual({ n: 0 });

    // Logs carry IDs only: never the code, the proof or a key.
    const all = logged.join("\n");
    for (const secret of [code, jwt, key.publicKey.x as string, key.privateKey.d as string]) expect(all).not.toContain(secret);
  });

  it("won't confirm until Runner has registered its agent, and never links an agent on a host that isn't the session's alone", async () => {
    const { person, agent, code, hostId } = await started();
    const key = await generateKeypair();
    expect((await redeem(agent, code, await proof(key, agent))).status).toBe(200);
    const early = await activate(person, agent, key.publicKey.kid as string);
    expect([early.status, early.code]).toEqual([409, "invalid_transition"]);
    expect((await read(person, agent)).body.status).toBe("redeemed");
    // Two agents on the host: never a guess at which.
    const one = await runnerAgent(key, ["get_identity"], "One");
    const two = await runnerAgent(key, ["get_identity"], "Two");
    one.client.destroy();
    two.client.destroy();
    expect((await read(person, agent)).body.runner_ready).toBe(false);
    const ambiguous = await activate(person, agent, key.publicKey.kid as string);
    expect([ambiguous.status, ambiguous.code]).toEqual([403, "not_allowed"]);
    expect((await read(person, agent)).body.status).toBe("redeemed");
    expect(await e.DB.prepare(`SELECT count(*) AS n FROM identity_link WHERE agent_id = ?`).bind(agent).first<{ n: number }>()).toEqual({ n: 0 });
    // The facts the API judges are read from the plugin's own tables: the session's host, its owner, the key it holds.
    const facts = await pluginFacts(e, hostId);
    expect(facts).toMatchObject({ host_id: hostId, host_owner: person.id, host_active: true, host_thumbprint: key.publicKey.kid, hosts_holding_key: 1 });
    expect(facts.agents).toHaveLength(2);
  });

  it("refuses another admin of the organization the confirmation, and the paired agent's connection", async () => {
    const admin = await signUp();
    const org = (await dash(admin, "POST", "/orgs", { name: "Pairs" })).body.id as string;
    const other = await signUp();
    const invitation = (await dash(admin, "POST", `/orgs/${org}/invitations`, { role: "admin" })).body.token;
    expect((await dash(other, "POST", "/org-invitations/accept", { token: invitation })).status).toBe(200);
    const res = await start(admin, { name: "Team runner" }, { "x-podster-org": org });
    expect(res.status).toBe(200);
    const agent = res.body.agent_id as string;
    const key = await generateKeypair();
    expect((await redeem(agent, res.body.code, await proof(key, agent))).status).toBe(200);
    const { client } = await runnerAgent(key);
    client.destroy();
    expect((await dash(other, "POST", `/pairing/${agent}/activate`, { key_thumbprint: key.publicKey.kid }, { "x-podster-org": org })).status).toBe(404);
    expect((await dash(admin, "POST", `/pairing/${agent}/activate`, { key_thumbprint: key.publicKey.kid }, { "x-podster-org": org })).status).toBe(200);
    // The other admin sees it in the organization, but can't take its connection through the passthrough.
    expect((await dash(other, "GET", "/agents", undefined, { "x-podster-org": org })).body.agents.map((a: any) => a.id)).toContain(agent);
    expect((await dash(other, "PUT", `/v1/agents/${agent}`, { org_id: org }, { "x-podster-org": org })).status).toBe(404);
  });

  it("answers the same again for a lost answer, on a fresh proof, without enrolling twice", async () => {
    const { agent, code, hostId } = await started();
    const key = await generateKeypair();
    expect((await redeem(agent, code, await proof(key, agent))).status).toBe(200);
    const before = await host(hostId);
    const again = await redeem(agent, code, await proof(key, agent));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ agent_id: agent, status: "redeemed", plugin_host_id: hostId, key_thumbprint: key.publicKey.kid });
    expect(await host(hostId)).toEqual(before);
  });

  it("refuses a replayed proof", async () => {
    const { agent, code } = await started();
    const key = await generateKeypair();
    const jwt = await proof(key, agent);
    expect((await redeem(agent, code, jwt)).status).toBe(200);
    expect(await redeem(agent, code, jwt)).toMatchObject({ status: 403, code: "not_allowed" });
  });

  it("refuses a proof that is missing, names another session, another audience, lives too long or comes from another key", async () => {
    const { agent, code, hostId } = await started();
    const other = (await started()).agent;
    const key = await generateKeypair();
    const attacker = await generateKeypair();
    const signed = (claims: Record<string, unknown>, signer: Keypair, header: Record<string, unknown> = { alg: "EdDSA", typ: "host+jwt" }) =>
      importJWK(signer.privateKey as never, "EdDSA").then((k) => new SignJWT(claims).setProtectedHeader(header as never).setIssuedAt().setExpirationTime("60s").setJti(crypto.randomUUID()).sign(k));
    const refusals: [string, string | null][] = [
      ["none", null],
      ["garbage", "not.a.jwt"],
      ["another session", await proof(key, other)],
      ["the plugin's default subject", await signHostJWT({ hostKeypair: key, audience: BASE })],
      ["another audience", await signHostJWT({ hostKeypair: key, audience: "https://elsewhere.test", issuer: agent } as never)],
      ["the audience in a list", await signed({ host_public_key: key.publicKey, sub: agent, aud: [BASE] }, key)],
      ["the audience among others", await signed({ host_public_key: key.publicKey, sub: agent, aud: [BASE, "https://elsewhere.test"] }, key)],
      ["longer than five minutes", await proof(key, agent, { expiresInSeconds: 600 })],
      ["a registration's agent key", await proof(key, agent, { agentPublicKey: attacker.publicKey })],
      ["someone else's key, signed by another", await signed({ host_public_key: key.publicKey, sub: agent, aud: BASE }, attacker)],
      ["a private key", await signed({ host_public_key: attacker.privateKey, sub: agent, aud: BASE }, attacker)],
      ["the wrong type", await signed({ host_public_key: key.publicKey, sub: agent, aud: BASE }, key, { alg: "EdDSA", typ: "agent+jwt" })],
      ["no key", await signed({ sub: agent, aud: BASE }, key)],
    ];
    for (const [why, jwt] of refusals) {
      const res = await redeem(agent, code, jwt);
      expect([why, res.status]).toEqual([why, why === "a private key" ? 400 : 401]);
    }
    // Nothing was bound or enrolled by any of them.
    expect((await host(hostId))!.status).toBe("pending_enrollment");
  });

  it("after enrolling, refuses unless exactly the session's host holds the key, revoking what holds it and canceling the session", async () => {
    const { person, agent, code, hostId } = await started();
    const key = await generateKeypair();
    expect((await redeem(agent, code, await proof(key, agent))).status).toBe(200);
    const held = { jwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: key.publicKey.x as string }, thumbprint: key.publicKey.kid as string };
    expect(await confirmEnrollment(e, held, hostId, agent)).toBeNull();
    // A second host holding the same key, as a race of two sessions would leave it.
    const rogue = `rogue${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    await e.DB.prepare(`INSERT INTO agentHost (id, name, userId, defaultCapabilities, publicKey, kid, status, createdAt, updatedAt) VALUES (?, 'r', NULL, '[]', ?, ?, 'active', ?, ?)`).bind(rogue, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: held.jwk.x, kid: held.thumbprint }), held.thumbprint, now, now).run();
    const refused = await confirmEnrollment(e, held, hostId, agent);
    expect(refused?.status).toBe(403);
    expect(await host(hostId)).toMatchObject({ status: "revoked", kid: null });
    expect(await host(rogue)).toMatchObject({ status: "revoked", kid: null });
    const seen = await read(person, agent);
    expect(seen.body.status).toBe("canceled");
    expect((await activate(person, agent, held.thumbprint)).status).toBe(409);
  });

  it("refuses a key already enrolled on a host, and leaves the session and its host waiting", async () => {
    const key = await generateKeypair();
    const first = await started();
    expect((await redeem(first.agent, first.code, await proof(key, first.agent))).status).toBe(200);
    const second = await started();
    expect(await redeem(second.agent, second.code, await proof(key, second.agent))).toMatchObject({ status: 403, code: "not_allowed" });
    const seen = await read(second.person, second.agent);
    expect([seen.body.status, seen.body.key_thumbprint]).toEqual(["pending", null]);
    expect((await host(second.hostId))!.status).toBe("pending_enrollment");
    expect((await host(first.hostId))!.status).toBe("active");
  });

  it("refuses a key a registration already put on a host of its own", async () => {
    const key = await generateKeypair();
    const agentKey = await generateKeypair();
    const registered = await call("/api/auth/agent/register", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await signHostJWT({ hostKeypair: key, audience: BASE, agentPublicKey: agentKey.publicKey, hostName: "h" } as never)}` }, body: JSON.stringify({ name: "x", mode: "delegated", capabilities: ["get_identity"], preferred_method: "device_authorization" }) });
    expect(registered.status).toBe(200);
    const { agent, code, hostId } = await started();
    expect(await redeem(agent, code, await proof(key, agent))).toMatchObject({ status: 403, code: "not_allowed" });
    expect((await host(hostId))!.status).toBe("pending_enrollment");
  });

  it("passes a wrong code to the API, which counts it, and enrolls nothing", async () => {
    const { person, agent, code, hostId } = await started();
    const key = await generateKeypair();
    const wrong = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
    expect(await redeem(agent, wrong, await proof(key, agent))).toMatchObject({ status: 403, code: "not_allowed" });
    expect((await read(person, agent)).body.attempts_left).toBe(4);
    expect((await host(hostId))!.status).toBe("pending_enrollment");
    expect(await redeem(agent, 12, await proof(key, agent))).toMatchObject({ status: 400, code: "invalid_argument" });
  });

  it("limits each network, and refuses when its limiter can't count", async () => {
    const ip = network();
    const agent = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    for (let i = 0; i < REDEEM_PER_MINUTE; i++) expect((await redeem(agent, "x", null, ip)).status).toBe(401);
    expect(await redeem(agent, "x", null, ip)).toMatchObject({ status: 429, code: "rate_limited" });
    expect((await redeem(agent, "x", null, network())).status).toBe(401);
    const broken = { idFromName: (name: string) => name, get: () => ({ take: async () => { throw new Error("down"); } }) };
    const refused = await strictLimit(broken as never, "pairing-redeem:203.0.113.9", REDEEM_PER_MINUTE, 100);
    expect(refused?.status).toBe(503);
    const nonsense = { idFromName: (name: string) => name, get: () => ({ take: async () => Number.NaN }) };
    expect((await strictLimit(nonsense as never, "pairing-redeem:203.0.113.9", REDEEM_PER_MINUTE, 100))?.status).toBe(503);
  });

  it("logs IDs and fixed outcomes only on every refusal path", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    const secrets: string[] = [];
    const key = await generateKeypair();
    secrets.push(key.publicKey.x as string, key.privateKey.d as string);
    // Bad proof, bad body, wrong code, an enrolled key, a replay, a refused start, the limiters.
    const one = await started();
    secrets.push(one.code);
    const bad = await proof(key, "agt_other");
    secrets.push(bad);
    await redeem(one.agent, one.code, bad);
    const good = await proof(key, one.agent);
    secrets.push(good);
    await redeem(one.agent, 12, good);
    const wrong = one.code.slice(0, -1) + (one.code.endsWith("A") ? "B" : "A");
    secrets.push(wrong);
    const proofWrong = await proof(key, one.agent);
    secrets.push(proofWrong);
    await redeem(one.agent, wrong, proofWrong);
    const fine = await proof(key, one.agent);
    secrets.push(fine);
    expect((await redeem(one.agent, one.code, fine)).status).toBe(200);
    await redeem(one.agent, one.code, fine);
    const two = await started();
    secrets.push(two.code);
    const enrolled = await proof(key, two.agent);
    secrets.push(enrolled);
    expect((await redeem(two.agent, two.code, enrolled)).status).toBe(403);
    const admin = await signUp();
    const org = (await dash(admin, "POST", "/orgs", { name: "Logs" })).body.id as string;
    const member = await signUp();
    const invitation = (await dash(admin, "POST", `/orgs/${org}/invitations`, { role: "member" })).body.token;
    await dash(member, "POST", "/org-invitations/accept", { token: invitation });
    secrets.push(invitation);
    expect((await start(member, {}, { "x-podster-org": org })).status).toBe(403);
    const broken = { idFromName: (name: string) => name, get: () => ({ take: async () => { throw new Error("down"); } }) };
    await strictLimit(broken as never, "pairing-redeem:203.0.113.1", 1, 1);
    const all = logged.join("\n");
    for (const secret of secrets) expect(all).not.toContain(secret);
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    // Each pairing line is JSON naming only where, which agent, and a fixed outcome.
    const ours = logged.filter((line) => line.includes("pairing."));
    expect(ours.length).toBeGreaterThan(0);
    for (const line of ours) {
      const entry = JSON.parse(line);
      expect(Object.keys(entry).every((k) => ["at", "agent", "plugin_agent", "person", "outcome"].includes(k))).toBe(true);
      expect(entry.outcome).toMatch(/^[a-z_]+$/);
      if (entry.agent !== undefined) expect(entry.agent).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    }
  });

  it("is only on the gateway's own path, for POST", async () => {
    const { agent, code } = await started();
    const key = await generateKeypair();
    const res = await call(`/pairing/${agent}/redeem`, { method: "GET", headers: { authorization: `Bearer ${await proof(key, agent)}`, "cf-connecting-ip": network() } });
    expect(res.status).toBe(404);
    expect((await call(`/api/pairing/${agent}/redeem`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await proof(key, agent)}` }, body: JSON.stringify({ code }) })).status).toBe(401);
  });
});

describe("finishing the link (step 5(c), M2 and L3 on #453)", () => {
  async function readyToConfirm(capabilities?: string[]) {
    const { person, agent, code, hostId } = await started();
    const key = await generateKeypair();
    expect((await redeem(agent, code, await proof(key, agent))).status).toBe(200);
    const { client, connected } = await runnerAgent(key, capabilities);
    client.destroy();
    return { person, agent, hostId, key, pluginAgent: connected.agentId };
  }

  it("finishes a link whose directory write failed, on the starter's next read", async () => {
    const { person, agent, key } = await readyToConfirm();
    await e.DB.prepare(`ALTER TABLE podster_agent RENAME TO podster_agent_away`).run();
    let done: Awaited<ReturnType<typeof activate>>;
    try {
      done = await activate(person, agent, key.publicKey.kid as string);
    } finally {
      await e.DB.prepare(`ALTER TABLE podster_agent_away RENAME TO podster_agent`).run();
    }
    expect([done.status, done.body.status, done.body.connected]).toEqual([200, "activated", false]);
    expect((await dash(person, "GET", "/agents")).body.agents.map((a: any) => a.id)).not.toContain(agent);
    const again = await read(person, agent);
    expect([again.status, again.body.connected]).toEqual([200, true]);
    expect((await dash(person, "GET", "/agents")).body.agents.map((a: any) => a.id)).toContain(agent);
  });

  it("refuses with fixed words, and leaves the session, when the plugin agent is already linked elsewhere", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    const { person, agent, key, pluginAgent } = await readyToConfirm();
    await e.DB.prepare(`INSERT INTO identity_link (provider, external_id, agent_id, person_id, created_at) VALUES ('agent_auth', ?, 'agt_elsewhere', ?, ?)`).bind(pluginAgent, person.id, Date.now()).run();
    const done = await activate(person, agent, key.publicKey.kid as string);
    expect([done.status, done.code]).toEqual([409, "already_linked"]);
    const seen = await read(person, agent);
    expect([seen.body.status, seen.body.connected, seen.body.link_problem]).toEqual(["activated", false, "already_linked"]);
    expect(logged.map((l) => JSON.parse(l)).filter((l) => l.outcome === "linked_elsewhere")).toContainEqual({ at: "pairing.link", agent, plugin_agent: pluginAgent, outcome: "linked_elsewhere" });
  });

  it("never links Runner's agent that asked for more than the allowlist: it isn't active, so the binding rule refuses it", async () => {
    const { person, agent, key } = await started().then(async (s) => {
      const key = await generateKeypair();
      expect((await redeem(s.agent, s.code, await proof(key, s.agent))).status).toBe(200);
      return { ...s, key };
    });
    const agentKey = await generateKeypair();
    const res = await call("/api/auth/agent/register", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await signHostJWT({ hostKeypair: key, audience: BASE, agentPublicKey: agentKey.publicKey } as never)}` }, body: JSON.stringify({ name: "Greedy", mode: "delegated", capabilities: ["get_identity", "create_task"], preferred_method: "device_authorization" }) });
    const registered = await res.json<any>();
    expect(res.status).toBe(200);
    expect(registered.status).not.toBe("active");
    expect((await read(person, agent)).body.runner_ready).toBe(false);
    const refused = await activate(person, agent, key.publicKey.kid as string);
    expect([refused.status, refused.code]).toEqual([403, "not_allowed"]);
    expect((await read(person, agent)).body.status).toBe("redeemed");
  });
});

describe("the expiry sweep, from the cron (step 5(c))", () => {
  type Seen = { path: string; person: string; kind: string; body: string };
  /**
   * The API's sweep, as it would answer once these sessions expired: its own clock decides that, and its tests show it.
   * `answers` maps a person to their sessions, or to a status the API fails with.
   */
  function apiAnswering(answers: Record<string, Record<string, unknown>[] | number>, seen: Seen[]) {
    return {
      ...e,
      API: {
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          const claims = JSON.parse(atob((request.headers.get("x-podster-assertion") ?? "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
          seen.push({ path, person: claims.person_id, kind: claims.kind, body: await request.text() });
          const answer = answers[claims.person_id] ?? [];
          if (typeof answer === "number") return Response.json({ error: { code: "internal_error" } }, { status: answer });
          if (path === "/v1/pairing/sweep") return Response.json({ sessions: answer });
          if (path === "/v1/pairing/sweep/settled") return Response.json({ settled: 1 });
          return Response.json({ error: { code: "not_found" } }, { status: 404 });
        },
      } as unknown as Fetcher,
    };
  }
  /** Moves a session's expiry, in the gateway's own record, as time would. */
  const due = (agent: string, ago = 1000) => e.DB.prepare(`UPDATE pairing_host SET expires_at = ? WHERE agent_id = ?`).bind(Date.now() - ago, agent).run();
  const row = (agent: string) => e.DB.prepare(`SELECT person_id, linked_agent_id FROM pairing_host WHERE agent_id = ?`).bind(agent).first<any>();

  it("records each start, by Podster's own person, and drops the record when the session ends", async () => {
    const person = await signUp();
    const one = await started(person);
    expect(await row(one.agent)).toEqual({ person_id: person.id, linked_agent_id: null });
    expect((await dash(person, "POST", `/pairing/${one.agent}/cancel`, {})).status).toBe(200);
    expect(await row(one.agent)).toBeNull();
  });

  it("revokes the host of a redeemed session that expired untouched, retires a waiting one, and settles them, under the service assertion", async () => {
    const person = await signUp();
    const redeemedOne = await started(person);
    const key = await generateKeypair();
    expect((await redeem(redeemedOne.agent, redeemedOne.code, await proof(key, redeemedOne.agent))).status).toBe(200);
    const { client, connected } = await runnerAgent(key);
    client.destroy();
    const waiting = await started(person);
    const missing = await started(person);
    for (const s of [redeemedOne, waiting, missing]) await due(s.agent);
    const seen: Seen[] = [];
    const sessions = [
      { agent_id: redeemedOne.agent, plugin_host_id: redeemedOne.hostId, status: "expired", key_thumbprint: key.publicKey.kid },
      { agent_id: waiting.agent, plugin_host_id: waiting.hostId, status: "expired", key_thumbprint: null },
      { agent_id: missing.agent, plugin_host_id: missing.hostId, status: "missing", key_thumbprint: null },
    ];
    await sweepPairings(apiAnswering({ [person.id]: sessions }, seen) as never);
    expect(await host(redeemedOne.hostId)).toMatchObject({ status: "revoked", kid: null, publicKey: "" });
    expect(await e.DB.prepare(`SELECT status, kid FROM agent WHERE id = ?`).bind(connected.agentId).first()).toEqual({ status: "revoked", kid: null });
    expect(await host(waiting.hostId)).toMatchObject({ status: "rejected", enrollmentTokenHash: null });
    expect(await host(missing.hostId)).toMatchObject({ status: "rejected", enrollmentTokenHash: null });
    for (const s of [redeemedOne, waiting, missing]) expect(await row(s.agent)).toBeNull();
    const mine = seen.filter((c) => c.person === person.id);
    expect(mine.map((c) => [c.path, c.kind])).toEqual([["/v1/pairing/sweep", "pairing_sweep"], ["/v1/pairing/sweep/settled", "pairing_sweep"]]);
    expect(JSON.parse(mine[1].body).agent_ids.sort()).toEqual([redeemedOne.agent, waiting.agent, missing.agent].sort());
  });

  it("reaches every due session over runs, oldest first, whatever other hosts the plugin holds and whoever fails (M1, L2)", async () => {
    // The probe: more people than one run takes, each with an old unlinked plugin host, and their own due sessions.
    const now = Date.now();
    const answers: Record<string, Record<string, unknown>[] | number> = {};
    for (let i = 0; i < 30; i++) {
      const id = `p${crypto.randomUUID().replaceAll("-", "")}`;
      const at = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
      await e.DB.prepare(`INSERT INTO agentHost (id, name, userId, defaultCapabilities, publicKey, kid, status, createdAt, updatedAt) VALUES (?, 'old', NULL, '[]', '', NULL, 'active', ?, ?)`).bind(`h${id}`, at, at).run();
      const person = `per_probe_${i}_${id.slice(0, 8)}`;
      await e.DB.prepare(`INSERT INTO pairing_host (host_id, person_id, agent_id, expires_at) VALUES (?, ?, ?, ?)`).bind(`ph${id}`, person, `agt_${id.slice(1)}`, now - 60 * 60 * 1000 - i).run();
      // One person's sweep fails every time; it mustn't hold the others up.
      answers[person] = i === 0 ? 500 : [];
    }
    // The target: a redeemed session that expired untouched, later than all of those.
    const person = await signUp();
    const target = await started(person);
    const key = await generateKeypair();
    expect((await redeem(target.agent, target.code, await proof(key, target.agent))).status).toBe(200);
    await due(target.agent, 60_000);
    answers[person.id] = [{ agent_id: target.agent, plugin_host_id: target.hostId, status: "expired", key_thumbprint: key.publicKey.kid }];
    const seen: Seen[] = [];
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    const env = apiAnswering(answers, seen) as never;
    for (let run = 0; run < 3 && (await host(target.hostId))!.status === "active"; run++) await sweepPairings(env, now + run);
    expect(await host(target.hostId)).toMatchObject({ status: "revoked", kid: null });
    // The failing person was logged by ID and put back, and the run went on past them.
    expect(logged.map((l) => JSON.parse(l)).filter((l) => l.outcome === "failed").map((l) => Object.keys(l).sort().join())).toContain("at,outcome,person");
    expect(seen.some((c) => c.person === person.id)).toBe(true);
  });

  it("reaches a new due session within two hourly runs, however many people keep failing ahead of it (probe B)", async () => {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const answers: Record<string, Record<string, unknown>[] | number> = {};
    const failing: string[] = [];
    for (let i = 0; i < 26; i++) {
      const id = crypto.randomUUID().replaceAll("-", "");
      const person = `per_failing_${i}_${id.slice(0, 8)}`;
      await e.DB.prepare(`INSERT INTO pairing_host (host_id, person_id, agent_id, expires_at) VALUES (?, ?, ?, ?)`).bind(`fh${id}`, person, `agt_${id}`, now - 2 * hour - i).run();
      answers[person] = 500;
      failing.push(person);
    }
    const person = await signUp();
    const target = await started(person);
    const key = await generateKeypair();
    expect((await redeem(target.agent, target.code, await proof(key, target.agent))).status).toBe(200);
    await due(target.agent, 60_000);
    answers[person.id] = [{ agent_id: target.agent, plugin_host_id: target.hostId, status: "expired", key_thumbprint: key.publicKey.kid }];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const env = apiAnswering(answers, []) as never;
    // The cron's real spacing: an hour apart, a few milliseconds late.
    await sweepPairings(env, now);
    await sweepPairings(env, now + hour + 5);
    expect(await host(target.hostId)).toMatchObject({ status: "revoked", kid: null });
    // Each failure doubles a person's wait, from two hours to a day at most.
    const backoff = async (who: string) => (await e.DB.prepare(`SELECT next_sweep_at, sweep_failures FROM pairing_host WHERE person_id = ?`).bind(who).first<{ next_sweep_at: number; sweep_failures: number }>())!;
    // The oldest failed in the first run; the newest, the 26th, was still reached in the second.
    expect((await backoff(failing[0])).sweep_failures).toBe(1);
    const first = await backoff(failing[25]);
    expect(first).toEqual({ next_sweep_at: now + 2 * hour, sweep_failures: 1 });
    // Only that person, from here: everyone else waits.
    await e.DB.prepare(`UPDATE pairing_host SET next_sweep_at = ? WHERE person_id != ?`).bind(Number.MAX_SAFE_INTEGER, failing[25]).run();
    for (const [run, at] of [[2, first.next_sweep_at], [3, now + 2 * hour + 4 * hour], [4, now + 14 * hour], [5, now + 30 * hour], [6, now + 54 * hour]] as const) {
      await sweepPairings(apiAnswering({ [failing[25]]: 500 }, []) as never, at);
      const after = await backoff(failing[25]);
      expect(after.sweep_failures).toBe(run);
      expect(after.next_sweep_at - at).toBe(Math.min(2 * hour * 2 ** (run - 1), 24 * hour));
    }
  });

  it("leaves activated and live sessions' hosts alone, and settles nothing it didn't act on", async () => {
    const person = await signUp();
    const live = await started(person);
    const key = await generateKeypair();
    expect((await redeem(live.agent, live.code, await proof(key, live.agent))).status).toBe(200);
    await due(live.agent);
    const seen: Seen[] = [];
    await sweepPairings(apiAnswering({ [person.id]: [{ agent_id: live.agent, plugin_host_id: live.hostId, status: "redeemed", key_thumbprint: key.publicKey.kid }] }, seen) as never);
    expect((await host(live.hostId))!.status).toBe("active");
    expect(seen.filter((c) => c.person === person.id).map((c) => c.path)).toEqual(["/v1/pairing/sweep"]);
    // With the real API, a session that hasn't expired by its own clock isn't listed, and nothing of it ends.
    await e.DB.prepare(`UPDATE pairing_host SET next_sweep_at = 0 WHERE agent_id = ?`).bind(live.agent).run();
    await sweepPairings(e, Date.now() + 11 * 60 * 1000);
    expect((await host(live.hostId))!.status).toBe("active");
    expect(await row(live.agent)).not.toBeNull();
  });

  it("logs IDs and fixed outcomes only", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    const person = await signUp();
    const one = await started(person);
    await due(one.agent);
    await sweepPairings(apiAnswering({ [person.id]: [{ agent_id: one.agent, plugin_host_id: one.hostId, status: "expired", key_thumbprint: null }] }, []) as never);
    const lines = logged.filter((l) => l.includes("pairing.sweep")).map((l) => JSON.parse(l));
    expect(lines).toContainEqual({ at: "pairing.sweep", agent: one.agent, outcome: "expired" });
    expect(logged.join("\n")).not.toContain(one.code);
  });
});
