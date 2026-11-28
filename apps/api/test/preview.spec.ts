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
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
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
    ? { kind: "agent", org: who.org, gen: 1 }
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
    trees: { [COMMIT_A]: top(DIR_A), [COMMIT_B]: top(DIR_B), [DIR_A]: { tree: tree({ "index.html": "<p>preview A</p>\n" }, blobs) }, [DIR_B]: { tree: tree({ "index.html": "<p>preview B</p>\n" }, blobs) } },
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
