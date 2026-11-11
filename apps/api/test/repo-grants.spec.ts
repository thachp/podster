import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// M5 step 5b: the room's owner gives and takes back `push` and `merge` grants on the room's repository, a list of them
// for people, and the two commands that end grants as a side effect: removing a participant, and moving ownership. Links
// are written straight into the room, because provisioning (step 4) isn't built. Nothing here issues a token or merges.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; claims?: object };
const ORG = "org_rg";
const OWNER: Who = { id: "per_rg_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const ADMIN: Who = { id: "per_rg_admin", kind: "person", org: ORG };
// In the room as a member, and an admin of the room's organization by the gateway's assertion.
const ORG_ADMIN: Who = { id: "per_rg_orgadmin", kind: "person", org: ORG, adminOrgs: [ORG] };
const MEMBER: Who = { id: "per_rg_member", kind: "person", org: ORG };
const GUEST: Who = { id: "per_rg_guest", kind: "person", org: ORG };
const AGENT: Who = { id: "agt_rg_agent", org: ORG };
const OTHER_AGENT: Who = { id: "agt_rg_other", org: ORG };
const PUBLIC_AGENT: Who = { id: "agt_rg_public", org: ORG };
const OUTSIDE_AGENT: Who = { id: "agt_rg_outside", org: ORG };
const STRANGER: Who = { id: "per_rg_stranger", kind: "person", org: "org_rg_x", adminOrgs: ["org_rg_x"] };
const orgAdmin = (org: string): Who => ({ id: `per_rg_admin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }), ...who.claims, ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, options: { key?: string | null; claims?: object; fail?: boolean } = {}) {
  const b = body as any;
  // The gateway states this when its directory says the person being added belongs to the organization.
  const claims = options.claims ?? (method === "POST" && /\/members$/.test(path) && b?.kind === "person" ? { target_member: { person: b.principal_id, orgs: { [ORG]: 1 } } } : {});
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, claims), "content-type": "application/json" };
  if (method !== "GET" && options.key !== null) headers["idempotency-key"] = options.key ?? `rg-key-${++counter}`;
  if (options.fail) headers["x-test-fail"] = "1";
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, text };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [AGENT, OTHER_AGENT, PUBLIC_AGENT, OUTSIDE_AGENT]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

afterEach(() => vi.restoreAllMocks());

const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version as number;
const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const grants = (id: string) => `/v1/workspaces/${id}/repository/grants`;

/** A room with a link, an admin, an organization's admin as a member, a member and a guest who are people, two agents,
 * and an agent that joined through a public claim. */
async function room(options: { link?: string | null } = {}) {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
  const people = [[ADMIN, "admin"], [ORG_ADMIN, "member"], [MEMBER, "member"], [GUEST, "guest"]] as const;
  for (const [who, role] of people) {
    const added = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "person", org_id: ORG, role, policy_version: await version(id) });
    expect(added.status, `add ${who.id}: ${added.text}`).toBe(200);
  }
  for (const [who, role] of [[AGENT, "member"], [OTHER_AGENT, "member"], [PUBLIC_AGENT, "guest"]] as const) {
    const added = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: ORG, role, policy_version: await version(id) });
    expect(added.status, `add ${who.id}: ${added.text}`).toBe(200);
  }
  await inRoom(id, (sql) => {
    sql.exec("UPDATE member SET joined_via = 'public' WHERE principal_id = ?", PUBLIC_AGENT.id);
    // Managed repositories switched on for this room: while they're off, none of these routes is there.
    sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)");
  });
  if (options.link !== null) await link(id, options.link ?? "ready");
  return id;
}

const REPO_ID = 4815162342;
const link = (id: string, status: string) => inRoom(id, (sql) => {
  sql.exec("DELETE FROM repo_link");
  sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/engineering', 'public', 'main', ?, ?, 1000, 2000, 2000)", REPO_ID, status, OWNER.id);
});

const give = async (id: string, principal: string, action: string, extra: object = {}, who: Who = OWNER, options: { key?: string | null } = {}) =>
  api(who, "POST", grants(id), { policy_version: await version(id), principal_id: principal, action, ...extra }, options);
const take = async (id: string, grant: string, who: Who = OWNER, options: { key?: string | null; claims?: object } = {}) =>
  api(who, "DELETE", `${grants(id)}/${grant}`, { policy_version: await version(id) }, options);

const grantRows = (id: string) => inRoom(id, (sql) => sql.exec("SELECT id, principal_id, provider, provider_repo_id, action, delegated_by, expires_at, revoked_at, revoked_by FROM provider_grant ORDER BY created_at, id").toArray() as any[]);
const audits = async (id: string, action: string) => (await inRoom(id, (sql) => sql.exec("SELECT actor_id, target_id, prior_json, new_json FROM audit_event WHERE action = ? ORDER BY seq", action).toArray() as any[]))
  .map((a) => ({ ...a, prior_json: a.prior_json && JSON.parse(a.prior_json), new_json: a.new_json && JSON.parse(a.new_json) }));
const events = (id: string, type: string) => inRoom(id, (sql) => sql.exec("SELECT actor_id, subject_id FROM event WHERE type = ? ORDER BY seq", type).toArray() as any[]);
const footprint = (id: string) => inRoom(id, (sql) => ({
  grants: sql.exec("SELECT count(*) AS n FROM provider_grant").one().n,
  events: sql.exec("SELECT count(*) AS n FROM event").one().n,
  audit: sql.exec("SELECT count(*) AS n FROM audit_event").one().n,
  version: sql.exec("SELECT policy_version AS v FROM workspace").one().v,
}));
const holdOutbox = (id: string) => inRoom(id, (sql) => void sql.exec("CREATE TABLE test_hold_outbox (x)"));
/** Who a grant's revocation was sent to, read while delivery is held. */
const toldOfRevocation = (id: string) => inRoom(id, (sql) => sql.exec("SELECT o.recipient_principal_id AS r FROM outbox o JOIN event e ON e.id = o.event_id WHERE e.type = 'repo_grant.revoked' ORDER BY o.recipient_principal_id").toArray().map((row: any) => row.r) as string[]);
const flush = (id: string) => runInDurableObject(stub(id), (instance: any) => instance.alarm());

describe("giving a grant", () => {
  it("lets the room's owner give a participant one action on the room's repository, audited and told to them", async () => {
    const id = await room();
    const before = await version(id);
    const given = await give(id, AGENT.id, "push");
    expect(given.status, given.text).toBe(200);
    expect(given.body).toEqual({ id: expect.stringMatching(/^pgr_[0-9a-f]{32}$/), principal_id: AGENT.id, action: "push", delegated_by: OWNER.id, created_at: expect.any(Number), expires_at: null, revoked_at: null, state: "live" });
    expect(await grantRows(id)).toEqual([{ id: given.body.id, principal_id: AGENT.id, provider: "github", provider_repo_id: REPO_ID, action: "push", delegated_by: OWNER.id, expires_at: null, revoked_at: null, revoked_by: null }]);
    expect(await version(id)).toBe(before + 1);
    expect(await audits(id, "repo_grant.given")).toEqual([{ actor_id: OWNER.id, target_id: given.body.id, prior_json: null, new_json: { principal: AGENT.id, action: "push", expires_at: null } }]);
    expect(await events(id, "repo_grant.given")).toEqual([{ actor_id: OWNER.id, subject_id: AGENT.id }]);
    // A merge grant is its own row, and a person can hold one too.
    expect((await give(id, AGENT.id, "merge")).status).toBe(200);
    expect((await give(id, MEMBER.id, "merge", { expires_at: Date.now() + 3_600_000 })).body).toMatchObject({ principal_id: MEMBER.id, action: "merge", state: "live" });
    expect((await grantRows(id)).map((g) => [g.principal_id, g.action])).toEqual([[AGENT.id, "push"], [AGENT.id, "merge"], [MEMBER.id, "merge"]]);
  });

  it("is the owner's alone: an admin lacks the delegation, and nobody else in the room has the authority", async () => {
    const id = await room();
    const before = await footprint(id);
    expect([(await give(id, AGENT.id, "push", {}, ADMIN)).status, (await give(id, AGENT.id, "push", {}, ADMIN)).code]).toEqual([403, "no_provider_delegation"]);
    for (const who of [ORG_ADMIN, MEMBER, GUEST, AGENT]) {
      const refused = await give(id, AGENT.id, "push", {}, who);
      expect([refused.status, refused.code], who.id).toEqual([403, "not_allowed"]);
    }
    // Someone outside the room is told nothing about it.
    for (const who of [STRANGER, OUTSIDE_AGENT]) {
      const refused = await give(id, AGENT.id, "push", {}, who);
      expect([refused.status, refused.code], who.id).toEqual([404, "workspace_not_found"]);
    }
    expect(await footprint(id)).toEqual(before);
    // The refusals of authority are kept, by fixed name, with no content.
    await flush(id);
    const denials = (await api(OWNER, "GET", `/v1/workspaces/${id}/denials`)).body.denials as any[];
    expect(denials.filter((d) => d.action === "repo_grant.give").map((d) => [d.actor_id, d.code]).sort()).toEqual([
      [ADMIN.id, "no_provider_delegation"], [AGENT.id, "not_allowed"], [GUEST.id, "not_allowed"], [MEMBER.id, "not_allowed"], [ORG_ADMIN.id, "not_allowed"],
      // Outsiders are counted together, as for every other change.
      ["outsider", "workspace_not_found"], ["outsider", "workspace_not_found"],
    ].sort());
  });

  it("goes only to a current participant who isn't there through a public claim", async () => {
    const id = await room();
    const before = await footprint(id);
    for (const [principal, code] of [[OUTSIDE_AGENT.id, "grantee_not_participant"], [STRANGER.id, "grantee_not_participant"], [PUBLIC_AGENT.id, "grantee_public"]] as const) {
      const refused = await give(id, principal, "push");
      expect([refused.status, refused.code], principal).toEqual([400, code]);
    }
    // A removed participant is no longer one.
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${OTHER_AGENT.id}`, { policy_version: await version(id) })).status).toBe(200);
    const removed = await give(id, OTHER_AGENT.id, "push");
    expect([removed.status, removed.code]).toEqual([400, "grantee_not_participant"]);
    expect((await footprint(id)).grants).toBe(before.grants);
    // Once the owner gives the public claimant another role, it isn't a public participant, and may hold one.
    await inRoom(id, (sql) => sql.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", PUBLIC_AGENT.id));
    expect((await give(id, PUBLIC_AGENT.id, "push")).status).toBe(200);
  });

  it("needs a linked repository, and takes one while the link is degraded or suspended", async () => {
    const unlinked = await room({ link: null });
    const refused = await give(unlinked, AGENT.id, "push");
    expect([refused.status, refused.code]).toEqual([409, "repo_not_linked"]);
    expect((await footprint(unlinked)).grants).toBe(0);
    for (const status of ["degraded", "suspended"]) {
      const id = await room({ link: status });
      const given = await give(id, AGENT.id, "push");
      expect([given.status, given.body.state], status).toEqual([200, "live"]);
    }
  });

  it("refuses a malformed request, an expiry that isn't in the future and an out-of-date form, and writes nothing", async () => {
    const id = await room();
    const before = await footprint(id);
    const v = await version(id);
    for (const body of [
      { policy_version: v, principal_id: AGENT.id, action: "admin" },
      { policy_version: v, principal_id: AGENT.id, action: "Push" },
      { policy_version: v, principal_id: AGENT.id },
      { policy_version: v, action: "push" },
      { policy_version: v, principal_id: "", action: "push" },
      { policy_version: v, principal_id: AGENT.id, action: "push", expires_at: "tomorrow" },
      { policy_version: v, principal_id: AGENT.id, action: "push", expires_at: Date.now() - 1 },
      { policy_version: v, principal_id: AGENT.id, action: "push", repository_id: REPO_ID },
      { policy_version: v, principal_id: AGENT.id, action: "push", delegated_by: ADMIN.id },
      { principal_id: AGENT.id, action: "push" },
    ]) {
      const refused = await api(OWNER, "POST", grants(id), body);
      expect([refused.status, refused.code], JSON.stringify(body)).toEqual([400, "invalid_argument"]);
    }
    const stale = await api(OWNER, "POST", grants(id), { policy_version: v - 1, principal_id: AGENT.id, action: "push" });
    expect([stale.status, stale.code]).toEqual([409, "version_conflict"]);
    expect(await footprint(id)).toEqual(before);
  });

  it("takes an expiry after now and at most a year ahead", async () => {
    const id = await room();
    const YEAR = 365 * 24 * 60 * 60 * 1000;
    for (const expires_at of [Date.now() + YEAR + 60_000, 2 ** 53 + 2, Number.MAX_SAFE_INTEGER, Date.now() - 1, 0, -1, 1.5]) {
      const refused = await give(id, AGENT.id, "push", { expires_at });
      expect([refused.status, refused.code], String(expires_at)).toEqual([400, "invalid_argument"]);
    }
    // A value too large for a 64-bit integer is refused too.
    const huge = await SELF.fetch(`https://api.internal${grants(id)}`, { method: "POST", headers: { "x-podster-assertion": await assertion(OWNER), "content-type": "application/json", "idempotency-key": "rg-huge" }, body: `{"policy_version":${await version(id)},"principal_id":"${AGENT.id}","action":"push","expires_at":99999999999999999999999}` });
    expect(huge.status).toBe(400);
    expect((await grantRows(id)).length).toBe(0);
    const longest = await give(id, AGENT.id, "push", { expires_at: Date.now() + YEAR - 1_000 });
    expect([longest.status, longest.body.state]).toEqual([200, "live"]);
    const soonest = await give(id, AGENT.id, "merge", { expires_at: Date.now() + 1_000 });
    expect([soonest.status, soonest.body.state]).toEqual([200, "live"]);
  });

  it("refuses an expiry at the instant of now, and takes one exactly a year ahead and no later", async () => {
    const id = await room();
    const YEAR = 365 * 24 * 60 * 60 * 1000;
    // The room reads the same clock as the test, held still, so `now` is exact.
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(now);
      const at = async (expires_at: number, action = "push") => api(OWNER, "POST", grants(id), { policy_version: await version(id), principal_id: AGENT.id, action, expires_at });
      expect((await at(now)).code).toBe("invalid_argument");
      expect((await at(now + YEAR + 1)).code).toBe("invalid_argument");
      const yearAhead = await at(now + YEAR);
      expect([yearAhead.status, yearAhead.body.expires_at]).toEqual([200, now + YEAR]);
      const justAfter = await at(now + 1, "merge");
      expect([justAfter.status, justAfter.body.expires_at]).toEqual([200, now + 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a retry with its stored answer, refuses a key reused for another request, and doesn't replay to a former owner", async () => {
    const id = await room();
    const body = { policy_version: await version(id), principal_id: AGENT.id, action: "push" };
    const first = await api(OWNER, "POST", grants(id), body, { key: "rg-replay" });
    const again = await api(OWNER, "POST", grants(id), body, { key: "rg-replay" });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect((await grantRows(id)).length).toBe(1);
    expect((await audits(id, "repo_grant.given")).length).toBe(1);
    const reused = await api(OWNER, "POST", grants(id), { ...body, action: "merge" }, { key: "rg-replay" });
    expect([reused.status, reused.code]).toEqual([422, "idempotency_mismatch"]);
    // No key, no command.
    expect((await api(OWNER, "POST", grants(id), body, { key: null })).code).toBe("idempotency_key_required");
    // Handing the room over ends what the former owner may do, stored answers included.
    const handed = await api(OWNER, "POST", `/v1/workspaces/${id}/owner/transfer`, { to: ADMIN.id, policy_version: await version(id) }, { claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } });
    expect(handed.status, handed.text).toBe(200);
    const replay = await api(OWNER, "POST", grants(id), body, { key: "rg-replay" });
    expect([replay.status, replay.code]).toEqual([403, "no_provider_delegation"]);
  });

  it("changes nothing when given again, and replaces a row with a new expiry, an expired row or an earlier owner's", async () => {
    const id = await room();
    const first = (await give(id, AGENT.id, "push")).body;
    const same = await give(id, AGENT.id, "push");
    expect(same.body).toEqual(first);
    expect((await audits(id, "repo_grant.given")).length).toBe(1);
    // A new expiry: the old row is revoked and a new one added, in one command.
    const until = Date.now() + 60_000;
    const longer = (await give(id, AGENT.id, "push", { expires_at: until })).body;
    expect(longer).toMatchObject({ expires_at: until, state: "live" });
    expect(longer.id).not.toBe(first.id);
    expect((await grantRows(id)).map((g) => [g.id, g.revoked_at === null, g.revoked_by])).toEqual([[first.id, false, OWNER.id], [longer.id, true, null]]);
    expect((await audits(id, "repo_grant.revoked")).map((a) => a.prior_json)).toEqual([{ principal: AGENT.id, action: "push", reason: "replaced" }]);
    // Past its expiry, the row still holds the principal's one place until a new grant replaces it.
    await inRoom(id, (sql) => sql.exec("UPDATE provider_grant SET expires_at = ? WHERE id = ?", Date.now() - 1, longer.id));
    expect((await api(OWNER, "GET", grants(id))).body.grants.map((g: any) => [g.id, g.state])).toEqual([[longer.id, "expired"]]);
    const renewed = (await give(id, AGENT.id, "push", { expires_at: until })).body;
    expect(renewed.id).not.toBe(longer.id);
    expect((await api(OWNER, "GET", grants(id))).body.grants.map((g: any) => [g.id, g.state])).toEqual([[renewed.id, "live"]]);
  });

  it("is live until the instant of its expiry, and expired from then", async () => {
    const id = await room();
    const given = (await give(id, AGENT.id, "push", { expires_at: Date.now() + 60_000 })).body;
    const at = (expires: number) => inRoom(id, (sql) => sql.exec("UPDATE provider_grant SET expires_at = ? WHERE id = ?", expires, given.id));
    const state = async () => (await api(OWNER, "GET", grants(id))).body.grants[0].state;
    await at(Date.now() + 5_000);
    expect(await state()).toBe("live");
    await at(Date.now());
    expect(await state()).toBe("expired");
  });

  it("isn't given in an archived room", async () => {
    const id = await room();
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    expect((await give(id, AGENT.id, "push")).code).toBe("workspace_archived");
  });
});

describe("taking a grant back", () => {
  it("lets the owner take any grant back, once, told to the holder", async () => {
    const id = await room();
    const given = (await give(id, AGENT.id, "merge")).body;
    const taken = await take(id, given.id);
    expect(taken.status, taken.text).toBe(200);
    expect(taken.body).toMatchObject({ id: given.id, state: "revoked", revoked_at: expect.any(Number) });
    expect((await grantRows(id))[0]).toMatchObject({ revoked_by: OWNER.id });
    expect(await audits(id, "repo_grant.revoked")).toEqual([{ actor_id: OWNER.id, target_id: given.id, prior_json: { principal: AGENT.id, action: "merge", reason: "revoked" }, new_json: null }]);
    expect(await events(id, "repo_grant.revoked")).toEqual([{ actor_id: OWNER.id, subject_id: AGENT.id }]);
    // Again changes nothing, and still answers.
    const again = await take(id, given.id);
    expect([again.status, again.body.state]).toEqual([200, "revoked"]);
    expect((await audits(id, "repo_grant.revoked")).length).toBe(1);
  });

  it("lets a person who administers the room's organization take any grant back, and a holder their own", async () => {
    const id = await room();
    const forAgent = (await give(id, AGENT.id, "push")).body;
    const forMember = (await give(id, MEMBER.id, "merge")).body;
    expect((await take(id, forAgent.id, ORG_ADMIN)).body.state).toBe("revoked");
    expect((await take(id, forMember.id, MEMBER)).body.state).toBe("revoked");
    expect((await audits(id, "repo_grant.revoked")).map((a) => a.actor_id)).toEqual([ORG_ADMIN.id, MEMBER.id]);
    // The holder isn't told of what they did themselves.
    expect(await events(id, "repo_grant.revoked")).toEqual([{ actor_id: ORG_ADMIN.id, subject_id: AGENT.id }, { actor_id: MEMBER.id, subject_id: MEMBER.id }]);
  });

  it("refuses everyone else, and a grant they may not see answers as a missing one does", async () => {
    const id = await room();
    const given = (await give(id, MEMBER.id, "push")).body;
    const before = await footprint(id);
    // A room admin sees the grant, and may not take it back without administering the organization.
    expect([(await take(id, given.id, ADMIN)).status, (await take(id, given.id, ADMIN)).code]).toEqual([403, "not_allowed"]);
    // Someone who can't see it learns nothing about it.
    for (const who of [GUEST]) expect([(await take(id, given.id, who)).status, (await take(id, given.id, who)).code], who.id).toEqual([404, "grant_not_found"]);
    // An agent has no route, even for a grant of its own.
    const agents = (await give(id, AGENT.id, "push")).body;
    const mid = await footprint(id);
    for (const [who, grant] of [[AGENT, agents.id], [AGENT, given.id], [OTHER_AGENT, agents.id]] as const) {
      const refused = await take(id, grant, who);
      expect([refused.status, refused.code], who.id).toEqual([403, "not_allowed"]);
    }
    for (const who of [STRANGER, OUTSIDE_AGENT]) expect((await take(id, given.id, who)).code, who.id).toBe("workspace_not_found");
    expect((await take(id, "pgr_00000000000000000000000000000000")).code).toBe("grant_not_found");
    expect((await footprint(id)).grants).toBe(mid.grants);
    expect((await grantRows(id)).every((g) => g.revoked_at === null)).toBe(true);
    expect(before.grants).toBe(1);
    await flush(id);
    const denials = (await api(OWNER, "GET", `/v1/workspaces/${id}/denials`)).body.denials as any[];
    expect(denials.filter((d) => d.action === "repo_grant.revoke" && d.code === "not_allowed").map((d) => d.actor_id).sort()).toEqual([ADMIN.id, AGENT.id, OTHER_AGENT.id].sort());
  });

  it("answers someone who may not see a grant the same whether or not it exists, and keeps the refusal", async () => {
    const id = await room();
    const given = (await give(id, MEMBER.id, "push")).body;
    const real = await take(id, given.id, GUEST);
    const missing = await take(id, "pgr_ffffffffffffffffffffffffffffffff", GUEST);
    expect([real.status, real.text]).toEqual([missing.status, missing.text]);
    expect([real.status, real.code]).toEqual([404, "grant_not_found"]);
    await flush(id);
    const denials = (await api(OWNER, "GET", `/v1/workspaces/${id}/denials`)).body.denials as any[];
    expect(denials.filter((d) => d.action === "repo_grant.revoke").map((d) => [d.actor_id, d.code, d.count])).toEqual([[GUEST.id, "grant_not_found", 2]]);
  });

  it("replays a stored revocation only to someone who may still take that grant back", async () => {
    const id = await room();
    const given = (await give(id, AGENT.id, "push")).body;
    const body = { policy_version: await version(id) };
    const first = await api(ORG_ADMIN, "DELETE", `${grants(id)}/${given.id}`, body, { key: "rg-org-take" });
    expect(first.body.state).toBe("revoked");
    // Still an organization's admin: the stored answer.
    expect((await api(ORG_ADMIN, "DELETE", `${grants(id)}/${given.id}`, body, { key: "rg-org-take" })).body).toEqual(first.body);
    // No longer one, and still in the room as a member: refused, as if the grant weren't there.
    const demoted = await api(ORG_ADMIN, "DELETE", `${grants(id)}/${given.id}`, body, { key: "rg-org-take", claims: { admin_orgs: [] } });
    expect([demoted.status, demoted.code]).toEqual([404, "grant_not_found"]);
  });

  it("works in an archived room, needs a current form, and answers a retry with its stored answer", async () => {
    const id = await room();
    const given = (await give(id, AGENT.id, "push")).body;
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    const stale = await api(OWNER, "DELETE", `${grants(id)}/${given.id}`, { policy_version: (await version(id)) - 1 });
    expect([stale.status, stale.code]).toEqual([409, "version_conflict"]);
    const extra = await api(OWNER, "DELETE", `${grants(id)}/${given.id}`, { policy_version: await version(id), reason: "x" });
    expect([extra.status, extra.code]).toEqual([400, "invalid_argument"]);
    const body = { policy_version: await version(id) };
    const first = await api(OWNER, "DELETE", `${grants(id)}/${given.id}`, body, { key: "rg-take" });
    const again = await api(OWNER, "DELETE", `${grants(id)}/${given.id}`, body, { key: "rg-take" });
    expect(first.body.state).toBe("revoked");
    expect(again.body).toEqual(first.body);
    expect((await audits(id, "repo_grant.revoked")).length).toBe(1);
  });
});

describe("who is told how each participant joined", () => {
  it("tells those who manage access which participants joined through a public claim, and nobody else, not even false", async () => {
    const id = await room();
    for (const who of [OWNER, ADMIN]) {
      const read = await api(who, "GET", `/v1/workspaces/${id}`);
      expect(read.status, read.text).toBe(200);
      const told = Object.fromEntries(read.body.members.map((m: any) => [m.principal_id, m.public_claim]));
      expect(told, who.id).toMatchObject({ [PUBLIC_AGENT.id]: true, [AGENT.id]: false, [MEMBER.id]: false, [GUEST.id]: false, [ORG_ADMIN.id]: false });
    }
    // A member who sees the whole room, a guest, an agent and the public-claim agent itself: no member carries the field.
    for (const who of [MEMBER, ORG_ADMIN, GUEST, AGENT, PUBLIC_AGENT]) {
      const read = await api(who, "GET", `/v1/workspaces/${id}`);
      expect(read.status, `${who.id}: ${read.text}`).toBe(200);
      expect(read.body.members.length, who.id).toBeGreaterThan(0);
      for (const member of read.body.members) expect(member, `${who.id} sees ${member.principal_id}`).not.toHaveProperty("public_claim");
    }
  });

  it("goes by the caller's current role: an admin made a member stops being told", async () => {
    const id = await room();
    expect((await api(ADMIN, "GET", `/v1/workspaces/${id}`)).body.members[0]).toHaveProperty("public_claim");
    await inRoom(id, (sql) => sql.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", ADMIN.id));
    for (const member of (await api(ADMIN, "GET", `/v1/workspaces/${id}`)).body.members) expect(member).not.toHaveProperty("public_claim");
  });

  it("uses the refusal's own predicate: a public joiner the owner gave another role is neither flagged nor refused", async () => {
    const id = await room();
    // Not reachable through today's commands, which clear joined_via on such a change; written here to pin the rule.
    await inRoom(id, (sql) => sql.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", PUBLIC_AGENT.id));
    const told = (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.members.find((m: any) => m.principal_id === PUBLIC_AGENT.id);
    expect(told.public_claim).toBe(false);
    expect((await give(id, PUBLIC_AGENT.id, "push")).status).toBe(200);
  });

  it("is told whether managed repositories are switched on or off", async () => {
    const id = await room();
    await inRoom(id, (sql) => sql.exec("DROP TABLE test_managed_repositories_on"));
    expect((await api(OWNER, "GET", `${grants(id)}`)).code).toBe("not_found");
    const told = Object.fromEntries((await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.members.map((m: any) => [m.principal_id, m.public_claim]));
    expect(told).toMatchObject({ [PUBLIC_AGENT.id]: true, [AGENT.id]: false });
  });

  it("authorizes nothing: the grant is still refused from the room's own row", async () => {
    const id = await room();
    const refused = await give(id, PUBLIC_AGENT.id, "push");
    expect([refused.status, refused.code]).toEqual([400, "grantee_public"]);
  });
});

describe("the list of grants", () => {
  it("shows a human owner or admin every grant that isn't revoked, and anyone else their own", async () => {
    const id = await room();
    const toAgent = (await give(id, AGENT.id, "push")).body;
    const toMember = (await give(id, MEMBER.id, "merge")).body;
    const toGuest = (await give(id, GUEST.id, "push")).body;
    const gone = (await give(id, OTHER_AGENT.id, "push")).body;
    await take(id, gone.id);
    const ids = async (who: Who) => (await api(who, "GET", grants(id))).body.grants.map((g: any) => g.id);
    expect(await ids(OWNER)).toEqual([toAgent.id, toMember.id, toGuest.id]);
    expect(await ids(ADMIN)).toEqual([toAgent.id, toMember.id, toGuest.id]);
    expect(await ids(MEMBER)).toEqual([toMember.id]);
    expect(await ids(GUEST)).toEqual([toGuest.id]);
    expect(await ids(ORG_ADMIN)).toEqual([]);
    expect((await api(OWNER, "GET", grants(id))).body.grants[0]).toEqual(toAgent);
  });

  it("is for people only, and tells outsiders nothing", async () => {
    const id = await room();
    await give(id, AGENT.id, "push");
    for (const who of [AGENT, OTHER_AGENT, PUBLIC_AGENT]) {
      const read = await api(who, "GET", grants(id));
      expect([read.status, read.code], who.id).toEqual([403, "not_allowed"]);
    }
    for (const who of [STRANGER, OUTSIDE_AGENT]) {
      const read = await api(who, "GET", grants(id));
      expect([read.status, read.code], who.id).toEqual([404, "workspace_not_found"]);
    }
    expect((await api(OWNER, "GET", `/v1/workspaces/ws_00000000000000000000000000000000/repository/grants`)).code).toBe("workspace_not_found");
  });

  it("says a grant is stale once its giver no longer holds the delegation", async () => {
    const id = await room();
    await give(id, AGENT.id, "push");
    await inRoom(id, (sql) => sql.exec("UPDATE workspace SET owner_left_at = ?", Date.now()));
    expect((await api(ADMIN, "GET", grants(id))).body.grants.map((g: any) => g.state)).toEqual(["stale"]);
  });
});

describe("what ends grants", () => {
  it("removing a participant ends every grant they hold, in the same command, and coming back restores nothing", async () => {
    const id = await room();
    const push = (await give(id, AGENT.id, "push")).body;
    const merge = (await give(id, AGENT.id, "merge")).body;
    const kept = (await give(id, MEMBER.id, "merge")).body;
    const removed = await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${AGENT.id}`, { policy_version: await version(id) });
    expect(removed.status, removed.text).toBe(200);
    expect((await grantRows(id)).map((g) => [g.id, g.revoked_at !== null, g.revoked_by])).toEqual([[push.id, true, OWNER.id], [merge.id, true, OWNER.id], [kept.id, false, null]]);
    expect((await audits(id, "repo_grant.revoked")).map((a) => [a.target_id, a.prior_json.reason])).toEqual([[push.id, "member_removed"], [merge.id, "member_removed"]]);
    // Recorded, but the removed agent is told only of its removal.
    expect((await events(id, "repo_grant.revoked")).length).toBe(2);
    const outbox = await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM outbox o JOIN event e ON e.id = o.event_id WHERE e.type = 'repo_grant.revoked'").one().n);
    expect(outbox).toBe(0);
    const back = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: AGENT.id, kind: "agent", org_id: ORG, role: "member", policy_version: await version(id) });
    expect(back.status, back.text).toBe(200);
    expect((await api(OWNER, "GET", grants(id))).body.grants.map((g: any) => g.id)).toEqual([kept.id]);
  });

  it("an agent withdrawn by its organization's person loses its grants the same way", async () => {
    const id = await room();
    const given = (await give(id, AGENT.id, "push")).body;
    const withdrawn = await api(orgAdmin(ORG), "POST", `/v1/workspaces/${id}/members/${AGENT.id}/withdraw`, {});
    expect(withdrawn.status, withdrawn.text).toBe(200);
    expect((await grantRows(id)).find((g) => g.id === given.id)).toMatchObject({ revoked_by: orgAdmin(ORG).id, revoked_at: expect.any(Number) });
    expect((await audits(id, "repo_grant.revoked")).map((a) => a.prior_json.reason)).toEqual(["member_removed"]);
  });

  it("handing the room over ends every grant the former owner gave, and the new owner grants again", async () => {
    const id = await room();
    const push = (await give(id, AGENT.id, "push")).body;
    const merge = (await give(id, MEMBER.id, "merge")).body;
    const handed = await api(OWNER, "POST", `/v1/workspaces/${id}/owner/transfer`, { to: ADMIN.id, policy_version: await version(id) }, { claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } });
    expect(handed.status, handed.text).toBe(200);
    expect((await grantRows(id)).map((g) => [g.revoked_at !== null, g.revoked_by])).toEqual([[true, OWNER.id], [true, OWNER.id]]);
    expect((await audits(id, "repo_grant.revoked")).map((a) => [a.target_id, a.prior_json.reason])).toEqual([[push.id, "owner_changed"], [merge.id, "owner_changed"]]);
    expect(await events(id, "repo_grant.revoked")).toEqual([{ actor_id: OWNER.id, subject_id: AGENT.id }, { actor_id: OWNER.id, subject_id: MEMBER.id }]);
    expect((await api(ADMIN, "GET", grants(id))).body.grants).toEqual([]);
    // The former owner is an admin now, and gives nothing.
    expect((await give(id, AGENT.id, "push", {}, OWNER)).code).toBe("no_provider_delegation");
    const again = await give(id, AGENT.id, "push", {}, ADMIN);
    expect([again.status, again.body.delegated_by, again.body.state]).toEqual([200, ADMIN.id, "live"]);
  });

  it("recovering a room whose owner left ends the former owner's grants and any they held", async () => {
    const id = await room();
    const toAgent = (await give(id, AGENT.id, "push")).body;
    const ownOwn = (await give(id, OWNER.id, "merge")).body;
    await inRoom(id, (sql) => sql.exec("UPDATE workspace SET owner_left_at = ?", Date.now()));
    const recovered = await api(ORG_ADMIN, "POST", `/v1/workspaces/${id}/owner/recover`, { to: ADMIN.id, expected_owner: OWNER.id }, { claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } });
    expect(recovered.status, recovered.text).toBe(200);
    expect((await grantRows(id)).every((g) => g.revoked_at !== null)).toBe(true);
    const reasons = (await audits(id, "repo_grant.revoked")).map((a) => [a.target_id, a.prior_json.reason]);
    expect(reasons).toEqual([[toAgent.id, "owner_changed"], [ownOwn.id, "owner_changed"]]);
  });
});

describe("ownership moving and coming back", () => {
  const recover = (id: string, to: Who) => api(ORG_ADMIN, "POST", `/v1/workspaces/${id}/owner/recover`, { to: to.id, expected_owner: OWNER.id }, { claims: { target_member: { person: to.id, orgs: { [ORG]: 1 } } } });
  const transfer = (id: string, from: Who, to: Who) => version(id).then((v) => api(from, "POST", `/v1/workspaces/${id}/owner/transfer`, { to: to.id, policy_version: v }, { claims: { target_member: { person: to.id, orgs: { [ORG]: 1 } } } }));

  it("recovering a room for the owner who left ends every grant, so rejoining restores none", async () => {
    const id = await room();
    const forAgent = (await give(id, AGENT.id, "push")).body;
    const forOwner = (await give(id, OWNER.id, "merge")).body;
    await inRoom(id, (sql) => sql.exec("UPDATE workspace SET owner_left_at = ?", Date.now()));
    const recovered = await recover(id, OWNER);
    expect(recovered.status, recovered.text).toBe(200);
    expect((await grantRows(id)).map((g) => [g.id, g.revoked_at !== null])).toEqual([[forAgent.id, true], [forOwner.id, true]]);
    expect((await api(OWNER, "GET", grants(id))).body.grants).toEqual([]);
    // They grant again, as anyone new would.
    const again = await give(id, AGENT.id, "push");
    expect([again.status, again.body.state]).toEqual([200, "live"]);
    expect(again.body.id).not.toBe(forAgent.id);
  });

  it("recovering it for someone else ends every grant too, and the displaced former owner is told only of losing the room", async () => {
    const id = await room();
    await give(id, AGENT.id, "push");
    await give(id, MEMBER.id, "merge");
    await give(id, OWNER.id, "merge");
    await inRoom(id, (sql) => sql.exec("UPDATE workspace SET owner_left_at = ?", Date.now()));
    await holdOutbox(id);
    expect((await recover(id, ADMIN)).status).toBe(200);
    expect((await grantRows(id)).every((g) => g.revoked_at !== null)).toBe(true);
    // Every revocation is recorded; the holders still here are told, and the former owner isn't.
    expect((await events(id, "repo_grant.revoked")).map((e) => e.subject_id)).toEqual([AGENT.id, MEMBER.id, OWNER.id]);
    expect(await toldOfRevocation(id)).toEqual([AGENT.id, MEMBER.id].sort());
  });

  it("recovering it for the same person tells them their grants ended", async () => {
    const id = await room();
    await give(id, OWNER.id, "merge");
    await inRoom(id, (sql) => sql.exec("UPDATE workspace SET owner_left_at = ?", Date.now()));
    await holdOutbox(id);
    expect((await recover(id, OWNER)).status).toBe(200);
    expect(await toldOfRevocation(id)).toEqual([OWNER.id]);
  });

  it("handing the room away and back leaves none of the first owner's grants live", async () => {
    const id = await room();
    const first = (await give(id, AGENT.id, "push")).body;
    expect((await transfer(id, OWNER, ADMIN)).status).toBe(200);
    const second = (await give(id, MEMBER.id, "merge", {}, ADMIN)).body;
    const back = await transfer(id, ADMIN, OWNER);
    expect(back.status, back.text).toBe(200);
    expect((await grantRows(id)).map((g) => [g.id, g.delegated_by, g.revoked_at !== null])).toEqual([[first.id, OWNER.id, true], [second.id, ADMIN.id, true]]);
    expect((await api(OWNER, "GET", grants(id))).body.grants).toEqual([]);
  });
});

describe("a cascade commits with its command or not at all", () => {
  it("a removal that fails leaves the grants as they were", async () => {
    const id = await room();
    const given = (await give(id, AGENT.id, "push")).body;
    const before = await footprint(id);
    const failed = await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${AGENT.id}`, { policy_version: await version(id) }, { fail: true });
    expect(failed.status).toBe(500);
    expect(await footprint(id)).toEqual(before);
    expect((await grantRows(id)).find((g) => g.id === given.id)?.revoked_at).toBeNull();
    expect(await inRoom(id, (sql) => sql.exec("SELECT revoked_at FROM member WHERE principal_id = ?", AGENT.id).one().revoked_at)).toBeNull();
  });

  it("a recovery that fails leaves the grants and the owner as they were", async () => {
    const id = await room();
    await give(id, AGENT.id, "push");
    await give(id, OWNER.id, "merge");
    await inRoom(id, (sql) => sql.exec("UPDATE workspace SET owner_left_at = ?", Date.now()));
    const before = await footprint(id);
    const failed = await api(ORG_ADMIN, "POST", `/v1/workspaces/${id}/owner/recover`, { to: ADMIN.id, expected_owner: OWNER.id }, { fail: true, claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } });
    expect(failed.status).toBe(500);
    expect(await footprint(id)).toEqual(before);
    expect((await grantRows(id)).every((g) => g.revoked_at === null)).toBe(true);
    expect(await inRoom(id, (sql) => sql.exec("SELECT owner_person_id FROM workspace").one().owner_person_id)).toBe(OWNER.id);
  });

  it("a transfer that fails leaves the grants and the owner as they were", async () => {
    const id = await room();
    await give(id, AGENT.id, "push");
    const before = await footprint(id);
    const failed = await api(OWNER, "POST", `/v1/workspaces/${id}/owner/transfer`, { to: ADMIN.id, policy_version: await version(id) }, { fail: true, claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } });
    expect(failed.status).toBe(500);
    expect(await footprint(id)).toEqual(before);
    expect((await grantRows(id)).every((g) => g.revoked_at === null)).toBe(true);
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.owner).toBe(OWNER.id);
  });
});

describe("what a grant shows and logs", () => {
  it("shows its events to a human owner or admin and its holder, not to everyone who sees the room", async () => {
    const id = await room();
    await give(id, AGENT.id, "push");
    const seen = async (who: Who) => ((await api(who, "GET", `/v1/workspaces/${id}/activity`)).body.events as any[]).filter((e) => e.type.startsWith("repo_grant.")).map((e) => e.subject);
    expect(await seen(OWNER)).toEqual([AGENT.id]);
    expect(await seen(ADMIN)).toEqual([AGENT.id]);
    expect(await seen(AGENT)).toEqual([AGENT.id]);
    // A member who sees the whole room doesn't learn who holds a grant.
    expect(await seen(OTHER_AGENT)).toEqual([]);
    expect(await seen(MEMBER)).toEqual([]);
    // A guest who holds a grant sees its events too, given and taken back.
    const toGuest = (await give(id, GUEST.id, "merge")).body;
    await take(id, toGuest.id);
    expect(await seen(GUEST)).toEqual([GUEST.id, GUEST.id]);
    expect(await seen(OWNER)).toEqual([AGENT.id, GUEST.id, GUEST.id]);
  });

  it("logs no request content", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const id = await room();
    lines.length = 0;
    const until = Date.now() + 987_654_321;
    const given = (await give(id, AGENT.id, "push", { expires_at: until })).body;
    await api(OWNER, "POST", grants(id), { policy_version: await version(id), principal_id: AGENT.id, action: "push", note: "SECRET-NOTE" });
    await give(id, AGENT.id, "push", {}, ADMIN);
    await take(id, given.id);
    await take(id, given.id, GUEST);
    await flush(id);
    const logged = lines.join("\n");
    expect(logged).not.toContain("SECRET-NOTE");
    expect(logged).not.toContain(String(until));
    expect(logged).not.toContain("podsterx/engineering");
  });

  it("adds no route an agent could reach for a merge or a release, and the token route is step 6's alone", async () => {
    const contract: { path: string; method: string; operation: string }[] = JSON.parse(BINDINGS.TEST_API_ROUTES);
    expect(contract.filter((r) => r.path.includes("/repository/grants")).map((r) => r.operation).sort()).toEqual(["grantRepositoryAction", "listRepositoryGrants", "revokeRepositoryGrant"]);
    // The one merge route is step 7b's, behind the switch. Nothing for a release or a deploy.
    expect(contract.filter((r) => /merge|release-status|deploy/i.test(r.path + r.operation)).map((r) => r.operation).sort()).toEqual(["getTaskReleaseStatus", "mergeTask"]);
    expect(contract.filter((r) => /repo-access/i.test(r.path)).map((r) => r.operation)).toEqual(["getRepoAccess"]);
  });
});
