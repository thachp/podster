import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// Expected outputs (M2 step 7): defining them, naming one on a task, and approval making it Ready (decisions 54, 135 to 140).

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OWNER: Who = { id: "per_op_owner", kind: "person", org: "org_op", adminOrgs: ["org_op"] };
const ADMIN: Who = { id: "per_op_admin", kind: "person", org: "org_op" };
const MEMBER: Who = { id: "agt_op_member", org: "org_op" };
/** The assignee: another organization's agent, a guest. */
const GUEST: Who = { id: "agt_op_guest", org: "org_op_guest" };
/** A guest who isn't on the task, so it can't see it. */
const OTHER_GUEST: Who = { id: "agt_op_other", org: "org_op" };
/** A registered agent that isn't in the room. */
const OUTSIDER: Who = { id: "agt_op_outsider", org: "org_op_x" };
/** A guest on no task here. */
const LIMITED: Who = { id: "agt_op_limited", org: "org_op" };
/** An agent stored as an admin, which counts as a guest. */
const AGENT_ADMIN: Who = { id: "agt_op_agent_admin", org: "org_op" };
const orgAdmin = (org: string): Who => ({ id: `per_op_orgadmin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }), ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, opts: { claims?: object; key?: string } = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, opts.claims ?? {}), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = opts.key ?? `op-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [MEMBER, GUEST, OTHER_GUEST, AGENT_ADMIN, LIMITED, OUTSIDER]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
const encoder = new TextEncoder();
const sha256 = async (data: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
const TEXT = encoder.encode("The finished report.\n".repeat(40));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)), (_: any, state: any) => fn(state.storage.sql));
const LINK = [{ uri: "https://example.com/report", label: "Report" }];

/** A room with an admin, a member, an agent stored as admin, and two guests, GUEST from another organization. */
async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Outputs" })).body.id;
  for (const [who, role] of [[ADMIN, "admin"], [MEMBER, "member"], [OTHER_GUEST, "guest"], [LIMITED, "guest"], [AGENT_ADMIN, "member"]] as const) {
    const claims = who.kind === "person" ? { target_member: { person: who.id, orgs: { [who.org]: 1 } } } : {};
    const r = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: who.kind ?? "agent", org_id: who.org, role, policy_version: await version(id) }, { claims });
    expect(r.status, `add ${who.id}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  // The API never stores an agent as an admin, but policy must treat one that is as a guest, so the row is set directly.
  await inRoom(id, (sql) => sql.exec("UPDATE member SET role = 'admin' WHERE principal_id = ?", AGENT_ADMIN.id));
  const invited = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { role: "guest", invited_org_id: GUEST.org, policy_version: await version(id) });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const joined = await api(orgAdmin(GUEST.org), "POST", "/v1/invitations/accept", { token: invited.body.token, org_id: GUEST.org, agents: [GUEST.id] });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  return id;
}

async function define(id: string, title = "Final report", description?: string) {
  const made = await api(OWNER, "POST", `/v1/workspaces/${id}/outputs`, { title, ...(description ? { description } : {}) });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return made.body.id as string;
}

/** A task the owner requested and reviews, offered to GUEST and accepted, optionally naming an output when created. */
async function acceptedTask(id: string, output?: string) {
  const made = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Write it", instructions: "Write the report.", assignee: GUEST.id, ...(output ? { expected_output_id: output } : {}) });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const taskPath = `/v1/workspaces/${id}/tasks/${made.body.id}`;
  expect((await api(GUEST, "POST", `${taskPath}/accept`, { version: made.body.version })).status).toBe(200);
  return { task: made.body.id as string, taskPath };
}

const taskVersion = async (taskPath: string) => (await api(OWNER, "GET", taskPath)).body.task.version as number;
const setOutput = async (who: Who, taskPath: string, output: string | null, body?: unknown) => api(who, "PUT", `${taskPath}/expected-output`, body ?? { version: await taskVersion(taskPath), output_id: output });
const submit = async (taskPath: string, body: Record<string, unknown>) => api(GUEST, "POST", `${taskPath}/submit`, { version: await taskVersion(taskPath), ...body });
const approve = (taskPath: string, submission_no = 1, opts: { key?: string } = {}) => api(OWNER, "POST", `${taskPath}/verify`, { submission_no }, opts);
const list = async (who: Who, id: string) => {
  const r = await api(who, "GET", `/v1/workspaces/${id}/outputs`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const listed = async (who: Who, id: string, output: string) => (await list(who, id)).outputs.find((o: any) => o.id === output);

async function upload(id: string, task: string) {
  const made = await api(GUEST, "POST", `/v1/workspaces/${id}/uploads`, { name: "report.txt", size: TEXT.length, sha256: await sha256(TEXT), task_id: task });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const sent = await SELF.fetch(`https://api.internal${made.body.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${made.body.token}` }, body: TEXT as any });
  expect(sent.status).toBe(200);
  await sent.text();
  await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET state = 'ready' WHERE id = ?", made.body.id));
  return made.body.id as string;
}

describe("defining expected outputs", () => {
  it("is for human owners and admins, and every participant sees them", async () => {
    const id = await room();
    const output = await define(id, "Final report", "A PDF for the board");
    expect((await api(ADMIN, "POST", `/v1/workspaces/${id}/outputs`, { title: "Slides" })).status).toBe(200);
    for (const who of [MEMBER, GUEST, AGENT_ADMIN]) {
      expect((await api(who, "POST", `/v1/workspaces/${id}/outputs`, { title: "Mine" })).code, who.id).toBe("not_allowed");
      expect((await api(who, "PUT", `/v1/workspaces/${id}/outputs/${output}`, { title: "Mine" })).code, who.id).toBe("not_allowed");
      expect((await api(who, "DELETE", `/v1/workspaces/${id}/outputs/${output}`)).code, who.id).toBe("not_allowed");
    }
    for (const who of [OWNER, MEMBER, GUEST, OTHER_GUEST]) {
      const body = await list(who, id);
      expect(body.total, who.id).toBe(2);
      expect(body.ready, who.id).toBe(0);
      expect(body.outputs[0], who.id).toMatchObject({ id: output, title: "Final report", description: "A PDF for the board", status: "not_started", current: null });
    }
    // Someone outside the room learns nothing.
    const refused = await api(OUTSIDER, "GET", `/v1/workspaces/${id}/outputs`);
    expect(refused.code).toBe("workspace_not_found");
    expect(refused.body.outputs).toBeUndefined();
  });

  it("checks titles and descriptions in bytes, and replaces them on rename", async () => {
    const id = await room();
    const path = `/v1/workspaces/${id}/outputs`;
    expect((await api(OWNER, "POST", path, { title: "  " })).code).toBe("invalid_argument");
    expect((await api(OWNER, "POST", path, {})).code).toBe("invalid_argument");
    expect((await api(OWNER, "POST", path, { title: "é".repeat(101) })).code).toBe("invalid_argument");
    expect((await api(OWNER, "POST", path, { title: "Report", description: "x".repeat(4097) })).code).toBe("invalid_argument");
    expect((await api(OWNER, "POST", path, { title: "Report", description: 7 })).code).toBe("invalid_argument");
    expect((await api(OWNER, "POST", path, { title: "Report", status: "ready" })).code).toBe("invalid_argument");
    const output = await define(id, "é".repeat(100), "x".repeat(4096));
    const renamed = await api(OWNER, "PUT", `${path}/${output}`, { title: "Board report" });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body).toMatchObject({ id: output, title: "Board report", description: null });
    expect((await api(OWNER, "PUT", `${path}/${output}`, { title: "Board report", current_task_id: "tsk_x" })).code).toBe("invalid_argument");
    expect((await api(OWNER, "PUT", `${path}/out_unknown`, { title: "X" })).status).toBe(404);
    expect((await api(OWNER, "PUT", `${path}/out_unknown`, { title: "X" })).code).toBe("output_not_found");
  });

  it("holds at most 50, and a removed one frees its place", async () => {
    const id = await room();
    const ids = [];
    for (let i = 0; i < 50; i++) ids.push(await define(id, `Output ${i}`));
    const refused = await api(OWNER, "POST", `/v1/workspaces/${id}/outputs`, { title: "One too many" });
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("too_many_outputs");
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/outputs/${ids[0]}`)).status).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/outputs`, { title: "Now it fits" })).status).toBe(200);
    expect((await list(OWNER, id)).total).toBe(50);
  });

  it("records ID-only events that reach activity, not inboxes", async () => {
    const id = await room();
    const output = await define(id, "Secret plan title");
    await api(OWNER, "PUT", `/v1/workspaces/${id}/outputs/${output}`, { title: "Renamed title" });
    // The same text again records nothing.
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/outputs/${output}`, { title: "Renamed title" })).status).toBe(200);
    await api(OWNER, "DELETE", `/v1/workspaces/${id}/outputs/${output}`);
    const events = await inRoom(id, (sql) => sql.exec("SELECT e.id, e.type, e.subject_id, e.reason, (SELECT count(*) FROM outbox o WHERE o.event_id = e.id) AS sent FROM event e WHERE e.type LIKE 'output.%' ORDER BY e.seq").toArray());
    expect(events.map((e: any) => [e.type, e.subject_id, e.reason, e.sent])).toEqual([
      ["output.defined", output, null, 0],
      ["output.updated", output, null, 0],
      ["output.removed", output, null, 0],
    ]);
    // A guest limited to its own tasks still sees them, because every participant sees outputs.
    const seen = (await api(OTHER_GUEST, "GET", `/v1/workspaces/${id}/activity`)).body.events.map((e: any) => e.type);
    expect(seen).toEqual(expect.arrayContaining(["output.defined", "output.updated", "output.removed"]));
  });

  it("refuses changes in an archived room", async () => {
    const id = await room();
    const output = await define(id);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/outputs`, { title: "Late" })).code).toBe("workspace_archived");
    expect((await api(OWNER, "PUT", `/v1/workspaces/${id}/outputs/${output}`, { title: "Late" })).code).toBe("workspace_archived");
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/outputs/${output}`)).code).toBe("workspace_archived");
    // Reads go on.
    expect((await list(GUEST, id)).total).toBe(1);
  });
});

describe("naming an output on a task", () => {
  it("is for the task's requester or a human admin, and hides the task from those who can't see it", async () => {
    const id = await room();
    const output = await define(id);
    const { taskPath } = await acceptedTask(id);
    expect((await setOutput(GUEST, taskPath, output)).code).toBe("not_allowed");
    expect((await setOutput(MEMBER, taskPath, output)).code).toBe("not_allowed");
    expect((await setOutput(AGENT_ADMIN, taskPath, output)).code).toBe("task_not_found");
    expect((await setOutput(OTHER_GUEST, taskPath, output)).code).toBe("task_not_found");
    const set = await setOutput(ADMIN, taskPath, output);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.expected_output).toEqual({ id: output, title: "Final report", removed: false });
    // A member who created its own task is its requester.
    const own = await api(MEMBER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Mine", instructions: "Do it." });
    expect((await setOutput(MEMBER, `/v1/workspaces/${id}/tasks/${own.body.id}`, output)).status).toBe(200);
  });

  it("checks the body and the output", async () => {
    const id = await room();
    const output = await define(id);
    const { taskPath } = await acceptedTask(id);
    const v = await taskVersion(taskPath);
    for (const body of [{}, { version: v }, { output_id: output }, { version: v, output_id: 7 }, { version: v, output_id: output, extra: 1 }, { version: "1", output_id: output }]) {
      expect((await setOutput(OWNER, taskPath, null, body)).code, JSON.stringify(body)).toBe("invalid_argument");
    }
    const unknown = await setOutput(OWNER, taskPath, "out_unknown");
    expect([unknown.status, unknown.code]).toEqual([404, "output_not_found"]);
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/outputs/${output}`)).status).toBe(200);
    expect((await setOutput(OWNER, taskPath, output)).code).toBe("output_not_found");
  });

  it("moves the task's version on a change only, so a stale submit is refused, and tells the task's parties", async () => {
    const id = await room();
    const output = await define(id);
    const { taskPath } = await acceptedTask(id);
    // Hold delivery, so the outbox still says who each event is for when it's read.
    await inRoom(id, (sql) => sql.exec("CREATE TABLE test_hold_outbox (x)"));
    const before = await taskVersion(taskPath);
    const set = await setOutput(OWNER, taskPath, output);
    expect(set.body.version).toBe(before + 1);
    expect((await setOutput(OWNER, taskPath, output)).body.version).toBe(before + 1);
    const stale = await api(GUEST, "POST", `${taskPath}/submit`, { version: before, artifacts: LINK });
    expect(stale.code).toBe("version_conflict");
    // Changing the output from a stale read is refused too, as update_task is.
    const staleSet = await setOutput(OWNER, taskPath, null, { version: before, output_id: null });
    expect([staleSet.status, staleSet.code]).toEqual([409, "version_conflict"]);
    const cleared = await setOutput(OWNER, taskPath, null);
    expect(cleared.body).toMatchObject({ version: before + 2, expected_output: null });
    const events = await inRoom(id, (sql) => sql.exec("SELECT e.subject_id, e.task_version, (SELECT group_concat(recipient_principal_id) FROM outbox o WHERE o.event_id = e.id) AS sent FROM event e WHERE e.type = 'task.output_changed' ORDER BY e.seq").toArray());
    expect(events).toEqual([
      { subject_id: output, task_version: before + 1, sent: GUEST.id },
      { subject_id: null, task_version: before + 2, sent: GUEST.id },
    ]);
  });

  it("can't change once the task is submitted or finished", async () => {
    const id = await room();
    const [first, second] = [await define(id, "One"), await define(id, "Two")];
    const { taskPath } = await acceptedTask(id, first);
    expect((await submit(taskPath, { artifacts: LINK })).status).toBe(200);
    expect((await setOutput(OWNER, taskPath, second)).code).toBe("invalid_transition");
    expect((await setOutput(OWNER, taskPath, null)).code).toBe("invalid_transition");
    // Asking for what it already names changes nothing.
    expect((await setOutput(OWNER, taskPath, first)).status).toBe(200);
    expect((await approve(taskPath)).status).toBe(200);
    expect((await setOutput(OWNER, taskPath, second)).code).toBe("invalid_transition");
  });

  it("gives an organization's admin overseeing its agent the output's ID, never its title", async () => {
    const id = await room();
    const output = await define(id, "Confidential plan");
    const { task } = await acceptedTask(id, output);
    const overseen = await api(orgAdmin(GUEST.org), "GET", `/v1/workspaces/${id}/agents/${GUEST.id}/tasks/${task}`);
    expect(overseen.status, JSON.stringify(overseen.body)).toBe(200);
    expect(overseen.body.expected_output).toEqual({ id: output, removed: false });
    expect(JSON.stringify(overseen.body)).not.toContain("Confidential plan");
    // The agent itself, in the room, gets the title.
    expect((await api(GUEST, "GET", `/v1/workspaces/${id}/tasks/${task}`)).body.expected_output).toEqual({ id: output, title: "Confidential plan", removed: false });
  });

  it("can be named when a task is created", async () => {
    const id = await room();
    const output = await define(id);
    const made = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Write it", instructions: "Write.", expected_output_id: output });
    expect(made.body.expected_output).toEqual({ id: output, title: "Final report", removed: false });
    const read = await api(OWNER, "GET", `/v1/workspaces/${id}/tasks/${made.body.id}`);
    expect(read.body.expected_output).toEqual({ id: output, title: "Final report", removed: false });
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "X", instructions: "Y", expected_output_id: "out_unknown" })).code).toBe("output_not_found");
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "X", instructions: "Y", expected_output_id: 3 })).code).toBe("invalid_argument");
    // A refused create leaves no task behind.
    const tasks = await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM task").toArray()[0].n);
    expect(tasks).toBe(1);
  });
});

describe("approval and status", () => {
  it("is in review while submitted, Ready on approval, and back to not started on request changes", async () => {
    const id = await room();
    const output = await define(id);
    const { task, taskPath } = await acceptedTask(id, output);
    expect((await submit(taskPath, { artifacts: LINK })).status).toBe(200);
    expect((await listed(OWNER, id, output)).status).toBe("in_review");
    expect((await api(OWNER, "POST", `${taskPath}/request-changes`, { submission_no: 1, reason: "Add a summary." })).status).toBe(200);
    expect(await listed(OWNER, id, output)).toMatchObject({ status: "not_started", current: null });
    // Back in accepted, the task's output can change again (decision 137), and here it's set back.
    const other = await define(id, "Other");
    expect((await setOutput(OWNER, taskPath, other)).status).toBe(200);
    expect((await setOutput(OWNER, taskPath, output)).status).toBe(200);
    expect((await submit(taskPath, { artifacts: LINK })).status).toBe(200);
    expect((await approve(taskPath, 2)).status).toBe(200);
    const body = await list(OWNER, id);
    expect(body.ready).toBe(1);
    expect(body.outputs[0]).toMatchObject({ status: "ready", current: { task_id: task, submission_no: 2, files_available: true } });
  });

  it("doesn't make an output Ready on a note-only approval", async () => {
    const id = await room();
    const output = await define(id);
    const { taskPath } = await acceptedTask(id, output);
    expect((await submit(taskPath, { note: "Done, nothing to attach." })).status).toBe(200);
    expect((await approve(taskPath)).status).toBe(200);
    expect(await listed(OWNER, id, output)).toMatchObject({ status: "not_started", current: null });
    expect(await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM expected_output_version").toArray()[0].n)).toBe(0);
  });

  it("takes the latest approval as current, and keeps every version", async () => {
    const id = await room();
    const output = await define(id);
    const first = await acceptedTask(id, output);
    expect((await submit(first.taskPath, { artifacts: LINK })).status).toBe(200);
    expect((await approve(first.taskPath)).status).toBe(200);
    const followUp = await acceptedTask(id, output);
    expect((await submit(followUp.taskPath, { artifacts: LINK })).status).toBe(200);
    // A follow-up in review doesn't take Ready away.
    expect((await listed(OWNER, id, output)).status).toBe("ready");
    expect((await approve(followUp.taskPath)).status).toBe(200);
    expect((await listed(OWNER, id, output)).current.task_id).toBe(followUp.task);
    const versions = await inRoom(id, (sql) => sql.exec("SELECT task_id FROM expected_output_version WHERE output_id = ? ORDER BY approved_at, task_id", output).toArray());
    expect(versions.map((v: any) => v.task_id).sort()).toEqual([first.task, followUp.task].sort());
  });

  it("records nothing again when an approval is replayed", async () => {
    const id = await room();
    const output = await define(id);
    const { taskPath } = await acceptedTask(id, output);
    expect((await submit(taskPath, { artifacts: LINK })).status).toBe(200);
    expect((await approve(taskPath, 1, { key: "op-replay" })).status).toBe(200);
    const at = (await listed(OWNER, id, output)).current.approved_at;
    expect((await approve(taskPath, 1, { key: "op-replay" })).status).toBe(200);
    expect((await listed(OWNER, id, output)).current.approved_at).toBe(at);
    expect(await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM expected_output_version").toArray()[0].n)).toBe(1);
  });

  it("names the delivering task, and its files' state, only to those allowed", async () => {
    const id = await room();
    const output = await define(id);
    const { task, taskPath } = await acceptedTask(id, output);
    const file = await upload(id, task);
    expect((await submit(taskPath, { files: [{ id: file }] })).status).toBe(200);
    expect((await approve(taskPath)).status).toBe(200);
    // A blocked file after approval: the output stays Ready (decision 138).
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET state = 'blocked' WHERE id = ?", file));
    for (const who of [OWNER, MEMBER, GUEST]) {
      expect(await listed(who, id, output), who.id).toMatchObject({ status: "ready", current: { task_id: task, files_available: false } });
    }
    // A guest who can't see the task sees the status, and nothing about the task or its files.
    expect(await listed(OTHER_GUEST, id, output)).toMatchObject({ status: "ready", current: null });
  });

  it("leaves files_available out for someone who sees the task but not that submission", async () => {
    const id = await room();
    const output = await define(id);
    const { task, taskPath } = await acceptedTask(id, output);
    const file = await upload(id, task);
    expect((await submit(taskPath, { files: [{ id: file }] })).status).toBe(200);
    expect((await approve(taskPath)).status).toBe(200);
    // Narrow the member's artifacts to its own tasks, which this isn't, while it still sees every task.
    const narrowed = await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { scopes: { artifacts: "own" }, policy_version: await version(id) });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    const seen = await listed(MEMBER, id, output);
    expect(seen.current).toMatchObject({ task_id: task, submission_no: 1 });
    expect(seen.current).not.toHaveProperty("files_available");
  });
});

describe("removing an output", () => {
  it("is refused while a live task names it or once it was Ready, and allowed after a cancel", async () => {
    const id = await room();
    const output = await define(id);
    const { taskPath } = await acceptedTask(id, output);
    const remove = () => api(OWNER, "DELETE", `/v1/workspaces/${id}/outputs/${output}`);
    expect([(await remove()).status, (await remove()).code]).toEqual([409, "output_in_use"]);
    expect((await api(OWNER, "POST", `${taskPath}/cancel`, { version: await taskVersion(taskPath), reason: "Not needed." })).status).toBe(200);
    expect((await remove()).status).toBe(200);
    expect((await list(OWNER, id)).total).toBe(0);
    // The canceled task still says what it named.
    expect((await api(OWNER, "GET", taskPath)).body.expected_output).toEqual({ id: output, title: "Final report", removed: true });

    const ready = await define(id, "Shipped");
    const done = await acceptedTask(id, ready);
    expect((await submit(done.taskPath, { artifacts: LINK })).status).toBe(200);
    expect((await approve(done.taskPath)).status).toBe(200);
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/outputs/${ready}`)).code).toBe("output_in_use");
  });
});

describe("an output's version history", () => {
  const versions = async (who: Who, id: string, output: string) => {
    const r = await api(who, "GET", `/v1/workspaces/${id}/outputs/${output}/versions`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.complete).toBe(true);
    return r.body.versions as any[];
  };
  const ALLOWED = ["approved_at", "approved_by", "submission_no", "task_id"];

  /** Two approvals of one output: the first by the owner, the second by OTHER_GUEST, a guest named as that task's reviewer. */
  async function history() {
    const id = await room();
    const output = await define(id);
    const first = await acceptedTask(id, output);
    expect((await submit(first.taskPath, { artifacts: LINK })).status).toBe(200);
    expect((await approve(first.taskPath)).status).toBe(200);
    const made = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Follow up", instructions: "Again.", assignee: GUEST.id, reviewer: OTHER_GUEST.id, expected_output_id: output });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const secondPath = `/v1/workspaces/${id}/tasks/${made.body.id}`;
    expect((await api(GUEST, "POST", `${secondPath}/accept`, { version: made.body.version })).status).toBe(200);
    const file = await upload(id, made.body.id);
    expect((await submit(secondPath, { files: [{ id: file }] })).status).toBe(200);
    const approved = await api(OTHER_GUEST, "POST", `${secondPath}/verify`, { submission_no: 1 });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return { id, output, first: first.task, second: made.body.id as string };
  }

  it("lists every approval newest first, with the source task and approver for someone who sees both tasks", async () => {
    const { id, output, first, second } = await history();
    const seen = await versions(OWNER, id, output);
    expect(seen).toEqual([
      { submission_no: 1, approved_at: expect.any(Number), task_id: second, approved_by: OTHER_GUEST.id },
      { submission_no: 1, approved_at: expect.any(Number), task_id: first, approved_by: OWNER.id },
    ]);
    expect(seen[0].approved_at).toBeGreaterThanOrEqual(seen[1].approved_at);
  });

  it("gives a limited guest on neither task only each version's number and time", async () => {
    const { id, output } = await history();
    const seen = await versions(LIMITED, id, output);
    expect(seen).toHaveLength(2);
    for (const version of seen) expect(Object.keys(version).sort()).toEqual(["approved_at", "submission_no"]);
  });

  it("gives the named reviewer, otherwise limited, the task it reviewed and nothing more of the other", async () => {
    const { id, output, second } = await history();
    const [reviewed, other] = await versions(OTHER_GUEST, id, output);
    expect(reviewed).toEqual({ submission_no: 1, approved_at: expect.any(Number), task_id: second, approved_by: OTHER_GUEST.id });
    expect(Object.keys(other).sort()).toEqual(["approved_at", "submission_no"]);
  });

  it("gives a member narrowed to its own artifacts the tasks it sees, and nothing about files", async () => {
    const { id, output, first, second } = await history();
    const narrowed = await api(OWNER, "PUT", `/v1/workspaces/${id}/members/${MEMBER.id}/access`, { scopes: { artifacts: "own" }, policy_version: await version(id) });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    const seen = await versions(MEMBER, id, output);
    expect(seen.map((v) => v.task_id)).toEqual([second, first]);
    for (const v of seen) expect(Object.keys(v).every((key) => ALLOWED.includes(key)), JSON.stringify(v)).toBe(true);
    // get_task still keeps that submission's file from it, which is where a version's files are read.
    const task = await api(MEMBER, "GET", `/v1/workspaces/${id}/tasks/${second}`);
    expect(task.body.files).toEqual([]);
  });

  it("answers output_not_found for an unknown or removed output, and nothing to an outsider", async () => {
    const id = await room();
    const output = await define(id);
    const unknown = await api(OWNER, "GET", `/v1/workspaces/${id}/outputs/out_unknown/versions`);
    expect([unknown.status, unknown.code]).toEqual([404, "output_not_found"]);
    expect((await versions(GUEST, id, output))).toEqual([]);
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/outputs/${output}`)).status).toBe(200);
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}/outputs/${output}/versions`)).code).toBe("output_not_found");
  });

  it("tells an outsider and a stored participant with no role that the room doesn't exist", async () => {
    const id = await room();
    const output = await define(id);
    const outsider = await api(OUTSIDER, "GET", `/v1/workspaces/${id}/outputs/${output}/versions`);
    expect([outsider.code, outsider.body.versions]).toEqual(["workspace_not_found", undefined]);
    // A member row whose role isn't one the room knows reads as Role::None, which sees no outputs.
    await inRoom(id, (sql) => sql.exec("UPDATE member SET role = 'none' WHERE principal_id = ?", LIMITED.id));
    for (const path of [`/v1/workspaces/${id}/outputs`, `/v1/workspaces/${id}/outputs/${output}/versions`]) {
      const refused = await api(LIMITED, "GET", path);
      expect([refused.code, refused.body.outputs, refused.body.versions], path).toEqual(["workspace_not_found", undefined, undefined]);
    }
  });

  it("orders versions by when they were recorded, even within one millisecond", async () => {
    const id = await room();
    const output = await define(id);
    // Recorded second, with a lower submission number and the same time, so only the record order puts it first.
    await inRoom(id, (sql) => {
      sql.exec("INSERT INTO expected_output_version (output_id, task_id, submission_no, approved_at, approved_by) VALUES (?, 'tsk_gone', 2, 1000, ?)", output, OWNER.id);
      sql.exec("INSERT INTO expected_output_version (output_id, task_id, submission_no, approved_at, approved_by) VALUES (?, 'tsk_gone', 1, 1000, ?)", output, OWNER.id);
    });
    expect((await versions(OWNER, id, output)).map((v) => v.submission_no)).toEqual([1, 2]);
  });

  it("returns at most 200, newest first, and says when there were more", async () => {
    const id = await room();
    const output = await define(id);
    await inRoom(id, (sql) => {
      for (let n = 1; n <= 201; n++) sql.exec("INSERT INTO expected_output_version (output_id, task_id, submission_no, approved_at, approved_by) VALUES (?, 'tsk_gone', ?, ?, ?)", output, n, 1000 + n, OWNER.id);
    });
    const r = await api(OWNER, "GET", `/v1/workspaces/${id}/outputs/${output}/versions`);
    expect(r.status).toBe(200);
    expect(r.body.complete).toBe(false);
    expect(r.body.versions).toHaveLength(200);
    expect(r.body.versions[0].submission_no).toBe(201);
    expect(r.body.versions[199].submission_no).toBe(2);
    // A version whose task no longer exists names nothing.
    expect(Object.keys(r.body.versions[0]).sort()).toEqual(["approved_at", "submission_no"]);
  });
});
