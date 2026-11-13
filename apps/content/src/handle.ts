// The content Worker's whole behaviour (M6 step 4(b), ADR 0010's "Where content is served" and "What content can
// reach"). It routes and never authorizes: what a host serves was decided in Rust and written as a serve entry, and
// this reads it. Everything it can't confirm answers not-found: it fails closed.
//
// For each request:
//   1. Anything but GET and HEAD is refused, and so is any request that carries a `Service-Worker` header.
//   2. The host must be an app's default host, `<label>.<content domain>`. Anything else is not-found, and nothing is
//      read for it. Custom hostnames arrive with custom domains (step 8), with their own entry form.
//   3. A request that arrived over plain HTTP is sent to the same host and path over HTTPS, and nothing is read.
//   4. The stop for the whole domain: read at most once every 30 seconds for each running copy, and kept in memory
//      between. Set, or unreadable, and every host answers not-found.
//   5. The serve entry for the request's exact host: one read. Missing, unreadable, not a script's name, or a script
//      under another label than the host's: not-found. The API's applier enforces the label when it writes; this is
//      the second lock, and the public one.
//   6. The script that entry names, asked of the namespace, with a request built from nothing: three of the
//      visitor's headers and nothing else of the visitor's.
//   7. The answer's headers are built from nothing: four of the app's pass, a same-host `Location` on a redirect, and
//      then this Worker's own fixed set, the sandbox among them.
//
// Nothing is logged for a request (ADR 0010's "Logs").
import { defaultHostLabel, scriptLabel, STOP_KEY } from "./names";

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
}

/** The visitor's headers that go through to an app. Each calls only for answer headers that are let through below. */
export const FORWARDED_REQUEST_HEADERS = ["accept", "if-none-match", "if-modified-since"] as const;
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

/** The headers this Worker sets on every answer, an app's and its own. `own` answers are never kept by a browser. */
function fixedHeaders(headers: Headers, origin: string, own: boolean): Headers {
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  headers.set("cache-control", own ? "no-store" : "max-age=60, no-transform");
  // A sandboxed page is cross-origin to its own host, so its own files need this to load (spike C).
  headers.set("access-control-allow-origin", "*");
  headers.set("content-security-policy", sandboxPolicy(origin));
  return headers;
}

function own(request: Request, origin: string, status: number, code: string, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8", ...extra });
  fixedHeaders(headers, origin, true);
  return new Response(request.method === "HEAD" ? null : `${code}\n`, { status, headers });
}

/**
 * Not-found: no entry, the stop, or anything that couldn't be confirmed. It asks the browser to drop what it cached
 * for this host, as a best effort and never a control (ADR 0010's "Unpublishing"). Only the cache: under the sandbox
 * an app has no cookies or storage to clear, and the cookies directive is the one under which a browser cleared a
 * sibling host's cookies in spike C.
 */
const notFound = (request: Request, origin: string) => own(request, origin, 404, "not_found", { "clear-site-data": '"cache"' });

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
 * The request the app is sent, built from nothing: the URL, the method, and three of the visitor's headers. The
 * visitor's request object is never passed on or copied, so nothing else of it can reach an app: no other header, no
 * body, and none of its settings.
 */
function requestForApp(request: Request, url: URL): Request {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Request(url.toString(), { method: request.method, headers, redirect: "manual" });
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname;
  const label = defaultHostLabel(host, deps.domain);
  // The sandbox names the host, so a host that is no app's is named as nothing a page could be served from.
  const origin = label === null ? "'none'" : `https://${host}`;
  try {
    if (request.method !== "GET" && request.method !== "HEAD") return own(request, origin, 405, "method_not_allowed", { allow: "GET, HEAD" });
    // A browser fetches a service worker's script, and what it imports, with this header, and with no other request.
    // Under the sandbox a page can't register one at all, so nothing an app needs carries it: any request that has
    // the header is refused, whatever it holds. Refusing the script is what keeps an app from running on in a
    // browser after it is taken down, and it holds even if the sandbox were ever loosened.
    if (request.headers.has("service-worker")) return own(request, origin, 403, "no_service_workers");
    if (label === null) return notFound(request, origin);
    // An app is never served over plain HTTP, and this doesn't rest on the zone's own redirect. The scheme is read
    // from the request's URL, which is what Cloudflare's edge received and no header of the visitor's can change.
    // `X-Forwarded-Proto` isn't read: a header is the visitor's to send, and that Cloudflare overwrites it is its
    // documented behaviour toward an origin, which isn't shown here for a Worker.
    if (url.protocol !== "https:") return own(request, origin, 301, "moved_to_https", { location: `${origin}${url.pathname}${url.search}` });
    if (await stopped(deps)) return notFound(request, origin);

    let script: string | null;
    try {
      script = await deps.entries.get(host, { cacheTtl: KV_CACHE_SECONDS });
    } catch {
      return notFound(request, origin);
    }
    // Only a script's name, and only one under this host's own label: a host never serves another app's script.
    if (script === null || scriptLabel(script) !== label) return notFound(request, origin);

    let answer: Response;
    try {
      // Asking the namespace for a script that isn't there returns without error; the fetch is what rejects, with
      // exactly this message (spikes A and C). Any other rejection is an error, and nothing is served for it.
      answer = await deps.apps.get(script).fetch(requestForApp(request, url));
    } catch (error) {
      if (error instanceof Error && error.message === "Worker not found.") return notFound(request, origin);
      return own(request, origin, 502, "app_error");
    }

    const headers = new Headers();
    if (answer.status < 200 || answer.status === 206 || UNSERVABLE_RESPONSE_HEADERS.some((name) => answer.headers.has(name))) return own(request, origin, 502, "app_answer_unservable");
    if (answer.status >= 300 && answer.status < 400 && answer.status !== 304) {
      const path = REDIRECTS.includes(answer.status) ? sameHostPath(answer.headers.get("location") ?? "", origin) : null;
      // A redirect anywhere but a path on this host is never passed on.
      if (path === null) return notFound(request, origin);
      headers.set("location", path);
    }
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = answer.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    fixedHeaders(headers, origin, false);
    // A status that can't carry a body gets none, whatever the app sent.
    const bodiless = request.method === "HEAD" || [204, 205, 304].includes(answer.status);
    return new Response(bodiless ? null : answer.body, { status: answer.status, headers });
  } catch {
    // Nothing above is expected to throw. If it does, the visitor still gets this Worker's own answer and headers.
    return own(request, origin, 502, "error");
  }
}
