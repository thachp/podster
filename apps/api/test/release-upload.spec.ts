import { env, runInDurableObject, SELF } from "cloudflare:test";
import { createHash } from "node:crypto";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alarmQuiet } from "./alarm";

// M6 step 5, the upload of a release's static files (ADR 0010's "The release job", steps 1 to 4): the room's command
// that rechecks, reads the release directory with the read-only App, uploads the files as the release's own script,
// asks the room again, writes the script, and records the upload. Nothing calls the command yet, so each test writes
// the rows a release would have straight into a room and calls the room's internal path.
//
// GitHub is the stand-in in `fake-github-release.ts`, under a repository ID that only this file uses. The provider is
// the upload part of `fake-content.ts`, which keeps everything by script name, and every test here has a label, and
// so a script name, of its own. **The room's applier and delete job have no provider** (`test_content_provider_off`),
// so nothing here asks the stand-in for anything but the upload: other spec files use it at the same time.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[] };
const ORG = "org_ru";
const OWNER: Who = { id: "per_ru_owner", kind: "person", org: ORG, adminOrgs: [ORG] };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: who.org, orgs: [who.org], admin_orgs: who.adminOrgs ?? [], org_since: { [who.org]: 1 } })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who), "idempotency-key": `ru-key-${++counter}` };
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
/** Release switched on for the test Worker, as no deployment is, while any command of this file's is out: two may overlap. */
let on = 0;
let switching: Promise<unknown> = Promise.resolve();
const inTurn = (step: () => Promise<unknown>) => (switching = switching.then(step, step));
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await inTurn(async () => { if (on++ === 0) await BINDINGS.DB.prepare("CREATE TABLE IF NOT EXISTS test_releases_on (x INTEGER)").run(); });
  try { return await run(); } finally { await inTurn(async () => { if (--on === 0) await BINDINGS.DB.prepare("DROP TABLE IF EXISTS test_releases_on").run(); }); }
}

// --- GitHub's stand-in, for this file's own repository ---------------------------------------------------------------
const REPO = 987650888;
const COMMIT = "c1".repeat(20);
const DIRECTORY = "d2".repeat(20);
const github = (path: string, body?: unknown) => fetch(`https://github-release-fake.example.com${path}?repo=${REPO}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
type GithubState = { calls: { method: string; path: string }[]; minted: any[]; tokens: { revoked: boolean }[] };
const githubState = async () => (await (await github("/state")).json()) as GithubState;
const bytes = (text: string) => new TextEncoder().encode(text);
const blobSha = (content: Uint8Array) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
const sha = (n: number) => n.toString(16).padStart(40, "0");
type Entry = { path: string; mode: string; type: string; sha: string; size?: number };
function repository(files: Record<string, string>, extra: Entry[] = []) {
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
  return { repo: REPO, trees: { [COMMIT]: { tree: top }, [DIRECTORY]: { tree: [...directory, ...extra] } }, blobs };
}
const SITE = { "index.html": "<p>one</p>\n", "app.js": "export const one = 1;\n", "css/site.css": "p { color: red }\n", "data/list.json": '["a"]\n', "notes": "plain\n" };
const TYPES: Record<string, string> = { "index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "css/site.css": "text/css; charset=utf-8", "data/list.json": "application/json", "notes": "application/octet-stream" };
/** A file's hash in the manifest: SHA-256 over its type, a zero byte and its own bytes, cut to 32 characters. */
const hashOf = (type: string, text: string) => createHash("sha256").update(type).update(Buffer.from([0])).update(bytes(text)).digest("hex").slice(0, 32);
const asked = (seen: GithubState) => seen.calls.map((call) => `${call.method} ${call.path.replace(/[0-9a-f]{40}/, "<sha>").replace(String(REPO), "<repo>")}`);
const blobReads = (seen: GithubState) => seen.calls.filter((call) => call.path.includes("/git/blobs/")).length;

// --- the provider's stand-in, by script ---------------------------------------------------------------------------------
type Written = { files: Record<string, { hash: string; size: number; type: string; base64: string }>; metadata: any; metadataText: string; times: number };
type Provider = { calls: { op: string; status: number; hashes?: string[]; manifest?: Record<string, { hash: string; size: number }>; query?: string; parts?: string[]; bytes?: number }[]; held: string[]; written: Written | null; expiredGates: number };
const provider = async (script: string) => (await (await fetch(`https://content-fake.example.com/upload-state?script=${script}`)).json()) as Provider;
const providerFault = (script: string, fault: object) => fetch(`https://content-fake.example.com/upload-fault?script=${script}`, { method: "POST", body: JSON.stringify({ times: 1, ...fault }) });
/**
 * Holds the next call of one kind to the provider for this script until the test lets it go: `arrived` resolves once
 * that call is held, `release` answers it. No clock: the test does what it means to do while the call is out.
 */
async function providerGate(script: string, op: "session" | "script") {
  const at = (path: string, id?: number) => `https://content-fake.example.com/${path}?script=${script}${id === undefined ? "" : `&id=${id}`}`;
  const { id } = (await (await fetch(at("upload-gate"), { method: "POST", body: JSON.stringify({ op }) })).json()) as { id: number };
  return {
    arrived: async () => { await (await fetch(at("upload-arrived", id))).json(); },
    release: async () => { await (await fetch(at("upload-release", id))).json(); },
  };
}
const bucketSize = (script: string, size: number) => fetch(`https://content-fake.example.com/upload-bucket-size?script=${script}&size=${size}`);
const ops = (seen: Provider) => seen.calls.map((call) => `${call.op} ${call.status}`);

// --- a room where a release is uploading -----------------------------------------------------------------------------
const REL = `rel_${"7e".repeat(16)}`;
const PREV = `rel_${"6d".repeat(16)}`;
const TASK = "tsk_ru_1";
let rooms = 0;
const made: string[] = [];
type Healthy = { room: string; label: string; host: string; script: string; prev: string };
/**
 * A room where everything the recheck asks for holds, whose default host serves an earlier release, and whose own
 * release is `uploading` under its script's name. Its applier and delete job have no provider; its upload has.
 */
async function uploading(opts: { provider?: boolean } = {}): Promise<Healthy> {
  const room: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Upload" })).body.id;
  made.push(room);
  await alarmQuiet(stub(room));
  const n = ++rooms;
  const requester = `per_ru_req_${n}`;
  const admin = `per_ru_adm_${n}`;
  const label = `ru${n.toString(36)}x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const host = `${label}.${FAKE.domain}`;
  const [script, prev] = [`${label}.${REL}`, `${label}.${PREV}`];
  await inRoom(room, (sql) => {
    for (const [who, role] of [[requester, "member"], [admin, "admin"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, ?, ?, 1)", who, ORG, role, OWNER.id);
    sql.exec("UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = 1", `ru-${n}-${label}`);
    sql.exec("INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at) VALUES ('rl_1', 'rr_1', 'github', ?, 4242, 'podsterx/upload', 'public', 'main', 'ready', ?, 1, 1, 1)", REPO, OWNER.id);
    sql.exec("INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at) VALUES ('pgr_ru', ?, 'github', ?, 'deploy', ?, 1)", requester, REPO, OWNER.id);
    sql.exec("INSERT INTO task (id, title, instructions, requester_id, reviewer_id, status, version, created_at, updated_at) VALUES (?, 'Ship it', 'x', ?, ?, 'completed', 1, 1, 1)", TASK, OWNER.id, admin);
    sql.exec("INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, merge_state, merge_sha, merge_called_at, merge_finished_at, reviewer_id, created_at, updated_at) VALUES (?, ?, 7, 1, 'succeeded', ?, 1, 1, ?, 1, 1)", TASK, REPO, COMMIT, admin);
    sql.exec("INSERT INTO app_label (label, current, created_at) VALUES (?, 1, 1)", label);
    sql.exec("INSERT INTO release_config (singleton, enabled, version, release_epoch, set_by, set_at, updated_at) VALUES (1, 1, 3, 2, ?, 1, 1)", OWNER.id);
    const release = (id: string, state: string) => sql.exec(
      `INSERT INTO release (id, commit_sha, state, label, config_version, release_epoch, task_id, script_name, script_release_id, requested_by, requested_at, approved_by, approved_at, upload_started_at, updated_at)
         VALUES (?, ?, ?, ?, 3, 2, ?, ?, ?, ?, 1, ?, 1, ?, 1)`, id, COMMIT, state, label, TASK, `${label}.${id}`, id, requester, OWNER.id, Date.now());
    release(PREV, "served");
    release(REL, "uploading");
    sql.exec("INSERT INTO serve_state (host, kind, label, label_current, release_id, script_name, version, updated_at) VALUES (?, 'default', ?, 1, ?, ?, 5, 1)", host, label, PREV, prev);
    sql.exec("INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, updated_at) VALUES (?, 5, ?, 1, 1)", host, prev);
    sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)");
    if (opts.provider !== false) sql.exec("CREATE TABLE test_release_upload_provider (x INTEGER)");
  });
  await BINDINGS.DB.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, 1)").bind(label, room).run();
  return { room, label, host, script, prev };
}
type Answer = { status: number; body: any };
const command = (path: string) => (room: string): Promise<Answer> =>
  switchedOn(() => stub(room).fetch(`https://do/internal/${path}`, { method: "POST", body: JSON.stringify({ release_id: REL }) }).then(async (r: Response) => ({ status: r.status, body: (await r.json()) as any })));
const upload = command("release-upload");
const commit = command("release-commit-live");
const row = (room: string) => inRoom(room, (sql) => sql.exec("SELECT state, failure_code FROM release WHERE id = ?", REL).one());
const record = (room: string) => inRoom(room, (sql) => sql.exec("SELECT release_id, script_name, files, bytes FROM release_upload").toArray());
const queued = (room: string) => inRoom(room, (sql) => sql.exec("SELECT script_name, gone_at IS NOT NULL AS gone, last_code FROM script_delete").toArray());
const host = (room: string) => inRoom(room, (sql) => sql.exec("SELECT script_name, release_id, version FROM serve_state").one());
const reserved = () => inModeration((sql) => sql.exec("SELECT release_id, reads FROM release_reads").toArray());
const hook = (table: string) => (room: string, ...statements: string[]) => inRoom(room, (sql) => {
  sql.exec(`CREATE TABLE ${table} (statement TEXT)`);
  for (const statement of statements) sql.exec(`INSERT INTO ${table} (statement) VALUES (?)`, statement);
});
/** Statements the room runs after the files are sent and before it is asked again. */
const beforeCheck = hook("test_release_upload_before_check");
/** Statements the room runs after it was asked again and before the script is written. */
const beforeWrite = hook("test_release_between_reads");
const brief = (answer: Answer) => [answer.status, answer.body.state, answer.body.uploaded, answer.body.waiting ?? null, answer.body.reason ?? null];

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});
beforeEach(async () => {
  await github("/reset", {});
  await moderation().fetch("https://do/release-reads", { method: "POST", body: JSON.stringify({ release_id: `rel_${"0".repeat(32)}`, reads: 1 }) });
  await inModeration((sql) => sql.exec("DELETE FROM release_reads"));
});
afterEach(async () => { for (const room of made.splice(0)) await alarmQuiet(stub(room)); });

describe("uploading a release's static files", () => {
  it("reads the release directory and writes it as the release's own script, whole, with the job's marker, and serves nothing", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    const answer = await upload(h.room);
    expect(brief(answer)).toEqual([200, "uploading", true, null, null]);
    const seen = await provider(h.script);
    // The session, a call for each bucket of two hashes, and the script: six hashes, the marker's among them.
    expect(ops(seen)).toEqual(["session 200", "bucket 202", "bucket 202", "bucket 201", "script 200"]);
    // The manifest names every file at its path under `/`, with its size and its hash over its type and bytes.
    const marker = `{"release_id":"${REL}","commit":"${COMMIT}"}\n`;
    const expected: Record<string, { hash: string; size: number }> = { "/.well-known/podster-release.json": { hash: hashOf("application/json", marker), size: marker.length } };
    for (const [path, text] of Object.entries(SITE)) expected[`/${path}`] = { hash: hashOf(TYPES[path], text), size: text.length };
    expect(seen.calls[0].manifest).toEqual(expected);
    // What the script holds: each file's own bytes, served with Podster's type for it, never the stand-in's.
    const files = seen.written!.files;
    expect(Object.keys(files).sort()).toEqual(Object.keys(expected).sort());
    for (const [path, text] of Object.entries(SITE)) expect([files[`/${path}`].type, Buffer.from(files[`/${path}`].base64, "base64").toString()], path).toEqual([TYPES[path], text]);
    expect([files["/.well-known/podster-release.json"].type, Buffer.from(files["/.well-known/podster-release.json"].base64, "base64").toString()]).toEqual(["application/json", marker]);
    // **Static files only:** one part, the metadata, naming the completion token and nothing that runs or binds.
    const written = seen.calls.find((call) => call.op === "script")!;
    expect(written.parts).toEqual(["metadata"]);
    expect(written.query).toBe("?excludeScript=true&bindings_inherit=strict");
    // **The metadata is exactly these bytes:** Podster's own fixed assets configuration, written out, the
    // completion token, a date and no flags. Nothing is left to the provider's defaults, and nothing is the room's.
    const token = seen.written!.metadata.assets.jwt;
    expect(token).toMatch(/^cfwau_test-completion-/);
    expect(seen.written!.metadataText).toBe(`{"assets":{"config":{"html_handling":"auto-trailing-slash","not_found_handling":"none"},"jwt":"${token}"},"compatibility_date":"2026-11-01","compatibility_flags":[]}`);
    // Each bucket went with `base64=true`.
    expect(seen.calls.filter((call) => call.op === "bucket").every((call) => call.query === "?base64=true")).toBe(true);
    // The room records the upload: six files, their bytes and the marker's.
    expect(await record(h.room)).toEqual([{ release_id: REL, script_name: h.script, files: 6, bytes: 62 + marker.length }]);
    // **Nothing is served:** the release is still uploading, and the host still names the release before it.
    expect(await row(h.room)).toEqual({ state: "uploading", failure_code: null });
    expect(await host(h.room)).toEqual({ script_name: h.prev, release_id: PREV, version: 5 });
    // GitHub: one token for this repository, the two trees, each file fetched twice, and the token given back.
    const gh = await githubState();
    expect(gh.minted).toEqual([{ repository_ids: [REPO], permissions: { contents: "read", metadata: "read" } }]);
    expect(blobReads(gh)).toBe(10);
    expect(gh.tokens.map((token) => token.revoked)).toEqual([true]);
    expect(asked(gh).at(-1)).toBe("DELETE /installation/token");
    // And every one of those reads was reserved: two trees, and two passes over five files.
    expect(await reserved()).toEqual([{ release_id: REL, reads: 12 }]);
  });

  it("commits nothing live until the room has recorded the upload", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    // Before the upload: the commit waits, stages nothing, and decides nothing.
    const early = await commit(h.room);
    expect([early.status, early.body.state, early.body.waiting]).toEqual([200, "uploading", "release_not_uploaded"]);
    expect(await host(h.room)).toEqual({ script_name: h.prev, release_id: PREV, version: 5 });
    // An upload whose script wasn't written leaves it waiting still.
    await providerFault(h.script, { op: "script", status: 500 });
    expect(brief(await upload(h.room))).toEqual([200, "uploading", false, "release_upload_unavailable", null]);
    expect((await commit(h.room)).body.waiting).toBe("release_not_uploaded");
    // After it: the same commit goes live.
    expect(brief(await upload(h.room))).toEqual([200, "uploading", true, null, null]);
    const live = await commit(h.room);
    expect([live.status, live.body.state]).toEqual([200, "live"]);
    expect((await host(h.room)).script_name).toBe(h.script);
  });

  it("sends a file whose bytes and type another file shares once, and takes buckets of any size", async () => {
    await github("/seed", repository({ "a.html": "same", "b.html": "same", "c.txt": "same", "d.html": "other" }));
    const h = await uploading();
    await bucketSize(h.script, 50);
    expect(brief(await upload(h.room))).toEqual([200, "uploading", true, null, null]);
    const seen = await provider(h.script);
    // One bucket: three hashes of files and the marker's. `a.html` and `b.html` are one hash; `c.txt` is another.
    expect(ops(seen)).toEqual(["session 200", "bucket 201", "script 200"]);
    expect(seen.calls[1].hashes).toHaveLength(4);
    const files = seen.written!.files;
    expect(files["/a.html"].hash).toBe(files["/b.html"].hash);
    expect(files["/a.html"].hash).not.toBe(files["/c.txt"].hash);
    expect(Buffer.from(files["/b.html"].base64, "base64").toString()).toBe("same");
    // The second pass fetched three files, not four: 4 + 3.
    expect(blobReads(await githubState())).toBe(7);
    // One hash to a bucket works the same.
    const one = await uploading();
    await bucketSize(one.script, 1);
    expect(brief(await upload(one.room))).toEqual([200, "uploading", true, null, null]);
    expect(ops(await provider(one.script))).toEqual(["session 200", "bucket 202", "bucket 202", "bucket 202", "bucket 201", "script 200"]);
  });
});

describe("how much goes in one request", () => {
  it("sends at most 8 MiB of files in one request, however large the provider's bucket", async () => {
    const MIB = 1024 * 1024;
    // Three files of 3 MiB and a small one: 9 MiB and a little, which the provider asks for in one bucket.
    const big = (letter: string) => letter + "x".repeat(3 * MIB - 1);
    await github("/seed", repository({ "a.bin": big("a"), "b.bin": big("b"), "c.bin": big("c"), "index.html": "<p>one</p>\n" }));
    const h = await uploading();
    await bucketSize(h.script, 50);
    expect(brief(await upload(h.room))).toEqual([200, "uploading", true, null, null]);
    const seen = await provider(h.script);
    const sent = seen.calls.filter((call) => call.op === "bucket");
    // One bucket of five hashes went as two requests, each within the cap, every hash once.
    expect(seen.calls[0].op).toBe("session");
    expect(sent.map((call) => call.status)).toEqual([202, 201]);
    for (const call of sent) expect(call.bytes).toBeLessThanOrEqual(8 * MIB);
    expect(Math.max(...sent.map((call) => call.bytes!))).toBeGreaterThan(5 * MIB);
    expect(sent.flatMap((call) => call.hashes!).sort()).toEqual(Object.values(seen.calls[0].manifest!).map((file) => file.hash).sort());
    // And the script holds each file whole.
    for (const letter of ["a", "b", "c"]) expect(Buffer.from(seen.written!.files[`/${letter}.bin`].base64, "base64").toString() === big(letter), letter).toBe(true);
    expect(await record(h.room)).toEqual([{ release_id: REL, script_name: h.script, files: 5, bytes: 9 * MIB + 11 + `{"release_id":"${REL}","commit":"${COMMIT}"}\n`.length }]);
  });
});

describe("an upload asked again", () => {
  it("asks nobody anything for a release already recorded", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    await upload(h.room);
    const [gh, seen, held] = [await githubState(), await provider(h.script), await reserved()];
    expect(brief(await upload(h.room))).toEqual([200, "uploading", true, null, null]);
    expect([await githubState(), await provider(h.script), await reserved()]).toEqual([gh, seen, held]);
    expect(await record(h.room)).toHaveLength(1);
  });

  it("writes the same script again when the answer to its write was lost, sending no file a second time", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    // The script is written, and the answer never arrives.
    await providerFault(h.script, { op: "script", lost: true });
    expect(brief(await upload(h.room))).toEqual([200, "uploading", false, "release_upload_unavailable", null]);
    expect((await provider(h.script)).written!.times).toBe(1);
    expect(await record(h.room)).toEqual([]);
    // Again: the provider holds every file under this script's name, so its session asks for none.
    expect(brief(await upload(h.room))).toEqual([200, "uploading", true, null, null]);
    const seen = await provider(h.script);
    expect(ops(seen)).toEqual(["session 200", "bucket 202", "bucket 202", "bucket 201", "script 502", "session 200", "script 200"]);
    expect(seen.written!.times).toBe(2);
    expect(await record(h.room)).toHaveLength(1);
    // Both attempts' reads are counted: twelve, then two trees and one pass, since nothing was fetched to send.
    expect(await reserved()).toEqual([{ release_id: REL, reads: 24 }]);
    expect((await githubState()).tokens.map((token) => token.revoked)).toEqual([true, true]);
  });

  it("starts over after a bucket was lost, and sends only what the provider doesn't hold", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    await providerFault(h.script, { op: "bucket", lost: true });
    expect(brief(await upload(h.room))).toEqual([200, "uploading", false, "release_upload_unavailable", null]);
    expect((await provider(h.script)).written).toBeNull();
    expect(brief(await upload(h.room))).toEqual([200, "uploading", true, null, null]);
    // The first bucket's two files were kept: the second session asks for four hashes, in two buckets.
    expect(ops(await provider(h.script))).toEqual(["session 200", "bucket 502", "session 200", "bucket 202", "bucket 201", "script 200"]);
  });
});

describe("two attempts at one upload, overlapping", () => {
  it("records one upload when both write the script, and the second to finish changes nothing", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    // The first attempt's write of the script is held at the provider while a second attempt runs whole.
    const gate = await providerGate(h.script, "script");
    const first = upload(h.room);
    // Its write is reached only once its buckets are done.
    await gate.arrived();
    expect((await provider(h.script)).calls.some((call) => call.op === "bucket" && call.status === 201)).toBe(true);
    const second = await upload(h.room);
    expect(brief(second)).toEqual([200, "uploading", true, null, null]);
    expect(await record(h.room)).toHaveLength(1);
    const before = await record(h.room);
    await gate.release();
    // The first comes back to a release already recorded: the same answer, and the record as it was.
    expect(brief(await first)).toEqual([200, "uploading", true, null, null]);
    expect(await record(h.room)).toEqual(before);
    expect((await provider(h.script)).written!.times).toBe(2);
    expect((await provider(h.script)).expiredGates).toBe(0);
    expect((await githubState()).tokens.map((token) => token.revoked)).toEqual([true, true]);
  });

  it("never lets a late attempt's failure end a release another attempt uploaded and the room took live", async () => {
    await github("/seed", repository(SITE));
    // `index.html` is right for the first attempt's hash, right twice for the second attempt, and wrong when the
    // first attempt comes back for it: a failure that would end the release, found by an attempt that is stale.
    await github("/fault", { blob: { [blobSha(bytes(SITE["index.html"]))]: ["ok", "ok", "ok", "other_bytes"] } });
    const h = await uploading();
    // The first attempt's session is held at the provider, after it has said which files it wants.
    const gate = await providerGate(h.script, "session");
    const first = upload(h.room);
    await gate.arrived();
    expect(blobReads(await githubState())).toBe(5);
    // The second attempt uploads, and the room commits the release live.
    expect(brief(await upload(h.room))).toEqual([200, "uploading", true, null, null]);
    expect((await commit(h.room)).body.state).toBe("live");
    // The first attempt now finds a file that isn't what the tree said. The release is live, and stays so.
    await gate.release();
    const late = await first;
    expect([late.status, late.body.state, late.body.uploaded, late.body.waiting ?? null]).toEqual([200, "live", true, null]);
    expect(await row(h.room)).toEqual({ state: "live", failure_code: null });
    expect((await host(h.room)).script_name).toBe(h.script);
    expect(await queued(h.room)).toEqual([]);
    expect((await provider(h.script)).expiredGates).toBe(0);
  });

  it("never lets a late attempt's failure end a release another attempt has recorded, before any commit", async () => {
    await github("/seed", repository(SITE));
    await github("/fault", { blob: { [blobSha(bytes(SITE["index.html"]))]: ["ok", "ok", "ok", "other_bytes"] } });
    const h = await uploading();
    const gate = await providerGate(h.script, "session");
    const first = upload(h.room);
    // Held at its session, its five reads done.
    await gate.arrived();
    expect(brief(await upload(h.room))).toEqual([200, "uploading", true, null, null]);
    await gate.release();
    const late = await first;
    expect([late.status, late.body.state, late.body.uploaded, late.body.waiting ?? null]).toEqual([200, "uploading", true, null]);
    expect(await row(h.room)).toEqual({ state: "uploading", failure_code: null });
    expect([await record(h.room), await queued(h.room)]).toEqual([[{ release_id: REL, script_name: h.script, files: 6, bytes: 168 }], []]);
    // And the room still commits it.
    expect((await commit(h.room)).body.state).toBe("live");
    expect((await provider(h.script)).expiredGates).toBe(0);
  });

  it("never answers that a release waits when it is recorded, or has ended, by the time an attempt gives up", async () => {
    await github("/seed", repository(SITE));
    // Recorded by a second attempt while the first, held at its session, then gets a bucket refused.
    const h = await uploading();
    const gate = await providerGate(h.script, "session");
    await providerFault(h.script, { op: "bucket", status: 500, times: 1 });
    const first = upload(h.room);
    await gate.arrived();
    // The second attempt takes the refused bucket, and waits; a third uploads.
    expect(brief(await upload(h.room))).toEqual([200, "uploading", false, "release_upload_unavailable", null]);
    expect(brief(await upload(h.room))).toEqual([200, "uploading", true, null, null]);
    // The first's own buckets are refused now: the provider's session for them has nothing left to want. It gives
    // up, and answers the release as it is: uploaded, and not waiting.
    await providerFault(h.script, { op: "bucket", status: 500, times: 5 });
    await gate.release();
    const late = await first;
    expect([late.body.state, late.body.uploaded, late.body.waiting ?? null]).toEqual(["uploading", true, null]);
    expect((await provider(h.script)).expiredGates).toBe(0);
    // Ended while an attempt was out: answered as failed, with its reason, and not as waiting.
    await github("/reset", {});
    await github("/seed", repository(SITE));
    const ended = await uploading();
    const held = await providerGate(ended.script, "session");
    await providerFault(ended.script, { op: "bucket", status: 500, times: 5 });
    const out = upload(ended.room);
    await held.arrived();
    await inRoom(ended.room, (sql) => sql.exec("UPDATE release SET state = 'failed', failure_code = 'release_upload_expired', finished_at = 1 WHERE id = ?", REL));
    await held.release();
    const answer = await out;
    expect([answer.body.state, answer.body.uploaded, answer.body.waiting ?? null, answer.body.reason]).toEqual(["failed", false, null, "release_upload_expired"]);
    expect((await provider(ended.script)).expiredGates).toBe(0);
  });
});

describe("a room that changes while its release uploads", () => {
  const moved = "UPDATE release_config SET release_epoch = release_epoch + 1";

  it("writes no script when the release epoch moved while the files were sent", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    await beforeCheck(h.room, moved);
    const answer = await upload(h.room);
    expect(brief(answer)).toEqual([200, "failed", false, null, "release_epoch_moved"]);
    const seen = await provider(h.script);
    expect([ops(seen).filter((op) => op.startsWith("script")), seen.written]).toEqual([[], null]);
    expect(await record(h.room)).toEqual([]);
    // Its script's name is owed a deletion all the same, as every ended release's is.
    expect((await queued(h.room)).map((q: any) => q.script_name)).toEqual([h.script]);
    expect((await githubState()).tokens.map((token) => token.revoked)).toEqual([true]);
  });

  it("owes the script its deletion again when the release ended while the script was being written", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    await beforeWrite(h.room, moved);
    const answer = await upload(h.room);
    expect(brief(answer)).toEqual([200, "failed", false, null, "release_epoch_moved"]);
    // The script was written: the room had said yes a moment before.
    expect((await provider(h.script)).written!.times).toBe(1);
    expect(await record(h.room)).toEqual([]);
    expect(await queued(h.room)).toEqual([{ script_name: h.script, gone: 0, last_code: "written_after_end" }]);
    // And a commit finds a failed release, and stages nothing.
    expect((await commit(h.room)).body.state).toBe("failed");
    expect((await host(h.room)).script_name).toBe(h.prev);
  });

  it("takes back a deletion already counted done, when the write landed after it", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    // Ended, its script deleted and counted gone, all between the room's yes and the write.
    await beforeWrite(h.room,
      `UPDATE release SET state = 'failed', failure_code = 'release_upload_expired', finished_at = 1 WHERE id = '${REL}'`,
      `INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at, attempts, gone_at) VALUES ('${h.script}', '${h.label}', 1, 1, 1, 2)`);
    expect(brief(await upload(h.room))).toEqual([200, "failed", false, null, "release_upload_expired"]);
    expect((await provider(h.script)).written!.times).toBe(1);
    expect(await queued(h.room)).toEqual([{ script_name: h.script, gone: 0, last_code: "written_after_end" }]);
  });

  it("records no upload for a script queued for deletion while it was being written, though the release still uploads", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    await beforeWrite(h.room, `INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES ('${h.script}', '${h.label}', 1, 4102444800000)`);
    const answer = await upload(h.room);
    expect([answer.body.state, answer.body.uploaded]).toEqual(["uploading", false]);
    expect((await provider(h.script)).written!.times).toBe(1);
    expect(await record(h.room)).toEqual([]);
    // A commit then ends it: a script that may be gone is never set on a host.
    expect((await commit(h.room)).body.reason).toBe("release_script_deleted");
    expect((await host(h.room)).script_name).toBe(h.prev);
  });

  it("asks everyone again before the script is written: a stop set while the files were sent ends it, with no script", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    // The session is held at the provider. The first check has passed by then, on reads made before the stop.
    const gate = await providerGate(h.script, "session");
    await moderation().fetch("https://do/content-stop");
    const clear = () => inModeration((sql) => sql.exec("UPDATE content_stop SET stopped = 0, reason = NULL, at = NULL, version = version + 1"));
    const out = upload(h.room);
    try {
      await gate.arrived();
      expect(blobReads(await githubState())).toBe(5);
      // The stop for the whole content domain, set now, in its own object.
      await inModeration((sql) => sql.exec("INSERT INTO content_stop (singleton, stopped, reason, at, version, updated_at) VALUES (1, 1, 'illegal', 1, 1, 1) ON CONFLICT (singleton) DO UPDATE SET stopped = 1, reason = 'illegal', at = 1, version = version + 1"));
      await gate.release();
      const answer = await out;
      expect([answer.status, answer.body.state, answer.body.uploaded]).toEqual([200, "failed", false]);
      expect(answer.body.reason).toBe("release_stopped");
    } finally { await gate.release(); await clear(); }
    // The files went up, and the script was never asked for.
    const seen = await provider(h.script);
    expect(seen.expiredGates).toBe(0);
    expect([ops(seen).filter((op) => op.startsWith("script")), seen.written]).toEqual([[], null]);
    expect(ops(seen).filter((op) => op.startsWith("bucket"))).toHaveLength(3);
  });

  it("writes nothing under a script already queued for deletion, or under a label that isn't the room's any more", async () => {
    await github("/seed", repository(SITE));
    const gone = await uploading();
    await inRoom(gone.room, (sql) => sql.exec("INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES (?, ?, 1, 1)", gone.script, gone.label));
    expect(brief(await upload(gone.room))).toEqual([200, "failed", false, null, "release_script_deleted"]);
    const late = await uploading();
    await beforeCheck(late.room, `INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES ('${late.script}', '${late.label}', 1, 1)`);
    expect(brief(await upload(late.room))).toEqual([200, "failed", false, null, "release_script_deleted"]);
    for (const h of [gone, late]) expect((await provider(h.script)).written, h.script).toBeNull();
    // Only the first asked GitHub nothing: it was refused before the read.
    expect((await githubState()).minted).toHaveLength(1);
  });

  it("ends the release before anything is asked of anyone when the recheck fails", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    await inRoom(h.room, (sql) => sql.exec("UPDATE workspace SET visibility = 'private'"));
    const answer = await upload(h.room);
    expect([answer.status, answer.body.state, answer.body.uploaded]).toEqual([200, "failed", false]);
    expect(answer.body.reason).toBe((await row(h.room)).failure_code);
    expect([(await githubState()).calls, (await provider(h.script)).calls, await reserved()]).toEqual([[], [], []]);
  });
});

describe("a read that gives nothing to upload", () => {
  it("fails the release on what its repository holds, and asks the provider nothing", async () => {
    const cases: [string, ReturnType<typeof repository>, object | null, string][] = [
      ["a refused name", repository({ ...SITE, "_headers": "/*\n  X: y\n" }), null, "release_refused_name"],
      ["a symlink", repository(SITE, [{ path: "link", mode: "120000", type: "blob", sha: sha(4), size: 9 }]), null, "release_symlink"],
      ["a file at the marker's path", repository({ ...SITE, ".well-known/podster-release.json": "{}" }), null, "release_refused_name"],
      ["a commit the repository doesn't have", { ...repository(SITE), trees: {} }, null, "release_commit_unreadable"],
      ["a file that isn't what the tree said", repository(SITE), { blob: { [blobSha(bytes(SITE["app.js"]))]: "other_bytes" } }, "release_file_mismatch"],
    ];
    for (const [what, repo, fault, code] of cases) {
      await github("/reset", {});
      await github("/seed", repo);
      if (fault) await github("/fault", fault);
      const h = await uploading();
      expect(brief(await upload(h.room)), what).toEqual([200, "failed", false, null, code]);
      expect((await provider(h.script)).calls, what).toEqual([]);
      expect(await row(h.room), what).toEqual({ state: "failed", failure_code: code });
      // The ended release's script name is owed its deletion, though nothing was written under it.
      expect((await queued(h.room)).map((q: any) => q.script_name), what).toEqual([h.script]);
      expect((await githubState()).tokens.map((token) => token.revoked), what).toEqual([true]);
    }
  });

  it("fails the release, with nothing written, on a file that changed between being hashed and being sent", async () => {
    await github("/seed", repository(SITE));
    await github("/fault", { blob: { [blobSha(bytes(SITE["index.html"]))]: ["ok", "other_bytes"] } });
    const h = await uploading();
    expect(brief(await upload(h.room))).toEqual([200, "failed", false, null, "release_file_mismatch"]);
    const seen = await provider(h.script);
    expect([seen.written, ops(seen).filter((op) => op.startsWith("script"))]).toEqual([null, []]);
  });

  it("waits, with the release as it was, when GitHub gives no answer to go on or the budget has no room", async () => {
    const index = blobSha(bytes(SITE["index.html"]));
    const cases: [string, object, string][] = [
      ["no token", { token: 500 }, "release_read_unavailable"],
      ["a page in place of the tree", { tree: { [COMMIT]: "html" } }, "release_read_unavailable"],
      ["a rate limit on the directory's tree", { tree: { [DIRECTORY]: 429 } }, "release_read_unavailable"],
      ["a file that didn't come", { blob: { [index]: 502 } }, "release_read_unavailable"],
      ["a page in a file's place", { blob: { [index]: "html" } }, "release_read_unavailable"],
      ["a page in a file's place the second time", { blob: { [index]: ["ok", "html"] } }, "release_read_unavailable"],
      ["a file that didn't come the second time", { blob: { [index]: ["ok", 502] } }, "release_read_unavailable"],
    ];
    for (const [what, fault, code] of cases) {
      await github("/reset", {});
      await github("/seed", repository(SITE));
      await github("/fault", fault);
      const h = await uploading();
      expect(brief(await upload(h.room)), what).toEqual([200, "uploading", false, code, null]);
      expect([(await provider(h.script)).written, await record(h.room), await queued(h.room)], what).toEqual([null, [], []]);
      const tokens = (await githubState()).tokens;
      expect(tokens.every((token) => token.revoked), what).toBe(true);
    }
    // The budget: 2,995 held elsewhere. The trees fit, the files don't, and the answer says when to ask again.
    await github("/reset", {});
    await github("/seed", repository(SITE));
    await inModeration((sql) => sql.exec("DELETE FROM release_reads"));
    await moderation().fetch("https://do/release-reads", { method: "POST", body: JSON.stringify({ release_id: `rel_${"9".repeat(32)}`, reads: 2995 }) });
    const h = await uploading();
    const answer = await upload(h.room);
    expect(brief(answer)).toEqual([200, "uploading", false, "release_reads_budget", null]);
    expect(typeof answer.body.retry_at).toBe("number");
    expect([blobReads(await githubState()), (await provider(h.script)).calls]).toEqual([0, []]);
  });

  it("stops at the attempt's deadline, by the clock it is given, having written nothing and given its token back", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading();
    // A clock that moves on by a tenth of the deadline each time it is read: it runs out among the file reads.
    await inRoom(h.room, (sql) => { sql.exec("CREATE TABLE test_release_upload_clock (step_ms INTEGER)"); sql.exec("INSERT INTO test_release_upload_clock VALUES (30000)"); });
    expect(brief(await upload(h.room))).toEqual([200, "uploading", false, "release_read_unavailable", null]);
    const gh = await githubState();
    expect(blobReads(gh)).toBeLessThan(10);
    expect(gh.tokens.map((token) => token.revoked)).toEqual([true]);
    expect((await provider(h.script)).written).toBeNull();
    // A clock that runs out after the last file was hashed: the provider is asked nothing, not even for a session.
    await github("/reset", {});
    await github("/seed", repository(SITE));
    const other = await uploading();
    await inRoom(other.room, (sql) => { sql.exec("CREATE TABLE test_release_upload_clock (step_ms INTEGER)"); sql.exec("INSERT INTO test_release_upload_clock VALUES (28000)"); });
    expect(brief(await upload(other.room))).toEqual([200, "uploading", false, "release_upload_unavailable", null]);
    expect([blobReads(await githubState()), (await provider(other.script)).calls]).toEqual([5, []]);
    expect((await githubState()).tokens.map((token) => token.revoked)).toEqual([true]);
    // With the Worker's own clock the same room uploads.
    await github("/reset", {});
    await github("/seed", repository(SITE));
    await inRoom(h.room, (sql) => sql.exec("DROP TABLE test_release_upload_clock"));
    expect(brief(await upload(h.room))).toEqual([200, "uploading", true, null, null]);
  });
});

describe("a provider that doesn't answer as it must", () => {
  it("records no upload on anything but the three answers the upload was seen to get", async () => {
    const faults: [string, object, boolean][] = [
      ["the session refused", { op: "session", status: 500 }, false],
      ["the session forbidden", { op: "session", status: 403 }, false],
      ["a session that doesn't say success", { op: "session", shape: "not_success" }, false],
      ["a session with no token", { op: "session", shape: "no_token" }, false],
      ["a session asking for a hash the manifest doesn't hold", { op: "session", shape: "unknown_hash" }, false],
      ["a session asking for a hash twice", { op: "session", shape: "hash_twice" }, false],
      ["a session with an empty bucket", { op: "session", shape: "empty_bucket" }, false],
      ["a page in place of the session", { op: "session", shape: "html" }, false],
      ["a bucket refused", { op: "bucket", status: 500 }, false],
      ["a page in place of a bucket's answer", { op: "bucket", shape: "html" }, false],
      ["done said before the last bucket", { op: "bucket", shape: "done_early" }, false],
      ["done never said", { op: "bucket", shape: "never_done", times: 3 }, false],
      ["the script refused", { op: "script", status: 400 }, false],
      ["the script's write refused in a body that says success", { op: "script", shape: "refused_but_success" }, true],
      ["the script's write not saying success", { op: "script", shape: "not_success" }, true],
      ["the script's write naming another script", { op: "script", shape: "other_id" }, true],
      ["a page in place of the script's answer", { op: "script", shape: "html" }, true],
    ];
    await github("/seed", repository(SITE));
    for (const [what, fault, written] of faults) {
      const h = await uploading();
      await providerFault(h.script, fault);
      expect(brief(await upload(h.room)), what).toEqual([200, "uploading", false, "release_upload_unavailable", null]);
      expect([await record(h.room), await queued(h.room)], what).toEqual([[], []]);
      const seen = await provider(h.script);
      expect(seen.written !== null, what).toBe(written);
      // **Nothing goes on past an answer that can't be gone on:** a session that isn't one sends no file, and a
      // bucket not taken as it must be writes no script.
      const op = (fault as { op: string }).op;
      if (op === "session") expect(ops(seen), what).toEqual([ops(seen)[0]]);
      if (op === "bucket") expect(ops(seen).filter((call) => call.startsWith("script")), what).toEqual([]);
      // Whatever the provider did, a commit stages nothing.
      expect((await commit(h.room)).body.waiting, what).toBe("release_not_uploaded");
      expect((await host(h.room)).script_name, what).toBe(h.prev);
    }
    expect((await githubState()).tokens.every((token) => token.revoked)).toBe(true);
  });

  it("waits, asking GitHub nothing, with no provider to upload to", async () => {
    await github("/seed", repository(SITE));
    const h = await uploading({ provider: false });
    expect(brief(await upload(h.room))).toEqual([200, "uploading", false, "content_provider_not_configured", null]);
    expect([(await githubState()).calls, await reserved()]).toEqual([[], []]);
  });
});

describe("the upload's own boundaries", () => {
  it("is reached by no client, is refused while the release path isn't complete, and uploads nothing but static files", async () => {
    await github("/seed", repository(SITE));
    for (const path of ["/internal/release-upload", "/v1/internal/release-upload"]) {
      const answer = await SELF.fetch(`https://api.internal${path}`, { method: "POST", body: JSON.stringify({ release_id: REL }) });
      expect(answer.status, path).toBeGreaterThanOrEqual(400);
    }
    // **The gate:** a room with a provider, on a deployment with release switched on, refuses the command, as it
    // refuses every release command until the path is complete.
    const h = await uploading();
    await inRoom(h.room, (sql) => sql.exec("DROP TABLE test_content_provider_off"));
    const gated = await upload(h.room);
    await inRoom(h.room, (sql) => sql.exec("CREATE TABLE test_content_provider_off (x INTEGER)"));
    expect(gated.status).toBeGreaterThanOrEqual(400);
    expect([(await githubState()).calls, (await provider(h.script)).calls]).toEqual([[], []]);
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    expect(sources["workspace/release_commit.rs"]).toContain("pub(crate) const RELEASE_PATH_COMPLETE: bool = false;");
    // The script's metadata is three fixed fields: no module, no binding, no store, and nothing from a repository.
    const source = sources["content_provider/upload.rs"];
    const metadata = source.slice(source.indexOf("let metadata = format!("), source.indexOf(");", source.indexOf("let metadata = format!(")));
    expect(metadata.match(/"[a-z_]+\\":/g)).toEqual(['"assets\\":', '"config\\":', '"jwt\\":', '"compatibility_date\\":', '"compatibility_flags\\":']);
    // The assets configuration is one constant, with two fields and nothing a repository could reach.
    expect(source.match(/const ASSETS_CONFIG: &str =\s*r#"([^#]+)"#;/)?.[1]).toBe('{"html_handling":"auto-trailing-slash","not_found_handling":"none"}');
    expect(source.match(/ASSETS_CONFIG/g)).toHaveLength(3);
    for (const word of ["main_module", "bindings\"", "durable_objects", "kv_namespaces", "d1_databases", "migrations"]) expect(source, word).not.toContain(word);
    // The test-only switches are compiled only into test builds.
    for (const name of ["test_release_upload_provider", "test_release_upload_before_check", "test_release_upload_clock"]) {
      const lines = sources["workspace/release_upload.rs"].split("\n");
      const at = lines.findIndex((line) => line.includes(`name = '${name}'`));
      expect(at, name).toBeGreaterThan(0);
      expect(lines.slice(Math.max(0, at - 12), at).some((line) => line.includes('#[cfg(feature = "failpoints")]')), name).toBe(true);
    }
  });
});
