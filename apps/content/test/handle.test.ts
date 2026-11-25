import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../packages/contracts/serve-entry.fixture.json";
import { CODE_APPS_ENABLED, type Deps, FORWARDED_REQUEST_HEADERS, handle, KV_CACHE_SECONDS, PASSED_RESPONSE_HEADERS, sandboxPolicy, STOP_KEPT_MS } from "../src/handle";
import { CODE_MARK, customEntryScript, defaultHostLabel, isHost, isScriptName, isWrittenHost, scriptLabel, STOP_KEY } from "../src/names";
import type { Admission } from "../src/counter";
import { MAX_WRITE_BODY_BYTES, READ_HEADERS, WRITE_METHODS } from "../src/requests";

// The content Worker's handler, against stand-ins for its two bindings (M6 step 4(b), ADR 0010). Nothing here reaches
// Cloudflare. The dispatch namespace's stand-in answers as spikes A and C recorded: asking for a script that isn't
// there returns without error, and its `fetch` rejects with an `Error` whose message is `Worker not found.`

const DOMAIN = "apps-test.example";
const HOST = `k3v9q2.${DOMAIN}`;
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
  clock: { now: number };
  failReads: { all: boolean; keys: Set<string> };
  /** Every label the write counter was asked to count a write for. */
  counted: string[];
  /** What the write counter answers. */
  budget: Admission;
  /** The order in which the counter and the app were asked. */
  order: ("count" | "dispatch")[];
  /** Every line logged. */
  logged: unknown[];
  /** Every script asked of the namespace, with the options it was asked with: none, or a dispatch's limits. */
  asked: { script: string; options: unknown }[];
};

/** The limits this file's worlds give a dispatch to a host with code: figures of the test's, not a ruling's. */
const LIMITS = { cpuMs: 50, subRequests: 5 } as const;

function world(): World {
  const w: World = { kv: new Map([[HOST, SCRIPT]]), reads: [], sent: [], apps: new Map(), clock: { now: 1_000_000 }, failReads: { all: false, keys: new Set() }, counted: [], budget: { ok: true }, order: [], logged: [], asked: [], deps: undefined as unknown as Deps };
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
      get(script, args, options) {
        w.asked.push({ script, options: args === undefined && options === undefined ? "none" : { args, options } });
        return {
          async fetch(request) {
            w.order.push("dispatch");
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
    domain: DOMAIN,
    codeApps: false,
    limits: LIMITS,
    writes: {
      async admit(label) {
        w.order.push("count");
        w.counted.push(label);
        return w.budget;
      },
    },
    log: (line) => w.logged.push(line),
  };
  return w;
}

const get = (w: World, path = "/", init: RequestInit = {}, host = HOST) => handle(new Request(`https://${host}${path}`, init), w.deps);
/** An answer an app could send that Node's own `Response` refuses to build: a 1xx, or a body with a status that can't carry one. */
const rawAnswer = (status: number, body: string | null, headers: Record<string, string> = {}) =>
  ({ status, headers: new Headers(headers), body: body === null ? null : new Response(body).body }) as unknown as Response;
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
      expect([refused.status, headersOf(refused), await refused.text()], method).toEqual([405, { ...OWN, allow: "GET, HEAD" }, "method_not_allowed\n"]);
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

  it("refuses any request that carries a Service-Worker header, whatever it holds", async () => {
    const w = world();
    // A browser sends `script` with a service worker's script and its imports, and with nothing else. Under the
    // sandbox no page can register one, so no request an app needs carries the header at all.
    for (const value of ["script", "Script", " SCRIPT ", "", "anything", "script, other"]) {
      const refused = await get(w, "/sw.js", { headers: { "service-worker": value } });
      expect([refused.status, headersOf(refused), await refused.text()], JSON.stringify(value)).toEqual([403, OWN, "no_service_workers\n"]);
    }
    expect([w.reads, w.sent]).toEqual([[], []]);
    // The same file asked for as an ordinary file is served.
    expect((await get(w, "/sw.js")).status).toBe(200);
  });

  it("serves on the content domain only an app's default host, and reads nothing for any other name there or no host", async () => {
    const w = world();
    // The content domain itself, a deeper name, a label of a form no app has, and names that aren't hosts: none is an
    // app's host. A host off the content domain may be a custom hostname, which has its own entry form (step 8c).
    const others = [DOMAIN, `deep.${HOST}`, `has-dash.${DOMAIN}`, `${"a".repeat(27)}.${DOMAIN}`, "localhost", "under_score.example", "xn--caf-dma.example."];
    for (const host of others) {
      // Even with an entry written for it, as only a fault or another writer could.
      w.kv.set(host, SCRIPT);
      const answer = await handle(new Request(`https://${host}/`), w.deps);
      expect([answer.status, w.reads.length, w.sent.length], host).toEqual([404, 0, 0]);
      // The sandbox names the host. For a host that is no app's, it names nothing a page could load from.
      expect(answer.headers.get("content-security-policy"), host).toContain("default-src 'none'");
    }
    // A name off the content domain holding a default host's form, the script's name alone, serves nothing: only a
    // custom hostname's own form is read there.
    for (const host of [`k3v9q2.other-${DOMAIN}`, `k3v9q2.${DOMAIN}.evil.example`, "app.example.org"]) {
      w.kv.set(host, SCRIPT);
      const answer = await handle(new Request(`https://${host}/`), w.deps);
      expect([answer.status, w.sent.length], host).toEqual([404, 0]);
    }
    w.reads.length = 0;
    expect([defaultHostLabel(HOST, DOMAIN), defaultHostLabel(DOMAIN, DOMAIN), defaultHostLabel(`a.b.${DOMAIN}`, DOMAIN), defaultHostLabel(`k3v9q2${DOMAIN}`, DOMAIN), defaultHostLabel(HOST, ""), defaultHostLabel(HOST, "example")]).toEqual(["k3v9q2", null, null, null, null, null]);
    expect([isHost("a.b"), isHost(HOST), isHost("has space.example"), isHost("UPPER.example"), isHost("a..b"), isHost(".a.b"), isHost(`${"a".repeat(250)}.com`)]).toEqual([false, true, false, false, false, false, false]);
    // A content domain that isn't a host, a single label, is no domain, even for a host that would sit under it.
    w.deps.domain = "example";
    expect([(await handle(new Request("https://k3v9q2.example/"), w.deps)).status, w.reads.length]).toEqual([404, 0]);
    // With no content domain configured, or one that isn't a host, no host is anyone's.
    for (const domain of ["", "not a domain", "example"]) {
      w.deps.domain = domain;
      const answer = await get(w);
      expect([answer.status, w.reads.length, w.sent.length], JSON.stringify(domain)).toEqual([404, 0, 0]);
    }
  });

  it("never serves an app over plain HTTP: the same host and path over HTTPS, and nothing read", async () => {
    const w = world();
    const plain = (path: string, init: RequestInit = {}, host = HOST) => handle(new Request(`http://${host}${path}`, init), w.deps);
    const moved = await plain("/docs/page?a=1&b=2");
    expect([moved.status, headersOf(moved), await moved.text()]).toEqual([301, { ...OWN, location: `${ORIGIN}/docs/page?a=1&b=2` }, "moved_to_https\n"]);
    expect([(await plain("/")).headers.get("location"), (await plain("/", {}, `${HOST}:8080`)).headers.get("location")]).toEqual([`${ORIGIN}/`, `${ORIGIN}/`]);
    const head = await plain("/x", { method: "HEAD" });
    expect([head.status, head.headers.get("location"), await head.text()]).toEqual([301, `${ORIGIN}/x`, ""]);
    // A header that says the request was secure changes nothing: the scheme is the URL's, which no visitor's
    // header can change.
    for (const headers of [{ "x-forwarded-proto": "https" }, { "cf-visitor": '{"scheme":"https"}' }, { forwarded: "proto=https" }, { "x-forwarded-ssl": "on" }] as Record<string, string>[]) {
      expect((await plain("/", { headers })).status, JSON.stringify(headers)).toBe(301);
    }
    // And one that says a secure request wasn't is ignored the same way.
    expect((await get(w, "/", { headers: { "x-forwarded-proto": "http" } })).status).toBe(200);
    // The other refusals come first, and a name on the content domain that is no app's is not-found, never
    // redirected. A name off it may be a custom hostname, which goes to HTTPS the same way, with nothing read.
    expect([(await plain("/", { method: "POST" })).status, (await plain("/", { headers: { "service-worker": "script" } })).status, (await plain("/", {}, `deep.${HOST}`)).status]).toEqual([405, 403, 404]);
    expect((await plain("/a?b=1", {}, "app.example.org")).headers.get("location")).toBe("https://app.example.org/a?b=1");
    // Nothing was read and nothing was asked of any app for a plain request.
    expect([w.reads.filter((read) => read.key !== STOP_KEY && read.key !== HOST), w.sent.length]).toEqual([[], 1]);
    const fresh = world();
    await handle(new Request(`http://${HOST}/`), fresh.deps);
    expect([fresh.reads, fresh.sent]).toEqual([[], []]);
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

  it("answers not-found with no entry, on a sibling app's host, and when the entry can't be read", async () => {
    const w = world();
    const sibling = await get(w, "/", {}, `other.${DOMAIN}`);
    expect([sibling.status, headersOf(sibling)]).toEqual([404, { ...NOT_FOUND, "content-security-policy": sandboxPolicy(`https://other.${DOMAIN}`) }]);
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
      expect([isScriptName(value), scriptLabel(value), (await get(w)).status, w.sent.length], JSON.stringify(value)).toEqual([false, null, 404, 0]);
    }
    for (const value of fixture.valid_script_names) {
      // Each is served on the host of its own label, which is the only host that may serve it.
      const label = value.slice(0, value.indexOf("."));
      const host = `${label}.${DOMAIN}`;
      const w = world();
      w.kv.set(host, value);
      w.apps.set(value, () => new Response("ok"));
      expect([isScriptName(value), scriptLabel(value), (await get(w, "/", {}, host)).status, w.sent.map((sent) => sent.script)], value).toEqual([true, label, 200, [value]]);
    }
    // The fixture's own pattern, which the API's test holds a written entry to, says the same of every vector.
    const pattern = new RegExp(fixture.script_name_pattern);
    for (const value of [...fixture.valid_script_names, ...fixture.invalid_script_names]) expect(pattern.test(value), JSON.stringify(value)).toBe(isScriptName(value));
    // A name that ends in a line break isn't one.
    expect(isScriptName(`${SCRIPT}\n`)).toBe(false);
  });

  it("never serves a script under another label than the host's own", async () => {
    // The API's applier writes a default host only its own label's script. This is the second lock, and the public
    // one: an entry that names another app's script, as only a fault or another writer could leave, serves nothing.
    const others = ["other.rel_0123456789abcdef0123456789abcdef", "k3v9q.rel_0123456789abcdef0123456789abcdef", "k3v9q22.rel_0123456789abcdef0123456789abcdef", "a.rel_0123456789abcdef0123456789abcdef"];
    for (const value of others) {
      const w = world();
      w.kv.set(HOST, value);
      w.apps.set(value, () => new Response("another app's files"));
      const answer = await get(w);
      expect([answer.status, headersOf(answer), w.sent.length], value).toEqual([404, NOT_FOUND, 0]);
    }
    // The same script on its own label's host is served.
    const w = world();
    w.kv.set(`other.${DOMAIN}`, others[0]);
    w.apps.set(others[0], () => new Response("its own files"));
    expect([(await get(w, "/", {}, `other.${DOMAIN}`)).status, w.sent.map((sent) => sent.script)]).toEqual([200, [others[0]]]);
  });

  it("learns a host's kind from the mark on its entry, by the fixture's vectors: with the switch off, code serves nothing", async () => {
    expect(fixture.valid_code_entries.length).toBeGreaterThanOrEqual(4);
    for (const value of fixture.valid_code_entries) {
      const script = value.slice(CODE_MARK.length);
      const host = `${script.slice(0, script.indexOf("."))}.${DOMAIN}`;
      const w = world();
      w.kv.set(host, value);
      w.apps.set(script, () => new Response("its code"));
      const answer = await get(w, "/", {}, host);
      // Exactly today's answer for a host with code while the switch is off: its own refusal, and no app asked.
      expect([answer.status, await answer.text(), answer.headers.get("access-control-allow-origin"), w.sent.length], value).toEqual([503, "code_apps_off\n", "null", 0]);
      // And on another label's host, nothing at all.
      const other = world();
      other.kv.set(HOST, value);
      if (!value.includes("k3v9q2.")) expect([(await get(other)).status, other.sent.length], value).toEqual([404, 0]);
    }
    // A malformed or ambiguous mark is no entry: not-found, as for any value that isn't one.
    expect(fixture.invalid_code_entries.length).toBeGreaterThanOrEqual(20);
    for (const value of fixture.invalid_code_entries) {
      const w = world();
      w.kv.set(HOST, value);
      const answer = await get(w);
      expect([answer.status, headersOf(answer), w.sent.length], JSON.stringify(value)).toEqual([404, NOT_FOUND, 0]);
    }
    // A static name that only begins with the mark's word is static, served as always.
    for (const value of fixture.static_entries_not_marked) {
      const host = `${value.slice(0, value.indexOf("."))}.${DOMAIN}`;
      const w = world();
      w.kv.set(host, value);
      w.apps.set(value, () => new Response("ok"));
      expect([(await get(w, "/", {}, host)).status, w.sent.map((sent) => sent.script)], value).toEqual([200, [value]]);
    }
  });
});

describe("a custom hostname (M6 step 8c)", () => {
  const CUSTOM = "app.example.com";
  const ENTRY = `${SCRIPT}@${CUSTOM}`;
  /** A world whose custom hostname holds its entry, in the form the API writes for it. */
  const custom = () => {
    const w = world();
    w.kv.set(CUSTOM, ENTRY);
    return w;
  };

  it("serves the script its entry names, only when that entry names this very host, with the sandbox naming the host", async () => {
    const w = custom();
    const answer = await get(w, "/index.html?x=1", {}, CUSTOM);
    expect([answer.status, await answer.text()]).toEqual([200, "<h1>app</h1>"]);
    expect(w.reads).toEqual([{ key: STOP_KEY, cacheTtl: 30 }, { key: CUSTOM, cacheTtl: 30 }]);
    expect(w.sent.map((sent) => [sent.script, sent.request.url])).toEqual([[SCRIPT, `https://${CUSTOM}/index.html?x=1`]]);
    expect(headersOf(answer)).toEqual({
      ...FIXED,
      "content-type": "text/html",
      "content-security-policy": sandboxPolicy(`https://${CUSTOM}`),
      // A custom hostname is a customer's name: its HSTS never pins the customer's other names, and is never preloaded.
      "strict-transport-security": "max-age=31536000",
    });
    // The same value under another name is nothing: a value copied, or written under the wrong key, serves nothing.
    w.kv.set("www.example.com", ENTRY);
    expect((await get(w, "/", {}, "www.example.com")).status).toBe(404);
  });

  it("reads its entry only in the custom form, by the vectors the API and core are tested against", async () => {
    expect(fixture.custom_entry_separator).toBe("@");
    expect(fixture.invalid_custom_entries.length).toBeGreaterThanOrEqual(15);
    for (const value of fixture.invalid_custom_entries) {
      const w = world();
      w.kv.set(fixture.custom_entry_host, value);
      const answer = await get(w, "/", {}, fixture.custom_entry_host);
      expect([customEntryScript(fixture.custom_entry_host, value), answer.status, w.sent.length], JSON.stringify(value)).toEqual([null, 404, 0]);
      expect(headersOf(answer)["strict-transport-security"]).toBe("max-age=31536000");
    }
    for (const value of fixture.valid_custom_entries) {
      const w = world();
      const script = value.slice(0, value.indexOf("@"));
      w.kv.set(fixture.custom_entry_host, value);
      w.apps.set(script, () => new Response("ok"));
      expect([customEntryScript(fixture.custom_entry_host, value), (await get(w, "/", {}, fixture.custom_entry_host)).status, w.sent.map((sent) => sent.script)], value).toEqual([script, 200, [script]]);
    }
  });

  it("learns its kind from the mark on its entry, by the fixture's vectors: with the switch off, code serves nothing", async () => {
    const host = fixture.custom_entry_host;
    for (const value of fixture.valid_code_custom_entries) {
      const w = world();
      w.kv.set(host, value);
      w.apps.set(value.slice(CODE_MARK.length, value.indexOf("@")), () => new Response("its code"));
      const answer = await get(w, "/", {}, host);
      expect([answer.status, await answer.text(), w.sent.length], value).toEqual([503, "code_apps_off\n", 0]);
    }
    expect(fixture.invalid_code_custom_entries.length).toBeGreaterThanOrEqual(20);
    for (const value of [...fixture.invalid_code_custom_entries, ...fixture.valid_code_entries]) {
      const w = world();
      w.kv.set(host, value);
      const answer = await get(w, "/", {}, host);
      expect([answer.status, w.sent.length], JSON.stringify(value)).toEqual([404, 0]);
    }
  });

  it("reads no entry for a host Rust never writes, and reads a formed host as core does, by the fixture's vectors", async () => {
    expect(fixture.custom_entry_refused_hosts.length).toBeGreaterThanOrEqual(10);
    for (const host of fixture.custom_entry_refused_hosts) {
      expect([isWrittenHost(host), customEntryScript(host, `${SCRIPT}@${host}`)], host).toEqual([false, null]);
    }
    // An IP address reaches the Worker as what it is, and nothing is read for it. (A request can't even name a host
    // whose last label is a number but isn't an address: the URL parser refuses it.)
    const ip = world();
    ip.kv.set("192.0.2.1", `${SCRIPT}@192.0.2.1`);
    expect([(await get(ip, "/", {}, "192.0.2.1")).status, ip.reads.length, ip.sent.length]).toEqual([404, 0, 0]);
    // A public suffix alone is a formed host, read the same on both sides: the claim refuses it, not the entry's form.
    for (const host of fixture.custom_entry_formed_hosts) {
      expect([isWrittenHost(host), customEntryScript(host, `${SCRIPT}@${host}`)], host).toEqual([true, SCRIPT]);
    }
  });

  it("refuses a custom hostname once its entry is gone, though Cloudflare's edge still sends it here (spike D, item 12)", async () => {
    // Spike D saw a request reach the Worker under a custom hostname 282 ms after its delete read gone at Cloudflare.
    // What refuses it then is this Worker's own check: no entry for the host, nothing served, the release's marker
    // included, and no app is asked. The API takes the entry down before a claim is freed (8b's S1), never relying on
    // Cloudflare's deletion alone.
    const w = custom();
    const marker = "/.well-known/podster-release.json";
    expect((await get(w, marker, {}, CUSTOM)).status).toBe(200);
    w.kv.delete(CUSTOM);
    for (const path of [marker, "/", "/index.html"]) {
      const answer = await get(w, path, {}, CUSTOM);
      expect([path, answer.status]).toEqual([path, 404]);
    }
    expect(w.sent.length).toBe(1);
  });

  it("answers not-found with no entry, an entry it can't read, and while the domain is stopped, and keeps a default host's HSTS", async () => {
    const empty = world();
    const none = await get(empty, "/", {}, CUSTOM);
    expect([none.status, headersOf(none)]).toEqual([404, { ...NOT_FOUND, "content-security-policy": sandboxPolicy(`https://${CUSTOM}`), "strict-transport-security": "max-age=31536000" }]);
    const unreadable = custom();
    unreadable.failReads.keys.add(CUSTOM);
    expect((await get(unreadable, "/", {}, CUSTOM)).status).toBe(404);
    const stopped = custom();
    stopped.kv.set(STOP_KEY, fixture.stop_value);
    expect([(await get(stopped, "/", {}, CUSTOM)).status, stopped.reads.map((read) => read.key)]).toEqual([404, [STOP_KEY]]);
    expect([empty.sent, unreadable.sent, stopped.sent]).toEqual([[], [], []]);
    // A default host keeps `includeSubDomains`: the content domain is Podster's own.
    expect((await get(world())).headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });

  it("is never read with no content domain configured, which is no deployment's way to tell names apart", async () => {
    for (const domain of ["", "not a domain", "example"]) {
      const w = custom();
      w.deps.domain = domain;
      expect([(await get(w, "/", {}, CUSTOM)).status, w.reads.length, w.sent.length], JSON.stringify(domain)).toEqual([404, 0, 0]);
    }
  });

  it("meets the same rules as a default host for its kind: a host with code serves nothing while the switch is off", async () => {
    const w = custom();
    // The entry carries the mark that its script has code, before the custom form.
    w.kv.set(CUSTOM, `${CODE_MARK}${ENTRY}`);
    const answer = await get(w, "/", {}, CUSTOM);
    expect([answer.status, await answer.text(), w.sent.length]).toEqual([503, "code_apps_off\n", 0]);
    expect((await get(w, "/", { method: "POST" }, CUSTOM)).status).toBe(405);
    expect((await get(w, "/sw.js", { headers: { "service-worker": "script" } }, CUSTOM)).status).toBe(403);
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

  it("answers a static host not-found for a script that isn't there, and for any other failure of the dispatch", async () => {
    const w = world();
    w.apps.delete(SCRIPT);
    const gone = await get(w);
    expect([gone.status, headersOf(gone), await gone.text()]).toEqual([404, NOT_FOUND, "not_found\n"]);
    // A static release has no code of its own to throw, so any rejection is the platform's, and the script can't be
    // confirmed: not-found, never an error, whatever the message.
    for (const message of ["Worker not found", "worker not found.", "Worker not found. ", "Internal error", ""]) {
      w.apps.set(SCRIPT, () => { throw new Error(message); });
      const failed = await get(w);
      expect([failed.status, headersOf(failed), await failed.text()], message).toEqual([404, NOT_FOUND, "not_found\n"]);
    }
    w.apps.set(SCRIPT, () => { throw "not an Error"; });
    expect((await get(w)).status).toBe(404);
    // The namespace itself throwing is not-found too, and still this Worker's own answer and headers.
    w.deps.apps = { get: () => { throw new Error("no namespace"); } };
    const broken = await get(w);
    expect([broken.status, headersOf(broken)]).toEqual([404, NOT_FOUND]);
    // A HEAD gets the same, with no body.
    const head = await get(w, "/", { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([404, ""]);
  });

  it("logs each failed dispatch as its class and its release's ID, and nothing else of the request or the error", async () => {
    const RELEASE = SCRIPT.slice(SCRIPT.indexOf(".") + 1);
    const w = world();
    // A dispatch that answers logs nothing.
    expect([(await get(w)).status, w.logged]).toEqual([200, []]);
    // A message that carries things that must never reach a log: a host, a path, a header, a token.
    const secret = `failed for ${HOST}/private/path?token=abc cookie: a=b`;
    w.apps.set(SCRIPT, () => { throw new Error(secret); });
    await get(w, "/private/path?token=abc", { headers: { cookie: "a=b", accept: "text/html" } });
    w.apps.delete(SCRIPT);
    await get(w, "/other", { method: "HEAD" });
    w.deps.apps = { get: () => { throw new Error(secret); } };
    await get(w);
    expect(w.logged).toEqual([
      { event: "dispatch_error", release: RELEASE },
      { event: "dispatch_missing", release: RELEASE },
      { event: "dispatch_error", release: RELEASE },
    ]);
    for (const line of w.logged) {
      expect(Object.keys(line as object).sort()).toEqual(["event", "release"]);
      const text = JSON.stringify(line);
      for (const word of [HOST, "k3v9q2", DOMAIN, "/private", "token", "cookie", "failed", "text/html"]) expect(text, word).not.toContain(word);
    }
    // A host with code logs its failures the same way.
    const c = codeWorld();
    c.apps.set(SCRIPT, () => { throw new Error(secret); });
    await get(c, "/api/items", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(c.logged).toEqual([{ event: "dispatch_error", release: RELEASE }]);
    // A log that fails changes no answer.
    const f = world();
    f.apps.delete(SCRIPT);
    f.deps.log = () => { throw new Error("log down"); };
    expect((await get(f)).status).toBe(404);
  });

  it("never answers a taken-down app's host with an error while a cached entry still names its deleted script", async () => {
    // M6-R14 on staging, 2026-11-24: a suspension removed the entry and then deleted the script, but the entry is read
    // with an edge cache, so for some seconds the cached entry still named the script, and the dispatch to it
    // rejected with a message other than "Worker not found." The host answered 502 where it must answer not-found.
    const w = world();
    expect((await get(w)).status).toBe(200);
    // The takedown: the script is going and the entry the edge still holds names it. The platform's message while the
    // script is being deleted is unknown, so a few are tried.
    for (const message of ["Worker not found.", "Internal error", "The script is being deleted", "Network connection lost."]) {
      w.apps.set(SCRIPT, () => { throw new Error(message); });
      for (const init of [{}, { method: "HEAD" }]) {
        const answer = await get(w, "/", init);
        expect([answer.status, answer.headers.get("clear-site-data")], message).toEqual([404, '"cache"']);
      }
    }
    // Then the cache catches up: no entry, and the namespace isn't asked at all.
    w.kv.delete(HOST);
    w.sent.length = 0;
    expect([(await get(w)).status, w.sent]).toEqual([404, []]);
  });

  it("builds the request to the app from nothing, so nothing else of the visitor's request can ride along", async () => {
    const w = world();
    const gone = new AbortController();
    const visitor = new Request(`${ORIGIN}/page?q=1`, {
      headers: { accept: "text/html", cookie: "a=b", "x-custom": "1" }, cache: "no-store", credentials: "include", mode: "same-origin", referrer: "https://elsewhere.example/from",
      referrerPolicy: "unsafe-url", integrity: "sha256-abc", keepalive: true, signal: gone.signal,
    });
    await handle(visitor, w.deps);
    const sent = w.sent[0].request;
    const untouched = new Request(`${ORIGIN}/page?q=1`, { redirect: "manual" });
    // A new request object, with the URL, the method and the three headers, and every other setting as a request
    // made from nothing has it. None of the visitor's settings came with it.
    expect(sent).not.toBe(visitor);
    expect([sent.url, sent.method, sent.body, sent.redirect]).toEqual([`${ORIGIN}/page?q=1`, "GET", null, "manual"]);
    expect(Object.fromEntries(sent.headers.entries())).toEqual({ accept: "text/html" });
    expect([sent.cache, sent.credentials, sent.mode, sent.referrer, sent.referrerPolicy, sent.integrity, sent.keepalive]).toEqual([untouched.cache, untouched.credentials, untouched.mode, untouched.referrer, untouched.referrerPolicy, untouched.integrity, untouched.keepalive]);
    expect([visitor.cache, visitor.credentials, visitor.keepalive]).toEqual(["no-store", "include", true]);
    // Not the visitor's abort signal either: the visitor going away doesn't reach into the app's request.
    gone.abort();
    expect([visitor.signal.aborted, sent.signal.aborted]).toEqual([true, false]);
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
    // An app that sends a body with a status that can't carry one: the status is passed, and the body isn't.
    for (const status of [204, 205, 304]) {
      w.apps.set(SCRIPT, () => rawAnswer(status, "a body that shouldn't be here", { etag: '"v2"' }));
      const answer = await get(w);
      expect([answer.status, await answer.text(), headersOf(answer)], String(status)).toEqual([status, "", { ...FIXED, etag: '"v2"' }]);
    }
    // And every other status keeps its body.
    for (const status of [200, 201, 203, 404, 410, 500, 503]) {
      w.apps.set(SCRIPT, () => rawAnswer(status, `body of ${status}`));
      const answer = await get(w);
      expect([answer.status, await answer.text()], String(status)).toEqual([status, `body of ${status}`]);
    }
  });

  it("serves nothing for an interim answer", async () => {
    // A 1xx isn't a file. Node's own Response can't be built with one, so the app's answer here is a plain object.
    for (const status of [100, 101, 103, 199]) {
      const w = world();
      w.apps.set(SCRIPT, () => rawAnswer(status, null, { upgrade: "websocket", "content-type": "text/html" }));
      const answer = await get(w);
      expect([answer.status, headersOf(answer), await answer.text()], String(status)).toEqual([502, OWN, "app_answer_unservable\n"]);
    }
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
    const answers = [await get(w), await get(w, "/", { method: "POST" }), await get(w, "/", { headers: { "service-worker": "script" } }), await get(w, "/", {}, "other.apps-test.example"), await handle(new Request(`http://${HOST}/`), w.deps)];
    w.apps.delete(SCRIPT);
    answers.push(await get(w));
    w.kv.set(STOP_KEY, "stopped");
    w.clock.now += STOP_KEPT_MS;
    answers.push(await get(w));
    expect(answers.map((answer) => answer.status)).toEqual([200, 405, 403, 404, 301, 404, 404]);
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

// Stage 1's request rules (ADR 0010's revision, sections 3.4 and 3.5; `src/requests.ts`, the mirror of
// `podster_core::app_requests`), through the real handler, for both kinds of host. A host with code is one the test
// says has code: the serve entry has no such mark yet, and the Worker's entry says every script is static.
//
// The switch is off in the Worker, as a constant of type `false` that no configuration reaches. With it off, no method
// but GET and HEAD is looked at past the host and the scheme. So the rules for writes and preflights are shown here with
// `Deps.codeApps` set by the test, which only a test can do; serving an app with code stays refused even then.

const CODE_OWN = { ...OWN, "access-control-allow-origin": "null" };
/** What this Worker sets on an app's answer to a write, for a host with code: never kept, readable by the origin null. */
const CODE_APP = { ...FIXED, "access-control-allow-origin": "null", "cache-control": "no-store" };
/** A refused preflight's headers: this Worker's own, readable by nobody. */
const PREFLIGHT_OWN = Object.fromEntries(Object.entries(OWN).filter(([name]) => name !== "access-control-allow-origin"));
const STATIC_405 = { ...OWN, allow: "GET, HEAD" };
const CODE_405 = { ...CODE_OWN, allow: "GET, HEAD, POST, PUT, PATCH, DELETE" };
const JSON_HEADERS = { "content-type": "application/json" };

/** A world whose one app's release carries code, with the switch on through the test's seam unless said otherwise. */
function codeWorld(codeApps = true): World {
  const w = world();
  // The entry carries the mark that its script has code (`podster_core::serve_entry`).
  w.kv.set(HOST, `${CODE_MARK}${SCRIPT}`);
  w.deps.codeApps = codeApps;
  return w;
}
const answerOf = async (response: Response) => [response.status, headersOf(response), await response.text()];
/** A body of exactly `bytes` bytes. */
const bodyOf = (bytes: number) => "x".repeat(bytes);

describe("the code-apps switch", () => {
  it("is on since 2026-11-25, and is a constant no binding or variable reaches", () => {
    expect(CODE_APPS_ENABLED).toBe(true);
  });

  it("while off, refuses every method but GET and HEAD with today's answer before anything is read, even on a host with code", async () => {
    const w = codeWorld(false);
    for (const [method, init] of [["POST", { body: "{}", headers: JSON_HEADERS }], ["PUT", { body: bodyOf(MAX_WRITE_BODY_BYTES + 1), headers: JSON_HEADERS }], ["DELETE", {}], ["OPTIONS", { headers: { "access-control-request-method": "POST" } }], ["PATCH", { body: "x" }]] as [string, RequestInit][]) {
      expect(await answerOf(await get(w, "/", { method, ...init })), method).toEqual([405, STATIC_405, "method_not_allowed\n"]);
    }
    expect([w.reads, w.sent, w.counted]).toEqual([[], [], []]);
    // A read on that host still learns its kind, and is refused: nothing of an app with code is served.
    expect(await answerOf(await get(w))).toEqual([503, CODE_OWN, "code_apps_off\n"]);
    expect(w.sent).toEqual([]);
  });

  it("while off, never asks the write counter, for any method on any host, and answers exactly as before it existed", async () => {
    const hosts: [string, string | null][] = [[HOST, SCRIPT], [HOST, `${CODE_MARK}${SCRIPT}`], [HOST, null], ["app.example.org", `${CODE_MARK}${SCRIPT}@app.example.org`], [`deep.${HOST}`, null]];
    for (const [host, entry] of hosts) {
      for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        const w = world();
        if (entry === null) w.kv.delete(host);
        else w.kv.set(host, entry);
        // A counter that would refuse, so a request that reached it would answer differently.
        w.budget = { ok: false, refusal: { code: "write_budget_spent", retryAfterMs: 1n } };
        const answer = await get(w, "/api/items", { method, ...(["GET", "HEAD", "OPTIONS"].includes(method) ? {} : { body: "{}", headers: JSON_HEADERS }) }, host);
        expect([w.counted, answer.status === 429], `${host} ${method}`).toEqual([[], false]);
        if (!["GET", "HEAD"].includes(method)) expect(answer.status, `${host} ${method}`).toBe(405);
      }
    }
  });
});

describe("a host whose release carries code", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serves nothing for a read with the switch off: its own refusal, readable by the origin null, and no app asked", async () => {
    const w = codeWorld(false);
    for (const method of ["GET", "HEAD"]) {
      const answer = await get(w, "/", { method });
      expect(await answerOf(answer), method).toEqual([503, CODE_OWN, method === "HEAD" ? "" : "code_apps_off\n"]);
    }
    expect([w.sent, w.asked]).toEqual([[], []]);
    // The same request to a static host is served, as it always was.
    w.kv.set(HOST, SCRIPT);
    expect((await get(w)).status).toBe(200);
  });

  it("serves a read with the switch on: sent with the dispatch's limits, never kept, readable by the origin null", async () => {
    const w = codeWorld();
    w.apps.set(SCRIPT, () => new Response("<h1>todo</h1>", { headers: { "content-type": "text/html", etag: '"e"', "set-cookie": "a=b", "cache-control": "max-age=999", "access-control-allow-origin": "*", "x-app": "1" } }));
    for (const method of ["GET", "HEAD"]) {
      const answer = await get(w, "/?x=1", { method, headers: { accept: "text/html", cookie: "a=b", authorization: "Bearer x", "if-none-match": '"d"' } });
      expect(await answerOf(answer), method).toEqual([200, { ...CODE_APP, "content-type": "text/html", etag: '"e"' }, method === "HEAD" ? "" : "<h1>todo</h1>"]);
      const sent = w.sent.at(-1)!.request;
      // The read's three headers and nothing else of the visitor's, at the visitor's exact path and query.
      expect([sent.method, sent.url, Object.fromEntries(sent.headers.entries())], method).toEqual([method, `${ORIGIN}/?x=1`, { accept: "text/html", "if-none-match": '"d"' }]);
    }
    // Every ask of the namespace for this host gave the script the dispatch's limits, and nothing more.
    expect(w.asked).toEqual([
      { script: SCRIPT, options: { args: {}, options: { limits: { cpuMs: 50, subRequests: 5 } } } },
      { script: SCRIPT, options: { args: {}, options: { limits: { cpuMs: 50, subRequests: 5 } } } },
    ]);
    // Nothing is counted for a read.
    expect(w.counted).toEqual([]);
    // A static host is still asked with no options at all.
    w.kv.set(HOST, SCRIPT);
    expect((await get(w)).status).toBe(200);
    expect(w.asked.at(-1)).toEqual({ script: SCRIPT, options: "none" });
  });

  it("sends the release marker's own request to the script at exactly the marker's path, and passes its answer (spike H, item 1)", async () => {
    // The marker job's request: the exact path, `accept: application/json` and `cache-control: no-cache`, no redirect
    // followed. The platform serves the marker's static file before the app's script, for exactly this path.
    const MARKER = "/.well-known/podster-release.json";
    const body = '{"release_id":"rel_0123456789abcdef0123456789abcdef","commit":"ce013625030ba8dba906f756967f9e9ca394464a"}\n';
    const w = codeWorld();
    w.apps.set(SCRIPT, (request) => (new URL(request.url).pathname === MARKER ? new Response(body, { headers: { "content-type": "application/json", etag: '"m"' } }) : new Response("module", { status: 500 })));
    const answer = await get(w, MARKER, { headers: { accept: "application/json", "cache-control": "no-cache" }, redirect: "manual" });
    expect(await answerOf(answer)).toEqual([200, { ...CODE_APP, "content-type": "application/json", etag: '"m"' }, body]);
    const sent = w.sent[0].request;
    expect([w.sent.length, w.sent[0].script, sent.method, sent.url, Object.fromEntries(sent.headers.entries())]).toEqual([1, SCRIPT, "GET", `${ORIGIN}${MARKER}`, { accept: "application/json" }]);
    // The same on an app's custom hostname, whose entry names the same script.
    const custom = "app.example.org";
    w.kv.set(custom, `${CODE_MARK}${SCRIPT}@${custom}`);
    const onCustom = await get(w, MARKER, { headers: { accept: "application/json" } }, custom);
    expect([onCustom.status, await onCustom.text(), w.sent.at(-1)!.request.url]).toEqual([200, body, `https://${custom}${MARKER}`]);
  });

  it("refuses everything that would reach the app when no limits are configured, before a write is counted", async () => {
    const w = codeWorld();
    w.deps.limits = null;
    for (const [method, init] of [["GET", {}], ["HEAD", {}], ...WRITE_METHODS.map((method) => [method, { body: "{}", headers: JSON_HEADERS }])] as [string, RequestInit][]) {
      expect(await answerOf(await get(w, "/api/items", { method, ...init })), method).toEqual([503, CODE_OWN, method === "HEAD" ? "" : "app_limits_unknown\n"]);
    }
    expect([w.sent, w.asked, w.counted]).toEqual([[], [], []]);
    // A preflight reaches no app, so it is still answered; a static host is asked as always, with no limits.
    expect((await get(w, "/api/items", { method: "OPTIONS", headers: { "access-control-request-method": "POST" } })).status).toBe(204);
    w.kv.set(HOST, SCRIPT);
    expect((await get(w)).status).toBe(200);
    expect(w.asked).toEqual([{ script: SCRIPT, options: "none" }]);
  });

  it("answers a read's failures as its own, readable by the origin null and never kept", async () => {
    const cases: [string, ((request: Request) => Response | Promise<Response>) | null, number, string, Record<string, string>][] = [
      ["missing", null, 404, "not_found\n", { "clear-site-data": '"cache"' }],
      // An app that throws, or passes a limit, which the platform answers by throwing: this Worker's own error.
      ["throws", () => { throw new Error("Worker exceeded CPU time limit."); }, 502, "app_error\n", {}],
      ["partial", () => new Response("x", { status: 206 }), 502, "app_answer_unservable\n", {}],
      ["encoded", () => new Response("x", { headers: { "content-encoding": "gzip" } }), 502, "app_answer_unservable\n", {}],
      ["interim", () => rawAnswer(103, null), 502, "app_answer_unservable\n", {}],
      ["elsewhere", () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }), 404, "not_found\n", { "clear-site-data": '"cache"' }],
      ["protocol-relative", () => new Response(null, { status: 307, headers: { location: "//evil.example/" } }), 404, "not_found\n", { "clear-site-data": '"cache"' }],
    ];
    for (const [name, app, status, body, extra] of cases) {
      const w = codeWorld();
      if (app === null) w.apps.delete(SCRIPT);
      else w.apps.set(SCRIPT, app);
      expect(await answerOf(await get(w, "/page")), name).toEqual([status, { ...CODE_OWN, ...extra }, body]);
    }
    // A redirect to a path on this host passes, as a static host's does (the platform's own, `/index.html` to `/`).
    const w = codeWorld();
    w.apps.set(SCRIPT, () => new Response(null, { status: 307, headers: { location: `${ORIGIN}/` } }));
    expect(await answerOf(await get(w, "/index.html"))).toEqual([307, { ...CODE_APP, location: "/" }, ""]);
    // A conditional answer passes, with no body.
    w.apps.set(SCRIPT, () => rawAnswer(304, "dropped", { etag: '"e"' }));
    expect(await answerOf(await get(w, "/", { headers: { "if-none-match": '"e"' } }))).toEqual([304, { ...CODE_APP, etag: '"e"' }, ""]);
  });

  it("answers an error after its kind is known as its own, readable by the origin null: a body that fails as it is counted", async () => {
    const w = codeWorld();
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("the visitor went away")); } });
    const answer = await handle(new Request(`${ORIGIN}/api/items`, { method: "POST", body, headers: JSON_HEADERS, duplex: "half" } as RequestInit), w.deps);
    expect(await answerOf(answer)).toEqual([502, CODE_OWN, "error\n"]);
    // Before the kind is known, the same error is answered as it always was.
    const s = world();
    s.deps.stop.read = { at: s.clock.now, stopped: false };
    // The entry's read answers something that isn't a string, so reading it throws before any kind is learned.
    s.deps.entries = { get: async () => 42 as unknown as string };
    expect(await answerOf(await get(s))).toEqual([502, OWN, "error\n"]);
  });

  it("counts a write that passes every rule, then sends it to the app with its body, at the body's cap and one under it, declared or counted", async () => {
    for (const method of WRITE_METHODS) {
      for (const bytes of [MAX_WRITE_BODY_BYTES - 1, MAX_WRITE_BODY_BYTES]) {
        for (const declared of [true, false]) {
          const w = codeWorld();
          const headers: Record<string, string> = { ...JSON_HEADERS, accept: "application/json", cookie: "a=b", authorization: "Bearer x", origin: "null" };
          if (declared) headers["content-length"] = String(bytes);
          const answer = await get(w, "/api/items?x=1", { method, body: bodyOf(bytes), headers });
          const label = `${method} ${bytes} ${declared ? "declared" : "counted"}`;
          expect(await answerOf(answer), label).toEqual([200, { ...CODE_APP, "content-type": "text/html" }, "<h1>app</h1>"]);
          // Counted once, for the app's label, before the app was asked.
          expect([w.counted, w.order], label).toEqual([["k3v9q2"], ["count", "dispatch"]]);
          // The app gets the method, the URL, the body as counted, and the write's headers, and nothing else.
          const sent = w.sent[0].request;
          expect([w.sent.length, w.sent[0].script, sent.method, sent.url, await sent.text()], label).toEqual([1, SCRIPT, method, `${ORIGIN}/api/items?x=1`, bodyOf(bytes)]);
          expect(Object.keys(Object.fromEntries(sent.headers.entries())).filter((name) => name !== "content-length").sort(), label).toEqual(["accept", "content-type"]);
        }
      }
    }
    // A write with no body at all, as a DELETE often is, still names JSON, is counted, and goes with an empty body.
    const w = codeWorld();
    expect((await get(w, "/api/items/1", { method: "DELETE", headers: JSON_HEADERS })).status).toBe(200);
    expect([w.counted, await w.sent[0].request.text()]).toEqual([["k3v9q2"], ""]);
  });

  it("refuses a write over the budget with 429 and when to come back, readable by the origin null, and never asks the app", async () => {
    for (const [retryAfterMs, seconds] of [[1n, "1"], [999n, "1"], [1_000n, "1"], [1_001n, "2"], [599_990n, "600"]] as const) {
      const w = codeWorld();
      w.budget = { ok: false, refusal: { code: "write_budget_spent", retryAfterMs } };
      const answer = await get(w, "/api/items", { method: "POST", body: "{}", headers: JSON_HEADERS });
      expect(await answerOf(answer), String(retryAfterMs)).toEqual([429, { ...CODE_OWN, "retry-after": seconds, "access-control-expose-headers": "retry-after" }, "write_budget_spent\n"]);
      expect([w.counted, w.order, w.sent], String(retryAfterMs)).toEqual([["k3v9q2"], ["count"], []]);
    }
  });

  it("refuses a write as unknown, 503, when the budget can't be read, and never asks the app", async () => {
    const w = codeWorld();
    w.budget = { ok: false, refusal: { code: "write_budget_unknown" } };
    for (const method of WRITE_METHODS) {
      expect(await answerOf(await get(w, "/api/items", { method, body: "{}", headers: JSON_HEADERS })), method).toEqual([503, CODE_OWN, "write_budget_unknown\n"]);
    }
    expect([w.counted.length, w.sent]).toEqual([4, []]);
    // A counter that throws, though the real one never does, is this Worker's own error, and the app isn't asked.
    w.deps.writes = {
      admit: async () => {
        throw new Error("counter down");
      },
    };
    expect(await answerOf(await get(w, "/api/items", { method: "POST", body: "{}", headers: JSON_HEADERS }))).toEqual([502, CODE_OWN, "error\n"]);
    expect(w.sent).toEqual([]);
  });

  it("counts no write this Worker refuses itself, and no read or preflight", async () => {
    const w = codeWorld();
    const requests: [string, RequestInit][] = [
      ["/", {}],
      ["/", { method: "HEAD" }],
      ["/", { method: "OPTIONS", headers: { "access-control-request-method": "POST" } }],
      ["/", { method: "OPTIONS", headers: { "access-control-request-method": "TRACE" } }],
      ["/", { method: "POST", body: bodyOf(MAX_WRITE_BODY_BYTES + 1), headers: JSON_HEADERS }],
      ["/", { method: "POST", body: bodyOf(MAX_WRITE_BODY_BYTES + 1), headers: { ...JSON_HEADERS, "content-length": "10" } }],
      ["/", { method: "POST", headers: { ...JSON_HEADERS, "content-length": String(MAX_WRITE_BODY_BYTES + 1) } }],
      ["/", { method: "POST", headers: { ...JSON_HEADERS, "content-length": "1e3" } }],
      ["/", { method: "PUT", body: "{}", headers: { "content-type": "text/plain" } }],
      ["/", { method: "PROPFIND", headers: JSON_HEADERS }],
      ["/sw.js", { method: "POST", headers: { ...JSON_HEADERS, "service-worker": "script" } }],
      ["/ws", { method: "POST", headers: { ...JSON_HEADERS, upgrade: "websocket" } }],
    ];
    const statuses = [];
    for (const [path, init] of requests) statuses.push((await get(w, path, init)).status);
    expect(statuses).toEqual([200, 200, 204, 403, 413, 413, 413, 400, 415, 405, 403, 403]);
    // Only the two reads reached the app, and nothing was counted.
    expect([w.counted, w.sent.map((sent) => sent.request.method)]).toEqual([[], ["GET", "HEAD"]]);
    w.sent.length = 0;
    // Nor on a host that isn't confirmed to have code: no entry, a static host, plain HTTP, and the stop.
    w.kv.delete(HOST);
    expect((await get(w, "/", { method: "POST", body: "{}", headers: JSON_HEADERS })).status).toBe(405);
    w.kv.set(HOST, SCRIPT);
    expect((await get(w, "/", { method: "POST", body: "{}", headers: JSON_HEADERS })).status).toBe(405);
    w.kv.set(HOST, `${CODE_MARK}${SCRIPT}`);
    expect((await handle(new Request(`http://${HOST}/`, { method: "POST", body: "{}", headers: JSON_HEADERS }), w.deps)).status).toBe(405);
    w.kv.set(STOP_KEY, "stopped");
    w.deps.stop.read = null;
    expect((await get(w, "/", { method: "POST", body: "{}", headers: JSON_HEADERS })).status).toBe(405);
    expect([w.counted, w.sent]).toEqual([[], []]);
  });

  it("counts by the app's label, so a new release keeps the count and a custom hostname shares its app's", async () => {
    const w = codeWorld();
    const write = { method: "POST", body: "{}", headers: JSON_HEADERS };
    expect((await get(w, "/", write)).status).toBe(200);
    // The same app's next release: another script under the same label.
    const next = "k3v9q2.rel_ffffffffffffffffffffffffffffffff";
    w.apps.set(next, () => new Response("{}", { headers: { "content-type": "application/json" } }));
    w.kv.set(HOST, `${CODE_MARK}${next}`);
    expect((await get(w, "/", write)).status).toBe(200);
    // The app's custom hostname, whose entry names the same script.
    const custom = "app.example.org";
    w.kv.set(custom, `${CODE_MARK}${next}@${custom}`);
    expect((await get(w, "/", write, custom)).status).toBe(200);
    expect(w.counted).toEqual(["k3v9q2", "k3v9q2", "k3v9q2"]);
    expect(w.sent.map((sent) => sent.script)).toEqual([SCRIPT, next, next]);
  });

  it("counts a write the app then fails, and answers the app's errors as its own, readable by the origin null", async () => {
    const write = { method: "POST", body: "{}", headers: JSON_HEADERS };
    const cases: [string, ((request: Request) => Response | Promise<Response>) | null, number, string][] = [
      ["missing", null, 404, "not_found\n"],
      [
        "throws",
        () => {
          throw new Error("boom");
        },
        502,
        "app_error\n",
      ],
      ["redirects", () => new Response(null, { status: 303, headers: { location: "/done" } }), 502, "app_answer_unservable\n"],
      ["partial", () => new Response("x", { status: 206 }), 502, "app_answer_unservable\n"],
      ["encoded", () => new Response("x", { headers: { "content-encoding": "gzip" } }), 502, "app_answer_unservable\n"],
    ];
    for (const [name, app, status, body] of cases) {
      const w = codeWorld();
      if (app === null) w.apps.delete(SCRIPT);
      else w.apps.set(SCRIPT, app);
      const answer = await get(w, "/api/items", write);
      expect([answer.status, await answer.text(), answer.headers.get("access-control-allow-origin"), answer.headers.get("cache-control")], name).toEqual([status, body, "null", "no-store"]);
      expect([w.counted, w.order], name).toEqual([["k3v9q2"], ["count", "dispatch"]]);
    }
    // The app's own refusal is passed on as the app's, with only the headers that pass, and is still counted.
    const w = codeWorld();
    w.apps.set(SCRIPT, () => new Response('{"error":"no"}', { status: 422, headers: { "content-type": "application/json", "set-cookie": "a=b", "access-control-allow-origin": "*", "cache-control": "max-age=999" } }));
    expect(await answerOf(await get(w, "/api/items", write))).toEqual([422, { ...CODE_APP, "content-type": "application/json" }, '{"error":"no"}']);
    expect(w.counted).toEqual(["k3v9q2"]);
    // An answer that can't carry a body gets none, and no length the app gave for the body it dropped.
    for (const status of [204, 205]) {
      w.apps.set(SCRIPT, () => rawAnswer(status, "dropped", { "content-length": "7", "content-type": "application/json", etag: '"e"' }));
      expect(await answerOf(await get(w, "/api/items", write)), String(status)).toEqual([status, { ...CODE_APP, "content-type": "application/json", etag: '"e"' }, ""]);
    }
  });

  it("sends a write on with no condition: the visitor's If-None-Match and If-Modified-Since stay behind", async () => {
    const w = codeWorld();
    const conditions = { "if-none-match": '"abc"', "if-modified-since": "Wed, 11 Nov 2026 10:00:00 GMT" };
    for (const method of WRITE_METHODS) {
      expect((await get(w, "/api/items", { method, body: "{}", headers: { ...JSON_HEADERS, accept: "application/json", ...conditions } })).status, method).toBe(200);
    }
    for (const sent of w.sent) expect(Object.keys(Object.fromEntries(sent.request.headers.entries())).filter((name) => name !== "content-length").sort(), sent.request.method).toEqual(["accept", "content-type"]);
    // A read keeps them, as it always has.
    w.kv.set(HOST, SCRIPT);
    await get(w, "/", { headers: conditions });
    expect(Object.keys(Object.fromEntries(w.sent.at(-1)!.request.headers.entries())).sort()).toEqual(["if-modified-since", "if-none-match"]);
  });

  it("refuses a body one byte over the cap, declared or counted, and a length that understates the body", async () => {
    const over = MAX_WRITE_BODY_BYTES + 1;
    for (const method of WRITE_METHODS) {
      const w = codeWorld();
      const declared = await get(w, "/api/items", { method, body: bodyOf(over), headers: { ...JSON_HEADERS, "content-length": String(over) } });
      expect(await answerOf(declared), `${method} declared`).toEqual([413, CODE_OWN, "write_too_large\n"]);
      const counted = await get(w, "/api/items", { method, body: bodyOf(over), headers: JSON_HEADERS });
      expect(await answerOf(counted), `${method} counted`).toEqual([413, CODE_OWN, "write_too_large\n"]);
      const understated = await get(w, "/api/items", { method, body: bodyOf(over), headers: { ...JSON_HEADERS, "content-length": "10" } });
      expect(await answerOf(understated), `${method} understated`).toEqual([413, CODE_OWN, "write_too_large\n"]);
      expect(w.sent).toEqual([]);
    }
    // The largest length there is, and one past it: too large, and not a length at all.
    const w = codeWorld();
    expect((await get(w, "/", { method: "POST", headers: { ...JSON_HEADERS, "content-length": "18446744073709551615" } })).status).toBe(413);
    // (A space around a header's value is trimmed by the platform before the Worker sees it, so the pure rule's test has those.)
    for (const length of ["18446744073709551616", "-1", "1e3", "10, 10", "0x10"]) {
      expect(await answerOf(await get(w, "/", { method: "POST", headers: { ...JSON_HEADERS, "content-length": length } })), length).toEqual([400, CODE_OWN, "write_bad_length\n"]);
    }
  });

  it("stops counting a body at the first chunk over the cap, and never reads the rest", async () => {
    const w = codeWorld();
    let pulled = 0;
    const chunk = new Uint8Array(1024);
    // A body that never ends.
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(chunk); } });
    const answer = await handle(new Request(`${ORIGIN}/api/items`, { method: "POST", body, headers: JSON_HEADERS, duplex: "half" } as RequestInit), w.deps);
    expect([answer.status, await answer.text()]).toEqual([413, "write_too_large\n"]);
    // 64 chunks reach the cap and the 65th is over it; the stream may have queued one more ahead of the read.
    expect(pulled).toBeGreaterThanOrEqual(65);
    expect(pulled).toBeLessThanOrEqual(67);
  });

  it("refuses a write that isn't JSON, a method no host takes, a service worker and an upgrade, each by its code", async () => {
    const w = codeWorld();
    for (const method of WRITE_METHODS) {
      expect(await answerOf(await get(w, "/", { method, body: "{}", headers: { "content-type": "text/plain" } })), method).toEqual([415, CODE_OWN, "write_not_json\n"]);
      expect(await answerOf(await get(w, "/", { method })), `${method} with no type`).toEqual([415, CODE_OWN, "write_not_json\n"]);
      expect((await get(w, "/", { method, body: "{}", headers: { "content-type": "application/json; charset=latin1" } })).status, method).toBe(415);
    }
    // The platform upper-cases `post`, `put`, `delete` and the like before the Worker sees them, but never `patch`.
    for (const method of ["PROPFIND", "patch", "Patch"]) {
      expect(await answerOf(await get(w, "/", { method, headers: JSON_HEADERS })), method).toEqual([405, CODE_405, "method_not_allowed\n"]);
    }
    expect(await answerOf(await get(w, "/sw.js", { method: "POST", headers: { ...JSON_HEADERS, "service-worker": "script" } }))).toEqual([403, CODE_OWN, "no_service_workers\n"]);
    for (const method of ["GET", "POST"]) {
      expect(await answerOf(await get(w, "/ws", { method, headers: { ...JSON_HEADERS, upgrade: "websocket" } })), method).toEqual([403, CODE_OWN, "no_upgrade\n"]);
    }
    expect(w.sent).toEqual([]);
  });

  it("answers a preflight itself: refused by its code, readable by nobody; allowed, 204 with the fixed allowance for the origin null", async () => {
    const w = codeWorld();
    const preflight = (method: string | null, headers: string | null) => {
      const sent: Record<string, string> = { origin: "null" };
      if (method !== null) sent["access-control-request-method"] = method;
      if (headers !== null) sent["access-control-request-headers"] = headers;
      return get(w, "/api/items", { method: "OPTIONS", headers: sent });
    };
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      for (const headers of [null, "content-type", "Content-Type"]) {
        const allowed = { ...CODE_APP, "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE", "access-control-allow-headers": "content-type" };
        expect(await answerOf(await preflight(method, headers)), `${method} ${headers}`).toEqual([204, allowed, ""]);
      }
    }
    expect(await answerOf(await preflight(null, "content-type"))).toEqual([403, PREFLIGHT_OWN, "preflight_no_method\n"]);
    for (const method of ["OPTIONS", "TRACE", "patch", ""]) expect(await answerOf(await preflight(method, null)), JSON.stringify(method)).toEqual([403, PREFLIGHT_OWN, "preflight_method\n"]);
    for (const headers of ["authorization", "content-type, x-custom", "content-length"]) expect(await answerOf(await preflight("POST", headers)), headers).toEqual([403, PREFLIGHT_OWN, "preflight_header\n"]);
    expect([w.sent, w.asked, w.counted]).toEqual([[], [], []]);
    // With the switch off, an allowed preflight is refused as switched off, as before 2026-11-25.
    w.deps.codeApps = false;
    w.deps.stop.read = null;
    // (The switch off answers any method but GET and HEAD before anything is read, so this is the static `405`.)
    expect((await preflight("POST", "content-type")).status).toBe(405);
  });

  it("is refused as any host is before its kind is known, with the switch on: over plain HTTP, while stopped, and with no confirmed entry", async () => {
    const w = codeWorld();
    const write = { method: "POST", body: "{}", headers: JSON_HEADERS };
    expect(await answerOf(await handle(new Request(`http://${HOST}/`, write), w.deps))).toEqual([405, STATIC_405, "method_not_allowed\n"]);
    expect(w.reads).toEqual([]);
    expect((await handle(new Request(`http://${HOST}/`), w.deps)).status).toBe(301);
    w.kv.set(STOP_KEY, "stopped");
    expect(await answerOf(await get(w, "/", write))).toEqual([405, STATIC_405, "method_not_allowed\n"]);
    expect((await get(w)).status).toBe(404);
    expect(w.sent).toEqual([]);
  });

  it("logs nothing, whatever it refuses", async () => {
    const calls: unknown[] = [];
    for (const name of ["log", "info", "warn", "error", "debug", "trace"] as const) vi.spyOn(console, name).mockImplementation((...args) => { calls.push(args); });
    const w = codeWorld();
    await get(w);
    await get(w, "/", { method: "POST", body: bodyOf(MAX_WRITE_BODY_BYTES + 1), headers: JSON_HEADERS });
    await get(w, "/", { method: "POST", body: "{}", headers: JSON_HEADERS });
    await get(w, "/", { method: "PUT", body: "x" });
    await get(w, "/", { method: "OPTIONS", headers: { "access-control-request-method": "POST" } });
    await get(w, "/", { method: "OPTIONS", headers: { "access-control-request-method": "TRACE" } });
    expect(calls).toEqual([]);
  });
});

describe("a static host, under the same rules", () => {
  it("answers every write exactly as before, at the cap, one under and one over, with the switch off or on, and asks no app", async () => {
    for (const method of WRITE_METHODS) {
      for (const bytes of [MAX_WRITE_BODY_BYTES - 1, MAX_WRITE_BODY_BYTES, MAX_WRITE_BODY_BYTES + 1]) {
        for (const codeApps of [false, true]) {
        const w = world();
        w.deps.codeApps = codeApps;
        const answer = await get(w, "/api/items", { method, body: bodyOf(bytes), headers: { ...JSON_HEADERS, "content-length": String(bytes) } });
        expect(await answerOf(answer), `${method} ${bytes} ${codeApps}`).toEqual([405, STATIC_405, "method_not_allowed\n"]);
        expect([w.sent, w.counted]).toEqual([[], []]);
        if (!codeApps) expect(w.reads).toEqual([]);
        }
      }
    }
  });

  it("answers no preflight: OPTIONS is refused as before, whatever it asks, with the switch on", async () => {
    const w = world();
    w.deps.codeApps = true;
    for (const headers of [{ "access-control-request-method": "POST", "access-control-request-headers": "content-type" }, {}, { "access-control-request-method": "GET" }] as Record<string, string>[]) {
      expect(await answerOf(await get(w, "/", { method: "OPTIONS", headers })), JSON.stringify(headers)).toEqual([405, STATIC_405, "method_not_allowed\n"]);
    }
  });

  it("keeps today's answer with the switch on: a non-read method is refused the same on every path, and a service worker only on a read", async () => {
    const w = world();
    w.deps.codeApps = true;
    // Today's answer to a POST on a host that is no app's, over plain HTTP, while stopped, and with no entry.
    expect(await answerOf(await get(w, "/", { method: "POST" }, `deep.${HOST}`))).toEqual([405, { ...STATIC_405, "content-security-policy": sandboxPolicy("'none'") }, "method_not_allowed\n"]);
    // A custom hostname's the same, with its own origin and HSTS.
    expect(await answerOf(await get(w, "/", { method: "POST" }, "app.example.org"))).toEqual([405, { ...STATIC_405, "content-security-policy": sandboxPolicy("https://app.example.org"), "strict-transport-security": "max-age=31536000" }, "method_not_allowed\n"]);
    expect(await answerOf(await handle(new Request(`http://${HOST}/`, { method: "POST" }), w.deps))).toEqual([405, STATIC_405, "method_not_allowed\n"]);
    expect(await answerOf(await get(w, "/", { method: "POST" }, `other.${DOMAIN}`))).toEqual([405, { ...STATIC_405, "content-security-policy": sandboxPolicy(`https://other.${DOMAIN}`) }, "method_not_allowed\n"]);
    expect(await answerOf(await get(w, "/", { method: "POST", headers: { "service-worker": "script" } }))).toEqual([405, STATIC_405, "method_not_allowed\n"]);
    w.kv.set(STOP_KEY, "stopped");
    expect(await answerOf(await get(w, "/", { method: "POST" }))).toEqual([405, STATIC_405, "method_not_allowed\n"]);
    expect(w.sent).toEqual([]);
  });

  it("serves a read as before, with three headers and no body's, and an upgrade asked for goes as a plain read", async () => {
    const w = world();
    const answer = await get(w, "/", { headers: { accept: "text/html", "content-type": "application/json", "content-length": "0", upgrade: "websocket", connection: "upgrade" } });
    expect([answer.status, await answer.text()]).toEqual([200, "<h1>app</h1>"]);
    expect(Object.keys(Object.fromEntries(w.sent[0].request.headers.entries()))).toEqual(["accept"]);
    expect(FORWARDED_REQUEST_HEADERS).toBe(READ_HEADERS);
  });
});
