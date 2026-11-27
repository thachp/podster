import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { alarmPass, alarmQuiet, manualAlarms } from "./alarm.ts";

// Inviting a person from another organization by email (docs/spec/CROSS-ORG-PEOPLE.md, decisions 239 to 247), AC-34 to
// AC-37. The gateway states a signed-in person's verified email on the preview and accept routes only; here the test
// signs it as the gateway would. AC-36's role change to admin is `cross-org-people.spec.ts`.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; orgs?: string[]; adminOrgs?: string[]; email?: string | null };
const ROOM_ORG = "org_pi_room";
const LONG_ORG = "org_pi_long";
const TEAM_ORG = "org_pi_team";
const OWNER: Who = { id: "per_PiOwner", kind: "person", org: ROOM_ORG, adminOrgs: [ROOM_ORG], email: "owner@example.com" };
const ADMIN: Who = { id: "per_PiAdmin", kind: "person", org: ROOM_ORG, email: "admin@example.com" };
const MEMBER: Who = { id: "per_PiMember", kind: "person", org: ROOM_ORG };
const GUEST: Who = { id: "per_PiGuest", kind: "person", org: ROOM_ORG };
// Long: his personal organization, and a team whose admin he is and whose agent is in the room.
const LONG: Who = { id: "per_PiLong", kind: "person", org: LONG_ORG, orgs: [LONG_ORG, TEAM_ORG], adminOrgs: [LONG_ORG, TEAM_ORG], email: "long@example.com" };
const STRANGER: Who = { id: "per_PiStranger", kind: "person", org: "org_pi_x", email: "stranger@example.com" };
const AGENT: Who = { id: "agt_pi_team", org: TEAM_ORG };
const ADDRESS = "long@example.com";

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  const orgs = who.orgs ?? [who.org];
  const person = { orgs, admin_orgs: who.adminOrgs ?? [], org_since: Object.fromEntries(orgs.map((o) => [o, 1])), ...(who.email ? { verified_email: who.email } : {}) };
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: 1 } : person), ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, claims: object = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, claims), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `pi-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined, text };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
const listed = async (who: Who) => (await api(who, "GET", "/v1/workspaces")).body.workspaces.map((w: any) => w.workspace_id);
const placed = (who: Who, org: string) => ({ target_member: { person: who.id, orgs: { [org]: 1 } } });
const memberRow = (id: string, principal: string) =>
  inRoom(id, (sql) => sql.exec("SELECT kind, org_id, role, guest_can_create, revoked_at, revocation_reason FROM member WHERE principal_id = ?", principal).toArray()[0] as any);
const invitationRows = (id: string) => inRoom(id, (sql) => sql.exec("SELECT i.id, i.status, p.kind, p.email FROM invitation i LEFT JOIN invitation_invitee p ON p.invitation_id = i.id ORDER BY i.created_at").toArray() as any[]);
/** Every audit entry and event the room holds, as text, to show no address reached them. */
const records = (id: string) => inRoom(id, (sql) => JSON.stringify([sql.exec("SELECT * FROM audit_event").toArray(), sql.exec("SELECT * FROM event").toArray()]));

const invite = async (id: string, email: string, extra: object = {}, by: Who = OWNER) =>
  api(by, "POST", `/v1/workspaces/${id}/invitations`, { policy_version: await version(id), invitee: { kind: "person", email }, ...extra });
const preview = (who: Who, token: string) => api(who, "POST", "/v1/invitations/preview", { token });
const accept = (who: Who, token: string, org: string, extra: object = {}) => api(who, "POST", "/v1/invitations/accept", { token, org_id: org, ...extra });

const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(stub(id));
});

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(LONG) }, body: JSON.stringify({ org_id: TEAM_ORG, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register ${AGENT.id}: ${res.status}`);
});

/** A room of the owner's organization with an admin, a member and a guest of it, and Long's team agent brought in by its
 * organization's invitation. Long himself has no place in it. */
async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Independent Creator Demo" })).body.id;
  madeRooms.push(id);
  await manualAlarms(stub(id));
  for (const [who, role] of [[ADMIN, "admin"], [MEMBER, "member"], [GUEST, "guest"]] as const) {
    const added = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "person", org_id: ROOM_ORG, role, policy_version: await version(id) }, placed(who, ROOM_ORG));
    expect(added.status, added.text).toBe(200);
  }
  const agentInvite = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { role: "guest", invited_org_id: TEAM_ORG, policy_version: await version(id) });
  const joined = await accept(LONG, agentInvite.body.token, TEAM_ORG, { agents: [AGENT.id] });
  expect(joined.status, joined.text).toBe(200);
  await alarmPass(stub(id));
  return id;
}

/** The room, with Long invited by `by` and accepted as his personal organization. */
async function roomWithLong(extra: object = {}, by: Who = OWNER) {
  const id = await room();
  const invited = await invite(id, ADDRESS, extra, by);
  expect(invited.status, invited.text).toBe(200);
  const accepted = await accept(LONG, invited.body.token, LONG_ORG);
  expect(accepted.status, accepted.text).toBe(200);
  await alarmPass(stub(id));
  return { id, token: invited.body.token as string, invitation: invited.body.id as string };
}

describe("AC-34: who may invite a person", () => {
  it("lets only the owner and an admin, as people; everyone else is refused and nothing is written", async () => {
    const { id } = await roomWithLong();
    const before = (await invitationRows(id)).length;
    for (const who of [MEMBER, GUEST, AGENT, { ...LONG, org: LONG_ORG }]) {
      const refused = await invite(id, "someone@example.com", {}, who);
      expect([refused.status, refused.code], who.id).toEqual([403, "not_allowed"]);
    }
    expect((await invitationRows(id)).length).toBe(before);
    for (const who of [OWNER, ADMIN]) {
      const made = await invite(id, `from-${who.id}@example.com`, {}, who);
      expect(made.status, made.text).toBe(200);
      // Guest by default, and the address isn't returned.
      expect(made.body).toMatchObject({ invitee_kind: "person", role: "guest" });
      expect(made.text).not.toContain("example.com");
    }
  });

  it("gives guest by default and member only by choice, never admin, and names no organization or opening", async () => {
    const id = await room();
    expect((await invite(id, "m@example.com", { role: "member" })).body.role).toBe("member");
    for (const extra of [{ role: "admin" }, { role: "owner" }, { invited_org_id: TEAM_ORG }, { work_role_id: "wr_x" }]) {
      const refused = await invite(id, "x@example.com", extra);
      expect([refused.status, refused.code], JSON.stringify(extra)).toEqual([400, "invalid_argument"]);
    }
    for (const invitee of [{ kind: "organization", email: ADDRESS }, { kind: "person" }, { kind: "person", email: "not-an-address" }, { kind: "person", email: ADDRESS, org: TEAM_ORG }]) {
      const refused = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { policy_version: await version(id), invitee });
      expect([refused.status, refused.code], JSON.stringify(invitee)).toEqual([400, "invalid_argument"]);
    }
  });

  it("shows the address to the owner and admins only, replaces a pending one for the same address, and keeps it out of every record", async () => {
    const id = await room();
    const first = await invite(id, "Long@Example.com");
    const second = await invite(id, ADDRESS);
    const pending = (await api(ADMIN, "GET", `/v1/workspaces/${id}/invitations`)).body.invitations;
    expect(pending.filter((i: any) => i.invitee_kind === "person")).toEqual([expect.objectContaining({ id: second.body.id, invitee_email: ADDRESS })]);
    expect((await api(MEMBER, "GET", `/v1/workspaces/${id}/invitations`)).code).toBe("not_allowed");
    // The replaced one is withdrawn, and its address gone with it.
    expect((await invitationRows(id)).find((r) => r.id === first.body.id)).toMatchObject({ status: "withdrawn", email: null });
    expect((await preview(LONG, first.body.token)).code).toBe("invitation_not_found");
    expect(await records(id)).not.toContain("example.com");
  });

  it("keeps the address out of the idempotency record, so the record can't confirm a guessed one, and still replays a retry", async () => {
    const id = await room();
    const v = await version(id);
    const body = { policy_version: v, invitee: { kind: "person", email: ADDRESS } };
    const headers = async () => ({ "x-podster-assertion": await assertion(OWNER), "content-type": "application/json", "idempotency-key": "pi-fingerprint" });
    const send = async () => {
      const res = await SELF.fetch(`https://api.internal/v1/workspaces/${id}/invitations`, { method: "POST", headers: await headers(), body: JSON.stringify(body) });
      return { status: res.status, body: await res.json<any>() };
    };
    const first = await send();
    expect(first.status).toBe(200);
    const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const path = `/v1/workspaces/${id}/invitations`;
    const [stored] = await inRoom(id, (sql) => sql.exec("SELECT request_hash, response_json FROM idempotency WHERE actor_id = ? AND key = 'pi-fingerprint'", OWNER.id).toArray() as any[]);
    // The fingerprint is the body with the address left out, which shows this reproduces how it's made.
    expect(stored.request_hash).toBe(await sha(`Post ${path} {"invitee":{"kind":"person"},"policy_version":${v}}`));
    expect(stored.request_hash).not.toBe(await sha(`Post ${path} {"invitee":{"email":"${ADDRESS}","kind":"person"},"policy_version":${v}}`));
    expect(stored.request_hash).not.toBe(await sha(ADDRESS));
    expect(JSON.stringify(stored)).not.toContain(ADDRESS);
    expect(JSON.stringify(stored)).not.toContain(await sha(ADDRESS));
    // A retry under the same key gets the first answer, without the token, and makes no second invitation.
    const again = await send();
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.token).toBeUndefined();
    expect((await invitationRows(id)).filter((r) => r.kind === "person")).toHaveLength(1);
  });

  it("refuses someone the link isn't addressed to before looking at the rest of their request", async () => {
    const id = await room();
    const made = await invite(id, ADDRESS);
    for (const body of [{ token: made.body.token }, { token: made.body.token, org_id: "bad/id" }, { token: made.body.token, org_id: STRANGER.org, agents: [AGENT.id] }]) {
      const res = await api(STRANGER, "POST", "/v1/invitations/accept", body);
      expect([res.status, res.code], JSON.stringify(body)).toEqual([404, "invitation_not_found"]);
    }
  });

  it("allows 20 pending and 20 made a day", async () => {
    const id = await room();
    for (let n = 0; n < 20; n++) expect((await invite(id, `p${n}@example.com`)).status).toBe(200);
    expect((await invite(id, "p20@example.com")).code).toBe("limit_exceeded");
    // Withdrawing one frees a pending place, but the day's twenty are made.
    const [one] = (await api(OWNER, "GET", `/v1/workspaces/${id}/invitations`)).body.invitations;
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/invitations/${one.id}`, { policy_version: await version(id) })).status).toBe(200);
    expect((await invite(id, "p21@example.com")).code).toBe("limit_exceeded");
    await inRoom(id, (sql) => void sql.exec("UPDATE invitation SET created_at = created_at - 2 * 86400000"));
    expect((await invite(id, "p22@example.com")).status).toBe(200);
  });
});

describe("AC-35: only the addressed, verified person, once", () => {
  it("previews for the addressed person, compared case-insensitively, and offers their organizations other than the room's", async () => {
    const id = await room();
    const made = await invite(id, ADDRESS, { role: "member" });
    const seen = await preview({ ...LONG, email: "LONG@example.COM", orgs: [LONG_ORG, TEAM_ORG, ROOM_ORG] }, made.body.token);
    expect(seen.status, seen.text).toBe(200);
    expect(seen.body).toMatchObject({ workspace_id: id, workspace_name: "Independent Creator Demo", invitee_kind: "person", role: "member", invited_by: OWNER.id, orgs: [LONG_ORG, TEAM_ORG] });
    // Long administers the team whose agent is here, so accepting ends that oversight.
    expect(seen.body.ends_oversight).toBe(true);
  });

  it("refuses anyone else before saying anything about the room, an unverified email included", async () => {
    const id = await room();
    const made = await invite(id, ADDRESS);
    // An agent is refused before the room is asked (`not_allowed`), as for any link.
    expect((await preview(AGENT, made.body.token)).code).toBe("not_allowed");
    for (const who of [STRANGER, { ...LONG, email: null }, { ...STRANGER, email: "long@example.org" }, OWNER]) {
      const refused = await preview(who, made.body.token);
      expect([refused.status, refused.code], who.id).toEqual([404, "invitation_not_found"]);
      expect(refused.text).not.toContain("Independent");
      const notAccepted = await accept(who, made.body.token, who.org);
      expect(notAccepted.status, who.id).not.toBe(200);
    }
    expect((await accept({ ...LONG, email: null }, made.body.token, LONG_ORG)).code).toBe("invitation_not_found");
    expect((await accept(STRANGER, made.body.token, STRANGER.org)).code).toBe("invitation_not_found");
    expect((await memberRow(id, STRANGER.id))).toBeUndefined();
  });

  it("adds the person alone, once, as the organization they chose, and a retry gets the same answer", async () => {
    const id = await room();
    const made = await invite(id, ADDRESS);
    expect((await accept(LONG, made.body.token, LONG_ORG, { agents: [AGENT.id] })).code).toBe("invalid_argument");
    // The room's own organization is added directly, not by invitation (decision 245).
    expect((await accept({ ...LONG, orgs: [LONG_ORG, ROOM_ORG] }, made.body.token, ROOM_ORG)).code).toBe("invalid_argument");
    expect((await accept(LONG, made.body.token, "org_pi_not_his")).code).toBe("not_allowed");
    const accepted = await accept(LONG, made.body.token, LONG_ORG);
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body).toEqual({ status: "accepted", principal_id: LONG.id, org_id: LONG_ORG, role: "guest" });
    expect(await accept(LONG, made.body.token, LONG_ORG)).toMatchObject({ status: 200, body: accepted.body });
    // Used: another request, or anyone else, gets the same as a bad link.
    expect((await accept(LONG, made.body.token, TEAM_ORG)).code).toBe("invitation_not_found");
    expect((await preview(LONG, made.body.token)).code).toBe("invitation_not_found");
    expect(await memberRow(id, LONG.id)).toMatchObject({ kind: "person", org_id: LONG_ORG, role: "guest", revoked_at: null });
    // The agent's place is as it was: a person invitation brings no agent, and changes none.
    expect(await memberRow(id, AGENT.id)).toMatchObject({ kind: "agent", org_id: TEAM_ORG, role: "guest", revoked_at: null });
    // The address went when it was accepted.
    expect((await invitationRows(id)).find((r) => r.id === made.body.id)).toMatchObject({ status: "accepted", email: null });
    await alarmPass(stub(id));
    expect(await listed(LONG)).toContain(id);
    const opened = await api(LONG, "GET", `/v1/workspaces/${id}`);
    expect(opened.status, opened.text).toBe(200);
    expect(await records(id)).not.toContain("example.com");
  });

  it("tells the person and the inviter, by ID", async () => {
    const id = await room();
    const made = await invite(id, ADDRESS, {}, ADMIN);
    expect((await accept(LONG, made.body.token, LONG_ORG)).status).toBe(200);
    const added = await inRoom(id, (sql) => sql.exec("SELECT e.actor_id, e.subject_id, o.recipient_principal_id AS r FROM event e LEFT JOIN outbox o ON o.event_id = e.id WHERE e.type = 'member.added' AND e.subject_id = ? ORDER BY r", LONG.id).toArray() as any[]);
    expect(added.map((a) => a.r).sort()).toEqual([ADMIN.id, LONG.id].sort());
    const audit = await inRoom(id, (sql) => sql.exec("SELECT action FROM audit_event WHERE target_id IN (?, ?) ORDER BY seq", LONG.id, made.body.id).toArray().map((r: any) => r.action));
    expect(audit).toEqual(["invitation.created", "member.added", "invitation.accept"]);
  });

  it("refuses an expired, withdrawn or creator-demoted invitation the same way, and erases the address", async () => {
    const id = await room();
    const expired = await invite(id, ADDRESS);
    await inRoom(id, (sql) => void sql.exec("UPDATE invitation SET expires_at = 1 WHERE id = ?", expired.body.id));
    expect((await preview(LONG, expired.body.token)).code).toBe("invitation_not_found");
    expect((await accept(LONG, expired.body.token, LONG_ORG)).code).toBe("invitation_not_found");
    // The room's alarm erases an expired one's address.
    await alarmPass(stub(id));
    expect((await invitationRows(id)).find((r) => r.id === expired.body.id)).toMatchObject({ email: null });

    const withdrawn = await invite(id, "w@example.com");
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/invitations/${withdrawn.body.id}`, { policy_version: await version(id) })).status).toBe(200);
    expect((await invitationRows(id)).find((r) => r.id === withdrawn.body.id)).toMatchObject({ status: "withdrawn", email: null });
    expect((await accept({ ...LONG, email: "w@example.com" }, withdrawn.body.token, LONG_ORG)).code).toBe("invitation_not_found");

    const byAdmin = await invite(id, ADDRESS, {}, ADMIN);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/members/${ADMIN.id}/role`, { role: "member", policy_version: await version(id) }, placed(ADMIN, ROOM_ORG))).status).toBe(200);
    expect((await preview(LONG, byAdmin.body.token)).code).toBe("invitation_not_found");
    expect((await accept(LONG, byAdmin.body.token, LONG_ORG)).code).toBe("invitation_not_found");
    expect((await invitationRows(id)).find((r) => r.id === byAdmin.body.id)).toMatchObject({ status: "withdrawn", email: null });
    expect(await memberRow(id, LONG.id)).toBeUndefined();
  });

  it("lets only the owner's invitation bring someone back as another organization than their revoked place holds", async () => {
    const { id } = await roomWithLong();
    expect((await api(LONG, "POST", `/v1/workspaces/${id}/leave`, {})).status).toBe(200);
    const fromAdmin = await invite(id, ADDRESS, {}, ADMIN);
    const refused = await accept(LONG, fromAdmin.body.token, TEAM_ORG);
    expect([refused.status, refused.code]).toEqual([403, "not_allowed"]);
    expect(await memberRow(id, LONG.id)).toMatchObject({ org_id: LONG_ORG, revocation_reason: "person_left" });
    // As the same organization, an admin's invitation is enough.
    expect((await accept(LONG, fromAdmin.body.token, LONG_ORG)).status).toBe(200);
    expect((await api(LONG, "POST", `/v1/workspaces/${id}/leave`, {})).status).toBe(200);
    const fromOwner = await invite(id, ADDRESS);
    expect((await accept(LONG, fromOwner.body.token, TEAM_ORG)).status).toBe(200);
    expect(await memberRow(id, LONG.id)).toMatchObject({ org_id: TEAM_ORG, revoked_at: null });
  });
});

describe("AC-36: what an outside person can never do", () => {
  it("refuses every access, repository and room-management command, and another room of the host organization stays hidden", async () => {
    const { id } = await roomWithLong({ role: "member" });
    await inRoom(id, (sql) => void sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)"));
    const v = await version(id);
    const commands: [string, string, object][] = [
      ["POST", "invitations", { policy_version: v, invitee: { kind: "person", email: "x@example.com" } }],
      ["POST", "invitations", { policy_version: v, invited_org_id: TEAM_ORG }],
      ["POST", "members", { principal_id: STRANGER.id, kind: "person", org_id: ROOM_ORG, role: "guest", policy_version: v }],
      ["DELETE", `members/${GUEST.id}`, { policy_version: v }],
      ["POST", `members/${GUEST.id}/role`, { role: "member", policy_version: v }],
      ["POST", `members/${LONG.id}/role`, { role: "admin", policy_version: v }],
      ["DELETE", `organizations/${TEAM_ORG}`, { policy_version: v }],
      ["PUT", "name", { name: "Mine now", policy_version: v }],
      ["POST", "archive", { policy_version: v }],
      ["POST", "roles", { title: "Lead", responsibilities: "x", capacity: 1, preset: "member", policy_version: v }],
      ["POST", "repository/grants", { principal_id: LONG.id, action: "merge", policy_version: v }],
    ];
    for (const [method, path, body] of commands) {
      const refused = await api(LONG, method, `/v1/workspaces/${id}/${path}`, body, placed(LONG, LONG_ORG));
      expect([refused.status, refused.code], `${method} ${path}`).toEqual([403, "not_allowed"]);
    }
    for (const path of ["audit", "denials", "invitations"]) {
      const refused = await api(LONG, "GET", `/v1/workspaces/${id}/${path}`);
      expect(refused.code, path).toBe("not_allowed");
    }
    expect(await memberRow(id, LONG.id)).toMatchObject({ org_id: LONG_ORG, role: "member" });
    // Another room of the host organization, which Long was never invited to.
    const other: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Host's other room" })).body.id;
    madeRooms.push(other);
    await manualAlarms(stub(other));
    expect((await api(LONG, "GET", `/v1/workspaces/${other}`)).code).toBe("workspace_not_found");
  });
});

describe("AC-37: leaving, and the person's and agent's places stay apart", () => {
  it("ends only the person's own place when they leave, runs the departure rules, and their oversight never returns", async () => {
    const id = await room();
    // Before he has a place, Long oversees his team's agent here (decision 7).
    expect((await api(LONG, "GET", `/v1/workspaces/${id}/agents/${AGENT.id}/tasks`)).status).toBe(200);
    const made = await invite(id, ADDRESS, { role: "member" });
    expect((await accept(LONG, made.body.token, LONG_ORG)).status).toBe(200);
    const task = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Edit", instructions: "Edit the video", assignee: AGENT.id, reviewer: LONG.id });
    expect(task.status, task.text).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/leave`, {})).code).toBe("not_allowed");
    expect((await api(AGENT, "POST", `/v1/workspaces/${id}/leave`, {})).code).toBe("not_allowed");
    const left = await api(LONG, "POST", `/v1/workspaces/${id}/leave`, {});
    expect(left.status, left.text).toBe(200);
    expect(await memberRow(id, LONG.id)).toMatchObject({ revocation_reason: "person_left" });
    expect(await memberRow(id, AGENT.id)).toMatchObject({ revoked_at: null });
    // The departure rules ran: the task he reviewed has another reviewer now.
    expect(await inRoom(id, (sql) => sql.exec("SELECT reviewer_id FROM task WHERE id = ?", task.body.id).one().reviewer_id)).not.toBe(LONG.id);
    expect((await api(LONG, "GET", `/v1/workspaces/${id}`)).code).toBe("access_revoked");
    expect((await api(LONG, "POST", `/v1/workspaces/${id}/leave`, {})).code).toBe("access_revoked");
    // Oversight of his team's agent doesn't come back (decision 247).
    expect((await api(LONG, "GET", `/v1/workspaces/${id}/agents/${AGENT.id}/tasks`)).status).not.toBe(200);
    await alarmPass(stub(id));
    expect(await listed(LONG)).not.toContain(id);
    expect(await listed(AGENT)).toContain(id);
  });

  it("ends only the person's place when the room removes them, their organization removes them, or the room revokes it", async () => {
    for (const [why, end, reason] of [
      ["the room removes him", async (id: string) => api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${LONG.id}`, { policy_version: await version(id) }), "room_removed"],
      ["his organization removes him", async () => api(LONG, "POST", "/v1/org-departures", {}, { departure: { person: LONG.id, org: LONG_ORG, left_at: Date.now() } }), "org_departure"],
      ["the room revokes his organization", async (id: string) => api(OWNER, "DELETE", `/v1/workspaces/${id}/organizations/${LONG_ORG}`, { policy_version: await version(id) }), "room_removed"],
    ] as const) {
      const { id } = await roomWithLong();
      const ended = await end(id);
      expect(ended.status, `${why}: ${ended.text}`).toBe(200);
      // An organization's departure reaches the room from Long's Principal, on its own alarm.
      await vi.waitFor(async () => expect((await memberRow(id, LONG.id)).revoked_at, why).not.toBeNull(), { timeout: 5000 });
      await alarmPass(stub(id));
      const row = await memberRow(id, LONG.id);
      if (reason) expect(row.revocation_reason, why).toBe(reason);
      expect(await memberRow(id, AGENT.id), why).toMatchObject({ revoked_at: null, org_id: TEAM_ORG });
      expect((await api(LONG, "GET", `/v1/workspaces/${id}/agents/${AGENT.id}/tasks`)).status, why).not.toBe(200);
      // A new invitation brings him back, once his organization lets him in again.
      const again = await invite(id, ADDRESS);
      expect((await accept(LONG, again.body.token, LONG_ORG)).status, why).toBe(200);
    }
  });

  it("leaves the person's place alone when their agent is removed", async () => {
    const { id } = await roomWithLong();
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${AGENT.id}`, { policy_version: await version(id) })).status).toBe(200);
    expect(await memberRow(id, LONG.id)).toMatchObject({ revoked_at: null, org_id: LONG_ORG, role: "guest" });
    expect((await api(LONG, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
  });
});

describe("room schema step 57", () => {
  it("adds the addressee's record to a room made before it, runs again safely, and keeps a pending invitation whole", async () => {
    const id = await room();
    const latest = await inRoom(id, (sql) => sql.exec("SELECT version FROM schema_version").one().version as number);
    await inRoom(id, (sql) => { sql.exec("DROP TABLE invitation_invitee"); sql.exec("UPDATE schema_version SET version = version - 2"); });
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    expect(await inRoom(id, (sql) => sql.exec("SELECT version FROM schema_version").one().version)).toBe(latest);
    // An organization's invitation from before the step is still one: it has no addressee row.
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/invitations`)).body.invitations.every((i: any) => i.invitee_kind === "organization")).toBe(true);
    const made = await invite(id, ADDRESS);
    await inRoom(id, (sql) => sql.exec("UPDATE schema_version SET version = version - 1"));
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    expect((await invitationRows(id)).find((r) => r.id === made.body.id)).toMatchObject({ kind: "person", email: ADDRESS });
  });
});
