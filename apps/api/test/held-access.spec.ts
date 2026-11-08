import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// A room whose migration fails answers every request with an error. Removing someone's access still has to reach it: a
// disconnect's fence and an organization departure are held, acknowledged, and applied before anything else once the room
// migrates again. Everything else keeps failing closed.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const OWNER: Who = { id: "per_owner", kind: "person", org: "org_a", adminOrgs: ["org_a"] };
const AGENT: Who = { id: "agt_held", org: "org_a" };
const LEAVER: Who = { id: "per_leaver", kind: "person", org: "org_a" };
const orgAdmin = (org: string): Who => ({ id: `per_admin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: 1 } : { orgs: [], admin_orgs: who.adminOrgs ?? [] }), ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, claims: object = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, claims), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(AGENT.org)) }, body: JSON.stringify({ org_id: AGENT.org, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register ${AGENT.id}: ${res.status}`);
});

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any, state: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql, state));
const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
const member = (id: string, who: Who) => inRoom(id, (sql) => sql.exec("SELECT revoked_at, revocation_reason FROM member WHERE principal_id = ?", who.id).toArray()[0]);
const held = (id: string) => inRoom(id, (sql) => sql.exec("SELECT kind FROM held_access ORDER BY seq").toArray().map((r: any) => r.kind));
const failures = (id: string) => inRoom(id, (sql) => sql.exec("SELECT failures FROM migration_failure").toArray()[0]?.failures ?? 0);

/** A room with an agent and another person of its organization, both in it. */
async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Held" })).body.id;
  expect((await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: AGENT.id, kind: "agent", org_id: AGENT.org, role: "member", policy_version: await version(id) })).status).toBe(200);
  const added = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: LEAVER.id, kind: "person", org_id: LEAVER.org, role: "member", policy_version: await version(id) }, { target_member: { person: LEAVER.id, orgs: { [LEAVER.org]: 1 } } });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  return id;
}

/** Makes the room's migration fail, as a broken release would: one migration is due, and the failpoint refuses it. */
const breakMigration = (id: string) =>
  inRoom(id, (sql) => {
    sql.exec("CREATE TABLE fail_migration (x INTEGER)");
    sql.exec("UPDATE schema_version SET version = version - 1");
  });
/**
 * A fixed release whose migration succeeds. Undoing a real migration would tie this test to whichever is newest, so the test
 * marks it done itself. What was held still has to be applied before the room answers anything.
 */
const fixMigration = (id: string) =>
  inRoom(id, (sql) => {
    sql.exec("DROP TABLE fail_migration");
    sql.exec("UPDATE schema_version SET version = version + 1");
  });

const revoke = (id: string, floor: number) => stub(id).fetch("https://workspace/internal/revoke", { method: "POST", body: JSON.stringify({ principal: AGENT.id, floor }) });
const depart = (id: string) => stub(id).fetch("https://workspace/internal/org-departure", { method: "POST", body: JSON.stringify({ person: LEAVER.id, org: LEAVER.org, actor: orgAdmin(LEAVER.org).id, left_at: Date.now() }) });

describe("a room whose migration fails", () => {
  it("still takes a disconnect and a departure, applies them first once it migrates, and fails closed until then", async () => {
    const id = await room();
    expect((await member(id, AGENT)).revoked_at).toBeNull();
    expect((await member(id, LEAVER)).revoked_at).toBeNull();
    await breakMigration(id);

    // Everything else fails closed.
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(500);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "x", instructions: "y" })).status).toBe(500);

    // Access removal is acknowledged, so the disconnect and the departure finish everywhere else.
    const fenced = await revoke(id, 99);
    expect(fenced.status).toBe(200);
    expect(await fenced.json()).toEqual({ acked: true });
    const departed = await depart(id);
    expect(departed.status).toBe(200);
    expect(await departed.json()).toEqual({ applied: true });
    expect(await held(id)).toEqual(["fence", "org_departure"]);
    expect(await failures(id)).toBeGreaterThanOrEqual(3);
    // Held, not applied: the schema can't be trusted yet, and nobody can act in the room meanwhile.
    expect((await member(id, AGENT)).revoked_at).toBeNull();
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(500);

    // The fixed release: the first request migrates, applies what was held, and only then answers.
    await fixMigration(id);
    const read = await api(OWNER, "GET", `/v1/workspaces/${id}`);
    expect(read.status).toBe(200);
    expect(await held(id)).toEqual([]);
    expect(await member(id, AGENT)).toMatchObject({ revoked_at: expect.any(Number), revocation_reason: "global_disconnect" });
    expect(await member(id, LEAVER)).toMatchObject({ revoked_at: expect.any(Number), revocation_reason: "org_departure" });
  });

  it("keeps failing closed if what's held can't be applied, and holds what comes next behind it", async () => {
    const id = await room();
    await breakMigration(id);
    expect((await revoke(id, 98)).status).toBe(200);
    // That held fence can't be replayed: a kind the room doesn't know, as a corrupted entry would be.
    await inRoom(id, (sql) => sql.exec("UPDATE held_access SET kind = 'unknown'"));
    await fixMigration(id);
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(500);
    expect((await revoke(id, 99)).status).toBe(200);
    expect(await held(id)).toEqual(["unknown", "fence"]);
    expect((await member(id, AGENT)).revoked_at).toBeNull();
    // Once the bad entry is cleared, the fence applies before the room answers.
    await inRoom(id, (sql) => sql.exec("DELETE FROM held_access WHERE kind = 'unknown'"));
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    expect(await member(id, AGENT)).toMatchObject({ revocation_reason: "global_disconnect" });
  });

  it("refuses past its cap rather than drop a revocation, and the sender's retry applies once the room migrates", async () => {
    const id = await room();
    await breakMigration(id);
    expect((await revoke(id, 1)).status).toBe(200);
    // Fill the rest of the cap with fences for agents who aren't in the room.
    await inRoom(id, (sql) => {
      for (let i = 1; i < 1_000; i++) sql.exec("INSERT INTO held_access (kind, body_json, held_at) VALUES ('fence', ?, 0)", JSON.stringify({ principal: `agt_fill_${i}`, floor: 1 }));
    });
    // A later fence for an agent already held only raises its floor, so the cap doesn't refuse it.
    expect((await revoke(id, 99)).status).toBe(200);
    // At the cap a new revocation and a departure are refused, not acknowledged, so their senders keep retrying.
    const other = () => stub(id).fetch("https://workspace/internal/revoke", { method: "POST", body: JSON.stringify({ principal: "agt_not_held", floor: 5 }) });
    expect((await other()).status).toBe(500);
    expect((await depart(id)).status).toBe(500);
    expect((await held(id)).length).toBe(1_000);
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(500);
    // Fixed: everything held replays, nothing was dropped, and the retried revocation and departure now apply.
    await fixMigration(id);
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    expect(await held(id)).toEqual([]);
    expect((await other()).status).toBe(200);
    expect((await depart(id)).status).toBe(200);
    expect(await member(id, AGENT)).toMatchObject({ revocation_reason: "global_disconnect" });
    expect(await member(id, LEAVER)).toMatchObject({ revocation_reason: "org_departure" });
  }, 60_000);

  it("sends nothing from the outbox while a removal is held, so the removal can still take back what was queued", async () => {
    const id = await room();
    await inRoom(id, (sql) => sql.exec("CREATE TABLE test_hold_outbox (x)"));
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "For the agent", instructions: "x", assignee: AGENT.id })).status).toBe(200);
    const queued = () => inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM outbox WHERE recipient_principal_id = ?", AGENT.id).one().n as number);
    expect(await queued()).toBeGreaterThan(0);
    await breakMigration(id);
    expect((await revoke(id, 99)).status).toBe(200);
    // The outbox is free to send again, but the alarm sends nothing while the fence is held, and comes back later.
    await inRoom(id, (sql) => sql.exec("DROP TABLE test_hold_outbox"));
    await runInDurableObject(stub(id), (instance: any) => instance.alarm());
    expect(await queued()).toBeGreaterThan(0);
    expect(await inRoom(id, (_sql, state) => state.storage.getAlarm())).not.toBeNull();
    const before = await inRoom(id, (sql) => sql.exec("SELECT e.type FROM outbox o JOIN event e ON e.id = o.event_id WHERE o.recipient_principal_id = ?", AGENT.id).toArray().map((r: any) => r.type));
    expect(before).not.toContain("member.revoked");
    // Once the room migrates, the fence applies and takes back what was waiting for the agent.
    await fixMigration(id);
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    const left = await inRoom(id, (sql) => sql.exec("SELECT e.type FROM outbox o JOIN event e ON e.id = o.event_id WHERE o.recipient_principal_id = ?", AGENT.id).toArray().map((r: any) => r.type));
    // Only the notice of its own removal is left for it, as a live revocation leaves.
    expect(left).toEqual(["member.revoked"]);
  });

  it.each([
    ["the fenced agent", AGENT, "agent_disconnected"],
    ["the departed person", LEAVER, "access_revoked"],
  ])("refuses %s's own first request after the fix, because the held removal applies before it", async (_name, who, code) => {
    const id = await room();
    await breakMigration(id);
    expect((await revoke(id, 99)).status).toBe(200);
    expect((await depart(id)).status).toBe(200);
    await fixMigration(id);
    const first = await api(who, "GET", `/v1/workspaces/${id}`);
    expect([first.status, first.code]).toEqual([403, code]);
    expect(await held(id)).toEqual([]);
  });

  it("keeps one held fence per agent and one held departure per person and organization, the latest of each", async () => {
    const id = await room();
    await breakMigration(id);
    for (const floor of [5, 9, 7]) expect((await revoke(id, floor)).status).toBe(200);
    const leave = (left_at: number) => stub(id).fetch("https://workspace/internal/org-departure", { method: "POST", body: JSON.stringify({ person: LEAVER.id, org: LEAVER.org, actor: orgAdmin(LEAVER.org).id, left_at }) });
    for (const left_at of [200, 300, 100]) expect((await leave(left_at)).status).toBe(200);
    const entries = await inRoom(id, (sql) => sql.exec("SELECT kind, body_json FROM held_access ORDER BY seq").toArray().map((r: any) => ({ kind: r.kind, ...JSON.parse(r.body_json) })));
    expect(entries).toEqual([
      { kind: "fence", principal: AGENT.id, floor: 9 },
      { kind: "org_departure", person: LEAVER.id, org: LEAVER.org, actor: orgAdmin(LEAVER.org).id, left_at: 300 },
    ]);
  });

  it("applies a disconnect and a departure at once in a room that migrates fine, holding nothing", async () => {
    const id = await room();
    expect((await revoke(id, 99)).status).toBe(200);
    expect((await depart(id)).status).toBe(200);
    expect(await member(id, AGENT)).toMatchObject({ revocation_reason: "global_disconnect" });
    expect(await member(id, LEAVER)).toMatchObject({ revocation_reason: "org_departure" });
    const tables = await inRoom(id, (sql) => sql.exec("SELECT name FROM sqlite_master WHERE name IN ('held_access', 'migration_failure')").toArray());
    expect(tables).toEqual([]);
  });

  it("refuses a malformed departure before holding it, so everything held can replay", async () => {
    const id = await room();
    await breakMigration(id);
    const bad = await stub(id).fetch("https://workspace/internal/org-departure", { method: "POST", body: JSON.stringify({ person: LEAVER.id }) });
    expect(bad.status).toBe(400);
    const tables = await inRoom(id, (sql) => sql.exec("SELECT name FROM sqlite_master WHERE name = 'held_access'").toArray());
    if (tables.length) expect(await held(id)).toEqual([]);
  });
});
