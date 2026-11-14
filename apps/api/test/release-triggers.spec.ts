import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { alarmQuiet } from "./alarm";

// M6 step 6: ADR 0010's unpublish triggers that are the room's own state, each fired in the transaction of the command
// that changes it, and the deployment's own switch, read by the room. Archiving the room, making it private and an
// operator's suspension of its public surface are here; a repository's link no longer ready is in
// `repo-readiness.spec.ts`, where its read-back is. Each unpublishes as Podster's act, through the one function
// decision 218's release switch uses, and none is undone by undoing its cause. After the command commits, the room
// runs its release bookkeeping, since the epoch moved: a release it had queued is ended at once.
//
// Nothing takes a release's request yet, so each room is given its rows through the test pool: an app serving an
// earlier release on its default host, and a release of its own, with everything its recheck asks for holding. Each
// room's provider is switched off, so what is read is the room's own state.

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
async function api(who: Who, method: string, path: string, body?: unknown, opts: { key?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "x-test-public-rooms": "on" };
  if (method !== "GET") headers["idempotency-key"] = opts.key ?? `rt-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());

/** Release switched on for the test Worker while `run` runs. A call inside another leaves it on. */
let releasesOn = 0;
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  if (releasesOn++ === 0) await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { if (--releasesOn === 0) await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

/**
 * The deployment's release setting as written, while `run` runs (test builds only): `null` is unset. Read by core's one
 * rule: exactly `true` is on, exactly `false` is off, and anything else is undecided.
 */
async function withSetting<T>(value: string | null, run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_setting (value TEXT)").run();
  await BINDINGS.DB.prepare("INSERT INTO test_releases_setting (value) VALUES (?)").bind(value).run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_setting").run(); }
}

const REL = `rel_${"7a".repeat(16)}`;
const PREV = `rel_${"6b".repeat(16)}`;
const NEXT = `rel_${"8c".repeat(16)}`;
const SHA = "ef".repeat(20);
const REPO_ID = 987650091;
const TASK = "tsk_rt_1";
let rooms = 0;
/** Every room a test made, so each is left with no alarm run under way and none to come, pass or fail. */
const made: string[] = [];

type Room = { room: string; owner: Who; label: string; host: string; prev: string; script: string };
/**
 * A public room whose app serves an earlier release on its default host, with a release of its own in `state`, queued
 * by default, and everything its recheck asks for holding. With `up: false`, a room with a release configuration and
 * nothing up: nothing served and no release open. With `configured: false`, no release configuration at all.
 */
async function room(org: string, opts: { state?: string; up?: boolean; configured?: boolean } = {}): Promise<Room> {
  const owner: Who = { id: `per_rt_owner_${org}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Triggers" });
  expect(created.status, org).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  await alarmQuiet(stub(id));
  const n = ++rooms;
  const requester: Who = { id: `per_rt_req_${n}`, org };
  const admin: Who = { id: `per_rt_adm_${n}`, org };
  const label = `rt${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  const [script, prev] = [`${label}.${REL}`, `${label}.${PREV}`];
  const handle = `pub_${crypto.randomUUID().replace(/-/g, "")}`;
  const state = opts.state ?? "queued";
  await inRoom(id, (sql) => {
    // A public room has person review on (decision 159), which publishing it again also asks for.
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1, require_person_review = 1", handle);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    if (opts.configured === false) return;
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, owner.id);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/release', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO_ID, owner.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_rt', ?, 'github', ?, 'deploy', ?, 1)", requester.id, REPO_ID, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, owner.id, admin.id);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO_ID, SHA, admin.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    if (opts.up === false) return;
    const release = (rel: string, relState: string, withScript: boolean) => sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, ?, ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, ?, 1)`,
      rel, SHA, relState, label, TASK, withScript ? `${label}.${rel}` : null, withScript ? rel : null, requester.id, owner.id, withScript ? Date.now() : null);
    release(PREV, "served", true);
    release(REL, state, state !== "queued");
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, prev);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, prev);
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, id).run();
  return { room: id, owner, label, host, prev, script };
}

const version = async (r: Room) => (await api(r.owner, "GET", `/v1/workspaces/${r.room}`)).body.policy_version as number;
const serving = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT script_name, release_id FROM serve_state").one());
const UP = (r: Room) => ({ script_name: r.prev, release_id: PREV });
const DOWN = { script_name: null, release_id: null };
const unpublishes = (r: Room) => all(r.room, "SELECT cause, label, release_epoch FROM unpublish ORDER BY seq");
const trail = (r: Room) => inRoom(r.room, (sql) => ({
  events: sql.exec("SELECT type, actor_id, reason FROM event WHERE type = 'app.unpublished' ORDER BY seq").toArray(),
  audit: sql.exec("SELECT actor_id, action, target_id, prior_json, new_json FROM audit_event WHERE action = 'app.unpublished' ORDER BY seq").toArray()
    .map((a: any) => [a.actor_id, a.action, a.target_id, a.prior_json, JSON.parse(a.new_json)]),
}));
const internal = (r: Room, path: string, body: object) => stub(r.room).fetch(`https://do/internal/${path}`, { method: "POST", body: JSON.stringify(body) })
  .then(async (x: Response) => ({ status: x.status, body: (await x.json()) as any }));
const suspendSurface = (r: Room, suspended: boolean) => internal(r, "operator-suspension", { suspended, reason: "abuse" });
/** The reconcile's question, the walk's wake, as `RELEASES` is: off unless the caller switched it on. */
const ask = (r: Room) => internal(r, "takedown-check", { kind: "wake" }).then((x) => x.body);
const releaseCommand = (path: string) => (r: Room, release = REL) => switchedOn(() => internal(r, path, { release_id: release }));
const recheck = releaseCommand("release-recheck");
const commit = releaseCommand("release-commit-live");

/**
 * The room as a trigger with code `reason` leaves it, at the end of the very request that fired it: nothing served,
 * the served release unpublished, the queued one ended under the new epoch by the bookkeeping that request ran, the
 * served script queued, and the unpublish recorded once as Podster's act.
 */
async function expectDown(r: Room, reason: string, what: string) {
  expect(await serving(r), what).toEqual(DOWN);
  expect(await all(r.room, "SELECT id, state, failure_code FROM release WHERE id IN (?, ?) ORDER BY id", PREV, REL), what).toEqual([
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

/**
 * After the cause is undone: nothing comes back, and a new release, asked for under the epoch the trigger moved to, is
 * decided by the whole recheck, not refused for an epoch it started under.
 */
async function expectNothingBack(r: Room, reason: string, what: string) {
  await expectDown(r, reason, what);
  await inRoom(r.room, (sql) => void sql.exec(
    `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, requested_by, requested_at, approved_by, approved_at, updated_at)
       SELECT ?, commit_sha, 'queued', label, config_version, 3, task_id, requested_by, 2, approved_by, 2, 2 FROM release WHERE id = ?`, NEXT, REL));
  expect((await recheck(r, NEXT)).body, what).toEqual({ release_id: NEXT, state: "queued", rechecked: true, reason: null });
  expect(await serving(r), what).toEqual(DOWN);
}

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

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

/**
 * Each trigger that is the room's own state: the command that fires it (with an idempotency key, where the command
 * takes one), the command that undoes its cause, and what the room's own row says of the cause.
 */
type Trigger = {
  name: string;
  reason: string;
  fire: (r: Room, key?: string, policyVersion?: number) => Promise<{ status: number }>;
  undo: (r: Room) => Promise<{ status: number }>;
  cause: (r: Room) => Promise<unknown>;
  keyed: boolean;
};
const TRIGGERS: Trigger[] = [
  {
    name: "the room archived",
    reason: "workspace_archived",
    fire: async (r, key, policyVersion) => api(r.owner, "POST", `/v1/workspaces/${r.room}/archive`, { policy_version: policyVersion ?? await version(r) }, { key }),
    undo: async (r) => api(r.owner, "POST", `/v1/workspaces/${r.room}/unarchive`, { policy_version: await version(r) }),
    cause: (r) => inRoom(r.room, (sql) => sql.exec("SELECT status FROM workspace").one().status),
    keyed: true,
  },
  {
    name: "the room made private",
    reason: "release_needs_public_room",
    fire: (r, key) => api(r.owner, "PUT", `/v1/workspaces/${r.room}/visibility`, { visibility: "private" }, { key }),
    undo: async (r) => {
      const hash = (await api(r.owner, "GET", `/v1/workspaces/${r.room}/visibility`)).body.view_hash;
      return api(r.owner, "PUT", `/v1/workspaces/${r.room}/visibility`, { visibility: "public", view_hash: hash });
    },
    cause: (r) => inRoom(r.room, (sql) => sql.exec("SELECT visibility FROM workspace").one().visibility),
    keyed: true,
  },
  {
    // An operator's suspension takes no idempotency key: asking for what's already so changes nothing, which is its
    // retry.
    name: "the room's public surface suspended by an operator",
    reason: "public_surface_suspended",
    fire: (r) => suspendSurface(r, true),
    undo: (r) => suspendSurface(r, false),
    cause: (r) => inRoom(r.room, (sql) => sql.exec("SELECT suspended_at IS NOT NULL AS suspended FROM workspace").one().suspended),
    keyed: false,
  },
];

describe.each(TRIGGERS)("ADR 0010's unpublish trigger, $name (M6 step 6)", (trigger) => {
  const org = (what: string) => `org_rt_${trigger.reason}_${what}`;

  it("takes the app down in the request that fires it; undoing the cause restores nothing, and a new release gets the whole recheck", async () => {
    const r = await room(org("down"));
    const before = await trigger.cause(r);
    expect((await trigger.fire(r)).status).toBe(200);
    await expectDown(r, trigger.reason, "fired");
    // Fired again: what's already so, refused or a no-op, and nothing more is recorded.
    await trigger.fire(r);
    await expectDown(r, trigger.reason, "fired again");
    expect((await trigger.undo(r)).status).toBe(200);
    expect(await trigger.cause(r)).toEqual(before);
    await expectNothingBack(r, trigger.reason, "undone");
  });

  it("unpublishes once for a retry with the same idempotency key", async () => {
    const r = await room(org("retry"));
    // The same request, key and body, as a client retrying after a lost answer sends it.
    const key = `rt-retry-${crypto.randomUUID()}`;
    const policyVersion = await version(r);
    const first = await trigger.fire(r, trigger.keyed ? key : undefined, policyVersion);
    const again = await trigger.fire(r, trigger.keyed ? key : undefined, policyVersion);
    expect([first.status, again.status]).toEqual([200, 200]);
    if (trigger.keyed) expect(again).toEqual(first);
    await expectDown(r, trigger.reason, "retried");
  });

  it("is never left behind by a command that fails after it: the whole command rolls back, the unpublish with it", async () => {
    const r = await room(org("rollback"));
    const before = await trigger.cause(r);
    await inRoom(r.room, (sql) => void sql.exec("CREATE TABLE test_fail_after_unpublish (x INTEGER)"));
    expect((await trigger.fire(r)).status).toBe(500);
    expect(await trigger.cause(r)).toEqual(before);
    expect(await serving(r)).toEqual(UP(r));
    expect(await unpublishes(r)).toEqual([]);
    expect(await trail(r)).toEqual({ events: [], audit: [] });
    expect((await all(r.room, "SELECT state FROM release WHERE id = ?", REL))[0].state).toBe("queued");
    await inRoom(r.room, (sql) => void sql.exec("DROP TABLE test_fail_after_unpublish"));
    expect((await trigger.fire(r)).status).toBe(200);
    await expectDown(r, trigger.reason, "fired once it could");
  });

  it("ends a commit caught between its reads and its confirm: it never goes live", async () => {
    const r = await room(org("flight"), { state: "uploading" });
    const answer = await heldBetween(r, async () => {
      expect((await trigger.fire(r)).status).toBe(200);
      expect((await unpublishes(r)).length).toBe(1);
    });
    expect(answer.body).toEqual({ release_id: REL, state: "failed", rechecked: false, reason: "release_epoch_moved" });
    expect(await serving(r)).toEqual(DOWN);
    expect((await all(r.room, "SELECT state FROM release WHERE id = ?", REL))[0].state).toBe("failed");
    expect((await all(r.room, "SELECT script_name FROM script_delete ORDER BY script_name")).map((q: any) => q.script_name)).toEqual([r.prev, r.script].sort());
    expect(await all(r.room, "SELECT in_flight_release, kept_previous FROM release_config")).toEqual([{ in_flight_release: null, kept_previous: null }]);
  });

  it("still records the unpublish for a room with a configuration and nothing up, which only raises the epoch", async () => {
    const r = await room(org("nothing"), { up: false });
    expect((await trigger.fire(r)).status).toBe(200);
    expect(await unpublishes(r)).toEqual([{ cause: trigger.reason, label: null, release_epoch: 3 }]);
    expect(await all(r.room, "SELECT * FROM script_delete")).toEqual([]);
    expect(await trail(r)).toEqual({
      events: [{ type: "app.unpublished", actor_id: "podster", reason: trigger.reason }],
      audit: [["podster", "app.unpublished", "app", null, { reason: trigger.reason }]],
    });
  });

  it("records nothing for a room with no release configuration: there is no app to unpublish", async () => {
    const r = await room(org("bare"), { configured: false });
    expect((await trigger.fire(r)).status).toBe(200);
    expect(await all(r.room, "SELECT * FROM release_config")).toEqual([]);
    expect(await unpublishes(r)).toEqual([]);
    expect(await trail(r)).toEqual({ events: [], audit: [] });
  });
});

describe("the record of an unpublish", () => {
  it("records each trigger that fires in turn: the second raises the epoch again, with nothing left to take down", async () => {
    const r = await room("org_rt_two");
    expect((await suspendSurface(r, true)).status).toBe(200);
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.room}/archive`, { policy_version: await version(r) })).status).toBe(200);
    expect(await serving(r)).toEqual(DOWN);
    expect(await unpublishes(r)).toEqual([
      { cause: "public_surface_suspended", label: null, release_epoch: 3 },
      { cause: "workspace_archived", label: null, release_epoch: 4 },
    ]);
    expect((await trail(r)).events.map((e: any) => e.reason)).toEqual(["public_surface_suspended", "workspace_archived"]);
  });

  it("keeps the trigger's own reason, whatever details its caller adds", async () => {
    const r = await room("org_rt_reason");
    // Test builds only: details merged into what the caller passes, a `reason` among them.
    await inRoom(r.room, (sql) => {
      sql.exec("CREATE TABLE test_unpublish_details (details TEXT)");
      sql.exec("INSERT INTO test_unpublish_details (details) VALUES (?)", JSON.stringify({ reason: "something_else", note: "kept" }));
    });
    expect((await suspendSurface(r, true)).status).toBe(200);
    expect((await trail(r)).audit).toEqual([["podster", "app.unpublished", "app", null, { reason: "public_surface_suspended", note: "kept" }]]);
  });
});

describe("the deployment's own setting, `RELEASES`, read by the room (M6 step 6)", () => {
  /** Whether M6's routes are open: switched on, a room route that isn't built yet, the custom hostname's read, answers
   *  `release_not_available`; otherwise it is answered where an unknown path is. */
  const routesOpen = async (r: Room) => (await api(r.owner, "GET", `/v1/workspaces/${r.room}/app-hostname`)).code === "release_not_available";
  const UNDECIDED = [null, "", "True", "TRUE", "1", "true ", " true", "False", "0", "off"];

  it("takes the room's app down at the walk's question only when the setting is exactly `false`, and only once", async () => {
    const r = await room("org_rt_deployment");
    // On, as a deployment that serves apps has it: the question changes nothing, and the routes are open.
    expect(await withSetting("true", async () => [(await ask(r)).known, await routesOpen(r)])).toEqual([true, true]);
    expect(await serving(r)).toEqual(UP(r));
    expect(await unpublishes(r)).toEqual([]);
    // Exactly `false`: the room reads it at the question and unpublishes, ending its queued release in that request.
    expect(await withSetting("false", async () => [(await ask(r)).known, await routesOpen(r)])).toEqual([true, false]);
    await expectDown(r, "release_off_for_deployment", "set to false");
    // Asked again while off: nothing is up, so nothing more is recorded.
    await withSetting("false", () => ask(r));
    await expectDown(r, "release_off_for_deployment", "asked again");
    // Switched back on: nothing comes back, and a new release gets the whole recheck.
    await withSetting("true", () => ask(r));
    await expectNothingBack(r, "release_off_for_deployment", "set to true again");
  });

  it("takes nothing down and releases nothing for any other setting: unset, empty or malformed", async () => {
    const r = await room("org_rt_deployment_undecided");
    for (const value of UNDECIDED) {
      const what = JSON.stringify(value);
      await withSetting(value, async () => {
        expect((await ask(r)).known, what).toBe(true);
        // M6's routes stay shut, exactly as when off.
        expect(await routesOpen(r), what).toBe(false);
      });
      expect(await serving(r), what).toEqual(UP(r));
      expect(await unpublishes(r), what).toEqual([]);
      expect(await trail(r), what).toEqual({ events: [], audit: [] });
    }
    // A release command under an undecided setting is refused, as when off, and takes nothing down either.
    expect((await withSetting("True", () => internal(r, "release-recheck", { release_id: REL }))).body)
      .toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_off_for_deployment" });
    expect(await serving(r)).toEqual(UP(r));
    expect(await unpublishes(r)).toEqual([]);
  });

  // The four ways a deployment's setting can slip without anyone meaning to take every app down, each from a deployment
  // that was serving: none takes anything down, and only a deliberate `false` afterwards does.
  const SLIPS: [string, (string | null)[]][] = [
    ["a typo in the value", ["true", "True"]],
    ["a new environment that omits it", [null]],
    ["a rollback to a version from before it was set", ["true", null]],
    ["a dashboard value removed by the next deploy", ["true", "", null]],
  ];
  SLIPS.forEach(([name, settings], n) => {
    it(`takes nothing down after ${name}; only a deliberate \`false\` does`, async () => {
      const r = await room(`org_rt_slip_${n}`);
      for (const value of settings) await withSetting(value, () => ask(r));
      expect(await serving(r)).toEqual(UP(r));
      expect(await unpublishes(r)).toEqual([]);
      await withSetting("false", () => ask(r));
      await expectDown(r, "release_off_for_deployment", name);
    });
  });

  it("records nothing for a room with no release configuration, or nothing up, when the setting is `false`", async () => {
    for (const opts of [{ configured: false }, { up: false }]) {
      const r = await room(`org_rt_deployment_${opts.configured === false ? "bare" : "nothing"}`, opts);
      await withSetting("false", () => ask(r));
      expect(await unpublishes(r), JSON.stringify(opts)).toEqual([]);
      expect(await trail(r), JSON.stringify(opts)).toEqual({ events: [], audit: [] });
    }
  });
});
