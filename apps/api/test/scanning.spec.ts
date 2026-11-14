import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { alarmPass, alarmQuiet } from "./alarm.ts";

const BINDINGS = env as any;
const SECRET = "test-scanner-secret";
const OWNER = { id: "per_owner", org: "org_a" };
const HOUR = 60 * 60 * 1000;
let key: any;
let counter = 0;

async function assertion() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "person", org: OWNER.org, orgs: [], admin_orgs: [OWNER.org] })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(OWNER.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}
async function api(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const inRoom = <T>(id: string, fn: (sql: any, state: any) => T) => runInDurableObject(stub(id), (_: any, state: any) => fn(state.storage.sql, state));
const row = (id: string, object: string) => inRoom(id, (sql) => sql.exec("SELECT * FROM stored_object WHERE id = ?", object).toArray()[0]);
const DATA = new TextEncoder().encode("some notes\n".repeat(100));
const sha256 = async (data: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Every room a test makes, quieted after it so that no alarm of it runs into the next test. */
const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)));
});

async function room() {
  const id = (await api("POST", "/v1/workspaces", { name: "Scans" })).body.id as string;
  madeRooms.push(id);
  return id;
}
/** A stored file, waiting for its scan. */
async function stored(id: string, name = "notes.txt") {
  const hash = await sha256(DATA);
  const upload = (await api("POST", `/v1/workspaces/${id}/uploads`, { name, size: DATA.length, sha256: hash })).body;
  const res = await SELF.fetch(`https://api.internal${upload.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${upload.token}` }, body: DATA });
  expect(res.status).toBe(200);
  const key = (await row(id, upload.id)).object_key as string;
  return { id: upload.id as string, hash, key };
}
const DAY = 24 * HOUR;
const DATABASE = { engine: "1.5.4", version: "28176", built_at: new Date(Date.now() - DAY).toISOString() };
const verdict = (id: string, file: { id: string; hash: string; key: string }, over: object = {}) => ({ v: 1, workspace_id: id, object_id: file.id, key: file.key, report: "no_known_malware", reason: "none", sha256: file.hash, bytes: DATA.length, database: DATABASE, scanned_at: 1, ...over });
const send = (body: unknown, secret: string | null = SECRET) => SELF.fetch("https://api.internal/internal/scan-result", { method: "POST", headers: secret === null ? {} : { "x-podster-scanner": secret }, body: JSON.stringify(body) });
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

describe("a scanner's verdict", () => {
  it("makes a clean file ready, storing what said so", async () => {
    const id = await room();
    const file = await stored(id);
    expect((await row(id, file.id)).state).toBe("scanning");
    const res = await answer(await send(verdict(id, file)));
    expect(res).toEqual({ status: 200, body: { state: "ready" } });
    const saved = await row(id, file.id);
    expect(saved.state).toBe("ready");
    expect(saved.scan_sha256).toBe(file.hash);
    expect(JSON.parse(saved.scan_database_json)).toEqual(DATABASE);
    expect(saved.scanned_at).toEqual(expect.any(Number));
  });

  it.each([
    ["a finding", "malware_found", "blocked"],
    ["an unreadable file", "unreadable", "blocked"],
    ["a word it doesn't know", "looks_fine_to_me", "blocked"],
    ["no words at all", undefined, "blocked"],
  ])("blocks on %s", async (_name, report, want) => {
    const id = await room();
    const file = await stored(id);
    expect((await answer(await send(verdict(id, file, { report, database: null })))).body.state).toBe(want);
    expect((await row(id, file.id)).state).toBe(want);
  });

  it.each([
    ["a wrong secret", "not-the-secret"],
    ["no secret", null],
    ["an empty secret", ""],
    ["a secret with more on the end", `${SECRET}x`],
  ])("gets nowhere with %s, even for a clean report that's otherwise right", async (_name, secret) => {
    const id = await room();
    const file = await stored(id);
    const res = await send(verdict(id, file), secret);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe("not_found");
    expect((await row(id, file.id)).state).toBe("scanning");
  });

  it("answers a wrong secret the same as a route that isn't there", async () => {
    const missing = await SELF.fetch("https://api.internal/internal/nothing", { method: "POST", headers: { "x-podster-assertion": await assertion() }, body: "{}" });
    const wrong = await send({}, "wrong");
    expect(wrong.status).toBe(missing.status);
    expect(await wrong.json()).toEqual(await missing.json());
  });

  it("can't be reached with an assertion instead of the secret", async () => {
    const id = await room();
    const file = await stored(id);
    const res = await SELF.fetch("https://api.internal/internal/scan-result", { method: "POST", headers: { "x-podster-assertion": await assertion() }, body: JSON.stringify(verdict(id, file)) });
    expect(res.status).toBe(404);
    expect((await row(id, file.id)).state).toBe("scanning");
  });

  it("isn't a path a room's own routes answer", async () => {
    const id = await room();
    const file = await stored(id);
    const res = await api("POST", `/v1/workspaces/${id}/internal/scan-result`, verdict(id, file));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await row(id, file.id)).state).toBe("scanning");
  });

  it("refuses a clean report about other bytes, and records nothing", async () => {
    const id = await room();
    const file = await stored(id);
    for (const over of [{ sha256: "0".repeat(64) }, { bytes: DATA.length + 1 }, { key: `${file.key}x` }, { key: undefined }]) {
      const res = await answer(await send(verdict(id, file, over)));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("scan_mismatch");
    }
    const saved = await row(id, file.id);
    expect(saved.state).toBe("scanning");
    expect(saved.scanned_at).toBeNull();
  });

  it("blocks on a finding about other bytes, as the scanner reports a stored size that differs from the upload's", async () => {
    for (const over of [{ report: "unreadable", reason: "size_mismatch", bytes: DATA.length + 1 }, { report: "malware_found", sha256: "0".repeat(64) }, { report: "malware_found", key: undefined }]) {
      const id = await room();
      const file = await stored(id);
      const res = await answer(await send(verdict(id, file, over)));
      expect(res.status).toBe(200);
      expect(res.body.state).toBe("blocked");
      const saved = await row(id, file.id);
      expect(saved.state).toBe("blocked");
      expect(saved.scan_sha256).toBe(file.hash);
      expect(saved.scanned_at).not.toBeNull();
    }
  });

  it("won't take a clean report without knowing which signatures said so, though a finding still blocks", async () => {
    const id = await room();
    const file = await stored(id);
    const builtAt = (ms: number) => ({ ...DATABASE, built_at: new Date(ms).toISOString() });
    for (const database of [
      null, {}, { engine: "1.5.4" }, { ...DATABASE, version: 28176 },
      builtAt(Date.now() - 7 * DAY - HOUR), builtAt(Date.now() + 2 * DAY), { ...DATABASE, built_at: "last tuesday" },
      { ...DATABASE, engine: "" }, { ...DATABASE, engine: "e".repeat(41) }, { ...DATABASE, version: "28176a" }, { ...DATABASE, version: "1".repeat(21) },
      { ...DATABASE, built_at: `${DATABASE.built_at}${" ".repeat(40)}` },
    ]) {
      expect((await send(verdict(id, file, { database }))).status).toBe(400);
    }
    expect((await row(id, file.id)).state).toBe("scanning");
    expect((await answer(await send(verdict(id, file, { report: "malware_found", database: null })))).body.state).toBe("blocked");
  });

  it("refuses an unknown file, a room that doesn't exist, another version and a file still arriving", async () => {
    const id = await room();
    const file = await stored(id);
    expect((await send(verdict(id, { ...file, id: "obj_none" }))).status).toBe(404);
    expect((await send(verdict("ws_none", file))).status).toBe(404);
    expect((await send(verdict(id, file, { v: 2 }))).status).toBe(400);
    expect((await send(verdict("../bad", file))).status).toBe(404);
    const hash = await sha256(DATA);
    const arriving = (await api("POST", `/v1/workspaces/${id}/uploads`, { name: "n.txt", size: DATA.length, sha256: hash })).body;
    // It has no key yet, so a report naming none is about it, and a finding about it still can't skip its arrival.
    for (const report of ["no_known_malware", "malware_found"]) {
      const res = await answer(await send(verdict(id, { id: arriving.id, hash, key: undefined as unknown as string }, { report })));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("invalid_transition");
    }
  });

  it("only ever tightens: a finding blocks a ready file, and nothing makes a blocked one ready", async () => {
    const id = await room();
    const file = await stored(id);
    expect((await answer(await send(verdict(id, file)))).body.state).toBe("ready");
    // The same report again, with no key to replay an old answer.
    expect((await answer(await send(verdict(id, file)))).body.state).toBe("ready");
    expect((await answer(await send(verdict(id, file, { report: "malware_found", reason: "Eicar", database: null })))).body.state).toBe("blocked");
    expect((await row(id, file.id)).scan_reason).toBe("Eicar");
    expect((await answer(await send(verdict(id, file)))).body.state).toBe("blocked");
    const saved = await row(id, file.id);
    expect(saved.state).toBe("blocked");
    expect(saved.scan_reason).toBe("Eicar");
  });

  it("records a result in an archived room", async () => {
    const id = await room();
    const file = await stored(id);
    const version = (await api("GET", `/v1/workspaces/${id}`)).body.policy_version;
    expect((await api("POST", `/v1/workspaces/${id}/archive`, { policy_version: version })).status).toBe(200);
    expect((await answer(await send(verdict(id, file)))).body.state).toBe("ready");
  });

  it("keeps the scanner's words out of events and audit, and cuts them to size on a character boundary", async () => {
    const id = await room();
    const file = await stored(id);
    const reason = `Win.Secret.Signature-${"é".repeat(300)}`;
    await send(verdict(id, file, { report: "malware_found", reason, database: null }));
    const saved = await row(id, file.id);
    expect(new TextEncoder().encode(saved.scan_reason).length).toBeLessThanOrEqual(200);
    expect(reason.startsWith(saved.scan_reason)).toBe(true);
    const events = await inRoom(id, (sql) => JSON.stringify(sql.exec("SELECT * FROM event").toArray()));
    const audit = await inRoom(id, (sql) => JSON.stringify(sql.exec("SELECT * FROM audit_event").toArray()));
    expect(events).toContain("object.scan_recorded");
    expect(audit).toContain("object.scan_recorded");
    expect(events).not.toContain("Secret.Signature");
    expect(audit).not.toContain("Secret.Signature");
  });

  it("tells nobody", async () => {
    const id = await room();
    const file = await stored(id);
    await send(verdict(id, file));
    expect(await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM outbox o JOIN event e ON e.id = o.event_id WHERE e.type LIKE 'object.%'").one().n)).toBe(0);
  });
});

describe("a scan with no verdict", () => {
  const overdue = (id: string, object: string) => inRoom(id, (sql) => sql.exec("UPDATE stored_object SET scanning_since = ? WHERE id = ?", Date.now() - HOUR - 1000, object));

  it("takes the file's scan turn when it arrives, then sets the alarm to send it again, and then to the end of its hour", async () => {
    const id = await room();
    const hash = await sha256(DATA);
    const upload = (await api("POST", `/v1/workspaces/${id}/uploads`, { name: "n.txt", size: DATA.length, sha256: hash })).body;
    // Whatever else the room had to do is done, so the alarm after this can only be the scan's. The unfinished upload leaves one
    // for removal's sweep, which clears it, more than an hour off. Two whole runs: the second finds what the first left due.
    await alarmPass(stub(id));
    await alarmPass(stub(id));
    const left = await inRoom(id, (_sql, state) => state.storage.getAlarm());
    expect(left === null || left > Date.now() + HOUR + 30 * 60 * 1000).toBe(true);
    const before = Date.now();
    expect((await SELF.fetch(`https://api.internal${upload.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${upload.token}` }, body: DATA })).status).toBe(200);
    // The room's turn on the scan queue is due at once, and its hour starts when it takes it. The runtime runs that alarm on
    // its own, and this run comes after it, or takes the turn itself.
    await alarmPass(stub(id));
    const sent = async () => (await inRoom(id, (sql) => sql.exec("SELECT scanning_since FROM stored_object WHERE id = ?", upload.id).toArray()))[0].scanning_since as number;
    const first = await sent();
    expect(first).toBeGreaterThanOrEqual(before);
    // First, 30 minutes on from then, to the millisecond, to send it once more if no verdict has come.
    expect(await inRoom(id, (_sql, state) => state.storage.getAlarm())).toBe(first + 30 * 60 * 1000);
    // Once that's past, the next is the end of its hour.
    const earlier = Date.now() - 30 * 60 * 1000 - 1000;
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET scanning_since = ? WHERE id = ?", earlier, upload.id));
    await alarmPass(stub(id));
    expect(await sent()).toBe(earlier);
    expect(await inRoom(id, (_sql, state) => state.storage.getAlarm())).toBe(earlier + HOUR);
  });

  it("ends as failed when the room's alarm runs past the hour", async () => {
    const id = await room();
    const late = await stored(id);
    const inTime = await stored(id, "other.txt");
    await overdue(id, late.id);
    await alarmPass(stub(id));
    expect((await row(id, late.id)).state).toBe("failed");
    expect((await row(id, inTime.id)).state).toBe("scanning");
    const audit = await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM audit_event WHERE action = 'object.scan_expired'").one().n);
    expect(audit).toBe(1);
  });

  it("leaves an admin's open form valid through an upload, a verdict and the sweep, and still lists them in the audit", async () => {
    const id = await room();
    const version = (await api("GET", `/v1/workspaces/${id}`)).body.policy_version;
    const scanned = await stored(id);
    expect((await answer(await send(verdict(id, scanned)))).body.state).toBe("ready");
    const late = await stored(id, "other.txt");
    await overdue(id, late.id);
    await alarmPass(stub(id));
    expect((await row(id, late.id)).state).toBe("failed");
    expect((await api("GET", `/v1/workspaces/${id}`)).body.policy_version).toBe(version);
    const actions = (await api("GET", `/v1/workspaces/${id}/audit`)).body.audit.map((e: any) => e.action);
    for (const action of ["object.upload_created", "object.stored", "object.scan_recorded", "object.scan_expired"]) expect(actions).toContain(action);
    expect((await api("POST", `/v1/workspaces/${id}/archive`, { policy_version: version })).status).toBe(200);
  });

  it("can't be brought back by a late clean report, though a late finding still blocks it", async () => {
    const id = await room();
    const file = await stored(id);
    await overdue(id, file.id);
    expect((await answer(await send(verdict(id, file)))).body.state).toBe("failed");
    expect((await answer(await send(verdict(id, file)))).body.state).toBe("failed");
    expect((await answer(await send(verdict(id, file, { report: "malware_found", database: null })))).body.state).toBe("blocked");
  });

  it("leaves a file with a verdict alone, and stops waking the room for it", async () => {
    const id = await room();
    const file = await stored(id);
    await send(verdict(id, file));
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET scanning_since = ? WHERE id = ?", 1, file.id));
    await runInDurableObject(stub(id), (instance: any) => instance.alarm());
    expect((await row(id, file.id)).state).toBe("ready");
    const next = await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM stored_object WHERE state = 'scanning'").one().n);
    expect(next).toBe(0);
  });
});

describe("queueing a scan", () => {
  const queued = async () => ((await (await fetch("https://hook-log.example.com/")).json()) as any[]).filter((r) => r.path === "/__queue").map((r) => JSON.parse(r.body));

  it("sends exactly the agreed message once the room accepts the file, with no name", async () => {
    const id = await room();
    const file = await stored(id, "a-very-secret-name.txt");
    const saved = await row(id, file.id);
    const after = Date.now();
    await vi.waitFor(async () => {
      const jobs = (await queued()).filter((job) => job.object_id === file.id);
      // When it was sent, which lets the scanner skip a job its room has already failed after the hour.
      expect(jobs).toEqual([{ v: 1, workspace_id: id, object_id: file.id, key: saved.object_key, size: DATA.length, sha256: file.hash, queued_at: expect.any(Number) }]);
      expect(jobs[0].queued_at).toBeGreaterThan(saved.stored_at - 5_000);
      expect(jobs[0].queued_at).toBeLessThanOrEqual(after + 5_000);
    }, { timeout: 10_000, interval: 100 });
    expect(JSON.stringify(await queued())).not.toContain("secret-name");
  });

  it("sends nothing for an upload that's refused", async () => {
    const id = await room();
    const hash = "0".repeat(64);
    const upload = (await api("POST", `/v1/workspaces/${id}/uploads`, { name: "n.txt", size: DATA.length, sha256: hash })).body;
    const res = await SELF.fetch(`https://api.internal${upload.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${upload.token}` }, body: DATA });
    expect(res.status).toBe(422);
    // A whole run of the alarm, which would have sent it.
    await alarmPass(stub(id));
    expect((await queued()).filter((job) => job.object_id === upload.id)).toEqual([]);
  });
});

describe("a file ready or not", () => {
  it("lets a file be downloaded only once a clean verdict makes it ready", async () => {
    const id = await room();
    const download = async (object: string) => SELF.fetch(`https://api.internal/v1/files/${id}/${object}`, { headers: { "x-podster-assertion": await assertion() } });
    const clean = await stored(id);
    const res = await download(clean.id);
    expect(res.status).toBe(409);
    await res.body?.cancel();
    expect((await answer(await send(verdict(id, clean)))).body.state).toBe("ready");
    const served = await download(clean.id);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(DATA);
    const found = await stored(id, "found.txt");
    expect((await answer(await send(verdict(id, found, { report: "malware_found", database: null })))).body.state).toBe("blocked");
    const late = await stored(id, "late.txt");
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET scanning_since = ? WHERE id = ?", Date.now() - HOUR - 1000, late.id));
    await runInDurableObject(stub(id), (instance: any) => instance.alarm());
    expect((await row(id, late.id)).state).toBe("failed");
    for (const object of [found.id, late.id]) {
      const refused = await download(object);
      expect(refused.status).toBe(409);
      await refused.body?.cancel();
    }
  });
});

describe("the sweep's queries", () => {
  it("read scanning files through their own index, not every file's", async () => {
    const id = await room();
    await stored(id);
    const plans = await inRoom(id, (sql) =>
      [
        "SELECT id, scanning_since FROM stored_object INDEXED BY stored_object_scanning WHERE state = 'scanning' AND scanning_since <= 1 ORDER BY scanning_since LIMIT 500",
        "SELECT MIN(scanning_since) AS first FROM stored_object INDEXED BY stored_object_scanning WHERE state = 'scanning'",
        "SELECT id, scanning_since FROM stored_object WHERE state = 'scanning' AND scanning_since <= 1 ORDER BY scanning_since LIMIT 500",
      ].map((query) => sql.exec(`EXPLAIN QUERY PLAN ${query}`).toArray().map((step: any) => step.detail).join(" | ")),
    );
    for (const plan of plans.slice(0, 2)) {
      expect(plan).toContain("stored_object_scanning");
      expect(plan).not.toContain("TEMP B-TREE");
    }
    // Even unnamed, it's the index SQLite picks now.
    expect(plans[2]).toContain("stored_object_scanning");
  });
});

describe("a room from before this", () => {
  /** Puts a room back to before this migration. Its audit entries each had their own policy version then, which was the cursor. */
  const undo = (id: string) =>
    inRoom(id, (sql) => {
      // The newer migrations come off first, newest first: submitted files' flag, expected outputs, removal, input assets linked
      // to tasks, then files on submissions.
      // M4 step 8's public claims, the newest migration, then step 6's discovery outbox, step 5's room visibility, step 13b's change requests, step 13's read-back and step 12's A2A attempts.
      // M5 step 6's agent tokens, the newest migration, come off first.
      // M5 step 7a's read bookkeeping, the newest migration, comes off first.
      // M5 step 7b's merge bookkeeping, the newest migration, comes off first.
      // The newest step, the M5 security review's two columns, comes off first.
      // M6 step 2's release tables, the newest migration, come off first.
      // M6 step 4(a)'s applier and script-delete tables, the newest migration, come off first.
      // The record of release bookkeeping that keeps failing, the newest migration, comes off first.
      // The hold on a room's app (step 6), the newest migration, comes off first.
      sql.exec("DROP TABLE release_hold");
      sql.exec("UPDATE schema_version SET version = version - 1");
      // Then decision 218's applied release switch.
      sql.exec("DROP TABLE release_switch_applied");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE release_bookkeeping");
      sql.exec("UPDATE schema_version SET version = version - 1");
      for (const table of ["serve_apply", "script_delete"]) sql.exec(`DROP TABLE ${table}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
      for (const table of ["release_config", "serve_state", "unpublish", "release", "app_label", "hostname_request"]) sql.exec(`DROP TABLE ${table}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("ALTER TABLE repo_link DROP COLUMN gone_seen_at");
      sql.exec("ALTER TABLE repo_request DROP COLUMN limited_since");
      sql.exec("ALTER TABLE repo_request DROP COLUMN limited_call");
      sql.exec("UPDATE schema_version SET version = version - 1");
      // The step that keeps an approval's reviewer (A1, decision 195) comes off next.
      sql.exec("ALTER TABLE task_change DROP COLUMN reviewer_person");
      sql.exec("ALTER TABLE task_change DROP COLUMN reviewer_id");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE merge_request");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_finished_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_called_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_mark_set_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_marked_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_step");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_next_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_attempts");
      sql.exec("ALTER TABLE task_change DROP COLUMN merge_requester_person");
      sql.exec("ALTER TABLE task_change DROP COLUMN submitter_person");
      sql.exec("ALTER TABLE task_change DROP COLUMN submitter_id");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE repo_read");
      sql.exec("ALTER TABLE repo_link DROP COLUMN reads_not_before");
      sql.exec("ALTER TABLE repo_link DROP COLUMN read_failures");
      sql.exec("ALTER TABLE task_change DROP COLUMN pr_draft");
      sql.exec("ALTER TABLE task_change DROP COLUMN commit_changed_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN unwatched_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN not_found_reads");
      sql.exec("ALTER TABLE task_change DROP COLUMN read_failures");
      sql.exec("ALTER TABLE task_change DROP COLUMN merged_by_id");
      sql.exec("ALTER TABLE task_change DROP COLUMN unchanged_reads");
      sql.exec("ALTER TABLE task_change DROP COLUMN read_at");
      sql.exec("ALTER TABLE task_change DROP COLUMN observed_base_sha");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE repo_token_mint");
      sql.exec("DROP TABLE repo_token");
      sql.exec("UPDATE schema_version SET version = version - 1");
      // M5 step 4's retry columns go with the request table below, then M5 step 5's webhook deliveries come off, then M5 step 2's managed repositories, then M4 step 10's operator suspension.
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE provider_delivery");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE task_change");
      sql.exec("DROP TABLE provider_grant");
      sql.exec("DROP TABLE repo_link");
      sql.exec("DROP TABLE repo_request_attempt");
      sql.exec("DROP TABLE repo_request");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("ALTER TABLE workspace DROP COLUMN suspension_reason");
      sql.exec("ALTER TABLE workspace DROP COLUMN suspended_at");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE public_claim_block");
      sql.exec("DROP INDEX role_claim_public");
      sql.exec("ALTER TABLE role_claim DROP COLUMN public");
      sql.exec("ALTER TABLE member DROP COLUMN joined_via");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE public_index_outbox");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("ALTER TABLE work_role DROP COLUMN publicly_claimable");
      sql.exec("ALTER TABLE workspace DROP COLUMN public_claims_paused");
      sql.exec("ALTER TABLE workspace DROP COLUMN topic");
      sql.exec("ALTER TABLE workspace DROP COLUMN published_at");
      sql.exec("ALTER TABLE workspace DROP COLUMN public_handle");
      sql.exec("ALTER TABLE workspace DROP COLUMN visibility");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN kind");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN remote_context_id");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN reference_task_id");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN reference_context_id");
      sql.exec("UPDATE schema_version SET version = version - 1");
          sql.exec("DROP INDEX a2a_attempt_reads");
      sql.exec("DROP INDEX a2a_attempt_cancels");
      sql.exec("DROP TABLE a2a_held");
      sql.exec("ALTER TABLE event DROP COLUMN origin");
      sql.exec("ALTER TABLE event DROP COLUMN origin_ref");
      sql.exec("ALTER TABLE audit_event DROP COLUMN origin");
      sql.exec("ALTER TABLE audit_event DROP COLUMN origin_ref");
      sql.exec("ALTER TABLE message DROP COLUMN origin");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN reading_ended");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_until");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN next_read_at");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_no");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_queued");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_queued_at");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN last_read_no");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN last_state");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN working_seen");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_ended_reason");
      sql.exec("ALTER TABLE a2a_attempt DROP COLUMN cancel_state");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE a2a_attempt");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP INDEX stored_object_unsubmitted");
      sql.exec("ALTER TABLE stored_object DROP COLUMN submitted_at");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP INDEX task_expected_output");
      sql.exec("ALTER TABLE task DROP COLUMN expected_output_id");
      sql.exec("DROP TABLE expected_output_version");
      sql.exec("DROP TABLE expected_output");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE storage_sweep");
      sql.exec("DROP INDEX stored_object_abandoned");
      sql.exec("DROP INDEX stored_object_purge");
      for (const column of ["removed_at", "removed_by", "removed_by_kind", "removed_from", "attempt_started_at", "purge_due_at"]) sql.exec(`ALTER TABLE stored_object DROP COLUMN ${column}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE asset_link");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE submission_file");
      sql.exec("DROP INDEX stored_object_task");
      sql.exec("ALTER TABLE stored_object DROP COLUMN for_task");
      sql.exec("ALTER TABLE task DROP COLUMN submission_files");
      sql.exec("ALTER TABLE task DROP COLUMN left_accepted_at");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP INDEX stored_object_scanning");
      for (const column of ["scan_reason", "scan_sha256", "scan_database_json", "scanned_at"]) sql.exec(`ALTER TABLE stored_object DROP COLUMN ${column}`);
      sql.exec("DROP INDEX audit_event_seq");
      sql.exec("ALTER TABLE audit_event DROP COLUMN seq");
      sql.exec("ALTER TABLE workspace DROP COLUMN audit_seq");
      sql.exec("UPDATE schema_version SET version = version - 1");
      // Before this, every entry moved the policy version, so each had its own.
      sql.exec("UPDATE audit_event SET policy_version = 100 + rowid");
      sql.exec("UPDATE workspace SET policy_version = (SELECT MAX(policy_version) FROM audit_event)");
    });

  it("arms the alarm when a read migrates it, so a scan stuck from before still ends", async () => {
    const id = await room();
    const stuck = await stored(id);
    // The room is left with no alarm and none running, so the only alarm after this is one the read sets. And the scan isn't
    // overdue yet: an alarm for one that is comes due in milliseconds, and the runtime runs it, leaving none to read.
    await alarmQuiet(stub(id));
    await undo(id);
    const since = Date.now() - 10 * 60 * 1000;
    await runInDurableObject(stub(id), async (_: any, state: any) => {
      state.storage.sql.exec("UPDATE stored_object SET scanning_since = ? WHERE id = ?", since, stuck.id);
      await state.storage.deleteAlarm();
    });
    expect(await runInDurableObject(stub(id), (_: any, state: any) => state.storage.getAlarm())).toBeNull();
    expect((await api("GET", `/v1/workspaces/${id}`)).status).toBe(200);
    // The first thing due for that scan, to the millisecond: its second send, 30 minutes after its first.
    expect(await runInDurableObject(stub(id), (_: any, state: any) => state.storage.getAlarm())).toBe(since + 30 * 60 * 1000);
    // And once its hour is over, a run of the alarm ends it.
    await runInDurableObject(stub(id), (_: any, state: any) => void state.storage.sql.exec("UPDATE stored_object SET scanning_since = ? WHERE id = ?", Date.now() - HOUR - 1000, stuck.id));
    await alarmPass(stub(id));
    expect((await row(id, stuck.id)).state).toBe("failed");
  });

  it("gets the columns, and keeps its files waiting", async () => {
    const id = await room();
    const file = await stored(id);
    await undo(id);
    expect((await answer(await send(verdict(id, file)))).body.state).toBe("ready");
  });

  it("keeps an audit cursor from before meaning the same place, and carries on after it", async () => {
    const id = await room();
    await stored(id);
    await undo(id);
    const before = await inRoom(id, (sql) => sql.exec("SELECT id, policy_version FROM audit_event ORDER BY policy_version").toArray());
    expect(before.length).toBeGreaterThan(2);
    const cursor = before[0].policy_version;
    const listed = (await api("GET", `/v1/workspaces/${id}/audit?after=${cursor}`)).body.audit.map((e: any) => e.id);
    expect(listed).toEqual(before.slice(1).map((e: any) => e.id));
    await stored(id, "later.txt");
    const after = (await api("GET", `/v1/workspaces/${id}/audit?after=${before[before.length - 1].policy_version}`)).body.audit.map((e: any) => e.action);
    expect(after).toEqual(["object.upload_created", "object.stored"]);
    const { unique, notNull } = await inRoom(id, (sql) => ({
      unique: sql.exec("SELECT \"unique\" AS u FROM pragma_index_list('audit_event') WHERE name = 'audit_event_seq'").one().u,
      notNull: sql.exec("SELECT \"notnull\" AS n FROM pragma_table_info('audit_event') WHERE name = 'seq'").one().n,
    }));
    expect([unique, notNull]).toEqual([1, 1]);
  });
});

// M4 step 14: per-room fairness in the scan queue. A room has at most 4 files on the shared queue at once, and its others wait in
// the room for its turn, so one busy room can't push other rooms' scans past the hour.
describe("each room's share of the scan queue", () => {
  const jobsFor = async (id: string) => ((await (await fetch("https://hook-log.example.com/")).json()) as any[]).filter((r) => r.path === "/__queue").map((r) => JSON.parse(r.body)).filter((job) => job.workspace_id === id);
  const counts = (id: string) =>
    inRoom(id, (sql) => sql.exec("SELECT COUNT(scanning_since) AS queued, COUNT(*) - COUNT(scanning_since) AS waiting FROM stored_object WHERE state = 'scanning'").one()) as Promise<{ queued: number; waiting: number }>;
  /** Runs the room's alarm until its turns are taken, as the platform would. */
  const settle = async (id: string) => {
    for (let n = 0; n < 3; n++) await alarmPass(stub(id));
  };
  /** The room's order: arrival, then ID, as it takes turns. */
  const arrivalOrder = (id: string) => inRoom(id, (sql) => sql.exec("SELECT id FROM stored_object WHERE state = 'scanning' ORDER BY stored_at, id").toArray().map((r: any) => r.id)) as Promise<string[]>;
  const files = async (id: string, count: number, prefix: string) => {
    for (let n = 0; n < count; n++) await stored(id, `${prefix}${n}.txt`);
  };

  it("puts at most 4 of a room's files on the queue, oldest first, and takes the next when a verdict frees a turn by itself", async () => {
    const id = await room();
    await files(id, 6, "f");
    const order = await arrivalOrder(id);
    await settle(id);
    expect(await counts(id)).toEqual({ queued: 4, waiting: 2 });
    await vi.waitFor(async () => expect((await jobsFor(id)).map((job) => job.object_id).sort()).toEqual(order.slice(0, 4).sort()));
    const first = await row(id, order[0]);
    expect((await answer(await send(verdict(id, { id: first.id, hash: first.sha256, key: first.object_key })))).body.state).toBe("ready");
    // The verdict arms the room's alarm, which takes the freed turn without the test running it.
    await vi.waitFor(async () => expect((await jobsFor(id)).map((job) => job.object_id)).toContain(order[4]), { timeout: 10_000, interval: 100 });
    expect(await counts(id)).toEqual({ queued: 4, waiting: 1 });
    expect((await jobsFor(id)).map((job) => job.object_id)).not.toContain(order[5]);
  });

  it("takes the turn an expiry frees, from the alarm the room set for it", async () => {
    const id = await room();
    await files(id, 5, "e");
    const order = await arrivalOrder(id);
    await settle(id);
    // The oldest queued scan's hour ends in a moment; any write lets the room set its alarm for that.
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET scanning_since = ? WHERE id = ?", Date.now() - HOUR + 1500, order[0]));
    expect((await api("PUT", `/v1/workspaces/${id}/topic`, { topic: "film" })).status).toBe(200);
    await vi.waitFor(async () => expect((await row(id, order[0])).state).toBe("failed"), { timeout: 15_000, interval: 200 });
    await vi.waitFor(async () => expect((await jobsFor(id)).map((job) => job.object_id)).toContain(order[4]), { timeout: 10_000, interval: 100 });
  });

  it("keeps a busy room to its share of the queue, so a quiet room's file is behind at most 4 of it", async () => {
    const busy = await room();
    await files(busy, 8, "b");
    await settle(busy);
    const quiet = await room();
    const file = await stored(quiet);
    await settle(quiet);
    // Without the cap all 8 of the busy room's would be on the queue ahead of the quiet room's one.
    await vi.waitFor(async () => expect((await jobsFor(quiet)).map((job) => job.object_id)).toEqual([file.id]));
    expect(await jobsFor(busy)).toHaveLength(4);
    expect(await counts(busy)).toEqual({ queued: 4, waiting: 4 });
  });

  it("gives a turn back when its send fails, stops the pass, and waits before asking the queue again", async () => {
    const id = await room();
    await inRoom(id, (sql) => sql.exec("CREATE TABLE test_scan_send_fails (x)"));
    // The first send fails in the alarm the first upload arms, so the rest is measured from before the uploads.
    const before = Date.now();
    await files(id, 3, "s");
    await settle(id);
    expect(await counts(id)).toEqual({ queued: 0, waiting: 3 });
    expect(await jobsFor(id)).toEqual([]);
    // Backed off: the alarm isn't back in 10 ms, and running it now sends nothing.
    const alarm = await inRoom(id, (_sql, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(before + 5_000);
    await inRoom(id, (sql) => sql.exec("DROP TABLE test_scan_send_fails"));
    await settle(id);
    expect(await counts(id)).toEqual({ queued: 0, waiting: 3 });
    // Once the rest is over, the next pass sends them.
    await vi.waitFor(async () => expect(await counts(id)).toEqual({ queued: 3, waiting: 0 }), { timeout: 15_000, interval: 250 });
    await vi.waitFor(async () => expect(await jobsFor(id)).toHaveLength(3));
  });

  const RESEND = 30 * 60 * 1000;
  const markers = (id: string) => inRoom(id, async (_sql, state) => [...(await state.storage.list({ prefix: "scan_resent:" })).keys()]) as Promise<string[]>;

  it("sends a queued scan once more after 30 minutes with no verdict, with its first time, never a third time, and forgets it once settled", async () => {
    const id = await room();
    const file = await stored(id);
    await settle(id);
    await vi.waitFor(async () => expect(await jobsFor(id)).toHaveLength(1));
    const firstSent = Date.now() - RESEND - 1000;
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET scanning_since = ? WHERE id = ?", firstSent, file.id));
    await settle(id);
    await vi.waitFor(async () => expect(await jobsFor(id)).toHaveLength(2));
    // The duplicate carries the file's first time, so the scanner's too-late skip matches the room's hour.
    expect((await jobsFor(id))[1].queued_at).toBe(firstSent);
    await settle(id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await jobsFor(id)).toHaveLength(2);
    expect(await markers(id)).toEqual([`scan_resent:${file.id}`]);
    // A verdict settles it, and the next alarm clears its marker.
    expect((await answer(await send(verdict(id, file)))).body.state).toBe("ready");
    await settle(id);
    expect(await markers(id)).toEqual([]);
  });

  it("arms its own alarm for a re-send that failed, and sends it once the rest is over", async () => {
    const id = await room();
    const file = await stored(id);
    await settle(id);
    await vi.waitFor(async () => expect(await jobsFor(id)).toHaveLength(1));
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET scanning_since = ? WHERE id = ?", Date.now() - RESEND - 1000, file.id));
    await inRoom(id, (sql) => sql.exec("CREATE TABLE test_scan_send_fails (x)"));
    const before = Date.now();
    await settle(id);
    expect(await jobsFor(id)).toHaveLength(1);
    expect(await markers(id)).toEqual([]);
    // Nothing else is due, yet the alarm is set, for the re-send, after the rest.
    const alarm = await inRoom(id, (_sql, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(before + 5_000);
    expect(alarm).toBeLessThan(before + 5 * 60 * 1000);
    await inRoom(id, (sql) => sql.exec("DROP TABLE test_scan_send_fails"));
    // The alarm the room set comes by itself and sends it.
    await vi.waitFor(async () => expect(await jobsFor(id)).toHaveLength(2), { timeout: 20_000, interval: 250 });
  });

  it("starts its rest from 5 seconds again after a clean pass", async () => {
    const id = await room();
    // The room's scan passes read the clock the test passes in, ten minutes ahead, so the runtime never runs the alarm
    // by itself during the test, and well inside the files' hour.
    let now = Date.now() + 10 * 60 * 1000;
    const at = (when: number) => inRoom(id, (sql) => sql.exec("DELETE FROM test_scan_now; INSERT INTO test_scan_now VALUES (?)", when));
    await inRoom(id, (sql) => sql.exec("CREATE TABLE test_scan_now (at INTEGER); CREATE TABLE test_scan_send_fails (x)"));
    await at(now);
    const alarm = () => inRoom(id, (_sql, state) => state.storage.getAlarm()) as Promise<number>;
    // The first failure, in the alarm the upload arms, rests 5 seconds.
    await stored(id, "r0.txt");
    await settle(id);
    expect(await alarm()).toBe(now + 5_000);
    // After that rest, a second pass fails too, and the rest doubles: the count really climbs.
    now += 5_000;
    await at(now);
    await settle(id);
    expect(await alarm()).toBe(now + 10_000);
    // A clean pass after that rest sends the file and resets the count.
    await inRoom(id, (sql) => sql.exec("DROP TABLE test_scan_send_fails"));
    now += 10_000;
    await at(now);
    await settle(id);
    expect(await counts(id)).toEqual({ queued: 1, waiting: 0 });
    // So the next failure rests 5 seconds, not the 20 a third failure in a row would.
    await inRoom(id, (sql) => sql.exec("CREATE TABLE test_scan_send_fails (x)"));
    now += 1;
    await at(now);
    await stored(id, "r1.txt");
    await settle(id);
    expect(await alarm()).toBe(now + 5_000);
  });

  it("starts a file's hour when it's queued, not when it arrived", async () => {
    const id = await room();
    await files(id, 5, "h");
    await settle(id);
    const waiting = (await arrivalOrder(id)).at(-1)!;
    expect((await row(id, waiting)).scanning_since).toBeNull();
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET stored_at = ? WHERE id = ?", Date.now() - 2 * HOUR, waiting));
    await settle(id);
    const late = await row(id, waiting);
    expect(late.state).toBe("scanning");
    // A verdict for it, as from an old job delivered again, isn't late either.
    expect((await answer(await send(verdict(id, { id: late.id, hash: late.sha256, key: late.object_key })))).body.state).toBe("ready");
  });

  it("fails closed a file that waited a day for its turn", async () => {
    const id = await room();
    await files(id, 5, "d");
    await settle(id);
    const waiting = (await inRoom(id, (sql) => sql.exec("SELECT id FROM stored_object WHERE state = 'scanning' AND scanning_since IS NULL").toArray()))[0] as any;
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET stored_at = ? WHERE id = ?", Date.now() - 24 * HOUR - 1000, waiting.id));
    await settle(id);
    expect((await row(id, waiting.id)).state).toBe("failed");
    const expired = await inRoom(id, (sql) => sql.exec("SELECT target_id FROM audit_event WHERE action = 'object.scan_expired'").toArray());
    expect(expired.map((r: any) => r.target_id)).toEqual([waiting.id]);
  });
});
