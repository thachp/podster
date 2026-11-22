import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet, manualAlarms } from "./alarm.ts";

// Inviting a person from another organization (docs/spec/CROSS-ORG-PEOPLE.md, AC-34 to AC-37). This file starts with the
// hardening that lands first: admin stays with the room's organization, whatever the owner asks.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; orgs?: string[]; adminOrgs?: string[] };
const ROOM_ORG = "org_xo_room";
const OTHER_ORG = "org_xo_other";
const OWNER: Who = { id: "per_XoOwner", kind: "person", org: ROOM_ORG, orgs: [ROOM_ORG], adminOrgs: [ROOM_ORG] };
const CAROL: Who = { id: "per_XoCarol", kind: "person", org: ROOM_ORG, orgs: [ROOM_ORG] };
const DAVE: Who = { id: "per_XoDave", kind: "person", org: ROOM_ORG, orgs: [ROOM_ORG] };

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
  if (method !== "GET") headers["idempotency-key"] = `xo-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
const memberRow = (id: string, principal: string) =>
  inRoom(id, (sql) => sql.exec("SELECT kind, org_id, role, guest_can_create, revoked_at FROM member WHERE principal_id = ?", principal).toArray()[0]);
const placed = (who: Who, org: string) => ({ target_member: { person: who.id, orgs: { [org]: 1 } } });

const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(stub(id));
});

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

/** A room of the owner's organization with Carol and Dave, people of that organization, added as members. */
async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Cross-org room" })).body.id;
  madeRooms.push(id);
  // The room's alarms are the test's from here, so only alarmPass runs its jobs and none runs into another test.
  await manualAlarms(stub(id));
  for (const who of [CAROL, DAVE]) {
    const added = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "person", org_id: ROOM_ORG, role: "member", policy_version: await version(id) }, placed(who, ROOM_ORG));
    expect(added.status, JSON.stringify(added.body)).toBe(200);
  }
  await alarmPass(stub(id));
  return id;
}

describe("AC-36: admin stays with the room's organization", () => {
  it("refuses making a person who holds their place through another organization admin, and leaves their row alone", async () => {
    const id = await room();
    // Until person invitations are built, no command writes such a row, so the test writes the one an accepted
    // invitation will: Carol holding her place through her own organization.
    await inRoom(id, (sql) => sql.exec("UPDATE member SET org_id = ? WHERE principal_id = ?", OTHER_ORG, CAROL.id));
    const before = await memberRow(id, CAROL.id);
    const refused = await api(OWNER, "POST", `/v1/workspaces/${id}/members/${CAROL.id}/role`, { role: "admin", policy_version: await version(id) }, placed(CAROL, OTHER_ORG));
    expect(refused.code, JSON.stringify(refused.body)).toBe("invalid_argument");
    expect(await memberRow(id, CAROL.id)).toEqual(before);
    expect(before).toMatchObject({ org_id: OTHER_ORG, role: "member" });
    // The other roles stay open to them: the owner can still make them a guest.
    const guest = await api(OWNER, "POST", `/v1/workspaces/${id}/members/${CAROL.id}/role`, { role: "guest", policy_version: await version(id) }, placed(CAROL, OTHER_ORG));
    expect(guest.status, JSON.stringify(guest.body)).toBe(200);
    expect(await memberRow(id, CAROL.id)).toMatchObject({ org_id: OTHER_ORG, role: "guest" });
  });

  it("still lets the owner make a person of the room's organization admin", async () => {
    const id = await room();
    const promoted = await api(OWNER, "POST", `/v1/workspaces/${id}/members/${DAVE.id}/role`, { role: "admin", policy_version: await version(id) }, placed(DAVE, ROOM_ORG));
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect(await memberRow(id, DAVE.id)).toMatchObject({ org_id: ROOM_ORG, role: "admin" });
  });
});
