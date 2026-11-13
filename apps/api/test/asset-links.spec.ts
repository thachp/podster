import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { alarmQuiet } from "./alarm.ts";

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OWNER: Who = { id: "per_al_owner", kind: "person", org: "org_al", adminOrgs: ["org_al"] };
const MEMBER: Who = { id: "agt_al_member", org: "org_al" };
const GUEST: Who = { id: "agt_al_guest", org: "org_al" };
const INVITED: Who = { id: "agt_al_invited", org: "org_al_other" };
const PEER: Who = { id: "agt_al_peer", org: "org_al" };
const NOTIFIED: Who = { id: "agt_al_notified", org: "org_al" };
const STRANGER: Who = { id: "agt_al_stranger", org: "org_al_x" };
const orgAdmin = (org: string): Who => ({ id: `per_al_admin_${org}`, kind: "person", org, adminOrgs: [org] });

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
  if (method !== "GET") headers["idempotency-key"] = `al-key-${++counter}`;
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

/** Every room a test makes, quieted after it so that no alarm of it runs into the next test. */
const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)));
});

async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Inputs" })).body.id;
  madeRooms.push(id);
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


const tasks = (id: string) => `/v1/workspaces/${id}/tasks`;
const files = (id: string) => `/v1/workspaces/${id}/files`;

async function task(id: string, assignee = GUEST.id) {
  const made = await api(OWNER, "POST", tasks(id), { title: "Use the brief", instructions: "Read the attached brief", assignee });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return made.body.id as string;
}
const link = (who: Who, id: string, object: string, taskId: string) => api(who, "POST", `${files(id)}/${object}/links`, { task_id: taskId });
const unlink = (who: Who, id: string, object: string, taskId: string) => api(who, "DELETE", `${files(id)}/${object}/links/${taskId}`);
const read = (who: Who, id: string, object: string) => api(who, "GET", `${files(id)}/${object}`);
const listed = async (who: Who, id: string, query = "") => {
  const res = await api(who, "GET", `${files(id)}${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.files as any[]).map((f) => f.id);
};
const events = (id: string, kind: string) => inRoom(id, (sql) => sql.exec("SELECT task_id FROM event WHERE type = ?", kind).toArray());
const inboxTypes = async (who: Who, taskId: string) => ((await api(who, "GET", "/v1/inbox")).body.events as any[]).filter((e) => e.task_id === taskId).map((e) => e.type);

describe("linking an input asset to a task", () => {
  it("lets the assignee read and download it only while it's linked", async () => {
    const id = await room();
    const object = await file(id);
    const t = await task(id);
    expect((await read(GUEST, id, object)).code).toBe("file_not_found");
    expect(await refusal(await download(GUEST, id, object))).toEqual({ status: 404, code: "file_not_found" });
    expect(await listed(GUEST, id)).toEqual([]);

    const linked = await link(OWNER, id, object, t);
    expect([linked.status, linked.body]).toEqual([200, { file_id: object, task_id: t, linked: true }]);
    const seen = await read(GUEST, id, object);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ id: object, state: "ready", linked_tasks: [t], download_path: `/v1/files/${id}/${object}` });
    const bytes = await download(GUEST, id, object);
    expect(bytes.status).toBe(200);
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(TEXT);
    expect(await listed(GUEST, id)).toEqual([object]);
    expect(await listed(GUEST, id, `?task_id=${t}`)).toEqual([object]);

    expect((await unlink(OWNER, id, object, t)).body).toEqual({ file_id: object, task_id: t, linked: false });
    expect((await read(GUEST, id, object)).code).toBe("file_not_found");
    expect(await refusal(await download(GUEST, id, object))).toEqual({ status: 404, code: "file_not_found" });
    expect(await listed(GUEST, id)).toEqual([]);
  });

  it("stops downloading for its assignee with file_removed once removed, keeping the link as a record", async () => {
    const id = await room();
    const object = await file(id);
    const t = await task(id);
    expect((await link(OWNER, id, object, t)).status).toBe(200);
    expect((await download(GUEST, id, object)).status).toBe(200);
    const removed = await api(OWNER, "POST", `/v1/workspaces/${id}/files/${object}/remove`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(await refusal(await download(GUEST, id, object))).toEqual({ status: 410, code: "file_removed" });
    expect((await read(GUEST, id, object)).body).toMatchObject({ state: "removed", download_path: null, linked_tasks: [t] });
    // Linking it anywhere again is refused as removed.
    const other = await task(id);
    expect((await link(OWNER, id, object, other)).code).toBe("file_removed");
  });

  it("is for whoever may upload input assets, and refuses everyone else as uploading does", async () => {
    const id = await room();
    const object = await file(id);
    const t = await task(id);
    expect((await link(MEMBER, id, object, t)).status).toBe(200);
    expect((await unlink(MEMBER, id, object, t)).status).toBe(200);
    expect((await link(STRANGER, id, object, t)).code).toBe("workspace_not_found");
    // A file they can't see answers as a missing one, and one they can, through their own task, as a refusal.
    expect((await link(GUEST, id, object, t)).code).toBe("file_not_found");
    expect((await link(OWNER, id, object, t)).status).toBe(200);
    expect((await link(GUEST, id, object, t)).code).toBe("not_allowed");
    expect((await unlink(GUEST, id, object, t)).code).toBe("not_allowed");
  });

  it("never lets a member narrowed to their own tasks link or unlink a file they can't read", async () => {
    const id = await room();
    const hidden = await file(id);
    const theirs = await api(MEMBER, "POST", tasks(id), { title: "Mine", instructions: "x" });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    const other = await task(id);
    expect((await link(OWNER, id, hidden, other)).status).toBe(200);
    const narrowed = await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { policy_version: await version(id), scopes: { tasks: "own" } });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect((await read(MEMBER, id, hidden)).code).toBe("file_not_found");
    for (const answer of [await link(MEMBER, id, hidden, theirs.body.id), await link(MEMBER, id, "obj_missing", theirs.body.id), await unlink(MEMBER, id, hidden, theirs.body.id)]) {
      expect([answer.status, answer.code]).toEqual([404, "file_not_found"]);
    }
    expect((await read(GUEST, id, hidden)).body.linked_tasks).toEqual([other]);
    expect(await inRoom(id, (sql) => sql.exec("SELECT task_id FROM asset_link WHERE object_id = ?", hidden).toArray())).toEqual([{ task_id: other }]);
  });

  it("answers an unknown file or task as one that doesn't exist", async () => {
    const id = await room();
    const object = await file(id);
    const t = await task(id);
    expect((await link(OWNER, id, "obj_nothing", t)).code).toBe("file_not_found");
    expect((await link(OWNER, id, object, "tsk_nothing")).code).toBe("task_not_found");
    expect((await link(OWNER, id, object, "bad id!")).code).toBe("invalid_argument");
    expect((await api(OWNER, "POST", `${files(id)}/${object}/links`, {})).code).toBe("invalid_argument");
  });

  it("links a file that's scanning or ready, and nothing nobody could ever have", async () => {
    const id = await room();
    const t = await task(id);
    for (const state of ["uploading", "blocked", "failed"]) {
      expect((await link(OWNER, id, await file(id, state), t)).code, state).toBe("file_not_available");
    }
    const scanning = await file(id, "scanning");
    expect((await link(OWNER, id, scanning, t)).status).toBe(200);
    // The assignee sees it waiting, and gets the bytes only once the scan ends Ready.
    expect((await read(GUEST, id, scanning)).body).toMatchObject({ state: "scanning", download_path: null });
    expect(await refusal(await download(GUEST, id, scanning))).toEqual({ status: 409, code: "file_not_available" });
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET state = 'ready' WHERE id = ?", scanning));
    expect((await download(GUEST, id, scanning)).status).toBe(200);
  });

  it("takes no new link on a finished task, and can always unlink", async () => {
    const id = await room();
    const object = await file(id);
    const open = await task(id);
    expect((await link(OWNER, id, object, open)).status).toBe(200);
    for (const status of ["completed", "canceled"]) {
      const t = await task(id);
      await inRoom(id, (sql) => sql.exec("UPDATE task SET status = ? WHERE id = ?", status, t));
      expect((await link(OWNER, id, object, t)).code, status).toBe("task_closed");
    }
    await inRoom(id, (sql) => sql.exec("UPDATE task SET status = 'canceled' WHERE id = ?", open));
    expect((await unlink(OWNER, id, object, open)).body.linked).toBe(false);
  });

  it("holds a task to the limit of linked assets", async () => {
    const id = await room();
    const object = await file(id);
    const t = await task(id);
    await inRoom(id, (sql) => {
      for (let i = 0; i < 50; i++) sql.exec("INSERT INTO asset_link (task_id, object_id, linked_by, linked_at) VALUES (?, ?, ?, 0)", t, `obj_seed${i}`, OWNER.id);
    });
    expect((await link(OWNER, id, object, t)).code).toBe("limit_exceeded");
  });

  it("treats linking twice as done, and tells only the assignee, by task, once", async () => {
    const id = await room();
    const object = await file(id);
    // An agent in this room only, so its inbox holds nothing from other tests.
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: NOTIFIED.id, kind: "agent", org_id: NOTIFIED.org, role: "guest", policy_version: await version(id) })).status).toBe(200);
    const t = await task(id, NOTIFIED.id);
    expect((await link(MEMBER, id, object, t)).status).toBe(200);
    expect((await link(MEMBER, id, object, t)).status).toBe(200);
    expect((await unlink(MEMBER, id, object, t)).status).toBe(200);
    expect((await unlink(MEMBER, id, object, t)).status).toBe(200);
    expect(await events(id, "asset.linked")).toEqual([{ task_id: t }]);
    expect(await events(id, "asset.unlinked")).toEqual([{ task_id: t }]);
    await vi.waitFor(async () => expect(await inboxTypes(NOTIFIED, t)).toEqual(expect.arrayContaining(["asset.linked", "asset.unlinked"])), { timeout: 5000, interval: 25 });
    expect((await inboxTypes(NOTIFIED, t)).filter((type) => type.startsWith("asset."))).toEqual(["asset.linked", "asset.unlinked"]);
    // Events never carry the file.
    const stored = await inRoom(id, (sql) => sql.exec("SELECT * FROM event WHERE type LIKE 'asset.%'").toArray());
    expect(JSON.stringify(stored)).not.toContain(object);
  });

  it("puts the notice in an agent assignee's inbox without waking it (decision 104), while other events still wake it", async () => {
    const id = await room();
    const object = await file(id);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: NOTIFIED.id, kind: "agent", org_id: NOTIFIED.org, role: "guest", policy_version: await version(id) })).status).toBe(200);
    const t = await task(id, NOTIFIED.id);
    expect((await api(NOTIFIED, "PUT", "/v1/inbox/wake", { url: "https://hooks.example.com/assets" })).status).toBe(200);
    const wake = () => runInDurableObject(BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(NOTIFIED.id)), (_: any, state: any) => state.storage.sql.exec("SELECT queued_until FROM wake").one().queued_until);
    // Offering the task woke it once already. Start from no wake queued, so only what follows counts.
    await vi.waitFor(async () => expect(await inboxTypes(NOTIFIED, t)).toContain("task.offered"), { timeout: 5000, interval: 25 });
    await runInDurableObject(BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(NOTIFIED.id)), (_: any, state: any) => void state.storage.sql.exec("UPDATE wake SET queued_until = NULL"));
    expect((await link(OWNER, id, object, t)).status).toBe(200);
    expect((await unlink(OWNER, id, object, t)).status).toBe(200);
    await vi.waitFor(async () => expect(await inboxTypes(NOTIFIED, t)).toEqual(expect.arrayContaining(["asset.linked", "asset.unlinked"])), { timeout: 5000, interval: 25 });
    expect(await wake()).toBeNull();
    // Something that asks for its attention still wakes it, so the check above could have seen a wake.
    expect((await api(OWNER, "POST", `${tasks(id)}/${t}/messages`, { body: "The brief is linked" })).status).toBe(200);
    await vi.waitFor(async () => expect(await wake()).toBeGreaterThan(Date.now()), { timeout: 5000, interval: 25 });
  });

  it("never wakes for a link, even one made while a wake is being sent", async () => {
    const id = await room();
    const object = await file(id);
    const agent: Who = { id: `agt_al_${crypto.randomUUID().replaceAll("-", "")}`, org: "org_al" };
    const registered = await SELF.fetch(`https://api.internal/v1/agents/${agent.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(agent.org)) }, body: JSON.stringify({ org_id: agent.org, name: agent.id }) });
    expect(registered.status).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: agent.id, kind: "agent", org_id: agent.org, role: "guest", policy_version: await version(id) })).status).toBe(200);
    expect((await api(agent, "PUT", "/v1/inbox/wake", { url: "https://hooks.example.com/in-flight" })).status).toBe(200);
    const principal = BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(agent.id));
    const internal = (path: string, body: object = {}) => principal.fetch(`https://principal/internal/${path}`, { method: "POST", body: JSON.stringify(body) }).then((r: Response) => r.json() as any);
    const t = await task(id, agent.id);
    await vi.waitFor(async () => expect(await inboxTypes(agent, t)).toContain("task.offered"), { timeout: 5000, interval: 25 });
    // A wake for the offer is sent, and while it's on its way the agent reads the offer and an asset is linked.
    const claim = await internal("wake-claim");
    expect(claim.send).toBe(true);
    const seen = (await api(agent, "GET", "/v1/inbox")).body.events as any[];
    expect((await api(agent, "POST", "/v1/inbox/ack", { up_to: seen.at(-1).seq })).status).toBe(200);
    expect((await link(OWNER, id, object, t)).status).toBe(200);
    await vi.waitFor(async () => expect(await inboxTypes(agent, t)).toContain("asset.linked"), { timeout: 5000, interval: 25 });
    expect((await internal("wake-report", { ok: true, secret: claim.secret, last_seq: claim.last_seq })).requeue).toBe(false);
    expect((await internal("wake-report", { ok: true, secret: "not this one", last_seq: claim.last_seq })).requeue).toBe(false);
    // Unread, but nothing to wake for.
    expect((await api(agent, "GET", "/v1/inbox")).body.unread).toBe(1);
    expect(await internal("wake-claim")).toMatchObject({ send: false, reason: "nothing_unread" });
  });

  it("tells an assignee who's no longer in the room nothing", async () => {
    // An owner who left their organization stays named on their tasks, but isn't in the room any more.
    const owner: Who = { id: `per_al_${crypto.randomUUID().replaceAll("-", "")}`, kind: "person", org: "org_al", adminOrgs: ["org_al"] };
    const id: string = (await api(owner, "POST", "/v1/workspaces", { name: "Left" })).body.id;
    madeRooms.push(id);
    const added = await api(owner, "POST", `/v1/workspaces/${id}/members`, { principal_id: MEMBER.id, kind: "agent", org_id: MEMBER.org, role: "member", policy_version: (await api(owner, "GET", `/v1/workspaces/${id}`)).body.policy_version });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const made = await api(owner, "POST", tasks(id), { title: "Mine", instructions: "x", assignee: owner.id, reviewer: MEMBER.id });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const t = made.body.id as string;
    const uploaded = await api(MEMBER, "POST", `/v1/workspaces/${id}/uploads`, { name: "brief.txt", size: TEXT.length, sha256: await sha256(TEXT) });
    expect(uploaded.status).toBe(200);
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET state = 'ready' WHERE id = ?", uploaded.body.id));
    await vi.waitFor(async () => expect(await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM outbox").one().n)).toBe(0), { timeout: 5000, interval: 25 });
    await inRoom(id, (sql) => sql.exec("UPDATE workspace SET owner_left_at = 1"));
    expect(await inRoom(id, (sql) => sql.exec("SELECT assignee_id FROM task WHERE id = ?", t).one().assignee_id)).toBe(owner.id);
    expect((await link(MEMBER, id, uploaded.body.id, t)).status).toBe(200);
    expect((await unlink(MEMBER, id, uploaded.body.id, t)).status).toBe(200);
    expect(await events(id, "asset.linked")).toEqual([{ task_id: t }]);
    expect(await events(id, "asset.unlinked")).toEqual([{ task_id: t }]);
    // Recorded with nobody to deliver to, so nothing is waiting and nothing was ever sent.
    expect(await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM outbox").one().n)).toBe(0);
    const inbox = ((await api(owner, "GET", "/v1/inbox")).body.events ?? []) as any[];
    expect(inbox.filter((e) => String(e.type).startsWith("asset."))).toEqual([]);
  });

  it("names only the linked tasks the reader can see", async () => {
    const id = await room();
    const object = await file(id);
    const mine = await task(id);
    const theirs = await task(id, PEER.id);
    for (const t of [mine, theirs]) expect((await link(OWNER, id, object, t)).status).toBe(200);
    expect((await read(OWNER, id, object)).body.linked_tasks).toEqual([mine, theirs]);
    expect((await read(GUEST, id, object)).body.linked_tasks).toEqual([mine]);
    expect(await listed(GUEST, id, `?task_id=${mine}`)).toEqual([object]);
    expect((await api(GUEST, "GET", `${files(id)}?task_id=${theirs}`)).code).toBe("task_not_found");
  });

  it("lists every input asset for whoever sees the whole room, but not unfinished uploads, a page at a time", async () => {
    const id = await room();
    const made = [await file(id), await file(id, "scanning"), await file(id, "blocked")];
    await file(id, "uploading");
    expect(await listed(MEMBER, id)).toEqual(made);
    await inRoom(id, (sql) => {
      for (let i = 0; i < 60; i++) sql.exec("INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, created_at, upload_expires_at) VALUES (?, 'n.txt', 1, ?, 'ready', 'x', ?, 0, 0)", `obj_page${i}`, "a".repeat(64), OWNER.id);
    });
    const first = await api(OWNER, "GET", files(id));
    expect(first.body.files.length).toBe(50);
    const second = await api(OWNER, "GET", `${files(id)}?cursor=${first.body.next_cursor}`);
    expect(second.body.files.length).toBe(13);
    expect(second.body.next_cursor).toBeNull();
    expect((await api(STRANGER, "GET", files(id))).code).toBe("workspace_not_found");
  });

  it("gives the room's space used and its limit only to whoever sees the whole room", async () => {
    const id = await room();
    const empty = await api(OWNER, "GET", files(id));
    expect(empty.body.quota).toEqual({ used: 0, limit: 5_000_000_000 });
    const object = await file(id);
    // An open reservation counts too, as it holds space, though it isn't listed.
    const reserved = await api(OWNER, "POST", `/v1/workspaces/${id}/uploads`, { name: "later.txt", size: 1000, sha256: "a".repeat(64) });
    expect(reserved.status).toBe(200);
    const t = await task(id);
    expect((await link(OWNER, id, object, t)).status).toBe(200);
    for (const who of [OWNER, MEMBER]) {
      expect((await api(who, "GET", files(id))).body.quota, who.id).toEqual({ used: TEXT.length + 1000, limit: 5_000_000_000 });
    }
    for (const query of ["", `?task_id=${t}`]) {
      const guest = await api(GUEST, "GET", `${files(id)}${query}`);
      expect(guest.body.files.map((f: any) => f.id)).toEqual([object]);
      expect(guest.body, query).not.toHaveProperty("quota");
    }
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { policy_version: await version(id), scopes: { tasks: "own" } })).status).toBe(200);
    expect((await api(MEMBER, "GET", files(id))).body).not.toHaveProperty("quota");
  });

  it("never lists a file uploaded for a submission, submitted or not, or lets it be linked", async () => {
    const id = await room();
    const input = await file(id);
    const t = await task(id);
    const path = `${tasks(id)}/${t}`;
    expect((await api(GUEST, "POST", `${path}/accept`, { version: 1 })).status).toBe(200);
    const forTask = async () => {
      const made = await api(GUEST, "POST", `/v1/workspaces/${id}/uploads`, { name: "work.txt", size: TEXT.length, sha256: await sha256(TEXT), task_id: t });
      expect(made.status, JSON.stringify(made.body)).toBe(200);
      const sent = await SELF.fetch(`https://api.internal${made.body.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${made.body.token}` }, body: TEXT as any });
      expect(sent.status).toBe(200);
      await sent.text();
      await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET state = 'ready' WHERE id = ?", made.body.id));
      return made.body.id as string;
    };
    const submitted = await forTask();
    const unsubmitted = await forTask();
    const version = (await api(OWNER, "GET", path)).body.task.version;
    expect((await api(GUEST, "POST", `${path}/submit`, { version, files: [{ id: submitted }] })).status).toBe(200);
    // The guest is the submitter and the assignee, and the input asset isn't linked to their task.
    for (const [who, all] of [[OWNER, [input]], [MEMBER, [input]], [GUEST, []]] as const) {
      expect(await listed(who, id), who.id).toEqual(all);
      expect(await listed(who, id, `?task_id=${t}`), who.id).toEqual([]);
    }
    // Still read through its task, as step 6 decides, and never with links.
    const read = await api(OWNER, "GET", `${files(id)}/${submitted}`);
    expect([read.status, read.body.linked_tasks]).toEqual([200, []]);
    for (const object of [submitted, unsubmitted]) {
      const other = await task(id);
      expect((await link(OWNER, id, object, other)).code, object).toBe("file_not_found");
    }
    expect(await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM asset_link").one().n)).toBe(0);
  });

  it("refuses a link in an archived room, and the file stays readable", async () => {
    const id = await room();
    const object = await file(id);
    const t = await task(id);
    expect((await link(OWNER, id, object, t)).status).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    expect((await unlink(OWNER, id, object, t)).code).toBe("workspace_archived");
    expect((await download(GUEST, id, object)).status).toBe(200);
  });

  it("gives an invited organization's admin the name and state of a file linked to their agent's task, never the bytes", async () => {
    const id = await room();
    const object = await file(id);
    const t = await task(id, INVITED.id);
    const overseen = `/v1/workspaces/${id}/agents/${INVITED.id}/files/${object}`;
    expect((await api(orgAdmin(INVITED.org), "GET", overseen)).code).toBe("file_not_found");
    expect((await link(OWNER, id, object, t)).status).toBe(200);
    const seen = await api(orgAdmin(INVITED.org), "GET", overseen);
    expect([seen.status, seen.body]).toEqual([200, { id: object, name: "notes.txt", state: "ready" }]);
    expect(await refusal(await download(orgAdmin(INVITED.org), id, object))).toEqual({ status: 404, code: "workspace_not_found" });
    expect((await download(INVITED, id, object)).status).toBe(200);
  });
});
