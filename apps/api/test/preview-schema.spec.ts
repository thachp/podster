import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm.ts";

// The schema previews need (M8 step 5; docs/m8-preview-plan.md, 9.4; decisions 250 to 259): the room's steps 59 to 64
// and D1's `0010_app_label_kind.sql`. Nothing reads or writes these yet (M8 step 6 and after), so this holds only that
// each step reaches a room made before it, runs again safely, leaves every existing release and custom hostname
// production's, and keeps the checks its rows need.

const BINDINGS = env as any;
let key: any;
const ORG = "org_ps_room";
const OWNER = { id: "per_PsOwner", org: ORG };

async function assertion() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: ORG, orgs: [ORG], admin_orgs: [ORG], org_since: { [ORG]: 1 } })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(OWNER.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `ps-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  return res.status;
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const schemaVersion = (id: string) => inRoom(id, (sql) => sql.exec("SELECT version FROM schema_version").one().version as number);
const refuses = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };

const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(stub(id));
});

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

async function room() {
  const made = await SELF.fetch("https://api.internal/v1/workspaces", {
    method: "POST",
    headers: { "x-podster-assertion": await assertion(), "content-type": "application/json", "idempotency-key": `ps-key-${++counter}` },
    body: JSON.stringify({ name: "Preview schema" }),
  });
  const id: string = ((await made.json()) as any).id;
  madeRooms.push(id);
  await manualAlarms(stub(id));
  return id;
}

const LABEL = "pslabel";
const PREVIEW_LABEL = "pspreview";
const SHA = "a".repeat(40);
const REL = (n: number) => `rel_${String(n).padStart(32, "0")}`;
const SLOT = (n: number) => `pvw_${String(n).padStart(32, "0")}`;
const SESSION = (n: number) => `pvs_${String(n).padStart(32, "0")}`;
const BUILD = `bld_${"b".repeat(32)}`;
const TABLES = ["release_environment", "preview_slot", "release_build", "release_from_preview", "preview_session", "preview_access_ask", "custom_hostname_role"];

/** A production label with two releases, and an open custom hostname request, as a room before previews holds them. */
function seed(sql: any) {
  sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", LABEL);
  for (const n of [1, 2]) {
    sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, requested_by, requested_at, updated_at)
         VALUES (?, ?, 'awaiting_approval', ?, 1, 0, ?, 1, 1)`,
      REL(n), SHA, LABEL, OWNER.id);
  }
  sql.exec(
    `INSERT INTO hostname_request (id, hostname, state, open, challenge, generation, requested_by, requested_at, expires_at, updated_at)
       VALUES ('hnr_ps_1', 'app.example.com', 'pending', 1, ?, 0, ?, 1, 2, 1)`,
    "c".repeat(64), OWNER.id);
}

describe("room schema steps 59 to 64 (M8 step 5)", () => {
  it("reach a room made before them, write no row, and run again safely over rows they hold", async () => {
    const id = await room();
    const latest = await schemaVersion(id);
    await inRoom(id, (sql) => {
      seed(sql);
      for (const table of TABLES) sql.exec(`DROP TABLE ${table}`);
      sql.exec("UPDATE schema_version SET version = version - 6");
    });
    expect(await api("GET", `/v1/workspaces/${id}`)).toBe(200);
    expect(await schemaVersion(id)).toBe(latest);
    // Every table is there and empty: no release becomes a preview, and no custom hostname a preview's.
    expect(await inRoom(id, (sql) => TABLES.map((t) => sql.exec(`SELECT count(*) AS n FROM ${t}`).one().n))).toEqual(TABLES.map(() => 0));
    // A row in each, then the steps again: every row is kept whole.
    const rows = await inRoom(id, (sql) => {
      sql.exec("INSERT INTO release_environment (release_id, environment) VALUES (?, 'preview')", REL(1));
      sql.exec("INSERT INTO preview_slot (id, label, current, access_epoch, default_release_id, default_version, created_at, updated_at) VALUES (?, ?, 1, 3, ?, 1, 1, 1)", SLOT(1), PREVIEW_LABEL, REL(1));
      sql.exec("INSERT INTO release_build (release_id, build_id, tree_sha, form_version) VALUES (?, ?, ?, 'form/1')", REL(1), BUILD, "d".repeat(40));
      sql.exec("INSERT INTO release_from_preview (release_id, preview_release_id, build_id) VALUES (?, ?, ?)", REL(2), REL(1), BUILD);
      sql.exec("INSERT INTO preview_session (sid, person_id, created_at, expires_at) VALUES (?, ?, 1000, 3601000)", SESSION(1), OWNER.id);
      sql.exec("INSERT INTO preview_access_ask (at) VALUES (5)");
      sql.exec("INSERT INTO custom_hostname_role (request_id, role) VALUES ('hnr_ps_1', 'preview')");
      return TABLES.map((t) => sql.exec(`SELECT * FROM ${t}`).toArray());
    });
    await inRoom(id, (sql) => sql.exec("UPDATE schema_version SET version = version - 6"));
    expect(await api("GET", `/v1/workspaces/${id}`)).toBe(200);
    expect(await schemaVersion(id)).toBe(latest);
    expect(await inRoom(id, (sql) => TABLES.map((t) => sql.exec(`SELECT * FROM ${t}`).toArray()))).toEqual(rows);
  });

  it("keeps a release's environment and a custom hostname's role to their two names, exactly", async () => {
    const id = await room();
    const refused = await inRoom(id, (sql) => {
      seed(sql);
      return [
        refuses(() => sql.exec("INSERT INTO release_environment (release_id, environment) VALUES (?, 'staging')", REL(1))),
        refuses(() => sql.exec("INSERT INTO release_environment (release_id, environment) VALUES (?, 'Preview')", REL(1))),
        refuses(() => sql.exec("INSERT INTO custom_hostname_role (request_id, role) VALUES ('hnr_ps_1', 'PREVIEW')")),
        refuses(() => sql.exec("INSERT INTO custom_hostname_role (request_id, role) VALUES ('hnr_ps_1', 'both')")),
      ];
    });
    expect(refused).toEqual([true, true, true, true]);
  });

  it("holds at most one current preview slot, keeps a deleted one's label, and bounds its access epoch", async () => {
    const id = await room();
    const result = await inRoom(id, (sql) => {
      seed(sql);
      const slot = (n: number, label: string, extra = "", values: unknown[] = []) =>
        sql.exec(`INSERT INTO preview_slot (id, label, current, created_at, updated_at${extra ? `, ${extra}` : ""}) VALUES (?, ?, 1, 1, 1${values.map(() => ", ?").join("")})`, SLOT(n), label, ...values);
      slot(1, PREVIEW_LABEL);
      const second = refuses(() => slot(2, "other"));
      // Deleted: current cleared and deleted_at set, together; its label stays taken.
      const halfDeleted = refuses(() => sql.exec("UPDATE preview_slot SET current = NULL WHERE id = ?", SLOT(1)));
      sql.exec("UPDATE preview_slot SET current = NULL, deleted_at = 2 WHERE id = ?", SLOT(1));
      const labelAgain = refuses(() => slot(2, PREVIEW_LABEL));
      slot(2, "other");
      const fresh = sql.exec("SELECT access_epoch, serve_epoch, default_version, default_release_id, custom_host FROM preview_slot WHERE id = ?", SLOT(2)).one();
      return {
        second, halfDeleted, labelAgain, fresh,
        epochTop: refuses(() => sql.exec("UPDATE preview_slot SET access_epoch = 999999999999999 WHERE id = ?", SLOT(2))),
        epochPast: refuses(() => sql.exec("UPDATE preview_slot SET access_epoch = 1000000000000000 WHERE id = ?", SLOT(2))),
        badId: refuses(() => sql.exec("INSERT INTO preview_slot (id, label, created_at, deleted_at, updated_at) VALUES ('pvw_XYZ', 'x', 1, 1, 1)")),
        badLabel: refuses(() => sql.exec("INSERT INTO preview_slot (id, label, created_at, deleted_at, updated_at) VALUES (?, 'Bad-Label', 1, 1, 1)", SLOT(3))),
      };
    });
    expect(result).toEqual({
      second: true, halfDeleted: true, labelAgain: true,
      fresh: { access_epoch: 0, serve_epoch: 0, default_version: 0, default_release_id: null, custom_host: null },
      epochTop: false, epochPast: true, badId: true, badLabel: true,
    });
  });

  it("keeps a preview slot's custom host and flight whole", async () => {
    const id = await room();
    const refused = await inRoom(id, (sql) => {
      seed(sql);
      sql.exec("INSERT INTO preview_slot (id, label, current, created_at, updated_at) VALUES (?, ?, 1, 1, 1)", SLOT(1), PREVIEW_LABEL);
      const set = (assignments: string, ...values: unknown[]) => refuses(() => sql.exec(`UPDATE preview_slot SET ${assignments} WHERE id = ?`, ...values, SLOT(1)));
      return {
        hostWithoutVersion: set("custom_host = 'preview.example.com'"),
        releaseWithoutHost: set("custom_release_id = ?", REL(1)),
        closedServing: set("custom_host = 'preview.example.com', custom_version = 0, custom_closed = 1, custom_release_id = ?", REL(1)),
        hostClosed: set("custom_host = 'preview.example.com', custom_version = 0, custom_closed = 1"),
        badHost: set("custom_host = 'Preview.Example.com', custom_version = 0, custom_closed = 0"),
        halfFlight: set("in_flight_release = ?, in_flight_epoch = 0", REL(1)),
        flightMarkAlone: set("default_flight_version = 1"),
        flight: set("in_flight_release = ?, in_flight_epoch = 0, in_flight_at = 1, default_flight_version = 1, default_flight_before = ?", REL(2), REL(1)),
        unknownRelease: set("default_release_id = ?", REL(9)),
      };
    });
    expect(refused).toEqual({
      hostWithoutVersion: true, releaseWithoutHost: true, closedServing: true, hostClosed: false, badHost: true,
      halfFlight: true, flightMarkAlone: true, flight: false, unknownRelease: true,
    });
  });

  it("keeps builds, publishes from a preview and sessions to their forms", async () => {
    const id = await room();
    const refused = await inRoom(id, (sql) => {
      seed(sql);
      return {
        shortBuild: refuses(() => sql.exec("INSERT INTO release_build (release_id, build_id, tree_sha, form_version) VALUES (?, 'bld_abc', ?, 'f')", REL(1), "d".repeat(40))),
        upperBuild: refuses(() => sql.exec("INSERT INTO release_build (release_id, build_id, tree_sha, form_version) VALUES (?, ?, ?, 'f')", REL(1), `bld_${"B".repeat(32)}`, "d".repeat(40))),
        badTree: refuses(() => sql.exec("INSERT INTO release_build (release_id, build_id, tree_sha, form_version) VALUES (?, ?, 'tree', 'f')", REL(1), BUILD)),
        noForm: refuses(() => sql.exec("INSERT INTO release_build (release_id, build_id, tree_sha, form_version) VALUES (?, ?, ?, '')", REL(1), BUILD, "d".repeat(40))),
        fromItself: refuses(() => sql.exec("INSERT INTO release_from_preview (release_id, preview_release_id, build_id) VALUES (?, ?, ?)", REL(1), REL(1), BUILD)),
        fromNothing: refuses(() => sql.exec("INSERT INTO release_from_preview (release_id, preview_release_id, build_id) VALUES (?, ?, ?)", REL(2), REL(9), BUILD)),
        overAnHour: refuses(() => sql.exec("INSERT INTO preview_session (sid, person_id, created_at, expires_at) VALUES (?, ?, 1000, 3601001)", SESSION(1), OWNER.id)),
        expiredAtBirth: refuses(() => sql.exec("INSERT INTO preview_session (sid, person_id, created_at, expires_at) VALUES (?, ?, 1000, 1000)", SESSION(1), OWNER.id)),
        badSid: refuses(() => sql.exec("INSERT INTO preview_session (sid, person_id, created_at, expires_at) VALUES ('pvs_1', ?, 1000, 2000)", OWNER.id)),
        noPerson: refuses(() => sql.exec("INSERT INTO preview_session (sid, person_id, created_at, expires_at) VALUES (?, '', 1000, 2000)", SESSION(1))),
        textAsk: refuses(() => sql.exec("INSERT INTO preview_access_ask (at) VALUES ('soon')")),
      };
    });
    expect(Object.values(refused).every(Boolean), JSON.stringify(refused)).toBe(true);
  });
});

describe("room schema step 64: a preview label is a row of app_label (M8 step 5)", () => {
  const OLD_LABEL = "psold";
  const labels = (sql: any) => sql.exec("SELECT label, kind, current, created_at, retired_at, indexed_at, suspended_at, suspension_reason FROM app_label ORDER BY label").toArray();
  /** Every row that names a label, so a rebuild that dropped or changed one shows. */
  const naming = (sql: any) => [
    sql.exec("SELECT id, label FROM release ORDER BY id").toArray(),
    sql.exec("SELECT host, label, label_current FROM serve_state ORDER BY host").toArray(),
    sql.exec("SELECT script_name, label FROM script_delete ORDER BY script_name").toArray(),
  ];

  it("reaches a room made before it, keeping every label and every row that names one, all production's", async () => {
    const id = await room();
    const latest = await schemaVersion(id);
    const before = await inRoom(id, (sql) => {
      seed(sql);
      // A retired label too, with a script owed its deletion and a suspension.
      sql.exec("INSERT INTO app_label (label, current, created_at, retired_at, indexed_at, suspended_at, suspension_reason) VALUES (?, NULL, 1, 2, 3, 4, 'abuse')", OLD_LABEL);
      sql.exec("INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES (?, ?, 1, 1)", `${OLD_LABEL}.${REL(7)}`, OLD_LABEL);
      sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES ('d.example', 'default', ?, 1, ?, ?, 1, 1)", LABEL, REL(1), `${LABEL}.${REL(1)}`);
      // The table as it was before the step, rebuilt by hand.
      sql.exec("PRAGMA defer_foreign_keys = ON");
      sql.exec("CREATE TABLE app_label_was AS SELECT label, current, created_at, retired_at, indexed_at, suspended_at, suspension_reason FROM app_label");
      sql.exec("DROP TABLE app_label");
      sql.exec(`CREATE TABLE app_label (label TEXT PRIMARY KEY CHECK (length(label) BETWEEN 1 AND 26 AND label NOT GLOB '*[^a-z0-9]*'), current INTEGER UNIQUE CHECK (current = 1),
        created_at INTEGER NOT NULL, retired_at INTEGER, indexed_at INTEGER, suspended_at INTEGER, suspension_reason TEXT,
        CHECK ((current IS NULL) = (retired_at IS NOT NULL)), CHECK ((suspended_at IS NULL) = (suspension_reason IS NULL)), UNIQUE (label, current)) WITHOUT ROWID`);
      sql.exec("INSERT INTO app_label SELECT * FROM app_label_was");
      sql.exec("DROP TABLE app_label_was");
      sql.exec("UPDATE schema_version SET version = version - 1");
      return naming(sql);
    });
    expect(await api("GET", `/v1/workspaces/${id}`)).toBe(200);
    expect(await schemaVersion(id)).toBe(latest);
    expect(await inRoom(id, labels)).toEqual([
      { label: LABEL, kind: "production", current: 1, created_at: 1, retired_at: null, indexed_at: null, suspended_at: null, suspension_reason: null },
      { label: OLD_LABEL, kind: "production", current: null, created_at: 1, retired_at: 2, indexed_at: 3, suspended_at: 4, suspension_reason: "abuse" },
    ]);
    expect(await inRoom(id, naming)).toEqual(before);
  });

  it("holds a live preview label beside the current production one, and a release under it, and runs again safely", async () => {
    const id = await room();
    const latest = await schemaVersion(id);
    const result = await inRoom(id, (sql) => {
      seed(sql);
      sql.exec("INSERT INTO preview_slot (id, label, current, created_at, updated_at) VALUES (?, ?, 1, 1, 1)", SLOT(1), PREVIEW_LABEL);
      sql.exec("INSERT INTO app_label (label, kind, created_at) VALUES (?, 'preview', 1)", PREVIEW_LABEL);
      sql.exec(
        `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, requested_by, requested_at, updated_at)
           VALUES (?, ?, 'awaiting_approval', ?, 1, 0, ?, 1, 1)`,
        REL(3), SHA, PREVIEW_LABEL, OWNER.id);
      sql.exec("INSERT INTO release_environment (release_id, environment) VALUES (?, 'preview')", REL(3));
      return {
        // `current = 1` is still production's alone.
        current: sql.exec("SELECT label FROM app_label WHERE current = 1").toArray(),
        previewCurrent: refuses(() => sql.exec("INSERT INTO app_label (label, kind, current, created_at) VALUES ('psother', 'preview', 1, 1)")),
        productionLive: refuses(() => sql.exec("INSERT INTO app_label (label, kind, created_at) VALUES ('psother', 'production', 1)")),
        badKind: refuses(() => sql.exec("INSERT INTO app_label (label, kind, created_at, retired_at) VALUES ('psother', 'staging', 1, 1)")),
        reused: refuses(() => sql.exec("INSERT INTO app_label (label, kind, created_at, retired_at) VALUES (?, 'production', 1, 1)", PREVIEW_LABEL)),
        retired: refuses(() => sql.exec("UPDATE app_label SET retired_at = 2 WHERE label = ?", PREVIEW_LABEL)),
      };
    });
    expect(result).toEqual({ current: [{ label: LABEL }], previewCurrent: true, productionLive: true, badKind: true, reused: true, retired: false });
    const rows = await inRoom(id, (sql) => [labels(sql), naming(sql)]);
    await inRoom(id, (sql) => sql.exec("UPDATE schema_version SET version = version - 1"));
    expect(await api("GET", `/v1/workspaces/${id}`)).toBe(200);
    expect(await schemaVersion(id)).toBe(latest);
    expect(await inRoom(id, (sql) => [labels(sql), naming(sql)])).toEqual(rows);
  });

  it("refuses the whole migration, and leaves the room as it was, if a row names a label the rebuild wouldn't keep", async () => {
    const id = await room();
    const latest = await schemaVersion(id);
    await inRoom(id, (sql) => {
      seed(sql);
      // A label recorded as a preview slot's while also the current production label can't be rebuilt as either.
      sql.exec("INSERT INTO preview_slot (id, label, created_at, deleted_at, updated_at) VALUES (?, ?, 1, 1, 1)", SLOT(1), LABEL);
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    expect(await api("GET", `/v1/workspaces/${id}`)).not.toBe(200);
    expect(await inRoom(id, (sql) => [sql.exec("SELECT version FROM schema_version").one().version, sql.exec("SELECT label FROM app_label").toArray(), sql.exec("SELECT count(*) AS n FROM release").one().n]))
      .toEqual([latest - 1, [{ label: LABEL }], 2]);
    // Without the stray row the step runs.
    await inRoom(id, (sql) => sql.exec("DELETE FROM preview_slot"));
    expect(await api("GET", `/v1/workspaces/${id}`)).toBe(200);
    expect(await schemaVersion(id)).toBe(latest);
  });
});

describe("D1 0010_app_label_kind.sql (M8 step 5)", () => {
  it("records a label's kind beside the index, with no row for a label indexed before it, and only two kinds", async () => {
    await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES ('pskindold', 'ws_ps', 1)").run();
    expect((await BINDINGS.DB.prepare("SELECT kind FROM app_label_kind WHERE label = 'pskindold'").all()).results).toEqual([]);
    await BINDINGS.DB.prepare("INSERT INTO app_label_kind (label, kind) VALUES ('pskindnew', 'preview')").run();
    expect((await BINDINGS.DB.prepare("SELECT kind FROM app_label_kind WHERE label = 'pskindnew'").all()).results).toEqual([{ kind: "preview" }]);
    for (const [label, kind] of [["pskindx", "staging"], ["pskindy", "Preview"], ["Bad-Label", "preview"]]) {
      await expect(BINDINGS.DB.prepare("INSERT INTO app_label_kind (label, kind) VALUES (?, ?)").bind(label, kind).run()).rejects.toThrow();
    }
  });
});

