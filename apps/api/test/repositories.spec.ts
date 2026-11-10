import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// M5 step 2: the room's state for managed repositories, and the three task routes, which are listed and refuse. Nothing
// here reaches a provider, and no token exists. Rows are written straight into the room where a test needs one, because
// nothing in the API can make one yet.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OWNER: Who = { id: "per_rp_owner", kind: "person", org: "org_rp", adminOrgs: ["org_rp"] };
const MEMBER: Who = { id: "agt_rp_member", org: "org_rp" };
const ASSIGNEE: Who = { id: "agt_rp_assignee", org: "org_rp" };
const GUEST: Who = { id: "agt_rp_guest", org: "org_rp" };
const STRANGER: Who = { id: "agt_rp_stranger", org: "org_rp_x" };
const orgAdmin = (org: string): Who => ({ id: `per_rp_admin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }) })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, options: { key?: string | null } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json" };
  if (method !== "GET" && options.key !== null) headers["idempotency-key"] = options.key ?? `rp-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, text };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [MEMBER, ASSIGNEE, GUEST, STRANGER]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;

/** A room with a member who sees everything and two guests who see only their own tasks, one of them on the task. */
async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
  for (const [who, role] of [[MEMBER, "member"], [ASSIGNEE, "guest"], [GUEST, "guest"]] as const) {
    const r = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: who.org, role, policy_version: await version(id) });
    expect(r.status, `add ${who.id}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  const task = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Add the parser", instructions: "Write it.", assignee: ASSIGNEE.id });
  expect(task.status, JSON.stringify(task.body)).toBe(200);
  return { id, task: task.body.id as string };
}

const TABLES = ["repo_request", "repo_link", "provider_grant", "task_change"];
const COMMIT = "a1".repeat(20);
const REPO_ID = 987654321;

/** A linked repository, as provisioning will record one. */
const link = (id: string, status = "ready") => inRoom(id, (sql) => {
  sql.exec("DELETE FROM repo_link");
  sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/engineering', 'public', 'main', ?, ?, 1000, 2000, 2000)", REPO_ID, status, OWNER.id);
});

/** The three task routes, each as its own call. */
const ROUTES = [
  { name: "get_repo_access", call: (who: Who, id: string, task: string, body: unknown = {}) => api(who, "POST", `/v1/workspaces/${id}/tasks/${task}/repo-access`, body, { key: null }) },
  { name: "merge_task", call: (who: Who, id: string, task: string, body: unknown = { submission_no: 1, commit_sha: COMMIT }) => api(who, "POST", `/v1/workspaces/${id}/tasks/${task}/merge`, body) },
  { name: "get_task_release_status", call: (who: Who, id: string, task: string) => api(who, "GET", `/v1/workspaces/${id}/tasks/${task}/release-status`) },
];

/** Everything a command could have left behind. The outbox empties on its own, and holds nothing without an event. */
const footprint = (id: string) => inRoom(id, (sql) => ({
  events: sql.exec("SELECT count(*) AS n FROM event").one().n,
  stored: sql.exec("SELECT count(*) AS n FROM idempotency").one().n,
  audit: sql.exec("SELECT count(*) AS n FROM audit_event").one().n,
  rows: TABLES.map((table) => sql.exec(`SELECT count(*) AS n FROM ${table}`).one().n),
}));

describe("the managed repositories migration", () => {
  const columns = (id: string, table: string) => inRoom(id, (sql) => sql.exec(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).toArray().map((c: any) => c.name));
  const schemaVersion = (id: string) => inRoom(id, (sql) => sql.exec("SELECT version FROM schema_version").one().version as number);

  it("adds the four tables to a room made before it, keeps what the room held, and does nothing the second time", async () => {
    const { id, task } = await room();
    const newest = await schemaVersion(id);
    // Back to the release before this one: the tables are gone, and the migration is due.
    await inRoom(id, (sql) => {
      for (const table of [...TABLES].reverse()) sql.exec(`DROP TABLE ${table}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    expect(await inRoom(id, (sql) => sql.exec("SELECT name FROM sqlite_master WHERE name IN ('repo_request', 'repo_link', 'provider_grant', 'task_change')").toArray())).toEqual([]);
    // A read migrates the room.
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    expect(await schemaVersion(id)).toBe(newest);
    expect(await columns(id, "repo_request")).toEqual(["id", "singleton", "state", "name", "visibility", "attempt", "provider_name", "provider_repo_id", "reason", "requested_by", "requested_at", "updated_at"]);
    expect(await columns(id, "repo_link")).toEqual(["id", "singleton", "request_id", "provider", "provider_repo_id", "provider_org_id", "full_name", "visibility", "default_branch", "status", "status_reason", "created_by", "created_at", "verified_at", "updated_at"]);
    expect(await columns(id, "provider_grant")).toEqual(["id", "principal_id", "provider", "provider_repo_id", "action", "delegated_by", "created_at", "expires_at", "revoked_at", "revoked_by"]);
    expect(await columns(id, "task_change")).toEqual(["task_id", "provider_repo_id", "pr_number", "submission_no", "reviewed_commit_sha", "observed_head_sha", "head_observed_at", "checks_state", "checks_json", "checks_observed_at", "merge_state", "merge_reason", "merge_sha", "merge_requested_by", "merge_requested_at", "merge_observed_at", "created_at", "updated_at"]);
    // Nothing is made up for a room that never asked for a repository, and what it held is as it was.
    expect((await footprint(id)).rows).toEqual([0, 0, 0, 0]);
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/tasks/${task}`)).body.task).toMatchObject({ id: task, title: "Add the parser", assignee: ASSIGNEE.id });
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/repository`)).body).toEqual({ request: null, repository: null });
    // A migrated room doesn't migrate again: a row written since is still there after reads and a write.
    await link(id);
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/name`, { name: "Engineering two", policy_version: await version(id) })).status).toBe(200);
    expect(await schemaVersion(id)).toBe(newest);
    expect((await footprint(id)).rows).toEqual([0, 1, 0, 0]);
  });

  it("gives a new room the same tables, empty", async () => {
    const { id } = await room();
    expect(await inRoom(id, (sql) => sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('repo_request', 'repo_link', 'provider_grant', 'task_change') ORDER BY name").toArray().map((t: any) => t.name))).toEqual([...TABLES].sort());
    expect((await footprint(id)).rows).toEqual([0, 0, 0, 0]);
  });

  it("holds one request and one repository a room, one live grant per action, and one change per pull request", async () => {
    const { id, task } = await room();
    const refused = (statement: string, ...values: unknown[]) => inRoom(id, (sql) => {
      try { sql.exec(statement, ...values); return false; } catch { return true; }
    });
    const request = "INSERT INTO repo_request (id, state, name, visibility, requested_by, requested_at, updated_at) VALUES (?, 'pending', 'engineering', 'public', 'per_x', 1, 1)";
    expect(await refused(request, "rr_1")).toBe(false);
    expect(await refused(request, "rr_2")).toBe(true);
    await link(id);
    expect(await refused("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, updated_at) VALUES ('rl_2', 'rr_1', 'github', 5, 4242, 'podsterx/other', 'public', 'main', 'ready', 'per_x', 1, 1)")).toBe(true);
    const grant = "INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at, revoked_at) VALUES (?, ?, 'github', ?, ?, 'per_x', 1, ?)";
    expect(await refused(grant, "pg_1", ASSIGNEE.id, REPO_ID, "push", null)).toBe(false);
    expect(await refused(grant, "pg_2", ASSIGNEE.id, REPO_ID, "push", null)).toBe(true);
    // Another action, another principal, and a grant after a revoked one are each their own row.
    expect(await refused(grant, "pg_3", ASSIGNEE.id, REPO_ID, "merge", null)).toBe(false);
    expect(await refused(grant, "pg_4", MEMBER.id, REPO_ID, "push", null)).toBe(false);
    expect(await refused(grant, "pg_5", GUEST.id, REPO_ID, "push", 5)).toBe(false);
    expect(await refused(grant, "pg_6", GUEST.id, REPO_ID, "push", null)).toBe(false);
    const change = "INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)";
    expect(await refused(change, task, REPO_ID, 7)).toBe(false);
    expect(await refused(change, task, REPO_ID, 8)).toBe(true);
    expect(await refused(change, "tsk_other", REPO_ID, 7)).toBe(true);
    expect(await inRoom(id, (sql) => sql.exec("SELECT merge_state FROM task_change").one().merge_state)).toBe("not_requested");
  });
});

describe("the room's repository read", () => {
  it("answers from the room's own state, for those who see the whole room", async () => {
    const { id } = await room();
    for (const who of [OWNER, MEMBER]) expect((await api(who, "GET", `/v1/workspaces/${id}/repository`)).body, who.id).toEqual({ request: null, repository: null });
    await inRoom(id, (sql) => sql.exec("INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, reason, requested_by, requested_at, updated_at) VALUES ('rr_1', 'failed', 'engineering', 'public', 2, 'engineering-7f3a', 'name_taken', ?, 1000, 1500)", OWNER.id));
    await link(id, "degraded");
    const read = await api(MEMBER, "GET", `/v1/workspaces/${id}/repository`);
    expect(read.status, read.text).toBe(200);
    // Exactly the contract's fields: the organization's ID, the name sent to the provider and the attempt count stay in the room.
    expect(read.body).toEqual({
      request: { id: "rr_1", state: "failed", name: "engineering", visibility: "public", reason: "name_taken", requested_by: OWNER.id, requested_at: 1000, updated_at: 1500 },
      repository: { id: "rl_1", provider: "github", provider_repo_id: REPO_ID, full_name: "podsterx/engineering", visibility: "public", default_branch: "main", status: "degraded", status_reason: null, created_at: 1000, verified_at: 2000, updated_at: 2000 },
    });
  });

  it("tells nobody else anything", async () => {
    const { id } = await room();
    await link(id);
    for (const who of [ASSIGNEE, GUEST]) {
      const read = await api(who, "GET", `/v1/workspaces/${id}/repository`);
      expect([read.status, read.code], who.id).toEqual([403, "not_allowed"]);
      expect(read.text).not.toContain("podsterx");
    }
    const outside = await api(STRANGER, "GET", `/v1/workspaces/${id}/repository`);
    expect([outside.status, outside.code]).toEqual([404, "workspace_not_found"]);
    expect(outside.text).not.toContain("podsterx");
    // It's a read: no other method is a route.
    for (const method of ["POST", "PUT", "DELETE"]) expect((await api(OWNER, method, `/v1/workspaces/${id}/repository`, {})).code, method).toBe("not_found");
  });
});

describe("get_repo_access, merge_task and get_task_release_status, listed and not built", () => {
  it("refuse with repo_not_ready in a room with no ready repository, and write nothing", async () => {
    const { id, task } = await room();
    const before = await footprint(id);
    for (const route of ROUTES) {
      for (const who of [OWNER, MEMBER, ASSIGNEE]) {
        const answer = await route.call(who, id, task);
        expect([answer.status, answer.code], `${route.name} as ${who.id}`).toEqual([409, "repo_not_ready"]);
        expect(answer.body).toEqual({ error: { code: "repo_not_ready", message: "repo_not_ready" } });
      }
    }
    // A link that isn't ready, or whose status can't be read, is no better than none.
    for (const status of ["degraded", "suspended", "pending", "READY", ""]) {
      await link(id, status);
      for (const route of ROUTES) expect((await route.call(ASSIGNEE, id, task)).code, `${route.name} with ${status}`).toBe("repo_not_ready");
    }
    await inRoom(id, (sql) => sql.exec("DELETE FROM repo_link"));
    expect(await footprint(id)).toEqual(before);
  });

  it("still refuse in a room whose repository is ready, with no token, no merge and nothing written", async () => {
    const { id, task } = await room();
    await link(id);
    const before = await footprint(id);
    for (const route of ROUTES) {
      const answer = await route.call(ASSIGNEE, id, task);
      expect([answer.status, answer.code], route.name).toEqual([503, "managed_repositories_unavailable"]);
      expect(answer.body).toEqual({ error: { code: "managed_repositories_unavailable", message: "managed_repositories_unavailable" } });
    }
    expect(await footprint(id)).toEqual(before);
    // A refused merge stores no answer, so the same key is refused again once the link changes, by the room's state then.
    const first = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks/${task}/merge`, { submission_no: 1, commit_sha: COMMIT }, { key: "rp-merge-retry" });
    expect(first.code).toBe("managed_repositories_unavailable");
    await link(id, "suspended");
    const again = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks/${task}/merge`, { submission_no: 1, commit_sha: COMMIT }, { key: "rp-merge-retry" });
    expect(again.code).toBe("repo_not_ready");
  });

  it("answer someone who can't see the task as for a task that doesn't exist, whatever the repository's state", async () => {
    const { id, task } = await room();
    const answers: string[] = [];
    for (const status of [null, "ready", "degraded"]) {
      if (status) await link(id, status);
      for (const route of ROUTES) {
        // A guest who isn't on the task, a task that doesn't exist, and someone outside the room.
        const hidden = await route.call(GUEST, id, task);
        const missing = await route.call(GUEST, id, "tsk_nope");
        expect([hidden.status, hidden.code], `${route.name} hidden, ${status}`).toEqual([404, "task_not_found"]);
        expect(hidden.body, `${route.name} hidden against missing, ${status}`).toEqual(missing.body);
        const outside = await route.call(STRANGER, id, task);
        expect([outside.status, outside.code], `${route.name} outside, ${status}`).toEqual([404, "workspace_not_found"]);
        answers.push(hidden.text, outside.text);
      }
    }
    // One answer each, the same in every state, and none names the repository.
    expect(new Set(answers).size).toBe(2);
    for (const text of answers) expect(text).not.toMatch(/podsterx|repo_|987654321/);
    // A hidden task answers the same whatever the body holds, so its shape can't be probed either.
    const probing = await ROUTES[1].call(GUEST, id, task, { repository_id: 1 });
    expect(probing.code).toBe("task_not_found");
  });

  it("take no organization, installation, repository or pull request from the caller (M5-04)", async () => {
    const { id, task } = await room();
    await link(id);
    const selectors = [{ organization: "podsterdev" }, { org_id: 1 }, { installation_id: 1 }, { repository_id: 1 }, { provider_repo_id: 1 }, { repo: "podsterdev/other" }, { full_name: "podsterdev/other" }, { pr_number: 7 }, { pull_request: 7 }, { permissions: { administration: "write" } }];
    for (const extra of selectors) {
      const access = await ROUTES[0].call(ASSIGNEE, id, task, extra);
      expect([access.status, access.code], `get_repo_access ${JSON.stringify(extra)}`).toEqual([400, "invalid_argument"]);
      const merge = await ROUTES[1].call(OWNER, id, task, { submission_no: 1, commit_sha: COMMIT, ...extra });
      expect([merge.status, merge.code], `merge_task ${JSON.stringify(extra)}`).toEqual([400, "invalid_argument"]);
    }
    // A merge names its submission and a full commit ID, and nothing looser.
    for (const body of [{}, { submission_no: 1 }, { commit_sha: COMMIT }, { submission_no: 0, commit_sha: COMMIT }, { submission_no: "1", commit_sha: COMMIT }, { submission_no: 1, commit_sha: "main" }, { submission_no: 1, commit_sha: "a1b2c3d" }, { submission_no: 1, commit_sha: COMMIT.toUpperCase() }]) {
      expect((await ROUTES[1].call(OWNER, id, task, body)).code, JSON.stringify(body)).toBe("invalid_argument");
    }
    expect((await ROUTES[1].call(OWNER, id, task, { submission_no: 1, commit_sha: "0f".repeat(32) })).code).toBe("managed_repositories_unavailable");
    // The path holds a room and a task and nothing else.
    for (const path of [`/tasks/${task}/repo-access/1`, `/tasks/${task}/merge/7`, `/repository/1`, `/repositories`]) {
      expect((await api(OWNER, "POST", `/v1/workspaces/${id}${path}`, {})).code, path).toBe("not_found");
    }
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/tasks/${task}/release-status/7`)).code).toBe("not_found");
  });

  it("keep merge_task a keyed command, get_repo_access keyless, and both closed in an archived room", async () => {
    const { id, task } = await room();
    const unkeyed = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks/${task}/merge`, { submission_no: 1, commit_sha: COMMIT }, { key: null });
    expect([unkeyed.status, unkeyed.code]).toEqual([400, "idempotency_key_required"]);
    expect((await ROUTES[0].call(ASSIGNEE, id, task)).code).toBe("repo_not_ready");
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    for (const route of ROUTES.slice(0, 2)) expect((await route.call(OWNER, id, task)).code, route.name).toBe("workspace_archived");
    // An archived room still reads.
    expect((await ROUTES[2].call(OWNER, id, task)).code).toBe("repo_not_ready");
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/repository`)).status).toBe(200);
  });
});
