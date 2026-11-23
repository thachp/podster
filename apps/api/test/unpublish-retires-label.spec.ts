import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm";

// An unpublish for good retires the room's app label (the architect's ruling of 2026-11-23, on the security review of
// PR #564; ADR 0010, "Unpublishing": a label is never used again). Every trigger that goes through
// `takedown::unpublish_for`, in the transaction that fires it: the label stops being current, its store is owed a
// deletion as `label_retired` (S4 of the store plan), and the room's next request draws a new label. What doesn't
// retire it: an operator's suspension of the app (the ruling of 2026-11-16 keeps its label and store, so a false one is
// recoverable), and a hold (`no-releaser.spec.ts`, and the repository's ceiling, `repo-readiness.spec.ts`).
//
// The triggers fired here are the ones a person's or an operator's command fires; `release_not_delegated`,
// `repo_not_ready` and `no_releaser` are shown in their own specs (`release-switch.spec.ts`, `repo-readiness.spec.ts`
// and `no-releaser.spec.ts`), where what fires them is set up.
//
// Each room's provider is switched off, so the release path's gate is open and what is read is the room's own state.

const BINDINGS = env as any;
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
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "x-test-public-rooms": "on" };
  if (method !== "GET") headers["idempotency-key"] = `ul-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined, text };
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

/** The deployment's release setting as written, while `run` runs (test builds only). */
async function withSetting<T>(value: string, run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_setting (value TEXT)").run();
  await BINDINGS.DB.prepare("INSERT INTO test_releases_setting (value) VALUES (?)").bind(value).run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_setting").run(); }
}

const PREV = `rel_${"6d".repeat(16)}`;
const SHA = "e4".repeat(20);
const REPO_ID = 987650311;
const TASK = "tsk_ul_1";
const T = 1_800_000_000_000;
const STORE_ID = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
let rooms = 0;
/** Every room a test made, quieted after each test. */
const made: string[] = [];

type Room = { room: string; owner: Who; requester: Who; label: string; host: string };
/**
 * A public room whose app serves a release on its default host under its current label, which has a store made, and
 * where a person holding a `deploy` grant may ask for a release of a task's merged commit. Release is on in the room
 * at version 3 and epoch 2.
 */
async function room(): Promise<Room> {
  const n = ++rooms;
  const org = `org_ul_${n}`;
  const owner: Who = { id: `per_ul_owner_${n}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Unpublish retires" });
  expect(created.status).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  await manualAlarms(stub(id));
  const requester: Who = { id: `per_ul_req_${n}`, org };
  const admin: Who = { id: `per_ul_adm_${n}`, org };
  const label = `ul${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${JSON.parse(BINDINGS.TEST_FAKE_CONTENT).domain}`;
  const script = `${label}.${PREV}`;
  await inRoom(id, (sql) => {
    // A public room has person review on (decision 159), which publishing it again also asks for.
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1, require_person_review = 1", `ul-${n}-${crypto.randomUUID().slice(0, 8)}`);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
    sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, owner.id);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/release', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO_ID, owner.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_ul', ?, 'github', ?, 'deploy', ?, 1)", requester.id, REPO_ID, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, requester.id, admin.id);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO_ID, SHA, admin.id);
    sql.exec("INSERT INTO app_label (label, current, created_at, indexed_at) VALUES (?, 1, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, 'served', ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, 1, 1)`,
      PREV, SHA, label, TASK, script, PREV, requester.id, owner.id);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, script);
    sql.exec("INSERT INTO release_script_kind (release_id, script_name, kind, recorded_at) VALUES (?, ?, 'static', 1)", PREV, script);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, script);
    // The label's store, made. The store provider is off, so a deletion owed stays owed and calls nothing.
    sql.exec("CREATE TABLE test_app_store_provider_off (x INTEGER)");
    sql.exec("INSERT INTO app_store (label, kind, store_name, store_id, recorded_at, create_sent_at, made_at, updated_at) VALUES (?, 'd1', ?, ?, 1, 1, 1, 1)",
      label, `podster-store-${"5e".repeat(16)}`, STORE_ID);
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, id).run();
  return { room: id, owner, requester, label, host };
}

const version = async (r: Room) => (await api(r.owner, "GET", `/v1/workspaces/${r.room}`)).body.policy_version as number;
const internal = (r: Room, path: string, body: object) => stub(r.room).fetch(`https://do/internal/${path}`, { method: "POST", body: JSON.stringify(body) })
  .then(async (x: Response) => ({ status: x.status, body: (await x.json()) as any }));
const ask = (r: Room) => switchedOn(() => api(r.requester, "POST", `/v1/workspaces/${r.room}/releases`, { task_id: TASK, commit_sha: SHA }));
const labels = (r: Room) => all(r.room, "SELECT label, current, retired_at IS NOT NULL AS retired FROM app_label ORDER BY created_at, label");
const store = (r: Room) => all(r.room, "SELECT delete_owed_at IS NOT NULL AS owed, delete_cause, gone_at FROM app_store WHERE label = ?", r.label);
const owedTrail = (r: Room) => inRoom(r.room, (sql) => ({
  audit: sql.exec("SELECT actor_id, new_json FROM audit_event WHERE action = 'app_data.delete_owed' ORDER BY seq").toArray().map((a: any) => [a.actor_id, JSON.parse(a.new_json)]),
  events: sql.exec("SELECT actor_id, reason FROM event WHERE type = 'app_data.delete_owed' ORDER BY seq").toArray(),
}));

/** The room's label as an unpublish for good leaves it: retired, no label current, and its store owed a deletion. */
async function expectRetired(r: Room, what: string) {
  expect(await labels(r), what).toEqual([{ label: r.label, current: null, retired: 1 }]);
  expect(await store(r), what).toEqual([{ owed: 1, delete_cause: "label_retired", gone_at: null }]);
  expect(await owedTrail(r), what).toEqual({ audit: [["podster", { cause: "label_retired" }]], events: [{ actor_id: "podster", reason: "label_retired" }] });
}

/** The room's label as it was: current, its store owed nothing. */
async function expectKept(r: Room, what: string) {
  expect(await labels(r), what).toEqual([{ label: r.label, current: 1, retired: 0 }]);
  expect(await store(r), what).toEqual([{ owed: 0, delete_cause: null, gone_at: null }]);
  expect(await owedTrail(r), what).toEqual({ audit: [], events: [] });
}

/** The next request draws a new label, made current, and the retired one is never used again. */
async function expectNewLabel(r: Room, what: string) {
  const answer = await ask(r);
  expect(answer.status, `${what}: ${answer.text}`).toBe(200);
  const [{ label }] = await all(r.room, "SELECT label FROM release WHERE id = ?", answer.body.id);
  expect(label, what).toMatch(/^[a-z2-7]{26}$/);
  expect(label, what).not.toBe(r.label);
  expect(await labels(r), what).toEqual([{ label: r.label, current: null, retired: 1 }, { label, current: 1, retired: 0 }]);
  // The retired label's store stays owed; the new label has none yet.
  expect(await store(r), what).toEqual([{ owed: 1, delete_cause: "label_retired", gone_at: null }]);
  expect(await all(r.room, "SELECT COUNT(*) AS n FROM app_store WHERE label = ?", label), what).toEqual([{ n: 0 }]);
}

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

/** Each trigger a command fires: what fires it, and what undoes its cause so the room may ask again. */
type Trigger = { reason: string; fire: (r: Room) => Promise<{ status: number }>; undo: (r: Room) => Promise<{ status: number }> };
const TRIGGERS: Trigger[] = [
  {
    reason: "workspace_archived",
    fire: async (r) => api(r.owner, "POST", `/v1/workspaces/${r.room}/archive`, { policy_version: await version(r) }),
    undo: async (r) => api(r.owner, "POST", `/v1/workspaces/${r.room}/unarchive`, { policy_version: await version(r) }),
  },
  {
    reason: "release_needs_public_room",
    fire: (r) => api(r.owner, "PUT", `/v1/workspaces/${r.room}/visibility`, { visibility: "private" }),
    undo: async (r) => {
      const hash = (await api(r.owner, "GET", `/v1/workspaces/${r.room}/visibility`)).body.view_hash;
      return api(r.owner, "PUT", `/v1/workspaces/${r.room}/visibility`, { visibility: "public", view_hash: hash });
    },
  },
  {
    reason: "public_surface_suspended",
    fire: (r) => internal(r, "operator-suspension", { suspended: true, reason: "abuse" }),
    undo: (r) => internal(r, "operator-suspension", { suspended: false, reason: "abuse" }),
  },
  {
    reason: "release_off",
    fire: (r) => switchedOn(() => api(r.owner, "PUT", `/v1/workspaces/${r.room}/release-config`, { enabled: false, expected_version: 3 })),
    undo: (r) => switchedOn(() => api(r.owner, "PUT", `/v1/workspaces/${r.room}/release-config`, { enabled: true, expected_version: 4 })),
  },
  {
    reason: "release_off_for_deployment",
    fire: (r) => withSetting("false", () => internal(r, "takedown-check", { kind: "wake" })),
    undo: async () => ({ status: 200 }),
  },
];

describe.each(TRIGGERS)("an unpublish for good, $reason, retires the app's label (2026-11-23)", (trigger) => {
  it("retires the label and owes its store's deletion in the transaction that fires it, and the next request draws a new label", async () => {
    const r = await room();
    await expectKept(r, "before");
    expect((await trigger.fire(r)).status).toBe(200);
    expect(await all(r.room, "SELECT cause FROM unpublish")).toEqual([{ cause: trigger.reason }]);
    await expectRetired(r, "fired");
    expect(await all(r.room, "SELECT label, label_current, script_name FROM serve_state")).toEqual([{ label: null, label_current: null, script_name: null }]);
    // The same fact again: the label was retired once, and its store owed once.
    await trigger.fire(r);
    await expectRetired(r, "fired again");
    expect((await trigger.undo(r)).status).toBe(200);
    await expectRetired(r, "undone");
    await expectNewLabel(r, "asked again");
  });
});

describe("what retires no label", () => {
  it("a command that fails after its unpublish rolls the retirement back with it", async () => {
    const r = await room();
    await inRoom(r.room, (sql) => void sql.exec("CREATE TABLE test_fail_after_unpublish (x INTEGER)"));
    expect((await TRIGGERS[0].fire(r)).status).toBe(500);
    await expectKept(r, "rolled back");
    await inRoom(r.room, (sql) => void sql.exec("DROP TABLE test_fail_after_unpublish"));
    expect((await TRIGGERS[0].fire(r)).status).toBe(200);
    await expectRetired(r, "fired once it could");
  });

  it("an operator's suspension of the app keeps its label and store (the ruling of 2026-11-16), and the archive after it retires them", async () => {
    const r = await room();
    const suspend = await stub(r.room).fetch("https://do/internal/app-suspension", { method: "POST", body: JSON.stringify({ label: r.label, suspended: true, reason: "abuse" }) });
    expect(suspend.status).toBe(200);
    expect(await all(r.room, "SELECT cause FROM unpublish")).toEqual([{ cause: "app_suspended" }]);
    await expectKept(r, "suspended");
    // A later unpublish for good retires the label the suspension is recorded on, and the suspension still holds.
    expect((await TRIGGERS[0].fire(r)).status).toBe(200);
    await expectRetired(r, "archived");
    expect(await all(r.room, "SELECT suspended_at IS NOT NULL AS suspended FROM app_label WHERE label = ?", r.label)).toEqual([{ suspended: 1 }]);
  });

  it("an app an operator suspended, then `RELEASES` set to `false`: nothing is up, but the label is retired for good, and the next request draws a new one", async () => {
    const r = await room();
    const suspension = (suspended: boolean) => stub(r.room).fetch("https://do/internal/app-suspension", { method: "POST", body: JSON.stringify({ label: r.label, suspended, reason: "abuse" }) });
    expect((await suspension(true)).status).toBe(200);
    await expectKept(r, "suspended");
    expect((await withSetting("false", () => internal(r, "takedown-check", { kind: "wake" }))).status).toBe(200);
    // Nothing was up, so nothing more is unpublished; the label is retired and its store owed all the same.
    expect(await all(r.room, "SELECT cause FROM unpublish")).toEqual([{ cause: "app_suspended" }]);
    await expectRetired(r, "switched off");
    // Read `false` again: nothing more.
    await withSetting("false", () => internal(r, "takedown-check", { kind: "wake" }));
    await expectRetired(r, "read again");
    // The suspension lifted and release on again: the next request draws a new label, never the old one.
    expect((await suspension(false)).status).toBe(200);
    await expectNewLabel(r, "lifted and on again");
  });

  it("a room with no release configuration has nothing to unpublish, and its label stays", async () => {
    const r = await room();
    await inRoom(r.room, (sql) => {
      sql.exec("DELETE FROM serve_apply");
      sql.exec("DELETE FROM serve_state");
      sql.exec("DELETE FROM release_script_kind");
      sql.exec("DELETE FROM release");
      sql.exec("DELETE FROM release_config");
    });
    expect((await TRIGGERS[0].fire(r)).status).toBe(200);
    expect(await all(r.room, "SELECT cause FROM unpublish")).toEqual([]);
    await expectKept(r, "nothing to unpublish");
  });
});
