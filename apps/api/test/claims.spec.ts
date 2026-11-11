import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { alarmPass } from "./alarm.ts";

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
async function api(who: Who, method: string, path: string, body?: unknown, opts: { claims?: object; on?: boolean; key?: string } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, opts.claims ?? {}), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = opts.key ?? `claim-key-${++counter}`;
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
  for (let n = 0; n < 5; n++) await alarmPass(stub(id));
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
    // Delivery is held, so the runtime's own run of the alarm can't send what the claim queues before it's read below.
    await inRoom(room.id, (sql) => sql.exec("CREATE TABLE test_hold_outbox (x)"));
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
    const read = (await api(OWNER, "GET", `/v1/workspaces/${room.id}/public-claims`)).body;
    expect(read).toMatchObject({ paused: true, blocked_orgs: ["org_x"], claims_last_hour: 1 });
    expect(read.claimants.map((c: any) => c.principal_id)).toEqual([taker.id]);
  });

  it("lets exactly one of many simultaneous claims take the last place (M4-04)", async () => {
    const room = await publicRoom({ capacity: 1 });
    const takers = await Promise.all(Array.from({ length: 8 }, () => agent()));
    const answers = await Promise.all(takers.map((t) => claim(t, room.handle, room.role)));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    expect(answers.filter((a) => a.code === "role_full")).toHaveLength(7);
    // Every refused agent got its counts back, once its release has run after the answer.
    for (const [i, t] of takers.entries()) {
      const want = answers[i].status === 200 ? 1 : 0;
      const n = await eventually(() => inPrincipal(t.id, (sql) => sql.exec("SELECT COUNT(*) AS n FROM public_claim").one().n), (got) => got === want);
      expect(n, t.id).toBe(want);
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
    expect(await eventually(() => inPrincipal(late.id, (sql) => sql.exec("SELECT COUNT(*) AS n FROM public_claim_hour").one().n), (n) => n === 0)).toBe(0);
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

/** Settling runs after the response, so a test waits for it. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  // Settling runs in `wait_until` after the answer. This returns as soon as it's done, and gives a loaded runner 5 s.
  for (let n = 0; n < 250 && !done(value); n++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
}
const counts = (principal: string) => inPrincipal(principal, (sql) => {
  const exists = sql.exec("SELECT name FROM sqlite_master WHERE name = 'public_claim'").toArray().length > 0;
  if (!exists) return { entries: [], hour: 0, reservations: 0 };
  return {
    entries: sql.exec("SELECT key, state FROM public_claim ORDER BY key").toArray(),
    hour: sql.exec("SELECT COUNT(*) AS n FROM public_claim_hour").one().n,
    reservations: sql.exec("SELECT COUNT(*) AS n FROM public_claim_reservation").one().n,
  };
});

describe("the deeper review's checks", () => {
  it("counts two claims at once from one agent for one room exactly once, whichever settles first (item 1)", async () => {
    for (const validFirst of [true, false]) {
      const room = await publicRoom();
      const taker = await agent();
      const valid = () => claim(taker, room.handle, room.role);
      const bad = () => claim(taker, room.handle, "role_nope");
      const [first, second] = validFirst ? await Promise.all([valid(), bad()]) : await Promise.all([bad(), valid()]);
      const answers = validFirst ? [first, second] : [second, first];
      expect(answers[0].status, answers[0].text).toBe(200);
      expect(answers[1].code).toBe("role_not_found");
      const settled = await eventually(() => counts(taker.id), (c: any) => c.reservations === 0 && c.entries.every((e: any) => e.state === "active"));
      // One claim stands, counted once as active. Its hour is counted once, or twice when the refused request reserved
      // first, since a request that isn't a retry counts afresh: over-counting in a race fails closed.
      expect(settled).toMatchObject({ entries: [{ key: room.id, state: "active" }], reservations: 0 });
      expect([1, 2]).toContain(settled.hour);
      const person = await eventually(() => counts(`per_linker_${taker.id}`), (c: any) => c.reservations === 0);
      expect(person).toMatchObject({ entries: [{ key: `${taker.id}:${room.id}`, state: "active" }], reservations: 0 });
      expect([1, 2]).toContain(person.hour);
    }
  });

  it("keeps a claim counted when its confirm is lost, and confirms it on a retry (item 2)", async () => {
    const room = await publicRoom();
    const taker = await agent();
    await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_fail_confirm (principal TEXT)").run();
    await BINDINGS.DB.prepare("INSERT INTO test_fail_confirm (principal) VALUES (?)").bind(taker.id).run();
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    // The agent's confirm was lost, so its entry is still pending.
    const lost = await eventually(() => counts(taker.id), (c: any) => c.entries.length === 1);
    expect(lost.entries).toEqual([{ key: room.id, state: "pending" }]);
    // Two minutes on, it counts as a claim. It isn't dropped.
    await inPrincipal(taker.id, (sql) => sql.exec("UPDATE public_claim SET at = at - 180000"));
    const other = await publicRoom();
    expect((await claim(taker, other.handle, other.role)).status).toBe(200);
    expect((await eventually(() => counts(taker.id), (c: any) => c.entries.length === 2 && c.entries.every((e: any) => e.state === "active"))).entries).toEqual(
      [{ key: room.id, state: "active" }, { key: other.id, state: "active" }].sort((a, b) => a.key.localeCompare(b.key)),
    );
    // A retry of the first claim confirms it again, and counts nothing new.
    const hour = (await counts(taker.id)).hour;
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    expect((await counts(taker.id)).hour).toBe(hour);
  });

  it("refuses an organization the room revoked (item 3)", async () => {
    const room = await publicRoom();
    const taker = await agent();
    const revoked = await api(OWNER, "DELETE", `/v1/workspaces/${room.id}/organizations/${taker.org}`, { policy_version: await version(room.id) });
    expect(revoked.status, revoked.text).toBe(200);
    expect((await claim(taker, room.handle, room.role)).code).toBe("not_allowed");
  });

  it("forgets how someone joined when they join again another way, so ending public claims leaves them (item 4)", async () => {
    const room = await publicRoom();
    const taker = await agent(ORG);
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    expect((await release(taker, room.id, room.role)).status).toBe(200);
    const added = await api(OWNER, "POST", `/v1/workspaces/${room.id}/members`, { principal_id: taker.id, kind: "agent", org_id: ORG, role: "member", policy_version: await version(room.id) });
    expect(added.status, added.text).toBe(200);
    expect(await inRoom(room.id, (sql) => sql.exec("SELECT joined_via FROM member WHERE principal_id = ?", taker.id).one().joined_via)).toBeNull();
    expect((await api(OWNER, "PUT", `/v1/workspaces/${room.id}/visibility`, { visibility: "private", end_public_claims: true })).status).toBe(200);
    expect((await api(taker, "GET", `/v1/workspaces/${room.id}`)).status).toBe(200);
  });

  it("ends a public claimant's membership with its claim, released or ended by the room (item 5)", async () => {
    const room = await publicRoom();
    const releases = await agent();
    expect((await claim(releases, room.handle, room.role)).status).toBe(200);
    expect((await release(releases, room.id, room.role)).body).toMatchObject({ status: "released", member: "left" });
    expect((await api(releases, "GET", `/v1/workspaces/${room.id}`)).code).toBe("access_revoked");
    const ended = await agent();
    expect((await claim(ended, room.handle, room.role)).status).toBe(200);
    const endedByRoom = await api(OWNER, "DELETE", `/v1/workspaces/${room.id}/roles/${room.role}/claims/${ended.id}`, { policy_version: await version(room.id) });
    expect(endedByRoom.status, endedByRoom.text).toBe(200);
    expect((await api(ended, "GET", `/v1/workspaces/${room.id}`)).code).toBe("access_revoked");
    // Each left through the departure rules, with a reason that lets it claim again.
    const reasons = await inRoom(room.id, (sql) => sql.exec("SELECT principal_id, revocation_reason FROM member WHERE joined_via = 'public' OR principal_id IN (?, ?) ORDER BY principal_id", releases.id, ended.id).toArray().map((r: any) => r.revocation_reason));
    expect(reasons.sort()).toEqual(["public_claim_ended", "public_claim_released"]);
    expect((await claim(releases, room.handle, room.role)).status).toBe(200);
  });

  it("frees a count only on its room's word: a room that can't answer keeps it (item 6)", async () => {
    const taker = await agent();
    // Three counted claims in rooms that don't exist, so none can answer.
    await inPrincipal(taker.id, (sql) => {
      sql.exec("CREATE TABLE IF NOT EXISTS public_claim (key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, hour_seq INTEGER); CREATE TABLE IF NOT EXISTS public_claim_hour (seq INTEGER PRIMARY KEY, key TEXT NOT NULL, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS public_claim_reservation (key TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (key, id));");
      for (const n of [1, 2, 3]) sql.exec("INSERT INTO public_claim (key, workspace_id, state, at) VALUES (?, ?, 'active', ?)", `ws_gone_${n}`, `ws_gone_${n}`, Date.now());
    });
    const room = await publicRoom();
    expect((await claim(taker, room.handle, room.role)).code).toBe("limit_exceeded");
    expect((await counts(taker.id)).entries).toHaveLength(3);
  });

  it("doesn't pin a count to an archived room (item 7)", async () => {
    const rooms = await Promise.all(Array.from({ length: 4 }, () => publicRoom()));
    const taker = await agent();
    for (const room of rooms.slice(0, 3)) expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${rooms[0].id}/archive`, { policy_version: await version(rooms[0].id) })).status).toBe(200);
    expect((await claim(taker, rooms[3].handle, rooms[3].role)).status).toBe(200);
    // Archiving changed nothing else: the claimant is still in the archived room.
    expect((await api(taker, "GET", `/v1/workspaces/${rooms[0].id}`)).status).toBe(200);
  });

  it("doesn't mark the index for task and message events (item 9)", async () => {
    const room = await publicRoom();
    const before = await inRoom(room.id, (sql) => sql.exec("SELECT seq, pending FROM public_index_outbox").one());
    const task = await api(OWNER, "POST", `/v1/workspaces/${room.id}/tasks`, { title: "T", instructions: "I" });
    await api(OWNER, "POST", `/v1/workspaces/${room.id}/tasks/${task.body.id}/messages`, { body: "hello" });
    expect(await inRoom(room.id, (sql) => sql.exec("SELECT seq, pending FROM public_index_outbox").one())).toEqual(before);
    // Anything else still marks it.
    await api(OWNER, "PUT", `/v1/workspaces/${room.id}/topic`, { topic: "film" });
    expect((await inRoom(room.id, (sql) => sql.exec("SELECT seq, pending FROM public_index_outbox").one())).seq).toBeGreaterThan(before.seq);
  });

  it("doesn't tell a public claimant who owns the room or wrote its brief (item 10)", async () => {
    const room = await publicRoom();
    expect((await api(OWNER, "PUT", `/v1/workspaces/${room.id}/brief`, { goal: "Count the reef", policy_version: await version(room.id) })).status).toBe(200);
    const taker = await agent();
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    const seen = await api(taker, "GET", `/v1/workspaces/${room.id}`);
    expect(seen.body).toMatchObject({ owner: null, brief_by: null, goal: "Count the reef" });
    expect(seen.text).not.toContain(OWNER.id);
  });
});

describe("the second review's checks", () => {
  const hour = async (principal: string) => (await counts(principal)).hour;

  it("counts a claim asked for again after it ended, so the 6th cycle on one room is refused at the agent limit (H1)", async () => {
    const room = await publicRoom();
    const taker = await agent();
    for (let n = 0; n < 5; n++) {
      const got = await claim(taker, room.handle, room.role);
      expect(got.status, got.text).toBe(200);
      expect((await release(taker, room.id, room.role)).status).toBe(200);
    }
    expect(await eventually(() => hour(taker.id), (h) => h === 5)).toBe(5);
    expect((await claim(taker, room.handle, room.role)).code).toBe("limit_exceeded");
    // The agent's count refused it: the room took 5 and nothing else.
    expect(await inRoom(room.id, (sql) => sql.exec("SELECT COUNT(*) AS n FROM role_claim WHERE public = 1").one().n)).toBe(5);
  });

  it("does the same at the linking person's limit, with two agents cycling on one room (H1)", async () => {
    const room = await publicRoom();
    const linker = `per_linker_cycle_${crypto.randomUUID().slice(0, 6)}`;
    const a = await agent(undefined, "public_claims", linker);
    const b = await agent(undefined, "public_claims", linker);
    for (const who of [a, a, a, b, b]) {
      const got = await claim(who, room.handle, room.role);
      expect(got.status, got.text).toBe(200);
      expect((await release(who, room.id, room.role)).status).toBe(200);
    }
    expect(await eventually(() => hour(linker), (h) => h === 5)).toBe(5);
    // b has made only 2 in the hour, so its own count would let it through. The person's refuses it.
    expect(await hour(b.id)).toBe(2);
    expect((await claim(b, room.handle, room.role)).code).toBe("limit_exceeded");
  });

  it("never leaves a claim uncounted when it races a release of the same role (M1)", async () => {
    for (let n = 0; n < 6; n++) {
      const room = await publicRoom();
      const taker = await agent();
      expect((await claim(taker, room.handle, room.role)).status).toBe(200);
      const [again] = await Promise.all([claim(taker, room.handle, room.role), release(taker, room.id, room.role)]);
      expect([200, 409], again.text).toContain(again.status);
      if (again.status === 409) expect(["version_conflict", "already_member"]).toContain(again.code);
      // Every public claim the room made for the agent is counted on its Principal and its person's.
      const made = await inRoom(room.id, (sql) => sql.exec("SELECT COUNT(*) AS n FROM role_claim WHERE public = 1 AND principal_id = ?", taker.id).one().n);
      const settled = await eventually(() => counts(taker.id), (c: any) => c.reservations === 0 && c.hour >= made);
      expect(settled.hour, `agent, round ${n}`).toBeGreaterThanOrEqual(made);
      const person = await eventually(() => counts(`per_linker_${taker.id}`), (c: any) => c.reservations === 0 && c.hour >= made);
      expect(person.hour, `person, round ${n}`).toBeGreaterThanOrEqual(made);
    }
  });

  it("counts a fresh claim the room was asked to take only as a retry by refusing it, then counts it on asking again (M1)", async () => {
    const room = await publicRoom();
    const taker = await agent();
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    expect((await release(taker, room.id, room.role)).status).toBe(200);
    // As if the room had said "held" just before the release landed: the agent's count is stale and active, and the
    // Worker counts nothing for a retry. Forcing the room's word here, the room must refuse what would be a new claim.
    await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_force_held (principal TEXT)").run();
    await BINDINGS.DB.prepare("INSERT INTO test_force_held (principal) VALUES (?)").bind(taker.id).run();
    const raced = await claim(taker, room.handle, room.role);
    await BINDINGS.DB.prepare("DELETE FROM test_force_held WHERE principal = ?").bind(taker.id).run();
    expect(raced.code, raced.text).toBe("version_conflict");
    expect(await inRoom(room.id, (sql) => sql.exec("SELECT COUNT(*) AS n FROM role_claim WHERE public = 1").one().n)).toBe(1);
    const before = await eventually(() => counts(taker.id), (c: any) => c.reservations === 0);
    expect(before.hour).toBe(1);
    // Asking again reads the room's real word, and counts it.
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    expect(await eventually(() => hour(taker.id), (h) => h === 2)).toBe(2);
  });

  it("restores a stale count it replaced when the room refuses, since the claim may still stand (H1)", async () => {
    const taker = await agent();
    const room = await publicRoom();
    // A count already here for the room, as one the room couldn't speak for.
    await inPrincipal(taker.id, (sql) => {
      sql.exec("CREATE TABLE IF NOT EXISTS public_claim (key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, hour_seq INTEGER); CREATE TABLE IF NOT EXISTS public_claim_hour (seq INTEGER PRIMARY KEY, key TEXT NOT NULL, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS public_claim_reservation (key TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (key, id));");
      sql.exec("INSERT INTO public_claim (key, workspace_id, state, at) VALUES (?, ?, 'active', ?)", room.id, room.id, Date.now());
    });
    await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_force_unknown (principal TEXT)").run();
    await BINDINGS.DB.prepare("INSERT INTO test_force_unknown (principal) VALUES (?)").bind(taker.id).run();
    const refused = await claim(taker, room.handle, "role_nope");
    await BINDINGS.DB.prepare("DELETE FROM test_force_unknown WHERE principal = ?").bind(taker.id).run();
    expect(refused.code).toBe("role_not_found");
    const after = await eventually(() => counts(taker.id), (c: any) => c.reservations === 0 && c.entries.every((e: any) => e.state === "active"));
    expect(after).toEqual({ entries: [{ key: room.id, state: "active" }], hour: 0, reservations: 0 });
  });

  it("lets a claimant the owner promoted keep its place on release, and tells it who owns the room (L1)", async () => {
    const room = await publicRoom();
    const taker = await agent(ORG);
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    const promoted = await api(OWNER, "POST", `/v1/workspaces/${room.id}/members/${taker.id}/role`, { role: "member", policy_version: await version(room.id) });
    expect(promoted.status, promoted.text).toBe(200);
    expect(await inRoom(room.id, (sql) => sql.exec("SELECT joined_via FROM member WHERE principal_id = ?", taker.id).one().joined_via)).toBeNull();
    const grant = () => inRoom(room.id, (sql) => sql.exec("SELECT g.tasks, g.artifacts, g.conversations, g.review, m.role FROM access_grant g JOIN member m ON m.principal_id = g.principal_id WHERE g.principal_id = ?", taker.id).one());
    const given = await grant();
    expect(given.role).toBe("member");
    const released = await release(taker, room.id, room.role);
    expect(released.status, released.text).toBe(200);
    expect(released.body.member).toBeUndefined();
    // The owner's promotion stands: release returns it to the role and access the owner gave, not the guest it joined as.
    expect(await grant()).toEqual(given);
    const seen = await api(taker, "GET", `/v1/workspaces/${room.id}`);
    expect(seen.status, seen.text).toBe(200);
    expect(seen.body.owner).not.toBeNull();
  });

  it("counts a claim made again before the first one's counts settle, on every Principal (M-A)", async () => {
    const room = await publicRoom();
    const taker = await agent();
    const principals = [taker.id, `per_linker_${taker.id}`, taker.org];
    await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_hold_settle (principal TEXT)").run();
    for (const p of principals) await BINDINGS.DB.prepare("INSERT INTO test_hold_settle (principal) VALUES (?)").bind(p).run();
    try {
      expect((await claim(taker, room.handle, room.role)).status).toBe(200);
      expect((await release(taker, room.id, room.role)).status).toBe(200);
      const again = await claim(taker, room.handle, room.role);
      expect(again.status, again.text).toBe(200);
    } finally {
      for (const p of principals) await BINDINGS.DB.prepare("DELETE FROM test_hold_settle WHERE principal = ?").bind(p).run();
    }
    const made = await inRoom(room.id, (sql) => sql.exec("SELECT COUNT(*) AS n FROM role_claim WHERE public = 1").one().n);
    expect(made).toBe(2);
    for (const p of principals) {
      const settled = await eventually(() => counts(p), (c: any) => c.reservations === 0 && c.entries.every((e: any) => e.state === "active"));
      expect(settled.hour, p).toBe(made);
    }
  });

  it("counts nothing on the organization for retries of a held claim (M-B)", async () => {
    const room = await publicRoom({ capacity: 10 });
    const org = `org_claim_retry_${crypto.randomUUID().slice(0, 6)}`;
    const taker = await agent(org);
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    expect(await eventually(() => hour(org), (h) => h === 1)).toBe(1);
    for (let n = 0; n < 25; n++) expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    expect(await eventually(() => counts(org), (c: any) => c.reservations === 0)).toMatchObject({ hour: 1 });
    expect(await hour(taker.id)).toBe(1);
    const other = await agent(org);
    expect((await claim(other, room.handle, room.role)).status).toBe(200);
    expect(await eventually(() => hour(org), (h) => h === 2)).toBe(2);
  });

  it("keeps an unsettled count another request may stand on, when the room says not held and refuses (follow-up)", async () => {
    const room = await publicRoom();
    const taker = await agent();
    // The first claim commits, but its answer is lost on the agent's count, which stays pending with its reservation.
    await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_fail_confirm (principal TEXT)").run();
    await BINDINGS.DB.prepare("INSERT INTO test_fail_confirm (principal) VALUES (?)").bind(taker.id).run();
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    const lost = await eventually(() => counts(taker.id), (c: any) => c.entries.length === 1);
    expect(lost).toEqual({ entries: [{ key: room.id, state: "pending" }], hour: 1, reservations: 1 });
    // A request that read "not held" before that claim committed, and that the room refuses.
    await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_force_not_held (principal TEXT)").run();
    await BINDINGS.DB.prepare("INSERT INTO test_force_not_held (principal) VALUES (?)").bind(taker.id).run();
    const refused = await claim(taker, room.handle, "role_nope");
    await BINDINGS.DB.prepare("DELETE FROM test_force_not_held WHERE principal = ?").bind(taker.id).run();
    expect(refused.code).toBe("role_not_found");
    // The standing claim is still counted at once, and only the refused request's hour was given back.
    const after = await eventually(() => counts(taker.id), (c: any) => c.reservations === 1 && c.entries.every((e: any) => e.state === "active"));
    expect(after).toEqual({ entries: [{ key: room.id, state: "active" }], hour: 1, reservations: 1 });
  });
});

describe("owner controls in public rooms (M4 step 9)", () => {
  const settings = async (room: string) => (await api(OWNER, "GET", `/v1/workspaces/${room}/public-claims`)).body;

  it("shows the owner each public claimant, with the opening it holds, and the room's claims this hour", async () => {
    const room = await publicRoom();
    const holds = await agent();
    const releases = await agent();
    const promoted = await agent(ORG);
    for (const who of [holds, releases, promoted]) expect((await claim(who, room.handle, room.role)).status).toBe(200);
    expect((await release(releases, room.id, room.role)).status).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${room.id}/members/${promoted.id}/role`, { role: "member", policy_version: await version(room.id) })).status).toBe(200);
    const seen = await settings(room.id);
    // The one that released left with its claim, and the promoted one is the owner's now: neither is listed.
    expect(seen.claimants).toHaveLength(1);
    expect(seen.claimants[0]).toMatchObject({ principal_id: holds.id, org_id: holds.org, role: "guest", role_id: room.role });
    expect(typeof seen.claimants[0].joined_at).toBe("number");
    expect(typeof seen.claimants[0].claimed_at).toBe("number");
    // Ended claims still count against the room's hour.
    expect(seen.claims_last_hour).toBe(3);
    // A human admin sees it too. A claimant doesn't.
    expect((await api(ADMIN, "GET", `/v1/workspaces/${room.id}/public-claims`)).status).toBe(200);
    expect((await api(holds, "GET", `/v1/workspaces/${room.id}/public-claims`)).code).toBe("not_allowed");
  });

  it("ends every public claim while the room stays public, keeping one the owner promoted (endPublicClaims)", async () => {
    const room = await publicRoom();
    const [a, b] = [await agent(), await agent()];
    const promoted = await agent(ORG);
    for (const who of [a, b, promoted]) expect((await claim(who, room.handle, room.role)).status).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${room.id}/members/${promoted.id}/role`, { role: "member", policy_version: await version(room.id) })).status).toBe(200);
    expect((await api(a, "POST", `/v1/workspaces/${room.id}/public-claims/end`, {})).code).toBe("not_allowed");
    expect((await api(OWNER, "POST", `/v1/workspaces/${room.id}/public-claims/end`, { org_id: a.org })).code).toBe("invalid_argument");
    const ended = await api(ADMIN, "POST", `/v1/workspaces/${room.id}/public-claims/end`, {});
    expect(ended.status, ended.text).toBe(200);
    expect(ended.body).toMatchObject({ ended: 2, claimants: [] });
    for (const who of [a, b]) expect((await api(who, "GET", `/v1/workspaces/${room.id}`)).code).toBe("access_revoked");
    expect((await api(promoted, "GET", `/v1/workspaces/${room.id}`)).status).toBe(200);
    // Each left through the departure rules, and the room is still public, so each can claim again.
    const reasons = await inRoom(room.id, (sql) => sql.exec("SELECT revocation_reason FROM member WHERE principal_id IN (?, ?)", a.id, b.id).toArray().map((r: any) => r.revocation_reason));
    expect(reasons).toEqual(["public_claims_ended", "public_claims_ended"]);
    expect((await api(OWNER, "GET", `/v1/workspaces/${room.id}/visibility`)).body.visibility).toBe("public");
    expect((await claim(a, room.handle, room.role)).status).toBe(200);
    const audit = await inRoom(room.id, (sql) => sql.exec("SELECT new_json FROM audit_event WHERE action = 'public_claims.ended'").toArray());
    expect(audit.map((r: any) => JSON.parse(r.new_json))).toEqual([{ ended: 2 }]);
  });

  it("can end a blocked organization's public claims with the block, and only that organization's", async () => {
    const room = await publicRoom();
    const org = `org_claim_blocked_${crypto.randomUUID().slice(0, 6)}`;
    const [x, y] = [await agent(org), await agent(org)];
    const other = await agent();
    for (const who of [x, y, other]) expect((await claim(who, room.handle, room.role)).status).toBe(200);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${room.id}/public-claims/blocked-orgs/${org}`, { end_claims: "yes" })).code).toBe("invalid_argument");
    const blocked = await api(OWNER, "PUT", `/v1/workspaces/${room.id}/public-claims/blocked-orgs/${org}`, { end_claims: true });
    expect(blocked.status, blocked.text).toBe(200);
    expect(blocked.body).toMatchObject({ ended: 2, blocked_orgs: [org] });
    expect(blocked.body.claimants.map((c: any) => c.principal_id)).toEqual([other.id]);
    expect((await claim(x, room.handle, room.role)).code).toBe("not_allowed");
    // Lifting the block lets them claim again.
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${room.id}/public-claims/blocked-orgs/${org}`)).status).toBe(200);
    expect((await claim(x, room.handle, room.role)).status).toBe(200);
  });

  it("keeps a removed agent out until an owner or admin clears the removal", async () => {
    const room = await publicRoom();
    const taker = await agent();
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${room.id}/members/${taker.id}`, { policy_version: await version(room.id) })).status).toBe(200);
    expect((await settings(room.id)).claimants).toEqual([]);
    expect((await claim(taker, room.handle, room.role)).code).toBe("access_revoked");
    const cleared = await api(OWNER, "POST", `/v1/workspaces/${room.id}/members/${taker.id}/clear-removal`, { policy_version: await version(room.id) });
    expect(cleared.status, cleared.text).toBe(200);
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
  });

  it("keeps person review on while the room is public", async () => {
    const room = await publicRoom();
    expect((await api(OWNER, "PUT", `/v1/workspaces/${room.id}/review-policy`, { require_person: false, policy_version: await version(room.id) })).code).toBe("person_review_required");
  });

  it("replays a stored answer only to a caller who may still manage the room (step 9 review, L1)", async () => {
    const room = await publicRoom();
    const asked = [
      ["PUT", `/v1/workspaces/${room.id}/public-claims`, { paused: true }],
      ["PUT", `/v1/workspaces/${room.id}/public-claims/blocked-orgs/org_replay`, {}],
      ["DELETE", `/v1/workspaces/${room.id}/public-claims/blocked-orgs/org_replay`, {}],
      ["POST", `/v1/workspaces/${room.id}/public-claims/end`, {}],
    ] as const;
    const keys = asked.map((_, n) => `replay-${room.id}-${n}`);
    for (const [n, [method, path, body]] of asked.entries()) {
      const first = await api(ADMIN, method, path, body, { key: keys[n] });
      expect(first.status, first.text).toBe(200);
      // Asked again while still an admin, it's the stored answer.
      expect((await api(ADMIN, method, path, body, { key: keys[n] })).status).toBe(200);
    }
    const demoted = await api(OWNER, "POST", `/v1/workspaces/${room.id}/members/${ADMIN.id}/role`, { role: "member", policy_version: await version(room.id) }, { claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } });
    expect(demoted.status, demoted.text).toBe(200);
    for (const [n, [method, path, body]] of asked.entries()) {
      expect((await api(ADMIN, method, path, body, { key: keys[n] })).code, `${method} ${path}`).toBe("not_allowed");
    }
  });

  it("lists only claimants still in the guest role they joined with, as ending them does (step 9 review, L2)", async () => {
    const room = await publicRoom();
    const [stays, raised] = [await agent(), await agent()];
    for (const who of [stays, raised]) expect((await claim(who, room.handle, room.role)).status).toBe(200);
    // A role raised by a path that doesn't clear how it joined.
    await inRoom(room.id, (sql) => sql.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", raised.id));
    expect((await settings(room.id)).claimants.map((c: any) => c.principal_id)).toEqual([stays.id]);
    const ended = await api(OWNER, "POST", `/v1/workspaces/${room.id}/public-claims/end`, {});
    expect(ended.body.ended).toBe(1);
  });
});

// M4 step 12, decision 161: a public participant may hold at most 1 GB of the room's files, beside the room's 5 GB.
describe("a public participant's share of the room's files", () => {
  const sha = async (data: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const DATA = new TextEncoder().encode("count");

  /** A public room whose claimant holds an accepted task, and already holds `held` bytes of the room's files. */
  async function claimantWithTask(held: number) {
    const room = await publicRoom();
    const taker = await agent();
    expect((await claim(taker, room.handle, room.role)).status).toBe(200);
    const task = await api(OWNER, "POST", `/v1/workspaces/${room.id}/tasks`, { title: "Count", instructions: "Count the fish.", assignee: taker.id });
    expect(task.status, task.text).toBe(200);
    const accepted = await api(taker, "POST", `/v1/workspaces/${room.id}/tasks/${task.body.id}/accept`, { version: 1 });
    expect(accepted.status, accepted.text).toBe(200);
    // What it already holds: a kept file of that size, without sending its bytes.
    await keep(room.id, taker.id, held);
    return { room, taker, task: task.body.id as string };
  }
  const keep = (room: string, who: string, size: number) =>
    inRoom(room, (sql) =>
      sql.exec(
        "INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, created_at, upload_expires_at) VALUES (?, 'kept.txt', ?, ?, 'ready', '', ?, ?, ?)",
        `obj_kept_${crypto.randomUUID().replace(/-/g, "")}`, size, "0".repeat(64), who, Date.now(), Date.now(),
      ),
    );
  const start = async (who: Who, room: string, task: string, size: number) =>
    api(who, "POST", `/v1/workspaces/${room}/uploads`, { name: "notes.txt", size, sha256: size === DATA.length ? await sha(DATA) : "a".repeat(64), task_id: task });

  it("lets it fill exactly 1 GB, counting uploads still arriving, and no more", async () => {
    const { room, taker, task } = await claimantWithTask(950_000_000);
    const over = await start(taker, room.id, task, 50_000_001);
    expect(over.status, over.text).toBe(409);
    expect(over.code).toBe("participant_quota_exceeded");
    expect((await start(taker, room.id, task, 50_000_000)).status).toBe(200);
    // The upload not yet arrived holds its space.
    const next = await start(taker, room.id, task, 1);
    expect(next.code).toBe("participant_quota_exceeded");
  });

  it("checks again when the bytes arrive, as the room's quota is", async () => {
    const { room, taker, task } = await claimantWithTask(1_000_000_000 - DATA.length);
    const made = await start(taker, room.id, task, DATA.length);
    expect(made.status, made.text).toBe(200);
    // Something else of its arrives first, so this one no longer fits.
    await keep(room.id, taker.id, 1);
    const sent = await SELF.fetch(`https://api.internal${made.body.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${made.body.token}` }, body: DATA as any });
    const body = await sent.json<any>();
    expect(sent.status).toBe(409);
    expect(body.error.code).toBe("participant_quota_exceeded");
  });

  it("doesn't limit one the owner has given another role, or anyone else", async () => {
    const { room, taker, task } = await claimantWithTask(1_000_000_000);
    expect((await start(taker, room.id, task, 1)).code).toBe("participant_quota_exceeded");
    const promoted = await api(OWNER, "POST", `/v1/workspaces/${room.id}/members/${taker.id}/role`, { role: "member", policy_version: await version(room.id) });
    expect(promoted.status, promoted.text).toBe(200);
    expect((await start(taker, room.id, task, 1)).status).toBe(200);
  });
});

// M4 step 12: a publish's stored answer is replayed only to someone who may still manage the room.
describe("replaying a visibility change", () => {
  it("refuses a stored answer to an admin who has since lost the role", async () => {
    const room = await publicRoom();
    const key = `vis-${crypto.randomUUID()}`;
    const first = await api(ADMIN, "PUT", `/v1/workspaces/${room.id}/visibility`, { visibility: "private" }, { key });
    expect(first.status, first.text).toBe(200);
    const demoted = await api(OWNER, "POST", `/v1/workspaces/${room.id}/members/${ADMIN.id}/role`, { role: "member", policy_version: await version(room.id) }, { claims: { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } } });
    expect(demoted.status, demoted.text).toBe(200);
    const again = await api(ADMIN, "PUT", `/v1/workspaces/${room.id}/visibility`, { visibility: "private" }, { key });
    expect(again.status).toBe(403);
    expect(again.body?.visibility).toBeUndefined();
  });
});
