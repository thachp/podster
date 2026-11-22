import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifiedEmailFor, type Env } from "../src/index";

// A person invitation (decision 241, CROSS-ORG-PEOPLE.md), through the real gateway and API: the gateway states the
// signed-in person's email on the preview and accept routes only when Better Auth's row marks it verified, and the API
// decides. A test person's address is sent only where the deployment admits test people.

const BASE = "https://gateway.test";
const e = env as unknown as Env & { TEST_DIRECTORY_SCHEMA: string; TEST_AUTH_SCHEMA: string; TEST_API_SCHEMA: string; API_DB: D1Database };
const statements = (sql: string) => sql.split(";").map((s) => s.trim()).filter(Boolean);
let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}-${crypto.randomUUID().slice(0, 8)}`;

type Person = { cookie: string; id: string; personal: string; email: string };
const call = (path: string, init: RequestInit = {}) => SELF.fetch(BASE + path, { redirect: "manual", ...init });
async function dash(who: { cookie: string }, method: string, path: string, body?: unknown) {
  const res = await call(`/api${path}`, { method, headers: { cookie: who.cookie, origin: BASE, "content-type": "application/json", "idempotency-key": unique("k") }, body: body === undefined ? undefined : JSON.stringify(body) });
  const parsed = await res.json<any>();
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}
async function signUp(name = "Test person"): Promise<Person> {
  const email = `${unique("p")}@example.test`;
  const res = await call("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: "local-test-password-123", name }) });
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const me = await dash({ cookie }, "GET", "/v1/me");
  return { cookie, id: me.body.id, personal: me.body.org_id, email };
}
const userId = (who: Person) => who.id.slice("per_".length);
const verify = (who: Person) => e.DB.prepare(`UPDATE "user" SET emailVerified = 1 WHERE id = ?`).bind(userId(who)).run();

beforeAll(async () => {
  for (const sql of statements(e.TEST_AUTH_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_DIRECTORY_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_API_SCHEMA)) await e.API_DB.prepare(sql).run();
});

async function invited(owner: Person, email: string) {
  const room = (await dash(owner, "POST", "/v1/workspaces", { name: "Independent Creator Demo" })).body.id as string;
  const version = (await dash(owner, "GET", `/v1/workspaces/${room}`)).body.policy_version;
  const made = await dash(owner, "POST", `/v1/workspaces/${room}/invitations`, { policy_version: version, invitee: { kind: "person", email: email.toUpperCase() } });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return { room, token: made.body.token as string };
}

describe("a person invitation through the gateway", () => {
  it("is refused to an unverified email, then previewed and accepted once Better Auth's row says it's verified", async () => {
    const [owner, long] = [await signUp("Owner"), await signUp("Long")];
    const { room, token } = await invited(owner, long.email);
    for (const path of ["/v1/invitations/preview", "/v1/invitations/accept"]) {
      const refused = await dash(long, "POST", path, { token, org_id: long.personal });
      expect([refused.status, refused.code], path).toEqual([404, "invitation_not_found"]);
    }
    await verify(long);
    const preview = await dash(long, "POST", "/v1/invitations/preview", { token });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ workspace_id: room, invitee_kind: "person", role: "guest", orgs: [long.personal] });
    // Someone else holding the link, verified, learns nothing.
    const other = await signUp("Forwarded to");
    await verify(other);
    expect((await dash(other, "POST", "/v1/invitations/preview", { token })).code).toBe("invitation_not_found");
    const accepted = await dash(long, "POST", "/v1/invitations/accept", { token, org_id: long.personal });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await dash(long, "GET", `/v1/workspaces/${room}`)).status).toBe(200);
    // Used: a second accept by anyone else is the same as a bad link.
    expect((await dash(other, "POST", "/v1/invitations/accept", { token, org_id: other.personal })).code).toBe("invitation_not_found");
    expect((await dash(long, "POST", `/v1/workspaces/${room}/leave`, {})).status).toBe(200);
    expect((await dash(long, "GET", `/v1/workspaces/${room}`)).code).toBe("access_revoked");
  });

  it("states a test person's address only where the deployment admits test people", async () => {
    const id = `e2e_${crypto.randomUUID().replaceAll("-", "")}`;
    const email = `${unique("t")}@e2e.podster.invalid`;
    await e.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Test', ?, 0, ?, ?)`).bind(id, email, Date.now(), Date.now()).run();
    expect(await verifiedEmailFor(e, id)).toBeUndefined();
    const admitted = { ...e, ENABLE_E2E_SIGNUP: "true", BASE_URL: "https://gateway-staging.podster.dev", E2E_SIGNUP_SECRET: "s".repeat(32) };
    expect(await verifiedEmailFor(admitted, id)).toBe(email);
    // Without the secret, or anywhere but staging's gateway, it isn't.
    expect(await verifiedEmailFor({ ...admitted, E2E_SIGNUP_SECRET: undefined }, id)).toBeUndefined();
    expect(await verifiedEmailFor({ ...admitted, BASE_URL: BASE }, id)).toBeUndefined();
    // Marked verified makes no difference to a test address outside such a deployment.
    await e.DB.prepare(`UPDATE "user" SET emailVerified = 1 WHERE id = ?`).bind(id).run();
    expect(await verifiedEmailFor(e, id)).toBeUndefined();
    expect(await verifiedEmailFor(e, "no-such-user")).toBeUndefined();
  });
});
