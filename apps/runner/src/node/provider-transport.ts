/**
 * The provider transport (M7 step 9(b); the architect's ruling 3 on spike B; #459's notes for 9(b)). The only place the
 * owner's provider key exists in Runner's process, outside the task's container and outside Claude Code:
 *
 * - **Only the broker's fixed URL.** A forward must name exactly the profile's upstream, built by the broker from fixed
 *   parts; its headers are the profile's, and the key is added here, last. A forward carrying a key or authorization of
 *   its own is refused.
 * - **`redirect: "error"`,** so the key never follows a redirect anywhere.
 * - **No proxy from the environment.** Node's `fetch` reads no proxy variable unless Node is told to; Runner refuses to
 *   make a transport when it has been (`NODE_USE_ENV_PROXY`, or `--use-env-proxy` in Node's options).
 * - **No TLS trust from the environment** (M3 on #460): Runner refuses to make a transport when certificate checks are
 *   off (`NODE_TLS_REJECT_UNAUTHORIZED=0`) or extra or system trust is added (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
 *   `--use-openssl-ca`, `--use-system-ca`), in the environment or in `NODE_OPTIONS`, since any of them lets someone
 *   else's certificate stand in for the provider's and read the key.
 * - **Streamed usage settles only on `message_stop`.** A stream cut before it, an error event, an answer that isn't 2xx,
 *   or one too large to hold returns no usage, so the broker counts the request's whole worst case.
 *
 * The answer's body goes back to Claude Code as it came. The key is never logged, returned or put in an error.
 */
import { upstreamUrl, type Forward, type ProviderProfile } from "../core/broker.js";
import type { ProviderAnswer, ProviderTransport } from "../core/run-interface.js";

/** The most an answer may hold. A larger one is cut, and counts its worst case. */
export const MAX_ANSWER_BYTES = 32 * 1024 * 1024;

const KEY = /^[A-Za-z0-9_-]{20,256}$/;

/** Whether this process has been told to take a proxy from its environment. */
export function envProxyRequested(env: NodeJS.ProcessEnv, execArgv: readonly string[]): boolean {
  const on = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return on(env.NODE_USE_ENV_PROXY) || execArgv.some((a) => a.startsWith("--use-env-proxy")) || /--use-env-proxy/.test(env.NODE_OPTIONS ?? "");
}

/** Why the environment would change where the key goes or whom it trusts, or null (M3 on #460). */
export function transportEnvRefusal(env: NodeJS.ProcessEnv, execArgv: readonly string[]): string | null {
  if (envProxyRequested(env, execArgv)) return "env_proxy";
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return "tls_unchecked";
  for (const name of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) if (env[name] !== undefined && env[name] !== "") return "tls_trust_added";
  const flags = [...execArgv, ...(env.NODE_OPTIONS ?? "").split(/\s+/)];
  if (flags.some((f) => /^--(use-openssl-ca|use-system-ca|use-bundled-ca=false)\b/.test(f) || f.startsWith("--openssl-config"))) return "tls_trust_added";
  return null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The usage a streamed answer reports, only once `message_stop` has arrived: `message_start`'s usage, then each
 * `message_delta`'s on top. Null if the stream never stopped, carried an error, or a usage line can't be read.
 */
export function streamUsage(text: string): unknown {
  let usage = null as Obj | null;
  let stopped = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      return null;
    }
    if (!isObj(event)) return null;
    if (event.type === "error") return null;
    if (event.type === "message_start") {
      if (!isObj(event.message) || !isObj(event.message.usage)) return null;
      usage = { ...(event.message.usage as Obj) };
    } else if (event.type === "message_delta" && event.usage !== undefined) {
      if (!isObj(event.usage) || usage === null) return null;
      usage = { ...usage, ...(event.usage as Obj) };
    } else if (event.type === "message_stop") {
      stopped = true;
    }
  }
  return stopped ? usage : null;
}

/** A whole answer's usage. */
export function answerUsage(status: number, contentType: string, text: string): unknown {
  if (status < 200 || status > 299) return null;
  if (contentType.includes("text/event-stream")) return streamUsage(text);
  try {
    const body = JSON.parse(text) as unknown;
    return isObj(body) && body.type === "message" ? (body.usage ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Why a request to the upstream failed, as a fixed code (the fifth real run of #460): `aborted` when Runner stopped
 * it, `redirect` when the upstream redirected, else `fetch_<cause code>` from Node's own error code, or `fetch_failed`.
 * Never the error's text, which can carry anything.
 */
export function failureCode(error: unknown, signal: AbortSignal): string {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return "aborted";
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  if (cause && typeof cause.message === "string" && /redirect/i.test(cause.message)) return "redirect";
  const code = cause?.code ?? (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? `fetch_${code.toLowerCase()}` : "fetch_failed";
}

export class ProviderKeyTransport implements ProviderTransport {
  private readonly key: string;
  private readonly url: string;
  private readonly profile: ProviderProfile;
  private readonly fetch: typeof globalThis.fetch;

  constructor(profile: ProviderProfile, key: string, opts: { fetch?: typeof globalThis.fetch; env?: NodeJS.ProcessEnv; execArgv?: readonly string[] } = {}) {
    if (!KEY.test(key)) throw new Error("The provider key isn't one Runner can use.");
    const refused = transportEnvRefusal(opts.env ?? process.env, opts.execArgv ?? process.execArgv);
    if (refused === "env_proxy") throw new Error("Runner won't send the provider key through a proxy taken from the environment. Unset NODE_USE_ENV_PROXY and --use-env-proxy.");
    if (refused !== null) throw new Error("Runner won't send the provider key with TLS trust taken from the environment. Unset NODE_TLS_REJECT_UNAUTHORIZED=0, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, --use-openssl-ca and --use-system-ca.");
    this.profile = profile;
    this.url = upstreamUrl(profile);
    this.key = key;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async send(forward: Forward, signal: AbortSignal): Promise<ProviderAnswer> {
    if (forward.url !== this.url) throw new Error("upstream_not_allowed");
    const names = Object.keys(forward.headers).map((n) => n.toLowerCase());
    const fixed = Object.keys(this.profile.headers).map((n) => n.toLowerCase());
    if (names.length !== fixed.length || names.some((n) => !fixed.includes(n))) throw new Error("headers_not_allowed");
    let response: Response;
    try {
      response = await this.fetch(this.url, {
        method: "POST",
        headers: { ...this.profile.headers, "x-api-key": this.key },
        body: forward.body as Uint8Array<ArrayBuffer>,
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw new Error(failureCode(error, signal));
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let cut = false;
    if (reader) {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw new Error(signal.aborted ? "aborted" : `body_${failureCode(error, signal)}`);
        }
        const { done, value } = chunk;
        if (done) break;
        if (size + value.byteLength > MAX_ANSWER_BYTES) {
          cut = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        size += value.byteLength;
      }
    }
    const body = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.byteLength;
    }
    const usage = cut ? null : answerUsage(response.status, response.headers.get("content-type") ?? "", new TextDecoder().decode(body));
    return { status: response.status, body, usage };
  }
}
