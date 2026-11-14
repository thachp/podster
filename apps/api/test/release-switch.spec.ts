import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { alarmQuiet, nextAlarm } from "./alarm";

// Decision 218's release switch, PR C: what a room does when an operator takes release from its organization or gives
// it back. The organization's own object sends each room it lists a notice, again until the room acknowledges it; a
// room reads the switch itself at its release commands and whenever the reconcile asks it anything; a room that hears
// of a take since what it last applied unpublishes its app, as Podster's act; giving release back restores nothing.
//
// **Which rooms an organization lists.** Its object's `org_room` list is filled as each room is made, for an
// organization the room limit applies to, which in test builds is one whose ID starts `org_limit_`; a test that needs
// its rooms listed uses such an organization. The list is also filled once from D1's listing, which other tests change,
// so no test here relies on that except the one that shows it, which writes its own row.
//
// Nothing takes a release's request yet (step 6), so each room is given its rows through the test pool: an app that
// serves an earlier release on its default host, and a release of its own in the state a test asks for. Each room's
// provider is switched off, so what is read is the room's own state. The waits between a notice's tries are moved by
// the test, in the object's own rows, never waited out.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; org: string; adminOrgs?: string[] };
const OPERATOR: Who = { id: "per_operator_one", org: "org_rs_ops" };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who) };
  if (method !== "GET") headers["idempotency-key"] = `rs-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());
const principal = (org: string) => BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(org));
const inOrg = <T>(org: string, fn: (sql: any) => T) => runInDurableObject(principal(org), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const hasTable = (sql: any, name: string) => sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length === 1;

/** Release switched on for the test Worker, as no deployment is, while `run` runs. A call inside another leaves it on. */
let on = 0;
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  if (on++ === 0) await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { if (--on === 0) await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

const REL = `rel_${"5e".repeat(16)}`;
const PREV = `rel_${"4f".repeat(16)}`;
const SHA = "cd".repeat(20);
const REPO_ID = 987650077;
const TASK = "tsk_rs_1";
let rooms = 0;
/** Every room a test made, so each is left with no alarm run under way and none to come, pass or fail. */
const made: string[] = [];
/** Every organization a test took release from, given back after each test, pass or fail. */
const taken = new Set<string>();

type Room = { room: string; org: string; owner: Who; label: string; host: string; script: string; prev: string };
/**
 * A room whose app serves an earlier release on its default host, and which has a release of its own in `state`,
 * queued by default, with everything its recheck asks for holding. The room's provider is switched off.
 */
async function room(org: string, opts: { state?: string } = {}): Promise<Room> {
  const owner: Who = { id: `per_rs_owner_${org}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Switch" });
  expect(created.status, org).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  // The room's index is written by its alarm: so the organization's listing names it, as a real room's would.
  await alarmQuiet(stub(id));
  const n = ++rooms;
  const requester: Who = { id: `per_rs_req_${n}`, org };
  const admin: Who = { id: `per_rs_adm_${n}`, org };
  const label = `rs${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  const [script, prev] = [`${label}.${REL}`, `${label}.${PREV}`];
  const state = opts.state ?? "queued";
  await inRoom(id, (sql) => {
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, owner.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `rs-${n}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/release', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO_ID, owner.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_rs', ?, 'github', ?, 'deploy', ?, 1)", requester.id, REPO_ID, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, owner.id, admin.id);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO_ID, SHA, admin.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    const release = (rel: string, relState: string, withScript: boolean) => sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, ?, ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, ?, 1)`,
      rel, SHA, relState, label, TASK, withScript ? `${label}.${rel}` : null, withScript ? rel : null, requester.id, owner.id, withScript ? Date.now() : null);
    release(PREV, "served", true);
    release(REL, state, state !== "queued");
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, prev);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, prev);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, id).run();
  return { room: id, org, owner, label, host, script, prev };
}

/** The organization's list of rooms, taken from the listing once, as already taken with none of the rooms made after this: so they are rooms the list misses. */
const unlisted = (org: string) => inOrg(org, (sql) => {
  sql.exec("CREATE TABLE IF NOT EXISTS org_room (workspace_id TEXT PRIMARY KEY)");
  sql.exec("CREATE TABLE IF NOT EXISTS org_room_seeded (id INTEGER PRIMARY KEY CHECK (id = 1))");
  sql.exec("INSERT OR IGNORE INTO org_room_seeded (id) VALUES (1)");
});
const setSwitch = async (org: string, granted: boolean) => {
  if (!granted) taken.add(org);
  const set = await switchedOn(() => api(OPERATOR, "PUT", `/v1/orgs/${org}/release-delegation`, { granted }));
  expect(set.status, `${org} ${granted}`).toBe(200);
  return set.body;
};
const FAR = () => Date.now() + 24 * 60 * 60 * 1000;
/**
 * One pass of the organization's alarm with every notice due, and in the same turn every wait it left put far ahead
 * and the alarm cleared: no later run sends anything by itself, however long the test takes.
 */
const notify = (org: string) => runInDurableObject(principal(org), async (instance: any, state: any) => {
  const sql = state.storage.sql;
  await state.storage.deleteAlarm();
  if (hasTable(sql, "org_release_notice")) sql.exec("UPDATE org_release_notice SET next_attempt_at = 0");
  try { await instance.alarm(); } finally {
    if (hasTable(sql, "org_release_notice")) sql.exec("UPDATE org_release_notice SET next_attempt_at = ?", FAR());
    await state.storage.deleteAlarm();
  }
});
const notices = (org: string) => inOrg(org, (sql) => hasTable(sql, "org_release_notice") ? sql.exec("SELECT workspace_id, generation, tries FROM org_release_notice ORDER BY workspace_id").toArray() : []);
const appliedSwitch = (room: string) => inRoom(room, (sql) => sql.exec("SELECT granted, generation, last_take FROM release_switch_applied").one());
const serving = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT script_name, release_id FROM serve_state").one());
const releases = (r: Room) => all(r.room, "SELECT id, state, failure_code FROM release ORDER BY id");
const unpublishes = (r: Room) => all(r.room, "SELECT cause, label, release_epoch FROM unpublish ORDER BY seq");
const trail = (r: Room) => inRoom(r.room, (sql) => ({
  events: sql.exec("SELECT type, actor_id, reason FROM event WHERE type = 'app.unpublished' ORDER BY seq").toArray(),
  audit: sql.exec("SELECT actor_id, action, target_id, prior_json, new_json FROM audit_event WHERE action = 'app.unpublished' ORDER BY seq").toArray(),
}));
const check = (r: Room, body: object = { kind: "wake" }) => stub(r.room).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify(body) }).then((x: Response) => x.json() as Promise<any>);
const command = (path: string) => (r: Room) =>
  switchedOn(() => stub(r.room).fetch(`https://do/internal/${path}`, { method: "POST", body: JSON.stringify({ release_id: REL }) }).then(async (x: Response) => ({ status: x.status, body: (await x.json()) as any })));
const recheck = command("release-recheck");
const commit = command("release-commit-live");
const notice = (r: Room, body: unknown) => stub(r.room).fetch("https://do/internal/release-switch-notice", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }).then(async (x: Response) => ({ status: x.status, body: (await x.json()) as any }));
/** The room as an unpublish by the switch leaves it, from what `r` served before: nothing served, the served release unpublished, the queued one ended under the new epoch, both scripts queued. */
async function expectDown(r: Room, generation: number, what: string) {
  expect(await serving(r), what).toEqual({ script_name: null, release_id: null });
  expect(await releases(r), what).toEqual([
    { id: PREV, state: "unpublished", failure_code: null },
    { id: REL, state: "failed", failure_code: "release_epoch_moved" },
  ].sort((a, b) => a.id.localeCompare(b.id)));
  expect(await unpublishes(r), what).toEqual([{ cause: "release_not_delegated", label: null, release_epoch: 3 }]);
  expect((await all(r.room, "SELECT script_name, unpublish_epoch FROM script_delete")).map((q: any) => [q.script_name, q.unpublish_epoch]), what).toEqual([[r.prev, 3]]);
  const { events, audit } = await trail(r);
  expect(events, what).toEqual([{ type: "app.unpublished", actor_id: "podster", reason: "release_not_delegated" }]);
  expect(audit.map((a: any) => [a.actor_id, a.action, a.target_id, a.prior_json, JSON.parse(a.new_json)]), what)
    .toEqual([["podster", "app.unpublished", "app", null, { reason: "release_not_delegated", cause: "release_switch", generation }]]);
}
const UP = (r: Room) => ({ script_name: r.prev, release_id: PREV });

afterEach(async () => {
  for (const org of [...taken]) {
    taken.delete(org);
    await switchedOn(() => api(OPERATOR, "PUT", `/v1/orgs/${org}/release-delegation`, { granted: true }));
    await notify(org);
  }
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("a take of an organization's release switch, carried to its rooms (decision 218, PR C)", () => {
  it("unpublishes every room the organization lists by its notice, as Podster's act, and a give-back restores nothing", async () => {
    const org = "org_limit_rs_notice";
    const [a, b] = [await room(org), await room(org)];
    const other = await room("org_rs_notice_other");
    // Both rooms started from the switch as they read it while being made: unset.
    for (const r of [a, b]) expect(await appliedSwitch(r.room)).toEqual({ granted: 1, generation: 0, last_take: 0 });
    // One notice for each room the organization lists, written with the set's own transaction, and owed until the
    // room acknowledges it. The organization's own alarm may send them before this pass does: either way they end.
    expect(await setSwitch(org, false)).toMatchObject({ granted: false, generation: 1, last_take: 1 });
    await notify(org);
    expect(await notices(org)).toEqual([]);
    for (const r of [a, b]) {
      await expectDown(r, 1, r.room);
      expect(await appliedSwitch(r.room)).toEqual({ granted: 0, generation: 1, last_take: 1 });
    }
    // Another organization's room is untouched.
    expect(await serving(other)).toEqual(UP(other));
    expect(await unpublishes(other)).toEqual([]);
    // Given back: each room records it, and nothing comes back.
    expect(await setSwitch(org, true)).toMatchObject({ granted: true, generation: 2, last_take: 1 });
    await notify(org);
    for (const r of [a, b]) {
      expect(await appliedSwitch(r.room)).toEqual({ granted: 1, generation: 2, last_take: 1 });
      await expectDown(r, 1, `${r.room} given back`);
    }
  });

  it("unpublishes once: the same answer again, from a notice, the reconcile or a release command, changes nothing", async () => {
    const org = "org_limit_rs_once";
    const r = await room(org);
    await setSwitch(org, false);
    await notify(org);
    await expectDown(r, 1, "first");
    const before = JSON.stringify(await all(r.room, "SELECT * FROM unpublish")) + JSON.stringify(await all(r.room, "SELECT * FROM event")) + JSON.stringify(await all(r.room, "SELECT * FROM release_config"));
    // The notice again, as a lost acknowledgement would bring it, then the reconcile's question twice and a release
    // command: each is answered, and none unpublishes again.
    const again = await notice(r, { org, granted: false, generation: 1, last_take: 1 });
    expect(again).toEqual({ status: 200, body: { known: true, applied: "stale", generation: 1 } });
    await check(r);
    await check(r);
    expect((await recheck(r)).body).toMatchObject({ state: "failed", reason: "release_epoch_moved", rechecked: false });
    expect(JSON.stringify(await all(r.room, "SELECT * FROM unpublish")) + JSON.stringify(await all(r.room, "SELECT * FROM event")) + JSON.stringify(await all(r.room, "SELECT * FROM release_config"))).toBe(before);
  });

  it("brings a room the organization doesn't list down at its own read: the reconcile's question, or a release command", async () => {
    // The organization's list of rooms is taken from the listing once. These two rooms are made after it was, and kept
    // out of it, as rooms the list misses would be.
    const org = "org_rs_unlisted";
    await unlisted(org);
    const [walked, commanded] = [await room(org), await room(org)];
    await setSwitch(org, false);
    // No notice is owed to either: they aren't listed. They still serve.
    await notify(org);
    expect(await notices(org)).toEqual([]);
    for (const r of [walked, commanded]) expect(await serving(r)).toEqual(UP(r));
    // The reconcile's walk wakes one: it reads the switch itself, and comes down exactly as a notice would have made it.
    expect((await check(walked)).known).toBe(true);
    await expectDown(walked, 1, "walked");
    // A release command in the other: the same, and the release it was asked about ends with the rest.
    expect((await recheck(commanded)).body).toEqual({ release_id: REL, state: "failed", rechecked: false, reason: "release_epoch_moved" });
    await expectDown(commanded, 1, "commanded");
  });

  it("starts a room that existed before the room schema step at unset, so it comes down for a take made before it", async () => {
    const org = "org_rs_older";
    await unlisted(org);
    const [unset, older] = [await room(org), await room(org)];
    // As each was before room schema step 40: no applied switch at all.
    for (const r of [unset, older]) await inRoom(r.room, (sql) => { sql.exec("DROP TABLE release_hold"); sql.exec("DROP TABLE release_switch_applied"); sql.exec("UPDATE schema_version SET version = 39"); });
    // Migrated while nothing was ever taken: unset, as the step's defaults make it, and nothing changes.
    await check(unset);
    expect(await inRoom(unset.room, (sql) => sql.exec("SELECT singleton, granted, generation, last_take, applied_at FROM release_switch_applied").toArray()))
      .toEqual([{ singleton: 1, granted: 1, generation: 0, last_take: 0, applied_at: null }]);
    expect(await serving(unset)).toEqual(UP(unset));
    // A take before the other is migrated: no notice reaches it, as the organization doesn't list it, and its first
    // read after the step, unset against the take, brings it down.
    await setSwitch(org, false);
    await notify(org);
    expect(await serving(older)).toEqual(UP(older));
    await check(older);
    await expectDown(older, 1, "older");
    expect(await appliedSwitch(older.room)).toEqual({ granted: 0, generation: 1, last_take: 1 });
  });

  it("starts a room made after a take from that take: nothing to unpublish, refused at its recheck, and a give-back only records", async () => {
    const org = "org_rs_after";
    await room(org);
    await setSwitch(org, false);
    const after = await room(org);
    expect(await appliedSwitch(after.room)).toEqual({ granted: 0, generation: 1, last_take: 1 });
    await notify(org);
    expect(await unpublishes(after)).toEqual([]);
    expect((await recheck(after)).body).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_not_delegated" });
    expect(await unpublishes(after)).toEqual([]);
    await setSwitch(org, true);
    await notify(org);
    // The organization's list was taken before this room was made, so it hears the give-back at its own read.
    await check(after);
    expect(await appliedSwitch(after.room)).toEqual({ granted: 1, generation: 2, last_take: 1 });
    expect(await unpublishes(after)).toEqual([]);
    expect(await serving(after)).toEqual(UP(after));
  });

  it("rechecks against the switch the room applied, which an older answer can't undo", async () => {
    const org = "org_rs_older_answer";
    await room(org);
    await setSwitch(org, false);
    const after = await room(org);
    // Test builds only: the organization's object is taken to answer an older switch, unset, as a reply overtaken by
    // the take would be. The room applied the take; the older answer is stale, and the recheck still refuses.
    await inRoom(after.room, (sql) => { sql.exec("CREATE TABLE test_release_switch_answer (answer TEXT)"); sql.exec("INSERT INTO test_release_switch_answer (answer) VALUES (?)", '{"granted":true,"generation":0,"last_take":0}'); });
    expect((await recheck(after)).body).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_not_delegated" });
    expect(await appliedSwitch(after.room)).toEqual({ granted: 0, generation: 1, last_take: 1 });
  });

  it("lists, at a set, the rooms the organization's object never listed, from the listing, once", async () => {
    // A room from before the object kept its list, as the listing names it: the set takes it from there.
    const org = "org_rs_seeded";
    const old = `ws_rs_seeded_${crypto.randomUUID().replace(/-/g, "")}`;
    await BINDINGS.DB.prepare("INSERT INTO membership_index (workspace_id, principal_id, org_id, role, workspace_name, removed, updated_seq) VALUES (?, 'per_rs_seeded', ?, 'owner', 'Old', 0, 1)").bind(old, org).run();
    await setSwitch(org, false);
    expect(await inOrg(org, (sql) => sql.exec("SELECT workspace_id FROM org_room").toArray())).toEqual([{ workspace_id: old }]);
    // A room nobody made answers, so its notice is done.
    await notify(org);
    expect(await notices(org)).toEqual([]);
  });

  it("starts a room that couldn't read the switch while being made at unset, which fails closed", async () => {
    const org = "org_rs_unread";
    await room(org);
    await setSwitch(org, false);
    await inOrg(org, (sql) => void sql.exec("CREATE TABLE test_release_switch_unreadable (x INTEGER)"));
    const blind = await room(org);
    expect(await appliedSwitch(blind.room)).toEqual({ granted: 1, generation: 0, last_take: 0 });
    await inOrg(org, (sql) => void sql.exec("DROP TABLE test_release_switch_unreadable"));
    await check(blind);
    await expectDown(blind, 1, "blind");
  });

  it("ends quick take, give and take under the last generation, whichever of the notices a room hears", async () => {
    const org = "org_rs_quick";
    const [all3, lastOnly] = [await room(org), await room(org)];
    await unlisted(org);
    for (const granted of [false, true, false]) await setSwitch(org, granted);
    // One room hears the give-back first, which still shows the take it missed, then the take late, then the last;
    // the other hears only the last. Both end down, under the last generation.
    expect((await notice(all3, { org, granted: true, generation: 2, last_take: 1 })).body.applied).toBe("unpublished");
    expect((await notice(all3, { org, granted: false, generation: 1, last_take: 1 })).body.applied).toBe("stale");
    // The last take is a take since what that room applied, so it unpublishes again: only the epoch moves, as
    // nothing was up.
    expect((await notice(all3, { org, granted: false, generation: 3, last_take: 3 })).body.applied).toBe("unpublished");
    expect((await notice(lastOnly, { org, granted: false, generation: 3, last_take: 3 })).body.applied).toBe("unpublished");
    expect(await unpublishes(all3)).toEqual([3, 4].map((epoch) => ({ cause: "release_not_delegated", label: null, release_epoch: epoch })));
    expect(await serving(all3)).toEqual({ script_name: null, release_id: null });
    await expectDown(lastOnly, 3, "heard the last");
    for (const r of [all3, lastOnly]) expect(await appliedSwitch(r.room)).toEqual({ granted: 0, generation: 3, last_take: 3 });
  });
});

describe("a notice the room doesn't acknowledge", () => {
  it("is sent again, and operators are told by the organization from the twelfth unanswered try on; the room comes down when it answers", async () => {
    const org = "org_limit_rs_deaf";
    const r = await room(org);
    await inRoom(r.room, (sql) => void sql.exec("CREATE TABLE test_refuse_release_switch_notice (x INTEGER)"));
    await setSwitch(org, false);
    const finding = () => inModeration((sql) => hasTable(sql, "takedown_finding")
      ? sql.exec("SELECT code, subject, detail, seen FROM takedown_finding WHERE code = 'release_switch_notice_unanswered' AND subject = ?", org).toArray() : []);
    const tries = async () => (await notices(org))[0]?.tries;
    // However many tries the organization's own alarm made before this, the count decides.
    for (let i = 0; i < 20 && (await tries()) < 11; i += 1) await notify(org);
    expect(await tries()).toBe(11);
    expect(await finding()).toEqual([]);
    await notify(org);
    expect(await tries()).toBe(12);
    expect(await finding()).toEqual([{ code: "release_switch_notice_unanswered", subject: org, detail: null, seen: 1 }]);
    // Still sent after the finding, and told again each time.
    await notify(org);
    expect(await tries()).toBe(13);
    expect((await finding())[0].seen).toBe(2);
    expect(await serving(r)).toEqual(UP(r));
    // The room answers: the notice is done, and the room is down.
    await inRoom(r.room, (sql) => void sql.exec("DROP TABLE test_refuse_release_switch_notice"));
    await notify(org);
    expect(await notices(org)).toEqual([]);
    await expectDown(r, 1, "answered at last");
  });

  it("is refused, never acknowledged, when it names another organization or isn't a switch; a room that doesn't exist acknowledges", async () => {
    const org = "org_rs_forged";
    const r = await room(org);
    const before = JSON.stringify(await appliedSwitch(r.room));
    const refusals: [unknown, number, string][] = [
      [{ org: "org_rs_someone_else", granted: false, generation: 1, last_take: 1 }, 403, "not_allowed"],
      [{ granted: false, generation: 1, last_take: 1 }, 403, "not_allowed"],
      [{ org, granted: "no", generation: 1, last_take: 1 }, 400, "invalid_argument"],
      [{ org, granted: false, generation: 1 }, 400, "invalid_argument"],
      [{ org, granted: false, generation: -1, last_take: 1 }, 400, "invalid_argument"],
      [{ org, granted: false, generation: 2, last_take: 1 }, 500, "internal_error"],
      [{ org, granted: true, generation: 2, last_take: 2 }, 500, "internal_error"],
      // A take at a generation the room can't store is refused, never applied: it can't pin the room for ever.
      [`{"org":"${org}","granted":false,"generation":18446744073709551615,"last_take":18446744073709551615}`, 500, "internal_error"],
      ["not json", 400, "invalid_argument"],
    ];
    for (const [body, status, code] of refusals) {
      const answer = await notice(r, body);
      expect([answer.status, answer.body?.error?.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect(JSON.stringify(await appliedSwitch(r.room))).toBe(before);
    expect(await unpublishes(r)).toEqual([]);
    expect(await serving(r)).toEqual(UP(r));
    // A room nobody made answers, so the object stops asking, and is still nobody's.
    const nobody = { room: "ws_rs_nobody", org } as Room;
    expect(await notice(nobody, { org, granted: false, generation: 1, last_take: 1 })).toEqual({ status: 200, body: { known: false, applied: null, generation: null } });
    expect(await inRoom("ws_rs_nobody", (sql) => sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'").toArray())).toEqual([]);
  });

  it("can't be reached by any client: the Worker forwards no such path", async () => {
    const r = await room("org_rs_path");
    await switchedOn(async () => {
      for (const who of [r.owner, OPERATOR]) {
        for (const path of ["/internal/release-switch-notice", `/v1/workspaces/${r.room}/internal/release-switch-notice`, `/v1/workspaces/${r.room}/release-switch-notice`, `/v1/orgs/${r.org}/release-switch-notice`]) {
          const answer = await api(who, "POST", path, { org: r.org, granted: false, generation: 1, last_take: 1 });
          expect(answer.status, `${who.id} ${path}`).toBe(404);
        }
      }
    });
    expect(await unpublishes(r)).toEqual([]);
  });
});

describe("the follow-up to decision 218's PR C", () => {
  const refuse = (r: Room) => inRoom(r.room, (sql) => void sql.exec("CREATE TABLE IF NOT EXISTS test_refuse_release_switch_notice (x INTEGER)"));
  const answer = (r: Room) => inRoom(r.room, (sql) => void sql.exec("DROP TABLE IF EXISTS test_refuse_release_switch_notice"));
  const finding = (code: string, org: string) => inModeration((sql) => hasTable(sql, "takedown_finding")
    ? sql.exec("SELECT code, subject, detail, seen FROM takedown_finding WHERE code = ? AND subject = ?", code, org).toArray() : []);

  it("arms the applier again when a notice comes back stale after the room stopped right after its unpublish", async () => {
    const org = "org_limit_rs_wake";
    const r = await room(org);
    // The room commits the unpublish and stops there, before its bookkeeping and its own arm, and at every notice after
    // it while the test keeps it so: the notice isn't acknowledged.
    await inRoom(r.room, (sql) => void sql.exec("CREATE TABLE test_release_switch_stops_after_commit (x INTEGER)"));
    await setSwitch(org, false);
    await notify(org);
    // A run of the organization's own alarm still under way is waited out, so nothing more is sent until the test sends it.
    await alarmQuiet(principal(org));
    expect(await unpublishes(r)).toEqual([{ cause: "release_not_delegated", label: null, release_epoch: 3 }]);
    expect((await notices(org)).map((n: any) => n.generation)).toEqual([1]);
    // As an object that died there: no wake. The room is quieted first while its provider is still off, so whatever its
    // own runs set can't be the applier's. Then, in one step, a provider is configured, so the applier owes the host's
    // removal, at a time an hour ahead: sooner than anything else the room owes, so its wake is the room's next alarm,
    // and too far for the runtime to run it while the test reads it. The room stops no more, and has no wake.
    await alarmQuiet(stub(r.room));
    const owedAt = Date.now() + 60 * 60 * 1000;
    await runInDurableObject(stub(r.room), async (_: any, state: any) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE test_content_provider_off");
      sql.exec("UPDATE serve_apply SET attempts = 1, attempt_version = (SELECT version FROM serve_state WHERE host = ?), next_attempt_at = ? WHERE host = ?", r.host, owedAt, r.host);
      sql.exec("UPDATE script_delete SET next_attempt_at = ?", owedAt);
      sql.exec("DROP TABLE test_release_switch_stops_after_commit");
      // A public room's first discovery-index check is set at random within six hours: put past the applier's time, so
      // the room's next alarm is the applier's alone.
      await state.storage.put("public_index_verify_next", FAR());
      await state.storage.deleteAlarm();
    });
    // The notice again: the room has applied it, so it is stale, and the room arms for what the applier owes all the
    // same, at exactly the time it owes it, the room's soonest.
    await notify(org);
    expect(await notices(org)).toEqual([]);
    expect(await nextAlarm(stub(r.room))).toBe(owedAt);
    await expectDown(r, 1, "stopped after its unpublish");
  });

  it("keeps counting a room's unanswered tries when the switch is set again, so operators are told on time", async () => {
    const org = "org_limit_rs_deaf_again";
    const r = await room(org);
    await refuse(r);
    await setSwitch(org, false);
    const tries = async () => (await notices(org))[0]?.tries;
    for (let i = 0; i < 20 && (await tries()) < 11; i += 1) await notify(org);
    expect(await tries()).toBeGreaterThanOrEqual(11);
    // Given back: the notice is replaced by the newer switch, and keeps its count. The organization's own alarm may send
    // it again at any point, which only adds a try, so the count is read as at least what it was.
    await setSwitch(org, true);
    const [replaced] = await notices(org);
    expect([replaced.workspace_id, replaced.generation]).toEqual([r.room, 2]);
    expect(replaced.tries).toBeGreaterThanOrEqual(11);
    for (let i = 0; i < 5 && (await tries()) < 12; i += 1) await notify(org);
    expect(await tries()).toBeGreaterThanOrEqual(12);
    expect((await finding("release_switch_notice_unanswered", org)).map((f: any) => [f.code, f.subject, f.detail])).toEqual([["release_switch_notice_unanswered", org, null]]);
    await answer(r);
    await notify(org);
    expect(await notices(org)).toEqual([]);
    // It hears the give-back, which still shows the take it missed.
    await expectDown(r, 2, "answered at last");
  });

  it("stops sending a notice to a listed room that is another organization's, and tells operators once", async () => {
    const mine = await room("org_rs_misdirected_owner");
    const org = "org_rs_misdirected";
    await room(org);
    await unlisted(org);
    await inOrg(org, (sql) => void sql.exec("INSERT INTO org_room (workspace_id) VALUES (?)", mine.room));
    await setSwitch(org, false);
    await notify(org);
    expect(await notices(org)).toEqual([]);
    expect(await finding("release_switch_notice_misdirected", org)).toEqual([{ code: "release_switch_notice_misdirected", subject: org, detail: null, seen: 1 }]);
    // Nothing more is sent, and nothing is told again.
    await notify(org);
    expect(await finding("release_switch_notice_misdirected", org)).toEqual([{ code: "release_switch_notice_misdirected", subject: org, detail: null, seen: 1 }]);
    expect(await finding("release_switch_notice_unanswered", org)).toEqual([]);
    // The room, whose organization's switch was never taken, is untouched.
    expect(await serving(mine)).toEqual(UP(mine));
    expect(await appliedSwitch(mine.room)).toEqual({ granted: 1, generation: 0, last_take: 0 });
  });

  it("sends a notice again to a room still being made when it came, which applies it once it exists", async () => {
    const org = "org_limit_rs_making";
    await room(org);
    const owner: Who = { id: `per_rs_owner_${org}`, org, adminOrgs: [org] };
    await inOrg(org, (sql) => { sql.exec("CREATE TABLE test_release_switch_read_hold (arrived INTEGER)"); sql.exec("INSERT INTO test_release_switch_read_hold (arrived) VALUES (0)"); });
    let making: Promise<{ status: number; body: any }> | undefined;
    try {
      making = api(owner, "POST", "/v1/workspaces", { name: "Being made" });
      // The new room has read the switch, unset, and waits for the answer: the room doesn't exist yet. Polled on the
      // organization's own mark, which is the state itself: no timer.
      await vi.waitFor(async () => expect(await inOrg(org, (sql) => sql.exec("SELECT arrived FROM test_release_switch_read_hold").one().arrived)).toBe(1), { timeout: 10_000, interval: 5 });
      await setSwitch(org, false);
      await notify(org);
      // The room being made didn't answer, so its notice is still owed; the other room's is done.
      expect((await notices(org)).map((n: any) => n.generation)).toEqual([1]);
    } finally {
      await inOrg(org, (sql) => void sql.exec("DROP TABLE IF EXISTS test_release_switch_read_hold"));
    }
    const created = await making!;
    expect(created.status).toBe(200);
    const id: string = created.body.id;
    made.push(id);
    expect((await notices(org)).map((n: any) => n.workspace_id)).toEqual([id]);
    // It started from the switch it read, before the take, and the notice sent again brings it to the take.
    expect(await appliedSwitch(id)).toEqual({ granted: 1, generation: 0, last_take: 0 });
    await notify(org);
    expect(await notices(org)).toEqual([]);
    expect(await appliedSwitch(id)).toEqual({ granted: 0, generation: 1, last_take: 1 });
  });

  it("records a take in a room with no release configuration, which has nothing to unpublish and says so to nobody", async () => {
    const org = "org_limit_rs_bare";
    const owner: Who = { id: `per_rs_owner_${org}`, org, adminOrgs: [org] };
    const created = await api(owner, "POST", "/v1/workspaces", { name: "Bare" });
    expect(created.status).toBe(200);
    const id: string = created.body.id;
    made.push(id);
    await alarmQuiet(stub(id));
    await setSwitch(org, false);
    await notify(org);
    expect(await notices(org)).toEqual([]);
    expect(await appliedSwitch(id)).toEqual({ granted: 0, generation: 1, last_take: 1 });
    expect(await all(id, "SELECT * FROM release_config")).toEqual([]);
    expect(await all(id, "SELECT * FROM unpublish")).toEqual([]);
    expect(await all(id, "SELECT type FROM event WHERE type = 'app.unpublished'")).toEqual([]);
    expect(await all(id, "SELECT action FROM audit_event WHERE action = 'app.unpublished'")).toEqual([]);
  });

  // Each arrival order through the Worker: an operator's sets, the organization's notices, and the room's own reads.
  // The room refuses notices except where a step lets it hear, so the order is the test's and not the alarm's.
  const orders: [string, string[], number[]][] = [
    ["each set heard in turn", ["take", "hear", "give", "hear", "take", "hear"], [3, 4]],
    ["the give-back and the last take heard as one", ["take", "hear", "give", "take", "hear"], [3, 4]],
    ["nothing heard until the last take", ["take", "give", "take", "hear"], [3]],
    ["the give-back read first, by the room itself", ["take", "give", "read", "take", "hear"], [3, 4]],
    ["notices and reads in turn", ["take", "hear", "give", "read", "take", "read", "hear"], [3, 4]],
  ];
  orders.forEach(([name, steps, epochs], n) => {
    it(`ends at the last take, down, whatever the order: ${name}`, async () => {
      const org = `org_limit_rs_order_${n}`;
      const r = await room(org);
      await refuse(r);
      try {
        for (const step of steps) {
          if (step === "take") await setSwitch(org, false);
          if (step === "give") await setSwitch(org, true);
          if (step === "read") await check(r);
          if (step === "hear") { await answer(r); await notify(org); await refuse(r); }
        }
      } finally {
        await answer(r);
      }
      expect(await notices(org)).toEqual([]);
      expect(await appliedSwitch(r.room)).toEqual({ granted: 0, generation: 3, last_take: 3 });
      expect(await serving(r)).toEqual({ script_name: null, release_id: null });
      expect(await unpublishes(r)).toEqual(epochs.map((epoch) => ({ cause: "release_not_delegated", label: null, release_epoch: epoch })));
    });
  });
});

/** The room's clock for release commands, set by the test (test builds only). */
const T = 1_800_000_000_000;
/** Holds a commit between its outside reads and its confirm (test builds only), runs `during`, then lets it go. */
async function heldBetween(r: Room, during: () => Promise<unknown>) {
  await inRoom(r.room, (sql) => {
    sql.exec("CREATE TABLE IF NOT EXISTS test_release_clock (now INTEGER)");
    sql.exec("DELETE FROM test_release_clock");
    sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
    sql.exec("UPDATE release SET upload_started_at = ? WHERE id = ?", T, REL);
    sql.exec("CREATE TABLE test_release_hold (arrived INTEGER)");
    sql.exec("INSERT INTO test_release_hold (arrived) VALUES (0)");
  });
  const answer = commit(r);
  try {
    // Polled on the room's own mark that the commit has reached the hold, which is the state itself: no timer.
    await vi.waitFor(async () => expect(await inRoom(r.room, (sql) => sql.exec("SELECT arrived FROM test_release_hold").one().arrived)).toBe(1), { timeout: 10_000, interval: 5 });
    await during();
  } finally {
    await inRoom(r.room, (sql) => void sql.exec("DROP TABLE test_release_hold"));
  }
  return answer;
}

describe("a commit racing a take", () => {
  it("never goes live when the take reaches the room between the commit's reads and its confirm", async () => {
    // The commit read the switch held. The take is made, and its notice heard by the room, while the commit is held
    // between those reads and its confirm: the unpublish clears the stage and moves the epoch, so it never goes live.
    const org = "org_limit_rs_race_before";
    const r = await room(org, { state: "uploading" });
    const answer = await heldBetween(r, async () => {
      await setSwitch(org, false);
      await notify(org);
      expect((await unpublishes(r)).length).toBe(1);
    });
    // The unpublish ended the staged release under the epoch it raised from; the confirm finds it ended.
    expect(answer.body).toEqual({ release_id: REL, state: "failed", rechecked: false, reason: "release_epoch_moved" });
    expect(await serving(r)).toEqual({ script_name: null, release_id: null });
    expect((await all(r.room, "SELECT state FROM release WHERE id = ?", REL))[0].state).toBe("failed");
    expect((await all(r.room, "SELECT script_name FROM script_delete ORDER BY script_name")).map((q: any) => q.script_name)).toEqual([r.prev, r.script].sort());
  });

  it("is unpublished when the take reaches the room after the commit went live on reads made before it", async () => {
    // Reads at most five seconds old decide a confirm, so a commit whose reads came just before a take can go live.
    // The take still ends it, as soon as the room hears.
    const org = "org_limit_rs_race_after";
    const r = await room(org, { state: "uploading" });
    expect((await commit(r)).body).toEqual({ release_id: REL, state: "live", rechecked: true, reason: null });
    expect(await serving(r)).toEqual({ script_name: r.script, release_id: REL });
    await setSwitch(org, false);
    await notify(org);
    expect(await serving(r)).toEqual({ script_name: null, release_id: null });
    expect((await all(r.room, "SELECT state FROM release WHERE id = ?", REL))[0].state).toBe("unpublished");
    expect(await unpublishes(r)).toEqual([{ cause: "release_not_delegated", label: null, release_epoch: 3 }]);
  });
});

describe("the switch's two facts, as the recheck reads them through the organization's own object", () => {
  it("gives the cause `release_switch` when both are taken, and fails on the delegation when the switch alone can't be read", async () => {
    const org = "org_rs_both";
    await room(org);
    await setSwitch(org, false);
    expect((await api(OPERATOR, "PUT", `/v1/orgs/${org}/provisioning-delegation`, { granted: false })).status).toBe(200);
    try {
      // Made after the take, so nothing unpublishes and the recheck alone decides: the switch comes first.
      const both = await room(org);
      expect((await recheck(both)).body).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_not_delegated" });
      const audit = await all(both.room, "SELECT new_json FROM audit_event WHERE action LIKE 'release.%'");
      expect(audit.map((a: any) => JSON.parse(a.new_json))).toEqual([{ state: "failed", reason: "release_not_delegated", cause: "release_switch" }]);
      // The switch alone can't be read, through the organization's real object, and the delegation is taken. The
      // room made before applied the take, and an unread switch is undecided; the delegation was read, and a fact that
      // was read and fails stands, whatever is unknown. So it fails, and says the delegation refused (decided in PR C).
      await inOrg(org, (sql) => void sql.exec("CREATE TABLE test_release_switch_unreadable (x INTEGER)"));
      const blind = await room(org);
      expect(await appliedSwitch(blind.room)).toEqual({ granted: 1, generation: 0, last_take: 0 });
      expect((await recheck(blind)).body).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_not_delegated" });
      const blindAudit = await all(blind.room, "SELECT new_json FROM audit_event WHERE action LIKE 'release.%'");
      expect(blindAudit.map((a: any) => JSON.parse(a.new_json))).toEqual([{ state: "failed", reason: "release_not_delegated", cause: "provisioning_delegation" }]);
      expect(await unpublishes(blind)).toEqual([]);
      // With the delegation held, the same unreadable switch is undecided: nothing written.
      expect((await api(OPERATOR, "PUT", `/v1/orgs/${org}/provisioning-delegation`, { granted: true })).status).toBe(200);
      const undecided = await room(org);
      const answer = await recheck(undecided);
      expect([answer.status, answer.body?.error?.code]).toEqual([503, "standing_unknown"]);
      expect((await all(undecided.room, "SELECT state FROM release WHERE id = ?", REL))[0].state).toBe("queued");
    } finally {
      await inOrg(org, (sql) => void sql.exec("DROP TABLE IF EXISTS test_release_switch_unreadable"));
      await api(OPERATOR, "PUT", `/v1/orgs/${org}/provisioning-delegation`, { granted: true });
    }
  });
});

describe("the operator's route, beyond PR B's tests", () => {
  it("is refused to another organization's admin, and answers an operator who is also a member as any operator", async () => {
    const org = "org_rs_route";
    await room(org);
    const path = `/v1/orgs/${org}/release-delegation`;
    const otherAdmin: Who = { id: "per_rs_other_admin", org: "org_rs_route_other", adminOrgs: ["org_rs_route_other"] };
    const operatorMember: Who = { ...OPERATOR, org };
    const operatorAdmin: Who = { ...OPERATOR, org, adminOrgs: [org] };
    await switchedOn(async () => {
      for (const method of ["GET", "PUT"]) expect((await api(otherAdmin, method, path, { granted: false })).code, method).toBe("not_allowed");
      expect((await api(OPERATOR, "GET", path)).body).toMatchObject({ generation: 0 });
      // An operator who is a member, or an admin, of the organization is an operator all the same: reads and sets.
      taken.add(org);
      expect((await api(operatorMember, "PUT", path, { granted: false })).body).toMatchObject({ granted: false, generation: 1, set_by: OPERATOR.id });
      expect((await api(operatorAdmin, "PUT", path, { granted: true })).body).toMatchObject({ granted: true, generation: 2, set_by: OPERATOR.id });
      expect((await api(operatorMember, "GET", path)).body).toMatchObject({ granted: true, generation: 2, last_take: 1 });
    });
  });

  it("keeps every set in the organization's log, in order, with who set it", async () => {
    const org = "org_rs_log";
    await room(org);
    for (const granted of [false, true, false, true]) await setSwitch(org, granted);
    const log = await inOrg(org, (sql) => sql.exec("SELECT granted, generation, last_take, set_by, typeof(set_at) AS at FROM org_release_switch_log ORDER BY seq").toArray());
    expect(log).toEqual([[0, 1, 1], [1, 2, 1], [0, 3, 3], [1, 4, 3]].map(([granted, generation, lastTake]) => ({ granted, generation, last_take: lastTake, set_by: OPERATOR.id, at: "integer" })));
  });

  it("refuses a set past the generation storage holds, and writes nothing: no switch, no log row, no notice", async () => {
    const org = "org_rs_cap";
    await room(org);
    await setSwitch(org, false);
    await notify(org);
    const state = () => inOrg(org, (sql) => JSON.stringify([
      sql.exec("SELECT granted, CAST(generation AS TEXT) AS g, CAST(last_take AS TEXT) AS t, set_by, set_at FROM org_release_switch").toArray(),
      sql.exec("SELECT count(*) AS n FROM org_release_switch_log").one(),
      sql.exec("SELECT * FROM org_release_notice").toArray(),
    ]));
    await inOrg(org, (sql) => void sql.exec("UPDATE org_release_switch SET granted = 0, generation = 9223372036854775807, last_take = 9223372036854775807"));
    const before = await state();
    for (const granted of [true, false]) {
      const set = await switchedOn(() => api(OPERATOR, "PUT", `/v1/orgs/${org}/release-delegation`, { granted }));
      expect([set.status, set.code], `${granted}`).toEqual([500, "internal_error"]);
    }
    expect(await state()).toBe(before);
    // Put back below the cap, so the clean-up can give it back.
    await inOrg(org, (sql) => void sql.exec("UPDATE org_release_switch SET granted = 0, generation = 2, last_take = 2"));
  });
});
