import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { REFUSED_BODY, REFUSED_HEADERS, REFUSED_STATUS } from "../src/refuse";

// The outbound Worker, called as Workers for Platforms calls it: with the request an app's `fetch()` made, an
// environment and a context. Nothing here reaches Cloudflare.

/** The Worker's own `fetch`, called with the three arguments the runtime passes, which it declares it doesn't take. */
const call = (request: unknown, env: unknown = {}, ctx: unknown = {}) =>
  (worker.fetch as unknown as (request: unknown, env: unknown, ctx: unknown) => Response)(request, env, ctx);

/** An object any read of which is recorded, and then throws. The Worker is meant to read none of these. */
function untouchable(name: string, touched: string[]) {
  const trap = (what: string) => () => {
    touched.push(`${name}: ${what}`);
    throw new Error(`${name} was read`);
  };
  return new Proxy({}, { get: (_, key) => trap(`get ${String(key)}`)(), has: trap("has"), ownKeys: trap("ownKeys"), getPrototypeOf: trap("getPrototypeOf"), getOwnPropertyDescriptor: trap("getOwnPropertyDescriptor") });
}

const headersOf = (response: Response) => Object.fromEntries([...response.headers.entries()]);

/** The refusal, exactly: the fixed status, the fixed headers and nothing else, the fixed body. */
async function expectRefusal(response: Response, what: string) {
  expect(response.status, what).toBe(REFUSED_STATUS);
  expect(response.status, what).toBe(403);
  expect(headersOf(response), what).toEqual(REFUSED_HEADERS);
  expect(await response.text(), what).toBe(REFUSED_BODY);
}

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND", "PURGE", "QUERY", "MKCOL", "LOCK", "post", "x-anything"];

const ODD_URLS = [
  "http://169.254.169.254/latest/meta-data/",
  "http://127.0.0.1:8787/",
  "http://[::1]/",
  "http://localhost:1/",
  "http://0.0.0.0/",
  "https://user:password@example.com:65535/a/../../b?c=d#e",
  "https://xn--nxasmq6b.example/%2e%2e/%00",
  "https://example.com/" + "a".repeat(64 * 1024),
  "https://podster.dev/api/v1/anything",
  "http://10.0.0.1/admin",
  "ws://example.com/socket",
  "ftp://example.com/file",
  "data:text/plain,hello",
  "file:///etc/passwd",
  "blob:https://example.com/0000",
];

describe("the outbound Worker refuses every request", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let logs: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("the outbound Worker called fetch");
    });
    logs = (["log", "info", "warn", "error", "debug", "trace"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  });

  afterEach(() => {
    // It never makes a request of its own, and never logs, whatever the test did.
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("refuses every method, with the same answer", async () => {
    for (const method of METHODS) {
      const init: RequestInit = ["GET", "HEAD"].includes(method) ? { method } : { method, body: "payload" };
      await expectRefusal(call(new Request("https://example.com/", init)), method);
    }
    // Methods Node's `Request` won't build, which a runtime could still hand over. The Worker never reads the
    // request, so each is passed as an object it would throw on if it did.
    const touched: string[] = [];
    for (const method of ["CONNECT", "TRACE", "TRACK"]) await expectRefusal(call(untouchable(method, touched)), method);
    expect(touched).toEqual([]);
  });

  it("refuses odd URLs, internal addresses and Podster's own hosts alike", async () => {
    for (const url of ODD_URLS) {
      let request: unknown;
      try {
        request = new Request(url, { method: "POST", body: "x" });
      } catch {
        // A URL Node's `Request` refuses: stand in with an object the Worker would throw on if it read it.
        request = untouchable(url.slice(0, 40), []);
      }
      await expectRefusal(call(request), url.slice(0, 60));
    }
  });

  it("never reads a large body", async () => {
    // 64 MiB, offered one chunk at a time. A stream with no high-water mark pulls only when someone reads it.
    let pulls = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 64) controller.close();
        else controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 });
    const streamed = new Request("https://example.com/upload", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expectRefusal(call(streamed), "streamed body");
    expect(pulls).toBe(0);
    expect(streamed.bodyUsed).toBe(false);
    // And one already in memory: 32 MiB.
    const buffered = new Request("https://example.com/upload", { method: "PUT", body: new Uint8Array(32 * 1024 * 1024) });
    await expectRefusal(call(buffered), "buffered body");
    expect(buffered.bodyUsed).toBe(false);
    // The control: the same stream is readable, so a read would have been counted.
    const control = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.close(); } }, { highWaterMark: 0 });
    await new Response(control).arrayBuffer();
    expect(pulls).toBe(1);
  });

  it("echoes nothing of the request", async () => {
    const MARK = "echo-marker-7f3a";
    const request = new Request(`https://${MARK}.example/${MARK}?${MARK}=${MARK}`, {
      method: "POST",
      headers: { "x-mark": MARK, cookie: `s=${MARK}`, authorization: `Bearer ${MARK}`, origin: `https://${MARK}.example`, "content-type": "application/json" },
      body: JSON.stringify({ MARK }),
    });
    const response = call(request);
    const everything = JSON.stringify(headersOf(response)) + (await response.text()) + response.url + response.statusText;
    expect(everything).not.toContain(MARK);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("reads neither the request, nor the environment, nor the context", async () => {
    const touched: string[] = [];
    await expectRefusal(call(untouchable("request", touched), untouchable("env", touched), untouchable("ctx", touched)), "untouchable");
    await expectRefusal(call(undefined, undefined, undefined), "nothing at all");
    expect(touched).toEqual([]);
    // The control: the stand-in does record and throw when read.
    const control: string[] = [];
    expect(() => (untouchable("control", control) as { url: string }).url).toThrow("control was read");
    expect(control).toEqual(["control: get url"]);
  });

  it("answers each call with a new response, so one app's read can't empty another's", async () => {
    const [first, second] = [call(new Request("https://a.example/")), call(new Request("https://b.example/"))];
    expect(first).not.toBe(second);
    expect(await first.text()).toBe(REFUSED_BODY);
    await expectRefusal(second, "second");
  });

  it("can't be changed through its exported headers", () => {
    expect(Object.isFrozen(REFUSED_HEADERS)).toBe(true);
    expect(() => {
      (REFUSED_HEADERS as Record<string, string>)["access-control-allow-origin"] = "*";
    }).toThrow();
  });
});
