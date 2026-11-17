// Spike A, part 2: does RUNNER.md's pairing proposal (Podster starts it, a code is entered in Runner, Runner's locally
// generated public key is bound) fit the pinned plugin? The plugin has a flow of that shape: a signed-in person creates a
// host with no key and gets a one-time enrollment token (/host/create), and the device sends the token with its public
// key (/host/enroll). Both are private on the gateway today. This probes what they do, calling the plugin's own server API
// the way a reviewed gateway route would, and the SDK's enrollHost for the device side. Throwaway; nothing builds on it.
import { AgentAuthClient, generateKeypair, MemoryStorage } from "@auth/agent";
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth, type Env } from "../../apps/gateway/src/index";

const BASE = "https://gateway.test";
const e = env as unknown as Env & { API_DB: D1Database; TEST_DIRECTORY_SCHEMA: string; TEST_AUTH_SCHEMA: string; TEST_API_SCHEMA: string };
const statements = (sql: string) => sql.split(";").map((s) => s.trim()).filter(Boolean);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(BASE + path, { method: "POST", redirect: "manual", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, ...headers } });

beforeAll(async () => {
  for (const sql of statements(e.TEST_AUTH_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_DIRECTORY_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_API_SCHEMA)) await e.API_DB.prepare(sql).run();
});

let n = 0;
async function person() {
  const res = await post("/api/auth/sign-up/email", { email: `pair-${++n}-${crypto.randomUUID().slice(0, 8)}@example.test`, password: "local-test-password-123", name: "Pairing owner" });
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const orgs = await (await SELF.fetch(`${BASE}/api/orgs`, { headers: { cookie } })).json<any>();
  return { cookie, org: orgs.organizations[0].id as string };
}

/** What a gateway route would do on the person's signed-in request: the plugin's createHost with no key. */
const startPairing = async (cookie: string, capabilities = ["get_identity", "read_inbox"]) =>
  createAuth(e).api.createHost({ headers: new Headers({ cookie }), body: { name: "Runner on a laptop", default_capabilities: capabilities } }) as Promise<any>;

/**
 * The device's side. The public gateway answers 404 for /host/enroll, so this stands in for a gateway route that passes the
 * request to the plugin; everything else goes to the real gateway as it is.
 */
const deviceFetch: typeof fetch = async (input, init) => {
  const request = new Request(input as RequestInfo, init);
  if (new URL(request.url).pathname === "/api/auth/host/enroll") return createAuth(e).handler(request);
  return SELF.fetch(request);
};
const runnerClient = () => new AgentAuthClient({ storage: new MemoryStorage(), urls: [BASE], fetch: deviceFetch, hostName: "spike-runner" });

describe("today's gateway", () => {
  it("keeps the plugin's enrollment, rotation and revoke routes private", async () => {
    const answers: Record<string, number> = {};
    for (const path of ["/host/create", "/host/enroll", "/agent/rotate-key", "/host/rotate-key", "/agent/revoke", "/agent/approve-capability", "/agent/claim"]) {
      answers[path] = (await post(`/api/auth${path}`, {})).status;
    }
    console.log("private routes", JSON.stringify(answers));
    expect(Object.values(answers).every((status) => status === 404)).toBe(true);
  });

  it("doesn't advertise them in discovery", async () => {
    const config = await (await SELF.fetch(`${BASE}/.well-known/agent-configuration`)).json<any>();
    console.log("advertised endpoints", JSON.stringify(Object.keys(config.endpoints)), "issuer", config.issuer);
    expect(Object.keys(config.endpoints)).not.toContain("rotate_key");
  });
});

describe("today's claim, with a host that already has a claimed agent", () => {
  it("records what a second agent on the same host key gets", async () => {
    // The M0 path, as Runner would use it: register, a person claims with the code. Then the same host key registers
    // another agent, which is what a Runner does after a disconnect if it keeps its host key.
    const owner = await person();
    let code = "";
    const client = new AgentAuthClient({ storage: new MemoryStorage(), urls: [BASE], fetch: (i, init) => SELF.fetch(new Request(i as RequestInfo, init)), hostName: "spike-runner", onApprovalRequired: (a) => void (code = a.user_code ?? "") });
    await client.init();
    const pending = client.connectAgent({ provider: BASE, capabilities: ["get_identity", "read_inbox"], mode: "delegated", preferredMethod: "device_authorization", name: "First" });
    // Let registration land, then claim it as the person would.
    let first: any;
    for (let i = 0; i < 50 && !code; i++) await new Promise((r) => setTimeout(r, 20));
    const row = await e.DB.prepare(`SELECT id FROM agent WHERE name = 'First' ORDER BY createdAt DESC LIMIT 1`).first<{ id: string }>();
    const claimed = await post("/claim", { agent_id: row!.id, user_code: code, org_id: owner.org }, { cookie: owner.cookie });
    expect(claimed.status).toBe(200);
    first = await pending;
    expect(first.status).toBe("active");
    const host = await e.DB.prepare(`SELECT status, userId IS NOT NULL AS owned, defaultCapabilities FROM agentHost WHERE id = (SELECT hostId FROM agent WHERE id = ?)`).bind(row!.id).first<any>();
    const second = await Promise.race([
      client.connectAgent({ provider: BASE, capabilities: ["get_identity"], mode: "delegated", preferredMethod: "device_authorization", name: "Second" }),
      new Promise((r) => setTimeout(() => r({ status: "still_pending_after_2s" }), 2000)),
    ]);
    console.log("host after the first claim", JSON.stringify(host), "second agent on the same host", JSON.stringify({ status: (second as any).status }));
    client.destroy();
  });
});

describe("the plugin's own enrollment, called as a gateway route would", () => {
  it("starts in Podster: a signed-in person gets a one-time token, and nothing is active yet", async () => {
    const owner = await person();
    const started = await startPairing(owner.cookie);
    const ttlSeconds = Math.round((new Date(started.enrollmentTokenExpiresAt).getTime() - Date.now()) / 1000);
    console.log("enrollment", JSON.stringify({ status: started.status, token_length: started.enrollmentToken.length, ttl_seconds: ttlSeconds, caps: started.default_capabilities }));
    expect(started.status).toBe("pending_enrollment");
    expect(started.enrollmentToken.length).toBeGreaterThanOrEqual(43);
    const stored = await e.DB.prepare(`SELECT enrollmentTokenHash, publicKey, status FROM agentHost WHERE id = ?`).bind(started.hostId).first<any>();
    // Only a hash of the token is kept.
    expect(stored.enrollmentTokenHash).not.toBe(started.enrollmentToken);
    expect(stored.publicKey).toBe("");
  });

  it("binds the device's public key, and an agent registered on that host is active at once, but Podster refuses it as unclaimed", async () => {
    const owner = await person();
    const started = await startPairing(owner.cookie);
    const client = runnerClient();
    await client.init();
    const enrolled = await client.enrollHost({ provider: BASE, enrollmentToken: started.enrollmentToken } as any);
    console.log("enrolled", JSON.stringify(enrolled));
    expect(enrolled.status).toBe("active");
    const connected = await client.connectAgent({ provider: BASE, capabilities: ["get_identity", "read_inbox"], mode: "delegated", preferredMethod: "device_authorization", name: "Paired Runner" });
    console.log("agent on the enrolled host", JSON.stringify({ status: connected.status, grants: connected.capabilityGrants.map((g) => `${g.capability}:${g.status}`) }));
    // The plugin approves it with no person in the loop, from the host's default capabilities.
    expect(connected.status).toBe("active");
    // Podster's link from the plugin's agent to its own agent and organization is written only by /claim and consent.
    const link = await e.DB.prepare(`SELECT 1 FROM identity_link WHERE external_id = ?`).bind(connected.agentId).first();
    expect(link).toBeNull();
    const result = await client.executeCapability({ agentId: connected.agentId, capability: "read_inbox", arguments: {} }).catch((error) => error);
    console.log("read_inbox before any Podster link", JSON.stringify({ code: result.code, status: result.status, message: result.message }));
    expect(result.status).toBe(403);
    // There's no pending approval with a code. Today's /claim still links it for the same person, with any code: its
    // retry path (claimedByThisPerson) treats an active plugin agent owned by this person as a claim they started.
    const claim = await post("/claim", { agent_id: connected.agentId, user_code: "ABCD-EFGH", org_id: owner.org }, { cookie: owner.cookie });
    console.log("claim of an enrolled agent, wrong code, same person", claim.status, JSON.stringify(await claim.json()));
    expect(claim.status).toBe(200);
    const after = await client.executeCapability({ agentId: connected.agentId, capability: "read_inbox", arguments: {} });
    expect(Object.keys((after as any).data)).toContain("events");
    // Another person can't.
    const stranger = await person();
    const second = await client.connectAgent({ provider: BASE, capabilities: ["get_identity"], mode: "delegated", preferredMethod: "device_authorization", name: "Second" });
    const strangers = await post("/claim", { agent_id: second.agentId, user_code: "ABCD-EFGH", org_id: stranger.org }, { cookie: stranger.cookie });
    console.log("stranger's claim of an enrolled agent", strangers.status);
    expect(strangers.status).toBe(403);
    client.destroy();
  });

  it("takes any public key with the token: enrollment has no proof of possession", async () => {
    const owner = await person();
    const started = await startPairing(owner.cookie);
    const someoneElses = await generateKeypair();
    const res = await deviceFetch(`${BASE}/api/auth/host/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: started.enrollmentToken, public_key: someoneElses.publicKey }) });
    console.log("enroll with a key the caller doesn't hold", res.status);
    expect(res.status).toBe(200);
  });

  it("refuses a used token and an expired one", async () => {
    const owner = await person();
    const started = await startPairing(owner.cookie);
    const enroll = async (token: string) => {
      const key = await generateKeypair();
      const res = await deviceFetch(`${BASE}/api/auth/host/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, public_key: key.publicKey }) });
      return { status: res.status, code: (await res.json<any>()).code };
    };
    expect((await enroll(started.enrollmentToken)).status).toBe(200);
    const again = await enroll(started.enrollmentToken);
    const other = await startPairing(owner.cookie);
    await e.DB.prepare(`UPDATE agentHost SET enrollmentTokenExpiresAt = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), other.hostId).run();
    const expired = await enroll(other.enrollmentToken);
    const guessed = await enroll("not-a-real-token");
    console.log("refusals", JSON.stringify({ again, expired, guessed }));
    expect(again.status).toBe(401);
    expect(expired.status).toBe(401);
    expect(guessed.status).toBe(401);
  });

  it("would also bind a key the device already enrolled elsewhere for the same person, without a new token check of possession", async () => {
    // Re-enrolling an existing host key under a new token reactivates that host. Recorded, not judged: the pairing
    // proposal refuses an existing credential binding, so a Podster route would have to refuse this case itself.
    const owner = await person();
    const client = runnerClient();
    await client.init();
    await client.enrollHost({ provider: BASE, enrollmentToken: (await startPairing(owner.cookie)).enrollmentToken } as any);
    const second = await client.enrollHost({ provider: BASE, enrollmentToken: (await startPairing(owner.cookie)).enrollmentToken } as any).catch((error) => error);
    console.log("second enrollment of the same host key", JSON.stringify({ status: second.status, code: second.code, hostId: second.hostId }));
    client.destroy();
  });
});
