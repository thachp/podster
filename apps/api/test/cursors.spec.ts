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

  it("answers a hidden task's ID exactly as it answers one that names nothing, so a cursor can't confirm it exists", async () => {
    const id = await room();
    await seedTasks(id, 3);
    const unknown = await api(GUEST, "GET", `/v1/workspaces/${id}/tasks?cursor=tsk_nothing`);
    expect([unknown.status, unknown.code]).toEqual([400, "invalid_argument"]);
    for (const order of ["", "&order=newest"]) {
      const hidden = await api(GUEST, "GET", `/v1/workspaces/${id}/tasks?cursor=tsk_cuh001${order}`);
      expect([hidden.status, hidden.body], order).toEqual([unknown.status, unknown.body]);
    }
    // Whoever can see it pages from it as from any other.
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/tasks?cursor=tsk_cuh001`)).body.tasks.map((t: any) => t.id)).toEqual(["tsk_cug002", "tsk_cuh002"]);
  });

  it("reads on past rows it drops, ending neither early nor never, and never names a dropped row", async () => {
    // No real row is dropped after the narrowed query, so a test-only table drops these, more than two batches in a row.
    const id = await room();
    await seedTasks(id, 130);
    const dropped = Array.from({ length: 120 }, (_, i) => `tsk_cug${String(i + 5).padStart(3, "0")}`);
    await inRoom(id, (sql) => {
      sql.exec("CREATE TABLE test_hide_from_lists (id TEXT PRIMARY KEY)");
      for (const task of dropped) sql.exec("INSERT INTO test_hide_from_lists (id) VALUES (?)", task);
    });
    const { seen, cursors } = await pages(GUEST, `/v1/workspaces/${id}/tasks`, "tasks");
    const kept = Array.from({ length: 130 }, (_, i) => `tsk_cug${String(i).padStart(3, "0")}`).filter((task) => !dropped.includes(task));
    expect(seen.map((t) => t.id)).toEqual(kept);
    expect(cursors).toEqual([]);
    // A page that would end on dropped rows reads on to a row it can return.
    await inRoom(id, (sql) => sql.exec("DELETE FROM test_hide_from_lists WHERE id IN ('tsk_cug100', 'tsk_cug101')"));
    const again = await pages(GUEST, `/v1/workspaces/${id}/tasks`, "tasks");
    expect(again.seen.length).toBe(12);
    expect(again.seen.map((t) => t.id)).toContain("tsk_cug100");
    for (const cursor of again.cursors) expect(dropped.filter((t) => t !== "tsk_cug100" && t !== "tsk_cug101")).not.toContain(cursor);
    // Everything dropped ends the list at once, with no cursor.
    await inRoom(id, (sql) => sql.exec("INSERT INTO test_hide_from_lists (id) SELECT id FROM task WHERE id NOT IN (SELECT id FROM test_hide_from_lists)"));
    expect((await api(GUEST, "GET", `/v1/workspaces/${id}/tasks`)).body).toEqual({ tasks: [], next_cursor: null });
  });

  it("puts the cursor on the last row returned when a page fills before rows it drops", async () => {
    const id = await room();
    await seedTasks(id, 60);
    // The page fills at tsk_cug049, and the next row it would scan is dropped, so the cursor stays on the last one returned.
    await inRoom(id, (sql) => {
      sql.exec("CREATE TABLE test_hide_from_lists (id TEXT PRIMARY KEY)");
      for (let i = 50; i < 55; i++) sql.exec("INSERT INTO test_hide_from_lists (id) VALUES (?)", `tsk_cug0${i}`);
    });
    const first = await api(GUEST, "GET", `/v1/workspaces/${id}/tasks`);
    expect(first.body.tasks.length).toBe(50);
    expect(first.body.next_cursor).toBe("tsk_cug049");
    const next = await api(GUEST, "GET", `/v1/workspaces/${id}/tasks?cursor=tsk_cug049`);
    expect(next.body.tasks.map((t: any) => t.id)).toEqual(["tsk_cug055", "tsk_cug056", "tsk_cug057", "tsk_cug058", "tsk_cug059"]);
    expect(next.body.next_cursor).toBeNull();
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

describe("the file list's cursor, for a file the caller isn't shown", () => {
  it("answers a hidden file's, a submission file's or an unfinished upload's ID exactly as one that names nothing", async () => {
    const id = await room();
    const t = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Read", instructions: "x", assignee: GUEST.id });
    await inRoom(id, (sql) => {
      const add = (object: string, state: string, forTask: string | null) =>
        sql.exec("INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, created_at, upload_expires_at, for_task) VALUES (?, 'n.txt', 1, ?, ?, 'x', ?, 0, 0, ?)", object, "a".repeat(64), state, OWNER.id, forTask);
      add("obj_cushown", "ready", null);
      add("obj_cuhidden", "ready", null);
      add("obj_cusubmission", "ready", t.body.id);
      add("obj_cuuploading", "uploading", null);
      sql.exec("INSERT INTO asset_link (task_id, object_id, linked_by, linked_at) VALUES (?, 'obj_cushown', ?, 0)", t.body.id, OWNER.id);
    });
    const unknown = await api(GUEST, "GET", `/v1/workspaces/${id}/files?cursor=obj_nothing`);
    expect([unknown.status, unknown.code]).toEqual([400, "invalid_argument"]);
    for (const object of ["obj_cuhidden", "obj_cusubmission", "obj_cuuploading"]) {
      const answer = await api(GUEST, "GET", `/v1/workspaces/${id}/files?cursor=${object}`);
      expect([answer.status, answer.body], object).toEqual([unknown.status, unknown.body]);
    }
    // A submission file and an unfinished upload aren't in the list for anyone, so they resume it for nobody.
    for (const object of ["obj_cusubmission", "obj_cuuploading"]) expect((await api(OWNER, "GET", `/v1/workspaces/${id}/files?cursor=${object}`)).code, object).toBe("invalid_argument");
    expect((await api(GUEST, "GET", `/v1/workspaces/${id}/files?cursor=obj_cushown`)).status).toBe(200);
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/files?cursor=obj_cuhidden`)).status).toBe(200);
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
    for (const message of [...first.body.messages, ...next.body.messages]) expect(Object.keys(message).sort()).toEqual(["body", "created_at", "external", "from", "id", "origin"]);
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
