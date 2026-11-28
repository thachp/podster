import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm";
import { appStoreDeleteCases } from "./app-store-delete.cases";
import { appCodeUploadCases, appStoreMakeCases } from "./app-store-make.cases";

// M6 stage 1, the first PR of the store plan: the room's record of its app's store, and the client that makes, reads,
// deletes and lists stores with its own D1 credential. The client is reached here through the test-only route
// `/test/app-store`, against D1's stand-in (`fake-stores.ts`), and the record is written here by hand, to show what the
// room's table holds and refuses. *Since S2 (2026-11-17):* the release job makes a store, and its cases run here too,
// in this file, since this file owns the stand-in and resets it (`app-store-make.cases.ts`).

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { account: string; scriptsToken: string; routingToken: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let key: any;

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

const fake = (path: string, body?: unknown) =>
  fetch(`https://stores-fake.example.com${path}`, { method: "POST", body: JSON.stringify(body ?? {}) }).then((res) => res.json() as Promise<any>);
const fault = (op: string, kind: string, times = 1) => fake("/fault", { op, kind, times });
const state = () => fake("/state") as Promise<{ databases: { uuid: string; name: string }[]; calls: { op: string; token: string; key: string }[] }>;
async function client(body: Record<string, unknown>) {
  const res = await SELF.fetch("https://api.internal/test/app-store", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}
const randomHex = () => crypto.randomUUID().replace(/-/g, "");
const storeName = () => `podster-store-${randomHex()}`;

describe("the store client", () => {
  beforeEach(() => fake("/reset"));

  it("makes, reads, lists and deletes a store, each with the store token alone", async () => {
    const name = storeName();
    const made = await client({ op: "create", name });
    expect(made.id).toMatch(UUID);
    expect((await state()).databases).toEqual([{ uuid: made.id, name }]);
    expect(await client({ op: "read", id: made.id, name })).toEqual({ read: "present" });
    expect(await client({ op: "list" })).toEqual({ list: [[made.id, name]] });
    expect(await client({ op: "delete", id: made.id })).toEqual({ sent: true });
    expect(await client({ op: "read", id: made.id, name })).toEqual({ read: "gone" });
    expect(await client({ op: "list" })).toEqual({ list: [] });
    const { calls } = await state();
    expect(calls.map((c) => [c.op, c.token])).toEqual([["create", "store"], ["read", "store"], ["list", "store"], ["delete", "store"], ["read", "store"], ["list", "store"]]);
    // A name or an ID goes nowhere unless it is of its form: nothing is sent.
    await fake("/reset");
    expect(await client({ op: "create", name: "podster-store-NOT" })).toEqual({ id: null });
    expect(await client({ op: "create", name: "my-database" })).toEqual({ id: null });
    expect(await client({ op: "read", id: made.id.toUpperCase(), name })).toEqual({ read: "unknown" });
    expect(await client({ op: "read", id: made.id, name: "my-database" })).toEqual({ read: "unknown" });
    expect(await client({ op: "read", id: "../../workers/scripts", name })).toEqual({ read: "unknown" });
    expect(await client({ op: "delete", id: made.id.toUpperCase() })).toEqual({ sent: true });
    expect(await client({ op: "delete", id: `${made.id}x` })).toEqual({ sent: true });
    // A path out of D1's would land outside the stand-in's view, so these show the guard only with the two above.
    expect(await client({ op: "delete", id: "../../storage/kv/namespaces/x" })).toEqual({ sent: true });
    expect((await state()).calls).toEqual([]);
  });

  it("counts a create only when D1 said it made exactly this one, and a later list settles the rest", async () => {
    for (const kind of ["lost", "created201", "noSuccess", "successText", "otherName", "upperId", "notJson", "huge", "redirect"]) {
      await fake("/reset");
      const name = storeName();
      await fault("create", kind);
      expect(await client({ op: "create", name }), kind).toEqual({ id: null });
      // What happened is told by the list, by the name the room chose: made by every fault but the redirect.
      const list = (await client({ op: "list" })).list as [string, string][];
      expect(list.filter(([, named]) => named === name).length, kind).toBe(kind === "redirect" ? 0 : 1);
    }
    // The control: the same call with no fault counts.
    await fake("/reset");
    expect((await client({ op: "create", name: storeName() })).id).toMatch(UUID);
    // A second create of a name D1 holds is refused, and isn't counted.
    const name = storeName();
    expect((await client({ op: "create", name })).id).toMatch(UUID);
    expect(await client({ op: "create", name })).toEqual({ id: null });
  });

  it("reads a store present only by its ID and name, and gone only on D1's own not-found", async () => {
    const name = storeName();
    const { id } = await client({ op: "create", name });
    expect(await client({ op: "read", id, name })).toEqual({ read: "present" });
    for (const kind of ["lost", "created201", "noSuccess", "successText", "otherName", "upperId", "otherId", "notJson", "huge", "redirect"]) {
      await fault("read", kind);
      expect(await client({ op: "read", id, name }), kind).toEqual({ read: "unknown" });
    }
    // Recorded under another name: not this store.
    expect(await client({ op: "read", id, name: storeName() })).toEqual({ read: "unknown" });
    await client({ op: "delete", id });
    expect(await client({ op: "read", id, name })).toEqual({ read: "gone" });
    for (const kind of ["notFoundOtherCode", "notFoundTwoCodes", "notFoundSuccessMissing", "codeText", "lost"]) {
      await fault("read", kind);
      expect(await client({ op: "read", id, name }), kind).toEqual({ read: "unknown" });
    }
    expect(await client({ op: "read", id, name })).toEqual({ read: "gone" });
  });

  it("never trusts a delete's answer: only a read says gone", async () => {
    const name = storeName();
    const { id } = await client({ op: "create", name });
    await fault("delete", "lost");
    expect(await client({ op: "delete", id })).toEqual({ sent: true });
    expect(await client({ op: "read", id, name })).toEqual({ read: "gone" });
    // A second delete of a gone store sends, and changes nothing.
    expect(await client({ op: "delete", id })).toEqual({ sent: true });
    expect((await state()).calls.filter((c) => c.op === "delete").map((c) => c.key)).toEqual([id, id]);
  });

  it("reads every page of the list, and a list of any other shape is no list", async () => {
    await fake("/seed", { count: 150, prefix: "someone-else-" });
    const name = storeName();
    const { id } = await client({ op: "create", name });
    const whole = (await client({ op: "list" })).list as [string, string][];
    expect(whole).toHaveLength(151);
    expect(whole.at(-1)).toEqual([id, name]);
    expect((await state()).calls.filter((c) => c.op === "list").length).toBe(2);
    for (const kind of ["noInfo", "badEntry", "shortPage", "lost", "huge"]) {
      await fault("list", kind);
      expect(await client({ op: "list" }), kind).toEqual({ list: null });
    }
    // On the second page only: the total moved under it.
    await fault("list", "totalDrift", 2);
    expect(await client({ op: "list" })).toEqual({ list: null });
    await fake("/reset");
    await fault("list", "otherName");
    // A fault the list doesn't know is no fault: the control reads whole.
    expect(await client({ op: "list" })).toEqual({ list: [] });
    // Longer than the bound, 20 pages of 100: no list.
    await fake("/seed", { count: 2001, prefix: "many-" });
    expect(await client({ op: "list" })).toEqual({ list: null });
    await fake("/reset");
    await fake("/seed", { count: 2000, prefix: "many-" });
    expect(((await client({ op: "list" })).list as unknown[]).length).toBe(2000);
  });

  it("is configured only with a well-formed store token of its own, on the content provider's account", async () => {
    expect(await client({ op: "list" })).toEqual({ list: [] });
    // The store token is never the scripts token or the routing token.
    expect(await client({ op: "list", token_from: "CONTENT_SCRIPTS_TOKEN" })).toEqual({ configured: false });
    expect(await client({ op: "list", token_from: "CONTENT_ROUTING_TOKEN" })).toEqual({ configured: false });
    expect(await client({ op: "list", scripts_from: "CONTENT_STORE_TOKEN" })).toEqual({ configured: false });
    expect(await client({ op: "list", routing_from: "CONTENT_STORE_TOKEN" })).toEqual({ configured: false });
    // Another token that can't be read can't be told apart from this one.
    expect(await client({ op: "list", scripts_from: "TEST_SETTING_NUMBER" })).toEqual({ configured: false });
    expect(await client({ op: "list", routing_from: "TEST_SETTING_NULL" })).toEqual({ configured: false });
    // Another token not bound at all is no conflict.
    expect(await client({ op: "list", scripts_from: "TEST_STORE_UNBOUND", routing_from: "TEST_STORE_UNBOUND" })).toEqual({ list: [] });
    // The token: bound, as text, of its form.
    for (const name of ["TEST_STORE_UNBOUND", "TEST_SETTING_NUMBER", "TEST_SETTING_NULL", "TEST_SETTING_TEXT_TRUE"]) {
      expect(await client({ op: "list", token_from: name }), name).toEqual({ configured: false });
    }
    // The account: bound, as text, 32 lower-case hexadecimal digits.
    for (const name of ["TEST_STORE_UNBOUND", "TEST_SETTING_NUMBER", "TEST_SETTING_TEXT_TRUE"]) {
      expect(await client({ op: "list", account_from: name }), name).toEqual({ configured: false });
    }
    // Every call that went out was the two configured ones, each with the store token, and the test values differ.
    expect((await state()).calls.map((c) => c.token)).toEqual(["store", "store"]);
    expect(BINDINGS.CONTENT_STORE_TOKEN).toMatch(/^test-/);
    expect([FAKE.scriptsToken, FAKE.routingToken]).not.toContain(BINDINGS.CONTENT_STORE_TOKEN);
  });

  it("binds its token in no environment, and logs nothing from what it reads", () => {
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    const source = sources["app_stores.rs"];
    const names = [...source.matchAll(/const [A-Z_]+: &str = "([A-Z_]+)";/g)].map((match) => match[1]).sort();
    expect(names).toEqual(["CONTENT_ACCOUNT_ID", "CONTENT_STORE_TOKEN"]);
    const wrangler: string = BINDINGS.TEST_API_WRANGLER;
    expect(wrangler).not.toMatch(/CONTENT_STORE_TOKEN|d1_databases.*podster-store/);
    // No console call in the module: nothing it reads, a name, an ID, an account or a token, reaches a log.
    expect(source).not.toMatch(/console_(log|error|warn|debug)!|console\./);
    // The test-only route is in test builds alone.
    const lib = sources["lib.rs"].split("\n");
    const at = lib.findIndex((line) => line.includes('"/test/app-store"'));
    expect(at).toBeGreaterThan(0);
    expect(lib[at - 1]).toContain('#[cfg(feature = "failpoints")]');
    expect(source).toMatch(/#\[cfg\(feature = "failpoints"\)\]\npub\(crate\) async fn test_route/);
  });
});

// The room's record of its app's store (room schema step 51): a kind and an ID, the name the room chose, and when it is
// owed a deletion. Nothing writes it yet; these rows are written by hand to show what the table takes and refuses.
async function assertion(id: string, org: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org, orgs: [org], admin_orgs: [org], org_since: { [org]: 1 } })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const made: string[] = [];
let rooms = 0;

async function room() {
  const n = ++rooms;
  const owner = `per_store_owner_${n}`;
  const org = `org_store_${n}`;
  const res = await SELF.fetch("https://api.internal/v1/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `store-${n}-${randomHex()}`, "x-podster-assertion": await assertion(owner, org) },
    body: JSON.stringify({ name: "Store" }),
  });
  expect(res.status).toBe(200);
  const id = ((await res.json()) as any).id as string;
  made.push(id);
  await inRoom(id, (sql) => sql.exec("INSERT INTO app_label (label, current, created_at) VALUES ('todo', 1, 1)"));
  await manualAlarms(stub(id));
  return { id, owner, org };
}
const visit = async (r: { id: string; owner: string; org: string }) =>
  (await SELF.fetch(`https://api.internal/v1/workspaces/${r.id}`, { headers: { "x-podster-assertion": await assertion(r.owner, r.org) } })).status;

const ID = "0123abcd-4567-89ef-0123-456789abcdef";
const NAME = "podster-store-00112233445566778899aabbccddeeff";
const insert = (sql: any, values: Record<string, unknown>) => {
  const row = { label: "todo", kind: "d1", store_name: NAME, store_id: null, recorded_at: 1, create_sent_at: null, made_at: null, delete_owed_at: null, delete_cause: null, gone_at: null, updated_at: 1, ...values };
  sql.exec(`INSERT INTO app_store (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`, ...Object.values(row));
};

describe("the room's record of its store", () => {
  afterEach(async () => {
    for (const id of made.splice(0)) await alarmQuiet(stub(id));
  });

  it("holds a kind, the name the room chose and, once made, an ID; and refuses any other shape", async () => {
    const r = await room();
    // Each of these is the room's own write, one step at a time.
    await inRoom(r.id, (sql) => {
      insert(sql, {});
      sql.exec("UPDATE app_store SET create_sent_at = 2, updated_at = 2");
      sql.exec("UPDATE app_store SET store_id = ?, made_at = 3, updated_at = 3", ID);
      sql.exec("UPDATE app_store SET delete_owed_at = 4, delete_cause = 'operator_takedown', updated_at = 4");
      sql.exec("UPDATE app_store SET gone_at = 5, updated_at = 5");
    });
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT kind, store_name, store_id, made_at, delete_cause, gone_at FROM app_store").toArray())).toEqual([
      { kind: "d1", store_name: NAME, store_id: ID, made_at: 3, delete_cause: "operator_takedown", gone_at: 5 },
    ]);
    const refused: [string, Record<string, unknown>][] = [
      ["a label the room doesn't hold", { label: "other" }],
      ["a kind that isn't d1", { kind: "kv" }],
      ["a kind's case twin", { kind: "D1" }],
      ["a name that isn't a store's", { store_name: "my-database" }],
      ["a name in capitals", { store_name: NAME.toUpperCase().replace("PODSTER-STORE-", "podster-store-") }],
      ["a name one digit short", { store_name: NAME.slice(0, -1) }],
      ["an ID in capitals", { store_id: ID.toUpperCase(), create_sent_at: 2, made_at: 3 }],
      ["an ID with no hyphens", { store_id: `${ID.replace(/-/g, "")}abcd`, create_sent_at: 2, made_at: 3 }],
      ["an ID with a hyphen out of place", { store_id: "0123abcd4-567-89ef-0123-456789abcdef", create_sent_at: 2, made_at: 3 }],
      ["an ID with no time made", { store_id: ID, create_sent_at: 2 }],
      ["made with no ID", { made_at: 3, create_sent_at: 2 }],
      ["made with no create sent", { store_id: ID, made_at: 3 }],
      ["a deletion owed with no cause", { delete_owed_at: 4 }],
      ["a cause with no deletion owed", { delete_cause: "label_retired" }],
      ["a cause not of its form", { delete_owed_at: 4, delete_cause: "Label retired" }],
      ["gone with no deletion owed", { gone_at: 5 }],
      ["a time that isn't an integer", { recorded_at: 1.5 }],
      ["a time made that isn't an integer", { store_id: ID, create_sent_at: 2, made_at: "soon" }],
      // Step 53's columns.
      ["a deletion due while none is owed", { delete_next_at: 5 }],
      ["a deletion due once gone", { delete_owed_at: 4, delete_cause: "owner_deleted", gone_at: 5, delete_next_at: 6 }],
      ["a first read of gone that isn't an integer", { first_gone_at: 1.5 }],
      ["tries counted below none", { delete_attempts: -1 }],
    ];
    for (const [why, values] of refused) {
      const error = await inRoom(r.id, (sql) => {
        sql.exec("DELETE FROM app_store");
        try { insert(sql, values); return null; } catch (e) { return String(e); }
      });
      expect(String(error), why).toMatch(/constraint|FOREIGN KEY/i);
    }
    // One record for one app, and a name or an ID is never shared by two.
    const shared = await inRoom(r.id, (sql) => {
      sql.exec("DELETE FROM app_store");
      sql.exec("UPDATE app_label SET current = NULL, retired_at = 2");
      sql.exec("INSERT INTO app_label (label, current, created_at) VALUES ('next', 1, 3)");
      insert(sql, { store_id: ID, create_sent_at: 2, made_at: 3 });
      const errors: string[] = [];
      for (const values of [{}, { label: "next" }, { label: "next", store_name: NAME.replace(/f$/, "0"), store_id: ID, create_sent_at: 2, made_at: 3 }]) {
        try { insert(sql, values); errors.push("taken"); } catch (e) { errors.push(String(e).match(/UNIQUE/i) ? "unique" : String(e)); }
      }
      insert(sql, { label: "next", store_name: NAME.replace(/f$/, "0") });
      return errors;
    });
    expect(shared).toEqual(["unique", "unique", "unique"]);
  });

  it("is added to a room made before it, and its step runs again safely", async () => {
    const r = await room();
    const latest = await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version as number);
    // A room as it was before step 51: no table, six steps behind (steps 52, the record of a script's kind, 53, the
    // record's rebuild, 54, who wrote a task's inputs, 55, the recheck's record, and 56, a custom host's marker, are
    // after it and run again safely too).
    await inRoom(r.id, (sql) => {
      sql.exec("DROP TABLE app_store");
      sql.exec("UPDATE schema_version SET version = version - 14");
    });
    expect(await visit(r)).toBe(200);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version)).toBe(latest);
    await inRoom(r.id, (sql) => insert(sql, { store_id: ID, create_sent_at: 2, made_at: 3 }));
    // The step again, over a table that is there with a row in it: the row is kept.
    await inRoom(r.id, (sql) => sql.exec("UPDATE schema_version SET version = version - 14"));
    expect(await visit(r)).toBe(200);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version)).toBe(latest);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT label, store_id FROM app_store").toArray())).toEqual([{ label: "todo", store_id: ID }]);
  });

  // Room schema step 53 (S4 of the store plan): the record gains `first_gone_at`, which S2 kept in `updated_at` while a
  // create was outstanding, and the deletion job's wait. SQLite can't add a column only if it is missing, so the step
  // rebuilds the table whole.
  it("is rebuilt with the first read of gone and the deletion's wait by step 53, on a room made before it, and the step runs again safely", async () => {
    const r = await room();
    const latest = await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version as number);
    const NAMES = ["0", "1", "2", "3"].map((d) => NAME.replace(/f$/, d));
    const IDS = ["0", "1"].map((d) => ID.replace(/f$/, d));
    // A room as it was before step 53: the record as step 51 made it, and four rows of it. Steps 54, 55 and 56, after it,
    // run again safely too.
    await inRoom(r.id, (sql) => {
      for (const label of ["l1", "l2", "l3"]) sql.exec("INSERT INTO app_label (label, current, created_at, retired_at) VALUES (?, NULL, 1, 1)", label);
      sql.exec("DROP TABLE app_store");
      sql.exec(`CREATE TABLE app_store (label TEXT PRIMARY KEY REFERENCES app_label (label), kind TEXT NOT NULL CHECK (kind = 'd1'), store_name TEXT NOT NULL UNIQUE,
        store_id TEXT UNIQUE, recorded_at INTEGER NOT NULL, create_sent_at INTEGER, made_at INTEGER, delete_owed_at INTEGER, delete_cause TEXT, gone_at INTEGER,
        updated_at INTEGER NOT NULL) WITHOUT ROWID`);
      const old = (label: string, name: string, values: Record<string, unknown>) => {
        const row = { label, kind: "d1", store_name: name, store_id: null, recorded_at: 1, create_sent_at: null, made_at: null, delete_owed_at: null, delete_cause: null, gone_at: null, updated_at: 1, ...values };
        sql.exec(`INSERT INTO app_store (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`, ...Object.values(row));
      };
      // A create outstanding whose first counted list S2 noted in `updated_at`, ten minutes after the create.
      old("todo", NAMES[0], { create_sent_at: 1_000, updated_at: 601_000 });
      // A create outstanding with no list counted yet: `updated_at` a millisecond short of ten minutes after it.
      old("l1", NAMES[1], { create_sent_at: 1_000, updated_at: 600_999 });
      // A store owed a deletion, and one gone.
      old("l2", NAMES[2], { store_id: IDS[0], create_sent_at: 1, made_at: 2, delete_owed_at: 3, delete_cause: "operator_takedown", updated_at: 3 });
      old("l3", NAMES[3], { store_id: IDS[1], create_sent_at: 1, made_at: 2, delete_owed_at: 3, delete_cause: "owner_deleted", gone_at: 4, updated_at: 4 });
      sql.exec("UPDATE schema_version SET version = version - 12");
    });
    expect(await visit(r)).toBe(200);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version)).toBe(latest);
    const read = () => inRoom(r.id, (sql) => sql.exec("SELECT label, store_id, create_sent_at, updated_at, first_gone_at, delete_next_at, delete_attempts, gone_at FROM app_store ORDER BY label").toArray());
    const rebuilt = [
      { label: "l1", store_id: null, create_sent_at: 1_000, updated_at: 600_999, first_gone_at: null, delete_next_at: null, delete_attempts: 0, gone_at: null },
      { label: "l2", store_id: IDS[0], create_sent_at: 1, updated_at: 3, first_gone_at: null, delete_next_at: 3, delete_attempts: 0, gone_at: null },
      { label: "l3", store_id: IDS[1], create_sent_at: 1, updated_at: 4, first_gone_at: null, delete_next_at: null, delete_attempts: 0, gone_at: 4 },
      { label: "todo", store_id: null, create_sent_at: 1_000, updated_at: 601_000, first_gone_at: 601_000, delete_next_at: null, delete_attempts: 0, gone_at: null },
    ];
    expect(await read()).toEqual(rebuilt);
    // Every check the table had still holds after the rebuild.
    const refused = await inRoom(r.id, (sql) => { try { sql.exec("UPDATE app_store SET gone_at = 9 WHERE label = 'todo'"); return null; } catch (e) { return String(e); } });
    expect(String(refused)).toMatch(/constraint/i);
    // The step again, over the rebuilt table: every row kept, the notes as they were.
    await inRoom(r.id, (sql) => sql.exec("UPDATE schema_version SET version = version - 12"));
    expect(await visit(r)).toBe(200);
    expect(await read()).toEqual(rebuilt);
  });
});

// The room's record of whether a release's script carries code (room schema step 52, S3 of the store plan): written
// before the script is, and read by the applier and the reconcile to compare an entry's kind as well as its script.
describe("the room's record of a script's kind", () => {
  afterEach(async () => {
    for (const id of made.splice(0)) await alarmQuiet(stub(id));
  });
  const release = (sql: any, id: string) => sql.exec(
    "INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, script_name, script_release_id, requested_by, requested_at, updated_at) VALUES (?, ?, 'uploading', 'todo', 1, 0, ?, ?, 'per_x', 1, 1)",
    id, "a5".repeat(20), `todo.${id}`, id);
  const UPLOADED = `rel_${"7a".repeat(16)}`;
  const UNCERTAIN = `rel_${"7b".repeat(16)}`;
  const OTHER = `rel_${"7c".repeat(16)}`;

  it("is added to a room made before it, as static for every script written before it, and its step runs again safely", async () => {
    const r = await room();
    const latest = await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version as number);
    // A room as it was before step 52: two scripts written, one recorded, one uncertain, and no record of kinds.
    await inRoom(r.id, (sql) => {
      release(sql, UPLOADED);
      release(sql, UNCERTAIN);
      release(sql, OTHER);
      sql.exec("INSERT INTO release_upload (release_id, script_name, files, bytes, uploaded_at) VALUES (?, ?, 2, 10, 5)", UPLOADED, `todo.${UPLOADED}`);
      sql.exec("INSERT INTO release_uncertain (release_id, script_name, files, bytes, since, last_code) VALUES (?, ?, 2, 10, 6, 'x')", UNCERTAIN, `todo.${UNCERTAIN}`);
      sql.exec("DROP TABLE release_script_kind");
      // Five steps behind: steps 53, 54, 55 and 56, after it, run again safely too.
      sql.exec("UPDATE schema_version SET version = version - 13");
    });
    expect(await visit(r)).toBe(200);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version)).toBe(latest);
    const kinds = () => inRoom(r.id, (sql) => sql.exec("SELECT release_id, script_name, kind, recorded_at FROM release_script_kind ORDER BY recorded_at").toArray());
    const backfilled = [
      { release_id: UPLOADED, script_name: `todo.${UPLOADED}`, kind: "static", recorded_at: 5 },
      { release_id: UNCERTAIN, script_name: `todo.${UNCERTAIN}`, kind: "static", recorded_at: 6 },
    ];
    expect(await kinds()).toEqual(backfilled);
    // The step again, over a record that holds code for another script: nothing is changed or added twice.
    await inRoom(r.id, (sql) => {
      sql.exec("INSERT INTO release_script_kind (release_id, script_name, kind, recorded_at) VALUES (?, ?, 'code', 7)", OTHER, `todo.${OTHER}`);
      sql.exec("UPDATE schema_version SET version = version - 13");
    });
    expect(await visit(r)).toBe(200);
    expect(await kinds()).toEqual([...backfilled, { release_id: OTHER, script_name: `todo.${OTHER}`, kind: "code", recorded_at: 7 }]);
  });

  it("holds a release's own script, of a kind that is static or code, once", async () => {
    const r = await room();
    const refused = await inRoom(r.id, (sql) => {
      release(sql, UPLOADED);
      release(sql, OTHER);
      const errors: string[] = [];
      const insert = (...values: unknown[]) => {
        try { sql.exec("INSERT INTO release_script_kind (release_id, script_name, kind, recorded_at) VALUES (?, ?, ?, ?)", ...values); errors.push("taken"); } catch (e) { errors.push(String(e).match(/UNIQUE/i) ? "unique" : String(e).match(/constraint|FOREIGN KEY/i) ? "refused" : String(e)); }
      };
      insert(UPLOADED, `todo.${UPLOADED}`, "Code", 1);
      insert(UPLOADED, `todo.${UPLOADED}`, "", 1);
      insert(UPLOADED, `todo.${OTHER}`, "code", 1);
      insert(UPLOADED, `todo.${UPLOADED}`, "code", 1.5);
      insert(`rel_${"7d".repeat(16)}`, `todo.rel_${"7d".repeat(16)}`, "code", 1);
      insert(UPLOADED, `todo.${UPLOADED}`, "code", 1);
      insert(UPLOADED, `todo.${UPLOADED}`, "static", 2);
      return errors;
    });
    expect(refused).toEqual(["refused", "refused", "refused", "refused", "refused", "taken", "unique"]);
  });
});

appStoreMakeCases();
appCodeUploadCases();
appStoreDeleteCases();
