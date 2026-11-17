import { env, runInDurableObject, SELF } from "cloudflare:test";
import { createHash } from "node:crypto";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm";
import { fakeIds } from "./fake-ids";

// M6 step 6, 6h: rolling back to an earlier release (`rollbackRelease`; ADR 0010's "Rollback", decision 203). A rollback
// is its own release record, asked for by a person with their own live `deploy` grant and approved as any release is.
// Once approved, the job switches the room's hosts back to the kept script with no upload, only when the room's rows
// allow it and Cloudflare's own read of that script, made at the switch, says it exists; otherwise it is a new release
// of that commit, uploaded again.
//
// **How a test drives it,** as `release-marker.spec.ts` does: the driver runs only in a room that opts in, one pass at
// a time on `/internal/test-release-drive`. **Time** is the release commands' clock. **The applier** has no provider
// here (`test_content_provider_off`, which also keeps the gate on the release path open): a test writes what it would
// have recorded. **The provider** for the switch's read and for an upload is `fake-content.ts`, by script name; a kept
// script it is told of exists, one it isn't told of reads as gone.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string; account: string; namespace: string; scriptsToken: string };
let key: any;
type Who = { id: string; org: string; kind?: "person" | "agent"; adminOrgs?: string[] };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const claims = who.kind === "agent"
    ? { kind: "agent", org: who.org, gen: 1 }
    : { kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who) };
  if (method !== "GET") headers["idempotency-key"] = idempotencyKey ?? `rb-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined, text };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
/** Release switched on for the test Worker while `run` is out, counted. */
let on = 0;
let switching: Promise<unknown> = Promise.resolve();
const inTurn = (step: () => Promise<unknown>) => (switching = switching.then(step, step));
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await inTurn(async () => { if (on++ === 0) await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_releases_on (x INTEGER)").run(); });
  try { return await run(); } finally { await inTurn(async () => { if (--on === 0) await BINDINGS.DB.prepare("DROP TABLE IF EXISTS test_releases_on").run(); }); }
}

/** An agent, registered once: it never asks here, refused by its kind. */
const AGENT: Who = { id: "agt_rb_agent", org: "org_rb_agents", kind: "agent" };

// --- GitHub's stand-in, for this file's own repository ---------------------------------------------------------------
const IDS = fakeIds("release-rollback");
const REPO = IDS.id(0);
const OLD = "a1".repeat(20);
const NEW = "b2".repeat(20);
const DIRECTORY = "d5".repeat(20);
const github = (path: string, body?: unknown) => fetch(`https://github-release-fake.example.com${path}?repo=${REPO}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
const blobSha = (content: Uint8Array) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
const sha = (n: number) => n.toString(16).padStart(40, "0");
/** The repository at `OLD`: one file under `site`. */
function repository() {
  const content = new TextEncoder().encode("<p>the old one</p>\n");
  const top = [{ path: "README.md", mode: "100644", type: "blob", sha: sha(1), size: 10 }, { path: "site", mode: "040000", type: "tree", sha: DIRECTORY }];
  const directory = [{ path: "index.html", mode: "100644", type: "blob", sha: blobSha(content), size: content.length }];
  return { repo: REPO, trees: { [OLD]: { tree: top }, [DIRECTORY]: { tree: directory } }, blobs: { [blobSha(content)]: Buffer.from(content).toString("base64") } };
}

// --- the provider's stand-in --------------------------------------------------------------------------------------------
const content = (path: string, query: string, body?: unknown) =>
  fetch(`https://content-fake.example.com/${path}?${query}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
/** The provider holds `script`: its read answers with a script object. */
const exists = (script: string) => content("seed", "", { scripts: [script] });
/** The provider deletes `script`, as anything outside the room might. */
const deleteAtProvider = (script: string) =>
  fetch(`https://api.cloudflare.com/client/v4/accounts/${FAKE.account}/workers/dispatch/namespaces/${FAKE.namespace}/scripts/${script}?force=true`, { method: "DELETE", headers: { authorization: `Bearer ${FAKE.scriptsToken}` } });
/** How many times the provider was asked to read `script`. */
const reads = async (script: string) => ((await (await content("state", "")).json()) as { calls: { op: string; name: string }[] }).calls.filter((c) => c.op === "script.get" && c.name === script).length;
/** What the provider's upload part holds for `script`: every call, and whether it was written. */
const uploadState = async (script: string) => (await (await content("upload-state", `script=${script}`)).json()) as { calls: unknown[]; written: unknown };
const serve = (host: string, body: string) => content("marker-serve", `host=${host}`, { body });
const marker = (release: string, commit: string) => `{"release_id":"${release}","commit":"${commit}"}\n`;

// --- a room with an app that served `OLD`, then `NEW` ----------------------------------------------------------------
const OLD_TASK = "tsk_rb_old";
const NEW_TASK = "tsk_rb_new";
const T = 1_900_000_000_000;
const DAY = 24 * 3_600_000;
let rooms = 0;
const made: string[] = [];
type Room = { room: string; owner: Who; admin: Who; requester: Who; label: string; host: string; old: string; now: string; kept: string; live: string };

/**
 * A public room where everything a release needs holds. Release `old` of commit `OLD` was served and then replaced by
 * `now`, of commit `NEW`, which the default host serves at version 5; `old`'s script is the one the room keeps. The
 * provider holds the kept script unless `keptExists` is false. The driver is on for the room, from the test's passes.
 */
async function room(opts: { keptExists?: boolean } = {}): Promise<Room> {
  const n = ++rooms;
  const org = `org_rb_${n}`;
  const owner: Who = { id: `per_rb_owner_${n}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Rollback" });
  expect(created.status).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  const requester: Who = { id: `per_rb_req_${n}`, org };
  const admin: Who = { id: `per_rb_adm_${n}`, org };
  const label = `${IDS.tag}${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  const old = `rel_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = `rel_${crypto.randomUUID().replace(/-/g, "")}`;
  await inRoom(id, (sql) => {
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, owner.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `rb-${n}-${label}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/rollback', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO, owner.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_rb', ?, 'github', ?, 'deploy', ?, 1)", requester.id, REPO, owner.id);
    for (const [task, commit, pr] of [[OLD_TASK, OLD, 7], [NEW_TASK, NEW, 8]] as const) {
      sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", task, requester.id, admin.id);
      sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, ?, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", task, REPO, pr, commit, admin.id);
    }
    sql.exec("INSERT INTO app_label (label, current, created_at, indexed_at) VALUES (?, 1, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at, kept_previous) VALUES (1, 1, 3, 2, ?, 1, 1, ?)", owner.id, `${label}.${old}`);
    const insert = `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, served_at, finished_at, updated_at)
      VALUES (?, ?, ?, ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, 1, 1, ?, 1)`;
    sql.exec(insert, old, OLD, "replaced", label, OLD_TASK, `${label}.${old}`, old, requester.id, owner.id, 2);
    sql.exec(insert, now, NEW, "served", label, NEW_TASK, `${label}.${now}`, now, requester.id, owner.id, null);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, now, `${label}.${now}`);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, `${label}.${now}`);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("CREATE TABLE test_release_upload_provider (x INTEGER)");
    sql.exec("CREATE TABLE test_release_driver (from_alarm INTEGER)");
    sql.exec("INSERT INTO test_release_driver (from_alarm) VALUES (0)");
    sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
    sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, id).run();
  if (opts.keptExists !== false) await exists(`${label}.${old}`);
  // The room's alarms are the test's from here on.
  await manualAlarms(stub(id));
  return { room: id, owner, admin, requester, label, host, old, now, kept: `${label}.${old}`, live: `${label}.${now}` };
}

const path = (r: Room, target = r.old) => `/v1/workspaces/${r.room}/releases/${target}/rollback`;
const rollback = (r: Room, opts: { target?: string; who?: Who; key?: string } = {}) => switchedOn(() => api(opts.who ?? r.requester, "POST", path(r, opts.target), undefined, opts.key));
const approve = (r: Room, release: string) => switchedOn(() => api(r.owner, "POST", `/v1/workspaces/${r.room}/releases/${release}/approve`));
const refused = (answer: { status: number; code?: string }) => [answer.status, answer.code];
type Pass = { release_id?: string | null; outcome: string; code?: string | null; state?: string };
const pass = (id: string): Promise<Pass> => switchedOn(() => stub(id).fetch("https://do/internal/test-release-drive", { method: "POST", body: "{}" }).then(async (res: Response) => {
  if (res.status !== 200) throw new Error(`a pass answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as Pass;
}));
const releaseOf = (r: Room, id: string) => inRoom(r.room, (sql) => sql.exec("SELECT state, script_name, script_release_id, failure_code FROM release WHERE id = ?", id).one());
const defaultHost = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT script_name, version FROM serve_state WHERE kind = 'default'").one());
const config = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT kept_previous, in_flight_release, in_flight_script FROM release_config").one());
const queuedScripts = (r: Room) => all(r.room, "SELECT script_name FROM script_delete ORDER BY script_name");
const everything = (r: Room) => inRoom(r.room, (sql) => JSON.stringify(["release", "release_rollback", "app_label", "audit_event", "event", "outbox", "serve_state", "script_delete"].map((table) => sql.exec(`SELECT * FROM ${table}`).toArray())));
const switchHost = (r: Room) => inRoom(r.room, (sql) => void sql.exec("UPDATE serve_apply SET applied_version = (SELECT version FROM serve_state WHERE kind = 'default'), applied_script = (SELECT script_name FROM serve_state WHERE kind = 'default'), applied_at = 1"));

/** A rollback to `old`, asked for and approved: queued for the driver. */
async function approved(r: Room): Promise<string> {
  const asked = await rollback(r);
  expect(asked.status, asked.text).toBe(200);
  const queued = await approve(r, asked.body.id);
  expect([queued.status, queued.body?.state], queued.text).toEqual([200, "queued"]);
  return asked.body.id;
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const registrar: Who = { id: "per_rb_registrar", org: AGENT.org, adminOrgs: [AGENT.org] };
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(registrar) }, body: JSON.stringify({ org_id: AGENT.org, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register ${AGENT.id}: ${res.status}`);
});
beforeEach(async () => {
  await github("/reset", {});
  await moderation().fetch("https://do/release-reads", { method: "POST", body: JSON.stringify({ release_id: `rel_${"0".repeat(32)}`, reads: 1, owner_key: "room:ws_schema" }) });
  await inModeration((sql) => { sql.exec("DELETE FROM release_reads"); sql.exec("DELETE FROM release_read_owner"); });
});
afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});

describe("asking to roll back (M6 step 6, 6h)", () => {
  it("records its own release, awaiting approval, naming the release it rolls back to and releasing its commit", async () => {
    const r = await room();
    await inRoom(r.room, (s) => void s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'admin', ?, 1)", AGENT.id, AGENT.org, r.owner.id));
    const answer = await rollback(r);
    expect(answer.status, answer.text).toBe(200);
    const id = answer.body.id;
    expect(answer.body).toEqual({
      id, commit_sha: OLD, environment: "production", state: "awaiting_approval", requested_by: r.requester.id, requested_at: T,
      approved_by: null, approved_at: null, declined_by: null, declined_at: null, result_url: null, failure_code: null, finished_at: null, rollback_to: r.old,
    });
    expect(await all(r.room, "SELECT release_id, rollback_to FROM release_rollback")).toEqual([{ release_id: id, rollback_to: r.old }]);
    expect(await all(r.room, "SELECT task_id, label, release_epoch, script_name FROM release WHERE id = ?", id)).toEqual([{ task_id: OLD_TASK, label: r.label, release_epoch: 2, script_name: null }]);
    const [audited] = await all(r.room, "SELECT actor_id, new_json FROM audit_event WHERE action = 'release.requested'");
    expect(audited.actor_id).toBe(r.requester.id);
    expect(JSON.parse(audited.new_json)).toEqual({ state: "awaiting_approval", task_id: OLD_TASK, commit_sha: OLD, rollback_to: r.old });
    // Told to those who may approve it, who are people; never the agent holding the admin role.
    const [event] = await all(r.room, "SELECT id FROM event WHERE type = 'release.requested' AND subject_id = ?", id);
    expect((await all(r.room, "SELECT recipient_principal_id AS who FROM outbox WHERE event_id = ? ORDER BY who", event.id)).map((o: any) => o.who)).toEqual([r.admin.id, r.owner.id].sort());
    // Nothing starts until a person approves it.
    expect((await pass(r.room)).outcome).toBe("not_due");
    expect((await releaseOf(r, id)).state).toBe("awaiting_approval");
  });

  it("is refused for a release the room didn't serve and leave, or doesn't have, writing nothing", async () => {
    const r = await room();
    const declined = `rel_${"de".repeat(16)}`;
    await inRoom(r.room, (s) => void s.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, requested_by, requested_at, declined_by, declined_at, updated_at)
      VALUES (?, ?, 'declined', ?, 3, 2, ?, ?, 1, ?, 1, 1)`, declined, OLD, r.label, OLD_TASK, r.requester.id, r.owner.id));
    const before = await everything(r);
    expect(refused(await rollback(r, { target: r.now })), "the release served now").toEqual([409, "rollback_target_invalid"]);
    expect(refused(await rollback(r, { target: declined })), "a release never served").toEqual([409, "rollback_target_invalid"]);
    expect(refused(await rollback(r, { target: `rel_${"0".repeat(32)}` }))).toEqual([404, "not_found"]);
    expect(refused(await switchedOn(() => api(r.requester, "POST", `/v1/workspaces/${r.room}/releases/rel_notone/rollback`)))).toEqual([404, "not_found"]);
    expect(await everything(r)).toBe(before);
  });

  it("needs the requester's own live deploy grant, decided before the release named is looked at, on every attempt", async () => {
    const r = await room();
    // The owner, with no grant of their own, as anyone: even naming a release the room doesn't have.
    expect(refused(await rollback(r, { who: r.owner, target: `rel_${"0".repeat(32)}` }))).toEqual([403, "grant_required"]);
    expect(refused(await rollback(r, { who: AGENT }))).toEqual([403, "not_allowed"]);
    // A stored answer goes back only to someone who still holds a grant.
    const first = await rollback(r, { key: "rb-replay" });
    expect(first.status, first.text).toBe(200);
    expect((await rollback(r, { key: "rb-replay" })).body).toEqual(first.body);
    await inRoom(r.room, (s) => void s.exec("UPDATE provider_grant SET revoked_at = 1"));
    const before = await everything(r);
    const replay = await rollback(r, { key: "rb-replay" });
    expect(refused(replay)).toEqual([403, "grant_required"]);
    expect(replay.text).not.toContain(first.body.id);
    expect(await everything(r)).toBe(before);
  });

  it("counts toward the room's 20 asks a day, and waits behind a release of the same commit", async () => {
    const r = await room();
    const first = await rollback(r);
    expect(first.status, first.text).toBe(200);
    expect(refused(await rollback(r))).toEqual([409, "release_pending"]);
    await inRoom(r.room, (s) => {
      s.exec("UPDATE release SET state = 'failed', failure_code = 'x', finished_at = ? WHERE id = ?", T, first.body.id);
      for (let i = 0; i < 18; i++) s.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, requested_by, requested_at, failure_code, finished_at, updated_at)
        VALUES (?, ?, 'failed', ?, 3, 2, ?, ?, 'x', ?, ?)`, `rel_${i.toString(16).padStart(32, "f")}`, NEW, r.label, r.requester.id, T - DAY + 1, T, T);
    });
    // The room's two releases from long ago don't count; one rollback and eighteen more in the day do: one more fits.
    const twentieth = await rollback(r);
    expect(twentieth.status, twentieth.text).toBe(200);
    await inRoom(r.room, (s) => void s.exec("UPDATE release SET state = 'failed', failure_code = 'x', finished_at = ? WHERE id = ?", T, twentieth.body.id));
    expect(refused(await rollback(r))).toEqual([429, "release_limit"]);
  });

  it("is refused by the gate on the release path before anything is read or written, and isn't there while release is off", async () => {
    const r = await room();
    const before = await everything(r);
    await inRoom(r.room, (s) => void s.exec("DROP TABLE test_content_provider_off"));
    try {
      expect(refused(await rollback(r))).toEqual([409, "release_not_available"]);
    } finally { await inRoom(r.room, (s) => void s.exec("CREATE TABLE test_content_provider_off (x INTEGER)")); }
    expect(await everything(r)).toBe(before);
    const real = await api(r.requester, "POST", path(r));
    const unknown = await api(r.requester, "POST", `${path(r)}x`);
    expect([real.status, real.text]).toEqual([unknown.status, unknown.text]);
    expect(real.code).toBe("not_found");
    expect(await everything(r)).toBe(before);
  });
});

describe("switching back to the kept script", () => {
  it("switches every host back, with nothing read from GitHub or uploaded, and the read of the script made at the switch", async () => {
    const r = await room();
    const id = await approved(r);
    // Approval reads nothing of the script, and nor does the start.
    expect(await reads(r.kept)).toBe(0);
    expect((await pass(r.room)).outcome).toBe("next");
    expect(await releaseOf(r, id)).toEqual({ state: "uploading", script_name: r.kept, script_release_id: r.old, failure_code: null });
    expect(await reads(r.kept)).toBe(0);
    // The switch: one read of the kept script, then the stage, the outside reads and the confirm.
    const switched = await pass(r.room);
    expect([switched.outcome, switched.state]).toEqual(["done", "live"]);
    expect(await reads(r.kept)).toBe(1);
    expect(await defaultHost(r)).toEqual({ script_name: r.kept, version: 6 });
    expect(await config(r)).toEqual({ kept_previous: r.kept, in_flight_release: id, in_flight_script: r.kept });
    // Nothing read from GitHub, no upload attempt, no read reserved, no script of its own.
    expect(await all(r.room, "SELECT * FROM release_upload_attempt")).toEqual([]);
    expect(await all(r.room, "SELECT * FROM release_upload")).toEqual([]);
    expect(await inModeration((s) => s.exec("SELECT release_id FROM release_reads").toArray())).toEqual([]);
    expect((await uploadState(`${r.label}.${id}`)).calls).toEqual([]);
    // Its marker is the kept script's own release's. Once it comes back, the rollback is served, the release rolled away
    // from is kept in its place, and nothing is deleted.
    await switchHost(r);
    await serve(r.host, marker(r.old, OLD));
    expect((await pass(r.room)).outcome).toBe("served");
    expect(await releaseOf(r, id)).toMatchObject({ state: "served" });
    expect(await releaseOf(r, r.now)).toMatchObject({ state: "replaced" });
    expect(await releaseOf(r, r.old)).toMatchObject({ state: "replaced" });
    expect(await config(r)).toEqual({ kept_previous: r.live, in_flight_release: null, in_flight_script: null });
    expect(await queuedScripts(r)).toEqual([]);
  });

  it("sets back, deleting nothing, when its marker never comes", async () => {
    const r = await room();
    const id = await approved(r);
    await pass(r.room);
    expect((await pass(r.room)).state).toBe("live");
    await switchHost(r);
    // The host serves the release rolled away from: not this rollback's marker. Fetched at the switch, then past the wait.
    await serve(r.host, marker(r.now, NEW));
    expect((await pass(r.room)).outcome).toBe("retry");
    await inRoom(r.room, (s) => void s.exec("UPDATE test_release_clock SET now = ?", T + 30_000));
    expect((await pass(r.room)).outcome).toBe("set_back");
    expect(await releaseOf(r, id)).toMatchObject({ state: "failed", failure_code: "release_marker_missing" });
    expect(await defaultHost(r)).toEqual({ script_name: r.live, version: 7 });
    expect(await config(r)).toEqual({ kept_previous: r.kept, in_flight_release: null, in_flight_script: null });
    expect(await queuedScripts(r)).toEqual([]);
  });
});

describe("a rollback that can't switch back", () => {
  /** Approved and started as a switch, then `change` before the switch's pass. */
  async function atSwitch(change: (r: Room) => Promise<unknown>, keptExists = true) {
    const r = await room({ keptExists });
    const id = await approved(r);
    expect((await pass(r.room)).outcome).toBe("next");
    expect((await releaseOf(r, id)).script_release_id).toBe(r.old);
    await change(r);
    return { r, id, after: await pass(r.room) };
  }

  it("is uploaded again when Cloudflare's read at the switch says the kept script is gone, though it was there before", async () => {
    await github("/seed", repository());
    const { r, id, after } = await atSwitch((r) => deleteAtProvider(r.kept));
    expect(after.outcome).toBe("next");
    const own = `${r.label}.${id}`;
    expect(await releaseOf(r, id)).toEqual({ state: "uploading", script_name: own, script_release_id: id, failure_code: null });
    expect(await defaultHost(r)).toEqual({ script_name: r.live, version: 5 });
    expect(JSON.parse((await all(r.room, "SELECT new_json FROM audit_event WHERE action = 'release.rollback_uploads'"))[0].new_json)).toEqual({ state: "uploading", reason: "rollback_script_gone" });
    // Uploaded as any release: an upload attempt of the room's, and the deployment's read budget.
    const uploaded = await pass(r.room);
    expect(uploaded.outcome, JSON.stringify(uploaded)).toBe("next");
    expect(await all(r.room, "SELECT release_id FROM release_upload_attempt")).toEqual([{ release_id: id }]);
    expect(await inModeration((s) => s.exec("SELECT release_id FROM release_reads WHERE release_id = ?", id).toArray())).toEqual([{ release_id: id }]);
    expect((await uploadState(own)).written).not.toBeNull();
    expect((await pass(r.room)).state).toBe("live");
    expect(await defaultHost(r)).toEqual({ script_name: own, version: 6 });
  });

  it("starts as an upload when the room's rows already say it can't switch", async () => {
    for (const [why, statement] of [
      ["nothing kept", "UPDATE release_config SET kept_previous = NULL"],
      ["the kept script queued for deletion", "INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) SELECT kept_previous, (SELECT label FROM app_label WHERE current = 1), 1, 1 FROM release_config"],
    ] as const) {
      const r = await room();
      const asked = await rollback(r);
      await inRoom(r.room, (s) => void s.exec(statement));
      expect((await approve(r, asked.body.id)).body.state, why).toBe("queued");
      expect((await pass(r.room)).outcome, why).toBe("next");
      expect(await releaseOf(r, asked.body.id), why).toMatchObject({ script_name: `${r.label}.${asked.body.id}`, script_release_id: asked.body.id });
      expect(await reads(r.kept), why).toBe(0);
    }
  });

  it("is uploaded again when the room's rows change before the switch, or a takedown finding is open against the script", async () => {
    for (const [why, change, code] of [
      ["the kept script queued for deletion", (r: Room) => inRoom(r.room, (s) => void s.exec("INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES (?, ?, 1, 1)", r.kept, r.label)), "rollback_script_deleting"],
      ["another script kept", (r: Room) => inRoom(r.room, (s) => void s.exec("UPDATE release_config SET kept_previous = ?", `${r.label}.rel_${"9".repeat(32)}`)), "rollback_not_kept"],
      ["a takedown finding against it", (r: Room) => inModeration((s) => void s.exec("INSERT INTO takedown_finding (code, subject, first_seen_at, last_seen_at) VALUES ('script_without_room', ?, 1, 1)", r.kept)), "rollback_finding_open"],
    ] as const) {
      const { r, id, after } = await atSwitch(change);
      expect(after.outcome, why).toBe("next");
      expect(await releaseOf(r, id), why).toMatchObject({ state: "uploading", script_release_id: id });
      expect(await defaultHost(r), why).toEqual({ script_name: r.live, version: 5 });
      const [audited] = await all(r.room, "SELECT new_json FROM audit_event WHERE action = 'release.rollback_uploads'");
      expect(JSON.parse(audited.new_json).reason, why).toBe(code);
    }
  });

  it("decides nothing while Cloudflare's read gives no answer, and switches nothing", async () => {
    const { r, id, after } = await atSwitch(async (r) => {
      await deleteAtProvider(r.kept);
      // The provider's upload part answers this script's next read with a 500.
      await content("upload-fault", `script=${r.kept}`, { op: "read", times: 1, status: 500 });
    });
    expect([after.outcome, after.code]).toEqual(["retry", "rollback_script_unread"]);
    expect(await releaseOf(r, id)).toMatchObject({ state: "uploading", script_name: r.kept, script_release_id: r.old });
    expect(await defaultHost(r)).toEqual({ script_name: r.live, version: 5 });
    expect(await config(r)).toMatchObject({ in_flight_release: null });
  });

  it("fails, switching nothing, on the release's own recheck: the epoch, the commit and the reviewer rule", async () => {
    for (const [why, statement, code] of [
      ["the room's epoch moved", "UPDATE release_config SET release_epoch = 3", "release_epoch_moved"],
      ["the commit isn't releasable", "UPDATE task_change SET merge_state = 'failed' WHERE task_id = 'tsk_rb_old'", "commit_not_releasable"],
      ["the room now requires a person as reviewer", "UPDATE workspace SET require_person_review = 1; UPDATE task_change SET reviewer_id = 'agt_rb_reviewer' WHERE task_id = 'tsk_rb_old'", "reviewer_rule_changed"],
      ["the app suspended", "UPDATE app_label SET suspended_at = 1, suspension_reason = 'abuse'", "app_suspended"],
    ] as const) {
      const { r, id } = await atSwitch((r) => inRoom(r.room, (s) => { for (const one of statement.split("; ")) s.exec(one); }));
      expect(await releaseOf(r, id), why).toMatchObject({ state: "failed", failure_code: code });
      // Never switched: the host is as it was, at its version, and the kept script is still kept, not queued.
      expect(await defaultHost(r), why).toEqual({ script_name: r.live, version: 5 });
      expect(await config(r), why).toMatchObject({ kept_previous: r.kept, in_flight_release: null });
      expect(await queuedScripts(r), why).toEqual([]);
    }
  });
});
