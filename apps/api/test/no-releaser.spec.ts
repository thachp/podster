import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet } from "./alarm";

// M6 step 6 (6d): ADR 0010's trigger "nobody who may release now remains", as the architect's interim rule (ruling 3,
// for the owner to review): no person who is the room's owner or one of its admins is in the room and still in their
// organization. An agent never counts. It is read from the room's own rows in the transaction of each command that
// changes who may release, and fires only when that command leaves nobody. Only a departure can do that today: the
// owner alone appoints, demotes and removes admins, and is a releaser themselves.
//
// Each room is given its rows through the test pool, as in `release-triggers.spec.ts`: an app serving an earlier
// release on its default host and a queued release of its own. Its provider is switched off.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; org: string; adminOrgs?: string[] };

async function assertion(who: Who, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 }, ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, opts: { key?: string; target?: Who } = {}) {
  const claims = opts.target ? { target_member: { person: opts.target.id, orgs: { [opts.target.org]: 1 } } } : {};
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who, claims), "x-test-public-rooms": "on" };
  if (method !== "GET") headers["idempotency-key"] = opts.key ?? `nr-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());

const REL = `rel_${"7a".repeat(16)}`;
const PREV = `rel_${"6b".repeat(16)}`;
const SHA = "ef".repeat(20);
const REPO_ID = 987650094;
const TASK = "tsk_nr_1";
let rooms = 0;
const made: string[] = [];

type Room = { room: string; owner: Who; admin: Who; member: Who; host: string; prev: string };
/**
 * A public room with its owner, one person admin and one member, whose app serves an earlier release on its default
 * host with a queued release of its own. With `up: false`, a room with a release configuration and nothing up; with
 * `configured: false`, no release configuration at all.
 */
async function room(org: string, opts: { up?: boolean; configured?: boolean } = {}): Promise<Room> {
  const owner: Who = { id: `per_nr_owner_${org}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "No releaser" });
  expect(created.status, org).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  await alarmQuiet(stub(id));
  const n = ++rooms;
  const member: Who = { id: `per_nr_mem_${n}`, org };
  const admin: Who = { id: `per_nr_adm_${n}`, org };
  const label = `nr${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  const prev = `${label}.${PREV}`;
  const handle = `pub_${crypto.randomUUID().replace(/-/g, "")}`;
  await inRoom(id, (sql) => {
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1, require_person_review = 1", handle);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    for (const [who, role] of [[member, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, org, role, owner.id);
    if (opts.configured === false) return;
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/release', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO_ID, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, owner.id, admin.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    if (opts.up === false) return;
    const release = (rel: string, state: string, withScript: boolean) => sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, ?, ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, ?, 1)`,
      rel, SHA, state, label, TASK, withScript ? `${label}.${rel}` : null, withScript ? rel : null, owner.id, owner.id, withScript ? Date.now() : null);
    release(PREV, "served", true);
    release(REL, "queued", false);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, prev);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, prev);
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, id).run();
  return { room: id, owner, admin, member, host, prev };
}

/** A departure from an organization, as the organization's sweep sends it to every room. */
const depart = (r: Room, who: Who, leftAt = Date.now()) => stub(r.room).fetch("https://workspace/internal/org-departure", {
  method: "POST", body: JSON.stringify({ person: who.id, org: who.org, actor: `per_nr_orgadmin_${who.org}`, left_at: leftAt }),
}).then((x: Response) => x.status);
const version = async (r: Room) => (await api(r.owner, "GET", `/v1/workspaces/${r.room}`)).body.policy_version as number;
const serving = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT script_name, release_id FROM serve_state").one());
const UP = (r: Room) => ({ script_name: r.prev, release_id: PREV });
const DOWN = { script_name: null, release_id: null };
const unpublishes = (r: Room) => all(r.room, "SELECT cause, label, release_epoch FROM unpublish ORDER BY seq");
const unpublishAudit = (r: Room) => all(r.room, "SELECT actor_id, new_json FROM audit_event WHERE action = 'app.unpublished' ORDER BY seq")
  .then((rows) => rows.map((a: any) => [a.actor_id, JSON.parse(a.new_json)]));
const unpublishEvents = (r: Room) => all(r.room, "SELECT actor_id, reason FROM event WHERE type = 'app.unpublished' ORDER BY seq");

/** Nothing has come down: the app serves, nothing is recorded, and the queued release is still queued. */
async function expectUp(r: Room, what: string) {
  expect(await serving(r), what).toEqual(UP(r));
  expect(await unpublishes(r), what).toEqual([]);
  expect(await unpublishAudit(r), what).toEqual([]);
}

/** The app down by `no_releaser`, once, as Podster's act, with the command that fired it kept as `cause`. */
async function expectDown(r: Room, cause: string, what: string) {
  expect(await serving(r), what).toEqual(DOWN);
  expect(await all(r.room, "SELECT id, state, failure_code FROM release ORDER BY id"), what).toEqual([
    { id: PREV, state: "unpublished", failure_code: null },
    { id: REL, state: "failed", failure_code: "release_epoch_moved" },
  ].sort((a, b) => a.id.localeCompare(b.id)));
  expect(await unpublishes(r), what).toEqual([{ cause: "no_releaser", label: null, release_epoch: 3 }]);
  expect(await unpublishAudit(r), what).toEqual([["podster", { cause, reason: "no_releaser" }]]);
  expect(await unpublishEvents(r), what).toEqual([{ actor_id: "podster", reason: "no_releaser" }]);
}

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("ADR 0010's trigger, nobody who may release remains (M6 step 6, the interim rule)", () => {
  it("takes the app down at the departure that leaves nobody, and not at one that leaves someone", async () => {
    const r = await room("org_nr_depart");
    // The admin leaves their organization: the owner remains.
    expect(await depart(r, r.admin)).toBe(200);
    expect(await all(r.room, "SELECT revoked_at IS NOT NULL AS gone FROM member WHERE principal_id = ?", r.admin.id)).toEqual([{ gone: 1 }]);
    await expectUp(r, "the admin left");
    // A member leaving changes nothing about who may release.
    expect(await depart(r, r.member)).toBe(200);
    await expectUp(r, "a member left");
    // The owner leaves: nobody remains.
    expect(await depart(r, r.owner)).toBe(200);
    await expectDown(r, "org_departure", "the owner left");
    // The same departure again, as the sweep may send it, and another for good measure: nothing more.
    expect(await depart(r, r.owner)).toBe(200);
    expect(await depart(r, r.admin)).toBe(200);
    await expectDown(r, "org_departure", "sent again");
  });

  it("fires on the last admin's departure once the owner has gone", async () => {
    const r = await room("org_nr_admin_last");
    expect(await depart(r, r.owner)).toBe(200);
    await expectUp(r, "the owner left, the admin remains");
    expect(await depart(r, r.admin)).toBe(200);
    await expectDown(r, "org_departure", "the admin left");
  });

  it("never counts an agent, whatever role is stored for it, or an admin whose place has ended", async () => {
    const r = await room("org_nr_agent");
    await inRoom(r.room, (sql) => {
      sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES ('agt_nr_admin', 'agent', ?, 'admin', ?, 1)", r.owner.org, r.owner.id);
      sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at, revoked_at, revocation_reason) VALUES ('per_nr_gone', 'person', ?, 'admin', ?, 1, 2, 'room_removed')", r.owner.org, r.owner.id);
    });
    expect(await depart(r, r.admin)).toBe(200);
    await expectUp(r, "the owner remains");
    expect(await depart(r, r.owner)).toBe(200);
    await expectDown(r, "org_departure", "only an agent stored as admin, and a removed admin, are left");
  });

  it("with nothing up, records the unpublish for a room with a release configuration, and nothing for a room without one", async () => {
    const r = await room("org_nr_nothing_up", { up: false });
    expect(await depart(r, r.admin)).toBe(200);
    expect(await depart(r, r.owner)).toBe(200);
    expect(await unpublishes(r)).toEqual([{ cause: "no_releaser", label: null, release_epoch: 3 }]);
    expect(await unpublishAudit(r)).toEqual([["podster", { cause: "org_departure", reason: "no_releaser" }]]);
    expect(await all(r.room, "SELECT release_epoch FROM release_config")).toEqual([{ release_epoch: 3 }]);

    const bare = await room("org_nr_unconfigured", { configured: false });
    expect(await depart(bare, bare.admin)).toBe(200);
    expect(await depart(bare, bare.owner)).toBe(200);
    expect(await unpublishes(bare)).toEqual([]);
    expect(await unpublishAudit(bare)).toEqual([]);
  });

  it("leaves a room that already had nobody at deploy as it is", async () => {
    const r = await room("org_nr_deploy");
    // As the room would be had its owner and admin left before this rule existed.
    await inRoom(r.room, (sql) => {
      sql.exec("UPDATE workspace SET owner_left_at = 5");
      sql.exec("UPDATE member SET revoked_at = 5, revocation_reason = 'org_departure' WHERE role = 'admin'");
    });
    expect(await depart(r, r.member)).toBe(200);
    expect(await depart(r, r.owner)).toBe(200);
    await expectUp(r, "nothing changed about who may release");
  });

  it("keeps its cause apart from an earlier trigger's", async () => {
    const r = await room("org_nr_causes");
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.room}/archive`, { policy_version: await version(r) })).status).toBe(200);
    expect(await depart(r, r.admin)).toBe(200);
    expect(await depart(r, r.owner)).toBe(200);
    expect(await unpublishes(r)).toEqual([
      { cause: "workspace_archived", label: null, release_epoch: 3 },
      { cause: "no_releaser", label: null, release_epoch: 4 },
    ]);
    expect(await unpublishAudit(r)).toEqual([
      ["podster", { reason: "workspace_archived" }],
      ["podster", { cause: "org_departure", reason: "no_releaser" }],
    ]);
  });

  describe("the commands that change who may release, none of which can leave nobody", () => {
    it("removing the only admin leaves the owner", async () => {
      const r = await room("org_nr_remove");
      expect((await api(r.owner, "DELETE", `/v1/workspaces/${r.room}/members/${r.admin.id}`, { policy_version: await version(r) })).status).toBe(200);
      await expectUp(r, "removed");
    });

    it("demoting the only admin leaves the owner", async () => {
      const r = await room("org_nr_demote");
      const changed = await api(r.owner, "POST", `/v1/workspaces/${r.room}/members/${r.admin.id}/role`, { role: "member", policy_version: await version(r) }, { target: r.admin });
      expect(changed.status).toBe(200);
      expect(await all(r.room, "SELECT role FROM member WHERE principal_id = ?", r.admin.id)).toEqual([{ role: "member" }]);
      await expectUp(r, "demoted");
    });

    it("revoking another organization that held an admin leaves the owner", async () => {
      const r = await room("org_nr_revoke_org");
      await inRoom(r.room, (sql) => void sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES ('per_nr_other_admin', 'person', 'org_nr_other', 'admin', ?, 1)", r.owner.id));
      expect((await api(r.owner, "DELETE", `/v1/workspaces/${r.room}/organizations/org_nr_other`, { policy_version: await version(r) })).status).toBe(200);
      await expectUp(r, "organization revoked");
    });

    it("handing the room over is one command, with no moment of nobody, and a same-key retry is answered as before", async () => {
      const r = await room("org_nr_transfer");
      const body = { to: r.admin.id, policy_version: await version(r) };
      const first = await api(r.owner, "POST", `/v1/workspaces/${r.room}/owner/transfer`, body, { key: "nr-transfer", target: r.admin });
      expect(first.status).toBe(200);
      expect(await api(r.owner, "POST", `/v1/workspaces/${r.room}/owner/transfer`, body, { key: "nr-transfer", target: r.admin })).toEqual(first);
      expect(await all(r.room, "SELECT owner_person_id FROM workspace")).toEqual([{ owner_person_id: r.admin.id }]);
      await expectUp(r, "handed over");
      // The former owner, now an admin, leaves: the new owner remains. Then the new owner leaves: nobody does.
      expect(await depart(r, r.owner)).toBe(200);
      await expectUp(r, "the former owner left");
      expect(await depart(r, r.admin)).toBe(200);
      await expectDown(r, "org_departure", "the new owner left");
    });
  });
});
