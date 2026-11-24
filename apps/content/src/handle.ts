// The content Worker's whole behaviour (M6 step 4(b), ADR 0010's "Where content is served" and "What content can
// reach", and stage 1 of its proposed revision for the request rules). It routes and never authorizes: what a host
// serves was decided in Rust and written as a serve entry, and this reads it. Everything it can't confirm answers
// not-found, or for a method other than GET and HEAD, today's refusal of that method: it fails closed.
//
// For each request:
//   1. A GET or HEAD that carries a `Service-Worker` header is refused.
//   2. The host must be an app's default host, `<label>.<content domain>`, or a custom hostname: a host off the content
//      domain (step 8c). Any other name on the content domain, anything that isn't a host, and every host while no
//      content domain is configured, is not-found, and nothing is read for it.
//   3. A request that arrived over plain HTTP is sent to the same host and path over HTTPS, and nothing is read.
//   4. The stop for the whole domain: read at most once every 30 seconds for each running copy, and kept in memory
//      between. Set, or unreadable, and every host answers not-found.
//   5. The serve entry for the request's exact host: one read. Missing, unreadable, not a script's name, or a script
//      under another label than the host's: not-found. The API's applier enforces the label when it writes; this is
//      the second lock, and the public one. A custom hostname's entry is read only in its own form, which names that
//      very host (`customEntryScript`); the API writes it only while the room holds the name's live claim and
//      Cloudflare reports it `active`, and the hostname's object agrees.
//   6. The host's kind, static or with code, from the mark on its entry alone (`podster_core::serve_entry`, copied in
//      `names.ts`): an entry with code begins with the mark, and a static entry carries none and is read exactly as
//      before. The rules for each kind are `requests.ts`, the mirror of `podster_core::app_requests`. A static
//      host takes GET and HEAD only, as it always has. A host with code meets the rules for its kind, and then the
//      code-apps switch, which is off: nothing of an app with code is served. With it on, which only a test can do, a
//      read is still refused, and a write that passes every rule is counted against its app's write budget
//      (`counter.ts`, by the app's label) and then sent to the app with its body; over the budget, or with a budget
//      that can't be read, it is refused and the app never sees it.
//   7. The script that entry names, asked of the namespace, with a request built from nothing: three of the
//      visitor's headers and nothing else of the visitor's. For a static host, a script that isn't there and any other
//      rejection of the dispatch are both not-found: a cached entry can name a script a takedown just deleted.
//   8. The answer's headers are built from nothing: four of the app's pass, a same-host `Location` on a redirect, and
//      then this Worker's own fixed set, the sandbox among them.
//
// For any method but GET and HEAD, with the code-apps switch off, as it is: today's `405` right after step 3, before
// anything is read. (With it on, which only a test can do, every step before 6 that would refuse answers that `405`
// instead, and so does a static host.) A static host's answers are exactly what they were before.
//
// One thing is logged, and only for a dispatch that failed: its fixed class and the release's ID (`DispatchLog`).
// Nothing else of a request is ever logged: no message, host, label, path, header or body (ADR 0010's "Logs").
import { BUDGET_REFUSAL_STATUS, retryAfterSeconds } from "./budget";
import type { WriteGate } from "./counter";
import { customEntryKind, defaultEntryKind, defaultHostLabel, isHost, isWrittenHost, onDomain, scriptLabel, scriptRelease, STOP_KEY } from "./names";
import { allowedMethods, bodyWithinCap, CODE_ALLOW_ORIGIN, checkPreflight, checkRequest, forwardedHeaders, type HostKind, READ_HEADERS, REFUSAL_STATUS, type RequestClass } from "./requests";

/**
 * **The code-apps switch, off.** While it is off, nothing of an app whose release carries code is served: a host with
 * code meets the request rules for its kind, and then this Worker's own refusal. It is a constant of type `false`,
 * read from no binding, variable or setting, so no configuration can turn it on; the package's configuration test
 * holds it so.
 * Turning it on is a change to this file's type, and the line in `codeHost` that pins it to `false` fails to compile
 * until serving an app with code is built there.
 */
export const CODE_APPS_ENABLED: false = false;

/** How long a read of a serve entry or of the stop may be cached where it was read: the shortest a read may ask for. */
export const KV_CACHE_SECONDS = 30;
/** How long one running copy keeps what it last read of the stop. */
export const STOP_KEPT_MS = 30_000;

/** The serve entries' namespace, as much of it as is used: one read of one key. */
export interface Entries {
  get(key: string, options: { cacheTtl: number }): Promise<string | null>;
}
/** The dispatch namespace, as much of it as is used. */
export interface Apps {
  get(name: string): { fetch(request: Request): Promise<Response> };
}
/**
 * The one line this Worker logs: a dispatch that failed. Its fixed class, and the release's ID from the script's name
 * (null if the name isn't a script's, which a confirmed entry never is). Never the rejection's message, the host, the
 * label, the path, a header or a body. It is the signal of a platform outage, which a static host answers as
 * not-found and so can't show by its status.
 */
export type DispatchLog = { event: "dispatch_missing" | "dispatch_error"; release: string | null };

/** What one running copy remembers of the stop. Only a read that answered is remembered. */
export interface StopMemory {
  read: { at: number; stopped: boolean } | null;
}
export interface Deps {
  entries: Entries;
  apps: Apps;
  /** The time now, in milliseconds. Passed in, so no test waits. */
  now: () => number;
  stop: StopMemory;
  /** The content domain, from configuration. Not a host, and every request is not-found. */
  domain: string;
  /**
   * The code-apps switch, as this request sees it. The Worker's entry passes `CODE_APPS_ENABLED`, which is of type
   * `false`; only a test passes anything else. While it is off, any method but GET and HEAD gets today's `405` before
   * anything is read, so no host's kind is learned for it, and no rule for hosts with code applies to it.
   */
  codeApps: boolean;
  /**
   * The write counter: asked once for each write to a host with code that passes every rule here, right before the
   * write is sent to the app, and never for anything else. With the switch off it is never asked.
   */
  writes: WriteGate;
  /** Where a failed dispatch's line goes. The Worker's entry writes it to the Worker's log; a test keeps it. */
  log: (line: DispatchLog) => void;
}

/** The visitor's headers that go through to an app with a read. Each calls only for answer headers let through below. */
export const FORWARDED_REQUEST_HEADERS = READ_HEADERS;
/** The app's headers that go through to the visitor. `Location` is handled apart, on a redirect only. */
export const PASSED_RESPONSE_HEADERS = ["content-type", "content-length", "etag", "last-modified"] as const;
/**
 * Headers that say the body isn't the plain file. No request header that calls for one is sent, so an app's answer
 * that carries one is not served: passing the body without the header would hand the visitor bytes it can't read.
 */
const UNSERVABLE_RESPONSE_HEADERS = ["content-encoding", "content-range"] as const;
const REDIRECTS = [301, 302, 303, 307, 308];

/**
 * The sandbox, for a page on `origin` (decision 216). One policy, stated here once.
 *
 * `sandbox` with scripts allowed and nothing else: the page's origin is opaque, so it has no cookies and no storage,
 * and can't read another room's. The sources name the host itself, never the keyword for "this origin", which
 * matches nothing in a sandboxed page (spike C). No other word is ever added to the `sandbox` directive here: any
 * such word is a change to decision 216's stance and is the owner's, and the one that would give the page its real
 * origin back is forbidden for good, by a test.
 */
export function sandboxPolicy(origin: string): string {
  return [
    "sandbox allow-scripts",
    `default-src ${origin}`,
    `script-src ${origin}`,
    `style-src ${origin} 'unsafe-inline'`,
    `img-src ${origin} data:`,
    `connect-src ${origin}`,
    "frame-ancestors 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * Who may read an answer, as `Access-Control-Allow-Origin`: any page, for a static host's files, as a sandboxed page
 * needs to load its own (spike C); the origin `null` only, for a host with code; and nobody, for a refused preflight,
 * so the browser sends nothing further.
 */
type ReadableBy = "*" | typeof CODE_ALLOW_ORIGIN | null;

/**
 * The host an answer is for: its origin, which the sandbox names, and whether it is a custom hostname.
 */
type Site = { origin: string; custom: boolean };

/**
 * `Strict-Transport-Security`, for a year. On the content domain, which is Podster's own, it covers every name under the
 * host too. **A custom hostname is a customer's name** (step 8c, Proposed): no `includeSubDomains`, which on an apex name
 * would pin every other name of the customer's to HTTPS for a year, and no `preload`.
 */
export function hstsFor(custom: boolean): string {
  return custom ? "max-age=31536000" : "max-age=31536000; includeSubDomains";
}

/** The headers this Worker sets on every answer, an app's and its own. `own` answers are never kept by a browser. */
function fixedHeaders(headers: Headers, site: Site, own: boolean, readableBy: ReadableBy = "*"): Headers {
  const origin = site.origin;
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("strict-transport-security", hstsFor(site.custom));
  headers.set("cache-control", own ? "no-store" : "max-age=60, no-transform");
  // A sandboxed page is cross-origin to its own host, so its own files need this to load (spike C).
  if (readableBy !== null) headers.set("access-control-allow-origin", readableBy);
  headers.set("content-security-policy", sandboxPolicy(origin));
  return headers;
}

function own(request: Request, site: Site, status: number, code: string, extra: Record<string, string> = {}, readableBy: ReadableBy = "*"): Response {
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8", ...extra });
  fixedHeaders(headers, site, true, readableBy);
  return new Response(request.method === "HEAD" ? null : `${code}\n`, { status, headers });
}

/**
 * Not-found: no entry, the stop, or anything that couldn't be confirmed. It asks the browser to drop what it cached
 * for this host, as a best effort and never a control (ADR 0010's "Unpublishing"). Only the cache: under the sandbox
 * an app has no cookies or storage to clear, and the cookies directive is the one under which a browser cleared a
 * sibling host's cookies in spike C.
 */
const notFound = (request: Request, site: Site) => own(request, site, 404, "not_found", { "clear-site-data": '"cache"' });

/** Whether the domain is stopped. Unreadable counts as stopped, and isn't remembered. */
async function stopped(deps: Deps): Promise<boolean> {
  const now = deps.now();
  const kept = deps.stop.read;
  if (kept && now - kept.at >= 0 && now - kept.at < STOP_KEPT_MS) return kept.stopped;
  try {
    // The key's presence is the stop. Whatever it holds, it is there.
    const isSet = (await deps.entries.get(STOP_KEY, { cacheTtl: KV_CACHE_SECONDS })) !== null;
    deps.stop.read = { at: now, stopped: isSet };
    return isSet;
  } catch {
    deps.stop.read = null;
    return true;
  }
}

/** A redirect's target, as a path on the same host, or null: an absolute path, or this origin followed by one. */
function sameHostPath(location: string, origin: string): string | null {
  // No control character, space or backslash: browsers read some of those as part of a scheme or a host.
  if (/[\u0000- \\\u007f]/.test(location)) return null;
  const path = location.startsWith(`${origin}/`) ? location.slice(origin.length) : location;
  return path.startsWith("/") && !path.startsWith("//") ? path : null;
}

/**
 * The request the app is sent, built from nothing: the URL, the method, the visitor's headers for its class, and for a
 * write the body as this Worker read it. The visitor's request object is never passed on or copied, so nothing else
 * of it can reach an app: no other header, and none of its settings. A write's `Content-Length` is the body's own,
 * set by the runtime from the bytes, never the visitor's claim, which could understate them.
 */
function requestForApp(request: Request, url: URL, cls: RequestClass, body: Uint8Array<ArrayBuffer> | null = null): Request {
  const headers = new Headers();
  for (const name of forwardedHeaders(cls)) {
    if (name === "content-length") continue;
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Request(url.toString(), { method: request.method, headers, redirect: "manual", body });
}

/**
 * The app's answer, from the dispatch namespace: the one place an app is asked. Asking the namespace for a script that
 * isn't there returns without error; the fetch is what rejects, with exactly this message (spikes A and C). Any other
 * rejection is an error, and nothing is served for it.
 *
 * **A static host answers both as not-found** (fix of 2026-11-24). A takedown removes the serve entry first and then
 * deletes the script, but this Worker reads the entry with an edge cache (`KV_CACHE_SECONDS`, and up to 60 seconds by
 * KV's documentation), so for some seconds a cached entry can still name a script that is deleted or being deleted.
 * Staging saw that window answer `502 app_error` for 3 to 14 seconds after a suspension and after an unpublish
 * (M6-R14, 2026-11-23 and 2026-11-24): the rejection's message there was, by inference, something other than this
 * one; no spike recorded it and nothing logged it. A static release's script has no code of the app's to throw, so any rejection
 * is the platform's, and a script that can't be reached is one this Worker can't confirm: not-found, as everything
 * else it can't confirm. Nothing is served either way. A host with code keeps the split, since there a rejection can
 * be the app's own exception.
 *
 * **Every failure is logged, for both kinds of host,** as one `DispatchLog`: so an outage of the namespace, which every
 * static host now answers as not-found, still shows. The line carries the class and the release's ID and nothing else;
 * the rejection's message is never logged, since it may hold anything. A log that fails changes no answer.
 */
async function dispatch(deps: Deps, script: string, request: Request): Promise<Response | "missing" | "error"> {
  try {
    return await deps.apps.get(script).fetch(request);
  } catch (error) {
    const missing = error instanceof Error && error.message === "Worker not found.";
    try {
      deps.log({ event: missing ? "dispatch_missing" : "dispatch_error", release: scriptRelease(script) });
    } catch {
      // Nothing: the answer is the same with or without the line.
    }
    return missing ? "missing" : "error";
  }
}

/** Whether a method is one a static host takes: the only ones any host has ever been served for. */
const isRead = (method: string) => method === "GET" || method === "HEAD";

/**
 * A write's body, read up to the cap and no further: its bytes, or null at the first chunk over the cap. A body that
 * came with a `Content-Length` is counted too, so a length that understates it changes nothing.
 */
async function bodyWithin(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let counted = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      counted += value.byteLength;
      if (!bodyWithinCap(counted)) return null;
      chunks.push(value);
    }
  } finally {
    // Whatever is left is never read: a body over the cap is not taken in.
    reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(counted);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/**
 * A request to a host whose release carries code. The rules for its kind come first, each refusal with its own code
 * and status, so a page can tell what it got wrong. A read or a preflight that passes them is still refused, because
 * the switch is off and serving an app with code isn't built.
 *
 * A write that passes them, which only a test can send here while the switch is off, is counted against its app's
 * write budget and then sent to the app, in that order: **the counter is asked before the app is**, so a write over
 * the budget never reaches the app, and a write the app then fails still counts (the plan's S6). A write this Worker
 * refuses itself, before the count, isn't counted. The count is the app's, by its label, the same across its releases
 * and its hosts. Over the budget, `429` with when to come back; a budget that can't be read, `503`.
 *
 * Every answer here is never kept and is readable by the origin `null` only, an app's answer to a write included,
 * except a preflight's, which is readable by nobody, so the browser sends nothing further.
 */
async function codeHost(request: Request, url: URL, site: Site, script: string, deps: Deps): Promise<Response> {
  const asCode = (status: number, code: string, extra: Record<string, string> = {}) => own(request, site, status, code, extra, CODE_ALLOW_ORIGIN);
  const checked = checkRequest("code", {
    method: request.method,
    contentType: request.headers.get("content-type"),
    contentLength: request.headers.get("content-length"),
    serviceWorker: request.headers.has("service-worker"),
    upgrade: request.headers.has("upgrade"),
  });
  if (!checked.ok) {
    const allow = checked.refusal === "method_not_allowed" ? { allow: allowedMethods("code").join(", ") } : undefined;
    return asCode(REFUSAL_STATUS[checked.refusal], checked.refusal, allow);
  }
  if (checked.value === "preflight") {
    const preflight = checkPreflight("code", request.headers.get("access-control-request-method"), request.headers.get("access-control-request-headers"));
    if (!preflight.ok) return own(request, site, 403, preflight.refusal, {}, null);
    return own(request, site, 503, "code_apps_off", {}, null);
  }
  if (checked.value === "write") {
    const body = await bodyWithin(request);
    if (body === null) return asCode(REFUSAL_STATUS.write_too_large, "write_too_large");
    // Counted first. The label is the script's, which a confirmed entry always has.
    const label = scriptLabel(script);
    const budget = label === null ? null : await deps.writes.admit(label);
    if (budget === null || !budget.ok) {
      const refusal = budget === null ? ({ code: "write_budget_unknown" } as const) : budget.refusal;
      // The wait is readable by the page, so it can tell its visitor when to try again.
      const wait: Record<string, string> = refusal.code === "write_budget_spent" ? { "retry-after": String(retryAfterSeconds(refusal.retryAfterMs)), "access-control-expose-headers": "retry-after" } : {};
      return asCode(BUDGET_REFUSAL_STATUS[refusal.code], refusal.code, wait);
    }
    // Then sent on.
    const answer = await dispatch(deps, script, requestForApp(request, url, "write", body));
    if (answer === "missing") return asCode(404, "not_found", { "clear-site-data": '"cache"' });
    if (answer === "error") return asCode(502, "app_error");
    // A write's answer is the app's, but never a redirect, a part, or a body that isn't the plain bytes.
    if (answer.status < 200 || answer.status === 206 || (answer.status >= 300 && answer.status < 400) || UNSERVABLE_RESPONSE_HEADERS.some((name) => answer.headers.has(name))) return asCode(502, "app_answer_unservable");
    // A status that can't carry a body gets none, and no length for the body that was dropped.
    const bodiless = [204, 205].includes(answer.status);
    const headers = new Headers();
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = answer.headers.get(name);
      if (value !== null && !(bodiless && name === "content-length")) headers.set(name, value);
    }
    fixedHeaders(headers, site, true, CODE_ALLOW_ORIGIN);
    return new Response(bodiless ? null : answer.body, { status: answer.status, headers });
  }
  // A read. Serving one is not built: the switch is pinned to `false` by type here, so turning it on fails to compile
  // until this line is replaced by the code that serves an app with code.
  const off: false = CODE_APPS_ENABLED;
  void off;
  return asCode(503, "code_apps_off");
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname;
  const label = defaultHostLabel(host, deps.domain);
  // A custom hostname (step 8c): a host off the content domain, only while a content domain is configured, since
  // without one no host can be told from another.
  const custom = label === null && isHost(deps.domain) && isWrittenHost(host) && !onDomain(host, deps.domain);
  // The sandbox names the host, so a host that is no app's is named as nothing a page could be served from.
  const origin = label === null && !custom ? "'none'" : `https://${host}`;
  const site: Site = { origin, custom };
  // Learned once the entry is confirmed, so an error after it is answered as that kind of host's own.
  let kind: HostKind | null = null;
  try {
    const read = isRead(request.method);
    // Any other method is refused as it always was, unless the host is confirmed to have code: so a static host, and
    // anything that isn't confirmed, gets exactly today's answer.
    const methodRefused = () => own(request, site, 405, "method_not_allowed", { allow: allowedMethods("static").join(", ") });
    const unconfirmed = () => (read ? notFound(request, site) : methodRefused());
    // A browser fetches a service worker's script, and what it imports, with this header, and with no other request.
    // Under the sandbox a page can't register one at all, so nothing an app needs carries it: any request that has
    // the header is refused, whatever it holds. Refusing the script is what keeps an app from running on in a
    // browser after it is taken down, and it holds even if the sandbox were ever loosened.
    if (read && request.headers.has("service-worker")) return own(request, site, 403, "no_service_workers");
    if (label === null && !custom) return unconfirmed();
    // An app is never served over plain HTTP, and this doesn't rest on the zone's own redirect. The scheme is read
    // from the request's URL, which is what Cloudflare's edge received and no header of the visitor's can change.
    // `X-Forwarded-Proto` isn't read: a header is the visitor's to send, and that Cloudflare overwrites it is its
    // documented behaviour toward an origin, which isn't shown here for a Worker.
    if (url.protocol !== "https:") return read ? own(request, site, 301, "moved_to_https", { location: `${origin}${url.pathname}${url.search}` }) : methodRefused();
    // With the switch off, no other method is looked at further: today's answer, and nothing read.
    if (!read && !deps.codeApps) return methodRefused();
    if (await stopped(deps)) return unconfirmed();

    let value: string | null;
    try {
      value = await deps.entries.get(host, { cacheTtl: KV_CACHE_SECONDS });
    } catch {
      return unconfirmed();
    }
    // A default host: only a script's name, and only one under this host's own label, so a host never serves another
    // app's script. A custom hostname: only its own form, naming this very host. Either may begin with the mark that
    // its script has code, which is the host's kind; anything else that looks like a mark is no entry.
    const entry = value === null ? null : custom ? customEntryKind(host, value) : defaultEntryKind(value);
    if (entry === null || (!custom && scriptLabel(entry.script) !== label)) return unconfirmed();
    const script = entry.script;

    kind = entry.kind;
    if (kind === "code") return await codeHost(request, url, site, script, deps);
    // A static host: GET and HEAD, as always (`podster_core::app_requests`' rule for a static host).
    if (!read) return methodRefused();

    const answer = await dispatch(deps, script, requestForApp(request, url, "read"));
    // A static release's script runs no code of the app's, so a rejection can only be the platform's own, and it
    // can't be told from a script that is gone: not-found, whatever its message. See `dispatch`.
    if (answer === "missing" || answer === "error") return notFound(request, site);
    const headers = new Headers();
    if (answer.status < 200 || answer.status === 206 || UNSERVABLE_RESPONSE_HEADERS.some((name) => answer.headers.has(name))) return own(request, site, 502, "app_answer_unservable");
    if (answer.status >= 300 && answer.status < 400 && answer.status !== 304) {
      const path = REDIRECTS.includes(answer.status) ? sameHostPath(answer.headers.get("location") ?? "", origin) : null;
      // A redirect anywhere but a path on this host is never passed on.
      if (path === null) return notFound(request, site);
      headers.set("location", path);
    }
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = answer.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    fixedHeaders(headers, site, false);
    // A status that can't carry a body gets none, whatever the app sent.
    const bodiless = request.method === "HEAD" || [204, 205, 304].includes(answer.status);
    return new Response(bodiless ? null : answer.body, { status: answer.status, headers });
  } catch {
    // Nothing above is expected to throw. If it does, the visitor still gets this Worker's own answer and headers.
    return own(request, site, 502, "error", {}, kind === "code" ? CODE_ALLOW_ORIGIN : "*");
  }
}
