// Which requests the content Worker lets through to an app, by whether the host's release carries code (ADR 0010's
// proposed revision, sections 3.4 and 3.5, decided by the owner on 2026-11-13 as decision 220, answer 5).
//
// **A mirror of `crates/core/src/app_requests.rs`, which is the rule.** The content Worker is TypeScript and can't
// call the Rust core, so the rule is written again here, line for line, and pure. The package's test of the rules reads
// the Rust source and fails if any constant, refusal code or status here differs from it, or if either side gains one the
// other lacks; it also runs core's own cases against this copy.
//
// - **A static app** keeps what the content Worker does today: `GET` and `HEAD`, three request headers, no body.
// - **An app whose release has code** also takes `POST`, `PUT`, `PATCH` and `DELETE`, each only with a JSON
//   `Content-Type`, so that every write a browser sends has first asked leave in a preflight. The content Worker
//   answers that preflight itself, and an app never sees an `OPTIONS` request.
// - **Refused for every app with code:** a request that asks for a WebSocket, and a request for a service worker's
//   script. (The handler keeps a static host's answers exactly as today: see `handle.ts`.)

/** What a host serves, from its serve entry. */
export type HostKind = "static" | "code";

/** What a request let through is. */
export type RequestClass = "read" | "write" | "preflight";

/** The largest body a write may carry, in bytes. **Proposed:** the revision gives 64 KiB as a guess. */
export const MAX_WRITE_BODY_BYTES = 64 * 1024;
/** The methods a static app takes. */
export const STATIC_METHODS = ["GET", "HEAD"] as const;
/** The methods an app with code takes, besides the preflight the content Worker answers. */
export const CODE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
/** The methods that write. */
export const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
/** The visitor's headers sent on to an app with every request, as today. */
export const READ_HEADERS = ["accept", "if-none-match", "if-modified-since"] as const;
/** The visitor's headers sent on to an app with a write: those of a read, and the body's type and length. */
export const WRITE_HEADERS = ["accept", "if-none-match", "if-modified-since", "content-type", "content-length"] as const;
/** The only media type a write may carry. */
export const JSON_TYPE = "application/json";
/** The `Access-Control-Allow-Origin` of every answer for a host with code: the origin a sandboxed page has. */
export const CODE_ALLOW_ORIGIN = "null";
/** The preflight's `Access-Control-Allow-Methods`. */
export const CODE_ALLOW_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE";
/** The preflight's `Access-Control-Allow-Headers`: the only request header a page may ask leave to send. */
export const CODE_ALLOW_HEADERS = "content-type";
/** The `Cache-Control` of every answer of an app with code. */
export const CODE_CACHE_CONTROL = "no-store";

/** The facts of a request the rule needs, as the content Worker read them. A header that wasn't sent is null. */
export interface RequestFacts {
  method: string;
  contentType: string | null;
  contentLength: string | null;
  /** Whether a `Service-Worker` header was sent, whatever it holds. */
  serviceWorker: boolean;
  /** Whether an `Upgrade` header was sent, whatever it holds. */
  upgrade: boolean;
}

/** Why a request is refused by the content Worker before it reaches an app, by its code. */
export type RequestRefusal = "method_not_allowed" | "no_service_workers" | "no_upgrade" | "write_not_json" | "write_bad_length" | "write_too_large";

/** The status the content Worker answers each refusal with. */
export const REFUSAL_STATUS: Readonly<Record<RequestRefusal, number>> = {
  method_not_allowed: 405,
  no_service_workers: 403,
  no_upgrade: 403,
  write_not_json: 415,
  write_bad_length: 400,
  write_too_large: 413,
};

/** Why a preflight isn't allowed, by its code. */
export type PreflightRefusal = "preflight_not_code" | "preflight_no_method" | "preflight_method" | "preflight_header";

/** What the answer to an allowed preflight carries: fixed, whatever was asked. */
export interface PreflightAnswer {
  allowOrigin: typeof CODE_ALLOW_ORIGIN;
  allowMethods: typeof CODE_ALLOW_METHODS;
  allowHeaders: typeof CODE_ALLOW_HEADERS;
}

export type Checked<T, E> = { ok: true; value: T } | { ok: false; refusal: E };

const includes = (list: readonly string[], value: string) => list.includes(value);

/** Lower case for ASCII letters only, as Rust's `eq_ignore_ascii_case` compares. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
/** Spaces and tabs off both ends, and nothing else, as Rust's `trim_matches([' ', '\t'])`. */
function trimSpaceTab(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** The methods a host takes, for its `Allow` header. */
export function allowedMethods(kind: HostKind): readonly string[] {
  return kind === "static" ? STATIC_METHODS : CODE_METHODS;
}

/** The visitor's headers sent on to an app with a request of this class. */
export function forwardedHeaders(cls: RequestClass): readonly string[] {
  return cls === "write" ? WRITE_HEADERS : READ_HEADERS;
}

/** Whether a `Content-Type` is JSON: `application/json` in any case, with at most one parameter, `charset=utf-8`. */
export function isJsonContentType(value: string): boolean {
  const parts = value.split(";");
  if (asciiLower(trimSpaceTab(parts[0])) !== JSON_TYPE) return false;
  if (parts.length === 1) return true;
  if (parts.length > 2) return false;
  const parameter = asciiLower(trimSpaceTab(parts[1]));
  return parameter === "charset=utf-8" || parameter === 'charset="utf-8"';
}

/** The largest value a `Content-Length` may name and still be read: Rust's `u64::MAX`. */
const U64_MAX = 2n ** 64n - 1n;

/** A `Content-Length`, read strictly: one to twenty ASCII digits and nothing else, and no more than `u64::MAX`. */
export function parseContentLength(value: string): bigint | null {
  if (!/^[0-9]{1,20}$/.test(value)) return null;
  const length = BigInt(value);
  return length <= U64_MAX ? length : null;
}

/** Whether a body counted so far, in bytes, is still within the cap. */
export function bodyWithinCap(bytes: number | bigint): boolean {
  return BigInt(bytes) <= BigInt(MAX_WRITE_BODY_BYTES);
}

/** Whether a request may pass to an app on a host of this kind, and as what. */
export function checkRequest(kind: HostKind, facts: RequestFacts): Checked<RequestClass, RequestRefusal> {
  const refuse = (refusal: RequestRefusal) => ({ ok: false, refusal }) as const;
  if (facts.serviceWorker) return refuse("no_service_workers");
  if (facts.upgrade) return refuse("no_upgrade");
  const method = facts.method;
  if (includes(STATIC_METHODS, method)) return { ok: true, value: "read" };
  if (kind === "static") return refuse("method_not_allowed");
  if (method === "OPTIONS") return { ok: true, value: "preflight" };
  if (!includes(WRITE_METHODS, method)) return refuse("method_not_allowed");
  if (facts.contentType === null || !isJsonContentType(facts.contentType)) return refuse("write_not_json");
  if (facts.contentLength !== null) {
    const length = parseContentLength(facts.contentLength);
    if (length === null) return refuse("write_bad_length");
    if (!bodyWithinCap(length)) return refuse("write_too_large");
  }
  return { ok: true, value: "write" };
}

/** Whether to allow a preflight, from its `Access-Control-Request-Method` and `Access-Control-Request-Headers`. */
export function checkPreflight(kind: HostKind, requestMethod: string | null, requestHeaders: string | null): Checked<PreflightAnswer, PreflightRefusal> {
  const refuse = (refusal: PreflightRefusal) => ({ ok: false, refusal }) as const;
  if (kind !== "code") return refuse("preflight_not_code");
  if (requestMethod === null) return refuse("preflight_no_method");
  if (!includes(CODE_METHODS, requestMethod)) return refuse("preflight_method");
  if (requestHeaders !== null) {
    for (const raw of requestHeaders.split(",")) {
      const name = trimSpaceTab(raw);
      if (name !== "" && asciiLower(name) !== CODE_ALLOW_HEADERS) return refuse("preflight_header");
    }
  }
  return { ok: true, value: { allowOrigin: CODE_ALLOW_ORIGIN, allowMethods: CODE_ALLOW_METHODS, allowHeaders: CODE_ALLOW_HEADERS } };
}
