import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { alarmPass, alarmQuiet, expectNoAlarmSooner, manualAlarms, nextAlarm } from "./alarm.ts";
import { evictRoom } from "./evict.ts";
import { fakeIds } from "./fake-ids.ts";

// The M5 security review's F2 and F8: a ready link is read back once a day from the room's alarm, and a link that's
// degraded, by that read or a merge's, has its agents' tokens revoked in the same alarm pass. Against the fake GitHub:
// the provisioning App reads the repository back, and the agent-token App mints and revokes. Nothing here reaches GitHub.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const ORG = "org_rr";
const OWNER: Who = { id: "per_rr_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const AGENT: Who = { id: "agt_rr_agent", org: ORG };
const orgAdmin: Who = { id: "per_rr_orgadmin", kind: "person", org: ORG, adminOrgs: [ORG] };
const OPERATOR: Who = { id: "per_operator_one", kind: "person", org: "org_operators" };
const DAY = 24 * 60 * 60 * 1000;
/** The soonest anything in these rooms is due again after a pass that read nothing: the held token's renewal is an hour off. */
const QUIET_MS = 30 * 60 * 1000;
let REPO_ID = 0;
/** This file's own repository IDs at the shared GitHub stand-in: see `fake-ids.ts`. */
const IDS = fakeIds("repo-readiness");

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  const facts = isAgent ? { gen: 1, linker: { person: OWNER.id, since: 1 } } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] };
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...facts })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, options: { key?: string | null } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json" };
  if (method !== "GET" && options.key !== null) headers["idempotency-key"] = options.key ?? `rr-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" || body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const must = async (who: Who, method: string, path: string, body?: unknown) => {
  const res = await api(who, method, path, body);
  if (res.status !== 200) throw new Error(`${method} ${path}: ${res.status} ${res.text}`);
  return res.body;
};

const fake = (path: string, body: object) => fetch(`https://github-fake.example.com${path}`, { method: "POST", body: JSON.stringify(body) });
/** This test's repository as provisioning left it, or changed: `rulesets`, `settings`, `workflow`, and a `script` for its reads. */
const ready = (patch: object = {}) => fake("/ready-repo", { id: REPO_ID, ...patch });
/** The provisioning App's reads of this test's repository. */
/**
 * The provisioning App's reads of this test's repository, how many of its tokens on it are live, and the presence check's
 * own tokens: how many asked about this repository and are live, and the status each revocation of one got.
 */
const readBack = async () => {
  const back = (await (await fetch(`https://github-fake.example.com/ready-reads?repo=${REPO_ID}`)).json()) as { reads: { path: string }[]; live: number; presence: { live: number; revokes: number[] } };
  return { ...back, reads: back.reads.slice(setupReads.get(REPO_ID) ?? 0) };
};
/** By repository, the reads its room's set-up made: the mint of the agent's token reads the repository back first. */
const setupReads = new Map<number, number>();
/** Every token the agent-token App minted for this test's repository, and whether it's still live. */
const minted = async () => (await (await fetch(`https://github-fake.example.com/agent-tokens?repo=${REPO_ID}`)).json()) as { token: string; live: boolean }[];

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version as number;
const link = (id: string) => inRoom(id, (sql) => sql.exec("SELECT status, status_reason, verified_at FROM repo_link").one() as any);
const tokens = (id: string) => inRoom(id, (sql) => sql.exec("SELECT state FROM repo_token").toArray().map((t: any) => t.state as string));
const events = (id: string) => inRoom(id, (sql) => sql.exec("SELECT type, reason FROM event WHERE type LIKE 'repository.%' ORDER BY seq").toArray() as any[]);
const scheduledReads = (id: string) => inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM repo_read WHERE kind = 'job' AND caller = 'readiness'").one().n as number);
/** When the repository was first seen gone, if a second look is owed. */
const goneSeen = (id: string) => inRoom(id, (sql) => sql.exec("SELECT gone_seen_at AS at FROM repo_link").one().at as number | null);
/** Moves the first gone sighting, and the scheduled read that made it, a little over a minute into the past. */
const aMinuteLater = (id: string) => inRoom(id, (sql) => {
  sql.exec("UPDATE repo_link SET gone_seen_at = gone_seen_at - 61000 WHERE gone_seen_at IS NOT NULL");
  sql.exec("UPDATE repo_read SET at = at - 61000 WHERE caller = 'readiness'");
});
/**
 * Makes the link last found right `ms` ago, which makes it due, with any other change the test needs in the same
 * transaction. The room's own alarm is often due at once after setup, so a change made in a later step could land after
 * that alarm had already read the link back: everything that decides the next read goes in together.
 */
const checkedAgo = (id: string, ms: number, also?: (sql: any) => void) => inRoom(id, (sql) => {
  also?.(sql);
  sql.exec("UPDATE repo_link SET verified_at = ?", Date.now() - ms);
});
/** An operator's recheck of room `id`'s link, as `crate::moderation` takes it. */
const recheck = (who: Who, id: string) => api(who, "POST", `/v1/moderation/repositories/${id}/recheck`, {});
const made: string[] = [];

// The deployment's ceiling on unpublishes for a repository's link (the architect's ruling of 2026-11-14), in the
// `Moderation` object, which every room of this file asks.
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const hasTable = (sql: any, name: string) => sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", name).one().n === 1;
/** The labels this file adds to the app-label lookup table, which sizes the ceiling's share. */
const COUNTED = `${IDS.tag}cnt`;
/**
 * Every test starts with the ceiling clear, its clock fixed, so a grant's hour can't run out under a slow run, and no
 * room of this file's in the lookup table: no earlier test's grant or hold carries over.
 */
async function resetCeiling() {
  await inModeration((sql) => {
    for (const table of ["repo_unpublish_grant", "repo_unpublish_held", "repo_unpublish_trip"]) if (hasTable(sql, table)) sql.exec(`DELETE FROM ${table}`);
    if (hasTable(sql, "takedown_finding")) sql.exec("DELETE FROM takedown_finding WHERE code IN ('installation_unconfirmed', 'repo_unpublish_held', 'repo_unpublish_stalled')");
    sql.exec("DROP TABLE IF EXISTS test_rooms_uncounted");
    sql.exec("DROP TABLE IF EXISTS test_clock");
    sql.exec("CREATE TABLE test_clock (now INTEGER NOT NULL)");
    sql.exec("INSERT INTO test_clock (now) VALUES (?)", Date.now());
  });
  await BINDINGS.DB.prepare("DELETE FROM app_label_index WHERE label LIKE ?").bind(`${COUNTED}%`).run();
}
/** `n` rooms with apps in the lookup table, each with a label an approval held for (6f), which makes the ceiling the smaller of 5 and 10% of them, rounded up. */
async function roomsWithApps(n: number) {
  for (let i = 0; i < n; i++) await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at, approved_at) VALUES (?, ?, 1, 1)").bind(`${COUNTED}${i}`, `ws_${COUNTED}_${i}`).run();
}
/** The ceiling's state: grants, held rooms, whether it's tripped, and its findings, each held or stalled room by its ID. */
const ceiling = () => inModeration((sql) => ({
  granted: hasTable(sql, "repo_unpublish_grant") ? sql.exec("SELECT room FROM repo_unpublish_grant ORDER BY room").toArray().map((r: any) => r.room) : [],
  held: hasTable(sql, "repo_unpublish_held") ? sql.exec("SELECT room FROM repo_unpublish_held ORDER BY room").toArray().map((r: any) => r.room) : [],
  tripped: hasTable(sql, "repo_unpublish_trip") ? sql.exec("SELECT count(*) AS n FROM repo_unpublish_trip").one().n === 1 : false,
  findings: hasTable(sql, "takedown_finding") ? sql.exec("SELECT code, subject, detail, seen FROM takedown_finding WHERE code IN ('installation_unconfirmed', 'repo_unpublish_held', 'repo_unpublish_stalled') ORDER BY code, subject").toArray() : [],
}));
/** Moves the ceiling's clock on, past the rolling hour its grants count for. */
const anHourOn = () => inModeration((sql) => void sql.exec("UPDATE test_clock SET now = now + 3600001"));
/** When room `id` next asks the ceiling by itself, from its durable storage, or null when no ask is outstanding. */
const retryAt = (id: string) => runInDurableObject(stub(id), async (_: any, state: any) => (await state.storage.get("repo_unpublish_retry_at")) ?? null) as Promise<number | null>;
/** Makes room `id`'s kept retry time come due now, as an hour passing would. Durable storage: no memory is involved. */
const retryNow = (id: string) => runInDurableObject(stub(id), (_: any, state: any) => state.storage.put("repo_unpublish_retry_at", 0));
/** Waits until a call is held at the stand-in's gate `gate`, then lets it go once `meanwhile` has run. No timer. */
const atGate = async (gate: number, meanwhile: () => Promise<unknown>) => {
  await fetch(`https://github-fake.example.com/gate-reached?repo=${gate}`);
  await meanwhile();
  await fetch("https://github-fake.example.com/agent-release", { method: "POST", body: JSON.stringify({ id: gate }) });
};
/** What the room's own stand-in for the installation answers: GitHub's status, whether it named this installation, and `suspended_at`. */
const installation = (id: string, status: number, idMatches: boolean, suspended: boolean | null) => inRoom(id, (sql) => {
  sql.exec("CREATE TABLE IF NOT EXISTS test_installation_answer (status INTEGER, id_matches INTEGER, suspended INTEGER)");
  sql.exec("DELETE FROM test_installation_answer");
  sql.exec("INSERT INTO test_installation_answer VALUES (?, ?, ?)", status, idMatches ? 1 : 0, suspended === null ? null : suspended ? 1 : 0);
});
/** The room's answer to the reconcile's walk, which says whether an unpublish is still owed for its link. */
const woken = async (id: string) => (await (await stub(id).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify({ kind: "wake" }) })).json() as any).repo_unpublish_wanted;

/**
 * M6 step 6: room `id` given an app, through the test pool, as nothing takes a release's request yet: a release
 * configuration at epoch 2 and, unless `up` is false, a served release on its default host and a queued one. The
 * provider is switched off, so the room's own state is what is read.
 */
async function withApp(id: string, opts: { up?: boolean } = {}) {
  const label = `rr${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const served = `rel_${"3c".repeat(16)}`;
  const queued = `rel_${"4e".repeat(16)}`;
  const script = `${label}.${served}`;
  await inRoom(id, (sql) => {
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 1, 2, ?, 1, 1)", OWNER.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES ('tsk_rr_release', 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", OWNER.id, OWNER.id);
    if (opts.up === false) return;
    const release = (rel: string, state: string, withScript: boolean) => sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 2, 'tsk_rr_release', ?, ?, ?, 1, ?, 1, ?, 1)`, rel, "ab".repeat(20), state, label, withScript ? `${label}.${rel}` : null, withScript ? rel : null, OWNER.id, OWNER.id, withScript ? 1 : null);
    release(served, "served", true);
    release(queued, "queued", false);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", `${label}.apps.example`, label, served, script);
    // The kind a real upload records before its script is written (S3): static.
    sql.exec("INSERT OR IGNORE INTO release_script_kind (release_id, script_name, kind, recorded_at) SELECT substr(s, -36), s, 'static', 1 FROM (SELECT script_name AS s FROM serve_state UNION SELECT flight_before FROM serve_state) WHERE s IS NOT NULL");
  });
  return { label, served, queued, script };
}
type App = Awaited<ReturnType<typeof withApp>>;
const appState = (id: string) => inRoom(id, (sql) => ({
  serving: sql.exec("SELECT script_name FROM serve_state").one().script_name,
  releases: sql.exec("SELECT id, state, failure_code FROM release WHERE id IN (?, ?) ORDER BY id", `rel_${"3c".repeat(16)}`, `rel_${"4e".repeat(16)}`).toArray(),
  unpublish: sql.exec("SELECT cause, release_epoch FROM unpublish").toArray(),
  queued: sql.exec("SELECT script_name FROM script_delete").toArray().map((q: any) => q.script_name),
  event: sql.exec("SELECT actor_id, reason FROM event WHERE type = 'app.unpublished'").toArray(),
  audit: sql.exec("SELECT actor_id, new_json FROM audit_event WHERE action = 'app.unpublished'").toArray().map((a: any) => [a.actor_id, JSON.parse(a.new_json)]),
}));
/** Room state after a degrade with code `cause` took the app down, the queued release ended in the same request or pass. */
const appDown = (app: App, cause: string) => ({
  serving: null,
  releases: [{ id: app.served, state: "unpublished", failure_code: null }, { id: app.queued, state: "failed", failure_code: "release_epoch_moved" }],
  unpublish: [{ cause: "repo_not_ready", release_epoch: 3 }],
  queued: [app.script],
  event: [{ actor_id: "podster", reason: "repo_not_ready" }],
  audit: [["podster", { reason: "repo_not_ready", cause }]],
});
const appUp = (app: App) => ({
  serving: app.script,
  releases: [{ id: app.served, state: "served", failure_code: null }, { id: app.queued, state: "queued", failure_code: null }],
  unpublish: [],
  queued: [],
  event: [],
  audit: [],
});

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin) }, body: JSON.stringify({ org_id: ORG, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register: ${res.status}`);
});

beforeEach(async () => {
  REPO_ID = IDS.next();
  await fake("/agent-repo", { id: REPO_ID });
  await ready({ rulesets: "ready" });
  await resetCeiling();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});

/**
 * A room with managed repositories on, a ready link found right a moment ago, the scheduled read switched on for it,
 * and the agent holding a token for its accepted, linked task under a push grant.
 */
async function room() {
  const id: string = (await must(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).id;
  made.push(id);
  await must(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: AGENT.id, kind: "agent", org_id: ORG, role: "member", policy_version: await version(id) });
  await inRoom(id, (sql) => {
    sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)");
    sql.exec("CREATE TABLE test_readiness_schedule (x INTEGER)");
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podster-test-org/engineering', 'public', 'main', 'ready', ?, ?, ?, ?)", REPO_ID, OWNER.id, Date.now(), Date.now(), Date.now());
  });
  await must(OWNER, "POST", `/v1/workspaces/${id}/repository/grants`, { policy_version: await version(id), principal_id: AGENT.id, action: "push" });
  const task = await must(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Code", instructions: "Change the code", assignee: AGENT.id });
  await inRoom(id, (sql) => sql.exec("UPDATE task SET has_linked_repository = 1 WHERE id = ?", task.id));
  await must(AGENT, "POST", `/v1/workspaces/${id}/tasks/${task.id}/accept`, { version: task.version });
  const got = await api(AGENT, "POST", `/v1/workspaces/${id}/tasks/${task.id}/repo-access`, undefined, { key: null });
  expect(got.status, got.text).toBe(200);
  expect(await tokens(id)).toEqual(["held"]);
  // The mint read the repository back before it went on. What a test reads back is what came after.
  setupReads.delete(REPO_ID);
  setupReads.set(REPO_ID, (await readBack()).reads.length);
  // Quiet before it's handed back: a test that writes to the room's rows next meets no alarm run of the set-up's.
  await manualAlarms(stub(id));
  return { id, token: got.body.token as string };
}

describe("the scheduled read-back of a ready link", () => {
  it("degrades a link whose protections changed, and revokes the agents' tokens in that same alarm pass (F8, F2)", async () => {
    const r = await room();
    // Someone with admin rights removes the update rule. Nothing reads it back for a day.
    await ready({ rulesets: "no_update" });
    await alarmPass(stub(r.id));
    expect((await readBack()).reads).toEqual([]);
    expect((await link(r.id)).status).toBe("ready");
    // A day on, one alarm pass reads it back, degrades the link, and takes the agent's token back.
    await checkedAgo(r.id, DAY + 1);
    await alarmPass(stub(r.id));
    expect(await link(r.id)).toMatchObject({ status: "degraded", status_reason: "ruleset_missing" });
    expect(await minted()).toEqual([expect.objectContaining({ token: r.token, live: false })]);
    expect(await tokens(r.id)).toEqual([]);
    expect(await events(r.id)).toEqual([{ type: "repository.degraded", reason: "ruleset_missing" }]);
    // Degraded, nothing more is due for it, so the alarm doesn't come back for it.
    await expectNoAlarmSooner(stub(r.id), QUIET_MS);
    // The read went through the provisioning App, counted against the repository's read cap, and left no token live.
    expect((await readBack()).reads.map((read) => read.path)).toContain(`/repositories/${REPO_ID}/rulesets/1`);
    expect((await readBack()).live).toBe(0);
    expect(await scheduledReads(r.id)).toBe(1);
  });

  it("degrades on a changed setting or workflow permission too", async () => {
    // [the change, the reason]
    const cases: [object, string][] = [
      [{ settings: { has_issues: true, has_wiki: false, has_projects: false, has_discussions: false, allow_auto_merge: false, delete_branch_on_merge: false } }, "settings_differ"],
      [{ settings: { has_issues: false, has_wiki: false, has_projects: false, has_discussions: false, allow_auto_merge: true, delete_branch_on_merge: false } }, "settings_differ"],
      [{ workflow: { default_workflow_permissions: "write", can_approve_pull_request_reviews: false } }, "workflow_permissions_differ"],
    ];
    for (const [patch, reason] of cases) {
      REPO_ID = IDS.next();
      await fake("/agent-repo", { id: REPO_ID });
      await ready({ rulesets: "ready" });
      const r = await room();
      await ready(patch);
      await checkedAgo(r.id, DAY + 1);
      await alarmPass(stub(r.id));
      expect(await link(r.id), reason).toMatchObject({ status: "degraded", status_reason: reason });
      expect(await tokens(r.id), reason).toEqual([]);
    }
  });

  it("finds a link exactly right, and only moves its check time on", async () => {
    const r = await room();
    const before = Date.now();
    await checkedAgo(r.id, DAY + 1);
    await alarmPass(stub(r.id));
    const now = await link(r.id);
    expect(now).toMatchObject({ status: "ready", status_reason: null });
    expect(now.verified_at).toBeGreaterThanOrEqual(before);
    expect(await tokens(r.id)).toEqual(["held"]);
    expect(await events(r.id)).toEqual([]);
    // Not again for a day.
    await expectNoAlarmSooner(stub(r.id), QUIET_MS);
    const reads = (await readBack()).reads.length;
    await alarmPass(stub(r.id));
    expect((await readBack()).reads.length).toBe(reads);
  });

  it("changes nothing when the read can't be made, a rate limit included, and tries again an hour later", async () => {
    // [why the read can't be made]
    const cases: object[] = [{ readRepo: 503 }, { workflowRead: 500 }, { limited: { kind: "primary", seconds: 600 } }, { limited: { kind: "secondary", seconds: 120 } }];
    for (const script of cases) {
      REPO_ID = IDS.next();
      await fake("/agent-repo", { id: REPO_ID });
      await ready({ rulesets: "ready" });
      const r = await room();
      // The script first, then the link made due: the room's own alarm may read it as soon as it is.
      await ready({ script });
      const old = Date.now() - DAY - 1;
      await inRoom(r.id, (sql) => sql.exec("UPDATE repo_link SET verified_at = ?", old));
      await alarmPass(stub(r.id));
      expect(await link(r.id), JSON.stringify(script)).toEqual({ status: "ready", status_reason: null, verified_at: old });
      expect(await tokens(r.id), JSON.stringify(script)).toEqual(["held"]);
      expect(await events(r.id), JSON.stringify(script)).toEqual([]);
      expect(await scheduledReads(r.id), JSON.stringify(script)).toBe(1);
      // Not again within the hour, and the alarm isn't set for sooner.
      await expectNoAlarmSooner(stub(r.id), QUIET_MS);
      await alarmPass(stub(r.id));
      expect(await scheduledReads(r.id), JSON.stringify(script)).toBe(1);
    }
  });

  it("waits while the repository's hourly read cap is used up", async () => {
    const r = await room();
    await checkedAgo(r.id, DAY + 1, (sql) => {
      for (let n = 0; n < 60; n++) sql.exec("INSERT INTO repo_read (at, kind, caller) VALUES (?, 'job', NULL)", Date.now());
    });
    await alarmPass(stub(r.id));
    expect((await readBack()).reads).toEqual([]);
    expect(await scheduledReads(r.id)).toBe(0);
    expect((await link(r.id)).status).toBe("ready");
    // And the alarm doesn't come straight back for it: not before the oldest counted read is an hour old.
    await expectNoAlarmSooner(stub(r.id), QUIET_MS);
  });

  it("isn't due at all while provisioning isn't configured, so the alarm doesn't keep coming back", async () => {
    const r = await room();
    await checkedAgo(r.id, DAY + 1, (sql) => sql.exec("CREATE TABLE test_no_provisioning_key (x INTEGER)"));
    await alarmPass(stub(r.id));
    expect((await readBack()).reads).toEqual([]);
    expect(await scheduledReads(r.id)).toBe(0);
    await expectNoAlarmSooner(stub(r.id), QUIET_MS);
  });

  it("reads nothing back for a link that isn't ready, or with managed repositories switched off", async () => {
    const r = await room();
    await checkedAgo(r.id, DAY + 1, (sql) => sql.exec("UPDATE repo_link SET status = 'degraded', status_reason = 'ruleset_missing'"));
    await alarmPass(stub(r.id));
    expect((await readBack()).reads).toEqual([]);
    await expectNoAlarmSooner(stub(r.id), QUIET_MS);
    await inRoom(r.id, (sql) => {
      sql.exec("UPDATE repo_link SET status = 'ready', status_reason = NULL");
      sql.exec("DROP TABLE test_managed_repositories_on");
    });
    await alarmPass(stub(r.id));
    expect((await readBack()).reads).toEqual([]);
    await expectNoAlarmSooner(stub(r.id), QUIET_MS);
  });

  it("degrades a link whose repository was deleted, which a read can't otherwise tell from GitHub being down (item 11)", async () => {
    const r = await room();
    await ready({ deleted: true });
    // The first answer that it's gone is only noted: one answer is never enough.
    const before = Date.now();
    await checkedAgo(r.id, DAY + 1);
    await alarmPass(stub(r.id));
    expect(await link(r.id)).toMatchObject({ status: "ready", status_reason: null });
    expect(await goneSeen(r.id)).toBeGreaterThanOrEqual(before);
    expect(await tokens(r.id)).toEqual(["held"]);
    // The installation-wide token that asked was revoked as soon as it was answered.
    expect((await readBack()).presence).toEqual({ live: 0, revokes: [204] });
    // The second look is due a minute after the first, not sooner.
    await expectNoAlarmSooner(stub(r.id), 50_000);
    await aMinuteLater(r.id);
    await alarmPass(stub(r.id));
    expect(await link(r.id)).toMatchObject({ status: "degraded", status_reason: "repository_gone" });
    expect(await minted()).toEqual([expect.objectContaining({ token: r.token, live: false })]);
    expect(await tokens(r.id)).toEqual([]);
    expect(await events(r.id)).toEqual([{ type: "repository.degraded", reason: "repository_gone" }]);
    // Each question was asked by the repository's ID, with a token for the whole installation that GitHub had just minted.
    expect((await readBack()).reads.map((read) => read.path)).toEqual([`/repositories/${REPO_ID}`, `/repositories/${REPO_ID}`]);
    expect((await readBack()).live).toBe(0);
    expect((await readBack()).presence).toEqual({ live: 0, revokes: [204, 204] });
    // The agent can't have another.
    const task = await inRoom(r.id, (sql) => sql.exec("SELECT id FROM task").one().id as string);
    const again = await api(AGENT, "POST", `/v1/workspaces/${r.id}/tasks/${task}/repo-access`, undefined, { key: null });
    expect([again.status, again.body?.error?.code]).toEqual([409, "repo_not_ready"]);
  });

  it("treats a first sighting older than an hour as none, so one more 404 only starts over", async () => {
    const r = await room();
    await ready({ deleted: true });
    // A sighting from over an hour ago, and no read since: the link is due, and the repository answers 404 again.
    const before = Date.now();
    await checkedAgo(r.id, DAY + 1, (sql) => sql.exec("UPDATE repo_link SET gone_seen_at = ?", Date.now() - 61 * 60_000));
    await alarmPass(stub(r.id));
    expect(await link(r.id)).toMatchObject({ status: "ready", status_reason: null });
    expect(await events(r.id)).toEqual([]);
    expect(await tokens(r.id)).toEqual(["held"]);
    // The old sighting was replaced by this one: a second look a minute from now is what it takes.
    expect(await goneSeen(r.id)).toBeGreaterThanOrEqual(before);
  });

  it("counts a presence token GitHub wouldn't take back as unrevoked, logs it by ID, and doesn't ask again", async () => {
    const r = await room();
    await ready({ deleted: true, script: { presenceRevoke: 1 } });
    const lines: string[] = [];
    for (const level of ["log", "error"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    await checkedAgo(r.id, DAY + 1);
    await alarmPass(stub(r.id));
    // The revocation failed once: the token lives out its hour, read-only on metadata, and the room says so by ID.
    expect((await readBack()).presence).toEqual({ live: 1, revokes: [500] });
    expect(lines.filter((line) => line.includes('"merge.token_unrevoked"'))).toEqual([JSON.stringify({ event: "merge.token_unrevoked", ws: r.id })]);
    // The second look comes due a minute later and runs: it asks with a new token, which is revoked. The first is never
    // tried again, since nothing holds it to try with, and it's still the one live.
    await aMinuteLater(r.id);
    await alarmPass(stub(r.id));
    expect(await link(r.id)).toMatchObject({ status: "degraded", status_reason: "repository_gone" });
    expect((await readBack()).presence).toEqual({ live: 1, revokes: [500, 204] });
    // Nothing GitHub wrote, and no token, reached the log in either pass.
    const logged = lines.join("\n");
    for (const text of ["ghs_", "SECRET-PROVIDER-TEXT", "does not exist or is not accessible"]) expect(logged).not.toContain(text);
  });

  it("degrades on two 404s a minute apart to the token minted for the repository itself (the direct branch)", async () => {
    const r = await room();
    // The token for this one repository is minted, and GitHub answers 404 for the repository by its ID.
    await ready({ script: { readRepo: 404 } });
    await checkedAgo(r.id, DAY + 1);
    await alarmPass(stub(r.id));
    expect((await link(r.id)).status).toBe("ready");
    expect(await goneSeen(r.id)).not.toBeNull();
    await aMinuteLater(r.id);
    await alarmPass(stub(r.id));
    expect(await link(r.id)).toMatchObject({ status: "degraded", status_reason: "repository_gone" });
  });

  it("forgets a gone sighting when a later read finds the repository, so one stray 404 never adds up", async () => {
    const r = await room();
    await ready({ script: { readRepo: 404 } });
    await checkedAgo(r.id, DAY + 1);
    await alarmPass(stub(r.id));
    expect(await goneSeen(r.id)).not.toBeNull();
    // It answers again: the sighting is cleared, and the link was never touched.
    await ready({ script: {} });
    await aMinuteLater(r.id);
    await alarmPass(stub(r.id));
    expect(await goneSeen(r.id)).toBeNull();
    expect(await link(r.id)).toMatchObject({ status: "ready", status_reason: null });
    // A single 404 after that starts over.
    await ready({ script: { readRepo: 404 } });
    await checkedAgo(r.id, DAY + 1);
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_read SET at = at - 3700000 WHERE caller = 'readiness'"));
    await alarmPass(stub(r.id));
    expect((await link(r.id)).status).toBe("ready");
    expect(await events(r.id)).toEqual([]);
  });

  it("leaves a link alone when no token can be had, so nothing can be told about the repository", async () => {
    const r = await room();
    await ready({ deleted: true, script: { token: 403 } });
    await checkedAgo(r.id, DAY + 1);
    await alarmPass(stub(r.id));
    expect(await link(r.id)).toMatchObject({ status: "ready", status_reason: null });
    expect(await tokens(r.id)).toEqual(["held"]);
    expect(await events(r.id)).toEqual([]);
  });
});

describe("an operator's recheck of a ready link (item 12)", () => {
  it("degrades it on a definite difference, in one command with its event, and its tokens go", async () => {
    const r = await room();
    await ready({ rulesets: "no_update" });
    // GitHub refuses the revocation for now, so the marked row is there to read whether or not the runtime has run the
    // alarm the command set.
    await fake("/agent-repo", { id: REPO_ID, revoke: 500 });
    const got = await recheck(OPERATOR, r.id);
    expect(got.body).toEqual({ status: "degraded", reason: "ruleset_missing" });
    expect(await link(r.id)).toMatchObject({ status: "degraded", status_reason: "ruleset_missing" });
    expect(await events(r.id)).toEqual([{ type: "repository.degraded", reason: "ruleset_missing" }]);
    // Marked in the command's own transaction, and revoked by the room's alarm.
    expect(await tokens(r.id)).toEqual(["revoke"]);
    await fake("/agent-repo", { id: REPO_ID, revoke: 204 });
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_token SET revoke_next_at = 0"));
    await alarmPass(stub(r.id));
    expect(await minted()).toEqual([expect.objectContaining({ token: r.token, live: false })]);
    expect(await tokens(r.id)).toEqual([]);
  });

  it("degrades it when the repository is gone, as after a takedown done by hand", async () => {
    const r = await room();
    await ready({ deleted: true });
    // The first look only notes it, and says GitHub gave no definite answer yet.
    const first = await recheck(OPERATOR, r.id);
    expect([first.status, first.body?.error?.code]).toEqual([502, "provider_unavailable"]);
    expect((await link(r.id)).status).toBe("ready");
    // A minute on, a second look makes it definite.
    await aMinuteLater(r.id);
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "degraded", reason: "repository_gone" });
    expect(await link(r.id)).toMatchObject({ status: "degraded", status_reason: "repository_gone" });
  });

  it("unpublishes the room's app when its link is degraded, as ADR 0010 is written (M6 step 6)", async () => {
    // A link no longer ready takes the room's app down, as core's `link_status_unpublishes` decides for `degraded` by the
    // architect's ruling of 2026-11-13. The operator's recheck is a request: its bookkeeping ends the queued release.
    const r = await room();
    const app = await withApp(r.id);
    await ready({ deleted: true });
    await recheck(OPERATOR, r.id);
    await aMinuteLater(r.id);
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "degraded", reason: "repository_gone" });
    expect(await appState(r.id)).toEqual(appDown(app, "repository_gone"));
  });

  it("unpublishes from the room's own alarm when the daily read-back degrades the link, and that alarm ends the queued release", async () => {
    const r = await room();
    const app = await withApp(r.id);
    await ready({ deleted: true });
    await checkedAgo(r.id, DAY + 1);
    await alarmPass(stub(r.id));
    expect(await link(r.id)).toMatchObject({ status: "ready" });
    await aMinuteLater(r.id);
    await alarmPass(stub(r.id));
    expect(await link(r.id)).toMatchObject({ status: "degraded", status_reason: "repository_gone" });
    // The same alarm pass that fired the trigger ran the release bookkeeping before it set its next wake.
    expect(await appState(r.id)).toEqual(appDown(app, "repository_gone"));
  });

  it("restores nothing when the link is ready again, and a new release then gets the whole recheck", async () => {
    const r = await room();
    const app = await withApp(r.id);
    await ready({ rulesets: "no_update" });
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "degraded", reason: "ruleset_missing" });
    await ready({ rulesets: "ready" });
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "ready", reason: null });
    expect(await appState(r.id)).toEqual(appDown(app, "ruleset_missing"));
    // A release asked for under the epoch the trigger moved to is decided by the whole recheck, not refused for its
    // epoch. This room has no merged change of the task's, so the recheck fails on that, having been made.
    await inRoom(r.id, (sql) => void sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, requested_by, requested_at, approved_by, approved_at, updated_at)
         VALUES ('rel_${"5d".repeat(16)}', ?, 'queued', ?, 1, 3, 'tsk_rr_release', ?, 2, ?, 2, 2)`, "ab".repeat(20), app.label, OWNER.id, OWNER.id));
    await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
    try {
      const answer = await (await stub(r.id).fetch("https://do/internal/release-recheck", { method: "POST", body: JSON.stringify({ release_id: `rel_${"5d".repeat(16)}` }) })).json() as any;
      expect(answer).toMatchObject({ rechecked: true });
      expect(answer.reason).not.toBe("release_epoch_moved");
    } finally {
      await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run();
    }
    expect(await appState(r.id)).toEqual(appDown(app, "ruleset_missing"));
  });

  it("unpublishes once for a retry of the operator's recheck with the same idempotency key, and once when asked anew", async () => {
    const r = await room();
    const app = await withApp(r.id);
    await ready({ rulesets: "no_update" });
    const key = `rr-retry-${crypto.randomUUID()}`;
    const first = await api(OPERATOR, "POST", `/v1/moderation/repositories/${r.id}/recheck`, {}, { key });
    const again = await api(OPERATOR, "POST", `/v1/moderation/repositories/${r.id}/recheck`, {}, { key });
    expect(first.body).toEqual({ status: "degraded", reason: "ruleset_missing" });
    expect(again.body).toEqual(first.body);
    expect(await appState(r.id)).toEqual(appDown(app, "ruleset_missing"));
    // Asked anew, with another key: the link is already degraded, which a recheck reads only to restore, so the trigger
    // doesn't fire a second time.
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "degraded", reason: "ruleset_missing" });
    expect(await appState(r.id)).toEqual(appDown(app, "ruleset_missing"));
  });

  it("is never left half done by an unpublish that fails after the degrade: the app stays up until the next ask takes it down", async () => {
    // The degrade commits alone, with its tokens marked; the unpublish is its own transaction after the ceiling's
    // answer (the architect's ruling of 2026-11-14), and fails whole here, so nothing of it is left.
    const r = await room();
    const app = await withApp(r.id);
    await ready({ rulesets: "no_update" });
    await inRoom(r.id, (sql) => void sql.exec("CREATE TABLE test_fail_after_unpublish (x INTEGER)"));
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "degraded", reason: "ruleset_missing" });
    expect(await link(r.id)).toMatchObject({ status: "degraded" });
    expect(await appState(r.id)).toEqual(appUp(app));
    await inRoom(r.id, (sql) => void sql.exec("DROP TABLE test_fail_after_unpublish"));
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "degraded", reason: "ruleset_missing" });
    expect(await appState(r.id)).toEqual(appDown(app, "ruleset_missing"));
  });

  it("records no unpublish for a room with a configuration and nothing up, as the deployment's switch records none", async () => {
    // Owed only with something up (core's `repo_unpublish_owed`): a release that hasn't ended under the room's epoch
    // counts, so nothing in flight can go live after the link went off ready, and the recheck refuses new ones.
    const r = await room();
    await withApp(r.id, { up: false });
    await ready({ rulesets: "no_update" });
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "degraded", reason: "ruleset_missing" });
    expect(await inRoom(r.id, (sql) => ({
      unpublish: sql.exec("SELECT cause, release_epoch FROM unpublish").toArray(),
      epoch: sql.exec("SELECT release_epoch FROM release_config").one().release_epoch,
      event: sql.exec("SELECT reason FROM event WHERE type = 'app.unpublished'").toArray(),
    }))).toEqual({ unpublish: [], epoch: 2, event: [] });
  });

  it("restores a repository made before these settings were set, once they're switched off by hand on GitHub", async () => {
    const r = await room();
    // A repository from before: issues, wiki and projects on, as GitHub's defaults left them. Nothing repairs them.
    const before = { has_issues: true, has_wiki: true, has_projects: true, has_discussions: false, allow_auto_merge: false, delete_branch_on_merge: false };
    await ready({ settings: before });
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "degraded", reason: "settings_differ" });
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "degraded", reason: "settings_differ" });
    // Someone with admin rights switches them off on GitHub: the next recheck finds it right and restores the link.
    await ready({ settings: { ...before, has_issues: false, has_wiki: false, has_projects: false } });
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "ready", reason: null });
    expect(await link(r.id)).toMatchObject({ status: "ready", status_reason: null });
    expect((await events(r.id)).map((e) => e.type)).toEqual(["repository.degraded", "repository.ready_again"]);
  });

  it("leaves one that reads back right as it is, with no event, and refuses anyone but an operator", async () => {
    const r = await room();
    for (const who of [OWNER, AGENT]) {
      const refused = await recheck(who, r.id);
      expect([refused.status, refused.body?.error?.code], who.id).toEqual([403, "not_allowed"]);
    }
    expect((await readBack()).reads).toEqual([]);
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "ready", reason: null });
    expect(await link(r.id)).toMatchObject({ status: "ready", status_reason: null });
    expect(await events(r.id)).toEqual([]);
    expect(await tokens(r.id)).toEqual(["held"]);
    // No definite answer: refused as unavailable, and nothing changes.
    await ready({ script: { readRepo: 503 } });
    const down = await recheck(OPERATOR, r.id);
    expect([down.status, down.body?.error?.code]).toEqual([502, "provider_unavailable"]);
    expect((await link(r.id)).status).toBe("ready");
  });
});

describe("the guard against a GitHub outage reading as every repository gone (the architect's ruling of 2026-11-14)", () => {
  /**
   * A room of its own repository, with an app up, as `room()` and `withApp` make them, handed back quiet: no alarm run
   * under way and none to come, so a test that writes the room's rows next is the only thing that changes them.
   */
  async function roomWithApp() {
    REPO_ID = IDS.next();
    await fake("/agent-repo", { id: REPO_ID });
    await ready({ rulesets: "ready" });
    const r = await room();
    const app = await withApp(r.id);
    await alarmQuiet(stub(r.id));
    return { ...r, repo: REPO_ID, app };
  }
  /** Both looks of the daily read-back, a minute apart, at room `r`'s repository answering that it's gone. */
  async function bothLooks(r: { id: string; repo: number }) {
    REPO_ID = r.repo;
    await ready({ deleted: true });
    await checkedAgo(r.id, DAY + 1);
    await alarmPass(stub(r.id));
    await aMinuteLater(r.id);
    await alarmPass(stub(r.id));
  }
  /** Room `r`'s daily read-back finding a protection removed: one definite difference, which degrades at once. */
  async function rulesChanged(r: { id: string; repo: number }) {
    REPO_ID = r.repo;
    await ready({ rulesets: "no_update" });
    await checkedAgo(r.id, DAY + 1);
    await alarmPass(stub(r.id));
  }

  it("takes nothing as gone while the installation can't be read healthy: no link degraded, nothing unpublished, one finding", async () => {
    // Three rooms whose repositories all answer 404, as in an incident, with the installation suspended, removed, or
    // unreadable. Each room's two looks a minute apart would have degraded its link and retired its app's address.
    const rooms = [await roomWithApp(), await roomWithApp(), await roomWithApp()];
    const readings: [number, boolean, boolean | null][] = [[200, true, true], [404, false, null], [500, false, null]];
    for (const [i, r] of rooms.entries()) {
      await installation(r.id, ...readings[i]);
      REPO_ID = r.repo;
      await ready({ deleted: true });
      await checkedAgo(r.id, DAY + 1);
      await alarmPass(stub(r.id));
      // No sighting was kept, so the next look is the hourly retry's: made due, and made.
      await inRoom(r.id, (sql) => sql.exec("UPDATE repo_read SET at = at - 3700000 WHERE caller = 'readiness'"));
      await alarmPass(stub(r.id));
      expect((await readBack()).reads.map((read) => read.path)).toEqual([`/repositories/${r.repo}`, `/repositories/${r.repo}`]);
    }
    for (const r of rooms) {
      expect(await link(r.id)).toMatchObject({ status: "ready", status_reason: null });
      // Undecided, as a read that couldn't be made: no sighting is kept for a second look to confirm.
      expect(await goneSeen(r.id)).toBeNull();
      expect(await tokens(r.id)).toEqual(["held"]);
      expect(await events(r.id)).toEqual([]);
      expect(await appState(r.id)).toEqual(appUp(r.app));
    }
    // One finding for the deployment, however many rooms and looks met it, with the last reading. Nothing asked the
    // ceiling, since nothing was owed.
    expect(await ceiling()).toEqual({
      granted: [], held: [], tripped: false,
      findings: [{ code: "installation_unconfirmed", subject: "provisioning_installation", detail: "installation_unreadable", seen: 6 }],
    });
  });

  it("takes a single repository as gone when the installation reads healthy, and unpublishes its room's app (the control)", async () => {
    const r = await roomWithApp();
    await installation(r.id, 200, true, false);
    await bothLooks(r);
    expect(await link(r.id)).toMatchObject({ status: "degraded", status_reason: "repository_gone" });
    expect(await appState(r.id)).toEqual(appDown(r.app, "repository_gone"));
    // It took one of the ceiling's places for the hour, and nobody was told anything.
    expect(await ceiling()).toEqual({ granted: [r.id], held: [], tripped: false, findings: [] });
    expect(await woken(r.id)).toBe(false);
  });

  it("stops at the ceiling: the rest are degraded but held up, with one finding, until an operator's recheck confirms one", async () => {
    // 20 rooms with apps: a ceiling of 2 this hour, the smaller of 5 and 10% of 20.
    await roomsWithApps(20);
    const [a, b, c, d] = [await roomWithApp(), await roomWithApp(), await roomWithApp(), await roomWithApp()];
    for (const r of [a, b, c, d]) await rulesChanged(r);
    // Every link is degraded and every agent's token taken back: the ceiling holds only unpublishes.
    for (const r of [a, b, c, d]) {
      expect(await link(r.id)).toMatchObject({ status: "degraded", status_reason: "ruleset_missing" });
      expect(await tokens(r.id)).toEqual([]);
    }
    expect(await appState(a.id)).toEqual(appDown(a.app, "ruleset_missing"));
    expect(await appState(b.id)).toEqual(appDown(b.app, "ruleset_missing"));
    expect(await appState(c.id)).toEqual(appUp(c.app));
    expect(await appState(d.id)).toEqual(appUp(d.app));
    const heldFindings = (ids: string[]) => [...ids].sort().map((id) => ({ code: "repo_unpublish_held", subject: id, detail: null, seen: 1 }));
    expect(await ceiling()).toEqual({ granted: [a.id, b.id].sort(), held: [c.id, d.id].sort(), tripped: true, findings: heldFindings([c.id, d.id]) });
    // A held room keeps its retry in durable storage and its alarm armed for it, an hour on, not in a loop. Asked again
    // once that comes, even with the hour's places freed, it is held again: only an operator or its cause clearing
    // releases it.
    expect(await retryAt(c.id)).not.toBeNull();
    await expectNoAlarmSooner(stub(c.id), QUIET_MS);
    expect(await nextAlarm(stub(c.id))).not.toBeNull();
    // The room is evicted, as a restart would: what it asks next comes from its rows and its kept retry alone.
    await evictRoom(() => stub(c.id));
    await alarmPass(stub(c.id));
    expect(await appState(c.id)).toEqual(appUp(c.app));
    await anHourOn();
    await retryNow(c.id);
    await alarmPass(stub(c.id));
    expect(await appState(c.id)).toEqual(appUp(c.app));
    expect(await ceiling()).toMatchObject({ held: [c.id, d.id].sort(), tripped: true });
    expect(await woken(c.id)).toBe(true);
    // An operator's recheck of a held room is that operator's confirmation for it: it comes down. The other stays held.
    expect((await recheck(OPERATOR, c.id)).body).toEqual({ status: "degraded", reason: "ruleset_missing" });
    expect(await appState(c.id)).toEqual(appDown(c.app, "ruleset_missing"));
    expect(await appState(d.id)).toEqual(appUp(d.app));
    expect(await ceiling()).toMatchObject({ held: [d.id], tripped: true, findings: [{ code: "repo_unpublish_held", subject: d.id }] });
    expect(await retryAt(c.id)).toBeNull();
  });

  it("resumes once the cause clears: nothing comes back, the held room stays up, and the next room is decided afresh", async () => {
    await roomsWithApps(20);
    const [a, b, c] = [await roomWithApp(), await roomWithApp(), await roomWithApp()];
    for (const r of [a, b, c]) await rulesChanged(r);
    expect(await ceiling()).toMatchObject({ held: [c.id], tripped: true });
    // The rules are put back on the held room's repository, and an operator's recheck finds it right.
    REPO_ID = c.repo;
    await ready({ rulesets: "ready" });
    expect((await recheck(OPERATOR, c.id)).body).toEqual({ status: "ready", reason: null });
    expect(await woken(c.id)).toBe(false);
    // Nothing that came down comes back, and the held room's app was never taken down.
    expect(await appState(a.id)).toEqual(appDown(a.app, "ruleset_missing"));
    expect(await appState(b.id)).toEqual(appDown(b.app, "ruleset_missing"));
    expect(await appState(c.id)).toEqual(appUp(c.app));
    // No room is held, so the trip clears and the finding goes. The count is a rolling hour: the hour's two grants stay.
    expect(await ceiling()).toEqual({ granted: [a.id, b.id].sort(), held: [], tripped: false, findings: [] });
    expect(await retryAt(c.id)).toBeNull();
    // So the next room within that hour finds no place left, and is held.
    const e = await roomWithApp();
    await rulesChanged(e);
    expect(await appState(e.id)).toEqual(appUp(e.app));
    expect(await ceiling()).toMatchObject({ held: [e.id], tripped: true });
    // An hour on the places are free again, but a tripped ceiling still holds this room until an operator confirms it
    // or its cause clears. Confirmed, it comes down.
    await anHourOn();
    expect((await recheck(OPERATOR, e.id)).body).toEqual({ status: "degraded", reason: "ruleset_missing" });
    expect(await appState(e.id)).toEqual(appDown(e.app, "ruleset_missing"));
    // With nothing held and the hour gone, the next room comes down on its own ask.
    const f = await roomWithApp();
    await rulesChanged(f);
    expect(await appState(f.id)).toEqual(appDown(f.app, "ruleset_missing"));
    expect(await ceiling()).toEqual({ granted: [f.id], held: [], tripped: false, findings: [] });
  });

  it("asks from the room's rows, not its memory: a room stopped between the degrade and the ask asks at its next alarm", async () => {
    // As if the room stopped right after the degrade committed: the link is off ready with the app up, and nothing else
    // is kept anywhere. The room is armed for it, and its alarm asks.
    const r = await roomWithApp();
    await inRoom(r.id, (sql) => void sql.exec("UPDATE repo_link SET status = 'degraded', status_reason = 'ruleset_missing'"));
    // And it really stops: evicted, its memory is gone, and only its rows are left.
    await evictRoom(() => stub(r.id));
    expect(await retryAt(r.id)).toBeNull();
    expect(await woken(r.id)).toBe(true);
    await alarmPass(stub(r.id));
    expect(await appState(r.id)).toEqual(appDown(r.app, "ruleset_missing"));
    expect(await ceiling()).toEqual({ granted: [r.id], held: [], tripped: false, findings: [] });
    // Nothing is owed any more, and nothing is kept for it.
    expect(await retryAt(r.id)).toBeNull();
    expect(await woken(r.id)).toBe(false);
  });

  it("asks again when the ceiling gave no answer, told to operators by the room's ID until it does", async () => {
    const r = await roomWithApp();
    await inRoom(r.id, (sql) => void sql.exec("CREATE TABLE test_ceiling_unanswered (x INTEGER)"));
    await rulesChanged(r);
    expect(await link(r.id)).toMatchObject({ status: "degraded" });
    expect(await appState(r.id)).toEqual(appUp(r.app));
    expect(await ceiling()).toEqual({ granted: [], held: [], tripped: false, findings: [{ code: "repo_unpublish_stalled", subject: r.id, detail: "no_answer", seen: 1 }] });
    // The retry is kept durably and the alarm armed for it, so a restart loses nothing.
    expect(await retryAt(r.id)).not.toBeNull();
    expect(await nextAlarm(stub(r.id))).not.toBeNull();
    await evictRoom(() => stub(r.id));
    await inRoom(r.id, (sql) => void sql.exec("DROP TABLE test_ceiling_unanswered"));
    await retryNow(r.id);
    await alarmPass(stub(r.id));
    expect(await appState(r.id)).toEqual(appDown(r.app, "ruleset_missing"));
    expect(await ceiling()).toEqual({ granted: [r.id], held: [], tripped: false, findings: [] });
    expect(await retryAt(r.id)).toBeNull();
  });

  it("asks again when the ceiling couldn't count the rooms with apps, told to operators by the room's ID", async () => {
    const r = await roomWithApp();
    await inModeration((sql) => void sql.exec("CREATE TABLE test_rooms_uncounted (x INTEGER)"));
    await rulesChanged(r);
    expect(await appState(r.id)).toEqual(appUp(r.app));
    expect(await ceiling()).toEqual({ granted: [], held: [], tripped: false, findings: [{ code: "repo_unpublish_stalled", subject: r.id, detail: "undecided", seen: 1 }] });
    expect(await retryAt(r.id)).not.toBeNull();
    await inModeration((sql) => void sql.exec("DROP TABLE test_rooms_uncounted"));
    await retryNow(r.id);
    await alarmPass(stub(r.id));
    expect(await appState(r.id)).toEqual(appDown(r.app, "ruleset_missing"));
    expect(await ceiling()).toEqual({ granted: [r.id], held: [], tripped: false, findings: [] });
  });

  it("asks again after a granted unpublish failed, and is granted again within the hour without another place", async () => {
    const r = await roomWithApp();
    await inRoom(r.id, (sql) => void sql.exec("CREATE TABLE test_fail_after_unpublish (x INTEGER)"));
    await rulesChanged(r);
    expect(await link(r.id)).toMatchObject({ status: "degraded" });
    expect(await appState(r.id)).toEqual(appUp(r.app));
    expect(await ceiling()).toEqual({ granted: [r.id], held: [], tripped: false, findings: [{ code: "repo_unpublish_stalled", subject: r.id, detail: "unpublish_failed", seen: 1 }] });
    expect(await retryAt(r.id)).not.toBeNull();
    await inRoom(r.id, (sql) => void sql.exec("DROP TABLE test_fail_after_unpublish"));
    await retryNow(r.id);
    await alarmPass(stub(r.id));
    expect(await appState(r.id)).toEqual(appDown(r.app, "ruleset_missing"));
    expect(await ceiling()).toEqual({ granted: [r.id], held: [], tripped: false, findings: [] });
  });

  it("releases a held room whose app came down another way: the archived room tells the ceiling, and the trip clears", async () => {
    // No rooms counted: a ceiling of 1.
    const [a, b] = [await roomWithApp(), await roomWithApp()];
    for (const r of [a, b]) await rulesChanged(r);
    expect(await ceiling()).toMatchObject({ granted: [a.id], held: [b.id], tripped: true });
    const owner = OWNER;
    const archived = await api(owner, "POST", `/v1/workspaces/${b.id}/archive`, { policy_version: await version(b.id) });
    expect(archived.status, archived.text).toBe(200);
    expect(await inRoom(b.id, (sql) => sql.exec("SELECT cause FROM unpublish").toArray())).toEqual([{ cause: "workspace_archived" }]);
    // Nothing is owed now, and the ask it had outstanding is still kept: its alarm tells the ceiling it no longer waits.
    await alarmPass(stub(b.id));
    expect(await ceiling()).toEqual({ granted: [a.id], held: [], tripped: false, findings: [] });
    expect(await retryAt(b.id)).toBeNull();
  });

  it("keeps a place used for the hour when the link healed between the grant and the unpublish, which then doesn't happen", async () => {
    // No rooms counted: a ceiling of 1. The room is held at the stand-in's gate after its grant.
    const r = await roomWithApp();
    const gate = IDS.next();
    await inRoom(r.id, (sql) => { sql.exec("CREATE TABLE test_hold_before_unpublish (gate INTEGER)"); sql.exec("INSERT INTO test_hold_before_unpublish VALUES (?)", gate); });
    REPO_ID = r.repo;
    await ready({ rulesets: "no_update" });
    await checkedAgo(r.id, DAY + 1);
    const pass = alarmPass(stub(r.id));
    // The link is set right again while the room waits between the grant and its unpublish's own check.
    await atGate(gate, () => inRoom(r.id, (sql) => { sql.exec("UPDATE repo_link SET status = 'ready', status_reason = NULL"); sql.exec("DROP TABLE test_hold_before_unpublish"); }));
    await pass;
    expect(await appState(r.id)).toEqual(appUp(r.app));
    expect(await retryAt(r.id)).toBeNull();
    // The grant it didn't use still counts for the hour: the next room is held.
    expect(await ceiling()).toEqual({ granted: [r.id], held: [], tripped: false, findings: [] });
    const s2 = await roomWithApp();
    await rulesChanged(s2);
    expect(await appState(s2.id)).toEqual(appUp(s2.app));
    expect(await ceiling()).toMatchObject({ granted: [r.id], held: [s2.id], tripped: true });
  });

  it("still confirms on a replayed operator recheck when the first one's ask got no answer", async () => {
    const r = await roomWithApp();
    REPO_ID = r.repo;
    await ready({ rulesets: "no_update" });
    await inRoom(r.id, (sql) => void sql.exec("CREATE TABLE test_ceiling_unanswered (x INTEGER)"));
    const key = `rr-replay-${crypto.randomUUID()}`;
    const first = await api(OPERATOR, "POST", `/v1/moderation/repositories/${r.id}/recheck`, {}, { key });
    expect(first.body).toEqual({ status: "degraded", reason: "ruleset_missing" });
    expect(await appState(r.id)).toEqual(appUp(r.app));
    await inRoom(r.id, (sql) => void sql.exec("DROP TABLE test_ceiling_unanswered"));
    const again = await api(OPERATOR, "POST", `/v1/moderation/repositories/${r.id}/recheck`, {}, { key });
    expect(again.body).toEqual(first.body);
    expect(await appState(r.id)).toEqual(appDown(r.app, "ruleset_missing"));
    // An operator's confirmation takes no place under the ceiling.
    expect(await ceiling()).toEqual({ granted: [], held: [], tripped: false, findings: [] });
  });
});
