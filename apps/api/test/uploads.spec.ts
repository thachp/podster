import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OWNER: Who = { id: "per_owner", kind: "person", org: "org_a", adminOrgs: ["org_a"] };
const ADMIN: Who = { id: "per_admin", kind: "person", org: "org_a" };
const MEMBER: Who = { id: "agt_member", org: "org_a" };
const GUEST: Who = { id: "agt_guest", org: "org_a" };
const OUTSIDER: Who = { id: "agt_out", org: "org_x" };
const orgAdmin = (org: string): Who => ({ id: `per_admin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [], admin_orgs: who.adminOrgs ?? [] }), ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = idempotencyKey ?? `key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [MEMBER, GUEST, OUTSIDER]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Files" })).body.id;
  const add = async (who: Who, role: string) => {
    const r = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: who.kind ?? "agent", org_id: who.org, role, policy_version: await version(id) });
    expect(r.status, `add ${who.id}`).toBe(200);
  };
  await SELF.fetch(`https://api.internal/v1/workspaces/${id}`, { headers: { "x-podster-assertion": await assertion(OWNER) } });
  await addPerson(id, ADMIN, "admin");
  await add(MEMBER, "member");
  await add(GUEST, "guest");
  return { id, uploads: `/v1/workspaces/${id}/uploads` };
}
async function addPerson(id: string, who: Who, role: string) {
  const headers: Record<string, string> = {
    "x-podster-assertion": await new SignJWT({ kind: "person", org: OWNER.org, orgs: [], admin_orgs: OWNER.adminOrgs, target_member: { person: who.id, orgs: { [who.org]: 1 } } })
      .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(OWNER.id).setAudience("podster-api")
      .setIssuedAt(Math.floor(Date.now() / 1000)).setExpirationTime(Math.floor(Date.now() / 1000) + 60).setJti(crypto.randomUUID()).sign(key),
    "idempotency-key": `key-${++counter}`,
  };
  const res = await SELF.fetch(`https://api.internal/v1/workspaces/${id}/members`, { method: "POST", headers, body: JSON.stringify({ principal_id: who.id, kind: "person", org_id: who.org, role, policy_version: await version(id) }) });
  expect(res.status, `add ${who.id}`).toBe(200);
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const sha256 = async (data: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
const TEXT = bytes("some notes\n".repeat(100));

/** Asks for an upload of exactly these bytes, unless told to announce something else. */
async function create(uploads: string, data: Uint8Array = TEXT, over: object = {}, who: Who = OWNER) {
  const r = await api(who, "POST", uploads, { name: "notes.txt", size: data.length, sha256: await sha256(data), ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
const coordinator = async (who: Who, id: string) => {
  expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${who.id}/access`, { preset: "coordinator", policy_version: await version(id) })).status).toBe(200);
};
const put = (upload: { upload_path: string; token: string }, body?: BodyInit | null, token: string | null = upload.token) =>
  SELF.fetch(`https://api.internal${upload.upload_path}`, { method: "PUT", headers: token ? { authorization: `Bearer ${token}` } : {}, body: body as any });
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const code = async (res: Response) => ((await res.json()) as any).error?.code;
const row = (id: string, object: string) => runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)), (_: any, state: any) => state.storage.sql.exec("SELECT * FROM stored_object WHERE id = ?", object).toArray()[0]);
const inRoom = (id: string, fn: (sql: any) => unknown) => runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)), (_: any, state: any) => fn(state.storage.sql));
const stored = async (id: string) => (await BINDINGS.ASSETS.list({ prefix: `rooms/${id}/` })).objects.map((o: any) => o.key) as string[];
/** A body with no declared length, which arrives chunked. */
const chunked = (data: Uint8Array, size = 1024) => new ReadableStream({
  start(controller) {
    for (let at = 0; at < data.length; at += size) controller.enqueue(data.slice(at, at + size));
    controller.close();
  },
});

/** A body that sends its first bytes, then waits to be told to finish. */
const heldBody = (data: Uint8Array = TEXT) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(data.slice(0, 10));
      await held;
      controller.enqueue(data.slice(10));
      controller.close();
    },
  });
  return { body, release };
};
const underWay = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("create_upload", () => {
  it("reserves the space, cleans the name and answers with a way to send the bytes", async () => {
    const { id, uploads } = await room();
    const upload = await create(uploads, TEXT, { name: "  plan‮.txt" });
    expect(upload.state).toBe("uploading");
    expect(upload.name).not.toContain("‮");
    expect(upload.size).toBe(TEXT.length);
    expect(upload.upload_path).toBe(`/v1/uploads/${id}/${upload.id}`);
    expect(upload.token).toMatch(/^upl_/);
    expect(upload.expires_at).toBeGreaterThan(Date.now());
    const saved = await row(id, upload.id);
    expect(saved.state).toBe("uploading");
    expect(JSON.stringify(saved)).not.toContain(upload.token);
  });

  it("returns the token once, so a retry can't read it from the stored answer", async () => {
    const { id, uploads } = await room();
    const body = { name: "notes.txt", size: TEXT.length, sha256: await sha256(TEXT) };
    const first = await api(OWNER, "POST", uploads, body, "same-key");
    const again = await api(OWNER, "POST", uploads, body, "same-key");
    expect(first.body.token).toMatch(/^upl_/);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.token).toBeUndefined();
    const held = await inRoom(id, (sql) => JSON.stringify(sql.exec("SELECT response_json FROM idempotency").toArray()));
    expect(held).not.toContain(first.body.token);
  });

  it("lets the owner, an admin and a member with the whole room upload, and nobody else", async () => {
    const { id, uploads } = await room();
    const body = { name: "notes.txt", size: TEXT.length, sha256: await sha256(TEXT) };
    expect((await api(ADMIN, "POST", uploads, body)).status).toBe(200);
    // A member's reach decides, and this one's is the default until it's widened.
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { preset: "coordinator", policy_version: await version(id) })).status).toBe(200);
    expect((await api(MEMBER, "POST", uploads, body)).status).toBe(200);
    const guest = await api(GUEST, "POST", uploads, body);
    expect([guest.status, guest.code]).toEqual([403, "not_allowed"]);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { preset: "guest", policy_version: await version(id) })).status).toBe(200);
    expect((await api(MEMBER, "POST", uploads, body)).status).toBe(403);
    expect((await api(OUTSIDER, "POST", uploads, body)).status).toBe(404);
  });

  it("refuses what the rules refuse, before any byte arrives", async () => {
    const { id, uploads } = await room();
    const hash = await sha256(TEXT);
    const asked = (over: object) => api(OWNER, "POST", uploads, { name: "notes.txt", size: 10, sha256: hash, ...over });
    expect((await asked({ size: 100_000_001 })).code).toBe("file_too_large");
    expect((await asked({ size: 100_000_000 })).status).toBe(200);
    expect((await asked({ size: 0 })).code).toBe("file_type_refused");
    expect((await asked({ size: -1 })).code).toBe("invalid_argument");
    expect((await asked({ size: 1.5 })).code).toBe("invalid_argument");
    expect((await asked({ name: "setup.exe" })).code).toBe("executable_refused");
    expect((await asked({ sha256: "abc" })).code).toBe("invalid_argument");
    expect((await asked({ sha256: hash.toUpperCase() })).code).toBe("invalid_argument");
    expect(await stored(id)).toEqual([]);
  });

  it("stops at 5 GB a room, counting kept files and live uploads, and not expired ones", async () => {
    const { id, uploads } = await room();
    const hash = await sha256(TEXT);
    const seed = (rowId: string, state: string, size: number, expires: number) => inRoom(id, (sql) => sql.exec(
      "INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, created_at, upload_expires_at) VALUES (?, 'x', ?, ?, ?, '', 'o', 0, ?)", rowId, size, hash, state, expires));
    const asked = (size: number) => api(OWNER, "POST", uploads, { name: "notes.txt", size, sha256: hash });
    await seed("kept", "scanning", 4_900_000_000, 0);
    expect((await asked(100_000_000)).status).toBe(200);
    const over = await asked(1);
    expect([over.status, over.code]).toEqual([409, "room_quota_exceeded"]);
    // The last one reserved its space, and when it expires the space comes back without anything clearing it.
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET upload_expires_at = 1 WHERE state = 'uploading'"));
    expect((await asked(1)).status).toBe(200);
    await seed("big", "blocked", 99_999_999, 0);
    expect((await asked(1)).code).toBe("room_quota_exceeded");
  });

  it("is refused in an archived room", async () => {
    const { id, uploads } = await room();
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    expect((await api(OWNER, "POST", uploads, { name: "n.txt", size: 1, sha256: await sha256(TEXT) })).code).toBe("workspace_archived");
  });

  it("keeps the name out of events and the audit log, and tells nobody", async () => {
    const { id, uploads } = await room();
    const upload = await create(uploads, TEXT, { name: "a-very-secret-name.txt" });
    expect((await put(upload, TEXT)).status).toBe(200);
    const events = await inRoom(id, (sql) => JSON.stringify(sql.exec("SELECT * FROM event WHERE type LIKE 'object.%'").toArray()));
    const audit = await inRoom(id, (sql) => JSON.stringify(sql.exec("SELECT * FROM audit_event WHERE action LIKE 'object.%'").toArray()));
    expect(JSON.parse(events as string)).toHaveLength(2);
    expect(JSON.parse(audit as string)).toHaveLength(2);
    expect(events).not.toContain("secret");
    expect(audit).not.toContain("secret");
    expect(await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM outbox o JOIN event e ON e.id = o.event_id WHERE e.type LIKE 'object.%'").one().n)).toBe(0);
  });
});

describe("the bytes of an upload", () => {
  it("stores exactly what was announced, and moves it to scanning, where it stays unavailable", async () => {
    const { id, uploads } = await room();
    const upload = await create(uploads);
    const res = await answer(await put(upload, TEXT));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: upload.id, state: "scanning", size: TEXT.length, sha256: await sha256(TEXT), media_type: expect.stringContaining("text/plain") });
    const saved = await row(id, upload.id);
    expect(saved.state).toBe("scanning");
    expect(saved.token_hash).toBe("");
    expect(saved.uploader_json).toBeNull();
    const held = await BINDINGS.ASSETS.get(saved.object_key);
    expect(new Uint8Array(await held.arrayBuffer())).toEqual(TEXT);
    expect(saved.object_key.startsWith(`rooms/${id}/objects/${upload.id}/`)).toBe(true);
    // No route gives the bytes back.
    expect((await api(OWNER, "GET", upload.upload_path)).status).toBe(404);
    expect((await api(OWNER, "GET", `${uploads}/${upload.id}`)).status).toBe(404);
  });

  it("takes a chunked upload with a correct hash and no declared length", async () => {
    const { id, uploads } = await room();
    const upload = await create(uploads);
    const res = await answer(await put(upload, chunked(TEXT)));
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("scanning");
    expect((await stored(id)).length).toBe(1);
  });

  it.each([
    ["a wrong hash", TEXT, new Uint8Array(32).fill(7)],
    ["a chunked body with a wrong hash", null, new Uint8Array(32).fill(7)],
  ])("refuses %s and keeps nothing, and the upload can be tried again", async (_name, body, wrong) => {
    const { id, uploads } = await room();
    const upload = await create(uploads, TEXT, { sha256: await sha256(wrong as Uint8Array) });
    const res = await put(upload, body ?? chunked(TEXT));
    expect(res.status).toBe(422);
    expect(await code(res)).toBe("upload_mismatch");
    expect(await stored(id)).toEqual([]);
    expect((await row(id, upload.id)).state).toBe("uploading");
  });

  it.each([["declared", (d: Uint8Array) => d], ["chunked", (d: Uint8Array) => chunked(d)]])("refuses a %s body longer or shorter than announced, keeping nothing", async (_name, send) => {
    const { id, uploads } = await room();
    const longer = await create(uploads);
    const extra = new Uint8Array(TEXT.length + 1).fill(97);
    extra.set(TEXT);
    const res = await put(longer, send(extra) as any);
    expect(res.status).toBe(422);
    expect(await code(res)).toBe("upload_mismatch");
    const shorter = await create(uploads);
    const short = await put(shorter, send(TEXT.slice(0, 10)) as any);
    expect(short.status).toBe(422);
    expect(await code(short)).toBe("upload_mismatch");
    expect(await stored(id)).toEqual([]);
    // The right bytes still work afterwards.
    expect((await put(shorter, TEXT)).status).toBe(200);
  });

  it("refuses a request with no body", async () => {
    const { uploads } = await room();
    const upload = await create(uploads);
    const res = await put(upload);
    expect(res.status).toBe(422);
    expect(await code(res)).toBe("upload_mismatch");
  });

  it("decides a type from the bytes, whatever the name says, and keeps nothing it refuses", async () => {
    const { id, uploads } = await room();
    const program = new Uint8Array(4096);
    program.set(bytes("MZ"));
    program[0x3c] = 0x80;
    program.set(bytes("PE\0\0"), 0x80);
    const upload = await create(uploads, program, { name: "harmless.txt" });
    const res = await put(upload, program);
    expect(res.status).toBe(415);
    expect(await code(res)).toBe("executable_refused");
    expect(await stored(id)).toEqual([]);
    expect((await row(id, upload.id)).state).toBe("uploading");
  });

  it("answers the same for a wrong token, no token, an unknown upload and an expired one", async () => {
    const { id, uploads } = await room();
    const upload = await create(uploads);
    const expired = await create(uploads);
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET upload_expires_at = 1 WHERE id = ?", expired.id));
    const answers = [
      await put(upload, TEXT, `upl_${"0".repeat(64)}`),
      await put(upload, TEXT, "upl_wrong"),
      await put(upload, TEXT, `${upload.token}0`),
      await put(upload, TEXT, null),
      await put({ ...upload, upload_path: `/v1/uploads/${id}/obj_none` }, TEXT),
      await put({ ...upload, upload_path: `/v1/uploads/ws_none/${upload.id}` }, TEXT),
      await put(expired, TEXT),
    ];
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(["upload_not_found", "workspace_not_found"]).toContain(await code(res));
    }
    expect(await stored(id)).toEqual([]);
    expect((await row(id, upload.id)).state).toBe("uploading");
  });

  it("doesn't take a real token for another upload, or for the same upload in another room", async () => {
    const { id, uploads } = await room();
    const other = await room();
    const upload = await create(uploads);
    const second = await create(uploads);
    const elsewhere = await create(other.uploads);
    const refused = [
      await put(upload, TEXT, second.token),
      await put(upload, TEXT, elsewhere.token),
      await put({ ...upload, upload_path: `/v1/uploads/${other.id}/${upload.id}` }, TEXT),
      await put({ ...elsewhere, upload_path: `/v1/uploads/${id}/${elsewhere.id}` }, TEXT),
    ];
    for (const res of refused) {
      expect(res.status).toBe(404);
      expect(await code(res)).toBe("upload_not_found");
    }
    expect(await stored(id)).toEqual([]);
    expect(await stored(other.id)).toEqual([]);
  });

  it("can't use an assertion in place of the token", async () => {
    const { uploads } = await room();
    const upload = await create(uploads);
    const res = await SELF.fetch(`https://api.internal${upload.upload_path}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(OWNER) }, body: TEXT });
    expect(res.status).toBe(404);
  });

  it("can't arrive twice, so nothing replaces a stored file", async () => {
    const { id, uploads } = await room();
    const upload = await create(uploads);
    expect((await put(upload, TEXT)).status).toBe(200);
    const before = await stored(id);
    // Its token is gone, so it's not told anything more than a stranger.
    expect((await put(upload, TEXT)).status).toBe(404);
    expect(await stored(id)).toEqual(before);
  });

  it("lets only the latest attempt complete, and drops the bytes of the one it replaced", async () => {
    const { id, uploads } = await room();
    const upload = await create(uploads);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = new ReadableStream({
      async start(controller) {
        controller.enqueue(TEXT.slice(0, 10));
        await held;
        controller.enqueue(TEXT.slice(10));
        controller.close();
      },
    });
    const first = put(upload, slow);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await put(upload, TEXT)).status).toBe(200);
    const saved = await row(id, upload.id);
    release();
    const late = await first;
    expect(late.status).toBe(409);
    expect(await code(late)).toBe("invalid_transition");
    expect(await stored(id)).toEqual([saved.object_key]);
    expect((await row(id, upload.id)).object_key).toBe(saved.object_key);
  });

  it("refuses an older attempt that finishes first, so the file is only ever what the latest attempt checked", async () => {
    const { id, uploads } = await room();
    const upload = await create(uploads);
    const hold = () => {
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(TEXT.slice(0, 10));
          await held;
          controller.enqueue(TEXT.slice(10));
          controller.close();
        },
      });
      return { body, release };
    };
    const older = hold();
    const newer = hold();
    const first = put(upload, older.body);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = put(upload, newer.body);
    await new Promise((resolve) => setTimeout(resolve, 100));
    older.release();
    const late = await first;
    expect(late.status).toBe(409);
    expect(await code(late)).toBe("invalid_transition");
    expect((await row(id, upload.id)).state).toBe("uploading");
    newer.release();
    expect((await second).status).toBe(200);
    const saved = await row(id, upload.id);
    expect(saved.state).toBe("scanning");
    expect(await stored(id)).toEqual([saved.object_key]);
    expect(new Uint8Array(await (await BINDINGS.ASSETS.get(saved.object_key)).arrayBuffer())).toEqual(TEXT);
  });

  it("refuses bytes from someone whose access narrows while they arrive", async () => {
    const { id, uploads } = await room();
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { preset: "coordinator", policy_version: await version(id) })).status).toBe(200);
    const upload = await create(uploads, TEXT, {}, MEMBER);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = new ReadableStream({
      async start(controller) {
        controller.enqueue(TEXT.slice(0, 10));
        await held;
        controller.enqueue(TEXT.slice(10));
        controller.close();
      },
    });
    const going = put(upload, slow);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { preset: "guest", policy_version: await version(id) })).status).toBe(200);
    release();
    const finished = await going;
    expect(finished.status).toBe(404);
    expect(await stored(id)).toEqual([]);
    expect(await row(id, upload.id)).toBeUndefined();
  });

  it("refuses bytes from someone who has left, at the start and when they finish", async () => {
    const { id, uploads } = await room();
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { preset: "coordinator", policy_version: await version(id) })).status).toBe(200);
    const upload = await create(uploads, TEXT, {}, MEMBER);
    const during = await create(uploads, TEXT, {}, MEMBER);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = new ReadableStream({
      async start(controller) {
        controller.enqueue(TEXT.slice(0, 10));
        await held;
        controller.enqueue(TEXT.slice(10));
        controller.close();
      },
    });
    const going = put(during, slow);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${MEMBER.id}`, { policy_version: await version(id) })).status).toBe(200);
    release();
    const finished = await going;
    expect(finished.status).toBe(404);
    expect(await code(finished)).toBe("upload_not_found");
    expect(await stored(id)).toEqual([]);
    const started = await put(upload, TEXT);
    expect(started.status).toBe(404);
    expect(await row(id, during.id)).toBeUndefined();
    expect(await row(id, upload.id)).toBeUndefined();
  });

  it("ends a removed member's token for good, even if they come back with more access", async () => {
    const { id, uploads } = await room();
    await coordinator(MEMBER, id);
    const upload = await create(uploads, TEXT, {}, MEMBER);
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${MEMBER.id}`, { policy_version: await version(id) })).status).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/members/${MEMBER.id}/clear-removal`, { policy_version: await version(id) })).status).toBeLessThan(500);
    await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: MEMBER.id, kind: "agent", org_id: MEMBER.org, role: "member", policy_version: await version(id) });
    await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { preset: "coordinator", policy_version: await version(id) });
    const res = await put(upload, TEXT);
    expect(res.status).toBe(404);
    expect(await code(res)).toBe("upload_not_found");
    expect(await stored(id)).toEqual([]);
  });

  it("gives back a removed member's reservation at once, with the record that it went", async () => {
    const { id, uploads } = await room();
    await coordinator(MEMBER, id);
    await inRoom(id, (sql) => sql.exec("INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, created_at, upload_expires_at) VALUES ('most', 'x', 4900000000, 'x', 'scanning', '', 'o', 0, 0)"));
    const reserving = await create(uploads, TEXT, { size: 100_000_000 }, MEMBER);
    const hash = await sha256(TEXT);
    expect((await api(OWNER, "POST", uploads, { name: "n.txt", size: 1, sha256: hash })).code).toBe("room_quota_exceeded");
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${MEMBER.id}`, { policy_version: await version(id) })).status).toBe(200);
    expect((await api(OWNER, "POST", uploads, { name: "n.txt", size: 1, sha256: hash })).status).toBe(200);
    const log = (await api(OWNER, "GET", `/v1/workspaces/${id}/audit`)).body.audit;
    expect(log.some((entry: any) => entry.action === "object.upload_dropped" && entry.target_id === reserving.id)).toBe(true);
  });

  it("drops an owner's unfinished uploads when the room hears they left the organization", async () => {
    const { id, uploads } = await room();
    const upload = await create(uploads);
    const answer = await BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)).fetch("https://do/internal/org-departure", { method: "POST", body: JSON.stringify({ person: OWNER.id, org: OWNER.org, left_at: Date.now() + 1000, actor: OWNER.id }) });
    expect(answer.status).toBe(200);
    expect(await row(id, upload.id)).toBeUndefined();
  });

  it("keeps a file that had already arrived when its uploader goes", async () => {
    const { id, uploads } = await room();
    await coordinator(MEMBER, id);
    const upload = await create(uploads, TEXT, {}, MEMBER);
    expect((await put(upload, TEXT)).status).toBe(200);
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${MEMBER.id}`, { policy_version: await version(id) })).status).toBe(200);
    expect((await row(id, upload.id)).state).toBe("scanning");
  });

  describe("deadlines", () => {
    it("gives up on a sender that goes quiet, keeping nothing, and the upload can be tried again", async () => {
      const { id, uploads } = await room();
      const upload = await create(uploads);
      const res = await put(upload, heldBody().body);
      expect(res.status).toBe(408);
      expect(await code(res)).toBe("upload_timed_out");
      expect(await stored(id)).toEqual([]);
      expect((await row(id, upload.id)).state).toBe("uploading");
      expect((await put(upload, TEXT)).status).toBe(200);
    }, 15_000);

    it("gives up on a sender that keeps trickling past the total limit", async () => {
      const { id, uploads } = await room();
      const upload = await create(uploads);
      let stop = false;
      const trickle = new ReadableStream({
        async start(controller) {
          for (let at = 0; at < TEXT.length && !stop; at++) {
            controller.enqueue(TEXT.slice(at, at + 1));
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        },
      });
      const res = await put(upload, trickle);
      stop = true;
      expect(res.status).toBe(408);
      expect(await code(res)).toBe("upload_timed_out");
      expect(await stored(id)).toEqual([]);
    }, 20_000);
  });

  it("refuses bytes from someone whose access no longer allows uploads", async () => {
    const { id, uploads } = await room();
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { preset: "coordinator", policy_version: await version(id) })).status).toBe(200);
    const upload = await create(uploads, TEXT, {}, MEMBER);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { preset: "guest", policy_version: await version(id) })).status).toBe(200);
    const res = await put(upload, TEXT);
    expect(res.status).toBe(404);
    expect(await code(res)).toBe("upload_not_found");
    expect(await stored(id)).toEqual([]);
    // Widening doesn't bring the token back.
    await coordinator(MEMBER, id);
    expect((await put(upload, TEXT)).status).toBe(404);
  });

  it("gives back a narrowed uploader's reservation at once", async () => {
    const { id, uploads } = await room();
    await coordinator(MEMBER, id);
    await inRoom(id, (sql) => sql.exec("INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, created_at, upload_expires_at) VALUES ('most', 'x', 4900000000, 'x', 'scanning', '', 'o', 0, 0)"));
    await create(uploads, TEXT, { size: 100_000_000 }, MEMBER);
    const hash = await sha256(TEXT);
    expect((await api(OWNER, "POST", uploads, { name: "n.txt", size: 1, sha256: hash })).code).toBe("room_quota_exceeded");
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { preset: "guest", policy_version: await version(id) })).status).toBe(200);
    expect((await api(OWNER, "POST", uploads, { name: "n.txt", size: 1, sha256: hash })).status).toBe(200);
  });

  it("drops an upload when a change of role stops its uploader finishing", async () => {
    const { id, uploads } = await room();
    await coordinator(MEMBER, id);
    const upload = await create(uploads, TEXT, {}, MEMBER);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/members/${MEMBER.id}/role`, { role: "guest", policy_version: await version(id) })).status).toBe(200);
    expect(await row(id, upload.id)).toBeUndefined();
    expect((await put(upload, TEXT)).status).toBe(404);
  });

  it("drops an upload when ending a claim takes away what let its uploader upload", async () => {
    const { id, uploads } = await room();
    const opening = await api(OWNER, "POST", `/v1/workspaces/${id}/roles`, { title: "Engineer", responsibilities: "Builds it", capacity: 1, preset: "member", policy_version: await version(id) });
    expect(opening.status).toBe(200);
    const roles = `/v1/workspaces/${id}/roles/${opening.body.id}`;
    expect((await api(OWNER, "POST", `${roles}/invites`, { principal_id: GUEST.id, policy_version: await version(id) })).status).toBe(200);
    expect((await api(GUEST, "POST", `${roles}/claim`, {})).status).toBe(200);
    const upload = await create(uploads, TEXT, {}, GUEST);
    expect((await api(GUEST, "POST", `${roles}/release`, {})).status).toBe(200);
    expect(await row(id, upload.id)).toBeUndefined();
    expect((await put(upload, TEXT)).status).toBe(404);
  });

  it("doesn't bring an upload back when an agent returns through an invitation", async () => {
    const { id, uploads } = await room();
    const created = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { role: "member", invited_org_id: OUTSIDER.org, policy_version: await version(id) });
    expect(created.status).toBe(200);
    expect((await api(orgAdmin(OUTSIDER.org), "POST", "/v1/invitations/accept", { token: created.body.token, org_id: OUTSIDER.org, agents: [OUTSIDER.id] })).status).toBe(200);
    await coordinator(OUTSIDER, id);
    const upload = await create(uploads, TEXT, {}, OUTSIDER);
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${OUTSIDER.id}`, { policy_version: await version(id) })).status).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/members/${OUTSIDER.id}/clear-removal`, { policy_version: await version(id) })).status).toBeLessThan(500);
    const again = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { role: "member", invited_org_id: OUTSIDER.org, policy_version: await version(id) });
    expect((await api(orgAdmin(OUTSIDER.org), "POST", "/v1/invitations/accept", { token: again.body.token, org_id: OUTSIDER.org, agents: [OUTSIDER.id] })).status).toBe(200);
    expect(await row(id, upload.id)).toBeUndefined();
    expect((await put(upload, TEXT)).status).toBe(404);
  });

  it("answers when the room is stuck at the start, reading no bytes", async () => {
    const { id, uploads } = await room();
    const upload = await create(uploads);
    let unblock = () => {};
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    const holding = runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)), (_: any, state: any) => state.blockConcurrencyWhile(() => blocked));
    await underWay();
    const res = await put(upload, TEXT);
    expect(res.status).toBe(504);
    expect(await code(res)).toBe("room_unavailable");
    unblock();
    await holding;
    expect(await stored(id)).toEqual([]);
  }, 15_000);

  it("keeps an upload through a change that still lets its uploader finish", async () => {
    const { id, uploads } = await room();
    await coordinator(MEMBER, id);
    const upload = await create(uploads, TEXT, {}, MEMBER);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { scopes: { conversations: "own" }, policy_version: await version(id) })).status).toBe(200);
    expect((await put(upload, TEXT)).status).toBe(200);
  });

  it("answers when the room is stuck, without deleting bytes it may yet accept", async () => {
    const { id, uploads } = await room();
    const upload = await create(uploads);
    const held = heldBody();
    const going = put(upload, held.body);
    await underWay();
    let unblock = () => {};
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    const holding = runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)), (_: any, state: any) => state.blockConcurrencyWhile(() => blocked));
    await underWay();
    held.release();
    const res = await going;
    expect(res.status).toBe(504);
    expect(await code(res)).toBe("upload_outcome_unknown");
    expect((await stored(id)).length).toBe(1);
    unblock();
    await holding;
  }, 15_000);

  it("refuses bytes in a room archived before or during the upload, and keeps none", async () => {
    const { id, uploads } = await room();
    const before = await create(uploads);
    const during = await create(uploads);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = new ReadableStream({
      async start(controller) {
        controller.enqueue(TEXT.slice(0, 10));
        await held;
        controller.enqueue(TEXT.slice(10));
        controller.close();
      },
    });
    const going = put(during, slow);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    release();
    const finished = await going;
    expect(finished.status).toBe(409);
    expect(await code(finished)).toBe("workspace_archived");
    expect(await stored(id)).toEqual([]);
    const late = await put(before, TEXT);
    expect(late.status).toBe(409);
    expect(await code(late)).toBe("workspace_archived");
  });

  describe("a reservation that lapses during an upload", () => {
    // A moment ago: the reservation is gone, and the attempt that began before then is still within its own limit.
    const reservationEnds = (id: string, object: string) => inRoom(id, (sql) => sql.exec("UPDATE stored_object SET upload_expires_at = ? WHERE id = ?", Date.now() - 1000, object));

    it("still finishes if the file fits", async () => {
      const { id, uploads } = await room();
      const upload = await create(uploads);
      const held = heldBody();
      const going = put(upload, held.body);
      await underWay();
      await reservationEnds(id, upload.id);
      held.release();
      expect((await going).status).toBe(200);
    });

    it("can't take the room past its quota, and keeps none of the bytes", async () => {
      const { id, uploads } = await room();
      const upload = await create(uploads);
      const held = heldBody();
      const going = put(upload, held.body);
      await underWay();
      await reservationEnds(id, upload.id);
      // Its space came back, and someone else takes all of it.
      await inRoom(id, (sql) => sql.exec("INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, created_at, upload_expires_at) VALUES ('full', 'x', 5000000000, 'x', 'scanning', '', 'o', 0, 0)"));
      held.release();
      const finished = await going;
      expect(finished.status).toBe(409);
      expect(await code(finished)).toBe("room_quota_exceeded");
      expect(await stored(id)).toEqual([]);
      expect((await row(id, upload.id)).state).toBe("uploading");
    });

    it("doesn't count itself when it checks, so a full room's own last file still lands", async () => {
      const { id, uploads } = await room();
      await inRoom(id, (sql) => sql.exec("INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, created_at, upload_expires_at) VALUES ('most', 'x', ?, 'x', 'scanning', '', 'o', 0, 0)", 5_000_000_000 - TEXT.length));
      const upload = await create(uploads);
      expect((await put(upload, TEXT)).status).toBe(200);
    });
  });

  describe("an uploader who goes while their room hasn't heard", () => {
    const holdFanOut = async (who: Who) => {
      const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}/disconnect`, { method: "POST", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)), "x-test-hold-fan-out": "1" }, body: "{}" });
      expect(res.status).toBe(200);
    };
    const depart = async (person: string, org: string, left_at: number) => {
      const res = await SELF.fetch("https://api.internal/v1/org-departures", { method: "POST", headers: { "x-podster-assertion": await assertion(orgAdmin(org), { departure: { person, org, left_at } }) }, body: "{}" });
      expect(res.status).toBe(200);
    };
    const freshAgent = async (id: string) => {
      const who: Who = { id: `agt_${crypto.randomUUID().replaceAll("-", "")}`, org: "org_a" };
      const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
      expect(res.status).toBe(200);
      expect((await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: who.org, role: "member", policy_version: await version(id) })).status).toBe(200);
      await coordinator(who, id);
      return who;
    };
    const freshAdmin = async (id: string) => {
      const who: Who = { id: `per_${crypto.randomUUID().replaceAll("-", "")}`, kind: "person", org: "org_a" };
      await addPerson(id, who, "admin");
      return who;
    };

    /** Answers without the body ever finishing, which only a check before the bytes can do. */
    const refusedBeforeTheBytes = async (upload: any) => {
      const held = heldBody();
      const res = await Promise.race([put(upload, held.body), new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))]);
      held.release();
      expect(res, "it waited for the bytes").not.toBeNull();
      return res as Response;
    };

    it("refuses an agent disconnected before the bytes start, without reading them", async () => {
      const { id, uploads } = await room();
      const agent = await freshAgent(id);
      const upload = await create(uploads, TEXT, {}, agent);
      await holdFanOut(agent);
      const res = await refusedBeforeTheBytes(upload);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("agent_disconnected");
      expect(await stored(id)).toEqual([]);
    });

    it("refuses an agent disconnected while the bytes arrive, and keeps none", async () => {
      const { id, uploads } = await room();
      const agent = await freshAgent(id);
      const upload = await create(uploads, TEXT, {}, agent);
      const held = heldBody();
      const going = put(upload, held.body);
      await underWay();
      await holdFanOut(agent);
      held.release();
      const finished = await going;
      expect(finished.status).toBe(403);
      expect(await code(finished)).toBe("agent_disconnected");
      expect(await stored(id)).toEqual([]);
      expect((await row(id, upload.id)).state).toBe("uploading");
    });

    it("refuses a person who left the organization before the bytes start, or while they arrive", async () => {
      const { id, uploads } = await room();
      const first = await freshAdmin(id);
      const before = await create(uploads, TEXT, {}, first);
      await depart(first.id, first.org, Date.now());
      const res = await refusedBeforeTheBytes(before);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("access_revoked");
      const second = await freshAdmin(id);
      const during = await create(uploads, TEXT, {}, second);
      const held = heldBody();
      const going = put(during, held.body);
      await underWay();
      await depart(second.id, second.org, Date.now());
      held.release();
      const finished = await going;
      expect(finished.status).toBe(403);
      expect(await code(finished)).toBe("access_revoked");
      expect(await stored(id)).toEqual([]);
    });

    it("doesn't hold an old departure against someone who came back before they asked", async () => {
      const { id, uploads } = await room();
      const person = await freshAdmin(id);
      const upload = await create(uploads, TEXT, {}, person);
      await depart(person.id, person.org, 1);
      await depart(person.id, "org_elsewhere", Date.now());
      expect((await put(upload, TEXT)).status).toBe(200);
    });
  });

  it("is refused for a disconnected agent", async () => {
    const { id, uploads } = await room();
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { preset: "coordinator", policy_version: await version(id) })).status).toBe(200);
    const upload = await create(uploads, TEXT, {}, MEMBER);
    // The agent's generation moves past what it had when it asked.
    await inRoom(id, (sql) => sql.exec("INSERT OR REPLACE INTO principal_fence (principal_id, min_generation) VALUES (?, 2)", MEMBER.id));
    const res = await put(upload, TEXT);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("agent_disconnected");
    expect(await stored(id)).toEqual([]);
  });
});
