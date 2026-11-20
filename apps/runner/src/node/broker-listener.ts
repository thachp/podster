/**
 * The run's loopback listener (M7 step 9(b); #459's notes for 9(b)), where Claude Code sends its model requests. It is
 * the only file in Runner's source that may open a listening socket (the scoped source test in `test/machine.test.ts`).
 *
 * - **Loopback only:** bound to the literal `"127.0.0.1"`, port 0, so the system picks a free port. **Or, on Linux
 *   (S-47), a Unix socket only:** at a path in the run's own folder (mode 0700), readable and writable by no one else
 *   (Node's `readableAll`/`writableAll` off, then mode 0600 set and checked, with its owner, before anything is served).
 *   The relay container mounts that one socket, read-only, and forwards to it; no TCP port is opened at all.
 * - **A per-run token:** 32 random bytes, which Claude Code sends as its API key. It is compared byte for byte in
 *   constant time, after a length check that reveals only the token's fixed length. It is not the provider key, which never leaves the transport.
 * - **`Origin` refused:** any request carrying one is a browser's, and is refused, so no web page can reach it.
 * - **`Host` checked:** exactly `127.0.0.1:<port>`, or the one name its caller fixes (the relay's `relay:8080`, when
 *   Claude Code runs in its own container and reaches this listener only through the relay), so a DNS-rebound name is
 *   refused.
 * - **Closed on a halt:** the run's signal closes the server and every connection.
 * - Hands the broker only the method, the path, the query and the body: no header is ever forwarded. The one query
 *   Claude Code adds, exactly `beta=true`, is dropped here, since nothing of the request reaches the upstream URL and
 *   no beta header is forwarded; any other query goes to the broker, which refuses it.
 *
 * Logs carry codes only, never a body, a header or the token.
 */
import { holdSecret } from "../core/known-secrets.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAX_BODY_BYTES, type BrokerRequest } from "../core/broker.js";
import type { ModelAnswer } from "../core/run-interface.js";

/** `port` is 0 and `url` is `unix:<path>` on a Unix socket. */
export type BrokerListener = { url: string; port: number; token: string; close(): Promise<void> };
/** The longest socket path taken: under every system's `sun_path` (104 bytes on macOS, 108 on Linux). */
export const MAX_SOCKET_PATH_BYTES = 100;
export type ListenerDeps = {
  model: (request: BrokerRequest) => Promise<ModelAnswer>;
  signal: AbortSignal;
  token?: string;
  /** Told each refusal's fixed code, so a run's report can say why its requests were refused. */
  onRefuse?: (code: string) => void;
  /** The one `Host` taken, when not `127.0.0.1:<port>`: the relay's name, fixed in the driver's code. */
  host?: string;
  /**
   * Listen on this Unix socket instead of loopback TCP (Linux, S-47): an absolute path in a folder only this user can
   * reach, with no file there yet. Needs `host`, the relay's name, which is then the only `Host` taken.
   */
  socket?: string;
  /** For tests; the defaults bound a stalled client. */
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  checkIntervalMs?: number;
};

/**
 * Whether `given` is the token: its raw bytes compared in constant time. A different length is refused before the
 * comparison, which reveals only the length, and the token's length is fixed (64 hex characters, 32 random bytes), so
 * that tells an attacker nothing. No hash in between: CodeQL alert #34 read one as a password hash.
 */
export function tokenMatches(given: unknown, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function respondRefused(res: ServerResponse, status: number, code: string) {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "permission_error", message: `Runner refused this request (${code}).` } }));
}

async function readBody(req: IncomingMessage): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function wantsStream(body: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { stream?: unknown };
    return parsed?.stream === true;
  } catch {
    return false;
  }
}

/** Removes the socket file if it is still there and still a socket; never anything else. */
async function removeSocket(path: string) {
  try {
    if ((await lstat(path)).isSocket()) await unlink(path);
  } catch {
    // Gone already.
  }
}

export async function startBrokerListener(deps: ListenerDeps): Promise<BrokerListener> {
  if (deps.socket !== undefined) {
    if (typeof deps.host !== "string" || deps.host === "") throw new Error("listener_socket_host");
    const p = deps.socket;
    if (typeof p !== "string" || !isAbsolute(p) || normalize(p) !== p || p.includes("\u0000") || Buffer.byteLength(p) > MAX_SOCKET_PATH_BYTES) throw new Error("listener_socket_path");
  }
  const token = deps.token ?? randomBytes(32).toString("hex");
  // Held for exact-match redaction in the local diagnostics file until the listener closes.
  const release = holdSecret(token);
  let port = 0;
  let closed = false;
  const refuse = (res: ServerResponse, status: number, code: string) => {
    try {
      deps.onRefuse?.(code);
    } catch {
      // A report only.
    }
    respondRefused(res, status, code);
  };
  const server = createServer({ connectionsCheckingInterval: deps.checkIntervalMs ?? 5_000, headersTimeout: deps.headersTimeoutMs ?? 30_000, requestTimeout: deps.requestTimeoutMs ?? 120_000 }, async (req, res) => {
    if (closed || deps.signal.aborted) return refuse(res, 503, "run_stopped");
    if (req.headers.origin !== undefined) return refuse(res, 403, "origin_refused");
    if (req.headers.host !== (deps.host ?? `127.0.0.1:${port}`)) return refuse(res, 403, "host_refused");
    if (!tokenMatches(req.headers["x-api-key"], token)) return refuse(res, 401, "token_refused");
    const target = req.url ?? "";
    if (!target.startsWith("/")) return refuse(res, 400, "target_refused");
    const at = target.indexOf("?");
    const path = at < 0 ? target : target.slice(0, at);
    let query = at < 0 ? "" : target.slice(at + 1);
    if (query === "beta=true") query = "";
    const body = await readBody(req).catch(() => null);
    if (body === null) return refuse(res, 413, "body_too_large");
    if (closed || deps.signal.aborted) return refuse(res, 503, "run_stopped");
    let answer: ModelAnswer;
    try {
      answer = await deps.model({ method: req.method ?? "", path, query, body });
    } catch {
      return refuse(res, 502, "upstream_failed");
    }
    if (!answer.ok) return refuse(res, answer.refused === "upstream_failed" ? 502 : 403, answer.refused);
    res.writeHead(answer.status, { "content-type": wantsStream(body) ? "text/event-stream" : "application/json" });
    res.end(Buffer.from(answer.body));
  });
  if (deps.socket !== undefined) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: deps.socket, readableAll: false, writableAll: false }, () => resolve());
    });
    // Mode 0600 and this user's, checked on the file itself, before anything is served. Its folder is the run's, 0700.
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    let safe = false;
    try {
      await chmod(deps.socket, 0o600);
      const info = await lstat(deps.socket);
      safe = info.isSocket() && info.uid === uid && (info.mode & 0o777) === 0o600 && server.address() === deps.socket;
    } catch {
      safe = false;
    }
    if (!safe) {
      server.close();
      await removeSocket(deps.socket);
      throw new Error("listener_socket_unsafe");
    }
  } else {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
      server.close();
      throw new Error("listener_not_loopback");
    }
    port = address.port;
  }
  const close = () =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      closed = true;
      release();
      server.close(() => {
        if (deps.socket === undefined) return resolve();
        void removeSocket(deps.socket).then(resolve);
      });
      server.closeAllConnections();
    });
  if (deps.signal.aborted) await close();
  else deps.signal.addEventListener("abort", () => void close(), { once: true });
  return { url: deps.socket !== undefined ? `unix:${deps.socket}` : `http://127.0.0.1:${port}`, port, token, close };
}
