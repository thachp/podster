/**
 * The inbound nudge's listener (M7 step 14; S-13), the second file in Runner's source that may open a listening socket
 * (the scoped source test in `test/machine.test.ts`). It exists only while `run` has `--nudge-listen` and `--nudge-url`.
 *
 * - **Loopback only:** bound to the literal `"127.0.0.1"`, at the port the owner names. Podster reaches it only at the
 *   owner's public HTTPS address (decision 236), through a reverse proxy or tunnel the owner runs on this machine, which
 *   terminates TLS and forwards to this port with the path unchanged. Runner opens nothing to the network itself.
 * - **Bounded:** headers within 5 s and the whole request within 10 s, small headers, few connections, and every answer
 *   closes its connection. The body is read only by `NudgeEndpoint`, which rate-limits before it reads and reads no
 *   more than `MAX_NUDGE_BODY_BYTES`.
 * - **Nothing but the endpoint:** each request goes to `NudgeEndpoint.handle` as a Web `Request`, and its answer back.
 *   It can only ring the poll loop's bell.
 * - **Closed on stop:** the run's signal, or `close()`, closes the server and every connection.
 *
 * Logs carry codes only, never a body, a header or an address.
 */
import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { NudgeEndpoint } from "../core/nudge.js";

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

function requestOf(req: IncomingMessage, port: number): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const method = req.method ?? "GET";
  const target = (req.url ?? "/").startsWith("/") ? (req.url ?? "/") : "/";
  const body = method === "GET" || method === "HEAD" ? undefined : (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>);
  return new Request(`http://127.0.0.1:${port}${target}`, { method, headers, body, duplex: "half" } as RequestInit);
}

export async function startNudgeListener(deps: { port: number; endpoint: NudgeEndpoint; signal: AbortSignal }): Promise<NudgeListener> {
  let port = 0;
  let closing: Promise<void> | null = null;
  let opened: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (opened = resolve));
  const server = createServer({ headersTimeout: 5_000, requestTimeout: 10_000, connectionsCheckingInterval: 1_000, maxHeaderSize: 8 * 1024, keepAliveTimeout: 1_000 }, (req, res) => {
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
  const close = () => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }).then(opened);
    return closing;
  };
  if (deps.signal.aborted) await close();
  else deps.signal.addEventListener("abort", () => void close(), { once: true });
  return { port, close, closed };
}
