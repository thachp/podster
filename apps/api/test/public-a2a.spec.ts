import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// M4 step 13, M4-17 (criterion 4 across protocols): in one public room, a public participant takes an offer and submits over
// A2A, and another takes one and submits through the API an MCP client calls. Each task has one history, and redelivered
// sends and reads add nothing to it.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; linker?: string };
const ORG = "org_pa2a";
const OWNER: Who = { id: "per_pa2a_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const LEAD: Who = { id: "agt_pa2a_lead", org: ORG };
const HOST = "a2a-public.example.com";
const orgAdmin = (org: string): Who => ({ id: `per_pa2a_admin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  const facts = isAgent
    ? { gen: 1, linker: { person: who.linker ?? `per_linker_${who.id}`, since: 1 } }
    : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } };
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...facts })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json", "x-test-public-rooms": "on" };
  if (method !== "GET") headers["idempotency-key"] = `pa2a-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, text };
}
const must = async (who: Who, method: string, path: string, body?: unknown) => {
  const res = await api(who, method, path, body);
  expect(res.status, `${method} ${path}: ${res.text}`).toBe(200);
  return res.body;
};

const stub = (room: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(room));
const roomSql = (room: string, query: string, ...args: unknown[]) => runInDurableObject(stub(room), (_: any, state: any) => state.storage.sql.exec(query, ...args).toArray()) as Promise<any[]>;
const version = async (room: string) => (await must(OWNER, "GET", `/v1/workspaces/${room}`)).policy_version;
const drain = async (room: string) => {
  for (let n = 0; n < 5; n++) await runDurableObjectAlarm(stub(room));
};

/** A fresh agent of its own organization, registered, with its owner allowing public claims. */
async function claimant(): Promise<Who> {
  const who: Who = { id: `agt_pa2a_${++counter}_${crypto.randomUUID().slice(0, 6)}`, org: `org_pa2a_${counter}` };
  await must(orgAdmin(who.org), "PUT", `/v1/agents/${who.id}`, { org_id: who.org, name: who.id });
  await must(orgAdmin(who.org), "PUT", `/v1/agents/${who.id}/participation-policy`, { policy: "public_claims" });
  return who;
}

/** A public room, with a lead agent who offers tasks and an opening anyone's agent can claim publicly. */
async function publicRoom() {
  const room = (await must(OWNER, "POST", "/v1/workspaces", { name: `Public A2A ${++counter}` })).id as string;
  await must(OWNER, "PUT", `/v1/agents/${LEAD.id}`, { org_id: ORG, name: LEAD.id });
  await must(OWNER, "POST", `/v1/workspaces/${room}/members`, { principal_id: LEAD.id, kind: "agent", org_id: ORG, role: "member", policy_version: await version(room) });
  await must(OWNER, "PUT", `/v1/workspaces/${room}/review-policy`, { require_person: true, policy_version: await version(room) });
  const opening = await must(OWNER, "POST", `/v1/workspaces/${room}/roles`, { title: "Writer", responsibilities: "Write briefs", preset: "public_participant", capacity: 5, publicly_claimable: true, policy_version: await version(room) });
  const hash = (await must(OWNER, "GET", `/v1/workspaces/${room}/visibility`)).view_hash;
  const published = await must(OWNER, "PUT", `/v1/workspaces/${room}/visibility`, { visibility: "public", view_hash: hash });
  await drain(room);
  return { room, handle: published.public_handle as string, opening: opening.id as string };
}

const attempts = (room: string, task: string) => roomSql(room, "SELECT * FROM a2a_attempt WHERE task_id = ? ORDER BY created_at", task);
const consume = async (room: string, attempt: any) => {
  const res = await SELF.fetch("https://api.internal/test/consume-a2a", { method: "POST", body: JSON.stringify({ ws: room, attempt: attempt.id, agent: attempt.agent_id }) });
  return { status: res.status, body: (await res.json()) as any };
};
const script = (remote: string, answers: unknown[]) => fetch("https://a2a-script.example.com/", { method: "POST", body: JSON.stringify({ key: remote, answers }) });
const remoteTask = (id: string, state: string, extra: Record<string, unknown> = {}) => ({ id, contextId: "c", ...extra, status: { state } });
const sentTo = async (url: string) => ((await (await fetch("https://hook-log.example.com/")).json()) as any[]).filter((r) => `https://${r.host}${r.path}` === url).map((r) => JSON.parse(r.body));
const row = async (room: string, id: string) => (await roomSql(room, "SELECT * FROM a2a_attempt WHERE id = ?", id))[0];
/** Makes the next read due, has the room's alarm queue it, then runs that read job. Returns the read's number to redeliver. */
async function readOnce(room: string, attemptId: string) {
  await roomSql(room, "UPDATE a2a_attempt SET next_read_at = 0 WHERE id = ? AND read_queued = 0", attemptId);
  await runInDurableObject(stub(room), (_: any, state: any) => state.storage.setAlarm(Date.now() + 60_000));
  await runDurableObjectAlarm(stub(room));
  const queued = await row(room, attemptId);
  expect(queued.read_queued, "the read was queued").toBe(1);
  return redeliverRead(room, queued);
}
const redeliverRead = async (room: string, queued: any) => {
  const res = await SELF.fetch("https://api.internal/test/consume-a2a", { method: "POST", body: JSON.stringify({ ws: room, attempt: queued.id, agent: queued.agent_id, kind: "read", read: queued.read_no }) });
  return { status: res.status, body: (await res.json()) as any, queued };
};
const history = async (room: string, task: string) => (await must(LEAD, "GET", `/v1/workspaces/${room}/tasks/${task}`)).history as any[];
const count = (entries: any[], type: string) => entries.filter((e) => e.type === type).length;

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("both protocols in one public room (M4-17)", () => {
  it("one public participant works over A2A and another through the API, each task with one history", async () => {
    const { room, handle, opening } = await publicRoom();
    const overA2a = await claimant();
    const overApi = await claimant();
    for (const who of [overA2a, overApi]) {
      const claimed = await api(who, "POST", `/v1/public/workrooms/${handle}/claim`, { role_id: opening });
      expect(claimed.status, claimed.text).toBe(200);
    }
    const members = await roomSql(room, "SELECT principal_id, role, joined_via FROM member WHERE principal_id IN (?, ?)", overA2a.id, overApi.id);
    expect(members).toHaveLength(2);
    expect(members.every((m) => m.role === "guest" && m.joined_via === "public")).toBe(true);

    // The A2A participant sets its own endpoint, as any connected agent can.
    const url = `https://${HOST}/a2a/public-${counter}`;
    await must(overA2a, "PUT", "/v1/inbox/a2a-endpoint", { url });

    // An offer to it goes out once over A2A, however often the job is delivered.
    const a2aTask = await must(LEAD, "POST", `/v1/workspaces/${room}/tasks`, { title: "Draft the brief", instructions: "Two paragraphs.", acceptance_criteria: "Mentions the dates.", assignee: overA2a.id, reviewer: OWNER.id });
    const [attempt] = await attempts(room, a2aTask.id);
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    expect((await consume(room, attempt)).status).toBe(200);
    const sends = (await sentTo(url)).filter((b) => b.method === "SendMessage");
    expect(sends).toHaveLength(1);
    const [sent] = await attempts(room, a2aTask.id);
    expect(sent.state).toBe("sent");
    const remote = sent.remote_task_id as string;

    // Its remote task is read back: WORKING accepts, COMPLETED submits, each as the agent itself, marked a2a_remote.
    await script(remote, [remoteTask(remote, "TASK_STATE_WORKING"), remoteTask(remote, "TASK_STATE_COMPLETED", { artifacts: [{ name: "Brief", parts: [{ text: "Here's the brief." }] }] })]);
    const getTasks = async () => (await sentTo(url)).filter((b) => b.method === "GetTask").length;
    /** Delivers a read job again, and checks it asked nothing and changed nothing. */
    const redeliveredDoesNothing = async (queued: any) => {
      const [asked, before] = [await getTasks(), await history(room, a2aTask.id)];
      await redeliverRead(room, queued);
      expect(await getTasks(), "no GetTask for a redelivered read").toBe(asked);
      expect(await history(room, a2aTask.id)).toEqual(before);
    };
    const first = await readOnce(room, sent.id);
    expect(first.body.outcome).toBe("ack");
    expect(await getTasks()).toBe(1);
    await redeliveredDoesNothing(first.queued);
    const second = await readOnce(room, sent.id);
    expect(second.body.outcome).toBe("ack");
    expect(await getTasks()).toBe(2);
    await redeliveredDoesNothing(second.queued);
    const a2aHistory = await history(room, a2aTask.id);
    expect(count(a2aHistory, "task.accepted")).toBe(1);
    expect(count(a2aHistory, "task.submitted")).toBe(1);
    expect(a2aHistory.find((e) => e.type === "task.accepted").origin).toBe("a2a_remote");
    expect(a2aHistory.find((e) => e.type === "task.submitted").origin).toBe("a2a_remote");
    expect(a2aHistory.find((e) => e.type === "task.accepted").actor_id).toBe(overA2a.id);
    expect(a2aHistory.find((e) => e.type === "task.submitted").actor_id).toBe(overA2a.id);
    const [submission] = await roomSql(room, "SELECT submitted_by, note FROM submission WHERE task_id = ?", a2aTask.id);
    expect(submission).toEqual({ submitted_by: overA2a.id, note: "Here's the brief." });

    // The other participant has no endpoint, so its offer's attempt stops with nothing sent, and it works through the API an
    // MCP client calls.
    const apiTask = await must(LEAD, "POST", `/v1/workspaces/${room}/tasks`, { title: "Check the dates", instructions: "List them.", acceptance_criteria: "Every date.", assignee: overApi.id, reviewer: OWNER.id });
    const [none] = await attempts(room, apiTask.id);
    expect((await consume(room, none)).body.outcome).toBe("ack");
    expect((await attempts(room, apiTask.id))[0]).toMatchObject({ state: "stopped", ended_reason: "no_endpoint" });
    const accepted = await must(overApi, "POST", `/v1/workspaces/${room}/tasks/${apiTask.id}/accept`, { version: 1 });
    await must(overApi, "POST", `/v1/workspaces/${room}/tasks/${apiTask.id}/submit`, { version: accepted.version, note: "Dates listed." });
    const apiHistory = await history(room, apiTask.id);
    expect(count(apiHistory, "task.accepted")).toBe(1);
    expect(count(apiHistory, "task.submitted")).toBe(1);
    expect(apiHistory.filter((e) => e.type.startsWith("task.")).every((e) => e.origin === null)).toBe(true);

    // Two tasks in the room, one per participant, and no competing ones from any redelivery.
    const tasks = await roomSql(room, "SELECT id, assignee_id, status FROM task ORDER BY created_at");
    expect(tasks.map((t) => [t.assignee_id, t.status])).toEqual([[overA2a.id, "submitted"], [overApi.id, "submitted"]]);
    // Each public participant sees only its own task.
    for (const [who, own] of [[overA2a, a2aTask.id], [overApi, apiTask.id]] as const) {
      const seen = await must(who, "GET", `/v1/workspaces/${room}/tasks`);
      expect(seen.tasks.map((t: any) => t.id), who.id).toEqual([own]);
    }
  });
});
