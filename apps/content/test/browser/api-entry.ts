// **The API spike's entry, and nothing else's** (`e2e/content-sandbox-api.mjs`). A local run, on one machine, to see
// whether a page under the content Worker's sandbox can call an API on its own host at all, and what any other page
// can then do to that API. It answers a question for ADR 0010's proposed revision; it builds nothing.
//
// **The API here is this file's own, and is not the content Worker's.** `src/handle.ts` takes `GET` and `HEAD` only
// and has no API; nothing in `src/` changes for this and nothing in `src/` imports this. The run names this file on
// `wrangler dev`'s command line, with the browser run's configuration, which stays the only test configuration.
//
// - A page on an app's host is served by the content Worker's **real handler,** so it carries the real policy.
// - A request under `/api/` on an app's host is answered **here,** by a small list kept in memory, in one of five
//   ways a server could answer a browser's cross-origin rules, named by the path's second part.
// - Two pages on another domain are served here with no policy of Podster's: one ordinary, one sandboxed by its own
//   header. They are what "any other page" means.
//
// Every request the API receives is written to a log the run reads: the method, what the `Origin` header said, the
// body's type, whether a cookie came with it, whether it was a preflight, and whether the answer set a cookie.
//
// **The API sets a cookie on every answer that isn't a preflight's,** one a browser would send back from any site if
// it kept it. So "no request carried a cookie" is a statement about the browser and not about a server that never
// offered one: on its own origin, in the control, the browser keeps it and sends it.
import { handle, type StopMemory } from "../../src/handle";

/** A domain under `.example`, which nobody can hold. The apps' hosts are under it. */
const DOMAIN = "sandbox-test.example";
/** Another domain, for pages that are nothing to do with the apps. */
const ELSEWHERE = "elsewhere-test.example";
const ENTRIES: Record<string, string> = {
  [`appa.${DOMAIN}`]: `appa.rel_${"a".repeat(32)}`,
  [`appb.${DOMAIN}`]: `appb.rel_${"b".repeat(32)}`,
};
/** The header the run puts the browser's address in. Only the run sends it. */
const ASKED = "x-content-browser-run-url";
/** The one app that has an API. Every page, on whatever host, calls this one. */
const API = `https://appa.${DOMAIN}`;

/**
 * How the API answers a browser's cross-origin rules, by the path's second part:
 * - `none`: no `Access-Control-` header at all, and no answer to a preflight.
 * - `star`: every answer allows any origin, and a preflight is answered.
 * - `null`: every answer allows the origin `null`, and a preflight is answered.
 * - `star-nopre`, `null-nopre`: the same on answers, and no answer to a preflight.
 */
export const MODES = ["none", "star", "null", "star-nopre", "null-nopre"] as const;
type Mode = (typeof MODES)[number];
const allowOrigin = (mode: Mode): string | null => (mode === "none" ? null : mode.startsWith("star") ? "*" : "null");
const answersPreflight = (mode: Mode) => mode === "star" || mode === "null";

type Seen = { mode: string; method: string; origin: string | null; contentType: string | null; cookie: boolean; preflight: boolean; setCookie: boolean };
/** The cookie the API offers: for its own host, sent from any site, over TLS. */
const COOKIE = "api-probe=1; Path=/; Secure; SameSite=None";
const log: Seen[] = [];
const lists = new Map<string, string[]>();

async function api(request: Request, url: URL): Promise<Response> {
  const mode = url.pathname.split("/")[2] as Mode;
  if (!MODES.includes(mode)) return new Response("no such way of answering\n", { status: 404 });
  const preflight = request.method === "OPTIONS" && request.headers.has("access-control-request-method");
  log.push({ mode, method: request.method, origin: request.headers.get("origin"), contentType: request.headers.get("content-type"), cookie: request.headers.has("cookie"), preflight, setCookie: request.method !== "OPTIONS" });
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  const allow = allowOrigin(mode);
  if (allow !== null) headers.set("access-control-allow-origin", allow);
  if (request.method === "OPTIONS") {
    if (!answersPreflight(mode)) return new Response(null, { status: 405 });
    headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE");
    headers.set("access-control-allow-headers", "content-type");
    headers.delete("content-type");
    return new Response(null, { status: 204, headers });
  }
  headers.set("set-cookie", COOKIE);
  const list = lists.get(mode) ?? [];
  lists.set(mode, list);
  // A body is taken as JSON `{ "text": … }` when it parses as that, and otherwise as the text itself.
  const body = request.method === "GET" ? "" : await request.text();
  const text = (() => { try { const parsed = JSON.parse(body) as { text?: unknown }; return typeof parsed.text === "string" ? parsed.text : body; } catch { return body; } })();
  if (request.method === "POST") list.push(text);
  else if (request.method === "PUT") list.splice(0, list.length, text);
  else if (request.method === "DELETE") list.splice(0, list.length);
  else if (request.method !== "GET") return new Response(JSON.stringify({ error: "method" }), { status: 405, headers });
  return new Response(JSON.stringify({ items: list }), { headers });
}

/** What every page runs: each call to the API, in each way of answering, and what came back, written into the page. */
const PROBE = `const API = ${JSON.stringify(API)};
const MODES = ${JSON.stringify(MODES)};
const who = document.documentElement.dataset.who;
const violations = [];
document.addEventListener("securitypolicyviolation", (event) => violations.push(event.effectiveDirective + " " + (event.blockedURI || "inline")));
const call = async (run) => {
  try { const answer = await run(); return { ok: true, status: answer.status, items: (await answer.json()).items }; }
  catch (error) { return { ok: false, error: (error && error.name) || String(error) }; }
};
const json = (method, text) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
const results = { who, origin: self.origin, calls: {} };
for (const mode of MODES) {
  const at = API + "/api/" + mode + "/items";
  const calls = {};
  calls.get = await call(() => fetch(at));
  calls.postJson = await call(() => fetch(at, json("POST", who + " posted json")));
  calls.putJson = await call(() => fetch(at, json("PUT", who + " put json")));
  // A body with no type of its own goes as text/plain, which a browser sends with no preflight.
  calls.postText = await call(() => fetch(at, { method: "POST", body: who + " posted text" }));
  calls.getAfter = await call(() => fetch(at));
  calls.deleteJson = await call(() => fetch(at, json("DELETE", "")));
  results.calls[mode] = calls;
}
results.violations = violations;
const out = document.getElementById("results");
out.textContent = JSON.stringify(results);
out.dataset.done = "1";
`;
const page = (who: string) => `<!doctype html>
<html data-who="${who}">
<head><meta charset="utf-8"><title>api probe</title><script type="module" src="/probe.js"></script></head>
<body><pre id="results" data-done="0">pending</pre></body>
</html>
`;
const HTML = "text/html; charset=utf-8";
const SCRIPT = "text/javascript; charset=utf-8";

/** One app's files, as a release's static files would answer. */
function serve(script: string, request: Request): Response {
  const label = script.split(".")[0];
  if (!Object.values(ENTRIES).includes(script)) throw new Error("Worker not found.");
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response(page(label === "appa" ? "the app's own page" : "a sibling app's page"), { headers: { "content-type": HTML } });
  if (path === "/probe.js") return new Response(PROBE, { headers: { "content-type": SCRIPT } });
  return new Response("no such file\n", { status: 404 });
}

/** The two pages that are nothing to do with the apps, served with none of Podster's headers. */
function elsewhere(url: URL): Response {
  const boxed = url.hostname === `boxed.${ELSEWHERE}`;
  if (!boxed && url.hostname !== `plain.${ELSEWHERE}`) return new Response("no such host\n", { status: 404 });
  const headers = new Headers({ "cache-control": "no-store" });
  // Sandboxed by a header of its own, with nothing about where it may connect: its origin is `null` too.
  if (boxed) headers.set("content-security-policy", "sandbox allow-scripts");
  if (url.pathname === "/") { headers.set("content-type", HTML); return new Response(page(boxed ? "a sandboxed page elsewhere" : "an ordinary page elsewhere"), { headers }); }
  if (url.pathname === "/probe.js") { headers.set("content-type", SCRIPT); if (boxed) headers.set("access-control-allow-origin", "*"); return new Response(PROBE, { headers }); }
  return new Response("no such file\n", { status: 404, headers });
}

const stop: StopMemory = { read: null };

export default {
  async fetch(request: Request, env: { BROWSER_RUN_ID?: unknown }): Promise<Response> {
    const asked = request.headers.get(ASKED);
    // Asked with no address: which run started it, and, for the run alone, the API's log and lists.
    if (asked === null) {
      const run = typeof env.BROWSER_RUN_ID === "string" ? env.BROWSER_RUN_ID : "";
      const path = new URL(request.url).pathname;
      const headers = { "x-content-browser-run-id": run, "content-type": "application/json" };
      if (path === "/__log") return new Response(JSON.stringify({ log, lists: Object.fromEntries(lists) }), { headers });
      if (path === "/__reset") { log.length = 0; lists.clear(); return new Response("{}", { headers }); }
      return new Response("the content Worker's API spike: not a deployment\n", { status: 400, headers });
    }
    const url = new URL(asked);
    const headers = new Headers(request.headers);
    headers.delete(ASKED);
    if (url.hostname.endsWith(`.${ELSEWHERE}`)) return elsewhere(url);
    if (url.hostname === new URL(API).hostname && url.pathname.startsWith("/api/")) {
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      return api(new Request(asked, { method: request.method, headers, body: hasBody ? await request.arrayBuffer() : undefined }), url);
    }
    // Everything else on an app's host: the content Worker's real handler, and so its real policy.
    return handle(new Request(asked, { method: request.method, headers }), {
      entries: { get: async (key) => ENTRIES[key] ?? null },
      apps: { get: (script) => ({ fetch: async (toApp) => serve(script, toApp) }) },
      now: () => Date.now(),
      stop,
      domain: DOMAIN,
    });
  },
} satisfies ExportedHandler<{ BROWSER_RUN_ID?: unknown }>;
