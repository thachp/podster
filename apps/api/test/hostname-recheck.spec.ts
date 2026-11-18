import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet, clearAlarm, manualAlarms, runAlarm } from "./alarm";
import { txtData } from "./fake-resolver";

// M6 step 8d: the daily recheck of a committed claim's challenge (ADR 0010's "Custom domains", step 7). The resolver is
// the stand-in in `fake-resolver.ts`, whose answers here take the shapes spike D recorded from Cloudflare's resolver on
// 2026-11-18: `data` in quotes, owner names with no trailing dot, a CNAME's target with one. No test asks a real
// resolver.
//
// Each room is set up as in `custom-hostname.spec.ts`: public, release on, an app serving on its default host, its
// content provider switched off and custom hostname claims opened for it. Creating at Cloudflare stays closed, so a
// claim that ends has nothing at Cloudflare and goes from marked to freed. Time is the proof job's own clock
// (`test_hostname_clock`), set a day at a time, never waited for.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; org: string; kind?: "person" | "agent"; adminOrgs?: string[] };

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
  if (method !== "GET") headers["idempotency-key"] = `rc-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());
const claimOf = (hostname: string) => BINDINGS.HOSTNAME_CLAIM.get(BINDINGS.HOSTNAME_CLAIM.idFromName(hostname));
const claimState = async (hostname: string) => (await claimOf(hostname).fetch("https://claim/internal/state")).json() as Promise<any>;

/** What the challenge's name answers: a DNS-over-HTTPS JSON body, an HTTP status with none, or null for `NXDOMAIN`. */
const answer = (name: string, value: { body: unknown } | { httpStatus: number } | null) =>
  fetch("https://resolver-fake.example.com/set", { method: "POST", body: JSON.stringify({ name: `_podster-challenge.${name}`, answer: value }) });
const challenge = (name: string) => `_podster-challenge.${name}`;
/** Cloudflare's answer holding `records`, `NOERROR`. */
const noerror = (records: unknown[], extra: Record<string, unknown> = {}) => ({ body: { Status: 0, TC: false, AD: false, CD: false, Answer: records, ...extra } });
const txt = (owner: string, value: string) => ({ name: owner, type: 16, TTL: 300, data: txtData(value) });
const cname = (owner: string, target: string) => ({ name: owner, type: 5, TTL: 300, data: `${target}.` });
/** How many times the resolver was asked for the challenge's name. */
const looks = async (name: string) => ((await (await fetch("https://resolver-fake.example.com/asked")).json()) as string[]).filter((line) => line.split(" ")[1] === challenge(name)).length;

async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

const PREV = `rel_${"7e".repeat(16)}`;
const SHA = "ab".repeat(20);
let rooms = 0;
const made: string[] = [];
let names = 0;
const newName = () => `r${(++names).toString(36)}${crypto.randomUUID().slice(0, 8)}.example.net`;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

type Room = { room: string; owner: Who };
async function room(org: string): Promise<Room> {
  const owner: Who = { id: `per_rc_owner_${org}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "The daily recheck" });
  expect(created.status, org).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  await manualAlarms(stub(id));
  const n = ++rooms;
  const label = `rc${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  await inRoom(id, (sql) => {
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1, require_person_review = 1", `pub_${crypto.randomUUID().replace(/-/g, "")}`);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("CREATE TABLE test_hostname_claims_open (x INTEGER)");
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/recheck', 'public', 'main', 'ready', ?, 1, 1, 1)", 987670100 + n, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES ('tsk_rc_1', 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", owner.id, owner.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, 'served', ?, 3, 2, 'tsk_rc_1', ?, ?, ?, 1, ?, 1, 1, 1)`,
      PREV, SHA, label, `${label}.${PREV}`, PREV, owner.id, owner.id);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, `${label}.${PREV}`);
    sql.exec("INSERT OR IGNORE INTO release_script_kind (release_id, script_name, kind, recorded_at) SELECT substr(s, -36), s, 'static', 1 FROM (SELECT script_name AS s FROM serve_state) WHERE s IS NOT NULL");
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, `${label}.${PREV}`);
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, id).run();
  return { room: id, owner };
}

const path = (r: Room) => `/v1/workspaces/${r.room}/app-hostname`;
const requestRow = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT id, state, open, proved_at, definite_no_since, end_reason FROM hostname_request ORDER BY requested_at DESC, id DESC LIMIT 1").toArray()[0] ?? null);
const rechecked = (r: Room) => inRoom(r.room, (sql) => (sql.exec("SELECT rechecked_at FROM hostname_recheck").toArray()[0]?.rechecked_at ?? null) as number | null);
const events = (r: Room) => all(r.room, "SELECT type FROM event WHERE type LIKE 'app_hostname.%' ORDER BY seq").then((found) => found.map((e: any) => e.type));
/** The proof job's clock stopped at `now`. */
const clock = (r: Room, now: number) => inRoom(r.room, (sql) => {
  sql.exec("DROP TABLE IF EXISTS test_hostname_clock");
  sql.exec("CREATE TABLE test_hostname_clock (now INTEGER)");
  sql.exec("INSERT INTO test_hostname_clock (now) VALUES (?)", now);
});
/** One pass of the room's alarm, alone, with release switched on for the deployment, handing the room back quiet. */
const quietPass = (r: Room) => switchedOn(() => runInDurableObject(stub(r.room), async (instance: any, state: any) => {
  await clearAlarm(state);
  await runAlarm(instance, state);
  await clearAlarm(state);
}));
/** One pass with the job's clock at `now`. */
const passAt = async (r: Room, now: number) => { await clock(r, now); await quietPass(r); };
/** Makes the request's next try due at `now`, as `custom-hostname.spec.ts`'s `due` does at real time. */
const dueAt = (r: Room, now: number) => inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET updated_at = ?, checked_at = ?", now - 61_000, now - 122_000));
/** The long end of a claim nothing was asked of Cloudflare for: marked at its object, then freed. */
const endLongWay = async (r: Room, now: number) => { await dueAt(r, now); await passAt(r, now); await dueAt(r, now); await passAt(r, now); };

/** A room holding a committed claim on a fresh name, proved at `proved`, its challenge still published. */
async function claimed(org: string) {
  const r = await room(org);
  const name = newName();
  const request = (await switchedOn(() => api(r.owner, "PUT", path(r), { hostname: name }))).body.request;
  await alarmQuiet(stub(r.room));
  await answer(name, noerror([txt(challenge(name), request.challenge_value)]));
  // The look the ask's own pass made found nothing yet: the next is made due now.
  await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = updated_at - 61000 WHERE checked_at IS NOT NULL"));
  await quietPass(r);
  const row = await requestRow(r);
  expect(row).toMatchObject({ state: "claimed", definite_no_since: null });
  return { r, name, request, proved: row.proved_at as number };
}

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("the daily recheck of a committed claim (M6 step 8d)", () => {
  it("looks a day after the proof and not before, and a match there resets the day", async () => {
    const { r, name, proved } = await claimed("org_rc_match");
    const first = await looks(name);
    await passAt(r, proved + DAY - 1);
    expect(await looks(name)).toBe(first);
    expect(await rechecked(r)).toBeNull();
    await passAt(r, proved + DAY);
    expect(await looks(name)).toBe(first + 1);
    expect(await rechecked(r)).toBe(proved + DAY);
    expect(await requestRow(r)).toMatchObject({ state: "claimed", proved_at: proved + DAY, definite_no_since: null });
    // The next is a day after that look.
    await passAt(r, proved + 2 * DAY - 1);
    expect(await looks(name)).toBe(first + 1);
    await passAt(r, proved + 2 * DAY);
    expect(await looks(name)).toBe(first + 2);
    expect(await events(r)).toEqual(["app_hostname.requested", "app_hostname.claimed"]);
  });

  it("ends a claim on two definite noes at least a day apart, the long way, and frees it only once its object is told", async () => {
    const { r, name, request, proved } = await claimed("org_rc_removed");
    // The record is taken down: NXDOMAIN.
    await answer(name, null);
    await passAt(r, proved + DAY);
    expect(await requestRow(r)).toMatchObject({ state: "claimed", definite_no_since: proved + DAY });
    // A wildcard of another type over the name answers NOERROR with nothing: the second no, a day after the first.
    await answer(name, noerror([], { Authority: [{ name: "example.net", type: 6 }] }));
    await passAt(r, proved + 2 * DAY);
    expect(await requestRow(r)).toMatchObject({ state: "ending", open: 1, end_reason: "hostname_challenge_removed" });
    // Nothing serves on the name from the same transaction: no custom host is open.
    expect(await all(r.room, "SELECT host FROM serve_state WHERE host = ? AND closed = 0", name)).toEqual([]);
    expect((await claimState(name)).claim).toMatchObject({ request_id: request.id, state: "live" });
    // 8b's path: the object marks it ending, then it is freed, and only then is the request over.
    await endLongWay(r, proved + 2 * DAY + HOUR);
    expect(await requestRow(r)).toMatchObject({ state: "ended", open: null, end_reason: "hostname_challenge_removed" });
    expect(await claimState(name)).toEqual({ claim: null, suspended: false, generation: 1 });
    expect(await events(r)).toEqual(["app_hostname.requested", "app_hostname.claimed", "app_hostname.ending", "app_hostname.ended"]);
  });

  it("counts no answer toward neither no: SERVFAIL, a failed request, a truncated or malformed answer, a stray owner's TXT", async () => {
    const { r, name, request, proved } = await claimed("org_rc_silent");
    await answer(name, null);
    await passAt(r, proved + DAY);
    expect(await requestRow(r)).toMatchObject({ definite_no_since: proved + DAY });
    const silences: ({ body: unknown } | { httpStatus: number })[] = [
      // A DNSSEC failure, as spike D saw Cloudflare answer it.
      { body: { Status: 2, TC: false, AD: false, CD: false, Comment: ["EDE(9): DNSKEY Missing"] } },
      { httpStatus: 500 },
      { body: { Status: 0, TC: true, Answer: [] } },
      { body: { Status: 0, Answer: [{ name: challenge(name), type: "16", data: txtData(request.challenge_value) }] } },
      // The value, but owned by a name the challenge's CNAME chain doesn't reach.
      noerror([txt(name, request.challenge_value)]),
    ];
    let day = 1;
    for (const silence of silences) {
      await answer(name, silence);
      await passAt(r, proved + ++day * DAY);
      expect(await requestRow(r), JSON.stringify(silence)).toMatchObject({ state: "claimed", proved_at: proved, definite_no_since: proved + DAY });
    }
    // None reset the first no: the next no, days after it, ends the claim.
    await answer(name, null);
    await passAt(r, proved + ++day * DAY);
    expect(await requestRow(r)).toMatchObject({ state: "ending", end_reason: "hostname_challenge_removed" });
  });

  it("counts a TXT reached through the challenge's CNAME chain, in Cloudflare's quoting, as a match", async () => {
    const { r, name, request, proved } = await claimed("org_rc_cname");
    await answer(name, null);
    await passAt(r, proved + DAY);
    expect(await requestRow(r)).toMatchObject({ definite_no_since: proved + DAY });
    await answer(name, noerror([cname(challenge(name), "proofs.example.org"), txt("proofs.example.org", request.challenge_value)]));
    await passAt(r, proved + 2 * DAY);
    expect(await requestRow(r)).toMatchObject({ state: "claimed", proved_at: proved + 2 * DAY, definite_no_since: null });
    // Unsigned, `AD: false`, and another value beside it change nothing.
    await answer(name, noerror([txt(challenge(name), "v=other"), txt(challenge(name), request.challenge_value)], { AD: false }));
    await passAt(r, proved + 3 * DAY);
    expect(await requestRow(r)).toMatchObject({ state: "claimed", proved_at: proved + 3 * DAY });
  });

  it("ends a claim with no match for seven days, and never sooner on no answer alone", async () => {
    const { r, name, proved } = await claimed("org_rc_lapsed");
    await answer(name, { body: { Status: 2 } });
    for (let day = 1; day <= 6; day++) {
      await passAt(r, proved + day * DAY);
      expect(await requestRow(r), `day ${day}`).toMatchObject({ state: "claimed", definite_no_since: null });
    }
    // Seven days after the proof to the millisecond, though only a day has passed since the last look a moment short of it.
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_recheck SET rechecked_at = ?", proved + 6 * DAY + 12 * HOUR));
    await passAt(r, proved + 7 * DAY - 1);
    expect(await requestRow(r)).toMatchObject({ state: "claimed" });
    await passAt(r, proved + 7 * DAY);
    expect(await requestRow(r)).toMatchObject({ state: "ending", end_reason: "hostname_proof_lapsed" });
    await endLongWay(r, proved + 7 * DAY + HOUR);
    expect(await requestRow(r)).toMatchObject({ state: "ended", end_reason: "hostname_proof_lapsed" });
    expect((await claimState(name)).claim).toBeNull();
  });

  it("doesn't look with the gate on claims closed or no resolver, records that as no answer, and so ends the claim after seven days", async () => {
    const { r, name, proved } = await claimed("org_rc_no_look");
    const before = await looks(name);
    await inRoom(r.room, (sql) => sql.exec("DROP TABLE test_hostname_claims_open"));
    await passAt(r, proved + DAY);
    expect(await rechecked(r)).toBe(proved + DAY);
    await inRoom(r.room, (sql) => {
      sql.exec("CREATE TABLE test_hostname_claims_open (x INTEGER)");
      sql.exec("CREATE TABLE test_hostname_resolver_off (x INTEGER)");
    });
    for (let day = 2; day <= 6; day++) await passAt(r, proved + day * DAY);
    expect(await rechecked(r)).toBe(proved + 6 * DAY);
    expect(await requestRow(r)).toMatchObject({ state: "claimed", definite_no_since: null });
    await passAt(r, proved + 7 * DAY);
    expect(await requestRow(r)).toMatchObject({ state: "ending", end_reason: "hostname_proof_lapsed" });
    expect(await looks(name)).toBe(before);
  });

  it("reads the room again before each look: one that fails ends the claim by its code with no look", async () => {
    const { r, name, proved } = await claimed("org_rc_room");
    const before = await looks(name);
    await inRoom(r.room, (sql) => sql.exec("UPDATE workspace SET status = 'archived'"));
    await passAt(r, proved + DAY);
    expect(await requestRow(r)).toMatchObject({ state: "ending", end_reason: "workspace_archived" });
    expect(await looks(name)).toBe(before);
    expect(await rechecked(r)).toBeNull();
  });

  it("still lapses a claim whose room's facts can't be read: no look is made, and seven days with no match end it", async () => {
    const { r, name, proved } = await claimed("org_rc_unread");
    const before = await looks(name);
    // The challenge is taken down, and the organization's release switch, as the room applied it, can't be read: held
    // at a generation its last take equals, which no set makes.
    await answer(name, null);
    await inRoom(r.room, (sql) => sql.exec("UPDATE release_switch_applied SET granted = 1, generation = 1, last_take = 1"));
    for (let day = 1; day <= 6; day++) {
      await passAt(r, proved + day * DAY);
      expect(await requestRow(r), `day ${day}`).toMatchObject({ state: "claimed", definite_no_since: null });
      expect(await rechecked(r)).toBe(proved + day * DAY);
    }
    await passAt(r, proved + 7 * DAY);
    expect(await requestRow(r)).toMatchObject({ state: "ending", end_reason: "hostname_proof_lapsed" });
    // Nothing was looked up while the room's facts couldn't be read.
    expect(await looks(name)).toBe(before);
  });

  it("makes the job due for the recheck on its own, when the custom hostname's own read isn't due for days", async () => {
    const { r, name, proved } = await claimed("org_rc_due");
    const before = await looks(name);
    // The custom hostname's own next read put two days off: only the recheck is owed a day after the proof.
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET updated_at = ?, checked_at = ?", proved + 2 * DAY, proved + 2 * DAY));
    await passAt(r, proved + DAY);
    expect(await looks(name)).toBe(before + 1);
    expect(await rechecked(r)).toBe(proved + DAY);
  });
});
