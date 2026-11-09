import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

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
async function api(who: Who, method: string, path: string, body?: unknown, opts: { claims?: object; key?: string; on?: boolean } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, opts.claims ?? {}), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = opts.key ?? `vis-key-${++counter}`;
  if (opts.on) headers["x-test-public-rooms"] = "on";
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
    expect(read.body).toMatchObject({ visibility: "private", public_handle: null, published_at: null, topic: null, public_claims_paused: false, public_rooms_enabled: false });
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
    expect(audit).toEqual([{ action: "visibility.published", prior_json: '{"visibility":"private"}', new_json: '{"visibility":"public"}' }]);
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
    expect(off.body).toMatchObject({ visibility: "private", public_handle: null, published_at: null });
    const audit = await inRoom(id, (sql) => sql.exec("SELECT action, actor_id FROM audit_event WHERE action = 'visibility.unpublished_claims_ended'").toArray());
    expect(audit).toEqual([{ action: "visibility.unpublished_claims_ended", actor_id: ADMIN.id }]);
    const second = (await publish(id)).body.public_handle;
    expect(second).toMatch(/^pub_[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
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
