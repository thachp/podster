import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet, manualAlarms } from "./alarm";

// M6 step 6: asking for a release of a task's merged commit (`requestRelease`, `POST /v1/workspaces/{ws}/releases`),
// the first half of ADR 0010's "a `deploy_release` command, then a person's approval". It records a release awaiting
// a person's approval and nothing else: nothing is read from a repository, uploaded or served, and the release job
// never takes up a release nobody approved. Who may ask is `podster_policy::release::authorize_release_request`; what
// may be asked for is `podster_core::release_request`.
//
// Each room's provider is switched off, as in `release-commit.spec.ts`, so the release path's gate is open and what is
// read is the room's own state, except in the gate's own test, which configures it.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; org: string; kind?: "person" | "agent"; adminOrgs?: string[]; departure?: object };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const claims = who.kind === "agent"
    ? { kind: "agent", org: who.org, gen: 1 }
    : { kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 }, ...(who.departure ? { departure: who.departure } : {}) };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who) };
  if (method !== "GET") headers["idempotency-key"] = idempotencyKey ?? `rq-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined, text };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());

/** Release switched on for the test Worker, as no deployment is, while `run` runs. */
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

/** An agent, registered once, whose credential names no linker: it may not ask here (6g asks with one). */
const AGENT: Who = { id: "agt_rq_agent", org: "org_rq_agents", kind: "agent" };

const SHA = "e1".repeat(20);
const OTHER_SHA = "f2".repeat(20);
const REPO_ID = 987650207;
const TASK = "tsk_rq_1";
const T = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
let rooms = 0;
/** Every room a test made, quieted after each test. */
const made: string[] = [];

type Room = { room: string; owner: Who; admin: Who; requester: Who; org: string };
/**
 * A public room where a release may be asked for: release on at version 3 and epoch 2, a ready repository, a member
 * holding a `deploy` grant the owner gave, and a completed task whose reviewed commit Podster's merge confirmed. The
 * room has no label yet, and its provider is switched off.
 */
async function room(opts: { org?: string } = {}): Promise<Room> {
  const n = ++rooms;
  const org = opts.org ?? `org_rq_${n}`;
  const owner: Who = { id: `per_rq_owner_${n}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Release request" });
  expect(created.status).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  const requester: Who = { id: `per_rq_req_${n}`, org };
  const admin: Who = { id: `per_rq_adm_${n}`, org };
  await inRoom(id, (sql) => {
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, owner.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `rq-${n}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/release', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO_ID, owner.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_rq', ?, 'github', ?, 'deploy', ?, 1)", requester.id, REPO_ID, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, requester.id, admin.id);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO_ID, SHA, admin.id);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
    sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
  });
  // The room's alarms are the test's from here on.
  await manualAlarms(stub(id));
  return { room: id, owner, admin, requester, org };
}

const path = (r: Room) => `/v1/workspaces/${r.room}/releases`;
const ask = (r: Room, body: unknown = { task_id: TASK, commit_sha: SHA }, who: Who = r.requester, idempotencyKey?: string) => api(who, "POST", path(r), body, idempotencyKey);
const refused = (answer: { status: number; code?: string }) => [answer.status, answer.code];
/** Everything a request could write, so a refusal can be shown to have written nothing. */
const everything = (r: Room) => inRoom(r.room, (sql) => JSON.stringify(["release", "app_label", "audit_event", "event", "outbox", "serve_state", "script_delete", "unpublish"].map((table) => sql.exec(`SELECT * FROM ${table}`).toArray())));

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const registrar: Who = { id: "per_rq_registrar", org: AGENT.org, adminOrgs: [AGENT.org] };
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(registrar) }, body: JSON.stringify({ org_id: AGENT.org, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register ${AGENT.id}: ${res.status}`);
});

describe("asking for a release (M6 step 6)", () => {
  it("records a release awaiting a person's approval, and nothing else", async () => {
    const r = await room();
    const answer = await switchedOn(() => ask(r));
    expect(answer.status, answer.text).toBe(200);
    const id = answer.body.id;
    expect(id).toMatch(/^rel_[0-9a-f]{32}$/);
    expect(answer.body).toEqual({
      id, commit_sha: SHA, environment: "production", state: "awaiting_approval", requested_by: r.requester.id, requested_at: T,
      approved_by: null, approved_at: null, declined_by: null, declined_at: null, result_url: null, failure_code: null, finished_at: null, rollback_to: null,
    });
    // Under the room's configuration and epoch as they are now, for the task named, with a label the room made: random,
    // the room's only current one, and in no name of the room's.
    const [row] = await all(r.room, "SELECT task_id, state, label, config_version, release_epoch, script_name, upload_started_at, updated_at FROM release WHERE id = ?", id);
    expect(row).toMatchObject({ task_id: TASK, state: "awaiting_approval", config_version: 3, release_epoch: 2, script_name: null, upload_started_at: null, updated_at: T });
    expect(row.label).toMatch(/^[a-z2-7]{26}$/);
    expect(await all(r.room, "SELECT label, current, retired_at, created_at FROM app_label")).toEqual([{ label: row.label, current: 1, retired_at: null, created_at: T }]);
    // On the trail: the audit record, by the requester, with IDs only; and the event, about the release, to those who
    // may approve it, who are the owner and the admin.
    const audited = await all(r.room, "SELECT actor_id, action, target_id, prior_json, new_json FROM audit_event WHERE action LIKE 'release.%'");
    expect(audited.map(({ new_json, ...a }: any) => ({ ...a, new: JSON.parse(new_json) }))).toEqual([
      { actor_id: r.requester.id, action: "release.requested", target_id: id, prior_json: null, new: { commit_sha: SHA, state: "awaiting_approval", task_id: TASK } },
    ]);
    const events = await all(r.room, "SELECT id, type, actor_id, subject_id FROM event WHERE type LIKE 'release.%'");
    expect(events.map(({ id: _, ...e }: any) => e)).toEqual([{ type: "release.requested", actor_id: r.requester.id, subject_id: id }]);
    expect((await all(r.room, "SELECT recipient_principal_id AS who FROM outbox WHERE event_id = ? ORDER BY who", events[0].id)).map((o: any) => o.who)).toEqual([r.admin.id, r.owner.id].sort());
    // Nothing toward serving it: no upload, no script, no host, no job.
    for (const table of ["serve_state", "release_job", "release_upload", "script_delete"]) expect(await all(r.room, `SELECT * FROM ${table}`), table).toEqual([]);
    // It is offered to those who may approve it.
    const offered = await switchedOn(() => api(r.owner, "GET", `/v1/workspaces/${r.room}/release-approvals`));
    expect(offered.body).toEqual({ releases: [{ id, task_id: TASK, commit_sha: SHA, state: "awaiting_approval", requested_by: r.requester.id, requested_at: T }], more: false });
  });

  it("tells people only: an agent holding the admin role hears nothing of a request it could never approve", async () => {
    const r = await room();
    await inRoom(r.room, (s) => void s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'admin', ?, 1)", AGENT.id, AGENT.org, r.owner.id));
    const id = (await switchedOn(() => ask(r))).body.id;
    const [event] = await all(r.room, "SELECT id FROM event WHERE type = 'release.requested' AND subject_id = ?", id);
    expect((await all(r.room, "SELECT recipient_principal_id AS who FROM outbox WHERE event_id = ? ORDER BY who", event.id)).map((o: any) => o.who)).toEqual([r.admin.id, r.owner.id].sort());
  });

  it("starts nothing: the room's job leaves it awaiting approval until a person approves it", async () => {
    const r = await room();
    const id = (await switchedOn(() => ask(r))).body.id;
    // The room's alarm runs its job twice, with release on: a release nobody approved is not the job's.
    await switchedOn(async () => {
      await alarmPass(stub(r.room));
      await alarmPass(stub(r.room));
    });
    expect(await all(r.room, "SELECT state, approved_by, upload_started_at, script_name FROM release WHERE id = ?", id)).toEqual([{ state: "awaiting_approval", approved_by: null, upload_started_at: null, script_name: null }]);
    expect(await all(r.room, "SELECT * FROM release_job")).toEqual([]);
    // Only a person's approval queues it (`release-approval.spec.ts`).
    const approve = await switchedOn(() => api(r.owner, "POST", `${path(r)}/${id}/approve`, {}));
    expect([approve.status, approve.body?.state], approve.text).toEqual([200, "queued"]);
  });

  it("answers a retry with the same key as the first time, and refuses a second ask for a commit already waiting", async () => {
    const r = await room();
    const first = await switchedOn(() => ask(r, undefined, r.requester, "rq-same"));
    const again = await switchedOn(() => ask(r, undefined, r.requester, "rq-same"));
    expect(first.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await all(r.room, "SELECT id FROM release")).toEqual([{ id: first.body.id }]);
    const label = (await all(r.room, "SELECT label FROM app_label"))[0].label;
    // Another ask for the same commit, while the first waits.
    const before = await everything(r);
    expect(refused(await switchedOn(() => ask(r)))).toEqual([409, "release_pending"]);
    expect(await everything(r)).toBe(before);
    // Once it has ended, the commit may be asked for again, under the same label.
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release SET state = 'declined', declined_by = ?, declined_at = 1 WHERE id = ?", r.owner.id, first.body.id));
    const later = await switchedOn(() => ask(r));
    expect(later.status, later.text).toBe(200);
    expect(await all(r.room, "SELECT label FROM release WHERE id = ?", later.body.id)).toEqual([{ label }]);
    expect(await all(r.room, "SELECT COUNT(*) AS n FROM app_label")).toEqual([{ n: 1 }]);
  });

  it("makes a new label only when the room has none current, which an unpublish leaves", async () => {
    const r = await room();
    await inRoom(r.room, (sql) => {
      sql.exec("INSERT INTO app_label (label, current, retired_at, created_at) VALUES ('rqretired', NULL, 5, 1)");
      sql.exec("INSERT INTO app_label (label, current, created_at) VALUES ('rqcurrent', 1, 2)");
    });
    const kept = await switchedOn(() => ask(r));
    expect(await all(r.room, "SELECT label FROM release WHERE id = ?", kept.body.id)).toEqual([{ label: "rqcurrent" }]);
    // The current label retired, as an unpublish does: the next ask makes another, and neither earlier label is used.
    await inRoom(r.room, (sql) => {
      sql.exec("UPDATE release SET state = 'failed', failure_code = 'release_epoch_moved', finished_at = 1");
      sql.exec("UPDATE app_label SET current = NULL, retired_at = 6 WHERE label = 'rqcurrent'");
    });
    const fresh = await switchedOn(() => ask(r));
    expect(fresh.status, fresh.text).toBe(200);
    const [{ label }] = await all(r.room, "SELECT label FROM release WHERE id = ?", fresh.body.id);
    expect(label).toMatch(/^[a-z2-7]{26}$/);
    expect(await all(r.room, "SELECT label FROM app_label WHERE current = 1")).toEqual([{ label }]);
  });
});

describe("who may ask (podster_policy::release::authorize_release_request)", () => {
  it("only a person in the room holding a live deploy grant from someone who still holds authority", async () => {
    const cases: [string, (r: Room) => unknown, Who | ((r: Room) => Who), [number, string]][] = [
      ["no grant", (r) => inRoom(r.room, (s) => void s.exec("DELETE FROM provider_grant")), (r) => r.requester, [403, "grant_required"]],
      ["a merge grant only", (r) => inRoom(r.room, (s) => void s.exec("UPDATE provider_grant SET action = 'merge'")), (r) => r.requester, [403, "grant_required"]],
      ["a grant on another repository", (r) => inRoom(r.room, (s) => void s.exec("UPDATE provider_grant SET provider_repo_id = 1")), (r) => r.requester, [403, "grant_required"]],
      ["a revoked grant", (r) => inRoom(r.room, (s) => void s.exec("UPDATE provider_grant SET revoked_at = 1")), (r) => r.requester, [403, "grant_required"]],
      ["an expired grant", (r) => inRoom(r.room, (s) => void s.exec("UPDATE provider_grant SET expires_at = ?", T)), (r) => r.requester, [403, "grant_required"]],
      ["a grant whose giver is no longer an admin", (r) => inRoom(r.room, (s) => { s.exec("UPDATE provider_grant SET delegated_by = ?", r.admin.id); s.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", r.admin.id); }), (r) => r.requester, [403, "grant_stale"]],
      ["the owner, with no grant of their own", () => undefined, (r) => r.owner, [403, "grant_required"]],
      ["an admin, with no grant of their own", () => undefined, (r) => r.admin, [403, "grant_required"]],
      ["someone removed from the room", (r) => inRoom(r.room, (s) => void s.exec("UPDATE member SET revoked_at = 1 WHERE principal_id = ?", r.requester.id)), (r) => r.requester, [403, "access_revoked"]],
      // Decision 239 (CROSS-ORG-PEOPLE.md): a person here through another organization never releases, whatever deploy
      // grant their row holds. No command writes such a row yet, so the test writes the one a person invitation will.
      ["a person here through another organization, with a live deploy grant", (r) => inRoom(r.room, (s) => void s.exec("UPDATE member SET org_id = 'org_rq_elsewhere' WHERE principal_id = ?", r.requester.id)), (r) => ({ ...r.requester, org: "org_rq_elsewhere" }), [403, "not_allowed"]],
    ];
    for (const [why, change, who, want] of cases) {
      const r = await room();
      await change(r);
      const before = await everything(r);
      const caller = typeof who === "function" ? who(r) : who;
      expect(refused(await switchedOn(() => ask(r, undefined, caller))), why).toEqual(want);
      expect(await everything(r), why).toBe(before);
    }
  });

  it("an agent only with a controlling person on its credential (6g: `release-agent.spec.ts`)", async () => {
    const r = await room();
    await inRoom(r.room, (s) => {
      s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'member', ?, 1)", AGENT.id, AGENT.org, r.owner.id);
      s.exec("UPDATE provider_grant SET principal_id = ?", AGENT.id);
    });
    const before = await everything(r);
    // This credential names no person who linked it, so nobody can be shown to control the agent.
    expect(refused(await switchedOn(() => ask(r, undefined, AGENT)))).toEqual([403, "agent_not_connected"]);
    expect(await everything(r)).toBe(before);
  });

  it("not a person who has left the organization their place here is held in", async () => {
    const r = await room();
    expect((await api({ ...r.requester, departure: { person: r.requester.id, org: r.org, left_at: Date.now() } }, "POST", "/v1/org-departures", {})).status).toBeLessThan(500);
    // Their own `Principal` now answers that they left, while the room still holds their place: nothing has swept it.
    // So the only fact that refuses is their own record's (`requester_holds` false), answered `not_allowed`.
    expect(await all(r.room, "SELECT revoked_at FROM member WHERE principal_id = ?", r.requester.id)).toEqual([{ revoked_at: null }]);
    const before = await everything(r);
    expect(refused(await switchedOn(() => ask(r)))).toEqual([403, "not_allowed"]);
    expect(await everything(r)).toBe(before);
    // Once the room has recorded their place ended, they are refused as someone no longer in it.
    await inRoom(r.room, (s) => void s.exec("UPDATE member SET revoked_at = 1 WHERE principal_id = ?", r.requester.id));
    const after = await everything(r);
    expect(refused(await switchedOn(() => ask(r)))).toEqual([403, "access_revoked"]);
    expect(await everything(r)).toBe(after);
  });

  it("refuses on a fact that was read before a task's name, and before an unread fact", async () => {
    // A member with no grant naming a task that isn't there: who is asking is settled first.
    const r = await room();
    await inRoom(r.room, (s) => void s.exec("DELETE FROM provider_grant"));
    const before = await everything(r);
    expect(refused(await switchedOn(() => ask(r, { task_id: "tsk_rq_none", commit_sha: SHA })))).toEqual([403, "grant_required"]);
    expect(await everything(r)).toBe(before);
    // A private room whose organization's release switch and delegation can't be read (test builds: an organization
    // whose ID has this prefix doesn't answer): the private room was read, and refuses by its own code.
    const quiet = await room({ org: `org_unavailable_rq_${rooms + 1}` });
    await inRoom(quiet.room, (s) => void s.exec("UPDATE workspace SET visibility = 'private'"));
    const quietBefore = await everything(quiet);
    expect(refused(await switchedOn(() => ask(quiet)))).toEqual([409, "release_needs_public_room"]);
    // The control: public again, nothing read fails, and the unread facts decide: nothing is written on them.
    await inRoom(quiet.room, (s) => void s.exec("UPDATE workspace SET visibility = 'public'"));
    expect(refused(await switchedOn(() => ask(quiet)))).toEqual([503, "standing_unknown"]);
    expect(await everything(quiet)).toBe(quietBefore);
  });

  it("gives a stored answer back only to someone who may still ask, by the code that holds now", async () => {
    const r = await room();
    const first = await switchedOn(() => ask(r, undefined, r.requester, "rq-replay"));
    expect(first.status, first.text).toBe(200);
    // The grant revoked, then the same request again under the same key.
    await inRoom(r.room, (s) => void s.exec("UPDATE provider_grant SET revoked_at = 1"));
    const before = await everything(r);
    const replay = await switchedOn(() => ask(r, undefined, r.requester, "rq-replay"));
    expect(refused(replay)).toEqual([403, "grant_required"]);
    expect(replay.text).not.toContain(first.body.id);
    expect(await everything(r)).toBe(before);
    // The room made private: the same key is refused by that, too.
    await inRoom(r.room, (s) => { s.exec("UPDATE provider_grant SET revoked_at = NULL"); s.exec("UPDATE workspace SET visibility = 'private'"); });
    expect(refused(await switchedOn(() => ask(r, undefined, r.requester, "rq-replay")))).toEqual([409, "release_needs_public_room"]);
    // With everything holding again, the stored answer comes back as it was.
    await inRoom(r.room, (s) => void s.exec("UPDATE workspace SET visibility = 'public'"));
    expect((await switchedOn(() => ask(r, undefined, r.requester, "rq-replay"))).body).toEqual(first.body);
  });

  it("decides nothing, and writes nothing, when the requester's or the grant giver's own record can't answer", async () => {
    // Test builds: a person whose ID has this prefix has a `Principal` that doesn't answer the departure question.
    for (const which of ["requester", "giver"] as const) {
      const r = await room();
      const silent: Who = { id: `per_unavailable_rq_${which}`, org: r.org };
      await inRoom(r.room, (s) => {
        s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", silent.id, r.org, which === "giver" ? "admin" : "member", r.owner.id);
        if (which === "requester") { s.exec("UPDATE provider_grant SET principal_id = ?", silent.id); s.exec("UPDATE task SET requester_id = ?", silent.id); }
        else s.exec("UPDATE provider_grant SET delegated_by = ?", silent.id);
      });
      const before = await everything(r);
      const answer = await switchedOn(() => ask(r, undefined, which === "requester" ? silent : r.requester));
      expect(refused(answer), which).toEqual([503, "standing_unknown"]);
      expect(await everything(r), which).toBe(before);
    }
  });
});

describe("where a release may be asked for", () => {
  it("only where release may happen at all, each refused by its own code, writing nothing", async () => {
    const cases: [string, string[], [number, string]][] = [
      ["a private room", ["UPDATE workspace SET visibility = 'private'"], [409, "release_needs_public_room"]],
      ["release off in the room", ["UPDATE release_config SET enabled = 0"], [409, "release_off"]],
      ["the app suspended by an operator", ["INSERT INTO app_label (label, current, created_at, suspended_at, suspension_reason) VALUES ('rqsuspended', 1, 1, 1, 'abuse')"], [409, "app_suspended"]],
      ["the public surface suspended", ["UPDATE workspace SET suspended_at = 1"], [409, "public_surface_suspended"]],
      ["the repository's link not ready", ["UPDATE repo_link SET status = 'degraded'"], [409, "repo_not_ready"]],
      ["no repository linked", ["DELETE FROM repo_link"], [409, "repo_not_ready"]],
      ["an archived room", ["UPDATE workspace SET status = 'archived'"], [409, "workspace_archived"]],
    ];
    for (const [why, statements, want] of cases) {
      const r = await room();
      await inRoom(r.room, (s) => { for (const statement of statements) s.exec(statement); });
      const before = await everything(r);
      const answer = await switchedOn(() => ask(r));
      expect(refused(answer), `${why}: ${answer.text}`).toEqual(want);
      expect(await everything(r), why).toBe(before);
    }
  });

  it("isn't there while release is switched off for the deployment: answered as an unknown route, writing nothing", async () => {
    const r = await room();
    const before = await everything(r);
    const real = await ask(r);
    const unknown = await api(r.requester, "POST", `${path(r)}x`, { task_id: TASK, commit_sha: SHA });
    expect([real.status, real.code]).toEqual([404, "not_found"]);
    expect([real.status, real.text]).toEqual([unknown.status, unknown.text]);
    expect(await everything(r)).toBe(before);
  });
});

describe("what may be asked for (podster_core::release_request)", () => {
  it("only the commit Podster's merge confirmed for a completed task the caller can see, each refused by its code", async () => {
    const cases: [string, unknown, string[], [number, string]][] = [
      ["another commit than the merge's", { task_id: TASK, commit_sha: OTHER_SHA }, [], [409, "commit_not_releasable"]],
      ["a task not completed", undefined, ["UPDATE task SET status = 'submitted'"], [409, "commit_not_releasable"]],
      ["a merge Podster didn't call", undefined, ["UPDATE task_change SET merge_called_at = NULL"], [409, "commit_not_releasable"]],
      ["a merge not confirmed", undefined, ["UPDATE task_change SET merge_state = 'requested'"], [409, "commit_not_releasable"]],
      ["a merge in another repository", undefined, ["UPDATE task_change SET provider_repo_id = 1"], [409, "commit_not_releasable"]],
      ["a task with no change", undefined, ["DELETE FROM task_change"], [409, "commit_not_releasable"]],
      ["a task that isn't there", { task_id: "tsk_rq_none", commit_sha: SHA }, [], [404, "task_not_found"]],
      ["another environment", { task_id: TASK, commit_sha: SHA, environment: "staging" }, [], [400, "invalid_argument"]],
      ["a field the request doesn't take", { task_id: TASK, commit_sha: SHA, label: "mine" }, [], [400, "invalid_argument"]],
      ["no commit", { task_id: TASK }, [], [400, "invalid_argument"]],
      ["a reviewer who wasn't a person, where the room requires one", undefined, ["UPDATE workspace SET require_person_review = 1", "UPDATE task_change SET reviewer_id = 'agt_rq_reviewer'"], [409, "reviewer_rule_changed"]],
      ["an app held because nobody may release", undefined, [`UPDATE release_hold SET cause = 'no_releaser', held_at = 1, until = ${T + DAY}`], [409, "no_releaser"]],
    ];
    for (const [why, body, statements, want] of cases) {
      const r = await room();
      await inRoom(r.room, (s) => { for (const statement of statements) s.exec(statement); });
      const before = await everything(r);
      const answer = await switchedOn(() => ask(r, body));
      expect(refused(answer), `${why}: ${answer.text}`).toEqual(want);
      expect(await everything(r), why).toBe(before);
    }
  });

  it("at most 20 asks in a rolling day, declined and failed ones included, by the room's clock", async () => {
    const r = await room();
    await inRoom(r.room, (s) => {
      s.exec("INSERT INTO app_label (label, current, retired_at, created_at) VALUES ('rqold', NULL, 1, 1)");
      for (let n = 0; n < 20; n += 1) {
        const declined = n % 2 === 0;
        s.exec(
          `INSERT INTO release (id, commit_sha, task_id, state, label, config_version, release_epoch, requested_by, requested_at, declined_by, declined_at, failure_code, updated_at) VALUES (?, ?, ?, ?, 'rqold', 3, 2, ?, ?, ?, ?, ?, 1)`,
          `rel_${n.toString(16).padStart(32, "0")}`, OTHER_SHA, TASK, declined ? "declined" : "failed", r.requester.id,
          n === 0 ? T - DAY + 1 : T - 1, declined ? r.owner.id : null, declined ? 1 : null, declined ? null : "release_epoch_moved",
        );
      }
    });
    const before = await everything(r);
    expect(refused(await switchedOn(() => ask(r)))).toEqual([429, "release_limit"]);
    expect(await everything(r)).toBe(before);
    // A millisecond on, the oldest is a day old and no longer counts.
    await inRoom(r.room, (s) => void s.exec("UPDATE test_release_clock SET now = ?", T + 1));
    expect((await switchedOn(() => ask(r))).status).toBe(200);
  });
});

describe("the gate on the release path", () => {
  it("refuses the request where release is switched on and a provider is configured, before anything is read or written", async () => {
    const r = await room();
    // The path is complete since 2026-11-23; a test build closes it for this room alone, to show what it refused.
    await inRoom(r.room, (s) => void s.exec("CREATE TABLE test_release_path_incomplete (x INTEGER)"));
    const before = await everything(r);
    // This room's provider is configured, as the test Worker's is, and release is switched on for the command.
    await inRoom(r.room, (s) => void s.exec("DROP TABLE test_content_provider_off"));
    try {
      expect(refused(await switchedOn(() => ask(r)))).toEqual([409, "release_not_available"]);
    } finally { await inRoom(r.room, (s) => void s.exec("CREATE TABLE test_content_provider_off (x INTEGER)")); }
    expect(await everything(r)).toBe(before);
    // The constant is true since 2026-11-23, and set in one place.
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    expect(sources["workspace/release_commit.rs"]).toContain("pub(crate) const RELEASE_PATH_COMPLETE: bool = true;");
    // The request passes the gate before it reads anything outside the room.
    const source = sources["workspace/release_request.rs"];
    const reads = source.slice(source.indexOf("async fn release_request_reads"));
    expect(reads.indexOf("self.release_path_open().await?")).toBeGreaterThan(-1);
    expect(reads.indexOf("self.release_path_open().await?")).toBeLessThan(reads.indexOf("self.on_reads()"));
  });
});
