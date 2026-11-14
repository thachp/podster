import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { alarmPass, alarmQuiet, expectNoAlarmSooner } from "./alarm.ts";

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
let nextRepo = 6_000_000 + Math.floor(Math.random() * 1_000_000) * 10;

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
const readBack = async () => (await (await fetch(`https://github-fake.example.com/ready-reads?repo=${REPO_ID}`)).json()) as { reads: { path: string }[]; live: number; presence: { live: number; revokes: number[] } };
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

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin) }, body: JSON.stringify({ org_id: ORG, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register: ${res.status}`);
});

beforeEach(async () => {
  REPO_ID = ++nextRepo;
  await fake("/agent-repo", { id: REPO_ID });
  await ready({ rulesets: "ready" });
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
      REPO_ID = ++nextRepo;
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
      REPO_ID = ++nextRepo;
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
    // architect's ruling of 2026-11-13. The room serves an app, with the provider switched off so nothing is asked of it.
    const r = await room();
    const label = `rr${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const release = `rel_${"3c".repeat(16)}`;
    const script = `${label}.${release}`;
    await inRoom(r.id, (sql) => {
      sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
      sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
      sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 1, 2, ?, 1, 1)", OWNER.id);
      sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES ('tsk_rr_release', 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", OWNER.id, OWNER.id);
      sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
        VALUES (?, ?, 'served', ?, 1, 2, 'tsk_rr_release', ?, ?, ?, 1, ?, 1, 1, 1)`, release, "ab".repeat(20), label, script, release, OWNER.id, OWNER.id);
      sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", `${label}.apps.example`, label, release, script);
    });
    await ready({ deleted: true });
    await recheck(OPERATOR, r.id);
    await aMinuteLater(r.id);
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "degraded", reason: "repository_gone" });
    expect(await inRoom(r.id, (sql) => ({
      serving: sql.exec("SELECT script_name FROM serve_state").one().script_name,
      unpublish: sql.exec("SELECT cause, release_epoch FROM unpublish").toArray(),
      queued: sql.exec("SELECT script_name FROM script_delete").toArray().map((q: any) => q.script_name),
      event: sql.exec("SELECT actor_id, reason FROM event WHERE type = 'app.unpublished'").toArray(),
      audit: sql.exec("SELECT actor_id, new_json FROM audit_event WHERE action = 'app.unpublished'").toArray().map((a: any) => [a.actor_id, JSON.parse(a.new_json)]),
    }))).toEqual({
      serving: null,
      unpublish: [{ cause: "repo_not_ready", release_epoch: 3 }],
      queued: [script],
      event: [{ actor_id: "podster", reason: "repo_not_ready" }],
      audit: [["podster", { reason: "repo_not_ready", cause: "repository_gone" }]],
    });
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
