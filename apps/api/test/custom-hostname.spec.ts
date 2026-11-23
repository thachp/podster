import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet, clearAlarm, manualAlarms, runAlarm } from "./alarm";
import { txtData } from "./fake-resolver";

// M6 step 8b: a committed claim's custom hostname at Cloudflare, created only for it, and the long end of every
// committed claim (ADR 0010's "Custom domains", steps 5, 6 and 8). Cloudflare is the stand-in in `fake-hostnames.ts`,
// whose answers are assumptions from the documentation: no spike has made a custom hostname.
//
// Each room is set up as in `app-hostname.spec.ts`: public, release on, an app serving on its default host and its
// content provider switched off. The gate on claims is open, as everywhere since claims are complete. Creating at
// Cloudflare is closed everywhere while the release path isn't complete; a room is opened to it only by `createOpen`,
// which is a test build's opt-in.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; org: string; kind?: "person" | "agent"; adminOrgs?: string[] };
const OPERATOR: Who = { id: "per_operator_one", org: "org_ch_ops" };

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
  if (method !== "GET") headers["idempotency-key"] = `ch-key-${++counter}`;
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
const claimState = async (hostname: string) => (await claimOf(hostname).fetch("https://claim/internal/state")).json() as Promise<any>;
const toClaim = async (hostname: string, path: string, body: unknown) => {
  const res = await claimOf(hostname).fetch(`https://claim${path}`, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};
const answerWith = (name: string, value: string) => fetch("https://resolver-fake.example.com/set", { method: "POST", body: JSON.stringify({ name: `_podster-challenge.${name}`, answer: { body: { Status: 0, Answer: [{ name: `_podster-challenge.${name}`, type: 16, data: txtData(value) }] } } }) });
/** What the stand-in holds for a name, and the calls it saw for it. */
const cloudflare = async (name: string) => (await (await fetch(`https://hostnames-fake.example.com/state?hostname=${name}`)).json()) as { held: { id: string; status: string } | null; calls: string[] };
const setAtCloudflare = (name: string, status: string | null) => fetch(`https://hostnames-fake.example.com/set?hostname=${name}`, { method: "POST", body: JSON.stringify({ status }) });
const fault = (op: string, hostname: string, kind: string, times = 1) => fetch("https://hostnames-fake.example.com/fault", { method: "POST", body: JSON.stringify({ op, hostname, kind, times }) });

async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

const PREV = `rel_${"6d".repeat(16)}`;
const SHA = "ef".repeat(20);
let rooms = 0;
const made: string[] = [];
let names = 0;
const newName = () => `c${(++names).toString(36)}${crypto.randomUUID().slice(0, 8)}.example.net`;

type Room = { room: string; owner: Who; label: string; host: string };
async function room(org: string): Promise<Room> {
  const owner: Who = { id: `per_ch_owner_${org}`, org, adminOrgs: [org] };
  const created = await api(owner, "POST", "/v1/workspaces", { name: "Custom hostname at Cloudflare" });
  expect(created.status, org).toBe(200);
  const id: string = created.body.id;
  made.push(id);
  await manualAlarms(stub(id));
  const n = ++rooms;
  const label = `ch${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  await inRoom(id, (sql) => {
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1, require_person_review = 1", `pub_${crypto.randomUUID().replace(/-/g, "")}`);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/custom', 'public', 'main', 'ready', ?, 1, 1, 1)", 987660100 + n, owner.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES ('tsk_ch_1', 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", owner.id, owner.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", owner.id);
    sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, 'served', ?, 3, 2, 'tsk_ch_1', ?, ?, ?, 1, ?, 1, 1, 1)`,
      PREV, SHA, label, `${label}.${PREV}`, PREV, owner.id, owner.id);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, `${label}.${PREV}`);
    // The kind a real upload records before its script is written (S3): static.
    sql.exec("INSERT OR IGNORE INTO release_script_kind (release_id, script_name, kind, recorded_at) SELECT substr(s, -36), s, 'static', 1 FROM (SELECT script_name AS s FROM serve_state UNION SELECT flight_before FROM serve_state) WHERE s IS NOT NULL");
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, `${label}.${PREV}`);
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, id).run();
  return { room: id, owner, label, host };
}

const path = (r: Room) => `/v1/workspaces/${r.room}/app-hostname`;
const requestRow = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT id, hostname, state, open, claimed_at, end_reason FROM hostname_request ORDER BY requested_at DESC, id DESC LIMIT 1").toArray()[0] ?? null);
const providerRow = (r: Room) => inRoom(r.room, (sql) => sql.exec("SELECT p.release_epoch, p.create_sent_at, p.provider_id, p.provider_status, p.object_ending_at, p.gone_at, p.first_gone_at, p.deleted_at FROM hostname_provider p JOIN hostname_request q ON q.id = p.request_id ORDER BY q.requested_at DESC LIMIT 1").toArray()[0] ?? null);
const events = (r: Room) => all(r.room, "SELECT type FROM event WHERE type LIKE 'app_hostname.%' ORDER BY seq").then((found) => found.map((e: any) => e.type));
/**
 * Makes the request's next turn due now, whatever time has passed: its last try set a minute and a second before its
 * last change, so the wait after it is the shortest, a minute, and already over.
 */
const due = (r: Room) => inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = updated_at - 61000 WHERE checked_at IS NOT NULL"));
/** One pass of the room's alarm, alone, handing the room back quiet. */
const quietPass = (r: Room) => runInDurableObject(stub(r.room), async (instance: any, state: any) => {
  await clearAlarm(state);
  await runAlarm(instance, state);
  await clearAlarm(state);
});
/** One pass of the room's job, its turn made due first, with release switched on for the deployment. */
const step = async (r: Room) => { await due(r); await switchedOn(() => quietPass(r)); };
/**
 * Moves the request's create, last delete and first read of gone eleven minutes back, so a read of gone now counts:
 * two reads ten minutes apart, each ten minutes after the create and the last delete (the deep review of PR #403).
 */
const aged = (r: Room) => inRoom(r.room, (sql) => sql.exec("UPDATE hostname_provider SET create_sent_at = create_sent_at - 660000, deleted_at = deleted_at - 660000, first_gone_at = first_gone_at - 660000"));
/** Two reads of gone that count: the first noted, the second confirming it. */
const confirmGone = async (r: Room) => { await aged(r); await step(r); await aged(r); await step(r); };
/** The long end of a claim whose custom hostname is there: marked, read and deleted, read gone twice, freed. */
const endLongWay = async (r: Room) => { await step(r); await step(r); await confirmGone(r); await step(r); };
/** The owner removes the room's custom hostname, and the room is handed back quiet before a test writes its rows. */
const remove = async (r: Room) => { const answer = await switchedOn(() => api(r.owner, "DELETE", path(r))); await alarmQuiet(stub(r.room)); return answer; };
/** The operators' record, as an operator reads it. */
const findings = async () => ((await switchedOn(() => api(OPERATOR, "GET", "/v1/moderation/takedown-findings"))).body.findings as { code: string; subject: string }[]);
/** Opens creating at Cloudflare for this room, as only a test build can. */
const createOpen = (r: Room) => inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_custom_hostname_create_open (x INTEGER)"));

/** A room holding a committed claim on a fresh name, quiet. */
async function claimed(org: string) {
  const r = await room(org);
  const name = newName();
  const request = (await switchedOn(() => api(r.owner, "PUT", path(r), { hostname: name }))).body.request;
  await alarmQuiet(stub(r.room));
  await answerWith(name, request.challenge_value);
  await step(r);
  expect(await requestRow(r)).toMatchObject({ state: "claimed" });
  return { r, name, request };
}

afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
});
beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("a committed claim's custom hostname at Cloudflare (M6 step 8b)", () => {
  it("is created once, for the committed claim, then read; moved ends the claim, which is deleted, read until gone and only then freed", async () => {
    const { r, name, request } = await claimed("org_ch_full");
    // The room recorded its release epoch with the request.
    expect(await providerRow(r)).toMatchObject({ release_epoch: 2, create_sent_at: null });
    await createOpen(r);
    await step(r);
    const made = await cloudflare(name);
    expect(made.held).toMatchObject({ status: "pending" });
    expect(made.calls).toEqual(["create"]);
    expect(await providerRow(r)).toMatchObject({ provider_id: made.held!.id, provider_status: "pending" });
    expect((await providerRow(r)).create_sent_at).not.toBeNull();
    // Read after, never created again.
    await setAtCloudflare(name, "active");
    await step(r);
    expect(await providerRow(r)).toMatchObject({ provider_status: "active" });
    expect((await cloudflare(name)).calls).toEqual(["create", "read"]);
    expect(await requestRow(r)).toMatchObject({ state: "claimed" });
    // Read active with the claim live at its object, but this room has no content provider: no applier could write or
    // remove an entry, so no custom host is made (the security re-check of PR #404), and nothing waits on one.
    expect(await all(r.room, "SELECT host FROM serve_state WHERE host = ?", name)).toEqual([]);
    // Cloudflare reports it moved: the claim ends, and the room stops serving on the name in the same transaction.
    await setAtCloudflare(name, "moved");
    // Its last read is put six hours back, the longest any read waits (8c, D5).
    await inRoom(r.room, (sql) => sql.exec("UPDATE hostname_request SET checked_at = ?", Date.now() - 6 * 3600_000 - 1000));
    await switchedOn(() => quietPass(r));
    expect(await requestRow(r)).toMatchObject({ state: "ending", open: 1, end_reason: "hostname_moved" });
    expect(await all(r.room, "SELECT host FROM serve_state WHERE host = ?", name)).toEqual([]);
    // The object is told first, and the claim, still holding the name, is never granted again.
    await step(r);
    expect((await claimState(name)).claim).toMatchObject({ workspace_id: r.room, request_id: request.id, state: "ending" });
    expect((await toClaim(name, "/internal/claim", { hostname: name, workspace_id: r.room, request_id: request.id, requested_at: request.requested_at, generation: 0 })).body.decision).toBe("hostname_claim_ending");
    // Read, found, deleted: the delete's answer isn't taken as gone.
    await step(r);
    expect((await cloudflare(name)).held).toBeNull();
    expect(await providerRow(r)).toMatchObject({ gone_at: null });
    expect((await claimState(name)).claim).not.toBeNull();
    // Read again at once: gone, but so soon after the delete it counts for nothing.
    await step(r);
    expect(await providerRow(r)).toMatchObject({ gone_at: null, first_gone_at: null });
    // Two reads of gone ten minutes apart, well after the delete: gone. Only then freed.
    await confirmGone(r);
    expect((await providerRow(r)).gone_at).not.toBeNull();
    expect((await claimState(name)).claim).not.toBeNull();
    // With no row for the host, nothing was ever written for it: freed at once (the review of PR #404, S1).
    await step(r);
    expect(await requestRow(r)).toMatchObject({ state: "ended", open: null, end_reason: "hostname_moved" });
    expect(await claimState(name)).toEqual({ claim: null, suspended: false, generation: 1 });
    expect(await inClaim(name, (sql) => sql.exec("SELECT state, held, end_reason FROM claim").toArray())).toEqual([{ state: "ended", held: null, end_reason: "hostname_moved" }]);
    expect((await cloudflare(name)).calls).toEqual(["create", "read", "read", "read", "delete", "read", "read", "read"]);
    expect(await events(r)).toEqual(["app_hostname.requested", "app_hostname.claimed", "app_hostname.ending", "app_hostname.ended"]);
    // The default host is untouched, and the room may ask for another name.
    expect(await all(r.room, "SELECT script_name FROM serve_state WHERE host = ?", r.host)).toEqual([{ script_name: `${r.label}.${PREV}` }]);
    expect((await switchedOn(() => api(r.owner, "PUT", path(r), { hostname: newName() }))).status).toBe(200);
  });

  it("is never created while creating is closed, with no provider, with release off, or for a claim not live at its object", async () => {
    const { r, name } = await claimed("org_ch_gates");
    // Closed: the release path incomplete, which a test build gives this room alone since the path is complete
    // (2026-11-23), and no test build's opt-in.
    await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_release_path_incomplete (x INTEGER)"));
    await step(r);
    await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_custom_hostname_provider_off (x INTEGER)"));
    await createOpen(r);
    // No provider for custom hostnames.
    await step(r);
    await inRoom(r.room, (sql) => sql.exec("DROP TABLE test_custom_hostname_provider_off"));
    // Release switched off for the deployment.
    await due(r);
    await quietPass(r);
    // The object's claim ending (as a suspension's notice not yet heard leaves it).
    await inClaim(name, (sql) => sql.exec("UPDATE claim SET state = 'ending'"));
    await step(r);
    expect(await cloudflare(name)).toEqual({ held: null, calls: [] });
    expect(await providerRow(r)).toMatchObject({ create_sent_at: null });
    expect(await requestRow(r)).toMatchObject({ state: "claimed" });
    // Live again at the object: created.
    await inClaim(name, (sql) => sql.exec("UPDATE claim SET state = 'live'"));
    await step(r);
    expect((await cloudflare(name)).calls).toEqual(["create"]);
    // The gate is the release path's own, read through the room's one method, and the opt-in is read only under the
    // test build's feature.
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    expect(sources["workspace/release_commit.rs"]).toContain("pub(crate) const RELEASE_PATH_COMPLETE: bool = true;");
    const gate = sources["workspace/custom_hostname.rs"].split("fn custom_hostname_create_open")[1].split("\n    }\n")[0];
    expect(gate).toMatch(/self\.release_path_complete\(\)[\s\S]*#\[cfg\(feature = "failpoints"\)\][\s\S]*test_custom_hostname_create_open[\s\S]*#\[cfg\(not\(feature = "failpoints"\)\)\]\s*\{\s*false\s*\}/);
  });

  it("settles a create whose answer was lost by reading: found is kept, never created twice; not found is created again", async () => {
    const a = await claimed("org_ch_lost_made");
    await createOpen(a.r);
    await fault("create", a.name, "lost");
    await step(a.r);
    expect(await providerRow(a.r)).toMatchObject({ provider_id: null });
    expect((await providerRow(a.r)).create_sent_at).not.toBeNull();
    await step(a.r);
    const held = (await cloudflare(a.name)).held!;
    expect(await providerRow(a.r)).toMatchObject({ provider_id: held.id, provider_status: "pending" });
    expect((await cloudflare(a.name)).calls).toEqual(["create", "read"]);
    const b = await claimed("org_ch_lost_none");
    await createOpen(b.r);
    await fault("create", b.name, "failed");
    await step(b.r);
    expect((await cloudflare(b.name)).held).toBeNull();
    // Read gone at once proves nothing; read gone twice, ten minutes apart, it is created again.
    await step(b.r);
    await confirmGone(b.r);
    expect((await cloudflare(b.name)).calls).toEqual(["create", "read", "read", "read", "create"]);
    expect(await providerRow(b.r)).toMatchObject({ provider_id: (await cloudflare(b.name)).held!.id });
  });

  it("ends a claim whose custom hostname is gone at Cloudflare after it was recorded made", async () => {
    const { r, name } = await claimed("org_ch_vanished");
    await createOpen(r);
    await step(r);
    await setAtCloudflare(name, null);
    // One read of gone ends nothing: the list may lag.
    await aged(r);
    await step(r);
    expect(await requestRow(r)).toMatchObject({ state: "claimed" });
    await aged(r);
    await step(r);
    expect(await requestRow(r)).toMatchObject({ state: "ending", end_reason: "hostname_gone_at_provider" });
    // Marked, read gone twice, freed: nothing to delete.
    await step(r);
    await confirmGone(r);
    await step(r);
    expect(await requestRow(r)).toMatchObject({ state: "ended", end_reason: "hostname_gone_at_provider" });
    expect((await claimState(name)).claim).toBeNull();
    expect((await cloudflare(name)).calls).not.toContain("delete");
  });
});

describe("every way a committed claim ends (M6 step 8b)", () => {
  it("frees a removed claim nothing was ever asked of Cloudflare for, without calling Cloudflare", async () => {
    const { r, name } = await claimed("org_ch_remove_none");
    expect((await remove(r)).body.request).toMatchObject({ state: "ending", end_reason: "hostname_unmapped" });
    await step(r);
    expect((await claimState(name)).claim).toMatchObject({ state: "ending" });
    await step(r);
    expect(await requestRow(r)).toMatchObject({ state: "ended", end_reason: "hostname_unmapped" });
    expect(await claimState(name)).toEqual({ claim: null, suspended: false, generation: 1 });
    expect((await cloudflare(name)).calls).toEqual([]);
    // A claim never transfers: the request that held it is stale now, and any later claim needs a new challenge.
    expect((await toClaim(name, "/internal/claim", { hostname: name, workspace_id: r.room, request_id: (await requestRow(r)).id, requested_at: Date.now(), generation: 0 })).body.decision).toBe("hostname_request_withdrawn");
  });

  it("holds the name while a read or a delete settles nothing, and while there is no provider to read with", async () => {
    const { r, name } = await claimed("org_ch_unsettled");
    await createOpen(r);
    await step(r);
    await remove(r);
    await step(r);
    // No provider: nothing at Cloudflare can be read gone, so nothing is freed.
    await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_custom_hostname_provider_off (x INTEGER)"));
    await step(r);
    await inRoom(r.room, (sql) => sql.exec("DROP TABLE test_custom_hostname_provider_off"));
    // A failed read, a page that hints at another, an answer of another shape: none is gone.
    for (const kind of ["failed", "partial", "shape"]) {
      await fault("read", name, kind);
      await step(r);
    }
    // A delete that answered success and didn't happen, and one whose answer was lost.
    await fault("delete", name, "kept");
    await step(r);
    expect((await cloudflare(name)).held).not.toBeNull();
    await fault("delete", name, "lost");
    await step(r);
    expect(await providerRow(r)).toMatchObject({ gone_at: null });
    expect((await claimState(name)).claim).toMatchObject({ workspace_id: r.room, state: "ending" });
    expect(await requestRow(r)).toMatchObject({ state: "ending", open: 1 });
    await confirmGone(r);
    await step(r);
    expect(await requestRow(r)).toMatchObject({ state: "ended" });
    expect((await cloudflare(name)).calls).toEqual(["create", "read", "read", "read", "read", "delete", "read", "delete", "read", "read"]);
  });

  it("ends the claim once the room unpublishes, by any trigger, and when the room's own facts fail", async () => {
    const a = await claimed("org_ch_unpublish");
    await createOpen(a.r);
    await step(a.r);
    // Switching release off in the room unpublishes it.
    const off = await switchedOn(() => api(a.r.owner, "PUT", `/v1/workspaces/${a.r.room}/release-config`, { enabled: false, expected_version: 3 }));
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    await alarmQuiet(stub(a.r.room));
    expect(await all(a.r.room, "SELECT release_epoch FROM release_config")).toEqual([{ release_epoch: 3 }]);
    await step(a.r);
    expect(await requestRow(a.r)).toMatchObject({ state: "ending", end_reason: "hostname_unpublished" });
    await endLongWay(a.r);
    expect(await requestRow(a.r)).toMatchObject({ state: "ended", end_reason: "hostname_unpublished" });
    expect((await cloudflare(a.name)).held).toBeNull();
    // Archived: read before the next call, and ended.
    const b = await claimed("org_ch_archived");
    await inRoom(b.r.room, (sql) => sql.exec("UPDATE workspace SET status = 'archived'"));
    await step(b.r);
    expect(await requestRow(b.r)).toMatchObject({ state: "ending", end_reason: "workspace_archived" });
    expect((await cloudflare(b.name)).calls).toEqual([]);
  });

  it("ends a suspended name's claim the long way, and the name stays suspended once it is freed", async () => {
    const { r, name } = await claimed("org_ch_suspended");
    await createOpen(r);
    await step(r);
    await switchedOn(async () => expect((await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${name}/suspend`, { reason: "abuse" })).status).toBe(200));
    await alarmPass(claimOf(name));
    // The notice changed the room's rows: quiet before the test writes its own.
    await alarmQuiet(stub(r.room));
    expect(await requestRow(r)).toMatchObject({ state: "ending", end_reason: "hostname_suspended" });
    await endLongWay(r);
    expect(await requestRow(r)).toMatchObject({ state: "ended", end_reason: "hostname_suspended" });
    expect((await cloudflare(name)).held).toBeNull();
    // Suspended, then freed.
    expect(await claimState(name)).toEqual({ claim: null, suspended: true, generation: 2 });
    await switchedOn(async () => expect((await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${name}/lift`, { reason: "other" })).status).toBe(200));
  });
});

describe("the deep review's rulings (M6 step 8b)", () => {
  it("never takes a create that lands after a first read of gone, or a list that lags right after a create, for gone", async () => {
    // A create whose answer was lost and that hadn't landed yet.
    const a = await claimed("org_ch_late_create");
    await createOpen(a.r);
    await fault("create", a.name, "failed");
    await step(a.r);
    await aged(a.r);
    await step(a.r);
    expect((await providerRow(a.r)).first_gone_at).not.toBeNull();
    // It lands: the next read finds it, the first read of gone is forgotten, and it is never created twice.
    await setAtCloudflare(a.name, "pending");
    await aged(a.r);
    await step(a.r);
    expect(await providerRow(a.r)).toMatchObject({ provider_id: (await cloudflare(a.name)).held!.id, first_gone_at: null });
    expect((await cloudflare(a.name)).calls).toEqual(["create", "read", "read"]);
    expect(await requestRow(a.r)).toMatchObject({ state: "claimed" });
    // Made, and the list doesn't show it yet: read gone at once, and again after ten minutes, ends nothing.
    const b = await claimed("org_ch_lagging");
    await createOpen(b.r);
    await step(b.r);
    await setAtCloudflare(b.name, null);
    await step(b.r);
    expect(await providerRow(b.r)).toMatchObject({ first_gone_at: null });
    await aged(b.r);
    await step(b.r);
    expect(await requestRow(b.r)).toMatchObject({ state: "claimed" });
    await setAtCloudflare(b.name, "pending");
    await step(b.r);
    expect(await providerRow(b.r)).toMatchObject({ first_gone_at: null });
    expect(await requestRow(b.r)).toMatchObject({ state: "claimed" });
    expect((await cloudflare(b.name)).calls).toEqual(["create", "read", "read", "read"]);
  });

  it("forgets a read of gone once a read finds the hostname moved, so the long end counts gone afresh", async () => {
    const { r, name } = await claimed("org_ch_moved_forgets");
    await createOpen(r);
    await step(r);
    // Gone, once: noted.
    await setAtCloudflare(name, null);
    await aged(r);
    await step(r);
    expect((await providerRow(r)).first_gone_at).not.toBeNull();
    // There, and moved: the claim ends, and the first read of gone is forgotten.
    await setAtCloudflare(name, "moved");
    await step(r);
    expect(await requestRow(r)).toMatchObject({ state: "ending", end_reason: "hostname_moved" });
    expect(await providerRow(r)).toMatchObject({ first_gone_at: null });
    await step(r);
    // Gone again, well over ten minutes after the first: on its own it only starts a new count.
    await setAtCloudflare(name, null);
    await aged(r);
    await step(r);
    expect(await providerRow(r)).toMatchObject({ gone_at: null });
    expect(await requestRow(r)).toMatchObject({ state: "ending" });
    expect((await providerRow(r)).first_gone_at).not.toBeNull();
  });

  it("reads every page of a name's search, so a name matched by more than a page is still found and deleted, and only it", async () => {
    const { r, name } = await claimed("org_ch_pages");
    // Sixty other names that contain this one, made first, so this one is on the second page.
    const others = Array.from({ length: 60 }, (_, n) => `p${n}${name}`);
    for (const other of others) await setAtCloudflare(other, "active");
    await createOpen(r);
    await step(r);
    expect((await cloudflare(name)).held).not.toBeNull();
    await remove(r);
    await endLongWay(r);
    expect(await requestRow(r)).toMatchObject({ state: "ended" });
    expect((await cloudflare(name)).held).toBeNull();
    for (const other of [others[0], others[49], others[59]]) expect((await cloudflare(other)).held, other).not.toBeNull();
    expect((await cloudflare(name)).calls.filter((call) => call === "delete")).toHaveLength(1);
  });

  it("reads a name's search no further than its bound, takes that for no answer, and tells operators", async () => {
    const { r, name } = await claimed("org_ch_too_long");
    await createOpen(r);
    await step(r);
    await fault("read", name, "huge", 25);
    await step(r);
    expect((await cloudflare(name)).calls.filter((call) => call === "read")).toHaveLength(20);
    expect(await requestRow(r)).toMatchObject({ state: "claimed" });
    expect((await findings()).filter((found) => found.subject === name).map((found) => found.code)).toEqual(["custom_hostname_list_too_long"]);
  });

  it("never deletes at Cloudflare for a claim its object says isn't this request's, and ends the request", async () => {
    const { r, name } = await claimed("org_ch_not_held");
    await createOpen(r);
    await step(r);
    // The object holds the name for another request.
    await inClaim(name, (sql) => sql.exec("UPDATE claim SET request_id = ?", `hnr_${"9".repeat(32)}`));
    await remove(r);
    await step(r);
    expect(await requestRow(r)).toMatchObject({ state: "ended", open: null, end_reason: "hostname_unmapped" });
    expect(await cloudflare(name)).toMatchObject({ held: { status: "pending" }, calls: ["create"] });
    expect((await claimState(name)).claim).toMatchObject({ request_id: `hnr_${"9".repeat(32)}`, state: "live" });
  });
});

describe("the hostname's object, for the long end (M6 step 8b)", () => {
  it("marks and frees only the room's own claim, and frees one only once it is ending", async () => {
    const { r, name, request } = await claimed("org_ch_object");
    const mine = { hostname: name, workspace_id: r.room, request_id: request.id };
    const other = { hostname: name, workspace_id: `ws_${"0".repeat(32)}`, request_id: request.id };
    expect((await toClaim(name, "/internal/free", mine)).body).toEqual({ freed: false, held: true });
    expect((await toClaim(name, "/internal/end", { ...other, reason: "hostname_unmapped" })).body).toEqual({ ending: false });
    expect((await toClaim(name, "/internal/free", other)).body).toEqual({ freed: false, held: false });
    expect((await claimState(name)).claim).toMatchObject({ state: "live" });
    expect((await toClaim(name, "/internal/end", { ...mine, reason: "Not a code" })).status).toBe(400);
    expect((await toClaim(name, "/internal/end", { ...mine, reason: "hostname_unmapped" })).body).toEqual({ ending: true });
    expect((await toClaim(name, "/internal/end", { ...mine, reason: "hostname_moved" })).body).toEqual({ ending: true });
    expect((await toClaim(name, "/internal/free", mine)).body).toEqual({ freed: true, held: true });
    expect((await toClaim(name, "/internal/free", mine)).body).toEqual({ freed: false, held: false });
    expect(await inClaim(name, (sql) => sql.exec("SELECT end_reason FROM claim").toArray())).toEqual([{ end_reason: "hostname_unmapped" }]);
    await alarmQuiet(stub(r.room));
  });

  it("is bound to no provider for custom hostnames in any environment", () => {
    const wrangler: string = BINDINGS.TEST_API_WRANGLER;
    for (const name of ["CUSTOM_HOSTNAME_ZONE_ID", "CUSTOM_HOSTNAME_TOKEN"]) expect(wrangler.includes(name), name).toBe(false);
  });
});

describe("the gate on claims, open while the release path isn't complete (M6 step 8)", () => {
  it("opens nothing by itself: no ask where RELEASES is unset or a content provider is configured, no look while RELEASES is unset, and no create anywhere", async () => {
    const r = await room("org_ch_claims_open");
    // The path is complete since 2026-11-23; a test build closes it for this room alone, to show what it refused.
    await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_release_path_incomplete (x INTEGER)"));
    const name = newName();
    const looks = async () => ((await (await fetch("https://resolver-fake.example.com/asked")).json()) as string[]).filter((line) => line.includes(name)).length;
    // RELEASES unset, as in every environment: the route can't be told from one nobody defined, and nothing is written.
    const unset = await api(r.owner, "PUT", path(r), { hostname: name });
    const nobody = await api(r.owner, "PUT", `${path(r)}x`, { hostname: name });
    expect([unset.status, unset.code]).toEqual([nobody.status, nobody.code]);
    expect(unset.code).toBe("not_found");
    // RELEASES on and a content provider configured, while the release path isn't complete: refused as a route that
    // isn't built, exactly as every release command is.
    await inRoom(r.room, (sql) => sql.exec("DROP TABLE test_content_provider_off"));
    const refused = await switchedOn(() => api(r.owner, "PUT", path(r), { hostname: name }));
    expect([refused.status, refused.code]).toEqual([409, "release_not_available"]);
    expect(await requestRow(r)).toBeNull();
    expect(await events(r)).toEqual([]);
    await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)"));
    // RELEASES on with no content provider, the one place the release path's gate doesn't refuse: asked, and pending.
    const request = (await switchedOn(() => api(r.owner, "PUT", path(r), { hostname: name }))).body.request;
    await alarmQuiet(stub(r.room));
    await answerWith(name, request.challenge_value);
    const before = await looks();
    // With RELEASES unset again, the proof job looks nothing up and asks for nothing, though the value is in DNS.
    await due(r);
    await quietPass(r);
    expect(await looks()).toBe(before);
    expect(await requestRow(r)).toMatchObject({ state: "pending", claimed_at: null });
    expect((await claimState(name)).claim).toBeNull();
    // RELEASES on: the claim is given and committed, but nothing is made at Cloudflare while the release path isn't
    // complete, pass after pass, with a provider for custom hostnames configured.
    await step(r);
    expect(await requestRow(r)).toMatchObject({ state: "claimed" });
    for (let i = 0; i < 3; i++) await step(r);
    expect(await cloudflare(name)).toEqual({ held: null, calls: [] });
    expect(await providerRow(r)).toMatchObject({ create_sent_at: null, provider_id: null });
    // Nothing routes: no custom host is made without the custom hostname at Cloudflare reading active.
    expect(await all(r.room, "SELECT host FROM serve_state WHERE kind = 'custom'")).toEqual([]);
    // The create's gate alone holds routing back, apart from the content provider being off: with a content provider
    // configured and the name already reading active at Cloudflare, the room still creates and reads nothing, so no
    // custom host is made and the claim stays as it was.
    await inRoom(r.room, (sql) => sql.exec("DROP TABLE test_content_provider_off"));
    await setAtCloudflare(name, "active");
    for (let i = 0; i < 3; i++) await step(r);
    expect((await cloudflare(name)).calls).toEqual([]);
    expect(await providerRow(r)).toMatchObject({ create_sent_at: null, provider_id: null, provider_status: null });
    expect(await all(r.room, "SELECT host FROM serve_state WHERE kind = 'custom'")).toEqual([]);
    expect(await requestRow(r)).toMatchObject({ state: "claimed" });
    await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)"));
    // The gate on claims is one constant, true, set in one place; the release path's is true too since 2026-11-23,
    // closed here by the test build for this room alone.
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    expect(sources["workspace/hostname.rs"]).toContain("pub(crate) const HOSTNAME_CLAIMS_COMPLETE: bool = true;");
    expect(sources["workspace/release_commit.rs"]).toContain("pub(crate) const RELEASE_PATH_COMPLETE: bool = true;");
  });
});
