import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AGENT } from "../src/identity";

const BASE = "http://localhost:8787";
const REDIRECT = "http://127.0.0.1:9999/callback";

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function register() {
  const res = await SELF.fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], client_name: "spike" }),
  });
  expect(res.status).toBe(201);
  return (await res.json<{ client_id: string }>()).client_id;
}

/** A whole authorization-code flow with PKCE. `resource` undefined leaves it out, as an older client would. */
async function tokenFor(resource: string | undefined, scope = resource?.endsWith("/a2a") ? "a2a offline_access" : "mcp offline_access") {
  const clientId = await register();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope, state: "s", code_challenge: challenge, code_challenge_method: "S256" });
  if (resource) q.set("resource", resource);
  const auth = await SELF.fetch(`${BASE}/authorize?${q}`, { redirect: "manual" });
  if (auth.status !== 302) return { error: auth.status, body: await auth.text() };
  const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
  if (resource) form.set("resource", resource);
  const res = await SELF.fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const body = await res.json<any>();
  return { clientId, status: res.status, access: body.access_token as string, refresh: body.refresh_token as string, scope: (body.scope ?? "") as string, resource: body.resource as string | undefined };
}

const bearer = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const atMcp = (token: string) => SELF.fetch(`${BASE}/mcp`, { method: "POST", headers: bearer(token) });
const atFiles = (token: string) => SELF.fetch(`${BASE}/v1/files/fil_1`, { headers: bearer(token) });
const atA2a = (token: string) =>
  SELF.fetch(`${BASE}/a2a`, {
    method: "POST",
    headers: bearer(token, { "content-type": "application/json", "A2A-Version": "1.0" }),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "tsk_whoami" } }),
  });

describe("two resources, two audiences, one identity", () => {
  it("issues an /a2a token that works at /a2a and resolves to the same agent", async () => {
    const t = await tokenFor(`${BASE}/a2a`);
    expect(t.status).toBe(200);
    expect(t.resource).toBe(`${BASE}/a2a`);
    expect(t.scope!.split(" ")).toContain("a2a");
    expect(t.scope!.split(" ")).not.toContain("mcp");
    const res = await atA2a(t.access!);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.result.metadata.agent).toBe(AGENT);
  });

  it("refuses an /a2a token at /mcp and at /v1/files", async () => {
    const t = await tokenFor(`${BASE}/a2a`);
    expect((await atMcp(t.access!)).status).toBe(401);
    expect((await atFiles(t.access!)).status).toBe(401);
  });

  it("refuses an /mcp token at /a2a, and it still works at /mcp and /v1/files", async () => {
    const t = await tokenFor(`${BASE}/mcp`);
    expect((await atA2a(t.access!)).status).toBe(401);
    const mcp = await atMcp(t.access!);
    expect(mcp.status).toBe(200);
    expect((await mcp.json<any>()).agent).toBe(AGENT);
    expect((await atFiles(t.access!)).status).toBe(200);
  });

  it("gives a client that leaves resource out an MCP token, as today", async () => {
    const t = await tokenFor(undefined, "mcp offline_access");
    expect(t.status).toBe(200);
    expect(t.resource).toBe(`${BASE}/mcp`);
    expect((await atMcp(t.access!)).status).toBe(200);
    expect((await atA2a(t.access!)).status).toBe(401);
  });

  it("never grants mcp scope on an /a2a token, even when asked", async () => {
    const t = await tokenFor(`${BASE}/a2a`, "mcp a2a offline_access");
    expect(t.scope!.split(" ")).not.toContain("mcp");
    expect((await atMcp(t.access!)).status).toBe(401);
  });

  it("won't retarget an /a2a refresh token to /mcp", async () => {
    const t = await tokenFor(`${BASE}/a2a`);
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh!, client_id: t.clientId!, resource: `${BASE}/mcp` });
    const res = await SELF.fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error).toBe("invalid_target");
  });

  it("refuses an unknown resource", async () => {
    const t = await tokenFor(`${BASE}/elsewhere`);
    expect(t.error).toBe(400);
  });

  it("answers an unauthenticated /a2a call with a challenge naming /a2a's own metadata", async () => {
    const res = await SELF.fetch(`${BASE}/a2a`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/a2a");
    const meta = await (await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/a2a`)).json<any>();
    expect(meta.resource).toBe(`${BASE}/a2a`);
  });

  it("disconnecting revokes both kinds of token", async () => {
    const a = await tokenFor(`${BASE}/a2a`);
    const m = await tokenFor(`${BASE}/mcp`);
    const res = await SELF.fetch(`${BASE}/spike/disconnect`, { method: "POST" });
    expect((await res.json<any>()).revoked).toBeGreaterThanOrEqual(2);
    expect((await atA2a(a.access!)).status).toBe(401);
    expect((await atMcp(m.access!)).status).toBe(401);
    expect((await atFiles(m.access!)).status).toBe(401);
  });
});
