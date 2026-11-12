import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet } from "./alarm";

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
type Held = { scripts: string[]; entries: Record<string, string>; calls: { op: string; name: string; status: number }[] };
const held = async () => (await (await fake("/state")).json()) as Held;
const fault = (body: object) => fake("/fault", body);

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
async function app(opts: { plain?: boolean; epoch?: number; index?: boolean } = {}): Promise<App> {
  const room: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Engineering" })).body.id;
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
  });
  // The applier's own record of the entry it last wrote, so a pass has nothing to do until the room changes its mind.
  await inRoom(room, (sql) => sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, ?, ?, 1, 1)", host, opts.plain ? 5 : 6, opts.plain ? served : flight));
  if (opts.index !== false) await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, room).run();
  // What the provider holds for it: the three scripts, and the entry the applier last wrote.
  await fake("/seed", { scripts: opts.plain ? [kept, served] : [kept, served, flight], entries: { [host]: opts.plain ? served : flight } });
  return { room, label, host, served, kept, flight, queued };
}

const suspend = (label: string, who: Who = OPERATOR, reason = "abuse") => api(who, "POST", `/v1/moderation/apps/${label}/suspend`, { reason });
const lift = (label: string, who: Who = OPERATOR, reason = "other") => api(who, "POST", `/v1/moderation/apps/${label}/lift`, { reason });
const serveRows = (room: string) => all(room, "SELECT host, kind, label, label_current, release_id, script_name, version, closed, flight_version, flight_before FROM serve_state ORDER BY host");
const configRow = (room: string) => one(room, "SELECT release_epoch, kept_previous, in_flight_release, in_flight_script, in_flight_epoch, in_flight_at FROM release_config");
const applyRows = (room: string) => all(room, "SELECT host, applied_version, applied_script, attempts, last_code FROM serve_apply ORDER BY host");
const deleteRows = (room: string) => all(room, "SELECT script_name, unpublish_epoch, attempts, last_code, gone_at IS NOT NULL AS gone FROM script_delete ORDER BY script_name");
/** Every wait is over: the next pass tries everything again. */
const due = (room: string) => inRoom(room, (sql) => { sql.exec("UPDATE serve_apply SET next_attempt_at = 0 WHERE next_attempt_at IS NOT NULL"); sql.exec("UPDATE script_delete SET next_attempt_at = 0 WHERE gone_at IS NULL"); });
const pass = (room: string) => alarmPass(stub(room));
const callsFor = (state: Held, app: App) => state.calls.filter((call) => call.name === app.host || call.name.startsWith(`${app.label}.`)).map((call) => `${call.op} ${call.name === app.host ? "host" : call.name.slice(app.label.length + 1, app.label.length + 7)} ${call.status}`);

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(OWNER) }, body: JSON.stringify({ org_id: AGENT.org, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register agent: ${res.status}`);
});

beforeEach(async () => { await fake("/reset", {}); });

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
      expect((await suspend(nowhere)).status).toBe(404);
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
    const answer = await switchedOn(() => suspend(a.label));
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ label: a.label, suspended: true, reason: "abuse", at: expect.any(Number) });
    // The state, as core's `unpublish` leaves it.
    expect(await configRow(a.room)).toEqual({ release_epoch: 5, kept_previous: null, in_flight_release: null, in_flight_script: null, in_flight_epoch: null, in_flight_at: null });
    expect(await serveRows(a.room)).toEqual([{ host: a.host, kind: "default", label: null, label_current: null, release_id: null, script_name: null, version: 7, closed: 0, flight_version: null, flight_before: null }]);
    expect(await all(a.room, "SELECT cause, label, release_epoch, scripts_gone_at FROM unpublish")).toEqual([{ cause: "app_suspended", label: a.label, release_epoch: 5, scripts_gone_at: null }]);
    expect(await one(a.room, "SELECT suspended_at IS NOT NULL AS suspended, suspension_reason FROM app_label")).toEqual({ suspended: 1, suspension_reason: "abuse" });
    // The releases that were up are unpublished. The one still queued is left to the job that owns it: the epoch it
    // started under is gone, so it can never go live.
    expect(await all(a.room, "SELECT id, state, release_epoch FROM release ORDER BY id")).toEqual([
      { id: rel(1), state: "replaced", release_epoch: 4 }, { id: rel(2), state: "unpublished", release_epoch: 4 }, { id: rel(3), state: "unpublished", release_epoch: 4 }, { id: rel(4), state: "queued", release_epoch: 4 },
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
      // A custom hostname, a host two labels deep, the bare domain, another domain, and a label that isn't one:
      // none is an app's default host. A custom hostname's suspension is the next PR's.
      for (const host of ["app.example.org", `deep.${a.host}`, FAKE.domain, `${a.label}.other.example`, `UPPER.${FAKE.domain}`, `${a.label}.${FAKE.domain}.`]) {
        expect((await api(OPERATOR, "POST", `/v1/moderation/app-hosts/${host}/suspend`, { reason: "abuse" })).code, host).toBe("release_not_available");
      }
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
    const a = await app({ plain: true });
    await switchedOn(() => suspend(a.label));
    // Both deletes fail outright, and the scripts are still there: a read that finds one is not "gone".
    await fault({ op: "script.delete", times: 2, status: 500 });
    await pass(a.room);
    expect((await deleteRows(a.room)).map((row: any) => [row.gone, row.attempts, row.last_code])).toEqual([[0, 1, "read_200"], [0, 1, "read_200"]]);
    expect((await held()).scripts).toEqual([a.kept, a.served].sort());
    // It waits before it tries again: a pass straight after asks the provider nothing.
    const quiet = (await held()).calls.length;
    await pass(a.room);
    expect((await held()).calls.length).toBe(quiet);
    expect((await all(a.room, "SELECT next_attempt_at FROM script_delete")).every((row: any) => row.next_attempt_at >= Date.now() + 3000)).toBe(true);
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
    const a = await app({ plain: true });
    await switchedOn(() => suspend(a.label));
    // The entry's removal fails: it is still there, so no script is touched.
    await fault({ op: "entry.delete", times: 1, status: 500 });
    await pass(a.room);
    let state = await held();
    expect(callsFor(state, a)).toEqual(["entry.delete host 500", "entry.get host 200"]);
    expect([state.entries[a.host], state.scripts]).toEqual([a.served, [a.kept, a.served].sort()]);
    expect(await applyRows(a.room)).toEqual([{ host: a.host, applied_version: 5, applied_script: a.served, attempts: 1, last_code: "delete_not_confirmed" }]);
    expect((await deleteRows(a.room)).map((row: any) => row.last_code)).toEqual(["entry_not_removed_yet", "entry_not_removed_yet"]);
    // The removal goes through, but the read-back still shows the entry, as a cache that lags would: not applied yet.
    await due(a.room);
    await fault({ op: "entry.get", times: 1, stale: true });
    await pass(a.room);
    state = await held();
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 5, attempts: 2, last_code: "read_back_differs" });
    expect(state.scripts).toEqual([a.kept, a.served].sort());
    // A read-back that answers 404 without the code for a missing key, as a wrong namespace would, isn't "absent".
    await due(a.room);
    await fault({ op: "entry.get", times: 1, status: 404 });
    await pass(a.room);
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 5, attempts: 3, last_code: "read_back_differs" });
    expect((await held()).scripts).toEqual([a.kept, a.served].sort());
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
    expect((await deleteRows(a.room)).map((row: any) => [row.gone, row.last_code])).toEqual([[0, "entry_not_removed_yet"], [0, "entry_not_removed_yet"], [0, "entry_not_removed_yet"]]);
    await alarmQuiet(stub(a.room));
  });

  it("start over when the room changes its mind while the provider is being asked", async () => {
    const a = await app({ plain: true });
    await switchedOn(() => suspend(a.label));
    await alarmQuiet(stub(a.room));
    await fake("/reset", {});
    await fake("/seed", { scripts: [a.kept, a.served], entries: { [a.host]: a.served } });
    await inRoom(a.room, (sql) => sql.exec("DELETE FROM serve_apply"));
    // While the first removal is out, the host's version moves, as a second change in the room would move it.
    await fault({ op: "entry.delete", times: 1, delayMs: 400 });
    const running = pass(a.room);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await inRoom(a.room, (sql) => sql.exec("UPDATE serve_state SET version = version + 1"));
    await running;
    // It didn't record the version it started with: it went round again and recorded the one the room holds now.
    const state = await held();
    expect(callsFor(state, a).filter((call) => call.startsWith("entry."))).toEqual(["entry.delete host 200", "entry.get host 404", "entry.delete host 200", "entry.get host 404"]);
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 7, attempts: 0 });
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
    await inRoom(a.room, (sql) => sql.exec("UPDATE serve_state SET version = version + 1 WHERE kind = 'default'"));
    await fault({ op: "entry.get", times: 1, stale: true });
    await pass(a.room);
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 5, attempts: 1, last_code: "read_back_differs" });
    await due(a.room);
    await pass(a.room);
    expect((await applyRows(a.room))[0]).toMatchObject({ applied_version: 6, attempts: 0, last_code: null });
    // A custom hostname that wants a script is left alone: its claim can't be asked yet, so nothing is written for it.
    await inRoom(a.room, (sql) => sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES ('app.example.org', 'custom', ?, 1, ?, ?, 1, 1)", a.label, rel(2), a.served));
    await pass(a.room);
    state = await held();
    expect(state.entries["app.example.org"]).toBeUndefined();
    expect(state.calls.filter((call) => call.name === "app.example.org")).toEqual([]);
    expect((await applyRows(a.room)).find((row: any) => row.host === "app.example.org")).toMatchObject({ applied_version: null, last_code: "claim_check_not_built" });
    // A state that names a script while the app is suspended is a fault no command makes. Even so, nothing is written.
    await inRoom(a.room, (sql) => { sql.exec("UPDATE app_label SET suspended_at = 1, suspension_reason = 'abuse'"); sql.exec("UPDATE serve_state SET version = version + 1 WHERE kind = 'default'"); });
    const before = (await held()).calls.length;
    await pass(a.room);
    expect((await held()).calls.length).toBe(before);
    expect((await applyRows(a.room)).find((row: any) => row.host === a.host)).toMatchObject({ applied_version: 6, last_code: "app_suspended" });
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
      // And the forms that are right are taken.
      refuses(() => sql.exec("INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES (?, ?, 1, 9e15)", `${a.label}.${rel(9)}`, a.label)),
      refuses(() => sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", a.host, a.served)),
    ])).toEqual([true, true, true, true, true, true, true, false, false]);
    await alarmQuiet(stub(a.room));
  });

  it("binds no provider, no token and no schedule in any environment", () => {
    const names = [...new Set([...(BINDINGS.TEST_CONTENT_PROVIDER_SOURCE as string).matchAll(/const [A-Z_]+: &str = "(CONTENT_[A-Z_]+)";/g)].map((match) => match[1]))].sort();
    expect(names).toEqual(["CONTENT_ACCOUNT_ID", "CONTENT_DISPATCH_NAMESPACE", "CONTENT_DOMAIN", "CONTENT_KV_NAMESPACE_ID", "CONTENT_ROUTING_TOKEN", "CONTENT_SCRIPTS_TOKEN"]);
    const wrangler: string = BINDINGS.TEST_WRANGLER;
    // Not as a variable, not in a comment, not under another spelling: the file doesn't hold the word.
    expect(wrangler).not.toMatch(/CONTENT_/);
    for (const name of ["triggers", "crons", "dispatch_namespaces", "kv_namespaces"]) expect(wrangler, name).not.toContain(`"${name}"`);
    // The one test-only switch this step adds is compiled out of a deployment: every mention of its table sits under
    // the failpoints attribute, and the deploy's build command names no feature.
    const source: string = BINDINGS.TEST_TAKEDOWN_SOURCE;
    const mentions = [...source.matchAll(/test_content_provider_off/g)];
    expect(mentions.length).toBeGreaterThan(0);
    const guarded = source.match(/#\[cfg\(feature = "failpoints"\)\]\n\s*if rows\(\n\s*sql,\n\s*"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_content_provider_off'"/g) ?? [];
    const inDocs = source.split("\n").filter((line) => line.includes("test_content_provider_off") && line.trim().startsWith("///")).length;
    expect(guarded.length + inDocs).toBe(mentions.length);
    expect(guarded.length).toBe(1);
    expect(JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, "")).build.command).toBe("worker-build --release");
    // The test Worker's values are the stand-in's, and no real account, namespace or token has their form's values.
    expect([FAKE.account, FAKE.kvNamespace]).toEqual(["c0".repeat(16), "d1".repeat(16)]);
    expect([FAKE.scriptsToken, FAKE.routingToken].every((token) => token.startsWith("test-"))).toBe(true);
  });
});
