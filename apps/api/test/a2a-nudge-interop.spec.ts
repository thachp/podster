import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm.ts";

// M7 step 15 (R-17), Podster's half: the API's real nudge send (`a2a_out::send_nudge`) and challenge, against an independent
// A2A 1.0 server, the A2A project's own @a2a-js/sdk 1.3.0 behind its own Express JSON-RPC handler (test/a2a-sdk-endpoint.ts,
// started by vitest.config.ts on 127.0.0.1). Every answer Podster reads here is the SDK's, apart from the endpoint owner's
// glue that answers Podster's own extension method. ADR 0007, "Nudge interoperability (M7 step 15)", records what this
// shows, and the deviations.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const ORG = "org_interop";
const OWNER: Who = { id: "per_interop_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const LEAD: Who = { id: "agt_interop_lead", org: ORG };
const HOST = "a2a-sdk.example.com";
const TITLE = "Draft the interop brief";
const INSTRUCTIONS = "Two paragraphs on the private plan.";

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
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `interop-key-${++counter}`;
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

const version = async (room: string) => (await must(OWNER, "GET", `/v1/workspaces/${room}`)).policy_version;
const join = async (room: string, agent: Who, role = "member") =>
  must(OWNER, "POST", `/v1/workspaces/${room}/members`, { principal_id: agent.id, kind: "agent", org_id: agent.org, role, policy_version: await version(room) });

const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)));
});
async function newRoom() {
  const room = (await must(OWNER, "POST", "/v1/workspaces", { name: `Interop ${++counter}` })).id as string;
  madeRooms.push(room);
  await manualAlarms(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(room)));
  await join(room, LEAD);
  return room;
}

/** What the endpoint at `path` holds: the signing secret it was shown, and the bearer token it requires, if any. */
const hold = (path: string, secret: string, token: string | null = null) =>
  fetch("https://a2a-sdk-control.example.com/hold", { method: "POST", body: JSON.stringify({ path, secret, token }) });
/** Each message the SDK parsed and handed its agent, as the SDK typed it. */
const received = async () => (await (await fetch("https://a2a-sdk-control.example.com/received")).json()) as { server: string; message: any }[];
const hookLog = async () => (await (await fetch("https://hook-log.example.com/")).json()) as any[];
const sentTo = async (url: string) => (await hookLog()).filter((r) => `https://${r.host}${r.path}` === url);

/** A fresh agent in `room` whose nudge endpoint is one of the SDK's servers, as Runner would set it. */
async function target(room: string, server: "plain" | "ext" | "old", token: string | null = null) {
  const agent: Who = { id: `agt_interop_${++counter}_${crypto.randomUUID().slice(0, 6)}`, org: ORG };
  await must(OWNER, "PUT", `/v1/agents/${agent.id}`, { org_id: ORG, name: agent.id });
  await join(room, agent, "guest");
  const path = `/${server}/${++counter}`;
  const url = `https://${HOST}${path}`;
  const set = await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url, delivery: "nudge", ...(token ? { token } : {}) });
  await hold(path, set.signing_secret, token);
  return { agent, url, path, secret: set.signing_secret as string, version: set.version as number };
}
const verify = (agent: Who) => api(agent, "POST", "/v1/inbox/a2a-endpoint/verify", {});
async function switchedOn(t: { agent: Who; version: number }) {
  expect((await verify(t.agent)).body).toMatchObject({ verified: true });
  expect((await api(OWNER, "PUT", `/v1/agents/${t.agent.id}/a2a-endpoint/nudge`, { on: true, version: t.version })).status).toBe(200);
}

const offer = async (room: string, assignee: string) => must(LEAD, "POST", `/v1/workspaces/${room}/tasks`, { title: TITLE, instructions: INSTRUCTIONS, assignee });
const roomSql = (room: string, query: string, ...args: unknown[]) =>
  runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(room)), (_: any, state: any) => state.storage.sql.exec(query, ...args).toArray());
const attempts = (room: string, task: string) => roomSql(room, "SELECT * FROM a2a_attempt WHERE task_id = ? ORDER BY created_at", task) as Promise<any[]>;
const consume = async (room: string, attempt: any) => {
  const res = await SELF.fetch("https://api.internal/test/consume-a2a", { method: "POST", body: JSON.stringify({ ws: room, attempt: attempt.id, agent: attempt.agent_id }) });
  return (await res.json() as any).outcome;
};
const endpointStatus = async (agent: Who) => must(agent, "GET", "/v1/inbox/a2a-endpoint");
const polled = async (room: string, agent: Who, task: string) => (await must(agent, "GET", `/v1/workspaces/${room}/tasks/${task}`)).task;

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  await must(OWNER, "PUT", `/v1/agents/${LEAD.id}`, { org_id: ORG, name: LEAD.id });
});

describe("Podster's nudge, sent to the A2A project's own 1.0 server", () => {
  it("is taken as a valid 1.0 SendMessage: the SDK parses one data part with the IDs, and its Message answer counts as taken", async () => {
    const room = await newRoom();
    const t = await target(room, "ext");
    await switchedOn(t);
    const task = await offer(room, t.agent.id);
    const [attempt] = await attempts(room, task.id);
    expect(await consume(room, attempt)).toBe("ack");
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "sent", remote_task_id: null, endpoint_url: t.url });
    expect(await endpointStatus(t.agent)).toMatchObject({ enabled: true, consecutive_failures: 0 });

    // What the SDK made of it, by its own 1.0 types: a user message, one data part, the IDs and Podster's metadata.
    const got = (await received()).filter((r) => r.message.messageId === attempt.id);
    expect(got).toHaveLength(1);
    const { server, message } = got[0];
    expect(server).toBe("ext");
    expect(message.role).toBe(1); // Role.ROLE_USER
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0].content).toEqual({ $case: "data", value: { kind: "podster.dev/nudge", workspace_id: room, task_id: task.id, attempt_id: attempt.id, attempt_kind: "offer" } });
    expect(message.parts[0].mediaType).toBe("application/json");
    expect(message.metadata).toEqual({ "podster.dev/task": `${room}:${task.id}`, "podster.dev/attempt": attempt.id, "podster.dev/delivery": "nudge" });

    // On the wire: one challenge and one nudge, both POSTs to the registered URL with A2A-Version 1.0. No Agent Card was
    // fetched: A2A lets a client be configured with the endpoint directly, and decision 120 has Podster fetch none.
    const wire = await sentTo(t.url);
    expect(wire.map((r) => JSON.parse(r.body).method)).toEqual(["podster.dev/verifyEndpoint", "SendMessage"]);
    expect(wire.every((r) => r.a2aVersion === "1.0")).toBe(true);
    expect((await hookLog()).filter((r) => r.host === HOST && !r.path.startsWith("/ext/") && !r.path.startsWith("/plain/") && !r.path.startsWith("/old/"))).toEqual([]);
    for (const r of wire) expect(r.body).not.toMatch(/interop brief|private plan/);
  });

  it("carries the endpoint's bearer token as A2A's HTTP bearer scheme, and a server that refuses it with 401 isn't counted as taken", async () => {
    const room = await newRoom();
    const t = await target(room, "ext", "tok_interop_good");
    await switchedOn(t);
    const task = await offer(room, t.agent.id);
    const [attempt] = await attempts(room, task.id);
    expect(await consume(room, attempt)).toBe("ack");
    const [nudge] = (await sentTo(t.url)).filter((r) => JSON.parse(r.body).method === "SendMessage");
    expect(nudge.authorization).toBe("Bearer tok_interop_good");

    // The server now wants another token: its 401 is a failure, retried with backoff, and the offer stays for polling.
    await hold(t.path, t.secret, "tok_interop_other");
    const second = await offer(room, t.agent.id);
    const [next] = await attempts(room, second.id);
    expect(await consume(room, next)).toEqual({ retry: 60 });
    expect((await received()).filter((r) => r.message.messageId === next.id)).toEqual([]);
    expect(await endpointStatus(t.agent)).toMatchObject({ enabled: true, consecutive_failures: 1 });
    expect((await polled(room, t.agent, second.id)).status).toBe("offered");
  });

  it("isn't taken when the SDK itself answers a JSON-RPC error: a server that offers only A2A 0.3 refuses 1.0 with VersionNotSupportedError", async () => {
    const room = await newRoom();
    const t = await target(room, "old");
    await switchedOn(t);
    const task = await offer(room, t.agent.id);
    const [attempt] = await attempts(room, task.id);
    expect(await consume(room, attempt)).toEqual({ retry: 60 });
    expect((await received()).filter((r) => r.message.messageId === attempt.id)).toEqual([]);
    expect(await endpointStatus(t.agent)).toMatchObject({ consecutive_failures: 1 });
    expect((await attempts(room, task.id))[0].state).not.toBe("sent");
    expect((await polled(room, t.agent, task.id)).status).toBe("offered");
  });

  it("can't be sent to a plain A2A server, which can't prove control: the SDK answers the challenge with method not found", async () => {
    const room = await newRoom();
    const t = await target(room, "plain");
    const tried = await verify(t.agent);
    expect(tried.status).toBe(200);
    expect(tried.body).toMatchObject({ verified: false, control: "unverified" });
    const [challenge] = await sentTo(t.url);
    expect(JSON.parse(challenge.body).method).toBe("podster.dev/verifyEndpoint");
    // The SDK's own answer to that request, sent again as Podster sent it: JSON-RPC method not found, so no proof.
    const again = await fetch(t.url, { method: "POST", headers: { "content-type": "application/json", "a2a-version": "1.0", "x-podster-signature": challenge.signature }, body: challenge.body });
    const answer = (await again.json()) as any;
    expect([again.status, answer.error?.code, answer.result]).toEqual([200, -32601, undefined]);
    // So the owner can't switch it on, and an offer sends nothing; polling still finds it.
    expect((await api(OWNER, "PUT", `/v1/agents/${t.agent.id}/a2a-endpoint/nudge`, { on: true, version: t.version })).code).toBe("endpoint_unverified");
    const task = await offer(room, t.agent.id);
    const [attempt] = await attempts(room, task.id);
    expect(await consume(room, attempt)).toBe("ack");
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "stopped", ended_reason: "endpoint_unverified" });
    expect((await sentTo(t.url)).filter((r) => JSON.parse(r.body).method === "SendMessage")).toEqual([]);
    expect((await polled(room, t.agent, task.id)).status).toBe("offered");
  });
});
