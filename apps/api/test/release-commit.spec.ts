import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet } from "./alarm";

// M6 step 5, the second PR: starting a release's upload, committing it live, and ending one that can't go on (ADR
// 0010's "The release job", steps 1 and 5). Nothing takes a release's request yet (step 6) and nothing calls these
// commands, so each test writes the rows a release would have straight into the room, through the test pool, and
// calls the room's internal paths.
//
// **No test here asks the provider anything.** The stand-in provider is one for the whole run, and `takedown.spec.ts`
// resets it, so each room here has its provider switched off, and what is read is the room's own state. That the
// applier serves nothing of a release the room hasn't recorded live, and that the delete job keeps an uploading
// release's script, are shown at the provider in `takedown.spec.ts`.
//
// One room is built where a release may go live. Each test then changes one thing.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; departure?: object };
const ORG = "org_rc";
const OWNER: Who = { id: "per_rc_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const OPERATOR: Who = { id: "per_operator_one", kind: "person", org: "org_rc_ops" };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 }, ...(who.departure ? { departure: who.departure } : {}) })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "idempotency-key": `rc-key-${++counter}` };
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;

/** Release switched on for the test Worker, as no deployment is, while `run` runs. */
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

const REL = `rel_${"5c".repeat(16)}`;
const PREV = `rel_${"4b".repeat(16)}`;
const OTHER = `rel_${"6d".repeat(16)}`;
const SHA = "cd".repeat(20);
const REPO_ID = 987650001;
const TASK = "tsk_rc_1";
const HOUR = 60 * 60 * 1000;
let rooms = 0;

type Healthy = { room: string; requester: Who; admin: Who; org: string; label: string; host: string; script: string; prev: string };
/**
 * A room where a release may go live: everything the recheck asks for holds, and the room's default host serves an
 * earlier release, which its applier has applied. The room's provider is switched off.
 * `state` is this release's: queued by default; from `uploading` on it has its script's name and a fresh start time.
 */
async function healthy(opts: { org?: string; state?: string } = {}): Promise<Healthy> {
  const org = opts.org ?? ORG;
  const owner = { ...OWNER, org, adminOrgs: [org] };
  const room: string = (await api(owner, "POST", "/v1/workspaces", { name: "Release" })).body.id;
  await alarmQuiet(stub(room));
  const n = ++rooms;
  const requester: Who = { id: `per_rc_req_${n}`, kind: "person", org };
  const admin: Who = { id: `per_rc_adm_${n}`, kind: "person", org };
  const label = `rc${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  const [script, prev] = [`${label}.${REL}`, `${label}.${PREV}`];
  const state = opts.state ?? "queued";
  const named = state !== "queued" && state !== "awaiting_approval";
  await inRoom(room, (sql) => {
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, OWNER.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `rc-${n}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/release', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO_ID, OWNER.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_rc', ?, 'github', ?, 'deploy', ?, 1)", requester.id, REPO_ID, OWNER.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, OWNER.id, admin.id);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO_ID, SHA, admin.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", OWNER.id);
    const release = (id: string, state: string, withScript: boolean, approved: boolean) => sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, ?, ?, 3, 2, ?, ?, ?, ?, 1, ?, ?, ?, 1)`,
      id, SHA, state, label, TASK, withScript ? `${label}.${id}` : null, withScript ? id : null, requester.id, approved ? OWNER.id : null, approved ? 1 : null, withScript ? Date.now() : null);
    release(PREV, "served", true, true);
    release(REL, state, named, state !== "awaiting_approval");
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, prev);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, prev);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, room).run();
  return { room, requester, admin, org, label, host, script, prev };
}

type Answer = { status: number; body: any };
const command = (path: string) => (room: string, release: string = REL): Promise<Answer> =>
  switchedOn(() => stub(room).fetch(`https://do/internal/${path}`, { method: "POST", body: JSON.stringify({ release_id: release }) }).then(async (r: Response) => ({ status: r.status, body: (await r.json()) as any })));
const recheck = command("release-recheck");
const start = command("release-start-upload");
const commit = command("release-commit-live");
const check = (room: string, body: object) => stub(room).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify(body) }).then((r: Response) => r.json() as Promise<any>);

const row = (room: string, release: string = REL) => inRoom(room, (sql) => sql.exec("SELECT state, failure_code, script_name, upload_started_at IS NOT NULL AS started FROM release WHERE id = ?", release).one());
const hostRow = (room: string) => inRoom(room, (sql) => sql.exec("SELECT script_name, release_id, version, flight_version, flight_before FROM serve_state").one());
const flight = (room: string) => inRoom(room, (sql) => sql.exec("SELECT in_flight_release, in_flight_script, in_flight_epoch, in_flight_at IS NOT NULL AS at, release_epoch FROM release_config").one());
const applied = (room: string) => inRoom(room, (sql) => sql.exec("SELECT applied_version, applied_script, attempts, last_code FROM serve_apply").one());
const queued = (room: string) => all(room, "SELECT script_name, unpublish_epoch, gone_at IS NOT NULL AS gone, last_code FROM script_delete ORDER BY script_name");
const trail = (room: string) => inRoom(room, (sql) => ({
  events: sql.exec("SELECT type, actor_id, subject_id, reason FROM event WHERE type LIKE 'release.%' ORDER BY seq").toArray(),
  audit: sql.exec("SELECT actor_id, action, target_id, prior_json, new_json FROM audit_event WHERE action LIKE 'release.%' ORDER BY seq").toArray(),
}));
/**
 * Everything a command could write: the release, the host, the flight, the applier's record, the queue, the events,
 * the audit and the outbox. The room's alarm is run out first, so what an earlier step left to send has been sent or
 * is waiting, and the outbox is read as what is still owed, whose send counts move by themselves.
 */
const everything = async (room: string) => {
  await alarmQuiet(stub(room));
  return inRoom(room, (sql) => JSON.stringify([
    ...["release", "serve_state", "release_config", "serve_apply", "script_delete", "event", "audit_event"].map((table) => sql.exec(`SELECT * FROM ${table}`).toArray()),
    sql.exec("SELECT event_id, recipient_principal_id FROM outbox ORDER BY event_id, recipient_principal_id").toArray(),
  ]));
};
const pass = (room: string) => alarmPass(stub(room));
const departs = (who: Who) => api({ ...who, departure: { person: who.id, org: who.org, left_at: Date.now() } }, "POST", "/v1/org-departures", {});
const between = (room: string, ...statements: string[]) => inRoom(room, (sql) => {
  sql.exec("CREATE TABLE test_release_between_reads (statement TEXT)");
  for (const statement of statements) sql.exec("INSERT INTO test_release_between_reads (statement) VALUES (?)", statement);
});
const betweenLeft = (room: string) => inRoom(room, (sql) => sql.exec("SELECT name FROM sqlite_master WHERE name = 'test_release_between_reads'").toArray().length === 1);
const UNKNOWN = [503, "standing_unknown"];
const refused = (answer: Answer) => [answer.status, answer.body?.error?.code];

/** The stop for the whole content domain, set, or made unreadable, while `run` runs. Its home is the Moderation object. */
async function withStop<T>(how: "set" | "unreadable", run: (clear: () => Promise<void>) => Promise<T>): Promise<T> {
  await moderation().fetch("https://do/content-stop");
  const clear = () => inModeration((s) => { s.exec("DROP TABLE IF EXISTS test_stop_unreadable"); s.exec("UPDATE content_stop SET stopped = 0, reason = NULL, at = NULL, version = version + 1"); });
  await inModeration((s) => {
    if (how === "unreadable") s.exec("CREATE TABLE test_stop_unreadable (x INTEGER)");
    else s.exec("INSERT INTO content_stop (singleton, stopped, reason, at, version, updated_at) VALUES (1, 1, 'illegal', 1, 1, 1) ON CONFLICT (singleton) DO UPDATE SET stopped = 1, reason = 'illegal', at = 1, version = version + 1");
  });
  try { return await run(clear); } finally { await clear(); }
}

/** The host as the room had it before any commit, and as a set-back leaves it: the earlier release, and no flight. */
const before = (h: Healthy, version: number) => ({ script_name: h.prev, release_id: PREV, version, flight_version: null, flight_before: null });
const NO_FLIGHT = { in_flight_release: null, in_flight_script: null, in_flight_epoch: null, at: 0, release_epoch: 2 };

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("starting a release's upload", () => {
  it("moves a queued release whose recheck holds to uploading, with its script's name and the time, once", async () => {
    const h = await healthy();
    const started = await start(h.room);
    expect(started).toEqual({ status: 200, body: { release_id: REL, state: "uploading", rechecked: true, reason: null, script: h.script } });
    expect(await row(h.room)).toEqual({ state: "uploading", failure_code: null, script_name: h.script, started: 1 });
    const after = await trail(h.room);
    expect(after.events).toEqual([{ type: "release.upload_started", actor_id: "podster", subject_id: REL, reason: null }]);
    expect(after.audit.map((a: any) => [a.actor_id, a.action, a.target_id, JSON.parse(a.prior_json), JSON.parse(a.new_json)])).toEqual([["podster", "release.upload_started", REL, { state: "queued" }, { state: "uploading" }]]);
    // Nothing is served on it, and nothing is staged: the host and the flight are as they were.
    expect([await hostRow(h.room), await flight(h.room)]).toEqual([before(h, 5), NO_FLIGHT]);
    // Asked again, it is the recheck and the same name, and nothing more is written.
    const all = await everything(h.room);
    expect((await start(h.room)).body).toEqual(started.body);
    expect(await everything(h.room)).toBe(all);
    await alarmQuiet(stub(h.room));
  });

  it("fails the release with core's reason where the recheck doesn't hold, and names no script", async () => {
    const h = await healthy();
    await inRoom(h.room, (s) => void s.exec("UPDATE release_config SET enabled = 0"));
    expect((await start(h.room)).body).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_off", script: null });
    expect(await row(h.room)).toEqual({ state: "failed", failure_code: "release_off", script_name: null, started: 0 });
    // It never had a script, so there is none to delete.
    expect(await queued(h.room)).toEqual([]);
    await alarmQuiet(stub(h.room));
  });

  it("decides nothing when a fact can't be read, and writes nothing", async () => {
    const h = await healthy();
    const all = await everything(h.room);
    await withStop("unreadable", async () => expect(refused(await start(h.room))).toEqual(UNKNOWN));
    expect(await everything(h.room)).toBe(all);
    await alarmQuiet(stub(h.room));
  });

  it("answers a release that isn't the job's as it is, and changes nothing", async () => {
    for (const state of ["awaiting_approval", "live", "served", "failed"]) {
      const h = await healthy({ state });
      const all = await everything(h.room);
      expect((await start(h.room)).body, state).toEqual({ release_id: REL, state, rechecked: false, reason: null, script: null });
      expect(await everything(h.room), state).toBe(all);
      await alarmQuiet(stub(h.room));
    }
  });
});

describe("committing a release live", () => {
  it("stages it on the room's hosts, asks everyone again, and only then records it live and lets it be served", async () => {
    const h = await healthy();
    await start(h.room);
    const committed = await commit(h.room);
    expect(committed).toEqual({ status: 200, body: { release_id: REL, state: "live", rechecked: true, reason: null } });
    expect(await row(h.room)).toMatchObject({ state: "live", failure_code: null });
    // The host names this release's script, one version on, with what it served before kept beside it; the flight is
    // this release's, under the epoch it started under.
    expect(await hostRow(h.room)).toEqual({ script_name: h.script, release_id: REL, version: 6, flight_version: 6, flight_before: h.prev });
    expect(await flight(h.room)).toEqual({ in_flight_release: REL, in_flight_script: h.script, in_flight_epoch: 2, at: 1, release_epoch: 2 });
    expect((await trail(h.room)).events.map((e: any) => [e.type, e.actor_id, e.subject_id])).toEqual([["release.upload_started", "podster", REL], ["release.live", "podster", REL]]);
    // The entry is the applier's to write: the host is owed a pass, at its new version, with no wait on it.
    expect(await applied(h.room)).toEqual({ applied_version: 5, applied_script: h.prev, attempts: 0, last_code: null });
    // Asked again, it is live, and nothing changes.
    const all = await everything(h.room);
    expect((await commit(h.room)).body).toEqual({ release_id: REL, state: "live", rechecked: false, reason: null });
    expect(await everything(h.room)).toBe(all);
    await alarmQuiet(stub(h.room));
  });

  it("leaves a staged release unserved until it is confirmed, however often it is asked and the applier runs", async () => {
    const h = await healthy({ state: "uploading" });
    await withStop("unreadable", async (clear) => {
      // The stage is the room's own. The stop can't be read, so the commit is undecided: refused, to be asked again.
      expect(refused(await commit(h.room))).toEqual(UNKNOWN);
      expect(await row(h.room)).toMatchObject({ state: "uploading", failure_code: null });
      expect(await hostRow(h.room)).toEqual({ script_name: h.script, release_id: REL, version: 6, flight_version: 6, flight_before: h.prev });
      expect((await flight(h.room)).in_flight_release).toBe(REL);
      expect((await trail(h.room)).events).toEqual([]);
      // The applier runs, with a provider, twice. For a release that isn't recorded live it stops before it asks the
      // provider anything, and records the host as waiting: what it last applied is still the earlier release.
      await inRoom(h.room, (s) => void s.exec("DROP TABLE test_content_provider_off"));
      await pass(h.room);
      await inRoom(h.room, (s) => void s.exec("UPDATE serve_apply SET next_attempt_at = 0 WHERE next_attempt_at IS NOT NULL"));
      await pass(h.room);
      await inRoom(h.room, (s) => void s.exec("CREATE TABLE test_content_provider_off (x INTEGER)"));
      expect(await applied(h.room)).toEqual({ applied_version: 5, applied_script: h.prev, attempts: 2, last_code: "release_not_confirmed" });
      // Asked again while still unreadable: still undecided, and the stage isn't made twice.
      expect(refused(await commit(h.room))).toEqual(UNKNOWN);
      expect((await hostRow(h.room)).version).toBe(6);
      // Readable again, the same command confirms it, and the host is due at once: no wait is left behind.
      await clear();
      expect((await commit(h.room)).body).toEqual({ release_id: REL, state: "live", rechecked: true, reason: null });
      expect(await applied(h.room)).toEqual({ applied_version: 5, applied_script: h.prev, attempts: 0, last_code: null });
      expect(await all(h.room, "SELECT attempt_version, next_attempt_at FROM serve_apply")).toEqual([{ attempt_version: null, next_attempt_at: null }]);
    });
    await alarmQuiet(stub(h.room));
  });

  // A pass that held is an answer about then. Each of these happens after the recheck and the start both held, and
  // before the commit, which asks everything again itself.
  const later: [string, string, (h: Healthy) => Promise<unknown>, (h: Healthy) => Promise<unknown>][] = [
    ["the stop for the whole content domain set", "release_stopped", () => moderation().fetch("https://do/content-stop").then(() => inModeration((s) => void s.exec("INSERT INTO content_stop (singleton, stopped, reason, at, version, updated_at) VALUES (1, 1, 'illegal', 1, 1, 1) ON CONFLICT (singleton) DO UPDATE SET stopped = 1, reason = 'illegal', at = 1, version = version + 1"))),
      () => inModeration((s) => void s.exec("UPDATE content_stop SET stopped = 0, reason = NULL, at = NULL, version = version + 1"))],
    ["the requester having left their organization", "requester_lost_authority", (h) => departs(h.requester), async () => {}],
    ["the approver having left their organization", "approver_lost_authority", async (h) => { await inRoom(h.room, (s) => void s.exec("UPDATE release SET approved_by = ?", h.admin.id)); await departs(h.admin); }, async () => {}],
    ["the grant's giver having left their organization", "requester_lost_authority", async (h) => { await inRoom(h.room, (s) => void s.exec("UPDATE provider_grant SET delegated_by = ?", h.admin.id)); await departs(h.admin); }, async () => {}],
    ["the organization's delegation taken back", "release_not_delegated", (h) => api(OPERATOR, "PUT", `/v1/orgs/${h.org}/provisioning-delegation`, { granted: false }), (h) => api(OPERATOR, "PUT", `/v1/orgs/${h.org}/provisioning-delegation`, { granted: true })],
  ];
  for (const [what, reason, change, undo] of later) {
    it(`never trusts an earlier pass: ${what} since then fails it and sets its hosts back`, async () => {
      const h = await healthy({ org: `org_rc_later_${rooms}` });
      expect((await recheck(h.room)).body).toMatchObject({ state: "queued", rechecked: true });
      expect((await start(h.room)).body).toMatchObject({ state: "uploading", rechecked: true });
      expect((await recheck(h.room)).body).toMatchObject({ state: "uploading", rechecked: true });
      await change(h);
      try {
        expect((await commit(h.room)).body).toEqual({ release_id: REL, state: "failed", rechecked: true, reason });
      } finally { await undo(h); }
      expect(await row(h.room)).toMatchObject({ state: "failed", failure_code: reason });
      // Staged, then set back: the host is on the earlier release again, two versions on, and the flight is closed.
      expect([await hostRow(h.room), await flight(h.room)]).toEqual([before(h, 7), NO_FLIGHT]);
      // Its script is queued for deletion, as the room's own act and under no unpublish.
      expect((await queued(h.room)).map((q: any) => [q.script_name, q.unpublish_epoch])).toEqual([[h.script, null]]);
      expect((await trail(h.room)).events.at(-1)).toEqual({ type: "release.failed", actor_id: "podster", subject_id: REL, reason });
      // It was never recorded live, so the applier never had it to write: what it last applied is the earlier release.
      expect(await applied(h.room)).toMatchObject({ applied_version: 5, applied_script: h.prev });
      await alarmQuiet(stub(h.room));
    });
  }

  it("fails on a fact of the room's own before it stages anything", async () => {
    const h = await healthy({ state: "uploading" });
    await inRoom(h.room, (s) => void s.exec("UPDATE workspace SET visibility = 'private'"));
    expect((await commit(h.room)).body).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_needs_public_room" });
    // Never staged: the host's version didn't move.
    expect([await hostRow(h.room), await flight(h.room)]).toEqual([before(h, 5), NO_FLIGHT]);
    expect((await queued(h.room)).map((q: any) => q.script_name)).toEqual([h.script]);
    await alarmQuiet(stub(h.room));
  });

  it("decides between its reads and its confirm from the room's rows as they are by then", async () => {
    // A fact of the room's own that changes in between is read as it now is: the release fails and is set back.
    const own = await healthy({ state: "uploading" });
    await between(own.room, "UPDATE release_config SET enabled = 0");
    expect((await commit(own.room)).body).toMatchObject({ state: "failed", reason: "release_off" });
    expect([await hostRow(own.room), await flight(own.room)]).toEqual([before(own, 7), NO_FLIGHT]);
    // Someone else named in between: what was read is about another person, so nothing is decided. The stage stays,
    // unserved, and the command asked again reads about the right one.
    const who = await healthy({ state: "uploading" });
    await between(who.room, `UPDATE release SET approved_by = '${who.admin.id}' WHERE id = '${REL}'`);
    expect(refused(await commit(who.room))).toEqual(UNKNOWN);
    expect(await row(who.room)).toMatchObject({ state: "uploading" });
    expect((await hostRow(who.room)).script_name).toBe(who.script);
    expect((await commit(who.room)).body).toMatchObject({ state: "live", rechecked: true });
    for (const h of [own, who]) await alarmQuiet(stub(h.room));
  });

  it("is ended by an unpublish that lands between its stage and its confirm, and never comes back", async () => {
    const h = await healthy({ state: "uploading" });
    await withStop("unreadable", async () => expect(refused(await commit(h.room))).toEqual(UNKNOWN));
    expect((await hostRow(h.room)).script_name).toBe(h.script);
    // An operator suspends the app while the release is staged and unconfirmed.
    expect((await switchedOn(() => api(OPERATOR, "POST", `/v1/moderation/apps/${h.label}/suspend`, { reason: "abuse" }))).status).toBe(200);
    expect(await row(h.room)).toMatchObject({ state: "failed", failure_code: "release_epoch_moved" });
    expect(await hostRow(h.room)).toEqual({ script_name: null, release_id: null, version: 7, flight_version: null, flight_before: null });
    expect(await flight(h.room)).toEqual({ ...NO_FLIGHT, release_epoch: 3 });
    // Both scripts are queued, under the unpublish: the one that was served, and the staged one.
    expect((await queued(h.room)).map((q: any) => [q.script_name, q.unpublish_epoch])).toEqual([[h.prev, 3], [h.script, 3]].sort());
    // The commit asked again finds it ended, and changes nothing.
    const all = await everything(h.room);
    expect((await commit(h.room)).body).toEqual({ release_id: REL, state: "failed", rechecked: false, reason: null });
    expect(await everything(h.room)).toBe(all);
    await alarmQuiet(stub(h.room));
  });

  it("waits while another release's flight is open, and decides nothing", async () => {
    const h = await healthy({ state: "uploading" });
    await inRoom(h.room, (s) => void s.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, 'uploading', ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, ?, 1)`, OTHER, SHA, h.label, TASK, `${h.label}.${OTHER}`, OTHER, h.requester.id, OWNER.id, Date.now()));
    // The first is staged and unconfirmed: its flight is open.
    await withStop("unreadable", async () => expect(refused(await commit(h.room))).toEqual(UNKNOWN));
    const all = await everything(h.room);
    expect((await commit(h.room, OTHER)).body).toEqual({ release_id: OTHER, state: "uploading", rechecked: false, reason: null, waiting: "release_in_flight" });
    expect(await everything(h.room)).toBe(all);
    // And once the first is live, its flight stays open until its marker, which is the job's: the other still waits.
    expect((await commit(h.room)).body).toMatchObject({ state: "live" });
    expect((await commit(h.room, OTHER)).body).toMatchObject({ state: "uploading", waiting: "release_in_flight" });
    expect(await row(h.room, OTHER)).toMatchObject({ state: "uploading", failure_code: null });
    await alarmQuiet(stub(h.room));
  });

  it("never commits a script that was queued for deletion, gone or not", async () => {
    for (const gone of [null, 5]) {
      const h = await healthy({ state: "uploading" });
      await inRoom(h.room, (s) => void s.exec("INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at, gone_at) VALUES (?, ?, 2, 2, ?)", h.script, h.label, gone));
      expect((await commit(h.room)).body, String(gone)).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_script_deleted" });
      expect([await hostRow(h.room), await flight(h.room)], String(gone)).toEqual([before(h, 5), NO_FLIGHT]);
      await alarmQuiet(stub(h.room));
    }
  });

  it("answers a release that isn't uploading as it is, with nothing asked of anyone", async () => {
    for (const state of ["awaiting_approval", "queued", "uncertain", "live", "served", "failed"]) {
      const h = await healthy({ state });
      // Left for the point just after the outside reads. A command that asked nobody never gets there.
      await between(h.room, "UPDATE release_config SET enabled = 0");
      const all = await everything(h.room);
      for (const ask of [commit, ...(state === "queued" || state === "uncertain" ? [] : [recheck, start])]) {
        expect((await ask(h.room)).body, state).toMatchObject({ release_id: REL, state, rechecked: false, reason: null });
      }
      expect([await everything(h.room), await betweenLeft(h.room)], state).toEqual([all, true]);
      await alarmQuiet(stub(h.room));
    }
  });
});

describe("what is read first", () => {
  it("fails on a fact that was read, whatever else couldn't be", async () => {
    // The organization's own object doesn't answer (test builds: an ID with this prefix), which alone is undecided.
    const down = await healthy({ org: "org_unavailable_rc_1" });
    const all = await everything(down.room);
    expect(refused(await recheck(down.room))).toEqual(UNKNOWN);
    expect(refused(await start(down.room))).toEqual(UNKNOWN);
    expect(await everything(down.room)).toBe(all);
    // With the stop set as well, the stop was read and fails: the release ends, without waiting for the organization.
    await withStop("set", async () => expect((await recheck(down.room)).body).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_stopped" }));
    // The same for a person whose record doesn't answer, beside a fact of the room's own.
    const person = await healthy();
    await inRoom(person.room, (s) => {
      s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES ('per_unavailable_rc', 'person', ?, 'admin', ?, 1)", person.org, OWNER.id);
      s.exec("UPDATE release SET approved_by = 'per_unavailable_rc' WHERE id = ?", REL);
    });
    expect(refused(await recheck(person.room))).toEqual(UNKNOWN);
    await inRoom(person.room, (s) => void s.exec("UPDATE task SET status = 'submitted'"));
    expect((await recheck(person.room)).body).toMatchObject({ state: "failed", reason: "commit_not_releasable" });
    // And someone who fails on the room's own rows fails, whatever their record would have said.
    const demoted = await healthy();
    await inRoom(demoted.room, (s) => {
      s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES ('per_unavailable_rc', 'person', ?, 'member', ?, 1)", demoted.org, OWNER.id);
      s.exec("UPDATE release SET approved_by = 'per_unavailable_rc' WHERE id = ?", REL);
    });
    expect((await recheck(demoted.room)).body).toMatchObject({ state: "failed", reason: "approver_lost_authority" });
    for (const h of [down, person, demoted]) await alarmQuiet(stub(h.room));
  });

  it("commits nothing while the organization's object doesn't answer", async () => {
    const h = await healthy({ org: "org_unavailable_rc_2", state: "uploading" });
    expect(refused(await commit(h.room))).toEqual(UNKNOWN);
    expect(await row(h.room)).toMatchObject({ state: "uploading", failure_code: null });
    // Staged in the room, and not recorded live: the applier has nothing it may write.
    expect((await hostRow(h.room)).script_name).toBe(h.script);
    expect((await trail(h.room)).events).toEqual([]);
    await alarmQuiet(stub(h.room));
  });
});

describe("a release that can't go on", () => {
  it("is failed once its upload is an hour old, by any release command and by the reconcile's question", async () => {
    const asks: [string, (h: Healthy) => Promise<unknown>][] = [
      ["the recheck", (h) => recheck(h.room)],
      ["the commit", (h) => commit(h.room)],
      ["the reconcile's wake", (h) => check(h.room, { kind: "wake" })],
      ["the reconcile finding its script", (h) => check(h.room, { kind: "script", script: h.script })],
    ];
    for (const state of ["uploading", "uncertain"]) {
      for (const [what, ask] of asks) {
        // A commit answers a release that isn't uploading as it is, before any transaction: it ends nothing.
        if (state === "uncertain" && what === "the commit") continue;
        const h = await healthy({ state });
        // A moment inside the hour: nothing ends.
        await inRoom(h.room, (s) => void s.exec("UPDATE release SET upload_started_at = ? WHERE id = ?", Date.now() - HOUR + 60_000, REL));
        await check(h.room, { kind: "wake" });
        expect((await row(h.room)).state, `${state} ${what}`).toBe(state);
        await inRoom(h.room, (s) => void s.exec("UPDATE release SET upload_started_at = ? WHERE id = ?", Date.now() - HOUR, REL));
        await ask(h);
        expect(await row(h.room), `${state} ${what}`).toMatchObject({ state: "failed", failure_code: "release_upload_expired" });
        expect((await queued(h.room)).map((q: any) => q.script_name), `${state} ${what}`).toEqual([h.script]);
        expect((await trail(h.room)).events, `${state} ${what}`).toEqual([{ type: "release.failed", actor_id: "podster", subject_id: REL, reason: "release_upload_expired" }]);
        await alarmQuiet(stub(h.room));
      }
    }
  });

  it("is set back when it expires while staged and unconfirmed", async () => {
    const h = await healthy({ state: "uploading" });
    await withStop("unreadable", async () => expect(refused(await commit(h.room))).toEqual(UNKNOWN));
    await inRoom(h.room, (s) => void s.exec("UPDATE release SET upload_started_at = ? WHERE id = ?", Date.now() - HOUR, REL));
    expect((await commit(h.room)).body).toEqual({ release_id: REL, state: "failed", rechecked: false, reason: null });
    expect(await row(h.room)).toMatchObject({ state: "failed", failure_code: "release_upload_expired" });
    expect([await hostRow(h.room), await flight(h.room)]).toEqual([before(h, 7), NO_FLIGHT]);
    await alarmQuiet(stub(h.room));
  });

  it("has its script queued when the recheck fails it while uploading, which isn't told to operators as a reconcile's deletion", async () => {
    const h = await healthy({ state: "uploading" });
    await inRoom(h.room, (s) => void s.exec("UPDATE release_config SET enabled = 0"));
    expect((await recheck(h.room)).body).toMatchObject({ state: "failed", reason: "release_off" });
    expect((await queued(h.room)).map((q: any) => [q.script_name, q.unpublish_epoch])).toEqual([[h.script, null]]);
    expect((await check(h.room, { kind: "wake" })).findings).toEqual([]);
    // A script a pass queues itself is still told, as before.
    const stray = `${h.label}.${OTHER}`;
    expect((await check(h.room, { kind: "script", script: stray })).findings).toEqual([{ code: "script_delete_queued", subject: stray, detail: "queued" }]);
    await alarmQuiet(stub(h.room));
  });

  it("ends with an unpublish if it hadn't gone live: awaiting approval, queued, uploading or uncertain", async () => {
    for (const state of ["awaiting_approval", "queued", "uploading", "uncertain"]) {
      const h = await healthy({ state });
      expect((await switchedOn(() => api(OPERATOR, "POST", `/v1/moderation/apps/${h.label}/suspend`, { reason: "abuse" }))).status, state).toBe(200);
      expect(await row(h.room), state).toMatchObject({ state: "failed", failure_code: "release_epoch_moved" });
      // The release that was served is unpublished, as before, and isn't failed.
      expect((await row(h.room, PREV)).state, state).toBe("unpublished");
      const scripts = (await queued(h.room)).map((q: any) => q.script_name);
      expect(scripts, state).toEqual(["uploading", "uncertain"].includes(state) ? [h.prev, h.script].sort() : [h.prev]);
      expect((await trail(h.room)).events, state).toEqual([{ type: "release.failed", actor_id: "podster", subject_id: REL, reason: "release_epoch_moved" }]);
      await alarmQuiet(stub(h.room));
    }
  });

  it("leaves a live and a served release untouched when the organization's delegation is taken back", async () => {
    // The delegation only refuses new releases and commits (decision 218). What is live stays live.
    const org = "org_rc_taken";
    const h = await healthy({ org, state: "live" });
    await inRoom(h.room, (s) => {
      s.exec("UPDATE serve_state SET release_id = ?, script_name = ?, version = 6, flight_version = 6, flight_before = ?", REL, h.script, h.prev);
      s.exec("UPDATE release_config SET in_flight_release = ?, in_flight_script = ?, in_flight_epoch = 2, in_flight_at = 1", REL, h.script);
      s.exec("UPDATE serve_apply SET applied_version = 6, applied_script = ?", h.script);
    });
    const all = await everything(h.room);
    expect((await api(OPERATOR, "PUT", `/v1/orgs/${org}/provisioning-delegation`, { granted: false })).status).toBe(200);
    try {
      for (const release of [REL, PREV]) for (const ask of [recheck, start, commit]) expect((await ask(h.room, release)).body).toMatchObject({ release_id: release, state: release === REL ? "live" : "served", rechecked: false });
      await check(h.room, { kind: "wake" });
    } finally { await api(OPERATOR, "PUT", `/v1/orgs/${org}/provisioning-delegation`, { granted: true }); }
    expect(await everything(h.room)).toBe(all);
    await alarmQuiet(stub(h.room));
  });
});

describe("the two paths", () => {
  it("can't be reached by any client: the Worker forwards neither", async () => {
    const h = await healthy();
    const all = await everything(h.room);
    await switchedOn(async () => {
      for (const who of [OWNER, h.requester, OPERATOR]) {
        for (const name of ["release-start-upload", "release-commit-live"]) {
          for (const path of [`/internal/${name}`, `/v1/workspaces/${h.room}/internal/${name}`, `/v1/workspaces/${h.room}/${name}`, `/v1/internal/${name}?ws=${h.room}`]) {
            expect((await api(who, "POST", path, { release_id: REL })).status, `${who.id} ${path}`).toBeGreaterThanOrEqual(400);
          }
        }
      }
    });
    expect(await everything(h.room)).toBe(all);
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    const naming = Object.entries(sources).filter(([, text]) => /release-start-upload|release-commit-live|INTERNAL_RELEASE_(START_UPLOAD|COMMIT_LIVE)/.test(text)).map(([name]) => name).sort();
    expect(naming).toEqual(["workspace.rs", "workspace/release_commit.rs"]);
    // And neither reads a read model.
    expect(sources["workspace/release_commit.rs"]).not.toMatch(/\.d1\(|"DB"|_index\b/);
    await alarmQuiet(stub(h.room));
  });

  it("answer only for a release the room has, by a well-formed ID", async () => {
    const h = await healthy();
    for (const ask of [start, commit]) {
      expect((await ask(h.room, `rel_${"00".repeat(16)}`)).status).toBe(404);
      for (const id of ["rel_short", "", `rel_${"ZZ".repeat(16)}`]) expect((await ask(h.room, id)).status, id).toBe(400);
    }
    expect(await row(h.room)).toMatchObject({ state: "queued" });
    await alarmQuiet(stub(h.room));
  });
});
