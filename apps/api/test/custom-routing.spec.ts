import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmQuiet } from "./alarm";
import { txtData } from "./fake-resolver";

// M6 step 8c: routing a custom hostname (ADR 0010's "Custom domains", step 5; the deep review's D5 and D6 on PR #403).
// A custom host serves only while the room holds its committed claim, Cloudflare's last read said `active`, the room
// hasn't unpublished since the request, its own facts hold, the release is served on the default host, and the
// hostname's own object holds exactly that room's and request's claim, live. The applier asks all of it again before
// every write, the object last; what was read and fails takes the entry down; what couldn't be read writes nothing.
//
// Each room is set up as in `custom-hostname.spec.ts`, with its content provider on, so the applier writes to the
// stand-in in `fake-content.ts`. Cloudflare's custom hostnames are the stand-in in `fake-hostnames.ts`.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; org: string; adminOrgs?: string[] };
const OPERATOR: Who = { id: "per_operator_one", org: "org_cr_ops" };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "x-test-public-rooms": "on" };
  if (method !== "GET") headers["idempotency-key"] = `cr-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());
const claimOf = (hostname: string) => BINDINGS.HOSTNAME_CLAIM.get(BINDINGS.HOSTNAME_CLAIM.idFromName(hostname));
const inClaim = <T>(hostname: string, fn: (sql: any) => T) => runInDurableObject(claimOf(hostname), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const answerWith = (name: string, value: string) => fetch("https://resolver-fake.example.com/set", { method: "POST", body: JSON.stringify({ name: `_podster-challenge.${name}`, answer: { body: { Status: 0, Answer: [{ name: `_podster-challenge.${name}`, type: 16, data: txtData(value) }] } } }) });
const cloudflareCalls = async (name: string) => ((await (await fetch(`https://hostnames-fake.example.com/state?hostname=${name}`)).json()) as { calls: string[] }).calls;
const setAtCloudflare = (name: string, status: string | null) => fetch(`https://hostnames-fake.example.com/set?hostname=${name}`, { method: "POST", body: JSON.stringify({ status }) });
const content = (path: string, body?: unknown) => fetch(`https://content-fake.example.com${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
type Held = { entries: Record<string, string>; calls: { op: string; name: string; status: number }[] };
const held = async () => (await (await content("/state")).json()) as Held;
const entryCalls = async (name: string) => (await held()).calls.filter((call) => call.name === name).map((call) => call.op);

async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

const PREV = `rel_${"6d".repeat(16)}`;
const NEXT = `rel_${"7e".repeat(16)}`;
const SHA = "ef".repeat(20);
let rooms = 0;
const made: string[] = [];
let names = 0;
const newName = () => `r${(++names).toString(36)}${crypto.randomUUID().slice(0, 8)}.example.net`;

type Room = { room: string; owner: Who; label: string; host: string; script: string };
async function room(org: string): Promise<Room> {
  const owner: Who = { id: `per_cr_owner_${org}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Custom hostname routing" });
  expect(created.status, org).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  await alarmQuiet(stub(id));
  const n = ++rooms;
  const label = `cr${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  const script = `${label}.${PREV}`;
  await inRoom(id, (sql) => {
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1, require_person_review = 1", `pub_${crypto.randomUUID().replace(/-/g, "")}`);
    sql.exec("CREATE TABLE test_hostname_claims_open (x INTEGER)");
    // Off only while the owner asks for the name: with release on and a provider, the release path's gate refuses
    // every release command, asking for a hostname among them, which `custom-hostname.spec.ts` shows.
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("CREATE TABLE test_custom_hostname_create_open (x INTEGER)");
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/routing', 'public', 'main', 'ready', ?, 1, 1, 1)", 987670100 + n, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES ('tsk_cr_1', 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", owner.id, owner.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, 'served', ?, 3, 2, 'tsk_cr_1', ?, ?, ?, 1, ?, 1, 1, 1)`,
      PREV, SHA, label, script, PREV, owner.id, owner.id);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, script);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, script);
  });
  await content("/seed", { scripts: [script], entries: { [host]: script } });
  return { room: id, owner, label, host, script };
}

const path = (r: Room) => `/v1/workspaces/${r.room}/app-hostname`;
const requestRow = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT id, state FROM hostname_request ORDER BY requested_at DESC, id DESC LIMIT 1").toArray()[0] ?? null);
const customRow = (r: Room, name: string) => inRoom(r.room, (sql) => sql.exec("SELECT script_name, version, closed FROM serve_state WHERE host = ? AND kind = 'custom'", name).toArray()[0] ?? null);
const applyRow = (r: Room, name: string) => inRoom(r.room, (sql) => sql.exec("SELECT applied_version, applied_script, attempts, refused_version, last_code FROM serve_apply WHERE host = ?", name).toArray()[0] ?? null);
/** Makes the request's next turn due now: its last try a minute and a second before its last change. */
const due = (r: Room) => inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = updated_at - 61000 WHERE checked_at IS NOT NULL"));
/** One pass of the room's alarm, alone, handing the room back quiet. */
const quietPass = (r: Room) => runInDurableObject(stub(r.room), async (instance: any, state: any) => {
  await state.storage.deleteAlarm();
  await instance.alarm();
  await state.storage.deleteAlarm();
});
/** One pass of the room's job, its turn made due first, with release switched on for the deployment. */
const step = async (r: Room) => { await due(r); await switchedOn(() => quietPass(r)); };
/** The applier's turn for every host, now. */
const applyDue = (r: Room) => inRoom(r.room, (sql) => sql.exec("UPDATE serve_apply SET next_attempt_at = 0 WHERE next_attempt_at IS NOT NULL"));
/** The applier forgets it applied the custom host, so its next pass asks every check again. */
const reapply = (r: Room, name: string) => inRoom(r.room, (sql) => sql.exec("DELETE FROM serve_apply WHERE host = ?", name));
const pass = (r: Room) => switchedOn(() => quietPass(r));

/** A room holding a committed claim on a fresh name, its custom hostname made at Cloudflare and still `pending`, quiet. */
async function claimed(org: string) {
  const r = await room(org);
  const name = newName();
  const request = (await switchedOn(() => api(r.owner, "PUT", path(r), { hostname: name }))).body.request;
  await alarmQuiet(stub(r.room));
  await inRoom(r.room, (sql) => sql.exec("DROP TABLE test_content_provider_off"));
  await answerWith(name, request.challenge_value);
  await step(r);
  expect(await requestRow(r)).toMatchObject({ state: "claimed" });
  await step(r);
  expect(await cloudflareCalls(name)).toEqual(["create"]);
  return { r, name, request };
}

/** A room whose custom host is routed and its entry written, in the custom form. */
async function routed(org: string) {
  const c = await claimed(org);
  await setAtCloudflare(c.name, "active");
  await step(c.r);
  await pass(c.r);
  expect((await held()).entries[c.name]).toBe(`${c.r.script}@${c.name}`);
  return c;
}

const reconcile = async () => {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_setting (value TEXT)").run();
  await BINDINGS.DB.prepare("INSERT INTO test_releases_setting (value) VALUES ('true')").run();
  try {
    return (await (await moderation().fetch("https://do/reconcile/entries", { method: "POST" })).json()) as any;
  } finally {
    await BINDINGS.DB.prepare("DROP TABLE test_releases_setting").run();
  }
};
const findings = async () => ((await switchedOn(() => api(OPERATOR, "GET", "/v1/moderation/takedown-findings"))).body.findings as { code: string; subject: string; detail: string | null }[]);
/** A pass starts from nothing: no room in the lookup table, no finding kept, and each pass at the start of its list. */
async function fresh() {
  await BINDINGS.DB.prepare("DELETE FROM app_label_index").run();
  await moderation().fetch("https://do/takedown-findings");
  await inModeration((sql) => { for (const table of ["takedown_finding", "reconcile_pass", "reconcile_failure"]) sql.exec(`DELETE FROM ${table}`); });
}

beforeEach(async () => { await content("/reset", {}); });
afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("routing a custom hostname (M6 step 8c)", () => {
  it("starts only once the committed claim's hostname reads active, on the release served, and writes the custom form", async () => {
    const { r, name } = await claimed("org_cr_start");
    // Pending at Cloudflare: nothing routes, and no entry is written, however many passes.
    await step(r);
    await pass(r);
    expect([await customRow(r, name), (await held()).entries[name], await entryCalls(name)]).toEqual([null, undefined, []]);
    // Active: the room opens the host on the release its default host serves, in the read's own pass.
    await setAtCloudflare(name, "active");
    await step(r);
    expect(await customRow(r, name)).toEqual({ script_name: r.script, version: 2, closed: 0 });
    // The applier writes the entry in the next pass, naming the host it is for, and reads it back.
    await pass(r);
    expect((await held()).entries[name]).toBe(`${r.script}@${name}`);
    expect(await entryCalls(name)).toEqual(["entry.put", "entry.get"]);
    expect(await applyRow(r, name)).toMatchObject({ applied_version: 2, applied_script: r.script, last_code: null });
    // The default host's entry is untouched.
    expect((await held()).entries[r.host]).toBe(r.script);
  });

  it("caps the status read at one every six hours once routed, where it was hourly (D5)", async () => {
    const { r, name } = await routed("org_cr_cap");
    const reads = async () => (await cloudflareCalls(name)).filter((call) => call === "read").length;
    const before = await reads();
    // The shortest wait before routing, a minute, is over: once routed it reads nothing.
    await step(r);
    expect(await reads()).toBe(before);
    // Five hours after its last read, far past the hour it waited before routing: still nothing. (An hour short of the
    // cap, so no run of this test is slow enough to reach it.)
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = ?", Date.now() - 5 * 3600_000));
    await switchedOn(() => quietPass(r));
    expect(await reads()).toBe(before);
    // Six hours: it reads.
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = ?", Date.now() - 6 * 3600_000 - 1000));
    await switchedOn(() => quietPass(r));
    expect(await reads()).toBe(before + 1);
  });

  it("stops when Cloudflare's status is read and isn't active, taking the entry down, and starts again once it is", async () => {
    const { r, name } = await routed("org_cr_pause");
    await setAtCloudflare(name, "pending");
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = ?", Date.now() - 7 * 3600_000));
    await switchedOn(() => quietPass(r));
    expect(await customRow(r, name)).toEqual({ script_name: null, version: 3, closed: 1 });
    expect(await requestRow(r)).toMatchObject({ state: "claimed" });
    await pass(r);
    expect((await held()).entries[name]).toBeUndefined();
    await setAtCloudflare(name, "active");
    await step(r);
    expect(await customRow(r, name)).toEqual({ script_name: r.script, version: 4, closed: 0 });
    await pass(r);
    expect((await held()).entries[name]).toBe(`${r.script}@${name}`);
  });

  it("is switched by each release once that release is served, and keeps what it served while the release waits for its marker", async () => {
    const { r, name } = await routed("org_cr_switch");
    const next = `${r.label}.${NEXT}`;
    await content("/seed", { scripts: [next] });
    // A release committed live: every open host is set to its script, the custom host among them.
    await inRoom(r.room, (sql) => {
      sql.exec(
        `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
           VALUES (?, ?, 'live', ?, 3, 2, 'tsk_cr_1', ?, ?, ?, 2, ?, 2, 2, 2)`, NEXT, SHA, r.label, next, NEXT, r.owner.id, r.owner.id);
      sql.exec("UPDATE serve_state SET release_id = ?, script_name = ?, version = version + 1 WHERE kind = 'custom'", NEXT, next);
    });
    await pass(r);
    // Not served yet: the custom host keeps what it served, nothing new is written, and it waits.
    expect((await held()).entries[name]).toBe(`${r.script}@${name}`);
    expect(await applyRow(r, name)).toMatchObject({ attempts: 1, last_code: "release_not_served" });
    // Served: written.
    await inRoom(r.room, (sql) => { sql.exec("UPDATE release SET state = 'served' WHERE id = ?", NEXT); sql.exec("UPDATE release SET state = 'replaced' WHERE id = ?", PREV); });
    await applyDue(r);
    await pass(r);
    expect((await held()).entries[name]).toBe(`${next}@${name}`);
  });
});

describe("the applier's checks before every write of a custom host's entry (M6 step 8c, D6)", () => {
  // Each check read and failing takes the entry down and refuses the host at its version, by the check's code.
  const failing: [string, string, (c: Awaited<ReturnType<typeof routed>>) => Promise<unknown>][] = [
    ["Cloudflare's last status isn't active", "hostname_not_active", (c) => inRoom(c.r.room, (sql) => sql.exec("UPDATE hostname_provider SET provider_status = 'pending'"))],
    ["the room unpublished since the request", "hostname_unpublished", (c) => inRoom(c.r.room, (sql) => sql.exec("UPDATE hostname_provider SET release_epoch = 1"))],
    ["the room is no longer public", "release_needs_public_room", (c) => inRoom(c.r.room, (sql) => sql.exec("UPDATE workspace SET visibility = 'private'"))],
    ["the request isn't a committed claim", "hostname_not_claimed", (c) => inRoom(c.r.room, (sql) => sql.exec("UPDATE hostname_request SET state = 'ending'"))],
    ["the gate on claims is closed", "hostname_claims_incomplete", (c) => inRoom(c.r.room, (sql) => sql.exec("DROP TABLE test_hostname_claims_open"))],
    ["the object's claim is ending", "claim_not_live", (c) => inClaim(c.name, (sql) => sql.exec("UPDATE claim SET state = 'ending' WHERE held = 1"))],
    ["the object's name is suspended", "claim_not_live", (c) => inClaim(c.name, (sql) => sql.exec("INSERT INTO suspension (singleton, reason, suspended_at) VALUES (1, 'abuse', 1)"))],
    ["the object holds another request's claim", "claim_not_live", (c) => inClaim(c.name, (sql) => sql.exec("UPDATE claim SET request_id = 'hnr_00000000000000000000000000000000' WHERE held = 1"))],
  ];
  for (const [what, code, breakIt] of failing) {
    it(`takes the entry down when ${what}`, async () => {
      const c = await routed(`org_cr_${code}_${what.length}`);
      // Every pass from here is the test's own: the job's turn is put a day ahead, so only the applier acts.
      await inRoom(c.r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = ?", Date.now() + 24 * 3600_000));
      await breakIt(c);
      await reapply(c.r, c.name);
      await pass(c.r);
      expect((await held()).entries[c.name], what).toBeUndefined();
      const row = await customRow(c.r, c.name);
      expect(await applyRow(c.r, c.name), what).toMatchObject({ applied_version: null, refused_version: row.version, last_code: code });
    });
  }

  it("writes nothing new and leaves what is there on what it can't read, and tries again", async () => {
    const c = await routed("org_cr_unread");
    await inRoom(c.r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = ?", Date.now() + 24 * 3600_000));
    const old = `${c.r.script}@${c.name}`;
    // The object can't be read.
    await inRoom(c.r.room, (sql) => sql.exec("CREATE TABLE test_claim_object_unread (x INTEGER)"));
    await reapply(c.r, c.name);
    const calls = (await entryCalls(c.name)).length;
    await pass(c.r);
    expect([(await held()).entries[c.name], (await entryCalls(c.name)).length]).toEqual([old, calls]);
    expect(await applyRow(c.r, c.name)).toMatchObject({ applied_version: null, refused_version: null, attempts: 1, last_code: "standing_unknown" });
    // Read again: written.
    await inRoom(c.r.room, (sql) => sql.exec("DROP TABLE test_claim_object_unread"));
    await applyDue(c.r);
    await pass(c.r);
    expect(await applyRow(c.r, c.name)).toMatchObject({ applied_version: 2, last_code: null });
  });
});

describe("the reconcile's checks of a custom hostname's entry (M6 step 8c)", () => {
  it("leaves an entry both sides agree on, has the room take it down once the object's claim isn't live, and tells of one with no claim", async () => {
    await fresh();
    const c = await routed("org_cr_reconcile");
    await inRoom(c.r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = ?", Date.now() + 24 * 3600_000));
    await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(c.r.label, c.r.room).run();
    expect(await reconcile()).toMatchObject({ code: "ok", changed: 0, unanswered: 0 });
    expect((await held()).entries[c.name]).toBe(`${c.r.script}@${c.name}`);
    // The object's claim is ending: the room forgets it applied the host, and its applier, asking the object again,
    // takes the entry down.
    await inClaim(c.name, (sql) => sql.exec("UPDATE claim SET state = 'ending' WHERE held = 1"));
    expect(await reconcile()).toMatchObject({ changed: 1 });
    await pass(c.r);
    expect((await held()).entries[c.name]).toBeUndefined();
    expect(await applyRow(c.r, c.name)).toMatchObject({ last_code: "claim_not_live" });
    // An entry for a name whose object holds no claim names no room: told to operators by its own code, never removed
    // here (ADR 0010: the reconcile never removes an entry itself).
    const stray = newName();
    await content("/seed", { entries: { [stray]: `${c.r.script}@${stray}` } });
    await reconcile();
    expect((await findings()).filter((f) => f.subject === stray).map((f) => f.code)).toEqual(["custom_entry_without_claim"]);
    expect((await held()).entries[stray]).toBe(`${c.r.script}@${stray}`);
  });
});
