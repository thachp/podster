import { createExecutionContext, createScheduledController, env, runInDurableObject, SELF, waitOnExecutionContext } from "cloudflare:test";
// The Worker's own entry, as it is built: the scheduled handler is called on it directly, since no schedule calls it.
import ApiWorker from "../build/index.js";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet, nextAlarm } from "./alarm";

// M6 step 4(a), the first of three PRs (ADR 0010's "Takedown"): an operator suspends a room's app and lifts that, the
// room unpublishes in one transaction, its applier removes the serve entries, and its delete job removes the scripts
// and counts them gone only on the provider's own word. Everything is behind `RELEASES`, which no deployment sets.
//
// Nothing writes a room's release state yet (configuration is step 6's and a commit step 5's), so each test writes
// the rows it needs straight into the room, through the test pool, which is no route. The provider is the stand-in in
// `fake-content.ts`.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { account: string; namespace: string; kvNamespace: string; domain: string; scriptsToken: string; routingToken: string };
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OWNER: Who = { id: "per_td_owner", kind: "person", org: "org_td", adminOrgs: ["org_td"] };
const AGENT: Who = { id: "agt_td_agent", org: "org_td" };
const OPERATOR: Who = { id: "per_operator_one", kind: "person", org: "org_td_ops" };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }) })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, raw?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who) };
  if (method !== "GET") headers["idempotency-key"] = `td-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : raw ?? JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).toArray());
const one = (room: string, query: string, ...values: unknown[]) => inRoom(room, (sql) => sql.exec(query, ...values).one());
const refuses = (run: () => unknown) => { try { run(); return false; } catch { return true; } };
const actions = (subject: string) => runInDurableObject(BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation")), (_: any, state: any) =>
  // The object makes its table on its first call: before any operator has acted, there is no log to read.
  state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'operator_action'").toArray().length === 0 ? []
    : state.storage.sql.exec("SELECT operator, subject_kind, action, reason, outcome FROM operator_action WHERE subject = ? ORDER BY seq", subject).toArray());

/** Release switched on for the test Worker, as no deployment is, while `run` runs. */
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

const fake = (path: string, body?: unknown) => fetch(`https://content-fake.example.com${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
type Held = { scripts: string[]; entries: Record<string, string>; calls: { op: string; name: string; status: number }[]; expiredGates: number };
const held = async () => (await (await fake("/state")).json()) as Held;
const fault = (body: object) => fake("/fault", body);
/** Holds the next call of one kind at the stand-in. `arrived` answers once that call is there; `release` lets it go. */
const gate = async (op: string) => ((await (await fake("/gate", { op })).json()) as { id: number }).id;
const arrived = (id: number) => fake(`/arrived?id=${id}`);
const release = (id: number) => fake(`/release?id=${id}`);

let labels = 0;
/** A label no other test has used: lower-case letters and digits, as the server would make. */
const newLabel = () => `td${(++labels).toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
const rel = (n: number) => `rel_${n.toString(16).padStart(2, "0").repeat(16)}`;
const SHA = "ab".repeat(20);

type App = { room: string; label: string; host: string; served: string; kept: string; flight: string; queued: string };
/**
 * A room with an app as a later step would leave it mid-release: one release served and kept for a rollback, one
 * served before a third was committed live and is still waiting for its marker, and a fourth queued behind it.
 * `opts.plain` leaves out the commit in flight: the room just serves its second release.
 */
/** Every room `app` made, so each is left with no alarm run under way and none to come, whether its test passed or failed. */
const madeApps: string[] = [];
async function app(opts: { plain?: boolean; epoch?: number; index?: boolean } = {}): Promise<App> {
  const room: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
  madeApps.push(room);
  // Making a room sets its alarm a moment ahead. It is run out and cleared here, before any row is written, so no run
  // of it can land between the rows below or between a test's next steps: nothing is set or running after this, and
  // only a command or a test's own pass runs one.
  await alarmQuiet(stub(room));
  const label = newLabel();
  const host = `${label}.${FAKE.domain}`;
  const script = (id: string) => `${label}.${id}`;
  const [kept, served, flight, queued] = [script(rel(1)), script(rel(2)), script(rel(3)), script(rel(4))];
  const epoch = opts.epoch ?? 4;
  await inRoom(room, (sql) => {
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    const release = (id: string, state: string, withScript: boolean) => sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'per_td_owner', 1, ?, ?, 1)`,
      id, SHA, state, label, epoch, withScript ? script(id) : null, withScript ? id : null, state === "queued" ? null : "per_td_owner", state === "queued" ? null : 1);
    release(rel(1), "replaced", true);
    release(rel(2), "served", true);
    if (!opts.plain) release(rel(3), "live", true);
    release(rel(4), "queued", false);
    if (opts.plain) {
      sql.exec("INSERT INTO release_config (singleton, enabled, release_epoch, set_by, set_at, updated_at, kept_previous) VALUES (1, 1, ?, 'per_td_owner', 1, 1, ?)", epoch, kept);
      sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, rel(2), served);
    } else {
      sql.exec(
        "INSERT INTO release_config (singleton, enabled, release_epoch, set_by, set_at, updated_at, kept_previous, in_flight_release, in_flight_script, in_flight_epoch, in_flight_at) VALUES (1, 1, ?, 'per_td_owner', 1, 1, ?, ?, ?, ?, 1)",
        epoch, kept, rel(3), flight, epoch);
      sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, flight_version, flight_before, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 6, 6, ?, 1)", host, label, rel(3), flight, served);
    }
    // The applier's own record of the entry it last wrote, so a pass has nothing to do until the room changes its mind.
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, ?, ?, 1, 1)", host, opts.plain ? 5 : 6, opts.plain ? served : flight);
  });
  if (opts.index !== false) await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, room).run();
  // What the provider holds for it: the three scripts, and the entry the applier last wrote.
  await fake("/seed", { scripts: opts.plain ? [kept, served] : [kept, served, flight], entries: { [host]: opts.plain ? served : flight } });
  return { room, label, host, served, kept, flight, queued };
}

const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const claimOf = (hostname: string) => BINDINGS.HOSTNAME_CLAIM.get(BINDINGS.HOSTNAME_CLAIM.idFromName(hostname));
const inClaim = <T>(hostname: string, fn: (sql: any) => T) => runInDurableObject(claimOf(hostname), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
/** One whole run of an object's alarm, which waits out a run the runtime started and has ended when this returns. */
const settle = (object: DurableObjectStub) => alarmPass(object);
const stopDomain = (who: Who = OPERATOR, reason = "illegal") => api(who, "POST", "/v1/moderation/content-domain/stop", { reason });
const resumeDomain = (who: Who = OPERATOR, reason = "other") => api(who, "POST", "/v1/moderation/content-domain/resume", { reason });
const stopRow = () => inModeration((sql) => sql.exec("SELECT stopped, reason, version, applied_version, attempts, attempt_version, next_attempt_at, last_code FROM content_stop").toArray()[0] ?? null);
const stopCalls = async () => (await held()).calls.filter((call) => call.name === "_stop").map((call) => `${call.op} ${call.status}`);
const suspendHost = (host: string, who: Who = OPERATOR, reason = "abuse") => api(who, "POST", `/v1/moderation/app-hosts/${host}/suspend`, { reason });
const liftHost = (host: string, who: Who = OPERATOR, reason = "other") => api(who, "POST", `/v1/moderation/app-hosts/${host}/lift`, { reason });
let hostnames = 0;
/** A custom hostname no other test has used. */
const newHostname = () => `h${(++hostnames).toString(36)}${crypto.randomUUID().slice(0, 8)}.example.org`;

// The two reconciles (third PR). A pass runs in the Moderation object: a test calls the object's own path and reads
// the pass's summary, or calls the Worker's scheduled handler, which no environment's schedule ever does.
const ENTRIES_CRON = "*/5 * * * *";
const SCRIPTS_CRON = "0 * * * *";
// A pass runs as in a deployment that has a provider, which sets `RELEASES` explicitly (M6 step 6): written `true` here
// (test builds only). Unset, the setting is undecided, and each pass tells operators so, which
// `release-triggers.spec.ts` shows on its own.
const reconcile = async (which: "entries" | "scripts") => {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_setting (value TEXT)").run();
  await BINDINGS.DB.prepare("INSERT INTO test_releases_setting (value) VALUES ('true')").run();
  try {
    return (await (await moderation().fetch(`https://do/reconcile/${which}`, { method: "POST" })).json()) as any;
  } finally {
    await BINDINGS.DB.prepare("DROP TABLE test_releases_setting").run();
  }
};
async function scheduled(cron: string, bindings: object = env) {
  const ctx = createExecutionContext();
  await new (ApiWorker as any)(ctx, bindings).scheduled(createScheduledController({ cron, scheduledTime: new Date() }));
  await waitOnExecutionContext(ctx);
}
const findings = async () => ((await switchedOn(() => api(OPERATOR, "GET", "/v1/moderation/takedown-findings"))).body.findings as { code: string; subject: string; detail: string | null; seen: number }[]);
// A deletion a reconcile started is told as `queued` and then `gone`, by the room's own delete job's time: which of
// the two a test reads isn't the test's to assume, so the line leaves it out.
const found = async () => (await findings()).map((finding) => `${finding.code} ${finding.subject}${finding.detail && finding.code !== "script_delete_queued" ? ` ${finding.detail}` : ""}`).sort();
/**
 * A pass starts from nothing: no room in the lookup table but the ones this test makes after it, no finding kept, and
 * each pass at the start of its list. So no room of an earlier test is woken, and what a test reads is its own.
 */
async function fresh() {
  await BINDINGS.DB.prepare("DELETE FROM app_label_index").run();
  await moderation().fetch("https://do/takedown-findings");
  await inModeration((sql) => { for (const table of ["takedown_finding", "reconcile_pass", "reconcile_failure"]) sql.exec(`DELETE FROM ${table}`); sql.exec("DROP TABLE IF EXISTS test_reconcile_budget"); });
}
const listCalls = async (op: string) => (await held()).calls.filter((call) => call.op === op).length;

const suspend = (label: string, who: Who = OPERATOR, reason = "abuse") => api(who, "POST", `/v1/moderation/apps/${label}/suspend`, { reason });
const lift = (label: string, who: Who = OPERATOR, reason = "other") => api(who, "POST", `/v1/moderation/apps/${label}/lift`, { reason });
const serveRows = (room: string) => all(room, "SELECT host, kind, label, label_current, release_id, script_name, version, closed, flight_version, flight_before FROM serve_state ORDER BY host");
const configRow = (room: string) => one(room, "SELECT release_epoch, kept_previous, in_flight_release, in_flight_script, in_flight_epoch, in_flight_at FROM release_config");
const applyRows = (room: string) => all(room, "SELECT host, applied_version, applied_script, attempts, last_code FROM serve_apply ORDER BY host");
const waitRows = (room: string) => all(room, "SELECT attempts, attempt_version, next_attempt_at, last_code FROM serve_apply ORDER BY host");
const deleteRows = (room: string) => all(room, "SELECT script_name, unpublish_epoch, attempts, last_code, gone_at IS NOT NULL AS gone FROM script_delete ORDER BY script_name");
/** Every wait is over: the next pass tries everything again. */
const due = (room: string) => inRoom(room, (sql) => { sql.exec("UPDATE serve_apply SET next_attempt_at = 0 WHERE next_attempt_at IS NOT NULL"); sql.exec("UPDATE script_delete SET next_attempt_at = 0 WHERE gone_at IS NULL"); });
/**
 * Every wait is far from over, whatever the clock does: the next pass tries nothing that is waiting. A test that
 * shows "it waits" sets this, so it never depends on a 5-second wait not having run out between two of its steps.
 */
const FAR = () => Date.now() + 24 * 60 * 60 * 1000;
const notDue = (room: string) => inRoom(room, (sql) => { sql.exec("UPDATE serve_apply SET next_attempt_at = ? WHERE next_attempt_at IS NOT NULL", FAR()); sql.exec("UPDATE script_delete SET next_attempt_at = ? WHERE gone_at IS NULL AND attempts > 0", FAR()); });
const pass = (room: string) => alarmPass(stub(room));
/**
 * One pass, and in the same turn every wait it left is put far ahead. For a test that goes on to count attempts: no
 * later run can try again by itself, however long the test takes, until the test says a wait is over with `due`.
 */
const passAndHold = (room: string) => runInDurableObject(stub(room), async (instance: any, state: any) => {
  await state.storage.deleteAlarm();
  await instance.alarm();
  state.storage.sql.exec("UPDATE serve_apply SET next_attempt_at = ? WHERE next_attempt_at IS NOT NULL", FAR());
  state.storage.sql.exec("UPDATE script_delete SET next_attempt_at = ? WHERE gone_at IS NULL AND attempts > 0", FAR());
});
const callsFor = (state: Held, app: App) => state.calls.filter((call) => call.name === app.host || call.name.startsWith(`${app.label}.`)).map((call) => `${call.op} ${call.name === app.host ? "host" : call.name.slice(app.label.length + 1, app.label.length + 7)} ${call.status}`);

/** A room whose app is down in its own state, with the entry still at the provider and the applier yet to run.
 * No alarm is set or running when it returns, so what a test scripts next is what the next pass meets. */
async function downButNotApplied() {
  const a = await app({ plain: true });
  await switchedOn(() => suspend(a.label));
  await alarmQuiet(stub(a.room));
  await fake("/reset", {});
  await fake("/seed", { scripts: [a.kept, a.served], entries: { [a.host]: a.served } });
  // As it was the moment the suspension committed: nothing applied, and both scripts still owed a delete.
  await inRoom(a.room, (sql) => { sql.exec("DELETE FROM serve_apply"); sql.exec("UPDATE script_delete SET gone_at = NULL, attempts = 0, next_attempt_at = 0, last_code = NULL"); sql.exec("UPDATE unpublish SET scripts_gone_at = NULL"); });
  return a;
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(OWNER) }, body: JSON.stringify({ org_id: AGENT.org, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register agent: ${res.status}`);
});

beforeEach(async () => { await fake("/reset", {}); });
afterEach(async () => { for (const room of madeApps.splice(0)) await alarmQuiet(stub(room)); });

describe("an operator's suspension of an app", () => {
  it("is nothing anyone can find while release is switched off", async () => {
    const a = await app();
    const before = [await serveRows(a.room), await configRow(a.room)];
    for (const who of [OPERATOR, OWNER, AGENT]) {
      const [real, unknown] = [await suspend(a.label, who), await api(who, "POST", `/v1/moderation/apps/${a.label}/suspendx`, { reason: "abuse" })];
      expect([real.status, real.code], who.id).toEqual([404, "not_found"]);
      expect([real.status, real.body], who.id).toEqual([unknown.status, unknown.body]);
    }
    expect((await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${a.host}/suspend`, { reason: "abuse" })).code).toBe("not_found");
    expect([await serveRows(a.room), await configRow(a.room)]).toEqual(before);
    expect(await actions(a.label)).toEqual([]);
    await alarmQuiet(stub(a.room));
  });

  it("settles who is asking before it says anything else", async () => {
    const a = await app();
    await switchedOn(async () => {
      // An agent, then anyone who isn't an operator, the room's own owner included: refused whatever they sent.
      for (const body of [{ reason: "abuse" }, {}, { reason: "nonsense" }]) {
        expect((await api(AGENT, "POST", `/v1/moderation/apps/${a.label}/suspend`, body)).code).toBe("not_allowed");
        expect((await api(OWNER, "POST", `/v1/moderation/apps/${a.label}/suspend`, body)).code).toBe("not_allowed");
        expect((await api(OWNER, "POST", `/v1/moderation/apps/nosuchlabel/lift`, body)).code).toBe("not_allowed");
        expect((await api(OWNER, "POST", `/v1/moderation/app-hosts/${a.host}/suspend`, body)).code).toBe("not_allowed");
        expect((await api(OWNER, "POST", `/v1/moderation/app-hosts/app.example.org/suspend`, body)).code).toBe("not_allowed");
      }
      // An operator: the body, then whether there is such an app.
      for (const body of [{}, { reason: "nonsense" }, { reason: "abuse", extra: 1 }]) expect((await api(OPERATOR, "POST", `/v1/moderation/apps/${a.label}/suspend`, body)).code).toBe("invalid_argument");
      expect((await api(OPERATOR, "POST", `/v1/moderation/apps/${a.label}/suspend`, undefined, "{")).code).toBe("invalid_argument");
      for (const label of ["nosuchlabel", "UPPER", "has-dash", "a".repeat(27), "a.b"]) expect([(await suspend(label)).status, (await suspend(label)).code], label).toEqual([404, "not_found"]);
    });
    expect((await one(a.room, "SELECT suspended_at FROM app_label")).suspended_at).toBeNull();
    expect(await actions(a.label)).toEqual([]);
    await alarmQuiet(stub(a.room));
  });

  it("never acts on the lookup table's word: the room named must say the label is its own", async () => {
    const a = await app();
    const other: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Another" })).body.id;
    const [stray, nowhere, unlisted] = [newLabel(), newLabel(), await app({ index: false })];
    // A row that names a room which never had the label, and one that names no room at all.
    await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(stray, a.room).run();
    await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(nowhere, `ws_${"0".repeat(32)}`).run();
    const before = [await serveRows(a.room), await configRow(a.room), await all(a.room, "SELECT label, suspended_at FROM app_label")];
    await switchedOn(async () => {
      expect([(await suspend(stray)).status, (await suspend(stray)).code]).toEqual([404, "not_found"]);
      // A row that names no room is the same answer as a label no room has, as the contract says.
      expect([(await suspend(nowhere)).status, (await suspend(nowhere)).code]).toEqual([404, "not_found"]);
      // A room's own label that the table doesn't list finds no room: reported as not found, and nothing is guessed.
      expect((await suspend(unlisted.label)).code).toBe("not_found");
    });
    expect([await serveRows(a.room), await configRow(a.room), await all(a.room, "SELECT label, suspended_at FROM app_label")]).toEqual(before);
    expect((await one(unlisted.room, "SELECT suspended_at FROM app_label")).suspended_at).toBeNull();
    expect(await all(other, "SELECT label FROM app_label")).toEqual([]);
    // Each try is in the operators' log with its refusal, so none happened unrecorded.
    expect((await actions(stray)).map((row: any) => row.outcome)).toEqual(["refused_404", "refused_404"]);
    for (const room of [a.room, unlisted.room]) await alarmQuiet(stub(room));
  });

  it("unpublishes in one room transaction: the epoch up, every host to nothing, the kept script and the flight forgotten", async () => {
    const a = await app();
    const events = () => all(a.room, "SELECT type, actor_id FROM event WHERE type LIKE 'app.%' ORDER BY seq");
    // The suspension wakes the room's alarm at once. With no provider for this room it does nothing, so what is read
    // below is exactly what the transaction left, whenever the alarm runs.
    await inRoom(a.room, (sql) => sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)"));
    const answer = await switchedOn(() => suspend(a.label));
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ label: a.label, suspended: true, reason: "abuse", at: expect.any(Number) });
    // The state, as core's `unpublish` leaves it.
    expect(await configRow(a.room)).toEqual({ release_epoch: 5, kept_previous: null, in_flight_release: null, in_flight_script: null, in_flight_epoch: null, in_flight_at: null });
    expect(await serveRows(a.room)).toEqual([{ host: a.host, kind: "default", label: null, label_current: null, release_id: null, script_name: null, version: 7, closed: 0, flight_version: null, flight_before: null }]);
    expect(await all(a.room, "SELECT cause, label, release_epoch, scripts_gone_at FROM unpublish")).toEqual([{ cause: "app_suspended", label: a.label, release_epoch: 5, scripts_gone_at: null }]);
    expect(await one(a.room, "SELECT suspended_at IS NOT NULL AS suspended, suspension_reason FROM app_label")).toEqual({ suspended: 1, suspension_reason: "abuse" });
    // The releases that were up are unpublished. The one still queued ends failed in the same transaction (step 5):
    // the epoch it started under is gone, so it could never go live.
    expect(await all(a.room, "SELECT id, state, failure_code, release_epoch FROM release ORDER BY id")).toEqual([
      { id: rel(1), state: "replaced", failure_code: null, release_epoch: 4 }, { id: rel(2), state: "unpublished", failure_code: null, release_epoch: 4 },
      { id: rel(3), state: "unpublished", failure_code: null, release_epoch: 4 }, { id: rel(4), state: "failed", failure_code: "release_epoch_moved", release_epoch: 4 },
    ]);
    // Every script core names is owed a delete: what a host served, what was kept, and the flight's own and the one before it.
    expect(await deleteRows(a.room)).toEqual([a.kept, a.served, a.flight].sort().map((script_name) => ({ script_name, unpublish_epoch: 5, attempts: 0, last_code: null, gone: 0 })));
    // Recorded as Podster's act, never the operator's own ID, and told to the room's managers.
    expect(await events()).toEqual([{ type: "app.suspended", actor_id: "podster" }]);
    expect(await all(a.room, "SELECT actor_id, action FROM audit_event WHERE action LIKE 'app.%'")).toEqual([{ actor_id: "podster", action: "app.suspended" }]);
    expect(JSON.stringify(await all(a.room, "SELECT * FROM event WHERE type LIKE 'app.%'"))).not.toContain(OPERATOR.id);
    expect(await actions(a.label)).toEqual([{ operator: OPERATOR.id, subject_kind: "app", action: "suspend", reason: "abuse", outcome: "done" }]);

    // Asking again changes nothing: no second unpublish, no new epoch, no new event.
    const again = await switchedOn(() => suspend(a.label, OPERATOR, "spam"));
    expect(again.body).toEqual(answer.body);
    expect((await configRow(a.room)).release_epoch).toBe(5);
    expect((await serveRows(a.room))[0].version).toBe(7);
    expect(await events()).toHaveLength(1);
    await alarmQuiet(stub(a.room));
  });

  it("then removes the serve entry first, and deletes the scripts behind it, each confirmed by the provider's own answer", async () => {
    const a = await app();
    expect((await held()).entries[a.host]).toBe(a.flight);
    await switchedOn(() => suspend(a.label));
    await pass(a.room);
    const state = await held();
    expect(state.entries[a.host]).toBeUndefined();
    expect(state.scripts.filter((name) => name.startsWith(`${a.label}.`))).toEqual([]);
    // The entry's removal and its read-back come before any script is touched.
    const calls = callsFor(state, a);
    expect(calls.slice(0, 2)).toEqual(["entry.delete host 200", "entry.get host 404"]);
    expect(calls.slice(2).every((call) => call.startsWith("script."))).toBe(true);
    // A first delete answers 200, which isn't "gone". The read that answers 200 with `"script": null` is.
    for (const id of [rel(1), rel(2), rel(3)]) expect(calls.filter((call) => call.includes(` ${id.slice(0, 6)} `))).toEqual([`script.delete ${id.slice(0, 6)} 200`, `script.get ${id.slice(0, 6)} 200`]);
    expect(await applyRows(a.room)).toEqual([{ host: a.host, applied_version: 7, applied_script: null, attempts: 0, last_code: null }]);
    expect((await deleteRows(a.room)).map((row: any) => [row.gone, row.last_code])).toEqual([[1, null], [1, null], [1, null]]);
    expect((await one(a.room, "SELECT scripts_gone_at IS NOT NULL AS done FROM unpublish")).done).toBe(1);
    // Nothing left to do: a second pass calls the provider for nothing.
    await pass(a.room);
    expect((await held()).calls.length).toBe(state.calls.length);
  });

  it("removes the entries and the scripts though release bookkeeping fails on every pass, and a commit asked again sets the alarm for what is owed", async () => {
    // Step 5's bookkeeping runs at the start of the alarm, in a transaction of its own. Test builds only: it fails here.
    const a = await app();
    await inRoom(a.room, (sql) => sql.exec("CREATE TABLE test_release_bookkeeping_fails (x INTEGER)"));
    expect((await switchedOn(() => suspend(a.label))).status).toBe(200);
    await pass(a.room);
    const state = await held();
    expect([state.entries[a.host], state.scripts.filter((name) => name.startsWith(`${a.label}.`))]).toEqual([undefined, []]);
    // The queued release is left for a later run of the bookkeeping. Its epoch is gone, so it can never go live.
    expect((await one(a.room, "SELECT state FROM release WHERE id = ?", rel(4))).state).toBe("queued");

    // A commit that committed and couldn't set the alarm: asked again it finds the release live, and sets the alarm.
    const b = await app();
    await inRoom(b.room, (sql) => sql.exec("UPDATE serve_apply SET applied_version = 5"));
    await runInDurableObject(stub(b.room), (_: any, s: any) => s.storage.deleteAlarm());
    expect(await nextAlarm(stub(b.room))).toBeNull();
    const again = await stub(b.room).fetch("https://do/internal/release-commit-live", { method: "POST", body: JSON.stringify({ release_id: rel(3) }) });
    expect([again.status, ((await again.json()) as any).state]).toEqual([200, "live"]);
    expect(await nextAlarm(stub(b.room))).not.toBeNull();
  });

  it("keeps a record in the room when its release bookkeeping fails, tells operators from it at the third failure in a row, and clears it when it works", async () => {
    await fresh();
    const a = await app({ plain: true });
    const T = 1_800_000_000_000;
    const record = () => inRoom(a.room, (sql) => sql.exec("SELECT failures, first_failed_at, last_failed_at, last_code FROM release_bookkeeping").toArray());
    const ask = (room: string) => stub(room).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify({ kind: "wake" }) }).then((r: Response) => r.json() as Promise<any>);
    const told = async (room: string) => (await ask(room)).findings.filter((finding: any) => finding.code === "release_bookkeeping_failing");
    /**
     * The reconcile's question with nothing able to come between: in one turn of the room, a run of its alarm under
     * way is waited out and its alarm cleared, `before` sets what the question starts from, and the question is asked.
     * No alarm is set again until the question has been answered.
     */
    const toldFrom = (before: (sql: any) => void) => runInDurableObject(stub(a.room), async (instance: any, state: any) => {
      await instance.alarm();
      await state.storage.deleteAlarm();
      before(state.storage.sql);
      const response: Response = await instance.fetch(new Request("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify({ kind: "wake" }) }));
      return ((await response.json()) as any).findings.filter((finding: any) => finding.code === "release_bookkeeping_failing");
    });
    const clockTo = (now: number) => inRoom(a.room, (sql) => { sql.exec("CREATE TABLE IF NOT EXISTS test_release_clock (now INTEGER)"); sql.exec("DELETE FROM test_release_clock"); sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", now); });
    // **The room's own alarm runs the bookkeeping too,** whenever it runs. So each counted step below is one turn of
    // the room (`toldFrom`): the alarm is run out and cleared, the count the step starts from is set, and the
    // question is asked, with no alarm able to come between. A count read after a step can be higher than the step
    // left it, and is asserted only as at least that.
    const failuresTo = (failures: number) => (sql: any) => void sql.exec("UPDATE release_bookkeeping SET failures = ?", failures);
    // Test builds only: release bookkeeping fails in this room, and the room's clock for it is the test's.
    await clockTo(T);
    await inRoom(a.room, (sql) => sql.exec("CREATE TABLE test_release_bookkeeping_fails (x INTEGER)"));
    expect(await record()).toEqual([]);
    // The first failure, after a suspension, which commits all the same. It is kept in the room's own row.
    expect((await switchedOn(() => suspend(a.label))).status).toBe(200);
    expect((await record())[0]).toMatchObject({ first_failed_at: T, last_failed_at: T, last_code: "internal_error" });
    expect((await record())[0].failures).toBeGreaterThanOrEqual(1);
    // The second in a row, at the reconcile's question a minute on, isn't told. When it first failed stays; when
    // it last failed moves.
    await clockTo(T + 60_000);
    expect(await toldFrom(failuresTo(1))).toEqual([]);
    expect((await record())[0]).toMatchObject({ first_failed_at: T, last_failed_at: T + 60_000, last_code: "internal_error" });
    // The third in a row is told, in the same answer, by the app's label and the code.
    await clockTo(T + 120_000);
    expect(await toldFrom(failuresTo(2))).toEqual([{ code: "release_bookkeeping_failing", subject: a.label, detail: "internal_error" }]);
    expect((await record())[0]).toMatchObject({ first_failed_at: T, last_failed_at: T + 120_000 });
    expect((await record())[0].failures).toBeGreaterThanOrEqual(3);
    // And it is first in the answer, so it is never the one left out.
    expect((await ask(a.room)).findings[0].code).toBe("release_bookkeeping_failing");
    // A pass of the reconcile carries it to the operators' record, and counts each time. **It has room of its own
    // there:** the shared part of the record is full, with a thousand findings of another kind, and it is kept.
    await inModeration((sql) => { for (let i = 0; i < 1000; i += 1) sql.exec("INSERT INTO takedown_finding (code, subject, first_seen_at, last_seen_at) VALUES ('entry_foreign_name', ?, 1, 1)", `filler-${i}.example.org`); });
    await fake("/seed", { scripts: [a.kept, a.served], entries: {} });
    await reconcile("scripts");
    expect((await inModeration((sql) => sql.exec("SELECT count(*) AS n FROM takedown_finding WHERE code = 'findings_full'").one().n))).toBe(0);
    const kept = async () => (await findings()).filter((finding: any) => finding.code === "release_bookkeeping_failing");
    expect((await kept()).map((finding: any) => [finding.subject, finding.detail])).toEqual([[a.label, "internal_error"]]);
    const first = (await kept())[0];
    await reconcile("scripts");
    const second = (await kept())[0];
    expect(second.seen).toBeGreaterThan(first.seen);
    expect(second.first_seen_at).toBe(first.first_seen_at);
    // No room's ID and no error's text: the subject is the label an operator suspends by, and the detail a code.
    expect(JSON.stringify(await kept())).not.toContain(a.room);
    expect(second.detail).toMatch(/^[a-z_]+$/);
    // **It is told from the row, not from that moment's try:** the alarm runs the bookkeeping too, and its failure
    // counts, with nothing asking.
    const before = (await record())[0].failures;
    await pass(a.room);
    expect((await record())[0].failures).toBeGreaterThan(before);
    // Working again: the record is cleared in the run that worked, the room stops telling, and the count stops rising.
    await inRoom(a.room, (sql) => sql.exec("DROP TABLE test_release_bookkeeping_fails"));
    expect(await told(a.room)).toEqual([]);
    expect(await record()).toEqual([]);
    await reconcile("scripts");
    expect((await kept())[0].seen).toBe(second.seen);
    // A streak starts again from one: a failure after it worked isn't told on the strength of the old ones. In one
    // turn the alarm is run out, the bookkeeping is made to fail, and the question is the first try to fail.
    expect(await toldFrom((sql) => void sql.exec("CREATE TABLE test_release_bookkeeping_fails (x INTEGER)"))).toEqual([]);
    expect((await record())[0]).toMatchObject({ first_failed_at: T + 120_000, last_code: "internal_error" });
    // A room with no app keeps the record too, and has no label to be told by.
    const bare: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
    madeApps.push(bare);
    await alarmQuiet(stub(bare));
    await inRoom(bare, (sql) => sql.exec("CREATE TABLE test_release_bookkeeping_fails (x INTEGER)"));
    for (let i = 0; i < 4; i += 1) expect(await told(bare)).toEqual([]);
    expect(await inRoom(bare, (sql) => sql.exec("SELECT failures FROM release_bookkeeping").one().failures)).toBeGreaterThanOrEqual(4);
  });

  it("never gives the reconcile more findings in one answer than it takes, whatever the room holds", async () => {
    // The reconcile takes a fixed number from one room's answer. The room's answer is built never to hold more: the
    // bookkeeping's one, the hosts it refused, the deletes that keep failing and the ones a pass started. That sum is
    // checked when the Worker is compiled, and read here from the same constants.
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    const constant = (file: string, name: string) => Number(sources[file].match(new RegExp(`const ${name}: (?:i64|usize) = (\\d+);`))?.[1]);
    const [hosts, failing, queued, taken] = [constant("workspace/takedown.rs", "HOST_FINDINGS"), constant("workspace/takedown.rs", "FINDINGS"), constant("workspace/takedown.rs", "QUEUED_FINDINGS"), constant("reconcile.rs", "ROOM_FINDINGS_TAKEN")];
    expect([hosts, failing, queued, taken]).toEqual([7, 8, 32, 48]);
    expect(1 + hosts + failing + queued).toBeLessThanOrEqual(taken);
    expect(sources["workspace/takedown.rs"]).toContain("1 + HOST_FINDINGS + FINDINGS + QUEUED_FINDINGS <= crate::reconcile::ROOM_FINDINGS_TAKEN as i64");
    expect(sources["reconcile.rs"]).toContain(".take(ROOM_FINDINGS_TAKEN)");
    // A room has two hosts at most, so the hosts' share is never short: one default host, by the room's own index,
    // and one custom hostname, since a room has one open request for one. Each is refused by the room's own schema.
    const a = await app({ plain: true });
    expect(refuses(() => { throw new Error("placeholder"); })).toBe(true);
    await expect(inRoom(a.room, (sql) => void sql.exec("INSERT INTO serve_state (host, kind, version, updated_at) VALUES ('second-default.example.org', 'default', 1, 1)"))).rejects.toThrow();
    const request = (id: string, hostname: string) => inRoom(a.room, (sql) => void sql.exec("INSERT INTO hostname_request (id, hostname, state, open, challenge, generation, requested_by, requested_at, expires_at, updated_at) VALUES (?, ?, 'pending', 1, ?, 0, 'per_td_owner', 1, 2, 1)", id, hostname, "ab".repeat(32)));
    await request("hr_first", "first.example.org");
    await expect(request("hr_second", "second.example.org")).rejects.toThrow();
    // And a room filled with every kind at once answers with no more than is taken, the bookkeeping's finding first.
    const T = 1_800_000_000_000;
    await inRoom(a.room, (sql) => {
      sql.exec("INSERT INTO release_bookkeeping (singleton, failures, first_failed_at, last_failed_at, last_code) VALUES (1, 3, 1, 2, 'internal_error')");
      sql.exec("CREATE TABLE test_release_bookkeeping_fails (x INTEGER)");
      for (let i = 0; i < 60; i += 1) {
        const id = `rel_${(1000 + i).toString(16).padStart(32, "0")}`;
        // Half keep failing, and all were queued under no unpublish just now, as a pass queues them.
        sql.exec("INSERT INTO script_delete (script_name, label, queued_at, attempts, next_attempt_at, last_code) VALUES (?, ?, ?, ?, ?, 'delete_500')", `${a.label}.${id}`, a.label, Date.now(), i % 2 === 0 ? 12 : 0, T);
      }
    });
    const answer = await stub(a.room).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify({ kind: "wake" }) }).then((r: Response) => r.json() as Promise<any>);
    const counts: Record<string, number> = {};
    for (const finding of answer.findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1;
    expect(counts).toEqual({ release_bookkeeping_failing: 1, script_delete_failing: 8, script_delete_queued: 32 });
    expect(answer.findings.length).toBeLessThanOrEqual(taken);
    expect(answer.findings[0].code).toBe("release_bookkeeping_failing");
  });

  it("doesn't count an unpublish done with its files while a release's own script is still unqueued", async () => {
    // A release that had begun its upload before the unpublish has a script of its own. It is queued only when the
    // room's bookkeeping ends the release, after the unpublish. Here that bookkeeping fails for a while. The room's
    // clock for release bookkeeping is the test's, so the upload is never an hour old, however long this takes.
    const T = 1_800_000_000_000;
    const a = await app({ plain: true });
    const uploading = `${a.label}.${rel(5)}`;
    await inRoom(a.room, (sql) => {
      sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
      sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
      sql.exec(
        `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
           VALUES (?, ?, 'uploading', ?, 1, 4, ?, ?, 'per_td_owner', 1, 'per_td_owner', 1, ?, 1)`, rel(5), SHA, a.label, uploading, rel(5), T);
      sql.exec("CREATE TABLE test_release_bookkeeping_fails (x INTEGER)");
    });
    await fake("/seed", { scripts: [uploading] });
    expect((await switchedOn(() => suspend(a.label))).status).toBe(200);
    await pass(a.room);
    // The unpublish's own two scripts are gone at the provider, by its own answer. The upload's script is still
    // there, queued nowhere, and its release hasn't been ended.
    let state = await held();
    expect(state.scripts.filter((name) => name.startsWith(`${a.label}.`))).toEqual([uploading]);
    expect((await deleteRows(a.room)).map((row: any) => [row.script_name, row.gone])).toEqual([a.kept, a.served].sort().map((name) => [name, 1]));
    expect((await one(a.room, "SELECT state FROM release WHERE id = ?", rel(5))).state).toBe("uploading");
    // So the unpublish is not done with its files.
    expect((await one(a.room, "SELECT scripts_gone_at IS NOT NULL AS done FROM unpublish")).done).toBe(0);
    // The bookkeeping works again: the release ends, its script is queued under that unpublish, and goes.
    await inRoom(a.room, (sql) => sql.exec("DROP TABLE test_release_bookkeeping_fails"));
    await pass(a.room);
    // The script was queued at the test's clock, which is ahead of this machine's: its wait is called over, so the
    // delete job, which runs by the machine's clock, takes it on the next pass.
    await due(a.room);
    await pass(a.room);
    state = await held();
    expect(state.scripts.filter((name) => name.startsWith(`${a.label}.`))).toEqual([]);
    expect(await one(a.room, "SELECT state, failure_code FROM release WHERE id = ?", rel(5))).toEqual({ state: "failed", failure_code: "release_epoch_moved" });
    expect((await deleteRows(a.room)).map((row: any) => [row.script_name, row.unpublish_epoch, row.gone])).toEqual([a.kept, a.served, uploading].sort().map((name) => [name, 5, 1]));
    // Only now is it done.
    expect((await one(a.room, "SELECT scripts_gone_at IS NOT NULL AS done FROM unpublish")).done).toBe(1);

    // And a script queued late, under a later unpublish, also closes an earlier one that only it was holding open.
    const b = await app({ plain: true });
    const late = `${b.label}.${rel(5)}`;
    await inRoom(b.room, (sql) => {
      sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
      sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
      sql.exec(
        `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
           VALUES (?, ?, 'uploading', ?, 1, 4, ?, ?, 'per_td_owner', 1, 'per_td_owner', 1, ?, 1)`, rel(5), SHA, b.label, late, rel(5), T);
      sql.exec("CREATE TABLE test_release_bookkeeping_fails (x INTEGER)");
    });
    await fake("/seed", { scripts: [late] });
    await switchedOn(() => suspend(b.label));
    await pass(b.room);
    // Lifted and suspended again while the bookkeeping still fails: a second unpublish, with no files of its own.
    await switchedOn(() => lift(b.label));
    await switchedOn(() => suspend(b.label));
    expect(await all(b.room, "SELECT release_epoch, scripts_gone_at IS NOT NULL AS done FROM unpublish ORDER BY release_epoch")).toEqual([{ release_epoch: 5, done: 0 }, { release_epoch: 6, done: 0 }]);
    await inRoom(b.room, (sql) => sql.exec("DROP TABLE test_release_bookkeeping_fails"));
    await pass(b.room);
    await due(b.room);
    await pass(b.room);
    expect((await held()).scripts).not.toContain(late);
    expect((await one(b.room, "SELECT unpublish_epoch FROM script_delete WHERE script_name = ?", late)).unpublish_epoch).toBe(6);
    expect(await all(b.room, "SELECT release_epoch, scripts_gone_at IS NOT NULL AS done FROM unpublish ORDER BY release_epoch")).toEqual([{ release_epoch: 5, done: 1 }, { release_epoch: 6, done: 1 }]);
  });

  it("queues an upload's script under the unpublish that owes it, whichever path queues it, past the upload's hour", async () => {
    const T = 1_800_000_000_000;
    const HOUR = 60 * 60 * 1000;
    const clockTo = (room: string, now: number) => inRoom(room, (sql) => { sql.exec("DELETE FROM test_release_clock"); sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", now); });
    const unpublish = (room: string) => one(room, "SELECT release_epoch, scripts_gone_at IS NOT NULL AS done FROM unpublish");
    const queuedAs = (room: string, script: string) => all(room, "SELECT unpublish_epoch, gone_at IS NOT NULL AS gone FROM script_delete WHERE script_name = ?", script);
    const checkScript = (room: string, script: string) => stub(room).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify({ kind: "script", script }) }).then((r: Response) => r.json() as Promise<any>);
    const withUpload = async (opts: { providerOff?: boolean } = {}) => {
      const made = await app({ plain: true });
      const script = `${made.label}.${rel(5)}`;
      await inRoom(made.room, (sql) => {
        if (opts.providerOff) sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
      sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
      sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
      sql.exec(
        `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
           VALUES (?, ?, 'uploading', ?, 1, 4, ?, ?, 'per_td_owner', 1, 'per_td_owner', 1, ?, 1)`, rel(5), SHA, made.label, script, rel(5), T);
      sql.exec("CREATE TABLE test_release_bookkeeping_fails (x INTEGER)");
      });
      await fake("/seed", { scripts: [script] });
      expect((await switchedOn(() => suspend(made.label))).status).toBe(200);
      return { ...made, script };
    };

    // (a) The unpublish's own scripts are already gone when the upload's hour passes, and the room's bookkeeping,
    // working again, ends the release as expired before it looks at the unpublish.
    const a = await withUpload();
    await pass(a.room);
    expect([(await held()).scripts.includes(a.script), await unpublish(a.room)]).toEqual([true, { release_epoch: 5, done: 0 }]);
    await clockTo(a.room, T + HOUR);
    await inRoom(a.room, (sql) => sql.exec("DROP TABLE test_release_bookkeeping_fails"));
    await pass(a.room);
    expect(await one(a.room, "SELECT state, failure_code FROM release WHERE id = ?", rel(5))).toEqual({ state: "failed", failure_code: "release_upload_expired" });
    // Queued under the unpublish, though it was the expiry that queued it.
    expect(await queuedAs(a.room, a.script)).toEqual([{ unpublish_epoch: 5, gone: 0 }]);
    expect((await unpublish(a.room)).done).toBe(0);
    await due(a.room);
    await pass(a.room);
    // Its going is what finishes the unpublish. Under no unpublish, nothing ever would have.
    expect([(await held()).scripts.includes(a.script), await unpublish(a.room)]).toEqual([false, { release_epoch: 5, done: 1 }]);

    // (a), by the other path: the bookkeeping still fails when the hour passes, and the hourly reconcile finds the
    // script before the room has ended its release.
    const found = await withUpload();
    await pass(found.room);
    await clockTo(found.room, T + HOUR);
    expect((await checkScript(found.room, found.script)).changed).toBe(true);
    // Queued under the unpublish, and due at once: the room's own alarm may take it before the next line, so whether
    // it is gone yet isn't asserted here, only under which unpublish it was queued.
    expect((await queuedAs(found.room, found.script)).map((row: any) => row.unpublish_epoch)).toEqual([5]);
    expect((await one(found.room, "SELECT state FROM release WHERE id = ?", rel(5))).state).toBe("uploading");
    await pass(found.room);
    expect([(await held()).scripts.includes(found.script), await unpublish(found.room)]).toEqual([false, { release_epoch: 5, done: 1 }]);

    // (b) One of the unpublish's own scripts is still pending when the upload's script is queued. The own script's
    // going must not finish the unpublish while the upload's script is still there.
    //
    // **Nothing here rests on the room's alarm not having run.** The room has no provider from before the suspension
    // until the upload's script has its wait, so whenever an alarm runs in between it can delete nothing. One is run
    // at that point on purpose. (On CI one landed there by itself, with a provider, and deleted the upload's script
    // before this test had set its wait: that was this test's fault, and is why it is built this way.)
    const b = await withUpload({ providerOff: true });
    await clockTo(b.room, T + HOUR);
    expect((await checkScript(b.room, b.script)).changed).toBe(true);
    await pass(b.room);
    expect((await deleteRows(b.room)).map((row: any) => [row.script_name, row.unpublish_epoch, row.gone])).toEqual([[b.kept, 5, 0], [b.served, 5, 0], [b.script, 5, 0]].sort());
    // The upload's script waits; the provider is back. Whichever pass comes next, this one or the room's own, takes
    // the unpublish's own two and leaves the upload's.
    await inRoom(b.room, (sql) => { sql.exec("UPDATE script_delete SET next_attempt_at = ? WHERE script_name = ?", FAR(), b.script); sql.exec("DROP TABLE test_content_provider_off"); });
    await pass(b.room);
    expect((await deleteRows(b.room)).map((row: any) => [row.script_name, row.gone])).toEqual([[b.kept, 1], [b.served, 1], [b.script, 0]].sort());
    expect([(await held()).scripts.includes(b.script), (await unpublish(b.room)).done]).toEqual([true, 0]);
    await due(b.room);
    await pass(b.room);
    expect([(await held()).scripts.includes(b.script), (await unpublish(b.room)).done]).toEqual([false, 1]);

    // A release that began after the room's last unpublish is owed by none: its script is queued under none. The
    // room was suspended and the suspension lifted, which left it at epoch 5, and the release began under that.
    const later = await app({ plain: true });
    await switchedOn(() => suspend(later.label));
    await switchedOn(() => lift(later.label));
    expect((await unpublish(later.room)).release_epoch).toBe(5);
    const fresh5 = `${later.label}.${rel(5)}`;
    await inRoom(later.room, (sql) => {
      sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
      sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T + HOUR);
      sql.exec(
        `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
           VALUES (?, ?, 'uploading', ?, 1, 5, ?, ?, 'per_td_owner', 1, 'per_td_owner', 1, ?, 1)`, rel(5), SHA, later.label, fresh5, rel(5), T);
    });
    await pass(later.room);
    expect(await one(later.room, "SELECT state, failure_code FROM release WHERE id = ?", rel(5))).toEqual({ state: "failed", failure_code: "release_upload_expired" });
    expect((await queuedAs(later.room, fresh5)).map((row: any) => row.unpublish_epoch)).toEqual([null]);
  });

  it("lifts without restoring anything", async () => {
    const a = await app();
    await switchedOn(() => suspend(a.label));
    await pass(a.room);
    const calls = (await held()).calls.length;
    const lifted = await switchedOn(() => lift(a.label));
    expect([lifted.status, lifted.body]).toEqual([200, { label: a.label, suspended: false, reason: null, at: null }]);
    await pass(a.room);
    // No entry, no script, no host serving, no kept script, and the epoch stays where the suspension put it.
    const state = await held();
    expect([state.entries[a.host], state.scripts.filter((name) => name.startsWith(`${a.label}.`)), state.calls.length]).toEqual([undefined, [], calls]);
    expect(await configRow(a.room)).toMatchObject({ release_epoch: 5, kept_previous: null, in_flight_release: null });
    expect((await serveRows(a.room))[0]).toMatchObject({ script_name: null, version: 7 });
    expect((await all(a.room, "SELECT state FROM release WHERE id IN (?, ?)", rel(2), rel(3))).map((row: any) => row.state)).toEqual(["unpublished", "unpublished"]);
    expect(await all(a.room, "SELECT type FROM event WHERE type LIKE 'app.%' ORDER BY seq")).toEqual([{ type: "app.suspended" }, { type: "app.suspension_lifted" }]);
    expect(await all(a.room, "SELECT cause FROM unpublish")).toHaveLength(1);
    // Lifting what isn't suspended changes nothing.
    expect((await switchedOn(() => lift(a.label))).body).toEqual(lifted.body);
    expect(await all(a.room, "SELECT type FROM event WHERE type LIKE 'app.%'")).toHaveLength(2);
    expect((await actions(a.label)).map((row: any) => `${row.action} ${row.outcome}`)).toEqual(["suspend done", "lift done", "lift done"]);
    // Suspended a second time, it unpublishes again: one more epoch, and one more row that names it.
    await switchedOn(() => suspend(a.label));
    expect((await configRow(a.room)).release_epoch).toBe(6);
    expect((await all(a.room, "SELECT release_epoch FROM unpublish ORDER BY seq")).map((row: any) => row.release_epoch)).toEqual([5, 6]);
    await alarmQuiet(stub(a.room));
  });

  it("is the same act by the app's default host, and no other host is anyone's default host", async () => {
    const a = await app({ plain: true });
    await switchedOn(async () => {
      const done = await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${a.host}/suspend`, { reason: "illegal" });
      expect([done.status, done.body]).toEqual([200, { host: a.host, suspended: true, reason: "illegal", at: expect.any(Number) }]);
      expect((await configRow(a.room)).release_epoch).toBe(5);
      expect((await deleteRows(a.room)).map((row: any) => row.script_name)).toEqual([a.kept, a.served].sort());
      const lifted = await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${a.host}/lift`, { reason: "other" });
      expect([lifted.status, lifted.body]).toEqual([200, { host: a.host, suspended: false, reason: null, at: null }]);
      // A host two labels deep, the bare domain, and a host whose label no room has: none is any app's.
      for (const host of [`deep.${a.host}`, FAKE.domain, `UPPER.${FAKE.domain}`]) {
        const answer = await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${host}/suspend`, { reason: "abuse" });
        expect([answer.status, answer.code], host).toEqual([404, "not_found"]);
      }
      expect((await one(a.room, "SELECT suspended_at FROM app_label")).suspended_at).toBeNull();
      // Two spellings of the host are one host: the same app, answered by its name as Podster writes it.
      const spelled = await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${a.host.toUpperCase()}./suspend`, { reason: "abuse" });
      expect([spelled.status, spelled.body]).toMatchObject([200, { host: a.host, suspended: true }]);
      await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${a.host}/lift`, { reason: "other" });
    });
    expect((await one(a.room, "SELECT suspended_at FROM app_label")).suspended_at).toBeNull();
    await alarmQuiet(stub(a.room));
  });

  it("is committed even when its answer is lost, and the retry is told the same", async () => {
    const a = await app({ plain: true });
    await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_lose_operator_answer (subject TEXT)").run();
    await BINDINGS.DB.prepare("INSERT INTO test_lose_operator_answer (subject) VALUES (?)").bind(a.label).run();
    try {
      expect((await switchedOn(() => suspend(a.label))).status).toBe(500);
    } finally {
      await BINDINGS.DB.prepare("DROP TABLE test_lose_operator_answer").run();
    }
    const at = (await one(a.room, "SELECT suspended_at FROM app_label")).suspended_at;
    expect(at).toEqual(expect.any(Number));
    const retry = await switchedOn(() => suspend(a.label));
    expect([retry.status, retry.body.at, (await configRow(a.room)).release_epoch]).toEqual([200, at, 5]);
    expect((await actions(a.label)).map((row: any) => row.outcome)).toEqual(["unknown", "done"]);
    await alarmQuiet(stub(a.room));
  });

  it("suspends a label whose room never configured release, with nothing to unpublish", async () => {
    const room: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Bare" })).body.id;
    await alarmQuiet(stub(room));
    const label = newLabel();
    await inRoom(room, (sql) => sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label));
    await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, room).run();
    expect((await switchedOn(() => suspend(label))).body).toMatchObject({ label, suspended: true });
    expect([await all(room, "SELECT * FROM unpublish"), await all(room, "SELECT * FROM script_delete"), await all(room, "SELECT * FROM release_config")]).toEqual([[], [], []]);
    await alarmQuiet(stub(room));
  });

  it("fails closed at the epoch's ceiling, and still never refuses a takedown", async () => {
    const ceiling = 2 ** 53 - 1;
    const a = await app({ plain: true, epoch: ceiling - 1 });
    expect((await switchedOn(() => suspend(a.label))).status).toBe(200);
    expect((await configRow(a.room)).release_epoch).toBe(ceiling);
    await switchedOn(() => lift(a.label));
    // It can't go up again. The second suspension still takes, and the row that names the ceiling is the one already there.
    expect((await switchedOn(() => suspend(a.label))).body).toMatchObject({ suspended: true });
    expect((await configRow(a.room)).release_epoch).toBe(ceiling);
    expect(await all(a.room, "SELECT release_epoch FROM unpublish")).toEqual([{ release_epoch: ceiling }]);
    await alarmQuiet(stub(a.room));
  });
});

describe("the room's applier and its delete job", () => {
  it("write no entry for a release the room hasn't recorded live, and keep an uploading release's script from the delete job", async () => {
    // Step 5: a commit stages a release's script on the room's hosts first, and records it live only after it has
    // asked everyone again. Until then the applier must ask the provider nothing for that host.
    const a = await app({ plain: true });
    const staged = `${a.label}.${rel(5)}`;
    await inRoom(a.room, (sql) => {
      sql.exec(
        `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
           VALUES (?, ?, 'uploading', ?, 1, 4, ?, ?, 'per_td_owner', 1, 'per_td_owner', 1, ?, 1)`, rel(5), SHA, a.label, staged, rel(5), Date.now());
      sql.exec("UPDATE serve_state SET release_id = ?, script_name = ?, version = 6, flight_version = 6, flight_before = ?", rel(5), staged, a.served);
      sql.exec("UPDATE release_config SET in_flight_release = ?, in_flight_script = ?, in_flight_epoch = 4, in_flight_at = 1", rel(5), staged);
    });
    await fake("/seed", { scripts: [staged] });
    // Two whole passes, each leaving its wait far ahead: exactly two attempts, whatever the clock does between them.
    await passAndHold(a.room);
    await due(a.room);
    await passAndHold(a.room);
    let state = await held();
    expect([state.entries[a.host], callsFor(state, a)]).toEqual([a.served, []]);
    expect(await applyRows(a.room)).toEqual([{ host: a.host, applied_version: 5, applied_script: a.served, attempts: 2, last_code: "release_not_confirmed" }]);
    // Recorded live, as the commit's confirm records it, with the host's wait cleared: the next pass writes the entry.
    await inRoom(a.room, (sql) => {
      sql.exec("UPDATE release SET state = 'live' WHERE id = ?", rel(5));
      sql.exec("UPDATE serve_apply SET attempts = 0, attempt_version = NULL, next_attempt_at = NULL, last_code = NULL");
    });
    await pass(a.room);
    state = await held();
    expect(state.entries[a.host]).toBe(staged);
    expect(callsFor(state, a)).toEqual(["entry.put host 200", "entry.get host 200"]);

    // The delete job, asked again at the delete itself: a script queued while its release was at another step, as a
    // reconcile queues an uncertain release's, isn't deleted while that release is uploading within its hour.
    const b = await app({ plain: true });
    const uploading = `${b.label}.${rel(5)}`;
    await inRoom(b.room, (sql) => {
      sql.exec(
        `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
           VALUES (?, ?, 'uploading', ?, 1, 4, ?, ?, 'per_td_owner', 1, 'per_td_owner', 1, ?, 1)`, rel(5), SHA, b.label, uploading, rel(5), Date.now());
      sql.exec("INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES (?, ?, 2, 2)", uploading, b.label);
    });
    await fake("/seed", { scripts: [uploading] });
    await pass(b.room);
    state = await held();
    expect([state.scripts.includes(uploading), callsFor(state, b)]).toEqual([true, []]);
    expect((await deleteRows(b.room)).map((row: any) => [row.attempts, row.last_code, row.gone])).toEqual([[0, "release_uploading", 0]]);
    // It waits for the upload's own hour, and no sooner: the room isn't woken for it again and again meanwhile.
    const started: number = (await one(b.room, "SELECT upload_started_at FROM release WHERE id = ?", rel(5))).upload_started_at;
    expect((await one(b.room, "SELECT next_attempt_at FROM script_delete")).next_attempt_at).toBe(started + 60 * 60 * 1000);
    expect(await nextAlarm(stub(b.room))).toBeGreaterThanOrEqual(started + 60 * 60 * 1000);
    await pass(b.room);
    expect(callsFor(await held(), b)).toEqual([]);
    // Past its hour the release is ended by the room's own pass, and the script goes.
    await inRoom(b.room, (sql) => { sql.exec("UPDATE release SET upload_started_at = ? WHERE id = ?", Date.now() - 60 * 60 * 1000, rel(5)); sql.exec("UPDATE script_delete SET next_attempt_at = 0"); });
    await pass(b.room);
    expect((await held()).scripts).not.toContain(uploading);
    expect(await one(b.room, "SELECT state, failure_code FROM release WHERE id = ?", rel(5))).toEqual({ state: "failed", failure_code: "release_upload_expired" });
    for (const room of [a.room, b.room]) await alarmQuiet(stub(room));
  });

  it("do nothing with no provider configured, and leave the work recorded as owed", async () => {
    const a = await app();
    await inRoom(a.room, (sql) => sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)"));
    await switchedOn(() => suspend(a.label));
    await pass(a.room);
    await pass(a.room);
    // The room's own state is already down. The provider was never called, and nothing claims otherwise.
    const state = await held();
    expect(callsFor(state, a)).toEqual([]);
    expect(state.entries[a.host]).toBe(a.flight);
    expect((await serveRows(a.room))[0]).toMatchObject({ script_name: null, version: 7 });
    expect(await applyRows(a.room)).toEqual([{ host: a.host, applied_version: 6, applied_script: a.flight, attempts: 0, last_code: null }]);
    expect((await deleteRows(a.room)).map((row: any) => [row.gone, row.attempts])).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect((await one(a.room, "SELECT scripts_gone_at FROM unpublish")).scripts_gone_at).toBeNull();
    // Once one is configured, the same rows are carried out.
    await inRoom(a.room, (sql) => sql.exec("DROP TABLE test_content_provider_off"));
    await pass(a.room);
    const after = await held();
    expect([after.entries[a.host], after.scripts.filter((name) => name.startsWith(`${a.label}.`))]).toEqual([undefined, []]);
  });

  it("count a script gone only on one of the two answers that mean gone, and retry anything else", async () => {
    const a = await downButNotApplied();
    // Both deletes fail outright, and the scripts are still there: a read that finds one is not "gone".
    await fault({ op: "script.delete", times: 2, status: 500 });
    const started = Date.now();
    await pass(a.room);
    expect((await deleteRows(a.room)).map((row: any) => [row.gone, row.attempts, row.last_code])).toEqual([[0, 1, "read_200"], [0, 1, "read_200"]]);
    expect((await held()).scripts).toEqual([a.kept, a.served].sort());
    // It waits before it tries again, 5 seconds from when it failed: a pass straight after asks the provider nothing.
    expect((await all(a.room, "SELECT next_attempt_at FROM script_delete")).every((row: any) => row.next_attempt_at >= started + 5000)).toBe(true);
    await notDue(a.room);
    const quiet = (await held()).calls.length;
    await pass(a.room);
    expect((await held()).calls.length).toBe(quiet);
    // The delete goes through and its answer is lost; then the read fails too. Nothing says gone, so nothing is recorded gone,
    // though the script is in fact deleted. A read answering 404 is not one of the two answers either.
    await due(a.room);
    await fault({ op: "script.delete", times: 2, lost: true });
    await fault({ op: "script.get", times: 1, status: 404 });
    await fault({ op: "script.get", times: 1, status: 500 });
    await pass(a.room);
    expect((await held()).scripts).toEqual([]);
    expect((await deleteRows(a.room)).map((row: any) => [row.gone, row.attempts, row.last_code])).toEqual([[0, 2, "read_404"], [0, 2, "read_500"]]);
    expect((await one(a.room, "SELECT scripts_gone_at FROM unpublish")).scripts_gone_at).toBeNull();
    // The next try's delete answers 404 with code 10007: gone, with no read needed.
    await due(a.room);
    const before = (await held()).calls.length;
    await pass(a.room);
    expect((await held()).calls.slice(before).map((call) => `${call.op} ${call.status}`)).toEqual(["script.delete 404", "script.delete 404"]);
    expect((await deleteRows(a.room)).map((row: any) => row.gone)).toEqual([1, 1]);
    expect((await one(a.room, "SELECT scripts_gone_at IS NOT NULL AS done FROM unpublish")).done).toBe(1);
  });

  it("delete no script while a serve entry might still name it", async () => {
    const a = await downButNotApplied();
    // The entry's removal fails: it is still there, so no script is touched.
    await fault({ op: "entry.delete", times: 1, status: 500 });
    await pass(a.room);
    let state = await held();
    expect(callsFor(state, a)).toEqual(["entry.delete host 500", "entry.get host 200"]);
    expect([state.entries[a.host], state.scripts]).toEqual([a.served, [a.kept, a.served].sort()]);
    expect(await applyRows(a.room)).toEqual([{ host: a.host, applied_version: null, applied_script: null, attempts: 1, last_code: "delete_not_confirmed" }]);
    // The scripts wait for the entry. Nothing was asked of the provider for them, so no attempt is counted, and their
    // own due time is left as it was: they go as soon as the entry does.
    expect((await all(a.room, "SELECT next_attempt_at FROM script_delete")).map((row: any) => row.next_attempt_at)).toEqual([0, 0]);
    expect((await deleteRows(a.room)).map((row: any) => [row.attempts, row.last_code])).toEqual([[0, "entry_not_removed_yet"], [0, "entry_not_removed_yet"]]);
    // The removal goes through, but the read-back still shows the entry, as a cache that lags would: not applied yet.
    await due(a.room);
    await fault({ op: "entry.get", times: 1, stale: true });
    await pass(a.room);
    state = await held();
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: null, attempts: 2, last_code: "read_back_differs" });
    expect(state.scripts).toEqual([a.kept, a.served].sort());
    // A read-back that answers 404 without the code for a missing key, as a wrong namespace would, isn't "absent".
    await due(a.room);
    await fault({ op: "entry.get", times: 1, status: 404 });
    await pass(a.room);
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: null, attempts: 3, last_code: "read_back_differs" });
    expect((await held()).scripts).toEqual([a.kept, a.served].sort());
    // The scripts ask for no wake of their own while the host is pending: the room's next alarm is the host's, by its
    // own backoff (5 s, 10 s, then 20 s after the third failure), and not a fixed few seconds.
    const wait = (await waitRows(a.room))[0] as any;
    expect(wait.next_attempt_at - (await one(a.room, "SELECT updated_at FROM serve_apply")).updated_at).toBe(20000);
    expect((await deleteRows(a.room)).map((row: any) => [row.attempts, row.last_code])).toEqual([[0, "entry_not_removed_yet"], [0, "entry_not_removed_yet"]]);
    expect(await nextAlarm(stub(a.room))).toBe(wait.next_attempt_at);
    // A removal whose answer was lost, read back as absent: applied, because absent is the point. Then the scripts go.
    await due(a.room);
    await fake("/seed", { entries: { [a.host]: a.served } });
    await fault({ op: "entry.delete", times: 1, lost: true });
    await pass(a.room);
    state = await held();
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 6, attempts: 0, last_code: null });
    expect([state.entries[a.host], state.scripts]).toEqual([undefined, []]);
  });

  it("delete no script the room's own state still names, whatever is queued", async () => {
    const a = await app();
    // Nothing is unpublished: every entry is as the room wants it. A delete queued for each script the room still
    // names (the one a host serves, the kept one, and the one that host served before the commit in flight) waits.
    await inRoom(a.room, (sql) => { for (const name of [a.flight, a.kept, a.served]) sql.exec("INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES (?, ?, 1, 0)", name, a.label); });
    await pass(a.room);
    const state = await held();
    expect(callsFor(state, a)).toEqual([]);
    expect(state.scripts).toEqual([a.kept, a.served, a.flight].sort());
    expect((await deleteRows(a.room)).map((row: any) => [row.gone, row.attempts, row.last_code])).toEqual([[0, 0, "entry_not_removed_yet"], [0, 0, "entry_not_removed_yet"], [0, 0, "entry_not_removed_yet"]]);
    await alarmQuiet(stub(a.room));
  });

  it("start over when the room changes its mind while the provider is being asked", async () => {
    const a = await downButNotApplied();
    // The first removal is held at the provider. While it is out, the host's version moves, as a second change in the
    // room would move it. Then the call is let go.
    const held1 = await gate("entry.delete");
    const running = pass(a.room);
    await arrived(held1);
    await inRoom(a.room, (sql) => sql.exec("UPDATE serve_state SET version = version + 1"));
    await release(held1);
    await running;
    // It didn't record the version it started with: it went round again and recorded the one the room holds now.
    const state = await held();
    expect(callsFor(state, a).filter((call) => call.startsWith("entry."))).toEqual(["entry.delete host 200", "entry.get host 404", "entry.delete host 200", "entry.get host 404"]);
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 7, attempts: 0 });
    expect(state.expiredGates).toBe(0);
  });

  it("take an entry back out when the app is suspended while its write is out", async () => {
    const a = await app({ plain: true });
    await fake("/reset", {});
    await fake("/seed", { scripts: [a.kept, a.served] });
    await inRoom(a.room, (sql) => sql.exec("DELETE FROM serve_apply"));
    // The applier is writing the entry the room wanted. The write is held at the provider, and the operator's
    // suspension commits in the room meanwhile. Then the write lands.
    const write = await gate("entry.put");
    const running = pass(a.room);
    await arrived(write);
    expect((await switchedOn(() => suspend(a.label))).body).toMatchObject({ suspended: true });
    expect((await serveRows(a.room))[0]).toMatchObject({ script_name: null, version: 6 });
    await release(write);
    await running;
    // The write did land, and was read back. The room had moved on, so in the same pass the applier removed it.
    const state = await held();
    expect(callsFor(state, a).filter((call) => call.startsWith("entry.")).slice(0, 4)).toEqual(["entry.put host 200", "entry.get host 200", "entry.delete host 200", "entry.get host 404"]);
    expect(state.entries[a.host]).toBeUndefined();
    expect(await applyRows(a.room)).toEqual([{ host: a.host, applied_version: 6, applied_script: null, attempts: 0, last_code: null }]);
    expect(state.expiredGates).toBe(0);
    await alarmQuiet(stub(a.room));
    expect((await held()).scripts).toEqual([]);
  });

  it("record nothing as applied when the version moves on every pass, and finish on the next", async () => {
    const a = await downButNotApplied();
    // Three passes, and the version moves during each.
    const gates = [await gate("entry.delete"), await gate("entry.delete"), await gate("entry.delete")];
    const running = pass(a.room);
    for (const id of gates) {
      await arrived(id);
      await inRoom(a.room, (sql) => sql.exec("UPDATE serve_state SET version = version + 1"));
      await release(id);
    }
    await running;
    let state = await held();
    expect(callsFor(state, a).filter((call) => call.startsWith("entry."))).toEqual(Array(3).fill(["entry.delete host 200", "entry.get host 404"]).flat());
    // The entry is in fact gone, but no version was seen through, so none is recorded: the attempt and its wait are
    // counted against the version the room holds now, and a pass straight after asks nothing.
    expect(state.entries[a.host]).toBeUndefined();
    expect(await applyRows(a.room)).toEqual([{ host: a.host, applied_version: null, applied_script: null, attempts: 1, last_code: "version_kept_moving" }]);
    expect((await waitRows(a.room))[0]).toMatchObject({ attempts: 1, attempt_version: 9 });
    expect(state.expiredGates).toBe(0);
    expect(state.scripts).toEqual([a.kept, a.served].sort());
    await notDue(a.room);
    await pass(a.room);
    expect((await held()).calls.length).toBe(state.calls.length);
    // Once the wait is over it sees the version through, and only then do the scripts go.
    await due(a.room);
    await pass(a.room);
    state = await held();
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 9, attempts: 0, last_code: null });
    expect(state.scripts).toEqual([]);
  });

  it("never make a takedown wait out a failure's backoff: a wait belongs to the version that failed", async () => {
    const a = await app({ plain: true });
    // The applier has failed to write version 5 many times, and its wait is as long as it gets and far from over.
    const far = Date.now() + 10 * 60 * 1000;
    await inRoom(a.room, (sql) => sql.exec("UPDATE serve_apply SET applied_version = 4, attempts = 9, attempt_version = 5, next_attempt_at = ?, last_code = 'write_not_confirmed'", far));
    await pass(a.room);
    expect(callsFor(await held(), a)).toEqual([]);
    // The suspension moves the host's version. The old wait is for a version that is gone, so the room is woken now.
    expect((await switchedOn(() => suspend(a.label))).status).toBe(200);
    const alarm = await nextAlarm(stub(a.room));
    expect(alarm === null || alarm < far - 5 * 60 * 1000, "the alarm is set for now, not for the old wait, unless it already ran").toBe(true);
    await pass(a.room);
    const state = await held();
    expect(state.entries[a.host]).toBeUndefined();
    expect(await applyRows(a.room)).toEqual([{ host: a.host, applied_version: 6, applied_script: null, attempts: 0, last_code: null }]);
    expect(state.scripts).toEqual([]);
    // A failure at the new version starts its own count, from the shortest wait.
    // Nothing is set or running from here: the rows changed next are met first by the pass below, not by a stray alarm.
    await alarmQuiet(stub(a.room));
    await inRoom(a.room, (sql) => { sql.exec("UPDATE serve_apply SET attempts = 9, attempt_version = 6, next_attempt_at = ?", far); sql.exec("UPDATE serve_state SET version = version + 1"); });
    await fault({ op: "entry.delete", times: 1, status: 500 });
    await fault({ op: "entry.get", times: 1, status: 500 });
    const started = Date.now();
    await pass(a.room);
    const wait = (await waitRows(a.room))[0] as any;
    expect([wait.attempts, wait.attempt_version, wait.last_code]).toEqual([1, 7, "delete_not_confirmed"]);
    expect(wait.next_attempt_at).toBeGreaterThanOrEqual(started + 5000);
    expect(wait.next_attempt_at).toBeLessThan(far - 5 * 60 * 1000);
    await alarmQuiet(stub(a.room));
  });

  it("touch no host that isn't this room's own default host, and write no script under another label", async () => {
    // A default host row that names another app's host: the room's rows alone never reach it.
    const wrong = await app({ plain: true });
    const victim = `${newLabel()}.${FAKE.domain}`;
    await fake("/reset", {});
    await fake("/seed", { scripts: [wrong.served], entries: { [victim]: "victim.rel_" + "9".repeat(32) } });
    await inRoom(wrong.room, (sql) => { sql.exec("DELETE FROM serve_apply"); sql.exec("UPDATE serve_state SET host = ?", victim); });
    await pass(wrong.room);
    let state = await held();
    expect(state.calls).toEqual([]);
    expect(state.entries[victim]).toBe("victim.rel_" + "9".repeat(32));
    expect(await applyRows(wrong.room)).toEqual([{ host: victim, applied_version: null, applied_script: null, attempts: 0, last_code: "host_not_this_rooms" }]);
    // It is recorded as refused at the version it has, with no attempt and no wait. So it doesn't wake the room, and
    // it doesn't hold the room's script deletes back: one that is owed goes on the next pass.
    expect(await all(wrong.room, "SELECT refused_version, attempt_version, next_attempt_at FROM serve_apply")).toEqual([{ refused_version: 5, attempt_version: null, next_attempt_at: null }]);
    expect(await nextAlarm(stub(wrong.room))).toBeNull();
    const owed = `${wrong.label}.${rel(7)}`;
    await fake("/seed", { scripts: [owed] });
    await inRoom(wrong.room, (sql) => sql.exec("INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES (?, ?, 1, 0)", owed, wrong.label));
    await pass(wrong.room);
    expect((await held()).scripts).toEqual([wrong.served]);
    expect((await deleteRows(wrong.room)).map((row: any) => row.gone)).toEqual([1]);
    expect(await nextAlarm(stub(wrong.room))).toBeNull();
    await fake("/reset", {});
    await fake("/seed", { entries: { [victim]: "victim.rel_" + "9".repeat(32) } });
    // The same for a removal, and for a host that is no app's default host at all.
    await inRoom(wrong.room, (sql) => sql.exec("UPDATE serve_state SET label = NULL, label_current = NULL, release_id = NULL, script_name = NULL, version = version + 1"));
    await pass(wrong.room);
    expect([(await held()).calls, (await applyRows(wrong.room))[0].last_code]).toEqual([[], "host_not_this_rooms"]);
    // Nor a custom row for anything on the content domain: an app's host, a deeper name, or the domain itself.
    const refusedHosts = [
      [`deep.${wrong.host}`, "default", "host_not_a_default_host"], ["app.example.org", "default", "host_not_a_default_host"], [FAKE.domain, "default", "host_not_a_default_host"],
      [`${wrong.label}.${FAKE.domain}`, "custom", "custom_host_on_content_domain"], [`deep.${wrong.host}`, "custom", "custom_host_on_content_domain"], [FAKE.domain, "custom", "custom_host_on_content_domain"],
    ];
    for (const [host, kind, code] of refusedHosts) {
      await inRoom(wrong.room, (sql) => { sql.exec("DELETE FROM serve_apply"); sql.exec("UPDATE serve_state SET host = ?, kind = ?, version = version + 1", host, kind); });
      await pass(wrong.room);
      expect([(await held()).calls, (await applyRows(wrong.room))[0].last_code], host).toEqual([[], code]);
    }
    await alarmQuiet(stub(wrong.room));

    // The room's own host, under a label it retired, asked to serve a script under its current label: the labels
    // differ, so nothing is written, and what the host had is removed.
    const room: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Two labels" })).body.id;
    await alarmQuiet(stub(room));
    const [old, current] = [newLabel(), newLabel()];
    const [host, script] = [`${old}.${FAKE.domain}`, `${current}.${rel(2)}`];
    await inRoom(room, (sql) => {
      sql.exec("INSERT INTO app_label (label, current, created_at, retired_at) VALUES (?, NULL, 1, 2)", old);
      sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", current);
      sql.exec("INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, updated_at) VALUES (?, ?, 'served', ?, 1, 0, ?, ?, 'per_td_owner', 1, 'per_td_owner', 1, 1)", rel(2), SHA, current, script, rel(2));
      sql.exec("INSERT INTO release_config (singleton, enabled, set_by, set_at, updated_at) VALUES (1, 1, 'per_td_owner', 1, 1)");
      sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 1, 1)", host, current, rel(2), script);
    });
    await fake("/seed", { scripts: [script], entries: { [host]: `${old}.${rel(1)}` } });
    await pass(room);
    state = await held();
    expect(state.calls.map((call) => `${call.op} ${call.status}`)).toEqual(["entry.delete 200", "entry.get 404"]);
    expect(state.entries[host]).toBeUndefined();
    // Its entry is known to be gone and nothing more will be tried at this version: refused, not retried.
    expect(await applyRows(room)).toEqual([{ host, applied_version: null, applied_script: null, attempts: 0, last_code: "script_not_this_hosts" }]);
    const quiet = (await held()).calls.length;
    await pass(room);
    expect([(await held()).calls.length, await nextAlarm(stub(room))]).toEqual([quiet, null]);
    await alarmQuiet(stub(room));
  });

  it("write a default host's entry only for what the room wants, and never for a suspended app or a custom hostname", async () => {
    const a = await app({ plain: true });
    await fake("/reset", {});
    await fake("/seed", { scripts: [a.kept, a.served] });
    await inRoom(a.room, (sql) => sql.exec("DELETE FROM serve_apply"));
    // Never applied: the room wants its served release on its default host, and the applier writes exactly that.
    await pass(a.room);
    let state = await held();
    expect(callsFor(state, a)).toEqual(["entry.put host 200", "entry.get host 200"]);
    expect(state.entries[a.host]).toBe(a.served);
    expect(await applyRows(a.room)).toEqual([{ host: a.host, applied_version: 5, applied_script: a.served, attempts: 0, last_code: null }]);
    // A write the provider accepted counts only once the entry reads back as that script.
    // Nothing is set or running from here: the rows changed next are met first by the pass below, not by a stray alarm.
    await alarmQuiet(stub(a.room));
    await inRoom(a.room, (sql) => sql.exec("UPDATE serve_state SET version = version + 1 WHERE kind = 'default'"));
    await fault({ op: "entry.get", times: 1, stale: true });
    await pass(a.room);
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 5, attempts: 1, last_code: "read_back_differs" });
    await due(a.room);
    await pass(a.room);
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 6, attempts: 0, last_code: null });
    await alarmQuiet(stub(a.room));
    // A custom hostname that wants a script: its claim can't be asked yet, so nothing is written for it, and an entry
    // that is somehow there is removed, since nothing can confirm it.
    await fake("/seed", { entries: { "app.example.org": a.served } });
    await inRoom(a.room, (sql) => sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES ('app.example.org', 'custom', ?, 1, ?, ?, 1, 1)", a.label, rel(2), a.served));
    await pass(a.room);
    state = await held();
    expect(state.entries["app.example.org"]).toBeUndefined();
    expect(state.calls.filter((call) => call.name === "app.example.org").map((call) => `${call.op} ${call.status}`)).toEqual(["entry.delete 200", "entry.get 404"]);
    expect((await applyRows(a.room)).find((row: any) => row.host === "app.example.org")).toMatchObject({ applied_version: null, last_code: "claim_check_not_built" });
    // A state that names a script while the app is suspended is a fault no command makes. Even so, nothing is written,
    // and the entry that is there comes out.
    // Nothing is set or running from here: the rows changed next are met first by the pass below, not by a stray alarm.
    await alarmQuiet(stub(a.room));
    expect(state.entries[a.host]).toBe(a.served);
    await inRoom(a.room, (sql) => { sql.exec("UPDATE app_label SET suspended_at = 1, suspension_reason = 'abuse'"); sql.exec("UPDATE serve_state SET version = version + 1 WHERE kind = 'default'"); });
    const before = (await held()).calls.length;
    await pass(a.room);
    state = await held();
    expect(state.calls.slice(before).filter((call) => call.name === a.host).map((call) => `${call.op} ${call.status}`)).toEqual(["entry.delete 200", "entry.get 404"]);
    expect(state.calls.some((call, index) => index >= before && call.op === "entry.put")).toBe(false);
    expect(state.entries[a.host]).toBeUndefined();
    expect((await applyRows(a.room)).find((row: any) => row.host === a.host)).toMatchObject({ applied_version: 6, last_code: "app_suspended" });
    // Both are refused at their versions: no retry, no wake, and a pass asks nothing.
    await pass(a.room);
    expect([(await held()).calls.length, await nextAlarm(stub(a.room))]).toEqual([state.calls.length, null]);
    // If a removal fails, the record says the entry remains, and that is retried.
    // Nothing is set or running from here: the rows changed next are met first by the pass below, not by a stray alarm.
    await alarmQuiet(stub(a.room));
    await inRoom(a.room, (sql) => sql.exec("UPDATE serve_state SET version = version + 1"));
    await fake("/seed", { entries: { [a.host]: a.served } });
    // Both hosts are due, so both removals fail.
    await fault({ op: "entry.delete", times: 2, status: 500 });
    await pass(a.room);
    expect((await applyRows(a.room)).find((row: any) => row.host === a.host)).toMatchObject({ attempts: 1, last_code: "app_suspended_entry_remains" });
    await alarmQuiet(stub(a.room));
  });

  it("use each token for its own kind of call, and nothing else on the provider's API", async () => {
    const a = await app();
    await switchedOn(() => suspend(a.label));
    await pass(a.room);
    const state = await held();
    // The stand-in refuses a script call with the routing token and an entry call with the scripts token, and records
    // any path it doesn't know. Every call was answered as its own kind, so each carried the right one.
    expect(state.calls.filter((call) => call.status === 403 || call.name.startsWith("unexpected"))).toEqual([]);
    expect(new Set(state.calls.map((call) => call.op))).toEqual(new Set(["entry.delete", "entry.get", "script.delete", "script.get"]));
  });
});

describe("what step 4(a) adds to the room and the Worker", () => {
  it("keeps the applier's and the delete job's records in forms the database itself holds", async () => {
    const a = await app({ plain: true });
    const other = `${newLabel()}.${rel(9)}`;
    await inRoom(a.room, (sql) => sql.exec("DELETE FROM serve_apply"));
    expect(await inRoom(a.room, (sql) => [
      // A script queued under a label that isn't the name's own, a name that isn't a script's, and an unknown label.
      refuses(() => sql.exec("INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES (?, ?, 1, 1)", other, a.label)),
      refuses(() => sql.exec("INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES (?, ?, 1, 1)", `${a.label}.notarelease`, a.label)),
      refuses(() => sql.exec("INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES (?, ?, 1, 1)", other, other.split(".")[0])),
      // An applied record for a host the room doesn't have, one with a script and no version, and a version that isn't a count.
      refuses(() => sql.exec("INSERT INTO serve_apply (host, updated_at) VALUES ('nohost.example.org', 1)")),
      refuses(() => sql.exec("INSERT INTO serve_apply (host, applied_script, updated_at) VALUES (?, ?, 1)", a.host, a.served)),
      refuses(() => sql.exec("INSERT INTO serve_apply (host, applied_version, applied_at, updated_at) VALUES (?, 0, 1, 1)", a.host)),
      refuses(() => sql.exec("INSERT INTO serve_apply (host, applied_version, applied_at, updated_at) VALUES (?, 'x', 1, 1)", a.host)),
      // A wait with no version it belongs to, and attempts counted against none.
      refuses(() => sql.exec("INSERT INTO serve_apply (host, next_attempt_at, updated_at) VALUES (?, 5, 1)", a.host)),
      refuses(() => sql.exec("INSERT INTO serve_apply (host, attempts, updated_at) VALUES (?, 2, 1)", a.host)),
      refuses(() => sql.exec("INSERT INTO serve_apply (host, attempt_version, updated_at) VALUES (?, 2, 1)", a.host)),
      // A refusal with no reason, and one that is also waiting to be tried again.
      refuses(() => sql.exec("INSERT INTO serve_apply (host, refused_version, updated_at) VALUES (?, 2, 1)", a.host)),
      refuses(() => sql.exec("INSERT INTO serve_apply (host, refused_version, last_code, attempts, attempt_version, updated_at) VALUES (?, 2, 'x', 1, 2, 1)", a.host)),
      // And the forms that are right are taken.
      refuses(() => sql.exec("INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES (?, ?, 1, 9e15)", `${a.label}.${rel(9)}`, a.label)),
      refuses(() => sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", a.host, a.served)),
    ])).toEqual([true, true, true, true, true, true, true, true, true, true, true, true, false, false]);
    await alarmQuiet(stub(a.room));
  });

  it("keeps every test-only switch out of the build a deployment gets", () => {
    // A deployment is built with no feature (the build command, checked below with the wrangler file). So a test-only
    // name is out of it when the code that names it is compiled only under the `failpoints` feature. Every string in
    // the API's source that names a test table, a test header or a test route must sit in a function that is under
    // that attribute, or after a `failpoints` condition inside its function. This reads every source file, not only
    // this step's.
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(30);
    const NAME = /(?<![a-z_])test_[a-z0-9_]+|x-test-[a-z-]+|\/internal\/test-[a-z-]+/g;
    const FN = /^\s*(pub(\([a-z]+\))? )?(const )?(async )?fn \w+/;
    const mentions: string[] = [];
    const unguarded: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (line.trim().startsWith("//")) return;
        for (const match of line.matchAll(NAME)) {
          // Only inside a string: an odd number of quotes before it on its line.
          if ((line.slice(0, match.index).split('"').length - 1) % 2 === 0) continue;
          mentions.push(`${file}:${match[0]}`);
          let start = i;
          while (start >= 0 && !FN.test(lines[start])) start -= 1;
          const attributes: string[] = [];
          for (let k = start - 1; k >= 0 && /^\s*(#\[|\/\/\/)/.test(lines[k]); k -= 1) attributes.push(lines[k]);
          const guarded = attributes.some((attribute) => attribute.includes('feature = "failpoints"')) || lines.slice(Math.max(start, 0), i + 1).join("\n").includes('feature = "failpoints"');
          if (!guarded) unguarded.push(`${file}:${i + 1}:${match[0]}`);
        }
      });
    }
    expect(unguarded).toEqual([]);
    // It found the ones known to be there, this step's among them, so it isn't passing by reading nothing.
    expect(mentions.length).toBeGreaterThan(50);
    expect(mentions).toContain("workspace/takedown.rs:test_content_provider_off");
    expect(mentions).toContain("releases.rs:test_releases_on");
    // The second PR's three: the stop's own provider switch, the stop made unreadable, and a room that doesn't answer.
    expect(mentions).toContain("content_stop.rs:test_content_provider_off");
    expect(mentions).toContain("moderation.rs:test_stop_unreadable");
    expect(mentions).toContain("workspace/takedown.rs:test_refuse_hostname_notice");
    expect(mentions).toContain("hostname_claim.rs:/internal/test-migrate");
    // And the reconciles' one: the time bounds a test sets, to show each without waiting it out.
    expect(mentions).toContain("reconcile.rs:test_reconcile_budget");
    // Step 5's: what a test leaves for the room to run between a release command's reads and its transaction, the
    // hold at that same point, the delegation's answer, the room's clock for release commands, and bookkeeping that fails.
    for (const name of ["test_release_between_reads", "test_release_hold", "test_release_delegation_answer", "test_release_clock"]) expect(mentions).toContain(`workspace/release_recheck.rs:${name}`);
    expect(mentions).toContain("workspace/release_commit.rs:test_release_bookkeeping_fails");
    // And the two that are a prefix of an ID, not a table, which the pattern above doesn't read: each is under the
    // feature, on the line before it.
    for (const prefix of ["org_unavailable_", "per_unavailable_"]) {
      const lines = sources["principal.rs"].split("\n");
      const at = lines.map((line, i) => (line.includes(`"${prefix}"`) ? i : -1)).filter((i) => i >= 0);
      expect(at.length, prefix).toBeGreaterThan(0);
      for (const i of at) expect(lines.slice(Math.max(0, i - 12), i).some((line) => line.includes('feature = "failpoints"')), `${prefix} at ${i + 1}`).toBe(true);
    }
    expect(BINDINGS.TEST_API_CARGO).toMatch(/\[features\][^\[]*\nfailpoints = \[\]/);
    expect(BINDINGS.TEST_API_CARGO).not.toMatch(/^default\s*=/m);
  });

  it("writes the stop key and each serve entry as the content Worker reads them", async () => {
    // One fixture, read by this test, by apps/content's and by crates/core's: the key and the value of the stop, and
    // what a script's name is.
    const fixture = JSON.parse(BINDINGS.TEST_SERVE_FIXTURE) as { stop_key: string; stop_value: string; script_name_pattern: string; valid_script_names: string[]; invalid_script_names: string[] };
    const source: string = BINDINGS.TEST_CONTENT_PROVIDER_SOURCE;
    expect([source.match(/const STOP_KEY: &str = "([^"]+)";/)?.[1], source.match(/const STOP_VALUE: &str = "([^"]+)";/)?.[1]]).toEqual([fixture.stop_key, fixture.stop_value]);
    // What the applier writes for a host is the script's name alone, and a name as the server makes one is among
    // the shapes the content Worker serves.
    const a = await app({ plain: true });
    await inRoom(a.room, (sql) => sql.exec("DELETE FROM serve_apply"));
    await pass(a.room);
    const written = (await held()).entries[a.host];
    expect(written).toBe(a.served);
    const pattern = new RegExp(fixture.script_name_pattern);
    expect(pattern.test(written)).toBe(true);
    expect([fixture.valid_script_names.every((name) => pattern.test(name)), fixture.invalid_script_names.some((name) => pattern.test(name))]).toEqual([true, false]);
    expect(fixture.invalid_script_names).not.toContain(written);
    await alarmQuiet(stub(a.room));
  });

  it("binds no provider and no token in any environment, and gives each the reconciles' two schedules", () => {
    const names = [...new Set([...(BINDINGS.TEST_CONTENT_PROVIDER_SOURCE as string).matchAll(/const [A-Z_]+: &str = "(CONTENT_[A-Z_]+)";/g)].map((match) => match[1]))].sort();
    expect(names).toEqual(["CONTENT_ACCOUNT_ID", "CONTENT_DISPATCH_NAMESPACE", "CONTENT_DOMAIN", "CONTENT_KV_NAMESPACE_ID", "CONTENT_ROUTING_TOKEN", "CONTENT_SCRIPTS_TOKEN"]);
    const wrangler: string = BINDINGS.TEST_WRANGLER;
    // Not as a variable, not in a comment, not under another spelling: the file doesn't hold the word.
    expect(wrangler).not.toMatch(/CONTENT_/);
    for (const name of ["dispatch_namespaces", "kv_namespaces"]) expect(wrangler, name).not.toContain(`"${name}"`);
    const config = JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, ""));
    expect(config.build.command).toBe("worker-build --release");
    // The two schedules, and nothing else, at the top and in every environment, since wrangler doesn't carry them in
    // (M6 step 6). The handler calls nothing while no provider is configured, which the reconciles' tests show.
    expect(config.triggers).toEqual({ crons: [ENTRIES_CRON, SCRIPTS_CRON] });
    for (const [name, environment] of Object.entries(config.env)) expect((environment as any).triggers, name).toEqual({ crons: [ENTRIES_CRON, SCRIPTS_CRON] });
    // The stand-in never holds a call as long as the provider module waits for one.
    const limit = Number((BINDINGS.TEST_CONTENT_PROVIDER_SOURCE as string).match(/const CALL_TIMEOUT_MS: u64 = ([0-9_]+);/)?.[1].replace(/_/g, ""));
    expect(limit).toBe(5000);
    expect(BINDINGS.TEST_GATE_LIMIT_MS).toBeLessThan(limit / 2 + 1);
    // The test Worker's values are the stand-in's, and no real account, namespace or token has their form's values.
    expect([FAKE.account, FAKE.kvNamespace]).toEqual(["c0".repeat(16), "d1".repeat(16)]);
    expect([FAKE.scriptsToken, FAKE.routingToken].every((token) => token.startsWith("test-"))).toBe(true);
  });
});

describe("the stop for the whole content domain", () => {
  /** However a test ends, the domain is left unstopped and the object quiet, so nothing reaches the next test. */
  async function unstopped<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } finally {
      await inModeration((sql) => { for (const table of ["test_content_provider_off", "test_stop_unreadable"]) sql.exec(`DROP TABLE IF EXISTS ${table}`); });
      await fake("/reset", {});
      await switchedOn(() => resumeDomain());
      await settle(moderation());
      await alarmQuiet(moderation());
    }
  }

  it("settles who is asking first, and is the Moderation object's own row", () => unstopped(async () => {
    await switchedOn(async () => {
      for (const body of [{ reason: "illegal" }, {}, { reason: "nonsense" }]) {
        for (const who of [AGENT, OWNER]) for (const verb of ["stop", "resume"]) expect((await api(who, "POST", `/v1/moderation/content-domain/${verb}`, body)).code).toBe("not_allowed");
      }
      for (const body of [{}, { reason: "nonsense" }, { reason: "illegal", extra: 1 }]) expect((await api(OPERATOR, "POST", "/v1/moderation/content-domain/stop", body)).code).toBe("invalid_argument");
      expect((await stopRow())?.stopped ?? 0).toBe(0);

      const stopped = await stopDomain();
      // The key at the provider isn't confirmed yet: that is the object's alarm's to do, after this answer.
      expect([stopped.status, stopped.body]).toEqual([200, { stopped: true, reason: "illegal", at: expect.any(Number), key_confirmed: false }]);
      const version = (await stopRow()).version;
      // Asking again changes nothing, not the reason and not the version. Whether the key is confirmed by then is the
      // alarm's own time, which the reconcile's tests show.
      expect((await stopDomain(OPERATOR, "spam")).body).toMatchObject({ stopped: true, reason: "illegal", at: stopped.body.at });
      expect(await stopRow()).toMatchObject({ stopped: 1, reason: "illegal", version });
      // The object writes one key at the provider, reads it back, and records it.
      await settle(moderation());
      expect((await held()).entries._stop).toBe("stopped");
      expect(await stopRow()).toMatchObject({ applied_version: version, attempts: 0, last_code: null });
      expect((await stopCalls()).slice(0, 2)).toEqual(["entry.put 200", "entry.get 200"]);

      const resumed = await resumeDomain();
      expect([resumed.status, resumed.body]).toEqual([200, { stopped: false, reason: null, at: null, key_confirmed: false }]);
      expect((await resumeDomain()).body).toMatchObject({ stopped: false, reason: null, at: null });
      await settle(moderation());
      expect((await held()).entries._stop).toBeUndefined();
      expect(await stopRow()).toMatchObject({ stopped: 0, reason: null, version: version + 1, applied_version: version + 1 });
    });
    const log = await runInDurableObject(moderation(), (_: any, state: any) => state.storage.sql.exec("SELECT operator, action, reason, outcome FROM operator_action WHERE subject_kind = 'content_domain' ORDER BY seq").toArray());
    expect(log.slice(-4)).toEqual([
      { operator: OPERATOR.id, action: "suspend", reason: "illegal", outcome: "done" }, { operator: OPERATOR.id, action: "suspend", reason: "spam", outcome: "done" },
      { operator: OPERATOR.id, action: "lift", reason: "other", outcome: "done" }, { operator: OPERATOR.id, action: "lift", reason: "other", outcome: "done" },
    ]);
  }));

  it("retries a key that wasn't confirmed, and never makes a new stop wait out an old failure", () => unstopped(async () => {
    // The write fails. Scripted before the stop, so whichever run of the alarm comes first meets it.
    await fault({ op: "entry.put", times: 1, status: 500 });
    const started = Date.now();
    await switchedOn(() => stopDomain());
    await settle(moderation());
    let row = await stopRow();
    expect(row).toMatchObject({ stopped: 1, attempts: 1, attempt_version: row.version, last_code: "write_not_confirmed" });
    expect(row.applied_version).not.toBe(row.version);
    expect(row.next_attempt_at).toBeGreaterThanOrEqual(started + 5000);
    expect((await held()).entries._stop).toBeUndefined();
    // It waits: while the wait isn't over, a run asks the provider nothing.
    await inModeration((sql) => sql.exec("UPDATE content_stop SET next_attempt_at = ?", FAR()));
    const quiet = (await stopCalls()).length;
    await settle(moderation());
    expect((await stopCalls()).length).toBe(quiet);
    // A write that the provider took but that doesn't read back isn't recorded either.
    await inModeration((sql) => sql.exec("UPDATE content_stop SET next_attempt_at = 0"));
    await fault({ op: "entry.get", times: 1, stale: true });
    await settle(moderation());
    expect(await stopRow()).toMatchObject({ attempts: 2, last_code: "read_back_differs" });
    expect((await stopRow()).applied_version).not.toBe(row.version);
    // The wait is now long. The operator resumes: that is a new version, so it is due at once, and the key comes out.
    const far = Date.now() + 10 * 60 * 1000;
    await inModeration((sql) => sql.exec("UPDATE content_stop SET attempts = 9, next_attempt_at = ?", far));
    await switchedOn(() => resumeDomain());
    await settle(moderation());
    row = await stopRow();
    expect(row).toMatchObject({ stopped: 0, applied_version: row.version, attempts: 0, last_code: null });
    expect((await held()).entries._stop).toBeUndefined();
  }));

  it("does nothing at the provider with none configured, and the stop still holds", () => unstopped(async () => {
    await inModeration((sql) => sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)"));
    expect((await switchedOn(() => stopDomain())).body).toMatchObject({ stopped: true });
    await settle(moderation());
    await settle(moderation());
    expect(await stopCalls()).toEqual([]);
    const owed = await stopRow();
    expect(owed).toMatchObject({ stopped: 1, attempts: 0 });
    expect(owed.applied_version).not.toBe(owed.version);
    expect(await nextAlarm(moderation())).toBeNull();
    // Once one is configured, the key that was owed is written.
    await inModeration((sql) => sql.exec("DROP TABLE test_content_provider_off"));
    await settle(moderation());
    expect((await held()).entries._stop).toBe("stopped");
  }));

  it("ends with the key as the operator last left it, when that changes while the key is being written", () => unstopped(async () => {
    // The stop is set with no provider, so no alarm is owed and none runs by itself. Then there is one, and this
    // test's own run of the alarm writes the key. That write is held at the provider.
    await inModeration((sql) => sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)"));
    await switchedOn(() => stopDomain());
    await inModeration((sql) => sql.exec("DROP TABLE test_content_provider_off"));
    const write = await gate("entry.put");
    const running = settle(moderation());
    await arrived(write);
    // While it is out, the operator resumes. No other run is woken for it, so what happens next is this run's alone.
    await inModeration((sql) => sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)"));
    expect((await switchedOn(() => resumeDomain())).body).toMatchObject({ stopped: false });
    expect(await nextAlarm(moderation())).toBeNull();
    await release(write);
    await running;
    // The same run saw the version had moved, started over, and took the key out again.
    const state = await held();
    const row = await stopRow();
    expect(state.entries._stop).toBeUndefined();
    expect(row).toMatchObject({ stopped: 0, applied_version: row.version, attempts: 0 });
    expect(await stopCalls()).toEqual(["entry.put 200", "entry.get 200", "entry.delete 200", "entry.get 404"]);
    expect(state.expiredGates).toBe(0);
  }));

  it("is read by the room before it writes a default host's entry, and never stops a removal", () => unstopped(async () => {
    const a = await app({ plain: true });
    const b = await app({ plain: true });
    await fake("/reset", {});
    await fake("/seed", { scripts: [a.kept, a.served, b.kept, b.served], entries: { [b.host]: b.served } });
    // Room a owes its default host an entry. The domain is stopped before its applier runs.
    await inRoom(a.room, (sql) => sql.exec("DELETE FROM serve_apply"));
    await switchedOn(() => stopDomain());
    await passAndHold(a.room);
    let state = await held();
    expect(callsFor(state, a)).toEqual([]);
    expect(state.entries[a.host]).toBeUndefined();
    // At least one try met the stop: this test's own pass, or a run the runtime started before it. From here the wait
    // is held far ahead, so every count below is of this test's own steps.
    const first = (await applyRows(a.room))[0] as any;
    expect(first).toEqual({ host: a.host, applied_version: null, applied_script: null, attempts: expect.any(Number), last_code: "content_domain_stopped" });
    expect(first.attempts).toBeGreaterThanOrEqual(1);
    // No room's own state changed for the stop.
    expect((await serveRows(a.room))[0]).toMatchObject({ script_name: a.served, version: 5 });
    // A takedown goes through while the domain is stopped: a removal never asks.
    await switchedOn(() => suspend(b.label));
    await pass(b.room);
    state = await held();
    expect(state.entries[b.host]).toBeUndefined();
    expect((await applyRows(b.room))[0]).toMatchObject({ applied_version: 6, applied_script: null });
    // If the stop can't be read, nothing is written either: it fails closed.
    await alarmQuiet(stub(a.room));
    await switchedOn(() => resumeDomain());
    await inModeration((sql) => sql.exec("CREATE TABLE test_stop_unreadable (x INTEGER)"));
    await due(a.room);
    await pass(a.room);
    expect(callsFor(await held(), a)).toEqual([]);
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: null, attempts: first.attempts + 1, last_code: "stop_unreadable" });
    // Resumed and readable, the entry the room wanted all along is written.
    await inModeration((sql) => sql.exec("DROP TABLE test_stop_unreadable"));
    await due(a.room);
    await pass(a.room);
    state = await held();
    expect(callsFor(state, a)).toEqual(["entry.put host 200", "entry.get host 200"]);
    expect(state.entries[a.host]).toBe(a.served);
    for (const room of [a.room, b.room]) await alarmQuiet(stub(room));
  }));

  it("says in the operator's answer whether the key is confirmed, and writes a key owed from before a provider existed", () => unstopped(async () => {
    await fresh();
    // Stopped with no provider: the stop holds, its key is owed, and no alarm is set for it.
    await inModeration((sql) => sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)"));
    expect((await switchedOn(() => stopDomain())).body).toMatchObject({ stopped: true, key_confirmed: false });
    await settle(moderation());
    expect((await switchedOn(() => stopDomain())).body).toMatchObject({ stopped: true, key_confirmed: false });
    expect(await nextAlarm(moderation())).toBeNull();
    // With none, a pass reads nothing, and says so.
    expect(await reconcile("entries")).toMatchObject({ ran: false, code: "no_provider" });
    expect(await reconcile("scripts")).toMatchObject({ ran: false, code: "no_provider" });
    expect((await held()).calls).toEqual([]);
    expect(await nextAlarm(moderation())).toBeNull();
    // A provider appears. Nobody asks the operator's route again: the next pass sets the object's alarm, and that
    // run writes the key. The write is held at the stand-in, so it is known to be that run's, with no clock involved.
    await inModeration((sql) => sql.exec("DROP TABLE test_content_provider_off"));
    const write = await gate("entry.put");
    expect(await reconcile("entries")).toMatchObject({ ran: true, code: "ok" });
    await arrived(write);
    await release(write);
    await settle(moderation());
    const state = await held();
    expect([state.entries._stop, state.expiredGates]).toEqual(["stopped", 0]);
    expect((await switchedOn(() => stopDomain())).body).toMatchObject({ stopped: true, key_confirmed: true });
    // Resumed: unconfirmed until the key is read as gone, then confirmed.
    expect((await switchedOn(() => resumeDomain())).body).toMatchObject({ stopped: false, key_confirmed: false });
    await settle(moderation());
    expect((await held()).entries._stop).toBeUndefined();
    expect((await switchedOn(() => resumeDomain())).body).toMatchObject({ stopped: false, key_confirmed: true });
  }));

  it("is put right by the object itself when the key at the provider isn't what the stop says", () => unstopped(async () => {
    await fresh();
    await switchedOn(() => stopDomain());
    await settle(moderation());
    await alarmQuiet(moderation());
    expect((await held()).entries._stop).toBe("stopped");
    // A pass that finds the key where it should be changes nothing.
    expect(await reconcile("entries")).toMatchObject({ code: "ok", listed: 1, changed: 0 });
    expect((await stopRow()).applied_version).toBe((await stopRow()).version);
    // The key goes missing, by no act of Podster's. The pass writes nothing itself: the object forgets that it
    // confirmed the key, and its own alarm writes it again.
    await fake("/reset", {});
    const write = await gate("entry.put");
    expect(await reconcile("entries")).toMatchObject({ code: "ok", listed: 0, changed: 1 });
    await arrived(write);
    await release(write);
    await settle(moderation());
    expect((await held()).entries._stop).toBe("stopped");
    expect(await found()).toEqual(["stop_key_differs _stop"]);
    // Resumed and confirmed absent, then the key appears again: the object takes it out.
    await switchedOn(() => resumeDomain());
    await settle(moderation());
    await alarmQuiet(moderation());
    await fake("/seed", { entries: { _stop: "stopped" } });
    const removal = await gate("entry.delete");
    expect(await reconcile("entries")).toMatchObject({ changed: 1 });
    await arrived(removal);
    await release(removal);
    await settle(moderation());
    const state = await held();
    expect([state.entries._stop, state.expiredGates]).toEqual([undefined, 0]);
    expect((await stopRow()).applied_version).toBe((await stopRow()).version);
  }));

  it("judges the stop key only once the whole list is read, a page at a time, and starts over on a cursor the provider refuses", () => unstopped(async () => {
    await fresh();
    await switchedOn(() => stopDomain());
    await settle(moderation());
    await alarmQuiet(moderation());
    // Sixty names nobody's, on the content domain, around the stop key: more than one page.
    // Fifty-five sort before the key and five after it, so the first page of fifty holds strays alone.
    const strays = Array.from({ length: 60 }, (_, i) => `${i < 55 ? "0" : "z"}${i}.deep.${FAKE.domain}`);
    await fake("/seed", { entries: Object.fromEntries(strays.map((name) => [name, "x"])) });
    const passState = () => inModeration((sql) => sql.exec("SELECT cursor IS NOT NULL AS mid, stop_seen, last_code FROM reconcile_pass WHERE pass = 'entries'").one());
    // Nothing is said of the stop after the first page: the key hasn't been reached.
    expect(await reconcile("entries")).toMatchObject({ code: "ok", listed: 50, findings: 50, changed: 0 });
    expect(await passState()).toMatchObject({ mid: 1 });
    // The second page ends the list, with the key in it: it is where it should be, and nothing changes.
    expect(await reconcile("entries")).toMatchObject({ code: "ok", listed: 11, findings: 10, changed: 0 });
    expect(await passState()).toEqual({ mid: 0, stop_seen: 0, last_code: "ok" });
    expect((await stopRow()).applied_version).toBe((await stopRow()).version);
    expect((await found()).filter((line) => line.startsWith("entry_foreign_name ")).length).toBe(60);
    // Nothing was written or removed by either pass: every stray is still there.
    const state = await held();
    expect(Object.keys(state.entries).length).toBe(61);
    expect(state.calls.filter((call) => call.op === "entry.put" || call.op === "entry.delete").length).toBe(1);
    // A cursor the provider no longer takes: no list, and the next pass starts from the top.
    await reconcile("entries");
    await inModeration((sql) => sql.exec("UPDATE reconcile_pass SET cursor = 'no such cursor' WHERE pass = 'entries'"));
    expect(await reconcile("entries")).toMatchObject({ code: "list_failed", listed: 0 });
    expect(await passState()).toEqual({ mid: 0, stop_seen: 0, last_code: "list_failed" });
    expect(await reconcile("entries")).toMatchObject({ code: "ok", listed: 50 });
  }));
});

describe("an operator's suspension of a custom hostname", () => {
  const claimRows = (hostname: string) => inClaim(hostname, (sql) => ({
    name: sql.exec("SELECT name, generation, last_suspended_at IS NOT NULL AS was_suspended, last_lifted_at IS NOT NULL AS was_lifted FROM hostname").toArray(),
    suspension: sql.exec("SELECT reason, lifted_at IS NULL AS holds FROM suspension").toArray(),
    claim: sql.exec("SELECT workspace_id, request_id, state, held, end_reason FROM claim").toArray(),
    notice: sql.exec("SELECT workspace_id, kind, attempts, answered_at IS NOT NULL AS answered FROM notice ORDER BY seq").toArray(),
  }));
  const CHALLENGE = "c4".repeat(32);

  /**
   * A room whose app is also served on a custom hostname it holds a live claim to, as custom domains will leave it.
   * `generation` is the name's generation the request was made, and the claim given, under. `flight` leaves a commit
   * waiting for its marker on both hosts.
   */
  async function claimed(opts: { generation?: number; flight?: boolean } = {}) {
    const a = await app({ plain: !opts.flight });
    const hostname = newHostname();
    const request = `hnr_${crypto.randomUUID().replace(/-/g, "")}`;
    const generation = opts.generation ?? 0;
    const serving = opts.flight ? a.flight : a.served;
    await inRoom(a.room, (sql) => {
      sql.exec("INSERT INTO hostname_request (id, hostname, state, open, challenge, generation, requested_by, requested_at, expires_at, claimed_at, proved_at, updated_at) VALUES (?, ?, 'claimed', 1, ?, ?, 'per_td_owner', 1, 2, 1, 1, 1)", request, hostname, CHALLENGE, generation);
      sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, flight_version, flight_before, updated_at) VALUES (?, 'custom', ?, 1, ?, ?, 3, ?, ?, 1)",
        hostname, a.label, opts.flight ? rel(3) : rel(2), serving, opts.flight ? 3 : null, opts.flight ? a.served : null);
      sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 3, ?, 1, 1)", hostname, serving);
    });
    await fake("/seed", { entries: { [hostname]: serving } });
    await holds(hostname, a.room, request, generation);
    return { ...a, hostname, request, serving };
  }
  /** The hostname's own object, holding a live claim for a room's request, given under `generation`. */
  async function holds(hostname: string, room: string, request: string, generation = 0) {
    await claimOf(hostname).fetch("https://do/internal/test-migrate", { method: "POST" });
    await inClaim(hostname, (sql) => {
      sql.exec("INSERT INTO hostname (singleton, name, created_at, generation) VALUES (1, ?, 1, ?)", hostname, generation);
      sql.exec("INSERT INTO claim (id, workspace_id, request_id, state, held, claimed_at, proved_at, updated_at, generation) VALUES ('clm_1', ?, ?, 'live', 1, 1, 1, 1, ?)", room, request, generation);
    });
  }
  /**
   * One run of the object's alarm, then, in the same turn, what it left for its one notice, with the due time put
   * far ahead. So nothing a test reads next depends on the 5-second wait not having run out, however long the test
   * takes between steps. `alarm` is the alarm as that run set it.
   */
  const settleAndHold = (hostname: string) => runInDurableObject(claimOf(hostname), async (instance: any, state: any) => {
    await state.storage.deleteAlarm();
    await instance.alarm();
    const alarm = await state.storage.getAlarm();
    const row = state.storage.sql.exec("SELECT attempts, next_attempt_at, answered_at FROM notice ORDER BY seq DESC LIMIT 1").one();
    state.storage.sql.exec("UPDATE notice SET next_attempt_at = ? WHERE answered_at IS NULL", FAR());
    return { attempts: row.attempts as number, wait: row.next_attempt_at as number, answered: row.answered_at !== null, alarm: alarm as number | null };
  }) as Promise<{ attempts: number; wait: number; answered: boolean; alarm: number | null }>;
  const notice = (room: string, body: object) => stub(room).fetch("https://do/internal/hostname-notice", { method: "POST", body: JSON.stringify(body) }).then(async (r: Response) => [r.status, await r.json()]);
  const customRow = (room: string, hostname: string) => one(room, "SELECT script_name, version, closed FROM serve_state WHERE host = ?", hostname);
  const requestRow = (room: string, id: string) => one(room, "SELECT state, open, end_reason FROM hostname_request WHERE id = ?", id);
  const hostEvents = (room: string) => all(room, "SELECT type, actor_id FROM event WHERE type LIKE 'app_hostname.%' ORDER BY seq");

  it("settles who is asking first, then what the name is", async () => {
    const hostname = newHostname();
    const a = await app({ plain: true });
    await switchedOn(async () => {
      for (const body of [{ reason: "abuse" }, {}]) for (const who of [AGENT, OWNER]) expect((await api(who, "POST", `/v1/moderation/app-hosts/${hostname}/suspend`, body)).code).toBe("not_allowed");
      for (const body of [{}, { reason: "nonsense" }]) expect((await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${hostname}/suspend`, body)).code).toBe("invalid_argument");
      // Not a hostname at all, or a single label.
      for (const host of ["localhost", "bad_name.example.org", "-bad.example.org"]) expect((await suspendHost(host)).code, host).toBe("invalid_argument");
      // On the content domain but nobody's host, or on Podster's own domain: no such hostname.
      for (const host of [`deep.${a.host}`, FAKE.domain, "podster.dev", "app.podster.dev"]) expect([(await suspendHost(host)).status, (await suspendHost(host)).code], host).toEqual([404, "not_found"]);
    });
    // None of that left anything behind for the name.
    expect(await claimOf(hostname).fetch("https://do/internal/state").then((r: Response) => r.json())).toEqual({ claim: null, suspended: false });
    await alarmQuiet(stub(a.room));
  });

  it("holds with no room at all, advances the name's generation, and lifts without restoring anything", async () => {
    const hostname = newHostname();
    await switchedOn(async () => {
      const done = await suspendHost(hostname);
      expect([done.status, done.body]).toEqual([200, { host: hostname, suspended: true, reason: "abuse", at: expect.any(Number) }]);
      expect(await claimRows(hostname)).toEqual({ name: [{ name: hostname, generation: 1, was_suspended: 1, was_lifted: 0 }], suspension: [{ reason: "abuse", holds: 1 }], claim: [], notice: [] });
      expect(await claimOf(hostname).fetch("https://do/internal/state").then((r: Response) => r.json())).toEqual({ claim: null, suspended: true });
      // Two spellings are one name, and asking again changes nothing: no new generation.
      expect((await suspendHost(hostname.toUpperCase(), OPERATOR, "spam")).body).toEqual(done.body);
      expect((await suspendHost(`${hostname}.`)).body).toEqual(done.body);
      expect((await claimRows(hostname)).name[0].generation).toBe(1);

      const lifted = await liftHost(hostname);
      expect([lifted.status, lifted.body]).toEqual([200, { host: hostname, suspended: false, reason: null, at: null }]);
      expect((await liftHost(hostname)).body).toEqual(lifted.body);
      // The lift advanced it too, so a request made under either earlier generation can't claim.
      expect(await claimRows(hostname)).toMatchObject({ name: [{ generation: 2, was_suspended: 1, was_lifted: 1 }], suspension: [{ reason: "abuse", holds: 0 }] });
      // Suspended again, it holds again, under a new generation.
      expect((await suspendHost(hostname, OPERATOR, "illegal")).body).toMatchObject({ suspended: true, reason: "illegal" });
      expect(await claimRows(hostname)).toMatchObject({ name: [{ generation: 3 }], suspension: [{ reason: "illegal", holds: 1 }] });
    });
    const log = await runInDurableObject(moderation(), (_: any, state: any) => state.storage.sql.exec("SELECT subject_kind, action, outcome FROM operator_action WHERE subject = ? ORDER BY seq", hostname).toArray());
    expect(log.map((row: any) => `${row.subject_kind} ${row.action} ${row.outcome}`)).toEqual(["app_host suspend done", "app_host suspend done", "app_host suspend done", "app_host lift done", "app_host lift done", "app_host suspend done"]);
    // The object answers only for the name it is for.
    const wrong = await claimOf(hostname).fetch("https://do/internal/suspension", { method: "POST", body: JSON.stringify({ hostname: newHostname(), suspended: false, reason: "other" }) });
    expect(wrong.status).toBe(500);
    expect((await claimRows(hostname)).suspension[0].holds).toBe(1);
  });

  it("ends serving on a name a room holds: the claim starts ending, the room clears and closes that host, and its default host stays", async () => {
    const c = await claimed();
    expect((await switchedOn(() => suspendHost(c.hostname))).status).toBe(200);
    // In the hostname's own object, at once: suspended, the claim ending and still holding the name, the room owed a notice.
    let rows = await claimRows(c.hostname);
    expect(rows).toMatchObject({ name: [{ generation: 1 }], suspension: [{ holds: 1 }], claim: [{ workspace_id: c.room, request_id: c.request, state: "ending", held: 1, end_reason: "hostname_suspended" }] });
    expect(rows.notice).toHaveLength(1);
    // The notice reaches the room, which clears that host alone, in its own transaction.
    await settle(claimOf(c.hostname));
    rows = await claimRows(c.hostname);
    expect(rows.notice).toEqual([{ workspace_id: c.room, kind: "hostname_suspended", attempts: 1, answered: 1 }]);
    expect(await customRow(c.room, c.hostname)).toEqual({ script_name: null, version: 4, closed: 1 });
    expect(await requestRow(c.room, c.request)).toEqual({ state: "ending", open: 1, end_reason: "hostname_suspended" });
    expect(await hostEvents(c.room)).toEqual([{ type: "app_hostname.suspended", actor_id: "podster" }]);
    // The app itself isn't suspended: its default host, its epoch and its scripts are as they were.
    expect((await serveRows(c.room)).find((row: any) => row.host === c.host)).toMatchObject({ script_name: c.served, version: 5, closed: 0 });
    expect(await configRow(c.room)).toMatchObject({ release_epoch: 4, kept_previous: c.kept });
    expect(await all(c.room, "SELECT cause FROM unpublish")).toEqual([]);
    // The room's applier takes that host's entry out, and nothing else.
    await pass(c.room);
    const state = await held();
    expect([state.entries[c.hostname], state.entries[c.host]]).toEqual([undefined, c.served]);
    expect(state.scripts).toEqual(expect.arrayContaining([c.kept, c.served]));
    expect((await applyRows(c.room)).find((row: any) => row.host === c.hostname)).toMatchObject({ applied_version: 4, applied_script: null });
    // Told a second time, the room changes nothing more.
    await inClaim(c.hostname, (sql) => sql.exec("INSERT INTO notice (workspace_id, claim_id, kind, created_at, next_attempt_at) VALUES (?, 'clm_1', 'hostname_suspended', 1, 0)", c.room));
    await settle(claimOf(c.hostname));
    expect((await claimRows(c.hostname)).notice.map((row: any) => row.answered)).toEqual([1, 1]);
    expect([await hostEvents(c.room), (await customRow(c.room, c.hostname)).version]).toEqual([[{ type: "app_hostname.suspended", actor_id: "podster" }], 4]);
    // Lifting restores nothing: the host stays closed, the request ending, and the claim ending.
    expect((await switchedOn(() => liftHost(c.hostname))).body).toMatchObject({ suspended: false });
    await settle(claimOf(c.hostname));
    await pass(c.room);
    expect(await customRow(c.room, c.hostname)).toEqual({ script_name: null, version: 4, closed: 1 });
    expect((await requestRow(c.room, c.request)).state).toBe("ending");
    expect((await claimRows(c.hostname)).claim[0]).toMatchObject({ state: "ending", held: 1 });
    expect((await held()).entries[c.hostname]).toBeUndefined();
    await alarmQuiet(stub(c.room));
  });

  it("keeps the notice and sends it again until the room has answered", async () => {
    const c = await claimed();
    // The room fails to answer. Set before the suspension, so whichever run of the object's alarm comes first meets it.
    await inRoom(c.room, (sql) => sql.exec("CREATE TABLE test_refuse_hostname_notice (x INTEGER)"));
    const started = Date.now();
    await switchedOn(() => suspendHost(c.hostname));
    // At least one try has failed, by this run or one the runtime started. From here the notice's due time is held
    // far ahead, so every count below is of this test's own steps.
    const first = await settleAndHold(c.hostname);
    expect([first.answered, first.attempts >= 1]).toEqual([false, true]);
    expect(first.wait).toBeGreaterThanOrEqual(started + 5000);
    expect(first.alarm).toBe(first.wait);
    // The room hasn't cleared anything yet: it is still open in the room's state.
    expect(await customRow(c.room, c.hostname)).toEqual({ script_name: c.served, version: 3, closed: 0 });
    // It waits before it asks again: while the wait isn't over, a run sends nothing.
    await settle(claimOf(c.hostname));
    expect((await claimRows(c.hostname)).notice[0].attempts).toBe(first.attempts);
    // Then it asks again, and the room answers this time.
    await inRoom(c.room, (sql) => sql.exec("DROP TABLE test_refuse_hostname_notice"));
    await inClaim(c.hostname, (sql) => sql.exec("UPDATE notice SET next_attempt_at = 0"));
    await settle(claimOf(c.hostname));
    expect((await claimRows(c.hostname)).notice).toEqual([{ workspace_id: c.room, kind: "hostname_suspended", attempts: first.attempts + 1, answered: 1 }]);
    expect(await customRow(c.room, c.hostname)).toEqual({ script_name: null, version: 4, closed: 1 });
    expect(await nextAlarm(claimOf(c.hostname))).toBeNull();
    await pass(c.room);
    expect((await held()).entries[c.hostname]).toBeUndefined();
    await alarmQuiet(stub(c.room));
  });

  it("changes nothing in a room that doesn't hold that request, and stops asking", async () => {
    const a = await app({ plain: true });
    const before = [await serveRows(a.room), await all(a.room, "SELECT * FROM hostname_request"), await all(a.room, "SELECT type FROM event WHERE type LIKE 'app%'")];
    // The object names a room that has no such request, and, for another name, a room that doesn't exist.
    const [stray, nowhere] = [newHostname(), newHostname()];
    await holds(stray, a.room, "hnr_unknown");
    await holds(nowhere, `ws_${"0".repeat(32)}`, "hnr_unknown");
    await switchedOn(async () => { await suspendHost(stray); await suspendHost(nowhere); });
    for (const hostname of [stray, nowhere]) {
      await settle(claimOf(hostname));
      expect((await claimRows(hostname)).notice.map((row: any) => row.answered), hostname).toEqual([1]);
    }
    expect([await serveRows(a.room), await all(a.room, "SELECT * FROM hostname_request"), await all(a.room, "SELECT type FROM event WHERE type LIKE 'app%'")]).toEqual(before);
    await alarmQuiet(stub(a.room));
  });

  it("never lets a late notice close the host of a newer request", async () => {
    // The room held the name under one request, which has ended. It holds it again under a second, made under a later
    // generation, and is serving on it. The first claim's notice arrives only now.
    const c = await claimed({ generation: 4 });
    const first = `hnr_${crypto.randomUUID().replace(/-/g, "")}`;
    await inRoom(c.room, (sql) => sql.exec("INSERT INTO hostname_request (id, hostname, state, open, challenge, generation, requested_by, requested_at, expires_at, ended_at, end_reason, updated_at) VALUES (?, ?, 'ended', NULL, ?, 0, 'per_td_owner', 1, 2, 3, 'removed', 3)", first, c.hostname, CHALLENGE));
    const before = [await customRow(c.room, c.hostname), await requestRow(c.room, c.request), await requestRow(c.room, first), await hostEvents(c.room)];
    // For the ended request: acknowledged, so the object stops asking, and nothing is cleared.
    expect(await notice(c.room, { hostname: c.hostname, request_id: first, generation: 0 })).toEqual([200, { known: true, acted: false }]);
    // For the request the room holds and is serving on, under a generation that isn't its own: a fault. It is never
    // acknowledged, so the object would keep it and send it again, and nothing is cleared on its word.
    for (const generation of [0, 3, 5]) expect((await notice(c.room, { hostname: c.hostname, request_id: c.request, generation }))[0], String(generation)).toBe(500);
    // For that request under another name, or with no generation at all: nothing either.
    expect(await notice(c.room, { hostname: newHostname(), request_id: c.request, generation: 4 })).toEqual([200, { known: false, acted: false }]);
    expect((await notice(c.room, { hostname: c.hostname, request_id: c.request }))[0]).toBe(400);
    expect([await customRow(c.room, c.hostname), await requestRow(c.room, c.request), await requestRow(c.room, first), await hostEvents(c.room)]).toEqual(before);
    expect(before[0]).toEqual({ script_name: c.served, version: 3, closed: 0 });
    // The one made for it, under its own generation, is the one that acts.
    expect(await notice(c.room, { hostname: c.hostname, request_id: c.request, generation: 4 })).toEqual([200, { known: true, acted: true }]);
    expect(await customRow(c.room, c.hostname)).toEqual({ script_name: null, version: 4, closed: 1 });
    expect((await requestRow(c.room, first)).state).toBe("ended");
    await alarmQuiet(stub(c.room));
  });

  it("keeps a notice the room refuses for its generation, and never drops it", async () => {
    // The room's open request was made under generation 4, and it is serving on the name. The claim, as if whatever
    // gave it had forgotten to record its generation, says 0.
    const c = await claimed({ generation: 4 });
    await inClaim(c.hostname, (sql) => sql.exec("UPDATE claim SET generation = 0"));
    await switchedOn(() => suspendHost(c.hostname));
    const first = await settleAndHold(c.hostname);
    // Refused, so not answered: the object still owes it and will send it again. Nothing was cleared on its word.
    expect([first.answered, first.attempts >= 1]).toEqual([false, true]);
    expect(first.alarm).toBe(first.wait);
    expect([await customRow(c.room, c.hostname), (await requestRow(c.room, c.request)).state, await hostEvents(c.room)]).toEqual([{ script_name: c.served, version: 3, closed: 0 }, "claimed", []]);
    // Once the claim carries the generation it was given under, the same notice is the room's to act on.
    await inClaim(c.hostname, (sql) => { sql.exec("UPDATE claim SET generation = 4"); sql.exec("UPDATE notice SET next_attempt_at = 0"); });
    await settle(claimOf(c.hostname));
    expect((await claimRows(c.hostname)).notice).toEqual([{ workspace_id: c.room, kind: "hostname_suspended", attempts: first.attempts + 1, answered: 1 }]);
    expect(await customRow(c.room, c.hostname)).toEqual({ script_name: null, version: 4, closed: 1 });
    await alarmQuiet(stub(c.room));
  });

  it("still clears the room's host when the name is lifted before the room has answered", async () => {
    const c = await claimed();
    await inRoom(c.room, (sql) => sql.exec("CREATE TABLE test_refuse_hostname_notice (x INTEGER)"));
    await switchedOn(() => suspendHost(c.hostname));
    const first = await settleAndHold(c.hostname);
    expect([first.answered, first.attempts >= 1]).toEqual([false, true]);
    // The operator lifts the suspension. The claim is ending all the same, and the notice is still owed.
    await switchedOn(() => liftHost(c.hostname));
    expect(await claimRows(c.hostname)).toMatchObject({ suspension: [{ holds: 0 }], claim: [{ state: "ending", held: 1 }], notice: [{ answered: 0 }] });
    await inRoom(c.room, (sql) => sql.exec("DROP TABLE test_refuse_hostname_notice"));
    await inClaim(c.hostname, (sql) => sql.exec("UPDATE notice SET next_attempt_at = 0"));
    await settle(claimOf(c.hostname));
    expect((await claimRows(c.hostname)).notice).toEqual([{ workspace_id: c.room, kind: "hostname_suspended", attempts: first.attempts + 1, answered: 1 }]);
    expect(await customRow(c.room, c.hostname)).toEqual({ script_name: null, version: 4, closed: 1 });
    expect((await requestRow(c.room, c.request)).state).toBe("ending");
    await alarmQuiet(stub(c.room));
  });

  it("owes the room a second notice when a name it still holds is suspended again, and the room changes nothing twice", async () => {
    const c = await claimed({ generation: 2 });
    await switchedOn(() => suspendHost(c.hostname));
    await settle(claimOf(c.hostname));
    expect(await customRow(c.room, c.hostname)).toEqual({ script_name: null, version: 4, closed: 1 });
    await switchedOn(() => liftHost(c.hostname));
    // The claim is still ending and still holds the name. Suspended again, the room is told again.
    await switchedOn(() => suspendHost(c.hostname, OPERATOR, "illegal"));
    let rows = await claimRows(c.hostname);
    expect(rows).toMatchObject({ name: [{ generation: 5 }], suspension: [{ reason: "illegal", holds: 1 }], claim: [{ state: "ending", held: 1 }] });
    // A second notice is owed. Whether the object's own alarm has already sent it isn't this test's to assume.
    expect([rows.notice.length, rows.notice[0].answered]).toEqual([2, 1]);
    await settle(claimOf(c.hostname));
    rows = await claimRows(c.hostname);
    expect(rows.notice.map((row: any) => row.answered)).toEqual([1, 1]);
    // It carries the generation the claim was given under, so the room knows it for its own request, and has nothing left to do.
    expect([await customRow(c.room, c.hostname), await hostEvents(c.room)]).toEqual([{ script_name: null, version: 4, closed: 1 }, [{ type: "app_hostname.suspended", actor_id: "podster" }]]);
    expect(await nextAlarm(claimOf(c.hostname))).toBeNull();
    await alarmQuiet(stub(c.room));
  });

  it("clears a custom host while a commit is waiting for its marker, and leaves that commit as it was", async () => {
    const c = await claimed({ flight: true });
    const flight = () => Promise.all([configRow(c.room), one(c.room, "SELECT script_name, version, closed, flight_version, flight_before FROM serve_state WHERE kind = 'default'")]);
    const before = await flight();
    expect(before[0]).toMatchObject({ in_flight_release: rel(3), in_flight_script: c.flight, in_flight_epoch: 4 });
    expect(await notice(c.room, { hostname: c.hostname, request_id: c.request, generation: 0 })).toEqual([200, { known: true, acted: true }]);
    // That host alone: nothing to serve, closed, its version up. What the commit wrote there and found there is kept,
    // so the mark the room rebuilds for the commit is the one it had.
    expect(await one(c.room, "SELECT script_name, version, closed, flight_version, flight_before FROM serve_state WHERE host = ?", c.hostname)).toEqual({ script_name: null, version: 4, closed: 1, flight_version: 3, flight_before: c.served });
    // The commit in flight, the epoch and the default host are untouched.
    expect(await flight()).toEqual(before);
    expect(await all(c.room, "SELECT cause FROM unpublish")).toEqual([]);
    // The applier removes that host's entry and leaves the default host's.
    await pass(c.room);
    const state = await held();
    expect([state.entries[c.hostname], state.entries[c.host]]).toEqual([undefined, c.flight]);
    await alarmQuiet(stub(c.room));
  });

  it("asks for no wake over a notice it would never send", async () => {
    const hostname = newHostname();
    await holds(hostname, `ws_${"1".repeat(32)}`, "hnr_x");
    // A notice whose claim this object doesn't have: the sender passes it over, so the alarm isn't set for it.
    await inClaim(hostname, (sql) => sql.exec("INSERT INTO notice (workspace_id, claim_id, kind, created_at, next_attempt_at) VALUES ('ws_gone', 'clm_gone', 'hostname_suspended', 1, 0)"));
    await settle(claimOf(hostname));
    expect(await nextAlarm(claimOf(hostname))).toBeNull();
    expect(await inClaim(hostname, (sql) => sql.exec("SELECT attempts, answered_at FROM notice").one())).toEqual({ attempts: 0, answered_at: null });
  });

  it("is found for the reconcile by the hostname's own object, which is woken, and a host the room refuses is told to operators", async () => {
    await fresh();
    const c = await claimed();
    // The entry for the custom hostname names another of the room's scripts than the room wants.
    await fake("/seed", { entries: { [c.hostname]: c.kept } });
    const summary = await reconcile("entries");
    expect(summary).toMatchObject({ code: "ok", listed: 2, changed: 1, unanswered: 0 });
    // The room's own applier did the rest. Nothing confirms a custom hostname's claim until custom domains are built,
    // so it takes the entry out and refuses the host; the default host's entry, which matched, is untouched.
    await pass(c.room);
    const state = await held();
    expect([state.entries[c.hostname], state.entries[c.host]]).toEqual([undefined, c.served]);
    expect(state.calls.filter((call) => call.name === c.host).map((call) => call.op)).toEqual(["entry.get"]);
    // The next pass carries the refusal to the operators' record, by the host it is about.
    await reconcile("entries");
    expect(await found()).toEqual([`host_refused ${c.hostname} claim_check_not_built`]);
    await alarmQuiet(stub(c.room));
  });

  it("tells operators of a notice no room answers, and gets a lost wake back from the reconcile", async () => {
    await fresh();
    const c = await claimed();
    await inRoom(c.room, (sql) => sql.exec("CREATE TABLE test_refuse_hostname_notice (x INTEGER)"));
    await switchedOn(() => suspendHost(c.hostname));
    const first = await settleAndHold(c.hostname);
    expect(first.answered).toBe(false);
    expect(await found()).toEqual([]);
    // Its eleventh try has failed. The twelfth fails too, and operators are told, by the hostname.
    await inClaim(c.hostname, (sql) => sql.exec("UPDATE notice SET attempts = 11, next_attempt_at = 0"));
    const twelfth = await settleAndHold(c.hostname);
    expect([twelfth.answered, twelfth.attempts]).toEqual([false, 12]);
    expect(await found()).toEqual([`hostname_notice_unanswered ${c.hostname}`]);
    // No room's ID is in what operators read.
    expect(JSON.stringify(await findings())).not.toContain(c.room);

    // The room can answer again, the notice is due, and the wake for it is lost: no alarm is set.
    await inRoom(c.room, (sql) => sql.exec("DROP TABLE test_refuse_hostname_notice"));
    await inClaim(c.hostname, (sql) => sql.exec("UPDATE notice SET next_attempt_at = 0"));
    await runInDurableObject(claimOf(c.hostname), (_: any, state: any) => state.storage.deleteAlarm());
    // The removal of the name's entry is held at the stand-in. Only the room's applier removes it, and only after
    // the notice has reached the room. This test runs no alarm of its own from here, so a removal that arrives means
    // the pass asked the name's own object, which set its alarm again, sent the notice, and the room acted on it.
    const removal = await gate("entry.delete");
    await reconcile("entries");
    await arrived(removal);
    await release(removal);
    await alarmQuiet(stub(c.room));
    const state = await held();
    expect([state.entries[c.hostname], state.entries[c.host], state.expiredGates]).toEqual([undefined, c.served, 0]);
    expect((await claimRows(c.hostname)).notice[0]).toMatchObject({ answered: 1 });
    await alarmQuiet(claimOf(c.hostname));
    await alarmQuiet(stub(c.room));
  });
});

describe("the two reconciles", () => {
  it("run from the scheduled handler whenever a provider is configured, whatever `RELEASES` says, and with none call no object", async () => {
    await fresh();
    // Each call of a pass in the Moderation object is counted (test builds only), so a run that calls nothing is seen.
    await inModeration((sql) => void sql.exec("CREATE TABLE IF NOT EXISTS test_reconcile_calls (x INTEGER)"));
    const calls = () => inModeration((sql) => sql.exec("SELECT count(*) AS n FROM test_reconcile_calls").one().n as number);
    const before = await calls();
    // With no provider configured, which is every deployment today, the handler returns before it calls any Durable
    // Object: the cron's own invocation is all it costs.
    const noProvider = { ...env, CONTENT_DOMAIN: undefined };
    await scheduled(ENTRIES_CRON, noProvider);
    await scheduled(SCRIPTS_CRON, noProvider);
    expect(await calls()).toBe(before);
    expect((await held()).calls).toEqual([]);
    // A schedule nothing answers to calls nothing either.
    await scheduled("* * * * *");
    expect(await calls()).toBe(before);
    // With a provider and `RELEASES` not switched on, unset here as in every deployment: both passes run, so a
    // deployment's rooms are still asked whatever the setting says (M6 step 6). Unset is undecided, which takes
    // nothing down; `release-triggers.spec.ts` shows each reading.
    await scheduled(ENTRIES_CRON);
    expect([await listCalls("entry.list"), await listCalls("script.list")]).toEqual([1, 0]);
    await scheduled(SCRIPTS_CRON);
    expect([await listCalls("entry.list"), await listCalls("script.list")]).toEqual([1, 1]);
    expect(await calls()).toBe(before + 2);
    // And the same with release switched on.
    await switchedOn(() => scheduled(ENTRIES_CRON));
    expect(await calls()).toBe(before + 3);
    // Each list is asked with its own token: the stand-in refuses the other.
    expect((await held()).calls.filter((call) => call.op.endsWith(".list")).map((call) => call.status)).toEqual([200, 200, 200]);
    await inModeration((sql) => void sql.exec("DROP TABLE test_reconcile_calls"));
    // The schedules the handler knows are the two the plan names, and the two `wrangler.jsonc` gives every
    // environment, as the test of what step 4(a) binds shows.
    const source = (JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>)["reconcile.rs"];
    expect([...source.matchAll(/_CRON: &str = "([^"]+)";/g)].map((match) => match[1])).toEqual([ENTRIES_CRON, SCRIPTS_CRON]);
  });

  it("is an operator's read and nobody else's, and nothing anyone can find while release is switched off", async () => {
    await fresh();
    for (const who of [OPERATOR, OWNER, AGENT]) {
      const [real, unknown] = [await api(who, "GET", "/v1/moderation/takedown-findings"), await api(who, "GET", "/v1/moderation/takedown-findingsx")];
      expect([real.status, real.code], who.id).toEqual([404, "not_found"]);
      expect([real.status, real.body], who.id).toEqual([unknown.status, unknown.body]);
    }
    await switchedOn(async () => {
      for (const who of [AGENT, OWNER]) expect((await api(who, "GET", "/v1/moderation/takedown-findings")).code).toBe("not_allowed");
      const read = await api(OPERATOR, "GET", "/v1/moderation/takedown-findings");
      expect([read.status, read.body]).toEqual([200, { findings: [] }]);
    });
  });

  it("asks the room about an entry that differs, and writes nothing itself: the room's applier puts it right", async () => {
    await fresh();
    const a = await app({ plain: true });
    const b = await app({ plain: true });
    // Room a's entry names a script the room doesn't want there. Room b's is as it should be.
    await fake("/reset", {});
    await fake("/seed", { scripts: [a.kept, a.served, b.kept, b.served], entries: { [a.host]: a.kept, [b.host]: b.served } });
    const summary = await reconcile("entries");
    expect(summary).toMatchObject({ ran: true, code: "ok", listed: 2, asked: 4, changed: 1, findings: 0, unanswered: 0, woken: 2 });
    await pass(a.room);
    await pass(b.room);
    const state = await held();
    expect([state.entries[a.host], state.entries[b.host]]).toEqual([a.served, b.served]);
    // The reconcile listed and read. The one write, and its read-back, were room a's applier's. Room b's entry was
    // only read.
    expect(callsFor(state, a)).toEqual(["entry.get host 200", "entry.put host 200", "entry.get host 200"]);
    expect(callsFor(state, b)).toEqual(["entry.get host 200"]);
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 5, applied_script: a.served, attempts: 0 });
    // A second pass finds both as they should be, and changes nothing.
    expect(await reconcile("entries")).toMatchObject({ changed: 0 });
    await pass(a.room);
    expect((await held()).calls.filter((call) => call.op === "entry.put").length).toBe(1);
    // An entry that shouldn't be there at all, for a room whose app is down and applied: the room takes it out.
    await switchedOn(() => suspend(b.label));
    await pass(b.room);
    await fake("/seed", { entries: { [b.host]: b.served } });
    expect(await reconcile("entries")).toMatchObject({ changed: 1 });
    await pass(b.room);
    expect((await held()).entries[b.host]).toBeUndefined();
    for (const room of [a.room, b.room]) await alarmQuiet(stub(room));
  });

  it("tells operators of an entry with no room or a name Podster didn't write, and never removes one on the table's word", async () => {
    await fresh();
    const a = await app({ plain: true });
    const unlisted = await app({ plain: true, index: false });
    const [stray, nowhere, hostname] = [newLabel(), newLabel(), newHostname()];
    // A row that names a room which never had the label, and one that names a room that doesn't exist.
    await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(stray, a.room).run();
    await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(nowhere, `ws_${"0".repeat(32)}`).run();
    const entries: Record<string, string> = {
      [a.host]: a.served, [unlisted.host]: unlisted.served, [`${stray}.${FAKE.domain}`]: a.served, [`${nowhere}.${FAKE.domain}`]: a.served,
      [`deep.${a.host}`]: a.served, [FAKE.domain]: a.served, "Not_A-Host": "x", [hostname]: a.served,
    };
    await fake("/reset", {});
    await fake("/seed", { scripts: [a.kept, a.served], entries });
    const summary = await reconcile("entries");
    expect(summary).toMatchObject({ code: "ok", listed: 8, changed: 0, unanswered: 0 });
    expect(await found()).toEqual([
      `entry_foreign_name ${FAKE.domain}`, "entry_foreign_name Not_A-Host", `entry_foreign_name deep.${a.host}`,
      `entry_without_room ${hostname}`, `entry_without_room ${nowhere}.${FAKE.domain}`, `entry_without_room ${stray}.${FAKE.domain}`, `entry_without_room ${unlisted.host}`,
    ].sort());
    // Every one is left exactly as it was: no entry was written or removed, by the pass or by any room.
    await pass(a.room);
    const state = await held();
    expect(state.entries).toEqual(Object.fromEntries(Object.entries(entries).sort()));
    expect(state.calls.filter((call) => call.op === "entry.put" || call.op === "entry.delete")).toEqual([]);
    // Seen again, each is counted again and kept once.
    await reconcile("entries");
    expect((await findings()).map((finding) => finding.seen)).toEqual([2, 2, 2, 2, 2, 2, 2]);
    // Nothing operators read names a room by its ID.
    expect(JSON.stringify(await findings())).not.toMatch(/ws_[0-9a-f]/);
    for (const room of [a.room, unlisted.room]) await alarmQuiet(stub(room));
  });

  it("wakes a room whose wake was lost, and a room whose work was owed from before a provider existed", async () => {
    await fresh();
    // Its app is down in its own state, its entry is still at the provider, and no alarm is set: the wake was lost.
    const a = await downButNotApplied();
    await BINDINGS.DB.prepare("DELETE FROM app_label_index WHERE label != ?").bind(a.label).run();
    expect(await nextAlarm(stub(a.room))).toBeNull();
    // The removal is held at the stand-in. Only the room's applier removes an entry, and this test runs no pass of
    // its own, so a removal that arrives is the room's own alarm at work: the reconcile woke it.
    let removal = await gate("entry.delete");
    expect(await reconcile("entries")).toMatchObject({ code: "ok", listed: 1, changed: 0 });
    await arrived(removal);
    await release(removal);
    await alarmQuiet(stub(a.room));
    let state = await held();
    expect([state.entries[a.host], state.scripts, state.expiredGates]).toEqual([undefined, [], 0]);
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 6, applied_script: null });

    // A second room owes the same from a time with no provider, when it set no alarm. Nothing of its is at the
    // provider, so no list names it: the walk of the lookup table reaches it, from either pass.
    const b = await downButNotApplied();
    await fake("/reset", {});
    await inRoom(b.room, (sql) => sql.exec("UPDATE script_delete SET attempts = 12, last_code = 'delete_500' WHERE script_name = ?", b.kept));
    expect(await nextAlarm(stub(b.room))).toBeNull();
    removal = await gate("entry.delete");
    const summary = await reconcile("scripts");
    expect(summary).toMatchObject({ code: "ok", listed: 0, woken: 2 });
    await arrived(removal);
    await release(removal);
    await alarmQuiet(stub(b.room));
    state = await held();
    expect(state.expiredGates).toBe(0);
    expect((await applyRows(b.room))[0]).toMatchObject({ applied_version: 6, applied_script: null });
    // The room also said one of its deletes had failed twelve times, and operators were told, by the script's name.
    expect(await found()).toEqual([`script_delete_failing ${b.kept} delete_500`]);
    for (const room of [a.room, b.room]) await alarmQuiet(stub(room));
  });

  it("doesn't find again a script the room counted gone after the pass read its list", async () => {
    // The pass reads the namespace once and then asks each script's room in turn, so the room's own delete job can
    // count a script gone between the list and the question: the question before ended a release and woke the room.
    // The question says when the list was read, and the room decides from its own record. Set here by construction.
    await fresh();
    const a = await app({ plain: true });
    const script = `${a.label}.${rel(9)}`;
    const goneAt = 1_900_000_000_000;
    await inRoom(a.room, (sql) => sql.exec("INSERT INTO script_delete (script_name, label, unpublish_epoch, queued_at, next_attempt_at, gone_at) VALUES (?, ?, NULL, 1, 1, ?)", script, a.label, goneAt));
    const ask = (listedAt?: number) => stub(a.room).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify({ kind: "script", script, ...(listedAt === undefined ? {} : { listed_at: listedAt }) }) }).then((r: Response) => r.json() as Promise<any>);
    // Listed before the room counted it gone: the list is older than the deletion. Nothing owed, nothing told.
    expect((await ask(goneAt - 1)).changed).toBe(false);
    expect((await ask(goneAt)).changed).toBe(false);
    expect((await one(a.room, "SELECT gone_at FROM script_delete WHERE script_name = ?", script)).gone_at).toBe(goneAt);
    // Listed after it was counted gone: it is there after all, and owed again.
    expect((await ask(goneAt + 1)).changed).toBe(true);
    expect((await one(a.room, "SELECT gone_at, last_code FROM script_delete WHERE script_name = ?", script))).toEqual({ gone_at: null, last_code: "reconcile_found" });
    await alarmQuiet(stub(a.room));
  });

  it("has the label's own room delete a script nothing of its claims, an uncertain release's among them, and leaves the rest", async () => {
    await fresh();
    const a = await app({ plain: true });
    const unlisted = await app({ plain: true, index: false });
    const stray = newLabel();
    await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(stray, a.room).run();
    const script = (n: number) => `${a.label}.${rel(n)}`;
    const now = Date.now();
    await inRoom(a.room, (sql) => {
      const release = (n: number, state: string, started: number | null) => sql.exec(
        `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 4, ?, ?, 'per_td_owner', 1, 'per_td_owner', 1, ?, 1)`, rel(n), SHA, state, a.label, script(n), rel(n), started);
      // Uploaded, with an outcome nobody knows, and no commit in flight: no row of the room's state names its script.
      release(7, "uncertain", 1);
      // Uploading now, and uploading for two hours.
      release(8, "uploading", now);
      release(6, "uploading", now - 2 * 60 * 60 * 1000);
    });
    const foreign = ["not-podsters", `${a.label}.rel_short`];
    const noRoom = [`${unlisted.label}.${rel(1)}`, `${stray}.${rel(1)}`];
    // In the namespace: what the room serves and keeps, the three releases' scripts, one under its label that no
    // release of its ever had, two names Podster didn't make, and two whose label finds no room that owns it.
    const seeded = [a.kept, a.served, script(7), script(8), script(6), script(9), ...foreign, ...noRoom];
    await fake("/reset", {});
    await fake("/seed", { scripts: seeded, entries: { [a.host]: a.served } });
    const summary = await reconcile("scripts");
    // One the pass itself started: the script no release names. The other two the room queued too, as its own act: at
    // the pass's first question it ended the two releases whose uploads had outlived their hour (step 5), and a
    // failed release's script is queued with it.
    expect(summary).toMatchObject({ ran: true, code: "ok", listed: 10, changed: 1, unanswered: 0 });
    expect(await all(a.room, "SELECT id, state, failure_code FROM release WHERE id IN (?, ?, ?) ORDER BY id", rel(6), rel(7), rel(8))).toEqual([
      { id: rel(6), state: "failed", failure_code: "release_upload_expired" }, { id: rel(7), state: "failed", failure_code: "release_upload_expired" }, { id: rel(8), state: "uploading", failure_code: null },
    ]);
    // The room queued exactly three, under no unpublish: the uncertain one, the upload that outlived its hour, and
    // the one no release names.
    expect((await deleteRows(a.room)).map((row: any) => [row.script_name, row.unpublish_epoch])).toEqual([script(6), script(7), script(9)].sort().map((name) => [name, null]));
    await pass(a.room);
    let state = await held();
    expect(state.scripts).toEqual([a.kept, a.served, script(8), ...foreign, ...noRoom].sort());
    // Only those three were ever asked to be deleted, each by the room's own job.
    expect([...new Set(state.calls.filter((call) => call.op === "script.delete").map((call) => call.name))].sort()).toEqual([script(6), script(7), script(9)].sort());
    expect((await deleteRows(a.room)).map((row: any) => row.gone)).toEqual([1, 1, 1]);
    // The delete the pass started is on the operators' record, by the script's name, beside what was left alone. The
    // two failed releases' scripts aren't: each is on the room's own record, as its release's failure.
    const queued = [script(9)].map((name) => `script_delete_queued ${name}`);
    expect(await found()).toEqual([...queued, ...foreign.map((name) => `script_foreign_name ${name}`), ...noRoom.map((name) => `script_without_room ${name}`)].sort());
    // A script the room counted as gone is in the namespace after all: it is owed again, and goes again.
    await fake("/seed", { scripts: [script(9)] });
    expect(await reconcile("scripts")).toMatchObject({ changed: 1 });
    await pass(a.room);
    state = await held();
    expect(state.scripts).not.toContain(script(9));
    // A list that says it holds less than there is: what it holds is still asked about, and operators are told.
    await fake("/seed", { scriptsUnlisted: 3 });
    expect(await reconcile("scripts")).toMatchObject({ code: "list_incomplete", changed: 0 });
    expect(await found()).toContain("script_list_incomplete namespace");
    // No list at all: nothing is asked and nothing queued.
    await fault({ op: "script.list", times: 1, status: 500 });
    expect(await reconcile("scripts")).toMatchObject({ code: "list_failed", listed: 0, asked: 2, changed: 0 });
    expect((await held()).scripts).toEqual(state.scripts);
    for (const room of [a.room, unlisted.room]) await alarmQuiet(stub(room));
  });

  it("never reads an entry it couldn't read as a match: a host that wants nothing has it taken out, and operators are told", async () => {
    await fresh();
    const a = await app({ plain: true });
    const b = await app({ plain: true });
    // Room a's app is suspended, and the removal of its entry is confirmed.
    await switchedOn(() => suspend(a.label));
    await pass(a.room);
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 6, applied_script: null });
    expect((await held()).entries[a.host]).toBeUndefined();
    // Something that isn't Podster writes that host an entry naming a script Podster never made.
    await fake("/seed", { entries: { [a.host]: "someone-elses-script" } });
    expect(await reconcile("entries")).toMatchObject({ code: "ok", listed: 2, changed: 1, errors: 0 });
    await pass(a.room);
    let state = await held();
    expect([state.entries[a.host], state.entries[b.host]]).toEqual([undefined, b.served]);
    expect(callsFor(state, a).slice(-3)).toEqual(["entry.get host 200", "entry.delete host 200", "entry.get host 404"]);
    expect(await found()).toEqual([`entry_unreadable ${a.host}`]);
    // The same with a script's name Podster did make, for that host: it wants nothing, so nothing there matches.
    await fake("/seed", { entries: { [a.host]: a.served } });
    expect(await reconcile("entries")).toMatchObject({ changed: 1 });
    await pass(a.room);
    expect((await held()).entries[a.host]).toBeUndefined();
    // Room b wants its script, and its entry is right, but the pass's read of it fails. A read that failed equals
    // nothing: the room writes its entry again, which changes nothing served.
    const puts = (await held()).calls.filter((call) => call.op === "entry.put").length;
    await fault({ op: "entry.get", times: 1, status: 500 });
    expect(await reconcile("entries")).toMatchObject({ listed: 1, changed: 1 });
    await pass(b.room);
    state = await held();
    expect(state.entries[b.host]).toBe(b.served);
    expect(state.calls.filter((call) => call.op === "entry.put").length).toBe(puts + 1);
    // A read that failed says nothing about that host. It is told once for the pass, with how many, never per host.
    expect(await found()).toEqual(["entry_reads_failing serve-entries 1", `entry_unreadable ${a.host}`]);
    for (const room of [a.room, b.room]) await alarmQuiet(stub(room));
  });

  it("goes on past a key it can't place, and takes a list with no end marked as no list", async () => {
    await fresh();
    const a = await app({ plain: true });
    const stray = `deep.${a.host}`;
    await fake("/reset", {});
    await fake("/seed", { scripts: [a.kept, a.served], entries: { [a.host]: a.kept, [stray]: "x" } });
    const passRow = () => inModeration((sql) => sql.exec("SELECT last_code, cursor FROM reconcile_pass WHERE pass = 'entries'").toArray()[0] ?? null);
    const failing = () => inModeration((sql) => sql.exec("SELECT kind, subject, failures FROM reconcile_failure").toArray().map((row: any) => `${row.kind} ${row.subject} ${row.failures}`).sort());
    // The lookup table can't be read: placing the default host's key fails, and so does the walk.
    const create = (BINDINGS.TEST_D1_SCHEMA as string).split(";").map((x) => x.trim()).filter((x) => /^CREATE TABLE\s+(IF NOT EXISTS\s+)?app_label_index\b/i.test(x));
    expect(create).toHaveLength(1);
    await BINDINGS.DB.prepare("DROP TABLE app_label_index").run();
    try {
      // Each is counted and skipped. The key after it is still judged, and where the pass got to is still written.
      // A pass that skipped a step is never recorded as plain `ok`.
      expect(await reconcile("entries")).toMatchObject({ code: "errors", listed: 2, asked: 0, errors: 2, findings: 1, woken: 0 });
      expect(await found()).toEqual([`entry_foreign_name ${stray}`]);
      expect(await passRow()).toEqual({ last_code: "errors", cursor: null });
      expect(await reconcile("scripts")).toMatchObject({ code: "errors", listed: 2, asked: 0, errors: 3 });
      // The same key fails a second pass, and a third: from the third, operators are told, by the key and the code.
      await reconcile("entries");
      expect(await found()).toEqual([`entry_foreign_name ${stray}`]);
      await reconcile("entries");
      expect(await found()).toEqual([`entry_foreign_name ${stray}`, `entry_keeps_failing ${a.host} internal_error`].sort());
      expect(await failing()).toEqual([`entry ${a.host} 3`, `script ${a.kept} 1`, `script ${a.served} 1`].sort());
    } finally {
      await BINDINGS.DB.prepare(create[0]).run();
    }
    await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(a.label, a.room).run();
    // With the table back, the key that was skipped is placed and its room asked.
    expect(await reconcile("entries")).toMatchObject({ code: "ok", errors: 0, changed: 1 });
    await pass(a.room);
    expect((await held()).entries[a.host]).toBe(a.served);
    // A step that works forgets the count: three in a row means three in a row.
    expect(await failing()).toEqual([`script ${a.kept} 1`, `script ${a.served} 1`].sort());
    expect(await reconcile("scripts")).toMatchObject({ code: "ok", errors: 0 });
    expect(await failing()).toEqual([]);
    // A page that doesn't say whether it is the last is no page: it is never read as the end of the list.
    await fake("/seed", { keysNoInfo: true });
    expect(await reconcile("entries")).toMatchObject({ code: "list_failed", listed: 0 });
    expect(await passRow()).toEqual({ last_code: "list_failed", cursor: null });
    await alarmQuiet(stub(a.room));
  });

  it("keeps telling of a deletion it started until the record has it, and a full record of anything else can't keep one out", async () => {
    await fresh();
    const a = await app({ plain: true });
    const stale = `${a.label}.${rel(9)}`;
    await fake("/reset", {});
    await fake("/seed", { scripts: [a.kept, a.served, stale], entries: { [a.host]: a.served } });
    expect(await reconcile("scripts")).toMatchObject({ code: "ok", changed: 1 });
    await pass(a.room);
    expect((await held()).scripts).toEqual([a.kept, a.served].sort());
    // The record of it is lost, as it would be had the room's one answer been lost. The script is gone, so no list
    // names it again. The room itself still knows: the next question to it, here only the walk's, carries it.
    await inModeration((sql) => sql.exec("DELETE FROM takedown_finding"));
    expect(await found()).toEqual([]);
    expect(await reconcile("entries")).toMatchObject({ code: "ok", changed: 0 });
    expect((await findings()).map((finding) => [finding.code, finding.subject, finding.detail])).toEqual([["script_delete_queued", stale, "gone"]]);
    // The record fills with something else, as an outage or a flood of strays would fill it, and the deletion's own
    // row is lost again. It still gets in: deletions have room of their own.
    await inModeration((sql) => {
      sql.exec("DELETE FROM takedown_finding");
      for (let i = 0; i < 1000; i++) sql.exec("INSERT INTO takedown_finding (code, subject, first_seen_at, last_seen_at) VALUES ('entry_foreign_name', ?, ?, ?)", `filler-${i}`, Date.now(), Date.now());
    });
    await fake("/seed", { entries: { [`deep.${a.host}`]: "x" } });
    expect(await reconcile("entries")).toMatchObject({ code: "ok" });
    const kept = await inModeration((sql) => sql.exec("SELECT code, subject, detail FROM takedown_finding WHERE subject NOT LIKE 'filler-%' ORDER BY code").toArray());
    // The new stray didn't fit and is counted as dropped, which an operator can see. The deletion did.
    expect(kept).toEqual([{ code: "findings_full", subject: "other", detail: null }, { code: "script_delete_queued", subject: stale, detail: "gone" }]);
    // A refused host and the stop key not as the stop says have room of their own too, each kind its own. So three
    // passes of an outage that fills the shared room with keys that keep failing can't keep either out.
    const tell = (code: string, subject: string) => moderation().fetch("https://do/takedown-finding", { method: "POST", body: JSON.stringify({ code, subject }) });
    const has = (code: string, subject: string) => inModeration((sql) => sql.exec("SELECT count(*) AS n FROM takedown_finding WHERE code = ? AND subject = ?", code, subject).one().n);
    for (const [code, subject] of [["host_refused", "refused.example.org"], ["stop_key_differs", "_stop"], ["stop_key_without_stop", "_stop"], ["entry_keeps_failing", "failing.example.org"]]) await tell(code, subject);
    expect([await has("host_refused", "refused.example.org"), await has("stop_key_differs", "_stop"), await has("stop_key_without_stop", "_stop"), await has("entry_keeps_failing", "failing.example.org")]).toEqual([1, 1, 1, 0]);
    // One kind's own room filling doesn't take another's: a thousand refused hosts leave the stop key's row its place.
    await inModeration((sql) => {
      sql.exec("DELETE FROM takedown_finding WHERE code IN ('stop_key_differs', 'host_refused')");
      for (let i = 0; i < 1000; i++) sql.exec("INSERT INTO takedown_finding (code, subject, first_seen_at, last_seen_at) VALUES ('host_refused', ?, ?, ?)", `refused-${i}`, Date.now(), Date.now());
    });
    await tell("host_refused", "one-more.example.org");
    await tell("stop_key_differs", "_stop");
    expect([await has("host_refused", "one-more.example.org"), await has("findings_full", "host_refused"), await has("stop_key_differs", "_stop")]).toEqual([0, 1, 1]);
    await alarmQuiet(stub(a.room));
  });

  it("takes back an unpublish's \"scripts gone\" while one of its scripts is owed again", async () => {
    await fresh();
    const a = await app({ plain: true });
    await switchedOn(() => suspend(a.label));
    await pass(a.room);
    const unpublish = () => one(a.room, "SELECT release_epoch, scripts_gone_at IS NOT NULL AS done FROM unpublish");
    const queue = async () => (await deleteRows(a.room)).map((row: any) => [row.script_name, row.unpublish_epoch, row.gone]);
    expect(await unpublish()).toEqual({ release_epoch: 5, done: 1 });
    expect(await queue()).toEqual([[a.kept, 5, 1], [a.served, 5, 1]].sort());
    // One of that unpublish's scripts is in the namespace after all. Its delete is held at the stand-in, so what the
    // room holds while it is owed can be read with no clock involved.
    await fake("/seed", { scripts: [a.kept] });
    const removal = await gate("script.delete");
    expect(await reconcile("scripts")).toMatchObject({ code: "ok", changed: 1 });
    await arrived(removal);
    // Owed again, still under the unpublish it came from, and that unpublish is no longer done with its files.
    expect(await queue()).toEqual([[a.kept, 5, 0], [a.served, 5, 1]].sort());
    expect(await unpublish()).toEqual({ release_epoch: 5, done: 0 });
    await release(removal);
    await alarmQuiet(stub(a.room));
    // Gone again, on the provider's own word, and only then is the unpublish done.
    const state = await held();
    expect([state.scripts, state.expiredGates]).toEqual([[], 0]);
    expect(await queue()).toEqual([[a.kept, 5, 1], [a.served, 5, 1]].sort());
    expect(await unpublish()).toEqual({ release_epoch: 5, done: 1 });
    // The one a pass found is told as a pass's deletion. The one the unpublish deleted by itself isn't.
    expect(await found()).toEqual([`script_delete_queued ${a.kept}`]);
    // And it is still told when the record of it is lost: the room knows it by when it was queued again.
    await inModeration((sql) => sql.exec("DELETE FROM takedown_finding"));
    await reconcile("entries");
    expect(await found()).toEqual([`script_delete_queued ${a.kept}`]);
    await alarmQuiet(stub(a.room));
  });

  it("gives the walk its own time, apart from the time for the list", async () => {
    await fresh();
    const a = await app({ plain: true });
    const b = await app({ plain: true });
    await fake("/reset", {});
    await fake("/seed", { scripts: [a.kept, a.served, b.kept, b.served], entries: { [a.host]: a.served, [b.host]: b.served } });
    const budget = (name: string | null) => inModeration((sql) => {
      sql.exec("CREATE TABLE IF NOT EXISTS test_reconcile_budget (name TEXT, ms INTEGER)");
      sql.exec("DELETE FROM test_reconcile_budget");
      if (name) sql.exec("INSERT INTO test_reconcile_budget (name, ms) VALUES (?, -1)", name);
    });
    const at = (which: string) => inModeration((sql) => sql.exec("SELECT cursor, skip FROM reconcile_pass WHERE pass = ?", which).toArray()[0] ?? null);
    // The list's time is already over when the pass starts, as after a provider that was slow: no key is begun, and
    // the same page is owed again. The walk still wakes both rooms, on its own time.
    await budget("pass");
    expect(await reconcile("entries")).toMatchObject({ code: "out_of_time", listed: 2, asked: 2, woken: 2 });
    expect(await at("entries")).toEqual({ cursor: null, skip: 0 });
    expect((await held()).calls.filter((call) => call.op === "entry.get")).toEqual([]);
    expect(await reconcile("scripts")).toMatchObject({ code: "out_of_time", listed: 4, asked: 2, woken: 2 });
    // The walk's time is over when it starts: it wakes nobody and stays where it was, and the list is read in full.
    await budget("wake");
    const before = await at("wake");
    expect(await reconcile("entries")).toMatchObject({ code: "ok", listed: 2, asked: 2, woken: 0 });
    expect(await at("wake")).toEqual(before);
    expect((await held()).calls.filter((call) => call.op === "entry.get").length).toBe(2);
    // With neither set short, both run.
    await budget(null);
    expect(await reconcile("entries")).toMatchObject({ code: "ok", asked: 4, woken: 2 });
    // The two bounds the build has, as the plan states them.
    const source = (JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>)["reconcile.rs"];
    expect([source.match(/const PASS_BUDGET_MS: i64 = ([0-9_]+);/)?.[1], source.match(/const WAKE_BUDGET_MS: i64 = ([0-9_]+);/)?.[1]]).toEqual(["20_000", "10_000"]);
    await inModeration((sql) => sql.exec("DROP TABLE IF EXISTS test_reconcile_budget"));
    for (const room of [a.room, b.room]) await alarmQuiet(stub(room));
  });
});
