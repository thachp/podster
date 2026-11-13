import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet } from "./alarm.ts";

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OWNER: Who = { id: "per_dl_owner", kind: "person", org: "org_dl", adminOrgs: ["org_dl"] };
const MEMBER: Who = { id: "agt_dl_member", org: "org_dl" };
const GUEST: Who = { id: "agt_dl_guest", org: "org_dl" };
const INVITED: Who = { id: "agt_dl_invited", org: "org_dl_other" };
const STRANGER: Who = { id: "agt_dl_stranger", org: "org_dl_x" };
const orgAdmin = (org: string): Who => ({ id: `per_dl_admin_${org}`, kind: "person", org, adminOrgs: [org] });

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
  if (method !== "GET") headers["idempotency-key"] = `dl-key-${++counter}`;
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

/** Every room a test makes, quieted after it so that no alarm of it runs into the next test. */
const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)));
});

async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Files" })).body.id;
  madeRooms.push(id);
  for (const [who, role] of [[MEMBER, "member"], [GUEST, "guest"]] as const) {
    const r = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: who.org, role, policy_version: await version(id) });
    expect(r.status, `add ${who.id}: ${JSON.stringify(r.body)}`).toBe(200);
  }
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

describe("downloading a file", () => {
  it("gives whoever sees the whole room the exact bytes, as an attachment nothing will render", async () => {
    const id = await room();
    const object = await file(id);
    for (const who of [OWNER, MEMBER]) {
      const res = await download(who, id, object);
      expect(res.status, who.id).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(`attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      expect(res.headers.get("content-length")).toBe(String(TEXT.length));
      expect(res.headers.get("accept-ranges")).toBeNull();
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(TEXT);
    }
  });

  it("only ever serves a ready file, and an unknown state counts as no", async () => {
    const id = await room();
    for (const state of ["uploading", "scanning", "blocked", "failed", "READY", ""]) {
      const object = await file(id, state);
      expect(await refusal(await download(OWNER, id, object)), state).toEqual({ status: 409, code: "file_not_available" });
    }
    // A removed file says so, since that's what it will stay.
    expect(await refusal(await download(OWNER, id, await file(id, "removed")))).toEqual({ status: 410, code: "file_removed" });
  });

  it("shows a file a room member can't have yet, with no path to it", async () => {
    const id = await room();
    const object = await file(id, "blocked");
    const seen = await api(MEMBER, "GET", `/v1/workspaces/${id}/files/${object}`);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ id: object, name: "notes.txt", state: "blocked", download_path: null });
    expect(JSON.stringify(seen.body)).not.toContain("rooms/");
  });

  it("names the path once it can be downloaded, and that path is what downloads", async () => {
    const id = await room();
    const object = await file(id);
    const seen = await api(MEMBER, "GET", `/v1/workspaces/${id}/files/${object}`);
    expect(seen.body.download_path).toBe(`/v1/files/${id}/${object}`);
    expect(seen.body.sha256).toBe(await sha256(TEXT));
    expect(JSON.stringify(seen.body)).not.toContain("rooms/");
  });

  it("hides a file from a guest not linked to it, as if it didn't exist, even when ready", async () => {
    const id = await room();
    const object = await file(id);
    expect(await refusal(await download(GUEST, id, object))).toEqual({ status: 404, code: "file_not_found" });
    expect(await refusal(await download(GUEST, id, "obj_unknown"))).toEqual({ status: 404, code: "file_not_found" });
    const read = await api(GUEST, "GET", `/v1/workspaces/${id}/files/${object}`);
    expect([read.status, read.code]).toEqual([404, "file_not_found"]);
  });

  it("gives someone outside the room the room's one answer", async () => {
    const id = await room();
    const object = await file(id);
    expect(await refusal(await download(STRANGER, id, object))).toEqual({ status: 404, code: "workspace_not_found" });
    expect(await refusal(await download(orgAdmin("org_dl_other"), id, object))).toEqual({ status: 404, code: "workspace_not_found" });
  });

  it("answers a malformed ID the room's usual way, checking the caller first", async () => {
    const id = await room();
    for (const bad of ["x".repeat(200), "obj!1"]) {
      expect(await refusal(await download(STRANGER, id, bad)), bad).toEqual({ status: 404, code: "workspace_not_found" });
      expect(await refusal(await download(MEMBER, id, bad)), bad).toEqual({ status: 404, code: "file_not_found" });
    }
    for (const who of [STRANGER, MEMBER]) expect(await refusal(await download(who, "x".repeat(200), "obj_1"))).toEqual({ status: 404, code: "workspace_not_found" });
  });

  it("checks on every use, so removal from the room ends the next download", async () => {
    const id = await room();
    const object = await file(id);
    expect((await download(MEMBER, id, object)).status).toBe(200);
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${MEMBER.id}`, { policy_version: await version(id) })).status).toBe(200);
    const after = await download(MEMBER, id, object);
    expect(after.headers.get("content-disposition")).toBeNull();
    expect(await refusal(after)).toEqual({ status: 403, code: "access_revoked" });
    const read = await api(MEMBER, "GET", `/v1/workspaces/${id}/files/${object}`);
    expect({ status: read.status, code: read.body.error?.code }).toEqual({ status: 403, code: "access_revoked" });
  });

  it("stops at a file's state on the very next use", async () => {
    const id = await room();
    const object = await file(id);
    expect((await download(OWNER, id, object)).status).toBe(200);
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET state = 'blocked' WHERE id = ?", object));
    expect((await refusal(await download(OWNER, id, object))).code).toBe("file_not_available");
  });

  it("keeps working in an archived room", async () => {
    const id = await room();
    const object = await file(id);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    expect((await download(MEMBER, id, object)).status).toBe(200);
  });

  it("refuses without a verified caller, before anything else", async () => {
    const id = await room();
    const object = await file(id);
    const res = await SELF.fetch(`https://api.internal/v1/files/${id}/${object}`);
    expect((await refusal(res)).status).toBe(401);
  });

  it("won't serve bytes that aren't the ones scanned, or that have gone", async () => {
    const id = await room();
    const object = await file(id);
    const saved: any = await inRoom(id, (sql) => sql.exec("SELECT object_key FROM stored_object WHERE id = ?", object).toArray()[0]);
    await BINDINGS.ASSETS.put(saved.object_key, new Uint8Array(TEXT.length), { sha256: await sha256(new Uint8Array(TEXT.length)) });
    expect(await refusal(await download(OWNER, id, object))).toEqual({ status: 409, code: "file_not_available" });
    await BINDINGS.ASSETS.delete(saved.object_key);
    expect(await refusal(await download(OWNER, id, object))).toEqual({ status: 409, code: "file_not_available" });
  });

  it("can't name a key through any client path", async () => {
    const id = await room();
    const object = await file(id);
    const saved: any = await inRoom(id, (sql) => sql.exec("SELECT object_key FROM stored_object WHERE id = ?", object).toArray()[0]);
    for (const path of [`/internal/download`, `/v1/workspaces/${id}/internal/download`, `/v1/workspaces/${id}/files/${object}/download`]) {
      const res = await api(OWNER, "POST", path, { id: object });
      expect(JSON.stringify(res.body), path).not.toContain(saved.object_key);
    }
  });

  it("keeps a hostile name from changing what the header says", async () => {
    const id = await room();
    const object = await file(id, "ready", 'a"; filename=evil.html é.txt');
    const res = await download(OWNER, id, object);
    expect(res.status).toBe(200);
    const header = res.headers.get("content-disposition")!;
    expect(header).toMatch(/^attachment; filename="[\w. -]+"; filename\*=UTF-8''[\w.%-]+$/);
    expect(header).not.toContain("evil.html\"");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("serves a stored type it doesn't recognize as plain bytes", async () => {
    const id = await room();
    const object = await file(id);
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET media_type = 'text/html' WHERE id = ?", object));
    expect((await download(OWNER, id, object)).headers.get("content-type")).toBe("application/octet-stream");
  });
});

describe("read-only oversight of a file", () => {
  it("never gives an invited organization's admin the bytes", async () => {
    const id = await room();
    const object = await file(id);
    const res = await download(orgAdmin(INVITED.org), id, object);
    expect(await refusal(res)).toEqual({ status: 404, code: "workspace_not_found" });
    expect(res.headers.get("content-disposition")).toBeNull();
  });

  it("shows nothing until a file is linked to a task the agent is on, since oversight only reaches its own tasks", async () => {
    const id = await room();
    const object = await file(id);
    const seen = await api(orgAdmin("org_dl_other"), "GET", `/v1/workspaces/${id}/agents/${INVITED.id}/files/${object}`);
    expect([seen.status, seen.code]).toEqual([404, "file_not_found"]);
  });

  it("tells someone in the room no, and an outsider nothing", async () => {
    const id = await room();
    const object = await file(id);
    expect((await api(MEMBER, "GET", `/v1/workspaces/${id}/agents/${INVITED.id}/files/${object}`)).code).toBe("not_allowed");
    expect((await api(orgAdmin("org_dl_x"), "GET", `/v1/workspaces/${id}/agents/${INVITED.id}/files/${object}`)).code).toBe("workspace_not_found");
  });
});
