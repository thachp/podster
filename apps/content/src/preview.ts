// The gate on preview hosts (M8 step 8; the preview plan, `docs/m8-preview-plan.md`, 5.3 to 5.5 and 5.8, with spike
// P1's results of 2026-11-28 and step 7's requirements; decisions 252, 255, 256 and 258). Pure but for WebCrypto: no
// binding, no clock (every time is passed in) and no log.
//
// **A mirror of `crates/core/src/preview_access.rs` and `serve_entry.rs`'s preview form, which are the rule.** Rust
// decided who may view and signed what it decided; this checks bytes and numbers against that, as `names.ts` checks a
// serve entry's label. The package's test of it reads the Rust source and fails if a constant, a refusal code or the
// token's wire form here differs from it.
//
// - **Verified with public keys only** (decision 258): Ed25519 over `podster-preview-token/v1.` and the payload, by a
//   key the payload's `kid` names, from `PREVIEW_PUBLIC_KEYS`. This Worker holds no key that signs, so it can mint
//   nothing; the session cookie it sets is the API's own signed session, carried beside its ticket in the fragment.
// - **The two cookies, by their exact names**, case-sensitively. Every other name is ignored, case variants included
//   (spike P1, item 1); a second cookie of an exact name refuses, and so does a nameless cookie a browser serialises as
//   one of them beside the real one (item 2), since it is then a second cookie of that name.
// - **Bound to the state cookie on every request**: a session's `st` must be the SHA-256 of this browser's state.
// - **Writes** only with `Sec-Fetch-Site: same-origin`, `Origin` only when that header is absent (item 5).
// - **The loop guard** (item 4): the state cookie carries the rounds of the flow, and a third round within a minute is a
//   fixed `401` page.
//
// Nothing here reads, returns or logs a token's or a cookie's value anywhere but in the comparison it makes.

import type { HostKind } from "./requests";
import { isScriptName, isWrittenHost } from "./names";

// ---------------------------------------------------------------------------------------------------------------------
// Constants, each `podster_core::preview_access`'s, `podster_core::preview`'s or `podster_core::serve_entry`'s
// ---------------------------------------------------------------------------------------------------------------------

export const TICKET_TTL_MS = 60 * 1000;
export const SESSION_MAX_TTL_MS = 60 * 60 * 1000;
export const MARKER_TTL_MS = 60 * 1000;
export const SESSION_COOKIE = "__Host-podster_preview";
export const STATE_COOKIE = "__Host-podster_preview_state";
export const STATE_COOKIE_MAX_AGE_S = 12 * 60 * 60;
export const SESSION_COOKIE_MAX_AGE_S = SESSION_MAX_TTL_MS / 1000;
export const LOOP_GUARD_ROUNDS = 2;
export const LOOP_GUARD_WINDOW_MS = 60 * 1000;
export const MAX_RETURN_PATH_LEN = 2048;
export const SESSION_ID_PREFIX = "pvs_";
export const SLOT_ID_PREFIX = "pvw_";
export const MAX_KEY_ID_LEN = 64;
export const MAX_ACCESS_EPOCH = 999_999_999_999_999;
export const TOKEN_SIGNING_PREFIX = "podster-preview-token/v1.";
export const ENTER_PATH = "/__podster/enter";
/** `podster_core::release_tree::MARKER_PATH`, which a marker token may fetch, with `GET`. */
export const MARKER_PATH = ".well-known/podster-release.json";
/** `podster_core::serve_entry::PREVIEW_MARK`. */
export const PREVIEW_MARK = "preview:";

/** The prefix this Worker answers itself on every host, for every method (the plan's 5.3). Matched in any case. */
export const PODSTER_PREFIX = "/__podster";
/**
 * The header the release job's marker fetch carries its marker token in (the plan's 3.2). **Proposed** here: the API
 * doesn't send one yet, so until it does a preview's marker fetch is refused like any request without a session.
 */
export const MARKER_HEADER = "x-podster-marker-token";

// ---------------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------------

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const hexId = (text: string, prefix: string) => text.startsWith(prefix) && /^[0-9a-f]{32}$/.test(text.slice(prefix.length));
export const isSlotId = (text: string) => hexId(text, SLOT_ID_PREFIX);
export const isSessionId = (text: string) => hexId(text, SESSION_ID_PREFIX);
export const isKeyId = (text: string) => text.length >= 1 && text.length <= MAX_KEY_ID_LEN && /^[A-Za-z0-9_-]+$/.test(text);

/** 43 base64url characters whose last carries only zero bits past 256: one spelling for one 32-byte value. */
export function isCanonical32(text: string): boolean {
  return text.length === 43 && /^[A-Za-z0-9_-]+$/.test(text) && BASE64URL.indexOf(text[42]) % 4 === 0;
}
/** `podster_core::preview_access::is_state_hash`. */
export const isStateHash = isCanonical32;

/** Bytes as base64url with no padding. */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const n = (bytes[at] << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0);
    const chars = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63].map((sextet) => BASE64URL[sextet]);
    out += chars.slice(0, Math.min(4, bytes.length - at + 1)).join("");
  }
  return out;
}

/** Base64url with no padding, read back only in its one canonical spelling; null for anything else. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.slice(i, i + 4);
    const n = [...chunk.padEnd(4, "A")].reduce((acc, char) => (acc << 6) | BASE64URL.indexOf(char), 0);
    const got = [(n >> 16) & 255, (n >> 8) & 255, n & 255].slice(0, chunk.length - 1);
    for (const byte of got) bytes[at++] = byte;
  }
  return base64url(bytes) === text ? bytes : null;
}

/** `podster_core::preview_access::return_path_ok`. */
export function returnPathOk(r: string): boolean {
  return r.length >= 1 && r.length <= MAX_RETURN_PATH_LEN && r.startsWith("/") && r[1] !== "/" && r[1] !== "\\" && /^[\x21-\x7e]+$/.test(r);
}

/** Whether a path is at or under `PODSTER_PREFIX`, in any case, as the URL parser hands it over. */
export function isPodsterPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return path === PODSTER_PREFIX || path.startsWith(`${PODSTER_PREFIX}/`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The serve entry's preview form (`podster_core::serve_entry::preview_entry_script`)
// ---------------------------------------------------------------------------------------------------------------------

/** One preview entry, read back. */
export type PreviewEntry = { slot: string; epoch: number; kind: HostKind; script: string };

/** A default preview host's entry: `preview:<slot>:<epoch>:` and a default host's production form. Null otherwise. */
export function previewEntry(value: string): PreviewEntry | null {
  if (!value.startsWith(PREVIEW_MARK)) return null;
  const rest = value.slice(PREVIEW_MARK.length);
  const first = rest.indexOf(":");
  if (first < 0) return null;
  const slot = rest.slice(0, first);
  const second = rest.indexOf(":", first + 1);
  if (second < 0) return null;
  const epochText = rest.slice(first + 1, second);
  if (!isSlotId(slot) || !/^(0|[1-9][0-9]{0,14})$/.test(epochText)) return null;
  const epoch = Number(epochText);
  if (epoch > MAX_ACCESS_EPOCH) return null;
  // What is left is a default host's production form, read exactly as `names.ts` reads one: the code mark once, from
  // the start only, then a script's name. (`CODE_MARK` is `names.ts`'s; spelled here so this file imports no marker.)
  const form = rest.slice(second + 1);
  const coded = form.startsWith("code:");
  const script = coded ? form.slice("code:".length) : form;
  return isScriptName(script) ? { slot, epoch, kind: coded ? "code" : "static", script } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tokens (`podster_core::preview_access::{token_payload, check_claims}`)
// ---------------------------------------------------------------------------------------------------------------------

export type TokenType = "ticket" | "session" | "marker";

export type Claims = { typ: TokenType; kid: string; aud: string; pvw: string; sid: string | null; ep: number; iat: number; exp: number; st: string | null };

const maxTtl = (typ: TokenType) => (typ === "ticket" ? TICKET_TTL_MS : typ === "session" ? SESSION_MAX_TTL_MS : MARKER_TTL_MS);
const isBrowsers = (typ: TokenType) => typ === "ticket" || typ === "session";

/** The payload's JSON exactly as `token_payload` writes it for these claims. */
export function payloadJson(claims: Claims): string {
  let json = `{"typ":"${claims.typ}","kid":"${claims.kid}","aud":"${claims.aud}","pvw":"${claims.pvw}"`;
  if (claims.sid !== null) json += `,"sid":"${claims.sid}"`;
  json += `,"ep":${claims.ep},"iat":${claims.iat},"exp":${claims.exp}`;
  if (claims.st !== null) json += `,"st":"${claims.st}"`;
  return `${json}}`;
}

/**
 * A payload's claims, read only in the one form `token_payload` writes: every key in its fixed order, each value of its
 * form, and the JSON written back exactly as it came. Null for anything else, so no other spelling of the same claims is
 * ever honoured.
 */
export function readPayload(text: string): Claims | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const typ = v.typ;
  if (typ !== "ticket" && typ !== "session" && typ !== "marker") return null;
  const str = (key: string) => (typeof v[key] === "string" ? (v[key] as string) : null);
  const int = (key: string) => (Number.isSafeInteger(v[key]) ? (v[key] as number) : null);
  const [kid, aud, pvw, ep, iat, exp] = [str("kid"), str("aud"), str("pvw"), int("ep"), int("iat"), int("exp")];
  if (kid === null || aud === null || pvw === null || ep === null || iat === null || exp === null) return null;
  if (!isKeyId(kid) || !isWrittenHost(aud) || !isSlotId(pvw) || ep < 0) return null;
  const browsers = isBrowsers(typ);
  const sid = browsers ? str("sid") : null;
  const st = browsers ? str("st") : null;
  if (browsers && (sid === null || st === null || !isSessionId(sid) || !isStateHash(st))) return null;
  const claims: Claims = { typ, kid, aud, pvw, sid, ep, iat, exp, st };
  return payloadJson(claims) === text ? claims : null;
}

/** What checks a signature: the public key the ID names, if this Worker holds one. */
export interface PreviewKeys {
  verify(kid: string, signature: Uint8Array<ArrayBuffer>, message: Uint8Array<ArrayBuffer>): Promise<boolean>;
}

/**
 * A token's claims, once its signature checks out: `<payload>.<signature>`, both canonical base64url, the payload's
 * `kid` naming a key held here, Ed25519 over `TOKEN_SIGNING_PREFIX` and the payload as written. Null for anything else.
 * Only then are the claims read by `checkClaims`.
 */
export async function verifiedClaims(token: string, keys: PreviewKeys): Promise<Claims | null> {
  if (token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const payloadBytes = fromBase64url(payload);
  const signatureBytes = fromBase64url(signature);
  if (payloadBytes === null || signatureBytes === null || payloadBytes.length === 0 || signatureBytes.length !== 64) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  } catch {
    return null;
  }
  const claims = readPayload(text);
  if (claims === null) return null;
  const message = new TextEncoder().encode(`${TOKEN_SIGNING_PREFIX}${payload}`);
  try {
    return (await keys.verify(claims.kid, signatureBytes, message)) ? claims : null;
  } catch {
    return null;
  }
}

/** The request a token was presented with (`podster_core::preview_access::Presented`). */
export type Presented = { host: string; now: number; entrySlot: string; entryEpoch: number; stateHash: string | null; path: string; method: string };

/** `podster_core::preview_access::TokenRefusal`, by name. */
export type TokenRefusal = "WrongType" | "WrongAudience" | "WrongSlot" | "Expired" | "EpochBelow" | "StateMismatch" | "MarkerOnly" | "Malformed";

/** What a request refused on a token is answered with (`TokenRefusal::code`). */
export function refusalCode(refusal: TokenRefusal | null): "preview_session_expired" | "preview_access_required" {
  return refusal === "Expired" ? "preview_session_expired" : "preview_access_required";
}

/** `podster_core::preview_access::check_claims`, in its order. */
export function checkClaims(claims: Claims, expected: TokenType, presented: Presented): TokenRefusal | null {
  const lifetime = claims.exp - claims.iat;
  const carriesBrowser = claims.sid !== null || claims.st !== null;
  const wellFormed =
    claims.exp > claims.iat &&
    lifetime <= maxTtl(claims.typ) &&
    claims.ep <= MAX_ACCESS_EPOCH &&
    (isBrowsers(claims.typ) ? claims.sid !== null && isSessionId(claims.sid) && claims.st !== null && isStateHash(claims.st) : !carriesBrowser);
  if (!wellFormed) return "Malformed";
  if (claims.typ !== expected) return "WrongType";
  if (claims.aud !== presented.host) return "WrongAudience";
  if (claims.pvw !== presented.entrySlot || !isSlotId(presented.entrySlot)) return "WrongSlot";
  if (presented.now >= claims.exp) return "Expired";
  if (!(claims.ep >= presented.entryEpoch)) return "EpochBelow";
  if (isBrowsers(claims.typ)) {
    if (presented.stateHash === null || presented.stateHash !== claims.st) return "StateMismatch";
  } else if (!(presented.path === `/${MARKER_PATH}` && presented.method === "GET")) {
    return "MarkerOnly";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The two cookies (`podster_core::preview_access::gate_cookies`)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A `Cookie` header as name and value pairs, in the order sent. A pair with no `=` is a nameless cookie: its name is
 * empty and its value the whole pair. A nameless cookie whose value reads `__Host-podster_preview=…` reaches a server
 * as that cookie and can't be told apart from it (spike P1, item 2), so it is read as that name, as every server would.
 */
export function cookiePairs(header: string | null): [string, string][] {
  if (header === null) return [];
  const trim = (text: string) => text.replace(/^[ \t]+|[ \t]+$/g, "");
  return header.split(";").map((segment) => {
    const at = segment.indexOf("=");
    return at < 0 ? ["", trim(segment)] : [trim(segment.slice(0, at)), trim(segment.slice(at + 1))];
  });
}

export type GateCookies = { session: string | null; state: string | null };

/** The two cookies, each if sent once; `"duplicate"` if an exact name came twice. Every other name is ignored. */
export function gateCookies(pairs: [string, string][]): GateCookies | "duplicate" {
  const found: GateCookies = { session: null, state: null };
  for (const [name, value] of pairs) {
    const slot = name === SESSION_COOKIE ? "session" : name === STATE_COOKIE ? "state" : null;
    if (slot === null) continue;
    if (found[slot] !== null) return "duplicate";
    found[slot] = value;
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// Writes, and the loop guard
// ---------------------------------------------------------------------------------------------------------------------

/** `podster_core::preview_access::write_allowed`. */
export function writeAllowed(method: string, secFetchSite: string | null, origin: string | null, host: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  if (secFetchSite !== null) return secFetchSite === "same-origin";
  return origin !== null && host !== "" && origin === `https://${host}`;
}

export type FlowRounds = { count: number; firstAt: number };

/** `podster_core::preview_access::next_round`: the round to record, or `"stop"`. */
export function nextRound(previous: FlowRounds | null, now: number): FlowRounds | "stop" {
  if (previous !== null && now - previous.firstAt < LOOP_GUARD_WINDOW_MS) {
    return previous.count >= LOOP_GUARD_ROUNDS ? "stop" : { count: previous.count + 1, firstAt: previous.firstAt };
  }
  return { count: 1, firstAt: now };
}

/**
 * The state cookie's value, Podster's own: 32 random bytes in canonical base64url, and while the browser is going round
 * the flow, `.<rounds>.<first round's time in ms>`. The state hash is over the random part alone, so recording a round
 * or clearing the record never changes it, and a session stays bound to the same state.
 */
export type State = { random: string; rounds: FlowRounds | null };

export function readState(value: string | null): State | null {
  if (value === null) return null;
  const match = /^([A-Za-z0-9_-]{43})(?:\.([1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,15}))?$/.exec(value);
  if (match === null || !isCanonical32(match[1])) return null;
  if (match[2] === undefined) return { random: match[1], rounds: null };
  const count = Number(match[2]);
  const firstAt = Number(match[3]);
  if (count > LOOP_GUARD_ROUNDS || !Number.isSafeInteger(firstAt)) return null;
  return { random: match[1], rounds: { count, firstAt } };
}

export function writeState(state: State): string {
  return state.rounds === null ? state.random : `${state.random}.${state.rounds.count}.${state.rounds.firstAt}`;
}

/** The state hash the API binds a ticket and a session to: SHA-256 of the state's random part, canonical base64url. */
export async function stateHash(random: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(random))));
}

/** A `Set-Cookie` for one of the two cookies: host-only by the `__Host-` prefix, HttpOnly, Secure, `SameSite=Lax`. */
export function setCookie(name: typeof SESSION_COOKIE | typeof STATE_COOKIE, value: string, maxAgeS: number): string {
  return `${name}=${value}; Max-Age=${maxAgeS}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The policies and the fixed pages
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The one `sandbox` directive on a preview host (decision 255, narrowing decision 216 on preview hosts only). **This is
 * the only place in the Worker that gives a page its origin back,** and only a preview host's answers carry it: the
 * production policy, `sandboxPolicy` in `handle.ts`, never does, and the package's test holds both.
 */
export const PREVIEW_SANDBOX = "sandbox allow-scripts allow-same-origin";

/**
 * The CSP of every answer on a preview host but the exchange page: the production policy for the same origin,
 * directive for directive, with the sandbox above in place of production's (the plan's 5.2.1 and 5.8).
 */
export function previewSandboxPolicy(productionPolicy: string): string {
  const [first, ...rest] = productionPolicy.split("; ");
  if (first !== "sandbox allow-scripts") throw new Error("the production policy must begin with its sandbox");
  return [PREVIEW_SANDBOX, ...rest].join("; ");
}

/**
 * The exchange page's one script (the plan's 5.3, step 5): read the fragment, take it out of the address and the
 * history at once with `replaceState`, post the ticket, the session and the return path to the same path, same-origin,
 * and go where the answer says if it is a path on this host. It reads nothing else and writes nothing but its message.
 * Its `referrerPolicy` keeps the browser's `Origin` on the post (spike P1, item 5: under `no-referrer` Firefox and
 * WebKit send `Origin: null` on a same-origin write), and a `Referer` of a same-origin request holds no fragment.
 */
export const ENTER_SCRIPT =
  '(function(){var f=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);' +
  'var m=document.getElementById("m");var t=f.get("t"),s=f.get("s"),r=f.get("r")||"/";' +
  'if(!t||!s){m.textContent="This link has no way in. Open the preview from its own address.";return;}' +
  'fetch(location.pathname,{method:"POST",credentials:"same-origin",referrerPolicy:"same-origin",cache:"no-store",headers:{"content-type":"application/json"},body:JSON.stringify({t:t,s:s,r:r})})' +
  '.then(function(a){return a.ok?a.json():null}).then(function(b){var p=b&&b.r;' +
  'if(typeof p==="string"&&p.charAt(0)==="/"&&p.charAt(1)!=="/"&&p.charAt(1)!=="\\\\"){location.replace(p);}' +
  'else{m.textContent="You can\'t open this preview. Open it from its own address to try again.";}})' +
  '.catch(function(){m.textContent="You can\'t open this preview. Open it from its own address to try again.";});})();';

/** The SHA-256 of `ENTER_SCRIPT`, for the page's `script-src`. The package's test computes it and holds this to it. */
export const ENTER_SCRIPT_HASH = "sha256-yqvZpMZtAVIrLzImFqHmZinxVeLOmnNF29WYF0pa8/8=";

export const ENTER_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Opening the preview</title></head><body><p id="m">Opening the preview…</p><script>${ENTER_SCRIPT}</script></body></html>`;

/** The exchange page's policy (the plan's 5.3, step 5): its one script, its own origin for its one post, and nothing else. */
export const ENTER_POLICY = [
  "default-src 'none'",
  `script-src '${ENTER_SCRIPT_HASH}'`,
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  PREVIEW_SANDBOX,
].join("; ");

/** The fixed page the loop guard answers with: no script, no link, nothing of the app's. */
export const STOPPED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>You can't open this preview</title></head><body><main><h1>You can't open this preview</h1><p>This browser went round the way in twice in a minute and still has no access. Close this tab and open the preview again from Podster. If it keeps happening, this browser may be refusing or dropping the preview's cookies.</p></main></body></html>`;

/** `robots.txt` on every preview host, answered before the gate (the plan's 5.8). */
export const PREVIEW_ROBOTS = "User-agent: *\nDisallow: /\n";

// ---------------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------------

/** At most two public keys: the current one and, for an hour after a rotation, the one before (decision 258). */
export const MAX_PUBLIC_KEYS = 2;

/**
 * The public keys, from `PREVIEW_PUBLIC_KEYS`: `<kid>:<64 hex>`, or two such separated by `,`, with distinct IDs. Each
 * is an Ed25519 public key's 32 bytes in hexadecimal, the public half of the API's `PREVIEW_TICKET_KEY`
 * (`podster_egress::preview_key`). Null for anything else, and then previews are off.
 */
export function publicKeysFromSetting(setting: unknown): Map<string, Uint8Array<ArrayBuffer>> | null {
  if (typeof setting !== "string" || setting.length === 0) return null;
  const entries = setting.split(",");
  if (entries.length > MAX_PUBLIC_KEYS) return null;
  const keys = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const entry of entries) {
    const at = entry.indexOf(":");
    if (at < 0) return null;
    const [kid, hex] = [entry.slice(0, at), entry.slice(at + 1)];
    if (!isKeyId(kid) || !/^[0-9a-fA-F]{64}$/.test(hex) || keys.has(kid)) return null;
    keys.set(kid, Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16)));
  }
  return keys;
}

/** Verifies with keys held by ID, each imported once, when first needed. A key WebCrypto won't take verifies nothing. */
export function webCryptoKeys(keys: Map<string, Uint8Array<ArrayBuffer>>): PreviewKeys {
  const imported = new Map<string, Promise<CryptoKey | null>>();
  return {
    async verify(kid, signature, message) {
      const raw = keys.get(kid);
      if (raw === undefined) return false;
      let key = imported.get(kid);
      if (key === undefined) {
        key = crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]).catch(() => null);
        imported.set(kid, key);
      }
      const ready = await key;
      return ready !== null && (await crypto.subtle.verify({ name: "Ed25519" }, ready, signature, message));
    },
  };
}

/**
 * The application host's origin, from `PREVIEW_ACCESS_ORIGIN`: exactly `https://<host>`, a host as Podster writes one,
 * and never on the content domain, so no app's host can be where a viewer is sent for a ticket. Null for anything else.
 */
export function accessOriginFromSetting(setting: unknown, contentDomain: string): string | null {
  if (typeof setting !== "string" || !setting.startsWith("https://")) return null;
  const host = setting.slice("https://".length);
  if (!isWrittenHost(host)) return null;
  if (contentDomain !== "" && (host === contentDomain || host.endsWith(`.${contentDomain}`))) return null;
  return setting;
}
