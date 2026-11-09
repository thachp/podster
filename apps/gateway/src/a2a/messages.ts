import { Role, type SendMessageRequest, type Task } from "@a2a-js/sdk";
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { parseA2aTaskId, readTask, UpstreamError, type ApiReads } from "./reads";

/**
 * M3 step 9: `SendMessage` to an existing task's thread, as MCP's `send_message` (ADR 0007). The message is text for the
 * thread and nothing else: it never moves the task, whatever it says. The room decides whether the caller may post.
 */

/** Decision 123: MCP's 16 KB per message, and at most 8 parts. */
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_PARTS = 8;
/**
 * A `messageId` becomes the API's idempotency key, `a2a-msg:<messageId>`, which holds at most 255 bytes. Its own prefix keeps
 * it apart from the lifecycle's `a2a-lc:` keys and from MCP's, so one ID a client reuses across them can't collide.
 */
const MESSAGE_ID = /^[\x21-\x7e]{1,200}$/;
export const idempotencyKey = (messageId: string) => `a2a-msg:${messageId}`;

/** A link Podster will keep, by the same rule as a submission's links in `crates/core`: `https`, a host, no credentials. */
export function externalLink(uri: unknown): uri is string {
  if (typeof uri !== "string" || new TextEncoder().encode(uri).length > 2048 || /[\s\p{Cc}]/u.test(uri) || !uri.startsWith("https://")) return false;
  const host = uri.slice("https://".length).split(/[/?#]/)[0] ?? "";
  return host !== "" && !host.includes("@");
}

/** The thread text a message carries. Every other field of the message is dropped, never read for meaning. */
function textOf(params: SendMessageRequest): { messageId: string; taskId: string; text: string } {
  const message = params.message;
  if (!message) throw new RequestMalformedError("A message is required.");
  if (!MESSAGE_ID.test(message.messageId ?? "")) throw new RequestMalformedError("A messageId is 1 to 200 printable characters with no spaces.");
  if (message.role !== Role.ROLE_USER) throw new RequestMalformedError("A client's message has role ROLE_USER.");
  // Decision 115: no task is created over A2A.
  if (!message.taskId) throw new UnsupportedOperationError("Podster doesn't create tasks over A2A. Send to an existing task's id.");
  if (message.contextId && message.contextId !== message.taskId) throw new RequestMalformedError("contextId must be the task's id.");
  const parts = message.parts ?? [];
  if (parts.length === 0 || parts.length > MAX_PARTS) throw new RequestMalformedError(`A message has 1 to ${MAX_PARTS} parts.`);
  const texts = parts.map((p) => {
    // Decision 121: Podster never fetches a file reference, and inline bytes are refused. A URL is kept as an external link
    // in the text, the URL alone, so nothing the client labels it with dresses it up.
    if (p.content?.$case === "text") return p.content.value;
    if (p.content?.$case === "url") {
      if (!externalLink(p.content.value)) throw new RequestMalformedError("A url part is an https URL with a host and no credentials or spaces, of at most 2048 bytes.");
      return `Link from the client: ${p.content.value}`;
    }
    throw new RequestMalformedError("Only text and url parts are accepted. Upload a file with create_upload instead.");
  });
  const text = texts.join("\n\n");
  if (text.trim() === "") throw new RequestMalformedError("A message needs some text.");
  if (new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) throw new RequestMalformedError(`A message is at most ${MAX_MESSAGE_BYTES} bytes.`);
  return { messageId: message.messageId, taskId: message.taskId, text };
}

/** What the API's refusals mean over A2A. A task the caller can't see is a task that doesn't exist. */
function refusal(status: number, body: any): Error {
  const code = body?.error?.code;
  if (status === 404 || status === 403 || code === "task_not_found" || code === "workspace_not_found" || code === "not_allowed" || code === "access_revoked" || code === "agent_disconnected") {
    return new TaskNotFoundError("Task not found.");
  }
  if (code === "task_closed") return new UnsupportedOperationError("This task is finished and takes no more messages.");
  if (code === "workspace_archived") return new UnsupportedOperationError("This task's room is archived and takes no more messages.");
  if (code === "idempotency_mismatch") return new RequestMalformedError("This messageId was already used for a different message.");
  if (code === "invalid_argument") return new RequestMalformedError("Podster couldn't post this message.");
  return new UpstreamError(status);
}

/**
 * Posts the message, then answers the task as `GetTask` would. A retry with the same `messageId`, task and text posts
 * nothing new: the API's idempotency record answers it. `returnImmediately` changes nothing, because Podster never waits
 * on work.
 */
export async function sendMessage(api: ApiReads, callerId: string, params: SendMessageRequest): Promise<Task> {
  const { messageId, taskId, text } = textOf(params);
  const target = parseA2aTaskId(taskId);
  if (!target) throw new TaskNotFoundError("Task not found.");
  const { status, body } = await api.sendMessage(target.workspaceId, target.taskId, text, idempotencyKey(messageId));
  if (status !== 200) throw refusal(status, body);
  return readTask(api, callerId, taskId, params.configuration?.historyLength);
}
