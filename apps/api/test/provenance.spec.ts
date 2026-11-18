import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm.ts";

/**
 * M7 step 4 (decision 228; the M7 security review's S-29): `get_task` adds the task's provenance for Runner's run policy.
 * The requester's organization, the room's visibility, and every author who ever wrote each prompt input (title,
 * instructions, acceptance criteria and the latest change request) with their organization, each marked `external` for the
 * reader and `active` while still held in that organization here. The room records each author from the command that wrote
 * the input, never from anything a client sends, keeps every one, and shows them only to someone who may read the task. It
 * authorizes nothing. The architect's rulings on the reviews of #443 (2026-11-18) are F1 to F7.
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
const COORD: Who = { id: "agt_pv_coord", org: "org_pv" };
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
  for (const who of [LEAD, REVIEWER, GUEST, COORD, BOB]) await register(who);
});

async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Provenance" })).body.id;
  // The room's alarms are the test's from here: nothing here waits for a delivery (review standard 1).
  await manualAlarms(stub(id));
  const version = async () => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
  for (const [who, role] of [[ADMIN, "admin"], [LEAD, "member"], [REVIEWER, "member"], [GUEST, "guest"], [COORD, "member"]] as const) {
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
/** Takes someone out of the room, as its owner does. */
const revoke = async (id: string, who: Who) => {
  const version = (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
  const r = await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${who.id}`, { policy_version: version });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const inputs = (body: any) => Object.fromEntries(body.provenance.inputs.map((i: any) => [i.input, i]));
/** Who wrote an input, in the order they first wrote it, without the times. */
const authors = (input: any) => input.authors.map(({ written_at: _, ...rest }: any) => rest);
const author = (who: Who, external: boolean, active = true) => ({ id: who.id, org: who.org, external, active });
const UNKNOWN = { id: null, org: null, external: true, active: false };
const unknownInput = (input: string) => ({ input, external: true, authors: [{ ...UNKNOWN, written_at: null }] });

describe("a task's provenance", () => {
  it("names the requester's organization, the room's visibility and who wrote each input, external for each reader", async () => {
    const { tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id, acceptance_criteria: "Tests pass" });
    const own = await read(LEAD, `${tasks}/${t.id}`);
    expect(own.provenance.room_visibility).toBe("private");
    expect(own.provenance.requester).toEqual({ id: LEAD.id, org: LEAD.org, external: false, active: true });
    expect(own.provenance.inputs.map((i: any) => i.input)).toEqual(["title", "instructions", "acceptance_criteria"]);
    for (const input of own.provenance.inputs) {
      expect(input.external).toBe(false);
      expect(authors(input)).toEqual([author(LEAD, false)]);
      expect(typeof input.authors[0].written_at).toBe("number");
    }
    // The same record, read from another organization: everything the room's organization wrote is external to it.
    const theirs = await read(BOB, `${tasks}/${t.id}`);
    expect(theirs.provenance.requester).toEqual({ id: LEAD.id, org: LEAD.org, external: true, active: true });
    for (const input of theirs.provenance.inputs) {
      expect(input.external).toBe(true);
      expect(authors(input)).toEqual([author(LEAD, true)]);
    }
    // A task with no criteria has no criteria authors.
    const bare = await create(LEAD, tasks, { assignee: BOB.id });
    expect((await read(LEAD, `${tasks}/${bare.id}`)).provenance.inputs.map((i: any) => i.input)).toEqual(["title", "instructions"]);
  });

  it("adds whoever changes an input's text to its authors, and the same text adds nobody", async () => {
    const { tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id, acceptance_criteria: "Tests pass" });
    const path = `${tasks}/${t.id}`;
    const edited = await api(ADMIN, "POST", `${path}/update`, { version: t.version, instructions: "Write the design, then the tests" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    let seen = inputs(await read(LEAD, path));
    expect(authors(seen.title)).toEqual([author(LEAD, false)]);
    expect(authors(seen.instructions)).toEqual([author(LEAD, false), author(ADMIN, false)]);
    expect(authors(seen.acceptance_criteria)).toEqual([author(LEAD, false)]);
    // The same words again change nothing.
    const again = await api(LEAD, "POST", `${path}/update`, { version: edited.body.version, title: "Design billing", instructions: "Write the design, then the tests", acceptance_criteria: "Tests pass" });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    seen = inputs(await read(LEAD, path));
    expect(authors(seen.instructions)).toEqual([author(LEAD, false), author(ADMIN, false)]);
    expect(authors(seen.title)).toEqual([author(LEAD, false)]);
  });

  it("keeps an external author after they leave and an internal coordinator takes over and edits (F1, F3)", async () => {
    const { id, tasks } = await room();
    // An external guest asks, then leaves the room.
    const t = await create(BOB, tasks, { assignee: LEAD.id, acceptance_criteria: "Ship it" });
    const path = `${tasks}/${t.id}`;
    await revoke(id, BOB);
    // An internal coordinator takes the task over for itself and makes a trivial edit to every input.
    const version = (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${COORD.id}/access`, { preset: "coordinator", policy_version: version })).status).toBe(200);
    const flagged = await read(COORD, path);
    const taken = await api(COORD, "POST", `${path}/set-requester`, { version: flagged.task.version, requester: COORD.id });
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    const edited = await api(COORD, "POST", `${path}/update`, { version: taken.body.version, title: "Design billing.", instructions: "Write the design.", acceptance_criteria: "Ship it." });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const body = await read(LEAD, path);
    // The requester is the coordinator now, recorded when it took the part.
    expect(body.provenance.requester).toEqual({ id: COORD.id, org: COORD.org, external: false, active: true });
    for (const input of body.provenance.inputs) {
      expect(input.external, input.input).toBe(true);
      expect(authors(input), input.input).toEqual([author(BOB, true, false), author(COORD, false)]);
    }
  });

  it("marks a requester and an author inactive once they are no longer here (F3)", async () => {
    const { id, tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    const path = `${tasks}/${t.id}`;
    await revoke(id, LEAD);
    const body = await read(BOB, path);
    expect(body.provenance.requester).toEqual({ id: LEAD.id, org: LEAD.org, external: true, active: false });
    for (const input of body.provenance.inputs) expect(authors(input)).toEqual([author(LEAD, true, false)]);
  });

  it("names every change request's author and the latest one's history entry", async () => {
    const { tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    const path = `${tasks}/${t.id}`;
    expect((await api(BOB, "POST", `${path}/accept`, { version: 1 })).status).toBe(200);
    expect((await api(BOB, "POST", `${path}/submit`, { version: 2, note: "first" })).status).toBe(200);
    expect(inputs(await read(BOB, path)).change_request).toBeUndefined();
    expect((await api(REVIEWER, "POST", `${path}/request-changes`, { submission_no: 1, reason: "fix the tests" })).status).toBe(200);
    let body = await read(BOB, path);
    const first = body.history.filter((e: any) => e.type === "task.changes_requested").at(-1);
    expect(inputs(body).change_request).toMatchObject({ external: true, event_id: first.id });
    expect(inputs(body).change_request.authors).toEqual([{ ...author(REVIEWER, true), written_at: first.created_at }]);
    // The next change request is the latest one, and its author joins the first's.
    const task = body.task;
    expect((await api(BOB, "POST", `${path}/submit`, { version: task.version, note: "second" })).status).toBe(200);
    expect((await api(REVIEWER, "POST", `${path}/request-changes`, { submission_no: 2, reason: "and the docs" })).status).toBe(200);
    body = await read(BOB, path);
    const second = body.history.filter((e: any) => e.type === "task.changes_requested").at(-1);
    expect(second.id).not.toBe(first.id);
    expect(inputs(body).change_request).toMatchObject({ external: true, event_id: second.id });
    expect(authors(inputs(body).change_request)).toEqual([author(REVIEWER, true)]);
    expect(inputs(await read(LEAD, path)).change_request.external).toBe(false);
  });

  it("counts a change request's record only while it names the latest request (F2)", async () => {
    const { id, tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    const path = `${tasks}/${t.id}`;
    expect((await api(BOB, "POST", `${path}/accept`, { version: 1 })).status).toBe(200);
    expect((await api(BOB, "POST", `${path}/submit`, { version: 2, note: "first" })).status).toBe(200);
    expect((await api(REVIEWER, "POST", `${path}/request-changes`, { submission_no: 1, reason: "fix" })).status).toBe(200);
    // The record points at an older event than the latest request: who wrote the latest isn't known.
    await inRoom(id, (sql) => sql.exec("UPDATE task_input_text SET event_id = 'evt_older' WHERE task_id = ? AND input = 'change_request'", t.id));
    const body = await read(LEAD, path);
    const latest = body.history.filter((e: any) => e.type === "task.changes_requested").at(-1);
    expect(inputs(body).change_request).toMatchObject({ external: true, event_id: latest.id });
    expect(authors(inputs(body).change_request)).toEqual([author(REVIEWER, false), UNKNOWN]);
  });

  it("takes nothing a client sends: authors come from the command, and an update naming one is refused", async () => {
    const { tasks } = await room();
    const t = await create(LEAD, tasks, {
      assignee: BOB.id,
      provenance: { requester: { id: BOB.id, org: "org_evil" }, room_visibility: "public", inputs: [] },
      author: BOB.id, author_org: "org_evil", requester_org: "org_evil", authors: [{ id: BOB.id }],
    });
    const body = await read(BOB, `${tasks}/${t.id}`);
    expect(body.provenance.requester).toEqual({ id: LEAD.id, org: LEAD.org, external: true, active: true });
    expect(body.provenance.room_visibility).toBe("private");
    for (const input of body.provenance.inputs) expect(authors(input)).toEqual([author(LEAD, true)]);
    for (const extra of [{ author: BOB.id }, { provenance: {} }, { authors: [] }, { title_by: BOB.id }]) {
      const r = await api(LEAD, "POST", `${tasks}/${t.id}/update`, { version: t.version, title: "x", ...extra });
      expect(r.code, JSON.stringify(extra)).toBe("invalid_argument");
    }
  });

  it("refuses cleanly a command whose author the room can't record, writing nothing (F6)", async () => {
    const { id, tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    const path = `${tasks}/${t.id}`;
    // A person held in an organization longer than the room records: the update is refused whole.
    const LONG = `org_${"x".repeat(125)}`;
    await inRoom(id, (sql) => sql.exec("UPDATE member SET org_id = ? WHERE principal_id = ?", LONG, ADMIN.id));
    const refused = await api({ ...ADMIN, org: LONG }, "POST", `${path}/update`, { version: t.version, title: "Changed" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.code).toBe("invalid_argument");
    const after = await read(LEAD, path);
    expect([after.task.title, after.task.version]).toEqual(["Design billing", t.version]);
    expect(authors(inputs(after).title)).toEqual([author(LEAD, false)]);
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

  it("shows inputs and a requester nobody recorded as unknown and external, even to the room's own organization", async () => {
    const { id, tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id, acceptance_criteria: "Tests pass" });
    await inRoom(id, (sql) => {
      for (const table of ["task_input_author", "task_input_text", "task_requester_org"]) sql.exec(`DELETE FROM ${table} WHERE task_id = ?`, t.id);
    });
    const body = await read(LEAD, `${tasks}/${t.id}`);
    expect(body.provenance.requester).toEqual({ id: LEAD.id, org: null, external: true, active: false });
    expect(body.provenance.inputs).toEqual(["title", "instructions", "acceptance_criteria"].map(unknownInput));
  });

  it("adds an unknown author, keeping the others, when the words changed by a path that names none", async () => {
    const { id, tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    const path = `${tasks}/${t.id}`;
    await inRoom(id, (sql) => sql.exec("UPDATE task SET instructions = 'Something else entirely' WHERE id = ?", t.id));
    const seen = inputs(await read(LEAD, path));
    expect(seen.title).toMatchObject({ external: false });
    expect(seen.instructions.external).toBe(true);
    expect(authors(seen.instructions)).toEqual([author(LEAD, false), UNKNOWN]);
  });

  it("is shown through oversight as the agent sees it", async () => {
    const { id, tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    const body = await read(orgAdmin(BOB.org), `/v1/workspaces/${id}/agents/${BOB.id}/tasks/${t.id}`);
    expect(body.provenance.requester).toEqual({ id: LEAD.id, org: LEAD.org, external: true, active: true });
    for (const input of body.provenance.inputs) expect(authors(input)).toEqual([author(LEAD, true)]);
  });

  it("is backfilled on migration with every change request's author, and nothing else is guessed", async () => {
    const { id, tasks } = await room();
    const t = await create(LEAD, tasks, { assignee: BOB.id });
    const path = `${tasks}/${t.id}`;
    expect((await api(BOB, "POST", `${path}/accept`, { version: 1 })).status).toBe(200);
    expect((await api(BOB, "POST", `${path}/submit`, { version: 2, note: "first" })).status).toBe(200);
    expect((await api(REVIEWER, "POST", `${path}/request-changes`, { submission_no: 1, reason: "fix" })).status).toBe(200);
    const before = await read(BOB, path);
    // A room from before this step: no record of authors, one schema step behind.
    await inRoom(id, (sql) => {
      for (const table of ["task_input_author", "task_input_text", "task_requester_org"]) sql.exec(`DROP TABLE ${table}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    const after = await read(BOB, path);
    const seen = inputs(after);
    expect(seen.change_request).toEqual(inputs(before).change_request);
    expect(seen.title).toEqual(unknownInput("title"));
    expect(seen.instructions).toEqual(unknownInput("instructions"));
    expect(after.provenance.requester).toEqual({ id: LEAD.id, org: null, external: true, active: false });
    // The step runs again over its own tables harmlessly, so a renumbering on rebase can't break a room.
    await inRoom(id, (sql) => sql.exec("UPDATE schema_version SET version = version - 1"));
    expect((await read(BOB, path)).provenance).toEqual(after.provenance);
  });
});
