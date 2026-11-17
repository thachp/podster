import { describe, expect, it } from "vitest";
import type { Helpers } from "./script-bindings.cases";

// The store reconcile (S5 of the store plan, its second PR): the hourly pass reads the whole list of D1's databases
// with the store token and asks each label's room for its record of that label's store. It tells operators of a
// Podster-named store no room records, of a made store D1 says is gone, and settles a name with no ID, its create
// outstanding, that the list shows, which the room records itself. It deletes nothing. These run inside
// `takedown.spec.ts` ([`storeReconcileCases`]), which owns the content provider's stand-in that every hourly pass reads,
// and use D1's stand-in under its second account, the reconcile's own (`?account=reconcile`), so `app-store.spec.ts`,
// which owns the first, never sees them.

const GONE_SPAN_MS = 10 * 60 * 1000;

export function storeReconcileCases(h: Helpers) {
  describe("the store reconcile: rooms' records of their stores against D1's list", () => {
    const stores = (path: string, body?: unknown) =>
      fetch(`https://stores-fake.example.com${path}?account=reconcile`, { method: "POST", body: JSON.stringify(body ?? {}) }).then((res) => res.json() as Promise<any>);
    const newName = () => `podster-store-${crypto.randomUUID().replace(/-/g, "")}`;
    /** Databases in the reconcile's account, by name: the ID D1 gave each. */
    async function seed(names: string[]): Promise<Record<string, string>> {
      const { databases } = await stores("/seed", { names });
      return Object.fromEntries((databases as { uuid: string; name: string }[]).map((db) => [db.name, db.uuid]));
    }
    async function fresh() {
      await h.fresh();
      await stores("/reset");
      await h.inModeration((sql) => {
        for (const table of ["store_walk", "store_listed", "store_claim", "store_unanswered", "store_gone_read"]) sql.exec(`DELETE FROM ${table}`);
        sql.exec("DROP TABLE IF EXISTS test_store_clock");
      });
    }
    /** A room's record of its label's store, as `release_store.rs` leaves one: made with an ID, or a name only. */
    const record = (room: string, label: string, name: string, opts: { id?: string; sent?: number | null; owed?: boolean } = {}) => h.inRoom(room, (sql) => sql.exec(
      "INSERT INTO app_store (label, kind, store_name, store_id, recorded_at, create_sent_at, made_at, delete_owed_at, delete_cause, updated_at) VALUES (?, 'd1', ?, ?, 1, ?, ?, ?, ?, 1)",
      label, name, opts.id ?? null, opts.sent === undefined ? 1 : opts.sent, opts.id ? 2 : null, opts.owed ? 3 : null, opts.owed ? "test" : null));
    const rowOf = (room: string, label: string) => h.one(room, "SELECT store_name, store_id, create_sent_at, made_at FROM app_store WHERE label = ?", label);
    const told = async () => (await h.findings()).filter((f) => f.code.startsWith("store_")).map((f) => `${f.code} ${f.subject}`).sort();
    const pass = async () => (await h.reconcile("scripts")).stores;
    const d1Calls = async (op: string) => ((await stores("/state")).calls as { op: string; key: string }[]).filter((call) => call.op === op).map((call) => call.key);
    const walkRow = () => h.inModeration((sql) => sql.exec("SELECT cursor, walk, whole, unwhole FROM store_walk").one());
    /** The store reconcile's own question, asked of a room directly, as the pass asks it. */
    const ask = (room: string, body: object) => h.stub(room).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify({ kind: "store", ...body }) }).then((r: Response) => r.json() as Promise<any>);
    /** Each pass asks at most this many labels, so a walk takes several passes. */
    const batch = (n: number) => h.inModeration((sql) => {
      sql.exec("CREATE TABLE IF NOT EXISTS test_reconcile_budget (name TEXT, ms INTEGER)");
      sql.exec("DELETE FROM test_reconcile_budget WHERE name = 'stores_batch'");
      sql.exec("INSERT INTO test_reconcile_budget (name, ms) VALUES ('stores_batch', ?)", n);
    });
    /** Apps in the order the walk reaches their labels. */
    async function apps(n: number) {
      const made = [];
      for (let i = 0; i < n; i++) made.push(await h.app({ plain: true }));
      return made.sort((x, y) => (x.label < y.label ? -1 : 1));
    }

    it("tells operators of a Podster-named store no room records, only at the end of a whole walk after the one it was first listed in, and deletes nothing", async () => {
      await fresh();
      const a = await h.app({ plain: true });
      const [own, orphan] = [newName(), newName()];
      const ids = await seed([own, orphan, "app-db", "podster-store-xyz"]);
      await record(a.room, a.label, own, { id: ids[own] });
      // First listed in the first walk: its room may not have recorded it when asked.
      expect(await pass()).toMatchObject({ code: "ok", listed: 3, orphans: 0, unanswered: 0, errors: 0 });
      expect(await told()).toEqual([]);
      // The next walk: every Podster-named store no room recorded is told, its own and other databases not.
      expect(await pass()).toMatchObject({ code: "ok", orphans: 2 });
      expect(await told()).toEqual([`store_orphan ${orphan}`, "store_orphan podster-store-xyz"].sort());
      // Nothing was deleted, nor read: the list said each was there.
      expect(await d1Calls("delete")).toEqual([]);
      expect(await d1Calls("read")).toEqual([]);
      expect(((await stores("/state")).databases as unknown[]).length).toBe(4);
      // A room that records it later takes it off the record.
      const b = await h.app({ plain: true });
      await record(b.room, b.label, orphan, { id: ids[orphan] });
      await pass();
      expect(await told()).toEqual(["store_orphan podster-store-xyz"]);
    });

    it("decides nothing on a list that isn't whole, and tells operators once for the pass", async () => {
      await fresh();
      await h.app({ plain: true });
      const orphan = newName();
      await seed([orphan]);
      await stores("/fault", { op: "list", kind: "noInfo", times: 2 });
      for (let n = 0; n < 2; n++) expect(await pass()).toMatchObject({ code: "list_unread", asked: 0, orphans: 0 });
      expect(await told()).toEqual(["store_list_unread d1"]);
      expect(await h.inModeration((sql) => sql.exec("SELECT count(*) AS n FROM store_listed").one().n)).toBe(0);
      // Whole again: the finding goes, and the orphan is told only at the end of the walk after the one it was listed in.
      expect(await pass()).toMatchObject({ code: "ok", orphans: 0 });
      expect(await told()).toEqual([]);
      expect(await pass()).toMatchObject({ code: "ok", orphans: 1 });
      expect(await told()).toEqual([`store_orphan ${orphan}`]);
    });

    it("decides no orphan in a walk a room didn't answer, and from the third such walk in a row names its label", async () => {
      await fresh();
      const a = await h.app({ plain: true });
      const orphan = newName();
      await seed([orphan]);
      await h.inRoom(a.room, (sql) => sql.exec("CREATE TABLE test_store_question_fails (x INTEGER)"));
      for (let n = 1; n <= 2; n++) {
        expect(await pass()).toMatchObject({ code: "ok", unanswered: 1, orphans: 0 });
        expect(await told(), `walk ${n}`).toEqual([]);
      }
      expect(await pass()).toMatchObject({ code: "ok", unanswered: 1, orphans: 0 });
      expect(await told()).toEqual([`store_walk_unwhole ${a.label}`]);
      expect((await walkRow()).unwhole).toBe(3);
      // The control: answered, the next walk tells the orphan, and the walk's finding goes.
      await h.inRoom(a.room, (sql) => sql.exec("DROP TABLE test_store_question_fails"));
      expect(await pass()).toMatchObject({ code: "ok", unanswered: 0, orphans: 1 });
      expect(await told()).toEqual([`store_orphan ${orphan}`]);
      expect((await walkRow()).unwhole).toBe(0);
    });

    it("never sets a live store's claim back to an older walk when a pass that began in it answers after the walk ended", async () => {
      await fresh();
      const [one, two] = await apps(2);
      const [live, orphan] = [newName(), newName()];
      const ids = await seed([live, orphan]);
      await record(two.room, two.label, live, { id: ids[live] });
      await batch(1);
      // Walk 1 reaches the first label.
      await pass();
      expect(await walkRow()).toMatchObject({ walk: 1, cursor: one.label });
      // The next pass asks the second label's room, which, before it answers, has four more passes run: the second label
      // in walk 1, walk 1's end, and both labels in walk 2.
      await h.inRoom(two.room, (sql) => { sql.exec("CREATE TABLE test_reenter_store_pass (passes INTEGER)"); sql.exec("INSERT INTO test_reenter_store_pass VALUES (4)"); });
      await pass();
      expect(await walkRow()).toMatchObject({ walk: 2, cursor: two.label });
      expect(await h.inModeration((sql) => sql.exec("SELECT walk FROM store_claim WHERE name = ?", live).one().walk)).toBe(2);
      // Walk 2 ends: the live store was seen in it, and only the store no room records is told.
      expect(await pass()).toMatchObject({ orphans: 1 });
      expect(await told()).toEqual([`store_orphan ${orphan}`]);
    });

    it("moves the walk on only from where a pass found it, when two passes overlap", async () => {
      await fresh();
      const [one, two, three] = await apps(3);
      await batch(1);
      await pass();
      expect(await walkRow()).toMatchObject({ walk: 1, cursor: one.label });
      // While the second label's room answers, two more passes reach the second label and the third.
      await h.inRoom(two.room, (sql) => { sql.exec("CREATE TABLE test_reenter_store_pass (passes INTEGER)"); sql.exec("INSERT INTO test_reenter_store_pass VALUES (2)"); });
      await pass();
      // The pass that found the cursor at the first label doesn't move it back to the second.
      expect(await walkRow()).toMatchObject({ walk: 1, cursor: three.label });
    });

    it("tells operators of a made store D1 says is gone only on its own not-found, read twice at least ten minutes apart", async () => {
      await fresh();
      const [a, c] = [await h.app({ plain: true }), await h.app({ plain: true })];
      const [gone, owed] = [newName(), newName()];
      const [goneId, owedId] = [crypto.randomUUID(), crypto.randomUUID()];
      await record(a.room, a.label, gone, { id: goneId });
      // Owed a deletion: S4's, never read here.
      await record(c.room, c.label, owed, { id: owedId, owed: true });
      const T = 1_000_000_000;
      const at = (now: number) => h.inModeration((sql) => { sql.exec("CREATE TABLE IF NOT EXISTS test_store_clock (now INTEGER)"); sql.exec("DELETE FROM test_store_clock"); sql.exec("INSERT INTO test_store_clock VALUES (?)", now); });
      const goneRows = () => h.inModeration((sql) => sql.exec("SELECT label, first_gone_at FROM store_gone_read").toArray());
      await at(T);
      expect(await pass()).toMatchObject({ code: "ok", made_gone: 0 });
      expect(await d1Calls("read")).toEqual([goneId]);
      expect(await goneRows()).toEqual([{ label: a.label, first_gone_at: T }]);
      // Read gone again at the same time, and one millisecond short of ten minutes on: too soon.
      for (const now of [T, T + GONE_SPAN_MS - 1]) {
        await at(now);
        expect(await pass(), String(now - T)).toMatchObject({ made_gone: 0 });
        expect(await told()).toEqual([]);
      }
      // Ten minutes on to the millisecond: told.
      await at(T + GONE_SPAN_MS);
      expect(await pass()).toMatchObject({ made_gone: 1 });
      expect(await told()).toEqual([`store_made_gone ${gone}`]);
      // Nothing deleted, nothing written in the room.
      expect(await d1Calls("delete")).toEqual([]);
      expect(await rowOf(a.room, a.label)).toMatchObject({ store_id: goneId, made_at: 2 });
      // Listed again: forgotten, and the finding taken away.
      await stores("/seed", { entries: [{ uuid: goneId, name: gone }] });
      await pass();
      expect(await goneRows()).toEqual([]);
      expect(await told()).toEqual([]);
      await h.inModeration((sql) => sql.exec("DROP TABLE test_store_clock"));
    });

    it("notes nothing on a read that isn't D1's own not-found", async () => {
      await fresh();
      const a = await h.app({ plain: true });
      const id = crypto.randomUUID();
      await record(a.room, a.label, newName(), { id });
      for (const kind of ["notFoundOtherCode", "notFoundTwoCodes", "notFoundSuccessMissing", "codeText", "lost"]) {
        await stores("/fault", { op: "read", kind, times: 1 });
        expect(await pass(), kind).toMatchObject({ code: "ok", made_gone: 0 });
        expect(await h.inModeration((sql) => sql.exec("SELECT count(*) AS n FROM store_gone_read").one().n), kind).toBe(0);
      }
      // The control: D1's own not-found is noted.
      await pass();
      expect(await h.inModeration((sql) => sql.exec("SELECT count(*) AS n FROM store_gone_read").one().n)).toBe(1);
    });

    it("settles a name with no ID, its create outstanding, that the list shows: the room records the listed ID itself", async () => {
      await fresh();
      const [a, c] = [await h.app({ plain: true }), await h.app({ plain: true })];
      const [sent, unlisted] = [newName(), newName()];
      const ids = await seed([sent]);
      await record(a.room, a.label, sent);
      await record(c.room, c.label, unlisted);
      expect(await pass()).toMatchObject({ code: "ok", settled: 1, orphans: 0 });
      expect(await rowOf(a.room, a.label)).toMatchObject({ store_name: sent, store_id: ids[sent], create_sent_at: 1 });
      expect((await rowOf(a.room, a.label)).made_at).toBeGreaterThan(2);
      // Not listed: the release job's to settle, left as it was.
      expect(await rowOf(c.room, c.label)).toEqual({ store_name: unlisted, store_id: null, create_sent_at: 1, made_at: null });
      expect(await told()).toEqual([`store_id_settled ${sent}`]);
      // Settled once: the next passes find it listed as recorded, and no store is an orphan.
      expect(await pass()).toMatchObject({ settled: 0, orphans: 0, made_gone: 0 });
      expect(await pass()).toMatchObject({ settled: 0, orphans: 0 });
      expect(await d1Calls("read")).toEqual([]);
      expect((await h.findings()).find((f) => f.code === "store_id_settled")?.seen).toBe(1);
    });

    it("never adopts a name whose create settling had cleared, and tells operators it reappeared", async () => {
      await fresh();
      const a = await h.app({ plain: true });
      const cleared = newName();
      const ids = await seed([cleared]);
      await record(a.room, a.label, cleared, { sent: null });
      expect(await pass()).toMatchObject({ code: "ok", settled: 0, reappeared: 1 });
      expect(await rowOf(a.room, a.label)).toEqual({ store_name: cleared, store_id: null, create_sent_at: null, made_at: null });
      expect(await told()).toEqual([`store_name_reappeared ${cleared}`]);
      // Asked directly to settle it, the room records nothing either.
      expect(await ask(a.room, { label: a.label, settle: { name: cleared, id: ids[cleared] } })).toMatchObject({ known: true, settled: false, store: { id: null } });
      // A later release asks for the store and sends its create again under the same name: the list then settles it,
      // and the reappeared finding is taken away (the deep re-review of PR #423, a low item).
      await h.inRoom(a.room, (sql) => sql.exec("UPDATE app_store SET create_sent_at = 5 WHERE label = ?", a.label));
      expect(await pass()).toMatchObject({ settled: 1, reappeared: 0 });
      expect(await rowOf(a.room, a.label)).toMatchObject({ store_id: ids[cleared] });
      expect(await told()).toEqual([`store_id_settled ${cleared}`]);
    });

    it("answers settled only when this answer recorded the ID", async () => {
      await fresh();
      const a = await h.app({ plain: true });
      const name = newName();
      const ids = await seed([name]);
      await record(a.room, a.label, name);
      expect(await ask(a.room, { label: a.label, settle: { name, id: ids[name] } })).toMatchObject({ settled: true, store: { id: ids[name] } });
      // Already held: not settled again.
      expect(await ask(a.room, { label: a.label, settle: { name, id: ids[name] } })).toMatchObject({ settled: false, store: { id: ids[name] } });
      // An ID another of the room's records holds: nothing is recorded.
      const other = `${a.label}z`;
      const otherName = newName();
      await h.inRoom(a.room, (sql) => sql.exec("INSERT INTO app_label (label, current, created_at, retired_at) VALUES (?, NULL, 1, 1)", other));
      await record(a.room, other, otherName);
      expect(await ask(a.room, { label: other, settle: { name: otherName, id: ids[name] } })).toMatchObject({ settled: false, store: { id: null } });
    });

    it("settles nothing for a record owed a deletion, and settles it once it is owed none", async () => {
      await fresh();
      const a = await h.app({ plain: true });
      const owed = newName();
      const ids = await seed([owed]);
      await record(a.room, a.label, owed, { owed: true });
      expect(await pass()).toMatchObject({ settled: 0 });
      expect(await rowOf(a.room, a.label)).toMatchObject({ store_id: null });
      // The control: the same record owed no deletion is settled.
      await h.inRoom(a.room, (sql) => sql.exec("UPDATE app_store SET delete_owed_at = NULL, delete_cause = NULL WHERE label = ?", a.label));
      expect(await pass()).toMatchObject({ settled: 1 });
      expect(await rowOf(a.room, a.label)).toMatchObject({ store_id: ids[owed] });
    });

    it("logs nothing but codes and counts: never a store's name, its ID or a label", () => {
      const sources = JSON.parse(h.BINDINGS.TEST_API_SOURCES) as Record<string, string>;
      const source = sources["store_reconcile.rs"];
      const logs = [...source.matchAll(/console_(?:log|error|warn|debug)!\(\s*"([^"]*)",?([\s\S]*?)\);/g)];
      expect(logs.length).toBe(3);
      for (const [, format, args] of logs) {
        expect(format).not.toMatch(/name|label|id=/);
        for (const arg of args.split(",").map((a) => a.trim()).filter(Boolean)) {
          expect(arg).toMatch(/^(code|tally\.\w+|error\.code\(\)\.unwrap_or\("internal_error"\))$/);
        }
      }
      // And the room's answer, in the store's own module, logs nothing new: its one line is the release's.
      expect(sources["workspace/release_store.rs"].match(/console_(log|error|warn)!/g)?.length).toBe(1);
    });
  });
}
