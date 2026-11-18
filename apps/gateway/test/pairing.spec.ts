// Runner pairing, the gateway's routes (M7 step 5(b); decision 222). The person's start, read, cancel and activate
// on their session, and Runner's redeem with a host JWT signed by the key it binds, against the real API build. Runner's
// side uses the pinned client, `@auth/agent` 0.6.2, for its key, its proof and its later connection.
import { AgentAuthClient, generateKeypair, MemoryStorage, signHostJWT, type Keypair } from "@auth/agent";
import { env, SELF } from "cloudflare:test";
import { SignJWT, importJWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { confirmEnrollment, settleSession, START_PER_MINUTE, strictLimit, REDEEM_PER_MINUTE, RUNNER_CAPABILITIES } from "../src/pairing";

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
  it("pairs a machine end to end with the pinned client: start, redeem, activate, then a connection Podster still holds unclaimed", async () => {
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
    expect([seen.body.status, seen.body.key_thumbprint]).toEqual(["redeemed", key.publicKey.kid]);
    const done = await activate(person, agent, key.publicKey.kid as string);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("activated");
    expect(done.body.connection).toMatchObject({ id: agent, generation: 1 });

    // Runner, holding only its key, connects an agent on that host. The plugin takes it at once; Podster refuses it as
    // unclaimed until step 5(c) links it.
    const storage = new MemoryStorage();
    await storage.setHostIdentity({ keypair: key, createdAt: Date.now() });
    const client = new AgentAuthClient({ storage, urls: [BASE], fetch: (input, init) => SELF.fetch(new Request(input as RequestInfo, init)), hostName: "runner" });
    await client.init();
    const connected = await client.connectAgent({ provider: BASE, capabilities: ["get_identity"], mode: "delegated", preferredMethod: "device_authorization", name: "Paired runner" });
    expect(connected.status).toBe("active");
    const refused = await client.executeCapability({ agentId: connected.agentId, capability: "get_identity", arguments: {} }).catch((error) => error);
    expect(refused.status).toBe(403);
    client.destroy();

    // Logs carry IDs only: never the code, the proof or a key.
    const all = logged.join("\n");
    for (const secret of [code, jwt, key.publicKey.x as string, key.privateKey.d as string]) expect(all).not.toContain(secret);
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
      expect(Object.keys(entry).every((k) => ["at", "agent", "outcome"].includes(k))).toBe(true);
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
