/**
 * The inbound nudge's listener (M7 step 14; S-13), the second file in Runner's source that may open a listening socket
 * (the scoped source test in `test/machine.test.ts`). It exists only while `run` has `--nudge-listen` and `--nudge-url`.
 *
 * - **Loopback only:** bound to the literal `"127.0.0.1"`, at the port the owner names. Podster reaches it only at the
 *   owner's public HTTPS address (decision 236), through a reverse proxy or tunnel the owner runs on this machine, which
 *   terminates TLS and forwards to this port with the path unchanged. Runner opens nothing to the network itself.
 * - **Bounded:** headers within 5 s and the whole request within 10 s, small headers, few connections, and every answer
 *   closes its connection. The body is read only when `NudgeEndpoint` asks for it, after its rate check, one chunk at a
 *   time straight from the request, with each request's own buffer held to `MAX_NUDGE_BODY_BYTES`. The moment the count
 *   passes that, the socket is destroyed, so no more is buffered whatever the client sends.
 * - **A server error after it starts** (EMFILE, say) is logged as a code and closes the listener. It never reaches the
 *   process's uncaught-exception handler, so polling goes on.
 * - **Nothing but the endpoint:** each request goes to `NudgeEndpoint.handle` as a Web `Request`, and its answer back.
 *   It can only ring the poll loop's bell.
 * - **Closed on stop:** the run's signal, or `close()`, closes the server and every connection.
 *
 * Logs carry codes only, never a body, a header or an address.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { MAX_NUDGE_BODY_BYTES, type NudgeEndpoint } from "../core/nudge.js";
import type { Logger } from "../core/runtime.js";

export type NudgeListener = { port: number; close(): Promise<void>; closed: Promise<void> };

/** Connections served at once. **Proposed.** */
export const MAX_CONNECTIONS = 16;

/**
 * The owner's `--nudge-listen`: a port, or `127.0.0.1:<port>`. Any other address is refused: Runner listens only on
 * loopback, and the owner's proxy or tunnel is what faces the network.
 */
export function parseListen(value: string): { port: number } {
  const match = /^(?:127\.0\.0\.1:)?(\d{1,5})$/.exec(value);
  const port = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--nudge-listen takes a port, or 127.0.0.1:<port>. Runner listens only on loopback; your proxy or tunnel faces the network.");
  return { port };
}

/**
 * The request's body as a stream that reads `req` only when pulled, one chunk at a time, counting bytes, and destroys the
 * socket the moment the count passes `max`. Not `Readable.toWeb`, whose own buffering isn't bounded by this count.
 */
function boundedBody(req: IncomingMessage, max: number): ReadableStream<Uint8Array> {
  const chunks = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let total = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await chunks.next();
          if (done) return controller.close();
          total += value.byteLength;
          if (total > max) {
            req.socket.destroy();
            return controller.error(new Error("too_large"));
          }
          controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        } catch {
          controller.error(new Error("unreadable"));
        }
      },
      cancel() {
        req.socket.destroy();
      },
    },
    { highWaterMark: 0 },
  );
}

function requestOf(req: IncomingMessage, port: number): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const method = req.method ?? "GET";
  const target = (req.url ?? "/").startsWith("/") ? (req.url ?? "/") : "/";
  const body = method === "GET" || method === "HEAD" ? undefined : boundedBody(req, MAX_NUDGE_BODY_BYTES);
  return new Request(`http://127.0.0.1:${port}${target}`, { method, headers, body, duplex: "half" } as RequestInit);
}

export type NudgeListenerDeps = {
  port: number;
  endpoint: Pick<NudgeEndpoint, "handle">;
  signal: AbortSignal;
  log?: Logger;
  /** For tests: the server, once listening. */
  onServer?: (server: Server) => void;
};

export async function startNudgeListener(deps: NudgeListenerDeps): Promise<NudgeListener> {
  let port = 0;
  let closing: Promise<void> | null = null;
  let opened: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (opened = resolve));
  const server = createServer({ highWaterMark: MAX_NUDGE_BODY_BYTES, headersTimeout: 5_000, requestTimeout: 10_000, connectionsCheckingInterval: 1_000, maxHeaderSize: 8 * 1024, keepAliveTimeout: 1_000 }, (req, res) => {
    const finish = (status: number, headers: Record<string, string>, body: Uint8Array) => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(status, { ...headers, connection: "close" });
      res.end(body);
    };
    if (closing) return finish(503, {}, new Uint8Array());
    let request: Request;
    try {
      request = requestOf(req, port);
    } catch {
      return finish(400, {}, new Uint8Array());
    }
    deps.endpoint.handle(request).then(
      async (answer) => {
        const headers: Record<string, string> = {};
        const type = answer.headers.get("content-type");
        if (type) headers["content-type"] = type;
        // What the endpoint didn't read is never read: every answer closes its connection.
        finish(answer.status, headers, new Uint8Array(await answer.arrayBuffer()));
      },
      () => finish(500, {}, new Uint8Array()),
    );
  });
  server.maxConnections = MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    server.close();
    throw new Error("listener_not_loopback");
  }
  port = address.port;
  // From here on, an error is the listener's end, never the process's (review 2 on #473).
  server.on("error", (error: NodeJS.ErrnoException) => {
    const code = typeof error?.code === "string" && /^E[A-Z]{1,30}$/.test(error.code) ? error.code.toLowerCase() : "unknown";
    deps.log?.("nudge.listen", "server_error", { code });
    void close();
  });
  const close = () => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }).then(opened);
    return closing;
  };
  if (deps.signal.aborted) await close();
  else deps.signal.addEventListener("abort", () => void close(), { once: true });
  deps.onServer?.(server);
  return { port, close, closed };
}
