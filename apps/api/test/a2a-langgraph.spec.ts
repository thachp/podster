import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// Decision 143's outbound run: Podster's real send, read-back, cancel and change-request code, in workerd, against LangGraph's
// own A2A 1.0 server (`langgraph-api` 0.17.1) with one trivial graph. Only e2e/run-langgraph-check.mjs starts that server and
// sets TEST_LANGGRAPH_ASSISTANT. Otherwise this skips. Nothing here is faked on the far side: every answer is LangGraph's.
//
// What it records is how the two fit, as found on 2026-11-09:
// - LangGraph ignores `returnImmediately` and answers SendMessage only once its run ends, already COMPLETED. Podster keeps
//   only the task's ID and context from that answer, so the first read sees COMPLETED with no WORKING before it, and decision
//   112 holds it as an unaccepted response.
// - LangGraph's GetTask carries no artifacts, only a fixed status message, so what the graph wrote never reaches Podster.
// - CancelTask on a finished run answers -32002, which Podster records as refused.
// - So no submission ever comes in over A2A, and a change request, which follows only one, never goes out. Sent by hand, a
//   change request continues the same LangGraph thread as a new task; e2e/langgraph/README.md records that probe.

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
/** Makes the next read due, has the alarm queue it, and runs it: one real GetTask to LangGraph. */
async function readOnce(room: string, attemptId: string) {
  await roomSql(room, "UPDATE a2a_attempt SET next_read_at = 0 WHERE id = ? AND read_queued = 0", attemptId);
  await fireAlarm(room);
  const queued = await row(room, attemptId);
  expect(queued.read_queued, "the read was queued").toBe(1);
  return job({ ws: room, attempt: attemptId, agent: queued.agent_id, kind: "read", read: queued.read_no });
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

  it("reads COMPLETED with no WORKING first, since LangGraph ran to the end before answering, and holds it (decision 112)", async () => {
    const { room, task, attempt } = await sentToLangGraph();
    expect(await readOnce(room, attempt.id)).toBe("ack");
    expect((await taskRow(room, task.id)).status).toBe("offered");
    expect(await row(room, attempt.id)).toMatchObject({ last_state: "TASK_STATE_COMPLETED", working_seen: 0, reading_ended: 1 });
    const [held] = await roomSql(room, "SELECT note, working_seen, links_json FROM a2a_held WHERE attempt_id = ?", attempt.id);
    // LangGraph's GetTask has no artifacts, so nothing the graph wrote is held: the gap this run found.
    expect(held).toMatchObject({ working_seen: 0, links_json: "[]" });
    expect(held.note ?? "").not.toContain("LangGraph test graph");
    expect(await roomSql(room, "SELECT count(*) AS n FROM event WHERE task_id = ? AND type = 'task.a2a_response_held'", task.id)).toEqual([{ n: 1 }]);
  });

  it("after the agent accepts, COMPLETED with nothing to submit is held, so no change request can follow", async () => {
    const { room, agent, task, attempt } = await sentToLangGraph();
    const accepted = await must(agent, "POST", `/v1/workspaces/${room}/tasks/${task.id}/accept`, { version: task.version });
    expect(await readOnce(room, attempt.id)).toBe("ack");
    // decide_remote says submit, but a submission needs a note or a link and LangGraph's read has neither, so the room refuses
    // it and holds the response instead.
    expect((await taskRow(room, task.id)).status).toBe("accepted");
    expect(await roomSql(room, "SELECT count(*) AS n FROM submission WHERE task_id = ?", task.id)).toEqual([{ n: 0 }]);
    expect(await roomSql(room, "SELECT type FROM event WHERE task_id = ? AND origin = 'a2a_remote'", task.id)).toEqual([{ type: "task.a2a_response_held" }]);

    // The agent submits by hand and the lead asks for changes. A change request goes out over A2A only for a submission that
    // came in over A2A (step 13b), so none goes to LangGraph: with LangGraph, Podster's change-request path can't be reached.
    await must(agent, "POST", `/v1/workspaces/${room}/tasks/${task.id}/submit`, { version: accepted.version, note: "Done by hand." });
    await must(LEAD, "POST", `/v1/workspaces/${room}/tasks/${task.id}/request-changes`, { submission_no: 1, reason: "Add the dates, please." });
    expect((await attempts(room, task.id)).filter((a) => a.kind === "change_request")).toEqual([]);
  });

  it("records LangGraph's refusal to cancel a finished run, and doesn't retry it", async () => {
    const { room, task, attempt } = await sentToLangGraph();
    await must(LEAD, "POST", `/v1/workspaces/${room}/tasks/${task.id}/cancel`, { version: task.version, reason: "Not needed." });
    await fireAlarm(room);
    expect((await row(room, attempt.id)).cancel_state).toBe("queued");
    expect(await job({ ws: room, attempt: attempt.id, agent: attempt.agent_id, kind: "cancel" })).toBe("ack");
    expect((await row(room, attempt.id)).cancel_state).toBe("refused");
  });
});
