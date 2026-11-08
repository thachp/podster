import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// An agent's A2A endpoint (M3 step 11): set, delete and status on its Principal, the signing secret shown once, the bearer
// token sealed and write-only, the registration version, and three failures switching it off (ADR 0007, decisions 119,
// 122 and 134).

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const ORG = "org_ep";
const ADMIN: Who = { id: "per_ep_admin", kind: "person", org: ORG, adminOrgs: [ORG] };
const OTHER_ADMIN: Who = { id: "per_ep_other_admin", kind: "person", org: "org_ep_other", adminOrgs: ["org_ep_other"] };
const URL_A = "https://agent.acme.dev/a2a";
const URL_B = "https://other.acme.dev/a2a";
const TOKEN = "tok_live_abc.DEF-123";

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }) })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

async function api(who: Who, method: string, path: string, body?: unknown) {
  const res = await SELF.fetch(`https://api.internal${path}`, {
    method,
    headers: { "x-podster-assertion": await assertion(who), "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, text };
}

let counter = 0;
/** A newly registered agent of ORG, so each test starts with no endpoint. */
async function newAgent(): Promise<Who> {
  const agent: Who = { id: `agt_ep_${++counter}_${crypto.randomUUID().slice(0, 8)}`, org: ORG };
  const res = await api(ADMIN, "PUT", `/v1/agents/${agent.id}`, { org_id: ORG, name: agent.id });
  expect(res.status, res.text).toBe(200);
  return agent;
}

const stub = (agent: Who) => BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(agent.id));
const internal = async (agent: Who, path: string, body: unknown = {}) => {
  const res = await stub(agent).fetch(`https://principal.internal${path}`, { method: "POST", body: JSON.stringify(body) });
  return res.json() as Promise<any>;
};
const claim = (agent: Who) => internal(agent, "/internal/a2a-endpoint-claim");
const report = (agent: Who, version: number, ok: boolean) => internal(agent, "/internal/a2a-endpoint-report", { version, ok });
const storedRow = (agent: Who) => runInDurableObject(stub(agent), (_: any, state: any) => state.storage.sql.exec("SELECT * FROM a2a_endpoint").toArray()[0]);
const set = (agent: Who, body: unknown) => api(agent, "PUT", "/v1/inbox/a2a-endpoint", body);
const status = async (agent: Who) => (await api(agent, "GET", "/v1/inbox/a2a-endpoint")).body;

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("setting an endpoint", () => {
  it("makes version 1 and shows the signing secret once", async () => {
    const agent = await newAgent();
    const made = await set(agent, { url: URL_A });
    expect(made.status, made.text).toBe(200);
    expect(made.body).toMatchObject({ url: URL_A, version: 1, enabled: true, consecutive_failures: 0, has_token: false });
    expect(made.body.signing_secret).toMatch(/^a2asec_[0-9a-f]{64}$/);
    const read = await status(agent);
    expect(read).toMatchObject({ url: URL_A, version: 1, enabled: true, has_token: false });
    expect(read).not.toHaveProperty("signing_secret");
    const identity = await api(agent, "GET", `/v1/agents/${agent.id}`);
    expect(identity.body.a2a_endpoint).toMatchObject({ url: URL_A, version: 1 });
    expect(identity.text).not.toContain(made.body.signing_secret);
    // Setting it doesn't touch wake.
    expect(identity.body.wake).toBeNull();
  });

  it("refuses every URL wake refuses, and anything but url and token", async () => {
    const agent = await newAgent();
    for (const url of ["http://agent.acme.dev/a2a", "https://10.0.0.1/a2a", "https://agent.acme.dev:8443/a2a", "https://u:p@agent.acme.dev/a2a", "https://podster.dev/a2a", "https://localhost/a2a", "not a url"]) {
      expect((await set(agent, { url })).code, url).toBe("invalid_endpoint_url");
    }
    for (const body of [{}, { url: 7 }, { url: URL_A, extra: 1 }, { url: URL_A, token: "has space" }, { url: URL_A, token: 5 }, { url: URL_A, token: "x".repeat(4097) }, "[]"]) {
      expect((await set(agent, body)).code, JSON.stringify(body)).toBe("invalid_argument");
    }
    expect(await status(agent)).toBeNull();
  });

  it("keeps the version and secret for the same URL, and turns a switched-off endpoint back on", async () => {
    const agent = await newAgent();
    const first = await set(agent, { url: URL_A });
    for (let n = 0; n < 3; n++) await report(agent, 1, false);
    expect(await status(agent)).toMatchObject({ enabled: false, consecutive_failures: 3 });
    const again = await set(agent, { url: URL_A });
    expect(again.body).toMatchObject({ version: 1, enabled: true, consecutive_failures: 0 });
    expect(again.body).not.toHaveProperty("signing_secret");
    expect((await storedRow(agent)).signing_secret).toBe(first.body.signing_secret);
  });

  it("moves the version and makes a new secret for a new URL, or the same one after a delete", async () => {
    const agent = await newAgent();
    const first = await set(agent, { url: URL_A });
    const moved = await set(agent, { url: URL_B });
    expect(moved.body.version).toBe(2);
    expect(moved.body.signing_secret).toBeTruthy();
    expect(moved.body.signing_secret).not.toBe(first.body.signing_secret);
    expect((await api(agent, "DELETE", "/v1/inbox/a2a-endpoint")).body).toEqual({ deleted: true });
    expect(await status(agent)).toBeNull();
    const back = await set(agent, { url: URL_B });
    expect(back.body.version).toBe(3);
    expect(back.body.signing_secret).not.toBe(moved.body.signing_secret);
    // Deleting nothing is fine.
    expect((await api(await newAgent(), "DELETE", "/v1/inbox/a2a-endpoint")).status).toBe(200);
  });
});

describe("the bearer token", () => {
  it("is sealed, never returned, and opened only for a send", async () => {
    const agent = await newAgent();
    const made = await set(agent, { url: URL_A, token: TOKEN });
    expect(made.body.has_token).toBe(true);
    expect(made.text).not.toContain(TOKEN);
    const row = await storedRow(agent);
    expect(row.token_sealed).toMatch(/^v1:[0-9a-f]+$/);
    expect(row.token_sealed).not.toContain(TOKEN);
    for (const read of [await api(agent, "GET", "/v1/inbox/a2a-endpoint"), await api(agent, "GET", `/v1/agents/${agent.id}`), await api(ADMIN, "GET", `/v1/agents/${agent.id}/a2a-endpoint`)]) {
      expect(read.status).toBe(200);
      expect(read.text).not.toContain(TOKEN);
      expect(read.text).not.toContain(row.token_sealed);
    }
    expect(await claim(agent)).toEqual({ send: true, agent_id: agent.id, url: URL_A, version: 1, signing_secret: made.body.signing_secret, token: TOKEN });
  });

  it("is kept for the same URL unless replaced or cleared, and cleared by a new URL or a delete", async () => {
    const agent = await newAgent();
    await set(agent, { url: URL_A, token: TOKEN });
    expect((await set(agent, { url: URL_A })).body.has_token).toBe(true);
    expect((await claim(agent)).token).toBe(TOKEN);
    expect((await set(agent, { url: URL_A, token: "tok_second" })).body.has_token).toBe(true);
    expect((await claim(agent)).token).toBe("tok_second");
    expect((await set(agent, { url: URL_A, token: null })).body.has_token).toBe(false);
    expect((await claim(agent)).token).toBeNull();
    await set(agent, { url: URL_A, token: TOKEN });
    expect((await set(agent, { url: URL_B })).body.has_token).toBe(false);
    expect((await storedRow(agent)).token_sealed).toBeNull();
    await set(agent, { url: URL_B, token: TOKEN });
    await api(agent, "DELETE", "/v1/inbox/a2a-endpoint");
    const row = await storedRow(agent);
    expect([row.url, row.signing_secret, row.token_sealed]).toEqual(["", "", null]);
  });

  it("can't be opened once it's moved to another version or agent", async () => {
    const agent = await newAgent();
    await set(agent, { url: URL_A, token: TOKEN });
    const sealed = (await storedRow(agent)).token_sealed;
    // A sealed value copied onto another agent, or kept past a version change, sends nothing.
    const other = await newAgent();
    await set(other, { url: URL_A });
    await runInDurableObject(stub(other), (_: any, state: any) => state.storage.sql.exec("UPDATE a2a_endpoint SET token_sealed = ?", sealed));
    expect(await claim(other)).toEqual({ send: false, reason: "token_unavailable" });
    await runInDurableObject(stub(agent), (_: any, state: any) => state.storage.sql.exec("UPDATE a2a_endpoint SET version = version + 1"));
    expect(await claim(agent)).toEqual({ send: false, reason: "token_unavailable" });
  });
});

describe("who may set it", () => {
  it("is the agent or its organization's admin, and nobody else", async () => {
    const agent = await newAgent();
    const path = `/v1/agents/${agent.id}/a2a-endpoint`;
    const made = await api(ADMIN, "PUT", path, { url: URL_A });
    expect(made.status, made.text).toBe(200);
    expect(made.body.signing_secret).toBeTruthy();
    expect((await api(ADMIN, "GET", path)).body).toMatchObject({ url: URL_A, version: 1 });
    expect((await status(agent))).toMatchObject({ url: URL_A });
    const stranger = await newAgent();
    for (const who of [OTHER_ADMIN, stranger]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const refused = await api(who, method, path, method === "PUT" ? { url: URL_B } : undefined);
        expect(refused.code, `${who.id} ${method}`).toBe("agent_not_found");
      }
    }
    expect((await api(ADMIN, "DELETE", path)).status).toBe(200);
    expect(await status(agent)).toBeNull();
  });
});

describe("disconnecting", () => {
  it("deletes the endpoint with its secret and token, and nothing can be set until reconnected", async () => {
    const agent = await newAgent();
    await set(agent, { url: URL_A, token: TOKEN });
    const off = await api(ADMIN, "POST", `/v1/agents/${agent.id}/disconnect`);
    expect(off.status, off.text).toBe(200);
    const row = await storedRow(agent);
    expect([row.url, row.signing_secret, row.token_sealed, row.enabled]).toEqual(["", "", null, 0]);
    expect((await api(ADMIN, "PUT", `/v1/agents/${agent.id}/a2a-endpoint`, { url: URL_A })).code).toBe("agent_disconnected");
    expect((await claim(agent)).send).toBe(false);
  });
});

describe("reports and claims", () => {
  it("switches off after three failures in a row, and a success resets the count", async () => {
    const agent = await newAgent();
    await set(agent, { url: URL_A });
    expect(await report(agent, 1, false)).toEqual({ outcome: "counted" });
    expect(await report(agent, 1, false)).toEqual({ outcome: "counted" });
    expect(await report(agent, 1, true)).toEqual({ outcome: "reset" });
    expect((await status(agent)).consecutive_failures).toBe(0);
    for (let n = 0; n < 2; n++) await report(agent, 1, false);
    expect(await report(agent, 1, false)).toEqual({ outcome: "switched_off" });
    expect(await status(agent)).toMatchObject({ enabled: false, consecutive_failures: 3 });
    expect(await claim(agent)).toEqual({ send: false, reason: "switched_off" });
    // Reports after it's off change nothing more.
    expect(await report(agent, 1, true)).toEqual({ outcome: "ignored" });
  });

  it("ignores a report for an older version, so an old URL's failures don't count against a new one", async () => {
    const agent = await newAgent();
    await set(agent, { url: URL_A });
    await set(agent, { url: URL_B });
    for (let n = 0; n < 3; n++) expect(await report(agent, 1, false)).toEqual({ outcome: "ignored" });
    expect(await status(agent)).toMatchObject({ version: 2, enabled: true, consecutive_failures: 0 });
  });

  it("sends nothing with no endpoint, and refuses a malformed report", async () => {
    const agent = await newAgent();
    expect(await claim(agent)).toEqual({ send: false, reason: "no_endpoint" });
    expect(await report(agent, 1, false)).toEqual({ outcome: "ignored" });
    const bad = await stub(agent).fetch("https://principal.internal/internal/a2a-endpoint-report", { method: "POST", body: JSON.stringify({ version: "1", ok: false }) });
    expect(bad.status).toBe(400);
    await bad.text();
  });
});
