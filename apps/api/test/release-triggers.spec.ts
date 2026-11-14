import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet } from "./alarm";

// M6 step 6, its first PR: ADR 0010's unpublish triggers that are the room's own state, each fired in the transaction of
// the command that changes it. Archiving the room, making it private and an operator's suspension of its public surface
// are here; a repository's link no longer ready is in `repo-readiness.spec.ts`, where its read-back is. Each unpublishes
// as Podster's act, through the one function decision 218's release switch uses, and none is undone by undoing its
// cause. After the command commits, the room runs its release bookkeeping, since the epoch moved: the release it had
// queued is ended at once, not at some later alarm.
//
// Nothing takes a release's request yet, so each room is given its rows through the test pool: an app serving an
// earlier release on its default host, and a release of its own, queued. Each room's provider is switched off, so
// what is read is the room's own state.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; org: string; adminOrgs?: string[] };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who) };
  if (method !== "GET") headers["idempotency-key"] = `rt-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());

const REL = `rel_${"7a".repeat(16)}`;
const PREV = `rel_${"6b".repeat(16)}`;
const SHA = "ef".repeat(20);
const TASK = "tsk_rt_1";
let rooms = 0;
/** Every room a test made, so each is left with no alarm run under way and none to come, pass or fail. */
const made: string[] = [];

type Room = { room: string; owner: Who; label: string; host: string; prev: string };
/**
 * A public room whose app serves an earlier release on its default host, with a release of its own queued. With
 * `configured: false`, a public room with no release configuration at all.
 */
async function room(org: string, opts: { configured?: boolean } = {}): Promise<Room> {
  const owner: Who = { id: `per_rt_owner_${org}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Triggers" });
  expect(created.status, org).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  await alarmQuiet(stub(id));
  const n = ++rooms;
  const label = `rt${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  const prev = `${label}.${PREV}`;
  const handle = `pub_${crypto.randomUUID().replace(/-/g, "")}`;
  await inRoom(id, (sql) => {
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", handle);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    if (opts.configured === false) return;
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, owner.id, owner.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    const release = (rel: string, state: string, script: string | null) => sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, ?, ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, ?, 1)`,
      rel, SHA, state, label, TASK, script, script ? rel : null, owner.id, owner.id, script ? 1 : null);
    release(PREV, "served", prev);
    release(REL, "queued", null);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, prev);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, prev);
  });
  return { room: id, owner, label, host, prev };
}

const version = async (r: Room) => (await api(r.owner, "GET", `/v1/workspaces/${r.room}`)).body.policy_version as number;
const serving = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT script_name, release_id FROM serve_state").one());
const UP = (r: Room) => ({ script_name: r.prev, release_id: PREV });
const unpublishes = (r: Room) => all(r.room, "SELECT cause, label, release_epoch FROM unpublish ORDER BY seq");
const trail = (r: Room) => inRoom(r.room, (sql) => ({
  events: sql.exec("SELECT type, actor_id, reason FROM event WHERE type = 'app.unpublished' ORDER BY seq").toArray(),
  audit: sql.exec("SELECT actor_id, action, target_id, prior_json, new_json FROM audit_event WHERE action = 'app.unpublished' ORDER BY seq").toArray()
    .map((a: any) => [a.actor_id, a.action, a.target_id, a.prior_json, JSON.parse(a.new_json)]),
}));
/** Release switched on for the test Worker while `run` runs. A call inside another leaves it on. */
let releasesOn = 0;
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  if (releasesOn++ === 0) await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { if (--releasesOn === 0) await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}
/** The reconcile's question, the walk's wake, as `RELEASES` is: off unless the caller switched it on. */
const ask = (r: Room) => stub(r.room).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify({ kind: "wake" }) }).then((x: Response) => x.json() as Promise<any>);
const suspendSurface = (r: Room, suspended: boolean) => stub(r.room).fetch("https://do/internal/operator-suspension", { method: "POST", body: JSON.stringify({ suspended, reason: "abuse" }) })
  .then(async (x: Response) => ({ status: x.status, body: (await x.json()) as any }));

/**
 * The room as a trigger with code `reason` leaves it, at the end of the very request that fired it: nothing served,
 * the served release unpublished, the queued one ended under the new epoch by the bookkeeping that request ran, the
 * served script queued, and the unpublish recorded once as Podster's act.
 */
async function expectDown(r: Room, reason: string, what: string) {
  expect(await serving(r), what).toEqual({ script_name: null, release_id: null });
  expect(await all(r.room, "SELECT id, state, failure_code FROM release ORDER BY id"), what).toEqual([
    { id: PREV, state: "unpublished", failure_code: null },
    { id: REL, state: "failed", failure_code: "release_epoch_moved" },
  ].sort((a, b) => a.id.localeCompare(b.id)));
  expect(await unpublishes(r), what).toEqual([{ cause: reason, label: null, release_epoch: 3 }]);
  expect((await all(r.room, "SELECT script_name, unpublish_epoch FROM script_delete")).map((q: any) => [q.script_name, q.unpublish_epoch]), what).toEqual([[r.prev, 3]]);
  expect(await trail(r), what).toEqual({
    events: [{ type: "app.unpublished", actor_id: "podster", reason }],
    audit: [["podster", "app.unpublished", "app", null, { reason }]],
  });
}

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("ADR 0010's unpublish triggers that are the room's own state (M6 step 6)", () => {
  it("unpublishes the room's app when the room is archived, and bringing it back restores nothing", async () => {
    const r = await room("org_rt_archive");
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.room}/archive`, { policy_version: await version(r) })).status).toBe(200);
    await expectDown(r, "workspace_archived", "archived");
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.room}/unarchive`, { policy_version: await version(r) })).status).toBe(200);
    expect(await serving(r)).toEqual({ script_name: null, release_id: null });
    await expectDown(r, "workspace_archived", "brought back");
  });

  it("unpublishes the room's app when the room is made private, and going public again restores nothing", async () => {
    const r = await room("org_rt_private");
    expect((await api(r.owner, "PUT", `/v1/workspaces/${r.room}/visibility`, { visibility: "private" })).status).toBe(200);
    await expectDown(r, "release_needs_public_room", "made private");
    // Private again changes nothing, and unpublishes nothing more.
    expect((await api(r.owner, "PUT", `/v1/workspaces/${r.room}/visibility`, { visibility: "private" })).status).toBe(200);
    await expectDown(r, "release_needs_public_room", "private again");
  });

  it("unpublishes the room's app when an operator suspends its public surface, and lifting it restores nothing", async () => {
    const r = await room("org_rt_suspended");
    expect((await suspendSurface(r, true)).status).toBe(200);
    await expectDown(r, "public_surface_suspended", "suspended");
    // Suspended again is what's already so: nothing more.
    expect((await suspendSurface(r, true)).status).toBe(200);
    expect((await suspendSurface(r, false)).status).toBe(200);
    await expectDown(r, "public_surface_suspended", "lifted");
  });

  it("records nothing for a room with no release configuration: there is no app to unpublish", async () => {
    const r = await room("org_rt_bare", { configured: false });
    expect((await suspendSurface(r, true)).status).toBe(200);
    expect((await api(r.owner, "PUT", `/v1/workspaces/${r.room}/visibility`, { visibility: "private" })).status).toBe(200);
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.room}/archive`, { policy_version: await version(r) })).status).toBe(200);
    expect(await all(r.room, "SELECT * FROM release_config")).toEqual([]);
    expect(await unpublishes(r)).toEqual([]);
    expect(await trail(r)).toEqual({ events: [], audit: [] });
  });

  it("records each trigger that fires in turn: the second raises the epoch again, with nothing left to take down", async () => {
    const r = await room("org_rt_two");
    expect((await suspendSurface(r, true)).status).toBe(200);
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.room}/archive`, { policy_version: await version(r) })).status).toBe(200);
    expect(await serving(r)).toEqual({ script_name: null, release_id: null });
    // Each trigger is on record with the epoch it raised to; the second had nothing up.
    expect(await unpublishes(r)).toEqual([
      { cause: "public_surface_suspended", label: null, release_epoch: 3 },
      { cause: "workspace_archived", label: null, release_epoch: 4 },
    ]);
    expect((await trail(r)).events.map((e: any) => e.reason)).toEqual(["public_surface_suspended", "workspace_archived"]);
  });
});

describe("the deployment's own switch, `RELEASES`, read by the room (M6 step 6)", () => {
  it("takes the room's app down at the walk's question once release is off for the deployment, and only once", async () => {
    const r = await room("org_rt_deployment");
    // On, as a deployment that serves apps has it: the question changes nothing.
    expect((await switchedOn(() => ask(r))).known).toBe(true);
    expect(await serving(r)).toEqual(UP(r));
    expect(await unpublishes(r)).toEqual([]);
    // Off: the room reads it at the question and unpublishes, ending its queued release in the same request.
    expect((await ask(r)).known).toBe(true);
    await expectDown(r, "release_off_for_deployment", "switched off");
    // Asked again while off: nothing is up, so nothing more is recorded.
    await ask(r);
    await expectDown(r, "release_off_for_deployment", "asked again");
    // Switched back on: nothing comes back.
    await switchedOn(() => ask(r));
    await expectDown(r, "release_off_for_deployment", "switched back on");
  });

  it("records nothing for a room with no release configuration while release is off", async () => {
    const r = await room("org_rt_deployment_bare", { configured: false });
    await ask(r);
    expect(await unpublishes(r)).toEqual([]);
    expect(await trail(r)).toEqual({ events: [], audit: [] });
  });
});
