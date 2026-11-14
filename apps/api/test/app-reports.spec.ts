import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// M6 step 9: a person's report that names a deployed app by its address, the operators' one queue of reports, and the
// deployment's release-read budget. Every window is tried with the Moderation object's test clock, never by waiting.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OPERATOR: Who = { id: "per_operator_one", kind: "person", org: "org_ar_ops" };
const AGENT: Who = { id: "agt_ar_agent", org: "org_ar" };
const person = (name: string): Who => ({ id: `per_ar_${name}`, kind: "person", org: "org_ar", adminOrgs: ["org_ar"] });

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T = 1_900_000_000_000;

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }) })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-podster-assertion": await assertion(who) };
  if (method !== "GET") headers["idempotency-key"] = idempotencyKey ?? `ar-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code as string | undefined, text, headers: [...res.headers.entries()].sort() };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  const res = await SELF.fetch(`https://api.internal/v1/agents/${AGENT.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(person("owner")) }, body: JSON.stringify({ org_id: AGENT.org, name: AGENT.id }) });
  if (res.status !== 200) throw new Error(`register ${AGENT.id}: ${res.status}`);
});

const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
/** The object's own routes, as the Worker reaches them. No public route reaches these. */
const internal = async (path: string, body: unknown) => {
  const res = await moderation().fetch(`https://moderation${path}`, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};
/** Sets the object's clock for what it counts over a window. The schema is made first, as any request would. */
const setClock = async (now: number) => {
  await internal("/report-lookup", { reporter: "per_ar_nobody", request_key: "none", request_hash: "none" });
  await inModeration((sql) => {
    sql.exec("CREATE TABLE IF NOT EXISTS test_clock (now INTEGER NOT NULL)");
    sql.exec("DELETE FROM test_clock");
    sql.exec("INSERT INTO test_clock (now) VALUES (?)", now);
  });
};
afterEach(async () => {
  await inModeration((sql) => sql.exec("DROP TABLE IF EXISTS test_clock"));
});

/** Release switched on for the test Worker, as no deployment is, while `run` runs. */
async function switchedOn<T>(run: () => Promise<T>): Promise<T> {
  await BINDINGS.DB.prepare("CREATE TABLE test_releases_on (x INTEGER)").run();
  try { return await run(); } finally { await BINDINGS.DB.prepare("DROP TABLE test_releases_on").run(); }
}

/** Every page of the operators' queue, newest first. */
async function queue() {
  const all: any[] = [];
  let cursor: string | null = null;
  do {
    const page = await api(OPERATOR, "GET", `/v1/moderation/reports${cursor ? `?cursor=${cursor}` : ""}`);
    expect(page.status).toBe(200);
    expect(page.body.reports.length).toBeLessThanOrEqual(50);
    all.push(...page.body.reports);
    cursor = page.body.next_cursor;
  } while (cursor);
  return all;
}

const ROOM_KEYS = ["agent_id", "created_at", "handle", "id", "note", "reason"];

describe("a report that names an app (M6 step 9)", () => {
  it("switched off, is a path nobody defined, and the queue is M4's, in M4's shape, even with apps' reports kept", async () => {
    const who = person("off");
    const made = await switchedOn(() => api(who, "POST", "/v1/app-reports", { address: "https://kept-while-on.example.com/x", reason: "spam" }));
    expect(made.status).toBe(200);
    const [real, unknown] = [await api(who, "POST", "/v1/app-reports", { address: "a.example.com", reason: "spam" }), await api(who, "POST", "/v1/app-reportsx", { address: "a.example.com", reason: "spam" })];
    expect([real.status, real.text, real.headers]).toEqual([unknown.status, unknown.text, unknown.headers]);
    expect([real.status, real.code]).toEqual([404, "not_found"]);
    // A room's report kept beside it, straight into the object, as the Worker would after finding the room.
    await internal("/report", { reporter: who.id, request_key: "off-room", request_hash: "h", handle: "off-room-handle", workspace_id: "ws_off", agent_id: null, reason: "abuse", note: null });
    const reports = await queue();
    expect(reports.find((r) => r.id === made.body.id)).toBeUndefined();
    const room = reports.find((r) => r.handle === "off-room-handle");
    expect(room).toBeDefined();
    for (const report of reports) expect(Object.keys(report).sort()).toEqual(ROOM_KEYS);
    expect(JSON.stringify(reports)).not.toContain("kept-while-on");
  });

  it("switched on, keeps only the host, answers a retry with the same report, and refuses what isn't a host", async () => {
    await switchedOn(async () => {
      const who = person("on");
      const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
      const made = await api(who, "POST", "/v1/app-reports", { address: "HTTPS://Some-App.Example.COM:8443/page?q=secret#top", reason: "abuse", note: "it asks for passwords" }, "on-1");
      expect(made.status).toBe(200);
      expect(Object.keys(made.body).sort()).toEqual(["created_at", "id"]);
      // The reporter is told nothing about the host: not even its normalized name.
      expect(made.text).not.toContain("example");
      // A retry is the same report; the same key with a different request isn't.
      expect((await api(who, "POST", "/v1/app-reports", { address: "HTTPS://Some-App.Example.COM:8443/page?q=secret#top", reason: "abuse", note: "it asks for passwords" }, "on-1")).body).toEqual(made.body);
      expect((await api(who, "POST", "/v1/app-reports", { address: "some-app.example.com", reason: "abuse", note: "it asks for passwords" }, "on-1")).body).toEqual(made.body);
      expect((await api(who, "POST", "/v1/app-reports", { address: "other.example.com", reason: "abuse", note: "it asks for passwords" }, "on-1")).code).toBe("idempotency_mismatch");
      const stored = await inModeration((sql) => sql.exec("SELECT host, reason, note FROM app_report WHERE id = ?", made.body.id).toArray());
      expect(stored).toEqual([{ host: "some-app.example.com", reason: "abuse", note: "it asks for passwords" }]);
      // A host nothing serves, or never could, answers in the same shape: nothing is looked up.
      for (const address of ["k3v9q2.podster.site", "nothing-here.invalid", "https://bücher.example/"]) {
        const answer = await api(who, "POST", "/v1/app-reports", { address, reason: "other" });
        expect([answer.status, Object.keys(answer.body).sort()], address).toEqual([200, ["created_at", "id"]]);
      }
      for (const [body, code] of [
        [{ address: "https://user@a.example.com/", reason: "spam" }, "invalid_argument"],
        [{ address: "https://127.0.0.1/", reason: "spam" }, "invalid_argument"],
        [{ address: "ftp://a.example.com/", reason: "spam" }, "invalid_argument"],
        [{ address: "a.example.com/page", reason: "spam" }, "invalid_argument"],
        [{ address: "", reason: "spam" }, "invalid_argument"],
        [{ address: 7, reason: "spam" }, "invalid_argument"],
        [{ reason: "spam" }, "invalid_argument"],
        [{ address: "a.example.com", reason: "bored" }, "invalid_argument"],
        [{ address: "a.example.com", reason: "spam", note: "x".repeat(1025) }, "invalid_argument"],
        [{ address: "a.example.com", reason: "spam", handle: "x" }, "invalid_argument"],
      ] as [object, string][]) {
        expect((await api(who, "POST", "/v1/app-reports", body)).code, JSON.stringify(body)).toBe(code);
      }
      expect((await api(AGENT, "POST", "/v1/app-reports", { address: "a.example.com", reason: "spam" })).code).toBe("not_allowed");
      // The address's cap counts characters, as the contract's maxLength does: 2,048 of them, most two bytes each, pass.
      const prefix = "https://bücher.example/";
      const longest = `${prefix}${"é".repeat(2048 - [...prefix].length)}`;
      expect([[...longest].length, new TextEncoder().encode(longest).length > 2048]).toEqual([2048, true]);
      expect((await api(person("long"), "POST", "/v1/app-reports", { address: longest, reason: "spam" })).status).toBe(200);
      expect((await api(person("long"), "POST", "/v1/app-reports", { address: `${longest}é`, reason: "spam" })).code).toBe("invalid_argument");
      // The note's counts bytes, as the contract says: 512 two-byte characters are 1,024 bytes, and one more is past it,
      // though 513 characters are well under the schema's maxLength.
      expect((await api(person("long"), "POST", "/v1/app-reports", { address: "a.example.com", reason: "spam", note: "é".repeat(512) })).status).toBe(200);
      expect((await api(person("long"), "POST", "/v1/app-reports", { address: "a.example.com", reason: "spam", note: "é".repeat(513) })).code).toBe("invalid_argument");
      // The host is a name: it reaches no log.
      for (const spy of logs) {
        expect(spy.mock.calls.flat().map(String).join("\n")).not.toContain("example");
        spy.mockRestore();
      }
      // Only operators read the queue.
      expect((await api(who, "GET", "/v1/moderation/reports")).code).toBe("not_allowed");
    });
  });

  it("counts against the same 10 a day as a room's report, to the millisecond, either way round", async () => {
    await switchedOn(async () => {
      const who = person("daily");
      await setClock(T);
      // Nine room reports, the oldest of them made exactly a day before T plus one millisecond, so still inside the day.
      const roomReport = (n: number) => internal("/report", { reporter: who.id, request_key: `daily-room-${n}`, request_hash: `h${n}`, handle: `daily-${n}`, workspace_id: "ws_daily", agent_id: null, reason: "spam", note: null });
      await setClock(T - DAY + 1);
      for (let n = 0; n < 9; n++) expect((await roomReport(n)).status).toBe(200);
      await setClock(T);
      expect((await api(who, "POST", "/v1/app-reports", { address: "tenth.example.com", reason: "spam" })).status).toBe(200);
      expect((await api(who, "POST", "/v1/app-reports", { address: "eleventh.example.com", reason: "spam" })).code).toBe("limit_exceeded");
      // And the other way: the app's report counts against a room's.
      expect((await roomReport(9)).body.error.code).toBe("limit_exceeded");
      // A millisecond later the nine have left the day: exactly a day old no longer counts.
      await setClock(T + 1);
      expect((await api(who, "POST", "/v1/app-reports", { address: "eleventh.example.com", reason: "spam" })).status).toBe(200);
      expect((await roomReport(10)).status).toBe(200);
      // Someone else's reports don't count against this person's.
      expect((await api(person("daily-other"), "POST", "/v1/app-reports", { address: "tenth.example.com", reason: "spam" })).status).toBe(200);
    });
  });

  it("switched on, the operators read one queue of rooms' and apps' reports, in the order they were made, by one cursor", async () => {
    await switchedOn(async () => {
      const ids: string[] = [];
      // Sixty reports, alternating kinds, by six people so no one passes the daily limit.
      for (let n = 0; n < 60; n++) {
        const reporter = person(`queue-${Math.floor(n / 10)}`).id;
        if (n % 2 === 0) {
          const made = await internal("/report", { reporter, request_key: `queue-${n}`, request_hash: `q${n}`, handle: `queue-room-${n}`, workspace_id: "ws_queue", agent_id: null, reason: "spam", note: null });
          ids.push(made.body.id);
        } else {
          const made = await internal("/report", { kind: "app", reporter, request_key: `queue-${n}`, request_hash: `q${n}`, host: `queue-app-${n}.example.com`, reason: "abuse", note: `n${n}` });
          ids.push(made.body.id);
        }
      }
      const reports = await queue();
      const ours = reports.filter((r) => ids.includes(r.id));
      // Newest first, both kinds interleaved as made, and across the page break.
      expect(ours.map((r) => r.id)).toEqual([...ids].reverse());
      expect(reports.slice(0, 60).map((r) => r.id)).toEqual([...ids].reverse());
      for (const report of reports) {
        expect(Object.keys(report).sort()).toEqual([...ROOM_KEYS, "host", "kind"].sort());
        if (report.kind === "app") expect([report.handle, report.agent_id, typeof report.host]).toEqual([null, null, "string"]);
        else expect([report.kind, report.host]).toEqual(["room", null]);
      }
      const app = ours.find((r) => r.kind === "app");
      expect(app).toMatchObject({ host: expect.stringMatching(/^queue-app-\d+\.example\.com$/), reason: "abuse" });
      // An app's report isn't a room's: suspending a room by it finds nothing.
      expect((await api(OPERATOR, "POST", `/v1/moderation/reports/${app.id}/suspend-room`, { reason: "abuse" })).code).toBe("not_found");
      // A room's report kept after apps' takes the next number after both, so it is still the newest.
      const later = await internal("/report", { reporter: person("queue-late").id, request_key: "queue-late", request_hash: "late", handle: "queue-late", workspace_id: "ws_queue", agent_id: null, reason: "spam", note: null });
      expect((await queue())[0].id).toBe(later.body.id);
    });
  });
});

describe("the deployment's release-read budget (M6 step 9)", () => {
  const rel = (n: number) => `rel_${n.toString(16).padStart(32, "0")}`;
  // Each release here is its own owner's unless a test says otherwise, so only the deployment's total binds.
  const reserve = (release: string, reads: unknown, owner = `room:ws_${release}`, more?: boolean) => internal("/release-reads", { release_id: release, reads, owner_key: owner, ...(more === undefined ? {} : { more }) });
  const share = (owner: unknown, reads: unknown) => internal("/release-reads/share", { owner_key: owner, reads });
  const empty = () => inModeration((sql) => { sql.exec("DELETE FROM release_reads"); sql.exec("DELETE FROM release_read_owner"); });

  it("reserves up to 3,000 reads in a rolling hour, says when a release would fit, and is reached by no route", async () => {
    await setClock(T);
    await empty();
    // Nine full-size releases, a second apart.
    for (let n = 0; n < 9; n++) {
      await setClock(T + n * 1000);
      expect((await reserve(rel(n), 302)).body).toEqual({ fits: true, reads: 302, reserved_at: T + n * 1000 });
    }
    await setClock(T + 9000);
    // A tenth waits for the first to leave the hour; a small one still fits beside them, to exactly 3,000.
    expect((await reserve(rel(9), 302)).body).toEqual({ fits: false, retry_at: T + HOUR });
    expect((await reserve(rel(10), 282)).body).toEqual({ fits: true, reads: 282, reserved_at: T + 9000 });
    expect((await reserve(rel(11), 1)).body).toEqual({ fits: false, retry_at: T + HOUR });
    // A release told to wait reserved nothing; at the time it was told, it fits. A millisecond before, it still waits.
    await setClock(T + HOUR - 1);
    expect((await reserve(rel(9), 302)).body).toEqual({ fits: false, retry_at: T + HOUR });
    await setClock(T + HOUR);
    expect((await reserve(rel(9), 302)).body).toEqual({ fits: true, reads: 302, reserved_at: T + HOUR });
    // Past the budget alone, it never fits.
    expect((await reserve(rel(12), 3001)).body).toEqual({ fits: false, retry_at: null });
  });

  it("is keyed by the release: asking again inside the hour answers as first made and counts nothing more", async () => {
    await setClock(T);
    await empty();
    expect((await reserve(rel(1), 302)).body).toEqual({ fits: true, reads: 302, reserved_at: T });
    await setClock(T + 5000);
    expect((await reserve(rel(1), 302)).body).toEqual({ fits: true, reads: 302, reserved_at: T });
    expect((await reserve(rel(1), 2000)).body).toEqual({ fits: true, reads: 302, reserved_at: T });
    expect(await inModeration((sql) => sql.exec("SELECT COUNT(*) AS n, SUM(reads) AS reads FROM release_reads").one())).toEqual({ n: 1, reads: 302 });
    // Once its hour is over, it reserves again, at its new count.
    await setClock(T + HOUR);
    expect((await reserve(rel(1), 100)).body).toEqual({ fits: true, reads: 100, reserved_at: T + HOUR });
  });

  it("keeps no reservation past the budget, by a check the table takes from the budget itself", async () => {
    await setClock(T);
    await reserve(rel(1), 1);
    const sql = await inModeration((sql) => sql.exec("SELECT sql FROM sqlite_master WHERE name = 'release_reads'").one().sql as string);
    expect(sql).toContain("CHECK (reads BETWEEN 1 AND 3000)");
    const refused = (reads: number) => inModeration((sql) => { try { sql.exec("INSERT INTO release_reads (release_id, reads, reserved_at) VALUES (?, ?, ?)", rel(99), reads, T); sql.exec("DELETE FROM release_reads WHERE release_id = ?", rel(99)); return false; } catch { return true; } });
    expect([await refused(3000), await refused(3001), await refused(0)]).toEqual([false, true, true]);
  });

  it("refuses what isn't a release, a count or an owner, and no route reaches it", async () => {
    await empty();
    for (const [release, reads] of [["rel_x", 302], [`rel_${"A".repeat(32)}`, 302], [rel(1), 0], [rel(1), -1], [rel(1), 1.5], [rel(1), "302"], [rel(1), 2 ** 32]] as [string, unknown][]) {
      const answer = await reserve(release, reads);
      expect([answer.status, answer.body.error?.code], `${release} ${reads}`).toEqual([400, "invalid_argument"]);
    }
    // **An owner that isn't named as a room's Rust names one is refused, and nothing is reserved:** missing, of another
    // kind, or not an ID. The share's question refuses the same.
    for (const owner of [undefined, null, "", "org:", "team:org_x", "org:org x", 7, `org:${"a".repeat(129)}`]) {
      const answer = await internal("/release-reads", { release_id: rel(1), reads: 1, ...(owner === undefined ? {} : { owner_key: owner }) });
      expect([answer.status, answer.body.error?.code], String(owner)).toEqual([400, "invalid_argument"]);
      expect((await share(owner, 1)).status, String(owner)).toBe(400);
    }
    expect((await share("org:org_x", 0)).status).toBe(400);
    expect(await inModeration((sql) => sql.exec("SELECT COUNT(*) AS n FROM release_reads").one().n)).toBe(0);
    await switchedOn(async () => {
      for (const path of ["/v1/release-reads", "/v1/moderation/release-reads", "/release-reads", "/release-reads/share", "/v1/release-reads/share"]) {
        expect((await api(OPERATOR, "POST", path, { release_id: rel(1), reads: 1, owner_key: "org:org_x" })).code, path).toBe("not_found");
      }
    });
  });
});

describe("each owner's share of the release-read budget (docs/m6-release-read-share.md)", () => {
  const rel = (n: number) => `rel_${n.toString(16).padStart(32, "0")}`;
  const reserve = (release: string, reads: number, owner: string, more?: boolean) => internal("/release-reads", { release_id: release, reads, owner_key: owner, ...(more === undefined ? {} : { more }) });
  const share = (owner: string, reads: number) => internal("/release-reads/share", { owner_key: owner, reads });
  const tables = () => inModeration((sql) => ({
    reads: sql.exec("SELECT release_id, reads, reserved_at FROM release_reads ORDER BY release_id").toArray(),
    owners: sql.exec("SELECT release_id, owner_key FROM release_read_owner ORDER BY release_id").toArray(),
  }));
  const ORG_A = "org:org_share_a";
  const ORG_B = "org:org_share_b";
  const PERSON = "person:per_share_c";

  it("holds one owner to 1,204 reads in the hour, to the read and to the millisecond, while another owner still fits", async () => {
    await setClock(T);
    await inModeration((sql) => { sql.exec("DELETE FROM release_reads"); sql.exec("DELETE FROM release_read_owner"); });
    // Two full attempts of one organization, from two of its rooms' releases: exactly its share.
    expect((await reserve(rel(1), 602, ORG_A, true)).body).toEqual({ fits: true, reads: 602, reserved_at: T });
    await setClock(T + 1000);
    expect((await reserve(rel(2), 602, ORG_A, true)).body).toEqual({ fits: true, reads: 602, reserved_at: T + 1000 });
    // A read more is refused, though the hour's total has 1,796 left, and waits for its owner's oldest to leave.
    expect((await reserve(rel(3), 1, ORG_A, true)).body).toEqual({ fits: false, retry_at: T + HOUR });
    expect((await reserve(rel(1), 1, ORG_A, true)).body).toEqual({ fits: false, retry_at: T + HOUR });
    // Another owner's release fits at once.
    expect((await reserve(rel(4), 10, ORG_B, true)).body).toEqual({ fits: true, reads: 10, reserved_at: T + 1000 });
    // More than a share alone never fits.
    expect((await reserve(rel(5), 1205, PERSON, true)).body).toEqual({ fits: false, retry_at: null });
    expect((await reserve(rel(5), 1204, PERSON, true)).body).toEqual({ fits: true, reads: 1204, reserved_at: T + 1000 });
    // A millisecond before the hour rolls, the full owner still waits; at it, it fits again.
    await setClock(T + HOUR - 1);
    expect((await reserve(rel(3), 1, ORG_A, true)).body).toEqual({ fits: false, retry_at: T + HOUR });
    await setClock(T + HOUR);
    expect((await reserve(rel(3), 602, ORG_A, true)).body).toEqual({ fits: true, reads: 602, reserved_at: T + HOUR });
    expect((await reserve(rel(6), 1, ORG_A, true)).body).toEqual({ fits: false, retry_at: T + 1000 + HOUR });
  });

  it("still binds the hour's total across owners: two full owners leave 592, and a third owner's full attempt waits", async () => {
    await setClock(T);
    await inModeration((sql) => { sql.exec("DELETE FROM release_reads"); sql.exec("DELETE FROM release_read_owner"); });
    expect((await reserve(rel(1), 1204, ORG_A, true)).body.fits).toBe(true);
    await setClock(T + 500);
    expect((await reserve(rel(2), 1204, ORG_B, true)).body.fits).toBe(true);
    // The third owner has nothing of its own, and 592 are left of the 3,000.
    expect((await share(PERSON, 602)).body).toEqual({ fits: false, retry_at: T + HOUR });
    expect((await reserve(rel(3), 602, PERSON, true)).body).toEqual({ fits: false, retry_at: T + HOUR });
    expect((await share(PERSON, 592)).body).toEqual({ fits: true });
    expect((await reserve(rel(3), 592, PERSON, true)).body).toEqual({ fits: true, reads: 592, reserved_at: T + 500 });
    expect((await reserve(rel(4), 1, "room:ws_share_d", true)).body).toEqual({ fits: false, retry_at: T + HOUR });
  });

  it("keeps a release's reads with the owner first recorded, whatever a later reservation names, until they leave the hour", async () => {
    await setClock(T);
    await inModeration((sql) => { sql.exec("DELETE FROM release_reads"); sql.exec("DELETE FROM release_read_owner"); });
    // A release reserves its trees under its room's organization; the room then changes hands to a person, and the
    // same release's file reads are asked for under the new owner.
    expect((await reserve(rel(1), 2, ORG_A, true)).body.fits).toBe(true);
    await setClock(T + 1000);
    expect((await reserve(rel(1), 600, PERSON, true)).body).toEqual({ fits: true, reads: 602, reserved_at: T + 1000 });
    expect((await tables()).owners).toEqual([{ release_id: rel(1), owner_key: ORG_A }]);
    // **The past reads stay with the old owner:** the new owner's share is whole, the old one's holds them.
    expect((await share(PERSON, 1204)).body).toEqual({ fits: true });
    expect((await share(ORG_A, 603)).body).toEqual({ fits: false, retry_at: T + 1000 + HOUR });
    expect((await share(ORG_A, 602)).body).toEqual({ fits: true });
    // A later attempt of the same release is charged to the old owner too, and refused by the old owner's share.
    expect((await reserve(rel(2), 602, ORG_A, true)).body.fits).toBe(true);
    expect((await reserve(rel(1), 2, PERSON, true)).body).toEqual({ fits: false, retry_at: T + 1000 + HOUR });
    // Once its reads leave the hour, the release's owner goes with them, and a new reservation is charged afresh.
    await setClock(T + 1000 + HOUR);
    expect((await reserve(rel(1), 2, PERSON, true)).body.fits).toBe(true);
    expect((await tables()).owners).toEqual([{ release_id: rel(1), owner_key: PERSON }]);
  });

  it("answers the share's question without writing anything, by the object's clock", async () => {
    await setClock(T);
    await inModeration((sql) => { sql.exec("DELETE FROM release_reads"); sql.exec("DELETE FROM release_read_owner"); });
    expect((await reserve(rel(1), 1204, ORG_A, true)).body.fits).toBe(true);
    // An hour on, the old row is still in the table: the question reads past it, and leaves it there.
    await setClock(T + HOUR);
    const before = await tables();
    expect((await share(ORG_A, 1204)).body).toEqual({ fits: true });
    await setClock(T + HOUR - 1);
    expect((await share(ORG_A, 1)).body).toEqual({ fits: false, retry_at: T + HOUR });
    expect((await share(ORG_B, 1204)).body).toEqual({ fits: true });
    expect((await share(ORG_B, 1205)).body).toEqual({ fits: false, retry_at: null });
    expect(await tables()).toEqual(before);
  });

  it("counts a reservation made before the share in the total only, and keeps the owners' table safe to make on an old object", async () => {
    await setClock(T);
    await inModeration((sql) => { sql.exec("DELETE FROM release_reads"); sql.exec("DELETE FROM release_read_owner"); });
    // A row as the object held it before the share: no owner on record.
    await inModeration((sql) => sql.exec("INSERT INTO release_reads (release_id, reads, reserved_at) VALUES (?, 1800, ?)", rel(9), T));
    expect((await share(ORG_A, 1200)).body).toEqual({ fits: true });
    expect((await share(ORG_A, 1201)).body).toEqual({ fits: false, retry_at: T + HOUR });
    // Every request makes the table if it isn't there, and leaves it alone if it is.
    const made = await inModeration((sql) => sql.exec("SELECT sql FROM sqlite_master WHERE name = 'release_read_owner'").one().sql as string);
    expect(made).toContain("release_read_owner (release_id TEXT PRIMARY KEY");
    expect((await share(ORG_A, 1)).status).toBe(200);
    expect(await inModeration((sql) => sql.exec("SELECT reads FROM release_reads WHERE release_id = ?", rel(9)).one().reads)).toBe(1800);
  });
});
