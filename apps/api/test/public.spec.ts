import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet } from "./alarm.ts";

// The public read surface (M4 step 7, ADR 0008): the room page, which is the only route that takes the public assertion,
// and Explore, which needs sign-in. Its merge criteria are the canary test and the route-list test below.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const ORG = "org_pub";
const OWNER: Who = { id: "per_pub_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const ADMIN: Who = { id: "per_pub_admin", kind: "person", org: ORG };
const AGENT: Who = { id: "agt_pub_member", org: ORG };
const STRANGER: Who = { id: "per_pub_stranger", kind: "person", org: "org_pub_x", adminOrgs: ["org_pub_x"] };
const OUTSIDE_AGENT: Who = { id: "agt_pub_outside", org: "org_pub_x" };
const orgAdmin = (org: string): Who => ({ id: `per_pub_orgadmin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }), ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
/** What the gateway's `PublicReads` mints: `kind: public`, and no subject or anything else. */
async function publicAssertion(extra: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "public", ...extra })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
type Opts = { claims?: object; on?: boolean; token?: string; cursorKey?: "unset" | "empty" | "short" };
async function api(who: Who | "public", method: string, path: string, body?: unknown, opts: Opts = {}) {
  const token = opts.token ?? (who === "public" ? await publicAssertion() : await assertion(who, opts.claims ?? {}));
  const headers: Record<string, string> = { "x-podster-assertion": token, "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `pub-key-${++counter}`;
  if (opts.on) headers["x-test-public-rooms"] = "on";
  if (opts.cursorKey) headers["x-test-cursor-key"] = opts.cursorKey;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, code: parsed?.error?.code, text, headers: res.headers };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const [agent, org] of [[AGENT.id, ORG], [OUTSIDE_AGENT.id, "org_pub_x"]]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${agent}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(org)) }, body: JSON.stringify({ org_id: org, name: agent }) });
    if (res.status !== 200) throw new Error(`register: ${res.status}`);
  }
});

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql));
const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
/** Runs the room's alarm until nothing is due, as the platform would, so its index row is written. */
const drain = async (id: string) => {
  for (let n = 0; n < 5; n++) await alarmPass(stub(id));
};
const page = (handle: string, who: Who | "public" = "public", opts: Opts = {}) => api(who, "GET", `/v1/public/workrooms/${handle}`, undefined, { on: true, ...opts });
const explore = (who: Who | "public", query = "", opts: Opts = {}) => api(who, "GET", `/v1/public/explore${query}`, undefined, { on: true, ...opts });

/** Every room a test makes, quieted after it so that no alarm of it runs into the next test. */
const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)));
});

/** A room with a human admin and a member agent, person review on, and a name of its own. */
async function room(name = "Open research room") {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name, goal: "Map the reef", context: "Shared notes on the survey" })).body.id;
  madeRooms.push(id);
  for (const [who, role] of [[ADMIN, "admin"], [AGENT, "member"]] as const) {
    const claims = who.kind === "person" ? { target_member: { person: who.id, orgs: { [who.org]: 1 } } } : {};
    const r = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: who.kind ?? "agent", org_id: who.org, role, policy_version: await version(id) }, { claims });
    expect(r.status, `add ${who.id}: ${r.text}`).toBe(200);
  }
  const r = await api(OWNER, "PUT", `/v1/workspaces/${id}/review-policy`, { require_person: true, policy_version: await version(id) });
  expect(r.status, r.text).toBe(200);
  return id;
}
async function publish(id: string) {
  const hash = (await api(OWNER, "GET", `/v1/workspaces/${id}/visibility`)).body.view_hash;
  const done = await api(OWNER, "PUT", `/v1/workspaces/${id}/visibility`, { visibility: "public", view_hash: hash }, { on: true });
  expect(done.status, done.text).toBe(200);
  await drain(id);
  return done.body.public_handle as string;
}
const unpublish = async (id: string) => {
  const done = await api(OWNER, "PUT", `/v1/workspaces/${id}/visibility`, { visibility: "private" });
  expect(done.status, done.text).toBe(200);
};

/** Every key path in a JSON value, with array items as `[]`. */
function keyPaths(value: any, at = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${at}[]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [`${at}.${k}`, ...keyPaths(v, `${at}.${k}`)]);
  return [];
}
function schemaPaths(schema: any, at = ""): string[] {
  const out: string[] = [];
  for (const [name, child] of Object.entries<any>(schema.properties ?? {})) {
    out.push(`${at}.${name}`);
    if (child.properties) out.push(...schemaPaths(child, `${at}.${name}`));
    if (child.items?.properties) out.push(...schemaPaths(child.items, `${at}.${name}[]`));
  }
  return out;
}

describe("the room page", () => {
  it("shows a public room the same to nobody signed in, a stranger, an agent and a member", async () => {
    const id = await room();
    const handle = await publish(id);
    const views = await Promise.all([page(handle), page(handle, STRANGER), page(handle, OUTSIDE_AGENT), page(handle, AGENT), page(handle, OWNER)]);
    for (const view of views) expect(view.status, view.text).toBe(200);
    expect(new Set(views.map((v) => v.text)).size).toBe(1);
    expect(views[0].body).toMatchObject({ handle, content: { name: "Open research room", goal: "Map the reef", archived: false, person_review: true } });
    expect(views[0].body.published_on).toBe(new Date().toISOString().slice(0, 10));
  });

  it("answers one not-found for anything that isn't a public room under its current handle", async () => {
    const privateRoom = await room("Private room");
    const gone = await room("Gone private");
    const goneHandle = await publish(gone);
    await unpublish(gone);
    await drain(gone);
    const again = await room("Republished");
    const oldHandle = await publish(again);
    await unpublish(again);
    await publish(again);
    const live = await room("Live");
    const liveHandle = await publish(live);
    const answers = await Promise.all([
      page(`pub_${"0".repeat(32)}`),
      page(goneHandle),
      page(oldHandle),
      page(privateRoom),
      page(live),
      page(liveHandle.toUpperCase()),
      page(`${liveHandle}x`),
      page("not-a-handle"),
      // Public rooms switched off.
      page(liveHandle, "public", { on: false }),
      page(liveHandle, OWNER, { on: false }),
    ]);
    for (const answer of answers) {
      expect([answer.status, answer.code]).toEqual([404, "workspace_not_found"]);
      expect(answer.text).toBe(answers[0].text);
      expect([...answer.headers.keys()].sort()).toEqual([...answers[0].headers.keys()].sort());
    }
  });

  it("asks no room unless the index has a resolvable row for the handle", async () => {
    const id = await room();
    const handle = await publish(id);
    // The room would answer: it's public under this handle. With its row not resolvable, nothing reaches it.
    await BINDINGS.DB.prepare("UPDATE public_workroom_index SET resolvable = 0 WHERE workspace_id = ?").bind(id).run();
    expect((await page(handle)).code).toBe("workspace_not_found");
    await BINDINGS.DB.prepare("DELETE FROM public_workroom_index WHERE workspace_id = ?").bind(id).run();
    expect((await page(handle)).code).toBe("workspace_not_found");
    await BINDINGS.DB.prepare("INSERT INTO public_workroom_index (workspace_id, public_handle, published_at, resolvable, listed, updated_seq) VALUES (?, ?, 1, 1, 1, 1)").bind(id, handle).run();
    expect((await page(handle)).status).toBe(200);
  });

  it("asks the room, not the index: a resolvable row whose room went private answers not-found", async () => {
    const id = await room();
    const handle = await publish(id);
    // Private, with the index not yet told.
    await inRoom(id, (sql) => sql.exec("UPDATE workspace SET visibility = 'private'"));
    expect((await page(handle)).code).toBe("workspace_not_found");
  });

  it("keeps an archived public room readable, labeled archived (decision 152)", async () => {
    const id = await room();
    const handle = await publish(id);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    await drain(id);
    const view = await page(handle);
    expect(view.status, view.text).toBe(200);
    expect(view.body.content.archived).toBe(true);
  });

  it("refuses a public assertion that names anyone, or carries anything else", async () => {
    const id = await room();
    const handle = await publish(id);
    for (const extra of [{ sub: OWNER.id }, { org: ORG }, { gen: 1 }, { admin_orgs: [ORG] }]) {
      const token = await publicAssertion(extra);
      expect((await page(handle, "public", { token })).code, JSON.stringify(extra)).toBe("invalid_assertion");
    }
  });

  it("checks a signed-in agent's connection, as every route does", async () => {
    const id = await room();
    const handle = await publish(id);
    expect((await page(handle, { ...OUTSIDE_AGENT, gen: 99 })).status).not.toBe(200);
  });

  it("spends a signed-in agent's token, so a replay is refused", async () => {
    const id = await room();
    const handle = await publish(id);
    const spend = { agent_jti: `plugin:${crypto.randomUUID()}`, agent_jti_exp: Math.floor(Date.now() / 1000) + 60 };
    expect((await page(handle, OUTSIDE_AGENT, { claims: spend })).status).toBe(200);
    const replayed = await page(handle, OUTSIDE_AGENT, { claims: spend });
    expect([replayed.status, replayed.code]).toEqual([401, "jwt_replay"]);
  });
});

describe("the canary test (M4-01)", () => {
  it("never shows a private field, ID or removed or closed item, and shows exactly the contract's fields", async () => {
    const C = (what: string) => `CANARY_${what}_${crypto.randomUUID().slice(0, 8)}`;
    const canaries: string[] = [];
    const mark = (what: string) => { const c = C(what); canaries.push(c); return c; };
    const id = await room();
    const task = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: mark("task_title"), instructions: mark("instructions"), acceptance_criteria: mark("criteria"), assignee: AGENT.id });
    expect(task.status, task.text).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/tasks/${task.body.id}/messages`, { body: mark("message") })).status).toBe(200);
    const closed = await api(OWNER, "POST", `/v1/workspaces/${id}/roles`, { title: mark("closed_title"), responsibilities: mark("closed_duties"), preset: "guest", publicly_claimable: true, policy_version: await version(id) });
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/roles/${closed.body.id}`, { policy_version: await version(id) })).status).toBe(200);
    const removed = await api(OWNER, "POST", `/v1/workspaces/${id}/outputs`, { title: mark("removed_output"), description: mark("removed_description") });
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/outputs/${removed.body.id}`)).status).toBe(200);
    const invited = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { kind: "person", role: "member", policy_version: await version(id) });
    // A public opening and a private one, so both shapes are checked. Only the claimable one's ID is shown.
    const open = await api(OWNER, "POST", `/v1/workspaces/${id}/roles`, { title: "Reviewer", responsibilities: "Read the survey", preset: "guest", publicly_claimable: true, policy_version: await version(id) });
    const invitedOnly = await api(OWNER, "POST", `/v1/workspaces/${id}/roles`, { title: "Diver", responsibilities: "Dive", preset: "member", policy_version: await version(id) });
    expect([open.status, invitedOnly.status]).toEqual([200, 200]);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/outputs`, { title: "Reef map", description: "The map" })).status).toBe(200);
    const handle = await publish(id);

    const ids = [id, OWNER.id, ADMIN.id, AGENT.id, ORG, task.body.id, closed.body.id, removed.body.id, invitedOnly.body.id];
    if (invited.body?.token) ids.push(invited.body.token);
    if (invited.body?.id) ids.push(invited.body.id);
    const responses = [await page(handle), await page(handle, STRANGER), await page(handle, OUTSIDE_AGENT), await explore(STRANGER), await explore(OUTSIDE_AGENT)];
    for (const response of responses) {
      expect(response.status, response.text).toBe(200);
      const headers = JSON.stringify([...response.headers.entries()]);
      for (const needle of [...canaries, ...ids]) {
        expect(response.text, needle).not.toContain(needle);
        expect(headers, needle).not.toContain(needle);
      }
    }
    const view = responses[0].body;
    expect(view.content.openings.map((o: any) => [o.title, o.id])).toEqual([["Reviewer", open.body.id], ["Diver", null]]);
    expect(view.content.outputs.map((o: any) => o.title)).toEqual(["Reef map"]);
    // The JSON's field names are exactly the contract's.
    const schema = JSON.parse(BINDINGS.TEST_PUBLIC_VIEW_SCHEMA);
    expect([...new Set(keyPaths(view))].sort()).toEqual([...new Set(schemaPaths(schema))].sort());
    const fromExplore = responses[3].body.workrooms.find((w: any) => w.handle === handle);
    expect(fromExplore).toEqual(view);
  });
});

/** Routes that read no assertion at all: an upload's bytes carry their upload's token instead. They still refuse it. */
const UNASSERTED = new Set(["PUT /v1/uploads/{ws}/{object}"]);

describe("the route-list test (M4-15)", () => {
  it("refuses the public assertion on every route but the room page", async () => {
    const id = await room();
    const handle = await publish(id);
    const routes: { path: string; method: string; operation: string }[] = JSON.parse(BINDINGS.TEST_API_ROUTES);
    expect(routes.length).toBeGreaterThan(100);
    const fill = (path: string) => path.replaceAll("{handle}", handle).replace(/\{(ws|workspace_id)\}/g, id).replace(/\{[a-z_]+\}/g, "x_1");
    const accepted: string[] = [];
    for (const route of routes) {
      const answer = await api("public", route.method, fill(route.path), {}, { on: true });
      if (answer.status >= 200 && answer.status < 300) accepted.push(route.operation);
      else if (UNASSERTED.has(`${route.method} ${route.path}`)) expect(answer.status, `${route.method} ${route.path}`).toBeGreaterThanOrEqual(400);
      else if (route.operation !== "getPublicWorkroom") expect([answer.status, answer.code], `${route.method} ${route.path}`).toEqual([401, "invalid_assertion"]);
    }
    expect(accepted).toEqual(["getPublicWorkroom"]);
    // Routes the contract doesn't list, internal ones included, refuse it too.
    for (const path of ["/v1/public/explore", "/v1/public/workrooms", "/v1/public", "/internal/public-page", "/internal/explore-entry", `/v1/workspaces/${id}/visibility`, "/v1/nope"]) {
      expect((await api("public", "GET", path, undefined, { on: true })).code, path).toBe("invalid_assertion");
    }
    // POST to the room page isn't the room page.
    expect((await api("public", "POST", `/v1/public/workrooms/${handle}`, {}, { on: true })).code).toBe("invalid_assertion");
  });
});

describe("Explore", () => {
  it("needs sign-in, and lists public rooms that aren't archived, newest first", async () => {
    const older = await room("Explore older");
    const olderHandle = await publish(older);
    const archived = await room("Explore archived");
    const archivedHandle = await publish(archived);
    expect((await api(OWNER, "POST", `/v1/workspaces/${archived}/archive`, { policy_version: await version(archived) })).status).toBe(200);
    await drain(archived);
    const privateRoom = await room("Explore private");
    const newer = await room("Explore newer");
    const newerHandle = await publish(newer);
    expect((await explore("public")).code).toBe("invalid_assertion");
    const seen = await explore(STRANGER);
    expect(seen.status, seen.text).toBe(200);
    const handles = seen.body.workrooms.map((w: any) => w.handle);
    expect(handles).toContain(olderHandle);
    expect(handles).toContain(newerHandle);
    expect(handles.indexOf(newerHandle)).toBeLessThan(handles.indexOf(olderHandle));
    expect(handles).not.toContain(archivedHandle);
    expect(seen.text).not.toContain("Explore private");
    expect(seen.text).not.toContain(privateRoom);
  });

  it("filters by topic and by an opening open now", async () => {
    const id = await room("Explore filtered");
    await api(OWNER, "PUT", `/v1/workspaces/${id}/topic`, { topic: "research" });
    const plain = await room("Explore plain");
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/roles`, { title: "Reviewer", responsibilities: "Read", preset: "guest", publicly_claimable: true, policy_version: await version(id) })).status).toBe(200);
    const handle = await publish(id);
    const plainHandle = await publish(plain);
    const topic = (await explore(STRANGER, "?topic=research")).body.workrooms.map((w: any) => w.handle);
    expect(topic).toContain(handle);
    expect(topic).not.toContain(plainHandle);
    const open = (await explore(STRANGER, "?open=true")).body.workrooms.map((w: any) => w.handle);
    expect(open).toContain(handle);
    expect(open).not.toContain(plainHandle);
    for (const bad of ["?topic=nonsense", "?open=yes", "?cursor=zz", "?cursor=00", "?q=reef", `?cursor=${"6".repeat(400)}`]) {
      expect((await explore(STRANGER, bad)).code, bad).toBe("invalid_argument");
    }
  });

  it("drops a candidate its room doesn't confirm, reads 20 candidates a page at most, and moves its cursor on", async () => {
    const id = await room("Explore after the fakes");
    const handle = await publish(id);
    const listed = await room("Explore stale");
    const staleHandle = await publish(listed);
    // The room went private, and the index hasn't been told yet.
    await inRoom(listed, (sql) => sql.exec("UPDATE workspace SET visibility = 'private'"));
    // 25 candidates newer than anything real: rooms that don't exist, and one that never answers.
    const future = Date.now() + 10_000_000;
    for (let n = 0; n < 25; n++) {
      const workspace = n === 0 ? "ws_hang_explore" : `ws_explore_fake_${n}`;
      const fake = `pub_${n.toString(16).padStart(32, "f")}`;
      await BINDINGS.DB.prepare("INSERT INTO public_workroom_index (workspace_id, public_handle, topic, has_open_opening, published_at, resolvable, listed, updated_seq) VALUES (?, ?, 'film', 0, ?, 1, 1, 1)").bind(workspace, fake, future - n).run();
    }
    try {
      const first = await explore(STRANGER, "?topic=film");
      expect(first.status, first.text).toBe(200);
      expect(first.body.workrooms).toEqual([]);
      expect(first.body.next_cursor).toMatch(/^[0-9a-f]+$/);
      expect(first.text).not.toContain("ws_explore_fake");
      const second = await explore(STRANGER, `?topic=film&cursor=${first.body.next_cursor}`);
      expect(second.body).toEqual({ workrooms: [], next_cursor: null });
      const everything: string[] = [];
      let cursor: string | null = null;
      for (let n = 0; n < 50; n++) {
        const next = await explore(STRANGER, cursor ? `?cursor=${cursor}` : "");
        expect(next.body.workrooms.length).toBeLessThanOrEqual(20);
        everything.push(...next.body.workrooms.map((w: any) => w.handle));
        cursor = next.body.next_cursor;
        if (!cursor) break;
      }
      expect(everything).toContain(handle);
      expect(everything).not.toContain(staleHandle);
      expect(new Set(everything).size).toBe(everything.length);
    } finally {
      await BINDINGS.DB.prepare("DELETE FROM public_workroom_index WHERE workspace_id LIKE 'ws_explore_fake_%' OR workspace_id = 'ws_hang_explore'").run();
    }
  });

  // M4 step 14: the cursor is sealed, so it says nothing about the handle it names and can't be changed or forged.
  it("seals its cursor, and refuses one changed, forged or of the old unsealed form", async () => {
    const future = Date.now() + 20_000_000;
    const fakes = Array.from({ length: 21 }, (_, n) => ({ ws: `ws_sealed_fake_${n}`, handle: `pub_${n.toString(16).padStart(32, "e")}`, at: future - n }));
    for (const fake of fakes) {
      await BINDINGS.DB.prepare("INSERT INTO public_workroom_index (workspace_id, public_handle, topic, has_open_opening, published_at, resolvable, listed, updated_seq) VALUES (?, ?, 'marketing', 0, ?, 1, 1, 1)").bind(fake.ws, fake.handle, fake.at).run();
    }
    try {
      const first = await explore(STRANGER, "?topic=marketing");
      const cursor: string = first.body.next_cursor;
      expect(cursor).toMatch(/^[0-9a-f]{1,200}$/);
      // The 20th candidate's handle and time, in any form, aren't in it.
      const last = fakes[19];
      const hex = (text: string) => [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
      for (const needle of [last.handle, hex(last.handle), String(last.at), hex(String(last.at))]) expect(cursor).not.toContain(needle);
      // It works, and the same page asked twice gives a different cursor for the same place.
      expect((await explore(STRANGER, `?topic=marketing&cursor=${cursor}`)).status).toBe(200);
      expect((await explore(STRANGER, "?topic=marketing")).body.next_cursor).not.toBe(cursor);
      const flipped = cursor.slice(0, -1) + (cursor.endsWith("0") ? "1" : "0");
      const unsealed = hex(`${last.at}.${last.handle}`);
      for (const bad of [flipped, cursor.slice(0, -2), unsealed, "ab".repeat(40)]) {
        expect((await explore(STRANGER, `?topic=marketing&cursor=${bad}`)).code, bad).toBe("invalid_argument");
      }
    } finally {
      await BINDINGS.DB.prepare("DELETE FROM public_workroom_index WHERE workspace_id LIKE 'ws_sealed_fake_%'").run();
    }
  });

  it("shows only its first page, and refuses every cursor, while the key is unset, empty or the wrong length", async () => {
    const future = Date.now() + 30_000_000;
    for (let n = 0; n < 21; n++) {
      await BINDINGS.DB.prepare("INSERT INTO public_workroom_index (workspace_id, public_handle, topic, has_open_opening, published_at, resolvable, listed, updated_seq) VALUES (?, ?, 'other', 0, ?, 1, 1, 1)").bind(`ws_nokey_fake_${n}`, `pub_${n.toString(16).padStart(32, "d")}`, future - n).run();
    }
    try {
      const sealed = (await explore(STRANGER, "?topic=other")).body.next_cursor;
      expect(sealed).toMatch(/^[0-9a-f]+$/);
      for (const cursorKey of ["unset", "empty", "short"] as const) {
        const first = await explore(STRANGER, "?topic=other", { cursorKey });
        expect(first.status, cursorKey).toBe(200);
        expect(first.body.next_cursor, cursorKey).toBeNull();
        const paged = await explore(STRANGER, `?topic=other&cursor=${sealed}`, { cursorKey });
        expect([paged.status, paged.code], cursorKey).toEqual([400, "invalid_argument"]);
      }
    } finally {
      await BINDINGS.DB.prepare("DELETE FROM public_workroom_index WHERE workspace_id LIKE 'ws_nokey_fake_%'").run();
    }
  });

  it("refuses a cursor over 200 characters, and one sealed under another key", async () => {
    // A value sealed exactly as the API seals a cursor, under this deployment's own key, but over 200 characters.
    const hexOf = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const ownKey = await crypto.subtle.importKey("raw", Uint8Array.from(BINDINGS.EXPLORE_CURSOR_KEY.match(/../g).map((h: string) => parseInt(h, 16))), "AES-GCM", false, ["encrypt"]);
    const longIv = crypto.getRandomValues(new Uint8Array(12));
    const longPlain = new TextEncoder().encode(`${Date.now()}.pub_${"c".repeat(32)}${"0".repeat(64)}`);
    const longSealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: longIv, additionalData: new TextEncoder().encode("podster-sealed:v1:explore-cursor") }, ownKey, longPlain));
    const tooLong = hexOf(longIv) + hexOf(longSealed);
    expect(tooLong.length).toBeGreaterThan(200);
    expect((await explore(STRANGER, `?cursor=${tooLong}`)).code).toBe("invalid_argument");
    // A well-formed cursor, sealed exactly as the API seals one, but under a key that isn't this deployment's.
    const otherKey = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const position = new TextEncoder().encode(`${Date.now()}.pub_${"c".repeat(32)}`);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("podster-sealed:v1:explore-cursor") }, otherKey, position));
    const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const forged = hex(iv) + hex(sealed);
    expect(forged.length).toBeLessThanOrEqual(200);
    expect((await explore(STRANGER, `?cursor=${forged}`)).code).toBe("invalid_argument");
  });

  it("is empty with public rooms off", async () => {
    const id = await room("Explore while off");
    await publish(id);
    expect((await explore(STRANGER, "", { on: false })).body).toEqual({ workrooms: [], next_cursor: null });
    // Off is checked first: a bad cursor or an unset key isn't read, or refused, while public rooms are off.
    for (const query of ["?cursor=zz", "?topic=nonsense"]) {
      const off = await explore(STRANGER, query, { on: false, cursorKey: "unset" });
      expect([off.status, off.body], query).toEqual([200, { workrooms: [], next_cursor: null }]);
    }
  });
});
