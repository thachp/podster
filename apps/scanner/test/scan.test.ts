import { describe, expect, it, vi } from "vitest";
import { MAX_SIGNATURE_AGE_MS, readDatabase, readJob, readVerdict, scanOne, SCANNER_HEADER, sendResult, signaturesAreFresh, withTimeout, type ScanJob, type ScanResult, type Scanning } from "../src/scan";

const NOW = Date.UTC(2026, 10, 7, 12);
const hash = "a".repeat(64);
const job: ScanJob = { v: 1, workspace_id: "ws_1", object_id: "obj_1", key: "rooms/ws_1/objects/obj_1/0f1e2d3c", size: 5, sha256: hash };
const fresh = { engine: "1.5.4", version: "28176", built_at: new Date(NOW - 86_400_000).toISOString() };
const stale = { ...fresh, built_at: new Date(NOW - MAX_SIGNATURE_AGE_MS - 1).toISOString() };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const clean = { report: "no_known_malware", reason: "none", sha256: hash, bytes: 5, database: fresh };

function setup(over: Partial<Scanning> & { scan?: () => Response | Promise<Response>; ready?: () => Response | Promise<Response> } = {}) {
  const sent: ScanResult[] = [];
  const scanned: Request[] = [];
  const scanning: Scanning = {
    now: () => NOW,
    read: async () => ({ size: 5, body: "hello" }),
    container: async (request) => {
      if (request.url.endsWith("/ready")) return (over.ready ?? (() => json({ ready: true, database: fresh })))();
      scanned.push(request);
      return (over.scan ?? (() => json(clean)))();
    },
    send: async (result) => {
      sent.push(result);
      return json({});
    },
    ...over,
  };
  return { sent, scanned, scanning };
}

describe("a verdict", () => {
  it("reports nothing found with the database version, in the words core reads", async () => {
    const { sent, scanning, scanned } = setup();
    expect(await scanOne(job, scanning)).toEqual({ ack: true, outcome: "no_known_malware" });
    expect(sent).toEqual([{ v: 1, workspace_id: "ws_1", object_id: "obj_1", key: job.key, report: "no_known_malware", reason: "none", sha256: hash, bytes: 5, database: fresh, scanned_at: NOW }]);
    expect(scanned[0].headers.get("x-expected-sha256")).toBe(hash);
    expect(scanned[0].headers.get("content-length")).toBe("5");
  });

  it.each([
    ["malware_found", "Win.Test.EICAR_HDB-1"],
    ["unreadable", "password_protected"],
    ["unreadable", "unreadable_archive"],
  ])("passes on %s (%s)", async (report, reason) => {
    const { sent, scanning } = setup({ scan: () => json({ ...clean, report, reason }) });
    expect(await scanOne(job, scanning)).toEqual({ ack: true, outcome: report });
    expect(sent[0]).toMatchObject({ report, reason, database: fresh });
  });

  it("carries no file name, because the message has none, and gives back the key it read, which is only IDs", async () => {
    const { sent, scanning } = setup();
    await scanOne({ ...job, name: "secret.txt" }, scanning);
    expect(JSON.stringify(sent[0])).not.toContain("secret");
    expect(sent[0].key).toBe(job.key);
  });
});

describe("fails closed: no verdict sends nothing and retries", () => {
  const noVerdict = async (over: Parameters<typeof setup>[0], why: string) => {
    const { sent, scanning } = setup(over);
    expect(await scanOne(job, scanning)).toEqual({ ack: false, why });
    expect(sent).toEqual([]);
  };

  it("a scanner that never answers", async () => {
    vi.useFakeTimers();
    try {
      const { sent, scanning } = setup({ scan: () => new Promise<Response>(() => {}) });
      const pending = scanOne(job, scanning);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await pending).toEqual({ ack: false, why: "no_answer" });
      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Container that never gets ready", async () => {
    vi.useFakeTimers();
    try {
      const { scanned, scanning } = setup({ ready: () => new Promise<Response>(() => {}) });
      const pending = scanOne(job, scanning);
      await vi.advanceTimersByTimeAsync(150_000);
      expect(await pending).toEqual({ ack: false, why: "not_ready" });
      expect(scanned).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // A compromised Container could answer at once and then stall, which would hold the one-at-a-time queue.
  const stalledBody = () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode('{"report":')) }));

  it("an answer whose body never ends", async () => {
    vi.useFakeTimers();
    try {
      const { sent, scanning } = setup({ scan: stalledBody });
      const pending = scanOne(job, scanning);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await pending).toEqual({ ack: false, why: "no_answer" });
      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a readiness answer whose body never ends", async () => {
    vi.useFakeTimers();
    try {
      const { scanned, scanning } = setup({ ready: stalledBody });
      const pending = scanOne(job, scanning);
      await vi.advanceTimersByTimeAsync(150_000);
      expect(await pending).toEqual({ ack: false, why: "not_ready" });
      expect(scanned).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stalled upload or dead clamd, which the Container answers with a 503", () => noVerdict({ scan: () => json({ error: "scan_interrupted" }, 503) }, "no_answer"));
  it("a connection that drops", () => noVerdict({ scan: () => Promise.reject(new Error("network connection lost")) }, "no_answer"));
  it("a 500", () => noVerdict({ scan: () => new Response("oops", { status: 500 }) }, "no_answer"));
  it("a 200 that isn't JSON", () => noVerdict({ scan: () => new Response("OK") }, "no_answer"));
  it("a report it doesn't know", () => noVerdict({ scan: () => json({ ...clean, report: "safe" }) }, "bad_answer"));
  it("no database version", () => noVerdict({ scan: () => json({ ...clean, database: undefined }) }, "bad_answer"));
  it("a database version that isn't one", () => noVerdict({ scan: () => json({ ...clean, database: { ...fresh, version: "latest" } }) }, "bad_answer"));
  it("no reason", () => noVerdict({ scan: () => json({ ...clean, reason: "" }) }, "bad_answer"));
  it("a size that isn't this file's", () => noVerdict({ scan: () => json({ ...clean, bytes: 6 }) }, "bad_answer"));
  it("nothing found about other bytes", () => noVerdict({ scan: () => json({ ...clean, sha256: "b".repeat(64) }) }, "bad_answer"));
  it("nothing found while claiming the hash didn't match", () => noVerdict({ scan: () => json({ ...clean, sha256: "b".repeat(64), reason: "hash_mismatch" }) }, "bad_answer"));
  it("a reason over the length the room keeps", () => noVerdict({ scan: () => json({ ...clean, report: "malware_found", reason: "x".repeat(121) }) }, "bad_answer"));
  it("a Container that isn't ready", () => noVerdict({ ready: () => json({ error: "not_ready" }, 503) }, "not_ready"));

  it("a room that refuses the result, or never answers", async () => {
    const { scanning } = setup({ send: async () => json({}, 500) });
    expect(await scanOne(job, scanning)).toEqual({ ack: false, why: "report_refused" });
    vi.useFakeTimers();
    try {
      const { scanning: silent } = setup({ send: () => new Promise<Response>(() => {}) });
      const pending = scanOne(job, silent);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toEqual({ ack: false, why: "report_refused" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("signatures past 7 days old (decision 84)", () => {
  it("don't start a scan when the Container says they're stale, and the file isn't read", async () => {
    const read = vi.fn(async () => ({ size: 5, body: "hello" }));
    const { sent, scanned, scanning } = setup({ read, ready: () => json({ error: "signatures_stale" }, 503) });
    expect(await scanOne(job, scanning)).toEqual({ ack: false, why: "signatures_stale" });
    expect(read).not.toHaveBeenCalled();
    expect(scanned).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("don't start a scan when the Container's own clock is wrong", async () => {
    const { sent, scanned, scanning } = setup({ ready: () => json({ ready: true, database: stale }) });
    expect(await scanOne(job, scanning)).toEqual({ ack: false, why: "signatures_stale" });
    expect(scanned).toEqual([]);
    expect(sent).toEqual([]);
  });

  it.each(["no_known_malware", "malware_found", "unreadable"])("give no verdict at all, even %s, if they went stale during the scan", async (report) => {
    const { sent, scanning } = setup({ scan: () => json({ ...clean, report, database: stale }) });
    expect(await scanOne(job, scanning)).toEqual({ ack: false, why: "signatures_stale" });
    expect(sent).toEqual([]);
  });

  it("are stale just past the limit, fresh at it, and a far-future date means nothing", () => {
    const at = (ms: number) => ({ ...fresh, built_at: new Date(ms).toISOString() });
    expect(signaturesAreFresh(at(NOW - MAX_SIGNATURE_AGE_MS), NOW)).toBe(true);
    expect(signaturesAreFresh(at(NOW - MAX_SIGNATURE_AGE_MS - 1), NOW)).toBe(false);
    expect(signaturesAreFresh(at(NOW + 86_400_000), NOW)).toBe(true);
    expect(signaturesAreFresh(at(NOW + 86_400_001), NOW)).toBe(false);
    expect(signaturesAreFresh(null, NOW)).toBe(false);
  });

  it("a 503 saying they're stale is told apart, for the log", () => {
    expect(readVerdict(503, { error: "signatures_stale" }, job, NOW)).toBe("signatures_stale");
  });
});

describe("what can only block", () => {
  it("an object that's gone blocks, and nothing is scanned", async () => {
    const { sent, scanned, scanning } = setup({ read: async () => null });
    expect(await scanOne(job, scanning)).toEqual({ ack: true, outcome: "unreadable" });
    expect(sent[0]).toMatchObject({ report: "unreadable", reason: "object_missing" });
    expect(scanned).toEqual([]);
  });

  it("an object of another size blocks, and nothing is scanned", async () => {
    const { sent, scanned, scanning } = setup({ read: async () => ({ size: 6, body: "hello!" }) });
    expect(await scanOne(job, scanning)).toEqual({ ack: true, outcome: "unreadable" });
    expect(sent[0]).toMatchObject({ report: "unreadable", reason: "size_mismatch", bytes: 6 });
    expect(scanned).toEqual([]);
  });

  it("over the upload limit blocks, and nothing is scanned", async () => {
    const big = { ...job, size: 100_000_001 };
    const { sent, scanned, scanning } = setup({ read: async () => ({ size: big.size, body: "x" }) });
    expect(await scanOne(big, scanning)).toEqual({ ack: true, outcome: "unreadable" });
    expect(sent[0].reason).toBe("too_large_to_scan");
    expect(scanned).toEqual([]);
  });

  it("the hash not matching is believed, because it can only block", async () => {
    const { sent, scanning } = setup({ scan: () => json({ ...clean, report: "unreadable", reason: "hash_mismatch", sha256: "b".repeat(64) }) });
    expect(await scanOne(job, scanning)).toEqual({ ack: true, outcome: "unreadable" });
    expect(sent[0]).toMatchObject({ reason: "hash_mismatch", sha256: hash });
  });
});

describe("a queue message", () => {
  it.each([
    ["no version", { ...job, v: undefined }],
    ["another version", { ...job, v: 2 }],
    ["a bad workspace", { ...job, workspace_id: "../x" }],
    ["a bad object", { ...job, object_id: "" }],
    ["no key", { ...job, key: "" }],
    ["another room's key", { ...job, key: "rooms/ws_2/objects/obj_1/0f1e2d3c" }],
    ["another file's key", { ...job, key: "rooms/ws_1/objects/obj_2/0f1e2d3c" }],
    ["a key with no attempt", { ...job, key: "rooms/ws_1/objects/obj_1/" }],
    ["a key that climbs out", { ...job, key: "rooms/ws_1/objects/obj_1/../../obj_2/x" }],
    ["a key in another shape", { ...job, key: "elsewhere/rooms/ws_1/objects/obj_1/0f1e2d3c" }],
    ["a bad hash", { ...job, sha256: "XYZ" }],
    ["a bad size", { ...job, size: -1 }],
    ["a size that's not a number", { ...job, size: "5" }],
    ["not an object", "scan it"],
    ["null", null],
  ])("with %s is dropped with no verdict", async (_, body) => {
    expect(readJob(body)).toBeNull();
    const { sent, scanned, scanning } = setup();
    expect(await scanOne(body, scanning)).toEqual({ ack: true, outcome: "bad_message" });
    expect(sent).toEqual([]);
    expect(scanned).toEqual([]);
  });
});

describe("telling the room", () => {
  const result: ScanResult = { v: 1, workspace_id: "ws_1", object_id: "obj_1", key: job.key, report: "no_known_malware", reason: "none", sha256: hash, bytes: 5, database: fresh, scanned_at: NOW };
  const signal = new AbortController().signal;

  it("proves it's the scanner, and sends no idempotency key, so a later finding still counts", async () => {
    const seen: Request[] = [];
    const api = { fetch: async (url: RequestInfo | URL, init?: RequestInit) => (seen.push(new Request(url, init)), json({})) } as Pick<Fetcher, "fetch">;
    await sendResult(api, "the-secret", result, signal);
    expect(new URL(seen[0].url).pathname).toBe("/internal/scan-result");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.get(SCANNER_HEADER)).toBe("the-secret");
    expect(seen[0].headers.get("idempotency-key")).toBeNull();
    expect(await seen[0].json()).toEqual(result);
  });

  it.each([400, 404, 409, 422])("a %i is an answer: nothing was recorded, retrying won't help, and the log can tell", async (status) => {
    const { scanning } = setup({ send: async () => json({}, status) });
    expect(await scanOne(job, scanning)).toEqual({ ack: true, outcome: "not_recorded", status });
  });

  it.each([500, 503, 429, 401, 403])("a %i retries, and ends in the dead-letter queue if it keeps on", async (status) => {
    const { scanning } = setup({ send: async () => json({}, status) });
    expect(await scanOne(job, scanning)).toEqual({ ack: false, why: "report_refused" });
  });

  it("sends nothing without its secret, so the queue retries and nothing is recorded", async () => {
    const fetch = vi.fn();
    expect((await sendResult({ fetch } as unknown as Pick<Fetcher, "fetch">, undefined, result, signal)).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    const { scanning } = setup({ send: (found, abort) => sendResult({ fetch } as unknown as Pick<Fetcher, "fetch">, "", found, abort) });
    expect(await scanOne(job, scanning)).toEqual({ ack: false, why: "report_refused" });
  });
});

describe("helpers", () => {
  it("readDatabase wants all of it", () => {
    expect(readDatabase(fresh)).toEqual(fresh);
    expect(readDatabase({ ...fresh, built_at: "soon" })).toBeNull();
    expect(readDatabase({ ...fresh, engine: "" })).toBeNull();
    expect(readDatabase("28176")).toBeNull();
  });

  it("readDatabase keeps to the room's limits, counting UTF-8 bytes", () => {
    expect(readDatabase({ ...fresh, engine: "e".repeat(40) })).not.toBeNull();
    expect(readDatabase({ ...fresh, engine: "e".repeat(41) })).toBeNull();
    // 20 UTF-16 units, but 60 bytes.
    expect(readDatabase({ ...fresh, engine: "€".repeat(20) })).toBeNull();
    expect(readDatabase({ ...fresh, version: "1".repeat(20) })).not.toBeNull();
    expect(readDatabase({ ...fresh, version: "1".repeat(21) })).toBeNull();
    expect(readDatabase({ ...fresh, version: "" })).toBeNull();
    expect(readDatabase({ ...fresh, built_at: `${fresh.built_at}${" ".repeat(41 - fresh.built_at.length)}` })).toBeNull();
  });

  it("withTimeout aborts what it started", async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const pending = withTimeout((signal) => {
        seen = signal;
        return new Promise<Response>(() => {});
      }, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toBeNull();
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a job its room has already failed", () => {
  it("is skipped once the hour since it was sent is over, without waking the Container", async () => {
    const { scanned, sent, scanning } = setup();
    let woke = false;
    const ending = await scanOne({ ...job, queued_at: NOW - 60 * 60_000 - 1 }, { ...scanning, container: async (r) => ((woke = true), scanning.container(r)) });
    expect(ending).toEqual({ ack: true, outcome: "too_late" });
    expect([woke, scanned.length, sent.length]).toEqual([false, 0, 0]);
  });

  it("is scanned as ever inside the hour, or when it says nothing of when it was sent", async () => {
    for (const body of [{ ...job, queued_at: NOW - 60 * 60_000 }, job]) {
      const { sent, scanning } = setup();
      expect(await scanOne(body, scanning)).toEqual({ ack: true, outcome: "no_known_malware" });
      expect(sent).toHaveLength(1);
    }
  });

  it("isn't a job at all if when it was sent isn't a time", () => {
    for (const queued_at of [0, -1, 1.5, "1", null]) expect(readJob({ ...job, queued_at }), String(queued_at)).toBeNull();
  });
});
