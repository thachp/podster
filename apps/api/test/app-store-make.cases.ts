import { env, runInDurableObject, SELF } from "cloudflare:test";
import { createHash } from "node:crypto";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmQuiet, manualAlarms } from "./alarm";
import { fakeIds } from "./fake-ids";

// M6 stage 1, S2 of the store plan: the release job makes its app's store, for a release whose manifest asks for one,
// once its recheck holds and before its upload. The room records the name it drew and when it sent the create before
// sending it; the create is sent only while the release path's gate allows (a test opens it per room with
// `test_app_store_create_open`); a lost answer is settled by a whole list read by the name; and a label never has two
// stores.
//
// These run inside `app-store.spec.ts` (`appStoreMakeCases`), which owns D1's stand-in (`fake-stores.ts`) and resets it:
// the stand-in keeps one account's databases for every spec file, so its tests must run in one file, in order. GitHub
// is `fake-github-release.ts` under this file's own repository, and the content provider's upload part keys everything
// by script name, each test's label its own. Each room's applier and delete job have no content provider, so nothing
// here asks that stand-in for anything but the upload.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; org: string };
const ORG = "org_as";
const OWNER: Who = { id: "per_as_owner", org: ORG };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: who.org, orgs: [who.org], admin_orgs: [who.org], org_since: { [who.org]: 1 } })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "idempotency-key": `as-key-${++counter}` };
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
let on = 0;
let switching: Promise<unknown> = Promise.resolve();
const inTurn = (step: () => Promise<unknown>) => (switching = switching.then(step, step));
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await inTurn(async () => { if (on++ === 0) await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_releases_on (x INTEGER)").run(); });
  try { return await run(); } finally { await inTurn(async () => { if (--on === 0) await BINDINGS.DB.prepare("DROP TABLE IF EXISTS test_releases_on").run(); }); }
}

// --- GitHub's stand-in, for this file's own repository ---------------------------------------------------------------
const IDS = fakeIds("app-store");
const REPO = IDS.id(0);
const COMMIT = "a5".repeat(20);
const DIRECTORY = "b6".repeat(20);
const github = (path: string, body?: unknown) => fetch(`https://github-release-fake.example.com${path}?repo=${REPO}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
const githubCalls = async () => ((await (await github("/state")).json()) as { calls: unknown[] }).calls.length;
const bytes = (text: string) => new TextEncoder().encode(text);
const blobSha = (content: Uint8Array) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
const sha = (n: number) => n.toString(16).padStart(40, "0");
type Entry = { path: string; mode: string; type: string; sha: string; size?: number };
function repository(files: Record<string, string>) {
  const blobs: Record<string, string> = {};
  const directory: Entry[] = [];
  const folders = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    const content = bytes(text);
    const id = blobSha(content);
    blobs[id] = Buffer.from(content).toString("base64");
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
    directory.push({ path, mode: "100644", type: "blob", sha: id, size: content.length });
  }
  let n = 0;
  for (const folder of folders) directory.push({ path: folder, mode: "040000", type: "tree", sha: sha(0xf000 + ++n) });
  const top: Entry[] = [{ path: "README.md", mode: "100644", type: "blob", sha: sha(1), size: 10 }, { path: "site", mode: "040000", type: "tree", sha: DIRECTORY }];
  return { repo: REPO, trees: { [COMMIT]: { tree: top }, [DIRECTORY]: { tree: directory } }, blobs };
}
/** An app that carries code, whose manifest says whether it asks for its store. */
const app = (store: boolean | string) => ({ "index.html": "<p>todo</p>\n", "podster-app.json": `{"main":"index.js","store":${store}}`, "worker/index.js": "export default {};\n" });
const STATIC = { "index.html": "<p>static</p>\n" };

// --- D1's stand-in ---------------------------------------------------------------------------------------------------
const stores = (path: string, body?: unknown) =>
  fetch(`https://stores-fake.example.com${path}`, { method: "POST", body: JSON.stringify(body ?? {}) }).then((res) => res.json() as Promise<any>);
const storeFault = (op: string, kind: string, times = 1) => stores("/fault", { op, kind, times });
type StoreState = { databases: { uuid: string; name: string }[]; calls: { op: string; token: string; key: string }[] };
const storeState = () => stores("/state") as Promise<StoreState>;
const creates = async () => (await storeState()).calls.filter((call) => call.op === "create");

// --- the content provider's upload stand-in --------------------------------------------------------------------------
const uploadCalls = async (script: string) =>
  ((await (await fetch(`https://content-fake.example.com/upload-state?script=${script}`)).json()) as { calls: { op: string }[] }).calls.map((call) => call.op);
/** Holds the provider's next call of one kind for this script until the test lets it go: no clock. */
async function providerGate(script: string, op: "session" | "script") {
  const at = (path: string, id?: number) => `https://content-fake.example.com/${path}?script=${script}${id === undefined ? "" : `&id=${id}`}`;
  const { id } = (await (await fetch(at("upload-gate"), { method: "POST", body: JSON.stringify({ op }) })).json()) as { id: number };
  return {
    arrived: async () => { await (await fetch(at("upload-arrived", id))).json(); },
    release: async () => { await (await fetch(at("upload-release", id))).json(); },
  };
}

// --- a room whose release is uploading --------------------------------------------------------------------------------
const REL = `rel_${"5a".repeat(16)}`;
const NEXT = `rel_${"5b".repeat(16)}`;
const PREV = `rel_${"5c".repeat(16)}`;
const TASK = "tsk_as_1";
const T = 1_900_000_000_000;
const MINUTE = 60_000;
let rooms = 0;
const made: string[] = [];
type Room = { room: string; label: string; script: string };

/**
 * A room where everything the recheck asks for holds, whose release `REL` is uploading under its own script, on the
 * release commands' clock at `T`. Its applier and delete job have no content provider; its upload has. `open` gives it
 * the test-only opening of the gate on making a store.
 */
async function uploading(opts: { open?: boolean; driver?: boolean } = {}): Promise<Room> {
  const room: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Store" })).body.id;
  made.push(room);
  await manualAlarms(stub(room));
  const n = ++rooms;
  const requester = `per_as_req_${n}`;
  const admin = `per_as_adm_${n}`;
  const label = `${IDS.tag}${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  await inRoom(room, (sql) => {
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who, ORG, role, OWNER.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `as-${n}-${label}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/store', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO, OWNER.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_as', ?, 'github', ?, 'deploy', ?, 1)", requester, REPO, OWNER.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, OWNER.id, admin);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO, COMMIT, admin);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", OWNER.id);
    const release = (id: string, state: string) => sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, ?, ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, ?, ?)`, id, COMMIT, state, label, TASK, `${label}.${id}`, id, requester, OWNER.id, T, T);
    release(PREV, "served");
    release(REL, "uploading");
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, `${label}.${PREV}`);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, `${label}.${PREV}`);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    sql.exec("CREATE TABLE test_release_upload_provider (x INTEGER)");
    sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
    sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
    if (opts.open !== false) sql.exec("CREATE TABLE test_app_store_create_open (x INTEGER)");
    if (opts.driver) {
      sql.exec("CREATE TABLE test_release_driver (from_alarm INTEGER)");
      sql.exec("INSERT INTO test_release_driver (from_alarm) VALUES (0)");
    }
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, room).run();
  return { room, label, script: `${label}.${REL}` };
}
type Answer = { status: number; body: any };
const upload = (room: string, release = REL): Promise<Answer> =>
  switchedOn(() => stub(room).fetch("https://do/internal/release-upload", { method: "POST", body: JSON.stringify({ release_id: release }) }).then(async (r: Response) => ({ status: r.status, body: (await r.json()) as any })));
const brief = (answer: Answer) => [answer.status, answer.body.state, answer.body.uploaded, answer.body.waiting ?? null, answer.body.reason ?? null];
const at = (room: string, now: number) => inRoom(room, (sql) => void sql.exec("UPDATE test_release_clock SET now = ?", now));
const record = (room: string) => inRoom(room, (sql) => sql.exec("SELECT label, kind, store_name, store_id, recorded_at, create_sent_at, made_at, updated_at FROM app_store").toArray() as any[]);
const failure = (room: string, release = REL) => inRoom(room, (sql) => sql.exec("SELECT state, failure_code FROM release WHERE id = ?", release).one());
/** Another release of the same label, uploading under its own script. */
const another = (r: Room) => inRoom(r.room, (sql) => sql.exec(
  `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
     SELECT ?, commit_sha, 'uploading', label, config_version, release_epoch, task_id, ?, ?, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at FROM release WHERE id = ?`,
  NEXT, `${r.label}.${NEXT}`, NEXT, REL));
const NAME = /^podster-store-[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function appStoreMakeCases() {
  describe("the release job makes its app's store (S2)", () => {
    beforeAll(async () => {
      key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
    });
    beforeEach(async () => {
      await stores("/reset");
      await github("/reset", {});
      // The moderation object's tables, made by its first call, then emptied.
      await moderation().fetch("https://do/release-reads", { method: "POST", body: JSON.stringify({ release_id: `rel_${"0".repeat(32)}`, reads: 1, owner_key: "room:ws_schema" }) });
      await inModeration((sql) => { sql.exec("DELETE FROM release_reads"); sql.exec("DELETE FROM release_read_owner"); });
    });
    afterEach(async () => { for (const room of made.splice(0)) await alarmQuiet(stub(room)); });

    it("makes one store for a release that asks, recording its name and the create's time before its ID, and no second for the label", async () => {
      await github("/seed", repository(app(true)));
      const r = await uploading();
      // The content provider's first call, the upload session, is held: by then the store is made and recorded.
      const gate = await providerGate(r.script, "session");
      const uploaded = upload(r.room);
      await gate.arrived();
      const [held] = await record(r.room);
      expect(held.store_id).toMatch(UUID);
      expect((await storeState()).databases).toEqual([{ uuid: held.store_id, name: held.store_name }]);
      await gate.release();
      expect(brief(await uploaded)).toEqual([200, "uploading", true, null, null]);
      const [row] = await record(r.room);
      expect(row).toEqual({ label: r.label, kind: "d1", store_name: held.store_name, store_id: held.store_id, recorded_at: T, create_sent_at: T, made_at: T, updated_at: T });
      expect(row.store_name).toMatch(NAME);
      expect((await creates()).map((call) => [call.token, call.key])).toEqual([["store", row.store_name]]);
      expect(await uploadCalls(r.script)).toContain("session");
      // A second release of the label that asks again makes none: its store is made.
      await another(r);
      expect(brief(await upload(r.room, NEXT))).toEqual([200, "uploading", true, null, null]);
      expect((await creates()).length).toBe(1);
      expect((await storeState()).databases.length).toBe(1);
      expect(await record(r.room)).toEqual([row]);
    });

    it("makes none for a release whose manifest asks for none, or doesn't say so whole, or that has no manifest", async () => {
      for (const files of [app(false), app('"true"'), STATIC]) {
        await github("/reset", {});
        await github("/seed", repository(files));
        const r = await uploading();
        expect(brief(await upload(r.room)), JSON.stringify(files)).toEqual([200, "uploading", true, null, null]);
        expect(await record(r.room)).toEqual([]);
      }
      expect((await storeState()).calls).toEqual([]);
    });

    it("sends no create while the release path's gate is closed: nothing is recorded, sent or uploaded", async () => {
      await github("/seed", repository(app(true)));
      const r = await uploading({ open: false });
      expect(brief(await upload(r.room))).toEqual([200, "uploading", false, "store_create_incomplete", null]);
      expect(await record(r.room)).toEqual([]);
      expect((await storeState()).calls).toEqual([]);
      expect(await uploadCalls(r.script)).toEqual([]);
      // The control: the same room with the gate opened makes it.
      await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_app_store_create_open (x INTEGER)"));
      expect(brief(await upload(r.room))).toEqual([200, "uploading", true, null, null]);
      expect((await creates()).length).toBe(1);
    });

    it("waits, recording and sending nothing, with no store provider", async () => {
      await github("/seed", repository(app(true)));
      const r = await uploading();
      await inRoom(r.room, (sql) => sql.exec("CREATE TABLE test_app_store_provider_off (x INTEGER)"));
      expect(brief(await upload(r.room))).toEqual([200, "uploading", false, "store_provider_missing", null]);
      expect(await record(r.room)).toEqual([]);
      expect((await storeState()).calls).toEqual([]);
    });

    it("settles a lost answer at once by a whole list, by the name, and goes on with the upload", async () => {
      await github("/seed", repository(app(true)));
      const r = await uploading();
      await storeFault("create", "lost");
      expect(brief(await upload(r.room))).toEqual([200, "uploading", true, null, null]);
      const [row] = await record(r.room);
      const { databases, calls } = await storeState();
      expect(databases).toEqual([{ uuid: row.store_id, name: row.store_name }]);
      expect(calls.map((call) => call.op)).toEqual(["create", "list"]);
    });

    it("records the name before it sends: a lost answer the list can't settle yet leaves the name, and the store is found by it", async () => {
      await github("/seed", repository(app(true)));
      const r = await uploading();
      await storeFault("create", "lost");
      await storeFault("list", "lost");
      const first = await upload(r.room);
      expect(brief(first)).toEqual([200, "uploading", false, "store_create_unanswered", null]);
      // The create went out and made it; the room holds the name it was sent under, and no ID.
      const { databases } = await storeState();
      expect(databases.length).toBe(1);
      const name = databases[0].name;
      expect(await record(r.room)).toEqual([{ label: r.label, kind: "d1", store_name: name, store_id: null, recorded_at: T, create_sent_at: T, made_at: null, updated_at: T }]);
      expect(await uploadCalls(r.script)).toEqual([]);
      // The next step, after its read, settles it by the list, finds it by the name, and uploads, with no second create.
      await at(r.room, T + MINUTE);
      expect(brief(await upload(r.room))).toEqual([200, "uploading", true, null, null]);
      expect(await record(r.room)).toEqual([{ label: r.label, kind: "d1", store_name: name, store_id: databases[0].uuid, recorded_at: T, create_sent_at: T, made_at: T + MINUTE, updated_at: T + MINUTE }]);
      expect((await creates()).length).toBe(1);
      expect((await storeState()).databases.length).toBe(1);
    });

    it("creates again only after two whole lists without the name, ten minutes apart, the first ten minutes after the create", async () => {
      await github("/seed", repository(app(true)));
      const r = await uploading();
      // A create that made nothing and whose answer was lost.
      await storeFault("create", "redirect");
      const first = await upload(r.room);
      expect(brief(first)).toEqual([200, "uploading", false, "store_create_unanswered", null]);
      expect(first.body.retry_at).toBe(T + 10 * MINUTE);
      const [{ store_name: name }] = await record(r.room);
      const step = async (now: number) => { await at(r.room, now); const answer = await upload(r.room); return [answer.body.waiting, answer.body.retry_at ?? null]; };
      // Before ten minutes from the create, a list without it counts for nothing.
      expect(await step(T + 10 * MINUTE - 1)).toEqual(["store_unsettled", T + 10 * MINUTE]);
      // The first that counts.
      expect(await step(T + 10 * MINUTE)).toEqual(["store_unsettled", T + 20 * MINUTE]);
      // A list that isn't whole decides nothing.
      await storeFault("list", "noInfo");
      expect(await step(T + 15 * MINUTE)).toEqual(["store_list_unknown", null]);
      // A second within ten minutes of the first counts for nothing.
      expect(await step(T + 20 * MINUTE - 1)).toEqual(["store_unsettled", T + 20 * MINUTE]);
      expect((await creates()).length).toBe(1);
      // The first counted list is noted as the record's last change.
      expect(await record(r.room)).toEqual([{ label: r.label, kind: "d1", store_name: name, store_id: null, recorded_at: T, create_sent_at: T, made_at: null, updated_at: T + 10 * MINUTE }]);
      // The second: the create made nothing, so it is created again at once, under the same name, recorded first
      // again, and the upload goes on.
      await at(r.room, T + 20 * MINUTE);
      expect(brief(await upload(r.room))).toEqual([200, "uploading", true, null, null]);
      const [row] = await record(r.room);
      expect(row).toEqual({ label: r.label, kind: "d1", store_name: name, store_id: row.store_id, recorded_at: T, create_sent_at: T + 20 * MINUTE, made_at: T + 20 * MINUTE, updated_at: T + 20 * MINUTE });
      expect(row.store_id).toMatch(UUID);
      expect((await creates()).map((call) => call.key)).toEqual([name, name]);
      expect((await storeState()).databases).toEqual([{ uuid: row.store_id, name }]);
    });

    it("fails the release by its code on a definite refusal, and leaves the create outstanding to be settled", async () => {
      await github("/seed", repository(app(true)));
      const r = await uploading();
      await storeFault("create", "refused");
      const answer = await upload(r.room);
      expect([answer.status, answer.body.state, answer.body.uploaded]).toEqual([200, "failed", false]);
      expect(await failure(r.room)).toEqual({ state: "failed", failure_code: "store_create_refused" });
      expect((await storeState()).databases).toEqual([]);
      expect(await record(r.room)).toEqual([{ label: r.label, kind: "d1", store_name: expect.stringMatching(NAME), store_id: null, recorded_at: T, create_sent_at: T, made_at: null, updated_at: T }]);
      expect(await uploadCalls(r.script)).toEqual([]);
    });

    it("reads D1's answer that the name is taken as unknown, and settles it by the list: the store is recorded and the release goes on", async () => {
      await github("/seed", repository(app(true)));
      const r = await uploading();
      // A create settled as having made nothing, whose store a list didn't show yet: the name is held at D1.
      const name = `podster-store-${crypto.randomUUID().replace(/-/g, "").slice(0, 31)}0`;
      await inRoom(r.room, (sql) => sql.exec("INSERT INTO app_store (label, kind, store_name, recorded_at, updated_at) VALUES (?, 'd1', ?, ?, ?)", r.label, name, T - 30 * MINUTE, T - 30 * MINUTE));
      await stores("/seed", { count: 1, prefix: name.slice(0, -1) });
      const [held] = (await storeState()).databases;
      expect(held.name).toBe(name);
      expect(brief(await upload(r.room))).toEqual([200, "uploading", true, null, null]);
      expect(await failure(r.room)).toEqual({ state: "uploading", failure_code: null });
      expect(await record(r.room)).toEqual([{ label: r.label, kind: "d1", store_name: name, store_id: held.uuid, recorded_at: T - 30 * MINUTE, create_sent_at: T, made_at: T, updated_at: T }]);
      expect((await storeState()).calls.map((call) => call.op)).toEqual(["create", "list"]);
      expect((await storeState()).databases).toEqual([held]);
    });

    it("never holds a release that asks for no store, while its label's create is outstanding and can't be settled", async () => {
      for (const why of ["list lost", "no store provider"]) {
        await github("/reset", {});
        await github("/seed", repository(STATIC));
        const r = await uploading({ driver: true });
        const name = `podster-store-${crypto.randomUUID().replace(/-/g, "")}`;
        await inRoom(r.room, (sql) => {
          sql.exec("INSERT INTO app_store (label, kind, store_name, recorded_at, create_sent_at, updated_at) VALUES (?, 'd1', ?, ?, ?, ?)", r.label, name, T - 30 * MINUTE, T - 30 * MINUTE, T - 30 * MINUTE);
          if (why === "no store provider") sql.exec("CREATE TABLE test_app_store_provider_off (x INTEGER)");
        });
        if (why === "list lost") await storeFault("list", "lost", 10);
        const slots = () => inRoom(r.room, (sql) => sql.exec("SELECT COUNT(*) AS n FROM release_upload_attempt").one().n);
        // Through the driver: a slot, the read, and the upload, with nothing asked of D1.
        const passed = await switchedOn(() => stub(r.room).fetch("https://do/internal/test-release-drive", { method: "POST", body: "{}" }).then((res: Response) => res.json() as Promise<any>));
        expect([passed.outcome, passed.code], why).toEqual(["next", null]);
        expect(await slots(), why).toBe(1);
        expect(await inRoom(r.room, (sql) => sql.exec("SELECT COUNT(*) AS n FROM release_upload").one().n), why).toBe(1);
        // The record is as it was: the create stays outstanding for a release that asks.
        expect(await record(r.room), why).toEqual([{ label: r.label, kind: "d1", store_name: name, store_id: null, recorded_at: T - 30 * MINUTE, create_sent_at: T - 30 * MINUTE, made_at: null, updated_at: T - 30 * MINUTE }]);
        // And by the command alone, for another static release of the label.
        await another(r);
        expect(brief(await upload(r.room, NEXT)), why).toEqual([200, "uploading", true, null, null]);
        expect((await storeState()).calls, why).toEqual([]);
        await stores("/reset");
      }
    });

    /**
     * A driven room whose release asked for its store and last waited on it (`last_code`), with its label's create
     * outstanding, sent `ago` before `T`.
     */
    async function waitingOnStore(ago: number, lastCode = "store_unsettled") {
      await github("/seed", repository(app(true)));
      const r = await uploading({ driver: true });
      const name = `podster-store-${crypto.randomUUID().replace(/-/g, "")}`;
      await inRoom(r.room, (sql) => {
        sql.exec("INSERT INTO app_store (label, kind, store_name, recorded_at, create_sent_at, updated_at) VALUES (?, 'd1', ?, ?, ?, ?)", r.label, name, T - ago, T - ago, T - ago);
        sql.exec("INSERT INTO release_job (release_id, next_attempt_at, last_code, updated_at) VALUES (?, ?, ?, ?)", REL, T, lastCode, T - ago);
      });
      const slots = () => inRoom(r.room, (sql) => sql.exec("SELECT COUNT(*) AS n FROM release_upload_attempt").one().n);
      const pass = () => switchedOn(() => stub(r.room).fetch("https://do/internal/test-release-drive", { method: "POST", body: "{}" }).then((res: Response) => res.json() as Promise<any>));
      /** Statements the room runs once at a named point of the step. */
      const atPoint = (point: string, statement: string) => inRoom(r.room, (sql) => {
        sql.exec("CREATE TABLE IF NOT EXISTS test_release_at (point TEXT, statement TEXT)");
        sql.exec("INSERT INTO test_release_at (point, statement) VALUES (?, ?)", point, statement);
      });
      return { r, name, slots, pass, atPoint };
    }

    it("settles a create outstanding first, taking no upload slot and reading nothing from GitHub, through the driver", async () => {
      const { r, name, slots, pass } = await waitingOnStore(5 * MINUTE);
      const settling = await pass();
      expect([settling.outcome, settling.code, settling.next_attempt_at]).toEqual(["retry", "store_unsettled", T + 5 * MINUTE]);
      expect(await slots()).toBe(0);
      expect(await githubCalls()).toBe(0);
      expect((await storeState()).calls.map((call) => call.op)).toEqual(["list"]);
      // The control: once the create isn't outstanding, the same pass takes a slot and reads.
      await inRoom(r.room, (sql) => sql.exec("UPDATE app_store SET create_sent_at = NULL"));
      await at(r.room, T + 5 * MINUTE);
      const uploaded = await pass();
      expect(uploaded.outcome).toBe("next");
      expect(await slots()).toBe(1);
      expect(await githubCalls()).toBeGreaterThan(0);
      expect((await creates()).map((call) => call.key)).toEqual([name]);
    });

    it("reads nothing without an upload slot when settling is no longer due by the time the step reads the record", async () => {
      const { r, slots, pass, atPoint } = await waitingOnStore(5 * MINUTE);
      // Between the lease, which took no slot to settle, and the step's own read, the create stops being outstanding.
      await atPoint("store_first", "UPDATE app_store SET create_sent_at = NULL");
      const ended = await pass();
      expect([ended.outcome, ended.code]).toEqual(["retry", "store_upload_slot_needed"]);
      expect(await slots()).toBe(0);
      expect(await githubCalls()).toBe(0);
      expect((await storeState()).calls).toEqual([]);
      // The next lease takes a slot, and the step reads and uploads.
      await at(r.room, ended.next_attempt_at);
      const uploaded = await pass();
      expect(uploaded.outcome).toBe("next");
      expect(await slots()).toBe(1);
      expect(await githubCalls()).toBeGreaterThan(0);
    });

    it("answers the lease lost when the first counted list can't be noted, and notes nothing", async () => {
      const { r, name, pass, atPoint } = await waitingOnStore(15 * MINUTE);
      // After the list, before what is written of it, the step's lease runs out.
      await atPoint("store_listed", "UPDATE test_release_clock SET now = (SELECT next_attempt_at FROM release_job)");
      const lost = await pass();
      expect([lost.outcome, lost.code]).toEqual(["retry", "release_drive_lease_lost"]);
      expect(await record(r.room)).toEqual([{ label: r.label, kind: "d1", store_name: name, store_id: null, recorded_at: T - 15 * MINUTE, create_sent_at: T - 15 * MINUTE, made_at: null, updated_at: T - 15 * MINUTE }]);
      // The control: the same list with the lease holding is noted.
      await inRoom(r.room, (sql) => sql.exec("UPDATE test_release_clock SET now = ?", lost.next_attempt_at));
      const noted = await pass();
      expect([noted.outcome, noted.code]).toEqual(["retry", "store_unsettled"]);
      expect((await record(r.room))[0].updated_at).toBe(lost.next_attempt_at);
    });

    it("lets no file but the store's own module write the room's record of its store", () => {
      const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
      // While a create is outstanding, the record's `updated_at` is when the first counted list without it was read:
      // any other writer would move it. S4's schema step adds `first_gone_at`.
      const writes = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+app_store\b/i;
      const writers = Object.entries(sources).filter(([, source]) => writes.test(source)).map(([path]) => path);
      expect(writers).toEqual(["workspace/release_store.rs"]);
    });

    it("is gated by the release path's constant alone, and logs only IDs and codes", () => {
      const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
      const source = sources["workspace/release_store.rs"];
      const gate = source.slice(source.indexOf("fn store_create_open"), source.indexOf("fn store_provider"));
      expect(gate).toContain("if release_commit::RELEASE_PATH_COMPLETE {\n            return true;\n        }");
      expect(gate).toMatch(/#\[cfg\(feature = "failpoints"\)\]\n\s+\{\n\s+rows\(\n[^]*test_app_store_create_open/);
      expect(gate).toMatch(/#\[cfg\(not\(feature = "failpoints"\)\)\]\n\s+\{\n\s+false\n\s+\}/);
      // The create is sent in one place, after the record's transaction.
      expect(source.match(/provider\.create\(/g)?.length).toBe(1);
      expect(source.indexOf("INSERT INTO app_store")).toBeLessThan(source.indexOf("provider.create("));
      // One log line, by the room's and the release's IDs and a code.
      const logs = source.match(/console_(log|error|warn)!\([^;]*;/g) ?? [];
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('"release: the app\'s store: room={} release={} code={}"');
    });
  });
}
