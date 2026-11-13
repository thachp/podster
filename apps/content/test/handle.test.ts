import { describe, expect, it } from "vitest";
import fixture from "../../../packages/contracts/serve-entry.fixture.json";
import { type Deps, FORWARDED_REQUEST_HEADERS, handle, KV_CACHE_SECONDS, PASSED_RESPONSE_HEADERS, sandboxPolicy, STOP_KEPT_MS } from "../src/handle";
import { isHost, isScriptName, STOP_KEY } from "../src/names";

// The content Worker's handler, against stand-ins for its two bindings (M6 step 4(b), ADR 0010). Nothing here reaches
// Cloudflare. The dispatch namespace's stand-in answers as spikes A and C recorded: asking for a script that isn't
// there returns without error, and its `fetch` rejects with an `Error` whose message is `Worker not found.`

const HOST = "k3v9q2.apps-test.example";
const ORIGIN = `https://${HOST}`;
const SCRIPT = "k3v9q2.rel_0123456789abcdef0123456789abcdef";

type World = {
  deps: Deps;
  kv: Map<string, string>;
  /** Every read of the serve entries' namespace, with the cache lifetime asked for. */
  reads: { key: string; cacheTtl: number }[];
  /** Every request an app was sent, with the script it was sent to. */
  sent: { script: string; request: Request }[];
  /** What each script answers. A script with no answer here isn't in the namespace. */
  apps: Map<string, (request: Request) => Response | Promise<Response>>;
  logs: string[];
  clock: { now: number };
  failReads: { all: boolean; keys: Set<string> };
};

function world(): World {
  const w: World = { kv: new Map([[HOST, SCRIPT]]), reads: [], sent: [], apps: new Map(), logs: [], clock: { now: 1_000_000 }, failReads: { all: false, keys: new Set() }, deps: undefined as unknown as Deps };
  w.apps.set(SCRIPT, () => new Response("<h1>app</h1>", { headers: { "content-type": "text/html" } }));
  w.deps = {
    entries: {
      async get(key, options) {
        w.reads.push({ key, cacheTtl: options.cacheTtl });
        if (w.failReads.all || w.failReads.keys.has(key)) throw new Error("KV is down");
        return w.kv.get(key) ?? null;
      },
    },
    apps: {
      get(script) {
        return {
          async fetch(request) {
            w.sent.push({ script, request });
            const app = w.apps.get(script);
            if (!app) throw new Error("Worker not found.");
            return app(request);
          },
        };
      },
    },
    now: () => w.clock.now,
    stop: { read: null },
    log: (status, code) => w.logs.push(`${status} ${code}`),
  };
  return w;
}

const get = (w: World, path = "/", init: RequestInit = {}, host = HOST) => handle(new Request(`https://${host}${path}`, init), w.deps);
const headersOf = (response: Response) => Object.fromEntries([...response.headers.entries()].sort());
/** What this Worker sets on every answer of an app's. */
const FIXED = {
  "access-control-allow-origin": "*",
  "cache-control": "max-age=60, no-transform",
  "content-security-policy": sandboxPolicy(ORIGIN),
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
};
/** And on every answer of its own, which no browser keeps. */
const OWN = { ...FIXED, "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" };
const NOT_FOUND = { ...OWN, "clear-site-data": '"cache"' };

describe("what a request may be", () => {
  it("serves GET and HEAD and refuses every other method, before anything is read", async () => {
    const w = world();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const refused = await get(w, "/", { method });
      expect([refused.status, headersOf(refused)], method).toEqual([405, { ...OWN, allow: "GET, HEAD" }]);
    }
    expect([w.reads, w.sent]).toEqual([[], []]);
    // A HEAD gets this Worker's own answers with no body, as it gets an app's.
    const headMissing = await get(w, "/", { method: "HEAD" }, "other.apps-test.example");
    expect([headMissing.status, await headMissing.text(), headMissing.headers.get("clear-site-data")]).toEqual([404, "", '"cache"']);
    w.sent.length = 0;
    const head = await get(w, "/", { method: "HEAD" });
    expect([head.status, await head.text(), w.sent[0].request.method]).toEqual([200, "", "HEAD"]);
    const page = await get(w);
    expect([page.status, await page.text()]).toEqual([200, "<h1>app</h1>"]);
  });

  it("refuses a service worker's script, however the header is written", async () => {
    const w = world();
    for (const value of ["script", "Script", " SCRIPT "]) {
      const refused = await get(w, "/sw.js", { headers: { "service-worker": value } });
      expect([refused.status, headersOf(refused), await refused.text()], value).toEqual([403, OWN, "no_service_workers\n"]);
    }
    expect([w.reads, w.sent]).toEqual([[], []]);
    // The same file asked for as an ordinary file is served.
    expect((await get(w, "/sw.js")).status).toBe(200);
  });

  it("never looks up a host that isn't one the API would have written", async () => {
    const w = world();
    for (const host of ["localhost", "under_score.example", "xn--caf-dma.example."]) {
      const answer = await handle(new Request(`https://${host}/`), w.deps);
      expect([answer.status, w.reads.length], host).toEqual([404, 0]);
      // The sandbox names the host. For a host that isn't one, it names nothing a page could load from.
      expect(answer.headers.get("content-security-policy"), host).toContain("default-src 'none'");
    }
    expect([isHost("a.b"), isHost("k3v9q2.apps-test.example"), isHost("has space.example"), isHost("UPPER.example"), isHost("a..b"), isHost(".a.b"), isHost(`${"a".repeat(250)}.com`)]).toEqual([false, true, false, false, false, false, false]);
  });
});

describe("the stop for the whole domain", () => {
  it("refuses every host while the key is there, whatever it holds", async () => {
    for (const value of [fixture.stop_value, "", "anything"]) {
      const w = world();
      w.kv.set(STOP_KEY, value);
      const answer = await get(w);
      expect([answer.status, headersOf(answer), await answer.text()], value).toEqual([404, NOT_FOUND, "not_found\n"]);
      // The host's entry isn't even read.
      expect([w.reads.map((read) => read.key), w.sent]).toEqual([[STOP_KEY], []]);
    }
    expect(STOP_KEY).toBe(fixture.stop_key);
  });

  it("refuses every host when the key can't be read, and asks again on the next request", async () => {
    const w = world();
    w.failReads.keys.add(STOP_KEY);
    expect((await get(w)).status).toBe(404);
    expect((await get(w)).status).toBe(404);
    // Unreadable is never remembered as clear, or as anything: each request asked.
    expect(w.reads.map((read) => read.key)).toEqual([STOP_KEY, STOP_KEY]);
    expect(w.sent).toEqual([]);
    w.failReads.keys.clear();
    expect((await get(w)).status).toBe(200);
  });

  it("is read at most once every 30 seconds for each running copy, with the clock passed in", async () => {
    const w = world();
    const stopReads = () => w.reads.filter((read) => read.key === STOP_KEY).length;
    expect((await get(w)).status).toBe(200);
    w.clock.now += STOP_KEPT_MS - 1;
    expect((await get(w)).status).toBe(200);
    expect(stopReads()).toBe(1);
    // The key is set meanwhile. This copy goes on serving until its 30 seconds are over, and then refuses.
    w.kv.set(STOP_KEY, fixture.stop_value);
    expect((await get(w)).status).toBe(200);
    w.clock.now += 1;
    expect([(await get(w)).status, stopReads()]).toEqual([404, 2]);
    // Lifted: the same again, the other way.
    w.kv.delete(STOP_KEY);
    w.clock.now += STOP_KEPT_MS - 1;
    expect([(await get(w)).status, stopReads()]).toEqual([404, 2]);
    w.clock.now += 1;
    expect([(await get(w)).status, stopReads()]).toEqual([200, 3]);
    expect(STOP_KEPT_MS).toBe(30_000);
    // A clock that went backwards never makes what was read last for ever.
    w.clock.now -= 10 * STOP_KEPT_MS;
    await get(w);
    expect(stopReads()).toBe(4);
  });
});

describe("the serve entry", () => {
  it("is one read for the request's exact host, asked with the shortest cache lifetime, and names the one script asked for", async () => {
    const w = world();
    await get(w, "/assets/app.js?v=3");
    expect(w.reads).toEqual([{ key: STOP_KEY, cacheTtl: 30 }, { key: HOST, cacheTtl: 30 }]);
    expect(KV_CACHE_SECONDS).toBe(30);
    expect(w.sent.map((sent) => [sent.script, sent.request.url])).toEqual([[SCRIPT, `${ORIGIN}/assets/app.js?v=3`]]);
    // A host written in another case is the same host.
    await handle(new Request(`https://${HOST.toUpperCase()}/`), w.deps);
    expect(w.reads[w.reads.length - 1].key).toBe(HOST);
  });

  it("answers not-found with no entry, on a sibling host, and when the entry can't be read", async () => {
    const w = world();
    for (const host of ["other.apps-test.example", `deep.${HOST}`, "apps-test.example"]) {
      const answer = await get(w, "/", {}, host);
      expect([answer.status, headersOf(answer)], host).toEqual([404, { ...NOT_FOUND, "content-security-policy": sandboxPolicy(`https://${host}`) }]);
    }
    w.failReads.keys.add(HOST);
    const unreadable = await get(w);
    expect([unreadable.status, headersOf(unreadable)]).toEqual([404, NOT_FOUND]);
    expect(w.sent).toEqual([]);
  });

  it("serves only a value that is a script's name, by the vectors the API and core are tested against", async () => {
    expect(fixture.invalid_script_names.length).toBeGreaterThanOrEqual(20);
    for (const value of fixture.invalid_script_names) {
      const w = world();
      w.kv.set(HOST, value);
      expect([isScriptName(value), (await get(w)).status, w.sent.length], JSON.stringify(value)).toEqual([false, 404, 0]);
    }
    for (const value of fixture.valid_script_names) {
      const w = world();
      w.kv.set(HOST, value);
      w.apps.set(value, () => new Response("ok"));
      expect([isScriptName(value), (await get(w)).status, w.sent.map((sent) => sent.script)], value).toEqual([true, 200, [value]]);
    }
    // The fixture's own pattern, which the API's test holds a written entry to, says the same of every vector.
    const pattern = new RegExp(fixture.script_name_pattern);
    for (const value of [...fixture.valid_script_names, ...fixture.invalid_script_names]) expect(pattern.test(value), JSON.stringify(value)).toBe(isScriptName(value));
    // A name that ends in a line break isn't one.
    expect(isScriptName(`${SCRIPT}\n`)).toBe(false);
  });
});

describe("asking the app", () => {
  it("sends three of the visitor's headers and nothing else of the visitor's", async () => {
    const w = world();
    await get(w, "/", { headers: {
      accept: "text/html", "if-none-match": '"abc"', "if-modified-since": "Wed, 11 Nov 2026 10:00:00 GMT",
      cookie: "podster_session=secret", authorization: "Bearer secret", range: "bytes=0-10", "accept-encoding": "gzip, br", "accept-language": "en",
      "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "203.0.113.9", referer: "https://elsewhere.example/", "user-agent": "a browser", origin: "https://elsewhere.example",
    } });
    expect(Object.fromEntries([...w.sent[0].request.headers.entries()].sort())).toEqual({ accept: "text/html", "if-modified-since": "Wed, 11 Nov 2026 10:00:00 GMT", "if-none-match": '"abc"' });
    expect([...FORWARDED_REQUEST_HEADERS]).toEqual(["accept", "if-none-match", "if-modified-since"]);
    // A request with a cookie and an Authorization header gets exactly what one without gets.
    const [withCredentials, without] = [await get(w, "/", { headers: { cookie: "a=b", authorization: "Bearer x" } }), await get(w)];
    expect([withCredentials.status, headersOf(withCredentials), await withCredentials.text()]).toEqual([without.status, headersOf(without), await without.text()]);
  });

  it("answers not-found for a script that isn't there, and an error for any other failure", async () => {
    const w = world();
    w.apps.delete(SCRIPT);
    const gone = await get(w);
    expect([gone.status, headersOf(gone)]).toEqual([404, NOT_FOUND]);
    // Only that exact message means the script isn't there.
    for (const message of ["Worker not found", "worker not found.", "Worker not found. ", "Internal error", ""]) {
      w.apps.set(SCRIPT, () => { throw new Error(message); });
      const failed = await get(w);
      expect([failed.status, headersOf(failed), await failed.text()], message).toEqual([502, OWN, "app_error\n"]);
    }
    w.apps.set(SCRIPT, () => { throw "not an Error"; });
    expect((await get(w)).status).toBe(502);
    // The namespace itself throwing is an error too, and still this Worker's own answer and headers.
    w.deps.apps = { get: () => { throw new Error("no namespace"); } };
    const broken = await get(w);
    expect([broken.status, headersOf(broken)]).toEqual([502, OWN]);
    // What is logged is a status and a code, nothing of the request.
    expect(new Set(w.logs)).toEqual(new Set(["404 not_found", "502 app_error"]));
  });
});

describe("the answer's headers", () => {
  it("are built from nothing: four of the app's, then this Worker's own", async () => {
    const w = world();
    w.apps.set(SCRIPT, () => new Response("body", { headers: {
      "content-type": "text/css", "content-length": "4", etag: '"v1"', "last-modified": "Wed, 11 Nov 2026 10:00:00 GMT",
      // Everything below is dropped or replaced, whatever the app or the platform set.
      "set-cookie": "a=b; Domain=apps-test.example; Path=/", "content-security-policy": "default-src *", "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "https://evil.example", "access-control-allow-credentials": "true", "clear-site-data": '"*"', "strict-transport-security": "max-age=0",
      "referrer-policy": "unsafe-url", "x-content-type-options": "none", "x-spike-header": "set-by-_headers", link: "</x>; rel=preload", refresh: "0; url=https://evil.example",
      "service-worker-allowed": "/", "x-frame-options": "ALLOWALL", "permissions-policy": "camera=*", "report-to": "{}", nel: "{}", "content-disposition": "attachment", vary: "Cookie", server: "app", "x-powered-by": "app",
      "cross-origin-opener-policy": "unsafe-none", "cross-origin-resource-policy": "cross-origin", "timing-allow-origin": "*", "www-authenticate": "Basic", "alt-svc": "h3=\":443\"", "sourcemap": "/x.map",
    } }));
    const answer = await get(w);
    expect(headersOf(answer)).toEqual({ ...FIXED, "content-length": "4", "content-type": "text/css", etag: '"v1"', "last-modified": "Wed, 11 Nov 2026 10:00:00 GMT" });
    expect(answer.headers.getSetCookie()).toEqual([]);
    expect([...PASSED_RESPONSE_HEADERS]).toEqual(["content-type", "content-length", "etag", "last-modified"]);
  });

  it("never lets a header outside the two lists leave, whatever name the app invents", async () => {
    const allowed = new Set([...PASSED_RESPONSE_HEADERS, ...Object.keys(FIXED), "location"]);
    const names = ["set-cookie", "set-cookie2", "x-anything", "content-language", "content-location", "expires", "pragma", "age", "accept-ranges", "date", "via", "x-robots-tag", "origin-agent-cluster", "content-security-policy-report-only", "x-xss-protection", "x-dns-prefetch-control", "x-permitted-cross-domain-policies", "cross-origin-embedder-policy", "document-policy", "speculation-rules", "supports-loading-mode", "critical-ch", "accept-ch", "early-data", "x-content-security-policy"];
    for (const name of names) {
      const w = world();
      w.apps.set(SCRIPT, () => new Response("x", { headers: { [name]: "value" } }));
      const answer = await get(w);
      expect([...answer.headers.keys()].filter((key) => !allowed.has(key)), name).toEqual([]);
      expect(answer.headers.has(name), name).toBe(false);
    }
  });

  it("passes a conditional answer and an app's own error, and gives no body to a status that can't carry one", async () => {
    const w = world();
    w.apps.set(SCRIPT, () => new Response(null, { status: 304, headers: { etag: '"v1"', "set-cookie": "a=b" } }));
    const unchanged = await get(w, "/", { headers: { "if-none-match": '"v1"' } });
    expect([unchanged.status, headersOf(unchanged), await unchanged.text()]).toEqual([304, { ...FIXED, etag: '"v1"' }, ""]);
    w.apps.set(SCRIPT, () => new Response("no such file", { status: 404, headers: { "content-type": "text/plain" } }));
    const missing = await get(w, "/nope");
    // The app's own not-found is the app's answer: no Clear-Site-Data, and kept for the app's minute.
    expect([missing.status, headersOf(missing), await missing.text()]).toEqual([404, { ...FIXED, "content-type": "text/plain" }, "no such file"]);
    w.apps.set(SCRIPT, () => new Response("oops", { status: 500 }));
    expect((await get(w)).status).toBe(500);
    w.apps.set(SCRIPT, () => new Response(null, { status: 204 }));
    expect([(await get(w)).status]).toEqual([204]);
  });

  it("serves nothing for an answer that isn't the plain file", async () => {
    for (const [status, headers] of [[206, { "content-range": "bytes 0-3/10" }], [200, { "content-encoding": "gzip" }], [200, { "content-range": "bytes 0-3/10" }], [206, {}]] as [number, Record<string, string>][]) {
      const w = world();
      w.apps.set(SCRIPT, () => new Response("part", { status, headers }));
      const answer = await get(w);
      expect([answer.status, headersOf(answer), await answer.text()], JSON.stringify([status, headers])).toEqual([502, OWN, "app_answer_unservable\n"]);
    }
  });

  it("passes a redirect only to a path on the same host", async () => {
    const redirect = async (status: number, location: string | null) => {
      const w = world();
      w.apps.set(SCRIPT, () => new Response(null, { status, headers: location === null ? {} : { location } }));
      const answer = await get(w, "/docs");
      return [answer.status, answer.headers.get("location")];
    };
    for (const status of [301, 302, 303, 307, 308]) expect(await redirect(status, "/docs/"), String(status)).toEqual([status, "/docs/"]);
    expect(await redirect(301, "/a/b?c=d#e")).toEqual([301, "/a/b?c=d#e"]);
    // This host, written out, is passed on as its path.
    expect(await redirect(302, `${ORIGIN}/docs/`)).toEqual([302, "/docs/"]);
    // Anywhere else, in any spelling a browser would take for another host or a scheme, is not-found.
    const elsewhere = [
      "https://evil.example/", "//evil.example/", "http://k3v9q2.apps-test.example/", `${ORIGIN}.evil.example/`, `${ORIGIN}@evil.example/`, `${ORIGIN}`, "https://other.apps-test.example/",
      "/\\evil.example", "\\\\evil.example", "/ /evil", "javascript:alert(1)", "data:text/html,x", "docs/", "", "/\tdocs", "/do cs", `${ORIGIN}//evil.example/`,
    ];
    for (const location of elsewhere) expect(await redirect(302, location), JSON.stringify(location)).toEqual([404, null]);
    expect(await redirect(302, null)).toEqual([404, null]);
    // Any other 3xx is never passed on, with or without a target.
    for (const status of [300, 305, 306]) expect(await redirect(status, "/docs/"), String(status)).toEqual([404, null]);
    // And the app was asked with redirects left alone, so this Worker never follows one itself.
    const w = world();
    await get(w);
    expect(w.sent[0].request.redirect).toBe("manual");
  });
});

describe("the sandbox", () => {
  it("is one policy, on every answer, naming the request's own host", async () => {
    expect(sandboxPolicy(ORIGIN)).toBe(
      `sandbox allow-scripts; default-src ${ORIGIN}; script-src ${ORIGIN}; style-src ${ORIGIN} 'unsafe-inline'; img-src ${ORIGIN} data:; connect-src ${ORIGIN}; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
    );
    const w = world();
    const answers = [await get(w), await get(w, "/", { method: "POST" }), await get(w, "/", { headers: { "service-worker": "script" } }), await get(w, "/", {}, "other.apps-test.example")];
    w.apps.delete(SCRIPT);
    answers.push(await get(w));
    w.kv.set(STOP_KEY, "stopped");
    w.clock.now += STOP_KEPT_MS;
    answers.push(await get(w));
    expect(answers.map((answer) => answer.status)).toEqual([200, 405, 403, 404, 404, 404]);
    for (const answer of answers) {
      const policy = answer.headers.get("content-security-policy") ?? "";
      expect(policy.startsWith("sandbox allow-scripts; ")).toBe(true);
      // Never the keyword for "this origin", which matches nothing in a sandboxed page.
      expect(policy).not.toContain("'self'");
    }
    expect(answers[3].headers.get("content-security-policy")).toBe(sandboxPolicy("https://other.apps-test.example"));
  });

  it("has scripts as its only allowance, for any host, and never gives a page its real origin back", () => {
    // Decision 216: every app is sandboxed. The word below would undo it, and no PR may add it. Any other word in
    // the sandbox directive is a change to that decision's stance, and is the owner's.
    const FORBIDDEN = ["allow", "same", "origin"].join("-");
    for (const host of [HOST, "a.b.c.example.org", "xn--caf-dma.example", "0.apps-test.example"]) {
      const sandbox = sandboxPolicy(`https://${host}`).split("; ")[0];
      expect(sandbox, host).toBe("sandbox allow-scripts");
      expect(sandboxPolicy(`https://${host}`), host).not.toContain(FORBIDDEN);
      expect(sandboxPolicy(`https://${host}`).match(/allow-[a-z-]+/g), host).toEqual(["allow-scripts"]);
    }
  });
});
