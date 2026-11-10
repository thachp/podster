import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// M5 step 4: provisioning a room's managed repository. Every GitHub call lands on test/fake-github.ts, which the test
// runtime puts in place of the network, so nothing here or in CI reaches GitHub. The fake checks the App's JWT and the
// installation token as GitHub would, and a test scripts how it misbehaves.

const BINDINGS = env as any;
const GH = JSON.parse(BINDINGS.TEST_FAKE_GITHUB) as { orgLogin: string; orgId: number; provisionAppId: number; installationId: number; mergeAppId: number };
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OPERATOR: Who = { id: "per_operator_one", kind: "person", org: "org_podster", adminOrgs: [] };
const AGENT: Who = { id: "agt_pv_member", org: "org_pv_agents" };
const STRANGER: Who = { id: "per_pv_stranger", kind: "person", org: "org_pv_else", adminOrgs: ["org_pv_else"] };

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
  if (method !== "GET" && options.key !== null) headers["idempotency-key"] = options.key ?? `pv-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined, text };
}

type Call = { method: string; path: string; body: any; auth: string };
const fake = async (path: string, body?: unknown) => (await fetch(`https://github-fake.example.com${path}`, { method: "POST", body: JSON.stringify(body ?? {}) })).json() as Promise<any>;
const github = async () => (await fake("/state")) as { calls: Call[]; repos: any[] };
const calls = async () => (await github()).calls.map((c) => `${c.method} ${c.path}`);
/** Calls that change something at GitHub. */
const writes = async () => (await github()).calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/access_tokens"));

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion({ id: "per_pv_agents_admin", kind: "person", org: AGENT.org, adminOrgs: [AGENT.org] }) }, body: JSON.stringify({ org_id: AGENT.org, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register: ${res.status}`);
});
afterEach(() => vi.restoreAllMocks());

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const delegate = (org: string, granted = true, by: Who = OPERATOR) => api(by, "PUT", `/v1/orgs/${org}/provisioning-delegation`, { granted });

let orgs = 0;
/** A room in an organization of its own, whose owner is `owner`. `delegated` gives the organization the delegation. `script` resets the fake. */
async function room(options: { delegated?: boolean; script?: object } = {}) {
  await fake("/reset", options.script ?? {});
  const org = `org_pv_${++orgs}_${crypto.randomUUID().slice(0, 8)}`;
  const owner: Who = { id: `per_pv_owner_${orgs}`, kind: "person", org, adminOrgs: [org] };
  const id: string = (await api(owner, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
  if (options.delegated !== false) expect((await delegate(org)).status).toBe(200);
  return { id, org, owner };
}
/** An agent of the room's own organization, added to the room as a member. */
async function memberAgent(r: { id: string; org: string; owner: Who }) {
  const agent: Who = { id: `agt_pv_${crypto.randomUUID().slice(0, 8)}`, org: r.org };
  const registered = await SELF.fetch(`https://api.internal/v1/agents/${agent.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(r.owner) }, body: JSON.stringify({ org_id: r.org, name: agent.id }) });
  expect(registered.status).toBe(200);
  const policy = (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version;
  const added = await api(r.owner, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: agent.id, kind: "agent", org_id: r.org, role: "member", policy_version: policy });
  expect(added.status, added.text).toBe(200);
  return agent;
}
const ask = (r: { id: string; owner: Who }, body: unknown = { name: "engineering", visibility: "public" }, options: { key?: string | null; who?: Who } = {}) =>
  api(options.who ?? r.owner, "POST", `/v1/workspaces/${r.id}/repository`, body, options);
const retry = (r: { id: string; owner: Who }, who?: Who) => api(who ?? r.owner, "POST", `/v1/workspaces/${r.id}/repository/retry`, {});
const read = async (r: { id: string; owner: Who }) => (await api(r.owner, "GET", `/v1/workspaces/${r.id}/repository`)).body as { request: any; repository: any };
/** Lets the room's alarm run the job until the request is no longer pending. */
async function settled(r: { id: string; owner: Who }) {
  for (let i = 0; i < 80; i++) {
    await runDurableObjectAlarm(stub(r.id));
    const now = await read(r);
    if (now.request && now.request.state !== "pending") return now;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the request stayed pending");
}
const rowsOf = (id: string, table: string) => inRoom(id, (sql) => sql.exec(`SELECT * FROM ${table}`).toArray() as any[]);
const eventTypes = (id: string) => inRoom(id, (sql) => sql.exec("SELECT type FROM event ORDER BY seq").toArray().map((e: any) => e.type as string));
const indexRow = async (repo: number) => (await BINDINGS.DB.prepare("SELECT workspace_id FROM repo_room_index WHERE provider = 'github' AND provider_repo_id = ?").bind(repo).first())?.workspace_id ?? null;

describe("the organization's provisioning delegation", () => {
  it("is given and taken back by a Podster operator, and nobody else", async () => {
    const org = `org_pv_d_${crypto.randomUUID().slice(0, 8)}`;
    const admin: Who = { id: "per_pv_d_admin", kind: "person", org, adminOrgs: [org] };
    const member: Who = { id: "per_pv_d_member", kind: "person", org, adminOrgs: [] };
    const path = `/v1/orgs/${org}/provisioning-delegation`;
    // Nobody has given it.
    expect((await api(admin, "GET", path)).body).toEqual({ provider: "github", granted: false, set_by: null, set_at: null });
    // An organization can't give itself authority over Podster's GitHub organization: not its admin, a member, an agent or a stranger.
    for (const who of [admin, member, AGENT, STRANGER, { ...AGENT, org }]) {
      const refused = await api(who, "PUT", path, { granted: true });
      expect([refused.status, refused.code], who.id).toEqual([403, "not_allowed"]);
    }
    expect((await api(OPERATOR, "GET", path)).body.granted).toBe(false);
    const given = await api(OPERATOR, "PUT", path, { granted: true });
    expect(given.status, given.text).toBe(200);
    expect(given.body).toMatchObject({ provider: "github", granted: true, set_by: OPERATOR.id });
    expect(given.body.set_at).toBeGreaterThan(Date.now() - 60_000);
    // Its admins and operators read it. A member, an agent, and an admin of another organization don't.
    expect((await api(admin, "GET", path)).body).toEqual(given.body);
    for (const who of [member, AGENT, STRANGER]) expect([(await api(who, "GET", path)).status, who.id]).toEqual([403, who.id]);
    // Only `{ granted: boolean }`: an organization, an installation or a provider can't be named.
    for (const bad of [{}, { granted: "yes" }, { granted: true, provider: "gitlab" }, { granted: true, org_id: 1 }, { granted: true, installation_id: 5 }, []]) {
      expect((await api(OPERATOR, "PUT", path, bad)).code, JSON.stringify(bad)).toBe("invalid_argument");
    }
    expect((await api(OPERATOR, "PUT", path, { granted: false })).body).toMatchObject({ granted: false, set_by: OPERATOR.id });
    // Each change is kept, in the organization's own object.
    const log = await runInDurableObject(BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(org)), (_: any, state: any) => state.storage.sql.exec("SELECT provider, granted, set_by FROM org_provider_delegation_log ORDER BY seq").toArray());
    expect(log).toEqual([{ provider: "github", granted: 1, set_by: OPERATOR.id }, { provider: "github", granted: 0, set_by: OPERATOR.id }]);
    expect((await api(OPERATOR, "GET", "/v1/orgs/has%20space/provisioning-delegation")).status).toBe(404);
  });
});

describe("asking for the room's repository", () => {
  it("is refused without the organization's delegation, and no request reaches GitHub (M5-14, AC-10)", async () => {
    const r = await room({ delegated: false });
    const refused = await ask(r);
    expect([refused.status, refused.code]).toEqual([403, "not_delegated"]);
    expect(await rowsOf(r.id, "repo_request")).toEqual([]);
    expect(await eventTypes(r.id)).not.toContain("repository.requested");
    // Given, then taken back: refused again.
    await delegate(r.org, true);
    await delegate(r.org, false);
    expect((await ask(r)).code).toBe("not_delegated");
    // Another organization's delegation is no use to this one.
    const other = await room();
    expect((await ask(r)).code).toBe("not_delegated");
    await runDurableObjectAlarm(stub(r.id));
    expect((await github()).calls).toEqual([]);
    expect(other.org).not.toBe(r.org);
  });

  it("is for the room's owner, as a person, and takes a name and a visibility and nothing else (M5-04)", async () => {
    const r = await room();
    const inside = await memberAgent(r);
    // An agent in the room, an admin of the organization who isn't the owner, the operator, and a stranger.
    const colleague: Who = { id: "per_pv_colleague", kind: "person", org: r.org, adminOrgs: [r.org] };
    for (const [who, status] of [[inside, 403], [OPERATOR, 404], [STRANGER, 404], [colleague, 404], [AGENT, 404]] as const) {
      const refused = await ask(r, undefined, { who });
      expect(refused.status, who.id).toBe(status);
    }
    // A caller can't choose the organization, the installation, the App or the repository's ID.
    for (const extra of [{ org: "another-org" }, { organization: "another-org" }, { installation_id: 1 }, { app_id: 1 }, { provider_repo_id: 5 }, { owner: "someone" }, { provider: "gitlab" }]) {
      const refused = await ask(r, { name: "engineering", visibility: "public", ...extra });
      expect([refused.status, refused.code], JSON.stringify(extra)).toEqual([400, "invalid_argument"]);
    }
    for (const name of ["", ".github", "Engineering", "has space", "a/b", "-lead", "x".repeat(65), "café", 5, null]) {
      expect((await ask(r, { name, visibility: "public" })).code, String(name)).toBe("invalid_argument");
    }
    for (const visibility of ["", "internal", "PUBLIC", null, true]) expect((await ask(r, { name: "engineering", visibility })).code).toBe("invalid_argument");
    expect((await ask(r, { name: "engineering" })).code).toBe("invalid_argument");
    // A private repository can't carry the rules on the organization's plan. It's unavailable, never quietly made public.
    const priv = await ask(r, { name: "engineering", visibility: "private" });
    expect([priv.status, priv.code]).toEqual([409, "private_unavailable"]);
    expect((await ask(r, undefined, { key: null })).status).toBe(400);
    expect(await rowsOf(r.id, "repo_request")).toEqual([]);
    expect((await github()).calls).toEqual([]);
  });

  it("records one request, answers a repeat with the same answer, and refuses a second", async () => {
    const r = await room();
    const first = await ask(r, undefined, { key: "pv-same" });
    expect(first.status, first.text).toBe(200);
    expect(first.body.repository).toBeNull();
    expect(first.body.request).toMatchObject({ state: "pending", name: "engineering", visibility: "public", reason: null, requested_by: r.owner.id });
    const again = await ask(r, undefined, { key: "pv-same" });
    expect(again.body).toEqual(first.body);
    expect(await rowsOf(r.id, "repo_request")).toHaveLength(1);
    expect((await eventTypes(r.id)).filter((t) => t === "repository.requested")).toHaveLength(1);
    // The same key with another body is a conflict, and a new key is a second request.
    expect((await ask(r, { name: "other", visibility: "public" }, { key: "pv-same" })).status).toBe(422);
    const second = await ask(r, { name: "other", visibility: "public" });
    expect([second.status, second.code]).toEqual([409, "repo_request_exists"]);
    const audit = await inRoom(r.id, (sql) => sql.exec("SELECT action, actor_id FROM audit_event WHERE action LIKE 'repository.%'").toArray());
    expect(audit).toEqual([{ action: "repository.requested", actor_id: r.owner.id }]);
    // Let the job finish, so it isn't still talking to the fake when the next test resets it.
    await settled(r);
  });
});

describe("the provisioning job", () => {
  it("creates one repository in the configured organization, sets it up, reads it back and links it by GitHub's ID (M5-01, M5-02)", async () => {
    const r = await room();
    expect((await ask(r)).status).toBe(200);
    const done = await settled(r);
    const { repos, calls: seen } = await github();
    expect(repos).toHaveLength(1);
    const made = repos[0];
    expect(done.request).toMatchObject({ state: "ready", name: "engineering", reason: null });
    // The room is private and the repository is public: the room's visibility decides nothing about it.
    expect((await api(r.owner, "GET", `/v1/workspaces/${r.id}/visibility`)).body.visibility).toBe("private");
    expect(done.repository).toMatchObject({ provider: "github", provider_repo_id: made.id, full_name: `${GH.orgLogin}/engineering`, visibility: "public", default_branch: "main", status: "ready", status_reason: null });
    expect(done.repository.verified_at).toBeGreaterThan(Date.now() - 60_000);
    const [link] = await rowsOf(r.id, "repo_link");
    expect(link).toMatchObject({ provider_repo_id: made.id, provider_org_id: GH.orgId, created_by: r.owner.id });
    // What went to GitHub, in order: one token from a signed App JWT, one creation in the configured organization, a
    // read, the three pieces of setup, and the read that decides.
    const id = made.id;
    const readBack = [`GET /repositories/${id}`, `GET /repositories/${id}/branches/main`, `GET /repositories/${id}/actions/permissions`, `GET /repositories/${id}/rulesets`];
    const two = made.rulesets.map((x: any) => `GET /repositories/${id}/rulesets/${x.id}`);
    expect(seen.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /app/installations/${GH.installationId}/access_tokens`,
      `POST /orgs/${GH.orgLogin}/repos`,
      ...readBack,
      `PUT /repositories/${id}/actions/permissions`, `POST /repositories/${id}/rulesets`, `POST /repositories/${id}/rulesets`,
      ...readBack, ...two,
    ]);
    expect(seen.map((c) => c.auth)).toEqual(["app", ...seen.slice(1).map(() => "token")]);
    expect(seen[1].body).toEqual({ name: "engineering", private: false, auto_init: true });
    // The repository as setup left it: Actions off, and exactly the two rulesets of ADR 0009.
    expect(made.actionsEnabled).toBe(false);
    const [review, update] = made.rulesets;
    expect(review).toMatchObject({ name: "podster-review", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, bypass_actors: [] });
    expect(review.rules.map((x: any) => x.type)).toEqual(["pull_request", "required_status_checks"]);
    expect(review.rules[1].parameters.required_status_checks).toEqual([{ context: "podster/review", integration_id: GH.mergeAppId }]);
    expect(update).toMatchObject({ name: "podster-update", enforcement: "active", bypass_actors: [{ actor_id: GH.mergeAppId, actor_type: "Integration", bypass_mode: "always" }] });
    expect(update.rules).toEqual([{ type: "update" }]);
    // The attempt, the events, the audit, and the routing row once the link is ready.
    expect((await rowsOf(r.id, "repo_request_attempt")).map((a) => [a.attempt, a.provider_name, a.outcome])).toEqual([[1, "engineering", "created"]]);
    expect((await eventTypes(r.id)).filter((t) => t.startsWith("repository."))).toEqual(["repository.requested", "repository.ready"]);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT action FROM audit_event WHERE action LIKE 'repository.%' ORDER BY seq").toArray().map((a: any) => a.action))).toEqual(["repository.requested", "repository.linked"]);
    for (let i = 0; i < 40 && (await indexRow(id)) === null; i++) { await runDurableObjectAlarm(stub(r.id)); await new Promise((x) => setTimeout(x, 50)); }
    expect(await indexRow(id)).toBe(r.id);
    // It doesn't run again: nothing more goes to GitHub, and a retry has nothing to retry.
    await fake("/forget-calls");
    await runDurableObjectAlarm(stub(r.id));
    expect((await github()).calls).toEqual([]);
    expect([(await retry(r)).status, (await retry(r)).code]).toEqual([409, "already_ready"]);
    expect((await ask(r)).code).toBe("repo_request_exists");
  });

  it("makes nothing for a room that doesn't ask", async () => {
    const r = await room();
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.id}/tasks`, { title: "Write the brief", instructions: "Write it." })).status).toBe(200);
    for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub(r.id));
    expect((await github()).calls).toEqual([]);
    expect(await read(r)).toEqual({ request: null, repository: null });
  });

  it("refuses cleanly while the App's key isn't set, and goes on under the chosen name once it is", async () => {
    const r = await room();
    await inRoom(r.id, (sql) => sql.exec("CREATE TABLE test_no_provisioning_key (x INTEGER)"));
    await ask(r);
    const stopped = await settled(r);
    expect(stopped.request).toMatchObject({ state: "failed", reason: "provisioning_not_configured" });
    expect(stopped.repository).toBeNull();
    expect((await github()).calls).toEqual([]);
    expect(await rowsOf(r.id, "repo_request_attempt")).toEqual([]);
    // Still unset: a retry ends the same way, and doesn't loop.
    expect((await retry(r)).body.request.state).toBe("pending");
    expect((await settled(r)).request.reason).toBe("provisioning_not_configured");
    await inRoom(r.id, (sql) => sql.exec("DROP TABLE test_no_provisioning_key"));
    expect((await retry(r)).status).toBe(200);
    expect((await settled(r)).request.state).toBe("ready");
    // No call had carried the chosen name, so it's still the one sent.
    expect((await github()).repos.map((x) => x.name)).toEqual(["engineering"]);
  });

  it("rechecks authority before it calls GitHub: the delegation, the room and the person who asked", async () => {
    const pending = (id: string, by: string) => inRoom(id, (sql) => sql.exec("INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, requested_by, requested_at, updated_at) VALUES ('rr_t', 'pending', 'engineering', 'public', 1, 'engineering', ?, 1, 1)", by));
    const poke = async (r: { id: string; owner: Who }) => { expect((await api(r.owner, "PUT", `/v1/workspaces/${r.id}/name`, { name: "Engineering two", policy_version: (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version })).status).toBe(200); return settled(r); };
    // The delegation was taken back after the request was recorded.
    const undelegated = await room({ delegated: false });
    await pending(undelegated.id, undelegated.owner.id);
    expect((await poke(undelegated)).request).toMatchObject({ state: "failed", reason: "not_delegated" });
    // The person who asked is no longer the room's owner.
    const moved = await room();
    await pending(moved.id, "per_pv_former_owner");
    expect((await poke(moved)).request).toMatchObject({ state: "failed", reason: "requester_not_owner" });
    // The room was archived.
    const archived = await room();
    await pending(archived.id, archived.owner.id);
    await inRoom(archived.id, (sql) => sql.exec("UPDATE workspace SET status = 'archived'"));
    await runDurableObjectAlarm(stub(archived.id));
    for (let i = 0; i < 40 && (await rowsOf(archived.id, "repo_request"))[0].state === "pending"; i++) { await runDurableObjectAlarm(stub(archived.id)); await new Promise((x) => setTimeout(x, 50)); }
    expect((await rowsOf(archived.id, "repo_request"))[0]).toMatchObject({ state: "failed", reason: "room_archived" });
    expect((await github()).calls).toEqual([]);
    for (const r of [undelegated, moved, archived]) expect(await rowsOf(r.id, "repo_request_attempt")).toEqual([]);
  });

  it("treats an unknown creation outcome as a failed setup, adopts nothing by name, and retries under a new server-made name (M5-03)", async () => {
    for (const mode of ["lost", "hang", "error500", "no_id"]) {
      const r = await room({ script: { create: [mode, "ok"] } });
      await ask(r);
      const unknown = await settled(r);
      expect(unknown.request, mode).toMatchObject({ state: "uncertain", reason: "creation_outcome_unknown" });
      expect(unknown.repository).toBeNull();
      expect((await rowsOf(r.id, "repo_request"))[0].provider_repo_id).toBeNull();
      expect((await rowsOf(r.id, "repo_request_attempt")).map((a) => [a.attempt, a.provider_name, a.outcome])).toEqual([[1, "engineering", "uncertain"]]);
      const orphans = (await github()).repos.map((x) => x.id);
      // The job doesn't run again by itself, and nobody looks a repository up by its name.
      await fake("/forget-calls");
      await runDurableObjectAlarm(stub(r.id));
      expect((await github()).calls).toEqual([]);
      const again = await retry(r);
      expect(again.status, again.text).toBe(200);
      const ready = await settled(r);
      expect(ready.request.state, mode).toBe("ready");
      const attempts = await rowsOf(r.id, "repo_request_attempt");
      expect(attempts.map((a) => [a.attempt, a.outcome])).toEqual([[1, "uncertain"], [2, "created"]]);
      expect(attempts[1].provider_name).toMatch(/^engineering-[0-9a-f]{6}$/);
      const { repos, calls: seen } = await github();
      // The linked repository is the one the second call's answer named. Whatever the first call made stays where it is.
      const linked = repos.find((x) => x.name === attempts[1].provider_name);
      expect(ready.repository.provider_repo_id).toBe(linked.id);
      expect(orphans).not.toContain(linked.id);
      for (const orphan of orphans) expect(seen.some((c) => c.path.includes(`/repositories/${orphan}`)), mode).toBe(false);
      expect(seen.filter((c) => c.method === "DELETE" || c.method === "PATCH")).toEqual([]);
      expect(seen.find((c) => c.path.endsWith("/repos"))?.body.name).toBe(attempts[1].provider_name);
      expect(repos.filter((x) => orphans.includes(x.id)).every((x) => x.rulesets.length === 0 && x.actionsEnabled)).toBe(true);
    }
  });

  it("marks an attempt a job died in the middle of as unknown, without sending its call again", async () => {
    const r = await room();
    await inRoom(r.id, (sql) => {
      sql.exec("INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, requested_by, requested_at, updated_at) VALUES ('rr_t', 'pending', 'engineering', 'public', 1, 'engineering', ?, 1, 1)", r.owner.id);
      sql.exec("INSERT INTO repo_request_attempt (request_id, attempt, provider_name, outcome, at) VALUES ('rr_t', 1, 'engineering', 'started', 1)");
    });
    expect((await api(r.owner, "PUT", `/v1/workspaces/${r.id}/name`, { name: "Engineering two", policy_version: (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version })).status).toBe(200);
    expect((await settled(r)).request).toMatchObject({ state: "uncertain", reason: "creation_outcome_unknown" });
    expect((await github()).calls).toEqual([]);
  });

  it("finishes setup on the repository it already holds when the answer did arrive, and makes no second one (M5-03)", async () => {
    const r = await room({ script: { readRepo: 500 } });
    await ask(r);
    const failed = await settled(r);
    expect(failed.request).toMatchObject({ state: "failed", reason: "read_back_failed" });
    expect(failed.repository).toBeNull();
    const [made] = (await github()).repos;
    expect((await rowsOf(r.id, "repo_request"))[0].provider_repo_id).toBe(made.id);
    await fake("/script", { readRepo: null });
    await fake("/forget-calls");
    expect((await retry(r)).status).toBe(200);
    const ready = await settled(r);
    expect(ready.request.state).toBe("ready");
    expect(ready.repository.provider_repo_id).toBe(made.id);
    const { repos, calls: seen } = await github();
    expect(repos).toHaveLength(1);
    expect(seen.filter((c) => c.path.endsWith("/repos"))).toEqual([]);
    expect((await rowsOf(r.id, "repo_request_attempt")).map((a) => [a.attempt, a.provider_name, a.outcome])).toEqual([[1, "engineering", "created"]]);
  });

  it("fails with a reason when GitHub refuses, and a retry never goes back to a name it sent", async () => {
    const taken = await room({ script: { create: ["taken", "ok"] } });
    await ask(taken);
    expect((await settled(taken)).request).toMatchObject({ state: "failed", reason: "name_taken" });
    expect((await rowsOf(taken.id, "repo_request_attempt"))[0].outcome).toBe("name_taken");
    await retry(taken);
    expect((await settled(taken)).request.state).toBe("ready");
    expect((await github()).repos.map((x) => x.name)).toEqual([expect.stringMatching(/^engineering-[0-9a-f]{6}$/)]);

    const forbidden = await room({ script: { create: ["forbidden"] } });
    await ask(forbidden);
    expect((await settled(forbidden)).request).toMatchObject({ state: "failed", reason: "provider_refused" });
    expect((await github()).repos).toEqual([]);

    // No token, no creation call: nothing can have been made.
    const noToken = await room({ script: { token: 401 } });
    await ask(noToken);
    expect((await settled(noToken)).request).toMatchObject({ state: "failed", reason: "provider_refused" });
    expect(await calls()).toEqual([`POST /app/installations/${GH.installationId}/access_tokens`]);

    // A repository that comes back under another owner isn't Podster's, and its ID isn't kept.
    const elsewhere = await room({ script: { create: ["wrong_owner"] } });
    await ask(elsewhere);
    expect((await settled(elsewhere)).request).toMatchObject({ state: "failed", reason: "wrong_owner" });
    expect((await rowsOf(elsewhere.id, "repo_request"))[0].provider_repo_id).toBeNull();
    expect(await writes()).toHaveLength(1);
  });

  it("links nothing unless the read-back is exactly right, for each way it can be wrong", async () => {
    const stray = { id: 7, name: "someone-elses", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, bypass_actors: [], rules: [{ type: "deletion" }], source_type: "Organization" };
    const cases: [string, object, string, number][] = [
      // [what's wrong, the fake's script, the reason, how many setup calls went out]
      ["a ruleset is missing", { ruleset: "drop_review" }, "ruleset_missing", 3],
      ["the other ruleset is missing", { ruleset: "drop_update" }, "ruleset_missing", 3],
      ["a ruleset isn't active", { ruleset: "inactive" }, "ruleset_inactive", 3],
      ["the update ruleset has an extra bypass actor", { ruleset: "extra_bypass" }, "bypass_differs", 3],
      ["the bypass lists can't be seen", { hideBypass: true }, "bypass_differs", 3],
      ["Actions are still on", { disableActions: "ignore" }, "actions_enabled", 3],
      ["Actions can't be read", { actionsRead: 403 }, "actions_unreadable", 0],
      ["a ruleset Podster didn't make is there", { fresh: { rulesets: [stray] } }, "unexpected_ruleset", 0],
      ["the default branch has no commit", { fresh: { hasCommit: false } }, "no_initial_commit", 0],
      ["the repository came back private", { fresh: { private: true } }, "visibility_differs", 0],
      ["the repository is archived", { fresh: { archived: true } }, "archived", 0],
      ["a setup call is refused", { ruleset: "forbidden" }, "setup_call_failed", 2],
      ["switching Actions off is refused", { disableActions: "forbidden" }, "setup_call_failed", 1],
    ];
    for (const [what, script, reason, setupCalls] of cases) {
      const r = await room({ script });
      await ask(r);
      const failed = await settled(r);
      expect(failed.request, what).toMatchObject({ state: "failed", reason });
      expect(failed.repository, what).toBeNull();
      expect(await rowsOf(r.id, "repo_link"), what).toEqual([]);
      const made = (await github()).repos[0];
      expect((await writes()).length - 1, what).toBe(setupCalls);
      expect(await indexRow(made.id), what).toBeNull();
      expect((await eventTypes(r.id)).filter((t) => t.startsWith("repository.")), what).toEqual(["repository.requested", "repository.setup_failed"]);
    }
  });

  it("never repairs a rule that's there and wrong: a retry reads it again and fails again", async () => {
    const r = await room({ script: { ruleset: "inactive" } });
    await ask(r);
    expect((await settled(r)).request.reason).toBe("ruleset_inactive");
    await fake("/script", { ruleset: "ok" });
    await fake("/forget-calls");
    await retry(r);
    expect((await settled(r)).request).toMatchObject({ state: "failed", reason: "ruleset_inactive" });
    // Reads only: nothing was edited, replaced or removed.
    expect(await writes()).toEqual([]);
    // Once someone with authority at GitHub has put it right, the same retry links it.
    const [made] = (await github()).repos;
    await fake("/edit", { id: made.id, patch: { rulesets: made.rulesets.map((x: any) => ({ ...x, enforcement: "active" })) } });
    await retry(r);
    const ready = await settled(r);
    expect(ready.request.state).toBe("ready");
    expect(ready.repository.provider_repo_id).toBe(made.id);
  });

  it("blocks nothing but the repository when setup fails, falls back to no other organization and deletes nothing (M5-15)", async () => {
    const r = await room({ script: { create: ["forbidden"] } });
    await ask(r);
    expect((await settled(r)).request.state).toBe("failed");
    // The room's other work goes on.
    const inside = await memberAgent(r);
    const task = await api(r.owner, "POST", `/v1/workspaces/${r.id}/tasks`, { title: "Write the brief", instructions: "Write it.", assignee: inside.id });
    expect(task.status, task.text).toBe(200);
    const accepted = await api(inside, "POST", `/v1/workspaces/${r.id}/tasks/${task.body.id}/accept`, { version: task.body.version });
    expect(accepted.status, accepted.text).toBe(200);
    const submitted = await api(inside, "POST", `/v1/workspaces/${r.id}/tasks/${task.body.id}/submit`, { version: accepted.body.version, note: "Done.", artifacts: [] });
    expect(submitted.status, submitted.text).toBe(200);
    // Every call went to the configured organization or to a repository it made, and none deleted or edited anything.
    const { calls: seen } = await github();
    expect(seen.filter((c) => c.path.startsWith("/orgs/")).map((c) => c.path)).toEqual([`/orgs/${GH.orgLogin}/repos`]);
    expect(seen.filter((c) => c.method === "DELETE" || c.method === "PATCH")).toEqual([]);
    // An agent can't ask, retry or read, whatever state setup is in.
    expect((await retry(r, inside)).status).toBe(403);
    expect((await api(inside, "GET", `/v1/workspaces/${r.id}/repository`)).status).toBe(403);
  });

  it("refuses a retry that has nothing to retry, or comes from anyone but the owner, or without the delegation", async () => {
    const r = await room({ script: { create: ["forbidden", "ok"] } });
    expect([(await retry(r)).status, (await retry(r)).code]).toEqual([404, "repo_request_not_found"]);
    await ask(r);
    expect((await retry(r)).code).toBe("setup_in_progress");
    await settled(r);
    expect((await retry(r, STRANGER)).status).toBe(404);
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.id}/repository/retry`, { name: "mine" })).code).toBe("invalid_argument");
    await delegate(r.org, false);
    expect((await retry(r)).code).toBe("not_delegated");
    await delegate(r.org, true);
    const again = await api(r.owner, "POST", `/v1/workspaces/${r.id}/repository/retry`, {}, { key: "pv-retry" });
    expect(again.body.request.state).toBe("pending");
    // A repeat of the same retry is the same answer, and doesn't move the attempt on twice.
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.id}/repository/retry`, {}, { key: "pv-retry" })).body).toEqual(again.body);
    expect((await rowsOf(r.id, "repo_request"))[0].attempt).toBe(2);
    expect((await settled(r)).request.state).toBe("ready");
  });

  it("takes a routing row from a room that says the repository isn't its own, and leaves one whose room says it is", async () => {
    const r = await room({ script: { nextId: 61000 } });
    // A stale row, left pointing at a room that was never made.
    await BINDINGS.DB.prepare("INSERT INTO repo_room_index (provider, provider_repo_id, workspace_id) VALUES ('github', 61000, 'ws_pv_never_made')").run();
    await ask(r);
    expect((await settled(r)).repository.provider_repo_id).toBe(61000);
    for (let i = 0; i < 40 && (await indexRow(61000)) !== r.id; i++) { await runDurableObjectAlarm(stub(r.id)); await new Promise((x) => setTimeout(x, 50)); }
    expect(await indexRow(61000)).toBe(r.id);
    expect((await rowsOf(r.id, "repo_link"))[0].indexed_at).toBeGreaterThan(0);
    // A second room that claims the same ID doesn't take the row: the first room confirms it.
    const squatter = await room({ script: { nextId: 62000 } });
    await inRoom(squatter.id, (sql) => sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, updated_at) VALUES ('rl_x', 'rr_x', 'github', 61000, 4242, 'x/y', 'public', 'main', 'ready', 'per_x', 1, 1)"));
    expect((await api(squatter.owner, "PUT", `/v1/workspaces/${squatter.id}/name`, { name: "Squatter", policy_version: (await api(squatter.owner, "GET", `/v1/workspaces/${squatter.id}`)).body.policy_version })).status).toBe(200);
    for (let i = 0; i < 40 && (await rowsOf(squatter.id, "repo_link"))[0].indexed_at === null; i++) { await runDurableObjectAlarm(stub(squatter.id)); await new Promise((x) => setTimeout(x, 50)); }
    expect((await rowsOf(squatter.id, "repo_link"))[0].indexed_at).toBe(0);
    expect(await indexRow(61000)).toBe(r.id);
  });

  it("keeps tokens and keys out of the room, D1 and the logs, and logs IDs and codes only", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const ok = await room();
    await ask(ok);
    await settled(ok);
    const bad = await room({ script: { create: ["forbidden"] } });
    await ask(bad);
    await settled(bad);
    const unknown = await room({ script: { create: ["error500"] } });
    await ask(unknown);
    await settled(unknown);
    const mine = lines.filter((line) => line.includes('"at":"provision"')).map((line) => JSON.parse(line));
    expect(mine).toEqual([
      { at: "provision", room: ok.id, request: expect.stringMatching(/^rr_[0-9a-f]{32}$/), outcome: "ready" },
      { at: "provision", room: bad.id, request: expect.stringMatching(/^rr_/), outcome: "failed", reason: "provider_refused", status: 403 },
      { at: "provision", room: unknown.id, request: expect.stringMatching(/^rr_/), outcome: "uncertain", reason: "creation_outcome_unknown", status: 0 },
    ]);
    // No token, no key, no name, and none of GitHub's own words.
    const secrets = ["ghs_fake_", "BEGIN RSA", "eyJhbGciOiJSUzI1NiI", "SECRET-PROVIDER-TEXT", "SECRET-DESCRIPTION", "engineering", GH.orgLogin];
    for (const line of lines) for (const secret of secrets) expect(line, secret).not.toContain(secret);
    // Nothing the room or D1 stores holds a token or a key either.
    const stored = await inRoom(ok.id, (sql) => {
      const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'").toArray().map((t: any) => t.name as string);
      return JSON.stringify(tables.map((table) => sql.exec(`SELECT * FROM ${table}`).toArray()));
    });
    for (const secret of ["ghs_fake_", "BEGIN RSA", "eyJhbGciOiJSUzI1NiI", "SECRET-PROVIDER-TEXT", "SECRET-DESCRIPTION"]) expect(stored).not.toContain(secret);
    const d1 = JSON.stringify((await BINDINGS.DB.prepare("SELECT * FROM repo_room_index").all()).results);
    expect(d1).not.toContain("ghs_fake_");
    // The events carry types and IDs. The repository's name isn't in one.
    const events = JSON.stringify(await rowsOf(ok.id, "event"));
    expect(events).not.toContain("engineering");
  });
});
