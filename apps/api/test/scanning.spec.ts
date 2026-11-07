import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

async function room() {
  return (await api("POST", "/v1/workspaces", { name: "Scans" })).body.id as string;
}
/** A stored file, waiting for its scan. */
async function stored(id: string, name = "notes.txt") {
  const hash = await sha256(DATA);
  const upload = (await api("POST", `/v1/workspaces/${id}/uploads`, { name, size: DATA.length, sha256: hash })).body;
  const res = await SELF.fetch(`https://api.internal${upload.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${upload.token}` }, body: DATA });
  expect(res.status).toBe(200);
  return { id: upload.id as string, hash };
}
const DATABASE = { engine: "1.5.4", version: "28176", built_at: "2026-11-06T07:26:08Z" };
const verdict = (id: string, file: { id: string; hash: string }, over: object = {}) => ({ v: 1, workspace_id: id, object_id: file.id, report: "no_known_malware", reason: "none", sha256: file.hash, bytes: DATA.length, database: DATABASE, scanned_at: 1, ...over });
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

  it("refuses a report about other bytes, and records nothing", async () => {
    const id = await room();
    const file = await stored(id);
    for (const over of [{ sha256: "0".repeat(64) }, { bytes: DATA.length + 1 }]) {
      const res = await answer(await send(verdict(id, file, over)));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("scan_mismatch");
    }
    const saved = await row(id, file.id);
    expect(saved.state).toBe("scanning");
    expect(saved.scanned_at).toBeNull();
  });

  it("won't take a clean report without knowing which signatures said so, though a finding still blocks", async () => {
    const id = await room();
    const file = await stored(id);
    for (const database of [null, {}, { engine: "1.5.4" }, { ...DATABASE, version: 28176 }]) {
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
    const res = await answer(await send(verdict(id, { id: arriving.id, hash })));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_transition");
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

  it("sets the room's alarm when the file arrives, to the end of its hour", async () => {
    const id = await room();
    const hash = await sha256(DATA);
    const upload = (await api("POST", `/v1/workspaces/${id}/uploads`, { name: "n.txt", size: DATA.length, sha256: hash })).body;
    // Whatever else the room had to do is done, so the alarm after this can only be the scan's.
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stub(id));
      expect(await inRoom(id, (_sql, state) => state.storage.getAlarm())).toBeNull();
    });
    const before = Date.now();
    expect((await SELF.fetch(`https://api.internal${upload.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${upload.token}` }, body: DATA })).status).toBe(200);
    const alarm = await inRoom(id, (_sql, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(before + HOUR - 5000);
    expect(alarm).toBeLessThan(Date.now() + HOUR + 5000);
  });

  it("ends as failed when the room's alarm runs past the hour", async () => {
    const id = await room();
    const late = await stored(id);
    const inTime = await stored(id, "other.txt");
    await overdue(id, late.id);
    await runDurableObjectAlarm(stub(id));
    await inRoom(id, () => null);
    await vi.waitFor(async () => {
      if ((await row(id, late.id)).state !== "failed") await runInDurableObject(stub(id), (instance: any) => instance.alarm());
      expect((await row(id, late.id)).state).toBe("failed");
    });
    expect((await row(id, inTime.id)).state).toBe("scanning");
    const audit = await inRoom(id, (sql) => sql.exec("SELECT count(*) AS n FROM audit_event WHERE action = 'object.scan_expired'").one().n);
    expect(audit).toBe(1);
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
    await vi.waitFor(async () => {
      const jobs = (await queued()).filter((job) => job.object_id === file.id);
      expect(jobs).toEqual([{ v: 1, workspace_id: id, object_id: file.id, key: saved.object_key, size: DATA.length, sha256: file.hash }]);
    }, { timeout: 10_000, interval: 100 });
    expect(JSON.stringify(await queued())).not.toContain("secret-name");
  });

  it("sends nothing for an upload that's refused", async () => {
    const id = await room();
    const hash = "0".repeat(64);
    const upload = (await api("POST", `/v1/workspaces/${id}/uploads`, { name: "n.txt", size: DATA.length, sha256: hash })).body;
    const res = await SELF.fetch(`https://api.internal${upload.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${upload.token}` }, body: DATA });
    expect(res.status).toBe(422);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await queued()).filter((job) => job.object_id === upload.id)).toEqual([]);
  });
});

describe("a file ready or not", () => {
  it("has no route that gives its bytes back yet", async () => {
    const id = await room();
    const file = await stored(id);
    await send(verdict(id, file));
    expect((await api("GET", `/v1/workspaces/${id}/uploads/${file.id}`)).status).toBe(404);
  });
});

describe("a room from before this", () => {
  it("gets the columns, and keeps its files waiting", async () => {
    const id = await room();
    const file = await stored(id);
    await inRoom(id, (sql) => {
      sql.exec("DROP INDEX stored_object_scanning");
      for (const column of ["scan_reason", "scan_sha256", "scan_database_json", "scanned_at"]) sql.exec(`ALTER TABLE stored_object DROP COLUMN ${column}`);
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    expect((await answer(await send(verdict(id, file)))).body.state).toBe("ready");
  });
});
