import { env, runInDurableObject, SELF } from "cloudflare:test";
import { createHash } from "node:crypto";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet, manualAlarms } from "./alarm";
import { fakeIds } from "./fake-ids";

// M8 step 6, the API side of workroom previews (docs/m8-preview-plan.md, 3.1 to 3.4 and 9.1; decisions 250 to 259):
// `requestPreview`, `getPreview` and `deletePreview`; the release job with an environment; the preview applier writing
// only `preview:` entries; the preview namespace's scripts; the triggers of the plan's 3.3; and the reconciles over both
// namespaces. **Production is held untouched throughout:** each room serves a production release whose rows, entry and
// namespace every test compares before and after.
//
// This file has a partition of the content provider's stand-in of its own (`preview` in `vitest.config.ts`), with a
// preview dispatch namespace beside its production one, so every call can be told by the namespace it named. The
// driver runs one pass at a time on `/internal/test-release-drive`, on the release commands' clock
// (`test_release_clock`); the room's alarm, run by the test, runs the appliers and the label index.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string; control: string; namespace: string; previewNamespace: string };
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; linker?: { person: string; since: number } };
const ORG = "org_pw";
const OWNER: Who = { id: "per_pw_owner", kind: "person", org: ORG, adminOrgs: [ORG] };
const ADMIN: Who = { id: "per_pw_admin", kind: "person", org: ORG };
const MEMBER: Who = { id: "per_pw_member", kind: "person", org: ORG };
const AGENT: Who = { id: "agt_pw_agent", kind: "agent", org: ORG };
const OUTSIDER: Who = { id: "per_pw_outsider", kind: "person", org: "org_pw_other" };
const OPERATOR: Who = { id: "per_operator_one", kind: "person", org: "org_ops" };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const claims = who.kind === "agent"
    ? { kind: "agent", org: who.org, gen: 1, ...(who.linker ? { linker: who.linker } : {}) }
    : { kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, idempotency?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "idempotency-key": idempotency ?? `pw-key-${++counter}` };
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const all = (id: string, query: string, ...bindings: unknown[]) => inRoom(id, (sql) => sql.exec(query, ...bindings).toArray());
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;

// --- the deployment's switches, made and dropped by each test that needs them ---------------------------------------
async function switches(on: { releases?: boolean; previews?: boolean | string }) {
  for (const table of ["test_releases_on", "test_previews_on", "test_previews_setting"]) await BINDINGS.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  if (on.releases) await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  if (on.previews === true) await BINDINGS.DB.prepare("CREATE TABLE test_previews_on (x INTEGER)").run();
  if (typeof on.previews === "string") {
    await BINDINGS.DB.prepare("CREATE TABLE test_previews_setting (value TEXT)").run();
    await BINDINGS.DB.prepare("INSERT INTO test_previews_setting (value) VALUES (?)").bind(on.previews).run();
  }
}

// --- GitHub's stand-in, for this file's own repository ---------------------------------------------------------------
const IDS = fakeIds("preview");
const REPO = IDS.id(0);
const COMMIT_A = "a5".repeat(20);
const COMMIT_B = "b5".repeat(20);
const DIR_A = "da".repeat(20);
const DIR_B = "db".repeat(20);
// B's page names browser storage, so its build carries the storage warning (M8 step 9; the plan's 5.2.1). A's doesn't.
const B_PAGE = "<p>preview B</p><script>localStorage.setItem('seen', '1')</script>\n";
const github = (path: string, body?: unknown) => fetch(`https://github-release-fake.example.com${path}?repo=${REPO}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
const bytes = (text: string) => new TextEncoder().encode(text);
const blobSha = (content: Uint8Array) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
const sha = (n: number) => n.toString(16).padStart(40, "0");
function tree(files: Record<string, string>, blobs: Record<string, string>) {
  return Object.entries(files).map(([path, text]) => {
    const content = bytes(text);
    blobs[blobSha(content)] = Buffer.from(content).toString("base64");
    return { path, mode: "100644", type: "blob", sha: blobSha(content), size: content.length };
  });
}
function repository() {
  const blobs: Record<string, string> = {};
  const top = (dir: string) => ({ tree: [{ path: "README.md", mode: "100644", type: "blob", sha: sha(1), size: 10 }, { path: "site", mode: "040000", type: "tree", sha: dir }] });
  return {
    repo: REPO,
    trees: { [COMMIT_A]: top(DIR_A), [COMMIT_B]: top(DIR_B), [DIR_A]: { tree: tree({ "index.html": "<p>preview A</p>\n" }, blobs) }, [DIR_B]: { tree: tree({ "index.html": B_PAGE }, blobs) } },
    blobs,
  };
}

// --- the provider's stand-in: this partition's namespaces, entries and app hosts ---------------------------------------
const control = (path: string, body?: unknown, query = "") =>
  fetch(`https://${FAKE.control}${path}${query}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
type Call = { op: string; name: string; status: number; namespace?: "production" | "preview" };
const fakeState = async () => (await (await control("/state")).json()) as { scripts: string[]; previewScripts: string[]; entries: Record<string, string>; calls: Call[] };
const serveMarker = (host: string, script: string) => control("/marker-serve", { script }, `?host=${host}`);
const uploadState = async (script: string) => (await (await control("/upload-state", undefined, `?script=${script}`)).json()) as { namespaces: string[]; written: unknown };

// --- a room with a production release served, and two merged tasks a preview may show --------------------------------
const PROD = `rel_${"7e".repeat(16)}`;
const TASK_A = "tsk_pw_a";
const TASK_B = "tsk_pw_b";
// The release commands' clock, set before the Worker's own, so what the room queues at it is due to the alarm at once.
const T = 1_750_000_000_000;
const made: string[] = [];
let rooms = 0;
type Room = { id: string; prodLabel: string; prodHost: string; prodScript: string };

async function room(opts: { visibility?: "public" | "private" } = {}): Promise<Room> {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Preview room" })).body.id;
  made.push(id);
  await manualAlarms(stub(id));
  const n = ++rooms;
  const prodLabel = `${IDS.tag}${n.toString(36)}p${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const prodHost = `${prodLabel}.${FAKE.domain}`;
  const prodScript = `${prodLabel}.${PROD}`;
  await inRoom(id, (sql) => {
    for (const [who, role] of [[ADMIN, "admin"], [MEMBER, "member"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who.id, ORG, role, OWNER.id);
    sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'agent', ?, 'admin', ?, 1)", AGENT.id, ORG, OWNER.id);
    if ((opts.visibility ?? "public") === "public") sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `pw-${n}-${prodLabel}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/preview', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO, OWNER.id);
    for (const [task, commit, pr] of [[TASK_A, COMMIT_A, 7], [TASK_B, COMMIT_B, 8]] as const) {
      sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", task, OWNER.id, ADMIN.id);
      sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, ?, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", task, REPO, pr, commit, ADMIN.id);
    }
    // Production: a release served on its default host, its entry confirmed written.
    sql.exec("INSERT INTO app_label (label, current, created_at, indexed_at) VALUES (?, 1, 1, 1)", prodLabel);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", OWNER.id);
    sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, served_at, updated_at)
      VALUES (?, ?, 'served', ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, 1, 1, 1)`, PROD, COMMIT_A, prodLabel, TASK_A, prodScript, PROD, OWNER.id, OWNER.id);
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", prodHost, prodLabel, PROD, prodScript);
    sql.exec("INSERT INTO release_script_kind (release_id, script_name, kind, recorded_at) VALUES (?, ?, 'static', 1)", PROD, prodScript);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", prodHost, prodScript);
    sql.exec("CREATE TABLE test_managed_repositories_on (x INTEGER)");
    sql.exec("CREATE TABLE test_release_driver (from_alarm INTEGER)");
    sql.exec("INSERT INTO test_release_driver (from_alarm) VALUES (0)");
    sql.exec("CREATE TABLE test_release_clock (now INTEGER)");
    sql.exec("INSERT INTO test_release_clock (now) VALUES (?)", T);
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(prodLabel, id).run();
  await control("/seed", { entries: { [prodHost]: prodScript }, scripts: [prodScript] });
  return { id, prodLabel, prodHost, prodScript };
}

/** Everything of production's, in the room and at the provider: compared before and after each preview action. */
async function production(r: Room) {
  const rows = await inRoom(r.id, (sql) => ({
    serve: sql.exec("SELECT * FROM serve_state ORDER BY host").toArray(),
    apply: sql.exec("SELECT * FROM serve_apply ORDER BY host").toArray(),
    config: sql.exec("SELECT kept_previous, in_flight_release, in_flight_script, in_flight_epoch, release_epoch, version FROM release_config").toArray(),
    releases: sql.exec("SELECT id, state, script_name, failure_code FROM release WHERE id NOT IN (SELECT release_id FROM release_environment WHERE environment = 'preview') ORDER BY seq").toArray(),
    labels: sql.exec("SELECT label, current, retired_at FROM app_label WHERE kind = 'production'").toArray(),
  }));
  const state = await fakeState();
  return { rows, entry: state.entries[r.prodHost], scripts: state.scripts };
}
/** The provider calls that named production's dispatch namespace. A preview never makes one. */
const productionNamespaceCalls = async () => (await fakeState()).calls.filter((call) => call.namespace === "production");

const request = (r: Room, who: Who = OWNER, opts: { task?: string; commit?: string; key?: string; body?: unknown } = {}) =>
  api(who, "POST", `/v1/workspaces/${r.id}/tasks/${opts.task ?? TASK_A}/preview`, opts.body ?? { commit_sha: opts.commit ?? COMMIT_A }, opts.key);
const getPreview = (r: Room, who: Who = OWNER) => api(who, "GET", `/v1/workspaces/${r.id}/preview`);
const deletePreview = (r: Room, who: Who = OWNER, key?: string) => api(who, "DELETE", `/v1/workspaces/${r.id}/preview`, undefined, key);
type Pass = { release_id?: string | null; outcome: string; code?: string | null; state?: string; step?: string };
const pass = (r: Room): Promise<Pass> => stub(r.id).fetch("https://do/internal/test-release-drive", { method: "POST", body: "{}" }).then(async (res: Response) => {
  if (res.status !== 200) throw new Error(`a pass answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as Pass;
});
const at = (r: Room, now: number) => inRoom(r.id, (sql) => void sql.exec("UPDATE test_release_clock SET now = ?", now));
/** The room's current slot, or else its most recently deleted one. */
const slot = (r: Room) => inRoom(r.id, (sql) => sql.exec("SELECT * FROM preview_slot ORDER BY current IS NULL, deleted_at DESC LIMIT 1").toArray()[0] ?? null);
const releaseOf = (r: Room, id: string) => inRoom(r.id, (sql) => sql.exec("SELECT state, failure_code, label, approved_by, script_name FROM release WHERE id = ?", id).one());
const previewHost = (label: string) => `${label}.${FAKE.domain}`;

/** A preview of `task` asked for, its label indexed, and the job taken through its upload and commit: live, its flight open. */
async function live(r: Room, task = TASK_A, commit = COMMIT_A) {
  const asked = await request(r, OWNER, { task, commit });
  expect(asked.status, JSON.stringify(asked.body)).toBe(200);
  expect(asked.body.state).toBe("queued");
  await alarmPass(stub(r.id)); // the label index
  expect((await pass(r)).outcome).toBe("next"); // start
  expect((await pass(r)).outcome).toBe("next"); // upload
  const committed = await pass(r);
  expect([committed.outcome, committed.state], JSON.stringify(committed)).toEqual(["done", "live"]);
  const s = await slot(r);
  return { id: asked.body.id as string, label: s.label as string, script: `${s.label}.${asked.body.id}` };
}

/** [`live`], then the preview applier's entry and the marker through the preview host: served. */
async function served(r: Room, task = TASK_A, commit = COMMIT_A) {
  const preview = await live(r, task, commit);
  await alarmPass(stub(r.id)); // the preview applier writes the entry
  await serveMarker(previewHost(preview.label), preview.script);
  const marked = await pass(r);
  expect([marked.outcome, marked.step], JSON.stringify(marked)).toEqual(["served", "marker"]);
  return preview;
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  // The agent, connected at generation 1, so what refuses it is the route, not its connection.
  const registered = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(OWNER) }, body: JSON.stringify({ org_id: ORG, name: AGENT.id }) });
  if (registered.status !== 200) throw new Error(`register: ${registered.status}`);
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});
beforeEach(async () => {
  await control("/reset", {});
  await github("/reset", {});
  await github("/seed", repository());
  await moderation().fetch("https://do/release-reads", { method: "POST", body: JSON.stringify({ release_id: `rel_${"0".repeat(32)}`, reads: 1, owner_key: "room:ws_schema" }) });
  await inModeration((sql) => { sql.exec("DELETE FROM release_reads"); sql.exec("DELETE FROM release_read_owner"); });
  await switches({ releases: true, previews: true });
});
afterEach(async () => {
  for (const id of made.splice(0)) await alarmQuiet(stub(id));
  await switches({});
});

describe("the preview routes (M8 step 6)", () => {
  it("answer as routes nobody defined while release is off, whoever asks", async () => {
    const r = await room();
    await switches({ previews: true });
    for (const [method, path] of [["GET", "preview"], ["DELETE", "preview"], ["POST", `tasks/${TASK_A}/preview`]]) {
      expect((await api(OWNER, method, `/v1/workspaces/${r.id}/${path}`, { commit_sha: COMMIT_A })).code, `${method} ${path}`).toBe("not_found");
      expect((await api(OUTSIDER, method, `/v1/workspaces/${r.id}/${path}`, { commit_sha: COMMIT_A })).code, `${method} ${path}`).toBe("workspace_not_found");
    }
  });

  it("answer previews_off after who is asking while release is on and previews aren't, and delete with nothing to delete", async () => {
    const r = await room();
    for (const setting of [false, "", "TRUE", "yes"] as const) {
      await switches({ releases: true, previews: setting === false ? undefined : setting });
      expect((await getPreview(r)).code).toBe("previews_off");
      expect((await request(r)).code).toBe("previews_off");
      // Who is asked first: someone outside gets the room's answer, an agent or a member their refusal.
      expect((await request(r, OUTSIDER)).code).toBe("workspace_not_found");
      expect((await request(r, MEMBER)).code).toBe("not_allowed");
      expect((await request(r, AGENT)).code).toBe("not_allowed");
      // Deleting passes no gate: there is nothing to delete.
      expect((await deletePreview(r)).body).toEqual({ preview: null });
    }
    expect(await slot(r)).toBeNull();
  });

  it("are a person's: every agent is refused, whatever its role, and members and guests may only read", async () => {
    const r = await room();
    expect((await getPreview(r, AGENT)).code).toBe("not_allowed");
    expect((await request(r, AGENT)).code).toBe("not_allowed");
    expect((await deletePreview(r, AGENT)).code).toBe("not_allowed");
    expect((await request(r, MEMBER)).code).toBe("not_allowed");
    expect((await deletePreview(r, MEMBER)).code).toBe("not_allowed");
    expect((await getPreview(r, MEMBER)).body).toEqual({ preview: null });
    expect((await getPreview(r, OUTSIDER)).code).toBe("workspace_not_found");
    // The room's owner and an admin may ask.
    expect((await request(r, ADMIN)).status).toBe(200);
  });

  it("refuse a body or a task that isn't right, a commit that isn't the task's merged one, and a room that can't release, in order", async () => {
    const r = await room();
    expect((await request(r, OWNER, { body: { commit_sha: COMMIT_A, environment: "preview" } })).code).toBe("invalid_argument");
    expect((await request(r, OWNER, { body: {} })).code).toBe("invalid_argument");
    expect((await request(r, OWNER, { body: { commit_sha: "nope" } })).code).toBe("invalid_argument");
    expect((await request(r, OWNER, { task: "tsk_pw_none" })).code).toBe("task_not_found");
    expect((await request(r, OWNER, { commit: COMMIT_B })).code).toBe("commit_not_releasable");
    await inRoom(r.id, (sql) => sql.exec("UPDATE release_config SET enabled = 0"));
    expect((await request(r)).code).toBe("release_off");
    expect(await slot(r)).toBeNull();
  });

  it("let a private room have a preview: release_needs_public_room is never the answer (decision 251)", async () => {
    const r = await room({ visibility: "private" });
    const asked = await request(r);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toMatchObject({ task_id: TASK_A, commit_sha: COMMIT_A, state: "queued", build_id: null, storage_warning: null, requested_by: OWNER.id, served_at: null, failure_code: null });
  });

  it("make the slot and its preview label once, queue the release with its asker as approver, and tell people only", async () => {
    const r = await room();
    const before = await production(r);
    const asked = await request(r);
    expect(asked.status).toBe(200);
    const s = await slot(r);
    expect(s.id).toMatch(/^pvw_[0-9a-f]{32}$/);
    expect(s.current).toBe(1);
    expect(s.label).toMatch(/^[a-z0-9]{1,26}$/);
    expect(s.label).not.toBe(r.prodLabel);
    const rows = await inRoom(r.id, (sql) => ({
      label: sql.exec("SELECT kind, current, retired_at FROM app_label WHERE label = ?", s.label).one(),
      environment: sql.exec("SELECT environment FROM release_environment WHERE release_id = ?", asked.body.id).one().environment,
      apply: sql.exec("SELECT host, slot_id FROM preview_apply").toArray(),
      events: sql.exec("SELECT e.type, o.recipient_principal_id AS who FROM event e JOIN outbox o ON o.event_id = e.id WHERE e.type LIKE 'preview.%' ORDER BY who").toArray(),
    }));
    expect(rows.label).toEqual({ kind: "preview", current: null, retired_at: null });
    expect(rows.environment).toBe("preview");
    expect(rows.apply).toEqual([{ host: previewHost(s.label), slot_id: s.id }]);
    expect(await releaseOf(r, asked.body.id)).toMatchObject({ state: "queued", label: s.label, approved_by: OWNER.id });
    // Told to the room's owner and its admins who are people; never the agent that holds the admin role.
    expect(rows.events.map((e: any) => e.who)).toEqual([ADMIN.id]);
    expect(await production(r)).toEqual(before);
  });

  it("refuse a second preview while one is in flight, never queued, and count previews in the room's 20 asks a day", async () => {
    const r = await room();
    expect((await request(r)).status).toBe(200);
    expect((await request(r, OWNER, { task: TASK_B, commit: COMMIT_B })).code).toBe("preview_in_flight");
    const id = (await inRoom(r.id, (sql) => sql.exec("SELECT id FROM release WHERE id IN (SELECT release_id FROM release_environment)").one())).id;
    await inRoom(r.id, (sql) => sql.exec("UPDATE release SET state = 'failed', failure_code = 'x', finished_at = ? WHERE id = ?", T, id));
    // Releases and previews asked in the rolling day count together.
    await inRoom(r.id, (sql) => {
      for (let i = 0; i < 19; i++) {
        sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, requested_by, requested_at, declined_by, declined_at, updated_at)
          VALUES (?, ?, 'declined', ?, 3, 2, ?, ?, ?, ?, ?)`, `rel_${i.toString(16).padStart(32, "e")}`, COMMIT_A, r.prodLabel, OWNER.id, T - 1000, OWNER.id, T, T);
      }
    });
    expect((await request(r, OWNER, { task: TASK_B, commit: COMMIT_B })).code).toBe("preview_limit");
  });

  it("answer a retry with the same key as the first time, with no second release", async () => {
    const r = await room();
    const first = await request(r, OWNER, { key: "pw-retry" });
    const again = await request(r, OWNER, { key: "pw-retry" });
    expect(again).toEqual(first);
    expect((await all(r.id, "SELECT release_id FROM release_environment")).length).toBe(1);
  });
});

describe("the release job with an environment (M8 step 6, the plan's 3.2 and 3.4)", () => {
  it("waits for the preview label's index, then uploads to the preview namespace only, and goes live on the slot alone", async () => {
    const r = await room();
    const before = await production(r);
    const asked = await request(r);
    // Not yet in D1's lookup table: the start waits, and nothing is read or uploaded.
    const waiting = await pass(r);
    expect([waiting.outcome, waiting.code]).toEqual(["retry", "preview_label_not_indexed"]);
    await alarmPass(stub(r.id));
    const s = await slot(r);
    const kind = await BINDINGS.DB.prepare("SELECT kind FROM app_label_kind WHERE label = ?").bind(s.label).first();
    expect(kind).toEqual({ kind: "preview" });
    await at(r, T + 10 * 60 * 1000);
    expect((await pass(r)).outcome).toBe("next");
    expect((await pass(r)).outcome).toBe("next");
    const script = `${s.label}.${asked.body.id}`;
    // Written to the preview namespace, never production's.
    expect((await uploadState(script)).namespaces.every((ns) => ns === "preview")).toBe(true);
    expect((await uploadState(script)).namespaces.length).toBeGreaterThan(0);
    const committed = await pass(r);
    expect([committed.outcome, committed.state]).toEqual(["done", "live"]);
    const after = await slot(r);
    expect([after.default_release_id, after.in_flight_release]).toEqual([asked.body.id, asked.body.id]);
    expect(await production(r)).toEqual(before);
    expect(await productionNamespaceCalls()).toEqual([]);
  });

  it("writes only the preview form of the entry, on the preview host, and serves the release once its own marker comes back", async () => {
    const r = await room();
    const before = await production(r);
    const preview = await live(r);
    await alarmPass(stub(r.id));
    const s = await slot(r);
    const entry = (await fakeState()).entries[previewHost(preview.label)];
    expect(entry).toBe(`preview:${s.id}:0:${preview.script}`);
    await serveMarker(previewHost(preview.label), preview.script);
    expect((await pass(r)).outcome).toBe("served");
    expect(await releaseOf(r, preview.id)).toMatchObject({ state: "served" });
    const read = await getPreview(r, MEMBER);
    expect(read.body.preview).toMatchObject({ state: "active", replacement: null, default_host: previewHost(preview.label), custom_host: null });
    expect(read.body.preview.serving).toMatchObject({ id: preview.id, state: "served", commit_sha: COMMIT_A });
    // The task's release status shows the preview's state and commit, never a host.
    const status = await api(OWNER, "GET", `/v1/workspaces/${r.id}/tasks/${TASK_A}/release-status`);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body.preview).toMatchObject({ exists: true, release_id: preview.id, commit_sha: COMMIT_A, state: "served", served: true });
    expect(JSON.stringify(status.body.preview)).not.toContain(preview.label);
    // Production's own part is production's release, never the preview.
    expect(status.body.release).toMatchObject({ exists: true, release_id: PROD });
    expect(await production(r)).toEqual(before);
    expect(await productionNamespaceCalls()).toEqual([]);
  });

  it("keeps the last working preview when a replacement's marker never comes back, and production never moves", async () => {
    const r = await room();
    const first = await served(r);
    const before = await production(r);
    const second = await live(r, TASK_B, COMMIT_B);
    await alarmPass(stub(r.id));
    const s = await slot(r);
    expect((await fakeState()).entries[previewHost(first.label)]).toBe(`preview:${s.id}:0:${second.script}`);
    // The host still answers with the first release's marker: the replacement's never comes back.
    await serveMarker(previewHost(first.label), first.script);
    expect((await pass(r)).outcome).toBe("retry");
    await at(r, T + 10 * 60 * 1000);
    const setBack = await pass(r);
    expect([setBack.outcome, setBack.code]).toEqual(["set_back", "release_marker_missing"]);
    expect(await releaseOf(r, second.id)).toMatchObject({ state: "failed", failure_code: "release_marker_missing" });
    expect(await releaseOf(r, first.id)).toMatchObject({ state: "served" });
    const back = await slot(r);
    expect([back.default_release_id, back.in_flight_release]).toEqual([first.id, null]);
    // The applier puts the first one's entry back, and the failed one's script is owed its deletion from the preview
    // namespace alone.
    await alarmPass(stub(r.id));
    expect((await fakeState()).entries[previewHost(first.label)]).toBe(`preview:${s.id}:0:${first.script}`);
    const read = await getPreview(r);
    expect(read.body.preview.serving.id).toBe(first.id);
    expect(read.body.preview.replacement).toMatchObject({ id: second.id, state: "failed", failure_code: "release_marker_missing" });
    expect(await production(r)).toEqual(before);
    expect(await productionNamespaceCalls()).toEqual([]);
  });

  it("replaces a served preview with one whose marker comes back, and deletes the script it replaced from the preview namespace", async () => {
    const r = await room();
    const first = await served(r);
    const second = await served(r, TASK_B, COMMIT_B);
    expect(await releaseOf(r, first.id)).toMatchObject({ state: "replaced" });
    expect(await releaseOf(r, second.id)).toMatchObject({ state: "served" });
    expect(await all(r.id, "SELECT script_name FROM script_delete")).toEqual([{ script_name: first.script }]);
    await control("/seed", { previewScripts: [first.script] });
    await alarmPass(stub(r.id));
    const state = await fakeState();
    expect(state.previewScripts).not.toContain(first.script);
    expect(state.calls.filter((c) => c.op === "script.delete").map((c) => [c.name, c.namespace])).toEqual([[first.script, "preview"]]);
    expect(state.scripts).toContain(r.prodScript);
  });

  it("runs apart from production's job: neither waits on the other's flight, and neither's marker replaces the other's release", async () => {
    const r = await room();
    const first = await served(r);
    // A production release on its way, by the room's own job: uploaded to production's namespace, then committed live.
    const REL2 = `rel_${"8c".repeat(16)}`;
    await inRoom(r.id, (sql) => {
      sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_pw', ?, 'github', ?, 'deploy', ?, 1)", OWNER.id, REPO, OWNER.id);
      sql.exec(`INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
        VALUES (?, ?, 'uploading', ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, ?, ?)`, REL2, COMMIT_A, r.prodLabel, TASK_A, `${r.prodLabel}.${REL2}`, REL2, OWNER.id, OWNER.id, T, T);
    });
    expect((await pass(r)).outcome).toBe("next");
    const prodCommitted = await pass(r);
    expect([prodCommitted.release_id, prodCommitted.state]).toEqual([REL2, "live"]);
    // Production's flight is open and waits for its switch; a preview is asked for meanwhile and goes all the way live,
    // its own flight open beside production's.
    const asked = await request(r, OWNER, { task: TASK_B, commit: COMMIT_B });
    expect(asked.status).toBe(200);
    // The room's hourly upload attempts are shared by previews and releases (decision 257): emptied here, so the test
    // needn't wait out the hour that this test's two uploads so far began.
    await inRoom(r.id, (sql) => sql.exec("DELETE FROM release_upload_attempt"));
    const outcomes: [string | null | undefined, string][] = [];
    for (let i = 0; i < 8 && (await releaseOf(r, asked.body.id)).state !== "live"; i++) {
      const done = await pass(r);
      outcomes.push([done.release_id, done.outcome]);
    }
    expect(await releaseOf(r, asked.body.id)).toMatchObject({ state: "live" });
    expect(await releaseOf(r, REL2)).toMatchObject({ state: "live" });
    expect((await inRoom(r.id, (sql) => sql.exec("SELECT in_flight_release FROM release_config").one())).in_flight_release).toBe(REL2);
    expect((await slot(r)).in_flight_release).toBe(asked.body.id);
    // Each applier writes its own host's entry, in its own form.
    await alarmPass(stub(r.id));
    const s = await slot(r);
    const second = `${s.label}.${asked.body.id}`;
    const state = await fakeState();
    expect(state.entries[r.prodHost]).toBe(`${r.prodLabel}.${REL2}`);
    expect(state.entries[previewHost(s.label)]).toBe(`preview:${s.id}:0:${second}`);
    // Production's marker serves production's release: the release it replaces is production's, never the preview.
    await serveMarker(r.prodHost, `${r.prodLabel}.${REL2}`);
    await serveMarker(previewHost(s.label), second);
    const markers: string[] = [];
    // Production's marker waited for its switch on its own poll: its time comes.
    await at(r, T + 5_000);
    for (let i = 0; i < 4 && markers.filter((m) => m === "served").length < 2; i++) markers.push((await pass(r)).outcome);
    expect(markers.filter((m) => m === "served").length).toBe(2);
    expect(await releaseOf(r, REL2)).toMatchObject({ state: "served" });
    expect(await releaseOf(r, PROD)).toMatchObject({ state: "replaced" });
    expect(await releaseOf(r, asked.body.id)).toMatchObject({ state: "served" });
    expect(await releaseOf(r, first.id)).toMatchObject({ state: "replaced" });
    // The preview's scripts were only ever the preview namespace's.
    expect((await uploadState(second)).namespaces.every((ns) => ns === "preview")).toBe(true);
    expect((await uploadState(`${r.prodLabel}.${REL2}`)).namespaces.every((ns) => ns === "production")).toBe(true);
  });

  it("is retry-safe: a pass with nothing due, or a step repeated, changes nothing", async () => {
    const r = await room();
    const preview = await served(r);
    const rows = () => all(r.id, "SELECT id, state FROM release ORDER BY seq");
    const before = [await rows(), await slot(r)];
    for (let i = 0; i < 3; i++) expect(["not_due", "none"]).toContain((await pass(r)).outcome);
    const committed = await stub(r.id).fetch("https://do/internal/release-commit-live", { method: "POST", body: JSON.stringify({ release_id: preview.id }) });
    expect(committed.status).toBe(200);
    expect([await rows(), await slot(r)]).toEqual(before);
  });
});

describe("deleting a preview (M8 step 6, the plan's 3.2 and 3.3)", () => {
  it("takes every preview host down, retires the label, deletes its scripts from the preview namespace, and leaves production alone", async () => {
    const r = await room();
    const preview = await served(r);
    const before = await production(r);
    await control("/seed", { previewScripts: [preview.script] });
    const deleted = await deletePreview(r, ADMIN, "pw-delete");
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.preview).toMatchObject({ state: "deleting", serving: null, replacement: null });
    const s = await slot(r);
    expect([s.current, s.default_release_id, s.access_epoch]).toEqual([null, null, 1]);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT kind, retired_at FROM app_label WHERE label = ?", preview.label).one())).toEqual({ kind: "preview", retired_at: T });
    expect(await releaseOf(r, preview.id)).toMatchObject({ state: "unpublished" });
    // A retry with the same key answers as the first time.
    expect((await deletePreview(r, ADMIN, "pw-delete")).body).toEqual(deleted.body);
    await alarmPass(stub(r.id));
    const state = await fakeState();
    expect(state.entries[previewHost(preview.label)]).toBeUndefined();
    expect(state.previewScripts).toEqual([]);
    expect((await getPreview(r)).body).toEqual({ preview: null });
    expect(await production(r)).toEqual(before);
    expect(await productionNamespaceCalls()).toEqual([]);
    // A new preview gets another slot and another label.
    expect((await request(r)).status).toBe(200);
    expect((await slot(r)).label).not.toBe(preview.label);
  });

  it("goes with every unpublish trigger but the room made private, and with PREVIEWS exactly false", async () => {
    // The room made private: the preview stays (decision 251); production is unpublished as before.
    const kept = await room();
    const keptPreview = await served(kept);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${kept.id}/visibility`, { visibility: "private" })).status).toBe(200);
    expect((await slot(kept)).current).toBe(1);
    expect(await releaseOf(kept, keptPreview.id)).toMatchObject({ state: "served" });

    // Release switched off in the room: the preview is deleted.
    const off = await room();
    await served(off);
    expect((await api(OWNER, "PUT", `/v1/workspaces/${off.id}/release-config`, { enabled: false, expected_version: 3 })).status).toBe(200);
    expect((await slot(off)).current).toBeNull();

    // An operator suspends the app: the preview goes too.
    const suspended = await room();
    await served(suspended);
    expect((await api(OPERATOR, "POST", `/v1/moderation/apps/${suspended.prodLabel}/suspend`, { reason: "abuse" })).status).toBe(200);
    expect((await slot(suspended)).current).toBeNull();

    // PREVIEWS exactly false, applied wherever RELEASES is read: the preview is deleted, and new ones are refused.
    const switchedOff = await room();
    await served(switchedOff);
    await switches({ releases: true, previews: "false" });
    expect((await request(switchedOff)).code).toBe("previews_off");
    expect((await slot(switchedOff)).current).toBeNull();
    // Undecided deletes nothing.
    await switches({ releases: true, previews: true });
    const undecided = await room();
    await served(undecided);
    await switches({ releases: true, previews: "maybe" });
    expect((await request(undecided)).code).toBe("previews_off");
    expect((await slot(undecided)).current).toBe(1);
  });
});

describe("unpublish epochs, kept apart by environment (M8 step 6)", () => {
  it("never attaches a preview script to a production unpublish, nor holds that unpublish's files open", async () => {
    const r = await room();
    const asked = await request(r);
    await alarmPass(stub(r.id));
    expect((await pass(r)).outcome).toBe("next");
    expect((await pass(r)).outcome).toBe("next");
    const s = await slot(r);
    const script = `${s.label}.${asked.body.id}`;
    // The room made private: production is unpublished, and the preview survives, but its release on its way, asked
    // under the epoch the unpublish left, is ended.
    expect((await api(OWNER, "PUT", `/v1/workspaces/${r.id}/visibility`, { visibility: "private" })).status).toBe(200);
    expect(await releaseOf(r, asked.body.id)).toMatchObject({ state: "failed" });
    expect(await all(r.id, "SELECT script_name, unpublish_epoch FROM script_delete WHERE script_name = ?", script)).toEqual([{ script_name: script, unpublish_epoch: null }]);
    expect((await slot(r)).current).toBe(1);
    // Production's unpublish is done with its files once production's are gone, whatever the preview's script does.
    await alarmPass(stub(r.id));
    const unpublished = await all(r.id, "SELECT cause, scripts_gone_at IS NOT NULL AS done FROM unpublish");
    expect(unpublished).toEqual([{ cause: "release_needs_public_room", done: 1 }]);
  });
});

describe("what production's code assumed of a label that isn't current (the plan's 9.4, for step 6)", () => {
  it("never retires a live preview label by the operator's retire, and names production's label in its findings", async () => {
    const r = await room();
    const preview = await live(r);
    const retired = await api(OPERATOR, "POST", `/v1/moderation/apps/${preview.label}/retire`, { reason: "abuse", room: r.id });
    expect(retired.code).toBe("app_label_not_taken");
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT retired_at FROM app_label WHERE label = ?", preview.label).one().retired_at)).toBeNull();
    // The room's release bookkeeping keeps failing: operators are told by production's label, though the preview label is
    // the newest of the room's labels.
    await inRoom(r.id, (sql) => {
      sql.exec("CREATE TABLE test_release_bookkeeping_fails (x INTEGER)");
      sql.exec("INSERT INTO release_bookkeeping (singleton, failures, first_failed_at, last_failed_at, last_code) VALUES (1, 3, 1, 1, 'x')");
    });
    const answer = await stub(r.id).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify({ kind: "wake" }) });
    const findings = ((await answer.json()) as { findings: { code: string; subject: string }[] }).findings;
    expect(findings.find((f) => f.code === "release_bookkeeping_failing")?.subject).toBe(r.prodLabel);
    await inRoom(r.id, (sql) => { sql.exec("DROP TABLE test_release_bookkeeping_fails"); sql.exec("DELETE FROM release_bookkeeping"); });
  });
});

describe("the reconciles over both namespaces (M8 step 6)", () => {
  it("forget a preview host's entry that differs, so the preview applier writes it again", async () => {
    const r = await room();
    const preview = await served(r);
    const host = previewHost(preview.label);
    const ask = (body: unknown) => stub(r.id).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify(body) }).then((res: Response) => res.json());
    const s = await slot(r);
    expect(await ask({ kind: "entry", preview: true, host, found_value: `preview:${s.id}:0:${preview.script}` })).toMatchObject({ known: true, changed: false });
    expect(await ask({ kind: "entry", preview: true, host, found_value: `preview:${s.id}:0:${r.prodScript}` })).toMatchObject({ known: true, changed: true });
    await control("/seed", { entries: { [host]: "something else" } });
    await alarmPass(stub(r.id));
    expect((await fakeState()).entries[host]).toBe(`preview:${s.id}:0:${preview.script}`);
  });

  it("queue a preview script nothing claims for deletion from the preview namespace, and never a preview label's from production's", async () => {
    const r = await room();
    const preview = await served(r);
    const stray = `${preview.label}.rel_${"5a".repeat(16)}`;
    const ask = (body: unknown) => stub(r.id).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify(body) }).then((res: Response) => res.json());
    // Asked as production's: a preview label's script isn't production's to answer for.
    expect(await ask({ kind: "script", script: stray })).toMatchObject({ known: false, changed: false });
    // The serving one is kept; the stray one queued.
    expect(await ask({ kind: "script", namespace: "preview", script: preview.script })).toMatchObject({ known: true, changed: false });
    expect(await ask({ kind: "script", namespace: "preview", script: stray })).toMatchObject({ known: true, changed: true });
    // A production script is never the preview question's.
    expect(await ask({ kind: "script", namespace: "preview", script: r.prodScript })).toMatchObject({ known: false });
    await control("/seed", { previewScripts: [stray] });
    await alarmPass(stub(r.id));
    const state = await fakeState();
    expect(state.previewScripts).toEqual([]);
    expect(state.scripts).toContain(r.prodScript);
    expect(await productionNamespaceCalls()).toEqual([]);
  });

  it("hold a preview script to rule 3(b) as production's: only its own label's STORE, and any other binding suspends the app", async () => {
    const OWN_ID = "0123abcd-4567-89ef-0123-456789abcdef";
    const storeBinding = { type: "d1", name: "STORE", id: OWN_ID };
    const reconcileScripts = async () => (await (await moderation().fetch("https://do/reconcile/scripts", { method: "POST" })).json()) as { previews: string };
    const freshCeiling = () => inModeration((sql) => { sql.exec("DELETE FROM binding_suspension"); sql.exec("DELETE FROM binding_unread"); sql.exec("DELETE FROM takedown_finding"); });
    const recordStore = (r: Room, label: string) => inRoom(r.id, (sql) => sql.exec(
      "INSERT INTO app_store (label, kind, store_name, store_id, recorded_at, create_sent_at, made_at, updated_at) VALUES (?, 'd1', ?, ?, 1, 1, 2, 2)",
      label, `podster-store-${crypto.randomUUID().replace(/-/g, "")}`.slice(0, 46), OWN_ID));
    const foreign = () => inModeration((sql) => sql.exec("SELECT subject, detail FROM takedown_finding WHERE code = 'script_binding_foreign'").toArray());
    // Clean: its own label's store, and nothing else.
    const clean = await room();
    const cleanPreview = await served(clean);
    await recordStore(clean, cleanPreview.label);
    await freshCeiling();
    await control("/seed", { previewScripts: [cleanPreview.script], bindings: { [cleanPreview.script]: [storeBinding] } });
    expect((await reconcileScripts()).previews).toBe("ok");
    expect(await foreign()).toEqual([]);
    expect((await slot(clean)).current).toBe(1);
    // Another binding beside it: caught, told by the script's name, and the app suspended as an operator's suspension,
    // which takes production down and deletes the preview.
    const r = await room();
    const preview = await served(r);
    await recordStore(r, preview.label);
    await freshCeiling();
    await control("/seed", { previewScripts: [preview.script], bindings: { [preview.script]: [storeBinding, { type: "service", name: "API", service: "podster-api" }] } });
    expect((await reconcileScripts()).previews).toBe("ok");
    expect(await foreign()).toEqual([{ subject: preview.script, detail: "other_binding" }]);
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT suspended_at IS NOT NULL AS suspended, suspension_reason FROM app_label WHERE label = ?", preview.label).one())).toEqual({ suspended: 1, suspension_reason: "other" });
    expect(await all(r.id, "SELECT cause FROM unpublish")).toEqual([{ cause: "app_suspended" }]);
    expect((await slot(r)).current).toBeNull();
    expect(await inModeration((sql) => sql.exec("SELECT count(*) AS n FROM binding_suspension").one().n)).toBe(1);
    // A preview label's script listed in production's namespace is no question for rule 3(b) there.
    const ask = await stub(r.id).fetch("https://do/internal/takedown-check", { method: "POST", body: JSON.stringify({ kind: "script", script: preview.script, listed_at: Date.now(), serve_entries: "x", bindings: [], bindings_oversized: false, may_suspend: true }) });
    expect(((await ask.json()) as { bindings?: unknown }).bindings ?? null).toBeNull();
  });

  it("fall through to production's own check when a production host holds a preview-form value, so its applier writes it again", async () => {
    const r = await room();
    await control("/seed", { entries: { [r.prodHost]: `preview:pvw_${"1".repeat(32)}:0:${r.prodScript}` } });
    await moderation().fetch("https://do/reconcile/entries", { method: "POST" });
    expect(await inRoom(r.id, (sql) => sql.exec("SELECT applied_version, last_code FROM serve_apply WHERE host = ?", r.prodHost).one())).toEqual({ applied_version: null, last_code: "reconcile_differs" });
    await alarmPass(stub(r.id));
    expect((await fakeState()).entries[r.prodHost]).toBe(r.prodScript);
  });

  it("walk the preview namespace in the hourly pass, asking each script's room by its preview label", async () => {
    const r = await room();
    const preview = await served(r);
    const stray = `${preview.label}.rel_${"6b".repeat(16)}`;
    await control("/seed", { previewScripts: [preview.script, stray] });
    const done = (await (await moderation().fetch("https://do/reconcile/scripts", { method: "POST" })).json()) as { previews: string };
    expect(done.previews).toBe("ok");
    expect(await all(r.id, "SELECT script_name FROM script_delete WHERE gone_at IS NULL")).toEqual([{ script_name: stray }]);
  });
});

// --- M8 step 9: publishing from a preview (the plan's 4.3 and section 10; decisions 254, 255 and 259) ---------------------
const PREVIEW_NOTICE = "This build ran in the preview with browser storage and its own origin. In production it runs sandboxed, with neither, so anything that worked only because of them will break.";
const STORAGE_NOTICE = "This build may use browser storage, which production apps don't have.";
const OTHER_BUILD = `bld_${"0f".repeat(16)}`;
const grantDeploy = (r: Room, who: Who = OWNER) => inRoom(r.id, (sql) => sql.exec(
  "INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES (?, ?, 'github', ?, 'deploy', ?, 1)",
  `pgr_pp_${who.id}`, who.id, REPO, OWNER.id));
const publish = (r: Room, from: string, opts: { who?: Who; task?: string; commit?: string } = {}) =>
  api(opts.who ?? OWNER, "POST", `/v1/workspaces/${r.id}/releases`, { task_id: opts.task ?? TASK_B, commit_sha: opts.commit ?? COMMIT_B, from_preview: from });
const approve = (r: Room, id: string, body?: unknown, who: Who = OWNER) => api(who, "POST", `/v1/workspaces/${r.id}/releases/${id}/approve`, body);
const buildOf = async (r: Room, id: string) => (await all(r.id, "SELECT build_id FROM release_build WHERE release_id = ?", id))[0]?.build_id as string | undefined;
const approvals = async (r: Room) => (await api(OWNER, "GET", `/v1/workspaces/${r.id}/release-approvals`)).body.releases as any[];
/** An approved production release driven by the job to its commit: `live`, or the state the job ended it in. */
async function driveProduction(r: Room, id: string) {
  // The room's hourly uploads are shared by previews and releases (decision 257): emptied, so a test needn't wait out
  // the hour its earlier uploads began.
  await inRoom(r.id, (sql) => sql.exec("DELETE FROM release_upload_attempt"));
  for (let i = 0; i < 6 && ["queued", "uploading"].includes((await releaseOf(r, id)).state); i++) await pass(r);
  return releaseOf(r, id);
}
/** [`driveProduction`], then the applier's entry and production's marker through its host: served. */
async function publishServed(r: Room, id: string) {
  expect(await driveProduction(r, id)).toMatchObject({ state: "live" });
  await alarmPass(stub(r.id));
  const script = `${r.prodLabel}.${id}`;
  expect((await fakeState()).entries[r.prodHost]).toBe(script);
  await serveMarker(r.prodHost, script);
  await at(r, T + 5_000);
  for (let i = 0; i < 4 && (await releaseOf(r, id)).state !== "served"; i++) await pass(r);
  expect(await releaseOf(r, id)).toMatchObject({ state: "served" });
}

describe("publishing from a preview (M8 step 9, the plan's 4.3)", () => {
  it("records every preview's build and its storage warning, from what the job fetched", async () => {
    const r = await room();
    const a = await served(r);
    const readA = (await getPreview(r)).body.preview.serving;
    expect(readA.build_id).toMatch(/^bld_[0-9a-f]{32}$/);
    expect(readA.storage_warning).toBe(false);
    expect(await all(r.id, "SELECT tree_sha, form_version FROM release_build WHERE release_id = ?", a.id)).toEqual([{ tree_sha: DIR_A, form_version: expect.stringMatching(/^\S+ \S+ STORE \S+$/) }]);
    const b = await served(r, TASK_B, COMMIT_B);
    const readB = (await getPreview(r)).body.preview.serving;
    expect(readB).toMatchObject({ id: b.id, storage_warning: true });
    expect(readB.build_id).toMatch(/^bld_[0-9a-f]{32}$/);
    expect(readB.build_id).not.toBe(readA.build_id);
    // The same commit uploaded again is the same build: a build is named by what was fetched, never by its script.
    await inRoom(r.id, (sql) => sql.exec("DELETE FROM release_upload_attempt"));
    const again = await served(r, TASK_A, COMMIT_A);
    expect(await buildOf(r, again.id)).toBe(readA.build_id);
  });

  it("publishes the exact build: the request names the preview release, the approval sends its build, and production goes live on it", async () => {
    const r = await room();
    await grantDeploy(r);
    const b = await served(r, TASK_B, COMMIT_B);
    const build = (await buildOf(r, b.id))!;
    const asked = await publish(r, b.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toMatchObject({ state: "awaiting_approval", commit_sha: COMMIT_B });
    expect(await all(r.id, "SELECT preview_release_id, build_id FROM release_from_preview WHERE release_id = ?", asked.body.id)).toEqual([{ preview_release_id: b.id, build_id: build }]);
    const trail = JSON.parse((await all(r.id, "SELECT new_json FROM audit_event WHERE action = 'release.requested' AND target_id = ?", asked.body.id))[0].new_json);
    expect(trail).toMatchObject({ from_preview: b.id, build });
    // The approval dialog's data: the build in full, when it reached the preview, its storage warning and Podster's words.
    const listed = (await approvals(r)).find((x) => x.id === asked.body.id);
    expect(listed).toEqual({
      id: asked.body.id, task_id: TASK_B, commit_sha: COMMIT_B, state: "awaiting_approval", requested_by: OWNER.id, requested_at: T,
      from_preview: b.id, build_id: build, preview_served_at: T, storage_warning: true, preview_replaced: false,
      preview_notice: PREVIEW_NOTICE, storage_notice: STORAGE_NOTICE,
    });
    // The body: required for a release made from a preview, exactly its build, and nothing else. Each refusal writes nothing.
    expect((await approve(r, asked.body.id)).code).toBe("invalid_argument");
    expect((await approve(r, asked.body.id, { build: OTHER_BUILD })).code).toBe("release_build_changed");
    expect((await approve(r, asked.body.id, { build, note: "x" })).code).toBe("invalid_argument");
    expect((await approve(r, asked.body.id, { build: 7 })).code).toBe("invalid_argument");
    expect(await releaseOf(r, asked.body.id)).toMatchObject({ state: "awaiting_approval", approved_by: null });
    const approved = await approve(r, asked.body.id, { build });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.state).toBe("queued");
    await publishServed(r, asked.body.id);
    // Production recomputed the build from what it fetched: the very build tested.
    expect(await buildOf(r, asked.body.id)).toBe(build);
    expect(await releaseOf(r, PROD)).toMatchObject({ state: "replaced" });
    // The production upload went to production's namespace alone; the preview's script is untouched.
    expect((await uploadState(`${r.prodLabel}.${asked.body.id}`)).namespaces.every((ns) => ns === "production")).toBe(true);
    expect((await getPreview(r)).body.preview.serving.id).toBe(b.id);
  });

  it("keeps an approval on its own build when the preview is replaced, and refuses to move it to the new one (decision 259)", async () => {
    const r = await room();
    await grantDeploy(r);
    const b = await served(r, TASK_B, COMMIT_B);
    const buildB = (await buildOf(r, b.id))!;
    const asked = await publish(r, b.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    // The preview is replaced with A before anyone approves.
    await inRoom(r.id, (sql) => sql.exec("DELETE FROM release_upload_attempt"));
    const a = await served(r, TASK_A, COMMIT_A);
    const buildA = (await buildOf(r, a.id))!;
    expect(buildA).not.toBe(buildB);
    expect(await releaseOf(r, b.id)).toMatchObject({ state: "replaced" });
    const listed = (await approvals(r)).find((x) => x.id === asked.body.id);
    expect(listed).toMatchObject({ from_preview: b.id, build_id: buildB, preview_replaced: true, preview_notice: PREVIEW_NOTICE });
    // What the preview shows now is refused; the build that was tested still approves.
    expect((await approve(r, asked.body.id, { build: buildA })).code).toBe("release_build_changed");
    expect(await all(r.id, "SELECT build_id FROM release_from_preview WHERE release_id = ?", asked.body.id)).toEqual([{ build_id: buildB }]);
    expect((await approve(r, asked.body.id, { build: buildB })).body.state).toBe("queued");
    await publishServed(r, asked.body.id);
    expect(await buildOf(r, asked.body.id)).toBe(buildB);
    expect(await all(r.id, "SELECT commit_sha FROM release WHERE id = ?", asked.body.id)).toEqual([{ commit_sha: COMMIT_B }]);
    // The preview still shows A.
    expect((await getPreview(r)).body.preview.serving.id).toBe(a.id);
  });

  it("doesn't call the preview replaced when a newer preview release shows the identical build", async () => {
    const r = await room();
    await grantDeploy(r);
    const b = await served(r, TASK_B, COMMIT_B);
    const build = (await buildOf(r, b.id))!;
    const asked = await publish(r, b.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    // The same commit made the preview again: another preview release, the very same build.
    await inRoom(r.id, (sql) => sql.exec("DELETE FROM release_upload_attempt"));
    const again = await served(r, TASK_B, COMMIT_B);
    expect(again.id).not.toBe(b.id);
    expect(await releaseOf(r, b.id)).toMatchObject({ state: "replaced" });
    expect(await buildOf(r, again.id)).toBe(build);
    expect((await approvals(r)).find((x) => x.id === asked.body.id)).toMatchObject({ from_preview: b.id, build_id: build, preview_replaced: false });
    expect((await approve(r, asked.body.id, { build })).body.state).toBe("queued");
  });

  it("publishes the pinned build after the preview is deleted, fetching the commit again, or fails cleanly if it differs", async () => {
    // Deleted after the request: the commit is fetched again, and the build that was tested goes live.
    const r = await room();
    await grantDeploy(r);
    const b = await served(r, TASK_B, COMMIT_B);
    const build = (await buildOf(r, b.id))!;
    const asked = await publish(r, b.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect((await deletePreview(r)).status).toBe(200);
    expect(await releaseOf(r, b.id)).toMatchObject({ state: "unpublished" });
    expect((await approvals(r)).find((x) => x.id === asked.body.id)).toMatchObject({ build_id: build, preview_replaced: true });
    expect((await approve(r, asked.body.id, { build })).body.state).toBe("queued");
    await publishServed(r, asked.body.id);
    expect(await buildOf(r, asked.body.id)).toBe(build);
    // Deleted before the request: a deleted preview's tested build may still be published, and if what GitHub now
    // answers for the commit isn't that build, the publish fails `build_mismatch` and production stays as it was.
    const other = await room();
    await grantDeploy(other);
    const ob = await served(other, TASK_B, COMMIT_B);
    const obuild = (await buildOf(other, ob.id))!;
    expect((await deletePreview(other)).status).toBe(200);
    const late = await publish(other, ob.id);
    expect(late.status, JSON.stringify(late.body)).toBe(200);
    expect((await approve(other, late.body.id, { build: obuild })).body.state).toBe("queued");
    const before = await production(other);
    const changed = repository();
    const blobs: Record<string, string> = { ...changed.blobs };
    changed.trees[DIR_B] = { tree: tree({ "index.html": "<p>changed since</p>\n" }, blobs) };
    await github("/reset", {});
    await github("/seed", { ...changed, blobs });
    expect(await driveProduction(other, late.body.id)).toMatchObject({ state: "failed", failure_code: "build_mismatch" });
    expect((await uploadState(`${other.prodLabel}.${late.body.id}`)).namespaces).toEqual([]);
    const after = await production(other);
    expect([after.entry, after.rows.serve]).toEqual([before.entry, before.rows.serve]);
    expect(await releaseOf(other, PROD)).toMatchObject({ state: "served" });
  });

  it("fails a publish whose fetched build isn't the one tested, before anything is uploaded, and production stays live", async () => {
    const r = await room();
    await grantDeploy(r);
    const b = await served(r, TASK_B, COMMIT_B);
    const build = (await buildOf(r, b.id))!;
    const asked = await publish(r, b.id);
    expect((await approve(r, asked.body.id, { build })).body.state).toBe("queued");
    const before = await production(r);
    // What GitHub answers for the commit is no longer what was tested.
    const changed = repository();
    const blobs: Record<string, string> = { ...changed.blobs };
    changed.trees[DIR_B] = { tree: tree({ "index.html": "<p>something else</p>\n" }, blobs) };
    await github("/reset", {});
    await github("/seed", { ...changed, blobs });
    expect(await driveProduction(r, asked.body.id)).toMatchObject({ state: "failed", failure_code: "build_mismatch" });
    expect(await buildOf(r, asked.body.id)).toBeUndefined();
    expect((await uploadState(`${r.prodLabel}.${asked.body.id}`)).namespaces).toEqual([]);
    const after = await production(r);
    expect(after.entry).toBe(before.entry);
    expect(after.rows.serve).toEqual(before.rows.serve);
    expect(await releaseOf(r, PROD)).toMatchObject({ state: "served" });
  });

  it("checks the build again at the commit live: a recorded build that isn't the one named never goes live", async () => {
    const r = await room();
    await grantDeploy(r);
    const b = await served(r, TASK_B, COMMIT_B);
    const build = (await buildOf(r, b.id))!;
    const asked = await publish(r, b.id);
    expect((await approve(r, asked.body.id, { build })).body.state).toBe("queued");
    const before = await production(r);
    await inRoom(r.id, (sql) => sql.exec("DELETE FROM release_upload_attempt"));
    expect((await pass(r)).outcome).toBe("next"); // start
    expect((await pass(r)).outcome).toBe("next"); // upload, its build recorded
    expect(await buildOf(r, asked.body.id)).toBe(build);
    await inRoom(r.id, (sql) => sql.exec("UPDATE release_build SET build_id = ? WHERE release_id = ?", OTHER_BUILD, asked.body.id));
    await pass(r); // the commit
    expect(await releaseOf(r, asked.body.id)).toMatchObject({ state: "failed", failure_code: "build_mismatch" });
    const after = await production(r);
    expect([after.entry, after.rows.serve]).toEqual([before.entry, before.rows.serve]);
    expect(await releaseOf(r, PROD)).toMatchObject({ state: "served" });
  });

  it("refuses a publish from anything but a tested preview of the very task and commit, and from an agent", async () => {
    const r = await room();
    await grantDeploy(r);
    // A preview live but whose marker never came back: never tested.
    const a = await live(r);
    expect((await publish(r, a.id, { task: TASK_A, commit: COMMIT_A })).code).toBe("preview_not_served");
    await alarmPass(stub(r.id));
    await serveMarker(previewHost(a.label), a.script);
    expect((await pass(r)).outcome).toBe("served");
    // Production's own release, and one the room doesn't have, are answered alike.
    expect((await publish(r, PROD, { task: TASK_A, commit: COMMIT_A })).code).toBe("preview_release_not_found");
    expect((await publish(r, `rel_${"9".repeat(32)}`, { task: TASK_A, commit: COMMIT_A })).code).toBe("preview_release_not_found");
    expect((await publish(r, "rel_nope", { task: TASK_A, commit: COMMIT_A })).code).toBe("invalid_argument");
    expect((await publish(r, a.id, { task: TASK_B, commit: COMMIT_B })).code).toBe("preview_task_mismatch");
    expect((await publish(r, a.id, { task: TASK_A, commit: COMMIT_B })).code).toBe("preview_commit_mismatch");
    // A preview whose build was never recorded.
    await inRoom(r.id, (sql) => { sql.exec("DELETE FROM release_build_storage WHERE release_id = ?", a.id); sql.exec("DELETE FROM release_build WHERE release_id = ?", a.id); });
    expect((await publish(r, a.id, { task: TASK_A, commit: COMMIT_A })).code).toBe("preview_build_missing");
    // An agent that may ask for a release may not name a preview (decision 253).
    const agent: Who = { ...AGENT, linker: { person: OWNER.id, since: 1 } };
    await grantDeploy(r, agent);
    expect((await publish(r, a.id, { who: agent, task: TASK_A, commit: COMMIT_A })).code).toBe("invalid_argument");
    expect(await all(r.id, "SELECT release_id FROM release_from_preview")).toEqual([]);
  });

  it("keeps approval a person's, and a release not made from a preview takes no build", async () => {
    const r = await room();
    await grantDeploy(r);
    const b = await served(r, TASK_B, COMMIT_B);
    const build = (await buildOf(r, b.id))!;
    const asked = await publish(r, b.id);
    expect((await approve(r, asked.body.id, { build }, AGENT)).code).toBe("not_allowed");
    expect((await approve(r, asked.body.id, { build }, MEMBER)).code).toBe("not_allowed");
    expect((await approve(r, asked.body.id, { build }, OUTSIDER)).code).toBe("workspace_not_found");
    expect(await releaseOf(r, asked.body.id)).toMatchObject({ state: "awaiting_approval" });
    expect((await approve(r, asked.body.id, { build }, ADMIN)).body.state).toBe("queued");
    // A release asked for as before has nulls for the dialog's preview fields, and refuses a build.
    const plain = await api(OWNER, "POST", `/v1/workspaces/${r.id}/releases`, { task_id: TASK_A, commit_sha: COMMIT_A });
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect((await approvals(r)).find((x) => x.id === plain.body.id)).toMatchObject({ from_preview: null, build_id: null, preview_served_at: null, storage_warning: null, preview_replaced: null, preview_notice: null, storage_notice: null });
    expect((await approve(r, plain.body.id, { build })).code).toBe("invalid_argument");
    expect((await approve(r, plain.body.id, {})).body.state).toBe("queued");
  });

  it("can't publish a private room's preview: the room must be public, as for any release (decision 251)", async () => {
    const r = await room({ visibility: "private" });
    await grantDeploy(r);
    const b = await served(r, TASK_B, COMMIT_B);
    expect((await publish(r, b.id)).code).toBe("release_needs_public_room");
  });
});
