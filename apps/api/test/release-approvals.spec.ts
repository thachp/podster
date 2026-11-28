import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm";

// M6 step 10(b): the room's releases awaiting a person's approval (`listReleaseApprovals`), for Needs attention. Only
// those who may approve one, the room's owner or an admin, as a person, see them (decision 215); everyone else in the
// room, and every agent, gets `not_allowed`. A read: it grants nothing, asks nobody's `Principal`, and writes nothing.
//
// Nothing takes a release's request yet, so each room is given its rows through the test pool, as in
// `release-config.spec.ts`. Each room's provider is switched off, so what is read is the room's own state.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; org: string; kind?: "person" | "agent"; adminOrgs?: string[] };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const claims = who.kind === "agent"
    ? { kind: "agent", org: who.org, gen: 1 }
    : { kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "x-test-public-rooms": "on" };
  if (method !== "GET") headers["idempotency-key"] = `ra-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined, text };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;

/** Release switched on for the test Worker while `run` runs. */
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

/** An agent, registered once: it never sees these, refused by its kind before the room is asked. */
const AGENT: Who = { id: "agt_ra_agent", org: "org_ra_agents", kind: "agent" };

const SHA = (n: number) => n.toString(16).padStart(2, "0").repeat(20);
const rel = (n: number) => `rel_${n.toString(16).padStart(32, "0")}`;
let rooms = 0;
const made: string[] = [];

type Room = { room: string; owner: Who; admin: Who; member: Who; label: string };
/** A public room with release on at version 3 and epoch 2, a label, a task, and no release yet. */
async function room(org: string): Promise<Room> {
  const owner: Who = { id: `per_ra_owner_${org}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Release approvals" });
  expect(created.status, org).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  await manualAlarms(stub(id));
  const n = ++rooms;
  const member: Who = { id: `per_ra_mem_${n}`, org };
  const admin: Who = { id: `per_ra_adm_${n}`, org };
  const label = `ra${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const handle = `pub_${crypto.randomUUID().replace(/-/g, "")}`;
  await inRoom(id, (sql) => {
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1, require_person_review = 1", handle);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    for (const [who, role] of [[member, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES ('tsk_ra_1', 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", owner.id, admin.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
  });
  return { room: id, owner, admin, member, label };
}

/** A release row as no command writes one yet: awaiting approval unless `extra` says otherwise. */
const release = (r: Room, n: number, extra: Record<string, unknown> = {}) => inRoom(r.room, (sql) => {
  const row = { id: rel(n), commit_sha: SHA(n), state: "awaiting_approval", label: r.label, config_version: 3, release_epoch: 2, task_id: "tsk_ra_1", requested_by: r.member.id, requested_at: 1000 + n, updated_at: 1000 + n, ...extra };
  sql.exec(`INSERT INTO release (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`, ...Object.values(row));
});

const path = (r: Room) => `/v1/workspaces/${r.room}/release-approvals`;
const list = (r: Room, who = r.owner) => api(who, "GET", path(r));
const listed = (r: Room, n: number, task: string | null = "tsk_ra_1") => ({ id: rel(n), task_id: task, commit_sha: SHA(n), state: "awaiting_approval", requested_by: r.member.id, requested_at: 1000 + n,
  // Not made from a preview (M8 step 9): nothing of the dialog's preview fields.
  from_preview: null, build_id: null, preview_served_at: null, storage_warning: null, preview_replaced: null, preview_notice: null, storage_notice: null });

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const registrar: Who = { id: "per_ra_registrar", org: AGENT.org, adminOrgs: [AGENT.org] };
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(registrar) }, body: JSON.stringify({ org_id: AGENT.org, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register ${AGENT.id}: ${res.status}`);
});

describe("a room's releases awaiting approval (M6 step 10(b))", () => {
  it("lists only releases awaiting approval under the room's current epoch, newest first, to the owner and its admins", async () => {
    const r = await room("org_ra_list");
    await release(r, 1);
    await release(r, 2, { task_id: null });
    // Not awaiting approval: each is past the decision, and none is listed.
    await release(r, 3, { state: "queued", approved_by: r.owner.id, approved_at: 5 });
    await release(r, 4, { state: "declined", declined_by: r.owner.id, declined_at: 5 });
    await release(r, 5, { state: "failed", failure_code: "release_epoch_moved" });
    // Awaiting approval, but asked for under an epoch the room has left: the room's bookkeeping ends it, so it isn't listed.
    await release(r, 6, { release_epoch: 1 });
    await switchedOn(async () => {
      for (const who of [r.owner, r.admin]) {
        const read = await list(r, who);
        expect(read.status, who.id).toBe(200);
        expect(read.body, who.id).toEqual({ releases: [listed(r, 2, null), listed(r, 1)], more: false });
      }
    });
  });

  it("is refused to everyone else in the room, to every agent, and to anyone outside it", async () => {
    const r = await room("org_ra_who");
    await release(r, 1);
    const outsider: Who = { id: "per_ra_outsider", org: "org_ra_other", adminOrgs: ["org_ra_other"] };
    await switchedOn(async () => {
      expect(await list(r)).toMatchObject({ status: 200, body: { releases: [listed(r, 1)] } });
      for (const [who, want] of [[r.member, [403, "not_allowed"]], [AGENT, [403, "not_allowed"]], [outsider, [404, "workspace_not_found"]]] as const) {
        const read = await list(r, who);
        expect([read.status, read.code], who.id).toEqual(want);
        // A refusal says nothing about what is awaiting: no ID or commit is in it.
        expect(read.text, who.id).not.toContain(rel(1));
        expect(read.text, who.id).not.toContain(SHA(1));
      }
    });
  });

  it("is empty while release is off in the room", async () => {
    const r = await room("org_ra_off");
    await release(r, 1);
    await inRoom(r.room, (sql) => sql.exec("UPDATE release_config SET enabled = 0"));
    await switchedOn(async () => {
      expect((await list(r)).body).toEqual({ releases: [], more: false });
    });
  });

  it("is empty in a room that never set release", async () => {
    const owner: Who = { id: "per_ra_owner_never", org: "org_ra_never", adminOrgs: ["org_ra_never"] };
    const id: string = (await api(owner, "POST", "/v1/workspaces", { name: "Never" })).body.id;
    made.push(id);
    await manualAlarms(stub(id));
    await switchedOn(async () => {
      const read = await api(owner, "GET", `/v1/workspaces/${id}/release-approvals`);
      expect([read.status, read.body]).toEqual([200, { releases: [], more: false }]);
    });
  });

  it("lists at most 50, the newest, and says there are more", async () => {
    const r = await room("org_ra_many");
    for (let n = 1; n <= 51; n += 1) await release(r, n);
    const read = await switchedOn(() => list(r));
    expect(read.body.releases).toHaveLength(50);
    expect(read.body.releases[0]).toEqual(listed(r, 51));
    expect(read.body.releases[49]).toEqual(listed(r, 2));
    expect(read.body.more).toBe(true);
  });

  it("writes nothing", async () => {
    const r = await room("org_ra_read");
    await release(r, 1);
    const counts = () => inRoom(r.room, (sql) => ["release", "event", "outbox", "audit_event", "idempotency"].map((table) => sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n));
    const before = await counts();
    await switchedOn(async () => {
      await list(r);
      await list(r, r.member);
    });
    expect(await counts()).toEqual(before);
    expect(await inRoom(r.room, (sql) => sql.exec("SELECT state, updated_at FROM release").toArray())).toEqual([{ state: "awaiting_approval", updated_at: 1001 }]);
  });

  it("isn't there while release is switched off for the deployment", async () => {
    const r = await room("org_ra_gone");
    await release(r, 1);
    const real = await list(r);
    const unknown = await api(r.owner, "GET", `${path(r)}x`);
    expect([real.status, real.code]).toEqual([404, "not_found"]);
    expect([real.status, real.text]).toEqual([unknown.status, unknown.text]);
  });
});
