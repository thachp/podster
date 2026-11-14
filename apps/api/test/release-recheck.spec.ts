import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet } from "./alarm";

// M6 step 5, the first PR: the room's recheck of a release (ADR 0010's "The release job", step 1). On every pass the
// room gathers every fact `podster_core::release::recheck` asks for, from current state, and fails the release when
// one doesn't hold. Nothing takes a release's request yet (step 6) and nothing calls the recheck, so each test writes
// the rows a release would have straight into the room, through the test pool, and calls the room's internal path.
//
// One room is built where everything holds. Each test then changes one thing, and only that thing.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; departure?: object };
const ORG = "org_rr";
const OWNER: Who = { id: "per_rr_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const OPERATOR: Who = { id: "per_operator_one", kind: "person", org: "org_rr_ops" };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  const facts = isAgent ? { gen: 1, linker: { person: OWNER.id, since: 1 } } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 }, ...(who.departure ? { departure: who.departure } : {}) };
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...facts })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who) };
  if (method !== "GET") headers["idempotency-key"] = `rr-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;

/** Release switched on for the test Worker, as no deployment is, while `run` runs. */
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

const REL = `rel_${"5a".repeat(16)}`;
const SHA = "cd".repeat(20);
const REPO_ID = 987654321;
const TASK = "tsk_rr_1";
let people = 0;
/** Every room a test made, so each is left with no alarm run under way and none to come, pass or fail. */
const made: string[] = [];

type Healthy = { room: string; requester: Who; admin: Who; org: string };
/**
 * A room where a release's recheck holds: public, release on, a ready repository, a completed task whose commit
 * Podster's merge job merged and read back, a person who asked for the release and holds a `deploy` grant the owner
 * gave, and the owner as its approver. `org` gives the room an organization of its own, for a test that changes the
 * organization.
 */
async function healthy(opts: { org?: string; state?: string } = {}): Promise<Healthy> {
  const org = opts.org ?? ORG;
  const owner = { ...OWNER, org, adminOrgs: [org] };
  const room: string = (await api(owner, "POST", "/v1/workspaces", { name: "Release" })).body.id;
  made.push(room);
  await alarmQuiet(stub(room));
  const n = ++people;
  const requester: Who = { id: `per_rr_req_${n}`, kind: "person", org };
  const admin: Who = { id: `per_rr_adm_${n}`, kind: "person", org };
  await inRoom(room, (sql) => {
    // The two people's places in the room, as the room records them: a member who asked, and an admin.
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, OWNER.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `rr-${n}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/release', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO_ID, OWNER.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_rr', ?, 'github', ?, 'deploy', ?, 1)", requester.id, REPO_ID, OWNER.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, OWNER.id, admin.id);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO_ID, SHA, admin.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES ('rrlabel', 1, 1)");
    // No provider for this room: with one, and release switched on, the gate on the release path refuses every
    // release command (`release-commit.spec.ts`).
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", OWNER.id);
    sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, ?, 'rrlabel', 3, 2, ?, ?, 1, ?, 1, ?, 1)`, REL, SHA, opts.state ?? "queued", TASK, requester.id, OWNER.id, Date.now());
  });
  return { room, requester, admin, org };
}

const recheck = (room: string, release: string = REL) =>
  stub(room).fetch("https://do/internal/release-recheck", { method: "POST", body: JSON.stringify({ release_id: release }) }).then(async (r: Response) => ({ status: r.status, body: (await r.json()) as any }));
const row = (room: string) => inRoom(room, (sql) => sql.exec("SELECT state, failure_code, finished_at IS NOT NULL AS finished FROM release WHERE id = ?", REL).one());
const trail = (room: string) => inRoom(room, (sql) => ({
  events: sql.exec("SELECT type, actor_id, subject_id, reason FROM event WHERE type LIKE 'release.%' ORDER BY seq").toArray(),
  audit: sql.exec("SELECT actor_id, action, target_id, prior_json, new_json FROM audit_event WHERE action LIKE 'release.%' ORDER BY seq").toArray(),
}));
/** Everything a pass could write beside the release's own row, which each test reads by itself: the outbox included. */
const written = (room: string) => inRoom(room, (sql) => JSON.stringify(["release_config", "serve_state", "script_delete", "event", "audit_event", "outbox"].map((table) => sql.exec(`SELECT * FROM ${table}`).toArray())));
const HOLDS = { status: 200, body: { release_id: REL, state: "queued", rechecked: true, reason: null } };
const departs = (who: Who) => api({ ...who, departure: { person: who.id, org: who.org, left_at: Date.now() } }, "POST", "/v1/org-departures", {});
/** Leaves statements for the room to run between what it read outside and its transaction. Test builds only. */
const between = (room: string, ...statements: string[]) => inRoom(room, (sql) => {
  sql.exec("CREATE TABLE test_release_between_reads (statement TEXT)");
  for (const statement of statements) sql.exec("INSERT INTO test_release_between_reads (statement) VALUES (?)", statement);
});

afterEach(async () => { for (const room of made.splice(0)) await alarmQuiet(stub(room)); });
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("the room's recheck of a release", () => {
  it("holds in a room where everything holds, and changes nothing", async () => {
    const h = await healthy();
    expect(await switchedOn(() => recheck(h.room))).toEqual(HOLDS);
    expect(await row(h.room)).toEqual({ state: "queued", failure_code: null, finished: 0 });
    expect(await trail(h.room)).toEqual({ events: [], audit: [] });
    // And again: a pass that holds is a pass that can be run as often as the job likes.
    expect(await switchedOn(() => recheck(h.room))).toEqual(HOLDS);
  });

  it("fails the release with core's reason, once, audited as Podster's act and told to the room's managers", async () => {
    const h = await healthy();
    await inRoom(h.room, (sql) => sql.exec("UPDATE release_config SET enabled = 0"));
    const failed = await switchedOn(() => recheck(h.room));
    expect(failed).toEqual({ status: 200, body: { release_id: REL, state: "failed", rechecked: true, reason: "release_off" } });
    expect(await row(h.room)).toEqual({ state: "failed", failure_code: "release_off", finished: 1 });
    const after = await trail(h.room);
    // The event names the release it is about, by its ID, and why, by the code.
    expect(after.events).toEqual([{ type: "release.failed", actor_id: "podster", subject_id: REL, reason: "release_off" }]);
    expect(after.audit.map((a: any) => [a.actor_id, a.action, a.target_id, JSON.parse(a.prior_json), JSON.parse(a.new_json)])).toEqual([["podster", "release.failed", REL, { state: "queued" }, { state: "failed", reason: "release_off" }]]);
    // A release that has ended takes no event: a second pass finds it failed and changes nothing, whatever is so now.
    await inRoom(h.room, (sql) => sql.exec("UPDATE release_config SET enabled = 1"));
    expect((await switchedOn(() => recheck(h.room))).body).toEqual({ release_id: REL, state: "failed", rechecked: false, reason: "release_off" });
    expect(await trail(h.room)).toEqual(after);
  });

  // Each of these changes one fact in a room where everything else holds, and names the reason core gives for it.
  const sql = (statement: string, ...values: unknown[]) => (h: Healthy) => inRoom(h.room, (s) => void s.exec(statement, ...values));
  const facts: [string, string, (h: Healthy) => Promise<unknown>][] = [
    ["the room archived", "workspace_archived", sql("UPDATE workspace SET status = 'archived'")],
    ["the room deleted, which nothing does yet", "workspace_deleted", sql("UPDATE workspace SET status = 'deleted'")],
    ["the room made private", "release_needs_public_room", sql("UPDATE workspace SET visibility = 'private'")],
    ["the room's public surface suspended", "public_surface_suspended", sql("UPDATE workspace SET suspended_at = 1, suspension_reason = 'abuse'")],
    ["the app suspended", "app_suspended", sql("UPDATE app_label SET suspended_at = 1, suspension_reason = 'abuse'")],
    ["the repository's link no longer ready", "repo_not_ready", sql("UPDATE repo_link SET status = 'degraded', status_reason = 'rules_changed'")],
    ["no repository linked at all", "repo_not_ready", sql("DELETE FROM repo_link")],
    ["release switched off in the room", "release_off", sql("UPDATE release_config SET enabled = 0")],
    ["the room's release configuration changed since it was asked for", "release_config_changed", sql("UPDATE release_config SET version = version + 1")],
    ["the room unpublished since it started", "release_epoch_moved", sql("UPDATE release_config SET release_epoch = release_epoch + 1")],
    ["the release naming a higher epoch than the room has reached", "release_epoch_moved", sql("UPDATE release SET release_epoch = release_epoch + 1")],
    // Whoever asked for it.
    ["the requester no longer in the room", "requester_lost_authority", (h) => inRoom(h.room, (s) => void s.exec("UPDATE member SET revoked_at = 2, revocation_reason = 'removed' WHERE principal_id = ?", h.requester.id))],
    ["the requester holding no deploy grant", "requester_lost_authority", sql("DELETE FROM provider_grant")],
    ["the requester's grant revoked", "requester_lost_authority", sql("UPDATE provider_grant SET revoked_at = 2, revoked_by = 'per_rr_owner'")],
    ["the requester's grant past its expiry", "requester_lost_authority", sql("UPDATE provider_grant SET expires_at = 2")],
    ["the requester's grant being for another repository", "requester_lost_authority", sql("UPDATE provider_grant SET provider_repo_id = provider_repo_id + 1")],
    ["the requester's grant being for another action", "requester_lost_authority", sql("UPDATE provider_grant SET action = 'merge'")],
    ["the requester's grant being with another provider than the room's repository", "requester_lost_authority", sql("UPDATE provider_grant SET provider = 'another'")],
    ["the requester there only through a public claim", "requester_lost_authority", (h) => inRoom(h.room, (s) => void s.exec("UPDATE member SET joined_via = 'public', role = 'guest' WHERE principal_id = ?", h.requester.id))],
    ["the requester having left their organization, before the room has heard", "requester_lost_authority", (h) => departs(h.requester)],
    ["the grant's giver no longer an owner or admin", "requester_lost_authority", (h) => inRoom(h.room, (s) => void s.exec("UPDATE provider_grant SET delegated_by = ?", h.requester.id))],
    ["the grant's giver having left their organization", "requester_lost_authority", async (h) => { await inRoom(h.room, (s) => void s.exec("UPDATE provider_grant SET delegated_by = ?", h.admin.id)); await departs(h.admin); }],
    ["the requester being an agent, whose controlling person isn't on record", "requester_lost_authority", async (h) => {
      await inRoom(h.room, (s) => {
        s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES ('agt_rr_asker', 'agent', ?, 'member', ?, 1)", h.org, OWNER.id);
        s.exec("UPDATE provider_grant SET principal_id = 'agt_rr_asker'");
        s.exec("UPDATE release SET requested_by = 'agt_rr_asker'");
      });
    }],
    // Whoever approved it.
    ["the approver no longer an owner or admin", "approver_lost_authority", (h) => inRoom(h.room, (s) => void s.exec("UPDATE release SET approved_by = ?", h.requester.id))],
    ["the approver no longer in the room", "approver_lost_authority", sql("UPDATE release SET approved_by = 'per_rr_stranger'")],
    ["the approver having left their organization", "approver_lost_authority", async (h) => { await inRoom(h.room, (s) => void s.exec("UPDATE release SET approved_by = ?", h.admin.id)); await departs(h.admin); }],
    ["the approver being an agent", "approver_lost_authority", async (h) => {
      await inRoom(h.room, (s) => {
        s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES ('agt_rr_approver', 'agent', ?, 'admin', ?, 1)", h.org, OWNER.id);
        s.exec("UPDATE release SET approved_by = 'agt_rr_approver'");
      });
    }],
    // The room's reviewer rule, as it is now.
    ["the room requiring a person as reviewer when no reviewer is on record", "reviewer_rule_changed", async (h) => {
      await inRoom(h.room, (s) => { s.exec("UPDATE workspace SET require_person_review = 1"); s.exec("UPDATE task_change SET reviewer_id = NULL"); });
    }],
    ["the room requiring a person as reviewer when the task's reviewer was an agent", "reviewer_rule_changed", async (h) => {
      await inRoom(h.room, (s) => { s.exec("UPDATE workspace SET require_person_review = 1"); s.exec("UPDATE task_change SET reviewer_id = 'agt_rr_reviewer'"); });
    }],
    // The commit, against the room's own merge record.
    ["the release naming another commit than the one merged", "commit_not_releasable", sql("UPDATE task_change SET merge_sha = ?", "ef".repeat(20))],
    ["the merge not having succeeded", "commit_not_releasable", sql("UPDATE task_change SET merge_state = 'outcome_unknown'")],
    ["the merge not being one Podster's job called", "commit_not_releasable", sql("UPDATE task_change SET merge_called_at = NULL")],
    ["the merge never read back", "commit_not_releasable", sql("UPDATE task_change SET merge_finished_at = NULL")],
    ["the merge being in another repository", "commit_not_releasable", sql("UPDATE task_change SET provider_repo_id = provider_repo_id + 1")],
    ["the task not completed", "commit_not_releasable", sql("UPDATE task SET status = 'submitted'")],
    ["the task having no merge record", "commit_not_releasable", sql("DELETE FROM task_change")],
    ["the release naming no task", "commit_not_releasable", sql("UPDATE release SET task_id = NULL")],
  ];
  for (const [what, reason, change] of facts) {
    it(`fails for ${what}, alone: ${reason}`, async () => {
      const h = await healthy();
      await change(h);
      // A release the room has since left behind is ended before the recheck runs, by the room's bookkeeping at the
      // start of every release command: the same reason, and nothing was left to recheck.
      const rechecked = what !== "the room unpublished since it started";
      expect((await switchedOn(() => recheck(h.room))).body).toEqual({ release_id: REL, state: "failed", rechecked, reason });
      expect(await row(h.room)).toEqual({ state: "failed", failure_code: reason, finished: 1 });
    });
  }

  it("holds when the room requires a person as reviewer and the task's reviewer was one", async () => {
    const h = await healthy();
    await inRoom(h.room, (s) => void s.exec("UPDATE workspace SET require_person_review = 1"));
    expect(await switchedOn(() => recheck(h.room))).toEqual(HOLDS);
  });

  it("fails while release is switched off for the deployment, which is everywhere", async () => {
    const h = await healthy();
    // No switch: the deployment's own configuration doesn't allow release.
    expect((await recheck(h.room)).body).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_off_for_deployment" });
  });

  /** Nothing was decided: the pass was refused as retryable, and the release, its events and its audit are as they were. */
  const undecided = async (h: Healthy, what: string) => {
    const before = await written(h.room);
    const answer = await switchedOn(() => recheck(h.room));
    expect([answer.status, answer.body?.error?.code], what).toEqual([503, "standing_unknown"]);
    expect(await row(h.room), what).toEqual({ state: "queued", failure_code: null, finished: 0 });
    expect(await trail(h.room), what).toEqual({ events: [], audit: [] });
    // Nothing at all: no event, no audit record, nothing queued, and nothing left in the outbox to send.
    expect(await written(h.room), what).toBe(before);
  };

  it("fails while the whole content domain is stopped, and decides nothing when the stop can't be read", async () => {
    const stopped = await healthy();
    const unreadable = await healthy();
    // The stop's home is the Moderation object. Its table is made on its first call.
    await moderation().fetch("https://do/content-stop");
    try {
      await inModeration((s) => void s.exec("INSERT INTO content_stop (singleton, stopped, reason, at, version, updated_at) VALUES (1, 1, 'illegal', 1, 1, 1) ON CONFLICT (singleton) DO UPDATE SET stopped = 1, reason = 'illegal', at = 1, version = version + 1"));
      expect((await switchedOn(() => recheck(stopped.room))).body).toMatchObject({ state: "failed", reason: "release_stopped" });
      await inModeration((s) => { s.exec("UPDATE content_stop SET stopped = 0, reason = NULL, at = NULL, version = version + 1"); s.exec("CREATE TABLE test_stop_unreadable (x INTEGER)"); });
      // A stop that can't be read is a fact that wasn't read. Failing a release can't be undone, so nothing is
      // decided on it: the pass is refused, to be tried again, and nothing is written.
      await undecided(unreadable, "the stop unreadable");
    } finally {
      await inModeration((s) => { s.exec("DROP TABLE IF EXISTS test_stop_unreadable"); s.exec("UPDATE content_stop SET stopped = 0, reason = NULL, at = NULL, version = version + 1"); });
    }
    // Readable again and clear, the same release holds.
    expect(await switchedOn(() => recheck(unreadable.room))).toEqual(HOLDS);
  });

  it("decides nothing when the organization's delegation can't be read, or isn't a yes or a no", async () => {
    // Test builds only: the answer the organization's object is taken to have given.
    for (const answer of ["not json at all", "{}", '{"granted":"yes"}', '{"granted":1}', '{"granted":null}', "null"]) {
      const h = await healthy();
      await inRoom(h.room, (s) => { s.exec("CREATE TABLE test_release_delegation_answer (answer TEXT)"); s.exec("INSERT INTO test_release_delegation_answer (answer) VALUES (?)", answer); });
      await undecided(h, answer);
      // A clear no is a fact that was read: it fails the release.
      await inRoom(h.room, (s) => void s.exec("UPDATE test_release_delegation_answer SET answer = ?", '{"granted":false}'));
      expect((await switchedOn(() => recheck(h.room))).body, answer).toMatchObject({ state: "failed", reason: "release_not_delegated" });
    }
  });

  it("uses the requester's grant on the room's own repository, whatever other grants they hold", async () => {
    const h = await healthy();
    // An older live `deploy` grant on another repository, from someone who gave nothing that counts.
    await inRoom(h.room, (s) => void s.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_older', ?, 'github', ?, 'deploy', ?, 0)", h.requester.id, REPO_ID + 5, h.requester.id));
    expect(await switchedOn(() => recheck(h.room))).toEqual(HOLDS);
  });

  it("can't be given two unrevoked grants for one repository and action, so the live one is the only one", async () => {
    // An expired grant beside a newer live one would have to be two unrevoked rows, which the room's own index
    // refuses. A grant is replaced by revoking it, and a revoked one is never read.
    const h = await healthy();
    const second = () => inRoom(h.room, (s) => void s.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_second', ?, 'github', ?, 'deploy', ?, 5)", h.requester.id, REPO_ID, OWNER.id));
    await inRoom(h.room, (s) => void s.exec("UPDATE provider_grant SET expires_at = 2"));
    await expect(second()).rejects.toThrow();
    // Revoked and expired, with a live one given after it: the live one is used.
    await inRoom(h.room, (s) => void s.exec("UPDATE provider_grant SET revoked_at = 3, revoked_by = ?", OWNER.id));
    await second();
    expect(await switchedOn(() => recheck(h.room))).toEqual(HOLDS);
  });

  it("fails once an operator has taken the provisioning delegation from the room's organization", async () => {
    // The organization's ability to release is its provisioning delegation (the architect's ruling, 2026-11-13).
    const org = "org_rr_untrusted";
    const h = await healthy({ org });
    const before = await healthy({ org });
    expect(await switchedOn(() => recheck(before.room))).toEqual(HOLDS);
    const taken = await api(OPERATOR, "PUT", `/v1/orgs/${org}/provisioning-delegation`, { granted: false });
    expect(taken.status).toBe(200);
    try {
      expect((await switchedOn(() => recheck(h.room))).body).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_not_delegated" });
    } finally {
      await api(OPERATOR, "PUT", `/v1/orgs/${org}/provisioning-delegation`, { granted: true });
    }
    // Another organization's rooms are untouched by it.
    const other = await healthy();
    expect(await switchedOn(() => recheck(other.room))).toEqual(HOLDS);
  });

  it("records which of the organization's two facts refused, for the same code on the wire", async () => {
    // The provisioning delegation only refuses; decision 218's release switch is the unpublish trigger. Both answer
    // `release_not_delegated`, and the audit record keeps which. The switch refuses with its own cause in a room that
    // already applied the take, one made after it: a room that hears of a take since what it applied unpublishes
    // first, which ends what hadn't gone live as `release_epoch_moved` (`release-switch.spec.ts`).
    const audited = async (room: string) => (await trail(room)).audit.map((a: any) => JSON.parse(a.new_json));
    const byDelegation = await healthy({ org: "org_rr_cause_p" });
    expect((await api(OPERATOR, "PUT", "/v1/orgs/org_rr_cause_p/provisioning-delegation", { granted: false })).status).toBe(200);
    try {
      await switchedOn(async () => {
        await healthy({ org: "org_rr_cause_s" });
        expect((await api(OPERATOR, "PUT", "/v1/orgs/org_rr_cause_s/release-delegation", { granted: false })).status).toBe(200);
        const bySwitch = await healthy({ org: "org_rr_cause_s" });
        for (const [h, cause] of [[byDelegation, "provisioning_delegation"], [bySwitch, "release_switch"]] as const) {
          expect((await recheck(h.room)).body, cause).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_not_delegated" });
          expect(await audited(h.room), cause).toEqual([{ state: "failed", reason: "release_not_delegated", cause }]);
          // The event and the row carry the code alone, as for every reason.
          expect((await trail(h.room)).events, cause).toEqual([{ type: "release.failed", actor_id: "podster", subject_id: REL, reason: "release_not_delegated" }]);
          expect(await row(h.room), cause).toEqual({ state: "failed", failure_code: "release_not_delegated", finished: 1 });
        }
      });
    } finally {
      await api(OPERATOR, "PUT", "/v1/orgs/org_rr_cause_p/provisioning-delegation", { granted: true });
      await switchedOn(() => api(OPERATOR, "PUT", "/v1/orgs/org_rr_cause_s/release-delegation", { granted: true }));
    }
    // Any other reason has no cause in its record.
    const other = await healthy();
    await inRoom(other.room, (sql) => sql.exec("UPDATE release_config SET enabled = 0"));
    await switchedOn(() => recheck(other.room));
    expect(await audited(other.room)).toEqual([{ state: "failed", reason: "release_off" }]);
  });

  it("refuses an organization's releases while its release switch is taken, and a room made after the take too", async () => {
    const org = "org_rr_switch";
    const before = await healthy({ org });
    const other = await healthy();
    await switchedOn(async () => {
      expect(await recheck(before.room)).toEqual(HOLDS);
      const taken = await api(OPERATOR, "PUT", `/v1/orgs/${org}/release-delegation`, { granted: false });
      expect(taken.body).toMatchObject({ granted: false, generation: 1, last_take: 1, set_by: OPERATOR.id });
      // A room made before the take hears of it at its recheck, from its own read, and unpublishes, which ends the
      // release that hadn't gone live under the epoch it raised from (PR C).
      expect((await recheck(before.room)).body).toEqual({ release_id: REL, state: "failed", rechecked: false, reason: "release_epoch_moved" });
      // A room made after the take applied it as it was made: nothing to unpublish, and the recheck refuses.
      const after = await healthy({ org });
      expect((await recheck(after.room)).body).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_not_delegated" });
      // Another organization's rooms are untouched.
      expect(await recheck(other.room)).toEqual(HOLDS);
      // Given back: a new release holds again. The one that failed stays failed: nothing is restored.
      const given = await api(OPERATOR, "PUT", `/v1/orgs/${org}/release-delegation`, { granted: true });
      expect(given.body).toMatchObject({ granted: true, generation: 2, last_take: 1 });
      const later = await healthy({ org });
      expect(await recheck(later.room)).toEqual(HOLDS);
      expect(await row(before.room)).toEqual({ state: "failed", failure_code: "release_epoch_moved", finished: 1 });
      // Take, give, take in quick succession ends taken, under the last generation, and the room made between them
      // comes down at its next recheck.
      try {
        await api(OPERATOR, "PUT", `/v1/orgs/${org}/release-delegation`, { granted: false });
        await api(OPERATOR, "PUT", `/v1/orgs/${org}/release-delegation`, { granted: true });
        const last = await api(OPERATOR, "PUT", `/v1/orgs/${org}/release-delegation`, { granted: false });
        expect(last.body).toMatchObject({ granted: false, generation: 5, last_take: 5 });
        expect((await recheck(later.room)).body).toMatchObject({ state: "failed", reason: "release_epoch_moved" });
        expect(await inRoom(later.room, (s) => s.exec("SELECT cause, release_epoch FROM unpublish").toArray())).toEqual([{ cause: "release_not_delegated", release_epoch: 3 }]);
      } finally {
        await api(OPERATOR, "PUT", `/v1/orgs/${org}/release-delegation`, { granted: true });
      }
    });
  });

  it("decides nothing when the release switch can't be read, or isn't a well-formed switch", async () => {
    // Test builds only: the answer the organization's object is taken to have given.
    for (const answer of ["not json at all", "{}", "null", '{"granted":true}', '{"granted":"yes","generation":1,"last_take":0}',
      '{"granted":false,"generation":2,"last_take":1}', '{"granted":true,"generation":1,"last_take":1}', '{"granted":false,"generation":0,"last_take":0}',
      '{"granted":true,"generation":-1,"last_take":0}', '{"granted":true,"generation":1.5,"last_take":0}']) {
      const h = await healthy();
      await inRoom(h.room, (s) => { s.exec("CREATE TABLE test_release_switch_answer (answer TEXT)"); s.exec("INSERT INTO test_release_switch_answer (answer) VALUES (?)", answer); });
      await undecided(h, answer);
      // A well-formed answer that held release all along holds; a well-formed take is a fact that was read, and the
      // room comes down on it, which ends the release.
      await inRoom(h.room, (s) => void s.exec("UPDATE test_release_switch_answer SET answer = ?", '{"granted":true,"generation":4,"last_take":0}'));
      expect(await switchedOn(() => recheck(h.room)), answer).toEqual(HOLDS);
      await inRoom(h.room, (s) => void s.exec("UPDATE test_release_switch_answer SET answer = ?", '{"granted":false,"generation":5,"last_take":5}'));
      expect((await switchedOn(() => recheck(h.room))).body, answer).toMatchObject({ state: "failed", reason: "release_epoch_moved" });
    }
  });

  it("rechecks a release the job owns, and leaves every other alone", async () => {
    for (const state of ["queued", "uploading", "uncertain"]) {
      const h = await healthy({ state });
      expect((await switchedOn(() => recheck(h.room))).body, state).toEqual({ release_id: REL, state, rechecked: true, reason: null });
      await inRoom(h.room, (s) => void s.exec("UPDATE release_config SET enabled = 0"));
      expect((await switchedOn(() => recheck(h.room))).body, state).toEqual({ release_id: REL, state: "failed", rechecked: true, reason: "release_off" });
    }
    // Not yet approved, already committed live, or ended: nothing is rechecked and nothing changes, though release is
    // off in the room. Ending one that is live also sets its hosts back, which isn't this command's.
    for (const state of ["awaiting_approval", "live", "served", "replaced", "unpublished", "failed"]) {
      const h = await healthy();
      await inRoom(h.room, (s) => {
        s.exec("UPDATE release SET state = ?, approved_by = ?, approved_at = ?, script_name = ?, script_release_id = ? WHERE id = ?", state,
          state === "awaiting_approval" ? null : OWNER.id, state === "awaiting_approval" ? null : 1, ["live", "served"].includes(state) ? `rrlabel.${REL}` : null, ["live", "served"].includes(state) ? REL : null, REL);
        s.exec("UPDATE release_config SET enabled = 0");
      });
      expect((await switchedOn(() => recheck(h.room))).body, state).toEqual({ release_id: REL, state, rechecked: false, reason: null });
      expect((await row(h.room)).state, state).toBe(state);
      expect(await trail(h.room)).toEqual({ events: [], audit: [] });
    }
  });

  it("decides nothing when what it read outside the room isn't about who the room names now", async () => {
    // Between the questions asked of the others and the room's transaction, the room changes who they were about.
    const changes: [string, (h: Healthy) => string[]][] = [
      ["the approver", (h) => [`UPDATE release SET approved_by = '${h.admin.id}'`]],
      // The requester alone: the new one holds the same grant from the same giver, so nothing else was asked about
      // anyone different. What was learned of the first requester must not be taken as said of the second.
      ["the requester, with the grant moved to the new one", (h) => [`UPDATE release SET requested_by = '${h.admin.id}'`, `UPDATE provider_grant SET principal_id = '${h.admin.id}'`]],
      ["the grant's giver", (h) => [`UPDATE provider_grant SET delegated_by = '${h.admin.id}'`]],
      ["the room's organization", () => ["UPDATE workspace SET owner_org_id = 'org_rr_other'"]],
      // The delegation is held for a provider. What was read for one says nothing of another.
      ["the provider the room's repository is with", () => ["UPDATE repo_link SET provider = 'another'", "UPDATE provider_grant SET provider = 'another'"]],
    ];
    for (const [what, statements] of changes) {
      const h = await healthy();
      await between(h.room, ...statements(h));
      // Nothing was decided: the release is as it was, and nothing was recorded.
      await undecided(h, what);
    }
    // Where the change leaves someone failing on the room's own rows, that is a fact that was read: the release
    // fails, whoever the outside answers were about. Neither new requester holds a grant.
    for (const [what, statements] of [
      ["the requester, who holds no grant", (h: Healthy) => [`UPDATE release SET requested_by = '${h.admin.id}'`]],
      ["the grant itself, gone", () => ["DELETE FROM provider_grant"]],
    ] as [string, (h: Healthy) => string[]][]) {
      const h = await healthy();
      await between(h.room, ...statements(h));
      expect((await switchedOn(() => recheck(h.room))).body, what).toMatchObject({ state: "failed", reason: "requester_lost_authority" });
    }
    // Someone the room's rows made not worth asking about when the questions were asked, and do by the transaction:
    // nothing is known of them, so nothing is decided. They aren't failed for not having been asked.
    const promoted: [string, (h: Healthy) => Promise<unknown>, (h: Healthy) => string[]][] = [
      ["the approver made an admin in between", (h) => inRoom(h.room, (s) => void s.exec("UPDATE release SET approved_by = ?", h.requester.id)), (h) => [`UPDATE member SET role = 'admin' WHERE principal_id = '${h.requester.id}'`]],
      ["the grant's giver made an admin in between", (h) => inRoom(h.room, (s) => void s.exec("UPDATE provider_grant SET delegated_by = ?", h.requester.id)), (h) => [`UPDATE member SET role = 'admin' WHERE principal_id = '${h.requester.id}'`]],
      ["the requester added to the room in between", (h) => inRoom(h.room, (s) => { s.exec("UPDATE release SET requested_by = 'per_rr_late'"); s.exec("UPDATE provider_grant SET principal_id = 'per_rr_late'"); }),
        (h) => [`INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES ('per_rr_late', 'person', '${h.org}', 'member', '${OWNER.id}', 1)`]],
      // With no repository linked, the organization was asked nothing, since there was no provider to name.
      ["a repository linked in between", (h) => inRoom(h.room, (s) => void s.exec("DELETE FROM repo_link")),
        () => [`INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ${REPO_ID}, 4242, 'podsterx/release', 'public', 'main', 'ready', '${OWNER.id}', 1, 1, 1)`]],
    ];
    // Asked about one place in the room, and by the transaction the rows give them another: the same person, in
    // another organization, or in a place that began at another time. The answer was about the first place.
    promoted.push(
      ["the approver's place moved to another organization in between", async () => {}, () => ["UPDATE workspace SET owner_org_id = 'org_rr_moved', created_at = created_at"]],
      ["the requester's place begun again in between", async () => {}, (h) => [`UPDATE member SET added_at = added_at + 5 WHERE principal_id = '${h.requester.id}'`]],
    );
    for (const [what, before, statements] of promoted) {
      const h = await healthy();
      await before(h);
      await between(h.room, ...statements(h));
      await undecided(h, what);
    }
    // A fact of the room's own that changes at that same point is simply read as it now is, inside the transaction.
    const h = await healthy();
    await between(h.room, "UPDATE release_config SET enabled = 0");
    expect((await switchedOn(() => recheck(h.room))).body).toMatchObject({ state: "failed", reason: "release_off" });
  });

  it("decides nothing when someone's own record can't answer", async () => {
    // A person whose Principal doesn't answer the departure question (test builds: an ID with this prefix).
    // The approver's, the requester's, and the grant's giver's.
    for (const statement of ["UPDATE release SET approved_by = 'per_unavailable_rr'", "UPDATE release SET requested_by = 'per_unavailable_rr'", "UPDATE provider_grant SET delegated_by = 'per_unavailable_rr'"]) {
      const h = await healthy();
      await inRoom(h.room, (s) => {
        s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES ('per_unavailable_rr', 'person', ?, 'admin', ?, 1)", h.org, OWNER.id);
        s.exec(statement);
        if (statement.includes("requested_by")) s.exec("UPDATE provider_grant SET principal_id = 'per_unavailable_rr'");
      });
      await undecided(h, statement);
    }
  });

  it("answers only for a release the room has, by a well-formed ID", async () => {
    const h = await healthy();
    await switchedOn(async () => {
      expect((await recheck(h.room, `rel_${"00".repeat(16)}`)).status).toBe(404);
      for (const id of ["rel_short", "REL", "", `rel_${"ZZ".repeat(16)}`]) expect((await recheck(h.room, id)).status, id).toBe(400);
      const none = await stub(h.room).fetch("https://do/internal/release-recheck", { method: "POST", body: "{" });
      expect(none.status).toBe(400);
    });
    expect(await row(h.room)).toEqual({ state: "queued", failure_code: null, finished: 0 });
  });

  it("can't be reached by any client: the Worker forwards no such path", async () => {
    const h = await healthy();
    await inRoom(h.room, (s) => void s.exec("UPDATE release_config SET enabled = 0"));
    await switchedOn(async () => {
      for (const who of [OWNER, h.requester, OPERATOR]) {
        for (const path of ["/internal/release-recheck", `/v1/workspaces/${h.room}/internal/release-recheck`, `/v1/workspaces/${h.room}/release-recheck`, `/v1/workspaces/${h.room}/releases/${REL}/recheck`, `/v1/internal/release-recheck?ws=${h.room}`]) {
          const answer = await api(who, "POST", path, { release_id: REL });
          expect(answer.status, `${who.id} ${path}`).toBeGreaterThanOrEqual(400);
        }
      }
    });
    // The room would have failed the release had any of those reached it.
    expect(await row(h.room)).toEqual({ state: "queued", failure_code: null, finished: 0 });
    // The Worker's own source names the path nowhere outside the room: nothing forwards to it.
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    const naming = Object.entries(sources).filter(([, text]) => text.includes("release-recheck") || text.includes("INTERNAL_RELEASE_RECHECK")).map(([name]) => name).sort();
    expect(naming).toEqual(["workspace.rs", "workspace/release_recheck.rs"]);
  });

  it("reads no read model: D1 holds nothing it decides from", async () => {
    const h = await healthy();
    // Everything D1 knows of this room says otherwise, or says nothing. The recheck holds all the same.
    for (const table of ["membership_index", "public_workroom_index", "repo_room_index", "app_label_index"]) await BINDINGS.DB.prepare(`DELETE FROM ${table}`).run();
    expect(await switchedOn(() => recheck(h.room))).toEqual(HOLDS);
    const source = (JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>)["workspace/release_recheck.rs"];
    expect(source).not.toMatch(/\.d1\(|"DB"|_index\b/);
  });
});

describe("an organization's release switch, as its operator route answers (decision 218)", () => {
  it("is held, unset, until an operator sets it; an operator and the organization's admin read it; only an operator sets it", async () => {
    const org = "org_rr_route";
    const h = await healthy({ org });
    const admin: Who = { id: "per_rr_route_admin", kind: "person", org, adminOrgs: [org] };
    const member: Who = { id: "per_rr_route_member", kind: "person", org };
    const path = `/v1/orgs/${org}/release-delegation`;
    await switchedOn(async () => {
      const unset = { granted: true, generation: 0, last_take: 0, set_by: null, set_at: null };
      expect((await api(OPERATOR, "GET", path)).body).toEqual(unset);
      expect((await api(admin, "GET", path)).body).toEqual(unset);
      expect([(await api(member, "GET", path)).status, (await api(member, "GET", path)).code]).toEqual([403, "not_allowed"]);
      // The organization's own admin can't set it, either way.
      for (const granted of [false, true]) expect((await api(admin, "PUT", path, { granted })).code, `${granted}`).toBe("not_allowed");
      expect((await api(OPERATOR, "GET", path)).body).toEqual(unset);
      // Only `{ granted }`, a boolean, is a set.
      for (const body of [{}, { granted: "false" }, { granted: false, extra: 1 }, { reason: "abuse" }]) expect((await api(OPERATOR, "PUT", path, body)).code, JSON.stringify(body)).toBe("invalid_argument");
      expect((await api(OPERATOR, "GET", path)).body).toEqual(unset);
      // Every set raises the generation; a take is the last take, and a give-back keeps it.
      const steps: [boolean, number, number][] = [[false, 1, 1], [false, 2, 2], [true, 3, 2], [true, 4, 2], [false, 5, 5]];
      for (const [granted, generation, lastTake] of steps) {
        const set = await api(OPERATOR, "PUT", path, { granted });
        expect(set.body, `${granted} ${generation}`).toMatchObject({ granted, generation, last_take: lastTake, set_by: OPERATOR.id });
        expect(typeof set.body.set_at).toBe("number");
        expect((await api(admin, "GET", path)).body).toEqual(set.body);
      }
      // An organization the API has never seen a room of.
      expect((await api(OPERATOR, "PUT", "/v1/orgs/org_rr_nobody/release-delegation", { granted: false })).code).toBe("organization_not_found");
      expect((await api(OPERATOR, "GET", "/v1/orgs/org_rr_nobody/release-delegation")).body).toEqual(unset);
    });
    // Switched off, it is answered as a path nobody defined, operators included, and nothing changes.
    for (const who of [OPERATOR, admin]) {
      for (const method of ["GET", "PUT"]) {
        const [real, unknown] = [await api(who, method, path, { granted: true }), await api(who, method, `${path}x`, { granted: true })];
        expect([real.status, real.code], `${who.id} ${method}`).toEqual([404, "not_found"]);
        expect([real.status, real.body], `${who.id} ${method}`).toEqual([unknown.status, unknown.body]);
      }
    }
    expect((await switchedOn(() => api(OPERATOR, "GET", path))).body).toMatchObject({ granted: false, generation: 5, last_take: 5 });
    expect(h.org).toBe(org);
    // Given back, so no later test finds this organization taken.
    expect((await switchedOn(() => api(OPERATOR, "PUT", path, { granted: true }))).body).toMatchObject({ granted: true, generation: 6, last_take: 5 });
  });
});
