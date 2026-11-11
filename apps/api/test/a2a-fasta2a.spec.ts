import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { alarmPass } from "./alarm.ts";

// Decision 143's backup independent server: Podster's real send, read-back, change-request and cancel code, in workerd, against
// pydantic's fasta2a (2.1.1) with the trivial agent in e2e/fasta2a. Only e2e/run-fasta2a-check.mjs starts it and sets
// TEST_FASTA2A_RUN_SECONDS, the agent's run time. Otherwise this skips. Every answer is fasta2a's own.
//
// fasta2a honors the A2A flow Podster expects: SendMessage answers SUBMITTED at once, a read during the run sees WORKING, and a
// later one COMPLETED with a text artifact. So this is the usual path, not decision 174's.

const BINDINGS = env as any;
const RUN_SECONDS = Number(BINDINGS.TEST_FASTA2A_RUN_SECONDS || 0);
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const ORG = "org_fa";
const OWNER: Who = { id: "per_fa_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const LEAD: Who = { id: "agt_fa_lead", org: ORG };

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
  if (method !== "GET") headers["idempotency-key"] = `fa-key-${++counter}`;
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
  await alarmPass(roomStub(room));
}
/** Makes the next read due, has the alarm queue it, and runs it: one real GetTask to fasta2a. */
async function readOnce(room: string, attemptId: string) {
  await roomSql(room, "UPDATE a2a_attempt SET next_read_at = 0 WHERE id = ? AND read_queued = 0", attemptId);
  await fireAlarm(room);
  const queued = await row(room, attemptId);
  expect(queued.read_queued, "the read was queued").toBe(1);
  return job({ ws: room, attempt: attemptId, agent: queued.agent_id, kind: "read", read: queued.read_no });
}
/** Long enough for the agent's run to end. */
const waitForRun = () => new Promise((done) => setTimeout(done, RUN_SECONDS * 1000 + 700));

/** A room with the lead, and an agent whose endpoint is fasta2a's, offered a task whose send has gone out. */
async function sentToFasta2a() {
  const room = (await must(OWNER, "POST", "/v1/workspaces", { name: `fasta2a ${++counter}` })).id as string;
  const join = async (agent: Who, role: string) => {
    const version = (await must(OWNER, "GET", `/v1/workspaces/${room}`)).policy_version;
    await must(OWNER, "POST", `/v1/workspaces/${room}/members`, { principal_id: agent.id, kind: "agent", org_id: agent.org, role, policy_version: version });
  };
  await join(LEAD, "member");
  const agent: Who = { id: `agt_fa_${++counter}_${crypto.randomUUID().slice(0, 6)}`, org: ORG };
  await must(OWNER, "PUT", `/v1/agents/${agent.id}`, { org_id: ORG, name: agent.id });
  await join(agent, "guest");
  await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url: "https://fasta2a.example.com/", token: "tok_fa_test" });
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

describe.skipIf(!RUN_SECONDS)("outbound against fasta2a's A2A server", () => {
  it("sends an offer fasta2a takes as a SUBMITTED task, and records its task and context", async () => {
    const { attempt } = await sentToFasta2a();
    expect(attempt).toMatchObject({ state: "sent", last_state: null, reading_ended: 0 });
    expect(attempt.remote_task_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(attempt.remote_context_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reads WORKING as an accept and COMPLETED as a submission with the agent's artifact, then a change request in the same context comes back as submission 2", async () => {
    const { room, agent, task, attempt } = await sentToFasta2a();
    expect(await readOnce(room, attempt.id)).toBe("ack");
    expect(await row(room, attempt.id)).toMatchObject({ last_state: "TASK_STATE_WORKING", working_seen: 1 });
    expect((await taskRow(room, task.id)).status).toBe("accepted");
    await waitForRun();
    expect(await readOnce(room, attempt.id)).toBe("ack");
    expect((await taskRow(room, task.id)).status).toBe("submitted");
    const [first] = await roomSql(room, "SELECT note, submitted_by FROM submission WHERE task_id = ? AND submission_no = 1", task.id);
    expect(first).toMatchObject({ submitted_by: agent.id });
    expect(first.note).toMatch(/^fasta2a test agent: turn 1, received \d+ characters\.$/);
    expect(await roomSql(room, "SELECT type, origin FROM event WHERE task_id = ? AND type IN ('task.accepted', 'task.submitted') ORDER BY seq", task.id)).toEqual([
      { type: "task.accepted", origin: "a2a_remote" },
      { type: "task.submitted", origin: "a2a_remote" },
    ]);

    await must(LEAD, "POST", `/v1/workspaces/${room}/tasks/${task.id}/request-changes`, { submission_no: 1, reason: "Add the dates, please." });
    const change = (await attempts(room, task.id)).find((a) => a.kind === "change_request");
    expect(change).toMatchObject({ reference_task_id: attempt.remote_task_id, reference_context_id: attempt.remote_context_id });
    expect(await job({ ws: room, attempt: change.id, agent: agent.id })).toBe("ack");
    const sent = await row(room, change.id);
    expect(sent).toMatchObject({ state: "sent", remote_context_id: attempt.remote_context_id });
    expect(sent.remote_task_id).not.toBe(attempt.remote_task_id);
    expect(await readOnce(room, change.id)).toBe("ack");
    await waitForRun();
    expect(await readOnce(room, change.id)).toBe("ack");
    expect((await taskRow(room, task.id)).status).toBe("submitted");
    const [second] = await roomSql(room, "SELECT note FROM submission WHERE task_id = ? AND submission_no = 2", task.id);
    // The same context: fasta2a counts this as the agent's second turn.
    expect(second.note).toMatch(/^fasta2a test agent: turn 2, /);
    await must(LEAD, "POST", `/v1/workspaces/${room}/tasks/${task.id}/verify`, { submission_no: 2 });
    expect((await taskRow(room, task.id)).status).toBe("completed");
  });

  it("sends CancelTask once to a task fasta2a is still working on, which it cancels", async () => {
    const { room, task, attempt } = await sentToFasta2a();
    expect(await readOnce(room, attempt.id)).toBe("ack");
    const accepted = await taskRow(room, task.id);
    expect(accepted.status).toBe("accepted");
    await must(LEAD, "POST", `/v1/workspaces/${room}/tasks/${task.id}/cancel`, { version: accepted.version, reason: "Not needed." });
    await fireAlarm(room);
    expect((await row(room, attempt.id)).cancel_state).toBe("queued");
    expect(await job({ ws: room, attempt: attempt.id, agent: attempt.agent_id, kind: "cancel" })).toBe("ack");
    expect((await row(room, attempt.id)).cancel_state).toBe("sent");
    expect((await taskRow(room, task.id)).status).toBe("canceled");
  });
});
