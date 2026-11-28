import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmQuiet, clearAlarm, manualAlarms, runAlarm } from "./alarm";
import { txtData } from "./fake-resolver";

// M6 step 8e: a custom hostname's marker (ADR 0010's "Custom domains", step 5, and "The release job", step 6; the gate's
// item "a custom hostname's marker"). Once the applier has written a custom host's entry for a release its default host's
// marker confirmed, the room's alarm fetches that release's marker through the custom host, and records the release
// served there only on that host's own marker. A marker that never comes within 30 seconds of the switch sets back that
// host alone; it opens again after a minute, doubling, and is checked again. A custom host never takes a release its
// default host's marker hasn't confirmed. And, from spike D's item 12, a marker answered for a host the room has closed is
// never taken for anything.
//
// Each room is set up as in `custom-routing.spec.ts`: a committed claim routed on a custom hostname, its content provider
// on, in a partition of the stand-in of its own (`CONTENT_PARTITIONS`). The job runs only in a room that opts in,
// `test_custom_marker`, which also stands for the release path's gate being open for it. **Time** is the release
// commands' clock, `test_release_clock`, so every bound is shown to the millisecond. **The custom host** is the stand-in
// in `fake-content.ts`, by host name: it answers the marker's path with what a test says, and counts every fetch.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string; control: string; partition: string };
let key: any;
type Who = { id: string; org: string; adminOrgs?: string[] };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "x-test-public-rooms": "on" };
  if (method !== "GET") headers["idempotency-key"] = `cm-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const answerWith = (name: string, value: string) => fetch("https://resolver-fake.example.com/set", { method: "POST", body: JSON.stringify({ name: `_podster-challenge.${name}`, answer: { body: { Status: 0, Answer: [{ name: `_podster-challenge.${name}`, type: 16, data: txtData(value) }] } } }) });
const cloudflareCalls = async (name: string) => ((await (await fetch(`https://hostnames-fake.example.com/state?hostname=${name}`)).json()) as { calls: string[] }).calls;
const setAtCloudflare = (name: string, status: string | null) => fetch(`https://hostnames-fake.example.com/set?hostname=${name}`, { method: "POST", body: JSON.stringify({ status }) });
const content = (path: string, body?: unknown) => fetch(`https://${FAKE.control}${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
type Held = { entries: Record<string, string>; calls: { op: string; name: string; status: number }[] };
const held = async () => (await (await content("/state")).json()) as Held;

// --- the custom host, at the stand-in ----------------------------------------------------------------------------------
const marker = (path: string, host: string, body?: unknown) =>
  fetch(`https://${FAKE.control}/${path}?host=${host}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
/** What the custom host answers at the marker's path. Said nothing, not-found. */
const serve = (host: string, what: { body?: string; status?: number }) => marker("marker-serve", host, what);
const fetches = async (host: string) => ((await (await marker("marker-state", host)).json()) as { fetches: number; credentialed: number; expiredGates: number });
async function hostGate(host: string) {
  const { id } = (await (await marker("marker-gate", host, {})).json()) as { id: number };
  const at = (path: string) => fetch(`https://${FAKE.control}/${path}?host=${host}&id=${id}`);
  return { arrived: async () => { await (await at("marker-arrived")).json(); }, release: async () => { await (await at("marker-release")).json(); } };
}

async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

const PREV = `rel_${"6d".repeat(16)}`;
const NEXT = `rel_${"7e".repeat(16)}`;
const SHA = "ef".repeat(20);
/** A release's marker, as the upload writes it. */
const body = (release: string) => `{"release_id":"${release}","commit":"${SHA}"}\n`;
const T = 1_900_000_000_000;
const POLL = 5_000;
const WAIT = 30_000;
const MINUTE = 60_000;
let rooms = 0;
const made: string[] = [];
let names = 0;
const newName = () => `m${(++names).toString(36)}${crypto.randomUUID().slice(0, 8)}.example.net`;

type Room = { room: string; owner: Who; label: string; host: string; script: string };
async function room(org: string): Promise<Room> {
  const owner: Who = { id: `per_cm_owner_${org}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Custom hostname marker" });
  expect(created.status, org).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  await manualAlarms(stub(id));
  const n = ++rooms;
  const label = `cm${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  const script = `${label}.${PREV}`;
  await inRoom(id, (sql) => {
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1, require_person_review = 1", `pub_${crypto.randomUUID().replace(/-/g, "")}`);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("CREATE TABLE test_custom_hostname_create_open (x INTEGER)");
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/marker', 'public', 'main', 'ready', ?, 1, 1, 1)", 987680100 + n, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES ('tsk_cm_1', 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", owner.id, owner.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, 'served', ?, 3, 2, 'tsk_cm_1', ?, ?, ?, 1, ?, 1, 1, 1)`,
      PREV, SHA, label, script, PREV, owner.id, owner.id);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, script);
    sql.exec("INSERT OR IGNORE INTO release_script_kind (release_id, script_name, kind, recorded_at) SELECT substr(s, -36), s, 'static', 1 FROM (SELECT script_name AS s FROM serve_state UNION SELECT flight_before FROM serve_state) WHERE s IS NOT NULL");
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, script);
  });
  await content("/seed", { scripts: [script], entries: { [host]: script } });
  return { room: id, owner, label, host, script };
}

const path = (r: Room) => `/v1/workspaces/${r.room}/app-hostname`;
const requestRow = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT id, state FROM hostname_request ORDER BY requested_at DESC, id DESC LIMIT 1").toArray()[0] ?? null);
const customRow = (r: Room, name: string) => inRoom(r.room, (sql) => sql.exec("SELECT script_name, version, closed FROM serve_state WHERE host = ? AND kind = 'custom'", name).toArray()[0] ?? null);
const defaultRow = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT script_name, version FROM serve_state WHERE kind = 'default'").one());
const markerRow = (r: Room, name: string) => inRoom(r.room, (sql) => sql.exec("SELECT version, script_name, switched_at, attempts, next_at, leased_until, served_at, set_back_at, set_backs, last_code FROM custom_marker WHERE host = ?", name).toArray()[0] ?? null);
const releaseState = (r: Room, id: string) => inRoom(r.room, (sql) => sql.exec("SELECT state FROM release WHERE id = ?", id).one().state);
const due = (r: Room) => inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = updated_at - 61000 WHERE checked_at IS NOT NULL"));
const quietPass = (r: Room) => runInDurableObject(stub(r.room), async (instance: any, state: any) => {
  await clearAlarm(state);
  await runAlarm(instance, state);
  await clearAlarm(state);
});
const step = async (r: Room) => { await due(r); await switchedOn(() => quietPass(r)); };
const applyDue = (r: Room) => inRoom(r.room, (sql) => sql.exec("UPDATE serve_apply SET next_attempt_at = 0 WHERE next_attempt_at IS NOT NULL"));
/** One pass of the room's alarm, with release switched on for the deployment. */
const pass = (r: Room) => switchedOn(() => quietPass(r));
/** The release commands' clock, which the job keeps its times by. */
const at = (r: Room, now: number) => inRoom(r.room, (sql) => void sql.exec("UPDATE test_release_clock SET now = ?", now));

/** A room whose custom host is routed and its entry written for the release served, before the job is on. */
async function routed(org: string) {
  const r = await room(org);
  const name = newName();
  const request = (await switchedOn(() => api(r.owner, "PUT", path(r), { hostname: name }))).body.request;
  await alarmQuiet(stub(r.room));
  await inRoom(r.room, (sql) => sql.exec("DROP TABLE test_content_provider_off"));
  await answerWith(name, request.challenge_value);
  await step(r);
  expect(await requestRow(r)).toMatchObject({ state: "claimed" });
  await step(r);
  expect(await cloudflareCalls(name)).toEqual(["create"]);
  await setAtCloudflare(name, "active");
  await step(r);
  await pass(r);
  expect((await held()).entries[name]).toBe(`${r.script}@${name}`);
  // The job's turn is put a day ahead, so only the applier and the marker act in a pass from here.
  await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = ?, proved_at = ?", Date.now() + 24 * 3600_000, Date.now()));
  return { r, name };
}

/** The job switched on for the room, its clock at `now`. */
const markerOn = (r: Room, now = T) => inRoom(r.room, (sql) => {
  sql.exec("CREATE TABLE test_custom_marker (x INTEGER)");
  sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
  sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", now);
});

/** A release committed live and waiting for its marker on the default host: every open host wants its script. */
const commitNext = async (r: Room) => {
  const next = `${r.label}.${NEXT}`;
  await content("/seed", { scripts: [next] });
  await inRoom(r.room, (sql) => {
    sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, 'live', ?, 3, 2, 'tsk_cm_1', ?, ?, ?, 2, ?, 2, 2, 2)`, NEXT, SHA, r.label, next, NEXT, r.owner.id, r.owner.id);
    sql.exec("UPDATE release_config SET in_flight_release = ?, in_flight_script = ?, in_flight_epoch = 2, in_flight_at = 3", NEXT, next);
    sql.exec("UPDATE serve_state SET release_id = ?, script_name = ?, flight_version = version + 1, flight_before = script_name, version = version + 1", NEXT, next);
    sql.exec("INSERT OR IGNORE INTO release_script_kind (release_id, script_name, kind, recorded_at) SELECT substr(s, -36), s, 'static', 1 FROM (SELECT script_name AS s FROM serve_state UNION SELECT flight_before FROM serve_state) WHERE s IS NOT NULL");
  });
  return next;
};
/** The default host's marker confirms the release in flight: served, the flight over (what the marker job records). */
const confirmNext = (r: Room) => inRoom(r.room, (sql) => {
  sql.exec("UPDATE release SET state = 'served' WHERE id = ?", NEXT);
  sql.exec("UPDATE release SET state = 'replaced' WHERE id = ?", PREV);
  sql.exec("UPDATE release_config SET in_flight_release = NULL, in_flight_script = NULL, in_flight_epoch = NULL, in_flight_at = NULL, kept_previous = ?", r.script);
  sql.exec("UPDATE serve_state SET flight_version = NULL, flight_before = NULL");
});


/** A rollback from `PREV` (R2) back to an earlier release (R1), committed and waiting for its marker on the default host.
 * Only the default host is written: the flight's mark leaves each custom host as it was, as a commit leaves a closed one. */
const OLD = `rel_${"3a".repeat(16)}`;
const ROLL = `rel_${"4b".repeat(16)}`;
const startRollback = async (r: Room) => {
  const older = `${r.label}.${OLD}`;
  await content("/seed", { scripts: [older] });
  await inRoom(r.room, (sql) => {
    const release = (id: string, state: string, script: string, scriptRelease: string) => sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, ?, ?, 3, 2, 'tsk_cm_1', ?, ?, ?, 0, ?, 0, 0, 0)`, id, SHA, state, r.label, script, scriptRelease, r.owner.id, r.owner.id);
    release(OLD, "replaced", older, OLD);
    release(ROLL, "live", older, OLD);
    sql.exec("INSERT INTO release_rollback (release_id, rollback_to) VALUES (?, ?)", ROLL, OLD);
    sql.exec("UPDATE release_config SET kept_previous = NULL, in_flight_release = ?, in_flight_script = ?, in_flight_epoch = 2, in_flight_at = 3", ROLL, older);
    sql.exec("UPDATE serve_state SET release_id = ?, script_name = ?, flight_version = version + 1, flight_before = script_name, version = version + 1 WHERE kind = 'default'", OLD, older);
    sql.exec("INSERT OR IGNORE INTO release_script_kind (release_id, script_name, kind, recorded_at) VALUES (?, ?, 'static', 1)", OLD, older);
  });
  return older;
};
/** The rollback's marker came back on the default host: the rollback is served, R2 replaced, the flight over. */
const settleRollback = (r: Room) => inRoom(r.room, (sql) => {
  sql.exec("UPDATE release SET state = 'served', served_at = 4 WHERE id = ?", ROLL);
  sql.exec("UPDATE release SET state = 'replaced' WHERE id = ?", PREV);
  sql.exec("UPDATE release_config SET in_flight_release = NULL, in_flight_script = NULL, in_flight_epoch = NULL, in_flight_at = NULL, kept_previous = ?", r.script);
  sql.exec("UPDATE serve_state SET flight_version = NULL, flight_before = NULL");
});

describe("a custom hostname's marker (M6 step 8e)", () => {
  beforeAll(async () => {
    key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
    for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  });
  beforeEach(async () => { await content("/reset", {}); });
  afterEach(async () => {
    for (const id of made.splice(0)) await alarmQuiet(stub(id));
    expect((await held()).calls.filter((call) => call.name.startsWith("unexpected "))).toEqual([]);
  });

  it("runs in its own partition of the content provider's stand-in", () => {
    expect([FAKE.partition, FAKE.control]).toEqual(["custom-marker", "custom-marker.content-fake.example.com"]);
    expect([BINDINGS.CONTENT_DISPATCH_NAMESPACE, BINDINGS.CONTENT_KV_NAMESPACE_ID]).toEqual(["podster-test-apps-custom-marker", "d4".repeat(16)]);
  });

  it("records a release served on a custom host only by that host's own marker, fetched once its entry is written", async () => {
    const { r, name } = await routed("org_cm_served");
    // The job off: however many passes, nothing is fetched.
    await pass(r);
    expect((await fetches(name)).fetches).toBe(0);
    await markerOn(r);
    // Not-found: fetched once, at the switch, and looked at again after the poll.
    await pass(r);
    expect((await fetches(name)).fetches).toBe(1);
    expect(await markerRow(r, name)).toMatchObject({ switched_at: T, attempts: 1, next_at: T + POLL, leased_until: null, served_at: null, last_code: "custom_marker_awaiting" });
    // Another release's marker, a millisecond early and then on time: not this release's, so not served.
    await serve(name, { body: body(NEXT) });
    await at(r, T + POLL - 1);
    await pass(r);
    expect((await fetches(name)).fetches).toBe(1);
    await at(r, T + POLL);
    await pass(r);
    expect((await fetches(name)).fetches).toBe(2);
    expect(await markerRow(r, name)).toMatchObject({ served_at: null, next_at: T + 2 * POLL });
    // Its own marker: recorded served on the custom host. Nothing more is fetched for it.
    await serve(name, { body: body(PREV) });
    await at(r, T + 2 * POLL);
    await pass(r);
    expect(await markerRow(r, name)).toMatchObject({ served_at: T + 2 * POLL, attempts: 3, next_at: null, last_code: null, set_backs: 0 });
    await at(r, T + 10 * WAIT);
    await pass(r);
    expect((await fetches(name)).fetches).toBe(3);
    expect((await fetches(name)).credentialed).toBe(0);
    // The default host, the release and the entry are as they were.
    expect([await releaseState(r, PREV), await defaultRow(r), (await held()).entries[name]]).toEqual(["served", { script_name: r.script, version: 5 }, `${r.script}@${name}`]);
  });

  it("sets back only the custom host when its marker never comes within 30 seconds of its switch, to the millisecond", async () => {
    const { r, name } = await routed("org_cm_setback");
    await markerOn(r);
    await pass(r);
    const before = await customRow(r, name);
    // A millisecond short of the wait: fetched again, and not set back.
    await at(r, T + WAIT - 1);
    await pass(r);
    expect(await customRow(r, name)).toEqual(before);
    expect(await markerRow(r, name)).toMatchObject({ next_at: T + WAIT, set_back_at: null });
    // At the wait's end: that host alone goes to nothing, still open, its version one higher.
    await at(r, T + WAIT);
    await pass(r);
    expect(await customRow(r, name)).toEqual({ script_name: null, version: before.version + 1, closed: 0 });
    expect(await markerRow(r, name)).toMatchObject({ set_back_at: T + WAIT, set_backs: 1, next_at: T + WAIT + MINUTE, last_code: "custom_marker_missing", served_at: null });
    // The release stays served on its default host, which is untouched.
    expect([await releaseState(r, PREV), await defaultRow(r)]).toEqual(["served", { script_name: r.script, version: 5 }]);
    // The applier takes the custom host's entry down; the default host's stays.
    await applyDue(r);
    await pass(r);
    expect([(await held()).entries[name], (await held()).entries[r.host]]).toEqual([undefined, r.script]);
  });

  it("opens a set-back host again on the release served after a minute, doubling, and checks its marker again", async () => {
    const { r, name } = await routed("org_cm_reopen");
    await markerOn(r);
    await pass(r);
    await at(r, T + WAIT);
    await pass(r);
    const setBack = await customRow(r, name);
    // A millisecond short of the minute: nothing.
    await at(r, T + WAIT + MINUTE - 1);
    await pass(r);
    expect(await customRow(r, name)).toEqual(setBack);
    // The minute: opened on the release last confirmed served, its version one higher.
    await at(r, T + WAIT + MINUTE);
    await pass(r);
    expect(await customRow(r, name)).toEqual({ script_name: r.script, version: setBack.version + 1, closed: 0 });
    expect(await markerRow(r, name)).toMatchObject({ set_back_at: null, set_backs: 1, last_code: "custom_marker_reopened" });
    // Written again and checked again from its new switch. Still nothing: set back, and the next wait is two minutes.
    const reopenedAt = T + WAIT + MINUTE;
    await applyDue(r);
    await pass(r);
    expect((await held()).entries[name]).toBe(`${r.script}@${name}`);
    expect(await markerRow(r, name)).toMatchObject({ switched_at: reopenedAt, attempts: 1, served_at: null });
    await at(r, reopenedAt + WAIT);
    await pass(r);
    expect(await markerRow(r, name)).toMatchObject({ set_backs: 2, next_at: reopenedAt + WAIT + 2 * MINUTE });
    // Opened again after two minutes, and this time its marker comes back: served, and the count in a row is over.
    await at(r, reopenedAt + WAIT + 2 * MINUTE);
    await pass(r);
    await serve(name, { body: body(PREV) });
    await applyDue(r);
    await pass(r);
    expect(await markerRow(r, name)).toMatchObject({ served_at: reopenedAt + WAIT + 2 * MINUTE, set_backs: 0 });
    expect((await held()).entries[name]).toBe(`${r.script}@${name}`);
  });

  it("waits to reopen while routing's checks don't hold, and never reopens a host that moved since its set-back", async () => {
    const { r, name } = await routed("org_cm_reopen_wait");
    await markerOn(r);
    await pass(r);
    await at(r, T + WAIT);
    await pass(r);
    const setBack = await customRow(r, name);
    // Cloudflare's last status isn't active: not reopened, and looked at again after the same wait.
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_provider SET provider_status = 'pending'"));
    await at(r, T + WAIT + MINUTE);
    await pass(r);
    expect(await customRow(r, name)).toEqual(setBack);
    expect(await markerRow(r, name)).toMatchObject({ next_at: T + WAIT + 2 * MINUTE, last_code: "custom_marker_reopen_waiting" });
    // The host moved meanwhile (here, closed as a claim's end closes it): the set-back is over, and nothing reopens it.
    await inRoom(r.room, (sql) => {
      sql.exec("UPDATE hostname_provider SET provider_status = 'active'");
      sql.exec("UPDATE serve_state SET closed = 1, version = version + 1 WHERE host = ?", name);
    });
    await at(r, T + WAIT + 2 * MINUTE);
    await pass(r);
    expect(await customRow(r, name)).toEqual({ script_name: null, version: setBack.version + 1, closed: 1 });
  });

  it("never fetches a custom host for a release its default host's marker hasn't confirmed, and keeps the release confirmed there meanwhile", async () => {
    const { r, name } = await routed("org_cm_flight");
    await markerOn(r);
    await serve(name, { body: body(PREV) });
    await pass(r);
    expect(await markerRow(r, name)).toMatchObject({ served_at: T });
    // A release committed live: the custom host wants it, but its marker hasn't come back through the default host.
    const next = await commitNext(r);
    for (const now of [T + POLL, T + WAIT, T + 10 * WAIT]) {
      await at(r, now);
      await applyDue(r);
      await pass(r);
    }
    expect((await fetches(name)).fetches).toBe(1);
    expect((await held()).entries[name]).toBe(`${r.script}@${name}`);
    expect((await customRow(r, name)).script_name).toBe(next);
    // Even a record that says the applier wrote it, which the applier never makes for a release not yet served, starts
    // no fetch: the job asks for the release served on the default host itself. (Its applier's own wait is put far
    // ahead, so only the job acts.)
    await inRoom(r.room, (sql) => sql.exec(
      "UPDATE serve_apply SET applied_version = (SELECT version FROM serve_state WHERE host = ?), applied_script = ?, applied_at = 9, next_attempt_at = ? WHERE host = ?",
      name, next, Date.now() + 24 * 3600_000, name));
    await pass(r);
    expect([(await fetches(name)).fetches, (await markerRow(r, name)).script_name]).toEqual([1, r.script]);
    await inRoom(r.room, (sql) => sql.exec("DELETE FROM serve_apply WHERE host = ?", name));
    // The default host's marker confirms it: the applier writes it, and the custom host's own marker is fetched for it.
    await confirmNext(r);
    await serve(name, { body: body(NEXT) });
    const now = T + 11 * WAIT;
    await at(r, now);
    await applyDue(r);
    await pass(r);
    expect((await held()).entries[name]).toBe(`${next}@${name}`);
    expect(await markerRow(r, name)).toMatchObject({ script_name: next, switched_at: now, served_at: now });
  });

  it("fetches nothing behind its gates: release off for the deployment, the app held, the content domain stopped", async () => {
    const { r, name } = await routed("org_cm_gates");
    await markerOn(r);
    // Release not switched on for the deployment: nothing, and nothing is recorded.
    await quietPass(r);
    expect([(await fetches(name)).fetches, await markerRow(r, name)]).toEqual([0, null]);
    // The app held because nobody may release: its entry comes down, and nothing is fetched.
    await inRoom(r.room, (sql) => sql.exec("UPDATE release_hold SET cause = 'no_releaser', held_at = 1, until = ?, generation = generation + 1", T + 7 * 24 * 3600_000));
    await applyDue(r);
    await inRoom(r.room, (sql) => sql.exec("DELETE FROM serve_apply WHERE host = ?", name));
    await pass(r);
    expect((await held()).entries[name]).toBeUndefined();
    expect([(await fetches(name)).fetches, await markerRow(r, name)]).toEqual([0, null]);
  });

  describe("spike D, item 12: the edge can answer for a custom hostname after its delete", () => {
    it("records nothing of a marker answered for a host the room closed while the fetch was out, and sets nothing back", async () => {
      const { r, name } = await routed("org_cm_lag");
      await markerOn(r);
      const gate = await hostGate(name);
      const running = pass(r);
      let closed: any;
      try {
        await gate.arrived();
        // The claim ends while the fetch is out: the room clears and closes the host, as every claim's end does first.
        await inRoom(r.room, (sql) => sql.exec("UPDATE serve_state SET script_name = NULL, release_id = NULL, label = NULL, label_current = NULL, closed = 1, version = version + 1 WHERE host = ?", name));
        closed = await customRow(r, name);
        // The edge still answers for the name with the release's own marker.
        await serve(name, { body: body(PREV) });
      } finally {
        await gate.release();
      }
      await running;
      expect((await fetches(name)).expiredGates).toBe(0);
      // Nothing is kept of it: not served, not set back, and the closed host is exactly as the room left it.
      expect(await markerRow(r, name)).toMatchObject({ served_at: null, set_back_at: null, next_at: null, leased_until: null, last_code: "custom_marker_moved" });
      expect(await customRow(r, name)).toEqual(closed);
      // Past the marker's wait, nothing more is fetched for the closed host, and nothing is set back on it.
      await at(r, T + 10 * WAIT);
      await pass(r);
      expect([(await fetches(name)).fetches, await customRow(r, name)]).toEqual([1, closed]);
    });

    it("never fetches a custom host once its claim ends, and what stops it serving is its entry taken down, not the marker", async () => {
      const { r, name } = await routed("org_cm_ended");
      await markerOn(r);
      await serve(name, { body: body(PREV) });
      await pass(r);
      expect(await markerRow(r, name)).toMatchObject({ served_at: T });
      // Cloudflare reports it moved: the claim ends, and the room clears and closes the host at once.
      await setAtCloudflare(name, "moved");
      await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = 0"));
      await at(r, T + MINUTE);
      await pass(r);
      expect(await requestRow(r)).toMatchObject({ state: "ending" });
      expect(await customRow(r, name)).toMatchObject({ script_name: null, closed: 1 });
      // The applier takes the entry down: with no entry, the content Worker refuses the host whatever still routes it
      // there. The edge still answers the marker; it is never fetched again, and the claim isn't freed on its word.
      await applyDue(r);
      await pass(r);
      expect((await held()).entries[name]).toBeUndefined();
      await at(r, T + 10 * WAIT);
      await pass(r);
      expect((await fetches(name)).fetches).toBe(1);
    });
  });

  describe("the architect's rulings on #448, 2026-11-18", () => {
    it("L1: a set-back host isn't reopened while a rollback is in flight, so the release rolled away from is never written", async () => {
      const { r, name } = await routed("org_cm_l1_reopen");
      await markerOn(r);
      await pass(r);
      await at(r, T + WAIT);
      await pass(r);
      await applyDue(r);
      await pass(r);
      const setBack = await customRow(r, name);
      expect([setBack.script_name, (await held()).entries[name]]).toEqual([null, undefined]);
      const older = await startRollback(r);
      // The reopening's wait runs out while the rollback waits for its marker: it waits again, and the host serves nothing.
      await at(r, T + WAIT + MINUTE);
      await applyDue(r);
      await pass(r);
      expect(await customRow(r, name)).toEqual(setBack);
      expect(await markerRow(r, name)).toMatchObject({ next_at: T + WAIT + 2 * MINUTE, last_code: "custom_marker_reopen_waiting" });
      await applyDue(r);
      await pass(r);
      expect((await held()).entries[name]).toBeUndefined();
      // The flight settles: reopened on the release rolled back to, never on the one rolled away from.
      await settleRollback(r);
      await at(r, T + WAIT + 2 * MINUTE);
      await pass(r);
      expect(await customRow(r, name)).toMatchObject({ script_name: older, closed: 0 });
      await applyDue(r);
      await pass(r);
      expect((await held()).entries[name]).toBe(`${older}@${name}`);
    });

    it("L1: routing doesn't open a custom host while a rollback is in flight (8c's start), and opens it once the flight settles", async () => {
      const { r, name } = await routed("org_cm_l1_route");
      // Cloudflare's status is read and isn't active: the host closes and its entry comes down.
      await setAtCloudflare(name, "pending");
      await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = ?", Date.now() - 7 * 3600_000));
      await pass(r);
      await applyDue(r);
      await pass(r);
      const closed = await customRow(r, name);
      expect([closed.closed, (await held()).entries[name]]).toEqual([1, undefined]);
      const older = await startRollback(r);
      // Active again while the rollback waits for its marker: routing reads every check holding, and still opens nothing.
      await setAtCloudflare(name, "active");
      await step(r);
      expect(await customRow(r, name)).toEqual(closed);
      await applyDue(r);
      await pass(r);
      expect((await held()).entries[name]).toBeUndefined();
      // The flight settles: opened on the release rolled back to.
      await settleRollback(r);
      await step(r);
      expect(await customRow(r, name)).toMatchObject({ script_name: older, closed: 0 });
      await applyDue(r);
      await pass(r);
      expect((await held()).entries[name]).toBe(`${older}@${name}`);
    });

    it("I2: a switch left pending while the job was idle starts its wait again on resuming, and is fetched before any set-back", async () => {
      const { r, name } = await routed("org_cm_i2");
      await serve(name, { status: 404 });
      await markerOn(r);
      await pass(r);
      expect(await markerRow(r, name)).toMatchObject({ switched_at: T, next_at: T + POLL });
      // Release off for the deployment past the wait's end: idle, nothing fetched, nothing set back.
      await at(r, T + WAIT);
      await quietPass(r);
      const IDLE = 10 * MINUTE;
      expect(await markerRow(r, name)).toMatchObject({ switched_at: T, next_at: T + WAIT + IDLE, last_code: "custom_marker_idle" });
      expect([(await fetches(name)).fetches, (await customRow(r, name)).script_name]).toEqual([1, r.script]);
      // Resumed: the switch's wait starts again from now, and the marker is fetched, not set back unseen.
      const resumed = T + WAIT + IDLE;
      await at(r, resumed);
      await pass(r);
      expect(await markerRow(r, name)).toMatchObject({ switched_at: resumed, set_back_at: null, last_code: "custom_marker_awaiting" });
      expect([(await fetches(name)).fetches, (await customRow(r, name)).script_name]).toEqual([2, r.script]);
      await serve(name, { body: body(PREV) });
      await at(r, resumed + POLL);
      await pass(r);
      expect(await markerRow(r, name)).toMatchObject({ served_at: resumed + POLL });
    });
  });

  it("room schema step 56: adds the marker's record to a room made before it, and runs again safely", async () => {
    const { r, name } = await routed("org_cm_schema");
    const latest = await inRoom(r.room, (sql) => sql.exec("SELECT version FROM schema_version").one().version as number);
    const visit = async () => (await api(r.owner, "GET", `/v1/workspaces/${r.room}`)).status;
    // A room as it was before step 56: no table, two steps behind (step 57, a person invitation's addressee, runs again safely).
    await inRoom(r.room, (sql) => { sql.exec("DROP TABLE custom_marker"); sql.exec("UPDATE schema_version SET version = version - 10"); });
    expect(await visit()).toBe(200);
    expect(await inRoom(r.room, (sql) => sql.exec("SELECT version FROM schema_version").one().version)).toBe(latest);
    // A row, then the step again: the row is kept whole.
    await markerOn(r);
    await serve(name, { body: body(PREV) });
    await pass(r);
    const row = await markerRow(r, name);
    expect(row).toMatchObject({ served_at: T });
    await inRoom(r.room, (sql) => sql.exec("UPDATE schema_version SET version = version - 10"));
    expect(await visit()).toBe(200);
    expect(await markerRow(r, name)).toEqual(row);
  });
});
