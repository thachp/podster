import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm.ts";

/**
 * M7 step 4 (decision 228; the M7 security review's S-29): `get_task` adds the task's provenance for Runner's run policy.
 * The requester's organization, the room's visibility, and who last wrote each prompt input (title, instructions,
 * acceptance criteria and the latest change request) with that author's organization, each marked `external` for the
 * reader. The room records each author from the command that wrote the input, never from anything a client sends, and
 * shows it only to someone who may read the task. It authorizes nothing.
 */

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const orgAdmin = (org: string): Who => ({ id: `per_pv_admin_${org}`, kind: "person", org, adminOrgs: [org] });
const OWNER: Who = { id: "per_pv_owner", kind: "person", org: "org_pv", adminOrgs: ["org_pv"] };
const ADMIN: Who = { id: "per_pv_admin", kind: "person", org: "org_pv" };
const LEAD: Who = { id: "agt_pv_lead", org: "org_pv" };
const REVIEWER: Who = { id: "agt_pv_rev", org: "org_pv" };
const GUEST: Who = { id: "agt_pv_guest", org: "org_pv" };
const BOB: Who = { id: "agt_pv_bob", org: "org_pvq" };

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }), ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: any) {
  // The gateway states this when its directory says the person being added belongs to the organization.
  const added = method === "POST" && /\/members$/.test(path) && body?.kind === "person" ? body.principal_id : undefined;
  const claims = added ? { target_member: { person: added, orgs: { [body.org_id]: 1 } } } : {};
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, claims), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `pv-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (method === "POST" && path === "/v1/workspaces" && typeof parsed?.id === "string") madeRooms.push(parsed.id);
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

async function register(who: Who) {
  const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
  if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, run: (sql: any) => T): Promise<T> => runInDurableObject(stub(id), (_: any, state: any) => run(state.storage.sql));

/** Every room a test makes, quieted after it so that no alarm of it runs into the next test. */
const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(stub(id));
});

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [LEAD, REVIEWER, GUEST, BOB]) await register(who);
});

async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Provenance" })).body.id;
  // The room's alarms are the test's from here: nothing here waits for a delivery (review standard 1).
  await manualAlarms(stub(id));
  const version = async () => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
  for (const [who, role] of [[ADMIN, "admin"], [LEAD, "member"], [REVIEWER, "member"], [GUEST, "guest"]] as const) {
    const r = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: who.kind ?? "agent", org_id: who.org, role, policy_version: await version() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  // Another organization's agent comes in the way the product brings it: an invitation its organization accepts.
  const invite = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { role: "guest", invited_org_id: BOB.org, guest_can_create: true, policy_version: await version() });
  expect(invite.status, JSON.stringify(invite.body)).toBe(200);
  const accepted = await api(orgAdmin(BOB.org), "POST", "/v1/invitations/accept", { token: invite.body.token, org_id: BOB.org, agents: [BOB.id] });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  return { id, tasks: `/v1/workspaces/${id}/tasks` };
}

const create = async (who: Who, tasks: string, body: object) => {
  const r = await api(who, "POST", tasks, { title: "Design billing", instructions: "Write the design", reviewer: REVIEWER.id, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const read = async (who: Who, path: string) => {
  const r = await api(who, "GET", path);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const inputs = (body: any) => Object.fromEntries(body.provenance.inputs.map((i: any) => [i.input, i]));
const by = (who: Who, external: boolean) => ({ from: { id: who.id, org: who.org }, external });

describe("a task's provenance", () => {
  it("names the requester's organization, the room's visibility and who wrote each input, external for each reader", async () => {
    const { tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id, acceptance_criteria: "Tests pass" });
    const own = await read(LEAD, `${tasks}/${t.id}`);
    expect(own.provenance.room_visibility).toBe("private");
    expect(own.provenance.requester).toEqual({ id: LEAD.id, org: LEAD.org, external: false });
    expect(own.provenance.inputs.map((i: any) => i.input)).toEqual(["title", "instructions", "acceptance_criteria"]);
    for (const input of own.provenance.inputs) {
      expect(input).toMatchObject(by(LEAD, false));
      expect(typeof input.written_at).toBe("number");
    }
    // The same record, read from another organization: everything the room's organization wrote is external to it.
    const theirs = await read(BOB, `${tasks}/${t.id}`);
    expect(theirs.provenance.requester).toEqual({ id: LEAD.id, org: LEAD.org, external: true });
    for (const input of theirs.provenance.inputs) expect(input).toMatchObject(by(LEAD, true));
    // A task with no criteria has no criteria author.
    const bare = await create(LEAD, tasks, { assignee: BOB.id });
    expect((await read(LEAD, `${tasks}/${bare.id}`)).provenance.inputs.map((i: any) => i.input)).toEqual(["title", "instructions"]);
  });

  it("moves an input to whoever last changed its text, and leaves the rest, and the same text, where they were", async () => {
    const { tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id, acceptance_criteria: "Tests pass" });
    const path = `${tasks}/${t.id}`;
    const edited = await api(ADMIN, "POST", `${path}/update`, { version: t.version, instructions: "Write the design, then the tests" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    let seen = inputs(await read(LEAD, path));
    expect(seen.title).toMatchObject(by(LEAD, false));
    expect(seen.instructions).toMatchObject(by(ADMIN, false));
    expect(seen.acceptance_criteria).toMatchObject(by(LEAD, false));
    // The requester writes the same words again: they're still the admin's and the lead's.
    const same = await api(LEAD, "POST", `${path}/update`, { version: edited.body.version, title: "Design billing", instructions: "Write the design, then the tests", acceptance_criteria: "Tests pass" });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    seen = inputs(await read(LEAD, path));
    expect(seen.instructions).toMatchObject(by(ADMIN, false));
    expect(seen.title).toMatchObject(by(LEAD, false));
  });

  it("shows a mix of authors, so the least trusted can decide", async () => {
    const { tasks } = await room();
    // Another organization's agent asks; the room's admin then rewrites the title only.
    const t = await create(BOB, tasks, { assignee: LEAD.id, acceptance_criteria: "Ship it" });
    const path = `${tasks}/${t.id}`;
    const edited = await api(ADMIN, "POST", `${path}/update`, { version: t.version, title: "Billing design" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const body = await read(LEAD, path);
    expect(body.provenance.requester).toEqual({ id: BOB.id, org: BOB.org, external: true });
    const seen = inputs(body);
    expect(seen.title).toMatchObject(by(ADMIN, false));
    expect(seen.instructions).toMatchObject(by(BOB, true));
    expect(seen.acceptance_criteria).toMatchObject(by(BOB, true));
  });

  it("names the latest change request's author and its history entry", async () => {
    const { tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    const path = `${tasks}/${t.id}`;
    expect((await api(BOB, "POST", `${path}/accept`, { version: 1 })).status).toBe(200);
    expect((await api(BOB, "POST", `${path}/submit`, { version: 2, note: "first" })).status).toBe(200);
    expect(inputs(await read(BOB, path)).change_request).toBeUndefined();
    expect((await api(REVIEWER, "POST", `${path}/request-changes`, { submission_no: 1, reason: "fix the tests" })).status).toBe(200);
    let body = await read(BOB, path);
    const first = body.history.filter((e: any) => e.type === "task.changes_requested").at(-1);
    expect(inputs(body).change_request).toMatchObject({ ...by(REVIEWER, true), event_id: first.id, written_at: first.created_at });
    // A rerun's change request is the latest one.
    const task = body.task;
    expect((await api(BOB, "POST", `${path}/submit`, { version: task.version, note: "second" })).status).toBe(200);
    expect((await api(REVIEWER, "POST", `${path}/request-changes`, { submission_no: 2, reason: "and the docs" })).status).toBe(200);
    body = await read(BOB, path);
    const second = body.history.filter((e: any) => e.type === "task.changes_requested").at(-1);
    expect(second.id).not.toBe(first.id);
    expect(inputs(body).change_request).toMatchObject({ ...by(REVIEWER, true), event_id: second.id });
    expect(inputs(await read(LEAD, path)).change_request).toMatchObject(by(REVIEWER, false));
  });

  it("takes nothing a client sends: authors come from the command, and an update naming one is refused", async () => {
    const { tasks } = await room();
    const t = await create(LEAD, tasks, {
      assignee: BOB.id,
      provenance: { requester: { id: BOB.id, org: "org_evil" }, room_visibility: "public", inputs: [] },
      author: BOB.id, author_org: "org_evil", requester_org: "org_evil",
    });
    const body = await read(BOB, `${tasks}/${t.id}`);
    expect(body.provenance.requester).toEqual({ id: LEAD.id, org: LEAD.org, external: true });
    expect(body.provenance.room_visibility).toBe("private");
    for (const input of body.provenance.inputs) expect(input).toMatchObject(by(LEAD, true));
    for (const extra of [{ author: BOB.id }, { provenance: {} }, { title_by: BOB.id }]) {
      const r = await api(LEAD, "POST", `${tasks}/${t.id}/update`, { version: t.version, title: "x", ...extra });
      expect(r.code, JSON.stringify(extra)).toBe("invalid_argument");
    }
  });

  it("is only in get_task, for those who may read the task", async () => {
    const { tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    expect(t.provenance).toBeUndefined();
    const list = await read(LEAD, tasks);
    expect(list.tasks.every((x: any) => x.provenance === undefined)).toBe(true);
    // A guest who isn't party to the task can't read it, so learns nothing of who wrote it.
    const hidden = await api(GUEST, "GET", `${tasks}/${t.id}`);
    expect([hidden.status, hidden.code]).toEqual([404, "task_not_found"]);
    const outsider = await api({ id: "agt_pv_nobody", org: "org_pvx" }, "GET", `${tasks}/${t.id}`);
    expect(outsider.status).not.toBe(200);
    expect(outsider.body?.provenance).toBeUndefined();
  });

  it("follows the room's visibility as it stands", async () => {
    const { id, tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    await inRoom(id, (sql) => sql.exec("UPDATE workspace SET visibility = 'public'"));
    expect((await read(BOB, `${tasks}/${t.id}`)).provenance.room_visibility).toBe("public");
  });

  it("shows an input nobody recorded as unknown and external, even to the room's own organization", async () => {
    const { id, tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id, acceptance_criteria: "Tests pass" });
    await inRoom(id, (sql) => sql.exec("DELETE FROM task_input_author WHERE task_id = ?", t.id));
    const body = await read(LEAD, `${tasks}/${t.id}`);
    expect(body.provenance.inputs).toEqual([
      { input: "title", from: null, external: true, written_at: null },
      { input: "instructions", from: null, external: true, written_at: null },
      { input: "acceptance_criteria", from: null, external: true, written_at: null },
    ]);
  });

  it("forgets an input's author when its text changes by any path that names none", async () => {
    const { id, tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    const path = `${tasks}/${t.id}`;
    // A write that bypasses the command path entirely can't leave the old author on new words: the next save through the
    // room's own code drops it. Simulated here by changing the text underneath, then saving any change.
    await inRoom(id, (sql) => sql.exec("UPDATE task SET instructions = 'Something else entirely' WHERE id = ?", t.id));
    expect((await api(BOB, "POST", `${path}/accept`, { version: 1 })).status).toBe(200);
    const seen = inputs(await read(LEAD, path));
    expect(seen.title).toMatchObject(by(LEAD, false));
    expect(seen.instructions).toEqual({ input: "instructions", from: null, external: true, written_at: null });
  });

  it("is shown through oversight as the agent sees it", async () => {
    const { id, tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    const body = await read(orgAdmin(BOB.org), `/v1/workspaces/${id}/agents/${BOB.id}/tasks/${t.id}`);
    expect(body.provenance.requester).toEqual({ id: LEAD.id, org: LEAD.org, external: true });
    for (const input of body.provenance.inputs) expect(input).toMatchObject(by(LEAD, true));
  });

  it("is backfilled on migration with each task's latest change request, and nothing else is guessed", async () => {
    const { id, tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    const path = `${tasks}/${t.id}`;
    expect((await api(BOB, "POST", `${path}/accept`, { version: 1 })).status).toBe(200);
    expect((await api(BOB, "POST", `${path}/submit`, { version: 2, note: "first" })).status).toBe(200);
    expect((await api(REVIEWER, "POST", `${path}/request-changes`, { submission_no: 1, reason: "fix" })).status).toBe(200);
    const before = await read(BOB, path);
    // A room from before this step: no record of authors, one schema step behind.
    await inRoom(id, (sql) => {
      sql.exec("DROP TABLE task_input_author");
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    const after = await read(BOB, path);
    const seen = inputs(after);
    expect(seen.change_request).toEqual(inputs(before).change_request);
    expect(seen.title).toEqual({ input: "title", from: null, external: true, written_at: null });
    expect(seen.instructions).toEqual({ input: "instructions", from: null, external: true, written_at: null });
    // The step runs again over its own table harmlessly, so a renumbering on rebase can't break a room.
    await inRoom(id, (sql) => sql.exec("UPDATE schema_version SET version = version - 1"));
    expect((await read(BOB, path)).provenance).toEqual(after.provenance);
  });
});
