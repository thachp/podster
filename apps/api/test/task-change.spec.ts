import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { alarmPass, alarmQuiet } from "./alarm.ts";

// M5 step 7a: a task's pull request. Linking it at submission, pinning the commit at review, and recording what Podster's
// own reads of GitHub show, against the fake GitHub. A room's link is written straight into the room, as step 6's tests
// do, because a test can't provision one. Tasks are made through the API, so which tasks are linked is the room's own
// decision. Nothing here reaches GitHub.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const ORG = "org_tc";
const OWNER: Who = { id: "per_tc_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const ADMIN: Who = { id: "per_tc_admin", kind: "person", org: ORG };
const AGENT: Who = { id: "agt_tc_agent", org: ORG };
const OTHER: Who = { id: "agt_tc_other", org: ORG };
const PUBLIC: Who = { id: "agt_tc_public", org: ORG };
const OUTSIDER: Who = { id: "agt_tc_outsider", org: ORG };
const GUEST: Who = { id: "per_tc_guest", kind: "person", org: ORG };
const orgAdmin: Who = { id: "per_tc_orgadmin", kind: "person", org: ORG, adminOrgs: [ORG] };
/** Each test's own repository, so the fake's state for it is the test's alone while other specs run beside it. */
let REPO_ID = 0;
let nextRepo = 9_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
const READ_ONLY = { metadata: "read", pull_requests: "read" };
const HEAD = "a1".repeat(20);
const HEAD2 = "c3".repeat(20);
const BASE = "b2".repeat(20);
const BASE2 = "d4".repeat(20);
const MERGE = "f6".repeat(20);

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  const facts = isAgent ? { gen: 1, linker: { person: "per_tc_linker", since: 1 } } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] };
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...facts, ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, options: { key?: string; claims?: object; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, options.claims), "content-type": "application/json", ...(options.headers ?? {}) };
  if (method !== "GET") headers["idempotency-key"] = options.key ?? `tc-key-${++counter}`;
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

type Pull = { head_sha: string; base_sha: string; base_ref?: string; head_repo?: number | null; base_repo?: number; state?: "open" | "closed"; merged?: boolean; merge_commit_sha?: string; merged_by?: number; as_number?: number; padding?: number; draft?: boolean };
const fake = (body: object) => fetch("https://github-fake.example.com/agent-repo", { method: "POST", body: JSON.stringify({ id: REPO_ID, ...body }) });
/** Sets one pull request of this test's repository, as GitHub would answer for it. */
const pull = (number: number, patch: Partial<Pull> = {}) => fake({ pulls: { [number]: { head_sha: HEAD, base_sha: BASE, ...patch } } });
/** Every read made of this test's repository: its path, what the token could do, and the answer's status. */
const reads = async () => (await (await fetch(`https://github-fake.example.com/agent-reads?repo=${REPO_ID}`)).json()) as { path: string; permissions: object; status: number }[];
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
/** Every token minted for this test's repository, and whether it's still live. */
const minted = async () => (await (await fetch(`https://github-fake.example.com/agent-tokens?repo=${REPO_ID}`)).json()) as { token: string; live: boolean; repo: unknown; permissions: object; asked: any }[];

const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version as number;
const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const change = (id: string, task: string) => inRoom(id, (sql) => (sql.exec("SELECT * FROM task_change WHERE task_id = ?", task).toArray()[0] ?? null) as any);
const events = (id: string, prefix = "task_change.") => inRoom(id, (sql) => sql.exec("SELECT type, actor_id, task_id, reason FROM event WHERE type LIKE ? ORDER BY seq", `${prefix}%`).toArray() as any[]);
const taskRow = (id: string, task: string) => inRoom(id, (sql) => sql.exec("SELECT status, version, has_linked_repository, approved_submission_no FROM task WHERE id = ?", task).one() as any);
/** Whole runs of the room's alarm, one at a time, each ended when this returns (see `alarm.ts`). */
const alarm = async (id: string, times = 1) => {
  for (let n = 0; n < times; n++) await alarmPass(stub(id));
};
/**
 * One whole run of the alarm, then the check, once. A run does everything that was due when it began, so there's nothing
 * to wait for and nothing to try again: a check that fails here has failed.
 */
const afterPass = async (id: string, check: () => Promise<void>) => {
  await alarm(id);
  await check();
};
/** One run of the alarm, so whatever was due before a test's next step has been done. */
const settle = (id: string) => alarm(id);
/** Every room a test made, quieted after it so none of its alarms reaches a later test. */
const made: string[] = [];

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [AGENT, OTHER, PUBLIC, OUTSIDER]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin) }, body: JSON.stringify({ org_id: ORG, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

beforeEach(async () => {
  REPO_ID = ++nextRepo;
  await fake({});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});

/** A room, by default with managed repositories on and a ready link, and one pull request, number 7, open on `main`. */
async function room(options: { switchedOn?: boolean; link?: boolean } = {}) {
  const id: string = (await must(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).id;
  made.push(id);
  await must(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: ADMIN.id, kind: "person", org_id: ORG, role: "admin", policy_version: await version(id) }, { claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } });
  for (const [who, role] of [[AGENT, "member"], [OTHER, "member"], [PUBLIC, "guest"]] as const) {
    await must(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: ORG, role, policy_version: await version(id) });
  }
  await inRoom(id, (sql) => {
    sql.exec("UPDATE member SET joined_via = 'public' WHERE principal_id = ?", PUBLIC.id);
    if (options.switchedOn !== false) sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)");
  });
  if (options.link !== false) await addLink(id);
  await pull(7);
  return id;
}
const addLink = (id: string, status = "ready") => inRoom(id, (sql) => {
  sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podster-test-org/engineering', 'public', 'main', ?, ?, 1000, 2000, 2000)", REPO_ID, status, OWNER.id);
});

/** A task the owner makes for the agent, accepted. The owner is its reviewer. */
async function accepted(id: string, assignee: Who = AGENT) {
  const made = await must(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Code", instructions: "Change the code", assignee: assignee.id });
  const task = await must(assignee, "POST", `/v1/workspaces/${id}/tasks/${made.id}/accept`, { version: made.version });
  return { task: made.id as string, version: task.version as number };
}
const submit = (who: Who, id: string, task: string, body: object, options: { key?: string } = {}) => api(who, "POST", `/v1/workspaces/${id}/tasks/${task}/submit`, { note: "Done", ...body }, options);
const verify = (who: Who, id: string, task: string, body: object) => api(who, "POST", `/v1/workspaces/${id}/tasks/${task}/verify`, body);
/** A room with a linked task submitted on pull request 7 at `HEAD`. */
async function submitted() {
  const id = await room();
  const t = await accepted(id);
  const sent = await submit(AGENT, id, t.task, { version: t.version, commit_sha: HEAD, pr_number: 7 });
  expect(sent.status, sent.text).toBe(200);
  return { id, ...t };
}
/** The same, approved by the owner. */
async function approved() {
  const r = await submitted();
  const done = await verify(OWNER, r.id, r.task, { submission_no: 1, commit_sha: HEAD });
  expect(done.status, done.text).toBe(200);
  return r;
}
/** Marks the change as named by a delivery, as step 5's nudge does. */
const nudge = (id: string) => inRoom(id, (sql) => void sql.exec("UPDATE task_change SET nudged_at = ?", Date.now() + 1));

describe("linking a pull request at submission", () => {
  it("links a task made in a room with a ready repository, reads the pull request with a read-only token for that one repository, and revokes it", async () => {
    const id = await room();
    const t = await accepted(id);
    expect((await taskRow(id, t.task)).has_linked_repository).toBe(1);
    const before = Date.now();
    const sent = await submit(AGENT, id, t.task, { version: t.version, commit_sha: HEAD, pr_number: 7 });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.body.status).toBe("submitted");
    // One read, by the repository's ID and the pull request's number, with a token that can only read.
    expect(await reads()).toEqual([{ path: `/repositories/${REPO_ID}/pulls/7`, permissions: READ_ONLY, status: 200 }]);
    expect(await minted()).toEqual([{ token: expect.any(String), live: false, repo: [REPO_ID], permissions: READ_ONLY, asked: { repository_ids: [REPO_ID], permissions: READ_ONLY } }]);
    // The change is recorded with the submission: IDs, commit IDs, a state and the time.
    const row = await change(id, t.task);
    expect(row).toMatchObject({
      task_id: t.task, provider_repo_id: REPO_ID, pr_number: 7, submission_no: 1, observed_head_sha: HEAD, head_repo_id: REPO_ID, base_ref: "main",
      observed_base_sha: BASE, pr_state: "open", reviewed_commit_sha: null, reviewed_base_sha: null, merge_state: "not_requested", merge_reason: null, unchanged_reads: 0,
    });
    for (const at of [row.head_observed_at, row.pr_observed_at, row.read_at, row.created_at]) expect(at).toBeGreaterThanOrEqual(before);
    expect(await events(id)).toEqual([{ type: "task_change.linked", actor_id: AGENT.id, task_id: t.task, reason: null }]);
    // The read of the task shows it to whoever may read the task.
    const shown = (await must(OWNER, "GET", `/v1/workspaces/${id}/tasks/${t.task}`)).change;
    expect(shown).toEqual({
      provider_repo_id: REPO_ID, pr_number: 7, submission_no: 1, pr_state: "open", pr_observed_at: row.pr_observed_at, observed_head_sha: HEAD, head_observed_at: row.head_observed_at,
      head_in_repository: true, base_is_default: true, observed_base_sha: BASE, reviewed_commit_sha: null, reviewed_base_sha: null, commit_changed: false,
      pr_draft: false, commit_changed_at: null, watched: true, merge_state: "not_requested", merge_reason: null, merge_sha: null, merge_observed_at: null, merge_requested_by: null, merge_requested_at: null, merge_finished_at: null,
    });
  });

  it("refuses each pull request that can't be the task's change, and records nothing", async () => {
    const id = await room();
    const t = await accepted(id);
    const tried = async (number: number, patch: Partial<Pull> | null, expected: [number, string], body: object = {}) => {
      if (patch) await pull(number, patch);
      const got = await submit(AGENT, id, t.task, { version: t.version, commit_sha: HEAD, pr_number: number, ...body });
      expect([got.status, got.code], JSON.stringify(patch)).toEqual(expected);
    };
    // No such pull request in the room's repository.
    await tried(404, null, [404, "pull_request_not_found"]);
    // One the provider says is in another repository, or answers about under another number.
    await tried(8, { base_repo: REPO_ID + 1 }, [404, "pull_request_not_found"]);
    await tried(9, { as_number: 10 }, [404, "pull_request_not_found"]);
    // A fork's pull request is never a task change, whether the fork is still there or gone.
    await tried(11, { head_repo: REPO_ID + 1 }, [409, "pull_request_from_fork"]);
    await tried(12, { head_repo: null }, [409, "pull_request_from_fork"]);
    // Not into the default branch.
    await tried(13, { base_ref: "release" }, [409, "pull_request_wrong_base"]);
    // Into a branch whose name is too long to be one of ours: the wrong base, not an unreadable pull request.
    await tried(18, { base_ref: "b".repeat(300) }, [409, "pull_request_wrong_base"]);
    // Still marked as a draft by its author.
    await tried(17, { draft: true }, [409, "pull_request_draft"]);
    // Closed, or already merged.
    await tried(14, { state: "closed" }, [409, "pull_request_not_open"]);
    await tried(15, { merged: true, merge_commit_sha: MERGE }, [409, "pull_request_not_open"]);
    // Its head isn't the commit the submission names.
    await tried(16, { head_sha: HEAD2 }, [409, "commit_changed"]);
    // No number, or one that isn't a positive whole number, costs no read.
    const before = (await reads()).length;
    for (const bad of [undefined, 0, -7, "7", 7.5, null]) {
      const got = await submit(AGENT, id, t.task, { version: t.version, commit_sha: HEAD, pr_number: bad });
      expect([got.status, got.code], String(bad)).toEqual([400, "invalid_argument"]);
    }
    // Neither does a commit that isn't a full ID.
    const short = await submit(AGENT, id, t.task, { version: t.version, commit_sha: "a1b2c3d", pr_number: 7 });
    expect([short.status, short.code]).toEqual([400, "invalid_argument"]);
    expect((await reads()).length).toBe(before);
    // A stale command is answered as stale, and never reads a pull request or says anything about one.
    const stale = await submit(AGENT, id, t.task, { version: t.version + 5, commit_sha: HEAD, pr_number: 404 });
    expect([stale.status, stale.code]).toEqual([409, "version_conflict"]);
    expect((await reads()).length).toBe(before);
    expect(await change(id, t.task)).toBeNull();
    expect((await taskRow(id, t.task)).status).toBe("accepted");
    expect(await events(id)).toEqual([]);
    // Every token made for those reads is gone.
    expect((await minted()).every((token) => !token.live)).toBe(true);
    // And the good one still goes through.
    expect((await submit(AGENT, id, t.task, { version: t.version, commit_sha: HEAD, pr_number: 7 })).status).toBe(200);
  });

  it("gives one pull request to one task, and keeps a task on the pull request it first named", async () => {
    const r = await submitted();
    // Another task can't name the same pull request, and that costs no read.
    const second = await accepted(r.id, OTHER);
    const before = (await reads()).length;
    const taken = await submit(OTHER, r.id, second.task, { version: second.version, commit_sha: HEAD, pr_number: 7 });
    expect([taken.status, taken.code]).toEqual([409, "pull_request_in_use"]);
    expect((await reads()).length).toBe(before);
    // Sent back, the agent pushes again and submits the new head of the same pull request: a new numbered submission.
    const back = await must(OWNER, "POST", `/v1/workspaces/${r.id}/tasks/${r.task}/request-changes`, { submission_no: 1, reason: "More" });
    await pull(7, { head_sha: HEAD2 });
    await pull(21, { head_sha: HEAD2 });
    const other = await submit(AGENT, r.id, r.task, { version: back.version, commit_sha: HEAD2, pr_number: 21 });
    expect([other.status, other.code]).toEqual([409, "pull_request_changed"]);
    const again = await submit(AGENT, r.id, r.task, { version: back.version, commit_sha: HEAD2, pr_number: 7 });
    expect(again.status, again.text).toBe(200);
    expect(await change(r.id, r.task)).toMatchObject({ pr_number: 7, submission_no: 2, observed_head_sha: HEAD2, reviewed_commit_sha: null });
    // Linked once: the second submission adds no second link event.
    expect((await events(r.id)).map((e) => e.type)).toEqual(["task_change.linked"]);
  });

  it("replays a stored submission without reading GitHub again", async () => {
    const id = await room();
    const t = await accepted(id);
    const body = { version: t.version, commit_sha: HEAD, pr_number: 7 };
    const first = await submit(AGENT, id, t.task, body, { key: "tc-replay" });
    const replay = await submit(AGENT, id, t.task, body, { key: "tc-replay" });
    expect(replay.body).toEqual(first.body);
    expect((await reads()).length).toBe(1);
  });

  it("reads a pull request whose description is as long as GitHub allows", async () => {
    const id = await room();
    const t = await accepted(id);
    await pull(7, { padding: 300_000 });
    expect((await submit(AGENT, id, t.task, { version: t.version, commit_sha: HEAD, pr_number: 7 })).status).toBe(200);
  });

  it("refuses cleanly when GitHub doesn't answer, answers wrongly, or hands back a wider token", async () => {
    const id = await room();
    const t = await accepted(id);
    const body = { version: t.version, commit_sha: HEAD, pr_number: 7 };
    await fake({ pullRead: 500 });
    const down = await submit(AGENT, id, t.task, body);
    expect([down.status, down.code]).toEqual([502, "provider_unavailable"]);
    expect(down.text).not.toContain("SECRET");
    await fake({ pullRead: 200 });
    for (const mode of ["wide", "extra_permission", "other_repo", "no_repositories"]) {
      await fake({ mode });
      const before = (await reads()).length;
      const got = await submit(AGENT, id, t.task, body);
      expect([got.status, got.code], mode).toEqual([502, "provider_unavailable"]);
      // A token that isn't exactly what was asked for is never used, and is revoked.
      expect((await reads()).length, mode).toBe(before);
    }
    expect((await minted()).every((token) => !token.live)).toBe(true);
    expect(await change(id, t.task)).toBeNull();
    await fake({ mode: "ok" });
    expect((await submit(AGENT, id, t.task, body)).status).toBe(200);
  });

  it("refuses without calling GitHub when the App that reads isn't configured", async () => {
    const id = await room();
    const t = await accepted(id);
    await inRoom(id, (sql) => sql.exec("CREATE TABLE test_no_agent_app (x INTEGER)"));
    const got = await submit(AGENT, id, t.task, { version: t.version, commit_sha: HEAD, pr_number: 7 });
    expect([got.status, got.code]).toEqual([503, "repo_access_unavailable"]);
    expect(await minted()).toEqual([]);
    expect((await taskRow(id, t.task)).status).toBe("accepted");
  });

  it("refuses a linked task while the room's repository isn't ready, and reads nothing", async () => {
    const id = await room();
    const t = await accepted(id);
    for (const status of ["degraded", "suspended"]) {
      await inRoom(id, (sql) => sql.exec("UPDATE repo_link SET status = ?", status));
      const got = await submit(AGENT, id, t.task, { version: t.version, commit_sha: HEAD, pr_number: 7 });
      expect([got.status, got.code], status).toEqual([409, "repo_not_ready"]);
    }
    expect(await reads()).toEqual([]);
  });

  it("holds reads for commands to 60 an hour for the room and 20 for any one caller, so one caller can't spend the room's", async () => {
    const r = await submitted();
    // The assignee has used its own allowance, on wrong commits say. Its next read is refused.
    await inRoom(r.id, (sql) => { for (let n = 0; n < 19; n++) sql.exec("INSERT INTO repo_read (at, kind, caller) VALUES (?, 'command', ?)", Date.now(), AGENT.id); });
    const back = await must(OWNER, "POST", `/v1/workspaces/${r.id}/tasks/${r.task}/request-changes`, { submission_no: 1, reason: "More" });
    const mintedBefore = (await minted()).length;
    const spent = await submit(AGENT, r.id, r.task, { version: back.version, commit_sha: HEAD, pr_number: 7 });
    expect([spent.status, spent.code]).toEqual([429, "rate_limited"]);
    expect((await minted()).length).toBe(mintedBefore);
    // The reviewer's approval of another task isn't held up by it.
    const other = await accepted(r.id, OTHER);
    await pull(8);
    expect((await submit(OTHER, r.id, other.task, { version: other.version, commit_sha: HEAD, pr_number: 8 })).status).toBe(200);
    expect((await verify(OWNER, r.id, other.task, { submission_no: 1, commit_sha: HEAD })).status).toBe(200);
    // The room's own cap holds everyone, and the refresh job's reads are counted apart from it.
    const third = await accepted(r.id, OTHER);
    await pull(9);
    await inRoom(r.id, (sql) => { sql.exec("DELETE FROM repo_read"); for (let n = 0; n < 60; n++) sql.exec("INSERT INTO repo_read (at, kind, caller) VALUES (?, 'command', ?)", Date.now(), `agt_tc_x${n}`); });
    const full = await submit(OTHER, r.id, third.task, { version: third.version, commit_sha: HEAD, pr_number: 9 });
    expect([full.status, full.code]).toEqual([429, "rate_limited"]);
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_read SET kind = 'job', caller = NULL"));
    expect((await submit(OTHER, r.id, third.task, { version: third.version, commit_sha: HEAD, pr_number: 9 })).status).toBe(200);
    // An hour on, the assignee has room again.
    await inRoom(r.id, (sql) => { sql.exec("DELETE FROM repo_read"); for (let n = 0; n < 20; n++) sql.exec("INSERT INTO repo_read (at, kind, caller) VALUES (?, 'command', ?)", Date.now() - 3_600_001, AGENT.id); });
    expect((await submit(AGENT, r.id, r.task, { version: back.version, commit_sha: HEAD, pr_number: 7 })).status).toBe(200);
  });

  it("answers a hidden room as a missing one and a hidden task as a missing one, and reads nothing for either", async () => {
    const id = await room();
    const t = await accepted(id);
    const body = { version: t.version, commit_sha: HEAD, pr_number: 7 };
    const outside = await submit(OUTSIDER, id, t.task, body);
    const nowhere = await submit(OUTSIDER, `ws_${crypto.randomUUID().replaceAll("-", "")}`, t.task, body);
    expect([outside.status, outside.code]).toEqual([nowhere.status, nowhere.code]);
    expect(outside.code).toBe("workspace_not_found");
    const hidden = await submit(PUBLIC, id, t.task, body);
    const missing = await submit(PUBLIC, id, "tsk_missing", body);
    expect([hidden.status, hidden.code]).toEqual([missing.status, missing.code]);
    expect(hidden.code).toBe("task_not_found");
    // Someone in the room who isn't the assignee is refused before any read, too.
    expect((await submit(OTHER, id, t.task, body)).status).toBe(403);
    expect(await minted()).toEqual([]);
  });
});

describe("which tasks are linked, and the switch", () => {
  it("leaves everything as it was with managed repositories off", async () => {
    const id = await room({ switchedOn: false });
    const t = await accepted(id);
    expect((await taskRow(id, t.task)).has_linked_repository).toBe(0);
    // No commit and no pull request are asked for, and one that's sent is ignored.
    const sent = await submit(AGENT, id, t.task, { version: t.version, pr_number: 7 });
    expect(sent.status, sent.text).toBe(200);
    expect((await verify(OWNER, id, t.task, { submission_no: 1 })).status).toBe(200);
    // Off, the task read has no `change` at all.
    expect((await must(OWNER, "GET", `/v1/workspaces/${id}/tasks/${t.task}`))).not.toHaveProperty("change");
    // A task that was linked while it was on is decided as before this step: a commit, and no read.
    const old = await accepted(id);
    await inRoom(id, (sql) => sql.exec("UPDATE task SET has_linked_repository = 1 WHERE id = ?", old.task));
    const without = await submit(AGENT, id, old.task, { version: old.version });
    expect([without.status, without.code]).toEqual([400, "invalid_argument"]);
    expect((await submit(AGENT, id, old.task, { version: old.version, commit_sha: HEAD })).status).toBe(200);
    expect((await verify(OWNER, id, old.task, { submission_no: 1, commit_sha: HEAD })).status).toBe(200);
    await alarm(id, 2);
    expect(await minted()).toEqual([]);
    expect(await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM task_change").one().n)).toBe(0);
    expect(await events(id)).toEqual([]);
  });

  it("links only tasks made while the repository is ready, and never blocks any other (M5-15)", async () => {
    const id = await room({ link: false });
    const early = await accepted(id);
    await addLink(id, "degraded");
    const during = await accepted(id);
    await inRoom(id, (sql) => sql.exec("UPDATE repo_link SET status = 'ready'"));
    const late = await accepted(id);
    expect([(await taskRow(id, early.task)).has_linked_repository, (await taskRow(id, during.task)).has_linked_repository, (await taskRow(id, late.task)).has_linked_repository]).toEqual([0, 0, 1]);
    // The unlinked ones are submitted and approved with no commit, no pull request and no read.
    for (const t of [early, during]) {
      expect((await submit(AGENT, id, t.task, { version: t.version })).status).toBe(200);
      expect((await verify(OWNER, id, t.task, { submission_no: 1 })).status).toBe(200);
    }
    expect(await minted()).toEqual([]);
    const needs = await submit(AGENT, id, late.task, { version: late.version, commit_sha: HEAD });
    expect([needs.status, needs.code]).toEqual([400, "invalid_argument"]);
  });

  it("refuses to approve a linked submission that has no pull request on record", async () => {
    const id = await room();
    const t = await accepted(id);
    // Submitted while the switch was off.
    await inRoom(id, (sql) => sql.exec("DROP TABLE test_managed_repositories_on"));
    expect((await submit(AGENT, id, t.task, { version: t.version, commit_sha: HEAD })).status).toBe(200);
    await inRoom(id, (sql) => sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)"));
    const got = await verify(OWNER, id, t.task, { submission_no: 1, commit_sha: HEAD });
    expect([got.status, got.code]).toEqual([409, "change_not_found"]);
    expect(await minted()).toEqual([]);
    // Sending it back is always possible.
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/tasks/${t.task}/request-changes`, { submission_no: 1, reason: "Name the pull request" })).status).toBe(200);
  });
});

describe("review pins the commit", () => {
  it("records the reviewed commit and base from a fresh read at approval, and merges nothing (M5-08, AC-17)", async () => {
    const r = await submitted();
    // The base moved between submission and review. That's recorded, and doesn't stop the approval.
    await pull(7, { base_sha: BASE2 });
    const done = await verify(OWNER, r.id, r.task, { submission_no: 1, commit_sha: HEAD });
    expect(done.status, done.text).toBe(200);
    expect(done.body.status).toBe("completed");
    expect(await change(r.id, r.task)).toMatchObject({ reviewed_commit_sha: HEAD, reviewed_base_sha: BASE2, observed_head_sha: HEAD, observed_base_sha: BASE2, pr_state: "open", merge_state: "not_requested", merge_sha: null, merge_requested_at: null });
    // Two reads in all, each read-only, and both tokens gone.
    expect((await reads()).map((read) => [read.path, read.permissions, read.status])).toEqual([[`/repositories/${REPO_ID}/pulls/7`, READ_ONLY, 200], [`/repositories/${REPO_ID}/pulls/7`, READ_ONLY, 200]]);
    expect((await minted()).map((token) => token.live)).toEqual([false, false]);
    // Approval is one task event, and nothing asked for a merge.
    expect(await events(r.id, "merge.")).toEqual([]);
    expect((await events(r.id)).map((e) => e.type)).toEqual(["task_change.linked"]);
  });

  it("refuses with commit_changed when the head moved after submission, and leaves the task to be submitted again", async () => {
    const r = await submitted();
    await pull(7, { head_sha: HEAD2 });
    const moved = await verify(OWNER, r.id, r.task, { submission_no: 1, commit_sha: HEAD });
    expect([moved.status, moved.code]).toEqual([409, "commit_changed"]);
    // Naming the new head doesn't re-pin the submission.
    const repinned = await verify(OWNER, r.id, r.task, { submission_no: 1, commit_sha: HEAD2 });
    expect([repinned.status, repinned.code]).toEqual([409, "commit_changed"]);
    expect((await taskRow(r.id, r.task)).status).toBe("submitted");
    expect(await change(r.id, r.task)).toMatchObject({ reviewed_commit_sha: null, observed_head_sha: HEAD, submission_no: 1 });
    // Without a commit, or with one that isn't the submission's, nothing is approved either.
    const none = await verify(OWNER, r.id, r.task, { submission_no: 1 });
    expect([none.status, none.code]).toEqual([400, "invalid_argument"]);
  });

  it("refuses to approve a pull request that's no longer one the task may have", async () => {
    const r = await submitted();
    for (const [patch, code] of [[{ state: "closed" }, "pull_request_not_open"], [{ base_ref: "other" }, "pull_request_wrong_base"], [{ head_repo: REPO_ID + 1 }, "pull_request_from_fork"], [{ draft: true }, "pull_request_draft"]] as const) {
      await pull(7, { head_sha: HEAD, base_sha: BASE, state: "open", base_ref: "main", head_repo: REPO_ID, draft: false, ...patch });
      const got = await verify(OWNER, r.id, r.task, { submission_no: 1, commit_sha: HEAD });
      expect([got.status, got.code], code).toEqual([409, code]);
    }
    await fake({ pullRead: 502 });
    const down = await verify(OWNER, r.id, r.task, { submission_no: 1, commit_sha: HEAD });
    expect([down.status, down.code]).toEqual([502, "provider_unavailable"]);
    expect((await taskRow(r.id, r.task)).status).toBe("submitted");
    // The assignee can't approve its own work, and that costs no read.
    const before = (await reads()).length;
    expect((await verify(AGENT, r.id, r.task, { submission_no: 1, commit_sha: HEAD })).status).toBe(403);
    // A change on record for some other repository isn't this room's, and isn't read or approved.
    await fake({ pullRead: 200 });
    await pull(7);
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET provider_repo_id = provider_repo_id + 1"));
    const elsewhere = await verify(OWNER, r.id, r.task, { submission_no: 1, commit_sha: HEAD });
    expect([elsewhere.status, elsewhere.code]).toEqual([409, "change_not_found"]);
    expect((await reads()).length).toBe(before);
    expect((await taskRow(r.id, r.task)).status).toBe("submitted");
  });

  it("refuses with pull_request_unread, and approves nothing, when the room changes while GitHub is being read", async () => {
    const r = await submitted();
    await settle(r.id);
    // GitHub holds its answer. Meanwhile the task's record comes to name another pull request, and then it answers.
    await fake({ mode: "gate" });
    const pending = verify(OWNER, r.id, r.task, { submission_no: 1, commit_sha: HEAD });
    await minting();
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET pr_number = 8"));
    await release();
    const got = await pending;
    expect([got.status, got.code]).toEqual([409, "pull_request_unread"]);
    expect(await taskRow(r.id, r.task)).toMatchObject({ status: "submitted", approved_submission_no: null });
    expect(await change(r.id, r.task)).toMatchObject({ pr_number: 8, reviewed_commit_sha: null });
    // Sent again once the room is settled, it's read and decided afresh.
    await fake({ mode: "ok" });
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET pr_number = 7"));
    expect((await verify(OWNER, r.id, r.task, { submission_no: 1, commit_sha: HEAD })).status).toBe(200);
  });
});

describe("the refresh job", () => {
  it("reads a change again when a delivery named it, and records what it saw as an event of IDs and states", async () => {
    const r = await submitted();
    await settle(r.id);
    const before = (await reads()).length;
    await pull(7, { head_sha: HEAD2, base_sha: BASE2 });
    await nudge(r.id);
    await afterPass(r.id, async () => expect(await change(r.id, r.task)).toMatchObject({ observed_head_sha: HEAD2, observed_base_sha: BASE2, pr_state: "open", unchanged_reads: 0 }));
    expect((await reads()).length).toBe(before + 1);
    expect((await reads()).at(-1)).toEqual({ path: `/repositories/${REPO_ID}/pulls/7`, permissions: READ_ONLY, status: 200 });
    expect((await minted()).every((token) => !token.live)).toBe(true);
    // Before review a moved head is only an observation. The submission's commit is still what review will be held to.
    expect(await events(r.id)).toEqual([
      { type: "task_change.linked", actor_id: AGENT.id, task_id: r.task, reason: null },
      { type: "task_change.observed", actor_id: "system", task_id: r.task, reason: "open" },
    ]);
    const stale = await verify(OWNER, r.id, r.task, { submission_no: 1, commit_sha: HEAD });
    expect([stale.status, stale.code]).toEqual([409, "commit_changed"]);
  });

  it("polls an open change once its wait is over, waits longer each time nothing changed, and not before", async () => {
    const r = await submitted();
    await settle(r.id);
    const before = (await reads()).length;
    // Just read: nothing is due.
    await alarm(r.id, 2);
    expect((await reads()).length).toBe(before);
    // A minute on, it's read. Nothing changed, so no event, and the next wait is two minutes.
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET read_at = ?", Date.now() - 60_001));
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).unchanged_reads).toBe(1));
    expect((await reads()).length).toBe(before + 1);
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET read_at = ?", Date.now() - 61_000));
    await alarm(r.id, 2);
    expect((await reads()).length).toBe(before + 1);
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET read_at = ?", Date.now() - 120_001));
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).unchanged_reads).toBe(2));
    expect((await events(r.id)).map((e) => e.type)).toEqual(["task_change.linked"]);
    // The alarm is set for the next poll.
    const next = await runInDurableObject(stub(r.id), (_: any, state: any) => state.storage.getAlarm());
    expect(next).not.toBeNull();
  });

  it("stops at the read cap for the repository, and catches up once there's room", async () => {
    const r = await submitted();
    await settle(r.id);
    const before = (await reads()).length;
    await inRoom(r.id, (sql) => { for (let n = 0; n < 60; n++) sql.exec("INSERT INTO repo_read (at, kind) VALUES (?, 'job')", Date.now()); });
    await pull(7, { head_sha: HEAD2 });
    await nudge(r.id);
    await alarm(r.id, 3);
    expect((await reads()).length).toBe(before);
    expect((await change(r.id, r.task)).observed_head_sha).toBe(HEAD);
    // The alarm waits for the oldest read to be an hour old, not five seconds.
    const next = (await runInDurableObject(stub(r.id), (_: any, state: any) => state.storage.getAlarm())) as number | null;
    expect(next === null || next > Date.now() + 30 * 60_000).toBe(true);
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_read SET at = ?", Date.now() - 3_600_001));
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).observed_head_sha).toBe(HEAD2));
  });

  it("records a head that moved after review without un-approving or re-pinning, and tells the people who'd follow up", async () => {
    const r = await approved();
    await settle(r.id);
    await pull(7, { head_sha: HEAD2 });
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).observed_head_sha).toBe(HEAD2));
    // The approval and the reviewed commit stand.
    expect(await taskRow(r.id, r.task)).toMatchObject({ status: "completed", approved_submission_no: 1 });
    expect(await change(r.id, r.task)).toMatchObject({ reviewed_commit_sha: HEAD, reviewed_base_sha: BASE, merge_state: "not_requested", merge_reason: null });
    const shown = (await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`)).change;
    expect(shown).toMatchObject({ commit_changed: true, reviewed_commit_sha: HEAD, observed_head_sha: HEAD2 });
    expect(shown.commit_changed_at).toBeGreaterThan(0);
    const recorded = (await events(r.id)).filter((e) => e.type === "task_change.commit_changed");
    expect(recorded).toEqual([{ type: "task_change.commit_changed", actor_id: "system", task_id: r.task, reason: "commit_changed" }]);
    // The room's owner and admin are told, by ID.
    // Every page of the person's inbox: other tests' rooms share these people.
    const inbox = async (who: Who) => {
      let found = 0;
      for (let after = 0; ; ) {
        const page = (await api(who, "GET", `/v1/inbox?after=${after}`)).body.events as any[];
        if (!page.length) return found;
        found += page.filter((e) => e.type === "task_change.commit_changed" && e.task_id === r.task).length;
        after = page.at(-1).seq;
      }
    };
    await afterPass(r.id, async () => expect([await inbox(OWNER), await inbox(ADMIN)]).toEqual([1, 1]));
    expect(await inbox(AGENT)).toBe(0);
    // It moves again: still one record that the reviewed commit was left behind.
    await pull(7, { head_sha: "e5".repeat(20) });
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).observed_head_sha).toBe("e5".repeat(20)));
    expect((await events(r.id)).filter((e) => e.type === "task_change.commit_changed")).toHaveLength(1);
    // Pushed back to the reviewed commit: it stays changed, with the time it was first seen (plan decision 6).
    await pull(7, { head_sha: HEAD });
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).observed_head_sha).toBe(HEAD));
    expect((await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`)).change).toMatchObject({ commit_changed: true, commit_changed_at: shown.commit_changed_at, observed_head_sha: HEAD, reviewed_commit_sha: HEAD });
    expect((await events(r.id)).filter((e) => e.type === "task_change.commit_changed")).toHaveLength(1);
  });

  it("records a pull request that went back to draft after review as a change of state, and un-approves nothing", async () => {
    const r = await approved();
    await settle(r.id);
    await pull(7, { draft: true });
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).pr_draft).toBe(1));
    expect(await taskRow(r.id, r.task)).toMatchObject({ status: "completed", approved_submission_no: 1 });
    expect(await change(r.id, r.task)).toMatchObject({ pr_state: "open", reviewed_commit_sha: HEAD, commit_changed_at: null });
    expect((await events(r.id)).at(-1)).toEqual({ type: "task_change.observed", actor_id: "system", task_id: r.task, reason: "draft" });
    expect((await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`)).change).toMatchObject({ pr_draft: true, commit_changed: false });
  });

  it("leaves a merge Podster asked for to the merge job, so a recorded observed merge is always one it didn't ask for", async () => {
    const r = await approved();
    await settle(r.id);
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET merge_state = 'requested'"));
    await pull(7, { merged: true, merge_commit_sha: MERGE, merged_by: 31337 });
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).pr_state).toBe("merged"));
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "requested", merge_reason: null, merge_sha: null, merged_by_id: null, merge_observed_at: null });
    expect((await events(r.id)).filter((e) => e.type === "task_change.merge_observed")).toEqual([]);
  });

  it("records a merge Podster didn't ask for, with its reason, and never as a success", async () => {
    // Approved, and merged at the reviewed commit by someone else.
    const r = await approved();
    await settle(r.id);
    await pull(7, { merged: true, merge_commit_sha: MERGE, merged_by: 31337 });
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).pr_state).toBe("merged"));
    expect(await change(r.id, r.task)).toMatchObject({ merge_state: "not_requested", merge_reason: "unrequested_merge", merge_sha: MERGE, merged_by_id: 31337, reviewed_commit_sha: HEAD });
    expect((await change(r.id, r.task)).merge_observed_at).toBeGreaterThan(0);
    expect((await events(r.id)).slice(-2)).toEqual([
      { type: "task_change.observed", actor_id: "system", task_id: r.task, reason: "merged" },
      { type: "task_change.merge_observed", actor_id: "system", task_id: r.task, reason: "unrequested_merge" },
    ]);
    expect(await events(r.id, "merge.")).toEqual([]);
    // Once merged, it isn't read again, and the merge isn't recorded twice.
    const before = (await reads()).length;
    await nudge(r.id);
    await alarm(r.id, 2);
    expect((await reads()).length).toBe(before);
    expect((await events(r.id)).filter((e) => e.type === "task_change.merge_observed")).toHaveLength(1);

    // Never approved, and merged anyway.
    REPO_ID = ++nextRepo;
    await fake({});
    const u = await submitted();
    await settle(u.id);
    await pull(7, { merged: true, merge_commit_sha: MERGE, merged_by: 31337 });
    await nudge(u.id);
    await afterPass(u.id, async () => expect((await change(u.id, u.task)).merge_reason).toBe("unreviewed_merge"));
    expect(await change(u.id, u.task)).toMatchObject({ merge_state: "not_requested", pr_state: "merged", reviewed_commit_sha: null });
    expect((await taskRow(u.id, u.task)).status).toBe("submitted");
  });

  it("reads a closed pull request only when a delivery names it, and leaves a failed read for the next poll", async () => {
    const r = await submitted();
    await settle(r.id);
    await pull(7, { state: "closed" });
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).pr_state).toBe("closed"));
    const before = (await reads()).length;
    // Closed and not named again: not polled, however long ago it was read.
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET read_at = 1, nudged_at = 0"));
    await alarm(r.id, 2);
    expect((await reads()).length).toBe(before);
    // Reopened, a delivery says so, and GitHub is down: the attempt is recorded and nothing else changes.
    await pull(7, { state: "open" });
    await fake({ pullRead: 500 });
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await reads()).length).toBe(before + 1));
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).read_at).toBeGreaterThan(1));
    expect(await change(r.id, r.task)).toMatchObject({ pr_state: "closed", read_failures: 1 });
  });

  it("waits longer after each failed read, a minute doubling to an hour, and starts over once one works", async () => {
    const r = await submitted();
    await settle(r.id);
    /** What the room has stored for the change, and how many reads GitHub failed. Checked after every run of the alarm. */
    const now = async () => {
      const row = await change(r.id, r.task);
      return { read_failures: row.read_failures, unchanged_reads: row.unchanged_reads, failed: (await reads()).filter((read) => read.status === 500).length };
    };
    /** The last read, as if it were `ms` ago. Each wait is counted from this stored time. */
    const readAgo = (ms: number) => inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET read_at = ?", Date.now() - ms));
    // One unchanged read first, so the poll's own backoff is seen to survive a failure.
    await readAgo(60_001);
    await alarm(r.id);
    expect(await now()).toEqual({ read_failures: 0, unchanged_reads: 1, failed: 0 });
    await fake({ pullRead: 500 });
    await nudge(r.id);
    await alarm(r.id);
    expect(await now()).toEqual({ read_failures: 1, unchanged_reads: 1, failed: 1 });
    // Inside the minute nothing reads it, whatever a delivery says.
    await nudge(r.id);
    await alarm(r.id, 2);
    await readAgo(50_000);
    await nudge(r.id);
    await alarm(r.id);
    expect(await now()).toEqual({ read_failures: 1, unchanged_reads: 1, failed: 1 });
    // After a minute it's tried again, and then not for two.
    await readAgo(60_001);
    await nudge(r.id);
    await alarm(r.id);
    expect(await now()).toEqual({ read_failures: 2, unchanged_reads: 1, failed: 2 });
    await readAgo(100_000);
    await nudge(r.id);
    await alarm(r.id, 2);
    expect(await now()).toEqual({ read_failures: 2, unchanged_reads: 1, failed: 2 });
    await readAgo(120_001);
    await alarm(r.id);
    expect(await now()).toEqual({ read_failures: 3, unchanged_reads: 1, failed: 3 });
    // The wait never passes an hour: short of one nothing is read, however many reads have failed, and after one it is.
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET read_failures = 40"));
    await readAgo(3_500_000);
    await nudge(r.id);
    await alarm(r.id);
    expect(await now()).toEqual({ read_failures: 40, unchanged_reads: 1, failed: 3 });
    await readAgo(3_600_001);
    await alarm(r.id);
    expect(await now()).toEqual({ read_failures: 41, unchanged_reads: 1, failed: 4 });
    // A read that works ends the run.
    await fake({ pullRead: 200 });
    await readAgo(3_600_001);
    await nudge(r.id);
    await alarm(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ read_failures: 0, not_found_reads: 0 });
  });

  it("stops watching a pull request that's gone after five reads in a row, and says so once", async () => {
    const r = await submitted();
    await settle(r.id);
    await fake({ pulls: { 7: null } });
    const gone = async () => (await reads()).filter((read) => read.status === 404).length;
    for (let n = 1; n <= 5; n++) {
      await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET read_at = ?", Date.now() - 3_600_001));
      await nudge(r.id);
      await afterPass(r.id, async () => expect((await change(r.id, r.task)).not_found_reads).toBe(n));
      await settle(r.id);
    }
    expect(await gone()).toBe(5);
    const row = await change(r.id, r.task);
    expect(row.unwatched_at).toBeGreaterThan(0);
    expect(row).toMatchObject({ pr_state: "open", observed_head_sha: HEAD, read_failures: 5 });
    expect((await events(r.id)).filter((e) => e.type === "task_change.unwatched")).toEqual([{ type: "task_change.unwatched", actor_id: "system", task_id: r.task, reason: "pull_request_not_found" }]);
    expect((await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`)).change.watched).toBe(false);
    // It isn't read again, however long passes or whatever a delivery says.
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET read_at = 1"));
    await nudge(r.id);
    await alarm(r.id, 2);
    expect(await gone()).toBe(5);
    // One 404 between other failures doesn't count towards it: the run has to be unbroken.
    // The fake's answer first, then the row that makes a read due: the room's own alarm may read at once.
    await fake({ pullRead: 500 });
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET unwatched_at = NULL, not_found_reads = 4, read_at = 1"));
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).not_found_reads).toBe(0));
    expect((await change(r.id, r.task)).unwatched_at).toBeNull();
  });

  it("makes the whole room's reads wait when GitHub refuses Podster itself, not each change in turn", async () => {
    const r = await submitted();
    const second = await accepted(r.id, OTHER);
    await pull(8);
    expect((await submit(OTHER, r.id, second.task, { version: second.version, commit_sha: HEAD, pr_number: 8 })).status).toBe(200);
    await settle(r.id);
    const link = () => inRoom(r.id, (sql) => sql.exec("SELECT read_failures, reads_not_before FROM repo_link").one() as any);
    const refusedReads = async () => (await reads()).filter((read) => read.status === 403).length;
    await fake({ pullRead: 403 });
    const before = Date.now();
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await link()).read_failures).toBe(1));
    await settle(r.id);
    // Both changes were due, and one read was enough to know. Neither change is marked as failing on its own.
    expect(await refusedReads()).toBe(1);
    expect((await link()).reads_not_before).toBeGreaterThanOrEqual(before + 60_000);
    expect([(await change(r.id, r.task)).read_failures, (await change(r.id, second.task)).read_failures]).toEqual([0, 0]);
    // While the room waits nothing is read, and the alarm isn't set for sooner.
    await nudge(r.id);
    await alarm(r.id, 2);
    expect(await refusedReads()).toBe(1);
    // The wait over and still refused: twice as long.
    const again = Date.now();
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_link SET reads_not_before = ?", Date.now() - 1));
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await link()).read_failures).toBe(2));
    expect((await link()).reads_not_before).toBeGreaterThanOrEqual(again + 120_000);
    await settle(r.id);
    // Put right, the next read clears it for the room.
    await fake({ pullRead: 200 });
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_link SET reads_not_before = ?", Date.now() - 1));
    await nudge(r.id);
    await afterPass(r.id, async () => expect(await link()).toEqual({ read_failures: 0, reads_not_before: null }));
    // Said once for the run of refusals, with a fixed code and no task.
    expect(await events(r.id, "repository.read_refused")).toEqual([{ type: "repository.read_refused", actor_id: "system", task_id: null, reason: "provider_credential_failed" }]);
  });

  it("treats a token that can't be had as the room's credential failing, and never as a pull request that's gone", async () => {
    const r = await approved();
    await settle(r.id);
    const link = () => inRoom(r.id, (sql) => sql.exec("SELECT read_failures, reads_not_before FROM repo_link").one() as any);
    // The installation is gone, so asking for a token answers 404, far more often than would unwatch a change. Then the
    // key is refused. No pull request was ever asked about.
    let failures = 0;
    for (const status of [404, 404, 404, 404, 404, 404, 401, 403]) {
      await fake({ mint: status });
      await inRoom(r.id, (sql) => sql.exec("UPDATE repo_link SET reads_not_before = ?", Date.now() - 1));
      await nudge(r.id);
      failures += 1;
      const want = failures;
      await afterPass(r.id, async () => expect((await link()).read_failures).toBe(want));
      await settle(r.id);
    }
    expect(await reads()).toHaveLength(2);
    expect(await change(r.id, r.task)).toMatchObject({ unwatched_at: null, not_found_reads: 0, read_failures: 0, pr_state: "open", reviewed_commit_sha: HEAD });
    expect((await events(r.id)).filter((e) => e.type === "task_change.unwatched")).toEqual([]);
    expect(await events(r.id, "repository.read_refused")).toEqual([{ type: "repository.read_refused", actor_id: "system", task_id: null, reason: "provider_credential_failed" }]);
    expect((await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`)).change.watched).toBe(true);
    // A token request that fails some other way is that change's own failed read, and the room doesn't wait.
    // The fake's answer first, then the room's wait lifted: its own alarm may read at once.
    await fake({ mint: 500 });
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_link SET read_failures = 0, reads_not_before = NULL"));
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).read_failures).toBe(1));
    expect(await link()).toEqual({ read_failures: 0, reads_not_before: null });
    expect(await change(r.id, r.task)).toMatchObject({ unwatched_at: null, not_found_reads: 0 });
    // Put right, the change is read again once its own wait is over.
    await fake({ mint: 201 });
    await pull(7, { head_sha: HEAD2 });
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET read_at = ?", Date.now() - 60_001));
    await nudge(r.id);
    await afterPass(r.id, async () => expect(await change(r.id, r.task)).toMatchObject({ observed_head_sha: HEAD2, read_failures: 0 }));
  });

  it("doesn't read for a task that's back with its agent, a room whose repository isn't ready, or a room with the switch off", async () => {
    const r = await submitted();
    await settle(r.id);
    const before = (await reads()).length;
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_link SET status = 'suspended'"));
    await nudge(r.id);
    await alarm(r.id, 2);
    await inRoom(r.id, (sql) => { sql.exec("UPDATE repo_link SET status = 'ready'"); sql.exec("DROP TABLE test_managed_repositories_on"); });
    await alarm(r.id, 2);
    await inRoom(r.id, (sql) => { sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)"); sql.exec("CREATE TABLE test_no_agent_app (x INTEGER)"); });
    await alarm(r.id, 2);
    await inRoom(r.id, (sql) => sql.exec("DROP TABLE test_no_agent_app"));
    await must(OWNER, "POST", `/v1/workspaces/${r.id}/tasks/${r.task}/request-changes`, { submission_no: 1, reason: "More" });
    await nudge(r.id);
    await alarm(r.id, 2);
    expect((await reads()).length).toBe(before);
  });
});

describe("who is shown a task's change", () => {
  it("shows it and its events to people who see the task and to its assignee and reviewer, and to no other agent, guest or public page", async () => {
    const r = await approved();
    await settle(r.id);
    // Something observed, so the task has events about its change beyond the link.
    await pull(7, { head_sha: HEAD2 });
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).commit_changed_at).toBeGreaterThan(0));
    await must(OWNER, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: GUEST.id, kind: "person", org_id: ORG, role: "guest", policy_version: await version(r.id) }, { claims: { target_member: { person: GUEST.id, orgs: { [ORG]: 1 } } } });
    /** What a caller gets of the change: the object, its events in the task's history, and its events in the room's activity. */
    const seenBy = async (who: Who, task = r.task) => {
      const got = await api(who, "GET", `/v1/workspaces/${r.id}/tasks/${task}`);
      if (got.status !== 200) return got.status;
      const history = (got.body.history as any[]).filter((e) => e.type.startsWith("task_change.")).length;
      const activity = ((await must(who, "GET", `/v1/workspaces/${r.id}/activity?task=${task}`)).events as any[]).filter((e) => e.type.startsWith("task_change.")).length;
      return { change: got.body.change !== null, history: history > 0, activity: activity > 0 };
    };
    const shown = { change: true, history: true, activity: true };
    const hidden = { change: false, history: false, activity: false };
    // The owner, who reviews it; an admin; and the agent it's assigned to.
    expect([await seenBy(OWNER), await seenBy(ADMIN), await seenBy(AGENT)]).toEqual([shown, shown, shown]);
    // Another agent in the room reads the task, and gets none of it.
    expect(await seenBy(OTHER)).toEqual(hidden);
    // A guest person and a public-claim participant don't see the task at all, and someone outside doesn't see the room.
    expect([await seenBy(GUEST), await seenBy(PUBLIC), await seenBy(OUTSIDER)]).toEqual([404, 404, 404]);
    // As the task's requester each of them may read it, and still gets none of its change.
    for (const who of [GUEST, PUBLIC]) {
      await inRoom(r.id, (sql) => sql.exec("UPDATE task SET requester_id = ? WHERE id = ?", who.id, r.task));
      expect(await seenBy(who), who.id).toEqual(hidden);
    }
    await inRoom(r.id, (sql) => sql.exec("UPDATE task SET requester_id = ? WHERE id = ?", OWNER.id, r.task));
    // A public-claim participant sees the change of a task that's its own to do, and a guest person one it reviews.
    const own = await accepted(r.id, PUBLIC);
    await pull(8);
    expect((await submit(PUBLIC, r.id, own.task, { version: own.version, commit_sha: HEAD, pr_number: 8 })).status).toBe(200);
    expect(await seenBy(PUBLIC, own.task)).toEqual(shown);
    expect(await seenBy(PUBLIC)).toBe(404);
    await inRoom(r.id, (sql) => sql.exec("UPDATE task SET reviewer_id = ? WHERE id = ?", GUEST.id, own.task));
    expect(await seenBy(GUEST, own.task)).toEqual(shown);
    // Nothing of it is in the task list, for anyone.
    const listed = JSON.stringify(await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks`));
    for (const part of ["pr_number", HEAD, HEAD2, "task_change"]) expect(listed).not.toContain(part);
    // Nor on the room's public page, once the room is public.
    const on = { headers: { "x-test-public-rooms": "on" } };
    expect((await api(OWNER, "PUT", `/v1/workspaces/${r.id}/review-policy`, { require_person: true, policy_version: await version(r.id) })).status).toBe(200);
    const hash = (await must(OWNER, "GET", `/v1/workspaces/${r.id}/visibility`)).view_hash;
    const published = await api(OWNER, "PUT", `/v1/workspaces/${r.id}/visibility`, { visibility: "public", view_hash: hash }, on);
    expect(published.status, published.text).toBe(200);
    await alarm(r.id, 3);
    const now = Math.floor(Date.now() / 1000);
    const anyone = await new SignJWT({ kind: "public" }).setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setAudience("podster-api").setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
    const page = await SELF.fetch(`https://api.internal/v1/public/workrooms/${published.body.public_handle}`, { headers: { "x-podster-assertion": anyone, "x-test-public-rooms": "on" } });
    const text = await page.text();
    expect(page.status, text).toBe(200);
    for (const part of ["pr_number", HEAD, HEAD2, "task_change", "commit_changed", String(REPO_ID)]) expect(text, part).not.toContain(part);
  });
});

describe("what's kept and logged", () => {
  it("keeps and logs nothing a pull request contains, no token, and IDs and statuses only (M5-13)", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const r = await approved();
    await settle(r.id);
    const answers: string[] = [];
    // A second task, refused in several ways, then a read whose token GitHub won't take back, then failed reads.
    const second = await accepted(r.id, OTHER);
    await pull(30, { base_ref: "SECRET-BASE-BRANCH" });
    answers.push((await submit(OTHER, r.id, second.task, { version: second.version, commit_sha: HEAD, pr_number: 30 })).text);
    await pull(31, {});
    await fake({ revoke: 500 });
    answers.push((await submit(OTHER, r.id, second.task, { version: second.version, commit_sha: HEAD, pr_number: 31 })).text);
    await fake({ revoke: 204 });
    // The first task's pull request moves to a branch that isn't the default, then GitHub fails, then it merges.
    await pull(7, { head_sha: HEAD2, base_ref: "SECRET-BASE-BRANCH" });
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).observed_head_sha).toBe(HEAD2));
    expect(await change(r.id, r.task)).toMatchObject({ base_ref: null });
    expect((await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`)).change).toMatchObject({ base_is_default: false, head_in_repository: true });
    await fake({ pullRead: 500 });
    const failedBefore = (await reads()).filter((read) => read.status === 500).length;
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await reads()).filter((read) => read.status === 500).length).toBeGreaterThan(failedBefore));
    await settle(r.id);
    await fake({ pullRead: 200 });
    await pull(7, { head_sha: HEAD2, merged: true, merge_commit_sha: MERGE, merged_by: 31337 });
    // The failed reads left a wait. It's over.
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET read_at = ?", Date.now() - 3_600_001));
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).pr_state).toBe("merged"));
    answers.push(JSON.stringify(await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`)));
    answers.push(JSON.stringify(await must(OWNER, "GET", `/v1/workspaces/${r.id}/events`)));

    const stored = await inRoom(r.id, (sql) => {
      const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'").toArray().map((t: any) => t.name as string);
      return JSON.stringify(Object.fromEntries(tables.map((table) => [table, sql.exec(`SELECT * FROM ${table}`).toArray()])));
    });
    const d1Tables = (await BINDINGS.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((t: any) => t.name);
    const d1 = JSON.stringify(await Promise.all(d1Tables.filter((t: string) => !t.startsWith("_cf") && !t.startsWith("sqlite")).map((t: string) => BINDINGS.DB.prepare(`SELECT * FROM ${t}`).all())));
    const tokens = (await minted()).map((token) => token.token.slice("ghs_fake_".length));
    expect(tokens.length).toBeGreaterThanOrEqual(5);
    for (const [where, text] of [["room", stored], ["D1", d1], ["answers", answers.join("\n")], ["logs", lines.join("\n")]] as const) {
      // The fake's title, body, branch names, labels, author and error text all say SECRET.
      expect(text, where).not.toContain("SECRET");
      for (const token of tokens) expect(text, where).not.toContain(token);
    }
    // What this step logs: the room's and the task's IDs, and a status.
    const mine = lines.filter((line) => line.includes('"task_change.')).map((line) => JSON.parse(line));
    expect(mine.map((line) => line.event)).toEqual(expect.arrayContaining(["task_change.token_unrevoked", "task_change.read_failed"]));
    for (const line of mine) {
      expect(Object.keys(line).sort().filter((name) => !["event", "ws", "task", "status"].includes(name))).toEqual([]);
      expect(line.ws).toBe(r.id);
      expect([r.task, second.task]).toContain(line.task);
    }
    // The one token GitHub wouldn't take back is the only one still live, and it could only read.
    const live = (await minted()).filter((token) => token.live);
    expect(live.map((token) => token.permissions)).toEqual([READ_ONLY]);
  });
});

describe("a task's release status (M5 step 8)", () => {
  const status = (who: Who, id: string, task: string) => api(who, "GET", `/v1/workspaces/${id}/tasks/${task}/release-status`);
  /** Every read of a commit's checks made of this test's repository, with what the token could do. */
  const checkReads = async () => ((await (await fetch(`https://github-fake.example.com/merge-calls?repo=${REPO_ID}`)).json()) as { calls: { path: string; permissions: object; status: number }[] }).calls.filter((c) => /\/commits\//.test(c.path));
  const CHECKS = { checks: "read", metadata: "read", statuses: "read" };

  it("reports checks and merge apart, each with its own time, from what the room holds, and that no release exists (M5-12)", async () => {
    const r = await approved();
    await settle(r.id);
    // Nothing read of the checks yet, and no merge asked for: said as that, never as a pass.
    const first = await status(OWNER, r.id, r.task);
    expect(first.status, first.text).toBe(200);
    const row = await change(r.id, r.task);
    expect(first.body).toEqual({
      task_id: r.task, linked: true,
      pull_request: { pr_number: 7, pr_state: "open", pr_observed_at: row.pr_observed_at, reviewed_commit_sha: HEAD, observed_head_sha: HEAD, head_observed_at: row.head_observed_at, commit_changed: false },
      checks: { state: null, counts: null, observed_at: null },
      merge: { state: "not_requested", reason: null, observed_at: null, sha: null, requested_by: null },
      release: { exists: false },
    });
    // The refresh reads the head's checks where the App has been given them: a failed status, a passing run, one still running.
    await inRoom(r.id, (sql) => sql.exec("CREATE TABLE test_reads_checks (x INTEGER)"));
    await fake({ checks: { statuses: ["success", "failure"], runs: [["completed", "success"], ["in_progress", null]] } });
    const before = Date.now();
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).checks_state).toBe("failure"));
    expect((await checkReads()).map((c) => [c.path, c.permissions, c.status])).toEqual([[`/repositories/${REPO_ID}/commits/${HEAD}/status`, CHECKS, 200], [`/repositories/${REPO_ID}/commits/${HEAD}/check-runs`, CHECKS, 200]]);
    expect((await minted()).every((token) => !token.live)).toBe(true);
    expect((await events(r.id)).at(-1)).toEqual({ type: "task_change.checks_observed", actor_id: "system", task_id: r.task, reason: "failure" });
    // A merge that succeeded, recorded as the merge job records it: the failed check stays a failed check beside it.
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET merge_state = 'succeeded', merge_sha = ?, merge_requested_by = ?, merge_requested_at = 80, merge_finished_at = 90, pr_state = 'merged'", MERGE, ADMIN.id));
    const reads = (await checkReads()).length;
    const both = (await status(OWNER, r.id, r.task)).body;
    expect(both.checks).toEqual({ state: "failure", counts: { success: 2, failure: 1, pending: 1 }, observed_at: expect.any(Number) });
    expect(both.checks.observed_at).toBeGreaterThanOrEqual(before);
    expect(both.merge).toEqual({ state: "succeeded", reason: null, observed_at: 90, sha: MERGE, requested_by: ADMIN.id });
    expect(both.release).toEqual({ exists: false });
    // And a failed merge beside passing checks.
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET merge_state = 'failed', merge_reason = 'commit_changed', merge_sha = NULL, merge_finished_at = 95, checks_state = 'success'"));
    const failed = (await status(OWNER, r.id, r.task)).body;
    expect([failed.checks.state, failed.merge.state, failed.merge.reason, failed.merge.observed_at]).toEqual(["success", "failed", "commit_changed", 95]);
    // Reading it asked GitHub for nothing.
    expect((await checkReads()).length).toBe(reads);
    // Nothing a check carries but its state is kept, shown or logged.
    const stored = JSON.stringify(await change(r.id, r.task)) + JSON.stringify(both) + JSON.stringify(await events(r.id));
    expect(stored).not.toContain("SECRET");
  });

  it("reads no checks until the App that reads has been given them, and keeps what it held when a read fails", async () => {
    const r = await submitted();
    await settle(r.id);
    await fake({ checks: { statuses: ["success"] } });
    await nudge(r.id);
    await alarm(r.id, 2);
    expect(await checkReads()).toEqual([]);
    expect((await status(OWNER, r.id, r.task)).body.checks).toEqual({ state: null, counts: null, observed_at: null });
    await inRoom(r.id, (sql) => sql.exec("CREATE TABLE test_reads_checks (x INTEGER)"));
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).checks_state).toBe("success"));
    const held = (await change(r.id, r.task)).checks_observed_at;
    // GitHub fails the next read: the state and its older time stay.
    await fake({ checksRead: 500, checks: { statuses: ["failure"] } });
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const failedBefore = (await checkReads()).filter((c) => c.status === 500).length;
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await checkReads()).filter((c) => c.status === 500).length).toBeGreaterThan(failedBefore));
    await settle(r.id);
    expect(await change(r.id, r.task)).toMatchObject({ checks_state: "success", checks_observed_at: held });
    const logged = lines.filter((line) => line.includes("task_change.checks_read_failed")).map((line) => JSON.parse(line));
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(Object.keys(line).sort()).toEqual(["event", "status", "task", "ws"]);
    expect(lines.join("\n")).not.toContain("SECRET");
    // A commit with nothing on it reads as none, not as a pass.
    await fake({ checksRead: 200, checks: { statuses: [], runs: [] } });
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET read_at = ?, read_failures = 0", Date.now() - 3_600_001));
    await nudge(r.id);
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).checks_state).toBe("none"));
    expect((await status(OWNER, r.id, r.task)).body.checks).toMatchObject({ state: "none", counts: { success: 0, failure: 0, pending: 0 } });
  });

  it("is for those shown the task's change and for whoever asked for the merge, and hides a task that's hidden", async () => {
    const r = await approved();
    const seen = async (who: Who) => {
      const got = await status(who, r.id, r.task);
      return [got.status, got.code ?? "ok"];
    };
    // The owner, who reviews it; an admin; the agent it's assigned to.
    for (const who of [OWNER, ADMIN, AGENT]) expect(await seen(who), who.id).toEqual([200, "ok"]);
    // Another agent reads the task and isn't shown its change. Once it has asked for the merge, it may read how that went.
    expect(await seen(OTHER)).toEqual([403, "not_allowed"]);
    await inRoom(r.id, (sql) => sql.exec("UPDATE task_change SET merge_requested_by = ?", OTHER.id));
    expect(await seen(OTHER)).toEqual([200, "ok"]);
    // A public-claim participant who can't see the task, a task that doesn't exist, and someone outside the room.
    const hidden = await status(PUBLIC, r.id, r.task);
    const missing = await status(PUBLIC, r.id, "tsk_missing");
    expect([hidden.status, hidden.text]).toEqual([missing.status, missing.text]);
    expect(hidden.code).toBe("task_not_found");
    expect((await status(OUTSIDER, r.id, r.task)).code).toBe("workspace_not_found");
    // A task with no pull request on record answers with nothing observed.
    const plain = await accepted(r.id);
    await inRoom(r.id, (sql) => sql.exec("UPDATE task SET has_linked_repository = 0 WHERE id = ?", plain.task));
    expect((await status(OWNER, r.id, plain.task)).body).toEqual({ task_id: plain.task, linked: false, pull_request: null, checks: { state: null, counts: null, observed_at: null }, merge: { state: "not_requested", reason: null, observed_at: null, sha: null, requested_by: null }, release: { exists: false } });
  });

  it("doesn't exist with managed repositories off: it answers exactly as a read that was never there", async () => {
    const r = await approved();
    await inRoom(r.id, (sql) => sql.exec("DROP TABLE test_managed_repositories_on"));
    for (const who of [OWNER, AGENT, OTHER, PUBLIC]) {
      const got = await status(who, r.id, r.task);
      const none = await api(who, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}/no-such-read`);
      expect([got.status, got.text], who.id).toEqual([none.status, none.text]);
    }
    expect((await status(OWNER, r.id, r.task)).code).toBe("not_found");
    // And nothing reads checks while it's off.
    await inRoom(r.id, (sql) => sql.exec("CREATE TABLE test_reads_checks (x INTEGER)"));
    await nudge(r.id);
    await alarm(r.id, 2);
    expect(await checkReads()).toEqual([]);
  });
});

describe("the room migration", () => {
  it("adds the read bookkeeping to a room made before it, and keeps what was there", async () => {
    const r = await submitted();
    await settle(r.id);
    const newest = await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version as number);
    await inRoom(r.id, (sql) => {
      // M5 step 7b's merge bookkeeping, the newest migration, comes off first.
      sql.exec("DROP TABLE merge_request");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_finished_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_called_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_mark_set_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_marked_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_step");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_next_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_attempts");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_requester_person");
      sql.exec("ALTER TABLE task_change DROP COLUMN submitter_person");
      sql.exec("ALTER TABLE task_change DROP COLUMN submitter_id");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE repo_read");
      for (const column of ["pr_draft", "commit_changed_at", "unwatched_at", "not_found_reads", "read_failures", "merged_by_id", "unchanged_reads", "read_at", "observed_base_sha"]) sql.exec(`ALTER TABLE task_change DROP COLUMN ${column}`);
      for (const column of ["reads_not_before", "read_failures"]) sql.exec(`ALTER TABLE repo_link DROP COLUMN ${column}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    // What GitHub will say is set before the request that migrates the room: with no read on record the change is due
    // one at once, and the room's own alarm may make it before this test's next line.
    await pull(7, { head_sha: HEAD2 });
    await must(OWNER, "GET", `/v1/workspaces/${r.id}`);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version)).toBe(newest);
    // That read may already have happened, which fills the read's columns in. These are there either way.
    expect(await change(r.id, r.task)).toMatchObject({ pr_number: 7, read_failures: 0, not_found_reads: 0, unwatched_at: null, commit_changed_at: null, merged_by_id: null });
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT read_failures, reads_not_before FROM repo_link").one())).toEqual({ read_failures: 0, reads_not_before: null });
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT name FROM pragma_table_info('repo_read')").toArray().map((c: any) => c.name))).toEqual(["at", "kind", "caller"]);
    // A change with no read on record is due one.
    await afterPass(r.id, async () => expect((await change(r.id, r.task)).observed_head_sha).toBe(HEAD2));
  });
});
