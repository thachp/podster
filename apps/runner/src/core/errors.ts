/**
 * The gateway's refusals, read by Runner itself (M7 plan, the architect's ruling 3 on spike A). The pinned client SDK
 * misreads the gateway's own `{ error: { code } }` shape, so Runner never takes a refusal from the SDK's errors: it reads
 * the HTTP status and the body's code, whichever of the three shapes the gateway answers in:
 *
 * - the gateway's own routes and the API: `{ "error": { "code": "not_allowed" } }`;
 * - the Agent Auth plugin: `{ "error": "agent_revoked", "message": "…" }`;
 * - the gateway's refusals on the plugin's capability path: `{ "message": "agent_unclaimed", "code": … }`.
 *
 * A body is someone else's content. Only a short snake-case code is ever taken from it, and anything else reads as
 * `unknown`, so no text from a response reaches a log or the owner's screen.
 */

/** A code as Runner keeps it: lower-case snake case, short. Anything else from a body is never kept. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds the gateway asked us to wait, for a 429 or 503, when it said. */
  readonly retryAfter: number | null;

  constructor(status: number, code: string, retryAfter: number | null = null) {
    super(`gateway answered ${status} ${code}`);
    this.name = "GatewayError";
    this.status = status;
    this.code = CODE.test(code) ? code : "unknown";
    this.retryAfter = retryAfter;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The code a refusal's body names, in any of the gateway's three shapes, or `unknown`. */
export function codeFrom(body: unknown): string {
  if (!isObject(body)) return "unknown";
  const { error, code, message } = body;
  const candidates = [isObject(error) ? error.code : undefined, typeof error === "string" ? error : undefined, code, message];
  for (const candidate of candidates) if (typeof candidate === "string" && CODE.test(candidate)) return candidate;
  return "unknown";
}

/** The most of a refusal's body Runner reads. */
export const MAX_ERROR_BYTES = 16_384;

/**
 * A response's body as text, read only up to `max` bytes: past that the rest is never read, the stream is cancelled,
 * and the answer is null. So an answer that is huge, or never ends, can't make Runner hold it whole (step 12's harness:
 * `text()` read it all before its length was checked). Null too when the body can't be read or isn't UTF-8.
 */
export async function readBounded(response: Response, max: number): Promise<string | null> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return null;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A refusal from a response that isn't 2xx. Reads at most a small body, and never keeps more than its code. */
export async function errorFrom(response: Response): Promise<GatewayError> {
  let body: unknown = null;
  try {
    const text = await readBounded(response, MAX_ERROR_BYTES);
    body = text === null ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  const header = response.headers.get("retry-after");
  const after = header !== null && /^\d{1,6}$/.test(header.trim()) ? Math.min(Number(header.trim()), 3600) : null;
  return new GatewayError(response.status, codeFrom(body), after);
}

/**
 * What a refusal means for Runner:
 *
 * - `unclaimed`: the agent is registered but its person hasn't confirmed it yet (`403 agent_unclaimed`). While pairing,
 *   that is waiting; once connected, it's an authority error.
 * - `authority`: the credential no longer acts: the agent was revoked or disconnected, whoever connected it left, its key
 *   isn't accepted, or a grant is gone. Runner stops and tells the owner, and never registers again by itself.
 * - `rate_limited`: wait and try again.
 * - `transient`: the network, a timeout or the server's own failure. Try again later, with the same key.
 * - `refused`: anything else. The request itself wasn't allowed.
 */
export type Meaning = "unclaimed" | "authority" | "rate_limited" | "transient" | "refused";

/** Codes that say this agent's credential no longer acts, whatever the status. */
const AUTHORITY = new Set([
  "agent_revoked", "agent_disconnected", "credential_owner_left", "agent_expired", "agent_rejected", "agent_pending",
  "host_revoked", "host_rejected", "capability_not_granted", "invalid_jwt", "jwt_replay", "invalid_credential", "unauthorized",
]);

export function meaningOf(error: unknown): Meaning {
  if (!(error instanceof GatewayError)) return "transient";
  if (error.status === 0 || error.status >= 500) return "transient";
  if (error.status === 429) return "rate_limited";
  if (error.status === 403 && error.code === "agent_unclaimed") return "unclaimed";
  if (error.status === 401 || AUTHORITY.has(error.code)) return "authority";
  return "refused";
}

/**
 * An error whose message is a fixed code, with the facts a person needs to see why (the owner's request of 2026-11-20):
 * a command's exit code and the tail of its error output. The detail goes only to the local diagnostics file, redacted
 * there, never to a log line, Podster or the network.
 */
export class DetailedError extends Error {
  /** `cut`: the error output was cut at its head cap, so its last word may be part of a secret. */
  readonly detail: { exit_code?: number; stderr?: string; errno?: string; cut?: boolean };
  constructor(code: string, detail: { exit_code?: number; stderr?: string; errno?: string; cut?: boolean } = {}) {
    super(code);
    this.detail = detail;
  }
}
