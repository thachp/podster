import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OWNER: Who = { id: "per_cu_owner", kind: "person", org: "org_cu", adminOrgs: ["org_cu"] };
const MEMBER: Who = { id: "agt_cu_member", org: "org_cu" };
const GUEST: Who = { id: "agt_cu_guest", org: "org_cu" };
const INVITED: Who = { id: "agt_cu_invited", org: "org_cu_other" };
const PEER: Who = { id: "agt_cu_peer", org: "org_cu" };
const NOTIFIED: Who = { id: "agt_cu_notified", org: "org_cu" };
const STRANGER: Who = { id: "agt_cu_stranger", org: "org_cu_x" };
const orgAdmin = (org: string): Who => ({ id: `per_cu_admin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }) })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `cu-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [MEMBER, GUEST, PEER, NOTIFIED, INVITED, STRANGER]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
const encoder = new TextEncoder();
const sha256 = async (data: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
const TEXT = encoder.encode("<script>alert(1)</script>\n".repeat(40));
const inRoom = (id: string, fn: (sql: any) => unknown) => runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)), (_: any, state: any) => fn(state.storage.sql));

async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Cursors" })).body.id;
  for (const [who, role] of [[MEMBER, "member"], [GUEST, "guest"], [PEER, "guest"]] as const) {
    const r = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: who.org, role, policy_version: await version(id) });
    expect(r.status, `add ${who.id}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  const invited = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { role: "guest", invited_org_id: INVITED.org, policy_version: await version(id) });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const joined = await api(orgAdmin(INVITED.org), "POST", "/v1/invitations/accept", { token: invited.body.token, org_id: INVITED.org, agents: [INVITED.id] });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  return id;
}


// Cursors on lists someone may see only part of: each is the ID of the last row returned, so a gap between pages says nothing
// about how many rows the caller can't see. A number, the old kind of cursor, is refused like any cursor that names no row.

/** Tasks straight into the room, alternating between one for GUEST and one it can't see, so the hidden ones sit between. */
async function seedTasks(id: string, count: number) {
  await inRoom(id, (sql) => {
    for (let i = 0; i < count; i++) {
      for (const [who, tag] of [[GUEST.id, "g"], [PEER.id, "h"]] as const) {
        sql.exec("INSERT INTO task (id, title, instructions, requester_id, assignee_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 't', 'i', ?, ?, ?, 'open', 1, 0, 0)",
          `tsk_cu${tag}${String(i).padStart(3, "0")}`, OWNER.id, who, OWNER.id);
      }
    }
  });
}
const hiddenTasks = (id: string) => inRoom(id, (sql) => (sql.exec("SELECT id FROM task WHERE assignee_id = ?", PEER.id).toArray() as any[]).map((row) => row.id as string));
const positions = (id: string) => inRoom(id, (sql) => (sql.exec("SELECT seq FROM task").toArray() as any[]).map((row) => String(row.seq)));

async function pages(who: Who, path: string, key: string) {
  const seen: any[] = [];
  const cursors: unknown[] = [];
  let cursor: unknown = undefined;
  for (let i = 0; i < 10; i++) {
    const res = await api(who, "GET", `${path}${path.includes("?") ? "&" : "?"}${cursor === undefined ? "" : `cursor=${encodeURIComponent(String(cursor))}`}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    seen.push(...res.body[key]);
    cursor = res.body.next_cursor;
    if (cursor === null || cursor === undefined) return { seen, cursors };
    cursors.push(cursor);
  }
  throw new Error("didn't end");
}

describe("the task list's cursor", () => {
  it("is the ID of the last task returned, so a narrowed caller learns nothing of the tasks between", async () => {
    const id = await room();
    await seedTasks(id, 60);
    const { seen, cursors } = await pages(GUEST, `/v1/workspaces/${id}/tasks`, "tasks");
    expect(seen.map((t) => t.id)).toEqual(Array.from({ length: 60 }, (_, i) => `tsk_cug${String(i).padStart(3, "0")}`));
    expect(cursors).toEqual(["tsk_cug049"]);
    const hidden = await hiddenTasks(id);
    const places = await positions(id);
    for (const cursor of cursors) {
      expect(typeof cursor).toBe("string");
      expect(hidden).not.toContain(cursor);
      expect(places).not.toContain(cursor);
    }
  });

  it("pages newest first from an ID too", async () => {
    const id = await room();
    await seedTasks(id, 60);
    const { seen, cursors } = await pages(GUEST, `/v1/workspaces/${id}/tasks?order=newest`, "tasks");
    expect(seen.map((t) => t.id)).toEqual(Array.from({ length: 60 }, (_, i) => `tsk_cug${String(59 - i).padStart(3, "0")}`));
    expect(cursors).toEqual(["tsk_cug010"]);
  });

  it("answers a cursor that isn't one of the room's tasks as invalid, the same whether the task exists elsewhere or not", async () => {
    const id = await room();
    await seedTasks(id, 1);
    const seq = await inRoom(id, (sql) => sql.exec("SELECT seq FROM task WHERE id = 'tsk_cug000'").one().seq as number);
    for (const cursor of ["tsk_nothing", "bad id!", "-1", "0", String(seq)]) {
      expect((await api(GUEST, "GET", `/v1/workspaces/${id}/tasks?cursor=${encodeURIComponent(cursor)}`)).code, cursor).toBe("invalid_argument");
    }
  });

  it("gives an organization's admin overseeing its agent the same kind of cursor", async () => {
    const id = await room();
    await seedTasks(id, 0);
    await inRoom(id, (sql) => {
      for (let i = 0; i < 55; i++) {
        for (const [who, tag] of [[INVITED.id, "i"], [GUEST.id, "g"]] as const) {
          sql.exec("INSERT INTO task (id, title, instructions, requester_id, assignee_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 't', 'i', ?, ?, ?, 'open', 1, 0, 0)",
            `tsk_cu${tag}${String(i).padStart(3, "0")}`, OWNER.id, who, OWNER.id);
        }
      }
    });
    const { seen, cursors } = await pages(orgAdmin(INVITED.org), `/v1/workspaces/${id}/agents/${INVITED.id}/tasks`, "tasks");
    expect(seen.length).toBe(55);
    expect(cursors).toEqual(["tsk_cui049"]);
  });
});

describe("the file list's cursor", () => {
  it("is the ID of the last file returned, never a position", async () => {
    const id = await room();
    const t = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Read", instructions: "x", assignee: GUEST.id });
    await inRoom(id, (sql) => {
      for (let i = 0; i < 60; i++) {
        for (const tag of ["g", "h"]) {
          const object = `obj_cu${tag}${String(i).padStart(3, "0")}`;
          sql.exec("INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, created_at, upload_expires_at) VALUES (?, 'n.txt', 1, ?, 'ready', 'x', ?, 0, 0)", object, "a".repeat(64), OWNER.id);
          if (tag === "g") sql.exec("INSERT INTO asset_link (task_id, object_id, linked_by, linked_at) VALUES (?, ?, ?, 0)", t.body.id, object, OWNER.id);
        }
      }
    });
    const { seen, cursors } = await pages(GUEST, `/v1/workspaces/${id}/files`, "files");
    expect(seen.map((f) => f.id)).toEqual(Array.from({ length: 60 }, (_, i) => `obj_cug${String(i).padStart(3, "0")}`));
    expect(cursors).toEqual(["obj_cug049"]);
    const rowids = await inRoom(id, (sql) => (sql.exec("SELECT rowid AS r FROM stored_object").toArray() as any[]).map((row) => String(row.r)));
    expect(rowids).not.toContain(cursors[0]);
    // A position, the old kind of cursor, names no file, and neither does an ID that isn't one here.
    const rowid = await inRoom(id, (sql) => sql.exec("SELECT rowid AS r FROM stored_object WHERE id = 'obj_cug058'").one().r as number);
    for (const cursor of [String(rowid), "obj_nothing"]) expect((await api(GUEST, "GET", `/v1/workspaces/${id}/files?cursor=${cursor}`)).code, cursor).toBe("invalid_argument");
  });
});

describe("a task thread's cursor", () => {
  /** A thread on GUEST's task, with messages on a task it can't see sent between, so the room's own numbering has gaps. */
  async function thread(count: number) {
    const id = await room();
    const make = async (assignee: string) => (await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Talk", instructions: "x", assignee })).body.id as string;
    const mine = await make(GUEST.id);
    const hidden = await make(PEER.id);
    for (let i = 0; i < count; i++) {
      expect((await api(OWNER, "POST", `/v1/workspaces/${id}/tasks/${mine}/messages`, { body: `m${i}` })).status).toBe(200);
      expect((await api(OWNER, "POST", `/v1/workspaces/${id}/tasks/${hidden}/messages`, { body: `h${i}` })).status).toBe(200);
    }
    return { id, mine, hidden, path: `/v1/workspaces/${id}/tasks/${mine}/messages` };
  }

  it("pages by the last message's ID, and no message or history entry says where it sits in the room", async () => {
    const { id, mine, path } = await thread(55);
    const first = await api(GUEST, "GET", path);
    expect(first.body.messages.map((m: any) => m.body)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`));
    const next = await api(GUEST, "GET", `${path}?after=${first.body.messages.at(-1).id}`);
    expect(next.body.messages.map((m: any) => m.body)).toEqual(["m50", "m51", "m52", "m53", "m54"]);
    for (const message of [...first.body.messages, ...next.body.messages]) expect(Object.keys(message).sort()).toEqual(["body", "created_at", "external", "from", "id"]);
    const read = await api(GUEST, "GET", `/v1/workspaces/${id}/tasks/${mine}`);
    expect(read.status).toBe(200);
    for (const message of read.body.messages) expect(message).not.toHaveProperty("seq");
    expect(read.body.history.length).toBeGreaterThan(0);
    for (const entry of read.body.history) expect(entry).not.toHaveProperty("seq");
  });

  it("refuses a cursor that isn't a message on this task: another task's, a position, or nothing", async () => {
    const { id, hidden, path } = await thread(2);
    const theirs = await inRoom(id, (sql) => sql.exec("SELECT id, seq FROM message WHERE task_id = ? ORDER BY seq LIMIT 1", hidden).one() as any);
    for (const after of [theirs.id, String(theirs.seq), "0", "msg_nothing"]) {
      expect((await api(GUEST, "GET", `${path}?after=${encodeURIComponent(after)}`)).code, after).toBe("invalid_argument");
    }
    expect((await api(GUEST, "GET", `${path}?after=`)).body.messages.length).toBe(2);
  });

  it("pages the same way for an organization's admin overseeing its agent", async () => {
    const id = await room();
    const task = (await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Talk", instructions: "x", assignee: INVITED.id })).body.id as string;
    for (let i = 0; i < 52; i++) expect((await api(OWNER, "POST", `/v1/workspaces/${id}/tasks/${task}/messages`, { body: `m${i}` })).status).toBe(200);
    const path = `/v1/workspaces/${id}/agents/${INVITED.id}/tasks/${task}/messages`;
    const first = await api(orgAdmin(INVITED.org), "GET", path);
    expect(first.body.messages.length).toBe(50);
    const next = await api(orgAdmin(INVITED.org), "GET", `${path}?after=${first.body.messages.at(-1).id}`);
    expect(next.body.messages.map((m: any) => m.body)).toEqual(["m50", "m51"]);
  });
});
