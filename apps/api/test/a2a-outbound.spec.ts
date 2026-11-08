import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// M3 step 12: outbound offers (ADR 0007, decisions 117, 118, 122 and 129). An offer to an agent records an attempt with the
// offer. The room's outbox puts it on the A2A queue with IDs only. The consumer asks the agent's Principal, then the room,
// and only then reads the text and sends `SendMessage` with `returnImmediately`, signed, with the token. Each attempt keeps
// the one remote task it was answered with, a retry is the same message, and repeated failures switch the endpoint off.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number; linker?: string; departure?: object };
const ORG = "org_out";
const OWNER: Who = { id: "per_out_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const LEAD: Who = { id: "agt_out_lead", org: ORG };
const TOKEN = "tok_out_secret.123";
const HOST = "a2a-out.example.com";

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  const facts = isAgent
    ? { gen: who.gen ?? 1, linker: { person: who.linker ?? OWNER.id, since: 1 } }
    : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 }, ...(who.departure ? { departure: who.departure } : {}) };
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...facts })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `out-key-${++counter}`;
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

const register = async (agent: Who) => must(OWNER, "PUT", `/v1/agents/${agent.id}`, { org_id: agent.org, name: agent.id });
const version = async (room: string) => (await must(OWNER, "GET", `/v1/workspaces/${room}`)).policy_version;
const join = async (room: string, agent: Who, role = "member") =>
  must(OWNER, "POST", `/v1/workspaces/${room}/members`, { principal_id: agent.id, kind: "agent", org_id: agent.org, role, policy_version: await version(room) });

async function newRoom() {
  const room = (await must(OWNER, "POST", "/v1/workspaces", { name: `Out ${++counter}` })).id as string;
  await join(room, LEAD);
  return room;
}
/** A fresh agent in `room` with an endpoint at `path` on HOST. Its endpoint's secret comes back so signatures can be checked. */
async function target(room: string, path = `/a2a/ok-${++counter}`, extra: Partial<Who> = {}) {
  const agent: Who = { id: `agt_out_${++counter}_${crypto.randomUUID().slice(0, 6)}`, org: ORG, ...extra };
  await register(agent);
  await join(room, agent, "guest");
  const url = `https://${HOST}${path}`;
  const set = await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url, token: TOKEN });
  return { agent, url, secret: set.signing_secret as string };
}
const offer = async (room: string, assignee: string, extra: Record<string, unknown> = {}) =>
  must(LEAD, "POST", `/v1/workspaces/${room}/tasks`, { title: "Draft the brief", instructions: "Two paragraphs on the plan.", acceptance_criteria: "Mentions the dates.", assignee, ...extra });

const roomStub = (room: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(room));
const roomSql = (room: string, query: string, ...args: unknown[]) =>
  runInDurableObject(roomStub(room), (_: any, state: any) => state.storage.sql.exec(query, ...args).toArray());
const attempts = (room: string, task: string) => roomSql(room, "SELECT * FROM a2a_attempt WHERE task_id = ? ORDER BY created_at", task) as Promise<any[]>;
const consume = async (room: string, attempt: any) => {
  const res = await SELF.fetch("https://api.internal/test/consume-a2a", { method: "POST", body: JSON.stringify({ ws: room, attempt: attempt.id, agent: attempt.agent_id }) });
  return { status: res.status, body: (await res.json()) as any };
};
const hookLog = async () => (await (await fetch("https://hook-log.example.com/")).json()) as any[];
const sentTo = async (url: string) => (await hookLog()).filter((r) => `https://${r.host}${r.path}` === url);

async function verifies(secret: string, header: string | null, body: string) {
  const [t, v1] = (header ?? "").split(",").map((part) => part.split("=")[1]);
  const mac = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = [...new Uint8Array(await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode(`${t}.${body}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return v1 === expected;
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  await register(LEAD);
});

describe("an offer to an agent", () => {
  it("records one attempt with the offer, in its transaction, and none for a person", async () => {
    const room = await newRoom();
    const { agent } = await target(room);
    const task = await offer(room, agent.id);
    const [attempt, ...more] = await attempts(room, task.id);
    expect(more).toEqual([]);
    expect(attempt).toMatchObject({ agent_id: agent.id, state: "queued", tries: 0, remote_task_id: null });
    expect(attempt.id).toMatch(/^att_[0-9a-f]{32}$/);
    const [offered] = await roomSql(room, "SELECT id FROM event WHERE task_id = ? AND type = 'task.offered'", task.id);
    expect(attempt.offer_id).toBe(offered.id);
    const toPerson = await offer(room, OWNER.id);
    expect(await attempts(room, toPerson.id)).toEqual([]);
    const open = await must(LEAD, "POST", `/v1/workspaces/${room}/tasks`, { title: "Open", instructions: "Anyone." });
    expect(await attempts(room, open.id)).toEqual([]);
  });

  it("goes on the A2A queue holding IDs only", async () => {
    const room = await newRoom();
    const { agent } = await target(room);
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    let job: any;
    for (let i = 0; i < 100 && !job; i++) {
      job = (await hookLog()).filter((r) => r.path === "/__queue").map((r) => JSON.parse(r.body)).find((b) => b.attempt === attempt.id);
      if (!job) await new Promise((done) => setTimeout(done, 50));
    }
    expect(job).toEqual({ ws: room, attempt: attempt.id, agent: agent.id });
    expect((await attempts(room, task.id))[0].queued).toBe(1);
  });
});

describe("sending", () => {
  it("sends SendMessage once, with returnImmediately, the text read now, signed, with the token, and keeps the remote task", async () => {
    const room = await newRoom();
    const { agent, url, secret } = await target(room);
    const task = await offer(room, agent.id);
    // Edited after the offer and before the send: the send carries what the task says now.
    await must(LEAD, "POST", `/v1/workspaces/${room}/tasks/${task.id}/update`, { version: task.version, instructions: "Three paragraphs, newly." });
    const [attempt] = await attempts(room, task.id);
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    const [request, ...again] = await sentTo(url);
    expect(again).toEqual([]);
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({ jsonrpc: "2.0", id: attempt.id, method: "SendMessage", params: { configuration: { returnImmediately: true } } });
    const message = body.params.message;
    expect(message).toMatchObject({ messageId: attempt.id, role: "ROLE_USER", metadata: { "podster.dev/task": `${room}:${task.id}`, "podster.dev/attempt": attempt.id } });
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0].text).toContain("# Draft the brief");
    expect(message.parts[0].text).toContain("Three paragraphs, newly.");
    expect(message.parts[0].text).not.toContain("Two paragraphs");
    expect(message.parts[0].text).toContain("Mentions the dates.");
    expect(message.parts[0].text).toContain(`/w/${room}/tasks`);
    expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.a2aVersion).toBe("1.0");
    expect(await verifies(secret, request.signature, request.body)).toBe(true);
    const [after] = await attempts(room, task.id);
    expect(after).toMatchObject({ state: "sent", remote_task_id: `remote-${url.split("/").pop()}`, endpoint_url: url, endpoint_version: 1, lease_until: null });
    // Redelivered: nothing more goes out.
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    expect(await sentTo(url)).toHaveLength(1);
  });

  it("counts a message with no task as sent, with no remote task to read", async () => {
    const room = await newRoom();
    const { agent } = await target(room, `/a2a/message-${++counter}`);
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    await consume(room, attempt);
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "sent", remote_task_id: null });
  });

  it("retries a failed send as the same message, and three failures switch the endpoint off", async () => {
    const room = await newRoom();
    const { agent, url } = await target(room, `/fail-${++counter}`);
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    for (let i = 0; i < 3; i++) expect((await consume(room, attempt)).body.outcome).toEqual({ retry: 1 });
    const sent = await sentTo(url);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((r) => JSON.parse(r.body).params.message.messageId))).toEqual(new Set([attempt.id]));
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "queued", tries: 3, endpoint_url: url, lease_until: null });
    expect((await must(agent, "GET", "/v1/inbox/a2a-endpoint")).enabled).toBe(false);
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    expect(await sentTo(url)).toHaveLength(3);
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "stopped", ended_reason: "switched_off" });
  });

  it("counts a redirect, a timeout, a JSON-RPC error, an oversized answer, a bad remote ID and an empty result as failures", async () => {
    const room = await newRoom();
    for (const path of ["/redirect", "/hang", "/a2a/error", "/a2a/big", "/a2a/bad-id", "/a2a/nothing"]) {
      const { agent } = await target(room, `${path}-${++counter}`);
      const task = await offer(room, agent.id);
      const [attempt] = await attempts(room, task.id);
      expect((await consume(room, attempt)).body.outcome, path).toEqual({ retry: 1 });
      expect((await attempts(room, task.id))[0], path).toMatchObject({ state: "queued", remote_task_id: null });
      expect((await must(agent, "GET", "/v1/inbox/a2a-endpoint")).consecutive_failures, path).toBe(1);
    }
    // The redirect wasn't followed.
    expect((await hookLog()).some((r) => r.host === "elsewhere.example.com")).toBe(false);
  });
});

describe("what sends nothing", () => {
  it("a task that moved on while queued: accepted, or declined and offered again", async () => {
    const room = await newRoom();
    const { agent, url } = await target(room);
    const task = await offer(room, agent.id);
    const [first] = await attempts(room, task.id);
    const accepted = await must(agent, "POST", `/v1/workspaces/${room}/tasks/${task.id}/accept`, { version: task.version });
    expect((await consume(room, first)).body.outcome).toBe("ack");
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "stopped", ended_reason: "offer_moved_on" });
    const other = await offer(room, agent.id);
    const [old] = await attempts(room, other.id);
    const declined = await must(agent, "POST", `/v1/workspaces/${room}/tasks/${other.id}/decline`, { version: other.version, reason: "Not now." });
    await must(LEAD, "POST", `/v1/workspaces/${room}/tasks/${other.id}/assign`, { version: declined.version, assignee: agent.id });
    const both = await attempts(room, other.id);
    expect(both).toHaveLength(2);
    expect((await consume(room, old)).body.outcome).toBe("ack");
    expect((await attempts(room, other.id))[0]).toMatchObject({ id: old.id, state: "stopped", ended_reason: "offer_moved_on" });
    expect(await sentTo(url)).toEqual([]);
    expect((await consume(room, both[1])).body.outcome).toBe("ack");
    expect(await sentTo(url)).toHaveLength(1);
    expect(accepted.status).toBe("accepted");
  });

  it("an agent removed from the room, disconnected, or with no endpoint", async () => {
    const room = await newRoom();
    const removed = await target(room);
    const removedTask = await offer(room, removed.agent.id);
    await must(OWNER, "DELETE", `/v1/workspaces/${room}/members/${removed.agent.id}`, { policy_version: await version(room) });
    const [a] = await attempts(room, removedTask.id);
    expect((await consume(room, a)).body.outcome).toBe("ack");
    expect((await attempts(room, removedTask.id))[0]).toMatchObject({ state: "stopped", ended_reason: "no_access" });

    const gone = await target(room);
    const goneTask = await offer(room, gone.agent.id);
    await must(OWNER, "POST", `/v1/agents/${gone.agent.id}/disconnect`, {});
    const [b] = await attempts(room, goneTask.id);
    expect((await consume(room, b)).body.outcome).toBe("ack");
    expect((await attempts(room, goneTask.id))[0].state).toBe("stopped");

    const bare = await target(room);
    await must(bare.agent, "DELETE", "/v1/inbox/a2a-endpoint");
    const bareTask = await offer(room, bare.agent.id);
    const [c] = await attempts(room, bareTask.id);
    expect((await consume(room, c)).body.outcome).toBe("ack");
    expect((await attempts(room, bareTask.id))[0]).toMatchObject({ state: "stopped", ended_reason: "no_endpoint" });
    for (const t of [removed, gone, bare]) expect(await sentTo(t.url), t.url).toEqual([]);
  });

  it("an archived room", async () => {
    const room = await newRoom();
    const { agent, url } = await target(room);
    const task = await offer(room, agent.id);
    await must(OWNER, "POST", `/v1/workspaces/${room}/archive`, { policy_version: await version(room) });
    const [attempt] = await attempts(room, task.id);
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "stopped", ended_reason: "room_archived" });
    expect(await sentTo(url)).toEqual([]);
  });

  it("an endpoint whose setter has left the organization, which is then deleted", async () => {
    const room = await newRoom();
    const linker: Who = { id: `per_out_linker_${++counter}`, kind: "person", org: ORG, adminOrgs: [] };
    const { agent, url } = await target(room, undefined, { linker: linker.id });
    const task = await offer(room, agent.id);
    // The gateway's own removal says so, as it does when a member is removed.
    await must({ ...linker, departure: { person: linker.id, org: ORG, left_at: Date.now() } }, "POST", "/v1/org-departures", {});
    const [attempt] = await attempts(room, task.id);
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "stopped", ended_reason: "setter_departed" });
    expect(await must(agent, "GET", "/v1/inbox/a2a-endpoint")).toBeNull();
    expect(await sentTo(url)).toEqual([]);
  });

  it("a send whose departure check can't be answered, which is retried and sends nothing", async () => {
    const room = await newRoom();
    const { agent, url } = await target(room, undefined, { linker: `per_unavailable_${++counter}` });
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    expect((await consume(room, attempt)).status).toBe(500);
    expect(await sentTo(url)).toEqual([]);
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "queued", tries: 0 });
    expect((await must(agent, "GET", "/v1/inbox/a2a-endpoint")).url).toBe(url);
  });

  it("an endpoint set before anyone was recorded as its setter", async () => {
    const room = await newRoom();
    const { agent, url } = await target(room);
    const principal = BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(agent.id));
    await runInDurableObject(principal, (_: any, state: any) => state.storage.sql.exec("UPDATE a2a_endpoint SET set_by = NULL"));
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "stopped", ended_reason: "setter_unknown" });
    expect(await sentTo(url)).toEqual([]);
  });

  it("an attempt another delivery is sending, until its lease ends", async () => {
    const room = await newRoom();
    const { agent, url } = await target(room);
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    await roomSql(room, "UPDATE a2a_attempt SET lease_until = ? WHERE id = ?", Date.now() + 60_000, attempt.id);
    expect((await consume(room, attempt)).body.outcome).toEqual({ retry: 1 });
    expect(await sentTo(url)).toEqual([]);
    await roomSql(room, "UPDATE a2a_attempt SET lease_until = ? WHERE id = ?", Date.now() - 1, attempt.id);
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    expect(await sentTo(url)).toHaveLength(1);
  });

  it("a job for another agent's attempt, or a malformed one", async () => {
    const room = await newRoom();
    const { agent, url } = await target(room);
    const other = await target(room);
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    expect((await consume(room, { ...attempt, agent_id: other.agent.id })).body.outcome).toBe("ack");
    expect((await consume(room, { id: "bad id", agent_id: agent.id })).body.outcome).toBe("ack");
    expect(await sentTo(url)).toEqual([]);
    expect(await sentTo(other.url)).toEqual([]);
    expect((await attempts(room, task.id))[0].state).toBe("queued");
  });

  it("records an answered send first, so a failure after it never sends the offer again", async () => {
    const room = await newRoom();
    const { agent, url } = await target(room);
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    const principal = BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(agent.id));
    await runInDurableObject(principal, (_: any, state: any) => state.storage.sql.exec("CREATE TABLE test_fail_report (x)"));
    expect((await consume(room, attempt)).status).toBe(500);
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "sent", remote_task_id: `remote-${url.split("/").pop()}` });
    // The lease has run out by the time the queue retries.
    await roomSql(room, "UPDATE a2a_attempt SET lease_until = NULL WHERE id = ?", attempt.id);
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    expect(await sentTo(url)).toHaveLength(1);
    expect((await must(agent, "GET", "/v1/inbox/a2a-endpoint")).consecutive_failures).toBe(0);
  });

  it("records the same answer again as nothing new, and refuses a different remote task", async () => {
    const room = await newRoom();
    const { agent, url } = await target(room);
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    await consume(room, attempt);
    const finish = (remote: string) => roomStub(room).fetch("https://workspace/internal/a2a-finish", {
      method: "POST",
      headers: { "x-podster-caller": JSON.stringify({ id: agent.id, kind: "agent", org: ORG, gen: 1, workspace_id: room }) },
      body: JSON.stringify({ attempt: attempt.id, outcome: "sent", remote_task_id: remote, url, version: 1 }),
    });
    expect((await finish(`remote-${url.split("/").pop()}`)).status).toBe(200);
    expect((await finish("remote-other")).status).toBe(409);
    expect((await attempts(room, task.id))[0].remote_task_id).toBe(`remote-${url.split("/").pop()}`);
  });
});

describe("the dead-letter queue", () => {
  const dead = async (body: object) => SELF.fetch("https://api.internal/test/dead-letter-a2a", { method: "POST", body: JSON.stringify(body) });

  it("ends a queued attempt as dead_lettered, and leaves a sent one", async () => {
    const room = await newRoom();
    const failing = await target(room, `/fail-${++counter}`);
    const t1 = await offer(room, failing.agent.id);
    const [a1] = await attempts(room, t1.id);
    await consume(room, a1);
    expect((await dead({ ws: room, attempt: a1.id, agent: a1.agent_id })).status).toBe(200);
    expect((await attempts(room, t1.id))[0]).toMatchObject({ state: "stopped", ended_reason: "dead_lettered" });
    expect((await dead({ ws: room, attempt: a1.id, agent: a1.agent_id })).status).toBe(200);
    const ok = await target(room);
    const t2 = await offer(room, ok.agent.id);
    const [a2] = await attempts(room, t2.id);
    await consume(room, a2);
    await dead({ ws: room, attempt: a2.id, agent: a2.agent_id });
    expect((await attempts(room, t2.id))[0].state).toBe("sent");
  });

  it("leaves a job whose room can't answer to be retried", async () => {
    const res = await dead({ ws: `ws_${"0".repeat(32)}`, attempt: `att_${"0".repeat(32)}`, agent: LEAD.id });
    expect(res.status).toBe(500);
  });
});
