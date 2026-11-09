import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// Decision 143's outbound run: Podster's real send, read-back, cancel and change-request code, in workerd, against LangGraph's
// own A2A 1.0 server (`langgraph-api` 0.17.1) with one trivial graph. Only e2e/run-langgraph-check.mjs starts that server and
// sets TEST_LANGGRAPH_ASSISTANT. Otherwise this skips. Nothing here is faked on the far side: every answer is LangGraph's.
//
// How the two fit, with decision 174 (2026-11-09):
// - LangGraph ignores `returnImmediately` and answers SendMessage once its run ends, already COMPLETED, with the graph's reply
//   as an artifact. Podster applies that answer as read 0. It never passed through WORKING, so decision 112 holds it, with
//   the reply, and reading ends.
// - The agent's accept then submits the held reply as the agent, marked a2a_remote.
// - A change request goes out as a new task in the same LangGraph thread. Its answer, already COMPLETED, is read 0 again,
//   and the task is accepted by then, so it's the second submission.
// - A task finished at read 0 is never sent CancelTask. Sent by hand to a finished run, LangGraph answers -32002, which
//   Podster records as refused (a2a-readback.spec.ts covers that path).
// LangGraph's GetTask carries no artifacts, so a later read would need decision 174's history follow-up. With read 0, none is
// needed here, and a2a-readback.spec.ts covers that follow-up.

const BINDINGS = env as any;
const ASSISTANT: string = BINDINGS.TEST_LANGGRAPH_ASSISTANT ?? "";
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const ORG = "org_lg";
const OWNER: Who = { id: "per_lg_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const LEAD: Who = { id: "agt_lg_lead", org: ORG };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const facts = (who.kind ?? "agent") === "agent"
    ? { gen: 1, linker: { person: OWNER.id, since: 1 } }
    : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } };
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...facts })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function must(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `lg-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  expect(res.status, `${method} ${path}: ${text}`).toBe(200);
  return text ? JSON.parse(text) : null;
}

const roomStub = (room: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(room));
const roomSql = (room: string, query: string, ...args: unknown[]) =>
  runInDurableObject(roomStub(room), (_: any, state: any) => state.storage.sql.exec(query, ...args).toArray()) as Promise<any[]>;
const attempts = (room: string, task: string) => roomSql(room, "SELECT * FROM a2a_attempt WHERE task_id = ? ORDER BY created_at", task);
const row = async (room: string, id: string) => (await roomSql(room, "SELECT * FROM a2a_attempt WHERE id = ?", id))[0];
const taskRow = async (room: string, id: string) => (await roomSql(room, "SELECT status, version FROM task WHERE id = ?", id))[0];
const job = async (body: Record<string, unknown>) => {
  const res = await SELF.fetch("https://api.internal/test/consume-a2a", { method: "POST", body: JSON.stringify(body) });
  return ((await res.json()) as any).outcome;
};
async function fireAlarm(room: string) {
  await runInDurableObject(roomStub(room), (_: any, state: any) => state.storage.setAlarm(Date.now() + 60_000));
  return runDurableObjectAlarm(roomStub(room));
}
/** A room with the lead, and an agent whose endpoint is LangGraph's, offered a task whose send has gone out. */
async function sentToLangGraph() {
  const room = (await must(OWNER, "POST", "/v1/workspaces", { name: `LangGraph ${++counter}` })).id as string;
  const join = async (agent: Who, role: string) => {
    const version = (await must(OWNER, "GET", `/v1/workspaces/${room}`)).policy_version;
    await must(OWNER, "POST", `/v1/workspaces/${room}/members`, { principal_id: agent.id, kind: "agent", org_id: agent.org, role, policy_version: version });
  };
  await join(LEAD, "member");
  const agent: Who = { id: `agt_lg_${++counter}_${crypto.randomUUID().slice(0, 6)}`, org: ORG };
  await must(OWNER, "PUT", `/v1/agents/${agent.id}`, { org_id: ORG, name: agent.id });
  await join(agent, "guest");
  await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url: `https://langgraph.example.com/a2a/${ASSISTANT}`, token: "tok_lg_test" });
  const task = await must(LEAD, "POST", `/v1/workspaces/${room}/tasks`, { title: "Draft the brief", instructions: "Two paragraphs on the plan.", assignee: agent.id });
  const [attempt] = await attempts(room, task.id);
  expect(await job({ ws: room, attempt: attempt.id, agent: agent.id })).toBe("ack");
  return { room, agent, task, attempt: await row(room, attempt.id) };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  await must(OWNER, "PUT", `/v1/agents/${LEAD.id}`, { org_id: ORG, name: LEAD.id });
});

describe.skipIf(!ASSISTANT)("outbound against LangGraph's A2A server", () => {
  it("sends an offer LangGraph takes as a task, and records its task and context", async () => {
    const { attempt } = await sentToLangGraph();
    expect(attempt.state).toBe("sent");
    // LangGraph's task ID is `<thread>:<run>`, and its contextId is the thread.
    expect(attempt.remote_task_id).toMatch(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/);
    expect(attempt.remote_context_id).toBe(attempt.remote_task_id.split(":")[0]);
  });

  it("applies LangGraph's already-finished send answer as read 0: held, with the graph's reply, since it never passed WORKING", async () => {
    const { room, task, attempt } = await sentToLangGraph();
    expect(await row(room, attempt.id)).toMatchObject({ last_read_no: 0, last_state: "TASK_STATE_COMPLETED", working_seen: 0, reading_ended: 1 });
    expect((await taskRow(room, task.id)).status).toBe("offered");
    const [held] = await roomSql(room, "SELECT read_no, note, working_seen FROM a2a_held WHERE attempt_id = ?", attempt.id);
    expect(held).toMatchObject({ read_no: 0, working_seen: 0 });
    expect(held.note).toMatch(/^LangGraph test graph: turn 1, received \d+ characters\.$/);
    expect(await roomSql(room, "SELECT count(*) AS n FROM event WHERE task_id = ? AND type = 'task.a2a_response_held'", task.id)).toEqual([{ n: 1 }]);
  });

  it("submits the held reply when the agent accepts, then a change request goes into the same thread and comes back as submission 2", async () => {
    const { room, agent, task, attempt } = await sentToLangGraph();
    const accepted = await must(agent, "POST", `/v1/workspaces/${room}/tasks/${task.id}/accept`, { version: task.version });
    expect(accepted.status).toBe("submitted");
    const [first] = await roomSql(room, "SELECT note, submitted_by FROM submission WHERE task_id = ? AND submission_no = 1", task.id);
    expect(first).toMatchObject({ submitted_by: agent.id });
    expect(first.note).toMatch(/^LangGraph test graph: turn 1, /);
    expect(await roomSql(room, "SELECT origin, origin_ref FROM event WHERE task_id = ? AND type = 'task.submitted'", task.id)).toEqual([{ origin: "a2a_remote", origin_ref: attempt.id }]);

    await must(LEAD, "POST", `/v1/workspaces/${room}/tasks/${task.id}/request-changes`, { submission_no: 1, reason: "Add the dates, please." });
    const change = (await attempts(room, task.id)).find((a) => a.kind === "change_request");
    expect(change).toMatchObject({ reference_task_id: attempt.remote_task_id, reference_context_id: attempt.remote_context_id });
    expect(await job({ ws: room, attempt: change.id, agent: agent.id })).toBe("ack");
    const sent = await row(room, change.id);
    // LangGraph made a new task in the same thread: a new run, the same context. Its answer was read 0 and submitted.
    expect(sent).toMatchObject({ state: "sent", remote_context_id: attempt.remote_context_id, last_read_no: 0, last_state: "TASK_STATE_COMPLETED" });
    expect(sent.remote_task_id).not.toBe(attempt.remote_task_id);
    expect((await taskRow(room, task.id)).status).toBe("submitted");
    const [second] = await roomSql(room, "SELECT note, submitted_by FROM submission WHERE task_id = ? AND submission_no = 2", task.id);
    expect(second).toMatchObject({ submitted_by: agent.id });
    expect(second.note).toMatch(/^LangGraph test graph: turn 2, /);
    await must(LEAD, "POST", `/v1/workspaces/${room}/tasks/${task.id}/verify`, { submission_no: 2 });
    expect((await taskRow(room, task.id)).status).toBe("completed");
  });

  it("sends no CancelTask for a LangGraph task already finished at read 0", async () => {
    const { room, task, attempt } = await sentToLangGraph();
    expect((await row(room, attempt.id)).reading_ended).toBe(1);
    await must(LEAD, "POST", `/v1/workspaces/${room}/tasks/${task.id}/cancel`, { version: task.version, reason: "Not needed." });
    await fireAlarm(room);
    // Only an attempt still being read has a remote task to cancel. This one finished before Podster's first read.
    expect((await row(room, attempt.id)).cancel_state).toBeNull();
    expect((await taskRow(room, task.id)).status).toBe("canceled");
  });
});
