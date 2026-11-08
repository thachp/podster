import { A2A_VERSION_HEADER } from "@a2a-js/sdk";
import { defaultServerCallContextBuilder, JsonRpcTransportHandler, UnauthenticatedUser, validateVersion } from "@a2a-js/sdk/server";
import { toJsonRpcError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { agentCard } from "./card";
import { PodsterA2AHandler } from "./handler";
import { A2A_BINDING, A2A_PATH, CARD_PATH, MAX_A2A_BODY_BYTES } from "./profile";

/**
 * The gateway's A2A surface: Podster's Agent Card, and JSON-RPC on `POST /a2a`. The gateway only translates. Rust will
 * decide every command, as it does for MCP. Logs carry nothing from a request.
 *
 * Before the handler, in ADR 0007's order: the gateway's per-client limit has already run for every request, then the
 * content type and size, then `A2A-Version`, then streaming. Authentication and the agent's own limit arrive with step 7,
 * between the per-client limit and the content type.
 */

const STREAMING = new Set(["SendStreamingMessage", "SubscribeToTask"]);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const rpcError = (id: unknown, error: unknown) => json({ jsonrpc: "2.0", id: id ?? null, error: toJsonRpcError(error) });

/** Reads at most `MAX_A2A_BODY_BYTES`, counting what arrives, because a chunked body declares no length. */
async function boundedText(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_A2A_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_A2A_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value as Uint8Array<ArrayBuffer>);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

/** The id and method, if the body is a JSON-RPC object, so an early refusal can answer in kind. */
function envelope(text: string): { id: unknown; method: unknown } {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { id: parsed.id ?? null, method: parsed.method } : { id: null, method: undefined };
  } catch {
    return { id: null, method: undefined };
  }
}

/** Answers the card and `/a2a`, and `null` for every other path. */
export async function handleA2a(request: Request, url: URL, baseUrl: string): Promise<Response | null> {
  if (url.pathname === CARD_PATH) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: { code: "method_not_allowed", message: "method_not_allowed" } }, 405, { allow: "GET, HEAD" });
    return json(agentCard(baseUrl), 200, { "cache-control": "public, max-age=300" });
  }
  if (url.pathname !== A2A_PATH) return null;
  if (request.method !== "POST") return json({ error: { code: "method_not_allowed", message: "method_not_allowed" } }, 405, { allow: "POST" });

  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/(a2a\+)?json\s*(;|$)/i.test(type)) return json({ error: { code: "unsupported_media_type", message: "unsupported_media_type" } }, 415);
  const text = await boundedText(request);
  if (text === null) return json({ error: { code: "payload_too_large", message: "payload_too_large" } }, 413);
  const { id, method } = envelope(text);

  const handler = new PodsterA2AHandler(baseUrl);
  const context = defaultServerCallContextBuilder({
    extensions: undefined,
    user: new UnauthenticatedUser(),
    headers: {},
    requestedVersion: request.headers.get(A2A_VERSION_HEADER) ?? undefined,
  } as never);
  try {
    // Decision 109: only 1.0. A missing header is read as 0.3 (spec 3.6.2), so it's refused too.
    validateVersion(context.requestedVersion, await handler.getAgentCard(), A2A_BINDING);
  } catch (error) {
    return rpcError(id, error);
  }
  // Decision 110: no streaming, refused here so nothing ever holds a response open.
  if (typeof method === "string" && STREAMING.has(method)) return rpcError(id, new UnsupportedOperationError("Streaming isn't supported."));

  const result = await new JsonRpcTransportHandler(handler).handle(text, context);
  if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    return rpcError(id, new UnsupportedOperationError("Streaming isn't supported."));
  }
  return json(result, 200, { [A2A_VERSION_HEADER]: "1.0" });
}
