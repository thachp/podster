import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";

/** The whole OAuth path a client takes, through the real gateway: sign-up, registration, consent and the token endpoint. */

export const BASE = "https://gateway.test";
export const REDIRECT = "https://client.test/cb";
export const MCP = `${BASE}/mcp`;
export const A2A = `${BASE}/a2a`;

type Schemas = { DB: D1Database; API_DB: D1Database; TEST_DIRECTORY_SCHEMA: string; TEST_AUTH_SCHEMA: string; TEST_API_SCHEMA: string };
const e = env as unknown as Schemas;
const statements = (sql: string) => sql.split(";").map((s) => s.trim()).filter(Boolean);

export async function setUpSchemas() {
  for (const sql of statements(e.TEST_AUTH_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_DIRECTORY_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_API_SCHEMA)) await e.API_DB.prepare(sql).run();
}

let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}-${crypto.randomUUID().slice(0, 8)}`;
export const call = (path: string, init: RequestInit = {}) => SELF.fetch(BASE + path, { redirect: "manual", ...init });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, ...headers } });

export type Person = { cookie: string; org: string };
export async function signUp(): Promise<Person> {
  const res = await post("/api/auth/sign-up/email", { email: `${unique("p")}@example.test`, password: "local-test-password-123", name: "Test person" });
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const orgs = await (await call("/api/orgs", { headers: { cookie } })).json<any>();
  return { cookie, org: orgs.organizations[0].id };
}

const VERIFIER = "local-test-verifier-".padEnd(64, "y");
async function challenge() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function registerClient(name = "Test client") {
  const reg = await post("/oauth/register", { redirect_uris: [REDIRECT], client_name: name, token_endpoint_auth_method: "none" });
  expect(reg.status).toBe(201);
  return (await reg.json<{ client_id: string }>()).client_id;
}

/** The authorize query for a resource. `resource: null` leaves it out, as an older MCP client would. */
export async function authorizeQuery(clientId: string, resource: string | null, scope: string) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope, code_challenge: await challenge(), code_challenge_method: "S256", state: "s" });
  if (resource) q.set("resource", resource);
  return `?${q}`;
}

export const approve = (who: Person, query: string, fields: Record<string, string> = {}) =>
  call("/authorize", { method: "POST", headers: { cookie: who.cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ oauth_query: query, agent_name: "Agent", org_id: who.org, ...fields }) });

export const tokenRequest = (fields: Record<string, string>) =>
  call("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

/** Consent, then the code for a token. Answers the code too, for tests that spend it themselves. */
export async function consentCode(who: Person, clientId: string, resource: string | null, scope: string, fields: Record<string, string> = {}) {
  const res = await approve(who, await authorizeQuery(clientId, resource, scope), fields);
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!).searchParams.get("code")!;
}

export type Tokens = { clientId: string; access: string; refresh: string; scope: string; resource?: string };
export async function connect(who: Person, resource: string | null, scope: string, opts: { clientId?: string; fields?: Record<string, string> } = {}): Promise<Tokens> {
  const clientId = opts.clientId ?? (await registerClient());
  const code = await consentCode(who, clientId, resource, scope, opts.fields);
  const fields: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: VERIFIER };
  if (resource) fields.resource = resource;
  const res = await tokenRequest(fields);
  expect(res.status).toBe(200);
  const body = await res.json<any>();
  return { clientId, access: body.access_token, refresh: body.refresh_token, scope: body.scope ?? "", resource: body.resource };
}

export { VERIFIER };

/** One MCP tool call, so a test can tell an MCP token still works. */
export async function mcpIdentity(token: string) {
  const res = await call("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_identity", arguments: {} } }),
  });
  if (res.status !== 200) return { status: res.status, id: undefined as string | undefined };
  const parsed = await res.json<any>();
  const text = parsed.result?.content?.[0]?.text;
  return { status: res.status, id: parsed.result?.isError ? undefined : (JSON.parse(text).id as string) };
}

let seq = 0;
/** One A2A call. `token: null` sends none. */
export async function a2a(method: string, params: unknown, token: string | null, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "content-type": "application/json", "A2A-Version": "1.0", ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await call("/a2a", { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) });
  return { res, status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json<any>() : null };
}
