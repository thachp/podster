import { env, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet } from "./alarm.ts";

// Issue 521: a person whose agent is in a room, and who is then added to the room themselves. The two grants stay apart:
// the agent's membership never shows its owner the room, and the person's own role does, whoever's agents are there.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; orgs?: string[]; adminOrgs?: string[] };
const ROOM_ORG = "org_pa_room";
const AGENT_ORG = "org_pa_long";
const OWNER: Who = { id: "per_PaOwner", kind: "person", org: ROOM_ORG, orgs: [ROOM_ORG], adminOrgs: [ROOM_ORG] };
// Person IDs are mixed case outside tests (Better Auth), so this one is too.
const LONG: Who = { id: "per_PaLong", kind: "person", org: AGENT_ORG, orgs: [AGENT_ORG], adminOrgs: [AGENT_ORG] };
const AGENT: Who = { id: "agt_pa_long", org: AGENT_ORG };

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: 1 } : { orgs: who.orgs ?? [who.org], admin_orgs: who.adminOrgs ?? [] }), ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, claims: object = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, claims), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `pa-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
const listed = async (who: Who) => (await api(who, "GET", "/v1/workspaces")).body.workspaces.map((w: any) => w.workspace_id);

const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(stub(id));
});

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(LONG) }, body: JSON.stringify({ org_id: AGENT_ORG, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register ${AGENT.id}: ${res.status}`);
});

/** A room of the owner's organization with the other organization's agent brought in by an invitation its admin accepted. */
async function roomWithAgent() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Independent Creator Demo" })).body.id;
  madeRooms.push(id);
  const invited = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { role: "guest", invited_org_id: AGENT_ORG, policy_version: await version(id) });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const accepted = await api(LONG, "POST", "/v1/invitations/accept", { token: invited.body.token, org_id: AGENT_ORG, agents: [AGENT.id] });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  await alarmPass(stub(id));
  return id;
}

describe("a person whose agent is in the room", () => {
  it("gets nothing from the agent's membership: accepting the invitation adds only the agent", async () => {
    const id = await roomWithAgent();
    expect(await listed(AGENT)).toContain(id);
    expect(await listed(LONG)).not.toContain(id);
    // Not found, as for any room the person isn't in, so the agent's membership doesn't reveal the room to its owner.
    expect((await api(LONG, "GET", `/v1/workspaces/${id}`)).code).toBe("workspace_not_found");
    // Accepting a second invitation for the same agent changes nothing, and still doesn't add the person.
    const again = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { role: "guest", invited_org_id: AGENT_ORG, policy_version: await version(id) });
    const repeat = await api(LONG, "POST", "/v1/invitations/accept", { token: again.body.token, org_id: AGENT_ORG, agents: [AGENT.id] });
    expect(repeat.code).toBe("already_member");
    await alarmPass(stub(id));
    expect(await listed(LONG)).not.toContain(id);
    expect((await api(LONG, "GET", `/v1/workspaces/${id}`)).code).toBe("workspace_not_found");
  });

  it("can't be added as a person from outside the room's organization", async () => {
    const id = await roomWithAgent();
    const refused = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: LONG.id, kind: "person", org_id: AGENT_ORG, role: "member", policy_version: await version(id) }, { target_member: { person: LONG.id, orgs: { [AGENT_ORG]: 1 } } });
    expect(refused.code).toBe("invitation_required");
    // Naming the room's organization for someone the directory doesn't place there is refused too.
    const notThere = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: LONG.id, kind: "person", org_id: ROOM_ORG, role: "member", policy_version: await version(id) }, { target_member: { person: LONG.id, orgs: { [AGENT_ORG]: 1 } } });
    expect(notThere.status).not.toBe(200);
    await alarmPass(stub(id));
    expect(await listed(LONG)).not.toContain(id);
    expect((await api(LONG, "GET", `/v1/workspaces/${id}`)).code).toBe("workspace_not_found");
  });

  it("sees the room, listed and opened directly, once added as a person, and the two grants stay separate", async () => {
    const id = await roomWithAgent();
    // Long has joined the room's organization, as the gateway's directory states, and the owner adds him as a person.
    const joined: Who = { ...LONG, orgs: [AGENT_ORG, ROOM_ORG] };
    const added = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: LONG.id, kind: "person", org_id: ROOM_ORG, role: "member", policy_version: await version(id) }, { target_member: { person: LONG.id, orgs: { [ROOM_ORG]: 1 } } });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    await alarmPass(stub(id));
    expect(await listed(joined)).toContain(id);
    const opened = await api(joined, "GET", `/v1/workspaces/${id}`);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const members: any[] = opened.body.members;
    const person = members.find((m) => m.principal_id === LONG.id);
    const agent = members.find((m) => m.principal_id === AGENT.id);
    expect(person).toMatchObject({ kind: "person", role: "member" });
    // The agent keeps the guest role its invitation gave it: adding its owner widens nothing of the agent's.
    expect(agent).toMatchObject({ kind: "agent", role: "guest" });
    expect(await listed(AGENT)).toContain(id);
    // Removing the agent leaves the person's own role alone, and the person's role was never the agent's.
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${AGENT.id}`, { policy_version: await version(id) })).status).toBe(200);
    await alarmPass(stub(id));
    expect(await listed(joined)).toContain(id);
    expect((await api(joined, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    expect((await api(AGENT, "GET", `/v1/workspaces/${id}`)).status).not.toBe(200);
  });
});
