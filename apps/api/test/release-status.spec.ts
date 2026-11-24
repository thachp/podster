import { env, runInDurableObject, SELF } from "cloudflare:test";
import { createHash } from "node:crypto";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm";
import { fakeIds } from "./fake-ids";

// M6 step 7: `get_task_release_status` reports the release beside checks and merge. The latest attempt for the task's
// merged commit, in the room's own state with the time the room recorded it; `served` and the default host's address
// only once the marker came back through the host and the host still serves it; and `{ exists: false }`, as before M6,
// while release is off for the deployment or the room.
//
// **How a test drives it,** as `release-marker.spec.ts` does: the release driver runs only in a room that opts in, one
// pass at a time on `/internal/test-release-drive`. Time is the release commands' clock, `test_release_clock`. The room's
// alarms are the test's (`manualAlarms`), so nothing runs beside the test. The applier has no provider here: a test
// writes what it would have recorded. The host is `fake-content.ts`'s.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const ORG = "org_rs";
const OWNER: Who = { id: "per_rs_owner", org: ORG, adminOrgs: [ORG] };
/** An agent in the room that isn't shown the task's change, and asks for its merge. */
const MERGER: Who = { id: "agt_rs_merger", kind: "agent", org: ORG };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const facts = who.kind === "agent" ? { gen: 1, linker: { person: "per_rs_linker", since: 1 } } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } };
  return new SignJWT({ kind: who.kind ?? "person", org: who.org, ...facts })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "idempotency-key": `rs-key-${++counter}` };
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
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
const IDS = fakeIds("release-status");
const REPO = IDS.id(0);
const COMMIT = "c5".repeat(20);
const ELSEWHERE = "e7".repeat(20);
const DIRECTORY = "d6".repeat(20);
const github = (path: string, body?: unknown) => fetch(`https://github-release-fake.example.com${path}?repo=${REPO}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
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
const SITE = { "index.html": "<p>status</p>\n" };

// --- the app's host, at the provider's stand-in ------------------------------------------------------------------------
const content = (path: string, host: string, body?: unknown) =>
  fetch(`https://content-fake.example.com/${path}?host=${host}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
const serve = (host: string, what: { script?: string; body?: string; status?: number }) => content("marker-serve", host, what);

// --- a room with a release of the task's merged commit -----------------------------------------------------------------
const REL = `rel_${"7b".repeat(16)}`;
const PREV = `rel_${"4e".repeat(16)}`;
const TASK = "tsk_rs_1";
const T = 1_900_000_000_000;
const HOUR = 60 * 60 * 1000;
const POLL = 5_000;
const WAIT = 30_000;
let rooms = 0;
const made: string[] = [];
type Room = { room: string; label: string; host: string; script: string; previous: string };

/**
 * A room where everything the recheck asks for holds, managed repositories and release are on, the task's merge of
 * `COMMIT` succeeded, and `REL` releases it, uploading since `T`. The default host serves `PREV`, a release of another
 * commit unless `previousCommit` says otherwise.
 */
async function room(previousCommit = ELSEWHERE): Promise<Room> {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Status" })).body.id;
  made.push(id);
  const n = ++rooms;
  const requester = `per_rs_req_${n}`;
  const admin = `per_rs_adm_${n}`;
  const label = `${IDS.tag}${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  await inRoom(id, (sql) => {
    sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)");
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who, ORG, role, OWNER.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `rs-${n}-${label}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/status', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO, OWNER.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_rs', ?, 'github', ?, 'deploy', ?, 1)", requester, REPO, OWNER.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, OWNER.id, admin);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_requested_by, merge_requested_at, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, ?, 1, 1, 2, ?, 1, 1)", TASK, REPO, COMMIT, admin, admin);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", OWNER.id);
    sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, served_at, updated_at)
      VALUES (?, ?, 'served', ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, 1, 1, 1)`, PREV, previousCommit, label, TASK, `${label}.${PREV}`, PREV, requester, OWNER.id);
    sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
      VALUES (?, ?, 'uploading', ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, ?, ?)`, REL, COMMIT, label, TASK, `${label}.${REL}`, REL, requester, OWNER.id, T, T);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, `${label}.${PREV}`);
    // The kind a real upload records before its script is written (S3): static.
    sql.exec("INSERT OR IGNORE INTO release_script_kind (release_id, script_name, kind, recorded_at) SELECT substr(s, -36), s, 'static', 1 FROM (SELECT script_name AS s FROM serve_state UNION SELECT flight_before FROM serve_state) WHERE s IS NOT NULL");
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, `${label}.${PREV}`);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("CREATE TABLE test_release_upload_provider (x INTEGER)");
    sql.exec("CREATE TABLE test_release_driver (from_alarm INTEGER)");
    sql.exec("INSERT INTO test_release_driver (from_alarm) VALUES (0)");
    sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
    sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, id).run();
  await manualAlarms(stub(id));
  return { room: id, label, host, script: `${label}.${REL}`, previous: `${label}.${PREV}` };
}
type Pass = { release_id?: string | null; outcome: string; code?: string | null; state?: string };
const pass = (id: string): Promise<Pass> => switchedOn(() => stub(id).fetch("https://do/internal/test-release-drive", { method: "POST", body: "{}" }).then(async (r: Response) => {
  if (r.status !== 200) throw new Error(`a pass answered ${r.status}: ${await r.text()}`);
  return (await r.json()) as Pass;
}));
const at = (id: string, now: number) => inRoom(id, (sql) => void sql.exec("UPDATE test_release_clock SET now = ?", now));
const switchHost = (id: string) => inRoom(id, (sql) => void sql.exec("UPDATE serve_apply SET applied_version = (SELECT version FROM serve_state WHERE kind = 'default'), applied_script = (SELECT script_name FROM serve_state WHERE kind = 'default'), applied_at = 1"));
const status = (id: string) => api(OWNER, "GET", `/v1/workspaces/${id}/tasks/${TASK}/release-status`);
/** The release part of the status, read with release switched on for the deployment. */
const shown = async (id: string) => {
  const got = await switchedOn(() => status(id));
  expect(got.status, got.text).toBe(200);
  return got.body.release;
};
const attempt = (state: string, observed_at: number, more: object = {}) =>
  ({ exists: true, release_id: REL, commit_sha: COMMIT, state, observed_at, failure_code: null, served: false, result_url: null, waiting: null, ...more });
async function withStop<T>(run: () => Promise<T>): Promise<T> {
  await moderation().fetch("https://do/content-stop");
  await inModeration((s) => void s.exec("INSERT INTO content_stop (singleton, stopped, reason, at, version, updated_at) VALUES (1, 1, 'illegal', 1, 1, 1) ON CONFLICT (singleton) DO UPDATE SET stopped = 1, reason = 'illegal', at = 1, version = version + 1"));
  try { return await run(); } finally { await inModeration((s) => void s.exec("UPDATE content_stop SET stopped = 0, reason = NULL, at = NULL, version = version + 1")); }
}

/** A room whose `REL` the driver has taken through its upload and its commit, at `T`: live, its marker not yet back. */
async function live(previousCommit?: string): Promise<Room> {
  await github("/seed", repository(SITE));
  const r = await room(previousCommit);
  expect((await pass(r.room)).outcome).toBe("next");
  const committed = await pass(r.room);
  expect([committed.outcome, committed.state]).toEqual(["done", "live"]);
  return r;
}
/** `live`, then served by its own marker through the switched host, at `T + POLL`. */
async function served(previousCommit?: string): Promise<Room> {
  const r = await live(previousCommit);
  await serve(r.host, { script: r.script });
  await switchHost(r.room);
  await at(r.room, T + POLL);
  expect((await pass(r.room)).outcome).toBe("served");
  return r;
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const registered = await SELF.fetch(`https://api.internal/v1/agents/${MERGER.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(OWNER) }, body: JSON.stringify({ org_id: ORG, name: MERGER.id }) });
  if (registered.status !== 200) throw new Error(`register ${MERGER.id}: ${registered.status}`);
});
beforeEach(async () => {
  await github("/reset", {});
  await moderation().fetch("https://do/release-reads", { method: "POST", body: JSON.stringify({ release_id: `rel_${"0".repeat(32)}`, reads: 1, owner_key: "room:ws_schema" }) });
  await inModeration((sql) => { sql.exec("DELETE FROM release_reads"); sql.exec("DELETE FROM release_read_owner"); });
});
afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});

describe("a task's release beside its checks and merge (M6 step 7)", () => {
  it("reports the latest attempt for the merged commit in the room's own state, and never as served until its marker comes back", async () => {
    const r = await room();
    // Uploading: the attempt in its state, at the time the room recorded it; nothing served, no address.
    const whole = (await switchedOn(() => status(r.room))).body;
    expect(whole.merge).toMatchObject({ state: "succeeded", sha: COMMIT, observed_at: 2 });
    expect(whole.release).toEqual(attempt("uploading", T));
    // The driver commits it live. The host is switched, and serves its marker, but nothing has fetched it yet: `live`
    // is never served, and the release before, of another commit, says nothing about this one.
    await github("/seed", repository(SITE));
    expect((await pass(r.room)).outcome).toBe("next");
    expect((await pass(r.room)).state).toBe("live");
    await serve(r.host, { script: r.script });
    await switchHost(r.room);
    expect(await shown(r.room)).toEqual(attempt("awaiting_confirmation", T));
    // The marker comes back through the host: served, with the default host's address, at the marker's time.
    await at(r.room, T + POLL);
    expect((await pass(r.room)).outcome).toBe("served");
    expect(await shown(r.room)).toEqual(attempt("served", T + POLL, { served: true, result_url: `https://${r.host}/` }));
  });

  it("says why a release waits while the room's upload cap holds it, and only while it does", async () => {
    await github("/seed", repository(SITE));
    await github("/fault", { token: 500 });
    const r = await room();
    // Two upload attempts in the hour, each left where it was by a read GitHub didn't answer: retried, not a named wait.
    expect((await pass(r.room)).code).toBe("release_read_unavailable");
    expect(await shown(r.room)).toEqual(attempt("uploading", T));
    await at(r.room, T + WAIT);
    expect((await pass(r.room)).code).toBe("release_read_unavailable");
    // The third waits for the room's hourly upload attempts: the status says so, by a word of the closed set alone.
    await at(r.room, T + 3 * WAIT);
    expect((await pass(r.room)).code).toBe("release_upload_attempts");
    expect(await shown(r.room)).toEqual(attempt("uploading", T, { waiting: "upload_cap" }));
    // A step out now isn't waiting, whatever the job last said.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_job SET leased_step = 'upload', leased_epoch = 2, leased_hold = 0"));
    expect((await shown(r.room)).waiting).toBe(null);
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_job SET leased_step = NULL, leased_epoch = NULL, leased_hold = NULL"));
    expect((await shown(r.room)).waiting).toBe("upload_cap");
    // The upload's hour ends the release: failed, and no longer waiting for anything.
    await at(r.room, T + HOUR);
    await pass(r.room);
    expect(await shown(r.room)).toEqual(attempt("failed", T + HOUR, { failure_code: "release_upload_expired" }));
  });

  it("is Merged · Deployment failed when the marker never comes back, never live", async () => {
    const r = await live();
    await serve(r.host, { script: r.previous });
    await switchHost(r.room);
    // Switched at `T`, and the host answers another release's marker: fetched again, still not served.
    expect((await pass(r.room)).code).toBe("release_awaiting_marker");
    expect(await shown(r.room)).toEqual(attempt("awaiting_confirmation", T));
    await at(r.room, T + WAIT);
    expect((await pass(r.room)).code).toBe("release_marker_missing");
    const got = (await switchedOn(() => status(r.room))).body;
    expect(got.merge.state).toBe("succeeded");
    expect(got.release).toEqual(attempt("failed", T + WAIT, { failure_code: "release_marker_missing" }));
  });

  it("keeps an earlier attempt of the same commit served beside a later one that failed", async () => {
    // The release before is of this same commit and still on the host: the commit is live, and the later attempt failed.
    const r = await live(COMMIT);
    await serve(r.host, { script: r.previous });
    await switchHost(r.room);
    expect((await pass(r.room)).code).toBe("release_awaiting_marker");
    // Live and not yet served, while the host is set to it: so the commit isn't shown served by the release before.
    expect(await shown(r.room)).toEqual(attempt("awaiting_confirmation", T));
    await at(r.room, T + WAIT);
    expect((await pass(r.room)).code).toBe("release_marker_missing");
    expect(await shown(r.room)).toEqual(attempt("failed", T + WAIT, { failure_code: "release_marker_missing", served: true, result_url: `https://${r.host}/` }));
  });

  it("isn't served while the host serves something else, the app is held or suspended, or the content domain is stopped", async () => {
    const r = await served();
    const yes = attempt("served", T + POLL, { served: true, result_url: `https://${r.host}/` });
    const no = attempt("served", T + POLL);
    expect(await shown(r.room)).toEqual(yes);
    // The default host set to another script.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE serve_state SET release_id = ?, script_name = ? WHERE kind = 'default'", PREV, r.previous));
    expect(await shown(r.room)).toEqual(no);
    await inRoom(r.room, (sql) => void sql.exec("UPDATE serve_state SET release_id = ?, script_name = ? WHERE kind = 'default'", REL, r.script));
    expect(await shown(r.room)).toEqual(yes);
    // Held because nobody who may release remains.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_hold SET cause = 'no_releaser', held_at = 1, until = 2"));
    expect(await shown(r.room)).toEqual(no);
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_hold SET cause = NULL, held_at = NULL, until = NULL"));
    expect(await shown(r.room)).toEqual(yes);
    // Suspended by an operator.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE app_label SET suspended_at = 1, suspension_reason = 'abuse' WHERE current = 1"));
    expect(await shown(r.room)).toEqual(no);
    await inRoom(r.room, (sql) => void sql.exec("UPDATE app_label SET suspended_at = NULL, suspension_reason = NULL WHERE current = 1"));
    expect(await shown(r.room)).toEqual(yes);
    // The whole content domain stopped.
    expect(await withStop(() => shown(r.room))).toEqual(no);
    expect(await shown(r.room)).toEqual(yes);
    // The room just made private, before its unpublish has run (the room's alarms are the test's, so it doesn't):
    // the host is still set to the release, and it isn't served.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE workspace SET visibility = 'private'"));
    expect(await inRoom(r.room, (sql) => sql.exec("SELECT script_name FROM serve_state WHERE kind = 'default'").one().script_name)).toBe(r.script);
    expect(await shown(r.room)).toEqual(no);
    await inRoom(r.room, (sql) => void sql.exec("UPDATE workspace SET visibility = 'public'"));
    expect(await shown(r.room)).toEqual(yes);
  });

  it("says nothing of a release while release is off for the deployment or the room, or of another commit's", async () => {
    const r = await served();
    // The deployment's switch is off: as before M6.
    const off = await status(r.room);
    expect([off.status, off.body.release]).toEqual([200, { exists: false }]);
    // The room's release is off.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_config SET enabled = 0"));
    expect(await shown(r.room)).toEqual({ exists: false });
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_config SET enabled = 1"));
    expect((await shown(r.room)).served).toBe(true);
    // The task's merged commit is another: no attempt for it.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE task_change SET merge_sha = ?", ELSEWHERE.replace(/^e7/, "f8")));
    expect(await shown(r.room)).toEqual({ exists: false });
    // No merged commit at all.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE task_change SET merge_sha = NULL, merge_state = 'not_requested'"));
    expect(await shown(r.room)).toEqual({ exists: false });
  });

  it("authorizes first: a refused caller, and whoever is given the merge alone, cause no read of the content domain's stop", async () => {
    const r = await served();
    await inRoom(r.room, (sql) => {
      sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'member', ?, 1)", MERGER.id, ORG, OWNER.id);
      sql.exec("UPDATE task SET requester_id = ? WHERE id = ?", MERGER.id, TASK);
    });
    await inModeration((sql) => void sql.exec("CREATE TABLE IF NOT EXISTS test_stop_reads (n INTEGER)"));
    const reads = () => inModeration((sql) => sql.exec("SELECT count(*) AS n FROM test_stop_reads").one().n as number);
    const read = (who: Who) => switchedOn(() => api(who, "GET", `/v1/workspaces/${r.room}/tasks/${TASK}/release-status`));
    try {
      // Control: the owner, shown the change, with a served release: the stop is asked once.
      const before = await reads();
      expect((await read(OWNER)).body.release.served).toBe(true);
      expect(await reads()).toBe(before + 1);
      // An agent that reads the task but isn't shown its change and didn't ask for its merge: refused, nothing asked.
      const refused = await read(MERGER);
      expect([refused.status, refused.body.error.code]).toEqual([403, "not_allowed"]);
      // Someone outside the room: refused, nothing asked.
      const outside = await read({ id: "per_rs_outsider", org: ORG });
      expect([outside.status, outside.body.error.code]).toEqual([404, "workspace_not_found"]);
      // Given the merge alone: answered, with no release, and nothing asked.
      await inRoom(r.room, (sql) => void sql.exec("UPDATE task_change SET merge_requested_by = ?", MERGER.id));
      const merged = await read(MERGER);
      expect([merged.status, merged.body.release]).toEqual([200, null]);
      expect(await reads()).toBe(before + 1);
      // The owner again, with the room's release off: nothing could be served, and nothing is asked.
      await inRoom(r.room, (sql) => void sql.exec("UPDATE release_config SET enabled = 0"));
      expect((await read(OWNER)).body.release).toEqual({ exists: false });
      expect(await reads()).toBe(before + 1);
      // And with it on but the room made private: not served, and nothing is asked.
      await inRoom(r.room, (sql) => void sql.exec("UPDATE release_config SET enabled = 1"));
      await inRoom(r.room, (sql) => void sql.exec("UPDATE workspace SET visibility = 'private'"));
      expect((await read(OWNER)).body.release).toMatchObject({ state: "served", served: false, result_url: null });
      expect(await reads()).toBe(before + 1);
    } finally {
      await inModeration((sql) => void sql.exec("DROP TABLE IF EXISTS test_stop_reads"));
    }
  });

  it("gives whoever is given the merge alone no release while it's on, and the same answer as everyone while it's off", async () => {
    const r = await served();
    await inRoom(r.room, (sql) => {
      sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'member', ?, 1)", MERGER.id, ORG, OWNER.id);
      sql.exec("UPDATE task_change SET merge_requested_by = ?", MERGER.id);
      // It reads the task as its requester, and as an agent that isn't its assignee or reviewer isn't shown its change.
      sql.exec("UPDATE task SET requester_id = ? WHERE id = ?", MERGER.id, TASK);
    });
    const theirs = (who: Who) => api(who, "GET", `/v1/workspaces/${r.room}/tasks/${TASK}/release-status`);
    const on = await switchedOn(() => theirs(MERGER));
    expect(on.status, on.text).toBe(200);
    expect([on.body.pull_request, on.body.checks, on.body.release, on.body.merge.requested_by]).toEqual([null, null, null, MERGER.id]);
    // Off for the deployment, or for the room: `{ exists: false }`, as before M6, for them and for the owner alike.
    expect((await theirs(MERGER)).body.release).toEqual({ exists: false });
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_config SET enabled = 0"));
    expect((await switchedOn(() => theirs(MERGER))).body.release).toEqual({ exists: false });
    expect(await shown(r.room)).toEqual({ exists: false });
  });
});
