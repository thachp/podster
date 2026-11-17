import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm";

// M6 stage 1, the first PR of the store plan: the room's record of its app's store, and the client that makes, reads,
// deletes and lists stores with its own D1 credential. Nothing makes a store yet: the client is reached here only
// through the test-only route `/test/app-store`, against D1's stand-in (`fake-stores.ts`), and the record is written
// here only by hand, to show what the room's table holds and refuses.

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
    // A room as it was before step 51: no table, one step behind.
    await inRoom(r.id, (sql) => {
      sql.exec("DROP TABLE app_store");
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    expect(await visit(r)).toBe(200);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version)).toBe(latest);
    await inRoom(r.id, (sql) => insert(sql, { store_id: ID, create_sent_at: 2, made_at: 3 }));
    // The step again, over a table that is there with a row in it: the row is kept.
    await inRoom(r.id, (sql) => sql.exec("UPDATE schema_version SET version = version - 1"));
    expect(await visit(r)).toBe(200);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT version FROM schema_version").one().version)).toBe(latest);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT label, store_id FROM app_store").toArray())).toEqual([{ label: "todo", store_id: ID }]);
  });
});
