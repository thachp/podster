import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { alarmPass, alarmQuiet } from "./alarm.ts";

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

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }), ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, options: { key?: string | null; claims?: object; fail?: boolean } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, options.claims), "content-type": "application/json" };
  if (options.fail) headers["x-test-fail"] = "1";
  if (method !== "GET" && options.key !== null) headers["idempotency-key"] = options.key ?? `pv-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined, text };
}

type Call = { method: string; path: string; body: any; auth: string; scope?: "all" | number[] };
const fake = async (path: string, body?: unknown) => (await fetch(`https://github-fake.example.com${path}`, { method: "POST", body: JSON.stringify(body ?? {}) })).json() as Promise<any>;
const github = async () => (await fake("/state")) as { calls: Call[]; repos: any[]; liveTokens: ("all" | number[])[] };
const TOKENS = "/access_tokens";
const REVOKE = "/installation/token";
const tokenCall = (c: Call) => c.path.endsWith(TOKENS) || c.path === REVOKE;
/** Anything that would delete or edit at GitHub. A token revoking itself isn't one. */
const destructive = (seen: Call[]) => seen.filter((c) => (c.method === "DELETE" || c.method === "PATCH") && c.path !== REVOKE);
const calls = async () => (await github()).calls.map((c) => `${c.method} ${c.path}`);
/** Calls that change something at GitHub. */
const writes = async () => (await github()).calls.filter((c) => c.method !== "GET" && !tokenCall(c));

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion({ id: "per_pv_agents_admin", kind: "person", org: AGENT.org, adminOrgs: [AGENT.org] }) }, body: JSON.stringify({ org_id: AGENT.org, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register: ${res.status}`);
});
const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
/** The rooms this test made. */
const made: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  // The fake keeps one list of calls, which the next test's room resets and then reads whole. A job still running for one
  // of this test's rooms would add to it, so each room is left with no alarm run under way and none to come.
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});

const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const delegate = (org: string, granted = true, by: Who = OPERATOR) => api(by, "PUT", `/v1/orgs/${org}/provisioning-delegation`, { granted });

let orgs = 0;
/**
 * Waits until the API knows the organization has a room. In a deployment the organization's own object records each room
 * as it's made. Test builds skip that record, since tests share organizations, so here it's the listing the room's alarm writes.
 */
async function known(org: string, id: string) {
  for (let i = 0; i < 80; i++) {
    if (await BINDINGS.DB.prepare("SELECT 1 FROM membership_index WHERE org_id = ? LIMIT 1").bind(org).first()) return;
    await alarmPass(stub(id));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the organization never showed in the listing");
}
/**
 * A room in an organization of its own, whose owner is `owner`. `delegated` gives the organization the delegation.
 * `script` resets the fake. Managed repositories are switched on for this room alone, unless `switchedOn` is false: the
 * Worker's variable is unset here, as in every deployment.
 */
async function room(options: { delegated?: boolean; script?: object; switchedOn?: boolean } = {}) {
  await fake("/reset", options.script ?? {});
  const org = `org_pv_${++orgs}_${crypto.randomUUID().slice(0, 8)}`;
  const owner: Who = { id: `per_pv_owner_${orgs}`, kind: "person", org, adminOrgs: [org] };
  const id: string = (await api(owner, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
  made.push(id);
  if (options.switchedOn !== false) await inRoom(id, (sql) => sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)"));
  await known(org, id);
  // Every organization holds the delegation until an operator takes it back, so `delegated: false` is a take-back.
  if (options.delegated === false) expect((await delegate(org, false)).status).toBe(200);
  return { id, org, owner };
}
/** A room of `owner`'s, in their organization, with managed repositories switched on. The fake isn't reset. */
async function roomOf(owner: Who) {
  const id: string = (await api(owner, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
  made.push(id);
  await inRoom(id, (sql) => sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)"));
  return { id, org: owner.org, owner };
}
const PLACES = "CREATE TABLE IF NOT EXISTS repo_request_room (workspace_id TEXT PRIMARY KEY, at INTEGER NOT NULL)";
/** When a room's place in an organization's count, or a person's, was last stamped, or null if it holds none. */
const stampOf = (holder: string, room: string) => runInDurableObject(BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(holder)), (_: any, state: any) => {
  state.storage.sql.exec(PLACES);
  return (state.storage.sql.exec("SELECT at FROM repo_request_room WHERE workspace_id = ?", room).toArray()[0]?.at ?? null) as number | null;
}) as Promise<number | null>;
/** Holds calls in room `id` at the fake's gate: `counted` once both caps counted them, `uncounted` once they decided not to count. */
const holdAt = async (id: string, where: "counted" | "uncounted") => {
  const gate = 900_000 + Math.floor(Math.random() * 90_000);
  await inRoom(id, (sql) => { sql.exec(`CREATE TABLE test_hold_${where} (gate INTEGER)`); sql.exec(`INSERT INTO test_hold_${where} VALUES (?)`, gate); });
  return {
    /** Waits until `n` calls are held, then stops holding new ones. */
    reached: async (n = 1) => {
      for (const deadline = Date.now() + 5_000; (await heldAt(gate)) < n; ) {
        if (Date.now() > deadline) throw new Error(`${n} calls never reached the gate`);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      await inRoom(id, (sql) => void sql.exec(`DROP TABLE test_hold_${where}`));
    },
    letGo: () => letGo(gate),
  };
};
/** The rooms that hold a place in an organization's count, or a person's. */
const counted = (holder: string) => runInDurableObject(BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(holder)), (_: any, state: any) => {
  state.storage.sql.exec(PLACES);
  return state.storage.sql.exec("SELECT workspace_id FROM repo_request_room ORDER BY at, workspace_id").toArray().map((row: any) => row.workspace_id as string);
}) as Promise<string[]>;
/** Makes a room's place `ms` older, as if it had been stamped that much earlier. */
const age = (holder: string, room: string, ms: number) => runInDurableObject(BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(holder)), (_: any, state: any) =>
  void state.storage.sql.exec("UPDATE repo_request_room SET at = at - ? WHERE workspace_id = ?", ms, room));
/** Asks an organization's object, or a person's, directly, as a room does. */
const principalCall = async (holder: string, path: string, body: object) =>
  (await BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(holder)).fetch(`https://principal/internal/${path}`, { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
/** How many calls wait at the fake's gate of that number, and letting them go. */
const heldAt = async (gate: number) => ((await (await fetch(`https://github-fake.example.com/agent-gate?repo=${gate}`)).json()) as { waiting: number }).waiting;
const letGo = (gate: number) => fetch("https://github-fake.example.com/agent-release", { method: "POST", body: JSON.stringify({ id: gate }) });
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
const ask = (r: { id: string; owner: Who }, body: unknown = { name: "engineering", visibility: "public" }, options: { key?: string | null; who?: Who; fail?: boolean } = {}) =>
  api(options.who ?? r.owner, "POST", `/v1/workspaces/${r.id}/repository`, body, options);
/** A retry, as if the wait since the last run were over. `soon` leaves the wait as the room set it. */
const retry = async (r: { id: string; owner: Who }, who?: Who, soon = false) => {
  if (!soon) await inRoom(r.id, (sql) => sql.exec("UPDATE repo_request SET retry_after = NULL"));
  return api(who ?? r.owner, "POST", `/v1/workspaces/${r.id}/repository/retry`, {});
};
const read = async (r: { id: string; owner: Who }) => (await api(r.owner, "GET", `/v1/workspaces/${r.id}/repository`)).body as { request: any; repository: any };
/** Lets the room's alarm run the job until the request is no longer pending. */
async function settled(r: { id: string; owner: Who }) {
  for (let i = 0; i < 80; i++) {
    await alarmPass(stub(r.id));
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
  it("keeps answering while managed repositories are switched off, the same as when they're on (ruled 2026-11-11)", async () => {
    // Off is this runtime's state for the whole Worker. The delegation routes never read the switch, so an operator
    // can set the delegation before the feature is switched on. A room switched on for a test changes nothing here.
    expect(BINDINGS.MANAGED_REPOSITORIES).toBeUndefined();
    const offRoom = await room({ delegated: false, switchedOn: false });
    const onRoom = await room({ delegated: false });
    const outsider: Who = { id: "per_pv_off_outsider", kind: "person", org: "org_pv_elsewhere", adminOrgs: ["org_pv_elsewhere"] };
    for (const r of [offRoom, onRoom]) {
      const path = `/v1/orgs/${r.org}/provisioning-delegation`;
      expect((await api(OPERATOR, "GET", path)).body).toMatchObject({ provider: "github", granted: false });
      const set = await api(OPERATOR, "PUT", path, { granted: true });
      expect([set.status, set.body.granted], r.id).toEqual([200, true]);
      expect((await api(r.owner, "GET", path)).body.granted).toBe(true);
      // Someone who is neither an operator nor the organization's admin is refused as ever, reading or setting.
      for (const method of ["GET", "PUT"]) {
        const refused = await api(outsider, method, path, method === "PUT" ? { granted: false } : undefined);
        expect([refused.status, refused.code], `${r.id} ${method}`).toEqual([403, "not_allowed"]);
      }
    }
  });

  it("is given and taken back by a Podster operator, and nobody else", async () => {
    const org = `org_pv_d_${crypto.randomUUID().slice(0, 8)}`;
    const admin: Who = { id: "per_pv_d_admin", kind: "person", org, adminOrgs: [org] };
    // An organization the API has never seen a room of can't be delegated to, by anyone.
    const unknown = await api(OPERATOR, "PUT", `/v1/orgs/${org}/provisioning-delegation`, { granted: true });
    expect([unknown.status, unknown.code]).toEqual([404, "organization_not_found"]);
    expect((await api(OPERATOR, "PUT", `/v1/orgs/${org}/provisioning-delegation`, { granted: false })).code).toBe("organization_not_found");
    const made = await api(admin, "POST", "/v1/workspaces", { name: "Engineering" });
    expect(made.status).toBe(200);
    await known(org, made.body.id);
    const member: Who = { id: "per_pv_d_member", kind: "person", org, adminOrgs: [] };
    const path = `/v1/orgs/${org}/provisioning-delegation`;
    // Nobody has set it: held, as every organization's is until an operator takes it back.
    expect((await api(admin, "GET", path)).body).toEqual({ provider: "github", granted: true, set_by: null, set_at: null });
    // An organization can't give itself authority over Podster's GitHub organization: not its admin, a member, an agent or a stranger.
    for (const who of [admin, member, AGENT, STRANGER, { ...AGENT, org }]) {
      const refused = await api(who, "PUT", path, { granted: true });
      expect([refused.status, refused.code], who.id).toEqual([403, "not_allowed"]);
    }
    // Still as it was: held, with nobody having set it.
    expect((await api(OPERATOR, "GET", path)).body).toEqual({ provider: "github", granted: true, set_by: null, set_at: null });
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
    // And in the operators' own record, beside their other actions.
    const actions = await runInDurableObject(BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation")), (_: any, state: any) => state.storage.sql.exec("SELECT operator, subject_kind, action, outcome FROM operator_action WHERE subject = ? ORDER BY seq", org).toArray());
    expect(actions).toEqual([
      { operator: OPERATOR.id, subject_kind: "organization", action: "provisioning_delegation.granted", outcome: "done" },
      { operator: OPERATOR.id, subject_kind: "organization", action: "provisioning_delegation.revoked", outcome: "done" },
    ]);
  });
});

describe("an organization the API knows", () => {
  it("is one whose own object recorded a room, as a deployment does, with no wait for the listing", async () => {
    // Test builds skip the organization's room record for every organization but ones named like this, because tests
    // share organizations. This one takes the path a deployment takes: the room is recorded as it's made.
    const org = `org_limit_pv_${crypto.randomUUID().slice(0, 8)}`;
    const admin: Who = { id: "per_pv_limit_admin", kind: "person", org, adminOrgs: [org] };
    const path = `/v1/orgs/${org}/provisioning-delegation`;
    const principal = BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(org));
    // No room yet: unknown.
    expect((await api(OPERATOR, "PUT", path, { granted: true })).code).toBe("organization_not_found");
    const made = await api(admin, "POST", "/v1/workspaces", { name: "Engineering" });
    expect(made.status, made.text).toBe(200);
    // Known at once, from the organization's own object. The listing is taken out of the picture, so it can't be what answers.
    await BINDINGS.DB.prepare("DELETE FROM membership_index WHERE org_id = ?").bind(org).run();
    expect(await runInDurableObject(principal, (_: any, state: any) => state.storage.sql.exec("SELECT workspace_id FROM org_room").toArray())).toEqual([{ workspace_id: made.body.id }]);
    const given = await api(OPERATOR, "PUT", path, { granted: true });
    expect(given.status, given.text).toBe(200);
    expect(given.body).toMatchObject({ granted: true, set_by: OPERATOR.id });
  });
});

describe("asking for the room's repository", () => {
  it("tells the owner whether the organization holds the delegation, from its record each time, and the command still decides", async () => {
    const r = await room({ delegated: false });
    expect((await read(r)).delegated).toBe(false);
    expect((await ask(r)).code).toBe("not_delegated");
    expect((await delegate(r.org)).status).toBe(200);
    expect((await read(r)).delegated).toBe(true);
    expect((await delegate(r.org, false)).status).toBe(200);
    expect((await read(r)).delegated).toBe(false);
    // It's display only: asking is refused exactly as before, by the command's own check.
    expect((await ask(r)).code).toBe("not_delegated");
    expect(await rowsOf(r.id, "repo_request")).toEqual([]);
    expect((await delegate(r.org)).status).toBe(200);
    expect((await read(r)).delegated).toBe(true);
    // An agent never gets the read at all. A person who isn't the owner gets it without the field: repositories.spec.ts.
    const agent = await memberAgent(r);
    expect((await api(agent, "GET", `/v1/workspaces/${r.id}/repository`)).code).toBe("not_allowed");
  });

  it("is for a room admin as for the owner, and never for a member or an agent stored as an admin (AC-10, AC-11)", async () => {
    const r = await room();
    const policy = async () => (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version;
    const person = async (name: string, role: string) => {
      const who: Who = { id: `per_pv_${name}_${crypto.randomUUID().slice(0, 8)}`, kind: "person", org: r.org, adminOrgs: [] };
      const added = await api(r.owner, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: who.id, kind: "person", org_id: r.org, role, policy_version: await policy() }, { claims: { target_member: { person: who.id, orgs: { [r.org]: 1 } } } });
      expect(added.status, added.text).toBe(200);
      return who;
    };
    const admin = await person("admin", "admin");
    const member = await person("member", "member");
    const agent = await memberAgent(r);
    await inRoom(r.id, (sql) => void sql.exec("UPDATE member SET role = 'admin' WHERE principal_id = ?", agent.id));
    for (const who of [member, agent]) {
      const refused = await ask(r, undefined, { who });
      expect([refused.status, refused.code], who.id).toEqual([403, "not_allowed"]);
      const again = await retry(r, who);
      expect([again.status, again.code], who.id).toEqual([403, "not_allowed"]);
    }
    expect(await rowsOf(r.id, "repo_request")).toEqual([]);
    // Nothing was counted for anyone refused.
    expect(await counted(r.org)).toEqual([]);
    // The admin is told the organization holds the delegation, asks, and the job carries the request through for them.
    expect((await api(admin, "GET", `/v1/workspaces/${r.id}/repository`)).body.delegated).toBe(true);
    const asked = await ask(r, undefined, { who: admin });
    expect(asked.status, asked.text).toBe(200);
    expect(asked.body.request).toMatchObject({ state: "pending", requested_by: admin.id });
    expect((await settled(r)).request).toMatchObject({ state: "ready", requested_by: admin.id });
    expect((await github()).repos).toHaveLength(1);
  });

  it("ends a pending request whose asker is no longer the owner or an admin, before anything goes to GitHub", async () => {
    const r = await room();
    const admin: Who = { id: `per_pv_demoted_${crypto.randomUUID().slice(0, 8)}`, kind: "person", org: r.org, adminOrgs: [] };
    const policy = async () => (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version;
    const added = await api(r.owner, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: admin.id, kind: "person", org_id: r.org, role: "admin", policy_version: await policy() }, { claims: { target_member: { person: admin.id, orgs: { [r.org]: 1 } } } });
    expect(added.status, added.text).toBe(200);
    // Demoted before the job's turn, with the request already on record under their name.
    await inRoom(r.id, (sql) => {
      sql.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", admin.id);
      sql.exec("INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, requested_by, requested_at, updated_at) VALUES ('rr_t', 'pending', 'engineering', 'public', 1, 'engineering', ?, 1, 1)", admin.id);
    });
    expect((await api(r.owner, "PUT", `/v1/workspaces/${r.id}/name`, { name: "Engineering two", policy_version: await policy() })).status).toBe(200);
    expect((await settled(r)).request).toMatchObject({ state: "failed", reason: "requester_lost_authority" });
    expect(await writes()).toEqual([]);
  });

  it("accepts five requests in a rolling day for an organization, refuses the sixth by name, and counts each room once", async () => {
    await fake("/reset", {});
    const tag = crypto.randomUUID().slice(0, 8);
    const org = `org_pv_cap_${tag}`;
    const rooms = [];
    // A different person asks in each room, so only the organization's count can be what refuses.
    for (let i = 0; i < 7; i++) rooms.push(await roomOf({ id: `per_pv_cap_${tag}_${i}`, kind: "person", org, adminOrgs: [org] }));
    const body = (i: number) => ({ name: `cap-${i}`, visibility: "public" });
    // One the room refuses for itself is never counted.
    expect((await ask(rooms[0], { name: "podster", visibility: "public" })).code).toBe("name_reserved");
    expect((await ask(rooms[0], { name: "cap-0", visibility: "private" })).code).toBe("private_unavailable");
    expect(await counted(org)).toEqual([]);
    // A request whose transaction fails leaves its room counted: nothing is ever given back. It's the same room's place
    // when that room asks again, so it costs no second one.
    expect((await ask(rooms[0], body(0), { fail: true })).status).toBe(500);
    expect([await counted(org), await counted(rooms[0].owner.id)]).toEqual([[rooms[0].id], [rooms[0].id]]);
    for (let i = 0; i < 5; i++) {
      const accepted = await ask(rooms[i], body(i), { key: `cap-${tag}-${i}` });
      expect(accepted.status, `${i}: ${accepted.text}`).toBe(200);
    }
    expect((await counted(org)).sort()).toEqual(rooms.slice(0, 5).map((r) => r.id).sort());
    // A replay is the stored answer, and asking again for a room that has its request is that room's refusal: neither counts.
    expect((await ask(rooms[0], body(0), { key: `cap-${tag}-0` })).status).toBe(200);
    expect((await ask(rooms[0], body(0))).code).toBe("repo_request_exists");
    // A retry of a failed setup is the same request.
    await inRoom(rooms[1].id, (sql) => void sql.exec("UPDATE repo_request SET state = 'failed', reason = 'name_taken', retry_after = NULL"));
    expect((await retry(rooms[1])).status).toBe(200);
    expect(await counted(org)).toHaveLength(5);
    // The sixth room is refused by name, and nothing is recorded for it or sent anywhere.
    const sixth = await ask(rooms[5], body(5));
    expect([sixth.status, sixth.code]).toEqual([429, "repository_request_limit"]);
    expect(await rowsOf(rooms[5].id, "repo_request")).toEqual([]);
    expect(await eventTypes(rooms[5].id)).not.toContain("repository.requested");
    expect(await counted(org)).toHaveLength(5);
    // The person who was refused wasn't counted either.
    expect(await counted(rooms[5].owner.id)).toEqual([]);
    // Another organization is untouched by this one's count.
    const elsewhere = await room();
    expect((await ask(elsewhere)).status).toBe(200);
    // The window rolls: one request leaves it, and one more is accepted. Then the cap holds again.
    await age(org, rooms[0].id, 86_400_000 - 1_000);
    expect((await ask(rooms[5], body(5))).code).toBe("repository_request_limit");
    await age(org, rooms[0].id, 1_000);
    expect((await ask(rooms[5], body(5))).status).toBe(200);
    expect((await ask(rooms[6], body(6))).code).toBe("repository_request_limit");
  });

  it("holds the same cap for one person across organizations, in the person's own record and by its own clock", async () => {
    await fake("/reset", {});
    const tag = crypto.randomUUID().slice(0, 8);
    const person = `per_pv_many_${tag}`;
    const rooms = [];
    // One person, an organization of their own making for each room.
    for (let i = 0; i < 7; i++) {
      const org = `org_pv_many_${tag}_${i}`;
      rooms.push(await roomOf({ id: person, kind: "person", org, adminOrgs: [org] }));
    }
    for (let i = 0; i < 5; i++) expect((await ask(rooms[i], { name: `many-${i}`, visibility: "public" })).status, `${i}`).toBe(200);
    expect((await counted(person)).sort()).toEqual(rooms.slice(0, 5).map((r) => r.id).sort());
    const sixth = await ask(rooms[5], { name: "many-5", visibility: "public" });
    expect([sixth.status, sixth.code]).toEqual([429, "repository_request_limit"]);
    expect(await rowsOf(rooms[5].id, "repo_request")).toEqual([]);
    // The sixth organization's own place for that room stays: it was asked first, and nothing is given back.
    expect(await counted(rooms[5].org)).toEqual([rooms[5].id]);
    expect(await counted(person)).toHaveLength(5);
    // Someone else in that organization's room isn't held by this person's count, and the room's place is the one it has.
    const policy = (await api(rooms[5].owner, "GET", `/v1/workspaces/${rooms[5].id}`)).body.policy_version;
    const admin: Who = { id: `per_pv_many_admin_${tag}`, kind: "person", org: rooms[5].org, adminOrgs: [] };
    const added = await api(rooms[5].owner, "POST", `/v1/workspaces/${rooms[5].id}/members`, { principal_id: admin.id, kind: "person", org_id: admin.org, role: "admin", policy_version: policy }, { claims: { target_member: { person: admin.id, orgs: { [admin.org]: 1 } } } });
    expect(added.status, added.text).toBe(200);
    expect((await ask(rooms[5], { name: "many-5", visibility: "public" }, { who: admin })).status).toBe(200);
    expect([await counted(admin.id), await counted(rooms[5].org)]).toEqual([[rooms[5].id], [rooms[5].id]]);
    // The person's window rolls by their own object's stamps: one place a second short of a day old still counts, and
    // a day old doesn't.
    await age(person, rooms[0].id, 86_400_000 - 1_000);
    expect((await ask(rooms[6], { name: "many-6", visibility: "public" })).code).toBe("repository_request_limit");
    await age(person, rooms[0].id, 1_000);
    expect((await ask(rooms[6], { name: "many-6", visibility: "public" })).status).toBe(200);
    expect(await counted(person)).toHaveLength(5);
  });

  it("records nothing for someone made an admin after the call looked and before its transaction: neither cap was asked for them", async () => {
    const r = await room();
    const policy = async () => (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version;
    const late: Who = { id: `per_pv_late_${crypto.randomUUID().slice(0, 8)}`, kind: "person", org: r.org, adminOrgs: [] };
    const target = { claims: { target_member: { person: late.id, orgs: { [r.org]: 1 } } } };
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: late.id, kind: "person", org_id: r.org, role: "member", policy_version: await policy() }, target)).status).toBe(200);
    // As a member they're refused, and nothing is counted.
    expect((await ask(r, undefined, { who: late })).code).toBe("not_allowed");
    // The next call is held after it has looked, as a member, and decided there's nothing to count.
    const held = await holdAt(r.id, "uncounted");
    const asking = ask(r, undefined, { who: late });
    await held.reached();
    // The owner makes them an admin while that call waits.
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.id}/members/${late.id}/role`, { role: "admin", policy_version: await policy() }, target)).status).toBe(200);
    await held.letGo();
    // The transaction resolves them as an admin, and refuses: this call counted nothing for them.
    const refused = await asking;
    expect([refused.status, refused.code]).toEqual([503, "delegation_unavailable"]);
    expect(await rowsOf(r.id, "repo_request")).toEqual([]);
    expect(await eventTypes(r.id)).not.toContain("repository.requested");
    expect([await counted(r.org), await counted(late.id)]).toEqual([[], []]);
    // Asking again, as the admin they now are, is counted against both caps and recorded.
    expect((await ask(r, undefined, { who: late })).status).toBe(200);
    expect([await counted(r.org), await counted(late.id)]).toEqual([[r.id], [r.id]]);
  });

  it("holds one place for each room, never gives it back, and stamps it again each time it's asked for", async () => {
    const holder = `org_pv_places_${crypto.randomUUID().slice(0, 8)}`;
    const reserve = (workspace: string) => principalCall(holder, "repo-request-reserve", { provider: "github", workspace, delegation: true });
    // A room takes a place, and asking again keeps the one it has: one room, however many calls.
    expect(await reserve("ws_one")).toEqual({ granted: true, held: true });
    expect(await reserve("ws_one")).toEqual({ granted: true, held: true });
    expect(await counted(holder)).toEqual(["ws_one"]);
    // There is nothing to give a place back with: the release and accept of earlier drafts don't exist.
    for (const path of ["repo-request-release", "repo-request-accept"]) {
      const gone = await BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(holder)).fetch(`https://principal/internal/${path}`, { method: "POST", body: JSON.stringify({ workspace: "ws_one" }) });
      expect(gone.status, path).toBeGreaterThanOrEqual(400);
      await gone.text();
    }
    expect(await counted(holder)).toEqual(["ws_one"]);
    // Four more rooms reach the cap, and a sixth is refused with nothing taken.
    for (const room of ["ws_two", "ws_three", "ws_four", "ws_five"]) expect((await reserve(room)).held, room).toBe(true);
    expect(await reserve("ws_six")).toEqual({ granted: true, held: false });
    expect(await counted(holder)).toHaveLength(5);
    // A room that holds a place keeps it at the cap, and is stamped again with now.
    await age(holder, "ws_one", 60_000);
    const before = (await stampOf(holder, "ws_one"))!;
    expect((await reserve("ws_one")).held).toBe(true);
    expect((await stampOf(holder, "ws_one"))!).toBeGreaterThanOrEqual(before + 60_000);
    // The window is this object's own clock on its own stamps: a second short of a day still counts, a day doesn't.
    await age(holder, "ws_two", 86_400_000 - 1_000);
    expect((await reserve("ws_six")).held).toBe(false);
    await age(holder, "ws_two", 1_000);
    expect((await reserve("ws_six")).held).toBe(true);
    expect((await counted(holder)).sort()).toEqual(["ws_five", "ws_four", "ws_one", "ws_six", "ws_three"]);
    // A room whose own place aged out is asked as a new one, and refused at the cap.
    expect((await reserve("ws_two")).held).toBe(false);
    // A place with no room is never taken.
    const nameless = await BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(holder)).fetch("https://principal/internal/repo-request-reserve", { method: "POST", body: JSON.stringify({ provider: "github", delegation: true }) });
    expect(nameless.status).toBe(400);
    await nameless.text();
  });

  it("keeps the room counted when one of two copies of the same call fails alone and the other records", async () => {
    // The sequence that left a recorded request uncounted: the same key and body twice at once; the first copy fails
    // alone, because the caller was demoted and then made an admin again between the two transactions; the second records.
    const r = await room();
    const policy = async () => (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version;
    const admin: Who = { id: `per_pv_copies_${crypto.randomUUID().slice(0, 8)}`, kind: "person", org: r.org, adminOrgs: [] };
    const target = { claims: { target_member: { person: admin.id, orgs: { [r.org]: 1 } } } };
    const setRole = async (role: string) => expect((await api(r.owner, "POST", `/v1/workspaces/${r.id}/members/${admin.id}/role`, { role, policy_version: await policy() }, target)).status).toBe(200);
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: admin.id, kind: "person", org_id: r.org, role: "admin", policy_version: await policy() }, target)).status).toBe(200);
    const key = `pv-copies-${r.id}`;
    const body = { name: "engineering", visibility: "public" };
    const one = await holdAt(r.id, "counted");
    const first = ask(r, body, { who: admin, key });
    await one.reached();
    const two = await holdAt(r.id, "counted");
    const second = ask(r, body, { who: admin, key });
    await two.reached();
    expect([await counted(r.org), await counted(admin.id)]).toEqual([[r.id], [r.id]]);
    // Demoted: the first copy's transaction refuses it. Nothing is given back.
    await setRole("member");
    await one.letGo();
    const refused = await first;
    expect([refused.status, refused.code]).toEqual([403, "not_allowed"]);
    expect([await counted(r.org), await counted(admin.id)]).toEqual([[r.id], [r.id]]);
    // An admin again: the second copy's transaction resolves the same person in the same organization, and records.
    await setRole("admin");
    await two.letGo();
    expect((await second).status).toBe(200);
    expect((await rowsOf(r.id, "repo_request")).map((row) => row.requested_by)).toEqual([admin.id]);
    // The recorded request is counted, in both objects.
    expect([await counted(r.org), await counted(admin.id)]).toEqual([[r.id], [r.id]]);
  });

  it("counts a room once when one person asks for it twice at once under different keys, and when two people do", async () => {
    // One person, two keys.
    const r = await room();
    const body = { name: "engineering", visibility: "public" };
    const held = await holdAt(r.id, "counted");
    const first = ask(r, body, { key: `pv-twice-a-${r.id}` });
    const second = ask(r, body, { key: `pv-twice-b-${r.id}` });
    await held.reached(2);
    await held.letGo();
    const answers = [await first, await second];
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(answers.find((a) => a.status === 409)?.code).toBe("repo_request_exists");
    expect(await rowsOf(r.id, "repo_request")).toHaveLength(1);
    expect([await counted(r.org), await counted(r.owner.id)]).toEqual([[r.id], [r.id]]);
    // Two people, one room: the owner and an admin at once.
    const shared = await room();
    const admin: Who = { id: `per_pv_pair_${crypto.randomUUID().slice(0, 8)}`, kind: "person", org: shared.org, adminOrgs: [] };
    const policy = (await api(shared.owner, "GET", `/v1/workspaces/${shared.id}`)).body.policy_version;
    expect((await api(shared.owner, "POST", `/v1/workspaces/${shared.id}/members`, { principal_id: admin.id, kind: "person", org_id: shared.org, role: "admin", policy_version: policy }, { claims: { target_member: { person: admin.id, orgs: { [shared.org]: 1 } } } })).status).toBe(200);
    const both = await holdAt(shared.id, "counted");
    const theirs = [ask(shared, body), ask(shared, body, { who: admin })];
    await both.reached(2);
    await both.letGo();
    expect((await Promise.all(theirs)).map((a) => a.status).sort()).toEqual([200, 409]);
    // The organization counts the room once. Each person's own count holds it: the one who didn't record is counted
    // one room too many until it ages out, never one too few.
    expect([await counted(shared.org), await counted(shared.owner.id), await counted(admin.id)]).toEqual([[shared.id], [shared.id], [shared.id]]);
  });

  it("refuses someone demoted after both caps counted their call, and leaves the room counted", async () => {
    const r = await room();
    const policy = async () => (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version;
    const admin: Who = { id: `per_pv_out_${crypto.randomUUID().slice(0, 8)}`, kind: "person", org: r.org, adminOrgs: [] };
    const target = { claims: { target_member: { person: admin.id, orgs: { [r.org]: 1 } } } };
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: admin.id, kind: "person", org_id: r.org, role: "admin", policy_version: await policy() }, target)).status).toBe(200);
    const held = await holdAt(r.id, "counted");
    const asking = ask(r, undefined, { who: admin });
    await held.reached();
    // The owner demotes them while their call waits, counted.
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.id}/members/${admin.id}/role`, { role: "member", policy_version: await policy() }, target)).status).toBe(200);
    await held.letGo();
    const refused = await asking;
    expect([refused.status, refused.code]).toEqual([403, "not_allowed"]);
    expect(await rowsOf(r.id, "repo_request")).toEqual([]);
    // Too high, not too low: the room and the person stay counted for the day, with no request.
    expect([await counted(r.org), await counted(admin.id)]).toEqual([[r.id], [r.id]]);
    // The owner then asks for the same room: it's the place the room already holds.
    expect((await ask(r)).status).toBe(200);
    expect(await counted(r.org)).toEqual([r.id]);
  });

  it("leaves the organization's place where it is when the person's own count refuses or can't answer", async () => {
    const r = await room();
    const policy = async () => (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version;
    const person = async (id: string) => {
      const who: Who = { id, kind: "person", org: r.org, adminOrgs: [] };
      expect((await api(r.owner, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: id, kind: "person", org_id: r.org, role: "admin", policy_version: await policy() }, { claims: { target_member: { person: id, orgs: { [r.org]: 1 } } } })).status).toBe(200);
      return who;
    };
    // The person's own count can't answer, after the organization's took the room: refused as retryable, nothing recorded.
    const unreachable = await person(`per_unavailable_pv_${crypto.randomUUID().slice(0, 8)}`);
    const unknown = await ask(r, undefined, { who: unreachable });
    expect([unknown.status, unknown.code]).toEqual([503, "delegation_unavailable"]);
    expect(await rowsOf(r.id, "repo_request")).toEqual([]);
    expect(await counted(r.org)).toEqual([r.id]);
    // The person is at their own cap, from five other rooms: refused by name, and the organization's place still stands.
    const capped = await person(`per_pv_capped_${crypto.randomUUID().slice(0, 8)}`);
    for (let n = 0; n < 5; n++) expect((await principalCall(capped.id, "repo-request-reserve", { provider: "github", workspace: `ws_elsewhere_${n}`, delegation: false })).held).toBe(true);
    const over = await ask(r, undefined, { who: capped });
    expect([over.status, over.code]).toEqual([429, "repository_request_limit"]);
    expect(await rowsOf(r.id, "repo_request")).toEqual([]);
    expect(await counted(r.org)).toEqual([r.id]);
    expect(await counted(capped.id)).toHaveLength(5);
    // The owner asks, in the place the room already holds, and records.
    expect((await ask(r)).status).toBe(200);
    expect([await counted(r.org), await counted(r.owner.id)]).toEqual([[r.id], [r.id]]);
  });

  it("stamps a place left by a failed attempt again when the request is recorded, so it counts for a day from then", async () => {
    const r = await room();
    // A first attempt fails after it was counted, and its place sits for 23 hours.
    expect((await ask(r, undefined, { fail: true })).status).toBe(500);
    for (const holder of [r.org, r.owner.id]) await age(holder, r.id, 23 * 3_600_000);
    const stale = (await stampOf(r.org, r.id))!;
    // The request is then recorded: both places are stamped with now, not left at the first attempt's time.
    expect((await ask(r)).status).toBe(200);
    for (const holder of [r.org, r.owner.id]) expect((await stampOf(holder, r.id))!, holder).toBeGreaterThanOrEqual(stale + 23 * 3_600_000);
    // A second short of a day after the record it still counts, where the first attempt's stamp would be long gone.
    for (const holder of [r.org, r.owner.id]) await age(holder, r.id, 86_400_000 - 1_000);
    expect((await principalCall(r.org, "repo-request-reserve", { provider: "github", workspace: "ws_another", delegation: true })).held).toBe(true);
    expect((await counted(r.org)).sort()).toEqual([r.id, "ws_another"].sort());
    // A replay of the recorded request, and asking again, reserve nothing: the stamp is where the record left it.
    const key = `pv-replay-${r.id}`;
    const fresh = await room();
    const recorded = await ask(fresh, undefined, { key });
    expect(recorded.status).toBe(200);
    await age(fresh.org, fresh.id, 3_600_000);
    await age(fresh.owner.id, fresh.id, 3_600_000);
    const stamps = [await stampOf(fresh.org, fresh.id), await stampOf(fresh.owner.id, fresh.id)];
    expect((await ask(fresh, undefined, { key })).body).toEqual(recorded.body);
    expect((await ask(fresh)).code).toBe("repo_request_exists");
    expect([await stampOf(fresh.org, fresh.id), await stampOf(fresh.owner.id, fresh.id)]).toEqual(stamps);
  });

  it("gives a public-claim participant nothing: it can't ask for the repository or retry its setup (AC-10)", async () => {
    const r = await room();
    const agent = await memberAgent(r);
    await inRoom(r.id, (sql) => void sql.exec("UPDATE member SET role = 'guest', joined_via = 'public' WHERE principal_id = ?", agent.id));
    const asked = await ask(r, undefined, { who: agent });
    expect([asked.status, asked.code]).toEqual([403, "not_allowed"]);
    await inRoom(r.id, (sql) => void sql.exec("INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, reason, requested_by, requested_at, updated_at) VALUES ('rr_p', 'failed', 'engineering', 'public', 1, 'engineering', 'name_taken', ?, 1, 1)", r.owner.id));
    const again = await retry(r, agent);
    expect([again.status, again.code]).toEqual([403, "not_allowed"]);
    expect((await rowsOf(r.id, "repo_request")).map((row) => row.state)).toEqual(["failed"]);
    expect(await counted(r.org)).toEqual([]);
    // Whatever role is stored for it beside that, it's an agent and asks for nothing.
    await inRoom(r.id, (sql) => void sql.exec("UPDATE member SET role = 'admin' WHERE principal_id = ?", agent.id));
    expect((await retry(r, agent)).code).toBe("not_allowed");
  });

  it("refuses new requests and retries once an operator takes the delegation back, and leaves a linked repository working (ADR 0009)", async () => {
    const r = await room();
    expect((await ask(r)).status).toBe(200);
    expect((await settled(r)).request.state).toBe("ready");
    const failing = await roomOf(r.owner);
    await inRoom(failing.id, (sql) => void sql.exec("INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, reason, requested_by, requested_at, updated_at) VALUES ('rr_f', 'failed', 'second', 'public', 1, 'second', 'name_taken', ?, 1, 1)", r.owner.id));
    const fresh = await roomOf(r.owner);
    const before = await counted(r.org);
    expect((await delegate(r.org, false)).status).toBe(200);
    // New requests and retries are refused, by the same name as ever, and nothing is counted.
    const refused = await ask(fresh, { name: "third", visibility: "public" });
    expect([refused.status, refused.code]).toEqual([403, "not_delegated"]);
    expect((await retry(failing)).code).toBe("not_delegated");
    expect(await counted(r.org)).toEqual(before);
    expect((await read(fresh)).delegated).toBe(false);
    // The repository that's already linked is as it was, and its grants are still given.
    const linked = await read(r);
    expect(linked.repository).toMatchObject({ status: "ready" });
    const agent = await memberAgent(r);
    const policy = (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version;
    const given = await api(r.owner, "POST", `/v1/workspaces/${r.id}/repository/grants`, { policy_version: policy, principal_id: agent.id, action: "push" });
    expect([given.status, given.body.state]).toEqual([200, "live"]);
    // Restored, the organization asks again.
    expect((await delegate(r.org, true)).status).toBe(200);
    expect((await ask(fresh, { name: "third", visibility: "public" })).status).toBe(200);
  });

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
    await alarmPass(stub(r.id));
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
    // Names that would read as Podster's own in the organization every room shares.
    for (const name of ["podster", "podsterdev", "security", "admin", "api", "www", "docs", "status", "support", "billing", "legal", "abuse", "podster-api", "podster-"]) {
      const reserved = await ask(r, { name, visibility: "public" });
      expect([reserved.status, reserved.code], name).toEqual([409, "name_reserved"]);
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
    const mint = `POST /app/installations/${GH.installationId}/access_tokens`;
    expect(seen.map((c) => `${c.method} ${c.path}`)).toEqual([
      // The installation's own token, for the creation call alone, and revoked as soon as it's answered.
      mint, `POST /orgs/${GH.orgLogin}/repos`, `DELETE ${REVOKE}`,
      // A token for this one repository, for everything after, revoked when the job ends.
      mint, ...readBack,
      `PUT /repositories/${id}/actions/permissions`, `POST /repositories/${id}/rulesets`, `POST /repositories/${id}/rulesets`,
      ...readBack, ...two,
      `DELETE ${REVOKE}`,
    ]);
    expect(seen.map((c) => c.auth)).toEqual(seen.map((c) => (c.path.endsWith(TOKENS) ? "app" : "token")));
    expect(seen[0].body).toBeNull();
    expect(seen[3].body).toEqual({ repository_ids: [id] });
    expect(seen.slice(1, 3).map((c) => c.scope)).toEqual(["all", "all"]);
    expect(seen.slice(4).map((c) => c.scope)).toEqual(seen.slice(4).map(() => [id]));
    expect((await github()).liveTokens).toEqual([]);
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
    for (let i = 0; i < 40 && (await indexRow(id)) === null; i++) { await alarmPass(stub(r.id)); await new Promise((x) => setTimeout(x, 50)); }
    expect(await indexRow(id)).toBe(r.id);
    // It doesn't run again: nothing more goes to GitHub, and a retry has nothing to retry.
    await fake("/forget-calls");
    await alarmPass(stub(r.id));
    expect((await github()).calls).toEqual([]);
    expect([(await retry(r)).status, (await retry(r)).code]).toEqual([409, "already_ready"]);
    expect((await ask(r)).code).toBe("repo_request_exists");
  });

  it("makes nothing for a room that doesn't ask", async () => {
    const r = await room();
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.id}/tasks`, { title: "Write the brief", instructions: "Write it." })).status).toBe(200);
    for (let i = 0; i < 3; i++) await alarmPass(stub(r.id));
    expect((await github()).calls).toEqual([]);
    expect(await read(r)).toEqual({ request: null, repository: null, delegated: true, may_request: true });
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
    // The person who asked is no longer the room's owner or an admin of it.
    const moved = await room();
    await pending(moved.id, "per_pv_former_owner");
    expect((await poke(moved)).request).toMatchObject({ state: "failed", reason: "requester_lost_authority" });
    // The room was archived.
    // Archived before the request is there, so an alarm the runtime runs on its own can't find it in an open room.
    const archived = await room();
    await inRoom(archived.id, (sql) => sql.exec("UPDATE workspace SET status = 'archived'"));
    await pending(archived.id, archived.owner.id);
    // Any command arms the room's alarm, refused or not.
    await api(archived.owner, "PUT", `/v1/workspaces/${archived.id}/name`, { name: "Engineering two", policy_version: 1 });
    await alarmPass(stub(archived.id));
    for (let i = 0; i < 40 && (await rowsOf(archived.id, "repo_request"))[0].state === "pending"; i++) { await alarmPass(stub(archived.id)); await new Promise((x) => setTimeout(x, 50)); }
    expect((await rowsOf(archived.id, "repo_request"))[0]).toMatchObject({ state: "failed", reason: "room_archived" });
    expect((await github()).calls).toEqual([]);
    for (const r of [undelegated, moved, archived]) expect(await rowsOf(r.id, "repo_request_attempt")).toEqual([]);
  });

  // `hang` waits out the room's own ten seconds for a call, so this test is given longer than the others.
  it("treats an unknown creation outcome as a failed setup, adopts nothing by name, and retries under a new server-made name (M5-03)", { timeout: 90_000 }, async () => {
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
      await alarmPass(stub(r.id));
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
      expect(destructive(seen)).toEqual([]);
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

    // No token, no creation call: nothing can have been made, and the name wasn't sent, so it isn't burned.
    const noToken = await room({ script: { token: 401 } });
    await ask(noToken);
    expect((await settled(noToken)).request).toMatchObject({ state: "failed", reason: "token_refused" });
    expect(await calls()).toEqual([`POST /app/installations/${GH.installationId}/access_tokens`]);
    expect((await rowsOf(noToken.id, "repo_request_attempt")).map((a) => [a.attempt, a.provider_name, a.outcome])).toEqual([[1, "engineering", "not_sent"]]);
    await fake("/script", { token: 201 });
    await retry(noToken);
    expect((await settled(noToken)).request.state).toBe("ready");
    expect((await rowsOf(noToken.id, "repo_request_attempt")).map((a) => [a.attempt, a.provider_name, a.outcome])).toEqual([[1, "engineering", "not_sent"], [2, "engineering", "created"]]);
    expect((await github()).repos.map((x) => x.name)).toEqual(["engineering"]);

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
      ["Actions can't be read", { actionsRead: 403 }, "read_back_failed", 0],
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
    expect(destructive(seen)).toEqual([]);
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
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_request SET retry_after = NULL"));
    const again = await api(r.owner, "POST", `/v1/workspaces/${r.id}/repository/retry`, {}, { key: "pv-retry" });
    expect(again.body.request.state).toBe("pending");
    // A repeat of the same retry is the same answer, and doesn't move the attempt on twice.
    expect((await api(r.owner, "POST", `/v1/workspaces/${r.id}/repository/retry`, {}, { key: "pv-retry" })).body).toEqual(again.body);
    expect((await rowsOf(r.id, "repo_request"))[0].attempt).toBe(2);
    expect((await settled(r)).request.state).toBe("ready");
  });

  it("is off unless the switch is on, for the commands and for the job", async () => {
    // The Worker's variable is unset in the test runtime, as in every deployment. A room no test switched on is off.
    const r = await room({ switchedOn: false });
    const off = await ask(r);
    expect([off.status, off.code]).toEqual([404, "not_found"]);
    expect(await rowsOf(r.id, "repo_request")).toEqual([]);
    // Still for the owner alone: nobody else learns the switch's state from the answer.
    expect((await ask(r, undefined, { who: STRANGER })).status).toBe(404);
    // A request recorded while it was on doesn't run once it's off, and can't be retried.
    await inRoom(r.id, (sql) => sql.exec("INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, requested_by, requested_at, updated_at) VALUES ('rr_t', 'pending', 'engineering', 'public', 1, 'engineering', ?, 1, 1)", r.owner.id));
    expect((await api(r.owner, "PUT", `/v1/workspaces/${r.id}/name`, { name: "Engineering two", policy_version: (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version })).status).toBe(200);
    // The read isn't there while it's off, so the room's own row says how the request ended.
    for (let i = 0; i < 5 && (await rowsOf(r.id, "repo_request"))[0].state === "pending"; i++) await alarmPass(stub(r.id));
    expect((await rowsOf(r.id, "repo_request"))[0]).toMatchObject({ state: "failed", reason: "managed_repositories_off" });
    expect((await retry(r)).status).toBe(404);
    expect((await github()).calls).toEqual([]);
    expect(await rowsOf(r.id, "repo_request_attempt")).toEqual([]);
  });

  it("is set for staging only in the Worker's configuration, beside the list of who may ask, with no key beside it", () => {
    // This reads the configuration file. A variable set on the deployed Worker by hand wouldn't show here.
    // The owner said "let's unblock m5 staging" on 2026-11-11. The architect took the switch out again that day, since
    // staging's sign-in is open to anyone, and put it back with `REPOSITORY_REQUESTERS`: on staging only the operators
    // the `OPERATORS` secret names and test people may ask, and no person's ID is in the file. The switch, that list, the organization and the three Apps' IDs
    // are staging's variables. The top level, which local runs and these tests use, and any other environment set none.
    const config = JSON.parse(BINDINGS.TEST_WRANGLER.replace(/^\s*\/\/.*$/gm, ""));
    // Wherever the switch is on, the list is set, to something that isn't everyone. Unset would be everyone.
    for (const [environment, scope] of [["top level", config], ...Object.entries<any>(config.env)] as [string, any][]) {
      if (scope.vars?.MANAGED_REPOSITORIES === undefined) continue;
      expect(scope.vars.REPOSITORY_REQUESTERS, environment).toMatch(/^(operators|test-people|per_[A-Za-z0-9_-]+)(,(operators|test-people|per_[A-Za-z0-9_-]+))*$/);
    }
    const staging: Record<string, string> = {
      MANAGED_REPOSITORIES: "true",
      REPOSITORY_REQUESTERS: "operators,test-people",
      GITHUB_ORG_LOGIN: "podsterdev",
      GITHUB_ORG_ID: "354820586",
      GITHUB_PROVISION_APP_ID: "5695065",
      GITHUB_PROVISION_INSTALLATION_ID: "180477080",
      GITHUB_AGENT_APP_ID: "5695079",
      GITHUB_AGENT_INSTALLATION_ID: "180477157",
      GITHUB_MERGE_APP_ID: "5695088",
      GITHUB_MERGE_INSTALLATION_ID: "180477225",
    };
    expect(Object.keys(config.env)).toContain("staging");
    for (const [name, value] of Object.entries(staging)) {
      expect(config.vars?.[name], name).toBeUndefined();
      for (const [environment, scope] of Object.entries<any>(config.env)) expect(scope.vars?.[name], `${environment} ${name}`).toBe(environment === "staging" ? value : undefined);
      expect(BINDINGS.TEST_WRANGLER.match(new RegExp(`"${name}"`, "g")), name).toHaveLength(1);
    }
    // Three roles, three Apps and three installations, each a positive number, as `github.rs` asks.
    for (const kind of ["APP_ID", "INSTALLATION_ID"]) expect(new Set(["PROVISION", "AGENT", "MERGE"].map((role) => staging[`GITHUB_${role}_${kind}`])).size, kind).toBe(3);
    for (const [name, value] of Object.entries(staging)) if (name.endsWith("_ID")) expect(value, name).toMatch(/^[1-9][0-9]*$/);
    // The keys are secrets, and the owner's to set. None is named anywhere in the file.
    for (const name of ["GITHUB_PROVISION_APP_KEY", "GITHUB_AGENT_APP_KEY", "GITHUB_MERGE_APP_KEY", "REPO_TOKEN_KEY", "REPO_TOKEN_KEY_PREVIOUS"]) expect(BINDINGS.TEST_WRANGLER, name).not.toContain(name);
    expect(BINDINGS.MANAGED_REPOSITORIES).toBeUndefined();
  });

  it("holds no token once it's done, however it ends, and never uses the installation's own token past the creation call", async () => {
    const endings: [string, object, string][] = [
      ["creation refused", { create: ["forbidden"] }, "provider_refused"],
      ["creation's answer lost", { create: ["lost"] }, "creation_outcome_unknown"],
      ["the read-back failed", { readRepo: 500 }, "read_back_failed"],
      ["a setup call was refused", { ruleset: "forbidden" }, "setup_call_failed"],
      ["the read-back wasn't right", { ruleset: "inactive" }, "ruleset_inactive"],
    ];
    for (const [what, script, reason] of endings) {
      const r = await room({ script });
      await ask(r);
      expect((await settled(r)).request.reason, what).toBe(reason);
      const { calls: seen, liveTokens } = await github();
      expect(liveTokens, what).toEqual([]);
      // The broad token made one call, the creation, and was revoked straight after it.
      const broad = seen.filter((c) => c.scope === "all").map((c) => `${c.method} ${c.path}`);
      expect(broad, what).toEqual([`POST /orgs/${GH.orgLogin}/repos`, `DELETE ${REVOKE}`]);
      // As many revocations as tokens.
      expect(seen.filter((c) => c.path === REVOKE).length, what).toBe(seen.filter((c) => c.path.endsWith(TOKENS)).length);
    }
    // A retry on a held repository never mints the broad token at all.
    const held = await room({ script: { readRepo: 500 } });
    await ask(held);
    await settled(held);
    await fake("/script", { readRepo: null });
    await fake("/forget-calls");
    await retry(held);
    expect((await settled(held)).request.state).toBe("ready");
    const after = await github();
    expect(after.calls.filter((c) => c.scope === "all")).toEqual([]);
    expect(after.calls.find((c) => c.path.endsWith(TOKENS))?.body).toEqual({ repository_ids: [after.repos[0].id] });
    expect(after.liveTokens).toEqual([]);
  });

  it("finishes all the same when a token can't be revoked, and says so by ID", async () => {
    const lines: string[] = [];
    for (const level of ["log", "error"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const r = await room({ script: { revoke: 500 } });
    await ask(r);
    expect((await settled(r)).request.state).toBe("ready");
    const said = lines.filter((line) => line.includes("provision.token_not_revoked")).map((line) => JSON.parse(line));
    // Both are counted: the installation's own token, which could still administer every repository, and the narrowed one.
    expect(said).toEqual([{ at: "provision.token_not_revoked", room: r.id, request: expect.stringMatching(/^rr_/), count: 2 }]);
    const after = await github();
    expect(after.calls.filter((c) => c.path === REVOKE)).toHaveLength(2);
    expect(after.liveTokens).toHaveLength(2);
    expect(after.liveTokens).toContain("all");
    // A job that never gets past the creation call reports the broad token just the same.
    lines.length = 0;
    const refused = await room({ script: { revoke: 500, create: ["forbidden"] } });
    await ask(refused);
    expect((await settled(refused)).request.reason).toBe("provider_refused");
    expect(lines.filter((line) => line.includes("provision.token_not_revoked")).map((line) => JSON.parse(line))).toEqual([{ at: "provision.token_not_revoked", room: refused.id, request: expect.stringMatching(/^rr_/), count: 1 }]);
    for (const line of lines) expect(line).not.toContain("ghs_fake_");
  });

  it("ends uncertain, never failed, when anything goes wrong after the creation call and before its outcome is on record", async () => {
    const r = await room();
    // The room can't record that the call created something: as if it broke between GitHub's 201 and its own write.
    await inRoom(r.id, (sql) => sql.exec("CREATE TRIGGER lose_created BEFORE UPDATE ON repo_request_attempt WHEN NEW.outcome = 'created' BEGIN SELECT RAISE(ABORT, 'lost'); END"));
    await ask(r);
    const ended = await settled(r);
    // A repository exists at GitHub, and the room holds no ID for it. That is unknown, not failed.
    expect(ended.request).toMatchObject({ state: "uncertain", reason: "creation_outcome_unknown" });
    expect(ended.repository).toBeNull();
    expect((await rowsOf(r.id, "repo_request"))[0].provider_repo_id).toBeNull();
    // The attempt keeps the name an operator would look for.
    expect((await rowsOf(r.id, "repo_request_attempt")).map((a) => [a.attempt, a.provider_name, a.outcome])).toEqual([[1, "engineering", "uncertain"]]);
    const { repos, liveTokens } = await github();
    expect(repos.map((x) => x.name)).toEqual(["engineering"]);
    expect(liveTokens).toEqual([]);
    // A retry goes out under a new name, and the orphan is left alone.
    await inRoom(r.id, (sql) => sql.exec("DROP TRIGGER lose_created"));
    await retry(r);
    const ready = await settled(r);
    expect(ready.request.state).toBe("ready");
    expect(ready.repository.provider_repo_id).not.toBe(repos[0].id);
  });

  it("leaves a request it can't even end alone for a while, keeps that wait in the room, and never sends the creation call again", async () => {
    const r = await room();
    // Nothing about the attempt can be written at all, so the job can't record how it ended.
    await inRoom(r.id, (sql) => sql.exec("CREATE TRIGGER stuck BEFORE UPDATE ON repo_request_attempt BEGIN SELECT RAISE(ABORT, 'stuck'); END"));
    const before = Date.now();
    await ask(r);
    const waiting = async () => { for (let i = 0; i < 12; i++) { await alarmPass(stub(r.id)); await new Promise((x) => setTimeout(x, 50)); } return (await rowsOf(r.id, "repo_request"))[0]; };
    const first = await waiting();
    expect(first).toMatchObject({ state: "pending", runs: 1, job_failures: 1 });
    // The wait is a column in the room, not a number in memory, so a restart doesn't forget it. Five seconds at first.
    expect(first.job_not_before).toBeGreaterThanOrEqual(before + 5_000);
    expect(first.job_not_before).toBeLessThanOrEqual(Date.now() + 5_000);
    const sent = (await github()).calls.length;
    expect((await github()).calls.filter((c) => c.path.endsWith("/repos"))).toHaveLength(1);
    // The alarm comes back, and the job stays away: nothing more goes to GitHub inside the wait.
    expect(await waiting()).toMatchObject({ runs: 1, job_failures: 1, job_not_before: first.job_not_before });
    expect((await github()).calls.length).toBe(sent);
    // The wait over, as a restarted room would read it from the column. The job runs, sees an attempt whose call may have
    // gone out, sends nothing, still can't end the request, and waits twice as long.
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_request SET job_not_before = 1"));
    const again = Date.now();
    const second = await waiting();
    expect(second).toMatchObject({ state: "pending", runs: 2, job_failures: 2 });
    expect(second.job_not_before).toBeGreaterThanOrEqual(again + 10_000);
    expect((await github()).calls.filter((c) => c.path.endsWith("/repos"))).toHaveLength(1);
    // And it holds itself to the run limit with no retry to refuse: at five runs it goes to GitHub for nothing at all.
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_request SET runs = 5, job_not_before = 1"));
    await fake("/forget-calls");
    const capped = await waiting();
    expect(capped.runs).toBe(5);
    expect((await github()).calls).toEqual([]);
    // Once the room can write again, that's how the request ends, and the wait is cleared.
    await inRoom(r.id, (sql) => { sql.exec("DROP TRIGGER stuck"); sql.exec("UPDATE repo_request SET job_not_before = 1"); });
    const ended = await settled(r);
    expect(ended.request.state).toBe("uncertain");
    expect((await rowsOf(r.id, "repo_request"))[0]).toMatchObject({ runs: 5, job_failures: 0, job_not_before: null });
    expect((await github()).calls).toEqual([]);
  });

  it("holds a held repository to the run limit in the job itself", async () => {
    // A request that is pending at the limit with a repository ID held, as after a run whose ending couldn't be written.
    const r = await room();
    await inRoom(r.id, (sql) => sql.exec("INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, provider_repo_id, requested_by, requested_at, updated_at, runs) VALUES ('rr_t', 'pending', 'engineering', 'public', 1, 'engineering', 9001, ?, 1, 1, 5)", r.owner.id));
    expect((await api(r.owner, "PUT", `/v1/workspaces/${r.id}/name`, { name: "Engineering two", policy_version: (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version })).status).toBe(200);
    expect((await settled(r)).request).toMatchObject({ state: "failed", reason: "retry_limit_reached" });
    expect((await github()).calls).toEqual([]);
    expect((await rowsOf(r.id, "repo_request"))[0].runs).toBe(5);
    expect((await retry(r)).code).toBe("retry_limit_reached");
  });

  it("makes a retry wait, longer each time, and takes no more after the fifth run", async () => {
    const r = await room({ script: { create: ["forbidden"] } });
    await ask(r);
    const before = Date.now();
    await settled(r);
    const [first] = await rowsOf(r.id, "repo_request");
    expect(first.runs).toBe(1);
    // The owner is told how many runs are left: the cap less the runs so far.
    expect((await read(r)).request.attempts_left).toBe(4);
    // A minute after the first run.
    expect(first.retry_after).toBeGreaterThanOrEqual(before + 60_000);
    expect(first.retry_after).toBeLessThanOrEqual(Date.now() + 60_000);
    const soon = await retry(r, undefined, true);
    expect([soon.status, soon.code]).toEqual([429, "retry_too_soon"]);
    expect((await rowsOf(r.id, "repo_request"))[0].state).toBe("failed");
    // Once the wait is over the retry is taken, and the next wait is twice as long.
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_request SET retry_after = ?", Date.now() - 1));
    expect((await retry(r, undefined, true)).status).toBe(200);
    const again = Date.now();
    await settled(r);
    const [second] = await rowsOf(r.id, "repo_request");
    expect(second.runs).toBe(2);
    expect(second.retry_after).toBeGreaterThanOrEqual(again + 120_000);
    // Three more runs, and that's all a room gets.
    for (let run = 3; run <= 5; run++) {
      expect((await retry(r)).status, String(run)).toBe(200);
      await settled(r);
      expect((await rowsOf(r.id, "repo_request"))[0].runs).toBe(run);
      expect((await read(r)).request.attempts_left, String(run)).toBe(5 - run);
    }
    const over = await retry(r);
    expect([over.status, over.code]).toEqual([409, "retry_limit_reached"]);
    // Waiting doesn't help, and nothing went to GitHub for the refused retry.
    await fake("/forget-calls");
    await inRoom(r.id, (sql) => sql.exec("UPDATE repo_request SET retry_after = 0"));
    expect((await retry(r, undefined, true)).code).toBe("retry_limit_reached");
    await alarmPass(stub(r.id));
    expect((await github()).calls).toEqual([]);
    expect((await rowsOf(r.id, "repo_request_attempt")).map((a) => a.attempt)).toEqual([1, 2, 3, 4, 5]);
  });

  it("takes a routing row from a room that says the repository isn't its own, and leaves one whose room says it is", async () => {
    const r = await room({ script: { nextId: 61000 } });
    // A stale row, left pointing at a room that was never made.
    await BINDINGS.DB.prepare("INSERT INTO repo_room_index (provider, provider_repo_id, workspace_id) VALUES ('github', 61000, 'ws_pv_never_made')").run();
    await ask(r);
    expect((await settled(r)).repository.provider_repo_id).toBe(61000);
    for (let i = 0; i < 40 && (await indexRow(61000)) !== r.id; i++) { await alarmPass(stub(r.id)); await new Promise((x) => setTimeout(x, 50)); }
    expect(await indexRow(61000)).toBe(r.id);
    expect((await rowsOf(r.id, "repo_link"))[0].indexed_at).toBeGreaterThan(0);
    // A second room that claims the same ID doesn't take the row: the first room confirms it.
    const squatter = await room({ script: { nextId: 62000 } });
    await inRoom(squatter.id, (sql) => sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, updated_at) VALUES ('rl_x', 'rr_x', 'github', 61000, 4242, 'x/y', 'public', 'main', 'ready', 'per_x', 1, 1)"));
    expect((await api(squatter.owner, "PUT", `/v1/workspaces/${squatter.id}/name`, { name: "Squatter", policy_version: (await api(squatter.owner, "GET", `/v1/workspaces/${squatter.id}`)).body.policy_version })).status).toBe(200);
    for (let i = 0; i < 40 && (await rowsOf(squatter.id, "repo_link"))[0].indexed_at === null; i++) { await alarmPass(stub(squatter.id)); await new Promise((x) => setTimeout(x, 50)); }
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

// A deployment's own list of who may ask (`REPOSITORY_REQUESTERS`), added after M5's security review. The Worker's
// variable is unset here, as the first test checks, so each room is given a setting of its own by a table only a test
// build reads, where `provisioning::requesters` reads the variable in a deployment.
describe("a deployment's list of repository requesters", () => {
  /** Gives one room the setting, as if the Worker's variable held `value`. */
  const listed = (id: string, value: string) => inRoom(id, (sql) => {
    sql.exec("CREATE TABLE IF NOT EXISTS test_repository_requesters (value TEXT)");
    sql.exec("DELETE FROM test_repository_requesters");
    sql.exec("INSERT INTO test_repository_requesters VALUES (?)", value);
  });
  const unset = (id: string) => inRoom(id, (sql) => void sql.exec("DROP TABLE IF EXISTS test_repository_requesters"));
  const CLOSED = [403, "repository_requests_closed"];
  const policyOf = async (r: { id: string; owner: Who }) => (await api(r.owner, "GET", `/v1/workspaces/${r.id}`)).body.policy_version;
  const person = async (r: { id: string; org: string; owner: Who }, id: string, role: string) => {
    const who: Who = { id, kind: "person", org: r.org, adminOrgs: [] };
    const added = await api(r.owner, "POST", `/v1/workspaces/${r.id}/members`, { principal_id: who.id, kind: "person", org_id: r.org, role, policy_version: await policyOf(r) }, { claims: { target_member: { person: who.id, orgs: { [r.org]: 1 } } } });
    expect(added.status, added.text).toBe(200);
    return who;
  };
  const failedRequest = (id: string, by: string) => inRoom(id, (sql) => void sql.exec("INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, reason, requested_by, requested_at, updated_at) VALUES ('rr_f', 'failed', 'engineering', 'public', 1, 'engineering', 'name_taken', ?, 1, 1)", by));
  /** Everything a refused request must leave as it was: no request, no event, no place in either count, nothing at GitHub. */
  const untouched = async (r: { id: string; org: string }, people: string[], events: string[]) => {
    expect(await rowsOf(r.id, "repo_request")).toEqual([]);
    expect(await rowsOf(r.id, "repo_request_attempt")).toEqual([]);
    expect(await eventTypes(r.id)).toEqual(events);
    for (const holder of [r.org, ...people]) expect(await counted(holder), holder).not.toContain(r.id);
    expect((await github()).calls).toEqual([]);
  };

  it("lets everyone the room's rule lets while the setting is unset, as this runtime has it", async () => {
    expect(BINDINGS.REPOSITORY_REQUESTERS).toBeUndefined();
    const r = await room();
    expect((await read(r)).may_request).toBe(true);
    expect((await ask(r)).status).toBe(200);
  });

  it("refuses an owner who isn't listed, with nothing recorded, nothing counted and nothing sent to GitHub, and takes them once they are", async () => {
    const r = await room();
    const events = await eventTypes(r.id);
    await listed(r.id, "per_pv_someone_else");
    const refused = await ask(r);
    expect([refused.status, refused.code]).toEqual(CLOSED);
    // The refusal says nothing of who is listed.
    expect(refused.text).not.toContain("per_pv_someone_else");
    expect(refused.body).toEqual({ error: { code: "repository_requests_closed", message: expect.any(String) } });
    // Under another key, and the same key again: the same refusal each time, and still no place taken.
    expect((await ask(r, undefined, { key: "pv-closed-key" })).code).toBe("repository_requests_closed");
    expect((await ask(r, undefined, { key: "pv-closed-key" })).code).toBe("repository_requests_closed");
    await untouched(r, [r.owner.id], events);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT action FROM audit_event WHERE action LIKE 'repository.%'").toArray())).toEqual([]);
    // The read says so before anyone asks, and a request the room wouldn't take for its own reasons is refused the same.
    expect((await read(r)).may_request).toBe(false);
    expect((await ask(r, { name: "engineering", visibility: "private" })).code).toBe("repository_requests_closed");
    expect((await ask(r, { nonsense: true })).code).toBe("repository_requests_closed");
    // Listed, the same person asks and the repository is made.
    await listed(r.id, `per_pv_someone_else,${r.owner.id}`);
    expect((await read(r)).may_request).toBe(true);
    expect((await ask(r)).status).toBe(200);
    expect(await counted(r.org)).toContain(r.id);
    expect(await counted(r.owner.id)).toContain(r.id);
    expect((await settled(r)).request.state).toBe("ready");
  });

  it("refuses a retry by someone who isn't listed the same way, and leaves the failed request as it was", async () => {
    const r = await room();
    await failedRequest(r.id, r.owner.id);
    const before = await rowsOf(r.id, "repo_request");
    const events = await eventTypes(r.id);
    await listed(r.id, "per_pv_someone_else");
    const refused = await retry(r);
    expect([refused.status, refused.code]).toEqual(CLOSED);
    expect(await rowsOf(r.id, "repo_request")).toEqual(before);
    expect(await eventTypes(r.id)).toEqual(events);
    expect((await github()).calls).toEqual([]);
    for (const holder of [r.org, r.owner.id]) expect(await counted(holder)).not.toContain(r.id);
    expect((await read(r)).may_request).toBe(false);
    // Listed, the retry is taken.
    await listed(r.id, r.owner.id);
    expect((await retry(r)).status).toBe(200);
    expect((await rowsOf(r.id, "repo_request"))[0].state).toBe("pending");
  });

  it("takes test people only with the entry for them, and a test person's ID is only ever the verified caller's", async () => {
    await fake("/reset", {});
    const tag = crypto.randomUUID().replaceAll("-", "");
    const org = `org_pv_e2e_${tag.slice(0, 8)}`;
    const testPerson: Who = { id: `per_e2e_${tag}`, kind: "person", org, adminOrgs: [org] };
    const r = await roomOf(testPerson);
    const events = await eventTypes(r.id);
    // A list without the entry holds no test person.
    await listed(r.id, "per_pv_someone_else");
    expect((await ask(r)).code).toBe("repository_requests_closed");
    expect((await read(r)).may_request).toBe(false);
    await untouched(r, [testPerson.id], events);
    // With it, a test person asks.
    await listed(r.id, "per_pv_someone_else,test-people");
    expect((await read(r)).may_request).toBe(true);
    // Someone else in the room who only says they're a test person, in a body, a header or a claim, is who the
    // assertion's subject says they are.
    const ordinary = await person(r, `per_pv_ordinary_${tag.slice(0, 8)}`, "admin");
    const pretending = await api(ordinary, "POST", `/v1/workspaces/${r.id}/repository`, { name: "engineering", visibility: "public", person: testPerson.id, requested_by: testPerson.id }, { claims: { test_person: true, person: testPerson.id } });
    expect([pretending.status, pretending.code]).toEqual(CLOSED);
    const plain = await ask(r, undefined, { who: ordinary });
    expect([plain.status, plain.code]).toEqual(CLOSED);
    expect((await api(ordinary, "GET", `/v1/workspaces/${r.id}/repository`)).body.may_request).toBe(false);
    await untouched(r, [testPerson.id, ordinary.id], [...events, ...(await eventTypes(r.id)).slice(events.length)]);
    expect((await ask(r)).status).toBe(200);
    expect((await rowsOf(r.id, "repo_request"))[0].requested_by).toBe(testPerson.id);
  });

  it("is nobody when the setting is empty or malformed, even for an ID that's in it", async () => {
    const r = await room();
    const events = await eventTypes(r.id);
    await failedRequest(r.id, r.owner.id);
    for (const value of ["", " ", ",", `${r.owner.id},`, `${r.owner.id},,test-people`, `${r.owner.id};per_pv_two`, `${r.owner.id},everyone`, "*", "all", "true", `${r.owner.id}\n`]) {
      await listed(r.id, value);
      expect((await retry(r)).code, JSON.stringify(value)).toBe("repository_requests_closed");
      expect((await read(r)).may_request, JSON.stringify(value)).toBe(false);
    }
    // And for a first request, in a room with none.
    const fresh = await roomOf(r.owner);
    for (const value of ["", `${r.owner.id},`, "*"]) {
      await listed(fresh.id, value);
      expect((await ask(fresh)).code, JSON.stringify(value)).toBe("repository_requests_closed");
    }
    expect(await rowsOf(fresh.id, "repo_request")).toEqual([]);
    expect(await eventTypes(r.id)).toEqual(events);
    for (const holder of [r.org, r.owner.id]) for (const id of [r.id, fresh.id]) expect(await counted(holder)).not.toContain(id);
    expect((await github()).calls).toEqual([]);
  });

  it("takes the deployment's operators only with the entry for them, and nobody by it when no operator is configured", async () => {
    // This runtime's OPERATORS names `per_operator_one` and `per_operator_two`, as moderation's tests use them.
    expect(BINDINGS.OPERATORS).toBe("per_operator_one, per_operator_two");
    await fake("/reset", {});
    const tag = crypto.randomUUID().slice(0, 8);
    const org = `org_pv_ops_${tag}`;
    const operator: Who = { id: "per_operator_one", kind: "person", org, adminOrgs: [org] };
    const r = await roomOf(operator);
    const events = await eventTypes(r.id);
    const other = await person(r, `per_pv_notop_${tag}`, "admin");
    const told = async (who: Who) => (await api(who, "GET", `/v1/workspaces/${r.id}/repository`)).body.may_request;
    // No entry: an operator isn't implied, beside test people or anyone else.
    for (const value of ["test-people", "per_pv_someone_else", "per_pv_someone_else,test-people"]) {
      await listed(r.id, value);
      expect((await ask(r)).code, value).toBe("repository_requests_closed");
      expect(await told(operator), value).toBe(false);
    }
    // A word that only looks like the entry closes the whole list.
    for (const value of ["operator", "Operators", "operators,admins", "operators,"]) {
      await listed(r.id, value);
      expect((await ask(r)).code, value).toBe("repository_requests_closed");
    }
    // The entry, with no operator configured: it admits nobody.
    await listed(r.id, "operators,test-people");
    await inRoom(r.id, (sql) => void sql.exec("CREATE TABLE test_no_operators (x INTEGER)"));
    expect((await ask(r)).code).toBe("repository_requests_closed");
    expect(await told(operator)).toBe(false);
    await inRoom(r.id, (sql) => void sql.exec("DROP TABLE test_no_operators"));
    // The entry, and a caller who isn't among the operators: refused, whatever they send.
    const pretending = await api(other, "POST", `/v1/workspaces/${r.id}/repository`, { name: "engineering", visibility: "public", operator: true }, { claims: { operator: true, operators: [other.id] } });
    expect([pretending.status, pretending.code]).toEqual(CLOSED);
    expect(await told(other)).toBe(false);
    await untouched(r, [operator.id, other.id], [...events, ...(await eventTypes(r.id)).slice(events.length)]);
    // An agent stored as an admin gets the room's own refusal, the entry or not.
    const agent = await memberAgent(r);
    await inRoom(r.id, (sql) => void sql.exec("UPDATE member SET role = 'admin' WHERE principal_id = ?", agent.id));
    expect((await ask(r, undefined, { who: agent })).code).toBe("not_allowed");
    // The entry, and the caller among the operators: they ask, and the repository is made.
    expect(await told(operator)).toBe(true);
    expect((await ask(r)).status).toBe(200);
    expect((await rowsOf(r.id, "repo_request"))[0].requested_by).toBe(operator.id);
    expect((await settled(r)).request.state).toBe("ready");
  });

  it("stops a request an operator made once the deployment names no operator, before anything goes to GitHub", async () => {
    await fake("/reset", {});
    const org = `org_pv_ops2_${crypto.randomUUID().slice(0, 8)}`;
    const operator: Who = { id: "per_operator_two", kind: "person", org, adminOrgs: [org] };
    const r = await roomOf(operator);
    await listed(r.id, "operators");
    await alarmQuiet(stub(r.id));
    expect((await ask(r)).status).toBe(200);
    await inRoom(r.id, (sql) => void sql.exec("CREATE TABLE test_no_operators (x INTEGER)"));
    for (let i = 0; i < 40 && (await rowsOf(r.id, "repo_request"))[0].state === "pending"; i++) await alarmPass(stub(r.id));
    expect((await rowsOf(r.id, "repo_request"))[0]).toMatchObject({ state: "failed", reason: "repository_requests_closed" });
    expect((await github()).calls).toEqual([]);
  });

  it("answers the room's own rule first, so only someone who could otherwise ask learns that requests are closed", async () => {
    const r = await room();
    const tag = crypto.randomUUID().slice(0, 8);
    const admin = await person(r, `per_pv_la_${tag}`, "admin");
    const member = await person(r, `per_pv_lm_${tag}`, "member");
    const agent = await memberAgent(r);
    await inRoom(r.id, (sql) => void sql.exec("UPDATE member SET role = 'admin' WHERE principal_id = ?", agent.id));
    await failedRequest(r.id, r.owner.id);
    // Listing a member, an agent or a stranger gives them nothing: the list only narrows.
    await listed(r.id, `${admin.id},${member.id},${STRANGER.id}`);
    for (const [who, status, code] of [[member, 403, "not_allowed"], [agent, 403, "not_allowed"], [STRANGER, 404, "workspace_not_found"], [r.owner, 403, "repository_requests_closed"]] as [Who, number, string][]) {
      const again = await retry(r, who);
      expect([again.status, again.code], who.id).toEqual([status, code]);
    }
    expect((await api(member, "GET", `/v1/workspaces/${r.id}/repository`)).body.may_request).toBe(false);
    expect((await read(r)).may_request).toBe(false);
    expect((await api(admin, "GET", `/v1/workspaces/${r.id}/repository`)).body.may_request).toBe(true);
    // The listed admin retries, while the owner, who isn't listed, can't.
    expect((await retry(r, admin)).status).toBe(200);
    expect((await github()).calls.filter((c) => c.method !== "GET" && !tokenCall(c))).toEqual([]);
  });

  it("answers as a missing route while managed repositories are off, whoever is listed", async () => {
    const off = await room({ switchedOn: false });
    for (const value of ["per_pv_someone_else", off.owner.id, ""]) {
      await listed(off.id, value);
      expect((await ask(off)).status, value).toBe(404);
      expect((await retry(off)).status, value).toBe(404);
      expect((await api(off.owner, "GET", `/v1/workspaces/${off.id}/repository`)).status, value).toBe(404);
    }
    expect(await rowsOf(off.id, "repo_request")).toEqual([]);
  });

  it("stops a request recorded under a wider setting before anything goes to GitHub, and replays no stored answer to someone who isn't listed", async () => {
    const r = await room();
    await alarmQuiet(stub(r.id));
    const first = await ask(r, undefined, { key: "pv-narrowed-key" });
    expect(first.status).toBe(200);
    // The setting is narrowed before the job has run.
    await listed(r.id, "per_pv_someone_else");
    const replay = await ask(r, undefined, { key: "pv-narrowed-key" });
    expect([replay.status, replay.code]).toEqual(CLOSED);
    for (let i = 0; i < 40 && (await rowsOf(r.id, "repo_request"))[0].state === "pending"; i++) await alarmPass(stub(r.id));
    expect((await rowsOf(r.id, "repo_request"))[0]).toMatchObject({ state: "failed", reason: "repository_requests_closed" });
    expect((await github()).calls).toEqual([]);
    expect(await rowsOf(r.id, "repo_request_attempt")).toEqual([]);
    // Listed again, a retry runs it.
    await unset(r.id);
    expect((await retry(r)).status).toBe(200);
    expect((await settled(r)).request.state).toBe("ready");
  });

  it("leaves a room that already has its repository working when nobody in it is listed: the read and the grants", async () => {
    const r = await room();
    expect((await ask(r)).status).toBe(200);
    expect((await settled(r)).request.state).toBe("ready");
    const agent = await memberAgent(r);
    for (const value of ["per_pv_someone_else", ""]) {
      await listed(r.id, value);
      const now = await read(r);
      expect(now.repository).toMatchObject({ status: "ready" });
      expect(now.request).toMatchObject({ state: "ready" });
      expect(now.may_request).toBe(false);
      const given = await api(r.owner, "POST", `/v1/workspaces/${r.id}/repository/grants`, { policy_version: await policyOf(r), principal_id: agent.id, action: "push" });
      expect([given.status, given.body.state], value).toEqual([200, "live"]);
      const all = await api(r.owner, "GET", `/v1/workspaces/${r.id}/repository/grants`);
      expect(all.status).toBe(200);
      const taken = await api(r.owner, "DELETE", `/v1/workspaces/${r.id}/repository/grants/${given.body.id}`, { policy_version: await policyOf(r) });
      expect(taken.status, taken.text).toBe(200);
    }
  });
});
