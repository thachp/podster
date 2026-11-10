import { A2A_VERSION_HEADER } from "@a2a-js/sdk";
import { defaultServerCallContextBuilder, JsonRpcTransportHandler, validateVersion, type User } from "@a2a-js/sdk/server";
import { ContentTypeNotSupportedError, toJsonRpcError, UnsupportedOperationError, VersionNotSupportedError } from "@a2a-js/sdk/errors";
import { agentCard } from "./card";
import { Task } from "@a2a-js/sdk";
import { guarded, PodsterA2AHandler } from "./handler";
import { activated, isLifecycleMethod, LIFECYCLE_URI, runLifecycle } from "./lifecycle";
import { INCOMPLETE_HEADER, type ApiReads, type ReadNotes } from "./reads";
import { A2A_BINDING, A2A_METHODS, A2A_PATH, A2A_VERSION, CARD_PATH, MAX_A2A_BODY_BYTES } from "./profile";

/**
 * The gateway's A2A surface: Podster's Agent Card, and JSON-RPC on `POST /a2a`. The gateway only translates. Rust will
 * decide every command, as it does for MCP. Logs carry nothing from a request.
 *
 * The order, as the M3 step 7 review set it:
 * 1. The gateway's per-client limit, which runs for every request before routing.
 * 2. `checkA2aRequest`: method, content type, a 64 KB body read once, and `A2A-Version`. None of it reveals anything.
 * 3. Authentication, by the `/a2a` resource server, so only a token whose audience is `/a2a` gets further.
 * 4. The agent's own limit, in the same bucket as MCP (decision 123), in the gateway's `/a2a` handler.
 * 5. `answerA2a`: parsing, streaming refused, and the handler.
 */

const A2A_EXTENSIONS_HEADER = "A2A-Extensions";
const STREAMING = new Set(["SendStreamingMessage", "SubscribeToTask"]);
const VERSION_HEADERS = { [A2A_VERSION_HEADER]: A2A_VERSION };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...VERSION_HEADERS, ...headers } });

const httpError = (code: string, status: number, headers: Record<string, string> = {}) => json({ error: { code, message: code } }, status, headers);

/** JSON-RPC allows an id that's a string, a number or null. Anything else isn't echoed back. */
const safeId = (id: unknown) => (typeof id === "string" || (typeof id === "number" && Number.isFinite(id)) ? id : null);

const rpcError = (id: unknown, error: unknown) => json({ jsonrpc: "2.0", id: safeId(id), error: toJsonRpcError(error) });

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

/** Podster's one public card, on the gateway's host. `null` for every other path. */
export function handleA2aCard(request: Request, url: URL, baseUrl: string): Response | null {
  if (url.pathname !== CARD_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return httpError("method_not_allowed", 405, { allow: "GET, HEAD" });
  const { body, etag } = cardFor(baseUrl);
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=300", etag, ...VERSION_HEADERS };
  // Compared weakly: Cloudflare may weaken an ETag when it compresses, and a client then sends it back as `W/"…"`.
  const match = request.headers.get("if-none-match");
  if (match && match.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag || tag.trim() === "*")) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}

/** The card's body and a strong validator from its own bytes (A2A's CARD-CACHE-002 SHOULD), made once per base URL. */
const cards = new Map<string, { body: string; etag: string }>();
function cardFor(baseUrl: string) {
  let card = cards.get(baseUrl);
  if (!card) {
    const body = JSON.stringify(agentCard(baseUrl));
    card = { body, etag: `"${fnv1a64(body)}"` };
    cards.set(baseUrl, card);
  }
  return card;
}

/** 64-bit FNV-1a over the UTF-16 code units, as 16 hex digits. Only for telling one card body from another. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export const isA2aPath = (url: URL) => url.pathname === A2A_PATH;

/** A version header longer than this is never a version: `999.999.999999`. */
const MAX_VERSION_LENGTH = 14;
/** `major.minor`, with an optional `.patch`: digits only, no leading zeros, bounded. Nothing else is read as a version. */
const VERSION = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:\.(0|[1-9]\d{0,5}))?$/;

/**
 * The version a request asks for, as negotiation reads it (decision 192). Patch numbers never count (spec 3.6), so `1.0.7` asks
 * for `1.0`. A missing header is 0.3 (spec 3.6.2). Anything that isn't exactly a version, such as a range, a prefix, a
 * suffix, a list from a repeated header, or an overlong value, is passed on as it is, and the check refuses it as before.
 */
export function requestedVersion(header: string | null): string {
  if (header === null) return "0.3";
  if (header.length > MAX_VERSION_LENGTH) return header;
  const match = VERSION.exec(header);
  return match ? `${match[1]}.${match[2]}` : header;
}

/**
 * `/a2a/` is `/a2a`, for clients that join the card's interface URL with a slash, as the A2A compatibility kit's does (decision
 * 190). Only that one path: the request is rewritten before anything else sees it, so every check, limit, credential and
 * answer is `/a2a`'s. No other path is normalized.
 */
export function aliasA2aPath(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname !== `${A2A_PATH}/`) return request;
  url.pathname = A2A_PATH;
  return new Request(url.href, request);
}

/**
 * Everything that comes before authentication. It answers a refusal, or the body, read once, for `answerA2a`. The version
 * check needs no credential and reveals nothing, so a client on the wrong version hears so before it signs in.
 */
export async function checkA2aRequest(request: Request, baseUrl: string): Promise<Response | { text: string }> {
  if (request.method !== "POST") return httpError("method_not_allowed", 405, { allow: "POST" });
  const type = request.headers.get("content-type") ?? "";
  // Still 415, but as a JSON-RPC error, so a JSON-RPC client reads it as one. The body isn't read, so the id is null.
  if (!/^application\/(a2a\+)?json\s*(;|$)/i.test(type)) {
    return json({ jsonrpc: "2.0", id: null, error: toJsonRpcError(new ContentTypeNotSupportedError("Send application/json.")) }, 415);
  }
  const text = await boundedText(request);
  if (text === null) return httpError("payload_too_large", 413);
  try {
    // Decision 109: only 1.0. A patch of it, such as 1.0.1, is 1.0, since patches never count (decision 192, spec 3.6). A
    // missing header is read as 0.3 (spec 3.6.2), so it's refused too, as is anything that isn't strictly a version.
    validateVersion(requestedVersion(request.headers.get(A2A_VERSION_HEADER)), await new PodsterA2AHandler(baseUrl).getAgentCard(), A2A_BINDING);
  } catch (error) {
    return rpcError(envelope(text).id, error instanceof VersionNotSupportedError ? error : new VersionNotSupportedError("Only A2A 1.0 is supported."));
  }
  return { text };
}

/**
 * After authentication: one JSON-RPC request from one agent. `agentId` is what the gateway resolved from the token, never
 * anything the client sent. A request's `tenant` reaches the SDK's context, and Podster never reads it for authority.
 */
export async function answerA2a(text: string, agentId: string, baseUrl: string, api: ApiReads, extensionsHeader: string | null = null): Promise<Response> {
  const { id, method } = envelope(text);
  // Step 10: the lifecycle extension's own methods, which the SDK's transport doesn't know.
  if (isLifecycleMethod(method)) {
    const extensions = activated(extensionsHeader);
    // A command runs only for a request that expects an answer: JSON-RPC 2.0, with an id. A notification, which has none,
    // runs nothing.
    const request = JSON.parse(text) as { jsonrpc?: unknown; id?: unknown; params?: unknown };
    if (request.jsonrpc !== "2.0" || !(typeof request.id === "string" || (typeof request.id === "number" && Number.isFinite(request.id)))) {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: a lifecycle method needs jsonrpc \"2.0\" and an id." } });
    }
    try {
      const params = request.params;
      const task = await guarded(method, agentId, () => runLifecycle(api, agentId, method, params, extensions));
      return json({ jsonrpc: "2.0", id: safeId(id), result: Task.toJSON(task) }, 200, { [A2A_EXTENSIONS_HEADER]: LIFECYCLE_URI });
    } catch (error) {
      return rpcError(id, error);
    }
  }
  // Decision 110: no streaming, refused here so nothing ever holds a response open.
  if (typeof method === "string" && STREAMING.has(method)) return rpcError(id, new UnsupportedOperationError("Streaming isn't supported."));
  // Only the profile's operations reach the handler. Anything else is "method not found", exactly.
  if (typeof method === "string" && !Object.hasOwn(A2A_METHODS, method)) {
    return json({ jsonrpc: "2.0", id: safeId(id), error: { code: -32601, message: "Method not found" } });
  }
  const user: User = { isAuthenticated: true, userName: agentId };
  const context = defaultServerCallContextBuilder({ extensions: undefined, user, headers: {}, requestedVersion: A2A_VERSION });
  const notes: ReadNotes = {};
  const result = await new JsonRpcTransportHandler(new PodsterA2AHandler(baseUrl, { agentId, api, notes })).handle(text, context);
  if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    return rpcError(id, new UnsupportedOperationError("Streaming isn't supported."));
  }
  const body = result as { id?: unknown };
  // A list that left rooms out says so here, because A2A's list response has no field for it.
  return json({ ...body, id: safeId(body.id) }, 200, notes.incompleteRooms ? { [INCOMPLETE_HEADER]: "rooms" } : {});
}
