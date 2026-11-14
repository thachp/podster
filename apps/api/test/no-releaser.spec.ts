import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { alarmPass, alarmQuiet, nextAlarm } from "./alarm";

// M6 step 6 (6d and its follow-up): ADR 0010's trigger "nobody who may release now remains", as the architect's interim
// rule (ruling 3, for the owner to review): no person who is the room's owner or one of its admins is in the room and
// still in their organization. An agent never counts. It is read from the room's own rows in the transaction of each
// command that changes who may release. A command that leaves nobody holds the app: its hosts serve nothing, and
// nothing else changes. Recovery naming an owner lifts the hold, and the hosts serve again what they served. Once 7
// days pass with nobody, the room's alarm unpublishes the app for good (the architect's ruling on 6d's first review).
// Only a departure can leave nobody today: the owner alone appoints, demotes and removes admins, and is a releaser.
//
// Each room is given its rows through the test pool, as in `release-triggers.spec.ts`: an app serving an earlier
// release on its default host and a queued release of its own. Its provider is switched off.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; org: string; adminOrgs?: string[] };

async function assertion(who: Who, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 }, ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, opts: { key?: string; target?: Who } = {}) {
  const claims = opts.target ? { target_member: { person: opts.target.id, orgs: { [opts.target.org]: 1 } } } : {};
  return send(who, claims, method, path, body, opts);
}
async function send(who: Who, claims: Record<string, unknown>, method: string, path: string, body?: unknown, opts: { key?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who, claims), "x-test-public-rooms": "on" };
  if (method !== "GET") headers["idempotency-key"] = opts.key ?? `nr-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());

const REL = `rel_${"7a".repeat(16)}`;
/** The test's clock: the room's clock for release commands and its hold, and the time of every departure. */
const T = 1_800_000_000_000;
const PREV = `rel_${"6b".repeat(16)}`;
const SHA = "ef".repeat(20);
const REPO_ID = 987650094;
const TASK = "tsk_nr_1";
let rooms = 0;
const made: string[] = [];

type Room = { room: string; owner: Who; admin: Who; member: Who; host: string; prev: string; script: string };
/**
 * A public room with its owner, one person admin and one member, whose app serves an earlier release on its default
 * host with a queued release of its own. With `up: false`, a room with a release configuration and nothing up; with
 * `configured: false`, no release configuration at all.
 */
async function room(org: string, opts: { up?: boolean; configured?: boolean; state?: string } = {}): Promise<Room> {
  const owner: Who = { id: `per_nr_owner_${org}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "No releaser" });
  expect(created.status, org).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  await alarmQuiet(stub(id));
  const n = ++rooms;
  const member: Who = { id: `per_nr_mem_${n}`, org };
  const admin: Who = { id: `per_nr_adm_${n}`, org };
  const label = `nr${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  const prev = `${label}.${PREV}`;
  const handle = `pub_${crypto.randomUUID().replace(/-/g, "")}`;
  await inRoom(id, (sql) => {
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1, require_person_review = 1, owner_since = 1", handle);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    for (const [who, role] of [[member, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, owner.id);
    if (opts.configured === false) return;
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/release', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO_ID, owner.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_nr', ?, 'github', ?, 'deploy', ?, 1)", member.id, REPO_ID, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, owner.id, admin.id);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO_ID, SHA, admin.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    if (opts.up === false) return;
    const release = (rel: string, state: string, withScript: boolean) => sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, ?, ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, ?, 1)`,
      rel, SHA, state, label, TASK, withScript ? `${label}.${rel}` : null, withScript ? rel : null, member.id, owner.id, withScript ? T : null);
    release(PREV, "served", true);
    release(REL, opts.state ?? "queued", (opts.state ?? "queued") !== "queued");
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, prev);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, prev);
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, id).run();
  return { room: id, owner, admin, member, host, prev, script: `${label}.${REL}` };
}

/** A departure from an organization, as the organization's sweep sends it to every room. */
const depart = (r: Room, who: Who, leftAt = T) => stub(r.room).fetch("https://workspace/internal/org-departure", {
  method: "POST", body: JSON.stringify({ person: who.id, org: who.org, actor: `per_nr_orgadmin_${who.org}`, left_at: leftAt }),
}).then((x: Response) => x.status);
const version = async (r: Room) => (await api(r.owner, "GET", `/v1/workspaces/${r.room}`)).body.policy_version as number;
const serving = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT script_name, release_id FROM serve_state").one());
const UP = (r: Room) => ({ script_name: r.prev, release_id: PREV });
const DOWN = { script_name: null, release_id: null };
const unpublishes = (r: Room) => all(r.room, "SELECT cause, label, release_epoch FROM unpublish ORDER BY seq");
const unpublishAudit = (r: Room) => all(r.room, "SELECT actor_id, new_json FROM audit_event WHERE action = 'app.unpublished' ORDER BY seq")
  .then((rows) => rows.map((a: any) => [a.actor_id, JSON.parse(a.new_json)]));
const unpublishEvents = (r: Room) => all(r.room, "SELECT actor_id, reason FROM event WHERE type = 'app.unpublished' ORDER BY seq");

const WEEK = 7 * 24 * 60 * 60 * 1000;
const hold = (r: Room) => all(r.room, "SELECT cause, held_at, until FROM release_hold WHERE until IS NOT NULL");
const holdTrail = (r: Room) => inRoom(r.room, (sql) => ({
  audit: sql.exec("SELECT actor_id, action, new_json FROM audit_event WHERE action IN ('app.held', 'app.hold_lifted') ORDER BY seq").toArray()
    .map((a: any) => [a.actor_id, a.action, JSON.parse(a.new_json)]),
  events: sql.exec("SELECT type, actor_id, reason FROM event WHERE type IN ('app.held', 'app.hold_lifted') ORDER BY seq").toArray(),
}));
const releases = (r: Room) => all(r.room, "SELECT id, state, failure_code FROM release ORDER BY id");
const AS_SEEDED = [{ id: PREV, state: "served", failure_code: null }, { id: REL, state: "queued", failure_code: null }].sort((a, b) => a.id.localeCompare(b.id));
const hostVersion = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT version FROM serve_state").one().version as number);
/** Whether the applier owes the host a pass, by its own rule: neither applied nor refused at the host's version. */
const applierOwes = (r: Room) => inRoom(r.room, (sql) => sql.exec(
  `SELECT (a.applied_version IS NULL OR a.applied_version != s.version) AND (a.refused_version IS NULL OR a.refused_version != s.version) AS owed
     FROM serve_state s JOIN serve_apply a ON a.host = s.host`).one().owed === 1);

/** Nothing has happened: the app serves, no hold, nothing recorded, and the releases are as seeded. */
async function expectUp(r: Room, what: string) {
  expect(await serving(r), what).toEqual(UP(r));
  expect(await hold(r), what).toEqual([]);
  expect(await unpublishes(r), what).toEqual([]);
  expect(await unpublishAudit(r), what).toEqual([]);
  expect((await holdTrail(r)).audit, what).toEqual([]);
  expect(await releases(r), what).toEqual(AS_SEEDED);
  expect(await hostVersion(r), what).toBe(5);
  expect(await applierOwes(r), what).toBe(false);
}

/**
 * The app held, once, as Podster's act, with the command that held it kept as `cause`: the room still names what it
 * serves, its hosts moved on so the applier takes their entries out, nothing is unpublished, and the releases are as
 * they were.
 */
async function expectHeld(r: Room, cause: string, what: string) {
  const [row] = await hold(r);
  expect(row, what).toMatchObject({ cause: "no_releaser" });
  expect(row.until - row.held_at, what).toBe(WEEK);
  expect(await serving(r), what).toEqual(UP(r));
  // The room's serve state is left as it was; the applier owes the host a pass, which takes its entry out.
  expect(await hostVersion(r), what).toBe(5);
  expect(await applierOwes(r), what).toBe(true);
  expect(await unpublishes(r), what).toEqual([]);
  expect(await releases(r), what).toEqual(AS_SEEDED);
  expect(await holdTrail(r), what).toEqual({
    audit: [["podster", "app.held", { cause, until: row.until, reason: "no_releaser" }]],
    events: [{ type: "app.held", actor_id: "podster", reason: "no_releaser" }],
  });
}

/** The room's clock for release commands and its hold, set by the test (test builds only). */
const clock = (r: Room, now: number) => inRoom(r.room, (sql) => {
  sql.exec("CREATE TABLE IF NOT EXISTS test_release_clock (now INTEGER)");
  sql.exec("DELETE FROM test_release_clock");
  sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", now);
});
/** Release switched on for the test Worker while `run` runs. */
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}
/** Holds a commit of the room's release between its outside reads and its confirm (test builds only), runs `during`. */
async function heldBetween(r: Room, during: () => Promise<unknown>) {
  await clock(r, T);
  await inRoom(r.room, (sql) => {
    sql.exec("CREATE TABLE test_release_hold (arrived INTEGER)");
    sql.exec("INSERT INTO test_release_hold (arrived) VALUES (0)");
  });
  const answer = switchedOn(() => stub(r.room).fetch("https://do/internal/release-commit-live", { method: "POST", body: JSON.stringify({ release_id: REL }) })
    .then(async (x: Response) => ({ status: x.status, body: (await x.json()) as any })));
  try {
    // Polled on the room's own mark that the commit has reached the hold, which is the state itself: no timer.
    await vi.waitFor(async () => expect(await inRoom(r.room, (sql) => sql.exec("SELECT arrived FROM test_release_hold").one().arrived)).toBe(1), { timeout: 10_000, interval: 5 });
    await during();
  } finally {
    await inRoom(r.room, (sql) => void sql.exec("DROP TABLE test_release_hold"));
  }
  return answer;
}

/** The recheck of one of the room's releases, as the release job would ask it. */
const recheck = (r: Room) => switchedOn(() => stub(r.room).fetch("https://do/internal/release-recheck", { method: "POST", body: JSON.stringify({ release_id: REL }) })
  .then(async (x: Response) => ({ status: x.status, body: (await x.json()) as any })));
/** An operator suspends the room's app by its label, or lifts that, as the Moderation object asks the room. */
const operatorSuspends = (r: Room, suspended: boolean) => stub(r.room).fetch("https://do/internal/app-suspension", {
  method: "POST", body: JSON.stringify({ label: r.host.split(".")[0], suspended, reason: "abuse" }),
}).then((x: Response) => x.status);
const suspendedAt = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT suspended_at FROM app_label").one().suspended_at);

/** An admin of the room's organization, outside the room, names a new owner by recovery. */
const recover = (r: Room, to: Who, key = `nr-recover-${++counter}`) => send(
  { id: `per_nr_orgadmin_${r.owner.org}`, org: r.owner.org, adminOrgs: [r.owner.org] },
  { target_member: { person: to.id, orgs: { [to.org]: 1 } } },
  "POST", `/v1/workspaces/${r.room}/owner/recover`, { to: to.id, expected_owner: r.owner.id }, { key },
);

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("ADR 0010's trigger, nobody who may release remains (M6 step 6, the interim rule)", () => {
  it("holds the app at the departure that leaves nobody, and not at one that leaves someone", async () => {
    const r = await room("org_nr_depart");
    // The admin leaves their organization: the owner remains.
    expect(await depart(r, r.admin)).toBe(200);
    expect(await all(r.room, "SELECT revoked_at IS NOT NULL AS gone FROM member WHERE principal_id = ?", r.admin.id)).toEqual([{ gone: 1 }]);
    await expectUp(r, "the admin left");
    // A member leaving changes nothing about who may release.
    expect(await depart(r, r.member)).toBe(200);
    await expectUp(r, "a member left");
    // The owner leaves: nobody remains.
    expect(await depart(r, r.owner)).toBe(200);
    await expectHeld(r, "org_departure", "the owner left");
    // The same departure again, as the sweep may send it, and another for good measure: nothing more.
    expect(await depart(r, r.owner)).toBe(200);
    expect(await depart(r, r.admin)).toBe(200);
    await expectHeld(r, "org_departure", "sent again");
  });

  it("holds it at the last admin's departure once the owner has gone", async () => {
    const r = await room("org_nr_admin_last");
    expect(await depart(r, r.owner)).toBe(200);
    await expectUp(r, "the owner left, the admin remains");
    expect(await depart(r, r.admin)).toBe(200);
    await expectHeld(r, "org_departure", "the admin left");
  });

  it("never counts an agent, whatever role is stored for it, or an admin whose place has ended", async () => {
    const r = await room("org_nr_agent");
    await inRoom(r.room, (sql) => {
      sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES ('agt_nr_admin', 'agent', ?, 'admin', ?, 1)", r.owner.org, r.owner.id);
      sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at, revoked_at, revocation_reason) VALUES ('per_nr_gone', 'person', ?, 'admin', ?, 1, 2, 'room_removed')", r.owner.org, r.owner.id);
    });
    expect(await depart(r, r.admin)).toBe(200);
    await expectUp(r, "the owner remains");
    expect(await depart(r, r.owner)).toBe(200);
    await expectHeld(r, "org_departure", "only an agent stored as admin, and a removed admin, are left");
  });

  it("with nothing up, holds a room with a release configuration and owes no host a pass, and holds nothing in a room without one", async () => {
    const r = await room("org_nr_nothing_up", { up: false });
    expect(await depart(r, r.admin)).toBe(200);
    expect(await depart(r, r.owner)).toBe(200);
    expect(await hold(r)).toEqual([expect.objectContaining({ cause: "no_releaser" })]);
    expect((await holdTrail(r)).audit.map((a: any) => a[1])).toEqual(["app.held"]);
    expect(await unpublishes(r)).toEqual([]);
    expect(await all(r.room, "SELECT release_epoch FROM release_config")).toEqual([{ release_epoch: 2 }]);
    // At the window's end the room unpublishes with nothing up, which raises the epoch and tells the managers.
    const [row] = await hold(r);
    await clock(r, row.until);
    await alarmPass(stub(r.room));
    expect(await unpublishes(r)).toEqual([{ cause: "no_releaser", label: null, release_epoch: 3 }]);
    expect(await unpublishAudit(r)).toEqual([["podster", { cause: "hold_ran_out", reason: "no_releaser" }]]);
    expect(await unpublishEvents(r)).toEqual([{ actor_id: "podster", reason: "no_releaser" }]);

    const bare = await room("org_nr_unconfigured", { configured: false });
    expect(await depart(bare, bare.admin)).toBe(200);
    expect(await depart(bare, bare.owner)).toBe(200);
    expect(await hold(bare)).toEqual([]);
    expect((await holdTrail(bare)).audit).toEqual([]);
  });

  it("leaves a room that already had nobody at deploy as it is", async () => {
    const r = await room("org_nr_deploy");
    // As the room would be had its owner and admin left before this rule existed.
    await inRoom(r.room, (sql) => {
      sql.exec("UPDATE workspace SET owner_left_at = 5");
      sql.exec("UPDATE member SET revoked_at = 5, revocation_reason = 'org_departure' WHERE role = 'admin'");
    });
    expect(await depart(r, r.member)).toBe(200);
    expect(await depart(r, r.owner)).toBe(200);
    await expectUp(r, "nothing changed about who may release");
  });

  it("keeps its causes apart from an earlier trigger's, and from the hold that ran out", async () => {
    const r = await room("org_nr_causes");
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.room}/archive`, { policy_version: await version(r) })).status).toBe(200);
    expect(await depart(r, r.admin)).toBe(200);
    expect(await depart(r, r.owner)).toBe(200);
    const [row] = await hold(r);
    await clock(r, row.until);
    await alarmPass(stub(r.room));
    expect(await unpublishes(r)).toEqual([
      { cause: "workspace_archived", label: null, release_epoch: 3 },
      { cause: "no_releaser", label: null, release_epoch: 4 },
    ]);
    expect(await unpublishAudit(r)).toEqual([
      ["podster", { reason: "workspace_archived" }],
      ["podster", { cause: "hold_ran_out", reason: "no_releaser" }],
    ]);
  });

  it("is lifted by recovery naming an owner within the window: the hosts serve again what they served, and nothing is republished", async () => {
    const r = await room("org_nr_recover");
    expect(await depart(r, r.admin)).toBe(200);
    expect(await depart(r, r.owner)).toBe(200);
    await expectHeld(r, "org_departure", "the owner left");
    const [row] = await hold(r);
    await clock(r, row.until - 1);
    // The alarm a moment before the window ends changes nothing.
    await alarmPass(stub(r.room));
    await expectHeld(r, "org_departure", "a moment before the window ends");
    // As the applier would leave it with a provider: the host refused at its version while held, its entry out.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE serve_apply SET refused_version = 5, last_code = 'app_held'"));
    expect(await applierOwes(r)).toBe(false);
    const recovered = await recover(r, r.member, "nr-recover-once");
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(await all(r.room, "SELECT owner_person_id, owner_left_at FROM workspace")).toEqual([{ owner_person_id: r.member.id, owner_left_at: null }]);
    expect(await hold(r)).toEqual([]);
    // The app was only held: the room serves what it served, which the applier owes a pass to write again, and every
    // release is as it was. Nothing new goes out without the whole recheck.
    expect(await serving(r)).toEqual(UP(r));
    expect(await hostVersion(r)).toBe(5);
    expect(await applierOwes(r)).toBe(true);
    expect(await releases(r)).toEqual(AS_SEEDED);
    expect(await unpublishes(r)).toEqual([]);
    expect((await holdTrail(r)).audit.map((a: any) => [a[1], a[2].cause])).toEqual([["app.held", "org_departure"], ["app.hold_lifted", "owner_recovered"]]);
    expect((await holdTrail(r)).events.map((e: any) => e.type)).toEqual(["app.held", "app.hold_lifted"]);
    // The same recovery retried with its key is answered as before, and lifts nothing twice.
    expect((await recover(r, r.member, "nr-recover-once")).status).toBe(200);
    expect((await holdTrail(r)).audit).toHaveLength(2);
    // And the window's end, which no longer applies, unpublishes nothing.
    await clock(r, row.until);
    await alarmPass(stub(r.room));
    expect(await unpublishes(r)).toEqual([]);
    expect(await serving(r)).toEqual(UP(r));
  });

  it("unpublishes for good at the window's end, by the alarm at exactly that time, and recovery afterwards restores nothing", async () => {
    const r = await room("org_nr_runs_out");
    expect(await depart(r, r.admin)).toBe(200);
    expect(await depart(r, r.owner)).toBe(200);
    const [row] = await hold(r);
    // A pass before the window ends sets the room's next wake at exactly its end. A public room's first
    // discovery-index check is set at random within six hours: it is put past the window, so the wake is the hold's.
    await runInDurableObject(stub(r.room), (_: any, state: any) => state.storage.put("public_index_verify_next", row.until + WEEK));
    await clock(r, row.until - 1);
    await alarmPass(stub(r.room));
    expect(await nextAlarm(stub(r.room))).toBe(row.until);
    await clock(r, row.until);
    await alarmPass(stub(r.room));
    expect(await hold(r)).toEqual([]);
    expect(await unpublishEvents(r)).toEqual([{ actor_id: "podster", reason: "no_releaser" }]);
    expect(await serving(r)).toEqual(DOWN);
    expect(await unpublishes(r)).toEqual([{ cause: "no_releaser", label: null, release_epoch: 3 }]);
    expect(await unpublishAudit(r)).toEqual([["podster", { cause: "hold_ran_out", reason: "no_releaser" }]]);
    expect(await releases(r)).toEqual([
      { id: PREV, state: "unpublished", failure_code: null },
      { id: REL, state: "failed", failure_code: "release_epoch_moved" },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    // Recovery now names an owner, and nothing comes back.
    expect((await recover(r, r.member)).status).toBe(200);
    expect(await serving(r)).toEqual(DOWN);
    expect((await holdTrail(r)).audit.map((a: any) => a[1])).toEqual(["app.held"]);
  });

  it("holds the app when a departure the room held, while its migration failed, is applied", async () => {
    const r = await room("org_nr_held_departure");
    expect(await depart(r, r.admin)).toBe(200);
    // The room can't migrate, as a broken release would leave it: the departure is held, not applied.
    await inRoom(r.room, (sql) => {
      sql.exec("CREATE TABLE fail_migration (x INTEGER)");
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    expect(await depart(r, r.owner)).toBe(200);
    expect(await all(r.room, "SELECT kind FROM held_access ORDER BY seq")).toEqual([{ kind: "org_departure" }]);
    expect(await all(r.room, "SELECT owner_left_at FROM workspace")).toEqual([{ owner_left_at: null }]);
    // Fixed: the next request migrates, applies what was held through the same watched code, and only then answers.
    await inRoom(r.room, (sql) => {
      sql.exec("DROP TABLE fail_migration");
      sql.exec("UPDATE schema_version SET version = version + 1");
    });
    expect((await api(r.member, "GET", `/v1/workspaces/${r.room}`)).status).toBe(200);
    await expectHeld(r, "org_departure", "the held departure applied");
  });

  it("never lets a commit caught between its reads and its confirm go live once the departure that leaves nobody holds the app", async () => {
    const r = await room("org_nr_flight", { state: "uploading" });
    expect(await depart(r, r.admin)).toBe(200);
    const answer = await heldBetween(r, async () => {
      expect(await depart(r, r.owner)).toBe(200);
      expect(await hold(r)).toHaveLength(1);
    });
    expect(answer.body).toMatchObject({ release_id: REL, state: "failed" });
    // The commit's hosts are set back to what was served, which stays the room's, held; its release never went live.
    expect(await serving(r)).toEqual(UP(r));
    expect(await all(r.room, "SELECT state FROM release WHERE id = ?", REL)).toEqual([{ state: "failed" }]);
    expect(await all(r.room, "SELECT in_flight_release FROM release_config")).toEqual([{ in_flight_release: null }]);
  });

  it("has the release recheck refuse while the app is held, whatever the requester's own standing", async () => {
    const r = await room("org_nr_recheck");
    await clock(r, T);
    // Not held: the requester may release, and the queued release passes its recheck.
    expect((await recheck(r)).body).toEqual({ release_id: REL, state: "queued", rechecked: true, reason: null });
    // Held, as no command would leave a room with its owner still in it: the gate is the hold's own.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_hold SET cause = 'no_releaser', held_at = 1, until = ?, generation = generation + 1", T + WEEK));
    expect((await recheck(r)).body).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "no_releaser" });
  });

  it("comes back for a hold whose settle failed, after a wait that doubles, and nothing is half done", async () => {
    const r = await room("org_nr_settle_fails");
    expect(await depart(r, r.admin)).toBe(200);
    expect(await depart(r, r.owner)).toBe(200);
    const [row] = await hold(r);
    await runInDurableObject(stub(r.room), (_: any, state: any) => state.storage.put("public_index_verify_next", row.until + WEEK));
    // The failpoint goes in before the clock reaches the window's end, so no run of the alarm can settle in between.
    await inRoom(r.room, (sql) => void sql.exec("CREATE TABLE test_settle_hold_fails (x INTEGER)"));
    const retry = () => inRoom(r.room, (sql) => sql.exec("SELECT settle_failures, settle_retry_at FROM release_hold").one());
    // Nothing set or running from here, before the clock moves: the pass below is the only one at the window's end.
    await alarmQuiet(stub(r.room));
    await clock(r, row.until);
    await alarmPass(stub(r.room));
    // Rolled back whole: still held and nothing unpublished. The alarm comes back 5 seconds on, not at once.
    expect(await hold(r)).toEqual([row]);
    expect(await unpublishes(r)).toEqual([]);
    expect(await serving(r)).toEqual(UP(r));
    expect(await retry()).toEqual({ settle_failures: 1, settle_retry_at: row.until + 5_000 });
    expect(await nextAlarm(stub(r.room))).toBe(row.until + 5_000);
    // Failing again at that time: the wait doubles.
    await clock(r, row.until + 5_000);
    await alarmPass(stub(r.room));
    expect(await retry()).toEqual({ settle_failures: 2, settle_retry_at: row.until + 15_000 });
    expect(await nextAlarm(stub(r.room))).toBe(row.until + 15_000);
    // Once it works, the hold ends and the app is unpublished once.
    await inRoom(r.room, (sql) => void sql.exec("DROP TABLE test_settle_hold_fails"));
    await clock(r, row.until + 15_000);
    await alarmPass(stub(r.room));
    expect(await hold(r)).toEqual([]);
    expect(await retry()).toEqual({ settle_failures: 0, settle_retry_at: null });
    expect(await unpublishes(r)).toEqual([{ cause: "no_releaser", label: null, release_epoch: 3 }]);
  });

  it("lifts the hold instead of unpublishing when somebody who may release is there at the window's end", async () => {
    const r = await room("org_nr_present_at_end");
    // Held while the owner is still in the room, as no command would leave it: a lift a command missed.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_hold SET cause = 'no_releaser', held_at = 1, until = ?, generation = generation + 1", T + WEEK));
    await clock(r, T + WEEK);
    await alarmPass(stub(r.room));
    expect(await hold(r)).toEqual([]);
    expect(await unpublishes(r)).toEqual([]);
    expect(await serving(r)).toEqual(UP(r));
    expect((await holdTrail(r)).audit).toEqual([["podster", "app.hold_lifted", { cause: "releaser_present_at_end", reason: "no_releaser" }]]);
  });

  it("ends the hold when another cause unpublishes: the window's end unpublishes nothing more, and recovery lifts nothing", async () => {
    const r = await room("org_nr_other_cause");
    expect(await depart(r, r.admin)).toBe(200);
    expect(await depart(r, r.owner)).toBe(200);
    const [row] = await hold(r);
    // The deployment's setting read as exactly `false` by the walk's question: its own unpublish, in its own
    // transaction, ends the hold with it.
    await BINDINGS.DB.prepare("CREATE TABLE test_releases_setting (value TEXT)").run();
    await BINDINGS.DB.prepare("INSERT INTO test_releases_setting (value) VALUES ('false')").run();
    try {
      await stub(r.room).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify({ kind: "wake" }) });
    } finally {
      await BINDINGS.DB.prepare("DROP TABLE test_releases_setting").run();
    }
    expect(await unpublishes(r)).toEqual([{ cause: "release_off_for_deployment", label: null, release_epoch: 3 }]);
    expect(await hold(r)).toEqual([]);
    await clock(r, row.until);
    await alarmPass(stub(r.room));
    expect(await unpublishes(r)).toHaveLength(1);
    expect((await recover(r, r.member)).status).toBe(200);
    expect((await holdTrail(r)).audit.map((a: any) => a[1])).toEqual(["app.held"]);
  });

  describe("with an operator's suspension of the app, which a hold never undoes", () => {
    it("suspended, then held, then lifted: the suspension stands", async () => {
      const r = await room("org_nr_suspended_first");
      expect(await operatorSuspends(r, true)).toBe(200);
      expect(await serving(r)).toEqual(DOWN);
      expect(await depart(r, r.admin)).toBe(200);
      expect(await depart(r, r.owner)).toBe(200);
      expect(await hold(r)).toHaveLength(1);
      expect((await recover(r, r.member)).status).toBe(200);
      expect(await hold(r)).toEqual([]);
      expect(await suspendedAt(r)).not.toBeNull();
      expect(await serving(r)).toEqual(DOWN);
      expect(await unpublishes(r)).toEqual([{ cause: "app_suspended", label: r.host.split(".")[0], release_epoch: 3 }]);
    });

    it("held, then suspended: the suspension's unpublish ends the hold, and neither recovery nor the operator's lift brings anything back", async () => {
      const r = await room("org_nr_held_first");
      expect(await depart(r, r.admin)).toBe(200);
      expect(await depart(r, r.owner)).toBe(200);
      expect(await hold(r)).toHaveLength(1);
      expect(await operatorSuspends(r, true)).toBe(200);
      expect(await hold(r)).toEqual([]);
      expect((await recover(r, r.member)).status).toBe(200);
      expect(await suspendedAt(r)).not.toBeNull();
      expect(await serving(r)).toEqual(DOWN);
      expect((await holdTrail(r)).audit.map((a: any) => a[1])).toEqual(["app.held"]);
      expect(await operatorSuspends(r, false)).toBe(200);
      expect(await hold(r)).toEqual([]);
      expect(await serving(r)).toEqual(DOWN);
    });
  });

  describe("the commands that change who may release, none of which can leave nobody", () => {
    it("removing the only admin leaves the owner", async () => {
      const r = await room("org_nr_remove");
      expect((await api(r.owner, "DELETE", `/v1/workspaces/${r.room}/members/${r.admin.id}`, { policy_version: await version(r) })).status).toBe(200);
      await expectUp(r, "removed");
    });

    it("demoting the only admin leaves the owner", async () => {
      const r = await room("org_nr_demote");
      const changed = await api(r.owner, "POST", `/v1/workspaces/${r.room}/members/${r.admin.id}/role`, { role: "member", policy_version: await version(r) }, { target: r.admin });
      expect(changed.status).toBe(200);
      expect(await all(r.room, "SELECT role FROM member WHERE principal_id = ?", r.admin.id)).toEqual([{ role: "member" }]);
      await expectUp(r, "demoted");
    });

    it("revoking another organization that held an admin leaves the owner", async () => {
      const r = await room("org_nr_revoke_org");
      await inRoom(r.room, (sql) => void sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES ('per_nr_other_admin', 'person', 'org_nr_other', 'admin', ?, 1)", r.owner.id));
      expect((await api(r.owner, "DELETE", `/v1/workspaces/${r.room}/organizations/org_nr_other`, { policy_version: await version(r) })).status).toBe(200);
      await expectUp(r, "organization revoked");
    });

    it("handing the room over is one command, with no moment of nobody, and a same-key retry is answered as before", async () => {
      const r = await room("org_nr_transfer");
      const body = { to: r.admin.id, policy_version: await version(r) };
      const first = await api(r.owner, "POST", `/v1/workspaces/${r.room}/owner/transfer`, body, { key: "nr-transfer", target: r.admin });
      expect(first.status).toBe(200);
      expect(await api(r.owner, "POST", `/v1/workspaces/${r.room}/owner/transfer`, body, { key: "nr-transfer", target: r.admin })).toEqual(first);
      expect(await all(r.room, "SELECT owner_person_id FROM workspace")).toEqual([{ owner_person_id: r.admin.id }]);
      await expectUp(r, "handed over");
      // The former owner, now an admin, leaves: the new owner remains. Then the new owner leaves: nobody does.
      expect(await depart(r, r.owner)).toBe(200);
      await expectUp(r, "the former owner left");
      expect(await depart(r, r.admin)).toBe(200);
      await expectHeld(r, "org_departure", "the new owner left");
    });
  });
});
