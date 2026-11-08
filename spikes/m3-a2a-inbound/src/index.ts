import { A2A_VERSION_HEADER } from "@a2a-js/sdk";
import { defaultServerCallContextBuilder, JsonRpcTransportHandler, validateVersion } from "@a2a-js/sdk/server";
import { UnsupportedOperationError, toJsonRpcError } from "@a2a-js/sdk/errors";
import { cardJson, PodsterHandler } from "./handler";
import { resetRoom } from "./room";

type Env = { BASE_URL: string; SPIKE_TOKENS: string; SPIKE_RESET?: string };

/** One request's body, at most this. A message is 16 KB, so this leaves room for the envelope and parts. */
const MAX_BODY_BYTES = 64 * 1024;
const STREAMING = new Set(["SendStreamingMessage", "SubscribeToTask"]);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const rpcError = (id: unknown, error: unknown) => json({ jsonrpc: "2.0", id: id ?? null, error: toJsonRpcError(error) });

/** Stands in for spike B: a bearer token maps to one agent identity, or nothing. */
function agentFor(request: Request, env: Env): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  if (!match) return null;
  const tokens = JSON.parse(env.SPIKE_TOKENS) as Record<string, string>;
  return Object.hasOwn(tokens, match[1]) ? tokens[match[1]] : null;
}

async function boundedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value as Uint8Array<ArrayBuffer>);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const handler = new PodsterHandler(env.BASE_URL);

    if (url.pathname === "/.well-known/agent-card.json" && request.method === "GET") {
      return json(cardJson(env.BASE_URL), 200, { "cache-control": "public, max-age=300" });
    }
    if (url.pathname === "/spike/reset" && request.method === "POST" && env.SPIKE_RESET === "1") {
      resetRoom();
      return new Response(null, { status: 204 });
    }
    if (url.pathname !== "/a2a") return json({ error: "not_found" }, 404);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });

    // Spec 7.4: authenticate before anything that could reveal whether a resource exists.
    const agent = agentFor(request, env);
    if (!agent) return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="a2a"' });

    const type = request.headers.get("content-type") ?? "";
    if (!/^application\/(a2a\+)?json\b/.test(type)) return json({ error: "unsupported_media_type" }, 415);
    const text = await boundedText(request);
    if (text === null) return json({ error: "payload_too_large" }, 413);

    let id: unknown = null;
    let method: unknown;
    try {
      const parsed = JSON.parse(text);
      id = parsed?.id ?? null;
      method = parsed?.method;
    } catch {
      // The transport handler answers malformed JSON itself.
    }

    const context = defaultServerCallContextBuilder({
      extensions: undefined,
      user: { isAuthenticated: true, userName: agent },
      headers: Object.fromEntries(request.headers),
      requestedVersion: request.headers.get(A2A_VERSION_HEADER) ?? undefined,
    } as any);
    try {
      // Spec 3.6.2: no header means 0.3, and only 1.0 is supported (decision 109).
      validateVersion(context.requestedVersion, await handler.getAgentCard(), "JSONRPC");
    } catch (error) {
      return rpcError(id, error);
    }
    // Decision 110: no streaming. Answered here, so nothing ever holds a response open.
    if (typeof method === "string" && STREAMING.has(method)) return rpcError(id, new UnsupportedOperationError("Streaming isn't supported."));

    const result = await new JsonRpcTransportHandler(handler).handle(text, context);
    if (result && typeof (result as any)[Symbol.asyncIterator] === "function") {
      return rpcError(id, new UnsupportedOperationError("Streaming isn't supported."));
    }
    return json(result, 200, { [A2A_VERSION_HEADER]: "1.0" });
  },
};
