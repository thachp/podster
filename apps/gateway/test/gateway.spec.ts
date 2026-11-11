import { generateKeypair, signAgentJWT, signHostJWT } from "@auth/agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getMigrations } from "better-auth/db/migration";
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { CAPABILITIES, capabilitiesFor, InvalidArguments, toApiCall } from "../src/capabilities";
import { decodeJwt, importJWK, SignJWT } from "jose";
import { mintAssertion } from "../src/assertion";
import worker, { resolveAgent, cleanUp, clientKey, sensitiveRoute, type RateLimit, safeNext, allowedPassthrough, spentToken, forMcp, linkOnce, callApi, claimHost, codeMatchesLiveApproval, createAuth, handleConnection, isPublicAuthRoute, type Env } from "../src/index";

const BASE = "https://gateway.test";
const e = env as unknown as Env & { API_DB: D1Database; TEST_DIRECTORY_SCHEMA: string; TEST_AUTH_SCHEMA: string; TEST_API_SCHEMA: string; TEST_CAPABILITIES: string; TEST_WRANGLER: string };
const statements = (sql: string) => sql.split(";").map((s) => s.trim()).filter(Boolean);
let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}-${crypto.randomUUID().slice(0, 8)}`;

const call = (path: string, init: RequestInit = {}) => SELF.fetch(BASE + path, { redirect: "manual", ...init });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, ...headers } });

type Person = { cookie: string; org: string };
async function signUp(): Promise<Person> {
  const res = await post("/api/auth/sign-up/email", { email: `${unique("p")}@example.test`, password: "local-test-password-123", name: "Test person" });
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const orgs = await (await call("/api/orgs", { headers: { cookie } })).json<any>();
  return { cookie, org: orgs.organizations[0].id };
}
const dashboard = (who: Person, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  call(`/api${path}`, { method, headers: { cookie: who.cookie, origin: BASE, "content-type": "application/json", "idempotency-key": unique("k"), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const dash = async (who: Person, method: string, path: string, body?: unknown) => {
  const res = await dashboard(who, method, path, body);
  const parsed = await res.json<any>();
  return { status: res.status, body: parsed, code: parsed?.error?.code };
};

type AgentAuthAgent = { host: any; keypair: any; pluginId: string; userCode: string; registered: any };
async function registerAgent(previous?: { host: any; keypair: any }): Promise<AgentAuthAgent> {
  const host = previous?.host ?? (await generateKeypair());
  const keypair = previous?.keypair ?? (await generateKeypair());
  const jwt = await signHostJWT({ hostKeypair: host, audience: BASE, agentPublicKey: keypair.publicKey, hostName: "test-host" } as never);
  const res = await post("/api/auth/agent/register", { name: "agent", mode: "delegated", capabilities: capabilitiesFor(e).map((c) => c.name), preferred_method: "device_authorization" }, { authorization: `Bearer ${jwt}` });
  const registered = await res.json<any>();
  return { host, keypair, pluginId: registered.agent_id, userCode: registered.approval?.user_code, registered };
}
const claim = async (who: Person, agent: AgentAuthAgent, extra: object = {}) =>
  post("/claim", { agent_id: agent.pluginId, user_code: agent.userCode, org_id: who.org, ...extra }, { cookie: who.cookie });
const execute = async (agent: AgentAuthAgent, capability: string, args: unknown = {}) => {
  const jwt = await signAgentJWT({ agentKeypair: agent.keypair, agentId: agent.pluginId, audience: BASE, capabilities: [capability] });
  const res = await post("/api/auth/capability/execute", { capability, arguments: args }, { authorization: `Bearer ${jwt}` });
  const parsed = await res.json<any>();
  return { status: res.status, data: parsed?.data, code: parsed?.code ?? parsed?.message, raw: parsed };
};
async function claimedAgent(who: Person) {
  const agent = await registerAgent();
  const res = await claim(who, agent);
  expect(res.status).toBe(200);
  return { ...agent, id: (await res.json<any>()).agent_id as string };
}

const VERIFIER = "local-test-verifier-".padEnd(64, "x");
async function challenge() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function authorizeQuery(clientName = "Test client") {
  const reg = await post("/oauth/register", { redirect_uris: ["https://client.test/cb"], client_name: clientName, token_endpoint_auth_method: "none" });
  const { client_id } = await reg.json<{ client_id: string }>();
  const query = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://client.test/cb", scope: "mcp", code_challenge: await challenge(), code_challenge_method: "S256", state: "s" });
  return { client_id, query: `?${query}` };
}
const approve = (who: Person, query: string, fields: Record<string, string>, origin = BASE) =>
  call("/authorize", { method: "POST", headers: { cookie: who.cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ oauth_query: query, agent_name: "MCP agent", org_id: who.org, ...fields }) });
async function mcpAgent(who: Person, fields: Record<string, string> = {}, client?: { client_id: string; query: string }) {
  const { client_id, query } = client ?? (await authorizeQuery());
  const res = await approve(who, query, fields);
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const tok = await call("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://client.test/cb", client_id, code_verifier: VERIFIER }) });
  expect(tok.status).toBe(200);
  const { access_token: token, scope } = await tok.json<{ access_token: string; scope?: string }>();
  const tool = async (name: string, args: unknown = {}) => {
    const r = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const parsed = await r.json<any>();
    const text = parsed.result?.content?.[0]?.text;
    return parsed.result?.isError ? { code: text as string, data: undefined as any } : { code: undefined, data: text ? JSON.parse(text) : undefined };
  };
  const identity = await tool("get_identity");
  return { token, scope, tool, id: identity.data.id as string };
}

beforeAll(async () => {
  for (const sql of statements(e.TEST_AUTH_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_DIRECTORY_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_API_SCHEMA)) await e.API_DB.prepare(sql).run();
});

describe("people and organizations", () => {
  describe("when the sign-up hook can't write the personal organization", () => {
    const failPersonalOrgWrites = () => e.DB.prepare("CREATE TRIGGER fail_personal_org BEFORE INSERT ON organization WHEN NEW.personal = 1 BEGIN SELECT RAISE(ABORT, 'failed for this test'); END").run();
    const allowPersonalOrgWrites = () => e.DB.prepare("DROP TRIGGER IF EXISTS fail_personal_org").run();
    const signUpDuringFailure = async () => {
      await failPersonalOrgWrites();
      const res = await post("/api/auth/sign-up/email", { email: `${unique("p")}@example.test`, password: "local-test-password-123", name: "Hook failure" });
      expect(res.status).toBe(200);
      return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0], org: "" } as Person;
    };
    const personalOrgs = async (id: string) => (await e.DB.prepare("SELECT id, name FROM organization WHERE personal = 1 AND created_by = ?").bind(id).all<{ id: string; name: string }>()).results;

    it("refuses the person while the write keeps failing, then restores it on their next request", async () => {
      try {
        const person = await signUpDuringFailure();
        expect((await dash(person, "GET", "/orgs")).body.organizations).toEqual([]);
        expect((await dash(person, "GET", "/v1/me")).status).toBe(403);
        await allowPersonalOrgWrites();
        const me = await dash(person, "GET", "/v1/me");
        expect(me.status).toBe(200);
        const orgs = (await dash(person, "GET", "/orgs")).body.organizations;
        expect(orgs).toEqual([expect.objectContaining({ id: me.body.org_id, name: "Hook failure", personal: 1, role: "admin" })]);
      } finally {
        await allowPersonalOrgWrites();
      }
    });

    it("restores it from the organization list, the agent list and the claim page", async () => {
      for (const path of ["/orgs", "/agents"]) {
        try {
          const person = await signUpDuringFailure();
          await allowPersonalOrgWrites();
          expect((await dash(person, "GET", path)).status).toBe(200);
          expect((await dash(person, "GET", "/orgs")).body.organizations).toHaveLength(1);
        } finally {
          await allowPersonalOrgWrites();
        }
      }
      try {
        const person = await signUpDuringFailure();
        await allowPersonalOrgWrites();
        // 403 would be "you need to be an admin". 404 is the bad link, so the page found the organization it restored.
        expect((await call("/claim?agent_id=x&code=y", { headers: { cookie: person.cookie } })).status).toBe(404);
      } finally {
        await allowPersonalOrgWrites();
      }
    });

    it("keeps the default on a team organization created before the repair", async () => {
      try {
        const person = await signUpDuringFailure();
        const team = await dash(person, "POST", "/orgs", { name: "Team first" });
        expect(team.status).toBe(200);
        expect((await dash(person, "GET", "/v1/me")).body.org_id).toBe(team.body.id);
        await allowPersonalOrgWrites();
        const me = await dash(person, "GET", "/v1/me");
        expect(me.body.org_id).toBe(team.body.id);
        expect((await dash(person, "GET", "/v1/me")).body.org_id).toBe(team.body.id);
        expect(await personalOrgs(me.body.id)).toHaveLength(1);
        expect((await dash(person, "GET", "/orgs")).body.organizations).toHaveLength(2);
      } finally {
        await allowPersonalOrgWrites();
      }
    });

    it("logs why the write failed, with no name or email", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const person = await signUpDuringFailure();
        await dash(person, "GET", "/orgs");
        const lines = log.mock.calls.filter(([first]) => first === "personal organization not written");
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(line[2]).toContain("failed for this test");
          expect(JSON.stringify(line)).not.toMatch(/Hook failure|@example\.test/);
        }
      } finally {
        log.mockRestore();
        await allowPersonalOrgWrites();
      }
    });

    it("leaves one organization when requests restore it at once, and gives no access to anyone else's", async () => {
      const other = await signUp();
      let person: Person;
      try {
        person = await signUpDuringFailure();
      } finally {
        await allowPersonalOrgWrites();
      }
      const answers = await Promise.all(Array.from({ length: 6 }, () => dash(person, "GET", "/v1/me")));
      expect(answers.map((a) => a.status)).toEqual(Array(6).fill(200));
      expect(new Set(answers.map((a) => a.body.org_id)).size).toBe(1);
      expect(await personalOrgs(answers[0].body.id)).toHaveLength(1);
      expect(answers[0].body.org_id).not.toBe(other.org);
      expect((await dashboard(person, "GET", "/v1/me", undefined, { "x-podster-org": other.org })).status).toBe(403);
    });

    it("keeps someone's working organization, and the database refuses a second personal one", async () => {
      const person = await signUp();
      const id = (await dash(person, "GET", "/v1/me")).body.id as string;
      await dash(person, "GET", "/orgs");
      await expect(e.DB.prepare("INSERT INTO organization (id, name, personal, created_by, created_at) VALUES (?, 'Second', 1, ?, 0)").bind(unique("org"), id).run()).rejects.toThrow(/UNIQUE/);
      expect((await personalOrgs(id)).map((o) => o.id)).toEqual([person.org]);
    });
  });

  it("gives everyone a personal organization, and they can only act in their own", async () => {
    const [a, b] = [await signUp(), await signUp()];
    expect((await dash(a, "POST", "/orgs", { name: "Acme" })).body.role).toBe("admin");
    const orgs = (await dash(a, "GET", "/orgs")).body.organizations;
    expect(orgs).toHaveLength(2);
    expect(orgs[0].role).toBe("admin");
    const other = await dashboard(a, "GET", "/v1/me", undefined, { "x-podster-org": b.org });
    expect(other.status).toBe(403);
    const mine = await dashboard(a, "GET", "/v1/me", undefined, { "x-podster-org": orgs[1].id });
    const me = await mine.json<any>();
    expect(me.org_id).toBe(orgs[1].id);
    expect(me.admin_orgs.sort()).toEqual(orgs.map((o: any) => o.id).sort());
  });

  it("requires a session, our own origin, and ignores identity sent by a client", async () => {
    const a = await signUp();
    expect((await call("/api/v1/me")).status).toBe(401);
    expect((await call("/api/orgs")).status).toBe(401);
    const crossSite = await call("/api/v1/workspaces", { method: "POST", headers: { cookie: a.cookie, origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    expect(crossSite.status).toBe(403);
    const noOrigin = await call("/api/orgs", { method: "POST", headers: { cookie: a.cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    expect(noOrigin.status).toBe(403);
    const forged = await call("/api/v1/me", { headers: { cookie: a.cookie, "x-podster-assertion": "forged", "x-podster-caller": JSON.stringify({ id: "per_admin", kind: "person", org: "x", admin_orgs: ["x"] }) } });
    expect((await forged.json<any>()).admin_orgs).toEqual([a.org]);
  });

  it("the dashboard can't reach agent registration, connection state or inboxes through the API path", async () => {
    const a = await signUp();
    for (const [method, path] of [["PUT", "/v1/agents/agt_x"], ["POST", "/v1/agents/agt_x/disconnect"], ["GET", "/v1//inbox"], ["PUT", "/v1//agents/agt_abcdefabcdef"], ["POST", "/internal/init"], ["GET", "/v1/../internal/init"]]) {
      const res = await dashboard(a, method, path, method === "GET" ? undefined : { org_id: a.org });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("password sign-in is off unless a test environment turns it on", async () => {
    const auth = createAuth({ ...e, ENABLE_PASSWORD_SIGNIN: undefined });
    await expect(auth.api.signUpEmail({ body: { email: `${unique("q")}@example.test`, password: "local-test-password-123", name: "x" } })).rejects.toThrow();
  });
});

describe("Agent Auth", () => {
  it("a new agent waits for a person, and only an admin of the chosen organization can claim it", async () => {
    const [owner, stranger] = [await signUp(), await signUp()];
    const agent = await registerAgent();
    expect(agent.registered.status).toBe("pending");
    expect(agent.registered.approval.verification_uri_complete).toContain("/claim");
    expect((await execute(agent, "get_identity")).status).toBe(403);
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org })).status).toBe(401);
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org }, { cookie: stranger.cookie })).status).toBe(403);
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org }, { cookie: owner.cookie, origin: "https://evil.test" })).status).toBe(403);
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: "WRONG-CODE", org_id: owner.org }, { cookie: owner.cookie })).status).toBe(403);
    expect((await execute(agent, "get_identity")).status).toBe(403);
    const claimed = await claim(owner, agent, { name: "Architect" });
    expect(claimed.status).toBe(200);
    const id = (await claimed.json<any>()).agent_id;
    for (let i = 0; i < 2; i++) {
      const me = await execute(agent, "get_identity");
      expect(me.status).toBe(200);
      expect(me.data).toMatchObject({ id, org_id: owner.org, name: "Architect", status: "active" });
    }
  });

  it("can't be claimed twice", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const agent = await claimedAgent(a);
    expect((await claim(b, agent)).status).toBe(403);
    expect((await claim(a, agent)).status).toBe(403);
    expect((await execute(agent, "get_identity")).data.org_id).toBe(a.org);
  });

  it("refuses replayed agent tokens, even concurrently", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const jwt = await signAgentJWT({ agentKeypair: agent.keypair, agentId: agent.pluginId, audience: BASE, capabilities: ["get_identity"] });
    const send = () => post("/api/auth/capability/execute", { capability: "get_identity", arguments: {} }, { authorization: `Bearer ${jwt}` });
    const results = await Promise.all(Array.from({ length: 8 }, send));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(7);
  });
});

describe("hosted MCP", () => {
  it("needs a token, and consent is a form that escapes what the client supplied", async () => {
    const a = await signUp();
    expect((await call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const { query } = await authorizeQuery(`<script>alert(1)</script>`);
    const unsigned = await call(`/authorize${query}`);
    expect(unsigned.status).toBe(302);
    expect(unsigned.headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent(`/authorize${query}`)}`);
    expect((await call("/authorize", { method: "POST", headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: "" })).status).toBe(401);
    const before = await e.DB.prepare("SELECT count(*) AS n FROM identity_link").first<{ n: number }>();
    const page = await call(`/authorize${query}`, { headers: { cookie: a.cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&#60;script&#62;");
    // Opening the page connects nothing.
    expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link").first<{ n: number }>()).toEqual(before);
  });

  it("only our own page, and only an admin of the organization, can connect an agent", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const { query } = await authorizeQuery();
    expect((await approve(a, query, {}, "https://evil.test")).status).toBe(403);
    expect((await approve(b, query, { org_id: a.org })).status).toBe(403);
    expect((await approve(a, query, { agent_name: "x".repeat(201) })).status).toBe(400);
    const agent = await mcpAgent(a);
    expect((await agent.tool("get_identity")).data).toMatchObject({ id: agent.id, org_id: a.org, status: "active" });
  });

  it("an MCP grant and Agent Auth can be the same agent, within one organization only", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const agent = await claimedAgent(a);
    const linked = await mcpAgent(a, { link_agent_id: agent.id });
    expect(linked.id).toBe(agent.id);
    const { query } = await authorizeQuery();
    expect((await approve(b, query, { link_agent_id: agent.id })).status).toBe(403);
  });
});

describe("gateway refusals that don't rely on the API", () => {
  const addMember = (org: string, who: Person) => whoAmI(who).then((id) => e.DB.prepare("INSERT INTO org_member (org_id, person_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(org, id, Date.now()).run());
  const whoAmI = async (who: Person) => (await (await dashboard(who, "GET", "/v1/me")).json<any>()).id as string;

  it("refuses a disconnected or unlinked agent before minting anything", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const mcp = await mcpAgent(a);
    await e.DB.prepare("UPDATE podster_agent SET revoked_at = 1 WHERE id = ?").bind(agent.id).run();
    expect((await execute(agent, "get_identity")).raw.message).toBe("agent_disconnected");
    await e.DB.prepare("UPDATE identity_link SET provider = 'unlinked' WHERE agent_id = ?").bind(mcp.id).run();
    expect((await mcp.tool("get_identity")).code).toBe("agent_unclaimed");
  });

  it("an ordinary member of an organization can't claim or connect agents for it, or hold admin authority", async () => {
    const [a, member] = [await signUp(), await signUp()];
    await addMember(a.org, member);
    const me = await (await dashboard(member, "GET", "/v1/me", undefined, { "x-podster-org": a.org })).json<any>();
    expect(me.orgs).toContain(a.org);
    expect(me.admin_orgs).not.toContain(a.org);
    const agent = await registerAgent();
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: agent.userCode, org_id: a.org }, { cookie: member.cookie })).status).toBe(403);
    const { query } = await authorizeQuery();
    expect((await approve(member, query, { org_id: a.org })).status).toBe(403);
  });

  it("an ordinary member can't link a credential to the organization's agent", async () => {
    const [a, member] = [await signUp(), await signUp()];
    await addMember(a.org, member);
    const existing = await claimedAgent(a);
    const agent = await registerAgent();
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: agent.userCode, org_id: a.org, link_agent_id: existing.id }, { cookie: member.cookie })).status).toBe(403);
    expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(agent.pluginId).first()).toEqual({ status: "pending" });
    const { query } = await authorizeQuery();
    expect((await approve(member, query, { org_id: a.org, link_agent_id: existing.id })).status).toBe(403);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link WHERE agent_id = ?").bind(existing.id).first()).toEqual({ n: 1 });
  });

  it("can't link a credential to a disconnected agent", async () => {
    const a = await signUp();
    const old = await claimedAgent(a);
    await dash(a, "POST", `/agents/${old.id}/disconnect`);
    expect((await claim(a, await registerAgent(), { link_agent_id: old.id })).status).toBe(403);
    const { query } = await authorizeQuery();
    expect((await approve(a, query, { link_agent_id: old.id })).status).toBe(403);
    expect(await (await call(`/authorize${query}`, { headers: { cookie: a.cookie } })).text()).not.toContain(old.id);
  });

  it("lets an agent and its organization's admin set its A2A endpoint, and nobody else", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const agent = await mcpAgent(a);
    const set = await agent.tool("set_a2a_endpoint", { url: "https://agent.acme.dev/a2a" });
    expect(set.code).toBeUndefined();
    expect(set.data).toMatchObject({ url: "https://agent.acme.dev/a2a", version: 1, enabled: true, has_token: false });
    expect(set.data.signing_secret).toMatch(/^a2asec_/);
    expect((await agent.tool("get_a2a_endpoint")).data).not.toHaveProperty("signing_secret");
    // With no sealing key set, as on a deployment before the owner sets it, a token can't be stored, and the endpoint stays.
    expect((await agent.tool("set_a2a_endpoint", { url: "https://agent.acme.dev/a2a", token: "tok_x" })).code).toBe("token_storage_unavailable");
    const path = `/agents/${agent.id}/a2a-endpoint`;
    expect((await dash(a, "GET", path)).body).toMatchObject({ url: "https://agent.acme.dev/a2a", version: 1 });
    const moved = await dash(a, "PUT", path, { url: "https://other.acme.dev/a2a" });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ version: 2 });
    expect((await dash(b, "GET", path)).status).toBe(404);
    expect((await dash(b, "PUT", path, { url: "https://evil.acme.dev/a2a" })).status).toBe(404);
    expect((await dash(a, "DELETE", path)).body).toEqual({ deleted: true });
    expect((await agent.tool("get_a2a_endpoint")).data).toBeNull();
    expect((await agent.tool("delete_a2a_endpoint")).data).toEqual({ deleted: true });
  });

  it("lets only the agent's organization's admins set its participation policy", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const agent = await mcpAgent(a);
    expect((await agent.tool("get_identity")).data).toMatchObject({ participation_policy: "invitations_only" });
    const path = `/agents/${agent.id}/participation-policy`;
    expect((await dash(a, "GET", path)).body).toMatchObject({ policy: "invitations_only", set_at: null, history: [] });
    const set = await dash(a, "PUT", path, { policy: "public_claims" });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ policy: "public_claims" });
    expect((await agent.tool("get_identity")).data).toMatchObject({ participation_policy: "public_claims" });
    expect((await dash(a, "PUT", path, { policy: "anything" })).status).toBe(400);
    expect((await dash(b, "GET", path)).status).toBe(404);
    expect((await dash(b, "PUT", path, { policy: "invitations_only" })).status).toBe(404);
    // No agent capability sets it: an agent can't vouch for itself.
    expect((await agent.tool("set_participation_policy", { policy: "invitations_only" })).data).toBeUndefined();
    expect((await agent.tool("get_identity")).data).toMatchObject({ participation_policy: "public_claims" });
  });

  it("shows an owner what would be public, and refuses publishing while public rooms are off", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const room = (await dash(a, "POST", "/v1/workspaces", { name: "Billing v2" })).body.id as string;
    const read = await dash(a, "GET", `/v1/workspaces/${room}/visibility`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ visibility: "private", public_handle: null, public_rooms_enabled: false });
    expect(read.body.preview.name).toBe("Billing v2");
    expect(read.body.view_hash).toMatch(/^[0-9a-f]{64}$/);
    // Off everywhere until the owner switches it on, so a deployment refuses before anything becomes public.
    const publish = await dash(a, "PUT", `/v1/workspaces/${room}/visibility`, { visibility: "public", view_hash: read.body.view_hash });
    expect(publish.code).toBe("public_rooms_disabled");
    expect((await dash(a, "GET", `/v1/workspaces/${room}/visibility`)).body.visibility).toBe("private");
    expect((await dash(a, "PUT", `/v1/workspaces/${room}/topic`, { topic: "research" })).body).toEqual({ topic: "research" });
    expect((await dash(b, "GET", `/v1/workspaces/${room}/visibility`)).code).toBe("workspace_not_found");
  });

  it("can't link a claim to another organization's agent", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const other = await claimedAgent(a);
    const agent = await registerAgent();
    expect((await claim(b, agent, { link_agent_id: other.id })).status).toBe(403);
  });

  it("doesn't offer autonomous agents, because claiming one would end it", async () => {
    const host = await generateKeypair();
    const keypair = await generateKeypair();
    const jwt = await signHostJWT({ hostKeypair: host, audience: BASE, agentPublicKey: keypair.publicKey, hostName: unique("host") } as never);
    const res = await post("/api/auth/agent/register", { name: "x", mode: "autonomous", capabilities: ["get_identity"] }, { authorization: `Bearer ${jwt}` });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("plugin routes", () => {
  const PLUGIN_ROUTES = ["agent/cleanup", "agent/get", "agent/session", "agent/grant-capability", "agent/introspect", "agent/list", "agent/reactivate", "agent/request-capability", "agent/revoke", "agent/revoke-capability", "agent/rotate-key", "agent/update", "agent/approve-capability", "agent/claim", "capability/batch-execute", "host/create", "host/enroll", "host/get", "host/list", "host/revoke", "host/rotate-key", "host/switch-account", "host/update"];

  it("only the ones the product needs are public", async () => {
    const a = await signUp();
    for (const route of PLUGIN_ROUTES) {
      const res = await post(`/api/auth/${route}`, {}, { cookie: a.cookie });
      expect(res.status, route).toBe(404);
      expect(isPublicAuthRoute(`/${route}`), route).toBe(false);
    }
    for (const route of ["change-password", "update-user", "delete-user", "list-sessions", "revoke-sessions", "sign-up/email/x", "reset-password"]) expect(isPublicAuthRoute(`/${route}`), route).toBe(false);
    for (const route of ["agent/register", "agent/status", "capability/execute", "capability/list", "capability/describe", "agent-configuration", "sign-in/social", "sign-out", "get-session", "callback/github"]) expect(isPublicAuthRoute(`/${route}`), route).toBe(true);
  });

  it("a stranger can't replace a pending agent's keys, approve it or deny it", async () => {
    const [owner, stranger] = [await signUp(), await signUp()];
    const agent = await registerAgent();
    const hostile = await generateKeypair();
    for (const [route, body] of [
      ["host/update", { host_id: agent.registered.host_id, public_key: hostile.publicKey }],
      ["host/create", { public_key: hostile.publicKey, kid: "victim" }],
      ["agent/approve-capability", { agent_id: agent.pluginId, action: "deny" }],
      ["agent/approve-capability", { agent_id: agent.pluginId, user_code: agent.userCode, action: "approve" }],
      ["agent/grant-capability", { agent_id: agent.pluginId, capabilities: ["cancel_task"] }],
    ] as const) {
      expect((await post(`/api/auth/${route}`, body, { cookie: stranger.cookie })).status, route).toBe(404);
    }
    expect((await claim(owner, agent)).status).toBe(200);
    expect((await execute(agent, "get_identity")).status).toBe(200);
  });
});

describe("claim flows", () => {
  it("works on an older session, and only reports success when approved", async () => {
    const owner = await signUp();
    await e.DB.prepare("UPDATE session SET createdAt = ?").bind(new Date(Date.now() - 3_600_000).toISOString()).run();
    const agent = await registerAgent();
    expect((await claim(owner, agent)).status).toBe(200);
    expect((await execute(agent, "get_identity")).status).toBe(200);
    const fresh = await registerAgent();
    const before = await e.DB.prepare("SELECT count(*) AS n FROM identity_link").first<{ n: number }>();
    expect((await post("/claim", { agent_id: fresh.pluginId, user_code: "WRONG", org_id: owner.org }, { cookie: owner.cookie })).status).toBe(403);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link").first<{ n: number }>()).toEqual(before);
  });

  it("an idle agent keeps its capabilities", async () => {
    const owner = await signUp();
    const agent = await claimedAgent(owner);
    const row = await e.DB.prepare("SELECT expiresAt FROM agent WHERE id = ?").bind(agent.pluginId).first<{ expiresAt: string | null }>();
    expect(row?.expiresAt).toBeNull();
    const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await e.DB.prepare("UPDATE agent SET lastUsedAt = ?, activatedAt = ?, createdAt = ? WHERE id = ?").bind(longAgo, longAgo, longAgo, agent.pluginId).run();
    expect((await execute(agent, "get_identity")).status).toBe(200);
  });

  it("an expired code is refused, the agent can ask again, and a partial claim can be retried", async () => {
    const owner = await signUp();
    const agent = await registerAgent();
    await e.DB.prepare("UPDATE approvalRequest SET expiresAt = ? WHERE agentId = ?").bind(new Date(Date.now() - 1000).toISOString(), agent.pluginId).run();
    expect((await claim(owner, agent)).status).toBe(403);
    expect((await claim(owner, { ...agent, userCode: "ANYTHING" })).status).toBe(403);
    expect((await execute(agent, "get_identity")).status).toBe(403);

    const again = await registerAgent(agent);
    expect(again.pluginId).toBe(agent.pluginId);
    expect(again.userCode).toBeTruthy();
    // With a live code, the old code and a guess are still refused.
    if (again.userCode !== agent.userCode) expect((await claim(owner, agent)).status).toBe(403);
    expect((await claim(owner, { ...again, userCode: "ANYTHING" })).status).toBe(403);
    const res = await claim(owner, again);
    expect(res.status).toBe(200);
    // The directory write failed after approval: the same person retries and gets the same agent.
    const first = (await res.json<any>()).agent_id;
    await e.DB.prepare("DELETE FROM identity_link WHERE external_id = ?").bind(again.pluginId).run();
    const retry = await claim(owner, again);
    expect((await retry.json<any>()).agent_id).toBe(first);
    expect((await execute(again, "get_identity")).data.id).toBe(first);
    const other = await signUp();
    await e.DB.prepare("DELETE FROM identity_link WHERE external_id = ?").bind(again.pluginId).run();
    expect((await claim(other, again)).status).toBe(403);
  });

  it("handles bad input without creating anything", async () => {
    const owner = await signUp();
    const before = await e.DB.prepare("SELECT count(*) AS n FROM podster_agent").first<{ n: number }>();
    for (const extra of [{ link_agent_id: "" }, {}]) expect((await post("/claim", { agent_id: "junk", user_code: "junk", org_id: owner.org, ...extra }, { cookie: owner.cookie })).status).toBe(403);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM podster_agent").first<{ n: number }>()).toEqual(before);
    expect((await call("/api/v1/me", { headers: { cookie: owner.cookie } })).status).toBe(200);
    const agent = await registerAgent();
    expect((await claim(owner, agent, { name: "名".repeat(150) })).status).toBe(400);
    // A refused name spends nothing.
    expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(agent.pluginId).first()).toEqual({ status: "pending" });
    expect((await claim(owner, agent, { name: "名".repeat(60) })).status).toBe(200);
    expect((await dash(owner, "POST", "/orgs", { name: "名".repeat(150) })).code).toBe("invalid_argument");
  });
});

describe("consent", () => {
  it("doesn't block the redirect in a browser, and shows where access goes", async () => {
    const a = await signUp();
    const { query } = await authorizeQuery("Podster Official CLI");
    const page = await call(`/authorize${query}`, { headers: { cookie: a.cookie } });
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    // Chromium sends `Origin: null` on the form's POST under no-referrer, and approval would always be refused.
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const html = await page.text();
    expect(html).toContain("<strong>client.test</strong>");
    expect(html).toContain("hasn't verified this name");
  });

  it("consenting again keeps the same agent, and connected agents are offered", async () => {
    const a = await signUp();
    const { client_id, query } = await authorizeQuery();
    expect((await approve(a, query, {})).status).toBe(302);
    const first = await e.DB.prepare("SELECT agent_id FROM identity_link WHERE provider = 'mcp_oauth' AND person_id LIKE 'per_%' ORDER BY created_at DESC LIMIT 1").first<{ agent_id: string }>();
    const count = () => e.DB.prepare("SELECT count(*) AS n FROM podster_agent").first<{ n: number }>();
    const before = await count();
    expect((await approve(a, query, {})).status).toBe(302);
    expect(await count()).toEqual(before);
    expect(client_id).toBeTruthy();
    const html = await (await call(`/authorize${query}`, { headers: { cookie: a.cookie } })).text();
    expect(html).toContain(first!.agent_id);
  });

  it("refuses bad requests and scopes with a clear answer", async () => {
    const a = await signUp();
    expect((await call("/authorize", { method: "POST", headers: { cookie: a.cookie, origin: BASE, "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    expect((await call("/authorize?client_id=nope", { headers: { cookie: a.cookie } })).status).toBe(400);
    const { query } = await authorizeQuery();
    const wrongScope = query.replace("scope=mcp", "scope=admin");
    expect((await call(`/authorize${wrongScope}`, { headers: { cookie: a.cookie } })).status).toBe(400);
    expect((await approve(a, wrongScope, {})).status).toBe(400);
    expect((await dash(a, "POST", "/agents/%zz/disconnect")).status).toBe(404);
  });

  it("MCP takes only POST", async () => {
    const a = await signUp();
    const agent = await mcpAgent(a);
    expect((await call("/mcp", { headers: { authorization: `Bearer ${agent.token}`, accept: "text/event-stream" } })).status).toBe(405);
  });
});

describe("registration", () => {
  const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const fakeJwt = (claims: object) => `${b64({ alg: "EdDSA", typ: "host+jwt" })}.${b64(claims)}.sig`;
  const register = (jwt: string, body: object = {}) => post("/api/auth/agent/register", { name: "x", mode: "delegated", capabilities: ["get_identity"], preferred_method: "device_authorization", ...body }, { authorization: `Bearer ${jwt}` });

  it("a stranger with a host's key ID can't touch that host or its agents", async () => {
    const [owner, stranger] = [await signUp(), await signUp()];
    const victim = await claimedAgent(owner);
    const hostBefore = await e.DB.prepare("SELECT id, userId, name FROM agentHost WHERE id = ?").bind(victim.registered.host_id).first();
    const hostile = await generateKeypair();
    const borrowed = { publicKey: { ...hostile.publicKey, kid: victim.host.publicKey.kid }, privateKey: hostile.privateKey };
    const agentKey = await generateKeypair();
    const jwt = await signHostJWT({ hostKeypair: borrowed, audience: BASE, agentPublicKey: agentKey.publicKey, hostName: "taken", issuer: unique("iss") } as never);
    const res = await register(jwt, { force_approval: true });
    expect(res.status).toBe(400);
    const withoutForce = await register(await signHostJWT({ hostKeypair: borrowed, audience: BASE, agentPublicKey: agentKey.publicKey, hostName: "taken", issuer: unique("iss") } as never));
    expect(withoutForce.status).toBe(400);
    expect((await withoutForce.json<any>()).error.code).toBe("invalid_public_key");
    expect(await e.DB.prepare("SELECT id, userId, name FROM agentHost WHERE id = ?").bind(victim.registered.host_id).first()).toEqual(hostBefore);
    expect((await execute(victim, "get_identity")).status).toBe(200);
    expect(stranger.org).toBeTruthy();
  });

  it("the host's real operator can't revoke its agents by forcing approval either", async () => {
    const owner = await signUp();
    const victim = await claimedAgent(owner);
    const next = await generateKeypair();
    const jwt = await signHostJWT({ hostKeypair: victim.host, audience: BASE, agentPublicKey: next.publicKey, hostName: "test-host" } as never);
    expect((await register(jwt, { force_approval: true })).status).toBe(400);
    expect((await execute(victim, "get_identity")).status).toBe(200);
  });

  it("refuses remote key URLs, agents with no capabilities, and anything it can't read", async () => {
    const keys = await generateKeypair();
    for (const claims of [{ host_jwks_url: "https://evil.test/jwks" }, { agent_jwks_url: "https://evil.test/jwks" }]) {
      const res = await register(fakeJwt({ iss: unique("iss"), ...claims }));
      expect((await res.json<any>()).error.code).toBe("jwks_url_not_supported");
    }
    const agentLie = await register(fakeJwt({ host_public_key: keys.publicKey, agent_public_key: { ...keys.publicKey, kid: "someone-else" } }));
    expect((await agentLie.json<any>()).error.code).toBe("invalid_public_key");
    for (const capabilities of [[], undefined]) {
      const res = await register(fakeJwt({ host_public_key: keys.publicKey }), { capabilities });
      expect((await res.json<any>()).error.code).toBe("capabilities_required");
    }
    expect((await post("/api/auth/agent/register", { capabilities: ["get_identity"] }, { authorization: "Bearer junk" })).status).toBe(401);
    expect((await call("/api/auth/agent/register", { method: "POST", body: "not json", headers: { "content-type": "application/json", origin: BASE } })).status).toBe(400);
  });

  it("shortens a long registered name so the agent can still be claimed", async () => {
    const owner = await signUp();
    const [host, key] = [await generateKeypair(), await generateKeypair()];
    const jwt = await signHostJWT({ hostKeypair: host, audience: BASE, agentPublicKey: key.publicKey, hostName: "test-host" } as never);
    const registered = await (await register(jwt, { name: "名".repeat(100) })).json<any>();
    const agent = { host, keypair: key, pluginId: registered.agent_id, userCode: registered.approval.user_code, registered };
    expect((await claim(owner, agent)).status).toBe(200);
    expect((await execute(agent, "get_identity")).data.name).toBe("名".repeat(66));
  });

  it("discovery lists only public routes", async () => {
    for (const path of ["/.well-known/agent-configuration", "/api/auth/agent-configuration"]) {
      const { endpoints } = await (await call(path)).json<any>();
      expect(Object.keys(endpoints).sort(), path).toEqual(["capabilities", "describe_capability", "execute", "register", "status"]);
    }
  });
});

describe("hosts with more than one agent", () => {
  it("a second person's claim doesn't end the first person's agent on a shared host", async () => {
    const [first, second] = [await signUp(), await signUp()];
    const one = await registerAgent();
    const two = await registerAgent({ host: one.host, keypair: await generateKeypair() });
    expect(two.registered.host_id).toBe(one.registered.host_id);
    expect((await claim(first, one)).status).toBe(200);
    const refused = await claim(second, two);
    expect(refused.status).toBe(403);
    expect((await refused.json<any>()).error.code).toBe("host_owned_by_another_person");
    expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(two.pluginId).first()).toEqual({ status: "pending" });
    expect((await execute(one, "get_identity")).status).toBe(200);
    expect(await e.DB.prepare("SELECT userId FROM agentHost WHERE id = ?").bind(one.registered.host_id).first()).toEqual({ userId: (await e.DB.prepare("SELECT userId FROM agent WHERE id = ?").bind(one.pluginId).first<{ userId: string }>())!.userId });
  });

  it("a wrong code can't take a host or learn that it's taken", async () => {
    const [first, second] = [await signUp(), await signUp()];
    const one = await registerAgent();
    const two = await registerAgent({ host: one.host, keypair: await generateKeypair() });
    const wrong = await claim(second, { ...one, userCode: "AAAA-AAAA" });
    expect((await wrong.json<any>()).error.code).toBe("not_allowed");
    expect(await e.DB.prepare("SELECT userId, status FROM agentHost WHERE id = ?").bind(one.registered.host_id).first()).toEqual({ userId: null, status: "pending" });
    expect((await claim(first, one)).status).toBe(200);
    expect((await (await claim(second, { ...two, userCode: "AAAA-AAAA" })).json<any>()).error.code).toBe("not_allowed");
  });

  it("only one person can take a host, even at the same moment", async () => {
    const [first, second] = [await signUp(), await signUp()];
    const agent = await registerAgent();
    const ids = await Promise.all([first, second].map(async (who) => (await e.DB.prepare("SELECT userId FROM session WHERE token = ?").bind(decodeURIComponent(who.cookie.split("=")[1]).split(".")[0]).first<{ userId: string }>())!.userId));
    const results = await Promise.all(ids.map((id) => claimHost(e, agent.pluginId, id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = ids[results.indexOf(true)];
    const hostRow = () => e.DB.prepare("SELECT userId, status, activatedAt, updatedAt FROM agentHost WHERE id = ?").bind(agent.registered.host_id).first<{ userId: string; status: string; activatedAt: string; updatedAt: string }>();
    const taken = (await hostRow())!;
    expect(taken).toMatchObject({ userId: winner, status: "active" });
    // Stored the way the plugin's adapter stores dates, or it would misread them.
    expect(taken.activatedAt).toBe(new Date(taken.activatedAt).toISOString());
    expect(taken.updatedAt).toBe(new Date(taken.updatedAt).toISOString());
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Holding the host already counts, and the plugin then has no owner change to act on.
    expect(await claimHost(e, agent.pluginId, winner)).toBe(true);
    const again = (await hostRow())!;
    expect(again.activatedAt).toBe(taken.activatedAt);
    expect(again.updatedAt > taken.updatedAt).toBe(true);
    // Revoking a host is final, even for its owner.
    await e.DB.prepare("UPDATE agentHost SET status = 'revoked' WHERE id = ?").bind(agent.registered.host_id).run();
    expect(await claimHost(e, agent.pluginId, winner)).toBe(false);
    expect((await hostRow())!.status).toBe("revoked");
  });

  describe("with one claim held partway", () => {
    const claimDirect = (who: Person, agent: AgentAuthAgent, db: D1Database, extra: object = {}) =>
      worker.fetch(new Request(`${BASE}/claim`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: who.cookie }, body: JSON.stringify({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: who.org, ...extra }) }), { ...e, DB: db } as never, { waitUntil() {}, passThroughOnException() {} } as never);
    const gate = () => {
      let open!: () => void;
      let reached!: () => void;
      return { opened: new Promise<void>((r) => (open = r)), arrived: new Promise<void>((r) => (reached = r)), open: () => open(), reach: () => reached() };
    };

    it("a second person can't slip past while the first activation is in flight", async () => {
      const [first, second] = [await signUp(), await signUp()];
      const one = await registerAgent();
      const two = await registerAgent({ host: one.host, keypair: await generateKeypair() });
      const held = gate();
      let done = false;
      const statement = (inner: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(inner, {
        get(target, key) {
          if (key === "bind") return (...args: unknown[]) => statement(target.bind(...args), sql);
          const value = (target as any)[key];
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (!done && /update\s+"?agent"?\s/i.test(sql)) {
              done = true;
              held.reach();
              await held.opened;
            }
            return value.apply(target, args);
          };
        },
      });
      const slowDb = new Proxy(e.DB, {
        get(target, key) {
          if (key === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
          const value = (target as any)[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const firstClaim = claimDirect(first, one, slowDb);
      await held.arrived;
      const secondClaim = await claimDirect(second, two, e.DB);
      held.open();
      expect((await firstClaim).status).toBe(200);
      expect(secondClaim.status).toBe(403);
      expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(one.pluginId).first()).toEqual({ status: "active" });
      expect((await execute(one, "get_identity")).status).toBe(200);
    });

    it("the same person submitting twice gets one agent and no error", async () => {
      const owner = await signUp();
      const agent = await registerAgent();
      const held = gate();
      let done = false;
      const slowDb = new Proxy(e.DB, {
        get(target, key) {
          if (key === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!done) {
                done = true;
                held.reach();
                await held.opened;
              }
              return target.batch(statements);
            };
          }
          const value = (target as any)[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const firstClaim = claimDirect(owner, agent, slowDb);
      await held.arrived;
      const second = await claimDirect(owner, agent, e.DB);
      held.open();
      const first = await firstClaim;
      expect([first.status, second.status]).toEqual([200, 200]);
      const [a, b] = [await first.json<any>(), await second.json<any>()];
      expect(a.agent_id).toBe(b.agent_id);
      expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link WHERE external_id = ?").bind(agent.pluginId).first()).toEqual({ n: 1 });
      expect((await execute(agent, "get_identity")).data.id).toBe(a.agent_id);
    });

    /** Holds the first claim at the moment it writes its link, whichever way it writes it. */
    function holdLinkWrite() {
      const held = gate();
      let done = false;
      const hold = async () => {
        if (!done) {
          done = true;
          held.reach();
          await held.opened;
        }
      };
      const statement = (inner: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(inner, {
        get(target, key) {
          if (key === "bind") return (...args: unknown[]) => statement(target.bind(...args), sql);
          const value = (target as any)[key];
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (/insert into identity_link/i.test(sql)) await hold();
            return value.apply(target, args);
          };
        },
      });
      const db = new Proxy(e.DB, {
        get(target, key) {
          if (key === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
          if (key === "batch") return async (statements: D1PreparedStatement[]) => (await hold(), target.batch(statements));
          const value = (target as any)[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return { db, held };
    }
    const linkOf = (agent: AgentAuthAgent) => e.DB.prepare("SELECT agent_id FROM identity_link WHERE provider = 'agent_auth' AND external_id = ?").bind(agent.pluginId).all<{ agent_id: string }>().then((r) => r.results.map((row) => row.agent_id));

    it("linking to the same agent twice gets the same answer both times", async () => {
      const owner = await signUp();
      const target = await claimedAgent(owner);
      const agent = await registerAgent();
      const { db, held } = holdLinkWrite();
      const firstClaim = claimDirect(owner, agent, db, { link_agent_id: target.id });
      await held.arrived;
      const second = await claimDirect(owner, agent, e.DB, { link_agent_id: target.id });
      held.open();
      expect([(await firstClaim).status, second.status]).toEqual([200, 200]);
      expect(await linkOf(agent)).toEqual([target.id]);
    });

    it("linking to two different agents refuses the one that lost", async () => {
      const owner = await signUp();
      const [loser, winner] = [await claimedAgent(owner), await claimedAgent(owner)];
      const agent = await registerAgent();
      const { db, held } = holdLinkWrite();
      const firstClaim = claimDirect(owner, agent, db, { link_agent_id: loser.id });
      await held.arrived;
      const second = await claimDirect(owner, agent, e.DB, { link_agent_id: winner.id });
      held.open();
      expect(second.status).toBe(200);
      expect((await firstClaim).status).toBe(403);
      expect(await linkOf(agent)).toEqual([winner.id]);
      expect((await execute(agent, "get_identity")).data.id).toBe(winner.id);
    });

    it("a plain claim that loses to a link is refused, not told about an agent it didn't get", async () => {
      const owner = await signUp();
      const winner = await claimedAgent(owner);
      const agent = await registerAgent();
      const { db, held } = holdLinkWrite();
      const firstClaim = claimDirect(owner, agent, db);
      await held.arrived;
      const second = await claimDirect(owner, agent, e.DB, { link_agent_id: winner.id });
      held.open();
      expect(second.status).toBe(200);
      expect((await firstClaim).status).toBe(403);
      expect(await linkOf(agent)).toEqual([winner.id]);
    });
  });

  it("a failed link only counts as done if it points at the same agent", async () => {
    const owner = await signUp();
    const { pluginId, id } = await claimedAgent(owner);
    const fail = () => Promise.reject(new Error("UNIQUE constraint failed"));
    expect(await linkOnce(e, pluginId, id, fail)).toBe(true);
    expect(await linkOnce(e, pluginId, "agt_other", fail)).toBe(false);
    await expect(linkOnce(e, "plugin_with_no_link", id, fail)).rejects.toThrow("UNIQUE");
  });

  it("two simultaneous claims on one host never both succeed", async () => {
    for (let round = 0; round < 5; round++) {
      const [first, second] = [await signUp(), await signUp()];
      const one = await registerAgent();
      const two = await registerAgent({ host: one.host, keypair: await generateKeypair() });
      const statuses = (await Promise.all([claim(first, one), claim(second, two)])).map((r) => r.status).sort();
      expect(statuses).toEqual([200, 403]);
      // Whoever won keeps a working agent, and the loser's is still waiting.
      const working = [(await execute(one, "get_identity")).status, (await execute(two, "get_identity")).status].sort();
      expect(working).toEqual([200, 403]);
    }
  });

  it("a claim stops if the plugin refuses a live code", async () => {
    const [owner, other] = [await signUp(), await signUp()];
    const agent = await registerAgent();
    const otherUser = (await e.DB.prepare("SELECT userId FROM session WHERE token = ?").bind(decodeURIComponent(other.cookie.split("=")[1]).split(".")[0]).first<{ userId: string }>())!.userId;
    await e.DB.prepare("UPDATE agent SET userId = ? WHERE id = ?").bind(otherUser, agent.pluginId).run();
    expect((await claim(owner, agent)).status).toBe(403);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link WHERE external_id = ?").bind(agent.pluginId).first()).toEqual({ n: 0 });
    expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(agent.pluginId).first()).toEqual({ status: "pending" });
    // The person with the valid code keeps the host, as documented.
    expect(await e.DB.prepare("SELECT status FROM agentHost WHERE id = ?").bind(agent.registered.host_id).first()).toEqual({ status: "active" });
  });

  it("the host's owner can claim its other agents", async () => {
    const owner = await signUp();
    const one = await registerAgent();
    const two = await registerAgent({ host: one.host, keypair: await generateKeypair() });
    expect((await claim(owner, one)).status).toBe(200);
    expect((await claim(owner, two)).status).toBe(200);
    expect((await execute(one, "get_identity")).status).toBe(200);
    expect((await execute(two, "get_identity")).status).toBe(200);
  });

  it("only the person who approved can finish a claim that stopped partway", async () => {
    const [owner, stranger] = [await signUp(), await signUp()];
    const agent = await registerAgent();
    // Approved, then the API or directory write failed: active, with no link and no Principal.
    const approved = await createAuth(e).api.approveCapability({ headers: new Headers({ cookie: owner.cookie }), body: { agent_id: agent.pluginId, user_code: agent.userCode, action: "approve" } }) as unknown as { status?: string };
    expect(approved.status).toBe("approved");
    expect((await claim(stranger, { ...agent, userCode: "AAAA-AAAA" })).status).toBe(403);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link WHERE external_id = ?").bind(agent.pluginId).first()).toEqual({ n: 0 });
    expect((await claim(owner, { ...agent, userCode: "AAAA-AAAA" })).status).toBe(200);
  });
});

describe("codes", () => {
  it("the gateway itself checks the code against a live approval", async () => {
    const agent = await registerAgent();
    const code = agent.userCode;
    expect(await codeMatchesLiveApproval(e, agent.pluginId, code)).toBe(true);
    expect(await codeMatchesLiveApproval(e, agent.pluginId, ` ${code.toLowerCase().replace("-", " ")}`)).toBe(true);
    expect(await codeMatchesLiveApproval(e, agent.pluginId, "AAAA-AAAA")).toBe(false);
    await e.DB.prepare("UPDATE approvalRequest SET expiresAt = ? WHERE agentId = ?").bind(new Date(Date.now() - 1000).toISOString(), agent.pluginId).run();
    expect(await codeMatchesLiveApproval(e, agent.pluginId, code)).toBe(false);
  });

  it("a junk code passes nothing when no approval is pending", async () => {
    const [owner, stranger] = [await signUp(), await signUp()];
    const agent = await registerAgent();
    // The moment after an owner's approval resolved the row, before the plugin activates the agent.
    await e.DB.prepare("UPDATE approvalRequest SET status = 'approved' WHERE agentId = ?").bind(agent.pluginId).run();
    expect((await claim(stranger, { ...agent, userCode: "AAAA-AAAA" })).status).toBe(403);
    expect(await e.DB.prepare("SELECT userId FROM agent WHERE id = ?").bind(agent.pluginId).first()).toEqual({ userId: null });
    expect(owner.org).toBeTruthy();
  });
});

describe("after a disconnect", () => {
  const person = async (who: Person) => (await (await dashboard(who, "GET", "/v1/me")).json<any>()) as { id: string; orgs: string[]; admin_orgs: string[] };

  it("an old key can't be claimed back without a code, or moved to another agent", async () => {
    const a = await signUp();
    const old = await claimedAgent(a);
    const other = await claimedAgent(a);
    await dash(a, "POST", `/agents/${old.id}/disconnect`);
    const junk = { ...old, userCode: "JUNK" };
    expect((await claim(a, junk)).status).toBe(403);
    expect((await claim(a, junk, { link_agent_id: other.id })).status).toBe(403);
    expect((await execute(old, "get_identity")).status).toBe(403);
    await dash(a, "POST", `/agents/${old.id}/reconnect`);
    expect((await claim(a, junk)).status).toBe(403);
    expect((await execute(old, "get_identity")).status).toBe(403);
    expect((await execute(other, "get_identity")).status).toBe(200);
  });

  it("a disconnect whose response was lost still ends credentials when reconnecting", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const linked = await mcpAgent(a, { link_agent_id: agent.id });
    const me = await person(a);
    // The API commits, and the gateway never gets to run its part.
    const lost = await callApi(e, { kind: "person", id: me.id, org: a.org, orgs: me.orgs, adminOrgs: me.admin_orgs, orgSince: {} }, { method: "POST", path: `/v1/agents/${agent.id}/disconnect`, body: "{}" });
    expect(lost.status).toBe(200);
    expect((await dash(a, "POST", `/agents/${agent.id}/reconnect`)).status).toBe(200);
    expect((await execute(agent, "get_identity")).status).toBe(403);
    expect((await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${linked.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status).toBe(401);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link WHERE agent_id = ?").bind(agent.id).first()).toEqual({ n: 0 });
  });

  describe("when the API's answer to the state check is unusual", () => {
    const identityOf = async (who: Person) => {
      const me = await person(who);
      return { kind: "person" as const, id: me.id, org: who.org, orgs: me.orgs, adminOrgs: me.admin_orgs, orgSince: {} };
    };
    const stubbed = (answer: (method: string) => Response, seen: string[]) => ({ ...e, API: { fetch: async (request: Request) => (seen.push(request.method), answer(request.method)) } as unknown as Fetcher });

    it("doesn't reconnect if the state can't be read", async () => {
      const a = await signUp();
      const agent = await claimedAgent(a);
      const seen: string[] = [];
      const res = await handleConnection(stubbed(() => new Response(JSON.stringify({ error: { code: "upstream_unavailable" } }), { status: 504 }), seen), await identityOf(a), agent.id, "reconnect");
      expect(res.status).toBe(504);
      expect(seen).toEqual(["GET"]);
    });

    it("ends credentials for any state but active", async () => {
      const a = await signUp();
      const agent = await claimedAgent(a);
      const seen: string[] = [];
      const answer = (method: string) => (method === "GET" ? new Response(JSON.stringify({ status: "disconnecting" })) : new Response(JSON.stringify({ error: { code: "conflict" } }), { status: 409 }));
      expect((await handleConnection(stubbed(answer, seen), await identityOf(a), agent.id, "reconnect")).status).toBe(409);
      expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link WHERE agent_id = ?").bind(agent.id).first()).toEqual({ n: 0 });
    });
  });

  it("reconnecting an agent that's still connected keeps its credentials", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    await dash(a, "POST", `/agents/${agent.id}/reconnect`);
    expect((await execute(agent, "get_identity")).status).toBe(200);
  });

  it("an older answer can't overwrite the directory's generation", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    await e.DB.prepare("UPDATE podster_agent SET generation = 99 WHERE id = ?").bind(agent.id).run();
    await dash(a, "POST", `/agents/${agent.id}/disconnect`);
    expect(await e.DB.prepare("SELECT generation FROM podster_agent WHERE id = ?").bind(agent.id).first()).toEqual({ generation: 99 });
  });
});

describe("consent across organizations and clients", () => {
  it("connecting a client to a second organization leaves the first one's agent working", async () => {
    const a = await signUp();
    const second = (await dash(a, "POST", "/orgs", { name: "Second" })).body.id as string;
    const client = await authorizeQuery();
    const first = await mcpAgent(a, {}, client);
    const other = await mcpAgent(a, { org_id: second }, client);
    expect(other.id).not.toBe(first.id);
    expect((await first.tool("get_identity")).data).toMatchObject({ id: first.id, org_id: a.org });
    expect((await other.tool("get_identity")).data).toMatchObject({ id: other.id, org_id: second });
  });

  it("consenting again in one organization replaces only that token", async () => {
    const a = await signUp();
    const client = await authorizeQuery();
    const first = await mcpAgent(a, {}, client);
    const again = await mcpAgent(a, {}, client);
    expect(again.id).toBe(first.id);
    expect((await again.tool("get_identity")).data.id).toBe(first.id);
    const old = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(old.status).toBe(401);
  });

  it("a connected credential can't be pointed at a different agent", async () => {
    const a = await signUp();
    const client = await authorizeQuery();
    await mcpAgent(a, {}, client);
    const other = await claimedAgent(a);
    expect((await approve(a, client.query, { link_agent_id: other.id })).status).toBe(409);
  });

  it("offers only agents from the person's own organizations, labeled by organization", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const mine = await claimedAgent(a);
    const theirs = await claimedAgent(b);
    const { query } = await authorizeQuery();
    const html = await (await call(`/authorize${query}`, { headers: { cookie: a.cookie } })).text();
    expect(html).toContain(mine.id);
    expect(html).not.toContain(theirs.id);
    expect(html).toContain("agent (Test person)");
  });

  it("accepts the scopes real clients send, and only ever grants mcp", async () => {
    const a = await signUp();
    const client = await authorizeQuery();
    const { query } = client;
    // The provider advertises required scopes without enforcing them on /mcp, so check what the token was actually given.
    for (const scoped of [query.replace("scope=mcp&", ""), query.replace("scope=mcp", "scope=mcp+offline_access")]) {
      expect((await call(`/authorize${scoped}`, { headers: { cookie: a.cookie } })).status, scoped).toBe(200);
      const agent = await mcpAgent(a, {}, { ...client, query: scoped });
      expect(agent.scope, scoped).toBe("mcp");
      expect((await agent.tool("get_identity")).data.org_id, scoped).toBe(a.org);
    }
    expect((await call(`/authorize${query.replace("scope=mcp", "scope=mcp+admin")}`, { headers: { cookie: a.cookie } })).status).toBe(400);
    const metadata = await (await call("/.well-known/oauth-protected-resource/mcp")).json<any>();
    expect(metadata.scopes_supported).toEqual(["mcp"]);
  });

  it("works with the official MCP SDK, from discovery to a tool call", async () => {
    const a = await signUp();
    const serverUrl = `${BASE}/mcp`;
    const sdkFetch = ((url: string | URL, init?: RequestInit) => SELF.fetch(String(url), init)) as typeof fetch;
    let authorizationUrl: URL | undefined;
    let verifier = "";
    let client: any;
    let tokens: any;
    const provider = {
      redirectUrl: "https://client.test/cb",
      clientMetadata: { client_name: "SDK client", redirect_uris: ["https://client.test/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
      clientInformation: () => client,
      saveClientInformation: (info: unknown) => void (client = info),
      tokens: () => tokens,
      saveTokens: (value: unknown) => void (tokens = value),
      redirectToAuthorization: (url: URL) => void (authorizationUrl = url),
      saveCodeVerifier: (value: string) => void (verifier = value),
      codeVerifier: () => verifier,
    } as any;
    expect(await sdkAuth(provider, { serverUrl, fetchFn: sdkFetch })).toBe("REDIRECT");
    const approved = await approve(a, authorizationUrl!.search, {});
    expect(approved.status).toBe(302);
    const authorizationCode = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    expect(await sdkAuth(provider, { serverUrl, authorizationCode, fetchFn: sdkFetch })).toBe("AUTHORIZED");
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider, fetch: sdkFetch }));
    expect((await mcp.listTools()).tools.map((t) => t.name)).toContain("get_identity");
    const result: any = await mcp.callTool({ name: "get_identity", arguments: {} });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ org_id: a.org, status: "active" });
    await mcp.close();
  });
});

describe("resilience and schema", () => {
  const someone = { kind: "person" as const, id: "per_x", org: "o", orgs: ["o"], adminOrgs: [], orgSince: {} };

  it("answers when the API hangs, and says so differently when it fails", async () => {
    const hanging = { ...e, API: { fetch: (request: Request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason))) } as unknown as Fetcher };
    expect((await callApi(hanging, someone, { method: "GET", path: "/v1/me" }, 20)).status).toBe(504);
    const failing = { ...e, API: { fetch: () => Promise.reject(new Error("no such service")) } as unknown as Fetcher };
    expect((await callApi(failing, someone, { method: "GET", path: "/v1/me" })).status).toBe(502);
  });

  it("a claim into a second organization gets a refusal, not an outage", async () => {
    const a = await signUp();
    const second = (await dash(a, "POST", "/orgs", { name: "Second" })).body.id as string;
    const agent = await claimedAgent(a);
    await e.DB.prepare("DELETE FROM identity_link WHERE external_id = ?").bind(agent.pluginId).run();
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: "x", org_id: second }, { cookie: a.cookie })).status).toBe(403);
  });

  it("passes the API's status through to agents", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const wake = await execute(agent, "set_wake", { url: "https://127.0.0.1/wake" });
    expect(wake.status).toBe(400);
    expect(wake.raw.message).toBe("invalid_wake_url");
    const missing = await execute(agent, "get_workspace", { workspace_id: "ws_none" });
    expect(missing.status).toBe(404);
  });

  it("password sign-in can't turn on with a real hostname", async () => {
    const auth = createAuth({ ...e, BASE_URL: "https://gateway.podster.dev", ENABLE_PASSWORD_SIGNIN: "true" });
    await expect(auth.api.signUpEmail({ body: { email: `${unique("q")}@example.test`, password: "local-test-password-123", name: "x" } })).rejects.toThrow();
  });

  it("doesn't check the schema on every request", () => {
    expect(createAuth(e).options.advanced?.database?.validateSchema).toBe(false);
  });

  it("the committed migration matches the pinned auth packages", async () => {
    const { toBeCreated, toBeAdded } = await getMigrations(createAuth(e).options);
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
  });
});

describe("rate limits", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
  /** A limiter that records every key, and refuses the ones it's told to. */
  const limiter = (refuse: (key: string) => boolean = () => false) => {
    const keys: string[] = [];
    const fake: RateLimit = { limit: async ({ key }) => (keys.push(key), { success: !refuse(key) }) };
    return { fake, keys };
  };
  const send = (path: string, init: RequestInit = {}, env: object = {}) => worker.fetch(new Request(BASE + path, init), { ...e, ...env } as never, ctx);
  const from = (ip: string, more: Record<string, string> = {}) => ({ "cf-connecting-ip": ip, ...more });
  const jsonPost = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", body: JSON.stringify(body), headers: { origin: BASE, "content-type": "application/json", ...headers } });
  const expectLimited = async (res: Response) => {
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await res.json<any>()).error.code).toBe("rate_limited");
  };
  /** OAuth and Agent Auth clients each read their own error shape. */
  const expectLimitedFor = async (path: string, res: Response) => {
    expect(res.status, path).toBe(429);
    expect(Number(res.headers.get("retry-after")), path).toBeGreaterThan(0);
    expect(Number(res.headers.get("retry-after")), path).toBeLessThanOrEqual(60);
    const body = await res.json<any>();
    if (path.startsWith("/oauth/")) expect(body, path).toEqual({ error: "temporarily_unavailable", error_description: "rate_limited" });
    else if (path.startsWith("/api/auth/")) expect(body, path).toEqual({ error: "rate_limited", message: "rate_limited" });
    else expect(body.error.code, path).toBe("rate_limited");
  };

  it("counts each client separately, and an IPv6 network as one client", () => {
    const ip = (value: string) => clientKey(new Request(BASE, { headers: { "cf-connecting-ip": value } }));
    expect(ip("203.0.113.9")).toBe("203.0.113.9");
    expect(ip("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2");
    expect(ip("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2");
    expect(ip("2001:DB8:0001:0002::")).toBe("2001:db8:1:2");
    expect(ip("::1")).toBe("0:0:0:0");
    expect(ip("2001:db8::1")).toBe("2001:db8:0:0");
    expect(ip("2001:db8:1:3::1")).not.toBe(ip("2001:db8:1:2::1"));
    expect(clientKey(new Request(BASE))).toBe("unknown");
    // Requests from other zones' Workers all arrive from one address, so they're told apart by zone.
    const worker_ = (zone: string) => clientKey(new Request(BASE, { headers: { "cf-connecting-ip": "2a06:98c0:3600::103", "cf-worker": zone } }));
    expect(worker_("one.example")).toBe("worker:one.example");
    expect(worker_("two.example")).not.toBe(worker_("one.example"));
    // Anyone else can send the header, and it changes nothing for them.
    expect(clientKey(new Request(BASE, { headers: { "cf-connecting-ip": "203.0.113.9", "cf-worker": "spoofed" } }))).toBe("203.0.113.9");
  });

  it("refuses a client over its general limit before doing any work, on every route", async () => {
    const general = limiter((key) => key === "ip:203.0.113.9");
    for (const path of ["/sign-in", "/mcp", "/.well-known/oauth-authorization-server", "/api/v1/me", "/oauth/token", "/api/auth/agent-configuration"]) {
      const res = await send(path, { headers: from("203.0.113.9") }, { RL_GENERAL: general.fake, AUTH_SECRET: "" });
      expect(res.headers.get("strict-transport-security"), path).toBe("max-age=31536000");
      if (path.startsWith("/.well-known/")) {
        expect(res.status, path).toBe(503);
        expect(res.headers.get("retry-after"), path).toBe("60");
      } else await expectLimitedFor(path, res);
    }
    expect((await send("/sign-in", { headers: from("203.0.113.10") }, { RL_GENERAL: general.fake })).status).toBe(200);
  });

  it("counts anonymous routes that store something exactly, each separately for each client", async () => {
    const routes = [["POST", "/sign-in", "sign-in"], ["POST", "/oauth/register", "oauth-register"], ["POST", "/oauth/token", "oauth-token"], ["POST", "/api/auth/agent/register", "agent-register"], ["POST", "/api/auth/sign-in/social", "auth"], ["POST", "/api/auth/sign-up/email", "auth"], ["GET", "/api/auth/callback/github", "auth"]] as const;
    for (const [method, path, route] of routes) {
      expect(sensitiveRoute(method, path), path).toBe(route);
      const ip = `198.51.100.${++counter % 250}${counter}`;
      const attempt = (address: string) => send(path, { method, redirect: "manual", headers: { ...from(address), origin: BASE, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined }, { STRICT_PER_MINUTE: "2" });
      expect((await attempt(ip)).status, path).not.toBe(429);
      expect((await attempt(ip)).status, path).not.toBe(429);
      await expectLimitedFor(path, await attempt(ip));
      expect((await attempt(`${ip}.other`)).status, `${path} other client`).not.toBe(429);
    }
    for (const [method, path] of [["GET", "/sign-in"], ["GET", "/oauth/register"], ["POST", "/mcp"], ["GET", "/api/auth/agent-configuration"], ["POST", "/api/auth/capability/execute"]]) expect(sensitiveRoute(method, path), path).toBeNull();
    // Each route has its own count for a client.
    const shared = `198.51.100.shared${++counter}`;
    const post_ = (path: string) => send(path, { method: "POST", headers: { ...from(shared), origin: BASE, "content-type": "application/json" }, body: "{}" }, { STRICT_PER_MINUTE: "1" });
    expect((await post_("/oauth/token")).status).not.toBe(429);
    expect((await post_("/oauth/token")).status).toBe(429);
    expect((await post_("/oauth/register")).status).not.toBe(429);
  });

  it("the strict count is exact under concurrency, and has a daily limit too", async () => {
    const ip = `198.51.100.burst${++counter}`;
    const attempt = (env: object) => send("/oauth/token", { method: "POST", headers: { ...from(ip), "content-type": "application/json" }, body: "{}" }, env);
    const statuses = await Promise.all(Array.from({ length: 12 }, () => attempt({ STRICT_PER_MINUTE: "5" })));
    expect(statuses.filter((res) => res.status === 429)).toHaveLength(7);
  });

  it("uses the real limits by default, whatever a bad setting says", async () => {
    for (const limits of [{ STRICT_PER_MINUTE: undefined, STRICT_PER_DAY: undefined }, { STRICT_PER_MINUTE: "abc", STRICT_PER_DAY: "abc" }, { STRICT_PER_MINUTE: "-5", STRICT_PER_DAY: "" }, { STRICT_PER_MINUTE: "0", STRICT_PER_DAY: "Infinity" }]) {
      const ip = `198.51.100.defaults${++counter}`;
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) statuses.push((await send("/oauth/token", { method: "POST", headers: { ...from(ip), "content-type": "application/json" }, body: "{}" }, limits)).status);
      expect(statuses.slice(0, 20).filter((status) => status === 429), JSON.stringify(limits)).toEqual([]);
      expect(statuses[20], JSON.stringify(limits)).toBe(429);
    }
    const stub = e.STRICT_COUNTER.get(e.STRICT_COUNTER.idFromName(unique("day")));
    await runInDurableObject(stub, (_: unknown, state: DurableObjectState) => state.storage.put("count", { minuteStart: Date.now(), minute: 0, dayStart: Date.now(), day: 499 }));
    expect(await stub.take(20, 500)).toBe(0);
    expect(await stub.take(20, 500)).toBeGreaterThan(60);
  });

  it("limits a day only where requests leave long-lived records, and says how long to wait", async () => {
    const lots = { STRICT_PER_MINUTE: "100", STRICT_PER_DAY: "1" };
    const attempt = (path: string, ip: string) => send(path, { method: "POST", headers: { ...from(ip), origin: BASE, "content-type": "application/json" }, body: "{}" }, lots);
    for (const path of ["/oauth/register", "/api/auth/agent/register"]) {
      const ip = `198.51.100.day${++counter}`;
      expect((await attempt(path, ip)).status, path).not.toBe(429);
      const refused = await attempt(path, ip);
      expect(refused.status, path).toBe(429);
      expect(Number(refused.headers.get("retry-after")), path).toBeGreaterThan(86_000);
    }
    // A token refresh or sign-in isn't: refreshes must keep working all day, for everyone on an address.
    for (const path of ["/oauth/token", "/sign-in", "/api/auth/sign-in/social"]) {
      const ip = `198.51.100.noday${++counter}`;
      for (let i = 0; i < 3; i++) expect((await attempt(path, ip)).status, path).not.toBe(429);
    }
    // A minute's refusal says when that minute ends.
    const ip = `198.51.100.minute${++counter}`;
    const once = () => send("/oauth/token", { method: "POST", headers: { ...from(ip), "content-type": "application/json" }, body: "{}" }, { STRICT_PER_MINUTE: "1" });
    expect((await once()).status).not.toBe(429);
    const limited = await once();
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(60);
  });

  it("the strict counter resets by window, and removes itself after a day", async () => {
    const stub = e.STRICT_COUNTER.get(e.STRICT_COUNTER.idFromName(unique("window")));
    expect(await stub.take(1, 2)).toBe(0);
    expect(await stub.take(1, 2)).toBeGreaterThan(0);
    const age = (minuteMs: number, dayMs: number) => runInDurableObject(stub, async (_: unknown, state: DurableObjectState) => {
      const count = await state.storage.get<any>("count");
      await state.storage.put("count", { ...count, minuteStart: Date.now() - minuteMs, dayStart: Date.now() - dayMs });
    });
    await age(61_000, 1000);
    expect(await stub.take(1, 2)).toBe(0);
    await age(61_000, 1000);
    expect(await stub.take(1, 2)).toBeGreaterThan(60);
    await age(61_000, 86_401_000);
    expect(await stub.take(1, 2)).toBe(0);
    expect(await runInDurableObject(stub, (_: unknown, state: DurableObjectState) => state.storage.getAlarm())).not.toBeNull();
    // A live count waits for its day to end, and an old one is deleted.
    await age(1000, 1000);
    await runInDurableObject(stub, async (_: unknown, state: DurableObjectState) => void (await state.storage.setAlarm(Date.now() + 3_600_000)));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, (_: unknown, state: DurableObjectState) => state.storage.get("count"))).toBeDefined();
    await age(1000, 86_401_000);
    await runInDurableObject(stub, async (_: unknown, state: DurableObjectState) => void (await state.storage.setAlarm(Date.now() + 3_600_000)));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, (_: unknown, state: DurableObjectState) => state.storage.get("count"))).toBeUndefined();
  });

  it("keeps working if the strict counter fails", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const res = await send("/oauth/token", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, { STRICT_COUNTER: { idFromName() { throw new Error("down"); } } });
      expect(res.status).not.toBe(429);
    } finally {
      console.error = quiet;
    }
  });

  it("limits long return paths and host names, which cost more stored than sent", async () => {
    expect(safeNext(`/claim?x=${"a".repeat(8 * 1024)}`)).toBe("/signed-in");
    const longest = `/authorize?state=${"a".repeat(4 * 1024)}`;
    expect(safeNext(longest)).toBe(longest);
    const [host, key] = [await generateKeypair(), await generateKeypair()];
    const register = async (hostName: string) => post("/api/auth/agent/register", { name: "x", mode: "delegated", capabilities: ["get_identity"], preferred_method: "device_authorization" }, { authorization: `Bearer ${await signHostJWT({ hostKeypair: host, audience: BASE, agentPublicKey: key.publicKey, hostName } as never)}` });
    expect((await register("h".repeat(201))).status).toBe(400);
    expect((await register("h".repeat(200))).status).toBe(200);
    // Padding a key doesn't change its thumbprint, but it's stored.
    const [padHost, padAgent] = [await generateKeypair(), await generateKeypair()];
    const padded = await post("/api/auth/agent/register", { name: "x", mode: "delegated", capabilities: ["get_identity"], preferred_method: "device_authorization" }, { authorization: `Bearer ${await signHostJWT({ hostKeypair: padHost, audience: BASE, agentPublicKey: { ...padAgent.publicKey, pad: "p".repeat(2000) }, hostName: "h" } as never)}` });
    expect(padded.status).toBe(400);
    expect((await padded.json<any>()).error.code).toBe("invalid_public_key");
  });

  it("the schedule runs the cleanup", async () => {
    const identifier = unique("scheduled");
    const old = new Date(Date.now() - 86_400_000).toISOString();
    await e.DB.prepare("INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, 'x', ?, ?, ?)").bind(unique("v"), identifier, old, old, old).run();
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({} as ScheduledController, e, { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM verification WHERE identifier = ?").bind(identifier).first()).toEqual({ n: 0 });
  });

  it("clears abandoned registrations and expired state, and nothing else", async () => {
    const owner = await signUp();
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const abandoned = await registerAgent();
    const stillLive = await registerAgent();
    const claimed = await claimedAgent(owner);
    const recent = await registerAgent();
    await e.DB.prepare("UPDATE agent SET createdAt = ? WHERE id IN (?, ?, ?)").bind(old, abandoned.pluginId, stillLive.pluginId, claimed.pluginId).run();
    await e.DB.prepare("UPDATE agentHost SET createdAt = ? WHERE id IN (?, ?)").bind(old, abandoned.registered.host_id, stillLive.registered.host_id).run();
    await e.DB.prepare("UPDATE approvalRequest SET expiresAt = ? WHERE agentId IN (?, ?)").bind(old, abandoned.pluginId, recent.pluginId).run();
    await e.DB.prepare("INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, 'x', ?, ?, ?), (?, ?, 'x', ?, ?, ?)").bind(unique("v"), unique("gone"), old, old, old, unique("v"), "keep-me", new Date(Date.now() + 60_000).toISOString(), old, old).run();
    expect(await cleanUp(e)).toBeGreaterThanOrEqual(1);
    const exists = async (id: string) => (await e.DB.prepare("SELECT id FROM agent WHERE id = ?").bind(id).first()) !== null;
    expect(await exists(abandoned.pluginId)).toBe(false);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM agentCapabilityGrant WHERE agentId = ?").bind(abandoned.pluginId).first()).toEqual({ n: 0 });
    expect(await e.DB.prepare("SELECT count(*) AS n FROM approvalRequest WHERE agentId = ?").bind(abandoned.pluginId).first()).toEqual({ n: 0 });
    expect(await e.DB.prepare("SELECT count(*) AS n FROM agentHost WHERE id = ?").bind(abandoned.registered.host_id).first()).toEqual({ n: 0 });
    // A live code, a claimed agent and a recent registration all stay.
    expect(await exists(stillLive.pluginId)).toBe(true);
    expect(await exists(claimed.pluginId)).toBe(true);
    expect(await exists(recent.pluginId)).toBe(true);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM agentHost WHERE id = ?").bind(stillLive.registered.host_id).first()).toEqual({ n: 1 });
    expect((await execute(claimed, "get_identity")).status).toBe(200);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM verification WHERE identifier = 'keep-me'").first()).toEqual({ n: 1 });
    expect(await e.DB.prepare("SELECT count(*) AS n FROM verification WHERE expiresAt < ?").bind(new Date().toISOString()).first()).toEqual({ n: 0 });
    // Only old, unowned, unclaimed registrations with no live code go, in batches.
    const shape = async (changes: string, ...values: unknown[]) => {
      const agent = await registerAgent();
      await e.DB.prepare("UPDATE approvalRequest SET expiresAt = ? WHERE agentId = ?").bind(old, agent.pluginId).run();
      await e.DB.prepare(`UPDATE agent SET createdAt = ?${changes} WHERE id = ?`).bind(old, ...values, agent.pluginId).run();
      return agent.pluginId;
    };
    const ownerUser = (await e.DB.prepare("SELECT userId FROM session WHERE token = ?").bind(decodeURIComponent(owner.cookie.split("=")[1]).split(".")[0]).first<{ userId: string }>())!.userId;
    const activeUnowned = await shape(", status = 'active'");
    const pendingOwned = await shape(", userId = ?", ownerUser);
    const twoHours = await registerAgent();
    await e.DB.prepare("UPDATE approvalRequest SET expiresAt = ? WHERE agentId = ?").bind(old, twoHours.pluginId).run();
    await e.DB.prepare("UPDATE agent SET createdAt = ? WHERE id = ?").bind(new Date(Date.now() - 2 * 3_600_000).toISOString(), twoHours.pluginId).run();
    const resolved = await registerAgent();
    await e.DB.prepare("UPDATE agent SET createdAt = ? WHERE id = ?").bind(old, resolved.pluginId).run();
    await e.DB.prepare("UPDATE approvalRequest SET status = 'approved', expiresAt = ? WHERE agentId = ?").bind(new Date(Date.now() + 60_000).toISOString(), resolved.pluginId).run();
    const [one, two] = [await shape(""), await shape("")];
    const total = async () => (await e.DB.prepare("SELECT count(*) AS n FROM agent").first<{ n: number }>())!.n;
    const before = await total();
    expect(await cleanUp(e, Date.now(), 1)).toBe(1);
    expect(await total()).toBe(before - 1);
    await cleanUp(e);
    expect(await exists(one)).toBe(false);
    expect(await exists(two)).toBe(false);
    expect(await exists(activeUnowned)).toBe(true);
    expect(await exists(pendingOwned)).toBe(true);
    expect(await exists(twoHours.pluginId)).toBe(true);
    expect(await exists(resolved.pluginId)).toBe(false);
    // A host stays if it's young, owned or active, or still has an agent.
    const hostShape = async (changes: string, ...values: unknown[]) => {
      const id = unique("host");
      await e.DB.prepare(`INSERT INTO agentHost (id, status, createdAt, updatedAt) VALUES (?, 'pending', ?, ?)`).bind(id, old, old).run();
      if (changes) await e.DB.prepare(`UPDATE agentHost SET ${changes} WHERE id = ?`).bind(...values, id).run();
      return id;
    };
    const hostGoes = await hostShape("");
    const hostYoung = await hostShape("createdAt = ?", new Date().toISOString());
    const hostOwned = await hostShape("userId = ?", ownerUser);
    const hostActive = await hostShape("status = 'active'");
    await cleanUp(e);
    const hostExists = async (id: string) => (await e.DB.prepare("SELECT id FROM agentHost WHERE id = ?").bind(id).first()) !== null;
    expect(await hostExists(hostGoes)).toBe(false);
    for (const id of [hostYoung, hostOwned, hostActive]) expect(await hostExists(id), id).toBe(true);
    // Coming back afterward starts again.
    const again = await registerAgent({ host: abandoned.host, keypair: abandoned.keypair });
    expect(again.registered.status).toBe("pending");
    expect((await claim(owner, again)).status).toBe(200);
  });

  it("limits each agent credential, and a limited agent can retry with the same token", async () => {
    const owner = await signUp();
    const agent = await claimedAgent(owner);
    const account = limiter(() => true);
    const jwt = await signAgentJWT({ agentKeypair: agent.keypair, agentId: agent.pluginId, audience: BASE, capabilities: ["get_identity"] });
    const run = (env: object) => send("/api/auth/capability/execute", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` }, body: JSON.stringify({ capability: "get_identity", arguments: {} }) }, env);
    const limited = await run({ RL_ACCOUNT: account.fake });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json<any>()).toMatchObject({ error: "rate_limited", message: "rate_limited" });
    expect(account.keys).toEqual([`agent:${agent.pluginId}`]);
    expect((await run({})).status).toBe(200);
    expect((await run({})).status).toBe(401);
  });

  it("limits each MCP credential", async () => {
    const owner = await signUp();
    const agent = await mcpAgent(owner);
    const account = limiter(() => true);
    const res = await send("/mcp", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }, { RL_ACCOUNT: account.fake });
    await expectLimited(res);
    expect(account.keys).toHaveLength(1);
    expect(account.keys[0]).toMatch(/^mcp:grant_/);
  });

  it("refuses a batch on MCP, so one request can't run many calls", async () => {
    const owner = await signUp();
    const agent = await mcpAgent(owner);
    const call_ = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_identity", arguments: {} } });
    const post_ = (body: unknown) => send("/mcp", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
    const batch = await post_([call_(1), call_(2)]);
    expect(batch.status).toBe(400);
    expect(await batch.json<any>()).toMatchObject({ error: { code: -32600 } });
    const single = await post_(call_(3));
    expect(single.status).toBe(200);
    // A body that isn't JSON still gets the protocol's own error.
    const garbled = await send("/mcp", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{not json" });
    expect(garbled.status).toBe(400);
    expect((await garbled.json<any>()).error.code).toBe(-32700);
    // The limit comes first, so a batch counts and gets refused as limited.
    const account = limiter(() => true);
    expect((await send("/mcp", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify([call_(4)]) }, { RL_ACCOUNT: account.fake })).status).toBe(429);
  });

  it("lists the repository tool only while managed repositories are on, exactly, and listing authorizes nothing (M5 step 6)", async () => {
    const owner = await signUp();
    const agent = await mcpAgent(owner);
    const headers = { authorization: `Bearer ${agent.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const tools = async (env: object) => {
      const res = await send("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }, env);
      expect(res.status).toBe(200);
      return ((await res.json<any>()).result.tools as { name: string }[]).map((t) => t.name);
    };
    // Off by default, and anything but exactly "true" is off.
    for (const value of [undefined, "", "1", "TRUE", "true ", "yes"]) expect(await tools({ MANAGED_REPOSITORIES: value }), String(value)).not.toContain("get_repo_access");
    expect(await tools({ MANAGED_REPOSITORIES: "true" })).toContain("get_repo_access");
    // Off, calling it by name is an unknown tool, and nothing reaches the API.
    const off = await send("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_repo_access", arguments: { workspace_id: "w", task_id: "t" } } }) });
    const refused = await off.json<any>();
    expect(refused.result?.isError ?? Boolean(refused.error)).toBe(true);
    expect(JSON.stringify(refused)).toContain("get_repo_access");
    // The same for merge_task (M5 step 7b): off, calling it answers exactly as calling a tool that doesn't exist does,
    // whatever is sent with it, so nothing about it can be told from the answer.
    const called = async (name: string) => {
      const res = await send("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: { workspace_id: "w", task_id: "t", submission_no: 1, commit_sha: "a".repeat(40), idempotency_key: "k" } } }) });
      return [res.status, (await res.text()).replaceAll(name, "<tool>")];
    };
    expect(await called("merge_task")).toEqual(await called("no_such_tool"));
    expect(await called("get_task_release_status")).toEqual(await called("no_such_tool"));
    expect((await called("merge_task"))[1]).toContain("<tool>");
    // Nothing else is ever gated, and the gated tool is a retry-safe command that names only the task.
    expect(capabilitiesFor({}).map((c) => c.name)).toEqual(CAPABILITIES.map((c) => c.name).filter((n) => !["get_repo_access", "merge_task", "get_task_release_status"].includes(n)));
    // The release status (M5 step 8) is listed the same way, and off, calling it answers exactly as a missing tool does.
    for (const value of [undefined, "", "1", "TRUE", "true ", "yes"]) expect(await tools({ MANAGED_REPOSITORIES: value }), String(value)).not.toContain("get_task_release_status");
    expect(await tools({ MANAGED_REPOSITORIES: "true" })).toContain("get_task_release_status");
    const status = capabilitiesFor({ MANAGED_REPOSITORIES: "true" }).find((c) => c.name === "get_task_release_status")!;
    expect([status.kind, status.method, Object.keys(status.fields ?? {})]).toEqual(["query", "GET", ["workspace_id", "task_id"]]);
    expect(toApiCall(status, { workspace_id: "w", task_id: "t", pr_number: 7, refresh: true })).toEqual({ method: "GET", path: "/v1/workspaces/w/tasks/t/release-status" });
    // The merge tool (M5 step 7b) is listed the same way: only with the switch exactly on. Off, no agent is offered one (AC-17).
    for (const value of [undefined, "", "1", "TRUE", "true ", "yes"]) expect(await tools({ MANAGED_REPOSITORIES: value }), String(value)).not.toContain("merge_task");
    expect(await tools({ MANAGED_REPOSITORIES: "true" })).toContain("merge_task");
    const merge = capabilitiesFor({ MANAGED_REPOSITORIES: "true" }).find((c) => c.name === "merge_task")!;
    expect([merge.kind, merge.method, merge.idempotent ?? false, Object.keys(merge.fields ?? {})]).toEqual(["command", "POST", false, ["workspace_id", "task_id", "submission_no", "commit_sha"]]);
    // It passes on the submission and the commit, and nothing that could name a repository or a pull request.
    expect(toApiCall(merge, { workspace_id: "w", task_id: "t", submission_no: 1, commit_sha: "a".repeat(40), pr_number: 7, repository_id: 1, merge_method: "squash", idempotency_key: "k" })).toEqual({ method: "POST", path: "/v1/workspaces/w/tasks/t/merge", body: JSON.stringify({ submission_no: 1, commit_sha: "a".repeat(40) }), idempotencyKey: "k" });
    const tool = capabilitiesFor({ MANAGED_REPOSITORIES: "true" }).find((c) => c.name === "get_repo_access")!;
    expect([tool.kind, tool.method, tool.idempotent, Object.keys(tool.fields ?? {})]).toEqual(["command", "POST", true, ["workspace_id", "task_id"]]);
    expect(toApiCall(tool, { workspace_id: "w", task_id: "t", repository_id: 1, installation_id: 2, permissions: { administration: "write" } })).toEqual({ method: "POST", path: "/v1/workspaces/w/tasks/t/repo-access", body: "{}", idempotencyKey: undefined });
    // A task's pull request (M5 step 7a) adds one field to submit_task and no capability. Off, the field isn't offered or passed on.
    const submit = (env: { MANAGED_REPOSITORIES?: string }) => capabilitiesFor(env).find((c) => c.name === "submit_task")!;
    for (const value of [undefined, "", "TRUE", "yes"]) expect(Object.keys(submit({ MANAGED_REPOSITORIES: value }).fields ?? {}), String(value)).not.toContain("pr_number");
    expect(Object.keys(submit({ MANAGED_REPOSITORIES: "true" }).fields ?? {})).toContain("pr_number");
    const args = { workspace_id: "w", task_id: "t", version: 2, note: "n", commit_sha: "a".repeat(40), pr_number: 7, idempotency_key: "k" };
    expect(JSON.parse(toApiCall(submit({}), args).body!)).toEqual({ version: 2, note: "n", commit_sha: "a".repeat(40) });
    expect(JSON.parse(toApiCall(submit({ MANAGED_REPOSITORIES: "true" }), args).body!)).toEqual({ version: 2, note: "n", commit_sha: "a".repeat(40), pr_number: 7 });
    for (const env of [{}, { MANAGED_REPOSITORIES: "true" }]) {
      for (const c of capabilitiesFor(env)) if (c.name !== "submit_task") expect(c).toBe(CAPABILITIES.find((x) => x.name === c.name));
    }
  });

  it("has managed repositories switched on for staging only in the Worker's configuration (M5 step 6)", () => {
    // The owner said "let's unblock m5 staging" on 2026-11-11. The top level, which these tests run on, stays off.
    const config = JSON.parse(e.TEST_WRANGLER.replace(/^\s*\/\/.*$/gm, ""));
    expect(config.vars?.MANAGED_REPOSITORIES).toBeUndefined();
    expect(Object.keys(config.env ?? {})).toContain("staging");
    for (const [name, environment] of Object.entries<any>(config.env ?? {})) expect(environment.vars?.MANAGED_REPOSITORIES, name).toBe(name === "staging" ? "true" : undefined);
    expect(e.TEST_WRANGLER.match(/"MANAGED_REPOSITORIES"/g)).toHaveLength(1);
    // The webhook secret is the owner's to set, and never a variable in this file.
    expect(e.TEST_WRANGLER).not.toContain('"GITHUB_WEBHOOK_SECRET"');
    expect((e as any).MANAGED_REPOSITORIES).toBeUndefined();
  });

  it("caps MCP bodies at the size the SDK allows, even with no declared length", async () => {
    const owner = await signUp();
    const agent = await mcpAgent(owner);
    const headers = { authorization: `Bearer ${agent.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const huge = "x".repeat(4 * 1024 * 1024 + 1);
    expect((await send("/mcp", { method: "POST", headers, body: huge })).status).toBe(413);
    expect((await send("/mcp", { method: "POST", headers, body: new Blob([huge]).stream(), duplex: "half" } as RequestInit)).status).toBe(413);
    // A huge batch is stopped by size, before anything parses it.
    expect((await send("/mcp", { method: "POST", headers, body: `[${"1,".repeat(2 * 1024 * 1024 + 1)}1]` })).status).toBe(413);
  });

  it("caps what an anonymous caller can have stored, even with no declared length", async () => {
    const big = JSON.stringify({ redirect_uris: ["https://client.test/cb"], client_name: "x".repeat(20_000), token_endpoint_auth_method: "none" });
    const declared = await send("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect(declared.status).toBe(413);
    const stream = new Blob([big]).stream();
    const chunked = await send("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect(chunked.status).toBe(413);
    expect((await send("/api/auth/agent/register", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x" }, body: big })).status).toBe(413);
    // Sign-in stores its return path and extra data, so it's capped too.
    const padded = "x".repeat(20_000);
    for (const [path, init] of [
      ["/sign-in", { method: "POST", headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ provider: "github", next: `/claim?x=${padded}` }) }],
      ["/api/auth/sign-in/social", { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ provider: "github", additionalData: { padded } }) }],
      ["/api/auth/sign-up/email", { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.test", password: "local-test-password-123", name: padded }) }],
    ] as const) {
      const res = await send(path, init as RequestInit);
      expect(res.status, path).toBe(413);
      expect(res.headers.get("strict-transport-security"), path).toBe("max-age=31536000");
      expect((await res.json<any>()).message, path).toBe("body_too_large");
    }
    // A registration's host name is in its token, so the header counts.
    expect((await send("/api/auth/agent/register", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${"x".repeat(17_000)}` }, body: "{}" })).status).toBe(413);
    // The limit comes first, so an oversized request still counts.
    expect((await send("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: big }, { STRICT_PER_MINUTE: "0" })).status).toBe(429);
    // A body arriving in pieces is put back together intact.
    const encoder = new TextEncoder();
    const pieces = encoder.encode(JSON.stringify({ redirect_uris: ["https://client.test/cb"], client_name: "in pieces", token_endpoint_auth_method: "none" }));
    const inPieces = new ReadableStream({ start(controller) { for (let i = 0; i < pieces.length; i += 20) controller.enqueue(pieces.slice(i, i + 20)); controller.close(); } });
    const assembled = await send("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: inPieces, duplex: "half" } as RequestInit);
    expect(assembled.status).toBe(201);
    expect((await assembled.json<any>()).client_name).toBe("in pieces");
    // Normal registrations are well under it, and still work.
    expect((await post("/oauth/register", { redirect_uris: ["https://client.test/cb"], client_name: "normal", token_endpoint_auth_method: "none" })).status).toBe(201);
  });

  it("limits code guessing on the claim page and form, for each person", async () => {
    const owner = await signUp();
    const agent = await registerAgent();
    const sensitive = limiter((key) => key.startsWith("claim:"));
    const limits = { RL_SENSITIVE: sensitive.fake };
    await expectLimited(await send(`/claim?agent_id=${agent.pluginId}&code=${agent.userCode}`, { headers: { cookie: owner.cookie } }, limits));
    await expectLimited(await send("/claim", jsonPost({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org }, { cookie: owner.cookie }), limits));
    const person = (await e.DB.prepare("SELECT userId FROM session WHERE token = ?").bind(decodeURIComponent(owner.cookie.split("=")[1]).split(".")[0]).first<{ userId: string }>())!.userId;
    expect(sensitive.keys).toEqual([`claim:${person}`, `claim:${person}`]);
    expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(agent.pluginId).first()).toEqual({ status: "pending" });
  });

  it("limits consent, organizations, rooms and invitations for each person, and not their reads", async () => {
    const owner = await signUp();
    const sensitive = limiter(() => true);
    const limits = { RL_SENSITIVE: sensitive.fake };
    const { query } = await authorizeQuery();
    await expectLimited(await send("/authorize", { method: "POST", headers: { cookie: owner.cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ oauth_query: query, org_id: owner.org }) }, limits));
    await expectLimited(await send("/api/orgs", jsonPost({ name: "x" }, { cookie: owner.cookie }), limits));
    await expectLimited(await send("/api/v1/workspaces", jsonPost({ name: "x" }, { cookie: owner.cookie, "idempotency-key": unique("k") }), limits));
    await expectLimited(await send("/api/v1/workspaces/ws_x/invitations", jsonPost({}, { cookie: owner.cookie, "idempotency-key": unique("k") }), limits));
    await expectLimited(await send("/api/v1/invitations/accept", jsonPost({}, { cookie: owner.cookie }), limits));
    const person = (await e.DB.prepare("SELECT userId FROM session WHERE token = ?").bind(decodeURIComponent(owner.cookie.split("=")[1]).split(".")[0]).first<{ userId: string }>())!.userId;
    expect(new Set(sensitive.keys)).toEqual(new Set([`consent:${person}`, `create-org:${person}`, `invite-or-create:${person}`]));
    // Reads and the consent page don't count against these.
    const before = sensitive.keys.length;
    expect((await send("/api/v1/me", { headers: { cookie: owner.cookie } }, limits)).status).toBe(200);
    expect((await send("/api/orgs", { headers: { cookie: owner.cookie } }, limits)).status).toBe(200);
    expect((await send(`/authorize${query}`, { headers: { cookie: owner.cookie } }, limits)).status).toBe(200);
    expect((await send("/api/v1/workspaces", { headers: { cookie: owner.cookie } }, limits)).status).toBe(200);
    // Ordinary room work isn't sensitive either: it's counted only by the person's overall limit.
    expect((await send("/api/v1/workspaces/ws_none/tasks", jsonPost({ title: "x", instructions: "y" }, { cookie: owner.cookie, "idempotency-key": unique("k") }), limits)).status).not.toBe(429);
    expect(sensitive.keys).toHaveLength(before);
  });

  it("limits each person's dashboard calls overall", async () => {
    const owner = await signUp();
    const account = limiter(() => true);
    await expectLimited(await send("/api/v1/me", { headers: { cookie: owner.cookie } }, { RL_ACCOUNT: account.fake }));
    await expectLimited(await send("/api/orgs", { headers: { cookie: owner.cookie } }, { RL_ACCOUNT: account.fake }));
    const person = (await e.DB.prepare("SELECT userId FROM session WHERE token = ?").bind(decodeURIComponent(owner.cookie.split("=")[1]).split(".")[0]).first<{ userId: string }>())!.userId;
    expect(account.keys[0]).toBe(`person:${person}`);
  });

  it("keeps working if a limiter fails", async () => {
    const broken: RateLimit = { limit: async () => { throw new Error("limiter down"); } };
    const quiet = console.error;
    let logged = 0;
    console.error = () => void logged++;
    try {
      for (let i = 0; i < 3; i++) expect((await send("/sign-in", { headers: from("203.0.113.9") }, { RL_GENERAL: broken, RL_SENSITIVE: broken, RL_ACCOUNT: broken })).status).toBe(200);
    } finally {
      console.error = quiet;
    }
    // A failing limiter can't be used to flood the logs.
    expect(logged).toBeLessThanOrEqual(1);
  });

  it("every deployed environment has all three limits, with its own counters", () => {
    const config = JSON.parse(e.TEST_WRANGLER.replace(/^\s*\/\/.*$/gm, ""));
    for (const environment of [config, ...Object.values<any>(config.env)]) {
      expect(environment.durable_objects.bindings.map((b: any) => b.class_name)).toContain("StrictCounter");
      expect(environment.triggers.crons).toHaveLength(1);
    }
    expect(config.migrations.flatMap((m: any) => m.new_sqlite_classes)).toContain("StrictCounter");
    const expected = { RL_GENERAL: 600, RL_ACCOUNT: 120, RL_SENSITIVE: 20 };
    const ids = new Set<string>();
    for (const environment of [config, ...Object.values<any>(config.env)]) {
      const found = Object.fromEntries(environment.ratelimits.map((r: any) => [r.name, r.simple.limit]));
      expect(found).toEqual(expected);
      for (const r of environment.ratelimits) {
        expect(r.simple.period).toBe(60);
        expect(r.namespace_id).toMatch(/^[1-9][0-9]*$/);
        ids.add(r.namespace_id);
      }
    }
    expect(ids.size).toBe(3 * (1 + Object.keys(config.env).length));
  });
});

describe("HTTPS only", () => {
  it("redirects reads to HTTPS, keeping the path, and never serves discovery over HTTP", async () => {
    for (const path of ["/sign-in?next=%2Fclaim", "/.well-known/oauth-authorization-server", "/.well-known/agent-configuration"]) {
      const res = await SELF.fetch(`http://gateway.test${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(301);
      expect(res.headers.get("location"), path).toBe(`${BASE}${path}`);
      expect(await res.text(), path).toBe("");
    }
  });

  it("can't be made to redirect to another host", async () => {
    for (const path of ["//evil.test/x", "///evil.test/", "/\\evil.test/x", "/.//evil.test/x", "/x/..//evil.test", "//evil.test:443@x/", "/%2f/evil.test", "/%5cevil.test", "/%09/evil.test", "/@evil.test"]) {
      const res = await worker.fetch(new Request(`http://gateway.test${path}`), e as never, { waitUntil() {}, passThroughOnException() {} } as never);
      expect(res.status, path).toBe(301);
      const location = new URL(res.headers.get("location")!);
      expect(location.origin, path).toBe(BASE);
      expect(location.username + location.password, path).toBe("");
    }
  });

  it("redirects HEAD too, and refuses a preflight", async () => {
    const head = await SELF.fetch("http://gateway.test/sign-in", { method: "HEAD", redirect: "manual" });
    expect(head.status).toBe(301);
    expect((await SELF.fetch("http://gateway.test/mcp", { method: "OPTIONS", redirect: "manual" })).status).toBe(400);
  });

  it("refuses anything sent with a body over HTTP, rather than acting on it", async () => {
    for (const [method, path] of [["POST", "/oauth/token"], ["POST", "/mcp"], ["POST", "/api/auth/capability/execute"], ["PUT", "/api/v1/x"], ["DELETE", "/api/v1/x"]]) {
      const res = await SELF.fetch(`http://gateway.test${path}`, { method, redirect: "manual", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status, path).toBe(400);
      expect((await res.json<any>()).error.code, path).toBe("https_required");
    }
  });

  it("tells browsers to stay on HTTPS, and keeps every other header", async () => {
    const page = await call("/sign-in");
    expect(page.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const started = await call("/sign-in", { method: "POST", headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: "provider=github" });
    expect(started.status).toBe(302);
    expect(started.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(started.headers.getSetCookie().length).toBeGreaterThan(0);
    const mcp = await call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain("resource_metadata");
    expect(mcp.headers.get("strict-transport-security")).toBe("max-age=31536000");
    // Wrapping a response must keep every cookie, and sign-out sets several.
    const person = await signUp();
    const out = await call("/api/auth/sign-out", { method: "POST", headers: { origin: BASE, cookie: person.cookie, "content-type": "application/json" }, body: "{}" });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().length).toBeGreaterThan(1);
    expect(out.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("leaves a local deployment on HTTP alone", async () => {
    const local = await worker.fetch(new Request("http://localhost:8787/sign-in"), { ...e, BASE_URL: "http://localhost:8787" } as never, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(local.status).toBe(200);
    expect(local.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("sign-in and claim pages", () => {
  const form = (fields: Record<string, string>, headers: Record<string, string> = {}, path = "/sign-in") =>
    call(path, { method: "POST", headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });

  it("only returns people to our own pages", () => {
    expect(safeNext("/authorize?client_id=x&state=y")).toBe("/authorize?client_id=x&state=y");
    expect(safeNext("/claim?agent_id=a&code=b")).toBe("/claim?agent_id=a&code=b");
    for (const bad of ["https://evil.test/authorize", "//evil.test/authorize", "/\\evil.test/claim", "/api/v1/me", "/authorize/../api/x", "javascript:alert(1)", "", null, undefined]) expect(safeNext(bad), String(bad)).toBe("/signed-in");
  });

  it("offers configured providers with no script, and escapes where it returns to", async () => {
    const res = await call(`/sign-in?next=${encodeURIComponent(`/claim?code="><script>alert(1)</script>`)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const html = await res.text();
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain("Continue with Google");
    expect(html).not.toContain("<script>");
    const away = await (await call(`/sign-in?next=${encodeURIComponent("https://evil.test/x")}`)).text();
    expect(away).not.toContain("evil.test");
    expect(away).toContain('value="/signed-in"');
    expect(await (await call("/signed-in")).text()).toContain("signed in");
  });

  it("says when sign-in failed, in its own words, and says so when nothing is set up", async () => {
    const failed = await (await call(`/sign-in?error=${encodeURIComponent("<b>call 555-0100</b>")}&next=${encodeURIComponent("/claim?agent_id=a&code=b")}`)).text();
    expect(failed).toContain("didn't finish");
    expect(failed).not.toContain("555-0100");
    expect(failed).toContain("agent_id=a");
    expect(await (await call("/sign-in")).text()).not.toContain("didn't finish");
    const bare = await worker.fetch(new Request(`${BASE}/sign-in`), { ...e, GITHUB_CLIENT_ID: undefined } as never, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(bare.status).toBe(503);
  });

  it("a callback with a bad state comes back to sign-in, not a dead end", async () => {
    const res = await call("/api/auth/callback/github?code=x&state=forged");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/sign-in?error=");
  });

  it("won't run without a secret, join accounts by email, or create a user from an unverified email", async () => {
    expect(() => createAuth({ ...e, AUTH_SECRET: "" })).toThrow("AUTH_SECRET");
    // The flag can't switch this off on a real hostname.
    const real = createAuth({ ...e, BASE_URL: "https://gateway.podster.dev", ENABLE_PASSWORD_SIGNIN: "true" }).options as any;
    expect(real.account.accountLinking.disableImplicitLinking).toBe(true);
    const before = real.databaseHooks.user.create.before;
    expect(await before({ email: "a@example.test", emailVerified: false })).toBe(false);
    expect(await before({ email: "a@example.test", emailVerified: true })).toBeUndefined();
    // Not even a provider vouching for it gets an address on the test people's domain.
    expect(await before({ email: "a@e2e.podster.invalid", emailVerified: true })).toBe(false);
  });

  it("starts a provider's sign-in from a form on our own page only", async () => {
    const started = await form({ provider: "github", next: "/claim?agent_id=a&code=b" });
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/github`);
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(started.headers.getSetCookie().length).toBeGreaterThan(0);
    // Sign-in remembers where to return, and where to go if it fails.
    const stored = await e.DB.prepare("SELECT value FROM verification WHERE identifier LIKE ?").bind(`%${location.searchParams.get("state")}`).first<{ value: string }>();
    expect(stored?.value).toContain(`${BASE}/claim?agent_id=a&code=b`);
    expect(stored?.value).toContain(`${BASE}/sign-in?next=${encodeURIComponent("/claim?agent_id=a&code=b")}`);
    const offsite = await form({ provider: "github", next: "https://evil.test/claim" });
    const offsiteState = new URL(offsite.headers.get("location")!).searchParams.get("state");
    const offsiteStored = await e.DB.prepare("SELECT value FROM verification WHERE identifier LIKE ?").bind(`%${offsiteState}`).first<{ value: string }>();
    expect(offsiteStored?.value).not.toContain("evil.test");
    expect(offsiteStored?.value).toContain(`${BASE}/signed-in`);
    expect((await call("/sign-in", { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    expect((await form({ provider: "github" }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await call("/sign-in", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "provider=github" })).status).toBe(403);
    expect((await form({ provider: "google" })).status).toBe(400);
    expect((await form({ provider: "evil" })).status).toBe(400);
  });

  it("sends a signed-out person to sign in and back to the claim", async () => {
    const res = await call("/claim?agent_id=a&code=b");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent("/claim?agent_id=a&code=b")}`);
  });

  it("an agent's approval link leads to a page that connects it", async () => {
    const owner = await signUp();
    const agent = await registerAgent();
    const link = new URL(agent.registered.approval.verification_uri_complete);
    const res = await call(link.pathname + link.search, { headers: { cookie: owner.cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<strong>agent</strong>");
    expect(html).toContain(agent.userCode);
    expect(html).toContain(owner.org);
    // Opening the page approves nothing.
    expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(agent.pluginId).first()).toEqual({ status: "pending" });
    const connected = await form({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org, name: "From the page", link_agent_id: "" }, { cookie: owner.cookie }, "/claim");
    expect(connected.status).toBe(200);
    expect(connected.headers.get("content-type")).toContain("text/html");
    expect(await connected.text()).toContain("Your agent is connected");
    expect((await execute(agent, "get_identity")).data).toMatchObject({ name: "From the page", status: "active" });
  });

  it("the claim page reveals nothing without the right code, and escapes what it's given", async () => {
    const owner = await signUp();
    const agent = await registerAgent();
    const wrong = await call(`/claim?agent_id=${agent.pluginId}&code=${encodeURIComponent("CALL 555-0100")}`, { headers: { cookie: owner.cookie } });
    expect(wrong.status).toBe(404);
    const wrongHtml = await wrong.text();
    expect(wrongHtml).not.toContain("<strong>agent</strong>");
    expect(wrongHtml).not.toContain("555-0100");
    expect(wrongHtml).not.toContain("<form");
    const hostile = await (await call(`/claim?agent_id=${encodeURIComponent(`"><script>x</script>`)}&code=${encodeURIComponent(`<script>y</script>`)}`, { headers: { cookie: owner.cookie } })).text();
    expect(hostile).not.toContain("<script>");
    const refused = await form({ agent_id: agent.pluginId, user_code: "AAAA-AAAA", org_id: owner.org }, { cookie: owner.cookie }, "/claim");
    expect(refused.status).toBe(403);
    const refusedText = await refused.text();
    expect(refusedText).toContain("connect this agent");
    expect(refusedText).toContain("may be wrong or expired");
    expect(refusedText).not.toContain("at most 200 bytes");
    expect((await form({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org }, { cookie: owner.cookie, origin: "https://evil.test" }, "/claim")).status).toBe(403);
  });

  it("refuses a credential whose connecting admin left, and another admin can connect a new one to the agent", async () => {
    const stays = await signUp();
    const team = (await dash(stays, "POST", "/orgs", { name: "Team" })).body.id as string;
    const link = (await dash(stays, "POST", `/orgs/${team}/invitations`, { role: "admin" })).body.token as string;
    const leaving = await signUp();
    expect((await dash(leaving, "POST", "/org-invitations/accept", { token: link })).status).toBe(200);
    const agent = await claimedAgent({ ...leaving, org: team });
    expect((await execute(agent, "get_identity")).status).toBe(200);
    expect((await dash(stays, "DELETE", `/orgs/${team}/members/${(await dash(leaving, "GET", "/v1/me")).body.id}`)).status).toBe(200);
    const refused = await execute(agent, "get_identity");
    expect([refused.status, refused.code]).toEqual([403, "credential_owner_left"]);
    expect((await dash(stays, "GET", "/agents")).body.agents.find((a: any) => a.id === agent.id).credentials_owner_left).toBe(1);
    const replacement = await registerAgent();
    expect((await claim({ ...stays, org: team }, replacement, { link_agent_id: agent.id })).status).toBe(200);
    const working = await execute(replacement, "get_identity");
    expect([working.status, working.data?.id]).toEqual([200, agent.id]);
    expect((await execute(agent, "get_identity")).status).toBe(403);
  });

  it("doesn't bring an Agent Auth credential back when its admin rejoins, and a new one takes over", async () => {
    const stays = await signUp();
    const team = (await dash(stays, "POST", "/orgs", { name: "Team" })).body.id as string;
    const invite = async (role: string) => (await dash(stays, "POST", `/orgs/${team}/invitations`, { role })).body.token as string;
    const person = await signUp();
    const join = async (role: string) => expect((await dash(person, "POST", "/org-invitations/accept", { token: await invite(role) })).status).toBe(200);
    const personId = (await dash(person, "GET", "/v1/me")).body.id as string;
    await join("admin");
    const inTeam = { ...person, org: team };
    const agent = await claimedAgent(inTeam);
    expect((await execute(agent, "get_identity")).status).toBe(200);
    const leftBehind = async () => (await dash(stays, "GET", "/agents")).body.agents.find((a: any) => a.id === agent.id).credentials_owner_left;
    expect((await dash(stays, "DELETE", `/orgs/${team}/members/${personId}`)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await join("member");
    const refused = await execute(agent, "get_identity");
    expect([refused.status, refused.code]).toEqual([403, "credential_owner_left"]);
    expect(await leftBehind()).toBe(1);
    // Neither becoming an admin again nor repeating the claim revives this key.
    expect((await claim(inTeam, agent)).status).toBe(403);
    expect((await dash(stays, "PUT", `/orgs/${team}/members/${personId}`, { role: "admin" })).status).toBe(200);
    expect((await claim(inTeam, agent)).status).toBe(403);
    expect((await execute(agent, "get_identity")).status).toBe(403);
    const replacement = await registerAgent();
    expect((await claim(inTeam, replacement, { link_agent_id: agent.id })).status).toBe(200);
    const working = await execute(replacement, "get_identity");
    expect([working.status, working.data?.id]).toEqual([200, agent.id]);
  });

  it("keeps an MCP credential off for a rejoined member, and renews it when they consent again as an admin", async () => {
    const stays = await signUp();
    const team = (await dash(stays, "POST", "/orgs", { name: "Team" })).body.id as string;
    const person = await signUp();
    const invite = async () => (await dash(stays, "POST", `/orgs/${team}/invitations`, { role: "admin" })).body.token as string;
    const personId = (await dash(person, "GET", "/v1/me")).body.id as string;
    expect((await dash(person, "POST", "/org-invitations/accept", { token: await invite() })).status).toBe(200);
    const inTeam = { ...person, org: team };
    const client = await authorizeQuery();
    const first = await mcpAgent(inTeam, {}, client);
    const externalId = (await e.DB.prepare("SELECT external_id FROM identity_link WHERE agent_id = ?").bind(first.id).first<{ external_id: string }>())!.external_id;
    // The API is told who linked the credential and when, so A2A sends to an endpoint they set stop once they leave.
    const linked = await e.DB.prepare("SELECT created_at FROM identity_link WHERE external_id = ?").bind(externalId).first<{ created_at: number }>();
    expect(await resolveAgent(e, "mcp_oauth", externalId)).toMatchObject({ linker: { person: personId, since: linked!.created_at } });
    expect((await dash(stays, "DELETE", `/orgs/${team}/members/${personId}`)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect((await dash(person, "POST", "/org-invitations/accept", { token: await invite() })).status).toBe(200);
    await expect(resolveAgent(e, "mcp_oauth", externalId)).rejects.toThrow("credential_owner_left");
    // A member can't consent, so it stays off until an admin does.
    expect((await dash(stays, "PUT", `/orgs/${team}/members/${personId}`, { role: "member" })).status).toBe(200);
    expect((await approve(inTeam, client.query, {})).status).toBe(403);
    await expect(resolveAgent(e, "mcp_oauth", externalId)).rejects.toThrow("credential_owner_left");
    expect((await dash(stays, "PUT", `/orgs/${team}/members/${personId}`, { role: "admin" })).status).toBe(200);
    const again = await approve(inTeam, client.query, {});
    expect(again.status).toBe(302);
    expect(await resolveAgent(e, "mcp_oauth", externalId)).toMatchObject({ id: first.id, org: team });
    const entries = (await dash(stays, "GET", `/orgs/${team}/audit`)).body.entries.filter((row: any) => row.action === "credential.reconnected");
    expect(entries.map((row: any) => [row.actor_id, row.target_id])).toEqual([[personId, first.id]]);
  });

  it("only offers organizations the person administers", async () => {
    const [a, member] = [await signUp(), await signUp()];
    const me = await (await dashboard(member, "GET", "/v1/me")).json<any>();
    await e.DB.prepare("INSERT INTO org_member (org_id, person_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(a.org, me.id, Date.now()).run();
    const agent = await registerAgent();
    const page = () => call(`/claim?agent_id=${agent.pluginId}&code=${agent.userCode}`, { headers: { cookie: member.cookie } });
    const html = await (await page()).text();
    expect(html).toContain(member.org);
    expect(html).not.toContain(a.org);
    // Someone who administers nothing is told so.
    await e.DB.prepare("DELETE FROM org_member WHERE person_id = ? AND org_id = ?").bind(me.id, member.org).run();
    expect((await page()).status).toBe(403);
  });

  it("escapes names from agents and organizations, and lists only the person's own agents", async () => {
    const [owner, other] = [await signUp(), await signUp()];
    const orgId = (await dash(owner, "POST", "/orgs", { name: "<u>org</u>" })).body.id as string;
    const mine = await registerAgent();
    expect((await claim(owner, mine, { org_id: orgId, name: "<i>mine</i>" })).status).toBe(200);
    const theirs = await claimedAgent(other);
    const [host, key] = [await generateKeypair(), await generateKeypair()];
    const jwt = await signHostJWT({ hostKeypair: host, audience: BASE, agentPublicKey: key.publicKey, hostName: "h" } as never);
    const registered = await (await post("/api/auth/agent/register", { name: "<b>Podster</b>", mode: "delegated", capabilities: ["get_identity"], preferred_method: "device_authorization" }, { authorization: `Bearer ${jwt}` })).json<any>();
    // The plugin cleans names when it stores them, so this checks our page doesn't rely on that.
    await e.DB.prepare("UPDATE agent SET name = ? WHERE id = ?").bind("<b>Podster</b>", registered.agent_id).run();
    const html = await (await call(`/claim?agent_id=${registered.agent_id}&code=${registered.approval.user_code}`, { headers: { cookie: owner.cookie } })).text();
    for (const raw of ["<u>org</u>", "<i>mine</i>", "<b>Podster</b>"]) expect(html, raw).not.toContain(raw);
    expect(html).toContain("&#60;u&#62;org");
    expect(html).toContain("&#60;i&#62;mine");
    expect(html).not.toContain(theirs.id);
  });

  it("a failure on our side says so, and reloading finishes the claim", async () => {
    const owner = await signUp();
    const agent = await registerAgent();
    const body = new URLSearchParams({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org, link_agent_id: "" });
    const headers = { origin: BASE, cookie: owner.cookie, "content-type": "application/x-www-form-urlencoded" };
    const down = { ...e, API: { fetch: () => Promise.reject(new Error("no such service")) } } as never;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
    const failed = await worker.fetch(new Request(`${BASE}/claim`, { method: "POST", headers, body }), down, ctx);
    expect(failed.status).toBe(502);
    const text = await failed.text();
    expect(text).toContain("Reload this page");
    expect(text).not.toContain("may be wrong or expired");
    const reloaded = await call("/claim", { method: "POST", headers, body });
    expect(reloaded.status).toBe(200);
    expect((await execute(agent, "get_identity")).status).toBe(200);
  });

  it("a claim form with a bad name says so", async () => {
    const owner = await signUp();
    const agent = await registerAgent();
    const res = await form({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org, name: "x".repeat(201) }, { cookie: owner.cookie }, "/claim");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("at most 200 bytes");
  });
});

describe("the application host", () => {
  const APP = "https://app.test";
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
  /** Every other test runs with APP_URL unset, which is what proves that path hasn't changed. */
  const withAppUrl = (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, { redirect: "manual", ...init }), { ...e, APP_URL: APP } as never, ctx);
  const onApp = (path: string, init: RequestInit = {}) => withAppUrl(APP + path, init);
  const onGateway = (path: string, init: RequestInit = {}) => withAppUrl(BASE + path, init);
  const appPost = (path: string, body: unknown, headers: Record<string, string> = {}) => onApp(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: APP, ...headers } });

  it("keeps the session on that host alone, and checks origin against it", async () => {
    const res = await appPost("/api/auth/sign-up/email", { email: `${unique("p")}@example.test`, password: "local-test-password-123", name: "Test person" });
    expect(res.status).toBe(200);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set.toLowerCase()).not.toContain("domain=");
    expect(set.toLowerCase()).toContain("httponly");
    const cookie = set.split(";")[0];
    expect((await (await onApp("/api/v1/me", { headers: { cookie } })).json<any>()).kind).toBe("person");

    const body = JSON.stringify({ name: "x" });
    const headers = { cookie, "content-type": "application/json" };
    expect((await onApp("/api/orgs", { method: "POST", headers: { ...headers, origin: APP }, body })).status).toBe(200);
    // Each host trusts only itself.
    expect((await onApp("/api/orgs", { method: "POST", headers: { ...headers, origin: BASE }, body })).status).toBe(403);
    expect((await onGateway("/api/orgs", { method: "POST", headers: { ...headers, origin: APP }, body })).status).toBe(403);
  });

  it("brings a provider's sign-in back to that host, and leaves agents on the gateway's", async () => {
    const res = await appPost("/api/auth/sign-in/social", { provider: "github", callbackURL: "/attention" });
    const { url } = await res.json<{ url: string }>();
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(`${APP}/api/auth/callback/github`);
    const discovery = await (await onGateway("/.well-known/agent-configuration")).json<any>();
    expect(JSON.stringify(discovery)).not.toContain(APP);
    const oauth = await (await onGateway("/.well-known/oauth-authorization-server")).json<any>();
    expect(oauth.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(oauth.issuer).toBe(BASE);
  });

  describe("redirects from the gateway's host", () => {
    it("sends a valid authorization request on, signed in or not, with its query intact", async () => {
      const { query } = await authorizeQuery();
      const res = await onGateway(`/authorize${query}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${APP}/oauth/consent${query}`);
    });

    it("answers a bad authorization request itself, and never sends anyone on with it", async () => {
      const { client_id, query } = await authorizeQuery();
      for (const bad of ["?client_id=nope", query.replace(encodeURIComponent("https://client.test/cb"), encodeURIComponent("https://evil.test/cb")), query.replace("scope=mcp", "scope=mcp+admin"), query.replace(/code_challenge=[^&]*&?/, ""), query.replace(/code_challenge=[^&]*&?/, "").replace(/code_challenge_method=[^&]*&?/, ""), `?response_type=code&client_id=${client_id}`]) {
        const res = await onGateway(`/authorize${bad}`);
        expect(res.status, bad).toBe(400);
        expect(res.headers.get("location"), bad).toBeNull();
      }
    });

    it("sends an agent's approval link on with its code", async () => {
      const res = await onGateway("/claim?agent_id=a&code=b");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${APP}/claim?agent_id=a&code=b`);
    });

    it("sends sign-in on, translating where it returns to and dropping anything else", async () => {
      const location = async (path: string) => (await onGateway(path)).headers.get("location");
      expect(await location(`/sign-in?next=${encodeURIComponent("/authorize?client_id=x&state=y")}`)).toBe(`${APP}/sign-in?next=${encodeURIComponent("/oauth/consent?client_id=x&state=y")}`);
      expect(await location(`/sign-in?next=${encodeURIComponent("/claim?agent_id=a&code=b")}`)).toBe(`${APP}/sign-in?next=${encodeURIComponent("/claim?agent_id=a&code=b")}`);
      expect(await location("/sign-in")).toBe(`${APP}/sign-in`);
      for (const next of ["https://evil.test/authorize", "//evil.test/claim", "/api/v1/me"]) expect(await location(`/sign-in?next=${encodeURIComponent(next)}`), next).toBe(`${APP}/sign-in`);
      expect(await location(`/sign-in?error=${encodeURIComponent("<b>call 555-0100</b>")}`)).toBe(`${APP}/sign-in?error=1`);
      const started = await onGateway("/sign-in", { method: "POST", headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ provider: "github", next: "/claim" }) });
      expect(started.status).toBe(303);
      expect(started.headers.get("location")).toBe(`${APP}/sign-in`);
    });

    it("can't register a client with a private-use redirect, because none is allowed yet", async () => {
      const reg = await onGateway("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["com.example.app:/cb"], client_name: "Desktop", token_endpoint_auth_method: "none" }) });
      expect(reg.status).toBe(400);
    });

    it("starts no session on this host, and leaves agents' routes and an existing session's routes alone", async () => {
      const send = (path: string, body: unknown) => onGateway(`/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(body) });
      for (const res of [await send("/sign-in/social", { provider: "github", callbackURL: "/signed-in" }), await send("/sign-in/email", { email: "x@example.test", password: "local-test-password-123" }), await send("/sign-up/email", { email: `${unique("p")}@example.test`, password: "local-test-password-123", name: "x" }), await onGateway("/api/auth/callback/github?code=c&state=s")]) {
        expect(res.status).toBe(404);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
      const a = await signUp();
      expect((await onGateway("/api/auth/get-session?disableRefresh=true", { headers: { cookie: a.cookie } })).status).toBe(200);
      expect((await onGateway("/api/auth/agent-configuration")).status).toBe(200);
      const agent = await registerAgent();
      expect(agent.registered.approval.verification_uri_complete).toContain(`${BASE}/claim`);
    });

    it("keeps the POSTs a session cookie can use, checking origin against this host and not the application's", async () => {
      const a = await signUp();
      const consent = async (origin: string) => {
        const { query } = await authorizeQuery();
        return onGateway("/authorize", { method: "POST", headers: { cookie: a.cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ oauth_query: query, org_id: a.org }) });
      };
      const approved = await consent(BASE);
      expect(approved.status).toBe(302);
      const code = new URL(approved.headers.get("location")!);
      expect(code.searchParams.get("code")).toBeTruthy();
      expect(code.searchParams.get("iss")).toBe(BASE);
      expect((await consent(APP)).status).toBe(403);

      const agent = await registerAgent();
      const claimAs = (origin: string) => onGateway("/claim", { method: "POST", headers: { cookie: a.cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: a.org }) });
      expect((await claimAs(APP)).status).toBe(403);
      expect((await claimAs(BASE)).status).toBe(200);
    });

    it("keeps the application host's routes off the gateway's host", async () => {
      const a = await signUp();
      for (const path of ["/api/consent", "/api/claim"]) {
        expect((await onGateway(path, { headers: { cookie: a.cookie } })).status, path).toBe(404);
        expect((await call(path, { headers: { cookie: a.cookie } })).status, `${path} with APP_URL unset`).toBe(404);
      }
    });

    it("changes nothing with APP_URL unset", async () => {
      const { query } = await authorizeQuery();
      expect((await call(`/authorize${query}`)).headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent(`/authorize${query}`)}`);
      expect((await call("/claim?agent_id=a&code=b")).headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent("/claim?agent_id=a&code=b")}`);
      expect((await call("/sign-in")).headers.get("content-type")).toContain("text/html");
    });
  });

  describe("consent over the binding", () => {
    const read = (who: Person | null, query: string) => onApp(`/api/consent${query}`, { headers: who ? { cookie: who.cookie } : {} });
    const decide = (who: Person, body: unknown, origin = APP) => onApp("/api/consent", { method: "POST", headers: { cookie: who.cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });

    it("reads the choices, with the client's name as data", async () => {
      const a = await signUp();
      const existing = await claimedAgent(a);
      const { query } = await authorizeQuery(`<script>alert(1)</script>`);
      const res = await read(a, query);
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.client_name).toBe(`<script>alert(1)</script>`);
      expect(body.redirect_hosts).toEqual(["client.test"]);
      expect(body.oauth_query).toBe(query);
      expect(body.orgs.map((o: { id: string }) => o.id)).toEqual([a.org]);
      expect(body.agents.map((row: { id: string }) => row.id)).toContain(existing.id);
    });

    it("refuses a read that's signed out, or for a bad request", async () => {
      const a = await signUp();
      const { query } = await authorizeQuery();
      expect((await read(null, query)).status).toBe(401);
      expect((await read(a, "?client_id=nope")).status).toBe(400);
      expect((await read(a, query.replace(encodeURIComponent("https://client.test/cb"), encodeURIComponent("https://evil.test/cb")))).status).toBe(400);
    });

    it("finishes a client's whole flow: approved here, then tokens and tools on the gateway's host", async () => {
      const a = await signUp();
      const { client_id, query } = await authorizeQuery();
      const res = await decide(a, { decision: "approve", oauth_query: query, org_id: a.org, agent_name: "From the app" });
      expect(res.status).toBe(200);
      const redirect = new URL((await res.json<any>()).redirect_to);
      expect(redirect.origin + redirect.pathname).toBe("https://client.test/cb");
      expect(redirect.searchParams.get("state")).toBe("s");
      // The client compares this with the issuer it discovered, which is the gateway.
      expect(redirect.searchParams.get("iss")).toBe(BASE);
      const tok = await onGateway("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: redirect.searchParams.get("code")!, redirect_uri: "https://client.test/cb", client_id, code_verifier: VERIFIER }) });
      expect(tok.status).toBe(200);
      const { access_token } = await tok.json<{ access_token: string }>();
      const mcp = await onGateway("/mcp", { method: "POST", headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_identity", arguments: {} } }) });
      const identity = JSON.parse((await mcp.json<any>()).result.content[0].text);
      expect(identity.id).toMatch(/^agt_/);
      const agents = await (await onApp("/api/agents", { headers: { cookie: a.cookie } })).json<any>();
      expect(agents.agents.find((row: { id: string }) => row.id === identity.id)?.name).toBe("From the app");
    });

    it("only connects on an explicit approval, from this host, for an organization the person runs", async () => {
      const [a, b] = [await signUp(), await signUp()];
      const { query } = await authorizeQuery();
      const before = await (await onApp("/api/agents", { headers: { cookie: a.cookie } })).json<any>();
      expect((await decide(a, { decision: "approve", oauth_query: query, org_id: a.org }, BASE)).status).toBe(403);
      expect((await decide(a, { decision: "approve", oauth_query: query, org_id: a.org }, "https://evil.test")).status).toBe(403);
      expect((await decide(a, { oauth_query: query, org_id: a.org })).status).toBe(400);
      expect((await decide(a, { decision: "yes", oauth_query: query, org_id: a.org })).status).toBe(400);
      expect((await decide(a, { decision: "approve", oauth_query: query })).status).toBe(400);
      expect((await decide(a, { decision: "approve", oauth_query: "/../evil", org_id: a.org })).status).toBe(400);
      expect((await decide(a, { decision: "approve", oauth_query: "?client_id=nope", org_id: a.org })).status).toBe(400);
      expect((await decide(a, { decision: "approve", oauth_query: query, org_id: b.org })).status).toBe(403);
      expect((await decide(a, { decision: "approve", oauth_query: query, org_id: a.org, agent_name: "x".repeat(201) })).status).toBe(400);
      expect((await onApp("/api/consent", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      const after = await (await onApp("/api/agents", { headers: { cookie: a.cookie } })).json<any>();
      expect(after.agents).toEqual(before.agents);
    });

    it("tells the client a person declined, and connects nothing", async () => {
      const a = await signUp();
      const { query } = await authorizeQuery();
      const res = await decide(a, { decision: "decline", oauth_query: query });
      expect(res.status).toBe(200);
      const redirect = new URL((await res.json<any>()).redirect_to);
      expect(redirect.origin + redirect.pathname).toBe("https://client.test/cb");
      expect(redirect.searchParams.get("error")).toBe("access_denied");
      expect(redirect.searchParams.get("state")).toBe("s");
      expect(redirect.searchParams.get("iss")).toBe(BASE);
      expect(redirect.searchParams.get("code")).toBeNull();
      expect((await (await onApp("/api/agents", { headers: { cookie: a.cookie } })).json<any>()).agents).toEqual([]);
      // A declined answer still only ever goes to a registered address.
      expect((await decide(a, { decision: "decline", oauth_query: query.replace(encodeURIComponent("https://client.test/cb"), encodeURIComponent("https://evil.test/cb")) })).status).toBe(400);
    });
  });

  describe("claims over the binding", () => {
    const read = (who: Person, agentId: string, code: string) => onApp(`/api/claim?agent_id=${encodeURIComponent(agentId)}&code=${encodeURIComponent(code)}`, { headers: { cookie: who.cookie } });
    const decide = (who: Person, body: unknown, origin = APP) => onApp("/api/claim", { method: "POST", headers: { cookie: who.cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });

    it("reveals nothing about an agent until the code is right", async () => {
      const a = await signUp();
      const agent = await registerAgent();
      const wrong = await read(a, agent.pluginId, "AAAA-AAAA");
      expect(wrong.status).toBe(404);
      const missing = await read(a, "agent_missing", "AAAA-AAAA");
      expect(missing.status).toBe(404);
      expect(await wrong.text()).toBe(await missing.text());
      const right = await read(a, agent.pluginId, agent.userCode);
      expect(right.status).toBe(200);
      expect(await right.json<any>()).toMatchObject({ agent_id: agent.pluginId, agent_name: "agent", code: agent.userCode, orgs: [{ id: a.org }] });
    });

    it("connects only from this host, with the right code", async () => {
      const a = await signUp();
      const agent = await registerAgent();
      const fields = { agent_id: agent.pluginId, user_code: agent.userCode, org_id: a.org, name: "From the app" };
      expect((await decide(a, fields, BASE)).status).toBe(403);
      expect((await decide(a, { ...fields, user_code: "AAAA-AAAA" })).status).toBe(403);
      expect((await onApp("/api/claim", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify(fields) })).status).toBe(401);
      const res = await decide(a, fields);
      expect(res.status).toBe(200);
      const { agent_id } = await res.json<{ agent_id: string }>();
      const { agents } = await (await onApp("/api/agents", { headers: { cookie: a.cookie } })).json<any>();
      expect(agents.find((row: { id: string }) => row.id === agent_id)?.name).toBe("From the app");
      // Its link is spent, so the page can't show it again.
      expect((await read(a, agent.pluginId, agent.userCode)).status).toBe(404);
      const after = await execute(agent, "get_identity");
      expect(after.status).toBe(200);
    });

    it("counts reads and decisions against the same limit on guessing", async () => {
      const a = await signUp();
      const keys: string[] = [];
      const fake: RateLimit = { limit: async ({ key }) => (keys.push(key), { success: !key.startsWith("claim:") }) };
      const limited = (init: RequestInit) => worker.fetch(new Request(`${APP}/api/claim?agent_id=a&code=b`, { redirect: "manual", ...init }), { ...e, APP_URL: APP, RL_SENSITIVE: fake } as never, ctx);
      expect((await limited({ headers: { cookie: a.cookie } })).status).toBe(429);
      expect((await limited({ method: "POST", headers: { cookie: a.cookie, origin: APP, "content-type": "application/json" }, body: "{}" })).status).toBe(429);
      expect(keys.filter((key) => key.startsWith("claim:")).length).toBe(2);
    });
  });
});

describe("dashboard inbox and agents", () => {
  it("reads a person's own inbox, but only the POST acknowledges", async () => {
    const a = await signUp();
    expect((await dash(a, "GET", "/v1/inbox")).status).toBe(200);
    expect((await dashboard(a, "GET", "/v1/inbox?ack=true")).status).toBe(404);
    expect((await dash(a, "POST", "/v1/inbox/ack", { up_to: 0 })).status).toBe(200);
    expect((await dashboard(a, "POST", "/v1/inbox/ack", { up_to: 0 }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await dashboard(a, "PUT", "/v1/inbox/wake", { url: "https://x.test" })).status).toBe(404);
  });

  it("lets the owning organization's admins oversee an agent's inbox, and nobody else", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const agent = await claimedAgent(a);
    expect((await dash(a, "GET", `/v1/agents/${agent.id}/inbox`)).status).toBe(200);
    expect(await dash(b, "GET", `/v1/agents/${agent.id}/inbox`)).toMatchObject({ status: 404, code: "agent_not_found" });
    expect((await dashboard(a, "GET", `/v1/agents/${agent.id}/inbox?ack=true`)).status).toBe(404);
    expect((await dashboard(a, "POST", `/v1/agents/${agent.id}/inbox`, {})).status).toBe(404);
  });

  it("lists only the agents of the person's own organizations", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const mine = await claimedAgent(a);
    const theirs = await claimedAgent(b);
    const res = await call("/api/agents", { headers: { cookie: a.cookie } });
    const ids = (await res.json<any>()).agents.map((row: { id: string }) => row.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect((await call("/api/agents")).status).toBe(401);
  });

  it("lists the newest agents first", async () => {
    const a = await signUp();
    const [first, second] = [await claimedAgent(a), await claimedAgent(a)];
    await e.DB.prepare("UPDATE podster_agent SET created_at = 1000 WHERE id = ?").bind(first.id).run();
    const { agents, truncated } = await (await call("/api/agents", { headers: { cookie: a.cookie } })).json<any>();
    expect(agents.map((row: { id: string }) => row.id)).toEqual([second.id, first.id]);
    expect(truncated).toBe(false);
  });
});

describe("sliding a session", () => {
  const age = (cookie: string) => {
    const token = decodeURIComponent(cookie.split("=")[1]).split(".")[0];
    const aged = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    return { token, aged, write: () => e.DB.prepare(`UPDATE session SET expiresAt = ? WHERE token = ?`).bind(aged.toISOString(), token).run() };
  };
  const expiry = async (token: string) => e.DB.prepare(`SELECT expiresAt FROM session WHERE token = ?`).bind(token).first<string>("expiresAt");

  it("happens only where the new cookie reaches the browser", async () => {
    const a = await signUp();
    const { token, write } = age(a.cookie);
    await write();
    const before = await expiry(token);

    // These answer without a new cookie, so they mustn't move the expiry.
    expect((await dashboard(a, "GET", "/v1/me")).status).toBe(200);
    expect((await call("/api/auth/get-session?disableRefresh=true", { headers: { cookie: a.cookie } })).status).toBe(200);
    expect(await expiry(token)).toBe(before);

    const refreshed = await call("/api/auth/get-session", { headers: { cookie: a.cookie } });
    expect(refreshed.headers.get("set-cookie")).toContain("better-auth.session_token=");
    expect(await expiry(token)).not.toBe(before);
  });
});

describe("dashboard passthrough", () => {
  it("refuses paths that could become a private route if a slash collapses", () => {
    for (const path of ["/v1//inbox", "/v1//agents/agt_x", "//v1/agents/agt_x", "/v1/inbox", "/v1/agents/agt_x", "/internal/init"]) expect(allowedPassthrough(path), path).toBe(false);
    expect(allowedPassthrough("/v1/workspaces/ws_x/tasks")).toBe(true);
  });
});

describe("spending agent tokens", () => {
  it("refuses a token older than 60 seconds, whatever its `exp` says", async () => {
    const owner = await signUp();
    const agent = await claimedAgent(owner);
    const signed = async (ageSeconds: number) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ capabilities: ["get_identity"] })
        .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt", kid: agent.keypair.publicKey.kid })
        .setSubject(agent.pluginId).setAudience(BASE).setIssuedAt(now - ageSeconds).setExpirationTime(now + 3600).setJti(crypto.randomUUID())
        .sign(await importJWK(agent.keypair.privateKey, "EdDSA"));
    };
    const send = async (age: number) => (await post("/api/auth/capability/execute", { capability: "get_identity", arguments: {} }, { authorization: `Bearer ${await signed(age)}` })).status;
    expect(await send(30)).toBe(200);
    expect(await send(90)).toBe(401);
  });

  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const bearer = (claims: object) => `Bearer ${encode({ alg: "EdDSA" })}.${encode(claims)}.sig`;
  const now = () => Math.floor(Date.now() / 1000);

  it("keeps the record for as long as the plugin accepts the token, whatever `exp` the client wrote", () => {
    const issued = now() - 5;
    expect(spentToken("plugin", bearer({ jti: "a", iat: issued, exp: now() + 315_360_000 }))).toEqual({ key: "plugin:a", expiresAt: issued + 90 });
    expect(spentToken("plugin", bearer({ jti: "a", iat: issued }))?.expiresAt).toBe(issued + 90);
    // An `iat` in the future can't stretch it either.
    expect(spentToken("plugin", bearer({ jti: "a", iat: now() + 1000 }))!.expiresAt).toBeLessThanOrEqual(now() + 91);
    expect(spentToken("plugin", bearer({ iat: issued }))).toBeNull();
  });

  it("sends the token to the API in the assertion, for agents only", async () => {
    const claims = decodeJwt(await mintAssertion({ kind: "agent", id: "agt_x", org: "o", generation: 1, spends: { key: "plugin:a", expiresAt: 123 } }, e.ASSERTION_SIGNING_JWK));
    expect(claims).toMatchObject({ agent_jti: "plugin:a", agent_jti_exp: 123 });
    const linked = decodeJwt(await mintAssertion({ kind: "agent", id: "agt_x", org: "o", generation: 1, linker: { person: "per_l", since: 5 } }, e.ASSERTION_SIGNING_JWK));
    expect(linked.linker).toEqual({ person: "per_l", since: 5 });
    const person = decodeJwt(await mintAssertion({ kind: "person", id: "per_x", org: "o", orgs: ["o"], adminOrgs: [], orgSince: {} }, e.ASSERTION_SIGNING_JWK));
    expect(person).not.toHaveProperty("agent_jti");
  });
});

describe("capability mapping", () => {
  it("matches the contract", () => {
    const contract = parse(e.TEST_CAPABILITIES).capabilities;
    expect(CAPABILITIES.map((c) => c.name).sort()).toEqual(Object.keys(contract).sort());
    for (const c of CAPABILITIES) expect(c.kind, c.name).toBe(contract[c.name].kind);
  });

  it("encodes path values and drops anything the capability doesn't define", () => {
    const task = CAPABILITIES.find((c) => c.name === "accept_task")!;
    const mapped = toApiCall(task, { workspace_id: "../../internal/init", task_id: "a/b?c", version: 1, idempotency_key: "k", org: "evil", role: "admin", actor: "x" });
    expect(mapped.path).toBe("/v1/workspaces/..%2F..%2Finternal%2Finit/tasks/a%2Fb%3Fc/accept");
    expect(JSON.parse(mapped.body!)).toEqual({ version: 1 });
    expect(mapped.idempotencyKey).toBe("k");
    expect(() => toApiCall(task, { workspace_id: "w", task_id: "t", version: 1 })).toThrow();
    const query = toApiCall(CAPABILITIES.find((c) => c.name === "list_tasks")!, { workspace_id: "w", status: "open", extra: "x" });
    expect(query.path).toBe("/v1/workspaces/w/tasks?status=open");
    expect(toApiCall(CAPABILITIES.find((c) => c.name === "list_tasks")!, { workspace_id: "w", order: "newest", cursor: 7 }).path).toBe("/v1/workspaces/w/tasks?cursor=7&order=newest");
  });

  it("refuses a path value a URL would read as a step in place or up, in every capability's every placeholder", () => {
    const withPath = CAPABILITIES.filter((c) => c.path.includes("{"));
    expect(withPath.length).toBeGreaterThan(10);
    for (const capability of withPath) {
      const names = [...capability.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const args = (value: string, at: string) => ({ ...Object.fromEntries(names.map((n) => [n, n === at ? value : "x"])), version: 1, plan_revision: 1, predecessors: [], idempotency_key: "k" });
      for (const name of names) {
        for (const value of [".", "..", ""]) expect(() => toApiCall(capability, args(value, name)), `${capability.name} ${name}=${JSON.stringify(value)}`).toThrow(InvalidArguments);
        // Encoded or longer forms stay text: the "%" is encoded too, so the API sees the same number of segments.
        for (const value of ["%2e%2e", ".%2e", "%2E", "...", "..x"]) {
          const { path } = toApiCall(capability, args(value, name));
          expect(new URL(`https://api.internal${path}`).pathname, `${capability.name} ${name}=${value}`).toBe(path.split("?")[0]);
        }
      }
    }
  });
});

describe("kernel journey across two organizations", () => {
  /** Delivery is asynchronous, usually within moments, so this polls the way an agent's next session would find it. */
  async function waitForEvent(read: (query: object) => Promise<{ data?: any }>, type: string, taskId?: string) {
    for (let i = 0; i < 100; i++) {
      const { data } = await read({ after: 0, limit: 50 });
      const found = data?.events?.find((event: any) => event.type === type && (!taskId || event.task_id === taskId));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no ${type} event arrived`);
  }

  async function setup() {
    const [personA, personB] = [await signUp(), await signUp()];
    const lead = await mcpAgent(personA);
    const architect = await claimedAgent(personB);
    const room = (await dash(personA, "POST", "/v1/workspaces", { name: "Billing v2" })).body.id as string;
    const version = async () => (await dash(personA, "GET", `/v1/workspaces/${room}`)).body.policy_version;
    expect((await dash(personA, "POST", `/v1/workspaces/${room}/members`, { principal_id: lead.id, kind: "agent", org_id: personA.org, role: "member", policy_version: await version() })).status).toBe(200);
    const invite = await dash(personA, "POST", `/v1/workspaces/${room}/invitations`, { role: "guest", invited_org_id: personB.org, policy_version: await version() });
    expect(invite.status).toBe(200);
    const accepted = await dash(personB, "POST", "/v1/invitations/accept", { token: invite.body.token, org_id: personB.org, agents: [architect.id] });
    expect(accepted.body.agents).toEqual([architect.id]);
    return { personA, personB, lead, architect, room, version };
  }

  it("reads and sets a task's plan over both connection methods, and sends no other field", async () => {
    const { personA, lead, architect, room, version } = await setup();
    const first = (await lead.tool("create_task", { workspace_id: room, title: "First", instructions: "x", idempotency_key: "plan-first" })).data;
    const second = (await lead.tool("create_task", { workspace_id: room, title: "Second", instructions: "x", idempotency_key: "plan-second" })).data;
    const before = (await lead.tool("get_plan", { workspace_id: room })).data;
    expect(before.complete).toBe(true);
    const set = (await lead.tool("set_task_plan", { workspace_id: room, task_id: second.id, plan_revision: before.plan_revision, duration_days: 3, predecessors: [first.id], idempotency_key: "plan-set" })).data;
    expect(set.predecessors).toEqual([first.id]);
    // The smaller read reaches the API over both connection methods.
    const small = (await lead.tool("get_plan", { workspace_id: room, scope: "unfinished" })).data;
    expect(small.complete).toBe(false);
    expect(small.plan_revision).toBe(set.plan_revision);
    expect((await execute(architect, "get_plan", { workspace_id: room, scope: "unfinished" })).data.complete).toBe(false);
    expect((await execute(architect, "get_plan", { workspace_id: room, scope: "everything" })).code).toBe("invalid_argument");
    // A guest connected through Agent Auth reads only part of it, and can't edit.
    const read = (await execute(architect, "get_plan", { workspace_id: room })).data;
    expect(read.complete).toBe(false);
    expect(read).not.toHaveProperty("plan_revision");
    expect(JSON.stringify(read)).not.toContain(first.id);
    const refused = await execute(architect, "set_task_plan", { workspace_id: room, task_id: first.id, plan_revision: 1, predecessors: [], idempotency_key: "plan-refused" });
    expect(refused.code).toBe("task_not_found");
    // Left out means not estimated.
    const cleared = (await lead.tool("set_task_plan", { workspace_id: room, task_id: second.id, plan_revision: set.plan_revision, predecessors: [], idempotency_key: "plan-clear" })).data;
    expect(cleared).toMatchObject({ duration_days: null, predecessors: [] });
    // Null means the same, on both paths the schema reaches.
    const nulled = (await lead.tool("set_task_plan", { workspace_id: room, task_id: second.id, plan_revision: cleared.plan_revision, duration_days: 4, predecessors: [], idempotency_key: "plan-four" })).data;
    const backToBlank = (await lead.tool("set_task_plan", { workspace_id: room, task_id: second.id, plan_revision: nulled.plan_revision, duration_days: null, predecessors: [], idempotency_key: "plan-null" })).data;
    expect(backToBlank.duration_days).toBeNull();
    // Agent Auth takes null too, with the same effect, once this agent can edit.
    await dash(personA, "PUT", `/v1/workspaces/${room}/members/${architect.id}/access`, { preset: "member", policy_version: await version() });
    const own = (await execute(architect, "create_task", { workspace_id: room, title: "Theirs", instructions: "x", idempotency_key: "plan-theirs" })).data;
    const current = (await execute(architect, "get_plan", { workspace_id: room })).data.plan_revision;
    const estimated = (await execute(architect, "set_task_plan", { workspace_id: room, task_id: own.id, plan_revision: current, duration_days: 2, predecessors: [], idempotency_key: "plan-auth-set" })).data;
    expect(estimated.duration_days).toBe(2);
    const blank = (await execute(architect, "set_task_plan", { workspace_id: room, task_id: own.id, plan_revision: estimated.plan_revision, duration_days: null, predecessors: [], idempotency_key: "plan-auth-null" })).data;
    expect(blank.duration_days).toBeNull();
    expect((await dash(personA, "GET", `/v1/workspaces/${room}/plan`)).status).toBe(200);
  });

  it("passes list_activity's order and cursor through to the API, over both connection methods", async () => {
    const { personA, lead, architect, room, version } = await setup();
    await dash(personA, "PUT", `/v1/workspaces/${room}/brief`, { goal: "Ship", policy_version: await version() });
    const first = (await lead.tool("list_activity", { workspace_id: room, order: "newest", limit: 1 })).data;
    expect(first.events[0].type).toBe("workspace.brief_changed");
    expect(first.next_before).toBe(first.events[0].id);
    const second = (await lead.tool("list_activity", { workspace_id: room, order: "newest", limit: 1, before: first.next_before })).data;
    expect(second.events[0].id).not.toBe(first.events[0].id);
    const agentAuth = (await execute(architect, "list_activity", { workspace_id: room, order: "newest", limit: 1 })).data;
    expect(agentAuth.events[0].type).toBe("workspace.brief_changed");
    expect(agentAuth.events[0].from).not.toHaveProperty("org");
    // A notice's subject reaches an agent over both connection methods. This one is limited, so it's its own.
    const joined = (await execute(architect, "list_activity", { workspace_id: room })).data.events.filter((e: any) => e.type === "member.added");
    expect(joined.map((e: any) => e.subject)).toEqual([architect.id]);
    const overMcp = (await lead.tool("list_activity", { workspace_id: room })).data.events.filter((e: any) => e.type === "member.added");
    expect(overMcp.map((e: any) => e.subject)).toContain(lead.id);
  });

  it("runs offer, accept, message, submit, changes, resubmit and verify, with different credentials on each side", async () => {
    const { lead, architect, room } = await setup();
    const created = await lead.tool("create_task", { workspace_id: room, title: "Design billing API", instructions: "Write the design", assignee: architect.id, idempotency_key: unique("k") });
    const task = created.data;
    expect(task.status).toBe("offered");
    const at = { workspace_id: room, task_id: task.id };

    // Agent B hears about the work in its inbox, with no public URL of its own. Events carry IDs, so it then reads the task.
    const offered = await waitForEvent((q) => execute(architect, "read_inbox", q), "task.offered", task.id);
    expect(offered).not.toHaveProperty("title");
    expect((await execute(architect, "get_task", at)).data.task.title).toBe("Design billing API");
    const accepted = await execute(architect, "accept_task", { ...at, version: 1, idempotency_key: unique("k") });
    expect(accepted.data.status).toBe("accepted");
    await waitForEvent(async (q) => ({ data: (await lead.tool("read_inbox", q)).data }), "task.accepted", task.id);
    expect((await execute(architect, "send_message", { ...at, body: "A question about scope", idempotency_key: unique("k") })).status).toBe(200);
    const submitted = await execute(architect, "submit_task", { ...at, version: 2, note: "First draft", artifacts: [{ uri: "https://example.test/pr/1", label: "PR" }], idempotency_key: unique("k") });
    expect(submitted.data.submission_no).toBe(1);

    await waitForEvent(async (q) => ({ data: (await lead.tool("read_inbox", q)).data }), "task.submitted", task.id);
    expect((await lead.tool("request_changes", { ...at, submission_no: 1, reason: "Needs tests", idempotency_key: unique("k") })).data.status).toBe("accepted");
    expect((await execute(architect, "submit_task", { ...at, version: 4, note: "Second draft", idempotency_key: unique("k") })).data.submission_no).toBe(2);
    expect((await execute(architect, "verify_task", { ...at, submission_no: 2, idempotency_key: unique("k") })).status).toBe(403);
    expect((await lead.tool("verify_task", { ...at, submission_no: 2, idempotency_key: unique("k") })).data.status).toBe("completed");

    const [fromLead, fromArchitect] = [(await lead.tool("get_task", at)).data, (await execute(architect, "get_task", at)).data];
    expect(fromLead.task).toEqual(fromArchitect.task);
    expect(fromLead.task.status).toBe("completed");
    expect(fromLead.submissions[0]).toMatchObject({ note: "First draft", external: true });
    expect(fromArchitect.submissions[0].external).toBe(false);
    const changes = fromArchitect.history.find((h: any) => h.type === "task.changes_requested");
    expect(changes).toMatchObject({ reason: "Needs tests", external: true });
    expect(fromLead.messages[0]).toMatchObject({ body: "A question about scope", external: true });
  });

  it("an agent goes from connected to its first accepted task in under 5 tool calls", async () => {
    const { lead, architect, room } = await setup();
    const created = (await lead.tool("create_task", { workspace_id: room, title: "Quick", instructions: "Go", assignee: architect.id, idempotency_key: unique("k") })).data;
    const event = await waitForEvent((q) => execute(architect, "read_inbox", q), "task.offered", created.id);
    const read = await execute(architect, "get_task", { workspace_id: event.workspace_id, task_id: event.task_id });
    const accepted = await execute(architect, "accept_task", { workspace_id: event.workspace_id, task_id: event.task_id, version: read.data.task.version, idempotency_key: unique("k") });
    expect(accepted.data.status).toBe("accepted");
  });

  it("an agent sets its own wake over either connection, and only it sees the secret", async () => {
    const { personB, architect } = await setup();
    const linked = await mcpAgent(personB, { link_agent_id: architect.id });
    const set = await execute(architect, "set_wake", { url: "https://hooks.example.com/wake", debounce: 120 });
    expect(set.data).toMatchObject({ url: "https://hooks.example.com/wake", debounce: 120, enabled: true });
    expect(set.data.secret).toMatch(/^whsec_/);
    const seen = (await linked.tool("get_identity")).data;
    expect(seen.wake).toMatchObject({ url: "https://hooks.example.com/wake", debounce: 120, enabled: true });
    expect(JSON.stringify(seen)).not.toContain(set.data.secret);
    expect((await linked.tool("set_wake", { url: "http://hooks.example.com/" })).code).toBe("invalid_wake_url");
    expect((await linked.tool("delete_wake")).data).toEqual({ deleted: true });
    expect((await execute(architect, "get_identity")).data.wake).toBeNull();
  });

  it("oversight shows the agent's organization IDs, type and time from another organization's room, never content (decision 31)", async () => {
    const { personA, personB, lead, architect, room } = await setup();
    const task = (await lead.tool("create_task", { workspace_id: room, title: "Secret title", instructions: "Secret instructions", assignee: architect.id, idempotency_key: unique("k") })).data;
    await lead.tool("send_message", { workspace_id: room, task_id: task.id, body: "Secret message", idempotency_key: unique("k") });
    await waitForEvent((q) => execute(architect, "read_inbox", q), "task.offered", task.id);
    const before = (await execute(architect, "read_inbox", {})).data.acked_seq;

    const seen = await dash(personB, "GET", `/v1/agents/${architect.id}/inbox?after=0&limit=50`);
    expect(seen.status).toBe(200);
    const offered = seen.body.events.find((event: any) => event.type === "task.offered" && event.task_id === task.id);
    expect(offered).toMatchObject({ workspace_id: room, task_id: task.id });
    for (const event of seen.body.events) expect(Object.keys(event).sort()).toEqual(["actor_id", "created_at", "event_id", "seq", "task_id", "type", "workspace_id"]);
    expect(JSON.stringify(seen.body)).not.toMatch(/Secret|Billing v2/);

    // The IDs open nothing, and looking moves nothing.
    expect(await dash(personB, "GET", `/v1/workspaces/${room}`)).toMatchObject({ status: 404, code: "workspace_not_found" });
    expect(await dash(personB, "GET", `/v1/workspaces/${room}/tasks/${task.id}`)).toMatchObject({ status: 404, code: "workspace_not_found" });
    expect((await execute(architect, "read_inbox", {})).data.acked_seq).toBe(before);
    // A room's owner isn't the agent's organization, so the panel isn't theirs.
    expect(await dash(personA, "GET", `/v1/agents/${architect.id}/inbox`)).toMatchObject({ status: 404, code: "agent_not_found" });
  });

  it("both connection methods share one inbox and cursor", async () => {
    const { personB, lead, architect, room } = await setup();
    const linked = await mcpAgent(personB, { link_agent_id: architect.id });
    const task = (await lead.tool("create_task", { workspace_id: room, title: "Shared", instructions: "x", assignee: architect.id, idempotency_key: unique("k") })).data;
    const event = await waitForEvent((q) => execute(architect, "read_inbox", q), "task.offered", task.id);
    expect((await linked.tool("ack_inbox", { up_to: event.seq })).data.acked_seq).toBe(event.seq);
    expect((await execute(architect, "read_inbox", {})).data.acked_seq).toBe(event.seq);
    const identity = await linked.tool("get_identity");
    expect(identity.data).toMatchObject({ inbox_unread: 0, wake: null });
  });

  it("revoking an organization leaves its agent one ID-only notice, and its next read and action fail", async () => {
    const { personA, lead, architect, room, version } = await setup();
    const task = (await lead.tool("create_task", { workspace_id: room, title: "Secret", instructions: "Secret too", assignee: architect.id, idempotency_key: unique("k") })).data;
    await waitForEvent((q) => execute(architect, "read_inbox", q), "task.offered", task.id);
    expect((await dash(personA, "DELETE", `/v1/workspaces/${room}/members/${architect.id}`, { policy_version: await version() })).status).toBe(200);
    expect((await execute(architect, "get_task", { workspace_id: room, task_id: task.id })).status).toBe(403);
    expect((await execute(architect, "send_message", { workspace_id: room, task_id: task.id, body: "still here?", idempotency_key: unique("k") })).status).toBe(403);
    const notice = await waitForEvent((q) => execute(architect, "read_inbox", q), "member.revoked");
    expect(notice.workspace_id).toBe(room);
    // The offer is gone, and nothing later arrives from this room.
    await lead.tool("create_task", { workspace_id: room, title: "Later", instructions: "x", idempotency_key: unique("k") });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { events } = (await execute(architect, "read_inbox", { after: 0, limit: 50 })).data;
    expect(events.filter((e: any) => e.workspace_id === room).map((e: any) => e.type)).toEqual(["member.revoked"]);
    expect(JSON.stringify(events)).not.toContain("Secret");
  });

  it("retrying with the same key creates nothing new", async () => {
    const { lead, architect, room } = await setup();
    const key = unique("k");
    const args = { workspace_id: room, title: "Once", instructions: "Only once", assignee: architect.id, idempotency_key: key };
    const [first, second] = [await lead.tool("create_task", args), await lead.tool("create_task", args)];
    expect(second.data.id).toBe(first.data.id);
    expect((await lead.tool("list_tasks", { workspace_id: room })).data.tasks).toHaveLength(1);
    expect((await lead.tool("create_task", { ...args, title: "Different" })).code).toBe("idempotency_mismatch");
  });

  it("refuses a role ID that would step up to another route, over both connection methods", async () => {
    const { lead, architect, room } = await setup();
    // Without the refusal this became POST /v1/workspaces/{room}/claim.
    expect((await lead.tool("claim_role", { workspace_id: room, role_id: "..", idempotency_key: unique("k") })).code).toBe("invalid_argument");
    expect((await execute(architect, "claim_role", { workspace_id: room, role_id: "..", idempotency_key: unique("k") })).code).toBe("invalid_argument");
    expect((await execute(architect, "get_task", { workspace_id: room, task_id: "." })).code).toBe("invalid_argument");
  });

  it("lets an agent ask for tasks newest first", async () => {
    const { lead, architect, room } = await setup();
    const make = (title: string) => lead.tool("create_task", { workspace_id: room, title, instructions: "A row", assignee: architect.id, idempotency_key: unique("k") });
    const [first, second] = [(await make("First")).data.id, (await make("Second")).data.id];
    expect((await lead.tool("list_tasks", { workspace_id: room })).data.tasks.map((task: { id: string }) => task.id)).toEqual([first, second]);
    expect((await lead.tool("list_tasks", { workspace_id: room, order: "newest" })).data.tasks.map((task: { id: string }) => task.id)).toEqual([second, first]);
    expect((await lead.tool("list_tasks", { workspace_id: room, order: "sideways" })).code).toBe("invalid_argument");
  });

  it("outsiders and uninvolved guests can't see tasks, and missing rooms look the same", async () => {
    const { personA, personB, lead, room, version } = await setup();
    const task = (await lead.tool("create_task", { workspace_id: room, title: "Private", instructions: "x", idempotency_key: unique("k") })).data;
    const outsider = await mcpAgent(await signUp());
    expect((await outsider.tool("get_workspace", { workspace_id: room })).code).toBe("workspace_not_found");
    expect((await outsider.tool("get_workspace", { workspace_id: "ws_does_not_exist" })).code).toBe("workspace_not_found");
    expect((await outsider.tool("list_tasks", { workspace_id: room })).code).toBe("workspace_not_found");
    const guest = await claimedAgent(personB);
    const invite = await dash(personA, "POST", `/v1/workspaces/${room}/invitations`, { role: "guest", invited_org_id: personB.org, policy_version: await version() });
    await dash(personB, "POST", "/v1/invitations/accept", { token: invite.body.token, org_id: personB.org, agents: [guest.id] });
    expect((await execute(guest, "list_tasks", { workspace_id: room })).data.tasks).toEqual([]);
    expect((await execute(guest, "get_task", { workspace_id: room, task_id: task.id })).status).toBe(404);
  });

  it("agents can't manage access, and revocation stops both reads and actions on the next request", async () => {
    const { personA, lead, architect, room, version } = await setup();
    const members = `/v1/workspaces/${room}/members`;
    const task = (await lead.tool("create_task", { workspace_id: room, title: "Work", instructions: "x", assignee: architect.id, idempotency_key: unique("k") })).data;
    expect(CAPABILITIES.some((c) => /member|invitation|disconnect/.test(c.name))).toBe(false);
    await execute(architect, "accept_task", { workspace_id: room, task_id: task.id, version: 1, idempotency_key: unique("k") });
    expect((await dash(personA, "DELETE", `${members}/${architect.id}`, { policy_version: await version() })).status).toBe(200);
    expect((await execute(architect, "get_task", { workspace_id: room, task_id: task.id })).status).toBe(403);
    expect((await execute(architect, "send_message", { workspace_id: room, task_id: task.id, body: "still here?", idempotency_key: unique("k") })).status).toBe(403);
    expect((await lead.tool("get_task", { workspace_id: room, task_id: task.id })).data.task).toMatchObject({ status: "open", assignee: null });
  });

  it("disconnect ends every credential, and reconnecting restores neither them nor room access", async () => {
    const { personB, architect, room } = await setup();
    const linked = await mcpAgent(personB, { link_agent_id: architect.id });
    expect((await linked.tool("get_workspace", { workspace_id: room })).data.id).toBe(room);

    const stranger = await signUp();
    expect((await dash(stranger, "POST", `/agents/${architect.id}/disconnect`)).code).toBe("agent_not_found");
    expect((await dash(stranger, "GET", `/agents/${architect.id}`)).code).toBe("agent_not_found");
    const off = await dash(personB, "POST", `/agents/${architect.id}/disconnect`);
    expect(off.body).toMatchObject({ status: "disconnected", generation: 2 });
    expect((await execute(architect, "get_identity")).status).toBe(403);
    expect((await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${linked.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status).toBe(401);

    const on = await dash(personB, "POST", `/agents/${architect.id}/reconnect`);
    expect(on.body).toMatchObject({ status: "active", generation: 3 });
    expect((await dash(personB, "GET", `/agents/${architect.id}`)).body.status).toBe("active");
    // The old key and token stay dead, so a leaked one doesn't come back.
    expect((await execute(architect, "get_identity")).status).toBe(403);
    expect((await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${linked.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status).toBe(401);

    // The owner approves a new credential, which reattaches to the same agent, with no room access.
    const replacement = await registerAgent();
    const reclaimed = await claim(personB, replacement, { link_agent_id: architect.id });
    expect((await reclaimed.json<any>()).agent_id).toBe(architect.id);
    expect((await execute(replacement, "get_identity")).data).toMatchObject({ id: architect.id, generation: 3 });
    expect((await execute(replacement, "get_workspace", { workspace_id: room })).status).toBe(403);
  });
});

describe("staging's test sign-up", () => {
  const GATEWAY = "https://gateway-staging.podster.dev";
  const APP = "https://app-staging.podster.dev";
  const SECRET = "local-test-only-e2e-secret-0123456789";
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
  const counter = (retryAfter = 0) => ({ idFromName: (name: string) => name, get: () => ({ take: async () => retryAfter }) });
  /** What staging's config gives the gateway. The counter is fake, because this file's tests would use up the real one. */
  const staging = { ...e, BASE_URL: GATEWAY, APP_URL: APP, ENABLE_PASSWORD_SIGNIN: undefined, ENABLE_E2E_SIGNUP: "true", E2E_SIGNUP_SECRET: SECRET, STRICT_COUNTER: counter() };
  const send = (url: string, init: RequestInit = {}, env: object = staging) => worker.fetch(new Request(url, { redirect: "manual", ...init }), env as never, ctx);
  const signUpAs = (env: object = staging, url = `${GATEWAY}/api/auth/sign-up/e2e`, secret: string | null = SECRET) => send(url, { method: "POST", headers: secret === null ? {} : { authorization: `Bearer ${secret}` } }, env);
  const testPerson = async (env: object = staging) => {
    const res = await signUpAs(env);
    expect(res.status).toBe(200);
    return { body: await res.json<{ user_id: string; email: string }>(), cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), set: res.headers.getSetCookie().join("\n") };
  };
  const peopleCount = async () => (await e.DB.prepare(`SELECT COUNT(*) AS n FROM "user"`).first<{ n: number }>())!.n;

  describe("is off unless everything lines up", () => {
    // The answer any private auth route gives today, so being on can't be told from being off.
    const today = async () => {
      const res = await send(`${GATEWAY}/api/auth/not-a-route`, { method: "POST" });
      return [res.status, await res.text()];
    };
    const refusals: [string, () => Promise<Response>][] = [
      ["the var is missing", () => signUpAs({ ...staging, ENABLE_E2E_SIGNUP: undefined })],
      ["the var isn't exactly true", () => signUpAs({ ...staging, ENABLE_E2E_SIGNUP: "1" })],
      ["the secret isn't set", () => signUpAs({ ...staging, E2E_SIGNUP_SECRET: undefined })],
      ["the secret is empty, and so is the header", () => signUpAs({ ...staging, E2E_SIGNUP_SECRET: "" }, undefined, "")],
      ["the secret is too short", () => signUpAs({ ...staging, E2E_SIGNUP_SECRET: "short" }, undefined, "short")],
      ["no secret is sent", () => signUpAs(staging, undefined, null)],
      ["the secret is wrong", () => signUpAs(staging, undefined, `${SECRET}x`)],
      ["the secret is only in the query", () => signUpAs(staging, `${GATEWAY}/api/auth/sign-up/e2e?secret=${SECRET}`, null)],
      ["the deployment is production", () => signUpAs({ ...staging, BASE_URL: "https://gateway.podster.dev", APP_URL: "https://app.podster.dev" }, "https://gateway.podster.dev/api/auth/sign-up/e2e")],
      ["the request is for production on staging's deployment", () => signUpAs(staging, "https://gateway.podster.dev/api/auth/sign-up/e2e")],
      ["the deployment isn't staging's, whatever the request says", () => signUpAs({ ...staging, BASE_URL: "https://gateway.podster.dev" })],
      ["the host only looks like staging's", () => signUpAs({ ...staging, BASE_URL: `${GATEWAY}.evil.test` }, `${GATEWAY}.evil.test/api/auth/sign-up/e2e`)],
      ["the request is for the application host", () => signUpAs(staging, `${APP}/api/auth/sign-up/e2e`)],
      ["it's a local target with password sign-in on", () => signUpAs({ ...e, ENABLE_E2E_SIGNUP: "true", E2E_SIGNUP_SECRET: SECRET, STRICT_COUNTER: counter() }, `${BASE}/api/auth/sign-up/e2e`)],
      ["it isn't a POST", () => send(`${GATEWAY}/api/auth/sign-up/e2e`, { headers: { authorization: `Bearer ${SECRET}` } })],
    ];
    for (const [name, attempt] of refusals) {
      it(`answers the same 404 when ${name}`, async () => {
        const before = await peopleCount();
        const res = await attempt();
        expect([res.status, await res.text()]).toEqual(await today());
        expect(res.headers.getSetCookie()).toEqual([]);
        expect(await peopleCount()).toBe(before);
      });
    }

    it("can't be turned on by the top-level config, or by any environment but staging", () => {
      const config = JSON.parse(e.TEST_WRANGLER.replace(/^\s*\/\/.*$/gm, ""));
      const { staging: stagingConfig, ...others } = config.env;
      for (const [name, environment] of Object.entries<any>({ top: config, ...others, production: config.env.production ?? {} })) {
        expect(environment.vars?.ENABLE_E2E_SIGNUP, name).toBeUndefined();
      }
      // A var is what turns it on, and the secret isn't one: a plain var would sit in this repo.
      for (const environment of [config, ...Object.values<any>(config.env)]) expect(environment.vars?.E2E_SIGNUP_SECRET).toBeUndefined();
      expect(stagingConfig.vars.ENABLE_E2E_SIGNUP).toBe("true");
      expect(stagingConfig.vars.BASE_URL).toBe(GATEWAY);
      // Production's name mustn't be able to pass as staging's.
      expect(config.vars.BASE_URL).not.toBe(GATEWAY);
    });
  });

  it("makes a marked person with their own organization, and a session the real hosts accept", async () => {
    const { body, cookie, set } = await testPerson();
    expect(body.user_id.startsWith("e2e_")).toBe(true);
    expect(body.email.endsWith("@e2e.podster.invalid")).toBe(true);
    expect(cookie).toContain("__Secure-better-auth.session_token=");
    expect(set.toLowerCase()).not.toContain("domain=");
    expect(set.toLowerCase()).toContain("httponly");
    for (const host of [GATEWAY, APP]) {
      const me = await send(`${host}/api/v1/me`, { headers: { cookie } });
      expect(me.status, host).toBe(200);
      expect((await me.json<any>()).id, host).toBe(`per_${body.user_id}`);
      const orgs = await (await send(`${host}/api/orgs`, { headers: { cookie } })).json<any>();
      expect(orgs.organizations.filter((o: any) => o.personal), host).toHaveLength(1);
    }
    // Origin checks are what they were: this host's own origin, and nobody else's.
    const create = (origin: string) => send(`${GATEWAY}/api/orgs`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    expect((await create(APP)).status).toBe(403);
    expect((await create(GATEWAY)).status).toBe(200);
    const row = await e.DB.prepare(`SELECT s.expiresAt FROM session s WHERE s.userId = ?`).bind(body.user_id).first<{ expiresAt: string }>();
    expect(new Date(row!.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
  });

  it("signs out on the gateway's host", async () => {
    const { cookie } = await testPerson();
    const out = await send(`${GATEWAY}/api/auth/sign-out`, { method: "POST", headers: { cookie, origin: GATEWAY, "content-type": "application/json" }, body: "{}" });
    expect(out.status).toBe(200);
    expect((await send(`${GATEWAY}/api/orgs`, { headers: { cookie } })).status).toBe(401);
  });

  it("signs in M4's one fixed test operator, the same person each time, and only with the secret", async () => {
    const asOperator = (secret: string | null = SECRET, env: object = staging) =>
      send(`${GATEWAY}/api/auth/sign-up/e2e`, { method: "POST", headers: { ...(secret === null ? {} : { authorization: `Bearer ${secret}` }), "content-type": "application/json" }, body: JSON.stringify({ stable: "operator" }) }, env);
    const first = await asOperator();
    expect(first.status).toBe(200);
    const one = await first.json<{ user_id: string; email: string }>();
    expect(one.user_id.startsWith("e2e_")).toBe(true);
    expect(one.email).toBe("e2e-operator@e2e.podster.invalid");
    const again = await asOperator();
    expect(again.status).toBe(200);
    const two = await again.json<{ user_id: string }>();
    expect(two.user_id).toBe(one.user_id);
    // A new session each time, for the same person, and either session works.
    const cookies = [first, again].map((res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "));
    expect(cookies[0]).not.toBe(cookies[1]);
    for (const cookie of cookies) expect((await send(`${GATEWAY}/api/orgs`, { headers: { cookie } })).status).toBe(200);
    // Without the right secret, or off staging, it's the same 404 as everything else here.
    expect((await asOperator(`${SECRET}x`)).status).toBe(404);
    expect((await asOperator(null)).status).toBe(404);
    expect((await asOperator(SECRET, { ...staging, ENABLE_E2E_SIGNUP: undefined })).status).toBe(404);
    // Any other value is an ordinary new test person.
    const other = await send(`${GATEWAY}/api/auth/sign-up/e2e`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ stable: "admin" }) });
    expect((await other.json<{ user_id: string }>()).user_id).not.toBe(one.user_id);
    // Its password is nobody's to type: password sign-in stays off for it.
    const typed = await send(`${APP}/api/auth/sign-in/email`, { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ email: one.email, password: "anything" }) });
    expect(typed.ok).toBe(false);
  });

  it("takes no input, so a request can't name, sign in as or link to a real person", async () => {
    const real = await signUp();
    const realMe = await (await call("/api/v1/me", { headers: { cookie: real.cookie } })).json<any>();
    const realRow = await e.DB.prepare(`SELECT email FROM "user" WHERE id = ?`).bind(realMe.id.slice("per_".length)).first<{ email: string }>();
    const github = `${unique("github")}`;
    await e.DB.prepare(`INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, 'github', ?, ?, ?)`).bind(github, github, realMe.id.slice("per_".length), new Date().toISOString(), new Date().toISOString()).run();
    const accounts = () => e.DB.prepare(`SELECT id, providerId, password FROM account WHERE userId = ? ORDER BY id`).bind(realMe.id.slice("per_".length)).all();
    const before = (await accounts()).results;

    const res = await send(`${GATEWAY}/api/auth/sign-up/e2e`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ email: realRow!.email, password: "chosen-password-123", name: "Real", user_id: realMe.id, id: realMe.id }) });
    expect(res.status).toBe(200);
    const made = await res.json<any>();
    expect(made.email).not.toBe(realRow!.email);
    expect(`per_${made.user_id}`).not.toBe(realMe.id);
    expect((await accounts()).results).toEqual(before);
  });

  it("leaves password sign-in off everywhere else on staging, including for test people", async () => {
    const { body } = await testPerson();
    const form = (path: string, email: string) => send(`${APP}${path}`, { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ email, password: "local-test-password-123", name: "x" }) });
    for (const path of ["/api/auth/sign-in/email", "/api/auth/sign-up/email"]) {
      for (const email of [body.email, `${unique("p")}@example.test`]) {
        const res = await form(path, email);
        expect(res.ok, `${path} ${email}`).toBe(false);
        expect(res.headers.getSetCookie().filter((c) => c.includes("session_token")), path).toEqual([]);
      }
    }
    // Someone who really has a password, the right one, gets nowhere either.
    const email = `${unique("p")}@example.test`;
    expect((await post("/api/auth/sign-up/email", { email, password: "local-test-password-123", name: "Has a password" })).status).toBe(200);
    const correct = await form("/api/auth/sign-in/email", email);
    expect(correct.ok).toBe(false);
    expect(correct.headers.getSetCookie().filter((c) => c.includes("session_token"))).toEqual([]);
    // And on the gateway's host, sign-up and sign-in are still its usual 404.
    for (const path of ["/api/auth/sign-in/email", "/api/auth/sign-up/email", "/api/auth/callback/github"]) {
      expect((await send(`${GATEWAY}${path}`, { method: "POST", headers: { origin: GATEWAY, "content-type": "application/json" }, body: "{}" })).status, path).toBe(404);
    }
  });

  it("keeps the reserved domain for test people, so the mark means what it says", async () => {
    const res = await post("/api/auth/sign-up/email", { email: `${unique("p")}@E2E.podster.invalid`, password: "local-test-password-123", name: "Pretender" });
    expect(res.ok).toBe(false);
    expect(res.headers.getSetCookie().filter((c) => c.includes("session_token"))).toEqual([]);
  });

  it("stops after a strict number across all clients, and refuses if it can't count", async () => {
    const live = { ...staging, STRICT_COUNTER: e.STRICT_COUNTER };
    const statuses: number[] = [];
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4", "192.0.2.5", "192.0.2.6", "192.0.2.7"]) {
      statuses.push((await send(`${GATEWAY}/api/auth/sign-up/e2e`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "cf-connecting-ip": ip } }, live)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);

    const before = await peopleCount();
    const over = await signUpAs({ ...staging, STRICT_COUNTER: counter(30) });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("30");
    const broken = { idFromName: (name: string) => name, get: () => ({ take: async () => { throw new Error("down"); } }) };
    expect((await signUpAs({ ...staging, STRICT_COUNTER: broken })).status).toBe(429);
    expect(await peopleCount()).toBe(before);
  });

  it("stops at 40 people a day, whatever the minute's count is", async () => {
    const live = { ...staging, STRICT_COUNTER: e.STRICT_COUNTER };
    const stub = e.STRICT_COUNTER.get(e.STRICT_COUNTER.idFromName("e2e-signup"));
    await runInDurableObject(stub, async (_counter, state) => {
      const now = Date.now();
      await state.storage.put("count", { minuteStart: now, minute: 0, dayStart: now, day: 39 });
    });
    expect((await signUpAs(live)).status).toBe(200);
    const over = await signUpAs(live);
    expect(over.status).toBe(429);
    // Until the day ends, not the minute.
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(3600);
    await runInDurableObject(stub, async (_counter, state) => state.storage.deleteAll());
  });

  describe("a test session's expiry never moves", () => {
    const expiry = async (cookie: string) => {
      const token = decodeURIComponent(cookie.match(/session_token=([^;]+)/)![1]).split(".")[0];
      return (await e.DB.prepare(`SELECT expiresAt FROM session WHERE token = ?`).bind(token).first<{ expiresAt: string }>())!.expiresAt;
    };
    const getSession = (cookie: string, env: object = staging) => send(`${GATEWAY}/api/auth/get-session`, { headers: { cookie } }, env);

    it("stays two hours through the public route that slides sessions", async () => {
      const { cookie } = await testPerson();
      const before = await expiry(cookie);
      for (const env of [staging, { ...staging, ENABLE_E2E_SIGNUP: undefined, E2E_SIGNUP_SECRET: undefined }]) {
        const res = await getSession(cookie, env);
        expect(res.status).toBe(200);
        expect((await res.json<any>()).user.email.endsWith("@e2e.podster.invalid")).toBe(true);
        expect(await expiry(cookie)).toBe(before);
      }
      expect(new Date(before).getTime() - Date.now()).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
      expect((await send(`${GATEWAY}/api/orgs`, { headers: { cookie } })).status).toBe(200);
    });

    it("still slides everyone else's", async () => {
      const email = `${unique("p")}@example.test`;
      const res = await post("/api/auth/sign-up/email", { email, password: "local-test-password-123", name: "Real" });
      const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const signed = await call("/api/auth/get-session", { headers: { cookie } });
      const { session } = await signed.json<any>();
      const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await e.DB.prepare(`UPDATE session SET expiresAt = ? WHERE id = ?`).bind(soon, session.id).run();
      expect((await call("/api/auth/get-session", { headers: { cookie } })).status).toBe(200);
      const after = (await e.DB.prepare(`SELECT expiresAt FROM session WHERE id = ?`).bind(session.id).first<{ expiresAt: string }>())!.expiresAt;
      expect(new Date(after).getTime() - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000);
    });
  });

  it("wrong guesses count under the route's limit per client, like other sign-up routes", () => {
    expect(sensitiveRoute("POST", "/api/auth/sign-up/e2e")).toBe("auth");
  });
});

describe("downloading a file through the gateway", () => {
  /** A room with this agent in it. The room's own answer about an unknown file shows a request got all the way there. */
  async function roomWith(who: Person, agent: string) {
    const made = await dash(who, "POST", "/v1/workspaces", { name: "Files" });
    const id = made.body.id as string;
    const version = (await dash(who, "GET", `/v1/workspaces/${id}`)).body.policy_version;
    const added = await dash(who, "POST", `/v1/workspaces/${id}/members`, { principal_id: agent, kind: "agent", org_id: who.org, role: "member", policy_version: version });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    return id;
  }
  const fetchFile = (id: string, token?: string) => call(`/v1/files/${id}/obj_unknown`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const reply = async (res: Response) => ({ status: res.status, code: (await res.json<any>()).error?.code as string });
  const agentJwt = (agent: AgentAuthAgent) => signAgentJWT({ agentKeypair: agent.keypair, agentId: agent.pluginId, audience: BASE, capabilities: ["get_asset_link"] });

  it("takes an Agent Auth credential on each use, spends it, and stops when it ends", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const id = await roomWith(a, agent.id);
    const jwt = await agentJwt(agent);
    expect(await reply(await fetchFile(id, jwt))).toEqual({ status: 404, code: "file_not_found" });
    expect((await reply(await fetchFile(id, jwt))).code).not.toBe("file_not_found");
    await dash(a, "POST", `/agents/${agent.id}/disconnect`);
    // Disconnecting revokes the agent in the plugin, which refuses it as the capability path does.
    const after = await fetchFile(id, await agentJwt(agent));
    const viaCapability = await execute(agent, "get_asset_link", { workspace_id: id, file_id: "obj_unknown" });
    expect(after.status).toBe(403);
    expect(viaCapability.status).toBe(403);
    expect(await after.json()).toEqual(viaCapability.raw);
    expect(viaCapability.raw.error).toBe("agent_revoked");
  });

  it("verifies a JWT bound to this very request, and refuses one bound to another", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const id = await roomWith(a, agent.id);
    const bound = (htm: string, htu: string) => signAgentJWT({ agentKeypair: agent.keypair, agentId: agent.pluginId, audience: BASE, capabilities: ["get_asset_link"], htm, htu });
    const here = `${BASE}/v1/files/${id}/obj_unknown`;
    expect(await reply(await fetchFile(id, await bound("GET", here)))).toEqual({ status: 404, code: "file_not_found" });
    expect(await reply(await fetchFile(id, await bound("GET", `${BASE}/v1/files/${id}/obj_other`)))).toEqual({ status: 401, code: "invalid_credential" });
    expect(await reply(await fetchFile(id, await bound("POST", here)))).toEqual({ status: 401, code: "invalid_credential" });
  });

  it("takes an MCP access token on each use, and stops when it ends", async () => {
    const a = await signUp();
    const agent = await mcpAgent(a);
    const id = await roomWith(a, agent.id);
    expect(await reply(await fetchFile(id, agent.token))).toEqual({ status: 404, code: "file_not_found" });
    expect(await agent.tool("get_asset_link", { workspace_id: id, file_id: "obj_unknown" })).toMatchObject({ code: "file_not_found" });
    await dash(a, "POST", `/agents/${agent.id}/disconnect`);
    expect(await reply(await fetchFile(id, agent.token))).toEqual({ status: 401, code: "invalid_credential" });
  });

  it("downloads only with the get_asset_link grant, refused the way the capability path refuses it", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const id = await roomWith(a, agent.id);
    const unclaimed = () => signAgentJWT({ agentKeypair: agent.keypair, agentId: agent.pluginId, audience: BASE });
    // A JWT without a capabilities claim covers every grant the agent holds, and one naming get_asset_link covers that.
    expect(await reply(await fetchFile(id, await unclaimed()))).toEqual({ status: 404, code: "file_not_found" });
    expect(await reply(await fetchFile(id, await agentJwt(agent)))).toEqual({ status: 404, code: "file_not_found" });
    const other = await signAgentJWT({ agentKeypair: agent.keypair, agentId: agent.pluginId, audience: BASE, capabilities: ["get_task"] });
    const refusedOther = await fetchFile(id, other);
    expect(refusedOther.status).toBe(403);
    expect(await refusedOther.json()).toEqual({ error: "capability_not_granted", message: 'Agent does not have an active grant for capability "get_asset_link".' });
    await e.DB.prepare("DELETE FROM agentCapabilityGrant WHERE agentId = ? AND capability = 'get_asset_link'").bind(agent.pluginId).run();
    const refused = await fetchFile(id, await unclaimed());
    const viaCapability = await execute(agent, "get_asset_link", { workspace_id: id, file_id: "obj_unknown" });
    expect(refused.status).toBe(viaCapability.status);
    expect(await refused.json()).toEqual(viaCapability.raw);
    // Other grants are untouched, so it's this one capability that's missing.
    expect((await execute(agent, "get_identity")).status).toBe(200);
  });

  it("holds a download to its grant's constraints, as the capability path does", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const allowed = await roomWith(a, agent.id);
    const other = await roomWith(a, agent.id);
    await e.DB.prepare("UPDATE agentCapabilityGrant SET constraints = ? WHERE agentId = ? AND capability = 'get_asset_link'").bind(JSON.stringify({ workspace_id: allowed }), agent.pluginId).run();
    expect(await reply(await fetchFile(allowed, await agentJwt(agent)))).toEqual({ status: 404, code: "file_not_found" });
    const refused = await fetchFile(other, await agentJwt(agent));
    const viaCapability = await execute(agent, "get_asset_link", { workspace_id: other, file_id: "obj_unknown" });
    expect(refused.status).toBe(403);
    expect(viaCapability.status).toBe(403);
    expect(await refused.json()).toEqual(viaCapability.raw);
    expect(viaCapability.raw.error).toBe("constraint_violated");
  });

  it("answers a revoked get_asset_link grant as the capability path does", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const id = await roomWith(a, agent.id);
    await e.DB.prepare("UPDATE agentCapabilityGrant SET status = 'revoked' WHERE agentId = ? AND capability = 'get_asset_link'").bind(agent.pluginId).run();
    const refused = await fetchFile(id, await agentJwt(agent));
    const viaCapability = await execute(agent, "get_asset_link", { workspace_id: id, file_id: "obj_unknown" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(viaCapability.raw);
    expect(viaCapability.raw.error).toBe("grant_revoked");
    expect((await execute(agent, "get_identity")).status).toBe(200);
  });

  it("downloads over MCP only with the scope that grants its tools, get_asset_link among them", async () => {
    const a = await signUp();
    const agent = await mcpAgent(a);
    const id = await roomWith(a, agent.id);
    expect(await reply(await fetchFile(id, agent.token))).toEqual({ status: 404, code: "file_not_found" });
    const [userId, grantId] = agent.token.split(":");
    const { keys } = await e.OAUTH_KV.list({ prefix: `token:${userId}:${grantId}:` });
    expect(keys.length).toBeGreaterThan(0);
    for (const { name } of keys) {
      const held = await e.OAUTH_KV.get<{ grant: Record<string, unknown> }>(name, "json");
      await e.OAUTH_KV.put(name, JSON.stringify({ ...held, scope: [], grant: { ...held!.grant, scope: [] } }));
    }
    const refused = await fetchFile(id, agent.token);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "capability_not_granted", message: 'Agent does not have an active grant for capability "get_asset_link".' });
  });

  it("lists and links input assets through the capability path, which the room decides", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const id = await roomWith(a, agent.id);
    const listed = await execute(agent, "list_assets", { workspace_id: id });
    expect([listed.status, listed.data]).toEqual([200, { files: [], next_cursor: null, quota: { used: 0, limit: 5_000_000_000 } }]);
    const task = await dash(a, "POST", `/v1/workspaces/${id}/tasks`, { title: "Read the brief", instructions: "x" });
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    expect(await execute(agent, "link_asset", { workspace_id: id, file_id: "obj_unknown", task_id: task.body.id, idempotency_key: "link-1" })).toMatchObject({ status: 404, code: "file_not_found" });
    expect(await execute(agent, "unlink_asset", { workspace_id: id, file_id: "obj_unknown", task_id: task.body.id, idempotency_key: "unlink-1" })).toMatchObject({ status: 404, code: "file_not_found" });
    const viaDashboard = await dashboard(a, "GET", `/v1/workspaces/${id}/files`);
    expect(viaDashboard.status).toBe(200);
  });

  it("takes only an MCP token issued for /mcp, not one for another resource", async () => {
    const a = await signUp();
    const agent = await mcpAgent(a);
    const id = await roomWith(a, agent.id);
    const [userId, grantId] = agent.token.split(":");
    const { keys } = await e.OAUTH_KV.list({ prefix: `token:${userId}:${grantId}:` });
    expect(keys.length).toBeGreaterThan(0);
    for (const { name } of keys) {
      const held = await e.OAUTH_KV.get<Record<string, unknown>>(name, "json");
      await e.OAUTH_KV.put(name, JSON.stringify({ ...held, audience: "https://elsewhere.test/api" }));
    }
    expect(await reply(await fetchFile(id, agent.token))).toEqual({ status: 401, code: "invalid_credential" });
  });

  it("matches /mcp the way the provider does, and a token with no audience is its one resource's", () => {
    expect(forMcp(`${BASE}/mcp`, BASE)).toBe(true);
    expect(forMcp(["https://elsewhere.test/mcp", `${BASE.toUpperCase()}/mcp`], BASE)).toBe(true);
    expect(forMcp(undefined, BASE)).toBe(true);
    for (const other of [`${BASE}/mcp/x`, `${BASE}/`, `${BASE}/v1/files`, "https://elsewhere.test/mcp", "not a url", []]) expect(forMcp(other as never, BASE), String(other)).toBe(false);
  });

  it("ends a credential's downloads as soon as whoever connected it leaves, with nothing issued earlier still working", async () => {
    const a = await signUp();
    const viaKey = await claimedAgent(a);
    const viaOauth = await mcpAgent(a);
    const id = await roomWith(a, viaKey.id);
    await e.DB.prepare("DELETE FROM org_member WHERE org_id = ?").bind(a.org).run();
    expect(await reply(await fetchFile(id, await agentJwt(viaKey)))).toEqual({ status: 403, code: "credential_owner_left" });
    expect(await reply(await fetchFile(id, viaOauth.token))).toEqual({ status: 403, code: "credential_owner_left" });
  });

  it("refuses anything that isn't a credential, before it reaches the API", async () => {
    expect(await reply(await fetchFile("ws_x"))).toEqual({ status: 401, code: "invalid_credential" });
    for (const token of ["a.b.c", "x:y:z", `upl_${"a".repeat(64)}`]) expect(await reply(await fetchFile("ws_x", token)), token).toEqual({ status: 401, code: "invalid_credential" });
    expect((await call("/v1/files/ws_x/obj_1", { method: "DELETE" })).status).toBe(405);
  });

  it("takes a person's session on the dashboard's path, which never answers with a client's headers", async () => {
    const a = await signUp();
    const made = await dash(a, "POST", "/v1/workspaces", { name: "Files" });
    const res = await dashboard(a, "GET", `/v1/files/${made.body.id}/obj_unknown`);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await reply(res)).toEqual({ status: 404, code: "file_not_found" });
    expect((await dashboard(a, "POST", `/v1/files/${made.body.id}/obj_unknown`, {})).status).toBe(405);
    expect((await call(`/api/v1/files/${made.body.id}/obj_unknown`)).status).toBe(401);
  });

  it("gives another organization's person the room's one answer", async () => {
    const a = await signUp();
    const b = await signUp();
    const made = await dash(a, "POST", "/v1/workspaces", { name: "Files" });
    expect(await reply(await dashboard(b, "GET", `/v1/files/${made.body.id}/obj_unknown`))).toEqual({ status: 404, code: "workspace_not_found" });
  });
});

describe("a person's public reads (M4 step 7)", () => {
  it("go through the contract's field filter, marked no-store", async () => {
    const who = await signUp();
    const page = await dashboard(who, "GET", "/v1/public/explore");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    // Public rooms are off in this suite, so the page is empty and the room page is the one not-found.
    expect(await page.json()).toEqual({ workrooms: [], next_cursor: null });
    const room = await dashboard(who, "GET", `/v1/public/workrooms/pub_${"ab".repeat(16)}`);
    expect([room.status, room.headers.get("cache-control"), (await room.json<any>()).error.code]).toEqual([404, "no-store", "workspace_not_found"]);
  });
});
