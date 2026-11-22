import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm.ts";

// Issue 523: the room read's `setup`, the facts a Runner's starter run policy is made from: the room's ID, its organization
// and its linked repository's full name and numeric ID, or null. Only for an agent that could receive a grant here. Links
// are written straight into the room, as the grant tests do.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const ORG = "org_sf";
const OTHER_ORG = "org_sf_other";
const OWNER: Who = { id: "per_sf_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const AGENT: Who = { id: "agt_sf_agent", org: ORG };
const GUEST_AGENT: Who = { id: "agt_sf_guest", org: ORG };
const PUBLIC_AGENT: Who = { id: "agt_sf_public", org: ORG };
const EXTERNAL_AGENT: Who = { id: "agt_sf_external", org: OTHER_ORG };
const orgAdmin = (org: string): Who => ({ id: `per_sf_admin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }) })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `sf-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, text };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [AGENT, GUEST_AGENT, PUBLIC_AGENT, EXTERNAL_AGENT]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version as number;

const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(stub(id));
});

const REPO_ID = 4815162342;

/** A room with its owner, a member agent, a guest agent, an agent that joined by a public claim and another organization's agent. */
async function room(options: { managed?: boolean } = {}) {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Setup facts" })).body.id;
  madeRooms.push(id);
  for (const [who, role] of [[AGENT, "member"], [GUEST_AGENT, "guest"], [PUBLIC_AGENT, "guest"]] as const) {
    const made = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: ORG, role, policy_version: await version(id) });
    expect(made.status, `add ${who.id}: ${made.text}`).toBe(200);
  }
  const invite = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { role: "guest", invited_org_id: OTHER_ORG, policy_version: await version(id) });
  expect(invite.status, invite.text).toBe(200);
  const accepted = await api(orgAdmin(OTHER_ORG), "POST", "/v1/invitations/accept", { token: invite.body.token, org_id: OTHER_ORG, agents: [EXTERNAL_AGENT.id] });
  expect(accepted.status, accepted.text).toBe(200);
  await inRoom(id, (sql) => {
    sql.exec("UPDATE member SET joined_via = 'public' WHERE principal_id = ?", PUBLIC_AGENT.id);
    if (options.managed !== false) sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)");
  });
  await manualAlarms(stub(id));
  return id;
}

const link = (id: string, repoId = REPO_ID, name = "podsterx/engineering") => inRoom(id, (sql) => {
  sql.exec("DELETE FROM repo_link");
  sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, ?, 'public', 'main', 'ready', ?, 1000, 2000, 2000)", repoId, name, OWNER.id);
});
const unlink = (id: string) => inRoom(id, (sql) => void sql.exec("DELETE FROM repo_link"));
const setup = async (who: Who, id: string) => {
  const read = await api(who, "GET", `/v1/workspaces/${id}`);
  expect(read.status, read.text).toBe(200);
  return read.body.setup;
};

describe("the room read's setup facts", () => {
  it("tells a member agent and a guest agent the room's organization and linked repository, and follows a change", async () => {
    const id = await room();
    for (const who of [AGENT, GUEST_AGENT]) expect(await setup(who, id), who.id).toEqual({ room_id: id, org_id: ORG, repository: null });
    await link(id);
    for (const who of [AGENT, GUEST_AGENT]) expect(await setup(who, id), who.id).toEqual({ room_id: id, org_id: ORG, repository: { full_name: "podsterx/engineering", provider_repo_id: REPO_ID } });
    // Replaced, then removed: the read is current state, every time.
    await link(id, 99, "podsterx/other");
    expect((await setup(AGENT, id)).repository).toEqual({ full_name: "podsterx/other", provider_repo_id: 99 });
    await unlink(id);
    expect((await setup(AGENT, id)).repository).toBeNull();
  });

  it("tells another organization's agent the room's organization, which isn't its own", async () => {
    const id = await room();
    await link(id);
    const facts = await setup(EXTERNAL_AGENT, id);
    expect(facts).toEqual({ room_id: id, org_id: ORG, repository: { full_name: "podsterx/engineering", provider_repo_id: REPO_ID } });
    expect((await api(EXTERNAL_AGENT, "GET", `/v1/workspaces/${id}`)).body.brief_external).toBe(true);
  });

  it("tells nothing to an agent there through a public claim, or to a person, so a reader takes it as unknown", async () => {
    const id = await room();
    await link(id);
    expect(await setup(PUBLIC_AGENT, id)).toBeUndefined();
    expect(await setup(OWNER, id)).toBeUndefined();
    // The repository read stays a person's, and never an agent's.
    expect((await api(AGENT, "GET", `/v1/workspaces/${id}/repository`)).code).toBe("not_allowed");
  });

  it("says no repository while managed repositories are switched off, even with a link left from before", async () => {
    const id = await room({ managed: false });
    await link(id);
    expect(await setup(AGENT, id)).toEqual({ room_id: id, org_id: ORG, repository: null });
  });
});
