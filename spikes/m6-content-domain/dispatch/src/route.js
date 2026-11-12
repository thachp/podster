// Spike only. What the dispatch Worker does with a request, with no Cloudflare import, so node can test it.
//
// A host is <mode><label>.opster.dev, one level deep. The label picks the script spike-m6-c-<label>.
// The mode is a prefix, so one app can be compared with and without each header:
//   (none)  the app's answer as the namespace gave it
//   w-      service-worker scripts refused, and /__gone answers with Clear-Site-Data; no CSP, so storage works
//   h-      everything w- does, plus a sandboxing CSP, Set-Cookie stripped and the ADR's fixed headers
//
// Paths the dispatch Worker answers itself, in every mode:
//   /__gone         the not-found answer, with Clear-Site-Data
//   /__echo-cookie  the names of the cookies the request carried, never their values

export const ZONE = "opster.dev";
export const SCRIPT_PREFIX = "spike-m6-c-";
export const LABEL = /^[a-z0-9]{1,20}$/;

export const SANDBOX_CSP = [
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
  "default-src 'self' data: blob:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
].join("; ");

export const CLEAR_SITE_DATA = '"cache", "cookies", "storage"';

/** The host's mode and the script it maps to, or null when the host isn't one of ours. */
export function parseHost(hostname) {
  const host = hostname.toLowerCase();
  if (!host.endsWith(`.${ZONE}`)) return null;
  let label = host.slice(0, -(ZONE.length + 1));
  let mode = "raw";
  if (label.startsWith("h-")) [mode, label] = ["hardened", label.slice(2)];
  else if (label.startsWith("w-")) [mode, label] = ["workers", label.slice(2)];
  if (!LABEL.test(label)) return null;
  return { mode, label, script: SCRIPT_PREFIX + label };
}

/** Cookie names only, sorted, from a Cookie header. */
export function cookieNames(header) {
  if (!header) return [];
  return header
    .split(";")
    .map((part) => part.split("=")[0].trim())
    .filter(Boolean)
    .sort();
}

/** What to answer before the app is asked, or null to ask it. Returns { status, headers, body }. */
export function preflight(target, { method, pathname, serviceWorker, cookie }) {
  if (pathname === "/__echo-cookie") {
    return { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ names: cookieNames(cookie) }) };
  }
  if (pathname === "/__gone") {
    return { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "clear-site-data": CLEAR_SITE_DATA, "cache-control": "no-store" }, body: "not found\n" };
  }
  if (target.mode === "raw") return null;
  if (method !== "GET" && method !== "HEAD") return { status: 405, headers: { allow: "GET, HEAD" }, body: "method\n" };
  // A browser fetches a service worker's script, and its imports, with this header.
  if (serviceWorker === "script") return { status: 403, headers: { "content-type": "text/plain" }, body: "no service workers\n" };
  return null;
}

/** The headers the dispatch Worker sets on the app's answer, last, overriding the app. */
export function headerChanges(mode) {
  if (mode !== "hardened") return { remove: [], set: {} };
  return {
    remove: ["set-cookie"],
    set: {
      "content-security-policy": SANDBOX_CSP,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=60",
    },
  };
}
