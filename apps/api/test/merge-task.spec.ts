import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { alarmPass, alarmQuiet } from "./alarm.ts";

// M5 step 7b: `merge_task`. Asking for a task's reviewed commit to be merged, and the room's job that marks it and
// merges it through the merge App, against the fake GitHub. A room's link is written straight into the room, and the
// fake holds this test's repository as provisioning would have left it. Nothing here reaches GitHub.

const BINDINGS = env as any;
const GH = JSON.parse(BINDINGS.TEST_FAKE_GITHUB);
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; linker?: string | null };
const ORG = "org_mt";
const OWNER: Who = { id: "per_mt_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const ADMIN: Who = { id: "per_mt_admin", kind: "person", org: ORG };
/** A person in the room who holds a merge grant, and controls none of the agents. */
const MERGER: Who = { id: "per_mt_merger", kind: "person", org: ORG };
/** The person who linked the submitting agent and its sibling. */
const LINKER: Who = { id: "per_mt_linker", kind: "person", org: ORG };
const AGENT: Who = { id: "agt_mt_agent", org: ORG, linker: LINKER.id };
const SIBLING: Who = { id: "agt_mt_sibling", org: ORG, linker: LINKER.id };
/** An agent another person controls. */
const ROBOT: Who = { id: "agt_mt_robot", org: ORG, linker: "per_mt_other_linker" };
/** An agent whose credential names nobody. */
const UNLINKED: Who = { id: "agt_mt_unlinked", org: ORG, linker: null };
const PUBLIC: Who = { id: "agt_mt_public", org: ORG, linker: "per_mt_public_linker" };
const OUTSIDER: Who = { id: "agt_mt_outsider", org: ORG, linker: "per_mt_x" };
const orgAdmin: Who = { id: "per_mt_orgadmin", kind: "person", org: ORG, adminOrgs: [ORG] };
let REPO_ID = 0;
let nextRepo = 11_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
const HEAD = "a1".repeat(20);
const HEAD2 = "c3".repeat(20);
const BASE = "b2".repeat(20);
const BASE2 = "d4".repeat(20);
const MERGED = "9e".repeat(20);
const MARK = { metadata: "read", statuses: "write" };
const MERGE = { contents: "write", metadata: "read", pull_requests: "write" };
const OBSERVE = { contents: "read", metadata: "read", pull_requests: "read" };

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  const facts = isAgent ? { gen: 1, ...(who.linker ? { linker: { person: who.linker, since: 1 } } : {}) } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] };
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...facts, ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, options: { key?: string; claims?: object } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, options.claims), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = options.key ?? `mt-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" || body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined, text };
}
const must = async (who: Who, method: string, path: string, body?: unknown, options: { claims?: object } = {}) => {
  const res = await api(who, method, path, body, options);
  if (res.status !== 200) throw new Error(`${method} ${path}: ${res.status} ${res.text}`);
  return res.body;
};

type Pull = { head_sha: string; base_sha: string; base_ref?: string; head_repo?: number | null; state?: "open" | "closed"; merged?: boolean; merge_commit_sha?: string; merged_by?: number; draft?: boolean };
const fake = (body: object) => fetch("https://github-fake.example.com/agent-repo", { method: "POST", body: JSON.stringify({ id: REPO_ID, ...body }) });
const pull = (number: number, patch: Partial<Pull> = {}) => fake({ pulls: { [number]: { head_sha: HEAD, base_sha: BASE, ...patch } } });
/** This test's repository as the provisioning App reads it back, or a change to it. */
const ready = (body: object = {}) => fetch("https://github-fake.example.com/ready-repo", { method: "POST", body: JSON.stringify({ id: REPO_ID, ...body }) });
/** Every token the agent-token App and the merge App minted for this test's repository. */
const minted = async () => (await (await fetch(`https://github-fake.example.com/agent-tokens?repo=${REPO_ID}`)).json()) as { token: string; live: boolean; repo: unknown; permissions: Record<string, string>; asked: any }[];
/** What the merge App did: its calls, the statuses set, the pull requests and what the default branch holds. */
const github = async () => (await (await fetch(`https://github-fake.example.com/merge-calls?repo=${REPO_ID}`)).json()) as { calls: { method: string; path: string; permissions: Record<string, string>; status: number; body: any }[]; statuses: { sha: string; state: string; context: string }[]; pulls: Record<string, Pull>; has: string[] };
const merges = async () => (await github()).calls.filter((c) => c.method === "PUT");
const marks = async () => (await github()).calls.filter((c) => c.method === "POST");
/** The provisioning App's read-back of this test's repository: its reads, and how many of its tokens are still live. */
const readBack = async () => (await (await fetch(`https://github-fake.example.com/ready-reads?repo=${REPO_ID}`)).json()) as { reads: { path: string; scope: number[] }[]; live: number };

const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version as number;
const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const change = (id: string, task: string) => inRoom(id, (sql) => (sql.exec("SELECT * FROM task_change WHERE task_id = ?", task).toArray()[0] ?? null) as any);
const events = (id: string, prefix = "merge.") => inRoom(id, (sql) => sql.exec("SELECT type, actor_id, subject_id, task_id, reason FROM event WHERE type LIKE ? ORDER BY seq", `${prefix}%`).toArray() as any[]);
const taskRow = (id: string, task: string) => inRoom(id, (sql) => sql.exec("SELECT status, approved_submission_no FROM task WHERE id = ?", task).one() as any);
const link = (id: string) => inRoom(id, (sql) => sql.exec("SELECT status, status_reason FROM repo_link").one() as any);
/** Whole runs of the room's alarm, one at a time (see `alarm.ts`). */
const alarm = async (id: string, times = 1) => {
  for (let n = 0; n < times; n++) await alarmPass(stub(id));
};
/**
 * Holds the merge job off in this room, so a test can look at a request, or change something, before any pass is made:
 * asking for a merge sets the room's alarm for at once, and the runtime may run it before the test's next line.
 */
const hold = (id: string) => inRoom(id, (sql) => {
  sql.exec("CREATE TABLE IF NOT EXISTS test_merge_dies (at TEXT)");
  sql.exec("INSERT INTO test_merge_dies (at) VALUES ('start')");
});
/** Stands for a Worker that dies at this point of a pass, or, with null, for one that doesn't. */
const dies = (id: string, at: string | null) => inRoom(id, (sql) => {
  sql.exec("CREATE TABLE IF NOT EXISTS test_merge_dies (at TEXT)");
  sql.exec("DELETE FROM test_merge_dies WHERE at <> 'start'");
  if (at) sql.exec("INSERT INTO test_merge_dies (at) VALUES (?)", at);
});
/** Makes the merge's next pass due now, as time passing would. */
const due = (id: string) => inRoom(id, (sql) => void sql.exec("UPDATE task_change SET merge_next_at = 0 WHERE merge_state IN ('requested', 'outcome_unknown')"));
/**
 * One pass of the merge job, whatever its backoff says. The hold comes off, the pass is made due and the alarm runs, all
 * in one step in the room, with the alarm the room had set taken away first: so the runtime's own alarm can't make a
 * pass in between, and exactly one is made.
 */
const pass = (id: string) =>
  runInDurableObject(stub(id), async (instance: any, state: any) => {
    const sql = state.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS test_merge_dies (at TEXT)");
    sql.exec("DELETE FROM test_merge_dies WHERE at = 'start'");
    sql.exec("UPDATE task_change SET merge_next_at = 0 WHERE merge_state IN ('requested', 'outcome_unknown')");
    await state.storage.deleteAlarm();
    await instance.alarm();
  });
const made: string[] = [];

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [AGENT, SIBLING, ROBOT, UNLINKED, PUBLIC, OUTSIDER]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin) }, body: JSON.stringify({ org_id: ORG, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

beforeEach(async () => {
  REPO_ID = ++nextRepo;
  await fake({});
  await ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});

const grant = async (id: string, who: Who) => (await must(OWNER, "POST", `/v1/workspaces/${id}/repository/grants`, { policy_version: await version(id), principal_id: who.id, action: "merge" })).id as string;

/** A room with managed repositories on, a ready link, and its people and agents. */
async function room(options: { switchedOn?: boolean } = {}) {
  const id: string = (await must(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).id;
  made.push(id);
  for (const [who, role] of [[ADMIN, "admin"], [MERGER, "member"], [LINKER, "member"]] as const) {
    await must(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "person", org_id: ORG, role, policy_version: await version(id) }, { claims: { target_member: { person: who.id, orgs: { [ORG]: 1 } } } });
  }
  for (const [who, role] of [[AGENT, "member"], [SIBLING, "member"], [ROBOT, "member"], [UNLINKED, "member"], [PUBLIC, "guest"]] as const) {
    await must(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: ORG, role, policy_version: await version(id) });
  }
  await inRoom(id, (sql) => {
    sql.exec("UPDATE member SET joined_via = 'public' WHERE principal_id = ?", PUBLIC.id);
    if (options.switchedOn !== false) sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)");
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podster-test-org/engineering', 'public', 'main', 'ready', ?, 1000, 2000, 2000)", REPO_ID, OWNER.id);
  });
  await pull(7);
  return id;
}

/** A linked task the agent submitted on pull request 7 at `HEAD`. The owner is its reviewer. */
async function submitted(id: string, number = 7, reviewer?: Who) {
  const made = await must(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Code", instructions: "Change the code", assignee: AGENT.id, ...(reviewer ? { reviewer: reviewer.id } : {}) });
  const accepted = await must(AGENT, "POST", `/v1/workspaces/${id}/tasks/${made.id}/accept`, { version: made.version });
  await must(AGENT, "POST", `/v1/workspaces/${id}/tasks/${made.id}/submit`, { version: accepted.version, note: "Done", commit_sha: HEAD, pr_number: number });
  return made.id as string;
}
/** A room whose task is approved at `HEAD`, with a merge grant for `MERGER`. */
async function approved() {
  const id = await room();
  const task = await submitted(id);
  await must(OWNER, "POST", `/v1/workspaces/${id}/tasks/${task}/verify`, { submission_no: 1, commit_sha: HEAD });
  const granted = await grant(id, MERGER);
  // The read made for the submission and the one for the approval are done. From here on, only the merge's calls count.
  await alarm(id);
  // No pass of the merge job is made until the test makes one.
  await hold(id);
  return { id, task, grant: granted };
}
const merge = (who: Who, id: string, task: string, body: object = { submission_no: 1, commit_sha: HEAD }, options: { key?: string } = {}) => api(who, "POST", `/v1/workspaces/${id}/tasks/${task}/merge`, body, options);
/** The same, with the merge asked for by `MERGER` and no pass of the job made yet. */
async function requested() {
  const r = await approved();
  const asked = await merge(MERGER, r.id, r.task);
  expect(asked.status, asked.text).toBe(200);
  return r;
}

describe("asking for a merge", () => {
  it("records the request and calls nothing, then the job marks exactly the reviewed commit and merges it (M5-09)", async () => {
    const r = await approved();
    const tokensBefore = (await minted()).length;
    const asked = await merge(MERGER, r.id, r.task, undefined, { key: "mt-once" });
    expect(asked.status, asked.text).toBe(200);
    expect(asked.body).toEqual({ task_id: r.task, merge_state: "requested", commit_sha: HEAD, submission_no: 1, requested_at: expect.any(Number) });
    // The command itself asked GitHub for nothing, and a replay answers the same and records nothing more.
    expect((await minted()).length).toBe(tokensBefore);
    expect((await github()).calls).toEqual([]);
    expect((await readBack()).reads).toEqual([]);
    expect((await merge(MERGER, r.id, r.task, undefined, { key: "mt-once" })).body).toEqual(asked.body);
    expect(await events(r.id)).toEqual([{ type: "merge.requested", actor_id: MERGER.id, subject_id: null, task_id: r.task, reason: null }]);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "requested", merge_requested_by: MERGER.id, merge_requester_person: MERGER.id, merge_attempts: 0, merge_step: "requested", merge_marked_at: null, merge_called_at: null, submitter_id: AGENT.id, submitter_person: LINKER.id });

    await pass(r.id);
    const done = await change(r.id, r.task);
    expect(done).toMatchObject({ merge_state: "succeeded", merge_reason: null, merge_sha: MERGED, merged_by_id: GH.mergeBotId, merge_base_sha: BASE, pr_state: "merged", merge_step: "succeeded", merge_attempts: 1, merge_next_at: null, merge_observed_at: null, reviewed_commit_sha: HEAD });
    for (const at of [done.merge_marked_at, done.merge_mark_set_at, done.merge_called_at, done.merge_finished_at]) expect(at).toBeGreaterThan(0);
    // Readiness first, with the provisioning App narrowed to this repository; then a read; the mark; the merge and its reads.
    const back = await readBack();
    expect(back.reads.map((read) => read.path)).toEqual([`/repositories/${REPO_ID}`, `/repositories/${REPO_ID}/branches/main`, `/repositories/${REPO_ID}/actions/permissions`, `/repositories/${REPO_ID}/actions/permissions/workflow`, `/repositories/${REPO_ID}/rulesets?per_page=100`.replace("?per_page=100", ""), `/repositories/${REPO_ID}/rulesets/1`, `/repositories/${REPO_ID}/rulesets/2`]);
    expect(back.reads.every((read) => JSON.stringify(read.scope) === JSON.stringify([REPO_ID]))).toBe(true);
    const seen = await github();
    expect(seen.calls.map((c) => [c.method, c.path, c.permissions, c.status])).toEqual([
      ["GET", `/repositories/${REPO_ID}/compare/main...${HEAD}`, OBSERVE, 200],
      ["POST", `/repositories/${REPO_ID}/statuses/${HEAD}`, MARK, 201],
      ["PUT", `/repositories/${REPO_ID}/pulls/7/merge`, MERGE, 200],
      ["GET", `/repositories/${REPO_ID}/compare/main...${HEAD}`, MERGE, 200],
    ]);
    expect(seen.calls[1].body).toEqual({ state: "success", context: "podster/review" });
    expect(seen.calls[2].body).toEqual({ sha: HEAD, merge_method: "merge" });
    expect(seen.statuses).toEqual([{ sha: HEAD, state: "success", context: "podster/review" }]);
    expect(seen.has).toEqual([HEAD]);
    // Every token of this pass is gone: the provisioning App's, and the merge App's three, each for this one repository.
    expect(back.live).toBe(0);
    const tokens = (await minted()).slice(tokensBefore);
    expect(tokens.map((t) => [t.permissions, t.repo, t.live])).toEqual([[OBSERVE, [REPO_ID], false], [MARK, [REPO_ID], false], [MERGE, [REPO_ID], false]]);
    // One outcome, of IDs, for the room's owner, its admin and whoever asked.
    expect(await events(r.id)).toEqual([
      { type: "merge.requested", actor_id: MERGER.id, subject_id: null, task_id: r.task, reason: null },
      { type: "merge.succeeded", actor_id: "system", subject_id: MERGER.id, task_id: r.task, reason: null },
    ]);
    expect(await taskRow(r.id, r.task)).toEqual({ status: "completed", approved_submission_no: 1 });
    expect((await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`)).change).toMatchObject({ merge_state: "succeeded", merge_sha: MERGED, merge_requested_by: MERGER.id, pr_state: "merged" });
    // Done: nothing is asked of GitHub again, and it can't be asked for twice.
    const calls = seen.calls.length;
    await alarm(r.id, 2);
    expect((await github()).calls.length).toBe(calls);
    const again = await merge(MERGER, r.id, r.task);
    expect([again.status, again.code]).toEqual([409, "already_merged"]);
  });

  it("merges in a room that has its repository when the deployment's list of requesters names nobody in it", async () => {
    // `REPOSITORY_REQUESTERS` bears on asking for a repository and retrying its setup, and on nothing else.
    const r = await approved();
    await inRoom(r.id, (sql) => { sql.exec("CREATE TABLE test_repository_requesters (value TEXT)"); sql.exec("INSERT INTO test_repository_requesters VALUES ('')"); });
    const asked = await merge(MERGER, r.id, r.task);
    expect(asked.status, asked.text).toBe(200);
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "succeeded", merge_sha: MERGED });
  });

  it("merges nothing on approval alone, however long passes (AC-17)", async () => {
    const r = await approved();
    await alarm(r.id, 3);
    expect((await github()).calls).toEqual([]);
    expect((await readBack()).reads).toEqual([]);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "not_requested", merge_requested_by: null, pr_state: "open" });
    expect(await events(r.id)).toEqual([]);
  });

  it("refuses the submitter, anyone its person controls, and anyone without the grant, whatever grant they hold (M5-10)", async () => {
    const r = await approved();
    // Holding the room or the review isn't holding the grant.
    for (const who of [OWNER, ADMIN]) {
      const got = await merge(who, r.id, r.task);
      expect([got.status, got.code], who.id).toEqual([403, "grant_required"]);
    }
    // With a merge grant each: the submitting agent, the person who controls it, that person's other agent, and an
    // agent whose controlling person nobody can name. All the same work, to the same person.
    for (const who of [AGENT, LINKER, SIBLING, UNLINKED]) {
      await grant(r.id, who);
      const got = await merge(who, r.id, r.task);
      expect([got.status, got.code], who.id).toEqual([403, "self_merge"]);
    }
    // An agent another person controls, with the grant, may.
    await grant(r.id, ROBOT);
    expect((await merge(ROBOT, r.id, r.task)).status).toBe(200);
    expect(await change(r.id, r.task)).toMatchObject({ merge_requested_by: ROBOT.id, merge_requester_person: ROBOT.linker });
    expect((await github()).calls).toEqual([]);
  });

  it("answers a hidden room and a hidden task as missing ones, before anything else", async () => {
    const r = await approved();
    const outside = await merge(OUTSIDER, r.id, r.task);
    const nowhere = await merge(OUTSIDER, `ws_${crypto.randomUUID().replaceAll("-", "")}`, r.task);
    expect([outside.status, outside.code]).toEqual([nowhere.status, nowhere.code]);
    expect(outside.code).toBe("workspace_not_found");
    const hidden = await merge(PUBLIC, r.id, r.task);
    const missing = await merge(PUBLIC, r.id, "tsk_missing");
    expect([hidden.status, hidden.code]).toEqual([missing.status, missing.code]);
    expect([hidden.status, hidden.code]).toEqual([404, "task_not_found"]);
    // A malformed body tells a hidden task's caller nothing either.
    expect((await merge(PUBLIC, r.id, r.task, {})).code).toBe("task_not_found");
  });

  it("refuses each state a merge can't start from, and records nothing", async () => {
    const r = await approved();
    const refused = async (expected: [number, string], body: object = { submission_no: 1, commit_sha: HEAD }, task = r.task) => {
      const got = await merge(MERGER, r.id, task, body);
      expect([got.status, got.code], JSON.stringify(expected)).toEqual(expected);
    };
    await refused([400, "invalid_argument"], {});
    await refused([400, "invalid_argument"], { submission_no: 1 });
    await refused([400, "invalid_argument"], { submission_no: 1, commit_sha: "a1b2c3d" });
    // The contract takes two fields. Anything else, such as something that would name a pull request, is refused.
    for (const extra of [{ pr_number: 7 }, { repository_id: 1 }, { merge_method: "squash" }, { sha: HEAD2 }]) await refused([400, "invalid_argument"], { submission_no: 1, commit_sha: HEAD, ...extra });
    await refused([409, "submission_mismatch"], { submission_no: 2, commit_sha: HEAD });
    await refused([409, "commit_changed"], { submission_no: 1, commit_sha: HEAD2 });
    // Submitted and not approved.
    await pull(8);
    const waiting = await submitted(r.id, 8);
    await refused([409, "not_approved"], undefined, waiting);
    // Not a linked task.
    await inRoom(r.id, (sql) => sql.exec("UPDATE task SET has_linked_repository = 0 WHERE id = ?", r.task));
    await refused([409, "task_not_linked"]);
    await inRoom(r.id, (sql) => sql.exec("UPDATE task SET has_linked_repository = 1 WHERE id = ?", r.task));
    // The repository isn't ready.
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_link SET status = 'degraded'"));
    await refused([409, "repo_not_ready"]);
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_link SET status = 'ready'"));
    // Approved while managed repositories were off: nothing was read, so there's no reviewed commit. It needs a fresh review.
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET reviewed_commit_sha = NULL WHERE task_id = ?", r.task));
    await refused([409, "review_required"]);
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET reviewed_commit_sha = ? WHERE task_id = ?", HEAD, r.task));
    // The head was seen off the reviewed commit at some point, and is back on it now. Still changed.
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET commit_changed_at = 5 WHERE task_id = ?", r.task));
    await refused([409, "commit_changed"]);
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET commit_changed_at = NULL, unwatched_at = 5 WHERE task_id = ?", r.task));
    await refused([409, "change_unwatched"]);
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET unwatched_at = NULL WHERE task_id = ?", r.task));
    // No change on record at all, so no submitter on record either: nobody can be shown not to be them.
    const kept = await change(r.id, r.task);
    await inRoom(r.id, (sql) => sql.exec("DELETE FROM task_change WHERE task_id = ?", r.task));
    await refused([403, "self_merge"]);
    // Approved by the owner, who controls neither party: an independent review, as the owner's decision on A1 asks.
    await inRoom(r.id, (sql) => sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, reviewed_commit_sha, reviewed_base_sha, observed_head_sha, pr_state, pr_draft, pr_observed_at, read_at, created_at, updated_at, submitter_id, submitter_person, reviewer_id, reviewer_person) VALUES (?, ?, 7, 1, ?, ?, ?, 'open', 0, ?, ?, 1, 1, ?, ?, ?, ?)", r.task, REPO_ID, HEAD, BASE, HEAD, kept.pr_observed_at, kept.read_at, AGENT.id, LINKER.id, OWNER.id, OWNER.id));
    // The grant has run out, or was taken back.
    await inRoom(r.id, (sql) => sql.exec("UPDATE provider_grant SET expires_at = ? WHERE id = ?", Date.now() - 1, r.grant));
    await refused([403, "grant_expired"]);
    await inRoom(r.id, (sql) => sql.exec("UPDATE provider_grant SET expires_at = NULL WHERE id = ?", r.grant));
    // The merge App isn't configured: nothing is recorded that the job could never do.
    await inRoom(r.id, (sql) => sql.exec("CREATE TABLE test_no_merge_app (x INTEGER)"));
    await refused([503, "merge_unavailable"]);
    await inRoom(r.id, (sql) => sql.exec("DROP TABLE test_no_merge_app"));
    // The merge App is the same App as the agent-token App: refused as not configured.
    await inRoom(r.id, (sql) => { sql.exec("CREATE TABLE test_github_vars (name TEXT, value TEXT)"); sql.exec("INSERT INTO test_github_vars (name, value) VALUES ('GITHUB_MERGE_APP_ID', ?)", String(GH.agentAppId)); });
    await refused([503, "merge_unavailable"]);
    await inRoom(r.id, (sql) => sql.exec("DROP TABLE test_github_vars"));
    // Through all of it nothing was recorded and GitHub was asked nothing.
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "not_requested", merge_requested_by: null });
    expect(await events(r.id)).toEqual([]);
    expect((await github()).calls).toEqual([]);
    // Asked for properly, it's taken once, and not again while it's under way.
    expect((await merge(MERGER, r.id, r.task)).status).toBe(200);
    await refused([409, "merge_already_requested"]);
  });

  it("doesn't exist with managed repositories off", async () => {
    const r = await approved();
    await inRoom(r.id, (sql) => sql.exec("DROP TABLE test_managed_repositories_on"));
    // Exactly as a task verb that doesn't exist answers, for everyone and whatever is sent.
    for (const who of [MERGER, OWNER, AGENT, PUBLIC]) {
      for (const body of [{ submission_no: 1, commit_sha: HEAD }, {}]) {
        const got = await merge(who, r.id, r.task, body);
        const none = await api(who, "POST", `/v1/workspaces/${r.id}/tasks/${r.task}/no-such-verb`, body);
        expect([got.status, got.text], who.id).toEqual([none.status, none.text]);
      }
    }
    expect((await merge(MERGER, r.id, r.task)).code).toBe("not_found");
    // Without an idempotency key too.
    const bare = async (verb: string) => {
      const res = await SELF.fetch(`https://api.internal/v1/workspaces/${r.id}/tasks/${r.task}/${verb}`, { method: "POST", headers: { "x-podster-assertion": await assertion(MERGER), "content-type": "application/json" }, body: "{}" });
      return [res.status, await res.text()];
    };
    expect(await bare("merge")).toEqual(await bare("no-such-verb"));
    // A merge asked for before the switch went off isn't carried out while it's off.
    await inRoom(r.id, (sql) => sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)"));
    expect((await merge(MERGER, r.id, r.task)).status).toBe(200);
    await inRoom(r.id, (sql) => sql.exec("DROP TABLE test_managed_repositories_on"));
    await pass(r.id);
    expect((await github()).calls).toEqual([]);
    expect((await change(r.id, r.task)).merge_state).toBe("requested");
  });
});

describe("an independent review (the owner's decision of 2026-11-11 on review A1)", () => {
  /** A room whose task `reviewer` approved at `HEAD`, with a merge grant for `MERGER` and the job held. */
  async function approvedBy(reviewer: Who) {
    const id = await room();
    const task = await submitted(id, 7, reviewer);
    const done = await api(reviewer, "POST", `/v1/workspaces/${id}/tasks/${task}/verify`, { submission_no: 1, commit_sha: HEAD });
    expect(done.status, done.text).toBe(200);
    await grant(id, MERGER);
    await alarm(id);
    await hold(id);
    return { id, task };
  }

  it("refuses to merge a commit its submitter's own person approved, or another of their agents did, though the task's review completes as before", async () => {
    for (const reviewer of [LINKER, SIBLING]) {
      REPO_ID = ++nextRepo;
      await fake({});
      await ready();
      const r = await approvedBy(reviewer);
      // Ordinary review is unchanged: the task is approved, at the reviewed commit, by the submitter's own controller.
      expect(await taskRow(r.id, r.task), reviewer.id).toEqual({ status: "completed", approved_submission_no: 1 });
      expect(await change(r.id, r.task), reviewer.id).toMatchObject({ reviewed_commit_sha: HEAD, reviewer_id: reviewer.id, reviewer_person: LINKER.id });
      // Only the merge is refused, with its own code, and nothing is recorded or asked of GitHub.
      const refused = await merge(MERGER, r.id, r.task);
      expect([refused.status, refused.code], reviewer.id).toEqual([403, "self_review"]);
      // It asks for someone else's review.
      expect(refused.body.error.message, reviewer.id).toMatch(/someone other than the person who controls its submitter/);
      expect(await change(r.id, r.task), reviewer.id).toMatchObject({ merge_state: "not_requested", merge_requested_by: null });
      expect(await events(r.id), reviewer.id).toEqual([]);
      expect((await github()).calls, reviewer.id).toEqual([]);
    }
  });

  it("merges a commit another person's agent approved, and one a person who controls no party approved", async () => {
    for (const reviewer of [ROBOT, ADMIN]) {
      REPO_ID = ++nextRepo;
      await fake({});
      await ready();
      await pull(7);
      const r = await approvedBy(reviewer);
      const asked = await merge(MERGER, r.id, r.task);
      expect(asked.status, `${reviewer.id} ${asked.text}`).toBe(200);
      await pass(r.id);
      expect((await change(r.id, r.task)).merge_state, reviewer.id).toBe("succeeded");
    }
  });

  it("refuses an approval the room recorded before it kept its reviewer, rather than guess who gave it", async () => {
    const r = await approved();
    await inRoom(r.id, (sql) => void sql.exec("UPDATE task_change SET reviewer_id = NULL, reviewer_person = NULL"));
    const refused = await merge(MERGER, r.id, r.task);
    expect([refused.status, refused.code]).toEqual([403, "self_review"]);
    // The same code, saying the commit needs reviewing again, not that someone else must review: the earlier approval
    // may well have been independent, and simply wasn't recorded.
    expect(refused.body.error.message).toMatch(/needs to be reviewed again/);
    expect(refused.body.error.message).not.toMatch(/someone other than/);
    // A reviewer on record whose controlling person isn't counts as not independent too, said as such.
    await inRoom(r.id, (sql) => void sql.exec("UPDATE task_change SET reviewer_id = ?, reviewer_person = NULL", ROBOT.id));
    const unknown = await merge(MERGER, r.id, r.task);
    expect(unknown.code).toBe("self_review");
    expect(unknown.body.error.message).toMatch(/controlling person isn't known/);
  });

  it("refuses a commit an agent with no linking person approved, saying who controls the reviewer isn't known", async () => {
    const r = await approvedBy(UNLINKED);
    expect(await change(r.id, r.task)).toMatchObject({ reviewer_id: UNLINKED.id, reviewer_person: null });
    const refused = await merge(MERGER, r.id, r.task);
    expect([refused.status, refused.code]).toEqual([403, "self_review"]);
    expect(refused.body.error.message).toMatch(/controlling person isn't known/);
    expect(refused.body.error.message).not.toMatch(/reviewed again/);
  });

  it("clears the recorded reviewer together with the reviewed commit when the work is submitted again", async () => {
    const id = await room();
    const task = await submitted(id);
    // An approval's record on the change, as an earlier review left it, while the task is back for changes.
    await inRoom(id, (sql) => void sql.exec("UPDATE task_change SET reviewed_commit_sha = ?, reviewer_id = ?, reviewer_person = ?", HEAD, ROBOT.id, "per_mt_other_linker"));
    const back = await must(OWNER, "POST", `/v1/workspaces/${id}/tasks/${task}/request-changes`, { submission_no: 1, reason: "More" });
    await pull(7, { head_sha: HEAD2 });
    const again = await api(AGENT, "POST", `/v1/workspaces/${id}/tasks/${task}/submit`, { version: back.version, note: "Again", commit_sha: HEAD2, pr_number: 7 });
    expect(again.status, again.text).toBe(200);
    expect(await change(id, task)).toMatchObject({ submission_no: 2, observed_head_sha: HEAD2, reviewed_commit_sha: null, reviewer_id: null, reviewer_person: null });
  });

  it("tells a caller who may not merge nothing about the review", async () => {
    const r = await approvedBy(LINKER);
    // No grant: the grant's refusal, not the review's.
    const robot = await merge(ROBOT, r.id, r.task);
    expect([robot.status, robot.code]).toEqual([403, "grant_required"]);
    // The submitter's own person: `self_merge`, as before.
    expect((await merge(LINKER, r.id, r.task)).code).toBe("self_merge");
  });

});

describe("the job checks everything again", () => {
  it("ends the merge when the requester's authority is gone by the time it runs, and marks nothing", async () => {
    for (const [what, lose, reason] of [
      ["grant revoked", async (r: any) => void (await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) })), "grant_required"],
      ["grant expired", (r: any) => inRoom(r.id, (sql) => void sql.exec("UPDATE provider_grant SET expires_at = ? WHERE id = ?", Date.now() - 1, r.grant)), "grant_expired"],
      ["requester removed", async (r: any) => void (await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/members/${MERGER.id}`, { policy_version: await version(r.id) })), "access_revoked"],
      ["commit seen changed", (r: any) => inRoom(r.id, (sql) => void sql.exec("UPDATE task_change SET commit_changed_at = 5")), "commit_changed"],
      ["link degraded", (r: any) => inRoom(r.id, (sql) => void sql.exec("UPDATE repo_link SET status = 'degraded'")), "repo_not_ready"],
      ["room archived", async (r: any) => void (await must(OWNER, "POST", `/v1/workspaces/${r.id}/archive`, { policy_version: await version(r.id) })), "workspace_archived"],
      ["room suspended", (r: any) => inRoom(r.id, (sql) => void sql.exec("UPDATE workspace SET suspended_at = 5, suspension_reason = 'test'")), "room_suspended"],
      // The request's own policy decision, run again (review A3): a requester who can no longer see the task, and one
      // who is now in the room through a public claim, are refused as the request would refuse them.
      ["requester's access narrowed", (r: any) => inRoom(r.id, (sql) => void sql.exec("UPDATE access_grant SET tasks = 'own' WHERE principal_id = ?", MERGER.id)), "task_not_found"],
      ["requester now there through a public claim", (r: any) => inRoom(r.id, (sql) => void sql.exec("UPDATE member SET joined_via = 'public', role = 'guest' WHERE principal_id = ?", MERGER.id)), "public_participant"],
      // The approving review, as the room's record has it, turns out not to be independent of the submitter (A1).
      ["review not independent", (r: any) => inRoom(r.id, (sql) => void sql.exec("UPDATE task_change SET reviewer_person = ?", LINKER.id)), "self_review"],
      // The owner, who gave the grant, has left the organization, and the room hasn't been told. Last, since it's the owner's own record.
      ["grant gone stale", async (r: any) => {
        await must(OWNER, "POST", "/v1/org-departures", {}, { claims: { departure: { person: OWNER.id, org: ORG, left_at: Date.now() } } });
        await inRoom(r.id, (sql) => void sql.exec("UPDATE workspace SET owner_left_at = NULL"));
      }, "grant_stale"],
    ] as const) {
      REPO_ID = ++nextRepo;
      await fake({});
      await ready();
      const r = await requested();
      await lose(r);
      await pass(r.id);
      expect(await change(r.id, r.task), what).toMatchObject({ merge_state: "failed", merge_reason: reason, merge_marked_at: null, merge_called_at: null, merge_next_at: null });
      expect((await github()).calls, what).toEqual([]);
      expect((await events(r.id)).at(-1), what).toEqual({ type: "merge.failed", actor_id: "system", subject_id: MERGER.id, task_id: r.task, reason });
      expect((await taskRow(r.id, r.task)).status, what).toBe("completed");
    }
  });

  it("ends the merge when an agent requester's linking person has left since asking, as token issue refuses (review A3)", async () => {
    const r = await approved();
    const linker = `per_mt_gone_${++counter}`;
    const agent: Who = { id: ROBOT.id, org: ORG, linker };
    await grant(r.id, ROBOT);
    const asked = await merge(agent, r.id, r.task);
    expect(asked.status, asked.text).toBe(200);
    // The linker leaves the organization after the request. Nothing in the room changes: they were never in it.
    await must({ id: linker, kind: "person", org: ORG }, "POST", "/v1/org-departures", {}, { claims: { departure: { person: linker, org: ORG, left_at: Date.now() } } });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "failed", merge_reason: "controller_departed", merge_marked_at: null, merge_called_at: null });
    expect((await github()).calls).toEqual([]);
    // And a request through a credential whose linker has already left is refused when it's made.
    const again = await merge(agent, r.id, r.task);
    expect([again.status, again.code]).toEqual([403, "controller_departed"]);
  });

  it("reads the repository's protections back first, and degrades the link instead of merging when they aren't what was set", async () => {
    for (const [patch, reason] of [[{ actionsEnabled: true }, "actions_enabled"], [{ rulesets: "no_update" }, "ruleset_missing"], [{ rulesets: "extra_bypass" }, "bypass_differs"], [{ rulesets: "inactive" }, "ruleset_inactive"], [{ rulesets: "extra" }, "unexpected_ruleset"], [{ archived: true }, "archived"]] as const) {
      REPO_ID = ++nextRepo;
      await fake({});
      await ready();
      const r = await requested();
      await ready(patch);
      await pass(r.id);
      expect(await link(r.id), reason).toEqual({ status: "degraded", status_reason: reason });
      expect(await change(r.id, r.task), reason).toMatchObject({ merge_state: "failed", merge_reason: "repo_not_ready", merge_marked_at: null, merge_called_at: null });
      expect((await github()).calls, reason).toEqual([]);
      expect((await readBack()).live, reason).toBe(0);
      // Coding work in the room stops with it, and a merge can't be asked for again until someone has looked.
      const again = await merge(MERGER, r.id, r.task);
      expect([again.status, again.code], reason).toEqual([409, "repo_not_ready"]);
    }
  });

  it("waits, counted, when the read-back can't be made, and goes on once it can", async () => {
    const r = await requested();
    await ready({ script: { readRepo: 500 } });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "requested", merge_attempts: 1, merge_marked_at: null });
    expect((await change(r.id, r.task)).merge_next_at).toBeGreaterThan(Date.now());
    expect(await link(r.id)).toEqual({ status: "ready", status_reason: null });
    // Not before its time.
    await alarm(r.id, 2);
    expect((await change(r.id, r.task)).merge_attempts).toBe(1);
    // A read-back that can't see who may bypass the rules isn't one either.
    await ready({ script: { hideBypass: true } });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "failed", merge_reason: "repo_not_ready" });
    expect((await github()).calls).toEqual([]);
  });

  it("ends the merge, marking nothing, when the pull request isn't what was reviewed any more", async () => {
    for (const [patch, reason, sticky] of [
      [{ head_sha: HEAD2 }, "commit_changed", true],
      [{ base_ref: "release" }, "base_changed", false],
      [{ head_repo: 1 }, "head_repo_changed", false],
      [{ head_repo: null }, "head_repo_changed", false],
      [{ state: "closed" }, "pull_request_closed", false],
      [{ draft: true }, "pull_request_draft", false],
      [{ merged: true, merge_commit_sha: "8d".repeat(20), merged_by: 31337 }, "merged_elsewhere", false],
    ] as const) {
      REPO_ID = ++nextRepo;
      await fake({});
      await ready();
      const r = await requested();
      await pull(7, patch as Partial<Pull>);
      await pass(r.id);
      const row = await change(r.id, r.task);
      expect(row, reason).toMatchObject({ merge_state: "failed", merge_reason: reason, merge_marked_at: null, merge_called_at: null, reviewed_commit_sha: HEAD });
      expect(row.commit_changed_at !== null, reason).toBe(sticky);
      expect(await marks(), reason).toEqual([]);
      expect(await merges(), reason).toEqual([]);
      expect((await minted()).every((token) => !token.live), reason).toBe(true);
      expect((await taskRow(r.id, r.task)).status, reason).toBe("completed");
      // A changed commit can't be asked for again: the way on is a follow-up task. Other failures can.
      await pull(7);
      const again = await merge(MERGER, r.id, r.task);
      expect(again.code ?? "ok", reason).toBe(sticky ? "commit_changed" : "ok");
    }
    // A base that moved under the same branch still merges, and the base seen at the merge is kept.
    REPO_ID = ++nextRepo;
    await fake({});
    await ready();
    const r = await requested();
    await pull(7, { base_sha: BASE2 });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "succeeded", merge_base_sha: BASE2, reviewed_base_sha: BASE });
  });
});

describe("dying and coming back", () => {
  it("before the mark: the intent is on record, nothing was set, and the next pass does everything again and merges once", async () => {
    const r = await requested();
    await dies(r.id, "before_mark");
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "requested", merge_step: "mark", merge_mark_set_at: null, merge_called_at: null, merge_attempts: 1 });
    expect((await change(r.id, r.task)).merge_marked_at).toBeGreaterThan(0);
    expect((await github()).statuses).toEqual([]);
    await dies(r.id, null);
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "succeeded", merge_attempts: 2 });
    expect((await github()).statuses).toHaveLength(1);
    expect(await merges()).toHaveLength(1);
    // The second pass read the protections and the pull request again before it marked.
    expect((await readBack()).reads.filter((read) => read.path === `/repositories/${REPO_ID}`)).toHaveLength(2);
  });

  it("after the mark, with authority gone since: the next pass refuses, and the mark left behind merges nothing", async () => {
    const r = await requested();
    await dies(r.id, "after_mark");
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "requested", merge_step: "marked", merge_called_at: null });
    expect((await github()).statuses).toEqual([{ sha: HEAD, state: "success", context: "podster/review" }]);
    expect(await merges()).toEqual([]);
    // The grant is taken back while the job is down.
    await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) });
    await dies(r.id, null);
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "failed", merge_reason: "grant_required", merge_called_at: null });
    expect(await merges()).toEqual([]);
    expect((await github()).pulls["7"]).toMatchObject({ head_sha: HEAD });
    expect((await github()).pulls["7"].merged ?? false).toBe(false);
    // The status is still on the commit, and an agent's token can't use it: the rules let only the merge App update the
    // default branch. The fake refuses as GitHub's update rule does.
    const push = await grantPush(r.id);
    const token = (await must(AGENT, "POST", `/v1/workspaces/${r.id}/tasks/${push}/repo-access`, undefined)).token as string;
    const tried = await fetch(`https://api.github.com/repositories/${REPO_ID}/pulls/7/merge`, { method: "PUT", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "test" }, body: JSON.stringify({ sha: HEAD, merge_method: "merge" }) });
    expect(tried.status).toBe(405);
    expect((await github()).pulls["7"].merged ?? false).toBe(false);
  });

  it("after the mark, with the head moved since: the next pass refuses, and the marked commit stays unmerged", async () => {
    const r = await requested();
    await dies(r.id, "after_mark");
    await pass(r.id);
    await pull(7, { head_sha: HEAD2 });
    await dies(r.id, null);
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "failed", merge_reason: "commit_changed", merge_called_at: null });
    expect((await change(r.id, r.task)).commit_changed_at).toBeGreaterThan(0);
    expect(await merges()).toEqual([]);
    // Only the reviewed commit was ever marked. The new head has no status.
    expect((await github()).statuses.map((s) => s.sha)).toEqual([HEAD]);
  });

  it("after the merge call, with its answer never seen: the next pass reads first, finds it merged, and asks for no second merge", async () => {
    const r = await requested();
    await dies(r.id, "after_merge_call");
    await pass(r.id);
    const mid = await change(r.id, r.task);
    expect(mid).toMatchObject({ merge_state: "requested", merge_step: "merge", merge_sha: null });
    expect(mid.merge_called_at).toBeGreaterThan(0);
    expect(await merges()).toHaveLength(1);
    await dies(r.id, null);
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "succeeded", merge_sha: MERGED, merge_attempts: 2 });
    expect(await merges()).toHaveLength(1);
    expect(await marks()).toHaveLength(1);
    // And with the requester's authority gone in between: the call was authorized when it was made, so the next pass
    // reads GitHub before it ends the merge, and records what the call did.
    REPO_ID = ++nextRepo;
    await fake({});
    await ready();
    const lost = await requested();
    await dies(lost.id, "after_merge_call");
    await pass(lost.id);
    await must(OWNER, "DELETE", `/v1/workspaces/${lost.id}/repository/grants/${lost.grant}`, { policy_version: await version(lost.id) });
    await dies(lost.id, null);
    await pass(lost.id);
    expect(await change(lost.id, lost.task)).toMatchObject({ merge_state: "succeeded", merge_reason: null, merge_sha: MERGED });
    expect(await merges()).toHaveLength(1);
    expect((await events(lost.id)).at(-1)).toMatchObject({ type: "merge.succeeded" });
  });

  /** A second, accepted task of the agent's, with a push grant, to get an agent token with. */
  async function grantPush(id: string) {
    await must(OWNER, "POST", `/v1/workspaces/${id}/repository/grants`, { policy_version: await version(id), principal_id: AGENT.id, action: "push" });
    const made = await must(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "More", instructions: "More code", assignee: AGENT.id });
    await must(AGENT, "POST", `/v1/workspaces/${id}/tasks/${made.id}/accept`, { version: made.version });
    return made.id as string;
  }
});

describe("what GitHub answers to the merge", () => {
  it("counts a merge by what it reads afterwards, not by the call's answer", async () => {
    // The answer is lost, and the merge happened: success, in the same pass, from the read.
    const lost = await requested();
    await fake({ merge: "lost" });
    await pass(lost.id);
    expect(await change(lost.id, lost.task)).toMatchObject({ merge_state: "succeeded", merge_sha: MERGED });
    expect((await merges()).map((c) => c.status)).toEqual([500]);

    // GitHub answers 200, because someone else merged another head a moment before. The read shows a head that isn't the
    // reviewed commit, so this isn't a success, whatever the call said.
    REPO_ID = ++nextRepo;
    await fake({});
    await ready();
    const other = await requested();
    await fake({ merge: "merged_by_other" });
    await pass(other.id);
    expect((await merges()).map((c) => c.status)).toEqual([200]);
    expect(await change(other.id, other.task)).toMatchObject({ merge_state: "failed", merge_reason: "commit_changed", merge_sha: null });
    expect((await change(other.id, other.task)).commit_changed_at).toBeGreaterThan(0);

    // The head moves just before the call lands: 409, and the read agrees.
    REPO_ID = ++nextRepo;
    await fake({});
    await ready();
    const moved = await requested();
    await fake({ merge: "moved" });
    await pass(moved.id);
    expect((await merges()).map((c) => c.status)).toEqual([409]);
    expect(await change(moved.id, moved.task)).toMatchObject({ merge_state: "failed", merge_reason: "commit_changed" });
    expect((await taskRow(moved.id, moved.task)).status).toBe("completed");

    // The rules refuse it: 405, failed with its reason, and it can be asked for again once that's put right.
    REPO_ID = ++nextRepo;
    await fake({});
    await ready();
    const refused = await requested();
    await fake({ merge: "refuse" });
    await pass(refused.id);
    expect(await change(refused.id, refused.task)).toMatchObject({ merge_state: "failed", merge_reason: "provider_refused" });
    await fake({ merge: "ok" });
    expect((await merge(MERGER, refused.id, refused.task)).status).toBe(200);
    await pass(refused.id);
    expect(await change(refused.id, refused.task)).toMatchObject({ merge_state: "succeeded", merge_attempts: 1 });
    expect((await merges()).map((c) => c.status)).toEqual([405, 200]);
  });

  it("reads before every retry: a failed call is made again only after the pull request is seen still open", async () => {
    const r = await requested();
    await fake({ merge: "error" });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "requested", merge_step: "merge", merge_attempts: 1 });
    expect((await merges()).map((c) => c.status)).toEqual([500]);
    // Not before the backoff is over.
    await alarm(r.id, 2);
    expect(await merges()).toHaveLength(1);
    await fake({ merge: "ok" });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "succeeded", merge_attempts: 2 });
    const calls = (await github()).calls.map((c) => `${c.method} ${c.status}`);
    // First pass: read, mark, merge (500), read. Second: read, mark, merge (200), read.
    expect(calls).toEqual(["GET 200", "POST 201", "PUT 500", "GET 200", "GET 200", "POST 201", "PUT 200", "GET 200"]);
  });

  it("waits for the merged state to be readable, and never merges twice while it does", async () => {
    const r = await requested();
    // The pull request reads as merged, and the default branch doesn't show the commit yet.
    await fake({ compare: "ahead" });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "requested", merge_step: "merge" });
    await pass(r.id);
    expect((await change(r.id, r.task)).merge_state).toBe("requested");
    await fake({ compare: undefined, mode: "ok" });
    await fetch("https://github-fake.example.com/agent-repo", { method: "POST", body: JSON.stringify({ id: REPO_ID, compare: "behind" }) });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "succeeded", merge_attempts: 3 });
    expect(await merges()).toHaveLength(1);
  });

  it("waits when GitHub rate-limits the compare with the default branch, and never ends the merge on it", async () => {
    const r = await requested();
    // The merge lands, then the compare that would show the default branch holds it is rate-limited.
    await fake({ compare: { kind: "primary", seconds: 600 } });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "requested", merge_step: "merge" });
    await fake({ compare: "behind" });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "succeeded" });
    expect(await merges()).toHaveLength(1);
  });

  it("gives up after five passes with a reason, and a person asks again", async () => {
    const r = await requested();
    await fake({ status: 500 });
    for (let n = 1; n <= 5; n++) {
      await pass(r.id);
      expect(await change(r.id, r.task), String(n)).toMatchObject({ merge_state: "requested", merge_attempts: n, merge_mark_set_at: null });
    }
    // Each wait is longer than the last.
    expect((await change(r.id, r.task)).merge_next_at).toBeGreaterThan(Date.now() + 60_000);
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "failed", merge_reason: "merge_attempts_exhausted", merge_called_at: null });
    expect(await marks()).toHaveLength(5);
    expect(await merges()).toEqual([]);
    expect((await events(r.id)).at(-1)).toMatchObject({ type: "merge.failed", reason: "merge_attempts_exhausted" });
    await fake({ status: 201 });
    expect((await merge(MERGER, r.id, r.task)).status).toBe(200);
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "succeeded", merge_attempts: 1 });
  });

  it("uses no token that came back wider than asked, and takes it back", async () => {
    const r = await requested();
    for (const mode of ["wide", "extra_permission", "other_repo"]) {
      await fake({ mode });
      await pass(r.id);
      expect((await github()).calls, mode).toEqual([]);
      expect((await minted()).every((token) => !token.live), mode).toBe(true);
      expect((await change(r.id, r.task)).merge_state, mode).toBe("requested");
    }
    // The merge App's key taken away after the merge was asked for: the pass waits, counted, and asks GitHub nothing.
    await fake({ mode: "ok" });
    await inRoom(r.id, (sql) => sql.exec("CREATE TABLE test_no_merge_app (x INTEGER)"));
    const before = (await change(r.id, r.task)).merge_attempts;
    const readsBefore = (await readBack()).reads.length;
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "requested", merge_attempts: before + 1, merge_marked_at: null });
    expect((await github()).calls).toEqual([]);
    expect((await readBack()).reads.length).toBe(readsBefore);
    await inRoom(r.id, (sql) => sql.exec("DROP TABLE test_no_merge_app"));
    // The merge App's token request refused outright: the same, with nothing to take back.
    await fake({ mode: "ok", mergeMint: 403 });
    await pass(r.id);
    expect((await github()).calls).toEqual([]);
    // Five passes are all a request gets. This test has used them, so the count starts over to show the way through.
    expect((await change(r.id, r.task)).merge_attempts).toBe(5);
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET merge_attempts = 0"));
    await fake({ mergeMint: 201 });
    await pass(r.id);
    expect((await change(r.id, r.task)).merge_state).toBe("succeeded");
  });
});

describe("what's kept, logged and shown", () => {
  it("keeps no token and nothing GitHub wrote, anywhere, and logs IDs and codes only (M5-13)", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const r = await requested();
    const answers: string[] = [];
    // A failed mark, a token GitHub won't take back, a lost answer, then success.
    await fake({ status: 500 });
    await pass(r.id);
    await fake({ status: 201, revoke: 500, merge: "error" });
    await pass(r.id);
    await fake({ revoke: 204, merge: "lost" });
    await pass(r.id);
    expect((await change(r.id, r.task)).merge_state).toBe("succeeded");
    answers.push(JSON.stringify(await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`)));
    answers.push(JSON.stringify(await must(OWNER, "GET", `/v1/workspaces/${r.id}/events`)));
    answers.push((await merge(MERGER, r.id, r.task)).text);
    const stored = await inRoom(r.id, (sql) => {
      const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'").toArray().map((t: any) => t.name as string);
      return JSON.stringify(Object.fromEntries(tables.map((table) => [table, sql.exec(`SELECT * FROM ${table}`).toArray()])));
    });
    const d1Tables = (await BINDINGS.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((t: any) => t.name);
    const d1 = JSON.stringify(await Promise.all(d1Tables.filter((t: string) => !t.startsWith("_cf") && !t.startsWith("sqlite")).map((t: string) => BINDINGS.DB.prepare(`SELECT * FROM ${t}`).all())));
    const tokens = (await minted()).map((token) => token.token.slice("ghs_fake_".length));
    expect(tokens.length).toBeGreaterThanOrEqual(8);
    for (const [where, text] of [["room", stored], ["D1", d1], ["answers", answers.join("\n")], ["logs", lines.join("\n")]] as const) {
      expect(text, where).not.toContain("SECRET");
      for (const token of tokens) expect(text, where).not.toContain(token);
    }
    const mine = lines.filter((line) => line.includes('"merge.')).map((line) => JSON.parse(line));
    expect(mine.map((line) => line.event)).toEqual(expect.arrayContaining(["merge.waiting", "merge.token_unrevoked", "merge.succeeded"]));
    for (const line of mine) {
      expect(Object.keys(line).filter((name) => !["event", "ws", "task", "at", "status", "reason", "code"].includes(name))).toEqual([]);
      expect(line.ws).toBe(r.id);
      expect(line.task).toBe(r.task);
    }
  });

  it("shows a merge's events to those shown the change and to whoever asked, and to no other agent", async () => {
    const r = await approved();
    await grant(r.id, ROBOT);
    expect((await merge(ROBOT, r.id, r.task)).status).toBe(200);
    await pass(r.id);
    const seenBy = async (who: Who) => {
      const got = await api(who, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`);
      if (got.status !== 200) return got.status;
      const kinds = (list: any[]) => list.filter((e) => e.type.startsWith("merge.")).map((e) => e.type);
      return { history: kinds(got.body.history), activity: kinds((await must(who, "GET", `/v1/workspaces/${r.id}/activity?task=${r.task}`)).events) };
    };
    const all = ["merge.requested", "merge.succeeded"];
    // The owner, who reviews it; an admin; the assignee; and the agent that asked, for its own request and its outcome.
    for (const who of [OWNER, ADMIN, AGENT, ROBOT]) expect(await seenBy(who), who.id).toEqual({ history: all, activity: all });
    // Another agent that reads the task gets none of it, and a page of its activity isn't left short by what it can't see.
    expect(await seenBy(SIBLING)).toEqual({ history: [], activity: [] });
    const page = (await must(SIBLING, "GET", `/v1/workspaces/${r.id}/activity?task=${r.task}&limit=2`)).events as any[];
    expect(page).toHaveLength(2);
    expect(page.some((e) => e.type.startsWith("merge.") || e.type.startsWith("task_change."))).toBe(false);
    expect(await seenBy(PUBLIC)).toBe(404);
  });
});

describe("with managed repositories switched off again", () => {
  it("shows nobody a managed repository's events, in a task's history or the activity, and leaves no page short", async () => {
    const r = await requested();
    await pass(r.id);
    expect((await change(r.id, r.task)).merge_state).toBe("succeeded");
    // Every managed-repository event, the grant's included (review A6), not only a change's and a merge's.
    const hiddenKind = (e: any) => ["merge.", "task_change.", "repository.", "repo_grant.", "repo_access.", "repo_token."].some((prefix) => e.type.startsWith(prefix));
    /** Every page of the room's activity for a viewer, three at a time, and how long each page was. */
    const pages = async (who: Who) => {
      const all: any[] = [];
      const sizes: number[] = [];
      for (let after: string | undefined; ; ) {
        const page = await must(who, "GET", `/v1/workspaces/${r.id}/activity?limit=3${after ? `&after=${after}` : ""}`);
        sizes.push(page.events.length);
        all.push(...page.events);
        if (!page.next_after) return { all, sizes };
        after = page.next_after;
      }
    };
    // On, the owner sees them, among the room's other events.
    const on = await pages(OWNER);
    const shown = on.all.filter(hiddenKind).length;
    expect(shown).toBeGreaterThanOrEqual(3);
    // Off, nobody does: not the owner, the assignee or whoever asked for the merge.
    await inRoom(r.id, (sql) => sql.exec("DROP TABLE test_managed_repositories_on"));
    for (const who of [OWNER, AGENT, MERGER]) {
      const task = await must(who, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`);
      expect((task.history as any[]).filter(hiddenKind), who.id).toEqual([]);
      expect("change" in task, who.id).toBe(false);
      expect(((await must(who, "GET", `/v1/workspaces/${r.id}/activity?task=${r.task}`)).events as any[]).filter(hiddenKind), who.id).toEqual([]);
    }
    // The owner's pages hold everything else, and every page but the last is full: the hidden rows took no room in any.
    const off = await pages(OWNER);
    expect(off.all.filter(hiddenKind)).toEqual([]);
    expect(off.all.length).toBe(on.all.length - shown);
    expect(off.all.map((e) => e.id)).toEqual(on.all.filter((e) => !hiddenKind(e)).map((e) => e.id));
    expect(off.sizes.slice(0, -1).every((size) => size === 3)).toBe(true);
    // On again, they're back: nothing was removed.
    await inRoom(r.id, (sql) => sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)"));
    expect((await pages(OWNER)).all.filter(hiddenKind)).toHaveLength(shown);
    // And on, a viewer who isn't shown them gets full pages too.
    const other = await pages(SIBLING);
    expect(other.all.filter(hiddenKind)).toEqual([]);
    expect(other.sizes.slice(0, -1).every((size) => size === 3)).toBe(true);
  });
});

describe("the room migration", () => {
  it("migrates a room with a submission approved before it kept reviewers, and refuses its merge until it's reviewed again (A1)", async () => {
    const r = await approved();
    const newest = await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version as number);
    await inRoom(r.id, (sql) => {
      // The newest step, the M5 security review's two columns, comes off first.
      // M6 step 2's release tables, the newest migration, come off first.
      // M6 step 4(a)'s applier and script-delete tables, the newest migration, come off first.
      for (const table of ["serve_apply", "script_delete"]) sql.exec(`DROP TABLE ${table}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
      for (const table of ["release_config", "serve_state", "unpublish", "release", "app_label", "hostname_request"]) sql.exec(`DROP TABLE ${table}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
      for (const [table, column] of [["repo_link", "gone_seen_at"], ["repo_request", "limited_since"], ["repo_request", "limited_call"]]) sql.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
      for (const column of ["reviewer_person", "reviewer_id"]) sql.exec(`ALTER TABLE task_change DROP COLUMN ${column}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    await must(OWNER, "GET", `/v1/workspaces/${r.id}`);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version)).toBe(newest);
    // The approval stays, its reviewer unknown: nothing is guessed, and its merge is refused until it's reviewed again.
    expect(await change(r.id, r.task)).toMatchObject({ reviewed_commit_sha: HEAD, reviewer_id: null, reviewer_person: null });
    expect(await taskRow(r.id, r.task)).toEqual({ status: "completed", approved_submission_no: 1 });
    const got = await merge(MERGER, r.id, r.task);
    expect([got.status, got.code]).toEqual([403, "self_review"]);
    expect(got.body.error.message).toMatch(/needs to be reviewed again/);
  });

  it("adds the merge bookkeeping to a room made before it, and keeps what was there", async () => {
    const r = await approved();
    const newest = await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version as number);
    await inRoom(r.id, (sql) => {
      // The newest step, the M5 security review's two columns, comes off first.
      // M6 step 2's release tables, the newest migration, come off first.
      // M6 step 4(a)'s applier and script-delete tables, the newest migration, come off first.
      for (const table of ["serve_apply", "script_delete"]) sql.exec(`DROP TABLE ${table}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
      for (const table of ["release_config", "serve_state", "unpublish", "release", "app_label", "hostname_request"]) sql.exec(`DROP TABLE ${table}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
      for (const [table, column] of [["repo_link", "gone_seen_at"], ["repo_request", "limited_since"], ["repo_request", "limited_call"]]) sql.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE merge_request");
      // The step after this one, which keeps an approval's reviewer (A1), goes too: a room this old has neither.
      for (const column of ["reviewer_person", "reviewer_id", "merge_finished_at", "merge_called_at", "merge_mark_set_at", "merge_marked_at", "merge_step", "merge_next_at", "merge_attempts", "merge_requester_person", "submitter_person", "submitter_id"]) sql.exec(`ALTER TABLE task_change DROP COLUMN ${column}`);
      sql.exec("UPDATE schema_version SET version = version - 2");
    });
    await must(OWNER, "GET", `/v1/workspaces/${r.id}`);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version)).toBe(newest);
    expect(await change(r.id, r.task)).toMatchObject({ pr_number: 7, reviewed_commit_sha: HEAD, merge_state: "not_requested", merge_attempts: 0, merge_next_at: null, merge_step: null, merge_marked_at: null, merge_called_at: null, submitter_id: null, submitter_person: null });
    // A change from before this step names no submitter, so nobody can be shown not to be them: every request is refused.
    const got = await merge(MERGER, r.id, r.task);
    expect([got.status, got.code]).toEqual([403, "self_merge"]);
  });
});

/** Resolves once a mint for this test's repository is waiting at the fake's gate (`mode: "gate"`). */
const minting = async () => {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; ) {
    const { waiting } = (await (await fetch(`https://github-fake.example.com/agent-gate?repo=${REPO_ID}`)).json()) as { waiting: number };
    if (waiting > 0) return;
    await new Promise((x) => setTimeout(x, 2));
  }
  throw new Error("no mint reached the gate");
};
/** Lets the mint waiting at the gate answer. */
const release = () => fetch("https://github-fake.example.com/agent-release", { method: "POST", body: JSON.stringify({ id: REPO_ID }) });
const OPERATOR: Who = { id: "per_operator_one", kind: "person", org: "org_operators" };
const recheck = (who: Who, id: string) => api(who, "POST", `/v1/moderation/repositories/${id}/recheck`, {});
const fresh = async () => {
  REPO_ID = ++nextRepo;
  await fake({});
  await ready();
};

describe("the review's findings (M5 step 7b)", () => {
  it("waits when a protection can't be read, and never degrades a healthy link over it (M1)", async () => {
    const r = await requested();
    // A server error, a limit and a refusal on each read of the read-back: none is a definite answer.
    for (const script of [{ actionsRead: 500 }, { actionsRead: 429 }, { actionsRead: 403 }, { readRepo: 503 }, { token: 500 }]) {
      await ready({ script });
      await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET merge_attempts = 0"));
      await pass(r.id);
      expect(await link(r.id), JSON.stringify(script)).toEqual({ status: "ready", status_reason: null });
      expect(await change(r.id, r.task), JSON.stringify(script)).toMatchObject({ merge_state: "requested", merge_attempts: 1, merge_marked_at: null });
    }
    expect((await github()).calls).toEqual([]);
    expect(await events(r.id, "repository.")).toEqual([]);
    // Readable again, the merge goes through.
    await ready({ script: {} });
    await pass(r.id);
    expect((await change(r.id, r.task)).merge_state).toBe("succeeded");
  });

  it("degrades the link when GitHub's default branch isn't the link's, and merges nothing into the stored one (M3)", async () => {
    const r = await requested();
    await ready({ defaultBranch: "trunk" });
    await pass(r.id);
    expect(await link(r.id)).toEqual({ status: "degraded", status_reason: "default_branch_changed" });
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "failed", merge_reason: "default_branch_changed", merge_marked_at: null });
    expect((await github()).calls).toEqual([]);
    expect(await events(r.id, "repository.")).toEqual([{ type: "repository.degraded", actor_id: "system", subject_id: null, task_id: null, reason: "default_branch_changed" }]);
    // The merge App is told another default than the provisioning App: caught at its own read, before the mark.
    await fresh();
    const seen = await requested();
    await fake({ defaultBranch: "trunk" });
    await pass(seen.id);
    expect(await link(seen.id)).toEqual({ status: "degraded", status_reason: "default_branch_changed" });
    expect(await change(seen.id, seen.task)).toMatchObject({ merge_state: "failed", merge_reason: "default_branch_changed", merge_marked_at: null });
    // It read, and wrote nothing.
    expect((await github()).calls.filter((c) => c.method !== "GET")).toEqual([]);
    // Changed after the mark, while the merge's token is on its way: the call isn't made, into either branch.
    await fresh();
    const late = await requested();
    await fake({ mode: "gate" });
    const running = pass(late.id);
    await minting();
    await release();
    await minting();
    await release();
    await minting();
    await fake({ mode: "ok", defaultBranch: "trunk" });
    await release();
    await running;
    expect(await change(late.id, late.task)).toMatchObject({ merge_state: "failed", merge_reason: "default_branch_changed" });
    expect(await link(late.id)).toEqual({ status: "degraded", status_reason: "default_branch_changed" });
    expect(await merges()).toEqual([]);
    expect((await github()).pulls["7"].merged ?? false).toBe(false);
    // Changed a moment after the merge landed: the merge is recorded as the merge it was, and the link is degraded.
    await fresh();
    const landed = await requested();
    await fake({ merge: "default_moves" });
    await pass(landed.id);
    expect(await change(landed.id, landed.task)).toMatchObject({ merge_state: "succeeded", merge_reason: null, merge_sha: MERGED });
    expect(await link(landed.id)).toEqual({ status: "degraded", status_reason: "default_branch_changed" });
    expect(await merges()).toHaveLength(1);
    expect((await events(landed.id)).at(-1)).toMatchObject({ type: "merge.succeeded" });
    // A default branch with a slash in its name is read and merged into like any other.
    await fresh();
    await ready({ defaultBranch: "release/v1" });
    await fake({ defaultBranch: "release/v1" });
    const slashed = await room();
    await inRoom(slashed, (sql) => sql.exec("UPDATE repo_link SET default_branch = 'release/v1'"));
    await pull(7, { base_ref: "release/v1" });
    const task = await submitted(slashed);
    await must(OWNER, "POST", `/v1/workspaces/${slashed}/tasks/${task}/verify`, { submission_no: 1, commit_sha: HEAD });
    await grant(slashed, MERGER);
    await hold(slashed);
    expect((await merge(MERGER, slashed, task)).status).toBe(200);
    await pass(slashed);
    expect(await change(slashed, task)).toMatchObject({ merge_state: "succeeded", merge_sha: MERGED });
    expect((await github()).calls.filter((c) => c.method === "GET").every((c) => c.path === `/repositories/${REPO_ID}/compare/release/v1...${HEAD}`)).toBe(true);
  });

  it("puts a degraded link back to ready only on an operator's recheck that reads it exactly right (M1b)", async () => {
    const r = await requested();
    await ready({ rulesets: "extra_bypass" });
    await pass(r.id);
    expect(await link(r.id)).toEqual({ status: "degraded", status_reason: "bypass_differs" });
    // Nothing recovers by itself, however often the alarm runs, even once the repository is right again.
    await ready({ rulesets: "ready" });
    await alarm(r.id, 3);
    expect((await link(r.id)).status).toBe("degraded");
    // Only an operator may ask: not the room's owner, an admin, an agent or someone outside.
    for (const who of [OWNER, ADMIN, MERGER, AGENT]) {
      const got = await recheck(who, r.id);
      expect([got.status, got.code], who.id).toEqual([403, "not_allowed"]);
    }
    // Still wrong: it stays degraded, with what differs now.
    await ready({ actionsEnabled: true });
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "degraded", reason: "actions_enabled" });
    expect(await link(r.id)).toEqual({ status: "degraded", status_reason: "actions_enabled" });
    // No definite answer changes nothing.
    await ready({ actionsEnabled: false, script: { readRepo: 500 } });
    const down = await recheck(OPERATOR, r.id);
    expect([down.status, down.code]).toEqual([502, "provider_unavailable"]);
    expect((await link(r.id)).status).toBe("degraded");
    // Exactly right: ready again, said once, and recorded as the operator's action.
    await ready({ script: {} });
    const fixed = await api(OPERATOR, "POST", `/v1/moderation/repositories/${r.id}/recheck`, {}, { key: "mt-recheck" });
    expect(fixed.body).toEqual({ status: "ready", reason: null });
    expect(await link(r.id)).toEqual({ status: "ready", status_reason: null });
    // The same key answers the same, from the record, with no second read. A new one finds nothing to recheck.
    const readsBefore = (await readBack()).reads.length;
    expect((await api(OPERATOR, "POST", `/v1/moderation/repositories/${r.id}/recheck`, {}, { key: "mt-recheck" })).body).toEqual(fixed.body);
    expect((await readBack()).reads.length).toBe(readsBefore);
    // A new one reads the ready link again, finds it right, and changes nothing.
    expect((await recheck(OPERATOR, r.id)).body).toEqual({ status: "ready", reason: null });
    expect((await readBack()).reads.length).toBeGreaterThan(readsBefore);
    expect((await events(r.id, "repository.")).map((e) => [e.type, e.reason])).toEqual([["repository.degraded", "bypass_differs"], ["repository.ready_again", null]]);
    expect((await readBack()).live).toBe(0);
    // And a merge can be asked for again.
    expect((await merge(MERGER, r.id, r.task)).status).toBe(200);
    // With managed repositories off, there's no such thing to recheck: for anyone, with a key or without, before who is
    // asking or the room is looked at, exactly as a route that doesn't exist answers (review A5).
    await inRoom(r.id, (sql) => sql.exec("DROP TABLE test_managed_repositories_on"));
    const raw = async (who: Who, path: string, key: string | null) => {
      const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json" };
      if (key) headers["idempotency-key"] = key;
      const res = await SELF.fetch(`https://api.internal${path}`, { method: "POST", headers, body: "{}" });
      return [res.status, await res.text()];
    };
    for (const who of [OPERATOR, OWNER, AGENT]) {
      for (const key of [null, "mt-recheck-off"]) {
        for (const room of [r.id, "ws_nowhere"]) {
          const label = `${who.id} ${key} ${room}`;
          const got = await raw(who, `/v1/moderation/repositories/${room}/recheck`, key);
          expect(got, label).toEqual(await raw(who, `/v1/moderation/repositories/${room}/no-such-route`, key));
          expect(got[0], label).toBe(404);
        }
      }
    }
  });

  it("counts every request through the command itself: ten for a task in its whole life, twenty an hour for the room (M2)", async () => {
    const r = await approved();
    await fake({ merge: "refuse" });
    const asked = async (task: string) => {
      const got = await merge(MERGER, r.id, task);
      if (got.status === 200) await pass(r.id);
      return [got.status, got.code ?? "ok"];
    };
    // Ten requests for one task, each failing. Asking again never starts the count over, and no wait lifts it.
    for (let n = 1; n <= 10; n++) expect(await asked(r.task), String(n)).toEqual([200, "ok"]);
    expect(await asked(r.task)).toEqual([429, "merge_request_limit"]);
    await inRoom(r.id, (sql) => sql.exec("UPDATE merge_request SET at = at - 7200001"));
    expect(await asked(r.task)).toEqual([429, "merge_request_limit"]);
    expect(await merges()).toHaveLength(10);
    // Twenty an hour for the room, whichever tasks they're for: two more tasks at ten each, and one more request.
    const others: string[] = [];
    for (const number of [20, 21, 22]) {
      await pull(number);
      const task = await submitted(r.id, number);
      await must(OWNER, "POST", `/v1/workspaces/${r.id}/tasks/${task}/verify`, { submission_no: 1, commit_sha: HEAD });
      others.push(task);
    }
    for (const task of others.slice(0, 2)) for (let n = 1; n <= 10; n++) expect(await asked(task), `${task} ${n}`).toEqual([200, "ok"]);
    expect(await asked(others[2])).toEqual([429, "rate_limited"]);
    // An hour on, the room takes requests again, and the first task still doesn't.
    await inRoom(r.id, (sql) => sql.exec("UPDATE merge_request SET at = at - 3600001"));
    expect(await asked(others[2])).toEqual([200, "ok"]);
    expect(await asked(r.task)).toEqual([429, "merge_request_limit"]);
    // A refused request records nothing and counts for nothing.
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT count(*) AS n FROM merge_request").one().n)).toBe(31);
    expect((await events(r.id)).filter((e) => e.type === "merge.requested")).toHaveLength(31);
  });

  it("honours authority that ends while GitHub is answering: before the mark, and between the mark and the merge (M4)", async () => {
    const ways = [
      ["grant revoked", async (r: any) => void (await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) })), "grant_required"],
      ["requester removed", async (r: any) => void (await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/members/${MERGER.id}`, { policy_version: await version(r.id) })), "access_revoked"],
      ["room archived", async (r: any) => void (await must(OWNER, "POST", `/v1/workspaces/${r.id}/archive`, { policy_version: await version(r.id) })), "workspace_archived"],
      ["room suspended", (r: any) => inRoom(r.id, (sql) => void sql.exec("UPDATE workspace SET suspended_at = 5, suspension_reason = 'test'")), "room_suspended"],
      ["requester's access narrowed", (r: any) => inRoom(r.id, (sql) => void sql.exec("UPDATE access_grant SET tasks = 'own' WHERE principal_id = ?", MERGER.id)), "task_not_found"],
      ["requester now there through a public claim", (r: any) => inRoom(r.id, (sql) => void sql.exec("UPDATE member SET joined_via = 'public', role = 'guest' WHERE principal_id = ?", MERGER.id)), "public_participant"],
      // The room's record of the approving review turns out not to be independent (A1, decision 195).
      ["review not independent", (r: any) => inRoom(r.id, (sql) => void sql.exec("UPDATE task_change SET reviewer_person = ?", LINKER.id)), "self_review"],
    ] as const;
    for (const [what, lose, reason] of ways) {
      for (const point of ["before the mark", "between the mark and the merge"] as const) {
        await fresh();
        const r = await requested();
        // The merge App's token requests wait at a gate: the read's first, then the mark's, then the merge's.
        await fake({ mode: "gate" });
        const running = pass(r.id);
        await minting();
        if (point === "between the mark and the merge") {
          // Let the read go. The mark's intent is recorded, and its token request now waits.
          await release();
          await minting();
        }
        await lose(r);
        await fake({ mode: "ok" });
        await release();
        await running;
        const label = `${what}, ${point}`;
        expect(await change(r.id, r.task), label).toMatchObject({ merge_state: "failed", merge_reason: reason, merge_called_at: null });
        expect(await merges(), label).toEqual([]);
        // Before the mark nothing was set. After it, the status is on the commit and nothing was merged with it.
        expect((await github()).statuses.length, label).toBe(point === "before the mark" ? 0 : 1);
        expect((await github()).pulls["7"].merged ?? false, label).toBe(false);
        expect((await minted()).every((token) => !token.live), label).toBe(true);
      }
    }
  });

  it("reads GitHub before ending a merge whose call went out, whatever ends it, and records what the call did (M5)", async () => {
    const dieAfterCall = async () => {
      await fresh();
      const r = await requested();
      await dies(r.id, "after_merge_call");
      await pass(r.id);
      await dies(r.id, null);
      return r;
    };
    // The call merged, and then: the grant goes, the room is archived, the repository's rules change.
    for (const [what, then] of [
      ["grant revoked", async (r: any) => void (await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) }))],
      ["room archived", async (r: any) => void (await must(OWNER, "POST", `/v1/workspaces/${r.id}/archive`, { policy_version: await version(r.id) }))],
      ["rules changed", async () => void (await ready({ rulesets: "no_update" }))],
    ] as const) {
      const r = await dieAfterCall();
      await then(r);
      await pass(r.id);
      expect(await change(r.id, r.task), what).toMatchObject({ merge_state: "succeeded", merge_reason: null, merge_sha: MERGED });
      expect(await merges(), what).toHaveLength(1);
      if (what === "rules changed") expect(await link(r.id)).toEqual({ status: "degraded", status_reason: "ruleset_missing" });
    }
    // The intent to call was recorded and the call never went out: the read shows it open, so it ends as it would have.
    await fresh();
    const r = await requested();
    await dies(r.id, "before_merge_call");
    await pass(r.id);
    expect((await change(r.id, r.task)).merge_called_at).toBeGreaterThan(0);
    await dies(r.id, null);
    await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "failed", merge_reason: "grant_required", merge_sha: null });
    expect(await merges()).toEqual([]);
    // Out of passes after a call, and GitHub can't be read: that isn't exhaustion and isn't failure. The outcome is
    // recorded as unknown, said once, and the job goes on reading until it knows.
    const spent = await dieAfterCall();
    await inRoom(spent.id, (sql) => sql.exec("UPDATE task_change SET merge_attempts = 5"));
    await fake({ mergeMint: 500 });
    await pass(spent.id);
    expect(await change(spent.id, spent.task)).toMatchObject({ merge_state: "outcome_unknown", merge_reason: "merge_attempts_exhausted", merge_finished_at: null });
    expect((await change(spent.id, spent.task)).merge_next_at).toBeGreaterThan(Date.now() + 10 * 60_000);
    await pass(spent.id);
    await pass(spent.id);
    expect((await change(spent.id, spent.task)).merge_state).toBe("outcome_unknown");
    expect((await events(spent.id)).filter((e) => e.type === "merge.outcome_unknown")).toEqual([{ type: "merge.outcome_unknown", actor_id: "system", subject_id: MERGER.id, task_id: spent.task, reason: null }]);
    // It can't be asked for again while nobody knows what the first call did.
    const again = await merge(MERGER, spent.id, spent.task);
    expect([again.status, again.code]).toEqual([409, "merge_already_requested"]);
    expect((await must(OWNER, "GET", `/v1/workspaces/${spent.id}/tasks/${spent.task}`)).change.merge_state).toBe("outcome_unknown");
    // Readable again: the merge the call made is recorded, with no second call.
    await fake({ mergeMint: 201 });
    await pass(spent.id);
    expect(await change(spent.id, spent.task)).toMatchObject({ merge_state: "succeeded", merge_reason: null, merge_sha: MERGED });
    expect(await merges()).toHaveLength(1);
    // And one whose call didn't merge, read at last, ends with the reason it was about to end with.
    await fresh();
    const open = await requested();
    await dies(open.id, "before_merge_call");
    await pass(open.id);
    await dies(open.id, null);
    await must(OWNER, "DELETE", `/v1/workspaces/${open.id}/repository/grants/${open.grant}`, { policy_version: await version(open.id) });
    await fake({ mergeMint: 500 });
    await pass(open.id);
    expect(await change(open.id, open.task)).toMatchObject({ merge_state: "outcome_unknown", merge_reason: "grant_required" });
    await fake({ mergeMint: 201 });
    await pass(open.id);
    expect(await change(open.id, open.task)).toMatchObject({ merge_state: "failed", merge_reason: "grant_required", merge_sha: null });
  });

  it("records a landed merge only once the default branch has been read, and waits until then", async () => {
    const r = await requested();
    // The merge lands, and the read that follows can't say what the default branch is.
    await fake({ merge: "default_unreadable" });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "requested", merge_step: "merge", merge_sha: null });
    expect(await merges()).toHaveLength(1);
    // Still unreadable: still not recorded, and no second merge call.
    await pass(r.id);
    expect((await change(r.id, r.task)).merge_state).toBe("requested");
    expect(await merges()).toHaveLength(1);
    // Readable, and the same branch: recorded as the merge it was.
    await fake({ merge: "ok", describe: 200 });
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "succeeded", merge_sha: MERGED });
    expect(await link(r.id)).toEqual({ status: "ready", status_reason: null });
    expect(await merges()).toHaveLength(1);
  });

  it("stops reading for an unknown outcome after twelve tries, waiting longer each time, and at once in a room that's closed", async () => {
    const unknown = async () => {
      await fresh();
      const r = await requested();
      await dies(r.id, "after_merge_call");
      await pass(r.id);
      await dies(r.id, null);
      await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) });
      await fake({ mergeMint: 500 });
      await pass(r.id);
      expect(await change(r.id, r.task)).toMatchObject({ merge_state: "outcome_unknown", merge_attempts: 0, merge_step: "outcome_unknown" });
      return r;
    };
    const r = await unknown();
    const waits: number[] = [];
    for (let n = 1; n <= 11; n++) {
      const before = Date.now();
      await pass(r.id);
      const row = await change(r.id, r.task);
      expect(row, String(n)).toMatchObject({ merge_state: "outcome_unknown", merge_attempts: n, merge_step: "outcome_unknown" });
      waits.push(Math.round((row.merge_next_at - before) / 60_000));
    }
    // Thirty minutes, an hour, two, four, and then six hours each time.
    expect(waits).toEqual([30, 60, 120, 240, 360, 360, 360, 360, 360, 360, 360]);
    // The twelfth try is the last: no next read, said once, and the outcome still isn't claimed either way.
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "outcome_unknown", merge_step: "outcome_unknown_final", merge_next_at: null, merge_finished_at: null });
    const tokens = (await minted()).length;
    await alarm(r.id, 3);
    expect((await minted()).length).toBe(tokens);
    expect((await events(r.id)).filter((e) => e.type === "merge.outcome_unknown_final")).toEqual([{ type: "merge.outcome_unknown_final", actor_id: "system", subject_id: MERGER.id, task_id: r.task, reason: null }]);
    // A person asking again begins with a read, and with GitHub readable the merge the first call made is recorded.
    await fake({ mergeMint: 201 });
    await grant(r.id, MERGER);
    expect((await merge(MERGER, r.id, r.task)).status).toBe(200);
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "succeeded", merge_sha: MERGED });
    expect(await merges()).toHaveLength(1);
    // In a room archived, or suspended, after the outcome became unknown: the job stops at once, and asks GitHub nothing.
    for (const close of [
      async (room: any) => void (await must(OWNER, "POST", `/v1/workspaces/${room.id}/archive`, { policy_version: await version(room.id) })),
      (room: any) => inRoom(room.id, (sql) => void sql.exec("UPDATE workspace SET suspended_at = 5, suspension_reason = 'test'")),
    ]) {
      const closed = await unknown();
      await close(closed);
      await fake({ mergeMint: 201 });
      const before = (await minted()).length;
      await pass(closed.id);
      expect(await change(closed.id, closed.task)).toMatchObject({ merge_state: "outcome_unknown", merge_step: "outcome_unknown_final", merge_next_at: null });
      expect((await minted()).length).toBe(before);
    }
  });

  it("asks the owner's standing again before the mark and before the merge, not once a pass", async () => {
    // The owner leaves the organization while GitHub is answering, and the room hasn't been told: the grant they gave
    // counts for nothing by the time the next intent is recorded. Rooms made after this aren't reached by it.
    for (const point of ["before the mark", "between the mark and the merge"] as const) {
      await fresh();
      const r = await requested();
      await fake({ mode: "gate" });
      const running = pass(r.id);
      await minting();
      if (point === "between the mark and the merge") {
        await release();
        await minting();
      }
      await must(OWNER, "POST", "/v1/org-departures", {}, { claims: { departure: { person: OWNER.id, org: ORG, left_at: Date.now() } } });
      await inRoom(r.id, (sql) => void sql.exec("UPDATE workspace SET owner_left_at = NULL"));
      await fake({ mode: "ok" });
      await release();
      await running;
      expect(await change(r.id, r.task), point).toMatchObject({ merge_state: "failed", merge_reason: "grant_stale", merge_called_at: null });
      expect(await merges(), point).toEqual([]);
      expect((await github()).statuses.length, point).toBe(point === "before the mark" ? 0 : 1);
    }
  });

  it("ends a merge whose call went out by the same decision as the pass that made it: no success without the default branch, and a changed one degrades", async () => {
    const lostAfterCall = async () => {
      await fresh();
      const r = await requested();
      await dies(r.id, "after_merge_call");
      await pass(r.id);
      await dies(r.id, null);
      await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) });
      return r;
    };
    // The merge landed, authority has gone, and the read can't say what the default branch is: not a success yet.
    const unread = await lostAfterCall();
    await fake({ describe: 503 });
    await pass(unread.id);
    expect(await change(unread.id, unread.task)).toMatchObject({ merge_state: "outcome_unknown", merge_reason: "grant_required", merge_sha: null });
    await fake({ describe: 200 });
    await pass(unread.id);
    expect(await change(unread.id, unread.task)).toMatchObject({ merge_state: "succeeded", merge_sha: MERGED });
    expect(await link(unread.id)).toEqual({ status: "ready", status_reason: null });
    // The default branch was changed after the merge landed: recorded as the merge it was, and the link is degraded.
    const changed = await lostAfterCall();
    await fake({ defaultBranch: "trunk" });
    await pass(changed.id);
    expect(await change(changed.id, changed.task)).toMatchObject({ merge_state: "succeeded", merge_sha: MERGED });
    expect(await link(changed.id)).toEqual({ status: "degraded", status_reason: "default_branch_changed" });
    expect(await merges()).toHaveLength(1);
  });

  it("lets the ordinary watch settle a merge the job stopped reading for, with no merge call and no token of the merge App's", async () => {
    /** A merge whose outcome the job stopped reading for, with the merge call made (and merged) or only recorded. */
    const finalUnknown = async (at: "after_merge_call" | "before_merge_call") => {
      await fresh();
      const r = await requested();
      await dies(r.id, at);
      await pass(r.id);
      await dies(r.id, null);
      await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) });
      await fake({ mergeMint: 500 });
      await pass(r.id);
      await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET merge_attempts = 11"));
      await pass(r.id);
      expect(await change(r.id, r.task)).toMatchObject({ merge_state: "outcome_unknown", merge_step: "outcome_unknown_final", merge_next_at: null });
      return r;
    };
    /** The change's own watch reads the pull request, as a delivery about it would make it. */
    const watch = async (id: string) => {
      await inRoom(id, (sql) => void sql.exec("UPDATE task_change SET nudged_at = ?, read_at = 1, read_failures = 0", Date.now() + 1));
      await alarm(id);
    };
    const mergeTokens = async () => (await minted()).filter((t) => t.permissions.statuses === "write" || t.permissions.contents).length;
    // The call had merged the reviewed commit: the watch's read of the pull request says so, and that's this request's success.
    const merged = await finalUnknown("after_merge_call");
    const before = await mergeTokens();
    await watch(merged.id);
    expect(await change(merged.id, merged.task)).toMatchObject({ merge_state: "succeeded", merge_reason: null, merge_sha: MERGED, pr_state: "merged" });
    expect((await events(merged.id)).at(-1)).toMatchObject({ type: "merge.succeeded", subject_id: MERGER.id });
    expect(await merges()).toHaveLength(1);
    expect(await mergeTokens()).toBe(before);
    // The call never went out, and the pull request is closed unmerged: failed, with the reason it was about to end with.
    const closed = await finalUnknown("before_merge_call");
    await watch(closed.id);
    expect((await change(closed.id, closed.task)).merge_state).toBe("outcome_unknown");
    await pull(7, { state: "closed" });
    await watch(closed.id);
    expect(await change(closed.id, closed.task)).toMatchObject({ merge_state: "failed", merge_reason: "grant_required", merge_sha: null });
    expect(await merges()).toEqual([]);
    // Merged by someone at another commit: not the reviewed commit, so not this request's success. The request is
    // failed, and what the watch saw is recorded as what it is: a merge of a commit nobody reviewed.
    const other = await finalUnknown("before_merge_call");
    await pull(7, { head_sha: HEAD2, merged: true, merge_commit_sha: "8d".repeat(20), merged_by: 31337 });
    await watch(other.id);
    expect(await change(other.id, other.task)).toMatchObject({ merge_state: "failed", merge_reason: "unreviewed_merge", merged_by_id: 31337 });
    expect((await change(other.id, other.task)).merge_observed_at).toBeGreaterThan(0);
    expect((await events(other.id)).map((e) => e.type).slice(-1)).toEqual(["merge.failed"]);
  });

  it("lets the watch settle an unknown outcome while the job is still counting its reads, and the job then finds it settled", async () => {
    /** A merge whose call went out and merged, whose outcome is unknown, with the job still reading for it. */
    const counting = async () => {
      await fresh();
      const r = await requested();
      await dies(r.id, "after_merge_call");
      await pass(r.id);
      await dies(r.id, null);
      await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) });
      await fake({ mergeMint: 500 });
      await pass(r.id);
      expect(await change(r.id, r.task)).toMatchObject({ merge_state: "outcome_unknown", merge_step: "outcome_unknown", merge_attempts: 0 });
      expect((await change(r.id, r.task)).merge_next_at).toBeGreaterThan(Date.now());
      return r;
    };
    const watch = async (id: string) => {
      await inRoom(id, (sql) => void sql.exec("UPDATE task_change SET nudged_at = ?, read_at = 1, read_failures = 0", Date.now() + 1));
      await alarm(id);
    };
    // The watch reads first, sees the pull request merged with the reviewed commit, and settles it in that same step.
    const r = await counting();
    await watch(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "succeeded", merge_reason: null, merge_sha: MERGED, pr_state: "merged", merge_next_at: null });
    // The job's own read, when its time comes, finds it settled: no second outcome, no call, nothing changed.
    await fake({ mergeMint: 201 });
    const tokens = (await minted()).length;
    await pass(r.id);
    await alarm(r.id, 2);
    expect((await minted()).length).toBe(tokens);
    expect((await events(r.id)).filter((e) => e.type === "merge.succeeded")).toHaveLength(1);
    expect(await merges()).toHaveLength(1);
    // GitHub's default branch isn't the link's any more: the watch records no merge into a branch that isn't the
    // default, degrades the link, and leaves the outcome for the job's fuller read.
    const renamed = await counting();
    await fake({ defaultBranch: "trunk" });
    await watch(renamed.id);
    expect((await change(renamed.id, renamed.task)).merge_state).toBe("outcome_unknown");
    expect(await link(renamed.id)).toEqual({ status: "degraded", status_reason: "default_branch_changed" });
    // The job's read then decides as the pass that made the call would: the merge it was, on a degraded link.
    await fake({ mergeMint: 201 });
    await pass(renamed.id);
    expect(await change(renamed.id, renamed.task)).toMatchObject({ merge_state: "succeeded", merge_sha: MERGED });
    expect(await link(renamed.id)).toEqual({ status: "degraded", status_reason: "default_branch_changed" });
  });

  it("keeps an earlier pass's call on record when a later pass can't get a token to call with (L6)", async () => {
    const r = await requested();
    // A first call that GitHub answered 500 to, and didn't merge: it's on record.
    await fake({ merge: "error" });
    await pass(r.id);
    const called = (await change(r.id, r.task)).merge_called_at;
    expect(called).toBeGreaterThan(0);
    // The next pass reads and marks, and then can't get the token for its merge call.
    await fake({ merge: "ok", mode: "gate" });
    const running = pass(r.id);
    await minting();
    await release();
    await minting();
    await release();
    await minting();
    await fake({ mode: "ok", mergeMint: 500 });
    await release();
    await running;
    const kept = await change(r.id, r.task);
    expect({ state: kept.merge_state, reason: kept.merge_reason, step: kept.merge_step, called: kept.merge_called_at }).toEqual({ state: "requested", reason: null, step: "merge", called: expect.any(Number) });
    expect(kept.merge_called_at).toBeGreaterThanOrEqual(called);
    expect(await merges()).toHaveLength(1);
    // And a pass with no call before it does take its own back, so a merge seen later isn't taken for it.
    await fresh();
    const first = await requested();
    await fake({ mode: "gate" });
    const again = pass(first.id);
    await minting();
    await release();
    await minting();
    await release();
    await minting();
    await fake({ mode: "ok", mergeMint: 500 });
    await release();
    await again;
    expect(await change(first.id, first.task)).toMatchObject({ merge_state: "requested", merge_called_at: null, merge_step: "marked" });
  });
});

describe("a room admin's grant (the owner's decision of 2026-11-11: owner and admins)", () => {
  /** An approved task whose merge grant `MERGER` holds from the room's admin, not its owner. */
  const grantedByAdmin = async () => {
    await fresh();
    const r = await approved();
    // Giving it again replaces the owner's row with the admin's own.
    const given = await must(ADMIN, "POST", `/v1/workspaces/${r.id}/repository/grants`, { policy_version: await version(r.id), principal_id: MERGER.id, action: "merge" });
    expect(given.delegated_by).toBe(ADMIN.id);
    return { ...r, grant: given.id as string };
  };

  it("merges the reviewed commit under an admin's grant, exactly as under the owner's", async () => {
    const r = await grantedByAdmin();
    expect((await merge(MERGER, r.id, r.task)).status).toBe(200);
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "succeeded", merge_sha: MERGED, merge_requested_by: MERGER.id });
    expect(await merges()).toHaveLength(1);
  });

  it("never lets an admin merge their own agent's work, or have another of their agents do it, by granting it themselves (M5-10)", async () => {
    await fresh();
    const r = await approved();
    // The person who controls the submitting agent is made an admin, and gives themselves and their other agent the grant.
    await inRoom(r.id, (sql) => void sql.exec("UPDATE member SET role = 'admin' WHERE principal_id = ?", LINKER.id));
    for (const who of [LINKER, SIBLING, AGENT]) {
      const given = await must(LINKER, "POST", `/v1/workspaces/${r.id}/repository/grants`, { policy_version: await version(r.id), principal_id: who.id, action: "merge" });
      expect([given.delegated_by, given.state], who.id).toEqual([LINKER.id, "live"]);
      const got = await merge(who, r.id, r.task);
      expect([got.status, got.code], who.id).toEqual([403, "self_merge"]);
    }
    expect((await change(r.id, r.task)).merge_state).toBe("not_requested");
    expect((await github()).calls).toEqual([]);
  });

  it("ends the merge, marking nothing, when the admin who gave the grant is no longer one by the time the job runs", async () => {
    for (const [what, lose, reason] of [
      // The role changed underneath, with nothing run to end the grant: the job decides from the room's own rows.
      ["demoted underneath", (r: any) => inRoom(r.id, (sql) => void sql.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", ADMIN.id)), "grant_stale"],
      // Demoted by the owner: the grant ends in that same change.
      ["demoted", async (r: any) => void (await must(OWNER, "POST", `/v1/workspaces/${r.id}/members/${ADMIN.id}/role`, { role: "member", policy_version: await version(r.id) }, { claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } })), "grant_required"],
      ["removed", async (r: any) => void (await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/members/${ADMIN.id}`, { policy_version: await version(r.id) })), "grant_required"],
    ] as const) {
      const r = await grantedByAdmin();
      expect((await merge(MERGER, r.id, r.task)).status, what).toBe(200);
      await lose(r);
      await pass(r.id);
      expect(await change(r.id, r.task), what).toMatchObject({ merge_state: "failed", merge_reason: reason, merge_marked_at: null, merge_called_at: null });
      expect((await github()).calls, what).toEqual([]);
    }
    // Refused when asked for, too, once the giver is no longer an admin.
    const r = await grantedByAdmin();
    await inRoom(r.id, (sql) => void sql.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", ADMIN.id));
    const got = await merge(MERGER, r.id, r.task);
    expect([got.status, got.code]).toEqual([403, "grant_stale"]);
  });

  it("ends the merge when the admin who gave the grant left the organization and the room hasn't heard, at the request and in the job", async () => {
    /** An approved task whose merge grant a newly added admin gave, who then leaves their organization unheard by the room. */
    const givenThenLeft = async (requestFirst: boolean) => {
      await fresh();
      const r = await approved();
      const admin: Who = { id: `per_mt_leaver_${nextRepo}`, kind: "person", org: ORG };
      await must(OWNER, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: admin.id, kind: "person", org_id: ORG, role: "admin", policy_version: await version(r.id) }, { claims: { target_member: { person: admin.id, orgs: { [ORG]: 1 } } } });
      const given = await must(admin, "POST", `/v1/workspaces/${r.id}/repository/grants`, { policy_version: await version(r.id), principal_id: MERGER.id, action: "merge" });
      expect(given.delegated_by).toBe(admin.id);
      if (requestFirst) expect((await merge(MERGER, r.id, r.task)).status).toBe(200);
      // The listing is emptied first, so the departure can't find the room: its rows still say admin, and live.
      await alarmQuiet(stub(r.id));
      await BINDINGS.DB.prepare("DELETE FROM membership_index WHERE principal_id = ?").bind(admin.id).run();
      await must(admin, "POST", "/v1/org-departures", {}, { claims: { departure: { person: admin.id, org: ORG, left_at: Date.now() } } });
      expect((await api(OWNER, "GET", `/v1/workspaces/${r.id}/repository/grants`)).body.grants.find((g: any) => g.id === given.id)?.state).toBe("live");
      return r;
    };
    // Asked for after they left: refused, from their own record.
    const late = await givenThenLeft(false);
    const got = await merge(MERGER, late.id, late.task);
    expect([got.status, got.code]).toEqual([403, "grant_stale"]);
    expect((await change(late.id, late.task)).merge_state).toBe("not_requested");
    // Asked for before they left: the job asks again, and ends the merge with nothing marked or called.
    const r = await givenThenLeft(true);
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "failed", merge_reason: "grant_stale", merge_marked_at: null, merge_called_at: null });
    expect((await github()).calls).toEqual([]);
    expect(await merges()).toEqual([]);
  });

  it("waits, counted, when the admin's record can't be read, and merges nothing on an unknown", async () => {
    await fresh();
    const r = await approved();
    const admin: Who = { id: `per_unavailable_mt_admin_${nextRepo}`, kind: "person", org: ORG };
    await must(OWNER, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: admin.id, kind: "person", org_id: ORG, role: "admin", policy_version: await version(r.id) }, { claims: { target_member: { person: admin.id, orgs: { [ORG]: 1 } } } });
    await must(admin, "POST", `/v1/workspaces/${r.id}/repository/grants`, { policy_version: await version(r.id), principal_id: MERGER.id, action: "merge" });
    const got = await merge(MERGER, r.id, r.task);
    expect([got.status, got.code]).toEqual([503, "standing_unknown"]);
    // A request already on record waits, with the pass counted.
    await inRoom(r.id, (sql) => void sql.exec("UPDATE task_change SET merge_state = 'requested', merge_requested_by = ?, merge_requester_person = ?, merge_step = 'requested'", MERGER.id, MERGER.id));
    await pass(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "requested", merge_attempts: 1, merge_marked_at: null, merge_called_at: null });
    expect((await github()).calls).toEqual([]);
  });
});
