import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet } from "./alarm";

// M6 step 6: the room's release configuration, read and set (`getReleaseConfig`, `setReleaseConfig`). Only the room's
// owner or an admin, as a person, and never an agent (decision 215). Switching release on needs everything release
// needs at all; switching it off is always allowed to them, and is ADR 0010's `release_off` trigger: what is up comes
// down in the same transaction, and switching on again restores nothing.
//
// Nothing takes a release's request yet, so each room is given its rows through the test pool, as in
// `release-triggers.spec.ts`: an app serving an earlier release on its default host and a queued release of its own.
// Each room's provider is switched off, so what is read is the room's own state.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
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
async function api(who: Who, method: string, path: string, body?: unknown, opts: { key?: string; fail?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "x-test-public-rooms": "on" };
  if (method !== "GET") headers["idempotency-key"] = opts.key ?? `rc-key-${++counter}`;
  if (opts.fail) headers["x-test-fail"] = "1";
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());

/** Release switched on for the test Worker while `run` runs. */
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

/** An agent of a room's organization, registered once: whatever its role, it never reads or sets release. */
const AGENT: Who = { id: "agt_rc_agent", org: "org_rc_agents", kind: "agent" };

const REL = `rel_${"7a".repeat(16)}`;
const PREV = `rel_${"6b".repeat(16)}`;
const SHA = "ef".repeat(20);
const REPO_ID = 987650093;
const TASK = "tsk_rc_1";
let rooms = 0;
const made: string[] = [];

type Room = { room: string; owner: Who; admin: Who; member: Who; label: string; host: string; prev: string };
/**
 * A public room whose app serves an earlier release on its default host, with a queued release of its own and release
 * on at version 3. With `configured: false`, a room that never set release, with no repository and no app.
 */
async function room(org: string, opts: { configured?: boolean } = {}): Promise<Room> {
  const owner: Who = { id: `per_rc_owner_${org}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Release config" });
  expect(created.status, org).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  await alarmQuiet(stub(id));
  const n = ++rooms;
  const member: Who = { id: `per_rc_mem_${n}`, org };
  const admin: Who = { id: `per_rc_adm_${n}`, org };
  const label = `rc${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
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
  return { room: id, owner, admin, member, label, host, prev };
}

const path = (r: Room) => `/v1/workspaces/${r.room}/release-config`;
const get = (r: Room, who = r.owner) => api(who, "GET", path(r));
const put = (r: Room, body: unknown, opts: { who?: Who; key?: string; fail?: boolean } = {}) => api(opts.who ?? r.owner, "PUT", path(r), body, opts);
const serving = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT script_name, release_id FROM serve_state").one());
const UP = (r: Room) => ({ script_name: r.prev, release_id: PREV });
const DOWN = { script_name: null, release_id: null };
const unpublishes = (r: Room) => all(r.room, "SELECT cause, label, release_epoch FROM unpublish ORDER BY seq");
const configAudit = (r: Room) => all(r.room, "SELECT actor_id, prior_json, new_json FROM audit_event WHERE action = 'release.config_set' ORDER BY seq")
  .then((rows) => rows.map((a: any) => [a.actor_id, JSON.parse(a.prior_json), JSON.parse(a.new_json)]));
const unpublishAudit = (r: Room) => all(r.room, "SELECT actor_id, new_json FROM audit_event WHERE action = 'app.unpublished' ORDER BY seq")
  .then((rows) => rows.map((a: any) => [a.actor_id, JSON.parse(a.new_json)]));
const events = (r: Room) => all(r.room, "SELECT type, actor_id, reason FROM event WHERE type IN ('release.config_set', 'app.unpublished') ORDER BY seq");
const config = (r: Room, enabled: boolean, version: number, setBy: string | null = r.owner.id) => ({
  enabled, approval_policy: "person", environments: ["production"], default_host: r.host, custom_host: null, version, set_by: setBy,
});

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const registrar: Who = { id: "per_rc_registrar", org: AGENT.org, adminOrgs: [AGENT.org] };
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(registrar) }, body: JSON.stringify({ org_id: AGENT.org, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register ${AGENT.id}: ${res.status}`);
});

describe("the room's release configuration (M6 step 6)", () => {
  it("is read by the room's owner and its admins, and by nobody else", async () => {
    const r = await room("org_rc_read");
    await switchedOn(async () => {
      for (const who of [r.owner, r.admin]) {
        const read = await get(r, who);
        expect(read.status, who.id).toBe(200);
        expect(read.body, who.id).toMatchObject(config(r, true, 3));
      }
      expect((await get(r, r.member)).code).toBe("not_allowed");
      expect((await get(r, AGENT)).code).toBe("not_allowed");
    });
  });

  it("reads as off at version 0 in a room that never set it", async () => {
    const r = await room("org_rc_never", { configured: false });
    await switchedOn(async () => {
      expect((await get(r)).body).toEqual({ ...config(r, false, 0, null), default_host: null, updated_at: null });
    });
  });

  it("switched off takes the app down in the same request, as Podster's act, and ends the release it had queued", async () => {
    const r = await room("org_rc_off");
    const answer = await switchedOn(() => put(r, { enabled: false, expected_version: 3 }));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject(config(r, false, 4));
    expect(await serving(r)).toEqual(DOWN);
    expect(await all(r.room, "SELECT id, state, failure_code FROM release ORDER BY id")).toEqual([
      { id: PREV, state: "unpublished", failure_code: null },
      { id: REL, state: "failed", failure_code: "release_epoch_moved" },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await unpublishes(r)).toEqual([{ cause: "release_off", label: null, release_epoch: 3 }]);
    expect(await configAudit(r)).toEqual([[r.owner.id, { enabled: true, version: 3 }, { enabled: false, version: 4 }]]);
    expect(await unpublishAudit(r)).toEqual([["podster", { reason: "release_off" }]]);
    expect(await events(r)).toEqual([
      { type: "release.config_set", actor_id: r.owner.id, reason: null },
      { type: "app.unpublished", actor_id: "podster", reason: "release_off" },
    ]);
  });

  it("unpublishes once for a retry with the same idempotency key, and asked again at the new version changes nothing", async () => {
    const r = await room("org_rc_retry");
    await switchedOn(async () => {
      const first = await put(r, { enabled: false, expected_version: 3 }, { key: "rc-retry" });
      expect(first.status).toBe(200);
      expect(await put(r, { enabled: false, expected_version: 3 }, { key: "rc-retry" })).toEqual(first);
      const again = await put(r, { enabled: false, expected_version: 4 });
      expect(again.status).toBe(200);
      expect(again.body.version).toBe(4);
    });
    expect(await unpublishes(r)).toHaveLength(1);
    expect(await configAudit(r)).toHaveLength(1);
  });

  it("refuses a stale version, and changes nothing", async () => {
    const r = await room("org_rc_stale");
    await switchedOn(async () => {
      for (const version of [2, 4, 0]) {
        const answer = await put(r, { enabled: false, expected_version: version });
        expect([answer.status, answer.code], `version ${version}`).toEqual([409, "version_conflict"]);
      }
      // Unchanged asked from a stale version is refused too, so the caller learns they read an old configuration.
      expect((await put(r, { enabled: true, expected_version: 2 })).code).toBe("version_conflict");
    });
    expect(await serving(r)).toEqual(UP(r));
    expect(await unpublishes(r)).toEqual([]);
    expect(await configAudit(r)).toEqual([]);
  });

  it("rolls the unpublish back with the change when the command fails", async () => {
    const r = await room("org_rc_rollback");
    const failed = await switchedOn(() => put(r, { enabled: false, expected_version: 3 }, { fail: true }));
    expect(failed.status).toBe(500);
    expect(await serving(r)).toEqual(UP(r));
    expect(await unpublishes(r)).toEqual([]);
    expect(await all(r.room, "SELECT enabled, version, release_epoch FROM release_config")).toEqual([{ enabled: 1, version: 3, release_epoch: 2 }]);
  });

  it("switched on again restores nothing", async () => {
    const r = await room("org_rc_again");
    await switchedOn(async () => {
      expect((await put(r, { enabled: false, expected_version: 3 })).status).toBe(200);
      const on = await put(r, { enabled: true, expected_version: 4 });
      expect(on.status).toBe(200);
      expect(on.body).toMatchObject(config(r, true, 5));
    });
    expect(await serving(r)).toEqual(DOWN);
    expect(await unpublishes(r)).toHaveLength(1);
    expect(await configAudit(r)).toEqual([
      [r.owner.id, { enabled: true, version: 3 }, { enabled: false, version: 4 }],
      [r.owner.id, { enabled: false, version: 4 }, { enabled: true, version: 5 }],
    ]);
  });

  it("is set by the room's owner and its admins only, and never by an agent", async () => {
    const r = await room("org_rc_who");
    await switchedOn(async () => {
      expect((await put(r, { enabled: false, expected_version: 3 }, { who: r.member })).code).toBe("not_allowed");
      expect((await put(r, { enabled: false, expected_version: 3 }, { who: AGENT })).code).toBe("not_allowed");
      expect(await serving(r)).toEqual(UP(r));
      const byAdmin = await put(r, { enabled: false, expected_version: 3 }, { who: r.admin });
      expect(byAdmin.status).toBe(200);
      expect(byAdmin.body.set_by).toBe(r.admin.id);
    });
    expect(await serving(r)).toEqual(DOWN);
  });

  it("is switched on only where release may happen at all, and switched off wherever it is on", async () => {
    // Never set, with no repository: refused by the first fact that fails, and nothing is written.
    const bare = await room("org_rc_bare", { configured: false });
    await switchedOn(async () => {
      expect((await put(bare, { enabled: true, expected_version: 0 })).code).toBe("repo_not_ready");
      // Off is already so: nothing is written, and the answer is the configuration as it is.
      const off = await put(bare, { enabled: false, expected_version: 0 });
      expect([off.status, off.body.version, off.body.enabled]).toEqual([200, 0, false]);
    });
    expect(await all(bare.room, "SELECT 1 FROM release_config")).toEqual([]);

    // A private room: switching on is refused. An archived room: switching on is refused by its own code, and off is
    // allowed, since it only takes down.
    for (const [what, change, code] of [
      ["private", "UPDATE workspace SET visibility = 'private', public_handle = NULL, published_at = NULL", "release_needs_public_room"],
      ["archived", "UPDATE workspace SET status = 'archived'", "workspace_archived"],
      ["a repository link that isn't ready", "UPDATE repo_link SET status = 'degraded'", "repo_not_ready"],
    ] as const) {
      const r = await room(`org_rc_where_${what.length}`);
      await inRoom(r.room, (sql) => {
        sql.exec("UPDATE release_config SET enabled = 0");
        sql.exec(change);
      });
      await switchedOn(async () => {
        expect((await put(r, { enabled: true, expected_version: 3 })).code, what).toBe(code);
        expect((await put(r, { enabled: false, expected_version: 3 })).status, what).toBe(200);
      });
      expect(await configAudit(r), what).toEqual([]);
      await inRoom(r.room, (sql) => void sql.exec("UPDATE release_config SET enabled = 1"));
      const off = await switchedOn(() => put(r, { enabled: false, expected_version: 3 }));
      expect([off.status, off.body?.version], what).toEqual([200, 4]);
    }
  });

  it("isn't switched on while an operator has taken release from the room's organization", async () => {
    const r = await room("org_rc_taken");
    await inRoom(r.room, (sql) => void sql.exec("UPDATE release_config SET enabled = 0"));
    const operator: Who = { id: "per_operator_one", org: "org_rc_ops" };
    await switchedOn(async () => {
      expect((await api(operator, "PUT", `/v1/orgs/${r.owner.org}/release-delegation`, { granted: false })).status).toBe(200);
      // The room reads its organization's switch itself before deciding, whether or not a notice reached it yet.
      expect((await put(r, { enabled: true, expected_version: 3 })).code).toBe("release_not_delegated");
      expect((await api(operator, "PUT", `/v1/orgs/${r.owner.org}/release-delegation`, { granted: true })).status).toBe(200);
      const on = await put(r, { enabled: true, expected_version: 3 });
      expect([on.status, on.body?.enabled]).toEqual([200, true]);
    });
    await alarmQuiet(BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(r.owner.org)));
  });

  it("isn't there while release is switched off for the deployment", async () => {
    const r = await room("org_rc_gone");
    const neighbour = `/v1/workspaces/${r.room}/release-configx`;
    expect([(await get(r)).status, (await get(r)).code]).toEqual([404, "not_found"]);
    const unknown = await api(r.owner, "PUT", neighbour, { enabled: false, expected_version: 3 });
    const real = await put(r, { enabled: false, expected_version: 3 });
    expect([real.status, real.code]).toEqual([unknown.status, unknown.code]);
    expect(await serving(r)).toEqual(UP(r));
  });
});
