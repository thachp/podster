import { describe, expect, it } from "vitest";
import type { Helpers } from "./script-bindings.cases";

// The store reconcile (S5 of the store plan, its second PR): the hourly pass reads the whole list of D1's databases
// with the store token and asks each label's room for its record of that label's store. It tells operators of a
// Podster-named store no room records, of a made store D1 says is gone, and settles a name with no ID that the list
// shows, which the room records itself. It deletes nothing. These run inside `takedown.spec.ts`
// ([`storeReconcileCases`]), which owns the content provider's stand-in that every hourly pass reads, and use D1's
// stand-in under its second account, the reconcile's own (`?account=reconcile`), so `app-store.spec.ts`, which owns the
// first, never sees them.

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
      await h.inModeration((sql) => { for (const table of ["store_walk", "store_listed", "store_claim", "store_gone_read"]) sql.exec(`DELETE FROM ${table}`); });
    }
    /** A room's record of its label's store, as `release_store.rs` leaves one: made with an ID, or a name only. */
    const record = (room: string, label: string, name: string, opts: { id?: string; sent?: number | null; owed?: boolean } = {}) => h.inRoom(room, (sql) => sql.exec(
      "INSERT INTO app_store (label, kind, store_name, store_id, recorded_at, create_sent_at, made_at, delete_owed_at, delete_cause, updated_at) VALUES (?, 'd1', ?, ?, 1, ?, ?, ?, ?, 1)",
      label, name, opts.id ?? null, opts.sent === undefined ? 1 : opts.sent, opts.id ? 2 : null, opts.owed ? 3 : null, opts.owed ? "test" : null));
    const rowOf = (room: string, label: string) => h.one(room, "SELECT store_name, store_id, create_sent_at, made_at FROM app_store WHERE label = ?", label);
    const told = async () => (await h.findings()).filter((f) => f.code.startsWith("store_")).map((f) => `${f.code} ${f.subject}`).sort();
    const pass = async () => (await h.reconcile("scripts")).stores;
    const d1Calls = async (op: string) => ((await stores("/state")).calls as { op: string; key: string }[]).filter((call) => call.op === op).map((call) => call.key);

    it("tells operators of a Podster-named store no room records, only after a whole walk that began after it was listed, and deletes nothing", async () => {
      await fresh();
      const a = await h.app({ plain: true });
      const [own, orphan] = [newName(), newName()];
      const ids = await seed([own, orphan, "app-db", "podster-store-xyz"]);
      await record(a.room, a.label, own, { id: ids[own] });
      // The first walk began before these were first listed: its room may not have recorded one yet.
      expect(await pass()).toMatchObject({ code: "ok", listed: 3, orphans: 0, unanswered: 0, errors: 0 });
      expect(await told()).toEqual([]);
      // The next walk began after: every Podster-named store no room recorded is told, its own and other databases not.
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
      // Whole again: the finding goes, and the orphan is told only once a walk that began after it was listed ends.
      expect(await pass()).toMatchObject({ code: "ok", orphans: 0 });
      expect(await told()).toEqual([]);
      expect(await pass()).toMatchObject({ code: "ok", orphans: 1 });
      expect(await told()).toEqual([`store_orphan ${orphan}`]);
    });

    it("decides no orphan in a walk a room didn't answer", async () => {
      await fresh();
      const a = await h.app({ plain: true });
      const orphan = newName();
      await seed([orphan]);
      await h.inRoom(a.room, (sql) => sql.exec("CREATE TABLE test_store_question_fails (x INTEGER)"));
      expect(await pass()).toMatchObject({ code: "ok", unanswered: 1, orphans: 0 });
      expect(await pass()).toMatchObject({ code: "ok", unanswered: 1, orphans: 0 });
      expect(await told()).toEqual([]);
      // The control: answered, the next walk tells it.
      await h.inRoom(a.room, (sql) => sql.exec("DROP TABLE test_store_question_fails"));
      expect(await pass()).toMatchObject({ code: "ok", unanswered: 0, orphans: 1 });
      expect(await told()).toEqual([`store_orphan ${orphan}`]);
    });

    it("tells operators of a made store D1 says is gone only on its own not-found, read twice at least ten minutes apart", async () => {
      await fresh();
      const [a, c] = [await h.app({ plain: true }), await h.app({ plain: true })];
      const [gone, owed] = [newName(), newName()];
      const [goneId, owedId] = [crypto.randomUUID(), crypto.randomUUID()];
      await record(a.room, a.label, gone, { id: goneId });
      // Owed a deletion: S4's, never read here.
      await record(c.room, c.label, owed, { id: owedId, owed: true });
      const goneRows = () => h.inModeration((sql) => sql.exec("SELECT label FROM store_gone_read").toArray().map((row: any) => row.label));
      expect(await pass()).toMatchObject({ code: "ok", made_gone: 0 });
      expect(await d1Calls("read")).toEqual([goneId]);
      expect(await goneRows()).toEqual([a.label]);
      // Read gone again at once: too soon.
      expect(await pass()).toMatchObject({ made_gone: 0 });
      expect(await told()).toEqual([]);
      // The edge is core's, tested to the millisecond there. Here the first read is moved back ten minutes, and the
      // next read counts.
      await h.inModeration((sql) => sql.exec("UPDATE store_gone_read SET first_gone_at = first_gone_at - 600000 WHERE label = ?", a.label));
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

    it("settles a name with no ID that the list shows: the room records the listed ID itself", async () => {
      await fresh();
      const [a, b, c] = [await h.app({ plain: true }), await h.app({ plain: true }), await h.app({ plain: true })];
      const [sent, cleared, unlisted] = [newName(), newName(), newName()];
      const ids = await seed([sent, cleared]);
      await record(a.room, a.label, sent);
      // A create settling had cleared, as having made nothing, that D1 lists after all.
      await record(b.room, b.label, cleared, { sent: null });
      await record(c.room, c.label, unlisted);
      const done = await pass();
      expect(done).toMatchObject({ code: "ok", settled: 2, orphans: 0 });
      expect(await rowOf(a.room, a.label)).toMatchObject({ store_name: sent, store_id: ids[sent], create_sent_at: 1 });
      expect((await rowOf(a.room, a.label)).made_at).toBeGreaterThan(2);
      expect(await rowOf(b.room, b.label)).toMatchObject({ store_name: cleared, store_id: ids[cleared], create_sent_at: 1 });
      // Not listed: the release job's to settle, left as it was.
      expect(await rowOf(c.room, c.label)).toEqual({ store_name: unlisted, store_id: null, create_sent_at: 1, made_at: null });
      expect(await told()).toEqual([`store_id_settled ${sent}`, `store_id_settled ${cleared}`].sort());
      // Settled once: the next pass finds each listed as recorded, and no store is an orphan.
      expect(await pass()).toMatchObject({ settled: 0, orphans: 0, made_gone: 0 });
      expect(await d1Calls("read")).toEqual([]);
    });

    it("settles nothing for a record owed a deletion, or for an ID another of the room's records holds", async () => {
      await fresh();
      const a = await h.app({ plain: true });
      const owed = newName();
      const ids = await seed([owed]);
      await record(a.room, a.label, owed, { owed: true });
      expect(await pass()).toMatchObject({ settled: 0 });
      expect(await rowOf(a.room, a.label)).toMatchObject({ store_id: null });
      // Asked directly with an ID the room already holds for another label: nothing is recorded.
      const other = `${a.label}z`;
      await h.inRoom(a.room, (sql) => sql.exec("INSERT INTO app_label (label, current, created_at, retired_at) VALUES (?, NULL, 1, 1)", other));
      await record(a.room, other, newName(), { id: ids[owed] });
      await h.inRoom(a.room, (sql) => sql.exec("UPDATE app_store SET delete_owed_at = NULL, delete_cause = NULL WHERE label = ?", a.label));
      const asked = await h.stub(a.room).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify({ kind: "store", label: a.label, settle: { name: owed, id: ids[owed] } }) }).then((r: Response) => r.json() as Promise<any>);
      expect(asked).toMatchObject({ known: true, settled: false, store: { name: owed, id: null } });
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
