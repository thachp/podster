import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet, manualAlarms } from "./alarm";

// M6 step 6, 6f: a person approves or declines a release awaiting approval (`approveRelease`, `declineRelease`), the
// second half of ADR 0010's "a `deploy_release` command, then a person's approval". Approval reads every outside fact
// again for itself, runs core's whole recheck, and queues the release for the driver only when every check holds;
// a fact read and failing ends the release `failed` with its code, and one that couldn't be read writes nothing.
// Before a release is queued, its label's row is in D1's lookup table and its default host has a serve row with no
// script. Declining needs no gate.
//
// Each room's provider is switched off, so the gate on the release path is open, except in the gate's own test.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
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
  if (method !== "GET") headers["idempotency-key"] = idempotencyKey ?? `ra-key-${++counter}`;
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

/** Release switched on for the test Worker, as no deployment is, while `run` runs. */
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

/** An agent, registered once: it never approves, refused by its kind before the room is asked. */
const AGENT: Who = { id: "agt_ra_agent", org: "org_ra_agents", kind: "agent" };

const SHA = "a7".repeat(20);
const REPO_ID = 987650306;
const TASK = "tsk_ra_1";
const T = 1_800_000_000_000;
let rooms = 0;
/** Every room a test made, quieted after each test. */
const made: string[] = [];

type Room = { room: string; owner: Who; admin: Who; requester: Who; org: string; release: string; label: string };
/**
 * A public room where a release may be approved: release on at version 3 and epoch 2, a ready repository, a member
 * holding a `deploy` grant the owner gave, a completed task whose reviewed commit Podster's merge confirmed, and a
 * release of it that member asked for, through the route, awaiting approval. Its label isn't in D1's lookup table yet.
 * The room's provider is switched off. `requesterRole` makes the one who asks an admin, to approve their own.
 */
async function room(opts: { org?: string; admin?: string; requesterRole?: "member" | "admin" } = {}): Promise<Room> {
  const n = ++rooms;
  const org = opts.org ?? `org_ra_${n}`;
  const owner: Who = { id: `per_ra_owner_${n}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Release approval" });
  expect(created.status).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  const requester: Who = { id: `per_ra_req_${n}`, org };
  const admin: Who = { id: opts.admin ?? `per_ra_adm_${n}`, org };
  await inRoom(id, (sql) => {
    for (const [who, role] of [[requester, opts.requesterRole ?? "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, owner.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `ra-${n}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/approval', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO_ID, owner.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_ra', ?, 'github', ?, 'deploy', ?, 1)", requester.id, REPO_ID, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, requester.id, admin.id);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO_ID, SHA, admin.id);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
    sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
  });
  // The room's alarms are the test's from here on.
  await manualAlarms(stub(id));
  const asked = await switchedOn(() => api(requester, "POST", `/v1/workspaces/${id}/releases`, { task_id: TASK, commit_sha: SHA }));
  expect(asked.status, asked.text).toBe(200);
  const [{ label }] = await all(id, "SELECT label FROM release WHERE id = ?", asked.body.id);
  return { room: id, owner, admin, requester, org, release: asked.body.id, label };
}

const path = (r: Room, verb: "approve" | "decline", release = r.release) => `/v1/workspaces/${r.room}/releases/${release}/${verb}`;
const approve = (r: Room, who: Who = r.owner, idempotencyKey?: string) => switchedOn(() => api(who, "POST", path(r, "approve"), undefined, idempotencyKey));
const decline = (r: Room, who: Who = r.owner, idempotencyKey?: string) => switchedOn(() => api(who, "POST", path(r, "decline"), undefined, idempotencyKey));
const refused = (answer: { status: number; code?: string }) => [answer.status, answer.code];
const releaseRow = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT state, approved_by, approved_at, declined_by, declined_at, failure_code, finished_at FROM release WHERE id = ?", r.release).one());
/** The label's row in D1's lookup table, if any. */
const indexRow = (label: string) => BINDINGS.DB.prepare("SELECT label, workspace_id, created_at FROM app_label_index WHERE label = ?").bind(label).first();
/** Everything the room could write, so a refusal can be shown to have written nothing in the room. */
const everything = (r: Room) => inRoom(r.room, (sql) => JSON.stringify(["release", "app_label", "audit_event", "event", "outbox", "serve_state", "serve_apply", "script_delete", "unpublish", "release_job"].map((table) => sql.exec(`SELECT * FROM ${table}`).toArray())));
const recipients = async (r: Room, type: string) => {
  const [event] = await all(r.room, "SELECT id FROM event WHERE type = ? AND subject_id = ?", type, r.release);
  return (await all(r.room, "SELECT recipient_principal_id AS who FROM outbox WHERE event_id = ? ORDER BY who", event.id)).map((o: any) => o.who);
};
/** The operators' finding that a label's lookup row is another room's, if they were told. */
const finding = (label: string) => inModeration((sql) => sql.exec("SELECT code, subject FROM takedown_finding WHERE code = 'app_label_taken' AND subject = ?", label).toArray());
const departs = (who: Who) => api({ ...who, departure: { person: who.id, org: who.org, left_at: Date.now() } }, "POST", "/v1/org-departures", {});
/** The content domain's stop, set or cleared in its home, the Moderation object. */
async function stop(stopped: boolean) {
  await moderation().fetch("https://do/content-stop");
  await inModeration((s) => void s.exec(
    "INSERT INTO content_stop (singleton, stopped, reason, at, version, updated_at) VALUES (1, ?, ?, ?, 1, 1) ON CONFLICT (singleton) DO UPDATE SET stopped = excluded.stopped, reason = excluded.reason, at = excluded.at, version = version + 1",
    stopped ? 1 : 0, stopped ? "illegal" : null, stopped ? 1 : null,
  ));
}

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const registrar: Who = { id: "per_ra_registrar", org: AGENT.org, adminOrgs: [AGENT.org] };
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(registrar) }, body: JSON.stringify({ org_id: AGENT.org, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register ${AGENT.id}: ${res.status}`);
});

describe("approving a release (M6 step 6, 6f)", () => {
  it("queues it for the driver once every check holds, with the app's address made first", async () => {
    const r = await room();
    // An agent holding the admin role, which must hear nothing of it.
    await inRoom(r.room, (s) => void s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'admin', ?, 1)", AGENT.id, AGENT.org, r.owner.id));
    expect(await indexRow(r.label)).toBeNull();
    const answer = await approve(r);
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body).toEqual({
      id: r.release, commit_sha: SHA, environment: "production", state: "queued", requested_by: r.requester.id, requested_at: T,
      approved_by: r.owner.id, approved_at: T, declined_by: null, declined_at: null, result_url: null, failure_code: null, finished_at: null, rollback_to: null,
    });
    // The address: the label's lookup row, this room's, recorded in the room; and the default host's serve row, which
    // names no script, so it serves nothing.
    expect(await indexRow(r.label)).toEqual({ label: r.label, workspace_id: r.room, created_at: T });
    expect(await all(r.room, "SELECT indexed_at FROM app_label WHERE label = ?", r.label)).toEqual([{ indexed_at: T }]);
    expect(await all(r.room, "SELECT host, kind, label, release_id, script_name, version, closed FROM serve_state")).toEqual([
      { host: `${r.label}.${FAKE.domain}`, kind: "default", label: null, release_id: null, script_name: null, version: 1, closed: 0 },
    ]);
    // On the trail: the approval by the owner, told to the other people who may approve and to whoever asked; never
    // to the agent, and never to the owner, who did it.
    const audited = await all(r.room, "SELECT actor_id, action, target_id, prior_json, new_json FROM audit_event WHERE action = 'release.approved'");
    expect(audited).toEqual([{ actor_id: r.owner.id, action: "release.approved", target_id: r.release, prior_json: '{"state":"awaiting_approval"}', new_json: '{"state":"queued"}' }]);
    expect(await recipients(r, "release.approved")).toEqual([r.admin.id, r.requester.id].sort());
    // The job owns it now: its recheck takes it up, and holds.
    const pass = await switchedOn(() => stub(r.room).fetch("https://do/internal/release-recheck", { method: "POST", body: JSON.stringify({ release_id: r.release }) }).then((res: Response) => res.json()));
    expect(pass).toEqual({ release_id: r.release, state: "queued", rechecked: true, reason: null });
    // It is no longer offered for approval.
    expect((await switchedOn(() => api(r.owner, "GET", `/v1/workspaces/${r.room}/release-approvals`))).body).toEqual({ releases: [], more: false });
  });

  it("lets a person who may approve approve their own request, as ruled", async () => {
    const r = await room({ requesterRole: "admin" });
    const answer = await approve(r, r.requester);
    expect([answer.status, answer.body?.state, answer.body?.approved_by], answer.text).toEqual([200, "queued", r.requester.id]);
    expect(await recipients(r, "release.approved")).toEqual([r.admin.id, r.owner.id].sort());
  });

  it("answers a retry with the same key as the first time, writing nothing more", async () => {
    const r = await room();
    const first = await approve(r, r.owner, "ra-same");
    const after = await everything(r);
    const again = await approve(r, r.owner, "ra-same");
    expect(again.body).toEqual(first.body);
    expect(await everything(r)).toBe(after);
    // A new key: the release isn't awaiting approval any more.
    expect(refused(await approve(r))).toEqual([409, "invalid_transition"]);
  });

  it("gives a stored answer back only to someone who may still approve, by what was read for that retry", async () => {
    const r = await room();
    const first = await approve(r, r.admin, "ra-replay");
    expect(first.status, first.text).toBe(200);
    // Demoted, then the same request again under the same key.
    await inRoom(r.room, (s) => void s.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", r.admin.id));
    const before = await everything(r);
    const replay = await approve(r, r.admin, "ra-replay");
    expect(refused(replay)).toEqual([403, "not_allowed"]);
    expect(replay.text).not.toContain(r.release);
    expect(await everything(r)).toBe(before);
    // An admin again, but their own record now says they left their organization: refused by that, too.
    await inRoom(r.room, (s) => void s.exec("UPDATE member SET role = 'admin' WHERE principal_id = ?", r.admin.id));
    await departs(r.admin);
    expect(refused(await approve(r, r.admin, "ra-replay"))).toEqual([403, "not_allowed"]);
    expect(await everything(r)).toBe(before);
  });

  it("refuses a replay whose approver's own record can't answer, writing nothing", async () => {
    const r = await room({ admin: `per_unavailable_ra_${rooms + 1}` });
    // Test builds: a person whose ID has this prefix has a `Principal` that doesn't answer the departure question,
    // so their own first approval is undecided too.
    const before = await everything(r);
    expect(refused(await approve(r, r.admin, "ra-silent"))).toEqual([503, "standing_unknown"]);
    expect(await everything(r)).toBe(before);
    // The owner approves; a replay of that answer under the owner's key still asks the owner's record.
    const first = await approve(r, r.owner, "ra-owner");
    expect(first.body.state).toBe("queued");
    expect((await approve(r, r.owner, "ra-owner")).body).toEqual(first.body);
  });
});

describe("who may approve or decline", () => {
  it("only the room's owner or an admin, as a person, still in their organization", async () => {
    for (const verb of ["approve", "decline"] as const) {
      const cases: [string, (r: Room) => unknown, (r: Room) => Who, [number, string]][] = [
        ["the member who asked", () => undefined, (r) => r.requester, [403, "not_allowed"]],
        ["an agent holding the admin role", (r) => inRoom(r.room, (s) => void s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'admin', ?, 1)", AGENT.id, AGENT.org, r.owner.id)), () => AGENT, [403, "not_allowed"]],
        ["an admin removed from the room", (r) => inRoom(r.room, (s) => void s.exec("UPDATE member SET revoked_at = 1 WHERE principal_id = ?", r.admin.id)), (r) => r.admin, [403, "access_revoked"]],
        ["an admin who left their organization", (r) => departs(r.admin), (r) => r.admin, [403, "not_allowed"]],
      ];
      for (const [why, change, who, want] of cases) {
        const r = await room();
        await change(r);
        const before = await everything(r);
        const answer = await (verb === "approve" ? approve : decline)(r, who(r));
        expect(refused(answer), `${verb}: ${why}: ${answer.text}`).toEqual(want);
        expect(await everything(r), `${verb}: ${why}`).toBe(before);
      }
    }
  });

  it("reads the approver's own record before anything else outside the room, and writes nothing to D1 for one who left", async () => {
    for (const [why, admin, change, want] of [
      ["left their organization", undefined, (r: Room) => departs(r.admin), [403, "not_allowed"]],
      ["their record doesn't answer", `per_unavailable_ra_s5_${rooms + 1}`, async () => undefined, [503, "standing_unknown"]],
    ] as const) {
      const r = await room({ admin });
      await change(r);
      // Test builds: each round of the release's outside reads, which apply the deployment's setting and the
      // organization's switch, is counted here.
      await inRoom(r.room, (s) => void s.exec("CREATE TABLE test_release_reads_seen (release_id TEXT)"));
      const before = await everything(r);
      expect(refused(await approve(r, r.admin)), why).toEqual(want);
      expect(await all(r.room, "SELECT * FROM test_release_reads_seen"), why).toEqual([]);
      expect(await indexRow(r.label), why).toBeNull();
      expect(await everything(r), why).toBe(before);
      // The control: the owner's approval makes those reads.
      expect((await approve(r)).body.state, why).toBe("queued");
      expect(await all(r.room, "SELECT release_id FROM test_release_reads_seen"), why).toEqual([{ release_id: r.release }]);
    }
  });

  it("refuses a decline whose decider's own record can't answer, writing nothing", async () => {
    const r = await room({ admin: `per_unavailable_ra_dec_${rooms + 1}` });
    const before = await everything(r);
    expect(refused(await decline(r, r.admin))).toEqual([503, "standing_unknown"]);
    expect(await everything(r)).toBe(before);
  });

  it("refuses a release that isn't awaiting approval, or that the room doesn't have", async () => {
    const r = await room();
    await inRoom(r.room, (s) => void s.exec("UPDATE release SET state = 'declined', declined_by = ?, declined_at = 1 WHERE id = ?", r.owner.id, r.release));
    const before = await everything(r);
    expect(refused(await approve(r))).toEqual([409, "invalid_transition"]);
    expect(refused(await decline(r))).toEqual([409, "invalid_transition"]);
    const missing = `rel_${"0".repeat(32)}`;
    expect(refused(await switchedOn(() => api(r.owner, "POST", path(r, "approve", missing))))).toEqual([404, "not_found"]);
    expect(refused(await switchedOn(() => api(r.owner, "POST", path(r, "decline", "rel_notone"))))).toEqual([404, "not_found"]);
    expect(await everything(r)).toBe(before);
  });

  it("isn't there while release is switched off for the deployment: answered as an unknown route, writing nothing", async () => {
    const r = await room();
    const before = await everything(r);
    for (const verb of ["approve", "decline"] as const) {
      const real = await api(r.owner, "POST", path(r, verb), {});
      const unknown = await api(r.owner, "POST", `${path(r, verb)}x`, {});
      expect([real.status, real.code], verb).toEqual([404, "not_found"]);
      expect([real.status, real.text], verb).toEqual([unknown.status, unknown.text]);
    }
    expect(await everything(r)).toBe(before);
  });
});

describe("approval reads every outside fact again, and runs core's whole recheck", () => {
  it("ends the release failed with its code when a fact read now fails, told to people only", async () => {
    const cases: [string, (r: Room) => Promise<unknown>, string][] = [
      // Each of these was read and held when the release was asked for.
      ["the requester has left their organization", (r) => departs(r.requester), "requester_lost_authority"],
      ["the requester's grant was revoked", (r) => inRoom(r.room, (s) => void s.exec("UPDATE provider_grant SET revoked_at = 1")), "requester_lost_authority"],
      ["the organization's provisioning delegation was taken back", (r) => inRoom(r.room, (s) => { s.exec("CREATE TABLE test_release_delegation_answer (answer TEXT)"); s.exec("INSERT INTO test_release_delegation_answer (answer) VALUES (?)", '{"granted":false}'); }), "release_not_delegated"],
      ["the room was made private", (r) => inRoom(r.room, (s) => void s.exec("UPDATE workspace SET visibility = 'private'")), "release_needs_public_room"],
      // Archived and suspended by direct writes, which move no epoch, so the recheck itself is what refuses.
      ["the room was archived", (r) => inRoom(r.room, (s) => void s.exec("UPDATE workspace SET status = 'archived'")), "workspace_archived"],
      ["the app was suspended by an operator", (r) => inRoom(r.room, (s) => void s.exec("UPDATE app_label SET suspended_at = 1, suspension_reason = 'abuse' WHERE label = ?", r.label)), "app_suspended"],
      ["the repository's link isn't ready", (r) => inRoom(r.room, (s) => void s.exec("UPDATE repo_link SET status = 'degraded'")), "repo_not_ready"],
      ["the room now requires a person as reviewer", (r) => inRoom(r.room, (s) => { s.exec("UPDATE workspace SET require_person_review = 1"); s.exec("UPDATE task_change SET reviewer_id = 'agt_ra_reviewer'"); }), "reviewer_rule_changed"],
      // The release's configuration version and epoch must still be the room's current ones.
      ["the room's release configuration changed", (r) => inRoom(r.room, (s) => void s.exec("UPDATE release_config SET version = 4")), "release_config_changed"],
      ["the release's epoch isn't the room's", (r) => inRoom(r.room, (s) => void s.exec("UPDATE release SET release_epoch = 3 WHERE id = ?", r.release)), "release_epoch_moved"],
    ];
    for (const [why, change, code] of cases) {
      const r = await room();
      await inRoom(r.room, (s) => void s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'admin', ?, 1)", AGENT.id, AGENT.org, r.owner.id));
      await change(r);
      const answer = await approve(r);
      expect([answer.status, answer.body?.state, answer.body?.failure_code, answer.body?.approved_by], `${why}: ${answer.text}`).toEqual([200, "failed", code, null]);
      expect(await releaseRow(r), why).toMatchObject({ state: "failed", failure_code: code, finished_at: T, approved_by: null });
      // Nothing queued and nothing toward serving it.
      expect(await all(r.room, "SELECT * FROM serve_state"), why).toEqual([]);
      expect(await all(r.room, "SELECT action FROM audit_event WHERE action = 'release.approved'"), why).toEqual([]);
      // Told to the people who may approve, and to whoever asked; not to the agent.
      expect(await recipients(r, "release.failed"), why).toEqual([r.admin.id, r.requester.id].sort());
    }
  });

  it("fails it while the whole content domain is stopped, which the request never read", async () => {
    const r = await room();
    try {
      await stop(true);
      const answer = await approve(r);
      expect([answer.body?.state, answer.body?.failure_code], answer.text).toEqual(["failed", "release_stopped"]);
    } finally { await stop(false); }
  });

  it("decides nothing, and writes nothing in the room, when a fact can't be read and nothing read fails", async () => {
    // The stop unreadable.
    const r = await room();
    const before = await everything(r);
    await moderation().fetch("https://do/content-stop");
    try {
      await inModeration((s) => void s.exec("CREATE TABLE test_stop_unreadable (x INTEGER)"));
      expect(refused(await approve(r))).toEqual([503, "standing_unknown"]);
    } finally { await inModeration((s) => void s.exec("DROP TABLE IF EXISTS test_stop_unreadable")); }
    expect(await everything(r)).toBe(before);
    expect(await releaseRow(r)).toMatchObject({ state: "awaiting_approval", approved_by: null });
    // The control: readable again, and the same release is approved.
    expect((await approve(r)).body.state).toBe("queued");

    // The requester's own record not answering, and the organization's delegation not a yes or a no.
    for (const which of ["requester", "delegation"] as const) {
      const q = await room();
      if (which === "requester") {
        const silent = `per_unavailable_ra_req_${rooms}`;
        await inRoom(q.room, (s) => {
          s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, 'member', ?, 1)", silent, q.org, q.owner.id);
          s.exec("UPDATE release SET requested_by = ? WHERE id = ?", silent, q.release);
          s.exec("UPDATE provider_grant SET principal_id = ?", silent);
        });
      } else {
        await inRoom(q.room, (s) => { s.exec("CREATE TABLE test_release_delegation_answer (answer TEXT)"); s.exec("INSERT INTO test_release_delegation_answer (answer) VALUES ('{}')"); });
      }
      const qBefore = await everything(q);
      expect(refused(await approve(q)), which).toEqual([503, "standing_unknown"]);
      expect(await everything(q), which).toBe(qBefore);
    }
  });

  it("fails it on a fact that was read even while another couldn't be", async () => {
    const r = await room();
    await inRoom(r.room, (s) => void s.exec("UPDATE workspace SET visibility = 'private'"));
    await moderation().fetch("https://do/content-stop");
    try {
      await inModeration((s) => void s.exec("CREATE TABLE test_stop_unreadable (x INTEGER)"));
      const answer = await approve(r);
      expect([answer.body?.state, answer.body?.failure_code], answer.text).toEqual(["failed", "release_needs_public_room"]);
    } finally { await inModeration((s) => void s.exec("DROP TABLE IF EXISTS test_stop_unreadable")); }
  });
});

describe("the app's address", () => {
  it("refuses for good, telling operators, while the label's lookup row names another room; never replaced", async () => {
    const r = await room();
    await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, 'ws_ra_someone_else', 1)").bind(r.label).run();
    const before = await everything(r);
    expect(refused(await approve(r))).toEqual([409, "release_label_taken"]);
    expect(await everything(r)).toBe(before);
    expect(await indexRow(r.label)).toEqual({ label: r.label, workspace_id: "ws_ra_someone_else", created_at: 1 });
    expect(await finding(r.label)).toEqual([{ code: "app_label_taken", subject: r.label }]);
    // The control: once the row is gone, the same release is approved, and the row is this room's.
    await BINDINGS.DB.prepare("DELETE FROM app_label_index WHERE label = ?").bind(r.label).run();
    expect((await approve(r)).body.state).toBe("queued");
    expect(await indexRow(r.label)).toMatchObject({ workspace_id: r.room });
  });

  it("waits, writing nothing in the room, while D1 can't be written", async () => {
    const r = await room();
    const create = (BINDINGS.TEST_D1_SCHEMA as string).split(";").map((x) => x.trim()).filter((x) => /^(CREATE TABLE\s+app_label_index|ALTER TABLE\s+app_label_index)\b/i.test(x));
    expect(create).toHaveLength(2);
    const kept = (await BINDINGS.DB.prepare("SELECT * FROM app_label_index").all()).results;
    const before = await everything(r);
    await BINDINGS.DB.prepare("DROP TABLE app_label_index").run();
    try {
      expect(refused(await approve(r))).toEqual([503, "release_address_pending"]);
    } finally {
      for (const statement of create) await BINDINGS.DB.prepare(statement).run();
      for (const row of kept as any[]) await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at, approved_at) VALUES (?, ?, ?, ?)").bind(row.label, row.workspace_id, row.created_at, row.approved_at).run();
    }
    expect(await everything(r)).toBe(before);
    expect(await all(r.room, "SELECT indexed_at FROM app_label")).toEqual([{ indexed_at: null }]);
    expect((await approve(r)).body.state).toBe("queued");
  });

  it("answers release_not_available, writing nothing in the room, where no content domain is configured", async () => {
    const r = await room();
    await inRoom(r.room, (s) => void s.exec("CREATE TABLE test_content_domain_unset (x INTEGER)"));
    const before = await everything(r);
    expect(refused(await approve(r))).toEqual([409, "release_not_available"]);
    expect(await everything(r)).toBe(before);
    expect(await all(r.room, "SELECT indexed_at FROM app_label")).toEqual([{ indexed_at: null }]);
  });

  describe("an earlier address, from a label an unpublish retired", () => {
    /** A room whose earlier default host, `old`, was taken down at version 4, and whatever its applier says of it. */
    async function earlier(apply: string | null) {
      const r = await room();
      const oldLabel = `raold${rooms}`;
      const old = `${oldLabel}.${FAKE.domain}`;
      await inRoom(r.room, (s) => {
        s.exec("INSERT INTO app_label (label, current, retired_at, created_at, indexed_at) VALUES (?, NULL, 1, 1, 1)", oldLabel);
        s.exec("INSERT INTO serve_state (host, kind, version, updated_at) VALUES (?, 'default', 4, 1)", old);
        if (apply) s.exec(apply, ...[old, `${oldLabel}.rel_${"1".repeat(32)}`].slice(0, apply.split("?").length - 1));
      });
      return { r, old };
    }
    const STILL_SERVING = "INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 3, ?, 1, 1)";

    it("waits while it may still serve something, writing nothing", async () => {
      const { r } = await earlier(STILL_SERVING);
      const before = await everything(r);
      expect(refused(await approve(r))).toEqual([503, "release_address_pending"]);
      expect(await everything(r)).toBe(before);
    });

    it("counts it down when the applier confirmed it, when the provider refused that version, or when no applier ever wrote it", async () => {
      for (const [why, apply] of [
        ["applied, with nothing served", "INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 4, NULL, 1, 1)"],
        ["refused at that version", "INSERT INTO serve_apply (host, refused_version, last_code, updated_at) VALUES (?, 4, 'host_not_this_rooms', 1)"],
        ["never written, as with no provider", null],
      ] as const) {
        const { r, old } = await earlier(apply);
        const answer = await approve(r);
        expect([answer.status, answer.body?.state], `${why}: ${answer.text}`).toEqual([200, "queued"]);
        // The new address is the room's default host; the earlier one is kept, retired, for its applier to answer for.
        expect(await all(r.room, "SELECT host, script_name FROM serve_state ORDER BY host = ?", old), why).toEqual([
          { host: `${r.label}.${FAKE.domain}`, script_name: null }, { host: old, script_name: null },
        ]);
        expect(await all(r.room, "SELECT host, retired_at FROM serve_retired"), why).toEqual([{ host: old, retired_at: T }]);
      }
    });

    it("keeps the earlier host's rows, so a write to it that lands late is still put right", async () => {
      const { r, old } = await earlier("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 4, NULL, 1, 1)");
      expect((await approve(r)).body.state).toBe("queued");
      // The rows are still there, and the reconcile's question about the old host gets the room's answer: nothing.
      expect(await all(r.room, "SELECT host, version FROM serve_state WHERE host = ?", old)).toEqual([{ host: old, version: 4 }]);
      expect(await all(r.room, "SELECT host, applied_version FROM serve_apply WHERE host = ?", old)).toEqual([{ host: old, applied_version: 4 }]);
      // A late write landed: the room forgets it applied the host, as the reconcile does, and its applier is due for
      // it again, wanting nothing there.
      await inRoom(r.room, (s) => void s.exec("UPDATE serve_apply SET applied_version = NULL, applied_at = NULL WHERE host = ?", old));
      const due = await inRoom(r.room, (s) => s.exec("SELECT s.host, s.script_name FROM serve_state s LEFT JOIN serve_apply a ON a.host = s.host WHERE a.applied_version IS NULL OR a.applied_version != s.version ORDER BY s.host = ?", old).toArray());
      expect(due).toContainEqual({ host: old, script_name: null });
    });
  });
});

describe("the labels' upkeep", () => {
  it("writes nothing to D1 while release is off, or while the gate on the release path is closed", async () => {
    const r = await room();
    // Release off for the deployment: the alarm writes nothing.
    await alarmPass(stub(r.room));
    expect(await indexRow(r.label)).toBeNull();
    expect(await all(r.room, "SELECT indexed_at FROM app_label")).toEqual([{ indexed_at: null }]);
    // Release on, and a provider configured, with the release path incomplete: nothing either.
    await inRoom(r.room, (s) => void s.exec("DROP TABLE test_content_provider_off"));
    try {
      await switchedOn(() => alarmPass(stub(r.room)));
    } finally { await inRoom(r.room, (s) => void s.exec("CREATE TABLE test_content_provider_off (x INTEGER)")); }
    expect(await indexRow(r.label)).toBeNull();
    expect(await all(r.room, "SELECT indexed_at FROM app_label")).toEqual([{ indexed_at: null }]);
    // The control: on, with the gate open, the label is written, by the release commands' clock.
    await switchedOn(() => alarmPass(stub(r.room)));
    expect(await indexRow(r.label)).toEqual({ label: r.label, workspace_id: r.room, created_at: T });
    expect(await all(r.room, "SELECT indexed_at FROM app_label")).toEqual([{ indexed_at: T }]);
  });

  it("leaves a label unmarked, to be tried again, when D1 doesn't answer: only another room's row marks it refused", async () => {
    const r = await room();
    const create = (BINDINGS.TEST_D1_SCHEMA as string).split(";").map((x) => x.trim()).filter((x) => /^(CREATE TABLE\s+app_label_index|ALTER TABLE\s+app_label_index)\b/i.test(x));
    const kept = (await BINDINGS.DB.prepare("SELECT * FROM app_label_index").all()).results;
    await BINDINGS.DB.prepare("DROP TABLE app_label_index").run();
    try {
      await switchedOn(() => alarmPass(stub(r.room)));
    } finally {
      for (const statement of create) await BINDINGS.DB.prepare(statement).run();
      for (const row of kept as any[]) await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at, approved_at) VALUES (?, ?, ?, ?)").bind(row.label, row.workspace_id, row.created_at, row.approved_at).run();
    }
    expect(await all(r.room, "SELECT indexed_at FROM app_label")).toEqual([{ indexed_at: null }]);
    await switchedOn(() => alarmPass(stub(r.room)));
    expect(await all(r.room, "SELECT indexed_at FROM app_label")).toEqual([{ indexed_at: T }]);
  });

  it("marks a label another room holds refused, tells operators, and an approval then refuses for good", async () => {
    const other = await room();
    await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, 'ws_ra_someone_else', 1)").bind(other.label).run();
    await switchedOn(() => alarmPass(stub(other.room)));
    expect(await all(other.room, "SELECT indexed_at FROM app_label")).toEqual([{ indexed_at: 0 }]);
    expect(await indexRow(other.label)).toMatchObject({ workspace_id: "ws_ra_someone_else" });
    expect(await finding(other.label)).toEqual([{ code: "app_label_taken", subject: other.label }]);
    expect(refused(await approve(other))).toEqual([409, "release_label_taken"]);
  });

  it("counts toward the repository-unpublish ceiling only a room an approval held for", async () => {
    // The ceiling's own query, as the source has it.
    const source = (JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>)["repo_ceiling.rs"];
    const from = source.slice(source.indexOf("fn rooms_with_apps"));
    const query = /\.prepare\("([^"]*)"\)/.exec(from)![1];
    expect(query).toContain("app_label_index");
    const count = async () => ((await BINDINGS.DB.prepare(query).first()) as any).n as number;
    const asked = await room();
    const approved = await room();
    const start = await count();
    // Both labels written to the lookup table; only one has had an approval.
    await switchedOn(() => alarmPass(stub(asked.room)));
    await switchedOn(() => alarmPass(stub(approved.room)));
    expect(await count()).toBe(start);
    expect((await approve(approved)).body.state).toBe("queued");
    await switchedOn(() => alarmPass(stub(approved.room)));
    expect(await count()).toBe(start + 1);
    expect(await all(approved.room, "SELECT approved_at, indexed_at FROM app_label_approval")).toEqual([{ approved_at: T, indexed_at: T }]);
    expect(await BINDINGS.DB.prepare("SELECT approved_at FROM app_label_index WHERE label = ?").bind(asked.label).first()).toEqual({ approved_at: null });
  });
});

describe("declining a release", () => {
  it("ends it declined, nothing indexed or served, told to people only", async () => {
    const r = await room();
    await inRoom(r.room, (s) => void s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'admin', ?, 1)", AGENT.id, AGENT.org, r.owner.id));
    const answer = await decline(r, r.admin);
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body).toMatchObject({ id: r.release, state: "declined", declined_by: r.admin.id, declined_at: T, approved_by: null, finished_at: T, failure_code: null });
    expect(await all(r.room, "SELECT * FROM serve_state")).toEqual([]);
    expect(await indexRow(r.label)).toBeNull();
    expect(await all(r.room, "SELECT actor_id, action, new_json FROM audit_event WHERE action = 'release.declined'")).toEqual([{ actor_id: r.admin.id, action: "release.declined", new_json: '{"state":"declined"}' }]);
    expect(await recipients(r, "release.declined")).toEqual([r.owner.id, r.requester.id].sort());
  });

  it("is allowed wherever the room is still there: private, archived, release off", async () => {
    for (const statement of ["UPDATE workspace SET visibility = 'private'", "UPDATE workspace SET status = 'archived'", "UPDATE release_config SET enabled = 0"]) {
      const r = await room();
      await inRoom(r.room, (s) => void s.exec(statement));
      const answer = await decline(r);
      expect([answer.status, answer.body?.state], `${statement}: ${answer.text}`).toEqual([200, "declined"]);
    }
  });

  it("gives a stored answer back only to someone who may still decline", async () => {
    const r = await room();
    const first = await decline(r, r.admin, "ra-decline");
    expect(first.body.state).toBe("declined");
    expect((await decline(r, r.admin, "ra-decline")).body).toEqual(first.body);
    await inRoom(r.room, (s) => void s.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", r.admin.id));
    const before = await everything(r);
    expect(refused(await decline(r, r.admin, "ra-decline"))).toEqual([403, "not_allowed"]);
    expect(await everything(r)).toBe(before);
  });
});

describe("the gate on the release path", () => {
  it("refuses approval where release is on and a provider is configured, before anything is read or written; declining passes", async () => {
    const r = await room();
    const before = await everything(r);
    // This room's provider is configured, as the test Worker's is, and release is switched on for the command.
    await inRoom(r.room, (s) => void s.exec("DROP TABLE test_content_provider_off"));
    try {
      expect(refused(await approve(r))).toEqual([409, "release_not_available"]);
      expect(await everything(r)).toBe(before);
      // Nothing written outside the room either: the lookup row is written only after the gate.
      expect(await indexRow(r.label)).toBeNull();
      // Declining only takes away: no gate.
      expect((await decline(r)).body.state).toBe("declined");
    } finally { await inRoom(r.room, (s) => void s.exec("CREATE TABLE test_content_provider_off (x INTEGER)")); }
    // The constant is still false, and the gate comes before any read.
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    expect(sources["workspace/release_commit.rs"]).toContain("pub(crate) const RELEASE_PATH_COMPLETE: bool = false;");
    const source = sources["workspace/release_approval.rs"];
    const reads = source.slice(source.indexOf("async fn approval_reads"));
    expect(reads.indexOf("self.release_path_open().await?")).toBeGreaterThan(-1);
    expect(reads.indexOf("self.release_path_open().await?")).toBeLessThan(reads.indexOf("self.release_reads_as("));
  });
});
