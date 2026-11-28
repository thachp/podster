// Spike P1 only. The gate's pure pieces, as the M8 preview plan (section 5.3 and 5.4) describes them, so the browser
// run can drive a working stand-in of the flow. Nothing builds on this file: the real gate is M8 step 8.
//
// The ticket and session here are HMAC-SHA256 with a key made for one run, not the plan's Ed25519. Which signature is
// used isn't a browser fact, and nothing in this spike depends on it.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION = "__Host-podster_preview";
export const STATE = "__Host-podster_preview_state";
export const TICKET_SECONDS = 60;
export const SESSION_SECONDS = 3600;

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");

/** The state hash the plan's `st` carries: SHA-256 of the state cookie's value, base64url. */
export const stateHash = (state) => b64(createHash("sha256").update(state).digest());

/** A new random 32-byte state, base64url. */
export const newState = () => b64(randomBytes(32));

/**
 * A `Cookie` header, split as a server sees it: pairs on `;`, each at its first `=`. A pair with no `=` is a nameless
 * cookie (RFC 6265bis serializes one as its value alone).
 */
export function cookiePairs(header) {
  if (!header) return [];
  return header.split(";").map((part) => part.trim()).filter((part) => part.length > 0).map((part) => {
    const at = part.indexOf("=");
    return at < 0 ? { name: "", value: part } : { name: part.slice(0, at), value: part.slice(at + 1) };
  });
}

/**
 * The plan's rule (5.4): exactly one cookie named exactly `SESSION` and at most one named exactly `STATE`, matched
 * case-sensitively. A second of either name, a nameless pair, or any pair whose name is a case variant of either
 * refuses the request. Every other cookie is ignored. Returns `{ ok, session, state, why }`.
 */
export function gateCookies(header) {
  const pairs = cookiePairs(header);
  const lower = new Set([SESSION.toLowerCase(), STATE.toLowerCase()]);
  let session;
  let state;
  for (const { name, value } of pairs) {
    if (name === "") return { ok: false, why: "nameless" };
    if (name === SESSION) {
      if (session !== undefined) return { ok: false, why: "duplicate" };
      session = value;
    } else if (name === STATE) {
      if (state !== undefined) return { ok: false, why: "duplicate" };
      state = value;
    } else if (lower.has(name.toLowerCase())) {
      return { ok: false, why: "case_variant" };
    }
  }
  return { ok: true, session, state };
}

/** A signed token: base64url JSON claims, a dot, base64url HMAC-SHA256 over the first part. */
export function sign(key, claims) {
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(createHmac("sha256", key).update(body).digest())}`;
}

/** The token's claims if its signature holds, else null. Checks nothing else. */
export function verify(key, token) {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), "base64url");
  const want = createHmac("sha256", key).update(body).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** The plan's check of a ticket or session (5.3 steps 6 and 7): type, audience, expiry and the state binding. */
export function check(key, token, { typ, host, state, now = Math.floor(Date.now() / 1000) }) {
  const claims = verify(key, token);
  if (!claims) return { ok: false, why: "signature" };
  if (claims.typ !== typ) return { ok: false, why: "typ" };
  if (claims.aud !== host) return { ok: false, why: "aud" };
  if (!(claims.exp > now)) return { ok: false, why: "exp" };
  if (typeof state !== "string" || claims.st !== stateHash(state)) return { ok: false, why: "st" };
  return { ok: true, claims };
}

/** The same-host return path rule: a path on this host, never `//`, a scheme or a backslash. */
export function sameHostPath(r) {
  return typeof r === "string" && r.startsWith("/") && !r.startsWith("//") && !r.includes("\\") ? r : "/";
}

/** The fixed exchange page's one inline script (5.3 step 5). Reads the fragment, removes it, posts it same-origin. */
export const ENTER_SCRIPT = [
  "(function(){",
  "var p=new URLSearchParams(location.hash.slice(1));var t=p.get('t');var r=p.get('r')||'/';",
  "history.replaceState(null,'',location.pathname);",
  "if(!t){document.body.textContent='no ticket';return;}",
  "fetch('/__podster/enter',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({t:t,r:r})})",
  ".then(function(x){if(!x.ok)throw x.status;return x.json();})",
  ".then(function(j){location.assign(j.r);})",
  ".catch(function(e){document.body.textContent='refused '+e;});",
  "})();",
].join("");

export const ENTER_SCRIPT_HASH = `sha256-${createHash("sha256").update(ENTER_SCRIPT).digest("base64")}`;

/** The exchange page's CSP, as the plan states it. */
export const ENTER_CSP = [
  "sandbox allow-scripts allow-same-origin",
  "default-src 'none'",
  `script-src '${ENTER_SCRIPT_HASH}'`,
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Production's policy, copied from `sandboxPolicy` in apps/content/src/handle.ts at 55ac33ac. */
export function productionPolicy(origin) {
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

/** The plan's preview policy (5.8): production's, with `allow-same-origin` and nothing else added. */
export const previewPolicy = (origin) => productionPolicy(origin).replace("sandbox allow-scripts", "sandbox allow-scripts allow-same-origin");
