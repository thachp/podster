import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm.ts";

// M7 step 13: the inbound nudge, server side (decision 236, RUNNER.md "Optional inbound A2A"). An agent's A2A endpoint can be
// set to deliver nudges: IDs only, through the same outbox, queue, egress rules and signing as ADR 0007's offers. It sends
// nothing until the endpoint has proved control, by answering a signed challenge with an HMAC under its own signing secret,
// and a person who administers the agent's organization has switched the nudge on for that exact registration. A new
// secret, a disconnect or that person leaving the organization ends it. The fake endpoint is the test runtime's.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number; linker?: string; departure?: object };
const ORG = "org_nudge";
const OWNER: Who = { id: "per_nudge_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const MEMBER: Who = { id: "per_nudge_member", kind: "person", org: ORG, adminOrgs: [] };
const STRANGER: Who = { id: "per_nudge_stranger", kind: "person", org: "org_nudge_other", adminOrgs: ["org_nudge_other"] };
const LEAD: Who = { id: "agt_nudge_lead", org: ORG };
const HOST = "runner-nudge.example.com";
const TITLE = "Draft the nudge brief";
const INSTRUCTIONS = "Two paragraphs on the secret plan.";
const CRITERIA = "Mentions the hidden dates.";

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
  if (method !== "GET") headers["idempotency-key"] = `nudge-key-${++counter}`;
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

const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)));
});

async function newRoom() {
  const room = (await must(OWNER, "POST", "/v1/workspaces", { name: `Nudge ${++counter}` })).id as string;
  madeRooms.push(room);
  await manualAlarms(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(room)));
  await join(room, LEAD);
  return room;
}

/** Tells the fake endpoint at `path` the secret it holds, as a Runner would keep the one it was shown. */
const holdSecret = async (path: string, secret: string) =>
  fetch("https://a2a-script.example.com/", { method: "POST", body: JSON.stringify({ key: `proof:${path}`, answers: [secret] }) });

/** A fresh agent in `room` with a nudge endpoint at `path`, set by the agent itself, as Runner would. */
async function nudgeTarget(room: string | null, path = `/nudge/ok-${++counter}`, extra: Partial<Who> = {}) {
  const agent: Who = { id: `agt_nudge_${++counter}_${crypto.randomUUID().slice(0, 6)}`, org: ORG, ...extra };
  await register(agent);
  if (room) await join(room, agent, "guest");
  const url = `https://${HOST}${path}`;
  const set = await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url, delivery: "nudge" });
  await holdSecret(path, set.signing_secret);
  return { agent, url, path, secret: set.signing_secret as string, version: set.version as number };
}
const verify = (who: Who, agent: Who) =>
  who.id === agent.id ? api(agent, "POST", "/v1/inbox/a2a-endpoint/verify", {}) : api(who, "POST", `/v1/agents/${agent.id}/a2a-endpoint/verify`, {});
const switchNudge = (who: Who, agent: Who, body: unknown) => api(who, "PUT", `/v1/agents/${agent.id}/a2a-endpoint/nudge`, body);
const status = async (agent: Who) => must(agent, "GET", "/v1/inbox/a2a-endpoint");
const principalSql = (agent: Who, query: string, ...args: unknown[]) =>
  runInDurableObject(BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(agent.id)), (_: any, state: any) => state.storage.sql.exec(query, ...args).toArray());
/** A new signing secret for the same URL, held by the fake endpoint as Runner would hold it. */
async function rotate(target: { agent: Who; url: string; path: string }) {
  const rotated = await must(target.agent, "PUT", "/v1/inbox/a2a-endpoint", { url: target.url, delivery: "nudge", rotate_secret: true });
  await holdSecret(target.path, rotated.signing_secret);
  return rotated;
}
/** Verified and switched on by the owner: a nudge endpoint that sends. */
async function activeTarget(room: string, path?: string, extra: Partial<Who> = {}, owner: Who = OWNER) {
  const target = await nudgeTarget(room, path, extra);
  expect((await verify(target.agent, target.agent)).body).toMatchObject({ verified: true });
  expect((await switchNudge(owner, target.agent, { on: true, version: target.version })).status).toBe(200);
  return target;
}

const offer = async (room: string, assignee: string) =>
  must(LEAD, "POST", `/v1/workspaces/${room}/tasks`, { title: TITLE, instructions: INSTRUCTIONS, acceptance_criteria: CRITERIA, assignee });
const roomSql = (room: string, query: string, ...args: unknown[]) =>
  runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(room)), (_: any, state: any) => state.storage.sql.exec(query, ...args).toArray());
const attempts = (room: string, task: string) => roomSql(room, "SELECT * FROM a2a_attempt WHERE task_id = ? ORDER BY created_at", task) as Promise<any[]>;
const consume = async (room: string, attempt: any) => {
  const res = await SELF.fetch("https://api.internal/test/consume-a2a", { method: "POST", body: JSON.stringify({ ws: room, attempt: attempt.id, agent: attempt.agent_id }) });
  return { status: res.status, body: (await res.json()) as any };
};
const hookLog = async () => (await (await fetch("https://hook-log.example.com/")).json()) as any[];
const sentTo = async (url: string) => (await hookLog()).filter((r) => `https://${r.host}${r.path}` === url);
const challenges = async (url: string) => (await sentTo(url)).filter((r) => JSON.parse(r.body).method === "podster.dev/verifyEndpoint");
const nudges = async (url: string) => (await sentTo(url)).filter((r) => JSON.parse(r.body).method === "SendMessage");
/** The task as the agent sees it, by its own polling. */
const polled = async (room: string, agent: Who, task: string) => (await must(agent, "GET", `/v1/workspaces/${room}/tasks/${task}`)).task;

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

describe("a nudge endpoint", () => {
  it("starts unverified and switched off, and an offer then sends nothing while polling still finds it", async () => {
    const room = await newRoom();
    const { agent, url, secret } = await nudgeTarget(room);
    expect(secret).toMatch(/^a2asec_/);
    expect(await status(agent)).toMatchObject({ url, version: 1, delivery: "nudge", control: "unverified", nudge_on: false, enabled: true });
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "stopped", ended_reason: "endpoint_unverified" });
    expect(await sentTo(url)).toEqual([]);
    expect((await polled(room, agent, task.id)).status).toBe("offered");
  });

  it("an offers endpoint keeps ADR 0007's delivery and isn't challenged", async () => {
    const agent: Who = { id: `agt_nudge_offers_${++counter}`, org: ORG };
    await register(agent);
    const url = `https://${HOST}/a2a/offers-${counter}`;
    expect((await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url })).delivery).toBe("offers");
    const refused = await verify(agent, agent);
    expect([refused.status, refused.code]).toEqual([409, "not_a_nudge_endpoint"]);
    expect(await sentTo(url)).toEqual([]);
    expect((await api(agent, "PUT", "/v1/inbox/a2a-endpoint", { url, delivery: "push" })).code).toBe("invalid_argument");
  });

  it("proves control with a signed challenge answered under the registration's own secret", async () => {
    const { agent, url, secret, version } = await nudgeTarget(null);
    const done = await verify(agent, agent);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ verified: true, control: "verified", nudge_on: false });
    expect(done.text).not.toContain(secret);
    const [sent, ...more] = await challenges(url);
    expect(more).toEqual([]);
    expect(await verifies(secret, sent.signature, sent.body)).toBe(true);
    const body = JSON.parse(sent.body);
    expect(Object.keys(body.params).sort()).toEqual(["agent_id", "challenge", "version"]);
    expect(body.params).toMatchObject({ agent_id: agent.id, version });
    expect(body.params.challenge).toMatch(/^[0-9a-f]{64}$/);
    // Verified already: nothing more is sent.
    expect((await verify(agent, agent)).body).toMatchObject({ verified: true });
    expect(await challenges(url)).toHaveLength(1);
    // The admin can ask too, and sees the same.
    expect((await verify(OWNER, agent)).body).toMatchObject({ verified: true });
  });

  it("isn't proved by an echo, a proof under another secret, an error, a redirect or no answer", async () => {
    for (const path of [`/nudge/echo-${++counter}`, `/nudge/wrong-${++counter}`, `/fail-nudge-${++counter}`, `/redirect-nudge-${++counter}`, `/hang-nudge-${++counter}`]) {
      const { agent, url } = await nudgeTarget(null, path);
      const tried = await verify(agent, agent);
      expect(tried.status, path).toBe(200);
      expect(tried.body, path).toMatchObject({ verified: false, control: "unverified" });
      expect(["wrong_proof", "no_answer"]).toContain(tried.body.reason);
      expect(await challenges(url), path).toHaveLength(1);
      expect((await status(agent)).control).toBe("unverified");
    }
  });

  it("counts challenges for one secret and refuses once they run out, until a new secret", async () => {
    const path = `/nudge/echo-${++counter}`;
    const { agent, url } = await nudgeTarget(null, path);
    for (let n = 0; n < 5; n++) expect((await verify(agent, agent)).body.verified).toBe(false);
    const spent = await verify(agent, agent);
    expect([spent.status, spent.code]).toEqual([429, "verify_attempts_exhausted"]);
    expect(await challenges(url)).toHaveLength(5);
    await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url, delivery: "nudge", rotate_secret: true });
    expect((await verify(agent, agent)).status).toBe(200);
    expect(await challenges(url)).toHaveLength(6);
  });

  it("counts challenges per agent, 10 an hour, and no rotation, new URL or delete resets that", async () => {
    const path = `/nudge/echo-${++counter}`;
    const target = await nudgeTarget(null, path);
    const { agent, url } = target;
    for (let n = 0; n < 5; n++) expect((await verify(agent, agent)).body.verified).toBe(false);
    await rotate(target);
    for (let n = 0; n < 5; n++) expect((await verify(agent, agent)).body.verified).toBe(false);
    await rotate(target);
    const limited = await verify(agent, agent);
    expect([limited.status, limited.code]).toEqual([429, "verify_rate_limited"]);
    // Neither a new URL nor a delete and set again starts the count over, and the admin's challenges count too.
    const elsewhere = `https://${HOST}/nudge/echo-${++counter}`;
    await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url: elsewhere, delivery: "nudge" });
    expect((await verify(OWNER, agent)).code).toBe("verify_rate_limited");
    await must(agent, "DELETE", "/v1/inbox/a2a-endpoint");
    await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url, delivery: "nudge" });
    expect((await verify(agent, agent)).code).toBe("verify_rate_limited");
    expect(await challenges(url)).toHaveLength(10);
    expect(await challenges(elsewhere)).toEqual([]);
    // An hour on, the oldest have left the window.
    await principalSql(agent, "UPDATE a2a_verify_window SET at = at - 3600001");
    expect((await verify(agent, agent)).status).toBe(200);
    expect(await challenges(url)).toHaveLength(11);
  });

  it("draws each challenge from 256 random bits, not from UUIDs", async () => {
    const seen: string[] = [];
    for (let n = 0; n < 2; n++) {
      const target = await nudgeTarget(null, `/nudge/echo-${++counter}`);
      for (let m = 0; m < 5; m++) await verify(target.agent, target.agent);
      seen.push(...(await challenges(target.url)).map((r) => JSON.parse(r.body).params.challenge));
    }
    expect(seen).toHaveLength(10);
    for (const c of seen) expect(c).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(seen).size).toBe(10);
    // Two v4 UUIDs would put a 4 at 12 and 44 every time.
    expect(seen.every((c) => c[12] === "4" && c[44] === "4")).toBe(false);
  });

  it("refuses a challenge to a URL that no longer passes the egress rules, and the switch-off it makes stays", async () => {
    const { agent, url } = await nudgeTarget(null);
    await principalSql(agent, "UPDATE a2a_endpoint SET url = 'https://localhost/nudge'");
    const refused = await verify(agent, agent);
    expect([refused.status, refused.code]).toEqual([409, "endpoint_switched_off"]);
    expect((await status(agent)).enabled).toBe(false);
    expect(await challenges(url)).toEqual([]);
  });

  it("finishes adding its columns to a table an earlier, partial change left behind", async () => {
    const { agent, url, path } = await nudgeTarget(null);
    // A table with step 12's columns and only the first of step 13's, as an ALTER that stopped partway would leave.
    await principalSql(agent, "DROP TABLE a2a_endpoint");
    await principalSql(agent, `CREATE TABLE a2a_endpoint (id INTEGER PRIMARY KEY CHECK (id = 1), url TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
      signing_secret TEXT NOT NULL DEFAULT '', token_sealed TEXT, enabled INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
      set_at INTEGER, last_report_at INTEGER, set_by TEXT, set_by_org TEXT, set_by_since INTEGER, delivery TEXT NOT NULL DEFAULT 'offers')`);
    const set = await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url, delivery: "nudge" });
    await holdSecret(path, set.signing_secret);
    expect(set).toMatchObject({ delivery: "nudge", control: "unverified" });
    expect((await verify(agent, agent)).body.verified).toBe(true);
    const columns = (await principalSql(agent, "SELECT name FROM pragma_table_info('a2a_endpoint')")).map((r: any) => r.name);
    expect(columns).toEqual(expect.arrayContaining(["verified_at", "challenge", "verify_attempts", "nudge_version", "nudge_by", "nudge_set_at"]));
  });

  it("keeps the current mode when a set leaves delivery out, and offers only for a new registration", async () => {
    const target = await nudgeTarget(null);
    const { agent, url, version } = target;
    await verify(agent, agent);
    expect((await switchNudge(OWNER, agent, { on: true, version })).body.nudge_on).toBe(true);
    // The same URL with only a token: still the same nudge registration, secret, proof and opt-in.
    const same = await api(agent, "PUT", "/v1/inbox/a2a-endpoint", { url, token: null });
    expect(same.body).toMatchObject({ delivery: "nudge", version, control: "verified", nudge_on: true });
    expect(same.body.signing_secret).toBeUndefined();
    // A new URL with a token and no delivery: still a nudge endpoint, with a new secret, so proof and opt-in again.
    const moved = await api(agent, "PUT", "/v1/inbox/a2a-endpoint", { url: `https://${HOST}/nudge/ok-moved-${++counter}`, token: null });
    expect(moved.body).toMatchObject({ delivery: "nudge", version: version + 1, control: "unverified", nudge_on: false });
    expect(moved.body.signing_secret).toMatch(/^a2asec_/);
    // After a delete, a set with no delivery is a new registration: offers.
    await must(agent, "DELETE", "/v1/inbox/a2a-endpoint");
    expect((await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url })).delivery).toBe("offers");
  });

  it("must prove control again after any new secret, and keeps it for the same registration", async () => {
    const { agent, url, path } = await nudgeTarget(null);
    await verify(agent, agent);
    expect((await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url, delivery: "nudge" })).control).toBe("verified");
    const rotated = await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url, delivery: "nudge", rotate_secret: true });
    expect(rotated).toMatchObject({ version: 1, control: "unverified" });
    await holdSecret(path, rotated.signing_secret);
    expect((await verify(agent, agent)).body.verified).toBe(true);
    // Another mode is another registration, with its own version and secret.
    const offers = await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url, delivery: "offers" });
    expect(offers).toMatchObject({ version: 2, delivery: "offers" });
    expect(offers.signing_secret).toBeTruthy();
    const back = await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url, delivery: "nudge" });
    expect(back).toMatchObject({ version: 3, delivery: "nudge", control: "unverified" });
  });
});

describe("the owner's opt-in", () => {
  it("is only for a person who administers the agent's organization", async () => {
    const { agent, version } = await nudgeTarget(null);
    await verify(agent, agent);
    const self = await switchNudge(agent, agent, { on: true, version });
    expect([self.status, self.code]).toEqual([403, "not_allowed"]);
    for (const who of [MEMBER, STRANGER]) {
      const refused = await switchNudge(who, agent, { on: true, version });
      expect([refused.status, refused.code], who.id).toEqual([404, "agent_not_found"]);
    }
    expect((await status(agent)).nudge_on).toBe(false);
  });

  it("names the verified registration the owner was shown, and switching off always works", async () => {
    const { agent, version } = await nudgeTarget(null);
    const early = await switchNudge(OWNER, agent, { on: true, version });
    expect([early.status, early.code]).toEqual([409, "endpoint_unverified"]);
    await verify(agent, agent);
    const stale = await switchNudge(OWNER, agent, { on: true, version: version + 1 });
    expect([stale.status, stale.code]).toEqual([409, "endpoint_changed"]);
    expect((await switchNudge(OWNER, agent, { on: true })).code).toBe("endpoint_changed");
    for (const bad of [{}, { on: "yes" }, { on: true, version, extra: 1 }]) {
      expect((await switchNudge(OWNER, agent, bad)).code).toBe("invalid_argument");
    }
    expect((await switchNudge(OWNER, agent, { on: true, version })).body).toMatchObject({ nudge_on: true, control: "verified" });
    expect(await must(OWNER, "GET", `/v1/agents/${agent.id}/a2a-endpoint`)).toMatchObject({ nudge_on: true, delivery: "nudge" });
    expect((await switchNudge(OWNER, agent, { on: false })).body).toMatchObject({ nudge_on: false });
    // Its audit, for the owner only: IDs, versions and reason codes, newest first.
    const read = await api(OWNER, "GET", `/v1/agents/${agent.id}/a2a-endpoint/nudge`);
    expect(read.body.endpoint).toMatchObject({ nudge_on: false });
    expect(read.body.history.map((h: any) => h.type)).toEqual(["nudge_off", "nudge_on", "verified", "challenge_sent"]);
    expect(read.body.history[1]).toMatchObject({ actor_id: OWNER.id, version, reason: null });
    expect(read.text).not.toContain("a2asec_");
    expect(JSON.stringify(read.body.history)).not.toContain(HOST);
    expect((await api(agent, "GET", `/v1/agents/${agent.id}/a2a-endpoint/nudge`)).code).toBe("not_allowed");
  });

  it("ends with a new URL, which needs proof and the owner again", async () => {
    const room = await newRoom();
    const { agent } = await activeTarget(room);
    const moved = await must(agent, "PUT", "/v1/inbox/a2a-endpoint", { url: `https://${HOST}/nudge/ok-moved-${++counter}`, delivery: "nudge" });
    expect(moved).toMatchObject({ version: 2, control: "unverified", nudge_on: false });
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    await consume(room, attempt);
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "stopped", ended_reason: "endpoint_unverified" });
  });

  it("ends with a rotated secret, even once the new secret is proved", async () => {
    const room = await newRoom();
    const target = await activeTarget(room);
    const rotated = await rotate(target);
    expect(rotated).toMatchObject({ version: target.version, nudge_on: false });
    expect((await verify(target.agent, target.agent)).body.verified).toBe(true);
    const [row] = await principalSql(target.agent, "SELECT nudge_version, nudge_by, nudge_by_org, nudge_by_since FROM a2a_endpoint");
    expect(row).toEqual({ nudge_version: null, nudge_by: null, nudge_by_org: null, nudge_by_since: null });
    expect((await status(target.agent)).nudge_on).toBe(false);
    const task = await offer(room, target.agent.id);
    const [attempt] = await attempts(room, task.id);
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "stopped", ended_reason: "nudge_off" });
    expect(await nudges(target.url)).toEqual([]);
  });

  it("is needed after proof: a verified endpoint the owner didn't switch on sends nothing", async () => {
    const room = await newRoom();
    const { agent, url } = await nudgeTarget(room);
    await verify(agent, agent);
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    await consume(room, attempt);
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "stopped", ended_reason: "nudge_off" });
    expect(await nudges(url)).toEqual([]);
  });
});

describe("a nudge", () => {
  it("goes out with IDs only, signed, and keeps no remote task to read back", async () => {
    const room = await newRoom();
    const { agent, url, secret } = await activeTarget(room);
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    const [sent, ...more] = await nudges(url);
    expect(more).toEqual([]);
    expect(await verifies(secret, sent.signature, sent.body)).toBe(true);
    for (const words of [TITLE, INSTRUCTIONS, CRITERIA, "Draft", "secret plan"]) expect(sent.body).not.toContain(words);
    const body = JSON.parse(sent.body);
    expect(body).toMatchObject({ jsonrpc: "2.0", id: attempt.id, method: "SendMessage" });
    const message = body.params.message;
    expect(message).toMatchObject({ messageId: attempt.id, role: "ROLE_USER" });
    expect(message.parts).toEqual([{ data: { kind: "podster.dev/nudge", workspace_id: room, task_id: task.id, attempt_id: attempt.id, attempt_kind: "offer" }, mediaType: "application/json" }]);
    expect(message.metadata).toEqual({ "podster.dev/task": `${room}:${task.id}`, "podster.dev/attempt": attempt.id, "podster.dev/delivery": "nudge" });
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "sent", remote_task_id: null, endpoint_url: url, reading_ended: 1, next_read_at: null });
    // Redelivered: nothing more goes out.
    await consume(room, attempt);
    expect(await nudges(url)).toHaveLength(1);
  });

  it("backs off when it fails, switches the endpoint off after three, and never holds up polling", async () => {
    const room = await newRoom();
    const { agent, url } = await activeTarget(room, `/nudge/flaky-${++counter}`);
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    const delays = [];
    for (let n = 0; n < 3; n++) delays.push((await consume(room, attempt)).body.outcome.retry);
    expect(delays).toEqual([60, 120, 240]);
    expect(await status(agent)).toMatchObject({ enabled: false, consecutive_failures: 3 });
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "stopped", ended_reason: "switched_off" });
    expect(await nudges(url)).toHaveLength(3);
    // The offer stands, and the agent finds and accepts it by polling.
    const seen = await polled(room, agent, task.id);
    expect(seen.status).toBe("offered");
    expect((await must(agent, "POST", `/v1/workspaces/${room}/tasks/${task.id}/accept`, { version: seen.version })).status).toBe("accepted");
  });

  it("stops, and the nudge switches off, once the person who switched it on leaves the organization", async () => {
    const room = await newRoom();
    const admin: Who = { id: `per_nudge_admin_${++counter}`, kind: "person", org: ORG, adminOrgs: [ORG] };
    const { agent, url } = await activeTarget(room, undefined, {}, admin);
    await must({ ...admin, departure: { person: admin.id, org: ORG, left_at: Date.now() } }, "POST", "/v1/org-departures", {});
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    expect((await consume(room, attempt)).body.outcome).toBe("ack");
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "stopped", ended_reason: "owner_departed" });
    expect(await status(agent)).toMatchObject({ url, nudge_on: false });
    expect(await nudges(url)).toEqual([]);
  });

  it("sends nothing, and is retried, when whether that person left can't be told", async () => {
    const room = await newRoom();
    const admin: Who = { id: `per_unavailable_nudge_${++counter}`, kind: "person", org: ORG, adminOrgs: [ORG] };
    const { agent, url } = await activeTarget(room, undefined, {}, admin);
    const task = await offer(room, agent.id);
    const [attempt] = await attempts(room, task.id);
    expect((await consume(room, attempt)).status).toBe(500);
    expect(await nudges(url)).toEqual([]);
    expect((await attempts(room, task.id))[0]).toMatchObject({ state: "queued", tries: 0 });
  });

  it("ends with a disconnect, and a reconnect brings none of it back", async () => {
    const room = await newRoom();
    const { agent, url } = await activeTarget(room);
    const task = await offer(room, agent.id);
    await must(OWNER, "POST", `/v1/agents/${agent.id}/disconnect`, {});
    const [attempt] = await attempts(room, task.id);
    await consume(room, attempt);
    expect((await attempts(room, task.id))[0].state).toBe("stopped");
    expect(await must(OWNER, "GET", `/v1/agents/${agent.id}/a2a-endpoint`)).toBeNull();
    const verified = await verify(OWNER, agent);
    expect([verified.status, verified.code]).toEqual([403, "agent_disconnected"]);
    expect(await nudges(url)).toEqual([]);
  });
});
