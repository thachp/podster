import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OWNER: Who = { id: "per_rm_owner", kind: "person", org: "org_rm", adminOrgs: ["org_rm"] };
const ADMIN: Who = { id: "per_rm_admin", kind: "person", org: "org_rm" };
const PERSON_MEMBER: Who = { id: "per_rm_member", kind: "person", org: "org_rm" };
const MEMBER: Who = { id: "agt_rm_member", org: "org_rm" };
const GUEST: Who = { id: "agt_rm_guest", org: "org_rm" };
const INVITED: Who = { id: "agt_rm_invited", org: "org_rm_other" };
const STRANGER: Who = { id: "agt_rm_stranger", org: "org_rm_x" };
const orgAdmin = (org: string): Who => ({ id: `per_rm_admin_${org}`, kind: "person", org, adminOrgs: [org] });

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
  if (method !== "GET") headers["idempotency-key"] = `rm-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [MEMBER, GUEST, INVITED, STRANGER]) {
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
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Files" })).body.id;
  // Adding a person through the API needs the gateway's word on their organization, which isn't under test here.
  await inRoom(id, (sql) => {
    for (const [who, role] of [[ADMIN, "admin"], [PERSON_MEMBER, "member"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at, join_generation) VALUES (?, 'person', ?, ?, ?, 0, 1)", who.id, who.org, role, OWNER.id);
  });
  for (const [who, role] of [[MEMBER, "member"], [GUEST, "guest"]] as const) {
    const r = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: who.org, role, policy_version: await version(id) });
    expect(r.status, `add ${who.id}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  // The member person gets the agent member's access, so they see the whole room and only their role keeps them from removing.
  await inRoom(id, (sql) => sql.exec("INSERT INTO access_grant (principal_id, tasks, artifacts, conversations, review, granted_by, updated_at) SELECT ?, tasks, artifacts, conversations, review, granted_by, updated_at FROM access_grant WHERE principal_id = ?", PERSON_MEMBER.id, MEMBER.id));
  const invited = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { role: "guest", invited_org_id: INVITED.org, policy_version: await version(id) });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const joined = await api(orgAdmin(INVITED.org), "POST", "/v1/invitations/accept", { token: invited.body.token, org_id: INVITED.org, agents: [INVITED.id] });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  return id;
}

/** A file that really arrived, in the state asked for. The scanner's route isn't what's under test, so this sets the state directly. */
async function file(id: string, state = "ready", name = "notes.txt", data: Uint8Array = TEXT) {
  const made = await api(OWNER, "POST", `/v1/workspaces/${id}/uploads`, { name, size: data.length, sha256: await sha256(data) });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const sent = await SELF.fetch(`https://api.internal${made.body.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${made.body.token}` }, body: data as any });
  expect(sent.status).toBe(200);
  await sent.text();
  await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET state = ? WHERE id = ?", state, made.body.id));
  return made.body.id as string;
}
const download = async (who: Who, id: string, object: string) =>
  SELF.fetch(`https://api.internal/v1/files/${id}/${object}`, { headers: { "x-podster-assertion": await assertion(who) } });
const refusal = async (res: Response) => ({ status: res.status, code: ((await res.json()) as any).error?.code });

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const row = (id: string, object: string): Promise<any> => inRoom(id, (sql) => sql.exec("SELECT * FROM stored_object WHERE id = ?", object).toArray()[0]) as Promise<any>;
const remove = (who: Who, id: string, object: string) => api(who, "POST", `/v1/workspaces/${id}/files/${object}/remove`);
const sweep = async (id: string) => {
  await inRoom(id, (sql) => sql.exec("UPDATE storage_sweep SET due_at = 0"));
  await runDurableObjectAlarm(stub(id));
};
const audits = (id: string, action: string): Promise<any[]> => inRoom(id, (sql) => sql.exec("SELECT * FROM audit_event WHERE action = ?", action).toArray()) as Promise<any[]>;

describe("removing a file", () => {
  it("keeps the record and hash, ends downloads, and deletes the bytes on the next sweep", async () => {
    const id = await room();
    const object = await file(id);
    const before = await row(id, object);
    const policy = await version(id);
    const removed = await remove(OWNER, id, object);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ id: object, state: "removed", size: TEXT.length, sha256: before.sha256, removed_by: OWNER.id });
    expect(typeof removed.body.removed_at).toBe("number");
    // A file's removal changes nobody's access, so an admin's open form still holds.
    expect(await version(id)).toBe(policy);
    const after = await row(id, object);
    expect(after).toMatchObject({ state: "removed", removed_by_kind: "person", removed_from: "ready", name: before.name, sha256: before.sha256, uploaded_by: before.uploaded_by });
    expect(await refusal(await download(OWNER, id, object))).toEqual({ status: 410, code: "file_removed" });
    const read = await api(MEMBER, "GET", `/v1/workspaces/${id}/files/${object}`);
    expect(read.body).toMatchObject({ state: "removed", download_path: null, removed_by: OWNER.id });
    // The removal made the sweep due at once, so the room's own alarm may already have run it.
    await runDurableObjectAlarm(stub(id));
    expect(await BINDINGS.ASSETS.head(before.object_key)).toBeNull();
    const [audit] = await audits(id, "object.removed");
    expect(audit).toMatchObject({ actor_id: OWNER.id, target_id: object });
    expect(audit.prior_json + audit.new_json).not.toContain("notes");
    const events: any[] = await inRoom(id, (sql) => sql.exec("SELECT * FROM event WHERE type = 'object.removed'").toArray()) as any[];
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("notes.txt");
    expect(JSON.stringify(events)).not.toContain(before.object_key);
  });

  it("lets a human admin remove, and nobody else, answering someone who can't see it as if it didn't exist", async () => {
    const id = await room();
    const object = await file(id);
    expect((await remove(PERSON_MEMBER, id, object)).code).toBe("not_allowed");
    expect((await remove(MEMBER, id, object)).code).toBe("not_allowed");
    expect(await remove(GUEST, id, object)).toMatchObject({ status: 404, code: "file_not_found" });
    expect(await remove(INVITED, id, object)).toMatchObject({ status: 404, code: "file_not_found" });
    expect(await remove(STRANGER, id, object)).toMatchObject({ status: 404, code: "workspace_not_found" });
    expect(await remove(GUEST, id, "obj_nothing")).toMatchObject({ status: 404, code: "file_not_found" });
    expect((await row(id, object)).state).toBe("ready");
    const done = await remove(ADMIN, id, object);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await row(id, object)).removed_by).toBe(ADMIN.id);
  });

  it("doesn't let an agent stored as an admin remove, since it counts as a guest and sees no file", async () => {
    const id = await room();
    const object = await file(id);
    await inRoom(id, (sql) => sql.exec("UPDATE member SET role = 'admin' WHERE principal_id = ?", MEMBER.id));
    expect(await remove(MEMBER, id, object)).toMatchObject({ status: 404, code: "file_not_found" });
    expect((await row(id, object)).state).toBe("ready");
  });

  it("changes nothing the second time", async () => {
    const id = await room();
    const object = await file(id);
    const first = await remove(OWNER, id, object);
    const second = await remove(ADMIN, id, object);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await audits(id, "object.removed")).toHaveLength(1);
  });

  it("works from every state, and ends an unfinished upload with it", async () => {
    const id = await room();
    for (const state of ["scanning", "blocked", "failed"]) {
      const object = await file(id, state);
      expect((await remove(OWNER, id, object)).body.state).toBe("removed");
      expect((await row(id, object)).removed_from).toBe(state);
    }
    const made = await api(OWNER, "POST", `/v1/workspaces/${id}/uploads`, { name: "late.txt", size: TEXT.length, sha256: await sha256(TEXT) });
    expect((await remove(OWNER, id, made.body.id)).body.state).toBe("removed");
    const sent = await SELF.fetch(`https://api.internal${made.body.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${made.body.token}` }, body: TEXT as any });
    expect(sent.status).toBe(404);
    await sent.text();
    expect(await BINDINGS.ASSETS.list({ prefix: `rooms/${id}/objects/${made.body.id}/` })).toMatchObject({ objects: [] });
  });

  it("works in an archived room (decision 93), for the same people only", async () => {
    const id = await room();
    const object = await file(id);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    expect((await remove(PERSON_MEMBER, id, object)).code).toBe("not_allowed");
    const done = await remove(ADMIN, id, object);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await row(id, object)).state).toBe("removed");
  });

  it("gives the space back at once", async () => {
    const id = await room();
    const object = await file(id);
    // The rest of the room's 5 GB, filled with records only, so a byte more doesn't fit.
    await inRoom(id, (sql) => sql.exec("INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, created_at, upload_expires_at) VALUES ('obj_filler', 'f', ?, ?, 'ready', '', ?, 0, 0)", 5_000_000_000 - TEXT.length, "0".repeat(64), OWNER.id));
    const tiny = new Uint8Array([1]);
    const refused = await api(OWNER, "POST", `/v1/workspaces/${id}/uploads`, { name: "one.bin", size: 1, sha256: await sha256(tiny) });
    expect(refused.code).toBe("room_quota_exceeded");
    expect((await remove(OWNER, id, object)).status).toBe(200);
    const fits = await api(OWNER, "POST", `/v1/workspaces/${id}/uploads`, { name: "one.txt", size: 1, sha256: await sha256(tiny) });
    expect(fits.status, JSON.stringify(fits.body)).toBe(200);
  });
});

describe("the room's sweep", () => {
  it("plans one sweep an hour after migrating a room that holds files, and none for a room that doesn't", async () => {
    const undoRemoval = (id: string) => runInDurableObject(stub(id), (_: any, state: any) => {
      state.storage.sql.exec("DROP TABLE storage_sweep");
      state.storage.sql.exec("DROP INDEX stored_object_abandoned");
      for (const column of ["removed_at", "removed_by", "removed_by_kind", "removed_from"]) state.storage.sql.exec(`ALTER TABLE stored_object DROP COLUMN ${column}`);
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
    });
    const due = async (id: string) => ((await inRoom(id, (sql) => sql.exec("SELECT due_at FROM storage_sweep").toArray()[0])) as any).due_at;
    const withFiles = await room();
    await file(withFiles);
    const empty = await room();
    await undoRemoval(withFiles);
    await undoRemoval(empty);
    const before = Date.now();
    expect((await api(OWNER, "GET", `/v1/workspaces/${withFiles}`)).status).toBe(200);
    expect((await api(OWNER, "GET", `/v1/workspaces/${empty}`)).status).toBe(200);
    expect(await due(withFiles)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + 60 * 60 * 1000);
    expect(await due(withFiles)).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
    expect(await due(empty)).toBeNull();
  });

  it("leaves a room that hasn't migrated yet to its next request, and its alarm still runs", async () => {
    const id = await room();
    const object = await file(id);
    await runInDurableObject(stub(id), (_: any, state: any) => {
      state.storage.sql.exec("DROP TABLE storage_sweep");
      state.storage.sql.exec("DROP INDEX stored_object_abandoned");
      for (const column of ["removed_at", "removed_by", "removed_by_kind", "removed_from"]) state.storage.sql.exec(`ALTER TABLE stored_object DROP COLUMN ${column}`);
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
    });
    await runDurableObjectAlarm(stub(id));
    expect((await remove(OWNER, id, object)).body.state).toBe("removed");
  });

  it("keeps every file's bytes, and keeps fresh bytes nobody refers to until they're an hour old", async () => {
    const id = await room();
    const object = await file(id);
    const kept = (await row(id, object)).object_key;
    const stray = `rooms/${id}/objects/obj_stray/attempt`;
    await BINDINGS.ASSETS.put(stray, new Uint8Array([1, 2, 3]));
    const strayAt = (await BINDINGS.ASSETS.head(stray)).uploaded.getTime();
    await sweep(id);
    expect(await BINDINGS.ASSETS.head(kept)).not.toBeNull();
    expect(await BINDINGS.ASSETS.head(stray)).not.toBeNull();
    const due: any = await inRoom(id, (sql) => sql.exec("SELECT due_at, cursor FROM storage_sweep").toArray()[0]);
    expect(due).toEqual({ due_at: strayAt + 60 * 60 * 1000, cursor: null });
    expect((await download(OWNER, id, object)).status).toBe(200);
  });

  it("never lists or deletes outside its own room, even a room whose ID starts the same", async () => {
    const id = await room();
    const object = await file(id);
    const other = `rooms/${id}x/objects/${object}/attempt`;
    await BINDINGS.ASSETS.put(other, new Uint8Array([1]));
    await remove(OWNER, id, object);
    await sweep(id);
    expect(await BINDINGS.ASSETS.head(other)).not.toBeNull();
    await BINDINGS.ASSETS.delete(other);
  });

  it("clears an upload an hour after its grant ends, and not before", async () => {
    const id = await room();
    const made = await api(OWNER, "POST", `/v1/workspaces/${id}/uploads`, { name: "never.txt", size: 3, sha256: await sha256(new Uint8Array([1, 2, 3])) });
    const now = Date.now();
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET upload_expires_at = ? WHERE id = ?", now - 60 * 60 * 1000 + 60_000, made.body.id));
    await runDurableObjectAlarm(stub(id));
    expect(await row(id, made.body.id)).toBeDefined();
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET upload_expires_at = ? WHERE id = ?", now - 60 * 60 * 1000 - 1, made.body.id));
    const policy = await version(id);
    await runDurableObjectAlarm(stub(id));
    expect(await row(id, made.body.id)).toBeUndefined();
    expect(await version(id)).toBe(policy);
    const [audit] = await audits(id, "object.upload_abandoned");
    expect(audit).toMatchObject({ actor_id: "podster", actor_kind: "system", target_id: made.body.id });
  });

  it("asks for a sweep an hour after an upload attempt begins", async () => {
    const id = await room();
    await inRoom(id, (sql) => sql.exec("UPDATE storage_sweep SET due_at = NULL"));
    const before = Date.now();
    await file(id);
    const { due_at }: any = await inRoom(id, (sql) => sql.exec("SELECT due_at FROM storage_sweep").toArray()[0]);
    expect(due_at).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(due_at).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });
});
