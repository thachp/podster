import { env, runInDurableObject, SELF } from "cloudflare:test";
import { createHash } from "node:crypto";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet, nextAlarm } from "./alarm";
import { fakeIds } from "./fake-ids";

// M6 step 5, a release whose upload's answer was lost (`docs/m6-plan.md`, "`uncertain` settling"): the script's write
// answered nothing that says whether it went through, so the release is `uncertain` until the provider's own read of
// the script settles it, by bounds of its own, and nothing else in the room goes live meanwhile.
//
// **How a test drives it,** as `release-driver.spec.ts` does: the driver runs only in a room that has
// `test_release_driver`, and each test asks for one pass at a time on `/internal/test-release-drive`. **Time** is the
// release commands' clock, `test_release_clock`, so every wait is shown to the millisecond and nothing waits on the
// Worker's clock. GitHub is `fake-github-release.ts` under this file's own repository; the provider is
// `fake-content.ts`'s upload part, by script, whose `read` answers the settling read with faults and gates of its own.
// The rooms' appliers and delete jobs have no provider (`test_content_provider_off`).

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const ORG = "org_un";
const OWNER: Who = { id: "per_un_owner", kind: "person", org: ORG, adminOrgs: [ORG] };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "idempotency-key": `un-key-${++counter}` };
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
/** Release switched on for the test Worker while `run` is out. */
let on = 0;
let switching: Promise<unknown> = Promise.resolve();
const inTurn = (step: () => Promise<unknown>) => (switching = switching.then(step, step));
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await inTurn(async () => { if (on++ === 0) await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_releases_on (x INTEGER)").run(); });
  try { return await run(); } finally { await inTurn(async () => { if (--on === 0) await BINDINGS.DB.prepare("DROP TABLE IF EXISTS test_releases_on").run(); }); }
}

// --- GitHub's stand-in, for this file's own repository ---------------------------------------------------------------
const IDS = fakeIds("release-uncertain");
const REPO = IDS.id(0);
const COMMIT = "c5".repeat(20);
const DIRECTORY = "d6".repeat(20);
const github = (path: string, body?: unknown) => fetch(`https://github-release-fake.example.com${path}?repo=${REPO}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
type GithubState = { calls: { method: string; path: string }[]; tokens: { revoked: boolean }[] };
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
const SITE = { "index.html": "<p>settled</p>\n", "app.js": "export const three = 3;\n" };
const MARKER_BYTES = (release: string) => `{"release_id":"${release}","commit":"${COMMIT}"}\n`.length;

// --- the provider's stand-in, by script --------------------------------------------------------------------------------
type Provider = { calls: { op: string; status: number }[]; written: { times: number } | null; expiredGates: number };
const provider = async (script: string) => (await (await fetch(`https://content-fake.example.com/upload-state?script=${script}`)).json()) as Provider;
const providerFault = (script: string, fault: object) => fetch(`https://content-fake.example.com/upload-fault?script=${script}`, { method: "POST", body: JSON.stringify({ times: 1, ...fault }) });
async function providerGate(script: string, op: "session" | "script" | "read") {
  const at = (path: string, id?: number) => `https://content-fake.example.com/${path}?script=${script}${id === undefined ? "" : `&id=${id}`}`;
  const { id } = (await (await fetch(at("upload-gate"), { method: "POST", body: JSON.stringify({ op }) })).json()) as { id: number };
  return {
    arrived: async () => { await (await fetch(at("upload-arrived", id))).json(); },
    release: async () => { await (await fetch(at("upload-release", id))).json(); },
  };
}
const ops = (seen: Provider) => seen.calls.map((call) => `${call.op} ${call.status}`);
const reads = (seen: Provider) => seen.calls.filter((call) => call.op === "read").length;

// --- a room with a release uploading -------------------------------------------------------------------------------------
const REL = `rel_${"5e".repeat(16)}`;
const REL2 = `rel_${"4b".repeat(16)}`;
const PREV = `rel_${"6d".repeat(16)}`;
const TASK = "tsk_un_1";
/** The release commands' clock in every room here, unless a test moves it. */
const T = 1_900_000_000_000;
const DEADLINE = 10 * 60 * 1000;
let rooms = 0;
const made: string[] = [];
type Room = { room: string; label: string; host: string; script: string; admin: string };
/**
 * A room where everything the recheck asks for holds, whose default host serves an earlier release, and whose release
 * `REL` is uploading since `T`. The driver is on for it, from the test's own passes only.
 */
async function room(extra: string[] = []): Promise<Room> {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Uncertain" })).body.id;
  made.push(id);
  await alarmQuiet(stub(id));
  const n = ++rooms;
  const requester = `per_un_req_${n}`;
  const admin = `per_un_adm_${n}`;
  const label = `${IDS.tag}${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.apps-test.example`;
  await inRoom(id, (sql) => {
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who, ORG, role, OWNER.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `un-${n}-${label}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/uncertain', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO, OWNER.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_un', ?, 'github', ?, 'deploy', ?, 1)", requester, REPO, OWNER.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, OWNER.id, admin);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO, COMMIT, admin);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", OWNER.id);
    sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
      VALUES (?, ?, 'served', ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, 1, 1)`, PREV, COMMIT, label, TASK, `${label}.${PREV}`, PREV, requester, OWNER.id);
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
  return { room: id, label, host, script: `${label}.${REL}`, admin };
}
type Pass = { release_id?: string | null; outcome: string; code?: string | null; next_attempt_at?: number | null; state?: string; due: number | null };
const pass = (id: string): Promise<Pass> => switchedOn(() => stub(id).fetch("https://do/internal/test-release-drive", { method: "POST", body: "{}" }).then(async (r: Response) => {
  if (r.status !== 200) throw new Error(`a pass answered ${r.status}: ${await r.text()}`);
  return (await r.json()) as Pass;
}));
const command = (path: string) => (id: string, release = REL) =>
  switchedOn(() => stub(id).fetch(`https://do/internal/${path}`, { method: "POST", body: JSON.stringify({ release_id: release }) }).then(async (r: Response) => ({ status: r.status, body: (await r.json()) as any })));
const upload = command("release-upload");
const commit = command("release-commit-live");
const check = (id: string, body: object) => stub(id).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify(body) }).then((r: Response) => r.json() as Promise<any>);
const at = (id: string, now: number) => inRoom(id, (sql) => void sql.exec("UPDATE test_release_clock SET now = ?", now));
const release = (id: string, which = REL) => inRoom(id, (sql) => sql.exec("SELECT state, failure_code FROM release WHERE id = ?", which).one());
const job = (id: string) => inRoom(id, (sql) => sql.exec("SELECT attempts, stalls, next_attempt_at, last_code FROM release_job WHERE release_id = ?", REL).toArray()[0] ?? null);
const kept = (id: string) => inRoom(id, (sql) => sql.exec("SELECT files, bytes, since, settles, settled_at, last_code FROM release_uncertain WHERE release_id = ?", REL).toArray()[0] ?? null);
const recorded = (id: string) => inRoom(id, (sql) => sql.exec("SELECT release_id, files, bytes FROM release_upload").toArray());
const slots = (id: string) => inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM release_upload_attempt").one().n as number);
const queued = (id: string) => inRoom(id, (sql) => sql.exec("SELECT script_name FROM script_delete").toArray().map((row: any) => row.script_name));
const hostScript = (id: string) => inRoom(id, (sql) => sql.exec("SELECT script_name FROM serve_state").one().script_name as string);
const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version as number;
const unpublishCauses = (id: string) => inRoom(id, (sql) => sql.exec("SELECT cause FROM unpublish ORDER BY seq").toArray().map((row: any) => row.cause));
const holds = (id: string) => inRoom(id, (sql) => sql.exec("SELECT cause FROM release_hold WHERE until IS NOT NULL").toArray().map((row: any) => row.cause));
/** A departure from the room's organization, as the organization's sweep sends it to every room. */
const depart = (id: string, person: string) => stub(id).fetch("https://do/internal/org-departure", {
  method: "POST", body: JSON.stringify({ person, org: ORG, actor: "per_un_orgadmin", left_at: T }),
}).then((x: Response) => x.status);
/** A room that is `uncertain` since `T`, its script's write lost, and whose first read is due at `T + 5_000`, now. */
async function uncertainAndDue(extra: string[] = []) {
  const r = await room(extra);
  await providerFault(r.script, { op: "script", lost: true });
  expect((await pass(r.room)).state).toBe("uncertain");
  await at(r.room, T + 5_000);
  return r;
}
const trail = (id: string) => inRoom(id, (sql) => ({
  events: sql.exec("SELECT type, subject_id, reason FROM event WHERE type LIKE 'release.%' ORDER BY seq").toArray().map((e: any) => [e.type, e.subject_id, e.reason]),
  audit: sql.exec("SELECT action, new_json FROM audit_event WHERE action IN ('release.uncertain', 'release.settled') ORDER BY seq").toArray().map((a: any) => [a.action, JSON.parse(a.new_json)]),
}));

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});
beforeEach(async () => {
  await github("/reset", {});
  await github("/seed", repository(SITE));
  await moderation().fetch("https://do/release-reads", { method: "POST", body: JSON.stringify({ release_id: `rel_${"0".repeat(32)}`, reads: 1, owner_key: "room:ws_schema" }) });
  await inModeration((sql) => { sql.exec("DELETE FROM release_reads"); sql.exec("DELETE FROM release_read_owner"); });
});
afterEach(async () => { for (const id of made.splice(0)) await alarmQuiet(stub(id)); });

describe("an upload whose answer was lost", () => {
  it("is uncertain, read back after five seconds to the millisecond, recorded on the provider's word and committed", async () => {
    const r = await room();
    await providerFault(r.script, { op: "script", lost: true });
    const first = await pass(r.room);
    expect([first.outcome, first.code, first.state, first.next_attempt_at, first.due]).toEqual(["retry", "release_upload_outcome_unknown", "uncertain", T + 5_000, T + 5_000]);
    expect(await kept(r.room)).toEqual({ files: 3, bytes: 15 + 24 + MARKER_BYTES(REL), since: T, settles: 0, settled_at: null, last_code: "release_upload_outcome_unknown" });
    expect([await recorded(r.room), await queued(r.room), await slots(r.room)]).toEqual([[], [], 1]);
    // Nothing is read before it is due.
    await at(r.room, T + 4_999);
    expect((await pass(r.room)).outcome).toBe("not_due");
    expect(reads(await provider(r.script))).toBe(0);
    // At five seconds: one read, the script is there, and the upload is recorded with what the attempt sent.
    await at(r.room, T + 5_000);
    const settled = await pass(r.room);
    expect([settled.outcome, settled.code, settled.state, settled.next_attempt_at]).toEqual(["next", null, "uploading", T + 5_000]);
    expect(await recorded(r.room)).toEqual([{ release_id: REL, files: 3, bytes: 15 + 24 + MARKER_BYTES(REL) }]);
    expect(await kept(r.room)).toMatchObject({ settles: 1, settled_at: T + 5_000, last_code: "release_settled_written" });
    // **No upload slot is taken by the read, nothing is asked of GitHub again, and the script is written once.**
    const seen = await provider(r.script);
    expect(ops(seen)).toEqual(["session 200", "bucket 202", "bucket 201", "script 502", "read 200"]);
    expect([seen.written!.times, await slots(r.room), (await githubState()).tokens.length]).toEqual([1, 1, 1]);
    // And the commit goes live.
    const live = await pass(r.room);
    expect([live.outcome, live.state]).toEqual(["done", "live"]);
    expect(await hostScript(r.room)).toBe(r.script);
    // Each outcome is on the release's trail with its own code.
    const seenTrail = await trail(r.room);
    expect(seenTrail.events).toEqual([
      ["release.uncertain", REL, "release_upload_outcome_unknown"],
      ["release.settled", REL, "release_settled_written"],
      ["release.uploaded", REL, null],
      ["release.live", REL, null],
    ]);
    expect(seenTrail.audit).toEqual([
      ["release.uncertain", { state: "uncertain", reason: "release_upload_outcome_unknown" }],
      ["release.settled", { state: "uploading", reason: "release_settled_written" }],
    ]);
    // Three attempts and one read: the read is not a stall, and isn't counted by the cap.
    expect(await job(r.room)).toMatchObject({ attempts: 3, stalls: 0 });
  });

  it("is uploaded again, whole, when the provider's read says the script isn't there", async () => {
    const r = await room();
    // A `5xx` with nothing written: the answer can't say the write didn't go through.
    await providerFault(r.script, { op: "script", status: 503 });
    expect((await pass(r.room)).state).toBe("uncertain");
    await at(r.room, T + 5_000);
    const settled = await pass(r.room);
    // Settled absent: back at its upload, due at once, and not a stall.
    expect([settled.outcome, settled.state, settled.next_attempt_at]).toEqual(["next", "uploading", T + 5_000]);
    expect([await recorded(r.room), await kept(r.room)]).toEqual([[], expect.objectContaining({ settles: 1, last_code: "release_settled_absent" })]);
    expect(await job(r.room)).toMatchObject({ attempts: 2, stalls: 0 });
    // The upload runs again and is written; the provider holds the files, so its session asks for none.
    const again = await pass(r.room);
    expect([again.outcome, again.state]).toEqual(["next", "uploading"]);
    expect(ops(await provider(r.script))).toEqual(["session 200", "bucket 202", "bucket 201", "script 503", "read 200", "session 200", "script 200"]);
    expect([(await recorded(r.room)).length, await slots(r.room)]).toEqual([1, 2]);
    expect((await trail(r.room)).events.map((e: any[]) => [e[0], e[2]])).toEqual([
      ["release.uncertain", "release_upload_outcome_unknown"],
      ["release.settled", "release_settled_absent"],
      ["release.uploaded", null],
    ]);
  });

  it("stays uncertain while the read settles nothing, read after waits that double to a minute, and ends at the sixth read", async () => {
    const r = await room();
    await providerFault(r.script, { op: "script", lost: true });
    await providerFault(r.script, { op: "read", status: 500, times: 6 });
    let due = (await pass(r.room)).next_attempt_at!;
    const readAt: number[] = [];
    for (let read = 1; read <= 5; read += 1) {
      // A millisecond before it is due, nothing is read.
      await at(r.room, due - 1);
      expect((await pass(r.room)).outcome, `read ${read}`).toBe("not_due");
      await at(r.room, due);
      const out = await pass(r.room);
      expect([out.outcome, out.code, out.state], `read ${read}`).toEqual(["retry", "release_settle_unknown", "uncertain"]);
      readAt.push(due - T);
      due = out.next_attempt_at!;
    }
    expect(readAt).toEqual([5_000, 15_000, 35_000, 75_000, 135_000]);
    expect(due - T).toBe(195_000);
    await at(r.room, due);
    const last = await pass(r.room);
    expect([last.state]).toEqual(["failed"]);
    expect(await release(r.room)).toEqual({ state: "failed", failure_code: "release_upload_unsettled" });
    expect(reads(await provider(r.script))).toBe(6);
    // Its script, which may exist, is queued for deletion; nothing was recorded and nothing went live.
    expect([await queued(r.room), await recorded(r.room), await hostScript(r.room)]).toEqual([[r.script], [], `${r.label}.${PREV}`]);
    expect((await trail(r.room)).events.at(-1)).toEqual(["release.failed", REL, "release_upload_unsettled"]);
    // Seven attempts, six of them reads: one counted by the cap.
    expect(await job(r.room)).toMatchObject({ attempts: 7, stalls: 0 });
  });

  it("is read no later than ten minutes after it became uncertain, to the millisecond, and then ends without a read", async () => {
    const r = await room();
    await providerFault(r.script, { op: "script", lost: true });
    await providerFault(r.script, { op: "read", status: 500, times: 2 });
    await pass(r.room);
    await at(r.room, T + 5_000);
    expect((await pass(r.room)).next_attempt_at).toBe(T + 15_000);
    // Late: a millisecond before the deadline it is still read, and the next read is due at the deadline, never past.
    await at(r.room, T + DEADLINE - 1);
    const late = await pass(r.room);
    expect([late.outcome, late.code, late.next_attempt_at]).toEqual(["retry", "release_settle_unknown", T + DEADLINE]);
    expect(reads(await provider(r.script))).toBe(2);
    await at(r.room, T + DEADLINE);
    const end = await pass(r.room);
    expect([end.outcome, end.code]).toEqual(["gave_up", "release_upload_unsettled"]);
    expect(reads(await provider(r.script))).toBe(2);
    expect(await release(r.room)).toEqual({ state: "failed", failure_code: "release_upload_unsettled" });
    expect(await kept(r.room)).toMatchObject({ settles: 2, last_code: "release_upload_unsettled" });
  });

  it("is settled written by an overlapping attempt whose write comes back said, as the read would", async () => {
    const r = await room();
    // The first attempt's write is held at the provider; a second attempt runs whole meanwhile, and its answer is lost.
    const gate = await providerGate(r.script, "script");
    const first = upload(r.room);
    await gate.arrived();
    await providerFault(r.script, { op: "script", lost: true });
    const second = await upload(r.room);
    expect([second.body.state, second.body.waiting]).toEqual(["uncertain", "release_upload_outcome_unknown"]);
    await gate.release();
    const done = (await first).body;
    expect([done.state, done.uploaded, done.settled]).toEqual(["uploading", true, "release_settled_written"]);
    expect([(await recorded(r.room)).length, reads(await provider(r.script)), (await provider(r.script)).expiredGates]).toEqual([1, 0, 0]);
  });

  it("asks nothing once its step's lease has run out before the read", async () => {
    const r = await room();
    await providerFault(r.script, { op: "script", lost: true });
    await pass(r.room);
    await at(r.room, T + 5_000);
    // Another pass leases the release while this step is at its read.
    await inRoom(r.room, (sql) => {
      sql.exec("CREATE TABLE test_release_at (point TEXT, statement TEXT)");
      sql.exec("INSERT INTO test_release_at (point, statement) VALUES ('settling', ?)", `UPDATE release_job SET attempts = attempts + 1 WHERE release_id = '${REL}'`);
    });
    expect((await pass(r.room)).outcome).toBe("stale");
    expect(reads(await provider(r.script))).toBe(0);
    expect([(await release(r.room)).state, (await kept(r.room)).settles]).toEqual(["uncertain", 0]);
  });

  it("never takes a script object that names another script, or none, for its own: such a read settles nothing", async () => {
    const r = await uncertainAndDue();
    // The script is written at the provider. The first read answers an object naming another script, the second one
    // naming none: neither is this script, so neither records anything.
    await providerFault(r.script, { op: "read", shape: "other_id" });
    const other = await pass(r.room);
    expect([other.outcome, other.code, other.state, other.next_attempt_at]).toEqual(["retry", "release_settle_unknown", "uncertain", T + 15_000]);
    await providerFault(r.script, { op: "read", shape: "no_id" });
    await at(r.room, T + 15_000);
    const none = await pass(r.room);
    expect([none.outcome, none.code, none.state, none.next_attempt_at]).toEqual(["retry", "release_settle_unknown", "uncertain", T + 35_000]);
    expect([await recorded(r.room), await kept(r.room)]).toEqual([[], expect.objectContaining({ settles: 2, settled_at: null, last_code: "release_settle_unknown" })]);
    // The control: the read that names this very script settles it written.
    await at(r.room, T + 35_000);
    expect([(await pass(r.room)).state, (await recorded(r.room)).length]).toEqual(["uploading", 1]);
    expect(ops(await provider(r.script)).filter((op) => op.startsWith("read"))).toEqual(["read 200", "read 200", "read 200"]);
  });

  it("resumes settling from what the room keeps after the object is evicted between the write and the read", async () => {
    const r = await room();
    await providerFault(r.script, { op: "script", lost: true });
    expect((await pass(r.room)).state).toBe("uncertain");
    // Evicted: the object is thrown away with everything it held in memory. A mark on the old instance shows the next
    // call meets a new one, which has only the room's durable state.
    await runInDurableObject(stub(r.room), (instance: any) => { instance.testEvictionMark = true; });
    await runInDurableObject(stub(r.room), (_: any, state: any) => { try { state.abort("evicted"); } catch {} }).catch(() => {});
    expect(await runInDurableObject(stub(r.room), (instance: any) => instance.testEvictionMark ?? null)).toBeNull();
    expect(await kept(r.room)).toEqual({ files: 3, bytes: 15 + 24 + MARKER_BYTES(REL), since: T, settles: 0, settled_at: null, last_code: "release_upload_outcome_unknown" });
    // The read is still due at five seconds, not sooner, and settles from `release_uncertain` alone.
    await at(r.room, T + 4_999);
    expect((await pass(r.room)).outcome).toBe("not_due");
    await at(r.room, T + 5_000);
    const settled = await pass(r.room);
    expect([settled.outcome, settled.state]).toEqual(["next", "uploading"]);
    expect(await recorded(r.room)).toEqual([{ release_id: REL, files: 3, bytes: 15 + 24 + MARKER_BYTES(REL) }]);
    expect(await kept(r.room)).toMatchObject({ settles: 1, settled_at: T + 5_000, last_code: "release_settled_written" });
    expect((await provider(r.script)).written!.times).toBe(1);
    expect([(await pass(r.room)).state, await hostScript(r.room)]).toEqual(["live", r.script]);
  });
});

describe("while a release is uncertain", () => {
  it("lets nothing else go live in the room", async () => {
    const r = await room([
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         SELECT '${REL2}', commit_sha, 'uploading', label, 3, 2, task_id, label || '.${REL2}', '${REL2}', requested_by, 2, approved_by, 2, ${T}, ${T} FROM release WHERE id = '${REL}'`,
    ]);
    await inRoom(r.room, (sql) => sql.exec("INSERT INTO release_upload (release_id, script_name, files, bytes, uploaded_at) VALUES (?, ?, 1, 0, 1)", REL2, `${r.label}.${REL2}`));
    await providerFault(r.script, { op: "script", lost: true });
    expect((await upload(r.room)).body.state).toBe("uncertain");
    // The other release's commit waits under its own code, and stages nothing.
    const waiting = await commit(r.room, REL2);
    expect([waiting.body.state, waiting.body.waiting]).toEqual(["uploading", "release_uncertain"]);
    expect(await hostScript(r.room)).toBe(`${r.label}.${PREV}`);
    // Once the first is settled, the other commits.
    expect((await upload(r.room)).body.state).toBe("uploading");
    expect((await commit(r.room, REL2)).body.state).toBe("live");
    expect(await hostScript(r.room)).toBe(`${r.label}.${REL2}`);
  });

  it("keeps its script from the hourly reconcile within its upload's hour", async () => {
    const r = await room();
    await providerFault(r.script, { op: "script", lost: true });
    expect((await upload(r.room)).body.state).toBe("uncertain");
    await check(r.room, { kind: "script", script: r.script });
    expect([await queued(r.room), (await release(r.room)).state]).toEqual([[], "uncertain"]);
  });

  const unpublishes: [string, string, (r: Room) => Promise<unknown>][] = [
    ["the room is archived", "workspace_archived", async (r) => expect((await api(OWNER, "POST", `/v1/workspaces/${r.room}/archive`, { policy_version: await version(r.room) })).status).toBe(200)],
    ["the room is made private", "release_needs_public_room", async (r) => expect((await api(OWNER, "PUT", `/v1/workspaces/${r.room}/visibility`, { visibility: "private" })).status).toBe(200)],
  ];
  for (const [what, cause, fire] of unpublishes) {
    it(`ends under the unpublish's own cause when ${what} during its read, and nothing is recorded or served`, async () => {
      const r = await uncertainAndDue();
      // The read is held at the provider while the unpublish lands; the provider then says the script is there.
      const gate = await providerGate(r.script, "read");
      const running = pass(r.room);
      try {
        await gate.arrived();
        await fire(r);
      } finally {
        await gate.release();
      }
      await running;
      expect(await unpublishCauses(r.room)).toEqual([cause]);
      expect(await release(r.room)).toEqual({ state: "failed", failure_code: "release_epoch_moved" });
      // The read counted for nothing: nothing recorded, nothing settled, the script queued, the host serving nothing.
      expect([await recorded(r.room), await kept(r.room)]).toEqual([[], expect.objectContaining({ settles: 0, settled_at: null })]);
      expect(await queued(r.room)).toContain(r.script);
      expect(await inRoom(r.room, (sql) => sql.exec("SELECT script_name, release_id FROM serve_state").one())).toEqual({ script_name: null, release_id: null });
      expect((await trail(r.room)).events.map((e: any[]) => e[0])).not.toContain("release.settled");
      // Nothing more is read.
      await at(r.room, T + 15_000);
      await pass(r.room);
      expect(reads(await provider(r.script))).toBe(1);
    });
  }

  const holdsLanding: [string, string, (r: Room) => Promise<unknown>][] = [
    // The hold alone, as no command would write it with the requester's standing unchanged: its own cause ends it.
    ["a hold because nobody may release", "no_releaser", (r) => inRoom(r.room, (sql) => void sql.exec("UPDATE release_hold SET cause = 'no_releaser', held_at = ?, until = ?, generation = generation + 1", T + 5_000, T + 5_000 + 7 * 24 * 60 * 60 * 1000))],
    // The real departures that hold the app: they also take the owner's delegation of the requester's `deploy` grant,
    // which the recheck asks first, so that is the cause it ends under.
    ["the departures that leave nobody who may release", "requester_lost_authority", async (r) => {
      for (const who of [r.admin, OWNER.id]) expect(await depart(r.room, who)).toBe(200);
    }],
  ];
  for (const [what, code, fire] of holdsLanding) {
    it(`ends with ${code} when ${what} lands during its read, and nothing is served`, async () => {
      const r = await uncertainAndDue();
      const gate = await providerGate(r.script, "read");
      const running = pass(r.room);
      try {
        await gate.arrived();
        await fire(r);
        expect(await holds(r.room)).toEqual(["no_releaser"]);
      } finally {
        await gate.release();
      }
      await running;
      // Whatever the read settled, the release can't go live while the app is held: its commit's recheck ends it.
      for (let step = 0; step < 4 && ["uncertain", "uploading"].includes((await release(r.room)).state); step += 1) await pass(r.room);
      expect(await release(r.room)).toEqual({ state: "failed", failure_code: code });
      expect((await trail(r.room)).events.at(-1)).toEqual(["release.failed", REL, code]);
      expect((await trail(r.room)).events.map((e: any[]) => e[0])).not.toContain("release.live");
      expect(await hostScript(r.room)).toBe(`${r.label}.${PREV}`);
      expect(await inRoom(r.room, (sql) => sql.exec("SELECT in_flight_release FROM release_config").one())).toEqual({ in_flight_release: null });
      expect([await holds(r.room), await unpublishCauses(r.room)]).toEqual([["no_releaser"], []]);
    });
  }
});

describe("the room's stored alarm while a release is uncertain", () => {
  it("is armed for each of settling's waits, the same distance off by the Worker's clock", async () => {
    const r = await room();
    await providerFault(r.script, { op: "script", lost: true });
    await providerFault(r.script, { op: "read", status: 500 });
    expect((await pass(r.room)).state).toBe("uncertain");
    // Armed from the room's alarm alone, with the release commands' clock held where it is: the alarm's own pass finds
    // nothing due, and sets the room's next alarm for the first read, five seconds off.
    const armedFor = async (wait: number) => {
      await inRoom(r.room, (sql) => void sql.exec("UPDATE test_release_driver SET from_alarm = 1"));
      try {
        const before = Date.now();
        await switchedOn(() => alarmPass(stub(r.room)));
        const armed = (await nextAlarm(stub(r.room)))!;
        expect(armed).toBeGreaterThanOrEqual(before + wait);
        expect(armed).toBeLessThanOrEqual(Date.now() + wait);
      } finally {
        await inRoom(r.room, (sql) => void sql.exec("UPDATE test_release_driver SET from_alarm = 0"));
      }
    };
    await armedFor(5_000);
    expect(reads(await provider(r.script))).toBe(0);
    // The first read settles nothing; the next wait is ten seconds, and the alarm is armed for it.
    await at(r.room, T + 5_000);
    expect((await pass(r.room)).next_attempt_at).toBe(T + 15_000);
    await armedFor(10_000);
    expect([reads(await provider(r.script)), (await release(r.room)).state]).toEqual([1, "uncertain"]);
  });
});
