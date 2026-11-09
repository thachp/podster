import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

// A room's visibility (M4 step 5, ADR 0008): the owner's preview, publishing with its hash, going private, the topic, and
// `publicly_claimable` on openings. `PUBLIC_ROOMS` is off unless a test build's request says `x-test-public-rooms: on`.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const ORG = "org_vis";
const OWNER: Who = { id: "per_vis_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const ADMIN: Who = { id: "per_vis_admin", kind: "person", org: ORG };
const MEMBER: Who = { id: "agt_vis_member", org: ORG };
const OUTSIDER: Who = { id: "per_vis_outsider", kind: "person", org: "org_vis_x", adminOrgs: ["org_vis_x"] };
const orgAdmin = (org: string): Who => ({ id: `per_vis_orgadmin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }), ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, opts: { claims?: object; key?: string; on?: boolean; fail?: boolean } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, opts.claims ?? {}), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = opts.key ?? `vis-key-${++counter}`;
  if (opts.on) headers["x-test-public-rooms"] = "on";
  if (opts.fail) headers["x-test-fail"] = "1";
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, text };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const res = await SELF.fetch(`https://api.internal/v1/agents/${MEMBER.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(ORG)) }, body: JSON.stringify({ org_id: ORG, name: MEMBER.id }) });
  if (res.status !== 200) throw new Error(`register: ${res.status}`);
});

const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)), (_: any, state: any) => fn(state.storage.sql));

/** A room with a human admin and a member agent, and person review on unless asked otherwise. */
async function room(personReview = true) {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Billing v2" })).body.id;
  for (const [who, role] of [[ADMIN, "admin"], [MEMBER, "member"]] as const) {
    const claims = who.kind === "person" ? { target_member: { person: who.id, orgs: { [who.org]: 1 } } } : {};
    const r = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: who.kind ?? "agent", org_id: who.org, role, policy_version: await version(id) }, { claims });
    expect(r.status, `add ${who.id}: ${r.text}`).toBe(200);
  }
  if (personReview) {
    const r = await api(OWNER, "PUT", `/v1/workspaces/${id}/review-policy`, { require_person: true, policy_version: await version(id) });
    expect(r.status, r.text).toBe(200);
  }
  return id;
}

const preview = async (id: string, who: Who = OWNER) => api(who, "GET", `/v1/workspaces/${id}/visibility`);
const publish = async (id: string, who: Who = OWNER, opts: { on?: boolean; hash?: string } = {}) => {
  const hash = opts.hash ?? (await preview(id)).body.view_hash;
  return api(who, "PUT", `/v1/workspaces/${id}/visibility`, { visibility: "public", view_hash: hash }, { on: opts.on ?? true });
};
const unpublish = (id: string, who: Who = OWNER, end_public_claims?: boolean) =>
  api(who, "PUT", `/v1/workspaces/${id}/visibility`, { visibility: "private", ...(end_public_claims === undefined ? {} : { end_public_claims }) });

describe("the preview", () => {
  it("starts private, and shows the owner and admins exactly what would be public", async () => {
    const id = await room();
    const read = await preview(id);
    expect(read.status, read.text).toBe(200);
    expect(read.body).toMatchObject({ visibility: "private", public_handle: null, published_at: null, published_on: null, topic: null, public_claims_paused: false, public_rooms_enabled: false });
    expect(read.body.view_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(read.body.preview).toMatchObject({ name: "Billing v2", workflow: "general", person_review: true, archived: false, openings: [], outputs: [] });
    // The owner, the admin and the member agent.
    expect(read.body.preview.participant_count).toBe(3);
    expect((await preview(id, ADMIN)).body.view_hash).toBe(read.body.view_hash);
    expect((await preview(id, MEMBER)).code).toBe("not_allowed");
    expect((await preview(id, OUTSIDER)).code).toBe("workspace_not_found");
  });

  it("holds nothing private", async () => {
    const id = await room();
    const task = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "CANARY_task_title", instructions: "CANARY_instructions", assignee: MEMBER.id });
    expect(task.status, task.text).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/tasks/${task.body.id}/messages`, { body: "CANARY_message" })).status).toBe(200);
    const closed = await api(OWNER, "POST", `/v1/workspaces/${id}/roles`, { title: "CANARY_closed_title", responsibilities: "CANARY_closed_duties", preset: "guest", policy_version: await version(id) });
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/roles/${closed.body.id}`, { policy_version: await version(id) })).status).toBe(200);
    const output = await api(OWNER, "POST", `/v1/workspaces/${id}/outputs`, { title: "CANARY_removed_output" });
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/outputs/${output.body.id}`)).status).toBe(200);
    const text = JSON.stringify((await preview(id)).body.preview);
    for (const needle of ["CANARY", id, OWNER.id, ADMIN.id, MEMBER.id, ORG, task.body.id, closed.body.id, output.body.id]) {
      expect(text, needle).not.toContain(needle);
    }
  });
});

describe("publishing", () => {
  it("is refused while public rooms are off, and changes nothing", async () => {
    const id = await room();
    expect((await publish(id, OWNER, { on: false })).code).toBe("public_rooms_disabled");
    expect((await preview(id)).body.visibility).toBe("private");
  });

  it("makes a new handle and tells everyone in the room", async () => {
    const id = await room();
    const done = await publish(id);
    expect(done.status, done.text).toBe(200);
    expect(done.body.visibility).toBe("public");
    expect(done.body.public_handle).toMatch(/^pub_[0-9a-f]{32}$/);
    expect(typeof done.body.published_at).toBe("number");
    const events = await inRoom(id, (sql) => sql.exec("SELECT type, actor_id FROM event WHERE type = 'room.published'").toArray());
    expect(events).toEqual([{ type: "room.published", actor_id: OWNER.id }]);
    const audit = await inRoom(id, (sql) => sql.exec("SELECT action, prior_json, new_json FROM audit_event WHERE action LIKE 'visibility.%'").toArray());
    // The handle goes in the audit row, so an old link can be traced to its room after it goes private or republishes.
    expect(audit.map((r: any) => ({ ...r, prior_json: JSON.parse(r.prior_json), new_json: JSON.parse(r.new_json) }))).toEqual([{ action: "visibility.published", prior_json: { visibility: "private", public_handle: null }, new_json: { visibility: "public", public_handle: done.body.public_handle } }]);
    // The member agent sees it in the room's activity.
    const activity = await api(MEMBER, "GET", `/v1/workspaces/${id}/activity`);
    expect(activity.body.events.map((e: any) => e.type)).toContain("room.published");
    // Asking again changes nothing and keeps the handle.
    const again = await publish(id);
    expect(again.body.public_handle).toBe(done.body.public_handle);
  });

  it("is for the owner alone", async () => {
    const id = await room();
    expect((await publish(id, ADMIN)).code).toBe("not_allowed");
    expect((await publish(id, MEMBER)).code).toBe("not_allowed");
    expect((await publish(id, OUTSIDER)).code).toBe("workspace_not_found");
    expect((await preview(id)).body.visibility).toBe("private");
  });

  it("is refused if anything public changed since the preview", async () => {
    const id = await room();
    const hash = (await preview(id)).body.view_hash;
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/brief`, { goal: "Changed", policy_version: await version(id) })).status).toBe(200);
    expect((await publish(id, OWNER, { hash })).code).toBe("version_conflict");
    expect((await preview(id)).body.visibility).toBe("private");
  });

  it("isn't stopped by something private changing", async () => {
    const id = await room();
    const hash = (await preview(id)).body.view_hash;
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Private", instructions: "Private", assignee: MEMBER.id })).status).toBe(200);
    expect((await publish(id, OWNER, { hash })).status).toBe(200);
  });

  it("needs person review on, and person review can't be turned off while public", async () => {
    const id = await room(false);
    expect((await publish(id)).code).toBe("person_review_required");
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/review-policy`, { require_person: true, policy_version: await version(id) })).status).toBe(200);
    expect((await publish(id)).status).toBe(200);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/review-policy`, { require_person: false, policy_version: await version(id) })).code).toBe("person_review_required");
    expect((await unpublish(id)).status).toBe(200);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/review-policy`, { require_person: false, policy_version: await version(id) })).status).toBe(200);
  });

  it("refuses bodies that aren't exactly one of the two requests", async () => {
    const id = await room();
    const hash = (await preview(id)).body.view_hash;
    for (const body of [{}, { visibility: "public" }, { visibility: "public", view_hash: "abc" }, { visibility: "public", view_hash: hash, end_public_claims: true }, { visibility: "private", view_hash: hash }, { visibility: "unlisted" }, { visibility: "private", end_public_claims: "yes" }]) {
      expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/visibility`, body, { on: true })).code, JSON.stringify(body)).toBe("invalid_argument");
    }
  });

  it("replays a retry's stored answer", async () => {
    const id = await room();
    const hash = (await preview(id)).body.view_hash;
    const first = await api(OWNER, "PUT", `/v1/workspaces/${id}/visibility`, { visibility: "public", view_hash: hash }, { on: true, key: `vis-retry-${id}` });
    const second = await api(OWNER, "PUT", `/v1/workspaces/${id}/visibility`, { visibility: "public", view_hash: hash }, { on: true, key: `vis-retry-${id}` });
    expect(second.body).toEqual(first.body);
  });
});

describe("going private", () => {
  it("drops the handle for good, and a republish makes a new one", async () => {
    const id = await room();
    const first = (await publish(id)).body.public_handle;
    const off = await unpublish(id, ADMIN, true);
    expect(off.status, off.text).toBe(200);
    expect(off.body).toMatchObject({ visibility: "private", public_handle: null, published_at: null, published_on: null });
    const audit = await inRoom(id, (sql) => sql.exec("SELECT action, actor_id, prior_json, new_json FROM audit_event WHERE action = 'visibility.unpublished_claims_ended'").toArray());
    expect(audit.map((r: any) => ({ ...r, prior_json: JSON.parse(r.prior_json), new_json: JSON.parse(r.new_json) }))).toEqual([{ action: "visibility.unpublished_claims_ended", actor_id: ADMIN.id, prior_json: { visibility: "public", public_handle: first }, new_json: { visibility: "private", public_handle: null } }]);
    const second = (await publish(id)).body.public_handle;
    expect(second).toMatch(/^pub_[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
    // Both handles stay traced to this room, each in the row that made it.
    const made = await inRoom(id, (sql) => sql.exec("SELECT new_json FROM audit_event WHERE action = 'visibility.published' ORDER BY seq").toArray().map((r: any) => JSON.parse(r.new_json).public_handle));
    expect(made).toEqual([first, second]);
  });

  it("works with public rooms off, and in an archived room, but never for an agent", async () => {
    const id = await room();
    await publish(id);
    expect((await unpublish(id, MEMBER)).code).toBe("not_allowed");
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    // Publishing an archived room is refused, and making it private isn't.
    expect((await publish(id)).code).toBe("workspace_archived");
    expect((await unpublish(id)).status).toBe(200);
    expect((await unpublish(id)).body.visibility).toBe("private");
  });
});

describe("the topic", () => {
  it("comes from the fixed list, set by the owner or an admin", async () => {
    const id = await room();
    expect((await api(ADMIN, "PUT", `/v1/workspaces/${id}/topic`, { topic: "film" })).body).toEqual({ topic: "film" });
    expect((await preview(id)).body.preview.topic).toBe("film");
    for (const body of [{ topic: "Film" }, { topic: "buy now" }, { topic: 3 }, {}, { topic: "film", extra: 1 }]) {
      expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/topic`, body)).code, JSON.stringify(body)).toBe("invalid_argument");
    }
    expect((await api(MEMBER, "PUT", `/v1/workspaces/${id}/topic`, { topic: "research" })).code).toBe("not_allowed");
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/topic`, { topic: null })).body).toEqual({ topic: null });
  });
});

describe("publicly claimable openings", () => {
  it("are only Public participant or Guest openings that aren't the lead", async () => {
    const id = await room();
    const make = async (body: object) => api(OWNER, "POST", `/v1/workspaces/${id}/roles`, { title: "Role", responsibilities: "Duties", policy_version: await version(id), ...body });
    const guest = await make({ preset: "guest", publicly_claimable: true });
    expect(guest.status, guest.text).toBe(200);
    expect(guest.body.publicly_claimable).toBe(true);
    expect((await make({ preset: "public_participant", publicly_claimable: true })).status).toBe(200);
    expect((await make({ preset: "member", publicly_claimable: true })).code).toBe("invalid_argument");
    expect((await make({ preset: "coordinator", publicly_claimable: true })).code).toBe("invalid_argument");
    expect((await make({ is_lead: true, publicly_claimable: true })).code).toBe("invalid_argument");
    expect((await make({ preset: "guest", publicly_claimable: "yes" })).code).toBe("invalid_argument");
    expect((await make({ preset: "member" })).body.publicly_claimable).toBe(false);
    // A change that would leave it on an opening that can't use it is refused, and turning it off then works.
    const path = `/v1/workspaces/${id}/roles/${guest.body.id}`;
    expect((await api(OWNER, "PUT", path, { preset: "member", policy_version: await version(id) })).code).toBe("invalid_argument");
    expect((await api(OWNER, "PUT", path, { preset: "member", publicly_claimable: false, policy_version: await version(id) })).body).toMatchObject({ preset: "member", publicly_claimable: false });
    // The preview shows only what's in effect, with an ID only for one that can be claimed.
    const openings = (await preview(id)).body.preview.openings;
    expect(openings.filter((o: any) => o.id !== null).length).toBe(1);
  });
});

describe("the switch", () => {
  it("is set nowhere in the Worker's configuration", () => {
    expect(BINDINGS.TEST_WRANGLER).not.toContain("PUBLIC_ROOMS");
  });
});

describe("the discovery index (step 6)", () => {
  const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
  /** Runs the room's alarm until nothing is due, as the platform would. */
  const drain = async (id: string) => {
    for (let n = 0; n < 5; n++) await runDurableObjectAlarm(stub(id));
  };
  const indexRow = async (id: string) =>
    BINDINGS.DB.prepare("SELECT * FROM public_workroom_index WHERE workspace_id = ?").bind(id).first();
  const due = (id: string) => inRoom(id, (sql) => sql.exec("SELECT seq, pending FROM public_index_outbox").toArray());

  it("writes nothing for a private room", async () => {
    const id = await room();
    await api(OWNER, "PUT", `/v1/workspaces/${id}/topic`, { topic: "film" });
    await drain(id);
    expect(await indexRow(id)).toBeNull();
    expect(await due(id)).toEqual([]);
  });

  it("lists a public room with its handle and keys, and no text", async () => {
    const id = await room();
    await api(OWNER, "PUT", `/v1/workspaces/${id}/topic`, { topic: "research" });
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/roles`, { title: "Reviewer", responsibilities: "Read it", preset: "guest", publicly_claimable: true, policy_version: await version(id) })).status).toBe(200);
    const published = (await publish(id)).body;
    await drain(id);
    const row = await indexRow(id);
    expect(row).toMatchObject({ workspace_id: id, public_handle: published.public_handle, topic: "research", has_open_opening: 1, published_at: published.published_at, resolvable: 1, listed: 1 });
    expect(Object.keys(row).sort()).toEqual(["has_open_opening", "listed", "public_handle", "published_at", "resolvable", "topic", "updated_seq", "workspace_id"]);
    expect(JSON.stringify(row)).not.toContain("Billing v2");
  });

  it("follows changes to its keys, and an unchanged row writes nothing", async () => {
    const id = await room();
    await publish(id);
    await drain(id);
    const first = await indexRow(id);
    expect(first.has_open_opening).toBe(0);
    // A message changes no key, so the row in D1 keeps its seq.
    const task = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "T", instructions: "I", assignee: MEMBER.id });
    await api(OWNER, "POST", `/v1/workspaces/${id}/tasks/${task.body.id}/messages`, { body: "hello" });
    await drain(id);
    expect((await indexRow(id)).updated_seq).toBe(first.updated_seq);
    await api(ADMIN, "PUT", `/v1/workspaces/${id}/topic`, { topic: "film" });
    await drain(id);
    const second = await indexRow(id);
    expect(second.topic).toBe("film");
    expect(second.updated_seq).toBeGreaterThan(first.updated_seq);
  });

  it("leaves a tombstone with the handle that went when a room goes private, and lists a republish under its new handle", async () => {
    const id = await room();
    const first = (await publish(id)).body.public_handle;
    await drain(id);
    await unpublish(id);
    await drain(id);
    expect(await indexRow(id)).toMatchObject({ resolvable: 0, listed: 0, public_handle: first, topic: null, has_open_opening: 0, published_at: null });
    const again = (await publish(id)).body.public_handle;
    await drain(id);
    expect(await indexRow(id)).toMatchObject({ resolvable: 1, listed: 1, public_handle: again });
  });

  it("keeps an archived public room resolvable but out of Explore, and lists it again when it's unarchived", async () => {
    const id = await room();
    await api(OWNER, "PUT", `/v1/workspaces/${id}/topic`, { topic: "research" });
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/roles`, { title: "Reviewer", responsibilities: "Read it", preset: "guest", publicly_claimable: true, policy_version: await version(id) })).status).toBe(200);
    const published = (await publish(id)).body;
    await drain(id);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    await drain(id);
    // Decision 152: the link still answers, labeled Archived, and Explore leaves it out. An archived room takes no claims.
    expect(await indexRow(id)).toMatchObject({ resolvable: 1, listed: 0, public_handle: published.public_handle, topic: "research", has_open_opening: 0, published_at: published.published_at });
    const unarchived = await api(OWNER, "POST", `/v1/workspaces/${id}/unarchive`, { policy_version: await version(id) });
    expect(unarchived.status, unarchived.text).toBe(200);
    await drain(id);
    expect(await indexRow(id)).toMatchObject({ resolvable: 1, listed: 1, public_handle: published.public_handle, has_open_opening: 1 });
  });

  it("writes one row with the new handle when a room goes private and public again before any write, and the old handle is gone", async () => {
    const id = await room();
    const first = (await publish(id)).body.public_handle;
    await unpublish(id);
    const second = (await publish(id)).body.public_handle;
    await drain(id);
    const all = await BINDINGS.DB.prepare("SELECT * FROM public_workroom_index WHERE workspace_id = ? OR public_handle IN (?, ?)").bind(id, first, second).all();
    expect(all.results).toHaveLength(1);
    expect(all.results[0]).toMatchObject({ workspace_id: id, public_handle: second, resolvable: 1, listed: 1 });
  });

  it("writes nothing more for a formerly public room than its tombstone", async () => {
    const id = await room();
    await publish(id);
    await drain(id);
    await unpublish(id);
    await drain(id);
    const tombstone = await indexRow(id);
    const outbox = await due(id);
    await api(OWNER, "PUT", `/v1/workspaces/${id}/topic`, { topic: "film" });
    const task = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "T", instructions: "I", assignee: MEMBER.id });
    await api(OWNER, "POST", `/v1/workspaces/${id}/tasks/${task.body.id}/messages`, { body: "hello" });
    await drain(id);
    expect(await indexRow(id)).toEqual(tombstone);
    expect(await due(id)).toEqual(outbox);
  });

  it("leaves the row due when a command lands while the write is out", async () => {
    const id = await room();
    // Test builds land a command, which marks the row due with a newer seq, after the D1 write and before it's settled. It's
    // asked for before the publish, since the alarm can fire on its own straight after.
    await inRoom(id, (sql) => sql.exec("CREATE TABLE test_index_inflight (x INTEGER)"));
    await publish(id);
    const seq = await inRoom(id, (sql) => sql.exec("SELECT seq FROM event WHERE type = 'room.published'").one().seq);
    await drain(id);
    // The first write carried the publish's seq. The row stayed due, so a second write carried the newer one.
    expect(await due(id)).toEqual([{ seq: seq + 1, pending: 0 }]);
    expect((await indexRow(id)).updated_seq).toBe(seq + 1);
    expect(await inRoom(id, (sql) => sql.exec("SELECT name FROM sqlite_master WHERE name = 'test_index_inflight'").toArray())).toEqual([]);
  });

  it("writes the row once after the migration for a room that's already public", async () => {
    const id = await room();
    const published = (await publish(id)).body;
    // Back to before this migration, with the room already public and nothing in D1.
    await inRoom(id, (sql) => {
      // Step 8's public claims came after, so they come off first.
      sql.exec("DROP TABLE public_claim_block");
      sql.exec("DROP INDEX role_claim_public");
      sql.exec("ALTER TABLE role_claim DROP COLUMN public");
      sql.exec("ALTER TABLE member DROP COLUMN joined_via");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE public_index_outbox");
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    // An alarm may already have written it, so it's taken out of D1 too.
    await BINDINGS.DB.prepare("DELETE FROM public_workroom_index WHERE workspace_id = ?").bind(id).run();
    // A read migrates the room. It records no event, so only the migration can mark the row due.
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    await drain(id);
    expect(await indexRow(id)).toMatchObject({ public_handle: published.public_handle, resolvable: 1, listed: 1 });
    // A private room gets nothing.
    const quiet = await room();
    await inRoom(quiet, (sql) => {
      // Step 8's public claims came after, so they come off first.
      sql.exec("DROP TABLE public_claim_block");
      sql.exec("DROP INDEX role_claim_public");
      sql.exec("ALTER TABLE role_claim DROP COLUMN public");
      sql.exec("ALTER TABLE member DROP COLUMN joined_via");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE public_index_outbox");
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    expect((await api(OWNER, "GET", `/v1/workspaces/${quiet}`)).status).toBe(200);
    expect(await due(quiet)).toEqual([]);
  });

  it("takes a tombstone's handle from the audit, not the room's current handle", async () => {
    const id = await room();
    const published = (await publish(id)).body.public_handle;
    await drain(id);
    await unpublish(id);
    // Something left a handle on the private room's row. The tombstone still names the one its audit recorded.
    await inRoom(id, (sql) => sql.exec("UPDATE workspace SET public_handle = 'pub_ffffffffffffffffffffffffffffffff'"));
    await drain(id);
    expect(await indexRow(id)).toMatchObject({ listed: 0, public_handle: published });
  });

  it("keeps milliseconds in the index, as the room and API do", async () => {
    const id = await room();
    const before = Date.now();
    const published = (await publish(id)).body;
    await drain(id);
    const row = await indexRow(id);
    expect(row.published_at).toBe(published.published_at);
    expect(row.published_at).toBeGreaterThanOrEqual(before);
    expect(new Date(row.published_at).toISOString().slice(0, 10)).toBe(published.published_on);
  });

  it("never lets an older write restore a row", async () => {
    const id = await room();
    await publish(id);
    await drain(id);
    // A newer row, as if a later write had landed first.
    await BINDINGS.DB.prepare("UPDATE public_workroom_index SET updated_seq = 1000000, listed = 0, public_handle = NULL WHERE workspace_id = ?").bind(id).run();
    await api(OWNER, "PUT", `/v1/workspaces/${id}/topic`, { topic: "other" });
    await drain(id);
    expect(await indexRow(id)).toMatchObject({ updated_seq: 1000000, listed: 0, public_handle: null });
  });

  it("rewrites a row D1 refused once D1 would take it, even if nothing in the room changed", async () => {
    const id = await room();
    await publish(id);
    await drain(id);
    // D1 holds a newer seq, so the next write is refused, and the room forgets what it wrote.
    await BINDINGS.DB.prepare("UPDATE public_workroom_index SET updated_seq = 1000000, listed = 0 WHERE workspace_id = ?").bind(id).run();
    await api(OWNER, "PUT", `/v1/workspaces/${id}/topic`, { topic: "other" });
    await drain(id);
    const written = await inRoom(id, (sql) => sql.exec("SELECT written FROM public_index_outbox").one().written);
    expect(written).toBeNull();
    // D1 goes back, as a restore would. An event that changes no key still writes the row in full.
    await BINDINGS.DB.prepare("UPDATE public_workroom_index SET updated_seq = 1 WHERE workspace_id = ?").bind(id).run();
    const task = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "T", instructions: "I", assignee: MEMBER.id });
    expect(task.status).toBe(200);
    await drain(id);
    expect(await indexRow(id)).toMatchObject({ topic: "other", listed: 1 });
    expect((await indexRow(id)).updated_seq).toBeGreaterThan(1);
  });

  it("stays due while D1 fails, and catches up once it works", async () => {
    const id = await room();
    // D1 fails from before the publish, since the alarm can fire on its own straight after.
    await BINDINGS.DB.prepare("ALTER TABLE public_workroom_index RENAME TO public_workroom_index_away").run();
    try {
      await publish(id);
      await drain(id);
      expect((await due(id))[0].pending).toBe(1);
    } finally {
      await BINDINGS.DB.prepare("ALTER TABLE public_workroom_index_away RENAME TO public_workroom_index").run();
    }
    await drain(id);
    expect((await due(id))[0].pending).toBe(0);
    expect((await indexRow(id)).listed).toBe(1);
  });

  it("logs a failed write with the error code and the room's ID only", async () => {
    const id = await room();
    // The alarm can fire on its own straight after the publish, so D1 fails and the spy listens from before it.
    const errors = vi.spyOn(console, "error");
    await BINDINGS.DB.prepare("ALTER TABLE public_workroom_index RENAME TO public_workroom_index_away").run();
    let handle = "";
    let lines: string[] = [];
    try {
      handle = (await publish(id)).body.public_handle;
      for (let n = 0; n < 50 && lines.length === 0; n++) {
        await runDurableObjectAlarm(stub(id));
        lines = errors.mock.calls.map((call) => call.map(String).join(" ")).filter((line) => line.includes("public index projection failed"));
        if (lines.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await BINDINGS.DB.prepare("ALTER TABLE public_workroom_index_away RENAME TO public_workroom_index").run();
      errors.mockRestore();
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toBe(`public index projection failed: room=${id} code=internal_error`);
      for (const needle of [handle, "Billing", OWNER.id, "public_workroom_index"]) expect(line).not.toContain(needle);
    }
  });
});

describe("the deeper review's checks", () => {
  /** What a visibility change writes, in one read. The outbox may drain on an alarm, so it's counted as never growing. */
  const written = (id: string, key: string) => inRoom(id, (sql) => ({
    room: sql.exec("SELECT visibility, public_handle, published_at FROM workspace").one(),
    events: sql.exec("SELECT COUNT(*) AS n FROM event WHERE type IN ('room.published', 'room.unpublished')").one().n,
    audit: sql.exec("SELECT COUNT(*) AS n FROM audit_event WHERE action LIKE 'visibility.%'").one().n,
    outbox: sql.exec("SELECT COUNT(*) AS n FROM outbox").one().n,
    orphans: sql.exec("SELECT COUNT(*) AS n FROM outbox WHERE event_id NOT IN (SELECT id FROM event)").one().n,
    keys: sql.exec("SELECT COUNT(*) AS n FROM idempotency WHERE key = ?", key).one().n,
  }));

  it("leaves nothing behind when a publish or an unpublish fails partway, and a retry does the work", async () => {
    const id = await room();
    const hash = (await preview(id)).body.view_hash;
    const body = { visibility: "public", view_hash: hash };
    const before = await written(id, "vis-fail-publish");
    const failed = await api(OWNER, "PUT", `/v1/workspaces/${id}/visibility`, body, { on: true, fail: true, key: "vis-fail-publish" });
    expect([failed.status, failed.code]).toEqual([500, "internal_error"]);
    const after = await written(id, "vis-fail-publish");
    expect(after).toMatchObject({ room: before.room, events: before.events, audit: before.audit, orphans: 0, keys: 0 });
    expect(after.outbox).toBeLessThanOrEqual(before.outbox);
    expect(before.room).toEqual({ visibility: "private", public_handle: null, published_at: null });
    const done = await api(OWNER, "PUT", `/v1/workspaces/${id}/visibility`, body, { on: true, key: "vis-fail-publish" });
    expect(done.status, done.text).toBe(200);

    const off = { visibility: "private" };
    const public_ = await written(id, "vis-fail-unpublish");
    const failedOff = await api(OWNER, "PUT", `/v1/workspaces/${id}/visibility`, off, { fail: true, key: "vis-fail-unpublish" });
    expect([failedOff.status, failedOff.code]).toEqual([500, "internal_error"]);
    const afterOff = await written(id, "vis-fail-unpublish");
    expect(afterOff).toMatchObject({ room: public_.room, events: public_.events, audit: public_.audit, orphans: 0, keys: 0 });
    expect(afterOff.outbox).toBeLessThanOrEqual(public_.outbox);
    expect(public_.room.public_handle).toBe(done.body.public_handle);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/visibility`, off, { key: "vis-fail-unpublish" })).body.visibility).toBe("private");
  });

  it("refuses a former owner, whether they handed the room on or left", async () => {
    const handed = await room();
    const claims = { target_member: { person: ADMIN.id, orgs: { [ORG]: 1 } } };
    const moved = await api(OWNER, "POST", `/v1/workspaces/${handed}/owner/transfer`, { to: ADMIN.id, policy_version: await version(handed) }, { claims });
    expect(moved.status, moved.text).toBe(200);
    const hash = (await preview(handed, ADMIN)).body.view_hash;
    expect((await publish(handed, OWNER, { hash })).code).toBe("not_allowed");
    expect((await preview(handed, ADMIN)).body.visibility).toBe("private");
    // The new owner may.
    expect((await publish(handed, ADMIN, { hash })).status).toBe(200);

    const left = await room();
    const leftHash = (await preview(left)).body.view_hash;
    await inRoom(left, (sql) => sql.exec("UPDATE workspace SET owner_left_at = ?", Date.now() - 1000));
    const refused = await publish(left, OWNER, { hash: leftHash });
    expect(refused.status, refused.text).not.toBe(200);
    expect(await inRoom(left, (sql) => sql.exec("SELECT visibility, public_handle FROM workspace").one())).toEqual({ visibility: "private", public_handle: null });
  });

  it("refuses an agent stored with the admin role, for publishing and the preview", async () => {
    const id = await room();
    const hash = (await preview(id)).body.view_hash;
    await inRoom(id, (sql) => sql.exec("UPDATE member SET role = 'admin' WHERE principal_id = ?", MEMBER.id));
    expect((await preview(id, MEMBER)).code).toBe("not_allowed");
    expect((await publish(id, MEMBER, { hash })).code).toBe("not_allowed");
    expect((await publish(id)).status).toBe(200);
    expect((await unpublish(id, MEMBER)).code).toBe("not_allowed");
    expect((await preview(id)).body.visibility).toBe("public");
  });

  it("accepts an uppercase view hash as the same hash", async () => {
    const id = await room();
    const hash: string = (await preview(id)).body.view_hash;
    expect(hash).toMatch(/[a-f]/);
    const done = await publish(id, OWNER, { hash: hash.toUpperCase() });
    expect(done.status, done.text).toBe(200);
    expect(done.body.view_hash).toBe(hash);
  });

  it("records the visibility events with no text, only IDs", async () => {
    const id = await room();
    await publish(id);
    await unpublish(id);
    const events = await inRoom(id, (sql) => sql.exec("SELECT * FROM event WHERE type IN ('room.published', 'room.unpublished') ORDER BY seq").toArray());
    expect(events.map((e: any) => e.type)).toEqual(["room.published", "room.unpublished"]);
    for (const event of events) {
      expect(event).toMatchObject({ actor_id: OWNER.id, task_id: null, reason: null, prior_status: null, new_status: null, task_version: null, subject_id: null });
      for (const [column, value] of Object.entries(event)) {
        if (typeof value !== "string" || column === "type") continue;
        expect(value, column).toMatch(/^[a-z]+_[A-Za-z0-9_]+$/);
      }
      expect(JSON.stringify(event)).not.toContain("Billing");
    }
  });

  it("dates a fresh publish today, in UTC", async () => {
    const id = await room();
    const before = Date.now();
    const done = await publish(id);
    const after = Date.now();
    expect(done.body.published_at).toBeGreaterThanOrEqual(before);
    expect(done.body.published_at).toBeLessThanOrEqual(after);
    const days = [before, after].map((ms) => new Date(ms).toISOString().slice(0, 10));
    expect(days).toContain(done.body.published_on);
    expect((await preview(id)).body.published_on).toBe(done.body.published_on);
  });
});
