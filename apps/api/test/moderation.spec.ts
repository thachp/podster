import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// Reports and operator actions (M4 step 10, decisions 158 and 160): signed-in people report public rooms and agents, and
// Podster operators, named in the API's configuration, suspend and lift a room's public surface and an agent's public claims.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number; linker?: string };
const ORG = "org_mod_room";
const OWNER: Who = { id: "per_mod_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const ADMIN: Who = { id: "per_mod_admin", kind: "person", org: ORG };
const STRANGER: Who = { id: "per_mod_stranger", kind: "person", org: "org_mod_x", adminOrgs: ["org_mod_x"] };
const orgAdmin = (org: string): Who => ({ id: `per_claim_orgadmin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  const agentClaims = isAgent ? { gen: who.gen ?? 1, linker: { person: who.linker ?? `per_linker_${who.id}`, since: 1 } } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] };
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...agentClaims, ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, opts: { claims?: object; on?: boolean; key?: string } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, opts.claims ?? {}), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = opts.key ?? `mod-key-${++counter}`;
  if (opts.on ?? true) headers["x-test-public-rooms"] = "on";
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, text };
}

let agents = 0;
/** A fresh agent of `org`, linked by `linker`, with its owner's policy set. */
async function agent(org?: string, policy: "public_claims" | "invitations_only" = "public_claims", linker?: string): Promise<Who> {
  const n = ++agents;
  // Each agent has its own organization unless a test shares one, so one test's claims don't use up another's hour.
  const who: Who = { id: `agt_mod_${n}_${crypto.randomUUID().slice(0, 6)}`, org: org ?? `org_mod_${n}`, linker };
  const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
  expect(res.status, "register").toBe(200);
  if (policy === "public_claims") await setPolicy(who, "public_claims");
  return who;
}
const setPolicy = async (who: Who, policy: string) => {
  const r = await api(orgAdmin(who.org), "PUT", `/v1/agents/${who.id}/participation-policy`, { policy });
  expect(r.status, r.text).toBe(200);
};

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql));
const inPrincipal = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(id)), (_: any, state: any) => fn(state.storage.sql));
const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
const drain = async (id: string) => {
  for (let n = 0; n < 5; n++) await runDurableObjectAlarm(stub(id));
};

/** A public room with an admin and a publicly claimable opening. Returns its ID, handle and opening. */
async function publicRoom(opts: { capacity?: number; preset?: string } = {}) {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Open survey" })).body.id;
  const added = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: ADMIN.id, kind: "person", org_id: ORG, role: "admin", policy_version: await version(id) }, { claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } });
  expect(added.status, added.text).toBe(200);
  expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/review-policy`, { require_person: true, policy_version: await version(id) })).status).toBe(200);
  const opening = await api(OWNER, "POST", `/v1/workspaces/${id}/roles`, { title: "Surveyor", responsibilities: "Count fish", preset: opts.preset ?? "public_participant", capacity: opts.capacity ?? 5, publicly_claimable: true, policy_version: await version(id) });
  expect(opening.status, opening.text).toBe(200);
  const hash = (await api(OWNER, "GET", `/v1/workspaces/${id}/visibility`)).body.view_hash;
  const done = await api(OWNER, "PUT", `/v1/workspaces/${id}/visibility`, { visibility: "public", view_hash: hash });
  expect(done.status, done.text).toBe(200);
  await drain(id);
  return { id, handle: done.body.public_handle as string, role: opening.body.id as string };
}
const claim = (who: Who, handle: string, role: string, opts: { claims?: object; on?: boolean } = {}) => api(who, "POST", `/v1/public/workrooms/${handle}/claim`, { role_id: role }, opts);
const release = (who: Who, room: string, role: string) => api(who, "POST", `/v1/workspaces/${room}/roles/${role}/release`, {});

async function publicAssertion() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "public" })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
const page = async (handle: string) => {
  const res = await SELF.fetch(`https://api.internal/v1/public/workrooms/${handle}`, { headers: { "x-podster-assertion": await publicAssertion(), "x-test-public-rooms": "on" } });
  await res.text();
  return res.status;
};
// Listed in the test configuration's OPERATORS.
const OPERATOR: Who = { id: "per_operator_one", kind: "person", org: "org_podster" };
const person = (n: string): Who => ({ id: `per_mod_reporter_${n}_${crypto.randomUUID().slice(0, 6)}`, kind: "person", org: "org_mod_people" });
const report = (who: Who, body: object, opts: { key?: string } = {}) => api(who, "POST", "/v1/reports", body, opts);
const indexRow = (id: string) => BINDINGS.DB.prepare("SELECT resolvable, listed FROM public_workroom_index WHERE workspace_id = ?").bind(id).first();
const suspendRoom = (who: Who, handle: string, reason = "abuse") => api(who, "POST", `/v1/moderation/rooms/${handle}/suspend`, { reason });
const liftRoom = (who: Who, handle: string) => api(who, "POST", `/v1/moderation/rooms/${handle}/lift`, { reason: "other" });

describe("reports (decision 160)", () => {
  it("takes a signed-in person's report of a public room or an agent in one, and refuses anything else", async () => {
    const room = await publicRoom();
    const reporter = person("a");
    const made = await report(reporter, { handle: room.handle, reason: "spam", note: "Selling things" });
    expect(made.status, made.text).toBe(200);
    expect(made.body.id).toMatch(/^rpt_[0-9a-f]{32}$/);
    const taker = await agent();
    expect((await report(reporter, { handle: room.handle, agent_id: taker.id, reason: "impersonation" })).status).toBe(200);
    // Agents can't report, and nothing but the listed fields is taken.
    expect((await report(taker, { handle: room.handle, reason: "spam" })).code).toBe("not_allowed");
    expect((await report(reporter, { handle: room.handle, reason: "rude" })).code).toBe("invalid_argument");
    expect((await report(reporter, { handle: room.handle, reason: "spam", note: "x".repeat(1025) })).code).toBe("invalid_argument");
    expect((await report(reporter, { handle: room.handle, reason: "spam", extra: 1 })).code).toBe("invalid_argument");
    expect((await report(reporter, { handle: room.handle, agent_id: "per_someone", reason: "spam" })).code).toBe("invalid_argument");
    // Only a room public now.
    expect((await report(reporter, { handle: `pub_${"0".repeat(32)}`, reason: "spam" })).code).toBe("workspace_not_found");
    expect((await report(reporter, { handle: room.id, reason: "spam" })).code).toBe("workspace_not_found");
    expect((await api(OWNER, "PUT", `/v1/workspaces/${room.id}/visibility`, { visibility: "private" })).status).toBe(200);
    await drain(room.id);
    expect((await report(reporter, { handle: room.handle, reason: "spam" })).code).toBe("workspace_not_found");
  });

  it("holds a person to 10 reports a day, and answers a retry with the same report", async () => {
    const room = await publicRoom();
    const reporter = person("b");
    const first = await report(reporter, { handle: room.handle, reason: "spam" }, { key: "same-report" });
    const again = await report(reporter, { handle: room.handle, reason: "spam" }, { key: "same-report" });
    expect(again.body).toEqual(first.body);
    for (let n = 0; n < 9; n++) expect((await report(reporter, { handle: room.handle, reason: "abuse" })).status).toBe(200);
    expect((await report(reporter, { handle: room.handle, reason: "abuse" })).code).toBe("limit_exceeded");
    // Someone else still can.
    expect((await report(person("c"), { handle: room.handle, reason: "abuse" })).status).toBe(200);
  });
});

describe("the operators' queue", () => {
  it("shows reports to operators only, newest first, without the reporter or the room's internal ID", async () => {
    const room = await publicRoom();
    const reporter = person("d");
    const made = await report(reporter, { handle: room.handle, reason: "privacy", note: "My address" });
    expect((await api(reporter, "GET", "/v1/moderation/reports")).code).toBe("not_allowed");
    expect((await api(OWNER, "GET", "/v1/moderation/reports")).code).toBe("not_allowed");
    // An agent is never an operator, even under a listed ID: refused before or by the operator check.
    const asAgent = await api({ id: OPERATOR.id, org: "org_podster" }, "GET", "/v1/moderation/reports");
    expect(asAgent.status).toBe(403);
    expect(["not_allowed", "agent_disconnected"]).toContain(asAgent.code);
    const queue = await api(OPERATOR, "GET", "/v1/moderation/reports");
    expect(queue.status, queue.text).toBe(200);
    expect(queue.body.reports[0]).toEqual({ id: made.body.id, handle: room.handle, agent_id: null, reason: "privacy", note: "My address", created_at: made.body.created_at });
    expect(queue.text).not.toContain(reporter.id);
    expect(queue.text).not.toContain(room.id);
  });

  it("pages 50 at a time", async () => {
    const room = await publicRoom();
    for (let p = 0; p < 6; p++) {
      const reporter = person(`page${p}`);
      for (let n = 0; n < 10; n++) expect((await report(reporter, { handle: room.handle, reason: "spam" })).status).toBe(200);
    }
    const first = await api({ ...OPERATOR, id: "per_operator_two" }, "GET", "/v1/moderation/reports");
    expect(first.body.reports).toHaveLength(50);
    expect(typeof first.body.next_cursor).toBe("string");
    const second = await api(OPERATOR, "GET", `/v1/moderation/reports?cursor=${first.body.next_cursor}`);
    expect(second.body.reports.length).toBeGreaterThan(0);
    const ids = new Set([...first.body.reports, ...second.body.reports].map((r: any) => r.id));
    expect(ids.size).toBe(first.body.reports.length + second.body.reports.length);
    expect((await api(OPERATOR, "GET", "/v1/moderation/reports?cursor=abc")).code).toBe("invalid_argument");
  });
});

describe("suspending a room's public surface (decision 158)", () => {
  it("hides the room, refuses claims and publishing, tells the owner, and lifts by its handle even after it went private", async () => {
    const room = await publicRoom();
    const held = await agent();
    expect((await claim(held, room.handle, room.role)).status).toBe(200);
    expect(await page(room.handle)).toBe(200);
    expect((await suspendRoom(OWNER, room.handle)).code).toBe("not_allowed");
    expect((await suspendRoom(OPERATOR, room.handle, "rude")).code).toBe("invalid_argument");
    expect((await suspendRoom(OPERATOR, `pub_${"0".repeat(32)}`)).code).toBe("workspace_not_found");
    const suspended = await suspendRoom(OPERATOR, room.handle);
    expect(suspended.status, suspended.text).toBe(200);
    expect(suspended.body).toMatchObject({ handle: room.handle, suspended: true, reason: "abuse" });
    // Asking again changes nothing.
    expect((await suspendRoom(OPERATOR, room.handle)).body.at).toBe(suspended.body.at);
    expect(await page(room.handle)).toBe(404);
    await drain(room.id);
    expect(await indexRow(room.id)).toEqual({ resolvable: 0, listed: 0 });
    expect((await claim(await agent(), room.handle, room.role)).code).toBe("workspace_not_found");
    // Nothing else changed: the claimant is still in, and the owner sees why.
    expect((await api(held, "GET", `/v1/workspaces/${room.id}`)).status).toBe(200);
    const seen = (await api(OWNER, "GET", `/v1/workspaces/${room.id}/visibility`)).body;
    expect(seen).toMatchObject({ visibility: "public", suspension: { reason: "abuse", at: suspended.body.at } });
    const audit = await inRoom(room.id, (sql) => sql.exec("SELECT actor_id, action FROM audit_event WHERE action LIKE 'room.suspen%' ORDER BY seq").toArray());
    expect(audit).toEqual([{ actor_id: OPERATOR.id, action: "room.suspended" }]);
    // The owner can make it private, but not public again.
    expect((await api(OWNER, "PUT", `/v1/workspaces/${room.id}/visibility`, { visibility: "private" })).status).toBe(200);
    const hash = (await api(OWNER, "GET", `/v1/workspaces/${room.id}/visibility`)).body.view_hash;
    expect((await api(OWNER, "PUT", `/v1/workspaces/${room.id}/visibility`, { visibility: "public", view_hash: hash })).code).toBe("room_suspended");
    // The operator lifts it by the handle they saw, though the room is private now.
    await drain(room.id);
    const lifted = await liftRoom(OPERATOR, room.handle);
    expect(lifted.status, lifted.text).toBe(200);
    expect(lifted.body).toMatchObject({ suspended: false, reason: null });
    expect((await api(OWNER, "GET", `/v1/workspaces/${room.id}/visibility`)).body.suspension).toBeNull();
    const republished = await api(OWNER, "PUT", `/v1/workspaces/${room.id}/visibility`, { visibility: "public", view_hash: hash });
    expect(republished.status, republished.text).toBe(200);
  });

  it("brings a room still public back when lifted", async () => {
    const room = await publicRoom();
    expect((await suspendRoom(OPERATOR, room.handle)).status).toBe(200);
    await drain(room.id);
    expect((await liftRoom(OPERATOR, room.handle)).status).toBe(200);
    await drain(room.id);
    expect(await page(room.handle)).toBe(200);
    expect(await indexRow(room.id)).toEqual({ resolvable: 1, listed: 1 });
  });
});

describe("suspending an agent's public claims (decision 158)", () => {
  it("refuses its public claims, keeps those it holds, and lifts", async () => {
    const [first, second] = [await publicRoom(), await publicRoom()];
    const taker = await agent();
    expect((await claim(taker, first.handle, first.role)).status).toBe(200);
    const suspend = (who: Who) => api(who, "POST", `/v1/moderation/agents/${taker.id}/suspend`, { reason: "spam" });
    expect((await suspend(OWNER)).code).toBe("not_allowed");
    expect((await suspend(orgAdmin(taker.org))).code).toBe("not_allowed");
    const done = await suspend(OPERATOR);
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ agent_id: taker.id, suspended: true, reason: "spam" });
    expect((await claim(taker, second.handle, second.role)).code).toBe("public_claims_suspended");
    expect((await api(taker, "GET", `/v1/workspaces/${first.id}`)).status).toBe(200);
    expect((await api(OPERATOR, "POST", `/v1/moderation/agents/${taker.id}/lift`, { reason: "other" })).body).toMatchObject({ suspended: false });
    expect((await claim(taker, second.handle, second.role)).status).toBe(200);
    // An agent never registered is refused, and no Principal is made for it.
    expect((await api(OPERATOR, "POST", "/v1/moderation/agents/agt_never_registered/suspend", { reason: "spam" })).code).toBe("agent_not_found");
    // Each action is logged by the moderation object, with IDs and codes only.
    const actions = await runInDurableObject(BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation")), (_: any, state: any) => state.storage.sql.exec("SELECT operator, subject_kind, subject, action, reason FROM operator_action WHERE subject = ? ORDER BY seq", taker.id).toArray());
    expect(actions).toEqual([
      { operator: OPERATOR.id, subject_kind: "agent", subject: taker.id, action: "suspend", reason: "spam" },
      { operator: OPERATOR.id, subject_kind: "agent", subject: taker.id, action: "lift", reason: "other" },
    ]);
  });
});
