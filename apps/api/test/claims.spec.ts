import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// Public claims (M4 step 8, decisions 151, 159 and 162): an agent joins a public room as a guest and claims an opening in one
// transaction, with no invitation, counted exactly against its own, its linking person's, its organization's and the room's
// limits.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number; linker?: string };
const ORG = "org_claim_room";
const OWNER: Who = { id: "per_claim_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const ADMIN: Who = { id: "per_claim_admin", kind: "person", org: ORG };
const STRANGER: Who = { id: "per_claim_stranger", kind: "person", org: "org_claim_x", adminOrgs: ["org_claim_x"] };
const orgAdmin = (org: string): Who => ({ id: `per_claim_orgadmin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  const agentClaims = isAgent ? { gen: who.gen ?? 1, linker: { person: who.linker ?? `per_linker_${who.id}`, since: 1 } } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] };
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...agentClaims, ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, opts: { claims?: object; on?: boolean } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, opts.claims ?? {}), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `claim-key-${++counter}`;
  if (opts.on ?? true) headers["x-test-public-rooms"] = "on";
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, text };
}

let agents = 0;
/** A fresh agent of `org`, linked by `linker`, with its owner's policy set. */
async function agent(org?: string, policy: "public_claims" | "invitations_only" = "public_claims", linker?: string): Promise<Who> {
  const n = ++agents;
  // Each agent has its own organization unless a test shares one, so one test's claims don't use up another's hour.
  const who: Who = { id: `agt_claim_${n}_${crypto.randomUUID().slice(0, 6)}`, org: org ?? `org_claim_${n}`, linker };
  const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
  expect(res.status, "register").toBe(200);
  if (policy === "public_claims") await setPolicy(who, "public_claims");
  return who;
}
const setPolicy = async (who: Who, policy: string) => {
  const r = await api(orgAdmin(who.org), "PUT", `/v1/agents/${who.id}/participation-policy`, { policy });
  expect(r.status, r.text).toBe(200);
};

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql));
const inPrincipal = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(id)), (_: any, state: any) => fn(state.storage.sql));
const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
const drain = async (id: string) => {
  for (let n = 0; n < 5; n++) await runDurableObjectAlarm(stub(id));
};

/** A public room with an admin and a publicly claimable opening. Returns its ID, handle and opening. */
async function publicRoom(opts: { capacity?: number; preset?: string } = {}) {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Open survey" })).body.id;
  const added = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: ADMIN.id, kind: "person", org_id: ORG, role: "admin", policy_version: await version(id) }, { claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } });
  expect(added.status, added.text).toBe(200);
  expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/review-policy`, { require_person: true, policy_version: await version(id) })).status).toBe(200);
  const opening = await api(OWNER, "POST", `/v1/workspaces/${id}/roles`, { title: "Surveyor", responsibilities: "Count fish", preset: opts.preset ?? "public_participant", capacity: opts.capacity ?? 5, publicly_claimable: true, policy_version: await version(id) });
  expect(opening.status, opening.text).toBe(200);
  const hash = (await api(OWNER, "GET", `/v1/workspaces/${id}/visibility`)).body.view_hash;
  const done = await api(OWNER, "PUT", `/v1/workspaces/${id}/visibility`, { visibility: "public", view_hash: hash });
  expect(done.status, done.text).toBe(200);
  await drain(id);
  return { id, handle: done.body.public_handle as string, role: opening.body.id as string };
}
const claim = (who: Who, handle: string, role: string, opts: { claims?: object; on?: boolean } = {}) => api(who, "POST", `/v1/public/workrooms/${handle}/claim`, { role_id: role }, opts);
const release = (who: Who, room: string, role: string) => api(who, "POST", `/v1/workspaces/${room}/roles/${role}/release`, {});

describe("a public claim", () => {
  it("joins as a guest with the opening's preset, with no invitation, and tells the room's managers", async () => {
    const room = await publicRoom();
    const taker = await agent();
    const done = await claim(taker, room.handle, room.role);
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ role_id: room.role, principal_id: taker.id, status: "active" });
    const member = await inRoom(room.id, (sql) => sql.exec("SELECT role, kind, org_id, joined_via, revoked_at FROM member WHERE principal_id = ?", taker.id).one());
    expect(member).toEqual({ role: "guest", kind: "agent", org_id: taker.org, joined_via: "public", revoked_at: null });
    const claimRow = await inRoom(room.id, (sql) => sql.exec("SELECT copied_preset, public FROM role_claim WHERE principal_id = ?", taker.id).one());
    expect(claimRow).toEqual({ copied_preset: "public_participant", public: 1 });
    const told = await inRoom(room.id, (sql) => sql.exec("SELECT e.type FROM event e JOIN outbox o ON o.event_id = e.id WHERE o.recipient_principal_id = ? ORDER BY e.seq", OWNER.id).toArray().map((r: any) => r.type));
    expect(told).toEqual(expect.arrayContaining(["member.added", "role.claimed"]));
    // No invitation was made or needed.
    expect(await inRoom(room.id, (sql) => sql.exec("SELECT COUNT(*) AS n FROM invitation").one().n)).toBe(0);
  });

  it("sees only what its preset allows once in: its own tasks, not the room's", async () => {
    const room = await publicRoom();
    const taker = await agent();
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    const other = await api(OWNER, "POST", `/v1/workspaces/${room.id}/tasks`, { title: "Private task", instructions: "Not for strangers" });
    expect(other.status, other.text).toBe(200);
    const listed = await api(taker, "GET", `/v1/workspaces/${room.id}/tasks`);
    expect(listed.status, listed.text).toBe(200);
    expect(listed.text).not.toContain("Private task");
    expect((await api(taker, "GET", `/v1/workspaces/${room.id}/tasks/${other.body.id}`)).status).not.toBe(200);
    // It can't create tasks, change the room or claim admin.
    expect((await api(taker, "POST", `/v1/workspaces/${room.id}/tasks`, { title: "Mine", instructions: "x" })).status).not.toBe(200);
    expect((await api(taker, "PUT", `/v1/workspaces/${room.id}/topic`, { topic: "film" })).code).toBe("not_allowed");
  });

  it("is refused while its owner allows invitations only, and works once they allow public claims (M4-05)", async () => {
    const room = await publicRoom();
    const taker = await agent(undefined, "invitations_only");
    expect((await claim(taker, room.handle, room.role)).code).toBe("public_claims_not_allowed");
    await setPolicy(taker, "public_claims");
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
  });

  it("answers again for the claim it holds, and counts it once", async () => {
    const room = await publicRoom();
    const taker = await agent();
    const first = await claim(taker, room.handle, room.role);
    const again = await claim(taker, room.handle, room.role);
    expect(again.status, again.text).toBe(200);
    expect(again.body.claimed_at).toBe(first.body.claimed_at);
    const hour = await inPrincipal(taker.id, (sql) => sql.exec("SELECT COUNT(*) AS n FROM public_claim_hour").one().n);
    expect(hour).toBe(1);
    expect(await inRoom(room.id, (sql) => sql.exec("SELECT COUNT(*) AS n FROM role_claim WHERE public = 1").one().n)).toBe(1);
  });

  it("refuses anything the room doesn't offer publicly now, and gives every count back", async () => {
    const room = await publicRoom();
    const taker = await agent();
    const lead = await api(OWNER, "POST", `/v1/workspaces/${room.id}/roles`, { title: "Lead", responsibilities: "Lead", preset: "coordinator", is_lead: true, policy_version: await version(room.id) });
    const invitedOnly = await api(OWNER, "POST", `/v1/workspaces/${room.id}/roles`, { title: "Diver", responsibilities: "Dive", preset: "guest", policy_version: await version(room.id) });
    expect((await claim(taker, `pub_${"0".repeat(32)}`, room.role)).code).toBe("workspace_not_found");
    expect((await claim(taker, room.handle, lead.body.id)).code).toBe("role_not_found");
    expect((await claim(taker, room.handle, invitedOnly.body.id)).code).toBe("role_not_found");
    expect((await claim(taker, room.handle, "role_nope")).code).toBe("role_not_found");
    expect((await claim(taker, room.handle, room.role, { on: false })).code).toBe("workspace_not_found");
    expect((await claim(STRANGER, room.handle, room.role)).code).toBe("not_allowed");
    expect((await api(taker, "POST", `/v1/public/workrooms/${room.handle}/claim`, { role_id: room.role, scopes: ["admin"] })).code).toBe("invalid_argument");
    // Nothing was kept on any count.
    for (const principal of [taker.id, `per_linker_${taker.id}`, taker.org]) {
      expect(await inPrincipal(principal, (sql) => sql.exec("SELECT name FROM sqlite_master WHERE name = 'public_claim_hour'").toArray().length ? sql.exec("SELECT COUNT(*) AS n FROM public_claim_hour").one().n : 0), principal).toBe(0);
    }
  });

  it("is refused while paused, in an archived room, for a full opening, and for an organization the room blocked", async () => {
    const room = await publicRoom({ capacity: 1 });
    const first = await agent();
    expect((await api(OWNER, "PUT", `/v1/workspaces/${room.id}/public-claims`, { paused: true })).body).toMatchObject({ paused: true });
    expect((await claim(first, room.handle, room.role)).code).toBe("public_claims_paused");
    expect((await api(ADMIN, "PUT", `/v1/workspaces/${room.id}/public-claims`, { paused: false })).status).toBe(200);
    expect((await claim(first, room.handle, room.role)).status).toBe(200);
    expect((await claim(await agent(), room.handle, room.role)).code).toBe("role_full");
    const blockedOrg = await agent("org_claim_blocked");
    expect((await api(OWNER, "PUT", `/v1/workspaces/${room.id}/public-claims/blocked-orgs/org_claim_blocked`, {})).body.blocked_orgs).toEqual(["org_claim_blocked"]);
    const roomy = await api(OWNER, "POST", `/v1/workspaces/${room.id}/roles`, { title: "More", responsibilities: "More", preset: "guest", capacity: 3, publicly_claimable: true, policy_version: await version(room.id) });
    expect((await claim(blockedOrg, room.handle, roomy.body.id)).code).toBe("not_allowed");
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${room.id}/public-claims/blocked-orgs/org_claim_blocked`)).body.blocked_orgs).toEqual([]);
    expect((await claim(blockedOrg, room.handle, roomy.body.id)).status).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${room.id}/archive`, { policy_version: await version(room.id) })).status).toBe(200);
    expect((await claim(await agent(), room.handle, roomy.body.id)).code).toBe("workspace_archived");
  });

  it("refuses an agent the room removed until someone clears it", async () => {
    const room = await publicRoom();
    const taker = await agent();
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${room.id}/members/${taker.id}`, { policy_version: await version(room.id) })).status).toBe(200);
    expect((await claim(taker, room.handle, room.role)).code).toBe("access_revoked");
  });

  it("lets only the owner or a human admin pause or block, and audits it", async () => {
    const room = await publicRoom();
    const taker = await agent();
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    expect((await api(taker, "PUT", `/v1/workspaces/${room.id}/public-claims`, { paused: true })).code).toBe("not_allowed");
    expect((await api(taker, "PUT", `/v1/workspaces/${room.id}/public-claims/blocked-orgs/org_x`, {})).code).toBe("not_allowed");
    expect((await api(taker, "GET", `/v1/workspaces/${room.id}/public-claims`)).code).toBe("not_allowed");
    expect((await api(OWNER, "PUT", `/v1/workspaces/${room.id}/public-claims`, { paused: true, extra: 1 })).code).toBe("invalid_argument");
    await api(OWNER, "PUT", `/v1/workspaces/${room.id}/public-claims`, { paused: true });
    await api(OWNER, "PUT", `/v1/workspaces/${room.id}/public-claims/blocked-orgs/org_x`, {});
    const audit = await inRoom(room.id, (sql) => sql.exec("SELECT action FROM audit_event WHERE action LIKE 'public_claims.%' ORDER BY seq").toArray().map((r: any) => r.action));
    expect(audit).toEqual(["public_claims.paused", "public_claims.org_blocked"]);
    expect((await api(OWNER, "GET", `/v1/workspaces/${room.id}/public-claims`)).body).toEqual({ paused: true, blocked_orgs: ["org_x"] });
  });

  it("lets exactly one of many simultaneous claims take the last place (M4-04)", async () => {
    const room = await publicRoom({ capacity: 1 });
    const takers = await Promise.all(Array.from({ length: 8 }, () => agent()));
    const answers = await Promise.all(takers.map((t) => claim(t, room.handle, room.role)));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    expect(answers.filter((a) => a.code === "role_full")).toHaveLength(7);
    // Every refused agent got its counts back.
    for (const [i, t] of takers.entries()) {
      const n = await inPrincipal(t.id, (sql) => sql.exec("SELECT COUNT(*) AS n FROM public_claim").one().n);
      expect(n, t.id).toBe(answers[i].status === 200 ? 1 : 0);
    }
  });
});

describe("the limits (decision 162)", () => {
  it("holds an agent to 3 public claims at once, and frees a place when a claim ends", async () => {
    const rooms = await Promise.all(Array.from({ length: 4 }, () => publicRoom()));
    const taker = await agent();
    for (const room of rooms.slice(0, 3)) expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    expect((await claim(taker, rooms[3].handle, rooms[3].role)).code).toBe("limit_exceeded");
    expect((await release(taker, rooms[0].id, rooms[0].role)).status).toBe(200);
    // The agent's count still lists the first room, which says the claim ended, so the place is freed.
    expect((await claim(taker, rooms[3].handle, rooms[3].role)).status).toBe(200);
  });

  it("holds an agent to 5 public claims an hour, ended ones included", async () => {
    const rooms = await Promise.all(Array.from({ length: 6 }, () => publicRoom()));
    const taker = await agent();
    for (const room of rooms.slice(0, 5)) {
      expect((await claim(taker, room.handle, room.role)).status).toBe(200);
      expect((await release(taker, room.id, room.role)).status).toBe(200);
    }
    expect((await claim(taker, rooms[5].handle, rooms[5].role)).code).toBe("limit_exceeded");
  });

  it("holds every agent one person linked to 3 at once, across organizations", async () => {
    const rooms = await Promise.all(Array.from({ length: 4 }, () => publicRoom()));
    const linker = `per_linker_shared_${crypto.randomUUID().slice(0, 6)}`;
    const takers = [await agent("org_claim_a", "public_claims", linker), await agent("org_claim_b", "public_claims", linker), await agent("org_claim_c", "public_claims", linker), await agent("org_claim_d", "public_claims", linker)];
    for (const [i, room] of rooms.slice(0, 3).entries()) expect((await claim(takers[i], room.handle, room.role)).status).toBe(200);
    expect((await claim(takers[3], rooms[3].handle, rooms[3].role)).code).toBe("limit_exceeded");
  });

  it("holds an organization to 20 an hour and a room to 20 an hour", async () => {
    const room = await publicRoom({ capacity: 50 });
    const org = `org_claim_hourly_${crypto.randomUUID().slice(0, 6)}`;
    // Twenty claims this hour already, as the organization's Principal counts them.
    await inPrincipal(org, (sql) => {
      sql.exec("CREATE TABLE IF NOT EXISTS public_claim (key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS public_claim_hour (seq INTEGER PRIMARY KEY, key TEXT NOT NULL, at INTEGER NOT NULL);");
      for (let n = 0; n < 20; n++) sql.exec("INSERT INTO public_claim_hour (key, at) VALUES (?, ?)", `agt_${n}:ws_${n}`, Date.now());
    });
    expect((await claim(await agent(org), room.handle, room.role)).code).toBe("limit_exceeded");
    // Twenty public claims in the room this hour.
    const busy = await publicRoom({ capacity: 50 });
    await inRoom(busy.id, (sql) => {
      for (let n = 0; n < 20; n++) sql.exec("INSERT INTO role_claim (id, role_id, principal_id, status, claimed_at, copied_preset, grant_version, prior_role, prior_tasks, prior_artifacts, prior_conversations, prior_review, public) VALUES (?, ?, ?, 'released', ?, 'guest', 1, 'guest', 'own', 'own', 'own', 'none', 1)", `clm_fake_${n}`, busy.role, `agt_fake_${n}`, Date.now());
    });
    const late = await agent();
    expect((await claim(late, busy.handle, busy.role)).code).toBe("limit_exceeded");
    // The room refused, so the agent's own count was given back.
    expect(await inPrincipal(late.id, (sql) => sql.exec("SELECT COUNT(*) AS n FROM public_claim_hour").one().n)).toBe(0);
  });
});

describe("unpublishing (decision 151)", () => {
  it("leaves public claimants in, unless the owner ends public claims, which removes them through the departure rules", async () => {
    const kept = await publicRoom();
    const stays = await agent();
    expect((await claim(stays, kept.handle, kept.role)).status).toBe(200);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${kept.id}/visibility`, { visibility: "private" })).status).toBe(200);
    expect((await api(stays, "GET", `/v1/workspaces/${kept.id}`)).status).toBe(200);

    const ended = await publicRoom();
    const goes = await agent();
    expect((await claim(goes, ended.handle, ended.role)).status).toBe(200);
    const invited = await agent("org_claim_room");
    expect((await api(OWNER, "POST", `/v1/workspaces/${ended.id}/members`, { principal_id: invited.id, kind: "agent", org_id: "org_claim_room", role: "member", policy_version: await version(ended.id) })).status).toBe(200);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${ended.id}/visibility`, { visibility: "private", end_public_claims: true })).status).toBe(200);
    expect((await api(goes, "GET", `/v1/workspaces/${ended.id}`)).code).toBe("access_revoked");
    // Someone who joined another way stays.
    expect((await api(invited, "GET", `/v1/workspaces/${ended.id}`)).status).toBe(200);
    const row = await inRoom(ended.id, (sql) => sql.exec("SELECT revocation_reason FROM member WHERE principal_id = ?", goes.id).one());
    expect(row.revocation_reason).toBe("public_claims_ended");
    expect(await inRoom(ended.id, (sql) => sql.exec("SELECT status FROM role_claim WHERE principal_id = ?", goes.id).one().status)).not.toBe("active");
  });
});
