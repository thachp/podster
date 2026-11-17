import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet, manualAlarms } from "./alarm";

// M6 stage 1, S4 of the store plan: deleting an app's data. The room's owner, as a person, and a Podster operator each
// owe the app's store a deletion; the room's own job then deletes it at D1, never trusting a delete's answer, and counts
// it gone only on D1's own not-found, read twice at least ten minutes apart. A record with a name and no ID is resolved
// by a whole list read by its name first. Only a store the room's own record names is ever deleted.
//
// These run inside `app-store.spec.ts` (`appStoreDeleteCases`), which owns D1's stand-in (`fake-stores.ts`) and resets
// it: the stand-in keeps one account's databases for every spec file. The job runs on the release commands' clock
// (`test_release_clock`), which each test sets, so every ten-minute edge is the test's to cross.

const BINDINGS = env as any;
type Who = { id: string; org: string };
const OPERATOR: Who = { id: "per_operator_one", org: "org_s4_ops" };
const NOTICE = "Your app’s data is deleted now, and nothing can read it. Cloudflare keeps a recoverable copy for up to 7 days; after that it’s gone for good.";
const T = 1_900_000_000_000;
const SPAN = 10 * 60 * 1000;
let key: any;

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: who.org, orgs: [who.org], admin_orgs: [who.org], org_since: { [who.org]: 1 } })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "idempotency-key": `s4-key-${++counter}-${crypto.randomUUID()}` };
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
let on = 0;
let switching: Promise<unknown> = Promise.resolve();
const inTurn = (step: () => Promise<unknown>) => (switching = switching.then(step, step));
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await inTurn(async () => { if (on++ === 0) await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_releases_on (x INTEGER)").run(); });
  try { return await run(); } finally { await inTurn(async () => { if (--on === 0) await BINDINGS.DB.prepare("DROP TABLE IF EXISTS test_releases_on").run(); }); }
}

// --- D1's stand-in, the content account's ----------------------------------------------------------------------------
const stores = (path: string, body?: unknown) =>
  fetch(`https://stores-fake.example.com${path}`, { method: "POST", body: JSON.stringify(body ?? {}) }).then((res) => res.json() as Promise<any>);
const storeFault = (op: string, kind: string, times = 1) => stores("/fault", { op, kind, times });
type StoreState = { databases: { uuid: string; name: string }[]; calls: { op: string; token: string; key: string }[] };
const storeState = () => stores("/state") as Promise<StoreState>;
const calls = async () => (await storeState()).calls.map((call) => [call.op, call.key]);
const newName = () => `podster-store-${crypto.randomUUID().replace(/-/g, "")}`;
async function database(name = newName()) {
  const db = { uuid: crypto.randomUUID(), name };
  await stores("/seed", { entries: [db] });
  return db;
}

// --- rooms ------------------------------------------------------------------------------------------------------------
const made: string[] = [];
let rooms = 0;
type Room = { id: string; label: string; owner: Who; admin: Who; member: Who };
/** A room with one current app label, listed in the lookup table, on the release commands' clock at `T`. */
async function room(): Promise<Room> {
  const n = ++rooms;
  const owner = { id: `per_s4_owner_${n}`, org: `org_s4_${n}` };
  const id: string = (await api(owner, "POST", "/v1/workspaces", { name: "Data" })).body.id;
  made.push(id);
  const label = `s4${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = { id: `per_s4_admin_${n}`, org: owner.org };
  const member = { id: `per_s4_member_${n}`, org: owner.org };
  await inRoom(id, (sql) => {
    for (const [who, role] of [[admin, "admin"], [member, "member"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, owner.org, role, owner.id);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
    sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, id).run();
  await manualAlarms(stub(id));
  return { id, label, owner, admin, member };
}
const at = (r: Room, now: number) => inRoom(r.id, (sql) => void sql.exec("UPDATE test_release_clock SET now = ?", now));
/** The room's record of its label's store, as `release_store.rs` leaves one: made, or a name only. */
const recordStore = (r: Room, db: { uuid?: string; name: string }, opts: { owed?: number; sent?: number | null } = {}) => inRoom(r.id, (sql) => sql.exec(
  `INSERT INTO app_store (label, kind, store_name, store_id, recorded_at, create_sent_at, made_at, delete_owed_at, delete_cause, delete_next_at, updated_at)
     VALUES (?, 'd1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  r.label, db.name, db.uuid ?? null, T - 3_600_000, opts.sent === undefined ? T - 3_600_000 : opts.sent, db.uuid ? T - 3_600_000 : null,
  opts.owed ?? null, opts.owed === undefined ? null : "owner_deleted", opts.owed ?? null, T - 3_600_000));
const row = (r: Room) => inRoom(r.id, (sql) => sql.exec(
  "SELECT store_id, made_at, create_sent_at, delete_owed_at, delete_cause, gone_at, first_gone_at, delete_next_at, delete_attempts FROM app_store WHERE label = ?", r.label).one());
/** One pass of the room's alarm, at `now` on the release commands' clock. */
async function pass(r: Room, now: number) {
  await at(r, now);
  await alarmPass(stub(r.id));
}

export function appStoreDeleteCases() {
  describe("deleting an app's data (S4)", () => {
    beforeAll(async () => {
      key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
    });
    beforeEach(() => stores("/reset"));
    afterEach(async () => { for (const id of made.splice(0)) await alarmQuiet(stub(id)); });

    describe("the room's job", () => {
      it("deletes a store owed a deletion, never trusts the delete's answer, and counts it gone only on two reads of D1's own not-found ten minutes apart", async () => {
        const r = await room();
        const db = await database();
        const other = await database();
        await recordStore(r, db, { owed: T });
        // A delete that says it worked and did nothing: the read says the store is still there.
        await storeFault("delete", "noEffect");
        await pass(r, T);
        expect(await row(r)).toMatchObject({ first_gone_at: null, gone_at: null, delete_attempts: 1, delete_next_at: T + 5_000 });
        expect((await storeState()).databases).toEqual([db, other]);
        // Not due before its wait: nothing is asked.
        await pass(r, T + 4_999);
        expect(await calls()).toEqual([["delete", db.uuid], ["read", db.uuid]]);
        // Due: deleted, and the first read of D1's not-found is noted, gone not yet.
        await pass(r, T + 5_000);
        const first = T + 5_000;
        expect(await row(r)).toMatchObject({ first_gone_at: first, gone_at: null, delete_attempts: 0, delete_next_at: first + SPAN });
        expect((await storeState()).databases).toEqual([other]);
        // A read that isn't D1's own not-found decides nothing: the note stays, and it is read again.
        await inRoom(r.id, (sql) => sql.exec("UPDATE app_store SET delete_next_at = ?", first + SPAN - 1));
        await storeFault("read", "notFoundOtherCode");
        await pass(r, first + SPAN - 1);
        expect(await row(r)).toMatchObject({ first_gone_at: first, gone_at: null, delete_attempts: 1 });
        // A second read of gone a millisecond inside the ten minutes counts for nothing.
        await inRoom(r.id, (sql) => sql.exec("UPDATE app_store SET delete_next_at = ?", first + SPAN - 1));
        await pass(r, first + SPAN - 1);
        expect(await row(r)).toMatchObject({ first_gone_at: first, gone_at: null, delete_next_at: first + SPAN });
        // Ten minutes after the first: gone, and nothing more is due.
        await pass(r, first + SPAN);
        expect(await row(r)).toMatchObject({ first_gone_at: first, gone_at: first + SPAN, delete_next_at: null, delete_owed_at: T, delete_cause: "owner_deleted", store_id: db.uuid });
        // Once deleted, nothing more is sent; the other store was never touched.
        await pass(r, first + 5 * SPAN);
        expect(await calls()).toEqual([["delete", db.uuid], ["read", db.uuid], ["delete", db.uuid], ["read", db.uuid], ["read", db.uuid], ["read", db.uuid], ["read", db.uuid]]);
        expect((await storeState()).databases).toEqual([other]);
      });

      it("forgets a note of gone when D1 describes the store again, and deletes it again", async () => {
        const r = await room();
        const db = await database();
        await recordStore(r, db, { owed: T });
        await pass(r, T);
        expect(await row(r)).toMatchObject({ first_gone_at: T });
        // The store is back (an undelete by the account's holder, or a read that lagged): present, so deleted again.
        await stores("/seed", { entries: [db] });
        await pass(r, T + SPAN);
        expect(await row(r)).toMatchObject({ first_gone_at: null, gone_at: null, delete_attempts: 1 });
        await pass(r, T + SPAN + 5_000);
        expect(await row(r)).toMatchObject({ first_gone_at: T + SPAN + 5_000, gone_at: null });
        expect((await storeState()).databases).toEqual([]);
      });

      it("resolves a record with a name and no ID by a whole list first: listed, its ID is recorded and it is deleted by it", async () => {
        const r = await room();
        const db = await database();
        await recordStore(r, { name: db.name }, { owed: T });
        // A list that isn't whole decides nothing, and nothing is deleted.
        await storeFault("list", "noInfo");
        await pass(r, T);
        expect(await row(r)).toMatchObject({ store_id: null, delete_attempts: 1 });
        await pass(r, T + 5_000);
        expect(await row(r)).toMatchObject({ store_id: db.uuid, made_at: T + 5_000, delete_next_at: T + 5_000, first_gone_at: null });
        await pass(r, T + 5_000);
        expect(await row(r)).toMatchObject({ first_gone_at: T + 5_000, gone_at: null });
        expect(await calls()).toEqual([["list", ""], ["list", ""], ["delete", db.uuid], ["read", db.uuid]]);
        expect((await storeState()).databases).toEqual([]);
      });

      it("counts a name the list never shows as gone only on two whole lists ten minutes apart, the first ten minutes after its create", async () => {
        const r = await room();
        const name = newName();
        // A create sent just now, still landing: a list without it doesn't count yet.
        await recordStore(r, { name }, { owed: T, sent: T });
        await pass(r, T);
        expect(await row(r)).toMatchObject({ first_gone_at: null, gone_at: null, delete_next_at: T + SPAN });
        await pass(r, T + SPAN);
        expect(await row(r)).toMatchObject({ first_gone_at: T + SPAN, gone_at: null, delete_next_at: T + 2 * SPAN });
        await inRoom(r.id, (sql) => sql.exec("UPDATE app_store SET delete_next_at = ?", T + 2 * SPAN - 1));
        await pass(r, T + 2 * SPAN - 1);
        expect(await row(r)).toMatchObject({ gone_at: null });
        await pass(r, T + 2 * SPAN);
        expect(await row(r)).toMatchObject({ gone_at: T + 2 * SPAN, store_id: null });
        // Nothing was ever deleted or read by an ID: there was none.
        expect((await calls()).map(([op]) => op)).toEqual(["list", "list", "list", "list"]);
      });

      it("never deletes a store the room's own record doesn't name: an orphan no room records, or another room's", async () => {
        const [r, s, u] = [await room(), await room(), await room()];
        // The orphan is listed first: Podster-named, and no room's (the reconcile's `store_orphan`).
        const [orphan, owed, byName, theirs] = [await database(), await database(), await database(), await database()];
        await recordStore(r, owed, { owed: T });
        // A record with a name and no ID, resolved by the list: only its own name is taken.
        await recordStore(u, { name: byName.name }, { owed: T });
        await recordStore(s, theirs);
        for (const now of [T, T + SPAN, T + 2 * SPAN]) {
          for (const each of [r, u, s]) await pass(each, now);
        }
        expect(await row(r)).toMatchObject({ gone_at: T + SPAN });
        expect(await row(u)).toMatchObject({ store_id: byName.uuid, gone_at: T + 2 * SPAN });
        expect((await storeState()).databases).toEqual([orphan, theirs]);
        expect((await calls()).filter(([op]) => op === "delete")).toEqual([["delete", owed.uuid], ["delete", byName.uuid]]);
        // The store a room keeps, owed nothing, is the app's live data: never asked about.
        expect(await row(s)).toMatchObject({ store_id: theirs.uuid, delete_owed_at: null, gone_at: null });
      });

      it("holds the delete while the edge may still route to a script bound to the store, or a release bound to it is under way", async () => {
        const r = await room();
        const db = await database();
        await recordStore(r, db, { owed: T });
        const host = `${r.label}.example`;
        await inRoom(r.id, (sql) => {
          sql.exec("INSERT INTO serve_state (host, kind, version, updated_at) VALUES (?, 'default', 3, 1)", host);
          sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 2, ?, 1, 1)", host, `${r.label}.rel_${"5e".repeat(16)}`);
        });
        await pass(r, T);
        expect(await row(r)).toMatchObject({ delete_attempts: 1, delete_next_at: T + 5_000, first_gone_at: null });
        expect(await calls()).toEqual([]);
        // Confirmed down, but a release of the label whose script was bound to the store is still live in the room's own
        // record (its host not yet switched to it): held. (One still uploading is held the same way, shown through the
        // real upload in `app-store-make.cases.ts`; written by hand here the alarm's bookkeeping would end it first.)
        const release = `rel_${"5f".repeat(16)}`;
        await inRoom(r.id, (sql) => {
          sql.exec("UPDATE serve_apply SET applied_version = 3, applied_script = NULL");
          sql.exec("INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, updated_at) VALUES (?, ?, 'live', ?, 1, 0, ?, ?, 'per_x', 1, 'per_x', 1, 1)",
            release, "a5".repeat(20), r.label, `${r.label}.${release}`, release);
          sql.exec("INSERT INTO release_store_binding (release_id, label, store_id, recorded_at) VALUES (?, ?, ?, 1)", release, r.label, db.uuid);
        });
        await pass(r, T + 5_000);
        expect(await row(r)).toMatchObject({ delete_attempts: 2, delete_next_at: T + 15_000 });
        expect(await calls()).toEqual([]);
        // Once that release has ended, nothing can reach the store: deleted.
        await inRoom(r.id, (sql) => sql.exec("UPDATE release SET state = 'failed', failure_code = 'x', finished_at = 1 WHERE id = ?", release));
        await pass(r, T + 15_000);
        expect(await calls()).toEqual([["delete", db.uuid], ["read", db.uuid]]);
        expect(await row(r)).toMatchObject({ first_gone_at: T + 15_000 });
      });

      it("waits its turn when a step writes nothing: an ID found by the name that another record holds", async () => {
        const r = await room();
        const db = await database();
        // Another of the room's records already holds the ID D1 lists under this record's name.
        await inRoom(r.id, (sql) => sql.exec("INSERT INTO app_label (label, current, created_at, retired_at) VALUES (?, NULL, 1, 1)", `${r.label}z`));
        await inRoom(r.id, (sql) => sql.exec(
          "INSERT INTO app_store (label, kind, store_name, store_id, recorded_at, create_sent_at, made_at, updated_at) VALUES (?, 'd1', ?, ?, 1, 1, 2, 2)", `${r.label}z`, newName(), db.uuid));
        await recordStore(r, { name: db.name }, { owed: T });
        await pass(r, T);
        // Not due again at once: the room isn't woken in a loop.
        expect(await row(r)).toMatchObject({ store_id: null, delete_attempts: 1, delete_next_at: T + 5_000 });
        expect((await calls()).map(([op]) => op)).toEqual(["list"]);
      });

      it("waits, recording the deletion owed and sending nothing, with no store provider", async () => {
        const r = await room();
        const db = await database();
        await recordStore(r, db, { owed: T });
        await inRoom(r.id, (sql) => sql.exec("CREATE TABLE test_app_store_provider_off (x INTEGER)"));
        await pass(r, T + SPAN);
        expect(await row(r)).toMatchObject({ first_gone_at: null, gone_at: null, delete_next_at: T, delete_attempts: 0 });
        expect(await calls()).toEqual([]);
        // The control: with the provider, the same pass deletes.
        await inRoom(r.id, (sql) => sql.exec("DROP TABLE test_app_store_provider_off"));
        await pass(r, T + SPAN);
        expect((await storeState()).databases).toEqual([]);
      });

      it("logs the room's ID and codes alone, and writes the record only through the store's own module", () => {
        const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
        const source = sources["workspace/store_delete.rs"];
        const logs = [...source.matchAll(/console_(?:log|error|warn|debug)!\(\s*"([^"]*)",?([\s\S]*?)\);/g)];
        expect(logs.map(([, format]) => format)).toEqual(["store delete: room={} code={}"]);
        expect(logs[0][2].split(",").map((arg) => arg.trim()).filter(Boolean)).toEqual(["release_driver::room_id(sql)", "code"]);
        // The job sends a delete in one place, by an ID from the room's own record.
        expect(source.match(/provider\.delete\(/g)?.length).toBe(1);
        expect(source).toMatch(/DeleteStep::Delete\(id\) => \{\n\s+\/\/ [^\n]*\n\s+provider\.delete\(id\)\.await;/);
      });
    });

    describe("the room's owner's command", () => {
      const ask = (r: Room, who: Who, body: unknown = { confirm: r.label }, label = r.label) =>
        api(who, "POST", `/v1/workspaces/${r.id}/apps/${label}/delete-data`, body);

      it("is nothing anyone can find while release is switched off", async () => {
        const r = await room();
        await recordStore(r, await database());
        const [real, unknown] = [await ask(r, r.owner), await api(r.owner, "POST", `/v1/workspaces/${r.id}/apps/${r.label}/delete-datax`, { confirm: r.label })];
        expect(real.status).toBe(404);
        expect([real.status, real.body]).toEqual([unknown.status, unknown.body]);
        expect(await row(r)).toMatchObject({ delete_owed_at: null });
      });

      it("is the room's owner's or an admin's, as a person (decision 220 (7)): a member and an agent admin are refused, and write nothing", async () => {
        const r = await room();
        await recordStore(r, await database());
        await switchedOn(async () => {
          const refused = await ask(r, r.member);
          expect([refused.status, refused.body.error.code]).toEqual([403, "not_allowed"]);
          // An agent holding the admin role: refused by its kind.
          const agent = { id: "agt_s4_admin", org: r.owner.org };
          await inRoom(r.id, (sql) => sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'admin', ?, 1)", agent.id, r.owner.org, r.owner.id));
          const now = Math.floor(Date.now() / 1000);
          const token = await new SignJWT({ kind: "agent", org: agent.org, gen: 1 }).setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(agent.id)
            .setAudience("podster-api").setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
          const byAgent = await SELF.fetch(`https://api.internal/v1/workspaces/${r.id}/apps/${r.label}/delete-data`, {
            method: "POST", headers: { "content-type": "application/json", "x-podster-assertion": token, "idempotency-key": `s4-agent-${crypto.randomUUID()}` }, body: JSON.stringify({ confirm: r.label }),
          });
          // Refused at the Worker, before the room, whichever of its agent checks answers first; the policy's own test
          // shows an agent admin refused by its kind (`crates/policy/tests/release.rs`).
          expect(byAgent.status).toBe(403);
          // Someone outside the room learns nothing of it.
          const outsider = await ask(r, { id: "per_s4_outsider", org: "org_s4_outside" });
          expect(outsider.body.error.code).toBe("workspace_not_found");
          expect(await row(r)).toMatchObject({ delete_owed_at: null });
          // An admin who is a person may.
          const byAdmin = await ask(r, r.admin);
          expect([byAdmin.status, byAdmin.body.cause, byAdmin.body.notice]).toEqual([200, "owner_deleted", NOTICE]);
        });
        expect(await inRoom(r.id, (sql) => sql.exec("SELECT actor_id FROM audit_event WHERE action = 'app_data.delete_owed'").toArray())).toEqual([{ actor_id: r.admin.id }]);
      });

      it("refuses while the edge may still serve one of the label's scripts, by what the applier last confirmed", async () => {
        const r = await room();
        await recordStore(r, await database());
        const script = `${r.label}.rel_${"5e".repeat(16)}`;
        await inRoom(r.id, (sql) => {
          // The room wants nothing on the host, but the applier last wrote the label's script there, at an older version.
          sql.exec("INSERT INTO serve_state (host, kind, version, updated_at) VALUES (?, 'default', 3, 1)", `${r.label}.example`);
          sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 2, ?, 1, 1)", `${r.label}.example`, script);
        });
        await switchedOn(async () => {
          expect((await ask(r, r.owner)).body.error.code).toBe("app_still_served");
          // Removed at the current version, but not yet confirmed: still refused.
          await inRoom(r.id, (sql) => sql.exec("UPDATE serve_apply SET applied_script = NULL"));
          expect((await ask(r, r.owner)).body.error.code).toBe("app_still_served");
          expect(await row(r)).toMatchObject({ delete_owed_at: null });
          // Confirmed down at the host's current version: owed, and the words are true.
          await inRoom(r.id, (sql) => sql.exec("UPDATE serve_apply SET applied_version = 3"));
          expect((await ask(r, r.owner)).body).toMatchObject({ data: "deleting", notice: NOTICE });
        });
      });

      it("refuses with data left and no store provider, since nothing would delete it", async () => {
        const r = await room();
        await recordStore(r, await database());
        await inRoom(r.id, (sql) => sql.exec("CREATE TABLE test_app_store_provider_off (x INTEGER)"));
        await switchedOn(async () => {
          const refused = await ask(r, r.owner);
          expect([refused.status, refused.body.error.code]).toEqual([409, "data_delete_unavailable"]);
          const byOperator = await api(OPERATOR, "POST", `/v1/moderation/apps/${r.label}/delete-data`, { reason: "abuse" });
          expect([byOperator.status, byOperator.body.error.code]).toEqual([409, "data_delete_unavailable"]);
        });
        expect(await row(r)).toMatchObject({ delete_owed_at: null });
        // The operator's refusal suspended nothing either.
        expect(await inRoom(r.id, (sql) => sql.exec("SELECT suspended_at FROM app_label").one().suspended_at)).toBeNull();
      });

      it("owes the store a deletion once nothing serves the app, answers in the owner's words, and asking again changes nothing", async () => {
        const r = await room();
        const db = await database();
        await recordStore(r, db);
        const before = await inRoom(r.id, (sql) => sql.exec("SELECT count(*) AS n FROM audit_event").one().n);
        await switchedOn(async () => {
          // The body must name the label again, and the label must be the room's.
          for (const body of [{}, { confirm: "other" }, { confirm: r.label, extra: 1 }]) expect((await ask(r, r.owner, body)).body.error.code, JSON.stringify(body)).toBe("invalid_argument");
          expect((await ask(r, r.owner, { confirm: "nosuchlabel" }, "nosuchlabel")).status).toBe(404);
          // While anything of the app could still run with the store, refused, and nothing is written.
          const script = `${r.label}.rel_${"5d".repeat(16)}`;
          await inRoom(r.id, (sql) => {
            sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", r.owner.id);
            sql.exec("UPDATE release_config SET kept_previous = ?", script);
          });
          const served = await ask(r, r.owner);
          expect([served.status, served.body.error.code]).toEqual([409, "app_still_served"]);
          expect(await row(r)).toMatchObject({ delete_owed_at: null });
          await inRoom(r.id, (sql) => sql.exec("UPDATE release_config SET kept_previous = NULL"));
          // Nothing serves it now: owed, and the answer is the owner's words exactly.
          const owed = await ask(r, r.owner);
          expect(owed).toEqual({ status: 200, body: { label: r.label, data: "deleting", cause: "owner_deleted", owed_at: expect.any(Number), deleted_at: null, notice: NOTICE } });
          expect(await row(r)).toMatchObject({ delete_owed_at: owed.body.owed_at, delete_cause: "owner_deleted", delete_next_at: owed.body.owed_at, gone_at: null });
          // Asking again changes nothing, an operator's included: the first cause stands.
          expect(await ask(r, r.owner)).toEqual(owed);
          const operator = await api(OPERATOR, "POST", `/v1/moderation/apps/${r.label}/delete-data`, { reason: "abuse" });
          expect(operator.body).toEqual(owed.body);
        });
        // Audited by the owner, once, and told to the room's managers.
        expect(await inRoom(r.id, (sql) => sql.exec("SELECT actor_id, action, new_json FROM audit_event WHERE action LIKE 'app_data.%'").toArray())).toEqual([
          { actor_id: r.owner.id, action: "app_data.delete_owed", new_json: JSON.stringify({ cause: "owner_deleted" }) },
        ]);
        expect(await inRoom(r.id, (sql) => sql.exec("SELECT type, actor_id, reason FROM event WHERE type LIKE 'app_data.%'").toArray())).toEqual([
          { type: "app_data.delete_owed", actor_id: r.owner.id, reason: "owner_deleted" },
        ]);
        expect(await inRoom(r.id, (sql) => sql.exec("SELECT count(*) AS n FROM audit_event").one().n)).toBeGreaterThan(before);
        // The job then deletes it, and the answer says so.
        await pass(r, T + 10 * 365 * 24 * 3_600_000);
        await pass(r, T + 10 * 365 * 24 * 3_600_000 + SPAN);
        const done = await switchedOn(() => ask(r, r.owner));
        expect(done.body).toMatchObject({ data: "deleted", deleted_at: T + 10 * 365 * 24 * 3_600_000 + SPAN, notice: NOTICE });
        expect((await storeState()).databases).toEqual([]);
      });

      it("answers none for an app with no store, writing nothing, and works in an archived room", async () => {
        const r = await room();
        await switchedOn(async () => {
          expect(await ask(r, r.owner)).toEqual({ status: 200, body: { label: r.label, data: "none", cause: null, owed_at: null, deleted_at: null, notice: null } });
          await recordStore(r, await database());
          await inRoom(r.id, (sql) => sql.exec("UPDATE workspace SET status = 'archived'"));
          expect((await ask(r, r.owner)).body).toMatchObject({ data: "deleting", notice: NOTICE });
        });
      });
    });

    describe("an operator's command", () => {
      const ask = (label: string, who: Who = OPERATOR, body: unknown = { reason: "abuse" }) => api(who, "POST", `/v1/moderation/apps/${label}/delete-data`, body);
      const actions = (label: string) => runInDurableObject(moderation(), (_: any, state: any) =>
        state.storage.sql.exec("SELECT operator, subject_kind, action, reason, outcome FROM operator_action WHERE subject = ? ORDER BY seq", label).toArray());

      it("is an operator's alone, and asks no room for an unknown label", async () => {
        const r = await room();
        await recordStore(r, await database());
        await switchedOn(async () => {
          expect((await ask(r.label, r.owner)).body.error.code).toBe("not_allowed");
          for (const body of [{}, { reason: "nonsense" }, { reason: "abuse", extra: 1 }]) expect((await ask(r.label, OPERATOR, body)).body.error.code).toBe("invalid_argument");
          expect((await ask("nosuchlabel")).status).toBe(404);
        });
        expect(await row(r)).toMatchObject({ delete_owed_at: null });
        expect(await inRoom(r.id, (sql) => sql.exec("SELECT suspended_at FROM app_label").one().suspended_at)).toBeNull();
      });

      it("gives the owner's words only once nothing can reach the store", async () => {
        const r = await room();
        await recordStore(r, await database());
        const host = `${r.label}.example`;
        const script = `${r.label}.rel_${"5e".repeat(16)}`;
        await inRoom(r.id, (sql) => {
          sql.exec("INSERT INTO serve_state (host, kind, version, updated_at) VALUES (?, 'default', 3, 1)", host);
          sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 3, ?, 1, 1)", host, script);
        });
        // Straight after the suspension the applier hasn't taken the entry down: owed, and no words yet.
        const first = await switchedOn(() => ask(r.label));
        expect(first.body).toMatchObject({ data: "deleting", cause: "operator_takedown", notice: null });
        // Confirmed down: asking again changes nothing, and the words are now true.
        await inRoom(r.id, (sql) => sql.exec("UPDATE serve_apply SET applied_script = NULL, applied_version = (SELECT version FROM serve_state WHERE host = ?)", host));
        const again = await switchedOn(() => ask(r.label));
        expect(again.body).toEqual({ ...first.body, notice: NOTICE });
      });

      it("owes a retired label's data without suspending the room's current app, which that label doesn't serve", async () => {
        const r = await room();
        const retired = `${r.label}r`;
        await inRoom(r.id, (sql) => sql.exec("INSERT INTO app_label (label, current, created_at, retired_at) VALUES (?, NULL, 1, 1)", retired));
        await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(retired, r.id).run();
        const db = await database();
        await inRoom(r.id, (sql) => sql.exec(
          "INSERT INTO app_store (label, kind, store_name, store_id, recorded_at, create_sent_at, made_at, updated_at) VALUES (?, 'd1', ?, ?, 1, 1, 2, 2)", retired, db.name, db.uuid));
        const answer = await switchedOn(() => ask(retired));
        expect(answer.body).toMatchObject({ label: retired, data: "deleting", cause: "operator_takedown", notice: NOTICE });
        expect(await inRoom(r.id, (sql) => sql.exec("SELECT label, suspended_at FROM app_label ORDER BY label").toArray())).toEqual([
          { label: r.label, suspended_at: null }, { label: retired, suspended_at: null },
        ]);
      });

      it("suspends the app first, then owes its store a deletion as Podster's act, and answers in the owner's words", async () => {
        const r = await room();
        const db = await database();
        await recordStore(r, db);
        const answer = await switchedOn(() => ask(r.label));
        expect(answer).toEqual({ status: 200, body: { label: r.label, data: "deleting", cause: "operator_takedown", owed_at: T, deleted_at: null, notice: NOTICE } });
        expect(await inRoom(r.id, (sql) => sql.exec("SELECT suspended_at IS NOT NULL AS suspended, suspension_reason FROM app_label").one())).toEqual({ suspended: 1, suspension_reason: "abuse" });
        expect(await row(r)).toMatchObject({ delete_owed_at: T, delete_cause: "operator_takedown", delete_next_at: T });
        expect(await inRoom(r.id, (sql) => sql.exec("SELECT actor_id, action FROM audit_event WHERE action LIKE 'app%' ORDER BY created_at, action").toArray())).toEqual([
          { actor_id: "podster", action: "app.suspended" }, { actor_id: "podster", action: "app_data.delete_owed" },
        ]);
        expect(JSON.stringify(await inRoom(r.id, (sql) => sql.exec("SELECT * FROM event WHERE type LIKE 'app%'").toArray()))).not.toContain(OPERATOR.id);
        expect(await actions(r.label)).toEqual([{ operator: OPERATOR.id, subject_kind: "app", action: "delete_data", reason: "abuse", outcome: "done" }]);
        // Asking again changes nothing and answers the same.
        expect((await switchedOn(() => ask(r.label, OPERATOR, { reason: "spam" }))).body).toEqual(answer.body);
        expect(await inRoom(r.id, (sql) => sql.exec("SELECT count(*) AS n FROM audit_event WHERE action = 'app_data.delete_owed'").one().n)).toBe(1);
        // An app with no store: suspended all the same, and the answer says there is no data.
        const s = await room();
        expect((await switchedOn(() => ask(s.label))).body).toEqual({ label: s.label, data: "none", cause: null, owed_at: null, deleted_at: null, notice: null });
        expect(await inRoom(s.id, (sql) => sql.exec("SELECT suspended_at IS NOT NULL AS suspended FROM app_label").one().suspended)).toBe(1);
      });
    });
  });
}
