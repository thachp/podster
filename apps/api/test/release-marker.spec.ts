import { env, runInDurableObject, SELF } from "cloudflare:test";
import { createHash } from "node:crypto";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet, clearAlarm, manualAlarms, nextAlarm } from "./alarm";
import { fakeIds } from "./fake-ids";

// M6 step 5, the release job's marker (ADR 0010's "The release job", step 6): once the room commits a release live, its
// alarm waits for the applier to switch the default host, fetches the release's marker through that host, and records
// the release served, or sets it back when the marker never comes. A later release's commit waits for that flight under
// a code of its own, counting no attempt (the driver's ruling 7). And the lease checks #373's review asked for.
//
// **How a test drives it,** as `release-driver.spec.ts` does: the driver runs only in a room that opts in, one pass at a
// time on `/internal/test-release-drive`, with its step run in the pass. **Time** is the release commands' clock,
// `test_release_clock`, so every bound is shown to the millisecond. **The applier** has no provider in these rooms
// (`test_content_provider_off`): a test writes what it would have recorded, `serve_apply`, itself. **The host** is
// `fake-content.ts`'s, by host name: it serves the marker file of the script the upload wrote, or what a test says.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const ORG = "org_rm";
const OWNER: Who = { id: "per_rm_owner", kind: "person", org: ORG, adminOrgs: [ORG] };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "idempotency-key": `rm-key-${++counter}` };
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
/** Release switched on for the test Worker while `run` is out, counted with every other file's. */
let on = 0;
let switching: Promise<unknown> = Promise.resolve();
const inTurn = (step: () => Promise<unknown>) => (switching = switching.then(step, step));
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await inTurn(async () => { if (on++ === 0) await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_releases_on (x INTEGER)").run(); });
  try { return await run(); } finally { await inTurn(async () => { if (--on === 0) await BINDINGS.DB.prepare("DROP TABLE IF EXISTS test_releases_on").run(); }); }
}

// --- GitHub's stand-in, for this file's own repository ---------------------------------------------------------------
const IDS = fakeIds("release-marker");
const REPO = IDS.id(0);
const COMMIT = "c3".repeat(20);
const DIRECTORY = "d4".repeat(20);
const github = (path: string, body?: unknown) => fetch(`https://github-release-fake.example.com${path}?repo=${REPO}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
type GithubState = { calls: { method: string; path: string }[]; minted: any[]; tokens: { revoked: boolean }[] };
const githubState = async () => (await (await github("/state")).json()) as GithubState;
const bytes = (text: string) => new TextEncoder().encode(text);
const blobSha = (content: Uint8Array) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
const sha = (n: number) => n.toString(16).padStart(40, "0");
function repository(files: Record<string, string>) {
  const blobs: Record<string, string> = {};
  const directory: { path: string; mode: string; type: string; sha: string; size?: number }[] = [];
  for (const [path, text] of Object.entries(files)) {
    const content = bytes(text);
    blobs[blobSha(content)] = Buffer.from(content).toString("base64");
    directory.push({ path, mode: "100644", type: "blob", sha: blobSha(content), size: content.length });
  }
  const top = [{ path: "README.md", mode: "100644", type: "blob", sha: sha(1), size: 10 }, { path: "site", mode: "040000", type: "tree", sha: DIRECTORY }];
  return { repo: REPO, trees: { [COMMIT]: { tree: top }, [DIRECTORY]: { tree: directory } }, blobs };
}
const SITE = { "index.html": "<p>marked</p>\n" };

// --- the app's host, at the provider's stand-in ------------------------------------------------------------------------
const content = (path: string, host: string, body?: unknown) =>
  fetch(`https://content-fake.example.com/${path}?host=${host}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
/** What the host serves at the marker's path: the marker file `script`'s upload wrote, or a body of the test's own. */
const serve = (host: string, what: { script?: string; body?: string; status?: number }) => content("marker-serve", host, what);
const fetches = async (host: string) => (await (await content("marker-state", host)).json()) as { fetches: number; credentialed: number; expiredGates: number };
async function hostGate(host: string) {
  const { id } = (await (await content("marker-gate", host, {})).json()) as { id: number };
  const at = (path: string) => fetch(`https://content-fake.example.com/${path}?host=${host}&id=${id}`);
  return { arrived: async () => { await (await at("marker-arrived")).json(); }, release: async () => { await (await at("marker-release")).json(); } };
}
const marker = (release: string) => `{"release_id":"${release}","commit":"${COMMIT}"}\n`;

// --- a room with a release for the driver ------------------------------------------------------------------------------
const REL = `rel_${"8f".repeat(16)}`;
const REL2 = `rel_${"9a".repeat(16)}`;
const PREV = `rel_${"6d".repeat(16)}`;
const TASK = "tsk_rm_1";
const T = 1_900_000_000_000;
const LEASE = 6 * 60 * 1000;
const POLL = 5_000;
const WAIT = 30_000;
const SWITCH_WAIT = 10 * 60 * 1000;
let rooms = 0;
const made: string[] = [];
type Room = { room: string; label: string; host: string; script: string; previous: string; admin: string };

/**
 * A room where everything the recheck asks for holds, whose default host serves `PREV` at version 5, and whose release
 * `REL` is uploading since `T`. The driver is on for it, from the test's own passes only.
 */
async function room(extra: string[] = []): Promise<Room> {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Marker" })).body.id;
  made.push(id);
  await manualAlarms(stub(id));
  const n = ++rooms;
  const requester = `per_rm_req_${n}`;
  const admin = `per_rm_adm_${n}`;
  const label = `${IDS.tag}${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  await inRoom(id, (sql) => {
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who, ORG, role, OWNER.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `rm-${n}-${label}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/marker', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO, OWNER.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_rm', ?, 'github', ?, 'deploy', ?, 1)", requester, REPO, OWNER.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, OWNER.id, admin);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO, COMMIT, admin);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", OWNER.id);
    sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, served_at, updated_at)
      VALUES (?, ?, 'served', ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, 1, 1, 1)`, PREV, COMMIT, label, TASK, `${label}.${PREV}`, PREV, requester, OWNER.id);
    sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
      VALUES (?, ?, 'uploading', ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, ?, ?)`, REL, COMMIT, label, TASK, `${label}.${REL}`, REL, requester, OWNER.id, T, T);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, `${label}.${PREV}`);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, `${label}.${PREV}`);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("CREATE TABLE test_release_upload_provider (x INTEGER)");
    sql.exec("CREATE TABLE test_release_driver (from_alarm INTEGER)");
    sql.exec("INSERT INTO test_release_driver (from_alarm) VALUES (0)");
    sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
    sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
    for (const statement of extra) sql.exec(statement);
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, id).run();
  return { room: id, label, host, script: `${label}.${REL}`, previous: `${label}.${PREV}`, admin };
}
type Pass = { release_id?: string | null; outcome: string; code?: string | null; next_attempt_at?: number | null; state?: string; step?: string; due: number | null };
const pass = (id: string): Promise<Pass> => switchedOn(() => stub(id).fetch("https://do/internal/test-release-drive", { method: "POST", body: "{}" }).then(async (r: Response) => {
  if (r.status !== 200) throw new Error(`a pass answered ${r.status}: ${await r.text()}`);
  return (await r.json()) as Pass;
}));
const at = (id: string, now: number) => inRoom(id, (sql) => void sql.exec("UPDATE test_release_clock SET now = ?", now));
const release = (id: string, which = REL) => inRoom(id, (sql) => sql.exec("SELECT state, failure_code, served_at FROM release WHERE id = ?", which).one());
const job = (id: string, which = REL) => inRoom(id, (sql) => sql.exec("SELECT attempts, next_attempt_at, leased_step, last_code, live_at, switched_at FROM release_job WHERE release_id = ?", which).toArray()[0] ?? null);
const config = (id: string) => inRoom(id, (sql) => sql.exec("SELECT kept_previous, in_flight_release, release_epoch FROM release_config").one());
const defaultHost = (id: string) => inRoom(id, (sql) => sql.exec("SELECT script_name, version, flight_version FROM serve_state WHERE kind = 'default'").one());
const events = (id: string) => inRoom(id, (sql) => sql.exec("SELECT type, subject_id, reason FROM event WHERE type LIKE 'release.%' ORDER BY seq").toArray().map((e: any) => [e.type, e.subject_id, e.reason]));
const queued = (id: string) => inRoom(id, (sql) => sql.exec("SELECT script_name FROM script_delete ORDER BY script_name").toArray().map((row: any) => row.script_name));
/** What the room's applier records once it has written the default host's entry as the room now wants it. */
const switchHost = (id: string) => inRoom(id, (sql) => void sql.exec("UPDATE serve_apply SET applied_version = (SELECT version FROM serve_state WHERE kind = 'default'), applied_script = (SELECT script_name FROM serve_state WHERE kind = 'default'), applied_at = 1"));

const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version as number;
const internal = (id: string, path: string, body: object) => stub(id).fetch(`https://do/internal/${path}`, { method: "POST", body: JSON.stringify(body) }).then((x: Response) => x.status);
const HOLD = 7 * 24 * 3_600_000;
const servedEvents = async (id: string) => (await events(id)).filter(([type]) => type === "release.served");
const unpublished = (id: string) => inRoom(id, (sql) => sql.exec("SELECT cause FROM unpublish ORDER BY seq").toArray().map((row: any) => row.cause));
/** The stop for the whole content domain set while `run` runs, at its home, the Moderation object, and cleared after. */
async function withStop<T>(run: () => Promise<T>): Promise<T> {
  await moderation().fetch("https://do/content-stop");
  await inModeration((s) => void s.exec("INSERT INTO content_stop (singleton, stopped, reason, at, version, updated_at) VALUES (1, 1, 'illegal', 1, 1, 1) ON CONFLICT (singleton) DO UPDATE SET stopped = 1, reason = 'illegal', at = 1, version = version + 1"));
  try { return await run(); } finally { await inModeration((s) => void s.exec("UPDATE content_stop SET stopped = 0, reason = NULL, at = NULL, version = version + 1")); }
}

/** A room whose `REL` the driver has taken through its upload and its commit, at `T`: live, its flight open. */
async function live(extra: string[] = []): Promise<Room> {
  await github("/seed", repository(SITE));
  const r = await room(extra);
  expect((await pass(r.room)).outcome).toBe("next");
  const committed = await pass(r.room);
  expect([committed.outcome, committed.state]).toEqual(["done", "live"]);
  expect((await config(r.room)).in_flight_release).toBe(REL);
  return r;
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});
beforeEach(async () => {
  await github("/reset", {});
  await moderation().fetch("https://do/release-reads", { method: "POST", body: JSON.stringify({ release_id: `rel_${"0".repeat(32)}`, reads: 1, owner_key: "room:ws_schema" }) });
  await inModeration((sql) => { sql.exec("DELETE FROM release_reads"); sql.exec("DELETE FROM release_read_owner"); });
});
afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});

describe("a release recorded served", () => {
  it("is fetched for only once the applier has switched its host, and served when its own marker comes back", async () => {
    const r = await live();
    await serve(r.host, { script: r.script });
    // Before the switch: nothing is fetched, no attempt counted, and the room looks again after the poll.
    const before = await pass(r.room);
    expect([before.release_id, before.outcome, before.code, before.next_attempt_at, before.due]).toEqual([REL, "waiting", "release_awaiting_switch", T + POLL, T + POLL]);
    expect(await job(r.room)).toEqual({ attempts: 2, next_attempt_at: T + POLL, leased_step: null, last_code: "release_awaiting_switch", live_at: T, switched_at: null });
    expect((await fetches(r.host)).fetches).toBe(0);
    // A millisecond early it isn't due.
    await switchHost(r.room);
    await at(r.room, T + POLL - 1);
    expect((await pass(r.room)).outcome).toBe("not_due");
    expect((await fetches(r.host)).fetches).toBe(0);
    // Switched: the marker the upload wrote comes back through the host, with no credential sent, and the release is served.
    await at(r.room, T + POLL);
    const served = await pass(r.room);
    expect([served.release_id, served.step, served.outcome, served.state, served.code]).toEqual([REL, "marker", "served", "served", null]);
    expect(await fetches(r.host)).toEqual({ fetches: 1, credentialed: 0, expiredGates: 0 });
    expect(await release(r.room)).toEqual({ state: "served", failure_code: null, served_at: T + POLL });
    // **The release before is replaced and kept for a rollback; the flight is over; the host still names the release.**
    expect(await release(r.room, PREV)).toMatchObject({ state: "replaced" });
    expect(await config(r.room)).toEqual({ kept_previous: r.previous, in_flight_release: null, release_epoch: 2 });
    expect(await defaultHost(r.room)).toEqual({ script_name: r.script, version: 6, flight_version: null });
    expect(await queued(r.room)).toEqual([]);
    expect((await events(r.room)).slice(-2)).toEqual([["release.served", REL, null], ["release.replaced", PREV, null]]);
    expect(await job(r.room)).toEqual({ attempts: 3, next_attempt_at: null, leased_step: null, last_code: null, live_at: T, switched_at: T + POLL });
    // Nothing is left for the driver.
    const after = await pass(r.room);
    expect([after.outcome, after.due]).toEqual(["not_due", null]);
  });

  it("deletes the script kept before the one it keeps now", async () => {
    // An earlier release's script was kept for a rollback; once this one is served, the release before it is kept instead.
    const older = `rel_${"5c".repeat(16)}`;
    const r = await live();
    const kept = `${r.label}.${older}`;
    await inRoom(r.room, (sql) => sql.exec("UPDATE release_config SET kept_previous = ?", kept));
    await serve(r.host, { script: r.script });
    await switchHost(r.room);
    expect((await pass(r.room)).outcome).toBe("served");
    expect([(await config(r.room)).kept_previous, await queued(r.room)]).toEqual([r.previous, [kept]]);
  });
});

describe("a release whose marker never comes back", () => {
  it("is fetched again while the host serves another release's marker, and set back at the wait's end, to the millisecond", async () => {
    const r = await live();
    // The host still serves the release before: what a cache that hasn't caught up would answer.
    await serve(r.host, { body: marker(PREV) });
    await switchHost(r.room);
    const first = await pass(r.room);
    expect([first.outcome, first.code, first.next_attempt_at, first.state]).toEqual(["retry", "release_awaiting_marker", T + POLL, "live"]);
    expect((await job(r.room)).switched_at).toBe(T);
    // A fetch a millisecond before the end is the last, and it is asked again at the end itself.
    await at(r.room, T + WAIT - 1);
    const last = await pass(r.room);
    expect([last.outcome, last.next_attempt_at]).toEqual(["retry", T + WAIT]);
    expect((await fetches(r.host)).fetches).toBe(2);
    await at(r.room, T + WAIT);
    const back = await pass(r.room);
    expect([back.outcome, back.code]).toEqual(["set_back", "release_marker_missing"]);
    // **Nothing more is fetched; the release failed; its host is back on the release before, at a new version; the
    // flight is over; its script is queued for deletion; and the release before is still the one served.**
    expect((await fetches(r.host)).fetches).toBe(2);
    expect(await release(r.room)).toEqual({ state: "failed", failure_code: "release_marker_missing", served_at: null });
    expect(await defaultHost(r.room)).toEqual({ script_name: r.previous, version: 7, flight_version: null });
    expect(await config(r.room)).toEqual({ kept_previous: null, in_flight_release: null, release_epoch: 2 });
    expect(await queued(r.room)).toEqual([r.script]);
    expect(await release(r.room, PREV)).toMatchObject({ state: "served" });
    expect((await events(r.room)).at(-1)).toEqual(["release.failed", REL, "release_marker_missing"]);
    expect((await pass(r.room)).due).toBeNull();
  });

  it("is not seen in a marker that isn't byte for byte its own, nor in its own under an error's status", async () => {
    const r = await live();
    await switchHost(r.room);
    for (const [n, answer] of [{ body: marker(REL).trimEnd() }, { body: marker(REL), status: 500 }, { body: `${marker(REL)} ` }].entries()) {
      await serve(r.host, answer);
      await inRoom(r.room, (sql) => void sql.exec("UPDATE release_job SET next_attempt_at = NULL"));
      expect((await pass(r.room)).outcome, `answer ${n}`).toBe("retry");
    }
    // The control: its own marker, as the job wrote it.
    await serve(r.host, { body: marker(REL) });
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_job SET next_attempt_at = NULL"));
    expect((await pass(r.room)).outcome).toBe("served");
  });

  it("is set back when the applier never switches its host, at the switch's bound from going live, fetching nothing", async () => {
    const r = await live();
    await serve(r.host, { script: r.script });
    await at(r.room, T + SWITCH_WAIT - 1);
    const waiting = await pass(r.room);
    expect([waiting.outcome, waiting.code, waiting.next_attempt_at]).toEqual(["waiting", "release_awaiting_switch", T + SWITCH_WAIT]);
    await at(r.room, T + SWITCH_WAIT);
    const back = await pass(r.room);
    expect([back.outcome, back.code]).toEqual(["set_back", "release_not_switched"]);
    expect(await release(r.room)).toEqual({ state: "failed", failure_code: "release_not_switched", served_at: null });
    expect(await defaultHost(r.room)).toEqual({ script_name: r.previous, version: 7, flight_version: null });
    expect((await fetches(r.host)).fetches).toBe(0);
  });
});

describe("a fetch the room moved under", () => {
  for (const [what, statement] of [
    ["the release epoch", "UPDATE release_config SET release_epoch = release_epoch + 1"],
    ["the hold's generation", "UPDATE release_hold SET generation = generation + 1"],
  ] as const) {
    it(`records nothing when ${what} moved while the marker was out, and looks at the release afresh`, async () => {
      const r = await live();
      await serve(r.host, { script: r.script });
      await switchHost(r.room);
      const gate = await hostGate(r.host);
      const running = pass(r.room);
      try {
        await gate.arrived();
        await inRoom(r.room, (sql) => void sql.exec(statement));
      } finally {
        await gate.release();
      }
      const moved = await running;
      expect([moved.outcome, moved.code]).toEqual(["moved", "release_driver_moved"]);
      // The marker came back as the release's own, and still nothing was recorded of it.
      expect(await release(r.room)).toEqual({ state: "live", failure_code: null, served_at: null });
      expect((await config(r.room)).in_flight_release).toBe(REL);
      expect(await job(r.room)).toMatchObject({ next_attempt_at: T, leased_step: null, last_code: "release_driver_moved" });
      expect((await fetches(r.host)).expiredGates).toBe(0);
    });
  }
});

describe("a later release's commit behind another's flight (the driver's ruling 7)", () => {
  it("waits under its own code, counting no attempt however often it is asked, and commits once the flight is served", async () => {
    // A second release, uploaded and at its commit, with seven of its eight attempts already spent.
    const r = await live();
    await inRoom(r.room, (sql) => {
      sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
        SELECT ?, commit_sha, 'uploading', label, 3, 2, task_id, ?, ?, requested_by, 2, approved_by, 2, ?, ? FROM release WHERE id = ?`, REL2, `${r.label}.${REL2}`, REL2, T, T, REL);
      sql.exec("INSERT INTO release_upload (release_id, script_name, files, bytes, uploaded_at) VALUES (?, ?, 2, 100, ?)", REL2, `${r.label}.${REL2}`, T);
      sql.exec("INSERT INTO release_job (release_id, attempts, updated_at) VALUES (?, 7, ?)", REL2, T);
    });
    // The first pass is the flight's: it waits for the switch.
    expect([(await pass(r.room)).release_id, (await job(r.room)).last_code]).toEqual([REL, "release_awaiting_switch"]);
    // Then the second release's commit waits for the flight, and its attempts stay where they were.
    const waiting = await pass(r.room);
    expect([waiting.release_id, waiting.outcome, waiting.code, waiting.next_attempt_at]).toEqual([REL2, "waiting", "release_in_flight", T + 30_000]);
    for (let n = 0; n < 9; n += 1) {
      await inRoom(r.room, (sql) => void sql.exec("UPDATE release_job SET next_attempt_at = NULL WHERE release_id = ?", REL2));
      expect((await pass(r.room)).code, `pass ${n}`).toBe("release_in_flight");
    }
    expect(await job(r.room, REL2)).toMatchObject({ attempts: 7, leased_step: null, last_code: "release_in_flight" });
    expect([(await release(r.room, REL2)).state, (await defaultHost(r.room)).script_name]).toEqual(["uploading", r.script]);
    // The flight is served: its end wakes the second release at once.
    await serve(r.host, { script: r.script });
    await switchHost(r.room);
    await at(r.room, T + POLL);
    expect((await pass(r.room)).outcome).toBe("served");
    expect((await job(r.room, REL2)).next_attempt_at).toBe(T + POLL);
    // Its commit goes on, as its eighth attempt.
    const committed = await pass(r.room);
    expect([committed.release_id, committed.outcome, committed.state]).toEqual([REL2, "done", "live"]);
    expect([(await job(r.room, REL2)).attempts, (await config(r.room)).in_flight_release]).toEqual([8, REL2]);
  });
});

describe("a step's lease, at the points #373's review named", () => {
  const at373 = (point: string, statement: string) => [
    "CREATE TABLE test_release_at (point TEXT, statement TEXT)",
    `INSERT INTO test_release_at (point, statement) VALUES ('${point}', '${statement}')`,
  ];
  const leaseRunsOut = `UPDATE test_release_clock SET now = ${T + LEASE}`;
  const reserved = () => inModeration((sql) => sql.exec("SELECT release_id, reads FROM release_reads").toArray());

  it("asks GitHub for no token once the lease ran out while the tree reads were reserved", async () => {
    await github("/seed", repository(SITE));
    const r = await room(at373("reserved", leaseRunsOut));
    const out = await pass(r.room);
    expect([out.outcome, out.code, out.state]).toEqual(["retry", "release_drive_lease_lost", "uploading"]);
    expect([(await githubState()).minted, await reserved()]).toEqual([[], [{ release_id: REL, reads: 2 }]]);
  });

  it("reads no tree once the lease ran out while the token was minted, and revokes the token", async () => {
    await github("/seed", repository(SITE));
    const r = await room(at373("opened", leaseRunsOut));
    const out = await pass(r.room);
    expect([out.outcome, out.code]).toEqual(["retry", "release_drive_lease_lost"]);
    const seen = await githubState();
    expect([seen.minted.length, seen.tokens.map((token) => token.revoked)]).toEqual([1, [true]]);
    expect(seen.calls.filter((call) => call.path.includes("/git/trees"))).toEqual([]);
  });

  it("makes no outside read for a commit once the lease ran out after its stage", async () => {
    const r = await room([...at373("staged", leaseRunsOut), "CREATE TABLE test_release_reads_seen (release_id TEXT)"]);
    await inRoom(r.room, (sql) => void sql.exec("INSERT INTO release_upload (release_id, script_name, files, bytes, uploaded_at) VALUES (?, ?, 2, 100, ?)", REL, r.script, T));
    const out = await pass(r.room);
    expect([out.outcome, out.code, out.state]).toEqual(["retry", "release_drive_lease_lost", "uploading"]);
    expect(await inRoom(r.room, (sql) => sql.exec("SELECT COUNT(*) AS n FROM test_release_reads_seen").one().n)).toBe(0);
    // Staged and never confirmed: the flight is its own, and nothing is served on it.
    expect((await config(r.room)).in_flight_release).toBe(REL);
  });

  it("is the control: a commit whose lease holds makes its outside reads and goes live", async () => {
    const r = await room(["CREATE TABLE test_release_reads_seen (release_id TEXT)"]);
    await inRoom(r.room, (sql) => void sql.exec("INSERT INTO release_upload (release_id, script_name, files, bytes, uploaded_at) VALUES (?, ?, 2, 100, ?)", REL, r.script, T));
    const out = await pass(r.room);
    expect([out.outcome, out.state]).toEqual(["done", "live"]);
    expect(await inRoom(r.room, (sql) => sql.exec("SELECT COUNT(*) AS n FROM test_release_reads_seen").one().n)).toBe(1);
  });
});

describe("a stop during the marker's wait (the architect's ruling on question 9, 2026-11-14)", () => {
  /**
   * A live release, switched, whose first fetch found the release before's marker: it waits to fetch again at
   * `T + POLL`. From here the host serves the release's own marker, so only the stop keeps it from being served.
   */
  async function waiting() {
    const r = await live();
    await serve(r.host, { body: marker(PREV) });
    await switchHost(r.room);
    expect((await pass(r.room)).outcome).toBe("retry");
    await serve(r.host, { script: r.script });
    await at(r.room, T + POLL);
    return r;
  }

  const stops: [string, string, (r: Room) => Promise<unknown>][] = [
    // A real departure, the admin's and then the owner's, leaves nobody who may release: the room holds the app by the
    // release commands' clock, so the hold runs a week from `T + POLL`, and resets the applier's record itself.
    ["a hold because nobody may release", "no_releaser", async (r) => {
      for (const who of [r.admin, OWNER.id]) expect(await internal(r.room, "org-departure", { person: who, org: ORG, actor: "per_rm_orgadmin", left_at: T })).toBe(200);
      expect(await inRoom(r.room, (sql) => sql.exec("SELECT held_at, until FROM release_hold").one())).toEqual({ held_at: T + POLL, until: T + POLL + HOLD });
    }],
    ["the stop for the whole content domain", "release_stopped", async () => {}],
  ];
  for (const [what, code, fire] of stops) {
    it(`ends the release with ${what}'s own cause, ${code}, fetching nothing more and serving nothing`, async () => {
      const r = await waiting();
      await fire(r);
      const back = code === "release_stopped" ? await withStop(() => pass(r.room)) : await pass(r.room);
      expect([back.release_id, back.outcome, back.code]).toEqual([REL, "set_back", code]);
      expect((await fetches(r.host)).fetches).toBe(1);
      expect(await release(r.room)).toEqual({ state: "failed", failure_code: code, served_at: null });
      expect(await servedEvents(r.room)).toEqual([]);
      expect((await events(r.room)).at(-1)).toEqual(["release.failed", REL, code]);
      expect(await config(r.room)).toMatchObject({ in_flight_release: null, kept_previous: null });
      expect(await defaultHost(r.room)).toMatchObject({ script_name: r.previous, flight_version: null });
      expect(await queued(r.room)).toEqual([r.script]);
      expect((await pass(r.room)).due).toBeNull();
    });
  }

  it("leases no fetch once a hold has started, even on applier rows the hold would have reset", async () => {
    // The default host's entry is recorded as switched, and the hold is written alone, leaving that record standing:
    // a fetch now could read an entry the hold is about to take down, and would record a held app's release served.
    const r = await live();
    await serve(r.host, { script: r.script });
    await switchHost(r.room);
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_hold SET cause = 'no_releaser', held_at = ?, until = ?, generation = generation + 1", T, T + HOLD));
    const back = await pass(r.room);
    expect([back.outcome, back.code]).toEqual(["set_back", "no_releaser"]);
    expect((await fetches(r.host)).fetches).toBe(0);
    expect(await release(r.room)).toEqual({ state: "failed", failure_code: "no_releaser", served_at: null });
    expect(await servedEvents(r.room)).toEqual([]);
  });

  const unpublishes: [string, string, (r: Room) => Promise<unknown>][] = [
    ["the room archived", "workspace_archived", async (r) => expect((await api(OWNER, "POST", `/v1/workspaces/${r.room}/archive`, { policy_version: await version(r.room) })).status).toBe(200)],
    ["the room made private", "release_needs_public_room", async (r) => expect((await api(OWNER, "PUT", `/v1/workspaces/${r.room}/visibility`, { visibility: "private" })).status).toBe(200)],
    ["an operator's suspension of the app", "app_suspended", async (r) => expect(await internal(r.room, "app-suspension", { label: r.label, suspended: true, reason: "abuse" })).toBe(200)],
  ];
  for (const [what, cause, fire] of unpublishes) {
    it(`ends the flight unpublished under its own cause when ${what}, fetching nothing more and serving nothing`, async () => {
      const r = await waiting();
      await fire(r);
      const after = await pass(r.room);
      expect([after.outcome, after.due]).toEqual(["not_due", null]);
      expect((await fetches(r.host)).fetches).toBe(1);
      expect(await release(r.room)).toEqual({ state: "unpublished", failure_code: null, served_at: null });
      expect(await unpublished(r.room)).toEqual([cause]);
      expect(await servedEvents(r.room)).toEqual([]);
      expect(await config(r.room)).toMatchObject({ in_flight_release: null, kept_previous: null });
      expect(await defaultHost(r.room)).toMatchObject({ script_name: null, flight_version: null });
    });
  }

  it("records nothing served for a marker that comes back after its release was set back, and its answer shows the set-back", async () => {
    // The fetch is held at the host past its own lease and the marker's wait: a later pass sets the release back.
    const r = await live();
    await serve(r.host, { script: r.script });
    await switchHost(r.room);
    const gate = await hostGate(r.host);
    const running = pass(r.room);
    try {
      await gate.arrived();
      await at(r.room, T + WAIT);
      const back = await pass(r.room);
      expect([back.outcome, back.code]).toEqual(["set_back", "release_marker_missing"]);
    } finally {
      await gate.release();
    }
    // The late fetch saw the release's own marker, and keeps nothing of it: the set-back stands, and its answer says so.
    const late = await running;
    expect(late).toMatchObject({ release_id: REL, outcome: "stale", set_back: true, code: "release_marker_missing", seen: true, state: "failed" });
    expect(await release(r.room)).toEqual({ state: "failed", failure_code: "release_marker_missing", served_at: null });
    expect(await servedEvents(r.room)).toEqual([]);
    expect((await events(r.room)).at(-1)).toEqual(["release.failed", REL, "release_marker_missing"]);
    expect(await defaultHost(r.room)).toMatchObject({ script_name: r.previous, flight_version: null });
    expect((await fetches(r.host)).expiredGates).toBe(0);
  });
});

describe("the room's stored alarm for the marker", () => {
  /** One run of the room's own alarm, the driver on from it, release allowed; then the alarm it set. */
  async function armedBy(id: string) {
    await inRoom(id, (sql) => void sql.exec("UPDATE test_release_driver SET from_alarm = 1"));
    try {
      const before = Date.now();
      await switchedOn(() => alarmPass(stub(id)));
      const armed = await nextAlarm(stub(id));
      return { before, after: Date.now(), armed };
    } finally {
      await inRoom(id, (sql) => void sql.exec("UPDATE test_release_driver SET from_alarm = 0"));
      await runInDurableObject(stub(id), (_: any, state: any) => clearAlarm(state));
    }
  }

  it("is set for the switch's next look while the flight waits for its switch", async () => {
    const r = await live();
    const { before, after, armed } = await armedBy(r.room);
    expect(await job(r.room)).toMatchObject({ next_attempt_at: T + POLL, last_code: "release_awaiting_switch" });
    expect(armed).not.toBeNull();
    expect(armed!).toBeGreaterThanOrEqual(before + POLL);
    expect(armed!).toBeLessThanOrEqual(after + POLL);
  });

  it("is set for the in-flight recheck while a later release's commit waits for the flight", async () => {
    const r = await live();
    await inRoom(r.room, (sql) => {
      sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
        SELECT ?, commit_sha, 'uploading', label, 3, 2, task_id, ?, ?, requested_by, 2, approved_by, 2, ?, ? FROM release WHERE id = ?`, REL2, `${r.label}.${REL2}`, REL2, T, T, REL);
      sql.exec("INSERT INTO release_upload (release_id, script_name, files, bytes, uploaded_at) VALUES (?, ?, 2, 100, ?)", REL2, `${r.label}.${REL2}`, T);
      // The flight's own next look is far off, so only the waiting commit's recheck can set this alarm.
      sql.exec("UPDATE release_job SET next_attempt_at = ? WHERE release_id = ?", T + SWITCH_WAIT - 1, REL);
    });
    const { before, after, armed } = await armedBy(r.room);
    expect(await job(r.room, REL2)).toMatchObject({ next_attempt_at: T + 30_000, last_code: "release_in_flight" });
    expect(armed).not.toBeNull();
    expect(armed!).toBeGreaterThanOrEqual(before + 30_000);
    expect(armed!).toBeLessThanOrEqual(after + 30_000);
  });
});

describe("room schema step 45, on a room with jobs on record", () => {
  it("keeps every job's row whole as it rebuilds release_job, and then admits the marker's step", async () => {
    const r = await room();
    const COLUMNS = "release_id, attempts, next_attempt_at, leased_step, leased_epoch, leased_hold, last_code, updated_at, stalls";
    const newest = await inRoom(r.room, (sql) => {
      // The room as step 44 left it: step 43's release_job, with step 44's stalls.
      sql.exec("DROP TABLE release_job");
      sql.exec(`CREATE TABLE release_job (release_id TEXT PRIMARY KEY REFERENCES release (id),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
        next_attempt_at INTEGER CHECK (next_attempt_at IS NULL OR typeof(next_attempt_at) = 'integer'),
        leased_step TEXT CHECK (leased_step IS NULL OR leased_step IN ('start', 'upload', 'commit')),
        leased_epoch INTEGER CHECK (leased_epoch IS NULL OR typeof(leased_epoch) = 'integer'),
        leased_hold INTEGER CHECK (leased_hold IS NULL OR typeof(leased_hold) = 'integer'),
        last_code TEXT CHECK (last_code IS NULL OR length(last_code) BETWEEN 1 AND 64), updated_at INTEGER NOT NULL,
        CHECK ((leased_step IS NULL) = (leased_epoch IS NULL)), CHECK ((leased_step IS NULL) = (leased_hold IS NULL))) WITHOUT ROWID`);
      sql.exec("ALTER TABLE release_job ADD COLUMN stalls INTEGER NOT NULL DEFAULT 0 CHECK (typeof(stalls) = 'integer' AND stalls >= 0)");
      // One job with every field set, leased for its commit; one with every optional field empty.
      sql.exec(`INSERT INTO release_job (${COLUMNS}) VALUES (?, 7, ?, 'commit', 4, 9, 'release_driver_moved', ?, 2)`, REL, T + 1, T);
      sql.exec("INSERT INTO release_job (release_id, updated_at) VALUES (?, ?)", PREV, T - 1);
      const newest = sql.exec("SELECT version FROM schema_version").one().version as number;
      // Before step 46 too, which only adds `release_uncertain`, and step 47, which only adds `hostname_provider`, so all
      // three run.
      sql.exec("DROP TABLE hostname_provider");
      sql.exec("DROP TABLE release_uncertain");
      sql.exec("UPDATE schema_version SET version = version - 3");
      return newest;
    });
    const before = await inRoom(r.room, (sql) => sql.exec(`SELECT ${COLUMNS} FROM release_job ORDER BY release_id`).toArray());
    expect(before).toEqual([
      { release_id: PREV, attempts: 0, next_attempt_at: null, leased_step: null, leased_epoch: null, leased_hold: null, last_code: null, updated_at: T - 1, stalls: 0 },
      { release_id: REL, attempts: 7, next_attempt_at: T + 1, leased_step: "commit", leased_epoch: 4, leased_hold: 9, last_code: "release_driver_moved", updated_at: T, stalls: 2 },
    ].sort((a, b) => a.release_id.localeCompare(b.release_id)));
    // A request migrates the room.
    expect((await api(OWNER, "GET", `/v1/workspaces/${r.room}`)).status).toBe(200);
    const after = await inRoom(r.room, (sql) => ({
      version: sql.exec("SELECT version FROM schema_version").one().version,
      rows: sql.exec(`SELECT ${COLUMNS} FROM release_job ORDER BY release_id`).toArray(),
      times: sql.exec("SELECT live_at, switched_at FROM release_job ORDER BY release_id").toArray(),
      leftover: sql.exec("SELECT name FROM sqlite_master WHERE name = 'release_job_next'").toArray(),
      uncertain: sql.exec("SELECT count(*) AS n FROM release_uncertain").one().n,
      foreignKeys: sql.exec("PRAGMA foreign_key_check").toArray(),
    }));
    expect(after).toEqual({
      version: newest,
      rows: before,
      times: [{ live_at: null, switched_at: null }, { live_at: null, switched_at: null }],
      leftover: [],
      uncertain: 0,
      foreignKeys: [],
    });
    // The marker's step is admitted now, as step 43's check never did.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_job SET leased_step = 'marker' WHERE release_id = ?", REL));
    expect((await job(r.room)).leased_step).toBe("marker");
  });
});
