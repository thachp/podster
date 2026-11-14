import { env, runInDurableObject, SELF } from "cloudflare:test";
import { createHash } from "node:crypto";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet, nextAlarm } from "./alarm";
import { fakeIds } from "./fake-ids";

// M6 step 5, the release job's driver (ADR 0010's "The release job"): the room's alarm takes a release through the
// room's own commands, start, upload and commit, one step at a time, with a wait that grows, a cap on attempts, a bound
// on how often a room reads, and the upload's hour as an alarm of its own.
//
// **How a test drives it.** The driver runs in a test build only in a room that has `test_release_driver`, and from the
// room's alarm only while its `from_alarm` is 1. Most tests here leave that at 0 and ask for one pass at a time on
// `/internal/test-release-drive`, which runs the very pass the alarm runs with its step run in the pass, and answers
// what came of it and when the driver would next wake the room. So no alarm the test doesn't make drives anything. One
// test turns `from_alarm` on and shows the alarm's own pass handing its step off.
//
// **Time** is the release commands' clock, `test_release_clock`, set by each test: every wait is shown to the
// millisecond, and nothing waits on the Worker's clock.
//
// GitHub is `fake-github-release.ts`, under a repository ID only this file uses; the provider is `fake-content.ts`'s
// upload part, by script name, and each room has a label of its own. The rooms' appliers and delete jobs have no
// provider (`test_content_provider_off`).

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const ORG = "org_rd";
const OWNER: Who = { id: "per_rd_owner", kind: "person", org: ORG, adminOrgs: [ORG] };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "idempotency-key": `rd-key-${++counter}` };
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: JSON.stringify(body ?? {}) });
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
/** This file's own repository at the shared stand-in: see `fake-ids.ts`. */
const IDS = fakeIds("release-driver");
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
const SITE = { "index.html": "<p>driven</p>\n", "app.js": "export const two = 2;\n" };

// --- the provider's stand-in, by script --------------------------------------------------------------------------------
type Provider = { calls: { op: string; status: number }[]; written: { times: number } | null; expiredGates: number };
const provider = async (script: string) => (await (await fetch(`https://content-fake.example.com/upload-state?script=${script}`)).json()) as Provider;
async function providerGate(script: string, op: "session" | "script") {
  const at = (path: string, id?: number) => `https://content-fake.example.com/${path}?script=${script}${id === undefined ? "" : `&id=${id}`}`;
  const { id } = (await (await fetch(at("upload-gate"), { method: "POST", body: JSON.stringify({ op }) })).json()) as { id: number };
  return {
    arrived: async () => { await (await fetch(at("upload-arrived", id))).json(); },
    release: async () => { await (await fetch(at("upload-release", id))).json(); },
  };
}

// --- a room with a release for the driver ------------------------------------------------------------------------------
const REL = `rel_${"8f".repeat(16)}`;
const REL2 = `rel_${"9a".repeat(16)}`;
const PREV = `rel_${"6d".repeat(16)}`;
const TASK = "tsk_rd_1";
/** The release commands' clock in every room here, unless a test moves it. */
const T = 1_900_000_000_000;
const HOUR = 60 * 60 * 1000;
const LEASE = 6 * 60 * 1000;
const IDLE = 10 * 60 * 1000;
let rooms = 0;
const made: string[] = [];
type Room = { room: string; label: string; script: string };
/**
 * A room where everything the recheck asks for holds, whose default host serves an earlier release, and whose release
 * `REL` is queued, or uploading since `T`. The driver is on for it, from the test's own passes only.
 */
async function room(state: "queued" | "uploading", extra: string[] = []): Promise<Room> {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Driver" })).body.id;
  made.push(id);
  await alarmQuiet(stub(id));
  const n = ++rooms;
  const requester = `per_rd_req_${n}`;
  const admin = `per_rd_adm_${n}`;
  const label = `${IDS.tag}${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  await inRoom(id, (sql) => {
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who, ORG, role, OWNER.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `rd-${n}-${label}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/driver', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO, OWNER.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_rd', ?, 'github', ?, 'deploy', ?, 1)", requester, REPO, OWNER.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, OWNER.id, admin);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO, COMMIT, admin);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", OWNER.id);
    sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
      VALUES (?, ?, 'served', ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, 1, 1)`, PREV, COMMIT, label, TASK, `${label}.${PREV}`, PREV, requester, OWNER.id);
    const uploading = state === "uploading";
    sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
      VALUES (?, ?, ?, ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, ?, ?)`, REL, COMMIT, state, label, TASK, uploading ? `${label}.${REL}` : null, uploading ? REL : null, requester, OWNER.id, uploading ? T : null, T);
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
  return { room: id, label, script: `${label}.${REL}` };
}
type Pass = { release_id?: string | null; outcome: string; code?: string | null; next_attempt_at?: number | null; state?: string; due: number | null };
/** One pass of the driver, as the alarm runs it, with its step run in the pass. */
const pass = (id: string): Promise<Pass> => stub(id).fetch("https://do/internal/test-release-drive", { method: "POST", body: "{}" }).then(async (r: Response) => {
  if (r.status !== 200) throw new Error(`a pass answered ${r.status}: ${await r.text()}`);
  return (await r.json()) as Pass;
});
const drivenPass = (id: string) => switchedOn(() => pass(id));
const at = (id: string, now: number) => inRoom(id, (sql) => void sql.exec("UPDATE test_release_clock SET now = ?", now));
const release = (id: string, which = REL) => inRoom(id, (sql) => sql.exec("SELECT state, failure_code FROM release WHERE id = ?", which).one());
const job = (id: string, which = REL) => inRoom(id, (sql) => sql.exec("SELECT attempts, next_attempt_at, leased_step, last_code FROM release_job WHERE release_id = ?", which).toArray()[0] ?? null);
const trail = (id: string) => inRoom(id, (sql) => ({
  events: sql.exec("SELECT type, actor_id, subject_id, reason FROM event WHERE type LIKE 'release.%' ORDER BY seq").toArray().map((e: any) => [e.type, e.subject_id, e.reason]),
  audit: sql.exec("SELECT action, target_id, new_json FROM audit_event WHERE action LIKE 'release.%' ORDER BY seq").toArray(),
}));
const reserved = () => inModeration((sql) => sql.exec("SELECT release_id, reads FROM release_reads").toArray());

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
  await inModeration((sql) => void sql.exec("DROP TABLE IF EXISTS test_clock"));
});

describe("driving a release", () => {
  it("takes a queued release through start, upload and commit, a step a pass, and records the upload with an event", async () => {
    await github("/seed", repository(SITE));
    const r = await room("queued");
    const first = await drivenPass(r.room);
    expect([first.outcome, first.state, first.next_attempt_at, first.due]).toEqual(["next", "uploading", T, T + 10]);
    const second = await drivenPass(r.room);
    expect([second.outcome, second.state, second.next_attempt_at]).toEqual(["next", "uploading", T]);
    expect((await provider(r.script)).written!.times).toBe(1);
    const third = await drivenPass(r.room);
    expect([third.outcome, third.state, third.next_attempt_at]).toEqual(["done", "live", null]);
    // Nothing left for the driver: no pass, and no wake but none.
    const after = await drivenPass(r.room);
    expect([after.outcome, after.due]).toEqual(["not_due", null]);
    expect(await job(r.room)).toEqual({ attempts: 3, next_attempt_at: null, leased_step: null, last_code: null });
    // **The upload is on the release's trail,** between its start and its going live, as Podster's act.
    const seen = await trail(r.room);
    expect(seen.events).toEqual([["release.upload_started", REL, null], ["release.uploaded", REL, null], ["release.live", REL, null]]);
    const uploaded = seen.audit.find((a: any) => a.action === "release.uploaded");
    expect(JSON.parse(uploaded.new_json)).toEqual({ state: "uploading", files: 3, bytes: 14 + 22 + `{"release_id":"${REL}","commit":"${COMMIT}"}\n`.length });
  });

  it("drives only the oldest release of the room, and the next once it is done", async () => {
    await github("/seed", repository(SITE));
    const r = await room("queued", [
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, requested_by, requested_at, approved_by, approved_at, updated_at)
         SELECT '${REL2}', commit_sha, 'queued', label, 3, 2, task_id, requested_by, 2, approved_by, 2, 2 FROM release WHERE id = '${REL}'`,
    ]);
    expect((await drivenPass(r.room)).release_id).toBe(REL);
    expect([await job(r.room, REL2), (await release(r.room, REL2)).state]).toEqual([null, "queued"]);
    // While the first is the room's to drive, the second waits however often the room is asked.
    expect((await drivenPass(r.room)).release_id).toBe(REL);
    expect([await job(r.room, REL2), (await release(r.room, REL2)).state]).toEqual([null, "queued"]);
    // Once the first has ended, the second is the one driven.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release SET state = 'failed', failure_code = 'release_upload_expired', finished_at = 1 WHERE id = ?", REL));
    const second = await drivenPass(r.room);
    expect([second.release_id, second.outcome, second.state]).toEqual([REL2, "next", "uploading"]);
  });
});

describe("a release that stays where it was", () => {
  it("is asked again after a wait that doubles to ten minutes, to the millisecond, and ends at the eighth attempt", async () => {
    // The organization's object gives no answer that says yes or no: every start is undecided, `standing_unknown`.
    const r = await room("queued", ["CREATE TABLE test_release_delegation_answer (answer TEXT)", `INSERT INTO test_release_delegation_answer (answer) VALUES ('"maybe"')`]);
    let now = T;
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const out = await drivenPass(r.room);
      expect([out.outcome, out.code, out.state], `attempt ${attempt}`).toEqual(["retry", "standing_unknown", "queued"]);
      waits.push(out.next_attempt_at! - now);
      expect(out.due, `attempt ${attempt}`).toBe(out.next_attempt_at);
      // A millisecond before it is due, a pass does nothing and counts nothing.
      await at(r.room, out.next_attempt_at! - 1);
      expect((await drivenPass(r.room)).outcome, `attempt ${attempt}`).toBe("not_due");
      expect((await job(r.room)).attempts, `attempt ${attempt}`).toBe(attempt);
      now = out.next_attempt_at!;
      await at(r.room, now);
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
    // The eighth leaves it where it was too, and ends it.
    const last = await drivenPass(r.room);
    expect([last.outcome, last.code, last.state]).toEqual(["gave_up", "release_attempts_exhausted", "failed"]);
    expect(await release(r.room)).toEqual({ state: "failed", failure_code: "release_attempts_exhausted" });
    expect((await trail(r.room)).events.at(-1)).toEqual(["release.failed", REL, "release_attempts_exhausted"]);
    expect([(await drivenPass(r.room)).outcome, (await job(r.room)).attempts]).toEqual(["not_due", 8]);
  });

  it("is taken up again when a step's lease runs out, and a step that comes back after that runs nothing", async () => {
    await github("/seed", repository(SITE));
    // A step was leased at T, as the second attempt, and died with the object: it never came back.
    const r = await room("queued", [
      `INSERT INTO release_job (release_id, attempts, next_attempt_at, leased_step, leased_epoch, leased_hold, updated_at) VALUES ('${REL}', 2, ${T + LEASE}, 'start', 2, 0, ${T})`,
    ]);
    const step = (attempt: number) => switchedOn(() => stub(r.room).fetch("https://do/internal/release-drive", { method: "POST", body: JSON.stringify({ release_id: REL, attempt }) }).then((res: Response) => res.json()));
    // An earlier attempt's step arriving while the second's lease is out runs nothing: the lease isn't its own.
    expect(await step(1)).toEqual({ release_id: REL, outcome: "stale" });
    expect([(await release(r.room)).state, await job(r.room)]).toEqual(["queued", { attempts: 2, next_attempt_at: T + LEASE, leased_step: "start", last_code: null }]);
    expect((await drivenPass(r.room)).outcome).toBe("not_due");
    await at(r.room, T + LEASE - 1);
    expect((await drivenPass(r.room)).outcome).toBe("not_due");
    await at(r.room, T + LEASE);
    const again = await drivenPass(r.room);
    expect([again.outcome, again.state]).toEqual(["next", "uploading"]);
    expect((await job(r.room)).attempts).toBe(3);
    // The dead attempt's step arrives now: no lease is out, and nothing is asked or written.
    const before = await trail(r.room);
    expect(await step(2)).toEqual({ release_id: REL, outcome: "stale" });
    expect([await trail(r.room), (await githubState()).minted, (await job(r.room)).attempts]).toEqual([before, [], 3]);
  });

  it("records nothing of a step the room's hold moved under, and looks at the release afresh", async () => {
    await github("/seed", repository(SITE));
    // The hold's generation moves while the files are sent: the upload itself goes on and is recorded.
    const r = await room("uploading", ["CREATE TABLE test_release_upload_before_check (statement TEXT)", "INSERT INTO test_release_upload_before_check (statement) VALUES ('UPDATE release_hold SET generation = generation + 1')"]);
    const moved = await drivenPass(r.room);
    expect([moved.outcome, moved.code]).toEqual(["moved", "release_driver_moved"]);
    expect(await job(r.room)).toEqual({ attempts: 1, next_attempt_at: T, leased_step: null, last_code: "release_driver_moved" });
    // Looked at afresh, from the release as it is: uploaded, so committed.
    const next = await drivenPass(r.room);
    expect([next.outcome, next.state]).toEqual(["done", "live"]);
  });

  it("records nothing of a step the room's release epoch moved under, and looks at the release afresh", async () => {
    await github("/seed", repository(SITE));
    // The epoch moves while the files are sent; the hold stays as it was.
    const r = await room("uploading", ["CREATE TABLE test_release_upload_before_check (statement TEXT)", "INSERT INTO test_release_upload_before_check (statement) VALUES ('UPDATE release_config SET release_epoch = release_epoch + 1')"]);
    const hold = () => inRoom(r.room, (sql) => sql.exec("SELECT generation FROM release_hold").one().generation);
    const holdBefore = await hold();
    const moved = await drivenPass(r.room);
    expect([moved.outcome, moved.code]).toEqual(["moved", "release_driver_moved"]);
    expect(await job(r.room)).toEqual({ attempts: 1, next_attempt_at: T, leased_step: null, last_code: "release_driver_moved" });
    expect(await hold()).toBe(holdBefore);
  });
});

describe("the backoff", () => {
  it("waits the first wait again once a step has moved the release on, and doubles only for attempts in a row", async () => {
    await github("/seed", repository(SITE));
    const r = await room("queued");
    // A start and an upload that each move it on.
    expect((await drivenPass(r.room)).outcome).toBe("next");
    expect((await drivenPass(r.room)).outcome).toBe("next");
    // Then the organization's object gives no answer to go on, and the commit leaves the release where it was.
    await inRoom(r.room, (sql) => { sql.exec("CREATE TABLE test_release_delegation_answer (answer TEXT)"); sql.exec(`INSERT INTO test_release_delegation_answer (answer) VALUES ('"maybe"')`); });
    const first = await drivenPass(r.room);
    // The third attempt, but the first in a row to stall: thirty seconds, not the third wait's two minutes.
    expect([first.outcome, first.code, first.state, first.next_attempt_at]).toEqual(["retry", "standing_unknown", "uploading", T + 30_000]);
    expect((await job(r.room)).attempts).toBe(3);
    await at(r.room, T + 30_000);
    const second = await drivenPass(r.room);
    expect([second.outcome, second.next_attempt_at]).toEqual(["retry", T + 30_000 + 60_000]);
    expect(await inRoom(r.room, (sql) => sql.exec("SELECT attempts, stalls FROM release_job").one())).toEqual({ attempts: 4, stalls: 2 });
  });
});

describe("a step's lease", () => {
  it("asks nothing more of the provider once it has run out, and the step waits", async () => {
    await github("/seed", repository(SITE));
    const r = await room("uploading");
    // The upload session is held at the provider while the release commands' clock reaches the lease's end.
    const gate = await providerGate(r.script, "session");
    const running = drivenPass(r.room);
    try {
      await gate.arrived();
      await at(r.room, T + LEASE);
    } finally {
      await gate.release();
    }
    const out = await running;
    expect([out.outcome, out.code, out.state, out.next_attempt_at]).toEqual(["retry", "release_drive_lease_lost", "uploading", T + LEASE + 30_000]);
    // The session was the provider's only call: no bucket, and no script written.
    const seen = await provider(r.script);
    expect([seen.calls.map((call) => call.op), seen.written]).toEqual([["session"], null]);
    // GitHub's token was revoked all the same.
    expect((await githubState()).tokens.every((token) => token.revoked)).toBe(true);
  });

  it("is still one the step may finish within: the same step, its clock a millisecond short of the end, uploads", async () => {
    await github("/seed", repository(SITE));
    const r = await room("uploading");
    const gate = await providerGate(r.script, "session");
    const running = drivenPass(r.room);
    try {
      await gate.arrived();
      await at(r.room, T + LEASE - 1);
    } finally {
      await gate.release();
    }
    const out = await running;
    expect([out.outcome, out.state]).toEqual(["next", "uploading"]);
    expect((await provider(r.script)).written!.times).toBe(1);
  });
});

describe("how often a room reads", () => {
  it("begins at most two upload attempts in an hour, and the upload's hour ends the release before a third", async () => {
    await github("/seed", repository(SITE));
    await github("/fault", { token: 500 });
    const r = await room("uploading");
    const first = await drivenPass(r.room);
    expect([first.outcome, first.code, first.next_attempt_at]).toEqual(["retry", "release_read_unavailable", T + 30_000]);
    await at(r.room, T + 30_000);
    const second = await drivenPass(r.room);
    expect([second.outcome, second.code, second.next_attempt_at]).toEqual(["retry", "release_read_unavailable", T + 90_000]);
    const held = await reserved();
    // The third waits for the first to leave the hour, counting no attempt, and reads nothing.
    await at(r.room, T + 90_000);
    const third = await drivenPass(r.room);
    expect([third.outcome, third.code, third.next_attempt_at, third.due]).toEqual(["waiting", "release_upload_attempts", T + HOUR, T + HOUR]);
    expect([(await job(r.room)).attempts, await reserved()]).toEqual([2, held]);
    expect(held).toEqual([{ release_id: REL, reads: 4 }]);
    // The upload began at T, so its hour ends then too: the release ends, and no third attempt is made.
    await at(r.room, T + HOUR - 1);
    expect([(await drivenPass(r.room)).outcome, (await release(r.room)).state]).toEqual(["not_due", "uploading"]);
    await at(r.room, T + HOUR);
    await drivenPass(r.room);
    expect(await release(r.room)).toEqual({ state: "failed", failure_code: "release_upload_expired" });
    expect(await reserved()).toEqual(held);
  });
});

describe("each owner's share of the read budget (docs/m6-release-read-share.md)", () => {
  /** The `Moderation` object's clock, where the budget is kept, set to match the rooms'. */
  const moderationAt = (now: number) => inModeration((sql) => {
    sql.exec("CREATE TABLE IF NOT EXISTS test_clock (now INTEGER NOT NULL)");
    sql.exec("DELETE FROM test_clock");
    sql.exec("INSERT INTO test_clock (now) VALUES (?)", now);
  });
  /** Reads reserved by another release of `owner`, as one of its rooms would. */
  const fill = async (n: number, reads: number, owner: string) => {
    const answer = await moderation().fetch("https://do/release-reads", { method: "POST", body: JSON.stringify({ release_id: `rel_${n.toString(16).padStart(32, "a")}`, reads, owner_key: owner, more: true }) });
    expect(((await answer.json()) as any).fits, `${owner} ${reads}`).toBe(true);
  };
  const slots = (id: string) => inRoom(id, (sql) => sql.exec("SELECT COUNT(*) AS n FROM release_upload_attempt").one().n);
  const owners = () => inModeration((sql) => sql.exec("SELECT release_id, owner_key FROM release_read_owner ORDER BY release_id").toArray());

  it("keeps a queued release waiting while two other owners hold their whole share, counting nothing, and starts it when the hour rolls", async () => {
    await github("/seed", repository(SITE));
    await moderationAt(T);
    await fill(1, 1204, "org:org_rd_one");
    await moderationAt(T + 1000);
    await fill(2, 1204, "org:org_rd_two");
    const held = await reserved();
    // 592 of the 3,000 are left, less than a full attempt: the room's release waits as it is, queued.
    const r = await room("queued");
    const waiting = await drivenPass(r.room);
    expect([waiting.outcome, waiting.code, waiting.next_attempt_at, waiting.due]).toEqual(["waiting", "release_reads_share", T + HOUR, T + HOUR]);
    // **No attempt is counted, no upload slot taken, nothing asked of GitHub, nothing reserved, and the upload's hour
    // hasn't begun.**
    expect(await job(r.room)).toEqual({ attempts: 0, next_attempt_at: T + HOUR, leased_step: null, last_code: "release_reads_share" });
    expect([await release(r.room), await slots(r.room), (await githubState()).minted, await reserved()]).toEqual([{ state: "queued", failure_code: null }, 0, [], held]);
    // Asked again a millisecond early, it isn't due; asked many times, it is never ended by the cap.
    await at(r.room, T + HOUR - 1);
    expect((await drivenPass(r.room)).outcome).toBe("not_due");
    for (let n = 0; n < 9; n += 1) {
      await inRoom(r.room, (sql) => void sql.exec("UPDATE release_job SET next_attempt_at = NULL"));
      expect((await drivenPass(r.room)).code, `pass ${n}`).toBe("release_reads_share");
    }
    expect([(await job(r.room)).attempts, (await release(r.room)).state]).toEqual([0, "queued"]);
    // The hour rolls past the first owner's reads: the release is started, as its first attempt.
    await moderationAt(T + HOUR);
    await at(r.room, T + HOUR);
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_job SET next_attempt_at = ?", T + HOUR));
    const started = await drivenPass(r.room);
    expect([started.outcome, started.state]).toEqual(["next", "uploading"]);
    expect((await job(r.room)).attempts).toBe(1);
    // Its upload reserves under its own room's organization, from the room's row.
    const uploaded = await drivenPass(r.room);
    expect([uploaded.outcome, uploaded.state]).toEqual(["next", "uploading"]);
    expect((await owners()).find((row: any) => row.release_id === REL)).toEqual({ release_id: REL, owner_key: `org:${ORG}` });
  });

  it("keeps a queued release waiting while its own organization's other releases hold the share, though the hour has room", async () => {
    await github("/seed", repository(SITE));
    await moderationAt(T);
    await fill(3, 602, `org:${ORG}`);
    await moderationAt(T + 2000);
    await fill(4, 602, `org:${ORG}`);
    const r = await room("queued");
    const waiting = await drivenPass(r.room);
    expect([waiting.outcome, waiting.code, waiting.next_attempt_at]).toEqual(["waiting", "release_reads_share", T + HOUR]);
    expect([(await job(r.room)).attempts, (await release(r.room)).state, await slots(r.room)]).toEqual([0, "queued", 0]);
    // The control: another organization's reads in its place leave this one's share whole, and the release starts.
    await inModeration((sql) => void sql.exec("UPDATE release_read_owner SET owner_key = 'org:org_rd_other'"));
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_job SET next_attempt_at = NULL"));
    const started = await drivenPass(r.room);
    expect([started.outcome, started.state, (await job(r.room)).attempts]).toEqual(["next", "uploading", 1]);
  });

  it("is enforced at the reservation all the same: a release past the queued check is refused by its owner's share", async () => {
    await github("/seed", repository(SITE));
    await moderationAt(T);
    await fill(5, 1204, `org:${ORG}`);
    const held = await reserved();
    // Already uploading, so the queued check is never asked: only the reservation stands between it and the reads.
    const r = await room("uploading");
    const refused = await drivenPass(r.room);
    expect([refused.outcome, refused.code, refused.state, refused.next_attempt_at]).toEqual(["retry", "release_reads_budget", "uploading", T + HOUR]);
    // The hour's total had room for it: the share alone refused, and nothing was reserved or asked of GitHub.
    expect([await reserved(), (await githubState()).minted]).toEqual([held, []]);
    // The control: the same reads charged to another owner, and the same release's next attempt reads and uploads.
    await inModeration((sql) => void sql.exec("UPDATE release_read_owner SET owner_key = 'org:org_rd_other'"));
    // Asked again before its upload's hour is out, which began at T.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_job SET next_attempt_at = NULL"));
    const uploaded = await drivenPass(r.room);
    expect([uploaded.outcome, uploaded.state]).toEqual(["next", "uploading"]);
    expect((await provider(r.script)).written!.times).toBe(1);
  });
});

describe("the upload's hour", () => {
  it("wakes the room at its end, to the millisecond, whatever the release's next attempt says", async () => {
    const r = await room("uploading", [`INSERT INTO release_job (release_id, attempts, next_attempt_at, updated_at) VALUES ('${REL}', 1, ${T + 2 * HOUR}, ${T})`]);
    await at(r.room, T + 1_000);
    expect(await drivenPass(r.room)).toEqual({ outcome: "not_due", due: T + HOUR });
    await at(r.room, T + HOUR - 1);
    await drivenPass(r.room);
    expect((await release(r.room)).state).toBe("uploading");
    await at(r.room, T + HOUR);
    await drivenPass(r.room);
    expect(await release(r.room)).toEqual({ state: "failed", failure_code: "release_upload_expired" });
    expect((await drivenPass(r.room)).due).toBeNull();
  });
});

describe("what the driver is behind", () => {
  it("does nothing, and counts nothing, unless the deployment's setting is exactly true and the release path is open", async () => {
    await github("/seed", repository(SITE));
    const r = await room("queued");
    // Unset: undecided.
    const unset = await pass(r.room);
    expect([unset.outcome, unset.code, unset.next_attempt_at]).toEqual(["idle", "release_driver_idle", T + 10 * 60 * 1000]);
    expect([await job(r.room), await release(r.room)]).toEqual([{ attempts: 0, next_attempt_at: T + 10 * 60 * 1000, leased_step: null, last_code: "release_driver_idle" }, { state: "queued", failure_code: null }]);
    // As written, `false`, and anything but `true`.
    for (const value of ["false", "True", "true "]) {
      await inRoom(r.room, (sql) => void sql.exec("DELETE FROM release_job"));
      await BINDINGS.DB.prepare("CREATE TABLE test_releases_setting (value TEXT)").run();
      try {
        await BINDINGS.DB.prepare("INSERT INTO test_releases_setting (value) VALUES (?)").bind(value).run();
        expect((await pass(r.room)).outcome, value).toBe("idle");
      } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_setting").run(); }
    }
    // Switched on, with a provider configured for the room: the release path's gate is closed.
    await inRoom(r.room, (sql) => { sql.exec("DELETE FROM release_job"); sql.exec("DROP TABLE test_content_provider_off"); });
    const gated = await drivenPass(r.room);
    await inRoom(r.room, (sql) => void sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)"));
    expect(gated.outcome).toBe("idle");
    expect([(await githubState()).minted, (await release(r.room)).state, (await job(r.room)).attempts]).toEqual([[], "queued", 0]);
    // The control: switched on, with the gate open, the same room is driven.
    await inRoom(r.room, (sql) => void sql.exec("DELETE FROM release_job"));
    expect((await drivenPass(r.room)).outcome).toBe("next");
  });

  it("does nothing, and counts nothing, while no content provider is configured to upload to", async () => {
    await github("/seed", repository(SITE));
    const r = await room("uploading");
    await inRoom(r.room, (sql) => void sql.exec("DROP TABLE test_release_upload_provider"));
    const idle = await drivenPass(r.room);
    expect([idle.outcome, idle.code, idle.next_attempt_at, idle.due]).toEqual(["idle", "content_provider_not_configured", T + IDLE, T + IDLE]);
    expect(await job(r.room)).toEqual({ attempts: 0, next_attempt_at: T + IDLE, leased_step: null, last_code: "content_provider_not_configured" });
    expect([(await githubState()).minted, await reserved(), (await release(r.room)).state]).toEqual([[], [], "uploading"]);
    // The control: with a provider, the same room is driven.
    await inRoom(r.room, (sql) => { sql.exec("CREATE TABLE test_release_upload_provider (x INTEGER)"); sql.exec("DELETE FROM release_job"); });
    expect((await drivenPass(r.room)).outcome).toBe("next");
  });

  it("is reached by no client, and its test switches are compiled only into test builds", async () => {
    for (const path of ["/internal/release-drive", "/v1/internal/release-drive", "/internal/test-release-drive"]) {
      const answer = await SELF.fetch(`https://api.internal${path}`, { method: "POST", body: JSON.stringify({ release_id: REL, attempt: 1 }) });
      expect(answer.status, path).toBeGreaterThanOrEqual(400);
    }
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    const check = (file: string, needle: string) => {
      const lines = sources[file].split("\n");
      const found = lines.findIndex((line) => line.includes(needle));
      expect(found, needle).toBeGreaterThan(0);
      expect(lines.slice(Math.max(0, found - 6), found).some((line) => line.includes('#[cfg(feature = "failpoints")]')), needle).toBe(true);
    };
    check("workspace/release_driver.rs", "name = 'test_release_driver'");
    check("workspace.rs", '"/internal/test-release-drive"');
    // **The owner a room's reads are charged to comes from the room's own row,** never from a request: the driver's
    // question and the upload's reservations both take it from `read_owner`, which reads only `workspace`.
    const driver = sources["workspace/release_driver.rs"];
    const owner = driver.slice(driver.indexOf("pub(super) fn read_owner("), driver.indexOf("fn room_id("));
    expect(owner).toContain('"SELECT id, owner_org_id, owner_person_id FROM workspace"');
    expect(owner).not.toMatch(/req|body|Request/);
    expect(driver).toContain('Some(json!({ "owner_key": owner, "reads": MAX_ATTEMPT_READS }))');
    expect(sources["workspace/release_upload.rs"]).toContain("let owner = release_driver::read_owner(&sql)?;");
    expect(sources["workspace/release_upload.rs"].match(/owner_key/g)).toBeNull();
    expect(sources["workspace/release_commit.rs"]).toContain("pub(crate) const RELEASE_PATH_COMPLETE: bool = false;");
  });
});

describe("the alarm's own pass", () => {
  it("hands its step to a request of the room's own and returns, and a pass while the step is out leases nothing", async () => {
    await github("/seed", repository(SITE));
    const r = await room("uploading");
    await inRoom(r.room, (sql) => { sql.exec("UPDATE test_release_driver SET from_alarm = 1"); sql.exec("DROP TABLE test_release_clock"); });
    // The upload's write of its script is held at the provider: by then GitHub has been asked everything.
    const gate = await providerGate(r.script, "script");
    try {
      await switchedOn(async () => {
        await alarmPass(stub(r.room));
        // The alarm has returned; the step it handed off reaches the provider all the same.
        await gate.arrived();
        expect((await job(r.room)).leased_step).toBe("upload");
        // A second alarm runs whole while the step is out, and leases nothing: one attempt, one session.
        await alarmPass(stub(r.room));
        expect((await job(r.room)).attempts).toBe(1);
        expect((await provider(r.script)).calls.filter((call) => call.op === "session")).toHaveLength(1);
      });
    } finally {
      // Nothing the step does from here asks GitHub or the deployment's setting: the script's write and the room.
      await inRoom(r.room, (sql) => void sql.exec("UPDATE test_release_driver SET from_alarm = 0"));
      await gate.release();
    }
    expect((await provider(r.script)).expiredGates).toBe(0);
  });
});

describe("the room's stored alarm", () => {
  const job = (next: number) => `INSERT INTO release_job (release_id, attempts, next_attempt_at, updated_at) VALUES ('${REL}', 1, ${next}, ${T})`;
  const fromAlarm = "UPDATE test_release_driver SET from_alarm = 1";

  it("is set for the upload's hour by the driver, and by nothing else in the room", async () => {
    // The release's next attempt is two hours off, so only its upload's hour, one hour off, can set this alarm.
    const r = await room("uploading", [job(T + 2 * HOUR)]);
    // The control: with the driver off from the alarm, the room sets none.
    await alarmPass(stub(r.room));
    expect(await nextAlarm(stub(r.room))).toBeNull();
    await inRoom(r.room, (sql) => void sql.exec(fromAlarm));
    const before = Date.now();
    await alarmPass(stub(r.room));
    const armed = (await nextAlarm(stub(r.room)))!;
    expect(armed).toBeGreaterThanOrEqual(before + HOUR);
    expect(armed).toBeLessThanOrEqual(Date.now() + HOUR);
  });

  it("is the earliest of the room's duties: the driver never puts an earlier one later, and brings a later one sooner", async () => {
    // A hold on the room's app runs out at a fixed moment, set as the alarm's own time.
    const HELD_UNTIL = 4_000_000_000_000;
    // The driver's own wake is a century off by the release commands' clock, so later than the hold's.
    const r = await room("queued", [job(T + 100 * 365 * 24 * HOUR), `UPDATE release_hold SET cause = 'no_releaser', held_at = 1, until = ${HELD_UNTIL}`, fromAlarm]);
    await alarmPass(stub(r.room));
    expect(await nextAlarm(stub(r.room))).toBe(HELD_UNTIL);
    // Now the driver's wake is an hour off: sooner than the hold's, so it is the alarm.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_job SET next_attempt_at = ?", T + HOUR));
    const before = Date.now();
    await alarmPass(stub(r.room));
    const armed = (await nextAlarm(stub(r.room)))!;
    expect(armed).toBeGreaterThanOrEqual(before + HOUR);
    expect(armed).toBeLessThanOrEqual(Date.now() + HOUR);
    expect(armed).toBeLessThan(HELD_UNTIL);
  });

  it("backs off from passes that failed by the count kept in the room, so a restart doesn't bring it back sooner", async () => {
    // Every write to the job fails, so every pass does; four had failed before, as a restarted object finds them.
    const r = await room("uploading", [
      fromAlarm,
      "CREATE TRIGGER test_release_job_fails BEFORE INSERT ON release_job BEGIN SELECT RAISE(ABORT, 'test'); END",
      `INSERT INTO release_drive_failure (singleton, failures, last_failed_at) VALUES (1, 4, ${T})`,
    ]);
    const failures = () => inRoom(r.room, (sql) => sql.exec("SELECT failures FROM release_drive_failure").toArray().map((row: any) => row.failures));
    const before = Date.now();
    await alarmPass(stub(r.room));
    const armed = (await nextAlarm(stub(r.room)))!;
    // The fifth in a row: 30 seconds doubled four times, though the release is due at once.
    expect(await failures()).toEqual([5]);
    expect(armed).toBeGreaterThanOrEqual(before + 480_000);
    expect(armed).toBeLessThanOrEqual(Date.now() + 480_000);
    // A pass that doesn't fail ends the count. Release is off here, so it idles, and the alarm is the idle's.
    await inRoom(r.room, (sql) => void sql.exec("DROP TRIGGER test_release_job_fails"));
    const after = Date.now();
    await alarmPass(stub(r.room));
    const idle = (await nextAlarm(stub(r.room)))!;
    expect(await failures()).toEqual([]);
    expect(idle).toBeGreaterThanOrEqual(after + IDLE);
    expect(idle).toBeLessThanOrEqual(Date.now() + IDLE);
  });
});
