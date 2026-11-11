import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { alarmPass, alarmQuiet } from "./alarm.ts";

// M5 step 6: `get_repo_access`, an agent's short-lived token for the room's repository, against the fake GitHub. Links
// and a task's link to the repository are written straight into the room, as step 5b's tests do: no command marks a
// task as linked yet. Nothing here reaches GitHub.

const BINDINGS = env as any;
const GH = JSON.parse(BINDINGS.TEST_FAKE_GITHUB);
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; linker?: string | null; departure?: object };
const ORG = "org_ra";
const OWNER: Who = { id: "per_ra_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const ADMIN: Who = { id: "per_ra_admin", kind: "person", org: ORG };
const MEMBER: Who = { id: "per_ra_member", kind: "person", org: ORG };
const LINKER = "per_ra_linker";
const AGENT: Who = { id: "agt_ra_agent", org: ORG };
const OTHER: Who = { id: "agt_ra_other", org: ORG };
const PUBLIC: Who = { id: "agt_ra_public", org: ORG };
const OUTSIDER: Who = { id: "agt_ra_outsider", org: ORG };
const orgAdmin: Who = { id: "per_ra_orgadmin", kind: "person", org: ORG, adminOrgs: [ORG] };
/** Each test's own repository, so the fake's state for it is the test's alone while other specs run beside it. */
let REPO_ID = 0;
let nextRepo = 7_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
const PERMISSIONS = { contents: "write", metadata: "read", pull_requests: "write" };

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  const facts = isAgent
    ? { gen: 1, ...(who.linker === null ? {} : { linker: { person: who.linker ?? LINKER, since: 1 } }) }
    : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [], ...(who.departure ? { departure: who.departure } : {}) };
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...facts, ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, options: { key?: string | null; fail?: boolean; claims?: object; raw?: string } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, options.claims), "content-type": "application/json" };
  if (method !== "GET" && options.key !== null) headers["idempotency-key"] = options.key ?? `ra-key-${++counter}`;
  if (options.fail) headers["x-test-fail"] = "1";
  const payload = options.raw ?? (method === "GET" || body === undefined ? undefined : JSON.stringify(body));
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: payload });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, text };
}
const must = async (who: Who, method: string, path: string, body?: unknown, options: { claims?: object } = {}) => {
  const res = await api(who, method, path, body, options);
  if (res.status !== 200) throw new Error(`${method} ${path}: ${res.status} ${res.text}`);
  return res.body;
};

/** The command under test. No idempotency key, as the gateway sends it. */
const access = (who: Who, id: string, task: string, body?: unknown, options: { fail?: boolean; raw?: string } = {}) =>
  api(who, "POST", `/v1/workspaces/${id}/tasks/${task}/repo-access`, body, { key: null, ...options });

/** Every token the agent-token App minted for this test's repository, and whether it's still live. */
const minted = async () => (await (await fetch(`https://github-fake.example.com/agent-tokens?repo=${REPO_ID}`)).json()) as { token: string; live: boolean; repo: unknown; permissions: object; asked: any }[];
/** How the fake answers for this test's repository: `mode` for a mint, `revoke` for a revocation's status. */
const script = (body: { mode?: string; revoke?: number }) => fetch("https://github-fake.example.com/agent-repo", { method: "POST", body: JSON.stringify({ id: REPO_ID, ...body }) });
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
/** A fresh repository for this test, known to the fake's agent-token App. */
const freshRepo = async () => {
  REPO_ID = ++nextRepo;
  await script({});
};

const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version as number;
const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const tokens = (id: string) => inRoom(id, (sql) => sql.exec("SELECT agent_id, task_id, grant_id, provider_repo_id, state, sealed, expires_at FROM repo_token ORDER BY created_at").toArray() as any[]);
const events = (id: string, type: string) => inRoom(id, (sql) => sql.exec("SELECT actor_id, subject_id, task_id FROM event WHERE type = ?", type).toArray() as any[]);
const OLD_KEY = "3c".repeat(32);
const NEW_KEY = "5d".repeat(32);
/** The room's sealing keys from here on, as the Worker's two secrets would give them. Null is unset. */
const setKeys = (id: string, current: string | null, previous: string | null) => inRoom(id, (sql) => {
  sql.exec("CREATE TABLE IF NOT EXISTS test_repo_token_keys (current TEXT, previous TEXT)");
  sql.exec("DELETE FROM test_repo_token_keys");
  sql.exec("INSERT INTO test_repo_token_keys (current, previous) VALUES (?, ?)", current, previous);
});
/** Runs the room's alarm, as the platform would: each run whole, and after any the runtime had under way. */
const alarm = async (id: string, times = 2) => {
  for (let n = 0; n < times; n++) await alarmPass(stub(id));
};
/**
 * Retries a check until it holds, running the room's alarm between tries, for what reaches the room from another object
 * in that object's own time: a departure, or a disconnect.
 */
const eventually = async (id: string, check: () => Promise<void>) => {
  for (let n = 0; ; n++) {
    try {
      return await check();
    } catch (error) {
      if (n >= 30) throw error;
      await alarm(id, 1);
      await new Promise((x) => setTimeout(x, 100));
    }
  }
};

/**
 * The owner leaves the organization, and room `id` has heard by the time this returns. The person's own alarm takes a
 * departure to their rooms: one whole run of it, after any the runtime had under way.
 */
const ownerLeaves = async (id: string) => {
  // The departure finds the room through the listing the room's alarm writes. Written here, so it doesn't wait on that.
  await BINDINGS.DB.prepare("INSERT OR REPLACE INTO membership_index (workspace_id, principal_id, org_id, role, workspace_name, removed, updated_seq) VALUES (?, ?, ?, 'owner', 'Engineering', 0, 1)").bind(id, OWNER.id, ORG).run();
  await must({ ...OWNER, departure: { person: OWNER.id, org: ORG, left_at: Date.now() } }, "POST", "/v1/org-departures", {});
  const person = BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(OWNER.id));
  const heard = () => inRoom(id, (sql) => sql.exec("SELECT owner_left_at AS t FROM workspace").one().t as number | null);
  await runInDurableObject(person, (_: any, state: any) => void state.storage.sql.exec("UPDATE org_departure SET next_sweep_at = 0"));
  await alarmPass(person);
  expect(await heard()).not.toBeNull();
};

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [AGENT, OTHER, PUBLIC, OUTSIDER]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin) }, body: JSON.stringify({ org_id: ORG, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

beforeEach(async () => {
  await freshRepo();
});

afterEach(() => vi.restoreAllMocks());

/** A room with managed repositories switched on, a ready link, the agent holding a push grant, and a linked task
 * assigned to it and accepted. */
async function room(options: { switchedOn?: boolean; grant?: boolean; accept?: boolean; assignee?: Who; linked?: boolean } = {}) {
  const id: string = (await must(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).id;
  await must(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: ADMIN.id, kind: "person", org_id: ORG, role: "admin", policy_version: await version(id) }, { claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } });
  await must(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: MEMBER.id, kind: "person", org_id: ORG, role: "member", policy_version: await version(id) }, { claims: { target_member: { person: MEMBER.id, orgs: { [ORG]: 1 } } } });
  for (const [who, role] of [[AGENT, "member"], [OTHER, "member"], [PUBLIC, "guest"]] as const) {
    await must(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: ORG, role, policy_version: await version(id) });
  }
  await inRoom(id, (sql) => {
    sql.exec("UPDATE member SET joined_via = 'public' WHERE principal_id = ?", PUBLIC.id);
    sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)");
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podster-test-org/engineering', 'public', 'main', 'ready', ?, 1000, 2000, 2000)", REPO_ID, OWNER.id);
  });
  let grant: string | undefined;
  if (options.grant !== false) grant = (await must(OWNER, "POST", `/v1/workspaces/${id}/repository/grants`, { policy_version: await version(id), principal_id: AGENT.id, action: "push" })).id;
  // The grant route is there only while the switch is on, so a room that's off is switched off after its grant.
  if (options.switchedOn === false) await inRoom(id, (sql) => sql.exec("DROP TABLE test_managed_repositories_on"));
  const task = await newTask(id, options.assignee ?? AGENT, options);
  return { id, task, grant: grant! };
}

async function newTask(id: string, assignee: Who, options: { accept?: boolean; linked?: boolean } = {}) {
  const made = await must(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Code", instructions: "Change the code", assignee: assignee.id });
  // A task made in a room with a ready repository is linked (M5 step 7a). The flag is written either way, for a room with the switch off.
  await inRoom(id, (sql) => sql.exec("UPDATE task SET has_linked_repository = ? WHERE id = ?", options.linked !== false ? 1 : 0, made.id));
  if (options.accept === false) return made.id as string;
  await must(assignee, "POST", `/v1/workspaces/${id}/tasks/${made.id}/accept`, { version: made.version });
  return made.id as string;
}

describe("issuing a token", () => {
  it("gives the assigned agent a token for the one repository, with the least it needs, and keeps it only sealed (M5-05, AC-27)", async () => {
    const r = await room();
    const before = Date.now();
    const got = await access(AGENT, r.id, r.task);
    expect(got.status, got.text).toBe(200);
    expect(got.body).toEqual({
      token: expect.stringMatching(/^ghs_fake_/),
      expires_at: expect.any(Number),
      repository: "podster-test-org/engineering",
      clone_url: "https://github.com/podster-test-org/engineering.git",
      permissions: PERMISSIONS,
      authority_ends_at: null,
    });
    expect(got.body.expires_at).toBeGreaterThan(before + 59 * 60_000);
    expect(got.body.expires_at).toBeLessThanOrEqual(Date.now() + 3_600_000);
    // One call to GitHub, as the agent-token App, for exactly this repository and these permissions.
    // The fake mints only for a JWT signed with the agent-token App's own key, for its own installation.
    expect(await minted()).toEqual([{ token: got.body.token, live: true, repo: [REPO_ID], permissions: PERMISSIONS, asked: { repository_ids: [REPO_ID], permissions: PERMISSIONS } }]);
    // The room holds it sealed, bound to the room, repository, grant, agent and task.
    const [held] = await tokens(r.id);
    expect(held).toMatchObject({ agent_id: AGENT.id, task_id: r.task, grant_id: r.grant, provider_repo_id: REPO_ID, state: "held", expires_at: got.body.expires_at });
    expect(held.sealed).toMatch(/^[0-9a-f]+$/);
    expect(held.sealed).not.toContain(got.body.token.slice(9));
    // One event, of IDs, and no idempotency record of the answer.
    const events = await inRoom(r.id, (sql) => sql.exec("SELECT type, actor_id, subject_id, task_id FROM event WHERE type = 'repo_access.issued'").toArray());
    expect(events).toEqual([{ type: "repo_access.issued", actor_id: AGENT.id, subject_id: r.grant, task_id: r.task }]);
    // The agent's accept kept one, as every command does. None holds this answer.
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT response_json FROM idempotency WHERE actor_id = ?", AGENT.id).toArray().map((x: any) => x.response_json))).not.toContainEqual(expect.stringContaining("ghs_"));
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT count(*) AS n FROM idempotency WHERE response_json LIKE '%ghs_%' OR request_hash LIKE '%ghs_%'").one().n)).toBe(0);
  });

  it("issues a token in a room that has its repository when the deployment's list of requesters names nobody in it", async () => {
    // `REPOSITORY_REQUESTERS` bears on asking for a repository and retrying its setup, and on nothing else.
    for (const value of ["per_ra_someone_else", ""]) {
      const r = await room();
      await inRoom(r.id, (sql) => { sql.exec("CREATE TABLE test_repository_requesters (value TEXT)"); sql.exec("INSERT INTO test_repository_requesters VALUES (?)", value); });
      const got = await access(AGENT, r.id, r.task);
      expect([got.status, got.body?.repository], JSON.stringify(value)).toEqual([200, "podster-test-org/engineering"]);
    }
  });

  it("returns the held token again, and only near its expiry mints a new one and revokes the old (M5-07)", async () => {
    const r = await room();
    const first = (await access(AGENT, r.id, r.task)).body;
    const again = await access(AGENT, r.id, r.task);
    expect(again.body).toEqual(first);
    expect(await minted()).toHaveLength(1);
    // Five minutes from its expiry it's replaced, after the same checks.
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_token SET expires_at = ?", Date.now() + 4 * 60_000));
    // GitHub refuses the revocation for now, so the old token's row is still there to read whether or not the runtime
    // has run the alarm that takes it back, which comes due within milliseconds.
    await script({ revoke: 500 });
    const renewed = await access(AGENT, r.id, r.task);
    expect(renewed.status, renewed.text).toBe(200);
    expect(renewed.body.token).not.toBe(first.token);
    expect((await tokens(r.id)).map((t) => t.state).sort()).toEqual(["held", "revoke"]);
    expect(await minted()).toEqual([expect.objectContaining({ token: first.token, live: true }), expect.objectContaining({ token: renewed.body.token, live: true })]);
    await script({ revoke: 204 });
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_token SET revoke_next_at = 0 WHERE state = 'revoke'"));
    await alarm(r.id);
    expect(await minted()).toEqual([expect.objectContaining({ token: first.token, live: false }), expect.objectContaining({ token: renewed.body.token, live: true })]);
    expect((await tokens(r.id)).map((t) => t.state)).toEqual(["held"]);
    // A renewal is refused like a first request once authority ends.
    await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) });
    expect((await access(AGENT, r.id, r.task)).code).toBe("grant_required");
  });

  it("can't mint two live tokens for concurrent calls: one waits for the other's lease", async () => {
    const r = await room();
    await script({ mode: "slow" });
    const [a, b] = await Promise.all([access(AGENT, r.id, r.task), access(AGENT, r.id, r.task)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.code, b.code]).toContain("repo_access_busy");
    expect((await minted()).filter((t) => t.live)).toHaveLength(1);
    // Asked again once the lease is done, the agent gets the one token there is.
    const after = await access(AGENT, r.id, r.task);
    expect(after.body.token).toBe((a.status === 200 ? a : b).body.token);
    expect(await minted()).toHaveLength(1);
  });

  it("keeps one live token per agent and task, and a token per task", async () => {
    const r = await room();
    const second = await newTask(r.id, AGENT);
    const one = (await access(AGENT, r.id, r.task)).body.token;
    const two = (await access(AGENT, r.id, second)).body.token;
    expect(one).not.toBe(two);
    expect((await tokens(r.id)).map((t) => [t.task_id, t.state])).toEqual([[r.task, "held"], [second, "held"]]);
  });
});

describe("refusing", () => {
  /** Every refusal: the code, and that nothing was asked of GitHub. */
  const refusedWith = async (res: Awaited<ReturnType<typeof api>>, status: number, code: string) => {
    expect([res.status, res.code], res.text).toEqual([status, code]);
    expect(res.text).not.toContain("ghs_");
    expect(await minted()).toEqual([]);
  };

  it("refuses without a push grant, with only a merge grant, and with one expired or revoked (M5-05)", async () => {
    const none = await room({ grant: false });
    await refusedWith(await access(AGENT, none.id, none.task), 403, "grant_required");
    await must(OWNER, "POST", `/v1/workspaces/${none.id}/repository/grants`, { policy_version: await version(none.id), principal_id: AGENT.id, action: "merge" });
    await refusedWith(await access(AGENT, none.id, none.task), 403, "grant_required");
    const expired = await room();
    await inRoom(expired.id, (sql) => sql.exec("UPDATE provider_grant SET expires_at = ? WHERE id = ?", Date.now() - 1, expired.grant));
    await refusedWith(await access(AGENT, expired.id, expired.task), 403, "grant_expired");
    const revoked = await room();
    await must(OWNER, "DELETE", `/v1/workspaces/${revoked.id}/repository/grants/${revoked.grant}`, { policy_version: await version(revoked.id) });
    await refusedWith(await access(AGENT, revoked.id, revoked.task), 403, "grant_required");
  });

  it("refuses a grant whose giver no longer holds the delegation, from current authority, not the list's state", async () => {
    const r = await room();
    // The owner leaves the organization. The room's own record is put back to what it was before it heard, so the grant
    // list still says live. That's done once the room has heard, and it takes a departure only once, so the person's
    // alarm can't write it again behind this.
    await ownerLeaves(r.id);
    await inRoom(r.id, (sql) => sql.exec("UPDATE workspace SET owner_left_at = NULL"));
    expect((await api(ADMIN, "GET", `/v1/workspaces/${r.id}/repository/grants`)).body.grants?.[0]?.state ?? "live").toBe("live");
    await refusedWith(await access(AGENT, r.id, r.task), 403, "grant_stale");
    // A grant the room's records say is a past owner's is stale too.
    const moved = await room();
    await inRoom(moved.id, (sql) => sql.exec("UPDATE provider_grant SET delegated_by = 'per_ra_someone_else'"));
    await refusedWith(await access(AGENT, moved.id, moved.task), 403, "grant_stale");
  });

  it("counts an admin's grant only while they're still an admin whose authority holds, from current state", async () => {
    /** A room where a newly added person, an admin, gave the agent its push grant. */
    const givenByAdmin = async (admin: string) => {
      const r = await room({ grant: false });
      const who: Who = { id: admin, kind: "person", org: ORG };
      await must(OWNER, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: admin, kind: "person", org_id: ORG, role: "admin", policy_version: await version(r.id) }, { claims: { target_member: { person: admin, orgs: { [ORG]: 1 } } } });
      const grant = await must(who, "POST", `/v1/workspaces/${r.id}/repository/grants`, { policy_version: await version(r.id), principal_id: AGENT.id, action: "push" });
      expect(grant.delegated_by).toBe(admin);
      return { ...r, admin: who };
    };
    const fresh = () => `per_ra_giver_${++counter}`;
    // Demoted underneath, with nothing run to end the grant: refused at use from the room's own rows.
    const demoted = await givenByAdmin(fresh());
    await inRoom(demoted.id, (sql) => void sql.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", demoted.admin.id));
    await refusedWith(await access(AGENT, demoted.id, demoted.task), 403, "grant_stale");
    // Stored as an admin and as an agent: an agent gives nothing that counts.
    const agentKind = await givenByAdmin(fresh());
    await inRoom(agentKind.id, (sql) => void sql.exec("UPDATE member SET kind = 'agent' WHERE principal_id = ?", agentKind.admin.id));
    await refusedWith(await access(AGENT, agentKind.id, agentKind.task), 403, "grant_stale");
    // Their place in the room revoked underneath.
    const gone = await givenByAdmin(fresh());
    await inRoom(gone.id, (sql) => void sql.exec("UPDATE member SET revoked_at = 1 WHERE principal_id = ?", gone.admin.id));
    await refusedWith(await access(AGENT, gone.id, gone.task), 403, "grant_stale");
    // They left the organization and the room hasn't heard: its rows still say admin and the list says live, and the
    // person's own record refuses the grant. The listing is emptied first, so the departure can't find the room.
    const left = await givenByAdmin(fresh());
    await alarmQuiet(stub(left.id));
    await BINDINGS.DB.prepare("DELETE FROM membership_index WHERE principal_id = ?").bind(left.admin.id).run();
    await must({ ...left.admin, departure: { person: left.admin.id, org: ORG, left_at: Date.now() } }, "POST", "/v1/org-departures", {});
    expect((await api(OWNER, "GET", `/v1/workspaces/${left.id}/repository/grants`)).body.grants.map((g: any) => g.state)).toEqual(["live"]);
    await refusedWith(await access(AGENT, left.id, left.task), 403, "grant_stale");
    // Their record can't be read: nothing is minted on an unknown.
    const unknown = await givenByAdmin(`per_unavailable_ra_giver_${++counter}`);
    await refusedWith(await access(AGENT, unknown.id, unknown.task), 503, "standing_unknown");
    // An admin whose authority holds: the token is minted under their grant.
    const held = await givenByAdmin(fresh());
    const got = await access(AGENT, held.id, held.task);
    expect(got.status, got.text).toBe(200);
    expect((await tokens(held.id)).map((t) => t.state)).toEqual(["held"]);
  });

  it("refuses an agent acting for a person who has left, or for nobody, and refuses when that can't be read", async () => {
    const r = await room();
    const linker = `per_ra_linker_${++counter}`;
    const agent: Who = { ...AGENT, linker };
    await must({ id: linker, kind: "person", org: ORG, departure: { person: linker, org: ORG, left_at: Date.now() } }, "POST", "/v1/org-departures", {});
    await refusedWith(await access(agent, r.id, r.task), 403, "controller_departed");
    await refusedWith(await access({ ...AGENT, linker: null }, r.id, r.task), 403, "controller_departed");
    // An answer that isn't a clear yes or no mints nothing.
    await refusedWith(await access({ ...AGENT, linker: "per_unavailable_ra" }, r.id, r.task), 503, "standing_unknown");
  });

  it("refuses a removed agent, a disconnected one and one in the room through a public claim", async () => {
    const removed = await room();
    await must(OWNER, "DELETE", `/v1/workspaces/${removed.id}/members/${AGENT.id}`, { policy_version: await version(removed.id) });
    const gone = await access(AGENT, removed.id, removed.task);
    expect([gone.status, gone.code]).toEqual([403, "access_revoked"]);
    expect(await minted()).toEqual([]);
    const pub = await room({ assignee: PUBLIC });
    await inRoom(pub.id, (sql) => sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_public', ?, 'github', ?, 'push', ?, 1)", PUBLIC.id, REPO_ID, OWNER.id));
    await refusedWith(await access(PUBLIC, pub.id, pub.task), 403, "public_participant");
  });

  it("refuses a disconnected agent", async () => {
    const agent: Who = { id: `agt_ra_gone_${++counter}`, org: ORG };
    const res = await SELF.fetch(`https://api.internal/v1/agents/${agent.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin) }, body: JSON.stringify({ org_id: ORG, name: agent.id }) });
    expect(res.status).toBe(200);
    const r = await room({ grant: false });
    await must(OWNER, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: agent.id, kind: "agent", org_id: ORG, role: "member", policy_version: await version(r.id) });
    await must(OWNER, "POST", `/v1/workspaces/${r.id}/repository/grants`, { policy_version: await version(r.id), principal_id: agent.id, action: "push" });
    const task = await newTask(r.id, agent);
    expect((await access(agent, r.id, task)).status).toBe(200);
    await must(orgAdmin, "POST", `/v1/agents/${agent.id}/disconnect`, {});
    const refused = await access(agent, r.id, task);
    expect([refused.status, refused.code]).toEqual([403, "agent_disconnected"]);
    expect(await minted()).toHaveLength(1);
  });

  it("refuses a task that isn't accepted, has ended, isn't linked, or is someone else's, and a person", async () => {
    const r = await room();
    const offered = await newTask(r.id, AGENT, { accept: false });
    await refusedWith(await access(AGENT, r.id, offered), 409, "task_not_active");
    const unlinked = await newTask(r.id, AGENT, { linked: false });
    await refusedWith(await access(AGENT, r.id, unlinked), 409, "task_not_linked");
    const others = await newTask(r.id, OTHER);
    await refusedWith(await access(AGENT, r.id, others), 403, "not_allowed");
    await refusedWith(await access(OWNER, r.id, r.task), 403, "not_allowed");
    const t = (await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`)).task ?? (await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`));
    await must(OWNER, "POST", `/v1/workspaces/${r.id}/tasks/${r.task}/cancel`, { version: t.version, reason: "Not needed" });
    await refusedWith(await access(AGENT, r.id, r.task), 409, "task_not_active");
  });

  it("refuses a repository that isn't ready", async () => {
    for (const status of ["degraded", "suspended"]) {
      const r = await room();
      await inRoom(r.id, (sql) => sql.exec("UPDATE repo_link SET status = ?", status));
      await refusedWith(await access(AGENT, r.id, r.task), 409, "repo_not_ready");
    }
    const r = await room();
    await inRoom(r.id, (sql) => sql.exec("DELETE FROM repo_link"));
    await refusedWith(await access(AGENT, r.id, r.task), 409, "repo_not_ready");
  });

  it("answers as a route that doesn't exist while the switch is off, a malformed body included", async () => {
    const r = await room({ switchedOn: false });
    await refusedWith(await access(AGENT, r.id, r.task), 404, "not_found");
    // A missing route parses the body first, so a malformed one is `invalid_argument` there and here alike.
    await refusedWith(await access(AGENT, r.id, r.task, undefined, { raw: "{not json" }), 400, "invalid_argument");
    await refusedWith(await access(AGENT, r.id, "tsk_missing"), 404, "not_found");
  });

  it("takes nothing from the caller: any field at all is refused", async () => {
    const r = await room();
    for (const body of [{ repository_id: 1 }, { installation_id: GH.agentInstallationId }, { permissions: { administration: "write" } }, { org: "x" }, []]) {
      await refusedWith(await access(AGENT, r.id, r.task, body), 400, "invalid_argument");
    }
    await refusedWith(await access(AGENT, r.id, r.task, undefined, { raw: "{not json" }), 400, "invalid_argument");
    expect((await access(AGENT, r.id, r.task, {})).status).toBe(200);
  });

  it("refuses before minting when the sealing key is unset", async () => {
    const r = await room();
    await setKeys(r.id, null, null);
    await refusedWith(await access(AGENT, r.id, r.task), 503, "repo_access_unavailable");
    expect(await tokens(r.id)).toEqual([]);
  });

  it("caps mints per agent and per room", async () => {
    const r = await room();
    await inRoom(r.id, (sql) => { for (let n = 0; n < 10; n++) sql.exec("INSERT INTO repo_token_mint (at, agent_id) VALUES (?, ?)", Date.now(), AGENT.id); });
    await refusedWith(await access(AGENT, r.id, r.task), 429, "rate_limited");
    const busy = await room();
    await inRoom(busy.id, (sql) => { for (let n = 0; n < 60; n++) sql.exec("INSERT INTO repo_token_mint (at, agent_id) VALUES (?, ?)", Date.now(), `agt_ra_x${n}`); });
    await refusedWith(await access(AGENT, busy.id, busy.task), 429, "rate_limited");
    // An hour later they count no more.
    await inRoom(busy.id, (sql) => sql.exec("UPDATE repo_token_mint SET at = ?", Date.now() - 3_600_001));
    expect((await access(AGENT, busy.id, busy.task)).status).toBe(200);
  });

  it("answers a hidden room as a missing one, and a hidden task as a missing one", async () => {
    const r = await room();
    const outside = await access(OUTSIDER, r.id, r.task);
    const nowhere = await access(OUTSIDER, `ws_${crypto.randomUUID().replaceAll("-", "")}`, r.task);
    expect([outside.status, outside.code]).toEqual([nowhere.status, nowhere.code]);
    expect(outside.code).toBe("workspace_not_found");
    // A guest who sees only their own tasks gets the same answer for another's task as for none.
    const hidden = await access(PUBLIC, r.id, r.task);
    const missing = await access(PUBLIC, r.id, "tsk_missing");
    expect([hidden.status, hidden.code]).toEqual([404, "task_not_found"]);
    expect([missing.status, missing.code]).toEqual([404, "task_not_found"]);
    expect(await minted()).toEqual([]);
  });
});

describe("what GitHub answers", () => {
  it("revokes and refuses a token that isn't exactly what was asked for", async () => {
    for (const mode of ["wide", "extra_permission", "other_repo", "no_repositories", "long_life"]) {
      await freshRepo();
      await script({ mode });
      const r = await room();
      const refused = await access(AGENT, r.id, r.task);
      expect([refused.status, refused.code], mode).toEqual([502, "provider_mismatch"]);
      expect(refused.text).not.toContain("ghs_");
      expect(await minted(), mode).toEqual([expect.objectContaining({ live: false })]);
      expect(await tokens(r.id), mode).toEqual([]);
    }
  });

  it("queues a mismatched token whose revocation failed, and the alarm takes it back", async () => {
    await script({ mode: "wide", revoke: 500 });
    const r = await room();
    expect((await access(AGENT, r.id, r.task)).code).toBe("provider_mismatch");
    expect((await tokens(r.id)).map((t) => t.state)).toEqual(["revoke"]);
    expect((await minted())[0].live).toBe(true);
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_token SET revoke_next_at = 0"));
    await alarm(r.id, 1);
    expect((await minted())[0].live).toBe(true);
    expect((await inRoom(r.id, (sql) => sql.exec("SELECT revoke_attempts AS n FROM repo_token").one())).n).toBe(1);
    await script({ revoke: 204 });
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_token SET revoke_next_at = 0"));
    await alarm(r.id, 1);
    expect((await minted())[0].live).toBe(false);
    expect(await tokens(r.id)).toEqual([]);
  });

  it("answers provider_unavailable when GitHub doesn't answer in time, and holds nothing", { timeout: 60_000 }, async () => {
    // GitHub holds the mint until the test lets it go, which is after the room has stopped waiting: the room's own
    // wait for a call, ten seconds, is the only clock here.
    await script({ mode: "gate" });
    const r = await room();
    const res = await access(AGENT, r.id, r.task);
    expect([res.status, res.code]).toEqual([502, "provider_unavailable"]);
    // The lease stays as a record of a token that may be live, with no token in it, until any such token has expired.
    expect((await tokens(r.id)).map((t) => [t.state, t.sealed])).toEqual([["mint_unknown", null]]);
    expect(await events(r.id, "repo_token.mint_unknown")).toHaveLength(1);
    // It holds nothing up: the agent can ask again.
    await script({ mode: "ok" });
    const next = await access(AGENT, r.id, r.task);
    expect(next.status).toBe(200);
    // The acknowledged gap: a token whose answer never arrived is unknown to the room, and lives out its hour.
    expect((await minted()).map((t) => t.token)).toEqual([next.body.token]);
    await release();
    const late = (await minted()).filter((t) => t.token !== next.body.token);
    expect(late.map((t) => t.live)).toEqual([true]);
  });

  it("revokes the minted token when the commit fails, and keeps no trace of it", async () => {
    const r = await room();
    const failed = await access(AGENT, r.id, r.task, undefined, { fail: true });
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain("ghs_");
    expect(await minted()).toEqual([expect.objectContaining({ live: false })]);
    expect(await tokens(r.id)).toEqual([]);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT count(*) AS n FROM event WHERE type = 'repo_access.issued'").one().n)).toBe(0);
    // Asking again works.
    expect((await access(AGENT, r.id, r.task)).status).toBe(200);
  });
});

describe("revoking a token whose authority ended", () => {
  /** Issues a token, runs `end`, then the alarm, and shows the token is taken back and the row gone. */
  const endsWith = async (name: string, end: (r: Awaited<ReturnType<typeof room>>) => Promise<unknown>) => {
    const r = await room();
    const got = await access(AGENT, r.id, r.task);
    expect(got.status, `${name}: ${got.text}`).toBe(200);
    // An alarm with nothing ended leaves the token alone. It also writes the room's index rows, which a departure uses.
    await alarm(r.id);
    expect(await minted(), name).toEqual([expect.objectContaining({ token: got.body.token, live: true })]);
    await end(r);
    await alarm(r.id);
    await eventually(r.id, async () => {
      expect(await minted(), name).toEqual([expect.objectContaining({ token: got.body.token, live: false })]);
      expect(await tokens(r.id), name).toEqual([]);
    });
  };

  /** The same, for a token minted under a grant the room's admin gave, not its owner. */
  const adminsEndsWith = async (name: string, end: (r: Awaited<ReturnType<typeof room>>) => Promise<unknown>) => {
    const r = await room({ grant: false });
    const given = await must(ADMIN, "POST", `/v1/workspaces/${r.id}/repository/grants`, { policy_version: await version(r.id), principal_id: AGENT.id, action: "push" });
    expect(given.delegated_by, name).toBe(ADMIN.id);
    const got = await access(AGENT, r.id, r.task);
    expect(got.status, `${name}: ${got.text}`).toBe(200);
    // An alarm with nothing ended leaves an admin's token alone, as it leaves the owner's.
    await alarm(r.id);
    expect(await minted(), name).toEqual([expect.objectContaining({ token: got.body.token, live: true })]);
    expect((await tokens(r.id)).map((t) => t.state), name).toEqual(["held"]);
    await end(r);
    await alarm(r.id);
    await eventually(r.id, async () => {
      expect(await minted(), name).toEqual([expect.objectContaining({ token: got.body.token, live: false })]);
      expect(await tokens(r.id), name).toEqual([]);
    });
  };
  it("when the admin who gave the grant is demoted", () => adminsEndsWith("demoted", async (r) => must(OWNER, "POST", `/v1/workspaces/${r.id}/members/${ADMIN.id}/role`, { role: "member", policy_version: await version(r.id) }, { claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } })));
  it("when the admin who gave the grant is removed", () => adminsEndsWith("removed", async (r) => must(OWNER, "DELETE", `/v1/workspaces/${r.id}/members/${ADMIN.id}`, { policy_version: await version(r.id) })));
  it("when the admin who gave the grant is one no more by the room's rows, seen by the alarm alone", () => adminsEndsWith("role changed underneath", (r) => inRoom(r.id, (sql) => void sql.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", ADMIN.id))));

  it("when the grant is taken back", () => endsWith("revoked", async (r) => must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) })));
  it("when the agent is removed", () => endsWith("removed", async (r) => must(OWNER, "DELETE", `/v1/workspaces/${r.id}/members/${AGENT.id}`, { policy_version: await version(r.id) })));
  it("when the task is canceled", () => endsWith("canceled", async (r) => {
    const t = await must(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`);
    return must(OWNER, "POST", `/v1/workspaces/${r.id}/tasks/${r.task}/cancel`, { version: (t.task ?? t).version, reason: "Not needed" });
  }));
  it("when the agent releases the task", () => endsWith("released", async (r) => {
    const t = await must(AGENT, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`);
    return must(AGENT, "POST", `/v1/workspaces/${r.id}/tasks/${r.task}/release`, { version: (t.task ?? t).version, reason: "Can't do it" });
  }));
  it("when ownership moves", () => endsWith("transferred", async (r) => must(OWNER, "POST", `/v1/workspaces/${r.id}/owner/transfer`, { to: ADMIN.id, policy_version: await version(r.id) }, { claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } })));
  it("when the owner leaves the organization, which leaves every grant stale", () => endsWith("owner left", (r) => ownerLeaves(r.id)));
  it("when the room is archived", () => endsWith("archived", async (r) => must(OWNER, "POST", `/v1/workspaces/${r.id}/archive`, { policy_version: await version(r.id) })));
  it("when the link stops allowing work, seen by the alarm alone", () => endsWith("degraded", (r) => inRoom(r.id, (sql) => sql.exec("UPDATE repo_link SET status = 'degraded'"))));
  it("when the agent is disconnected", async () => {
    const agent: Who = { id: `agt_ra_cut_${++counter}`, org: ORG };
    const res = await SELF.fetch(`https://api.internal/v1/agents/${agent.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin) }, body: JSON.stringify({ org_id: ORG, name: agent.id }) });
    expect(res.status).toBe(200);
    const r = await room({ grant: false });
    await must(OWNER, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: agent.id, kind: "agent", org_id: ORG, role: "member", policy_version: await version(r.id) });
    await must(OWNER, "POST", `/v1/workspaces/${r.id}/repository/grants`, { policy_version: await version(r.id), principal_id: agent.id, action: "push" });
    const task = await newTask(r.id, agent);
    const issued = await access(agent, r.id, task);
    expect(issued.status, issued.text).toBe(200);
    const got = issued.body;
    await must(orgAdmin, "POST", `/v1/agents/${agent.id}/disconnect`, {});
    // The disconnect reaches the room through the agent's fence, which may take a moment.
    await eventually(r.id, async () => {
      expect(await minted()).toEqual([expect.objectContaining({ token: got.token, live: false })]);
      expect(await tokens(r.id)).toEqual([]);
    });
  });
  it("when it expires, which the alarm drops", async () => {
    const r = await room();
    expect((await access(AGENT, r.id, r.task)).status).toBe(200);
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_token SET expires_at = ?", Date.now() - 1));
    await alarm(r.id);
    expect(await tokens(r.id)).toEqual([]);
  });
  it("when a request is refused, which revokes the held one", () => endsWith("refused", async (r) => {
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_link SET status = 'suspended'"));
    // GitHub refuses the revocation for now, so the row is there to read whether or not the runtime has run its alarm.
    await script({ revoke: 500 });
    expect((await access(AGENT, r.id, r.task)).code).toBe("repo_not_ready");
    expect((await tokens(r.id)).map((t) => t.state)).toEqual(["revoke"]);
    await script({ revoke: 204 });
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_token SET revoke_next_at = 0"));
  }));
  it("a revocation that fails doesn't hold up the cascade, and is retried", async () => {
    const r = await room();
    const got = (await access(AGENT, r.id, r.task)).body;
    await script({ revoke: 500 });
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) })).status).toBe(200);
    await alarm(r.id);
    expect(await minted()).toEqual([expect.objectContaining({ token: got.token, live: true })]);
    const [row] = await inRoom(r.id, (sql) => sql.exec("SELECT state, revoke_attempts, revoke_next_at FROM repo_token").toArray() as any[]);
    expect(row.state).toBe("revoke");
    expect(row.revoke_attempts).toBeGreaterThanOrEqual(1);
    expect(row.revoke_next_at).toBeGreaterThan(Date.now());
    await script({ revoke: 204 });
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_token SET revoke_next_at = 0"));
    await alarm(r.id);
    expect(await minted()).toEqual([expect.objectContaining({ token: got.token, live: false })]);
  });
});

describe("where a token may be", () => {
  it("never reaches a log, an event, D1, the outbox, the idempotency store or an error", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const r = await room();
    const answers: string[] = [];
    answers.push((await access(AGENT, r.id, r.task, undefined, { fail: true })).text);
    answers.push((await access(AGENT, r.id, r.task)).text);
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_token SET expires_at = ?", Date.now() + 60_000));
    answers.push((await access(AGENT, r.id, r.task)).text);
    await script({ mode: "wide" });
    const other = await newTask(r.id, AGENT);
    answers.push((await access(AGENT, r.id, other)).text);
    await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) });
    answers.push((await access(AGENT, r.id, r.task)).text);
    await alarm(r.id);
    const issued = (await minted()).map((t) => t.token);
    expect(issued.length).toBeGreaterThanOrEqual(3);
    // Every table in the room but the sealed copy's column, and D1.
    const stored = await inRoom(r.id, (sql) => {
      const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'").toArray().map((t: any) => t.name as string);
      return JSON.stringify(Object.fromEntries(tables.map((table) => [table, sql.exec(`SELECT * FROM ${table}`).toArray()])));
    });
    const d1Tables = (await BINDINGS.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((t: any) => t.name);
    const d1 = JSON.stringify(await Promise.all(d1Tables.filter((t: string) => !t.startsWith("_cf") && !t.startsWith("sqlite")).map((t: string) => BINDINGS.DB.prepare(`SELECT * FROM ${t}`).all())));
    const errors = [answers[0], answers[3], answers[4]].join("\n");
    expect(errors).not.toContain('"token"');
    for (const token of issued) {
      const secret = token.slice("ghs_fake_".length);
      expect(stored, "room").not.toContain(secret);
      expect(d1, "D1").not.toContain(secret);
      expect(errors, "errors").not.toContain(secret);
      for (const line of lines) expect(line, "log").not.toContain(secret);
    }
    // The logs carry IDs and codes.
    const mine = lines.filter((line) => line.includes('"repo_token.')).map((line) => JSON.parse(line).event);
    expect(mine).toEqual(expect.arrayContaining(["repo_token.issued", "repo_token.commit_failed", "repo_token.mismatch", "repo_token.revocations"]));
  });
});

describe("the review's findings (M5 step 6)", () => {
  it("wakes at a grant's expiry when it's sooner than its token's, and revokes the token then (M1)", async () => {
    const r = await room({ grant: false });
    const expires = Date.now() + 60_000;
    const grant = (await must(OWNER, "POST", `/v1/workspaces/${r.id}/repository/grants`, { policy_version: await version(r.id), principal_id: AGENT.id, action: "push", expires_at: expires })).id;
    const got = await access(AGENT, r.id, r.task);
    expect(got.status, got.text).toBe(200);
    expect(got.body.expires_at).toBeGreaterThan(expires);
    // The alarm was set before the token was answered, for the grant's expiry, not the token's.
    // The runtime runs alarms as they come due, and one may be running, so read it once none is.
    let alarmAt: number | null = null;
    for (let n = 0; n < 40 && alarmAt === null; n++) {
      alarmAt = await runInDurableObject(stub(r.id), (_: any, state: any) => state.storage.getAlarm());
      if (alarmAt === null) await new Promise((x) => setTimeout(x, 50));
    }
    expect(alarmAt).not.toBeNull();
    // The room sets its alarm for the moment itself, so it's never past the grant's expiry, and the token's is an hour on.
    expect(alarmAt!).toBeLessThanOrEqual(expires);
    expect(got.body.expires_at - expires).toBeGreaterThan(30 * 60_000);
    // The agent never asks again. When the grant lapses, the alarm takes the token back.
    await inRoom(r.id, (sql) => sql.exec("UPDATE provider_grant SET expires_at = ? WHERE id = ?", Date.now() - 1, grant));
    await alarm(r.id);
    await eventually(r.id, async () => {
      expect(await minted()).toEqual([expect.objectContaining({ token: got.body.token, live: false })]);
      expect(await tokens(r.id)).toEqual([]);
    });
  });

  it("opens a held token with the previous key while rotating, and seals new ones with the current key (M2)", async () => {
    const r = await room();
    const first = (await access(AGENT, r.id, r.task)).body.token;
    await setKeys(r.id, NEW_KEY, OLD_KEY);
    expect((await access(AGENT, r.id, r.task)).body.token).toBe(first);
    // A renewal is sealed with the new key, so it still opens once the previous one is gone.
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_token SET expires_at = ?", Date.now() + 60_000));
    const renewed = (await access(AGENT, r.id, r.task)).body.token;
    expect(renewed).not.toBe(first);
    // The old token, marked for revocation and sealed under the old key, is revoked while the previous key is set.
    await alarm(r.id);
    expect(await minted()).toEqual([expect.objectContaining({ token: first, live: false }), expect.objectContaining({ token: renewed, live: true })]);
    // Once the previous key is removed, the renewal still opens: it was sealed with the current one.
    await setKeys(r.id, NEW_KEY, null);
    expect((await access(AGENT, r.id, r.task)).body.token).toBe(renewed);
  });

  it("records and drops a held token neither key opens, and mints anew rather than refusing (M2)", async () => {
    const r = await room();
    const first = (await access(AGENT, r.id, r.task)).body.token;
    const [row] = await inRoom(r.id, (sql) => sql.exec("SELECT id FROM repo_token").toArray() as any[]);
    await setKeys(r.id, NEW_KEY, null);
    const next = await access(AGENT, r.id, r.task);
    expect(next.status, next.text).toBe(200);
    expect(next.body.token).not.toBe(first);
    expect(await events(r.id, "repo_token.unrevocable")).toEqual([{ actor_id: AGENT.id, subject_id: row.id, task_id: r.task }]);
    // Nothing could revoke it, so it lives out its hour, and the record says so.
    expect((await minted()).find((t) => t.token === first)?.live).toBe(true);
    expect((await tokens(r.id)).map((t) => t.state)).toEqual(["held"]);
  });

  it("records and drops a token to revoke that neither key opens, in the alarm (M2)", async () => {
    const r = await room();
    expect((await access(AGENT, r.id, r.task)).status).toBe(200);
    // The keys change before the grant goes. Taking the grant back sets the room's alarm, and the runtime may run it
    // before this test's own run. Whichever run comes first then meets the keys as the test means them.
    await setKeys(r.id, NEW_KEY, null);
    await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) });
    await alarm(r.id);
    await eventually(r.id, async () => {
      expect(await tokens(r.id)).toEqual([]);
      expect(await events(r.id, "repo_token.unrevocable")).toHaveLength(1);
    });
    // With no key set at all, a row waits instead: that's configuration missing, not a key gone.
    const s = await room();
    expect((await access(AGENT, s.id, s.task)).status).toBe(200);
    await setKeys(s.id, null, null);
    await must(OWNER, "DELETE", `/v1/workspaces/${s.id}/repository/grants/${s.grant}`, { policy_version: await version(s.id) });
    await alarm(s.id);
    expect((await tokens(s.id)).map((t) => t.state)).toEqual(["revoke"]);
    expect(await events(s.id, "repo_token.unrevocable")).toEqual([]);
  });

  it("takes every held token back when the switch is turned off (L1)", async () => {
    const r = await room();
    const got = (await access(AGENT, r.id, r.task)).body.token;
    await inRoom(r.id, (sql) => sql.exec("DROP TABLE test_managed_repositories_on"));
    await alarm(r.id);
    expect(await minted()).toEqual([expect.objectContaining({ token: got, live: false })]);
    expect(await tokens(r.id)).toEqual([]);
  });

  it("answers the proper refusal when authority ends while the token is minted, and revokes it (L3)", async () => {
    for (const [name, code] of [["archived", "workspace_archived"], ["removed", "access_revoked"]] as const) {
      await freshRepo();
      // GitHub holds the mint until the test has ended the authority and lets it go, so the order doesn't rest on a sleep.
      await script({ mode: "gate" });
      const r = await room();
      const v = await version(r.id);
      const asked = access(AGENT, r.id, r.task);
      await minting();
      const ended = await (name === "archived" ? api(OWNER, "POST", `/v1/workspaces/${r.id}/archive`, { policy_version: v }) : api(OWNER, "DELETE", `/v1/workspaces/${r.id}/members/${AGENT.id}`, { policy_version: v }));
      expect(ended.status, `${name}: ${ended.text}`).toBe(200);
      await release();
      const res = await asked;
      expect(res.code, name).toBe(code);
      expect(res.status, name).not.toBe(500);
      expect(await minted(), name).toEqual([expect.objectContaining({ live: false })]);
      expect(await tokens(r.id), name).toEqual([]);
    }
  });

  it("uses the live grant when an expired one sits beside it (L4)", async () => {
    const r = await room();
    // Newer than the live grant, on an earlier repository, and expired.
    await inRoom(r.id, (sql) => sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at, expires_at) VALUES ('pgr_old', ?, 'github', ?, 'push', ?, ?, ?)", AGENT.id, REPO_ID + 1, OWNER.id, Date.now() + 1000, Date.now() - 1));
    const got = await access(AGENT, r.id, r.task);
    expect(got.status, got.text).toBe(200);
    expect((await tokens(r.id))[0].grant_id).toBe(r.grant);
  });

  it("keeps a lease a Worker never came back from as a record of a token that may be live, for its hour (L5)", async () => {
    const r = await room();
    await inRoom(r.id, (sql) => sql.exec("INSERT INTO repo_token (id, agent_id, task_id, grant_id, provider_repo_id, state, lease_until, created_at) VALUES ('rtk_lost', ?, ?, ?, ?, 'minting', ?, ?)", AGENT.id, r.task, r.grant, REPO_ID, Date.now() - 1, Date.now() - 30_001));
    await alarm(r.id);
    const [row] = await inRoom(r.id, (sql) => sql.exec("SELECT state, sealed, expires_at FROM repo_token WHERE id = 'rtk_lost'").toArray() as any[]);
    expect(row.state).toBe("mint_unknown");
    expect(row.sealed).toBeNull();
    expect(row.expires_at).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(await events(r.id, "repo_token.mint_unknown")).toEqual([{ actor_id: AGENT.id, subject_id: "rtk_lost", task_id: r.task }]);
    // It doesn't block a new token, and it's gone once any token it stands for would have expired.
    expect((await access(AGENT, r.id, r.task)).status).toBe(200);
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_token SET expires_at = ? WHERE id = 'rtk_lost'", Date.now() - 1));
    await alarm(r.id);
    expect((await tokens(r.id)).map((t) => t.state)).toEqual(["held"]);
  });
});

describe("the re-review's lows (M5 step 6 follow-up)", () => {
  it("keeps a row the current key can't open waiting while the previous secret is set but malformed (a)", async () => {
    const r = await room();
    const first = (await access(AGENT, r.id, r.task)).body.token;
    await setKeys(r.id, NEW_KEY, "not-a-key");
    // At a request: refused for now, and the row is kept.
    const asked = await access(AGENT, r.id, r.task);
    expect([asked.status, asked.code]).toEqual([503, "repo_access_unavailable"]);
    expect((await tokens(r.id)).map((t) => t.state)).toEqual(["held"]);
    // In the alarm: a row to revoke waits and is retried, never dropped as unrevocable.
    await must(OWNER, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${r.grant}`, { policy_version: await version(r.id) });
    await alarm(r.id);
    const [row] = await inRoom(r.id, (sql) => sql.exec("SELECT state, revoke_attempts FROM repo_token").toArray() as any[]);
    expect(row.state).toBe("revoke");
    expect(await events(r.id, "repo_token.unrevocable")).toEqual([]);
    // Once the previous secret is fixed, the token is revoked.
    await setKeys(r.id, NEW_KEY, OLD_KEY);
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_token SET revoke_next_at = 0"));
    await eventually(r.id, async () => expect(await minted()).toEqual([expect.objectContaining({ token: first, live: false })]));
    // With no previous secret at all, the same row would have been recorded and dropped: see the M2 tests above.
  });

  it("refuses to mint when the agent App is the provisioning App or the merge App, end to end (b)", async () => {
    for (const [name, id] of [["GITHUB_PROVISION_APP_ID", GH.provisionAppId], ["GITHUB_MERGE_APP_ID", GH.mergeAppId]] as const) {
      const r = await room();
      await inRoom(r.id, (sql) => {
        sql.exec("CREATE TABLE test_github_vars (name TEXT, value TEXT)");
        sql.exec("INSERT INTO test_github_vars (name, value) VALUES ('GITHUB_AGENT_APP_ID', ?)", String(id));
      });
      const refused = await access(AGENT, r.id, r.task);
      expect([refused.status, refused.code], name).toEqual([503, "repo_access_unavailable"]);
      expect(await minted(), name).toEqual([]);
      // Its own installation, the provisioning one, is refused the same way.
      await inRoom(r.id, (sql) => {
        sql.exec("DELETE FROM test_github_vars");
        sql.exec("INSERT INTO test_github_vars (name, value) VALUES ('GITHUB_AGENT_INSTALLATION_ID', ?)", String(GH.installationId));
      });
      expect((await access(AGENT, r.id, r.task)).code, name).toBe("repo_access_unavailable");
      // And with the table empty, the same room mints: the refusal was the configuration's.
      await inRoom(r.id, (sql) => sql.exec("DELETE FROM test_github_vars"));
      expect((await access(AGENT, r.id, r.task)).status, name).toBe(200);
      await freshRepo();
    }
  });
});

