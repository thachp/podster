// Review A6 of M5: every managed-repository event follows the switch and the same visibility as the read it mirrors, in
// the room's activity, its events, a task's history and the inbox. Events are written straight into the room, one of each
// type, so each read is checked against exactly what's there.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet } from "./alarm.ts";

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const ORG = "org_m5e";
const OWNER: Who = { id: "per_m5e_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
/** A person who sees the whole room and isn't an admin. */
const MEMBER: Who = { id: "per_m5e_member", kind: "person", org: ORG };
/** The task's assignee, who holds the push grant the token events name. */
const AGENT: Who = { id: "agt_m5e_agent", org: ORG };
/** Another agent that sees the whole room. */
const OTHER: Who = { id: "agt_m5e_other", org: ORG };

async function assertion(who: Who, claims: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }), ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, claims: object = {}) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who, claims), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `m5e-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return JSON.parse(text);
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [AGENT, OTHER]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(OWNER) }, body: JSON.stringify({ org_id: ORG, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).policy_version as number;
const switchOn = (id: string) => inRoom(id, (sql) => sql.exec("CREATE TABLE IF NOT EXISTS test_managed_repositories_on (x INTEGER)"));
const switchOff = (id: string) => inRoom(id, (sql) => sql.exec("DROP TABLE IF EXISTS test_managed_repositories_on"));

/** One of each managed-repository event type, as the room records them: room events with no task, and task events. */
const ROOM_EVENTS = ["repository.requested", "repository.retry_requested", "repository.setup_failed", "repository.ready", "repository.degraded", "repository.ready_again", "repository.read_refused"];
const TASK_EVENTS = ["task_change.linked", "task_change.observed", "task_change.commit_changed", "task_change.merge_observed", "task_change.checks_observed", "task_change.unwatched", "merge.requested", "merge.succeeded", "merge.failed", "merge.outcome_unknown", "merge.outcome_unknown_final"];
const TOKEN_EVENTS = ["repo_access.issued", "repo_token.mint_unknown", "repo_token.unrevocable"];
const GRANT_EVENTS = ["repo_grant.given", "repo_grant.revoked"];
const ALL = [...ROOM_EVENTS, ...TASK_EVENTS, ...TOKEN_EVENTS, ...GRANT_EVENTS];

/** Every room a test makes, quieted after it so that no alarm of it runs into the next test. */
const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)));
});

async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).id;
  madeRooms.push(id);
  await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: MEMBER.id, kind: "person", org_id: ORG, role: "member", policy_version: await version(id) }, { target_member: { person: MEMBER.id, orgs: { [ORG]: 1 } } });
  for (const who of [AGENT, OTHER]) await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: ORG, role: "member", policy_version: await version(id) });
  const task: string = (await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Code", instructions: "Change the code", assignee: AGENT.id })).id;
  await switchOn(id);
  return { id, task };
}

/** Writes one event of each type, every one with an outbox row for each of `to`, and a plain room event to compare with. */
async function write(id: string, task: string, to: Who[]) {
  const ids: Record<string, string> = {};
  await inRoom(id, (sql) => {
    sql.exec("CREATE TABLE IF NOT EXISTS test_hold_outbox (x)");
    for (const type of [...ALL, "room.renamed"]) {
      const event = `evt_m5e_${++counter}`;
      ids[type] = event;
      const onTask = TASK_EVENTS.includes(type) || TOKEN_EVENTS.includes(type);
      // A token's event is the holder's own; a grant's is about the holder; a merge's about whoever asked.
      const actor = TOKEN_EVENTS.includes(type) ? AGENT.id : OWNER.id;
      const subject = TOKEN_EVENTS.includes(type) ? "grt_m5e" : GRANT_EVENTS.includes(type) ? AGENT.id : null;
      sql.exec("INSERT INTO event (id, type, actor_id, actor_org, task_id, created_at, subject_id) VALUES (?, ?, ?, ?, ?, ?, ?)", event, type, actor, ORG, onTask ? task : null, Date.now(), subject);
      for (const who of to) sql.exec("INSERT INTO outbox (event_id, recipient_principal_id, next_attempt_at) VALUES (?, ?, 0)", event, who.id);
    }
  });
  return ids;
}
/** Lets the room's outbox go, and runs its alarm until every row has been sent or dropped. */
const deliver = async (id: string) => {
  await inRoom(id, (sql) => sql.exec("DROP TABLE IF EXISTS test_hold_outbox"));
  for (let n = 0; n < 10 && (await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM outbox").one().n)) > 0; n++) await alarmPass(stub(id));
  expect(await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM outbox").one().n)).toBe(0);
};

/** Every page of the room's activity for a viewer. */
const activity = async (who: Who, id: string) => {
  const types: string[] = [];
  for (let after: string | undefined; ; ) {
    const page = await api(who, "GET", `/v1/workspaces/${id}/activity?limit=50${after ? `&after=${after}` : ""}`);
    types.push(...(page.events as any[]).map((e) => e.type as string));
    if (!page.next_after) return types;
    after = page.next_after;
  }
};
const history = async (who: Who, id: string, task: string) => ((await api(who, "GET", `/v1/workspaces/${id}/tasks/${task}`)).history as any[]).map((e) => e.type as string);
const auditEvents = async (id: string) => ((await api(OWNER, "GET", `/v1/workspaces/${id}/events`)).events as any[]).map((e) => e.type as string);
/** Which of `events` reached the viewer's inbox, reading every page of it. */
const inbox = async (who: Who, events: Record<string, string>) => {
  const mine = new Set<string>();
  for (let after = 0; ; ) {
    const page = (await api(who, "GET", `/v1/inbox?after=${after}`)).events as any[];
    if (!page.length) break;
    for (const event of page) mine.add(event.event_id as string);
    after = page.at(-1).seq;
  }
  return Object.entries(events).filter(([, event]) => mine.has(event)).map(([type]) => type).sort();
};
const m5 = (types: string[]) => types.filter((type) => ALL.includes(type)).sort();

describe("managed-repository events (review A6)", () => {
  it("are shown nowhere while the switch is off: activity, events, a task's history and the inbox", async () => {
    const r = await room();
    await switchOff(r.id);
    const events = await write(r.id, r.task, [OWNER, MEMBER, AGENT]);
    for (const who of [OWNER, MEMBER, AGENT]) {
      expect(m5(await activity(who, r.id)), who.id).toEqual([]);
      expect(m5(await history(who, r.id, r.task)), who.id).toEqual([]);
    }
    expect(m5(await auditEvents(r.id))).toEqual([]);
    // The room's own events still show.
    expect(await activity(OWNER, r.id)).toContain("room.renamed");
    expect(await auditEvents(r.id)).toContain("room.renamed");
    await deliver(r.id);
    for (const who of [OWNER, MEMBER, AGENT]) expect(m5(await inbox(who, events)), who.id).toEqual([]);
    // Switched on again, they're there for the owner, who may see them all.
    await switchOn(r.id);
    expect(m5(await activity(OWNER, r.id))).toEqual([...ALL].sort());
    expect(m5(await auditEvents(r.id))).toEqual([...ALL].sort());
  });

  it("show the repository's events only to those who read the repository: people who see the whole room, and no agent", async () => {
    const r = await room();
    const events = await write(r.id, r.task, [OWNER, MEMBER, AGENT, OTHER]);
    for (const who of [OWNER, MEMBER]) expect((await activity(who, r.id)).filter((t) => ROOM_EVENTS.includes(t)).sort(), who.id).toEqual([...ROOM_EVENTS].sort());
    for (const who of [AGENT, OTHER]) {
      expect((await activity(who, r.id)).filter((t) => ROOM_EVENTS.includes(t)), who.id).toEqual([]);
      // The read they mirror isn't theirs either.
      const res = await SELF.fetch(`https://api.internal/v1/workspaces/${r.id}/repository`, { headers: { "x-podster-assertion": await assertion(who) } });
      expect(res.status, who.id).not.toBe(200);
    }
    await deliver(r.id);
    expect((await inbox(MEMBER, events)).filter((t) => ROOM_EVENTS.includes(t))).toEqual([...ROOM_EVENTS].sort());
    for (const who of [AGENT, OTHER]) expect((await inbox(who, events)).filter((t) => ROOM_EVENTS.includes(t)), who.id).toEqual([]);
  });

  it("show a token's events only to those who see the holder's grant, not to everyone who reads the task", async () => {
    const r = await room();
    const events = await write(r.id, r.task, [OWNER, MEMBER, AGENT, OTHER]);
    for (const who of [OWNER, AGENT]) {
      expect((await activity(who, r.id)).filter((t) => TOKEN_EVENTS.includes(t)).sort(), who.id).toEqual([...TOKEN_EVENTS].sort());
      expect((await history(who, r.id, r.task)).filter((t) => TOKEN_EVENTS.includes(t)).sort(), who.id).toEqual([...TOKEN_EVENTS].sort());
    }
    // Both can read the task, and neither sees the grant.
    for (const who of [MEMBER, OTHER]) {
      expect((await history(who, r.id, r.task)).length, who.id).toBeGreaterThan(0);
      expect((await activity(who, r.id)).filter((t) => TOKEN_EVENTS.includes(t)), who.id).toEqual([]);
      expect((await history(who, r.id, r.task)).filter((t) => TOKEN_EVENTS.includes(t)), who.id).toEqual([]);
    }
    // A history entry carries no subject: the grant's ID isn't in it for anyone.
    const entries = (await api(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${r.task}`)).history as any[];
    expect(entries.some((e) => "subject_id" in e || "subject" in e)).toBe(false);
    await deliver(r.id);
    expect((await inbox(AGENT, events)).filter((t) => TOKEN_EVENTS.includes(t))).toEqual([...TOKEN_EVENTS].sort());
    for (const who of [MEMBER, OTHER]) expect((await inbox(who, events)).filter((t) => TOKEN_EVENTS.includes(t)), who.id).toEqual([]);
  });

  it("keep a task's change and merge to fewer than may read the task, in the inbox too", async () => {
    const r = await room();
    const events = await write(r.id, r.task, [MEMBER, AGENT, OTHER]);
    // The assignee and a person in the room are shown the change; another agent isn't.
    for (const who of [MEMBER, AGENT]) expect((await history(who, r.id, r.task)).filter((t) => TASK_EVENTS.includes(t)).sort(), who.id).toEqual([...TASK_EVENTS].sort());
    expect((await history(OTHER, r.id, r.task)).filter((t) => TASK_EVENTS.includes(t))).toEqual([]);
    await deliver(r.id);
    expect((await inbox(AGENT, events)).filter((t) => TASK_EVENTS.includes(t))).toEqual([...TASK_EVENTS].sort());
    expect((await inbox(OTHER, events)).filter((t) => TASK_EVENTS.includes(t))).toEqual([]);
  });
});
