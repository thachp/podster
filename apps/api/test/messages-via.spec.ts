import { env, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * M3 step 9: a message the gateway marks `via: a2a` is refused once its task is finished (spec 3.1.1, ADR 0007), by
 * `podster_core::a2a::accepts_inbound_message`. A message with no `via`, as MCP sends, isn't affected.
 */

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const OWNER: Who = { id: "per_mv_owner", kind: "person", org: "org_mv", adminOrgs: ["org_mv"] };
const MEMBER: Who = { id: "agt_mv_member", org: "org_mv" };
const GUEST: Who = { id: "agt_mv_guest", org: "org_mv" };
const orgAdmin = (org: string): Who => ({ id: `per_mv_admin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }) })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `mv-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

let room: string;
const version = async () => (await api(OWNER, "GET", `/v1/workspaces/${room}`)).body.policy_version;
const task = async (assignee?: string) => (await api(MEMBER, "POST", `/v1/workspaces/${room}/tasks`, { title: "t", instructions: "x", ...(assignee ? { assignee } : {}) })).body;
const post = (who: Who, taskId: string, body: Record<string, unknown>) => api(who, "POST", `/v1/workspaces/${room}/tasks/${taskId}/messages`, body);
const cancel = async (t: { id: string; version: number }) => {
  const res = await api(MEMBER, "POST", `/v1/workspaces/${room}/tasks/${t.id}/cancel`, { version: t.version, reason: "done with it" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [MEMBER, GUEST]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
  room = (await api(OWNER, "POST", "/v1/workspaces", { name: "Via" })).body.id;
  for (const [who, role] of [[MEMBER, "member"], [GUEST, "guest"]] as const) {
    const r = await api(OWNER, "POST", `/v1/workspaces/${room}/members`, { principal_id: who.id, kind: "agent", org_id: who.org, role, policy_version: await version() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
});

describe("messages marked via a2a", () => {
  it("post to an unfinished task as any message does", async () => {
    const t = await task(GUEST.id);
    expect((await post(GUEST, t.id, { body: "hi", via: "a2a" })).status).toBe(200);
  });

  it("are refused with task_closed once the task is finished, and MCP's aren't", async () => {
    const t = await task(GUEST.id);
    await cancel(t);
    const a2a = await post(GUEST, t.id, { body: "late", via: "a2a" });
    expect(a2a.status).toBe(409);
    expect(a2a.code).toBe("task_closed");
    expect((await post(GUEST, t.id, { body: "late, over MCP" })).status).toBe(200);
  });

  it("answer task_not_found for a hidden task before anything about its state", async () => {
    const hidden = await task();
    await cancel(hidden);
    const res = await post(GUEST, hidden.id, { body: "x", via: "a2a" });
    expect(res.status).toBe(404);
    expect(res.code).toBe("task_not_found");
  });

  it("refuse any other via", async () => {
    const t = await task(GUEST.id);
    for (const via of ["mcp", "A2A", "", 1]) {
      expect((await post(GUEST, t.id, { body: "x", via })).code, String(via)).toBe("invalid_argument");
    }
  });
});
