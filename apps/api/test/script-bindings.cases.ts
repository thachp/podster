import { describe, expect, it, vi } from "vitest";

// Rule 3(b) (S5 of the store plan; the architect's ruling on the store, 2026-11-16): the hourly pass reads each app
// script's bindings with the scripts token, and the script's own room judges them against its record of the label's
// store. A binding it may not hold suspends the room's app as an operator's suspension does, within the deployment's
// ceiling. These run inside `takedown.spec.ts` ([`scriptBindingsCases`]), which owns the content provider's stand-in
// and lends its helpers, so they never run beside that file's resets of it.

type App = { room: string; label: string; host: string; served: string; kept: string; flight: string; queued: string };
type Finding = { code: string; subject: string; detail: string | null; seen: number };
export type Helpers = {
  BINDINGS: any;
  FAKE: { kvNamespace: string };
  app: (opts?: { plain?: boolean; epoch?: number; index?: boolean }) => Promise<App>;
  fresh: () => Promise<void>;
  reconcile: (which: "entries" | "scripts") => Promise<any>;
  fake: (path: string, body?: unknown) => Promise<Response>;
  fault: (body: object) => Promise<Response>;
  held: () => Promise<{ scripts: string[]; calls: { op: string; name: string; status: number }[] }>;
  found: () => Promise<string[]>;
  findings: () => Promise<Finding[]>;
  inRoom: <T>(id: string, fn: (sql: any) => T) => Promise<T>;
  inModeration: <T>(fn: (sql: any) => T) => Promise<T>;
  all: (room: string, query: string, ...values: unknown[]) => Promise<any[]>;
  one: (room: string, query: string, ...values: unknown[]) => Promise<any>;
  configRow: (room: string) => Promise<any>;
  serveRows: (room: string) => Promise<any[]>;
  deleteRows: (room: string) => Promise<any[]>;
  pass: (room: string) => Promise<unknown>;
  lift: (label: string) => Promise<{ status: number }>;
  switchedOn: <T>(run: () => Promise<T>) => Promise<T>;
  stub: (id: string) => any;
};

export function scriptBindingsCases(h: Helpers) {
  describe("rule 3(b): each app script's bindings", () => {
    const OWN_ID = "0123abcd-4567-89ef-0123-456789abcdef";
    const OTHER_ID = "fedcba98-7654-3210-fedc-ba9876543210";
    let stores = 0;
    /** A store record for a label of the room, made, with this ID; as `release_store.rs` would leave one. */
    const recordStore = (room: string, label: string, id: string) => h.inRoom(room, (sql) => sql.exec(
      "INSERT INTO app_store (label, kind, store_name, store_id, recorded_at, create_sent_at, made_at, updated_at) VALUES (?, 'd1', ?, ?, 1, 1, 2, 2)",
      label, `podster-store-${(++stores).toString(16).padStart(8, "0")}${crypto.randomUUID().replace(/-/g, "")}`.slice(0, 46), id));
    const storeBinding = (id: string) => ({ type: "d1", name: "STORE", id });
    /** Every pass starts from nothing, the ceiling's hour and the unread counts included. */
    async function fresh() {
      await h.fresh();
      await h.inModeration((sql) => { sql.exec("DELETE FROM binding_suspension"); sql.exec("DELETE FROM binding_unread"); });
    }
    /** An app serving one script, with a store record, whose served script the stand-in says holds `list`. */
    async function bound(list: unknown, opts: { record?: string | null } = {}) {
      await fresh();
      const a = await h.app({ plain: true });
      if (opts.record !== null) await recordStore(a.room, a.label, opts.record ?? OWN_ID);
      await h.fake("/reset", {});
      await h.fake("/seed", { scripts: [a.kept, a.served], entries: { [a.host]: a.served }, bindings: { [a.served]: list } });
      return a;
    }
    const labelRow = (a: App, label = a.label) => h.one(a.room, "SELECT label, current, suspended_at IS NOT NULL AS suspended, suspension_reason FROM app_label WHERE label = ?", label);
    /** The reconcile's own question about one script, asked of its room directly, as the pass asks it. */
    const ask = (room: string, script: string, extra: object) => h.stub(room).fetch("https://do/internal/takedown-check", {
      method: "POST", body: JSON.stringify({ kind: "script", script, listed_at: Date.now(), serve_entries: h.FAKE.kvNamespace, bindings_oversized: false, may_suspend: true, ...extra }),
    }).then((r: Response) => r.json() as Promise<any>);
    const lines = async (prefix: string) => (await h.found()).filter((line) => line.startsWith(prefix));
    /** A list longer than the read's bound, 256 KiB: every entry its own store, padded. */
    const padded = Array.from({ length: 3000 }, () => ({ ...storeBinding(OWN_ID), pad: "x".repeat(100) }));

    const FOREIGN: [string, unknown][] = [
      ["write_counter", [{ type: "durable_object_namespace", name: "COUNTER", class_name: "WriteCounter" }]],
      ["serve_entries", [{ type: "kv_namespace", name: "ENTRIES", namespace_id: h.FAKE.kvNamespace }]],
      ["store_foreign", [storeBinding(OTHER_ID)]],
      ["store_own_twice", [storeBinding(OWN_ID), { type: "d1", name: "DB", id: OWN_ID }]],
      ["kv_namespace", [{ type: "kv_namespace", name: "KV", namespace_id: "ab".repeat(16) }]],
      ["durable_object", [{ type: "durable_object_namespace", name: "DO", class_name: "Other" }]],
      ["other_binding", [storeBinding(OWN_ID), { type: "service", name: "API", service: "podster-api" }]],
      ["store_twice", [storeBinding(OWN_ID), storeBinding(OWN_ID)]],
      ["bindings_oversized", padded],
    ];

    for (const [code, list] of FOREIGN) {
      it(`suspends the app for what it may not hold, keeping its label, and tells operators: ${code}`, async () => {
        const a = await bound(list);
        // Another app's store is a real one: recorded by another room.
        if (code === "store_foreign") { const b = await h.app({ plain: true }); await recordStore(b.room, b.label, OTHER_ID); }
        expect(await labelRow(a)).toEqual({ label: a.label, current: 1, suspended: 0, suspension_reason: null });
        expect(await h.reconcile("scripts")).toMatchObject({ ran: true, code: "ok", changed: 1, unanswered: 0, errors: 0 });
        // An operator's suspension, by Podster: the label kept and current, the app unpublished, nothing served.
        expect(await labelRow(a)).toEqual({ label: a.label, current: 1, suspended: 1, suspension_reason: "other" });
        expect(await h.all(a.room, "SELECT cause, label FROM unpublish")).toEqual([{ cause: "app_suspended", label: a.label }]);
        expect((await h.serveRows(a.room)).map((row: any) => row.script_name)).toEqual([null]);
        expect(await h.all(a.room, "SELECT actor_id, action FROM audit_event WHERE action LIKE 'app.%'")).toEqual([{ actor_id: "podster", action: "app.suspended" }]);
        expect(await lines("script_binding_")).toEqual([`script_binding_foreign ${a.served} ${code}`]);
        expect(await h.inModeration((sql) => sql.exec("SELECT count(*) AS n FROM binding_suspension").one().n)).toBe(1);
        // The same question again: foreign, and nothing more done.
        const epoch = (await h.configRow(a.room)).release_epoch;
        expect((await ask(a.room, a.served, code === "bindings_oversized" ? { bindings: null, bindings_oversized: true } : { bindings: list })).bindings)
          .toEqual({ verdict: "foreign", foreign: code, suspended: false, held: false, suspended_since: expect.any(Number) });
        // A second pass changes nothing, uses none of the ceiling, and tells again.
        await h.fake("/seed", { scripts: [a.served], bindings: { [a.served]: list } });
        expect(await h.reconcile("scripts")).toMatchObject({ code: "ok", changed: 0 });
        expect((await h.configRow(a.room)).release_epoch).toBe(epoch);
        expect((await h.findings()).find((f) => f.code === "script_binding_foreign")?.seen).toBe(2);
        expect(await h.inModeration((sql) => sql.exec("SELECT count(*) AS n FROM binding_suspension").one().n)).toBe(1);
      });
    }

    it("suspends for a store bound while the room recorded none", async () => {
      const a = await bound([storeBinding(OWN_ID)], { record: null });
      expect(await h.reconcile("scripts")).toMatchObject({ changed: 1 });
      expect(await labelRow(a)).toMatchObject({ suspended: 1, suspension_reason: "other" });
      expect(await lines("script_binding_")).toEqual([`script_binding_foreign ${a.served} store_unrecorded`]);
    });

    it("leaves an app alone that holds nothing or its own store alone, whatever its record's state", async () => {
      for (const list of [[], [storeBinding(OWN_ID)]]) {
        const a = await bound(list);
        // Owed a deletion: a script written before still holds its own store rightly.
        await h.inRoom(a.room, (sql) => sql.exec("UPDATE app_store SET delete_owed_at = 3, delete_cause = 'test' WHERE label = ?", a.label));
        expect(await h.reconcile("scripts")).toMatchObject({ code: "ok", changed: 0, findings: 0 });
        expect(await labelRow(a)).toMatchObject({ suspended: 0 });
        expect(await h.found()).toEqual([]);
        // Read with the scripts token, which the stand-in alone accepts: answered 200.
        expect((await h.held()).calls.filter((call) => call.op === "script.bindings").map((call) => `${call.name} ${call.status}`).sort()).toEqual([`${a.kept} 200`, `${a.served} 200`].sort());
      }
    });

    it("decides nothing on what it couldn't read, and tells operators once for the pass", async () => {
      const unread: [string, () => Promise<unknown>, unknown, number][] = [
        ["no answer", () => h.fault({ op: "script.bindings", times: 2, status: 500 }), [], 2],
        ["a 404, the read lagging an upload", () => h.fault({ op: "script.bindings", times: 2, status: 404 }), [], 2],
        ["a result that isn't a list", async () => {}, { bindings: [storeBinding(OTHER_ID)] }, 1],
        ["its own store beside an entry that isn't an object", async () => {}, [storeBinding(OWN_ID), "STORE"], 1],
        ["a store binding with no name", async () => {}, [{ type: "d1", id: OTHER_ID }], 1],
        ["a store binding whose ID isn't one", async () => {}, [storeBinding(OWN_ID.toUpperCase())], 1],
      ];
      for (const [what, script, list, count] of unread) {
        const a = await bound(list);
        await script();
        expect(await h.reconcile("scripts"), what).toMatchObject({ code: "ok", changed: 0 });
        expect(await labelRow(a), what).toMatchObject({ suspended: 0 });
        expect(await h.all(a.room, "SELECT cause FROM unpublish"), what).toEqual([]);
        expect(await lines("script_binding_"), what).toEqual([]);
        expect(await h.found(), what).toContain(`script_bindings_unread namespace ${count}`);
      }
    });

    it("judges every readable entry first: a foreign one read anywhere decides, beside entries that can't be read", async () => {
      const cases: [unknown[], string][] = [
        [["STORE", storeBinding(OTHER_ID)], "store_foreign"],
        [[storeBinding(OTHER_ID), "STORE"], "store_foreign"],
        [[{ name: "NO_TYPE" }, { type: "service", name: "API" }], "other_binding"],
        [[{ type: "d1", id: OTHER_ID }, { type: "kv_namespace", namespace_id: h.FAKE.kvNamespace }], "serve_entries"],
        [[42, { class_name: "WriteCounter" }], "write_counter"],
      ];
      for (const [list, code] of cases) {
        const a = await bound(list);
        expect(await h.reconcile("scripts"), code).toMatchObject({ changed: 1 });
        expect(await labelRow(a), code).toMatchObject({ suspended: 1 });
        expect(await lines("script_binding_"), code).toEqual([`script_binding_foreign ${a.served} ${code}`]);
      }
    });

    it("tells operators by name of a script that stays unknown three passes in a row, and forgets it once judged", async () => {
      const a = await bound([storeBinding(OWN_ID), "STORE"]);
      const keep = async () => (await h.findings()).filter((f) => f.code === "script_bindings_keep_unread").map((f) => `${f.subject} ${f.detail}`);
      const passes = () => h.inModeration((sql) => sql.exec("SELECT script, passes FROM binding_unread").toArray());
      await h.reconcile("scripts");
      await h.reconcile("scripts");
      expect(await keep()).toEqual([]);
      expect(await passes()).toEqual([{ script: a.served, passes: 2 }]);
      await h.reconcile("scripts");
      expect(await keep()).toEqual([`${a.served} 3`]);
      // Judged clean: the count is forgotten, and a later unknown starts again at one.
      await h.fake("/seed", { bindings: { [a.served]: [storeBinding(OWN_ID)] } });
      await h.reconcile("scripts");
      expect(await passes()).toEqual([]);
      await h.fake("/seed", { bindings: { [a.served]: ["STORE"] } });
      await h.reconcile("scripts");
      expect(await passes()).toEqual([{ script: a.served, passes: 1 }]);
    });

    it("suspends at most the ceiling's share in an hour, holds the rest for operators, and goes on once the hour allows", async () => {
      // A misread of the provider's answer that makes every script look foreign, in seven rooms. With 100 rooms with
      // apps the ceiling is 5 in the hour.
      await fresh();
      const apps: App[] = [];
      for (let n = 0; n < 7; n++) apps.push(await h.app({ plain: true }));
      for (const a of apps) await recordStore(a.room, a.label, crypto.randomUUID());
      for (let n = 0; n < 100; n++) {
        await h.BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at, approved_at) VALUES (?, ?, 1, 1)").bind(`ceil${n}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`, `ws_ceiling_${n}`).run();
      }
      await h.fake("/reset", {});
      await h.fake("/seed", { scripts: apps.map((a) => a.served), bindings: Object.fromEntries(apps.map((a) => [a.served, [storeBinding(OTHER_ID)]])) });
      expect(await h.reconcile("scripts")).toMatchObject({ code: "ok", changed: 5 });
      const suspended = async () => { let n = 0; for (const a of apps) n += (await labelRow(a)).suspended; return n; };
      expect(await suspended()).toBe(5);
      // Every one is told; the two held are told so, by name, with why.
      expect((await lines("script_binding_foreign")).length).toBe(7);
      const held = await lines("script_binding_held");
      expect(held.length).toBe(2);
      for (const line of held) expect(line).toMatch(/ ceiling_reached$/);
      // Within the hour, nothing more comes down.
      expect(await h.reconcile("scripts")).toMatchObject({ changed: 0 });
      expect(await suspended()).toBe(5);
      // Once the hour has passed, the two held are suspended.
      await h.inModeration((sql) => sql.exec("UPDATE binding_suspension SET at = at - 3600000"));
      expect(await h.reconcile("scripts")).toMatchObject({ changed: 2 });
      expect(await suspended()).toBe(7);
    });

    /** A binding core reads as foreign whatever the room's record says, so its script is asked with a slot at once. */
    const kv = () => ({ type: "kv_namespace", name: "KV", namespace_id: "ab".repeat(16) });
    /**
     * Two apps whose served scripts hold `first`'s and `second`'s lists (a KV binding by default), with a ceiling of one
     * (no room counted as having an app). `first` is the app whose script the pass asks about first.
     */
    async function two(lists: { first?: unknown[]; second?: unknown[] } = {}) {
      await fresh();
      const apps = [await h.app({ plain: true }), await h.app({ plain: true })];
      for (const a of apps) await recordStore(a.room, a.label, crypto.randomUUID());
      const [first, second] = [...apps].sort((x, y) => (x.served < y.served ? -1 : 1));
      await h.fake("/reset", {});
      await h.fake("/seed", { scripts: apps.map((a) => a.served), bindings: { [first.served]: lists.first ?? [kv()], [second.served]: lists.second ?? [kv()] } });
      return { first, second };
    }
    const slots = () => h.inModeration((sql) => sql.exec("SELECT count(*) AS n FROM binding_suspension").one().n);
    const kept = () => h.inModeration((sql) => sql.exec("SELECT script FROM binding_slot_kept").toArray().map((row: any) => row.script));
    const suspendedPair = async (x: App, y: App) => [(await labelRow(x)).suspended, (await labelRow(y)).suspended];

    it("never lets two passes at once suspend past the ceiling: the slot is taken when the room is asked", async () => {
      const { first, second } = await two();
      // While the first app's room is answering, a second pass runs to its end: the two overlap, in this order.
      await h.inRoom(first.room, (sql) => sql.exec("CREATE TABLE test_reenter_scripts_pass (x INTEGER)"));
      await h.reconcile("scripts");
      expect(await h.inRoom(first.room, (sql) => sql.exec("SELECT name FROM sqlite_master WHERE name = 'test_reenter_scripts_pass'").toArray())).toEqual([]);
      expect(await suspendedPair(first, second)).toEqual([1, 0]);
      expect(await slots()).toBe(1);
      expect(await lines("script_binding_held")).toEqual([`script_binding_held ${second.served} ceiling_reached`]);
    });

    it("counts a suspension whose answer was lost: the slot stays taken for the hour, and the room's next answer keeps it", async () => {
      const { first, second } = await two();
      await h.inRoom(first.room, (sql) => sql.exec("CREATE TABLE test_takedown_answer_lost (x INTEGER)"));
      expect(await h.reconcile("scripts")).toMatchObject({ unanswered: 1 });
      // The room suspended before its answer was lost; the pass counted the slot all the same, so the second waits.
      expect(await suspendedPair(first, second)).toEqual([1, 0]);
      expect(await slots()).toBe(1);
      expect(await kept()).toEqual([first.served]);
      expect(await lines("script_binding_held")).toEqual([`script_binding_held ${second.served} ceiling_reached`]);
      // The room answers again, reporting its app suspended since the slot was taken: the slot stays, so does the hold.
      expect(await h.reconcile("scripts")).toMatchObject({ unanswered: 0, changed: 0 });
      expect(await kept()).toEqual([]);
      expect(await slots()).toBe(1);
      expect(await suspendedPair(first, second)).toEqual([1, 0]);
      // The control: an hour on, the slot no longer counts, and the second comes down.
      await h.inModeration((sql) => sql.exec("UPDATE binding_suspension SET at = at - 3600000"));
      expect(await h.reconcile("scripts")).toMatchObject({ changed: 1 });
      expect((await labelRow(second)).suspended).toBe(1);
    });

    it("keeps a slot kept for a lost answer when the room's clock stamped its suspension up to a minute before the slot", async () => {
      // The deep re-review of PR #423, a low item: the room stamps its suspension by its own clock, this object the slot
      // by its own. A room a minute behind still keeps the slot; one stamped further before it frees it.
      for (const [behind, pair] of [[60_000, [1, 0]], [60_001, [1, 1]]] as const) {
        const { first, second } = await two();
        await h.inRoom(first.room, (sql) => sql.exec("CREATE TABLE test_takedown_answer_lost (x INTEGER)"));
        await h.reconcile("scripts");
        expect(await kept(), String(behind)).toEqual([first.served]);
        const at = await h.inModeration((sql) => sql.exec("SELECT at FROM binding_slot_kept").one().at as number);
        await h.inRoom(first.room, (sql) => { sql.exec("DROP TABLE IF EXISTS test_takedown_answer_lost"); sql.exec("UPDATE app_label SET suspended_at = ? WHERE label = ?", at - behind, first.label); });
        await h.reconcile("scripts");
        expect(await kept(), String(behind)).toEqual([]);
        // Kept, the second stays held for the hour; freed, it comes down in the same pass.
        expect(await suspendedPair(first, second), String(behind)).toEqual(pair);
      }
    });

    it("frees a slot kept for a lost answer once the room answers that nothing was suspended since", async () => {
      const { first, second } = await two();
      // The check fails, so nothing is suspended, and the answer is lost: the slot is kept, and the second is held.
      await h.inRoom(first.room, (sql) => { sql.exec("CREATE TABLE test_bindings_check_fails (x INTEGER)"); sql.exec("CREATE TABLE test_takedown_answer_lost (x INTEGER)"); });
      await h.reconcile("scripts");
      expect(await suspendedPair(first, second)).toEqual([0, 0]);
      expect(await kept()).toEqual([first.served]);
      expect(await lines("script_binding_held")).toEqual([`script_binding_held ${second.served} ceiling_reached`]);
      // The room answers again, clean now and suspended at no time: the slot is freed before the second is asked.
      await h.inRoom(first.room, (sql) => sql.exec("DROP TABLE test_bindings_check_fails"));
      await h.fake("/seed", { bindings: { [first.served]: [] } });
      expect(await h.reconcile("scripts")).toMatchObject({ changed: 1 });
      expect(await kept()).toEqual([]);
      expect(await suspendedPair(first, second)).toEqual([0, 1]);
      expect(await slots()).toBe(1);
    });

    it("takes no slot for an ordinary app, so its lost answer holds nothing", async () => {
      // The first holds only its own store, which only its room's record can judge: asked without a slot.
      const { first, second } = await two({ first: [storeBinding(OWN_ID)] });
      await h.inRoom(first.room, (sql) => sql.exec("UPDATE app_store SET store_id = ? WHERE label = ?", OWN_ID, first.label));
      await h.inRoom(first.room, (sql) => sql.exec("CREATE TABLE test_takedown_answer_lost (x INTEGER)"));
      expect(await h.reconcile("scripts")).toMatchObject({ unanswered: 1, changed: 1 });
      expect(await kept()).toEqual([]);
      expect(await suspendedPair(first, second)).toEqual([0, 1]);
      expect(await slots()).toBe(1);
    });

    it("asks a script whose foreign store only the room's record shows again with a slot, once the room holds it for want of one", async () => {
      const { first, second } = await two({ first: [storeBinding(OTHER_ID)], second: [storeBinding(OTHER_ID)] });
      // The rooms' log lines, to show the ceiling is said to have held only the one it did hold (the deep re-review of
      // PR #423, a low item): a first ask with no slot offered isn't held by the ceiling, and is asked again.
      const logged: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
      try {
        expect(await h.reconcile("scripts")).toMatchObject({ changed: 1 });
      } finally {
        spy.mockRestore();
      }
      expect(await suspendedPair(first, second)).toEqual([1, 0]);
      expect(await slots()).toBe(1);
      expect(await lines("script_binding_held")).toEqual([`script_binding_held ${second.served} ceiling_reached`]);
      expect(logged.filter((line) => line.includes("the ceiling held the suspension"))).toEqual(["takedown: a script holds a binding it may not, and the ceiling held the suspension: code=store_foreign"]);
      expect(logged.filter((line) => line.includes("and the app was suspended"))).toHaveLength(1);
    });

    it("gives the slot back for a room that answered without suspending", async () => {
      // Asked with a slot and already suspended: given back.
      const b = await bound([kv()]);
      expect(await h.reconcile("scripts")).toMatchObject({ changed: 1 });
      expect(await slots()).toBe(1);
      await h.fake("/seed", { scripts: [b.served], bindings: { [b.served]: [kv()] } });
      await h.inModeration((sql) => sql.exec("UPDATE binding_suspension SET at = at - 3600000"));
      expect(await h.reconcile("scripts")).toMatchObject({ changed: 0 });
      // The hour's old slot is pruned by the pass, and the new one taken for the question was given back.
      expect(await slots()).toBe(0);
    });

    it("suspends the room's app for a script left under a retired label, and the room deletes that script; a lift before it is gone is undone", async () => {
      await fresh();
      const a = await h.app({ plain: true });
      await recordStore(a.room, a.label, OWN_ID);
      const old = `old${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const leftover = `${old}.rel_${"9a".repeat(16)}`;
      await h.inRoom(a.room, (sql) => sql.exec("INSERT INTO app_label (label, current, created_at, retired_at) VALUES (?, NULL, 1, 1)", old));
      await h.BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(old, a.room).run();
      await h.fake("/reset", {});
      await h.fake("/seed", { scripts: [a.kept, a.served, leftover], entries: { [a.host]: a.served }, bindings: { [leftover]: [storeBinding(OTHER_ID)] } });
      expect(await h.reconcile("scripts")).toMatchObject({ code: "ok" });
      // The room's app is down: recorded on the retired label the finding names, and nothing served.
      expect(await labelRow(a, old)).toMatchObject({ current: null, suspended: 1, suspension_reason: "other" });
      expect((await h.serveRows(a.room)).map((row: any) => row.script_name)).toEqual([null]);
      expect(await lines("script_binding_")).toEqual([`script_binding_foreign ${leftover} store_unrecorded`]);
      // What the suspension's unpublish does, as any operator's does: the app's scripts are queued for deletion, the
      // offending one with them, by the same pass's question about it.
      expect((await h.deleteRows(a.room)).map((row: any) => row.script_name).sort()).toEqual([a.kept, a.served, leftover].sort());
      // Lifted while the offending script is still there: the next pass reads it again and suspends again.
      expect((await h.switchedOn(() => h.lift(old))).status).toBe(200);
      expect(await labelRow(a, old)).toMatchObject({ suspended: 0 });
      await h.fake("/seed", { scripts: [leftover], bindings: { [leftover]: [storeBinding(OTHER_ID)] } });
      // An hour on, so the ceiling (one, with no room counted as having an app) allows it.
      await h.inModeration((sql) => sql.exec("UPDATE binding_suspension SET at = at - 3600000"));
      expect(await h.reconcile("scripts")).toMatchObject({ changed: 1 });
      expect(await labelRow(a, old)).toMatchObject({ suspended: 1 });
      // The room's own delete job takes it away; a lift then stands.
      await h.inRoom(a.room, (sql) => sql.exec("UPDATE script_delete SET next_attempt_at = 0 WHERE gone_at IS NULL"));
      await h.pass(a.room);
      expect((await h.held()).scripts).not.toContain(leftover);
      expect((await h.switchedOn(() => h.lift(old))).status).toBe(200);
      await h.reconcile("scripts");
      expect(await labelRow(a, old)).toMatchObject({ suspended: 0 });
    });

    it("keeps the suspension, and tells operators this pass, when a later step of the room's answer fails", async () => {
      const a = await bound([storeBinding(OTHER_ID)]);
      await h.inRoom(a.room, (sql) => sql.exec("CREATE TABLE test_takedown_check_fails (x INTEGER)"));
      const summary = await h.reconcile("scripts");
      expect(summary).toMatchObject({ changed: 1 });
      expect(summary.errors).toBeGreaterThanOrEqual(1);
      expect(await labelRow(a)).toMatchObject({ suspended: 1, suspension_reason: "other" });
      expect(await lines("script_binding_")).toEqual([`script_binding_foreign ${a.served} store_foreign`]);
      // The failure is counted against the script, as a room's failure always is.
      expect(await h.inModeration((sql) => sql.exec("SELECT failures FROM reconcile_failure WHERE kind = 'script' AND subject = ?", a.served).toArray())).toEqual([{ failures: 1 }]);
      await h.inRoom(a.room, (sql) => sql.exec("DROP TABLE test_takedown_check_fails"));
    });

    it("goes on with the rest of the question when the bindings' check itself fails, and decides nothing", async () => {
      const a = await bound([storeBinding(OTHER_ID)]);
      // A script under the room's label that nothing claims: only the rest of the question queues it.
      const stray = `${a.label}.rel_${"5b".repeat(16)}`;
      await h.fake("/seed", { scripts: [stray] });
      await h.inRoom(a.room, (sql) => sql.exec("CREATE TABLE test_bindings_check_fails (x INTEGER)"));
      const summary = await h.reconcile("scripts");
      expect(summary).toMatchObject({ errors: 0, unanswered: 0 });
      expect(await labelRow(a)).toMatchObject({ suspended: 0 });
      expect(await lines("script_binding_")).toEqual([]);
      expect(await h.found()).toContain("script_bindings_unread namespace 3");
      expect((await h.deleteRows(a.room)).map((row: any) => row.script_name)).toContain(stray);
      await h.inRoom(a.room, (sql) => sql.exec("DROP TABLE test_bindings_check_fails"));
    });

    it("logs nothing but a code: never a script's name, a label, a store's ID or a binding", () => {
      const sources = JSON.parse(h.BINDINGS.TEST_API_SOURCES) as Record<string, string>;
      const room = sources["workspace/script_bindings.rs"];
      const logs = [...room.matchAll(/console_(?:log|error|warn|debug)!\(\s*"[^"]*",?([\s\S]*?)\);/g)].map((m) => m[1].trim());
      expect(logs.length).toBe(2);
      for (const args of logs) expect(args).toMatch(/^found\.code\(\),?$/);
    });
  });
}
