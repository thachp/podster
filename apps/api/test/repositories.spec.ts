import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// M5 step 2: the room's state for managed repositories, and the person-only read of it. Nothing here reaches a provider,
// no token exists, and no token, merge or status route exists either. Rows are written straight into the room where a test needs one, because
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

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }), ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, options: { key?: string | null; claims?: object; raw?: string } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, options.claims), "content-type": "application/json" };
  if (method !== "GET" && options.key !== null) headers["idempotency-key"] = options.key ?? `rp-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : options.raw ?? JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, text, headers: [...res.headers.entries()] };
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
  // Managed repositories switched on for this room. While they're off the read isn't there (see "while switched off").
  await inRoom(id, (sql) => sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)"));
  for (const [who, role] of [[MEMBER, "member"], [ASSIGNEE, "guest"], [GUEST, "guest"]] as const) {
    const r = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: who.org, role, policy_version: await version(id) });
    expect(r.status, `add ${who.id}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  const task = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Add the parser", instructions: "Write it.", assignee: ASSIGNEE.id });
  expect(task.status, JSON.stringify(task.body)).toBe(200);
  return { id, task: task.body.id as string };
}

const TABLES = ["repo_request", "repo_request_attempt", "repo_link", "provider_grant", "task_change"];
const COMMIT = "a1".repeat(20);
const REPO_ID = 987654321;

/** A linked repository, as provisioning will record one. */
const link = (id: string, status = "ready") => inRoom(id, (sql) => {
  sql.exec("DELETE FROM repo_link");
  sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/engineering', 'public', 'main', ?, ?, 1000, 2000, 2000)", REPO_ID, status, OWNER.id);
});

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

  it("adds the five tables to a room made before it, keeps what the room held, and does nothing the second time", async () => {
    const { id, task } = await room();
    const newest = await schemaVersion(id);
    // Back to the release before this one: the tables are gone, and the migration is due. Step 5's migration and step
    // 4's came after it and change three of these tables, so they're undone with it and run again behind it, and so is
    // step 6's, which comes after them all.
    await inRoom(id, (sql) => {
      // M5 step 7a's read bookkeeping, the newest migration, comes off first.
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
      sql.exec("ALTER TABLE repo_link DROP COLUMN reads_not_before");
      sql.exec("ALTER TABLE repo_link DROP COLUMN read_failures");
      sql.exec("ALTER TABLE task_change DROP COLUMN pr_draft");
      sql.exec("ALTER TABLE task_change DROP COLUMN commit_changed_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN unwatched_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN not_found_reads");
      sql.exec("ALTER TABLE task_change DROP COLUMN read_failures");
      sql.exec("ALTER TABLE task_change DROP COLUMN merged_by_id");
      sql.exec("ALTER TABLE task_change DROP COLUMN unchanged_reads");
      sql.exec("ALTER TABLE task_change DROP COLUMN read_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN observed_base_sha");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE repo_token_mint");
      sql.exec("DROP TABLE repo_token");
      sql.exec("DROP TABLE provider_delivery");
      for (const table of [...TABLES].reverse()) sql.exec(`DROP TABLE ${table}`);
      sql.exec("UPDATE schema_version SET version = version - 4");
    });
    expect(await inRoom(id, (sql) => sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'repo_%' OR name IN ('provider_grant', 'task_change')").toArray())).toEqual([]);
    // A read migrates the room.
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    expect(await schemaVersion(id)).toBe(newest);
    expect(await columns(id, "repo_request")).toEqual(["id", "singleton", "state", "name", "visibility", "attempt", "provider_name", "provider_repo_id", "reason", "requested_by", "requested_at", "updated_at", "runs", "retry_after", "job_failures", "job_not_before"]);
    expect(await columns(id, "repo_request_attempt")).toEqual(["request_id", "attempt", "provider_name", "outcome", "at"]);
    expect(await columns(id, "repo_link")).toEqual(["id", "singleton", "request_id", "provider", "provider_repo_id", "provider_org_id", "full_name", "visibility", "default_branch", "status", "status_reason", "created_by", "created_at", "verified_at", "updated_at", "indexed_at", "read_failures", "reads_not_before"]);
    expect(await columns(id, "provider_grant")).toEqual(["id", "principal_id", "provider", "provider_repo_id", "action", "delegated_by", "created_at", "expires_at", "revoked_at", "revoked_by"]);
    expect(await columns(id, "task_change")).toEqual(["task_id", "provider_repo_id", "pr_number", "submission_no", "reviewed_commit_sha", "observed_head_sha", "head_observed_at", "checks_state", "checks_json", "checks_observed_at", "merge_state", "merge_reason", "merge_sha", "merge_requested_by", "merge_requested_at", "merge_observed_at", "created_at", "updated_at", "head_repo_id", "base_ref", "reviewed_base_sha", "merge_base_sha", "pr_state", "pr_observed_at", "nudged_at", "observed_base_sha", "read_at", "unchanged_reads", "merged_by_id", "read_failures", "not_found_reads", "unwatched_at", "commit_changed_at", "pr_draft", "submitter_id", "submitter_person", "merge_requester_person", "merge_attempts", "merge_next_at", "merge_step", "merge_marked_at", "merge_mark_set_at", "merge_called_at", "merge_finished_at"]);
    // Nothing is made up for a room that never asked for a repository, and what it held is as it was.
    expect((await footprint(id)).rows).toEqual([0, 0, 0, 0, 0]);
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/tasks/${task}`)).body.task).toMatchObject({ id: task, title: "Add the parser", assignee: ASSIGNEE.id });
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/repository`)).body).toEqual({ request: null, repository: null, delegated: true, may_request: true });
    // A migrated room doesn't migrate again: a row written since is still there after reads and a write.
    await link(id);
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/name`, { name: "Engineering two", policy_version: await version(id) })).status).toBe(200);
    expect(await schemaVersion(id)).toBe(newest);
    expect((await footprint(id)).rows).toEqual([0, 0, 1, 0, 0]);
  });

  it("gives a new room the same tables, empty", async () => {
    const { id } = await room();
    expect(await inRoom(id, (sql) => sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'repo_%' OR name IN ('provider_grant', 'task_change')) ORDER BY name").toArray().map((t: any) => t.name))).toEqual([...TABLES, "repo_read", "repo_token", "repo_token_mint"].sort());
    expect((await footprint(id)).rows).toEqual([0, 0, 0, 0, 0]);
  });

  it("holds one request and one repository a room, one live grant per action, and one change per pull request", async () => {
    const { id, task } = await room();
    const refused = (statement: string, ...values: unknown[]) => inRoom(id, (sql) => {
      try { sql.exec(statement, ...values); return false; } catch { return true; }
    });
    const request = "INSERT INTO repo_request (id, state, name, visibility, requested_by, requested_at, updated_at) VALUES (?, 'pending', 'engineering', 'public', 'per_x', 1, 1)";
    expect(await refused(request, "rr_1")).toBe(false);
    expect(await refused(request, "rr_2")).toBe(true);
    // Each creation call keeps its own name, so a retry under a new one doesn't lose the earlier, possibly orphaned, name.
    const attempt = "INSERT INTO repo_request_attempt (request_id, attempt, provider_name, outcome, at) VALUES ('rr_1', ?, ?, 'uncertain', 1)";
    expect(await refused(attempt, 1, "engineering")).toBe(false);
    expect(await refused(attempt, 2, "engineering-7f3a")).toBe(false);
    expect(await refused(attempt, 2, "engineering-9c1d")).toBe(true);
    expect(await inRoom(id, (sql) => sql.exec("SELECT provider_name FROM repo_request_attempt ORDER BY attempt").toArray().map((a: any) => a.provider_name))).toEqual(["engineering", "engineering-7f3a"]);
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
    expect(await inRoom(id, (sql) => sql.exec("SELECT merge_state, checks_state, pr_state, head_repo_id, base_ref, reviewed_base_sha, merge_base_sha, pr_observed_at FROM task_change").one())).toEqual({ merge_state: "not_requested", checks_state: null, pr_state: null, head_repo_id: null, base_ref: null, reviewed_base_sha: null, merge_base_sha: null, pr_observed_at: null });
  });
});

describe("the room's repository read", () => {
  it("answers a person who sees the whole room from the room's own state", async () => {
    const { id } = await room();
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/repository`)).body).toEqual({ request: null, repository: null, delegated: true, may_request: true });
    await inRoom(id, (sql) => sql.exec("INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, reason, requested_by, requested_at, updated_at) VALUES ('rr_1', 'failed', 'engineering', 'public', 2, 'engineering-7f3a', 'name_taken', ?, 1000, 1500)", OWNER.id));
    await link(id, "degraded");
    const read = await api(OWNER, "GET", `/v1/workspaces/${id}/repository`);
    expect(read.status, read.text).toBe(200);
    // Exactly the contract's fields: the organization's ID, the name sent to the provider and the attempt number stay in
    // the room. What's said of attempts is how many setup runs are left, and `delegated` is the owner's alone.
    expect(read.body).toEqual({
      request: { id: "rr_1", state: "failed", name: "engineering", visibility: "public", reason: "name_taken", requested_by: OWNER.id, requested_at: 1000, updated_at: 1500, attempts_left: 5 },
      repository: { id: "rl_1", provider: "github", provider_repo_id: REPO_ID, full_name: "podsterx/engineering", visibility: "public", default_branch: "main", status: "degraded", status_reason: null, created_at: 1000, verified_at: 2000, updated_at: 2000 },
      delegated: true,
      may_request: true,
    });
  });

  it("tells nobody else anything", async () => {
    const { id } = await room();
    await link(id);
    // It's person-only: an agent is refused even when it sees the whole room, as a member does.
    for (const who of [MEMBER, ASSIGNEE, GUEST]) {
      const read = await api(who, "GET", `/v1/workspaces/${id}/repository`);
      expect([read.status, read.code], who.id).toEqual([403, "not_allowed"]);
      expect(read.text).not.toContain("podsterx");
    }
    const outside = await api(STRANGER, "GET", `/v1/workspaces/${id}/repository`);
    expect([outside.status, outside.code]).toEqual([404, "workspace_not_found"]);
    expect(outside.text).not.toContain("podsterx");
    // It's a read. Step 4 made POST the owner's request for a repository, and there's no PUT or DELETE.
    for (const method of ["PUT", "DELETE"]) expect((await api(OWNER, method, `/v1/workspaces/${id}/repository`, {})).code, method).toBe("not_found");
  });
});

describe("while managed repositories are switched off", () => {
  const off = (id: string) => inRoom(id, (sql) => sql.exec("DROP TABLE test_managed_repositories_on"));
  const PERSON: Who = { id: "per_rp_member", kind: "person", org: "org_rp" };
  /** The same request to a route that doesn't exist, which is what every managed-repository route must look like. */
  const missing = (who: Who, method: string, id: string, body: unknown, raw?: string) => api(who, method, `/v1/workspaces/${id}/no-such-route`, body, { raw });
  const same = (a: Awaited<ReturnType<typeof api>>, b: Awaited<ReturnType<typeof api>>, label: string) =>
    expect([a.status, a.body, a.headers], label).toEqual([b.status, b.body, b.headers]);
  const routes = (id: string, grant: string, task: string) => [
    ["GET", `/v1/workspaces/${id}/repository`, undefined],
    ["GET", `/v1/workspaces/${id}/repository/grants`, undefined],
    ["POST", `/v1/workspaces/${id}/repository`, { name: "engineering", visibility: "public" }],
    ["POST", `/v1/workspaces/${id}/repository/retry`, {}],
    ["POST", `/v1/workspaces/${id}/repository/grants`, { policy_version: 1, principal_id: MEMBER.id, action: "push" }],
    ["DELETE", `/v1/workspaces/${id}/repository/grants/${grant}`, { policy_version: 1 }],
    ["POST", `/v1/workspaces/${id}/tasks/${task}/repo-access`, {}],
  ] as const;
  /** A room with a person member too, so a person who isn't the owner is asked as well. */
  async function offRoom(rows: boolean) {
    const r = await room();
    const added = await api(OWNER, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: PERSON.id, kind: "person", org_id: "org_rp", role: "member", policy_version: await version(r.id) }, { claims: { target_member: { person: PERSON.id, orgs: { org_rp: 1 } } } });
    expect(added.status, added.text).toBe(200);
    if (rows) {
      // What an earlier on-period could have left: a request, a link and a grant.
      await inRoom(r.id, (sql) => sql.exec("INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, reason, requested_by, requested_at, updated_at, runs) VALUES ('rr_1', 'failed', 'engineering', 'public', 2, 'engineering-7f3a', 'name_taken', ?, 1000, 1500, 2)", OWNER.id));
      await link(r.id);
      await inRoom(r.id, (sql) => sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pg_1', ?, 'github', ?, 'push', ?, 1000)", MEMBER.id, REPO_ID, OWNER.id));
    }
    await off(r.id);
    return r;
  }
  const callers = () => [OWNER, PERSON, orgAdmin("org_rp"), MEMBER, ASSIGNEE, GUEST, STRANGER];

  it("answers every repository route as a missing one, status, body and headers, for everyone, rows or none", async () => {
    for (const rows of [false, true]) {
      const { id, task } = await offRoom(rows);
      const before = await footprint(id);
      for (const who of callers()) {
        for (const [method, path, body] of routes(id, rows ? "pg_1" : "pg_none", task)) {
          const answer = await api(who, method, path, body);
          same(answer, await missing(who, method, id, body), `${who.id} ${method} ${path} rows=${rows}`);
          expect(answer.text).not.toContain("podsterx");
          expect(answer.text).not.toContain("engineering");
        }
      }
      // Nothing was recorded, refused into the audit or replayed: a missing route leaves nothing behind either.
      expect(await footprint(id)).toEqual(before);
    }
  });

  it("answers a malformed body as a missing route does, and in an archived room too", async () => {
    const { id, task } = await offRoom(true);
    for (const who of callers()) {
      for (const [method, path] of routes(id, "pg_1", task).filter(([method]) => method !== "GET")) {
        const answer = await api(who, method, path, undefined, { raw: "{not json" });
        same(answer, await missing(who, method, id, undefined, "{not json"), `${who.id} ${method} ${path} malformed`);
      }
    }
    // Archived: a missing route is still a missing route there.
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    for (const who of callers()) {
      for (const [method, path, body] of routes(id, "pg_1", task)) {
        same(await api(who, method, path, body), await missing(who, method, id, body), `${who.id} ${method} ${path} archived`);
      }
    }
  });

  it("answers again, as before, once it's switched back on, with the rows the room kept", async () => {
    const { id } = await room();
    await link(id);
    await off(id);
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/repository`)).code).toBe("not_found");
    await inRoom(id, (sql) => sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)"));
    const read = await api(OWNER, "GET", `/v1/workspaces/${id}/repository`);
    expect(read.status).toBe(200);
    expect(read.body.repository).toMatchObject({ id: "rl_1", status: "ready" });
  });

  it("leaves `change` out of a task read, for a task that got one while it was on", async () => {
    const { id, task } = await room();
    await link(id);
    await inRoom(id, (sql) => sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, created_at, updated_at) VALUES (?, ?, 7, 1, 1000, 1000)", task, REPO_ID));
    const on = await api(OWNER, "GET", `/v1/workspaces/${id}/tasks/${task}`);
    expect(on.body.change).toMatchObject({ provider_repo_id: REPO_ID, pr_number: 7 });
    await off(id);
    for (const who of [OWNER, ASSIGNEE]) {
      const read = await api(who, "GET", `/v1/workspaces/${id}/tasks/${task}`);
      expect(read.status, read.text).toBe(200);
      expect(read.body, who.id).not.toHaveProperty("change");
      expect(read.body.task.id).toBe(task);
    }
  });
});

describe("what the read says to whom", () => {
  it("gives `delegated` to the room's owner and admins, true until an operator takes it back, and absent for anyone else", async () => {
    const { id } = await room();
    const admin = orgAdmin("org_rp");
    const member: Who = { id: "per_rp_plain_member", kind: "person", org: "org_rp" };
    await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: admin.id, kind: "person", org_id: "org_rp", role: "admin", policy_version: await version(id) }, { claims: { target_member: { person: admin.id, orgs: { org_rp: 1 } } } });
    await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: member.id, kind: "person", org_id: "org_rp", role: "member", policy_version: await version(id) }, { claims: { target_member: { person: member.id, orgs: { org_rp: 1 } } } });
    // No record for the organization: it holds the delegation, and the owner and an admin are both told so.
    for (const who of [OWNER, admin]) {
      const read = await api(who, "GET", `/v1/workspaces/${id}/repository`);
      expect([read.status, read.body], who.id).toEqual([200, { request: null, repository: null, delegated: true, may_request: true }]);
    }
    // A person who sees the whole room and doesn't run its repository is told nothing about the delegation.
    const theirs = await api(member, "GET", `/v1/workspaces/${id}/repository`);
    expect(theirs.status, theirs.text).toBe(200);
    expect(theirs.body).toEqual({ request: null, repository: null, may_request: false });
    expect(theirs.text).not.toContain("delegated");
  });

  it("leaves `delegated` out when the organization's record can't be read: unknown isn't false", async () => {
    const { id } = await room();
    await inRoom(id, (sql) => sql.exec("CREATE TABLE test_delegation_unreadable (x INTEGER)"));
    const read = await api(OWNER, "GET", `/v1/workspaces/${id}/repository`);
    expect(read.status, read.text).toBe(200);
    expect(read.body).toEqual({ request: null, repository: null, may_request: true });
    await inRoom(id, (sql) => sql.exec("DROP TABLE test_delegation_unreadable"));
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/repository`)).body).toHaveProperty("delegated", true);
  });

  it("goes by current standing: a recorded owner who left the organization has only what their member row gives", async () => {
    const { id } = await room();
    // The room has heard its owner left the organization, and still records them as owner until recovery. With no
    // member row they have no place in the room at all.
    await inRoom(id, (sql) => void sql.exec("UPDATE workspace SET owner_left_at = ?", Date.now()));
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/repository`)).status).toBe(404);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/repository`, { name: "engineering", visibility: "public" })).status).toBe(404);
    // As a plain member by their own row, they can't ask, and nothing they read says `delegated`.
    await inRoom(id, (sql) => void sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', 'org_rp', 'member', ?, 0)", OWNER.id, OWNER.id));
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/repository`)).text).not.toContain("delegated");
    const asked = await api(OWNER, "POST", `/v1/workspaces/${id}/repository`, { name: "engineering", visibility: "public" });
    expect([asked.status, asked.code]).toEqual([403, "not_allowed"]);
    // A member row whose role began before their current membership of the organization gives nothing either: a role
    // ends when its holder leaves, and rejoining doesn't restore it.
    await inRoom(id, (sql) => void sql.exec("UPDATE member SET role = 'admin' WHERE principal_id = ?", OWNER.id));
    const rejoined = await api(OWNER, "POST", `/v1/workspaces/${id}/repository`, { name: "engineering", visibility: "public" }, { claims: { org_since: { org_rp: 5 } } });
    expect(rejoined.status).toBe(404);
    expect(await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM repo_request").one().n)).toBe(0);
  });

  it("counts attempts left from the room's runs, down to 0 at the cap and never below", async () => {
    const { id } = await room();
    await inRoom(id, (sql) => sql.exec("INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, reason, requested_by, requested_at, updated_at) VALUES ('rr_1', 'failed', 'engineering', 'public', 1, 'engineering', 'name_taken', ?, 1000, 1500)", OWNER.id));
    const left: number[] = [];
    for (const runs of [0, 1, 4, 5, 9]) {
      await inRoom(id, (sql) => sql.exec("UPDATE repo_request SET runs = ?", runs));
      left.push((await api(OWNER, "GET", `/v1/workspaces/${id}/repository`)).body.request.attempts_left);
    }
    expect(left).toEqual([5, 4, 1, 0, 0]);
  });
});

describe("the routes later steps build", () => {
  it("don't exist yet, so nothing can ask for a merge or a status, and a token only with the switch on (step 6)", async () => {
    const { id, task } = await room();
    await link(id);
    await inRoom(id, (sql) => sql.exec("DROP TABLE test_managed_repositories_on"));
    for (const [method, tail] of [["POST", "repo-access"], ["POST", "merge"], ["GET", "release-status"]] as const) {
      const answer = await api(OWNER, method, `/v1/workspaces/${id}/tasks/${task}/${tail}`, { submission_no: 1, commit_sha: COMMIT });
      expect([answer.status, answer.code], tail).toEqual([404, "not_found"]);
    }
    const contract: { path: string; operation: string }[] = JSON.parse(BINDINGS.TEST_API_ROUTES);
    // Step 7b added the merge route, which answers as above while the switch is off. Nothing for a release or a deploy.
    expect(contract.filter((r) => /merge|release-status|deploy/i.test(r.path + r.operation)).map((r) => r.operation).sort()).toEqual(["getTaskReleaseStatus", "mergeTask"]);
    expect(contract.filter((r) => /repo-access/i.test(r.path)).map((r) => r.operation)).toEqual(["getRepoAccess"]);
  });
});
