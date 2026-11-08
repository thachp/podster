import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildOAuth, routeOAuth } from "../src/oauth";
import { A2A, BASE, MCP, REDIRECT, VERIFIER, a2a, authorizeQuery, call, connect, consentCode, mcpIdentity, registerClient, setUpSchemas, signUp, tokenRequest, type Person } from "./oauth-helpers";

/**
 * M3 step 7: one authorization server, two resources, two audiences, one agent identity (ADR 0007). These are AC-12's
 * wrong-audience negatives for the new resource, and the checks ADR 0007 listed as untested by spike B.
 */

const e = env as unknown as { OAUTH_KV: KVNamespace; DB: D1Database };
const atA2a = (token: string) => a2a("GetTask", { id: "tsk_x" }, token);
const atFiles = (token: string) => call("/v1/files/ws_x/fil_x", { headers: { authorization: `Bearer ${token}` } });
const refresh = (t: { clientId: string; refresh: string }, resource?: string) =>
  tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: t.clientId, ...(resource ? { resource } : {}) });
const disconnect = (who: Person, agentId: string) =>
  call(`/api/agents/${agentId}/disconnect`, { method: "POST", headers: { cookie: who.cookie, origin: BASE, "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: "{}" });

/** The KV records the OAuth package keeps for a person's grants and tokens, so a test can age one into an older shape. */
async function records(prefix: string) {
  const out: { key: string; value: any }[] = [];
  let cursor: string | undefined;
  do {
    const page = await e.OAUTH_KV.list({ prefix, cursor });
    for (const k of page.keys) out.push({ key: k.name, value: await e.OAUTH_KV.get(k.name, "json") });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

let who: Person;
beforeAll(async () => {
  await setUpSchemas();
  who = await signUp();
});

describe("each resource's tokens work only there", () => {
  it("an /a2a token reaches /a2a, and is refused at /mcp and at downloads", async () => {
    const t = await connect(who, A2A, "a2a");
    expect(t.resource).toBe(A2A);
    expect(t.scope.split(" ")).toContain("a2a");
    expect(t.scope.split(" ")).not.toContain("mcp");
    const at = await atA2a(t.access);
    expect(at.status).toBe(200);
    // It got past authentication: the task simply doesn't exist.
    expect(at.body.error.data[0].reason).toMatch(/TASK_NOT_FOUND/);
    expect((await mcpIdentity(t.access)).status).toBe(401);
    expect((await atFiles(t.access)).status).toBe(401);
  });

  it("an /mcp token reaches /mcp, and is refused at /a2a", async () => {
    const t = await connect(who, MCP, "mcp");
    expect((await mcpIdentity(t.access)).id).toMatch(/^agt_/);
    expect((await atA2a(t.access)).status).toBe(401);
  });

  it("a client that names no resource gets an /mcp token, as today's MCP clients do", async () => {
    const t = await connect(who, null, "mcp");
    expect((await mcpIdentity(t.access)).id).toMatch(/^agt_/);
    expect((await atA2a(t.access)).status).toBe(401);
  });
});

describe("consent grants only the resource's own scope", () => {
  it("refuses mcp scope on an /a2a request, and a2a scope on an /mcp one", async () => {
    const clientId = await registerClient();
    expect((await call(`/authorize${await authorizeQuery(clientId, A2A, "mcp")}`, { headers: { cookie: who.cookie } })).status).toBe(400);
    expect((await call(`/authorize${await authorizeQuery(clientId, A2A, "a2a mcp")}`, { headers: { cookie: who.cookie } })).status).toBe(400);
    expect((await call(`/authorize${await authorizeQuery(clientId, MCP, "a2a")}`, { headers: { cookie: who.cookie } })).status).toBe(400);
    expect((await call(`/authorize${await authorizeQuery(clientId, null, "a2a")}`, { headers: { cookie: who.cookie } })).status).toBe(400);
    expect((await call(`/authorize${await authorizeQuery(clientId, `${BASE}/elsewhere`, "mcp")}`, { headers: { cookie: who.cookie } })).status).toBe(400);
  });

  it("says on the consent page when an app asks to act over A2A", async () => {
    const clientId = await registerClient();
    const page = await (await call(`/authorize${await authorizeQuery(clientId, A2A, "a2a")}`, { headers: { cookie: who.cookie } })).text();
    expect(page).toContain("over A2A");
    const mcpPage = await (await call(`/authorize${await authorizeQuery(clientId, MCP, "mcp")}`, { headers: { cookie: who.cookie } })).text();
    expect(mcpPage).not.toContain("over A2A");
  });
});

describe("a code or refresh token can't change its resource", () => {
  it("refuses an /mcp code spent with resource=/a2a", async () => {
    const clientId = await registerClient();
    const code = await consentCode(who, clientId, MCP, "mcp");
    const res = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: VERIFIER, resource: A2A });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).access_token).toBeUndefined();
  });

  it("refuses an /mcp refresh with resource=/a2a, and an /a2a refresh with resource=/mcp", async () => {
    const m = await connect(who, MCP, "mcp offline_access");
    const a = await connect(who, A2A, "a2a offline_access");
    for (const res of [await refresh(m, A2A), await refresh(a, MCP)]) {
      expect(res.status).toBe(400);
      expect((await res.json<any>()).error).toMatch(/invalid_target|invalid_grant/);
    }
    // Without `resource`, each refresh stays where it was.
    const again = await (await refresh(m)).json<any>();
    expect((await mcpIdentity(again.access_token)).id).toMatch(/^agt_/);
    expect((await atA2a(again.access_token)).status).toBe(401);
  });

  it("keeps a grant stored with no resource an /mcp grant, and refuses it for /a2a", async () => {
    const m = await connect(who, MCP, "mcp offline_access");
    // Age the grant into the shape it had before there was a second resource: no stored resource at all.
    const grants = (await records("grant:")).filter((g) => g.value?.clientId === m.clientId);
    expect(grants).toHaveLength(1);
    const { resource: _dropped, ...legacy } = grants[0].value;
    await e.OAUTH_KV.put(grants[0].key, JSON.stringify(legacy));
    const toA2a = await refresh(m, A2A);
    expect(toA2a.status).toBe(400);
    const plain = await refresh(m);
    expect(plain.status).toBe(200);
    const token = (await plain.json<any>()).access_token;
    expect((await mcpIdentity(token)).id).toMatch(/^agt_/);
    expect((await atA2a(token)).status).toBe(401);
  });
});

describe("each resource checks its own scope", () => {
  /** Strips a live token's scopes in KV, as a grant that never had them would be, and keeps its audience. */
  async function withoutScopes(access: string) {
    const [userId, grantId] = access.split(":");
    const tokens = await records(`token:${userId}:${grantId}:`);
    expect(tokens).toHaveLength(1);
    const value = tokens[0].value;
    await e.OAUTH_KV.put(tokens[0].key, JSON.stringify({ ...value, scope: [], grant: { ...value.grant, scope: [] } }));
  }

  it("/mcp answers 403 insufficient_scope to an /mcp token without mcp", async () => {
    const t = await connect(who, MCP, "mcp");
    await withoutScopes(t.access);
    const res = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${t.access}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain("insufficient_scope");
  });

  it("/a2a answers 403 insufficient_scope to an /a2a token without a2a", async () => {
    const t = await connect(who, A2A, "a2a");
    await withoutScopes(t.access);
    const { res } = await atA2a(t.access);
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain("insufficient_scope");
  });
});

describe("one identity, and consent replaces only the same resource's grant", () => {
  it("consenting to /a2a keeps the same client's /mcp grant, and a new /mcp consent replaces only the old /mcp one", async () => {
    const clientId = await registerClient();
    const m1 = await connect(who, MCP, "mcp", { clientId });
    const a = await connect(who, A2A, "a2a", { clientId });
    expect((await mcpIdentity(m1.access)).id).toMatch(/^agt_/);
    expect((await atA2a(a.access)).status).toBe(200);
    const m2 = await connect(who, MCP, "mcp", { clientId });
    expect((await mcpIdentity(m1.access)).status).toBe(401);
    expect((await mcpIdentity(m2.access)).id).toMatch(/^agt_/);
    expect((await atA2a(a.access)).status).toBe(200);
  });

  it("the same client's /mcp and /a2a grants are one agent, and a second client links to it on consent", async () => {
    const clientId = await registerClient();
    const m = await connect(who, MCP, "mcp", { clientId });
    const agentId = (await mcpIdentity(m.access)).id!;
    await connect(who, A2A, "a2a", { clientId });
    const second = await connect(who, A2A, "a2a", { fields: { link_agent_id: agentId } });
    expect(second.access).toBeTruthy();
    const { results } = await e.DB.prepare(`SELECT DISTINCT agent_id FROM identity_link WHERE agent_id = ?`).bind(agentId).all<{ agent_id: string }>();
    expect(results).toEqual([{ agent_id: agentId }]);
    const links = await e.DB.prepare(`SELECT COUNT(*) AS n FROM identity_link WHERE agent_id = ? AND provider = 'mcp_oauth'`).bind(agentId).first<{ n: number }>();
    expect(links!.n).toBe(2);
  });

  it("disconnecting the agent ends its /mcp and /a2a tokens together", async () => {
    const owner = await signUp();
    const clientId = await registerClient();
    const m = await connect(owner, MCP, "mcp", { clientId });
    const a = await connect(owner, A2A, "a2a", { clientId });
    const agentId = (await mcpIdentity(m.access)).id!;
    expect((await disconnect(owner, agentId)).status).toBe(200);
    expect((await mcpIdentity(m.access)).status).toBe(401);
    expect((await atA2a(a.access)).status).toBe(401);
  });
});

describe("discovery", () => {
  it("publishes each resource's own metadata, and the authorization server lists both", async () => {
    const mcpMeta = await (await call("/.well-known/oauth-protected-resource/mcp")).json<any>();
    const a2aMeta = await (await call("/.well-known/oauth-protected-resource/a2a")).json<any>();
    expect(mcpMeta.resource).toBe(MCP);
    expect(a2aMeta.resource).toBe(A2A);
    expect(mcpMeta.scopes_supported).toEqual(["mcp"]);
    expect(a2aMeta.scopes_supported).toEqual(["a2a"]);
    expect((await call("/.well-known/oauth-protected-resource/elsewhere")).status).toBe(404);
    const as = await (await call("/.well-known/oauth-authorization-server")).json<any>();
    expect(as.issuer).toBe(BASE);
  });

});

describe("small things the deeper pass found", () => {
  it("answers a preflight to /a2a with CORS, and still refuses HEAD", async () => {
    const pre = await call("/a2a", { method: "OPTIONS", headers: { origin: "https://client.test", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, a2a-version" } });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get("access-control-allow-origin")).toBeTruthy();
    expect((await call("/a2a", { method: "HEAD" })).status).toBe(405);
  });

  it("names a new agent from an A2A consent for A2A, when the person gives no name", async () => {
    const t = await connect(who, A2A, "a2a", { fields: { agent_name: "" } });
    expect(t.access).toBeTruthy();
    const row = await e.DB.prepare(`SELECT a.name FROM podster_agent a JOIN identity_link l ON l.agent_id = a.id WHERE l.provider = 'mcp_oauth' ORDER BY l.created_at DESC LIMIT 1`).first<{ name: string }>();
    expect(row!.name).toBe("A2A agent");
  });

  it("gives an env new helpers when the build changes, so they never belong to another issuer", async () => {
    const reused = { OAUTH_KV: e.OAUTH_KV } as any;
    const seen: unknown[] = [];
    const app = { fetch: async (_r: Request, env: any) => (seen.push(env.OAUTH_PROVIDER), new Response("ok")) };
    const handlers = { mcp: app, a2a: app };
    const first = buildOAuth<any>("https://one.test", handlers);
    const second = buildOAuth<any>("https://two.test", handlers);
    await routeOAuth(first, new Request("https://one.test/x"), reused, {} as ExecutionContext, app);
    await routeOAuth(first, new Request("https://one.test/x"), reused, {} as ExecutionContext, app);
    await routeOAuth(second, new Request("https://two.test/x"), reused, {} as ExecutionContext, app);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
  });
});
