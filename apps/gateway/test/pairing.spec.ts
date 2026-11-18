// Runner pairing, the gateway's routes (M7 step 5(b); decision 222). The person's start, read, cancel and activate
// on their session, and Runner's redeem with a host JWT signed by the key it binds, against the real API build. Runner's
// side uses the pinned client, `@auth/agent` 0.6.2, for its key, its proof and its later connection.
import { AgentAuthClient, generateKeypair, MemoryStorage, signHostJWT, type Keypair } from "@auth/agent";
import { env, SELF } from "cloudflare:test";
import { SignJWT, importJWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { redeemLimit, REDEEM_PER_MINUTE, RUNNER_CAPABILITIES } from "../src/pairing";

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
    expect(JSON.parse(stored.defaultCapabilities).sort()).toEqual([...RUNNER_CAPABILITIES].filter((c) => c !== "get_repo_access").sort());
    expect(JSON.parse(stored.defaultCapabilities)).not.toContain("merge_task");
    expect(JSON.parse(stored.defaultCapabilities)).not.toContain("deploy_release");
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
    const refused = await redeemLimit(broken as never, "203.0.113.9");
    expect(refused?.status).toBe(503);
    const nonsense = { idFromName: (name: string) => name, get: () => ({ take: async () => Number.NaN }) };
    expect((await redeemLimit(nonsense as never, "203.0.113.9"))?.status).toBe(503);
  });

  it("is only on the gateway's own path, for POST", async () => {
    const { agent, code } = await started();
    const key = await generateKeypair();
    const res = await call(`/pairing/${agent}/redeem`, { method: "GET", headers: { authorization: `Bearer ${await proof(key, agent)}`, "cf-connecting-ip": network() } });
    expect(res.status).toBe(404);
    expect((await call(`/api/pairing/${agent}/redeem`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await proof(key, agent)}` }, body: JSON.stringify({ code }) })).status).toBe(401);
  });
});
