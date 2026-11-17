import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm";

// M6 step 6, 6g: an agent asks for a release, the `deploy_release` capability, through `requestRelease`'s route and
// its `record`. The release keeps the person who controls the agent (`release_requester`): who linked the credential it
// asked with, since when, and the agent's connection generation. On every pass, the request's standing, a replay of its
// stored answer, the approval's recheck and the job's, that link must still be exactly the recorded one, and its person
// still in the agent's organization; anything else ends the release or refuses, and a fact that couldn't be read decides
// nothing. An agent there through a public claim never asks (decision 159).
//
// Each room's provider is switched off, as in `release-request.spec.ts`, so the release path's gate is open.

const BINDINGS = env as any;
let key: any;
type Link = { person: string; since: number };
type Who = { id: string; org: string; kind?: "person" | "agent"; adminOrgs?: string[]; departure?: object; linker?: Link | null; gen?: number };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const claims = who.kind === "agent"
    ? { kind: "agent", org: who.org, gen: who.gen ?? 1, ...(who.linker ? { linker: who.linker } : {}) }
    : { kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 }, ...(who.departure ? { departure: who.departure } : {}) };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who) };
  if (method !== "GET") headers["idempotency-key"] = idempotencyKey ?? `ag-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined, text };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const principal = (id: string) => BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());

/** Release switched on for the test Worker, as no deployment is, while `run` runs. */
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

const AGENT_ORG = "org_ag_agents";
const SHA = "b8".repeat(20);
const REPO_ID = 987650411;
const TASK = "tsk_ag_1";
const T = 1_800_000_000_000;
const SINCE = 1_700_000_000_000;
let rooms = 0;
/** Every room a test made, quieted after each test. */
const made: string[] = [];

/** Registers an agent of its own for one test, connected at generation 1, so disconnecting it touches no other test. */
async function register(id: string) {
  const registrar: Who = { id: "per_ag_registrar", org: AGENT_ORG, adminOrgs: [AGENT_ORG] };
  const res = await SELF.fetch(`https://api.internal/v1/agents/${id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(registrar) }, body: JSON.stringify({ org_id: AGENT_ORG, name: id }) });
  if (res.status !== 200) throw new Error(`register ${id}: ${res.status}`);
}

type Room = { room: string; owner: Who; admin: Who; agent: Who; linker: Who; org: string };
/**
 * A public room where a release may be asked for: release on at version 3 and epoch 2, a ready repository, an agent of
 * the agent organization in the room holding a `deploy` grant the owner gave, and a completed task whose reviewed commit
 * Podster's merge confirmed. The agent's credential was linked by `linker`, a person of the agent's organization, at
 * `SINCE`. The room has no label yet, and its provider is switched off.
 */
async function room(opts: { linker?: string; agent?: string } = {}): Promise<Room> {
  const n = ++rooms;
  const org = `org_ag_${n}`;
  const owner: Who = { id: `per_ag_owner_${n}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Agent release" });
  expect(created.status).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  const admin: Who = { id: `per_ag_adm_${n}`, org };
  const linker: Who = { id: opts.linker ?? `per_ag_linker_${n}`, org: AGENT_ORG };
  const agent: Who = { id: opts.agent ?? `agt_ag_${n}`, org: AGENT_ORG, kind: "agent", linker: { person: linker.id, since: SINCE }, gen: 1 };
  await register(agent.id);
  await inRoom(id, (sql) => {
    sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, 'admin', ?, 1)", admin.id, org, owner.id);
    sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'member', ?, 1)", agent.id, AGENT_ORG, owner.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `ag-${n}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/agent-release', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO_ID, owner.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_ag', ?, 'github', ?, 'deploy', ?, 1)", agent.id, REPO_ID, owner.id);
    // The agent did the task, so it sees it.
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, assignee_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, ?, 'completed', 1, 1, 1)", TASK, owner.id, admin.id, agent.id);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO_ID, SHA, admin.id);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
    sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
  });
  // The room's alarms are the test's from here on.
  await manualAlarms(stub(id));
  return { room: id, owner, admin, agent, linker, org };
}

const path = (r: Room) => `/v1/workspaces/${r.room}/releases`;
const ask = (r: Room, who: Who = r.agent, idempotencyKey?: string) => api(who, "POST", path(r), { task_id: TASK, commit_sha: SHA }, idempotencyKey);
const refused = (answer: { status: number; code?: string }) => [answer.status, answer.code];
/** Everything a request or an approval could write, so a refusal can be shown to have written nothing. */
const everything = (r: Room) => inRoom(r.room, (sql) => JSON.stringify(["release", "release_requester", "app_label", "audit_event", "event", "outbox", "serve_state", "release_job"].map((table) => sql.exec(`SELECT * FROM ${table}`).toArray())));
const departs = (who: Who) => api({ ...who, kind: "person", departure: { person: who.id, org: who.org, left_at: Date.now() } }, "POST", "/v1/org-departures", {});
/** The agent disconnected and connected again: its connection generation moves, as every disconnect moves it. */
const reconnected = (agent: Who) => runInDurableObject(principal(agent.id), (_: any, state: any) => void state.storage.sql.exec("UPDATE connection SET generation = generation + 1"));
const recheck = (r: Room, release: string) =>
  switchedOn(() => stub(r.room).fetch("https://do/internal/release-recheck", { method: "POST", body: JSON.stringify({ release_id: release }) }).then(async (res: Response) => ({ status: res.status, body: (await res.json()) as any })));
const approve = (r: Room, release: string, who: Who = r.owner) => switchedOn(() => api(who, "POST", `${path(r)}/${release}/approve`, undefined));
const state = (r: Room, release: string) => all(r.room, "SELECT state, failure_code FROM release WHERE id = ?", release).then((rows) => rows[0]);

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("an agent asks for a release (M6 step 6, 6g)", () => {
  it("records the release with the person who controls the agent, told to people only", async () => {
    const r = await room();
    const answer = await switchedOn(() => ask(r));
    expect(answer.status, answer.text).toBe(200);
    const id = answer.body.id;
    expect(answer.body).toMatchObject({ id, commit_sha: SHA, state: "awaiting_approval", requested_by: r.agent.id, requested_at: T, approved_by: null });
    // Who controls the agent, on record: the person who linked its credential, since when, in which organization, and
    // the connection it asked under.
    expect(await all(r.room, "SELECT release_id, requester_person, org_id, linked_since, generation FROM release_requester")).toEqual([
      { release_id: id, requester_person: r.linker.id, org_id: AGENT_ORG, linked_since: SINCE, generation: 1 },
    ]);
    // Audited by the agent, IDs only; told to the people who may approve it, never to the agent.
    expect(await all(r.room, "SELECT actor_id, action, target_id FROM audit_event WHERE action LIKE 'release.%'")).toEqual([{ actor_id: r.agent.id, action: "release.requested", target_id: id }]);
    const [event] = await all(r.room, "SELECT id FROM event WHERE type = 'release.requested' AND subject_id = ?", id);
    expect((await all(r.room, "SELECT recipient_principal_id AS who FROM outbox WHERE event_id = ? ORDER BY who", event.id)).map((o: any) => o.who)).toEqual([r.admin.id, r.owner.id].sort());
  });

  it("records a person's own request as controlled by themselves, with no link", async () => {
    const r = await room();
    await inRoom(r.room, (s) => {
      s.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES ('per_ag_person', 'person', ?, 'member', ?, 1)", r.org, r.owner.id);
      s.exec("UPDATE provider_grant SET principal_id = 'per_ag_person'");
      s.exec("UPDATE task SET requester_id = 'per_ag_person'");
    });
    const answer = await switchedOn(() => ask(r, { id: "per_ag_person", org: r.org }));
    expect(answer.status, answer.text).toBe(200);
    expect(await all(r.room, "SELECT requester_person, org_id, linked_since, generation FROM release_requester")).toEqual([
      { requester_person: "per_ag_person", org_id: null, linked_since: null, generation: null },
    ]);
  });

  it("is refused, writing nothing, without a live controller, a grant, or a place that isn't a public claim", async () => {
    const cases: [string, (r: Room) => unknown, (r: Room) => Who, [number, string]][] = [
      ["a credential with no controlling person", () => undefined, (r) => ({ ...r.agent, linker: null }), [403, "agent_not_connected"]],
      ["its controlling person left the agent's organization", (r) => departs(r.linker), (r) => r.agent, [403, "agent_not_connected"]],
      ["no grant", (r) => inRoom(r.room, (s) => void s.exec("DELETE FROM provider_grant")), (r) => r.agent, [403, "grant_required"]],
      // Decision 159: an agent in the room only through a public claim gets no grant, and is refused even holding one.
      ["a public claim, even holding a grant", (r) => inRoom(r.room, (s) => void s.exec("UPDATE member SET joined_via = 'public', role = 'guest' WHERE principal_id = ?", r.agent.id)), (r) => r.agent, [403, "public_participant"]],
      ["a private room", (r) => inRoom(r.room, (s) => void s.exec("UPDATE workspace SET visibility = 'private'")), (r) => r.agent, [409, "release_needs_public_room"]],
    ];
    for (const [why, change, who, want] of cases) {
      const r = await room();
      await change(r);
      const before = await everything(r);
      expect(refused(await switchedOn(() => ask(r, who(r)))), why).toEqual(want);
      expect(await everything(r), why).toBe(before);
    }
  });

  it("decides nothing, and writes nothing, when the controlling person's own record can't answer", async () => {
    // Test builds: a person whose ID has this prefix has a `Principal` that doesn't answer the departure question.
    const r = await room({ linker: "per_unavailable_ag_linker" });
    const before = await everything(r);
    expect(refused(await switchedOn(() => ask(r)))).toEqual([503, "standing_unknown"]);
    expect(await everything(r)).toBe(before);
  });

  it("gives a stored answer back only to the credential whose link is the one recorded", async () => {
    const r = await room();
    const first = await switchedOn(() => ask(r, r.agent, "ag-replay"));
    expect(first.status, first.text).toBe(200);
    const before = await everything(r);
    // The same agent, the same key, through a credential another person of its organization linked: not the link on
    // record, so nothing is given back.
    const other: Who = { ...r.agent, linker: { person: `per_ag_other_${rooms}`, since: SINCE } };
    const byOther = await switchedOn(() => ask(r, other, "ag-replay"));
    expect(refused(byOther)).toEqual([403, "agent_not_connected"]);
    expect(byOther.text).not.toContain(first.body.id);
    // The same person's link made again, later: a new generation of the link, not the one recorded.
    const relinked: Who = { ...r.agent, linker: { person: r.linker.id, since: SINCE + 1 } };
    expect(refused(await switchedOn(() => ask(r, relinked, "ag-replay")))).toEqual([403, "agent_not_connected"]);
    expect(await everything(r)).toBe(before);
    // The recorded link again: the stored answer, as it was.
    expect((await switchedOn(() => ask(r, r.agent, "ag-replay"))).body).toEqual(first.body);
  });

  it("compares links only for a stored answer of this request: another command's under the same key is idempotency_mismatch", async () => {
    const r = await room();
    // A stored answer of another command of the agent's under the key, with an `id` of its own (as a message's is).
    await inRoom(r.room, (s) => void s.exec("INSERT INTO idempotency (actor_id, key, request_hash, response_json, expires_at) VALUES (?, 'ag-other', 'another-route', ?, ?)", r.agent.id, JSON.stringify({ id: "msg_ag_other" }), Date.now() + 86_400_000));
    const before = await everything(r);
    expect(refused(await switchedOn(() => ask(r, r.agent, "ag-other")))).toEqual([422, "idempotency_mismatch"]);
    expect(await everything(r)).toBe(before);
  });

  it("is a request a rollback is not: a rollback stays a person's", async () => {
    const r = await room();
    const asked = await switchedOn(() => ask(r));
    expect(asked.status, asked.text).toBe(200);
    expect(refused(await switchedOn(() => api(r.agent, "POST", `${path(r)}/${asked.body.id}/rollback`, {})))).toEqual([403, "not_allowed"]);
  });
});

describe("an agent's release, approved and rechecked", () => {
  it("may be approved by the person who controls the agent (the owner's decision of 2026-11-16), and the job's recheck holds", async () => {
    const n = rooms + 1;
    // The room's owner linked the agent's credential.
    const r = await room({ linker: `per_ag_owner_${n}` });
    expect(r.linker.id).toBe(r.owner.id);
    const id = (await switchedOn(() => ask(r))).body.id;
    const approved = await approve(r, id);
    expect([approved.status, approved.body?.state, approved.body?.approved_by], approved.text).toEqual([200, "queued", r.owner.id]);
    expect(await recheck(r, id)).toEqual({ status: 200, body: { release_id: id, state: "queued", rechecked: true, reason: null } });
  });

  const lost: [string, (r: Room) => Promise<unknown>][] = [
    ["the agent connected again since it asked", (r) => reconnected(r.agent)],
    ["its controlling person left the agent's organization", (r) => departs(r.linker)],
    ["no controlling person on record", (r) => inRoom(r.room, (s) => void s.exec("DELETE FROM release_requester"))],
  ];
  for (const [why, change] of lost) {
    it(`fails at the approval's recheck when ${why}: requester_lost_authority`, async () => {
      const r = await room();
      const id = (await switchedOn(() => ask(r))).body.id;
      await change(r);
      const answer = await approve(r, id);
      expect([answer.status, answer.body?.state, answer.body?.failure_code], answer.text).toEqual([200, "failed", "requester_lost_authority"]);
    });

    it(`fails at the job's recheck when ${why}: requester_lost_authority`, async () => {
      const r = await room();
      const id = (await switchedOn(() => ask(r))).body.id;
      expect((await approve(r, id)).body?.state).toBe("queued");
      await change(r);
      expect((await recheck(r, id)).body).toEqual({ release_id: id, state: "failed", rechecked: true, reason: "requester_lost_authority" });
      expect(await state(r, id)).toEqual({ state: "failed", failure_code: "requester_lost_authority" });
    });
  }

  it("decides nothing at the approval or the job when the agent's connection or its controller's record can't be read", async () => {
    // Test builds: an agent whose ID has this prefix has a `Principal` that doesn't answer a read of its connection, and
    // a person whose ID has this prefix one that doesn't answer the departure question. The request itself is checked
    // as every agent request is, by the Worker, which this doesn't touch.
    for (const which of ["connection", "controller"] as const) {
      const r = await room(which === "connection" ? { agent: `agt_unavailable_ag_${rooms + 1}` } : {});
      const id = (await switchedOn(() => ask(r))).body.id;
      expect(id, which).toBeDefined();
      if (which === "controller") {
        // The record now names a person whose record doesn't answer: the read is about them, and gives nothing.
        await inRoom(r.room, (s) => void s.exec("UPDATE release_requester SET requester_person = 'per_unavailable_ag_ctl'"));
      }
      const before = await everything(r);
      expect(refused(await approve(r, id)), which).toEqual([503, "standing_unknown"]);
      expect(await everything(r), which).toBe(before);
      // Queued by hand, as an approval would have: the job's pass decides nothing either.
      await inRoom(r.room, (s) => void s.exec("UPDATE release SET state = 'queued', approved_by = ?, approved_at = 1 WHERE id = ?", r.owner.id, id));
      const queued = await everything(r);
      expect([(await recheck(r, id)).status], which).toEqual([503]);
      expect(await everything(r), which).toBe(queued);
    }
  });

  it("ends the release on a departure that was read, even when the agent's connection couldn't be read", async () => {
    // A fact read and failing decides, whatever else is unread (review standards, rule 3).
    for (const at of ["approval", "job"] as const) {
      const r = await room({ agent: `agt_unavailable_ag_dep_${rooms + 1}` });
      const id = (await switchedOn(() => ask(r))).body.id;
      if (at === "job") await inRoom(r.room, (s) => void s.exec("UPDATE release SET state = 'queued', approved_by = ?, approved_at = 1 WHERE id = ?", r.owner.id, id));
      await departs(r.linker);
      if (at === "approval") {
        const answer = await approve(r, id);
        expect([answer.status, answer.body?.state, answer.body?.failure_code], at).toEqual([200, "failed", "requester_lost_authority"]);
      } else {
        expect((await recheck(r, id)).body, at).toEqual({ release_id: id, state: "failed", rechecked: true, reason: "requester_lost_authority" });
      }
    }
  });

  it("decides nothing on reads about a link that is no longer the one recorded", async () => {
    // The record changes between what was read outside and the job's transaction (test builds only): what was read is
    // about the earlier link, and says nothing of the one recorded now, though each answer was a clear yes.
    for (const change of ["UPDATE release_requester SET requester_person = 'per_ag_someone'", "UPDATE release_requester SET linked_since = linked_since + 1", "UPDATE release_requester SET generation = generation + 1"]) {
      const r = await room();
      const id = (await switchedOn(() => ask(r))).body.id;
      expect((await approve(r, id)).body?.state, change).toBe("queued");
      await inRoom(r.room, (s) => {
        s.exec("CREATE TABLE test_release_between_reads (statement TEXT)");
        s.exec("INSERT INTO test_release_between_reads (statement) VALUES (?)", change);
      });
      const answer = await recheck(r, id);
      expect([answer.status, answer.body?.error?.code], change).toEqual([503, "standing_unknown"]);
      expect(await state(r, id), change).toEqual({ state: "queued", failure_code: null });
    }
  });
});
