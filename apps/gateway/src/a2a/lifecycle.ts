import { Task } from "@a2a-js/sdk";
import { ExtensionSupportRequiredError, RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { parseA2aTaskId, readTask, UpstreamError, type ApiReads } from "./reads";
import { toA2aTask } from "./tasks";

/**
 * M3 step 10: Podster's lifecycle extension (decision 113, ADR 0007). Plain A2A has no accept or submit, and a message's
 * text must never become a command, so these are their own JSON-RPC methods. Each one is the existing capability, called
 * as the agent the token resolved to, so policy and the state machine decide exactly as they do for MCP.
 *
 * A client activates the extension by naming it in `A2A-Extensions`. Without that, the methods answer
 * `ExtensionSupportRequiredError`, and reading and messages work as before.
 */

export const LIFECYCLE_URI = "https://podster.dev/a2a/lifecycle/v1";

/** Method names carry the extension's name and version, so they can't collide with A2A's own. */
export const LIFECYCLE_METHODS = {
  "podster.lifecycle.v1.AcceptTask": "accept_task",
  "podster.lifecycle.v1.DeclineTask": "decline_task",
  "podster.lifecycle.v1.ReleaseTask": "release_task",
  "podster.lifecycle.v1.SubmitTask": "submit_task",
} as const;
export type LifecycleMethod = keyof typeof LIFECYCLE_METHODS;
export const isLifecycleMethod = (method: unknown): method is LifecycleMethod => typeof method === "string" && Object.hasOwn(LIFECYCLE_METHODS, method);

/** Which extensions a request named in `A2A-Extensions`. */
export const activated = (header: string | null) => (header ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** A `requestId` becomes the API's idempotency key, `a2a:<requestId>`, which holds at most 255 bytes. */
const REQUEST_ID = /^[\x21-\x7e]{1,200}$/;
const MAX_REASON_BYTES = 4 * 1024;
const MAX_NOTE_BYTES = 16 * 1024;
const MAX_ARTIFACTS = 10;

const bytes = (s: string) => new TextEncoder().encode(s).length;
const malformed = (why: string) => new RequestMalformedError(why);

/** The parameters each method takes. Anything else is refused, so nothing a client adds is read for meaning. */
const ALLOWED: Record<LifecycleMethod, string[]> = {
  "podster.lifecycle.v1.AcceptTask": ["id", "version", "requestId", "reason"],
  "podster.lifecycle.v1.DeclineTask": ["id", "version", "requestId", "reason"],
  "podster.lifecycle.v1.ReleaseTask": ["id", "version", "requestId", "reason"],
  "podster.lifecycle.v1.SubmitTask": ["id", "version", "requestId", "note", "artifacts"],
};

type Parsed = { workspaceId: string; taskId: string; a2aId: string; requestId: string; args: Record<string, unknown> };

function parse(method: LifecycleMethod, params: unknown): Parsed {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw malformed("params must be an object.");
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(p)) if (!ALLOWED[method].includes(key)) throw malformed(`${method} takes no ${key}.`);
  const target = parseA2aTaskId(p.id);
  if (!target) throw new TaskNotFoundError("Task not found.");
  if (!Number.isSafeInteger(p.version) || (p.version as number) < 1) throw malformed("version is the task's podster.dev/version, a positive integer.");
  if (typeof p.requestId !== "string" || !REQUEST_ID.test(p.requestId)) throw malformed("requestId is 1 to 200 printable characters with no spaces.");
  const args: Record<string, unknown> = { version: p.version };
  const needsReason = method === "podster.lifecycle.v1.DeclineTask" || method === "podster.lifecycle.v1.ReleaseTask";
  if (p.reason !== undefined || needsReason) {
    if (typeof p.reason !== "string" || p.reason.trim() === "" || bytes(p.reason) > MAX_REASON_BYTES) throw malformed(`reason is text of at most ${MAX_REASON_BYTES} bytes${needsReason ? ", and required here" : ""}.`);
    args.reason = p.reason;
  }
  if (method === "podster.lifecycle.v1.SubmitTask") {
    if (p.note !== undefined) {
      if (typeof p.note !== "string" || bytes(p.note) > MAX_NOTE_BYTES) throw malformed(`note is text of at most ${MAX_NOTE_BYTES} bytes.`);
      args.note = p.note;
    }
    // Links only for now. Files arrive with step 14, through create_upload.
    const artifacts = p.artifacts ?? [];
    if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS) throw malformed(`artifacts is a list of at most ${MAX_ARTIFACTS} links.`);
    args.artifacts = artifacts.map((a) => {
      if (!a || typeof a !== "object" || typeof (a as any).uri !== "string" || typeof (a as any).label !== "string" || Object.keys(a).some((k) => k !== "uri" && k !== "label")) {
        throw malformed("Each artifact is { uri, label }.");
      }
      return { uri: (a as any).uri, label: (a as any).label };
    });
  }
  return { ...target, a2aId: p.id as string, requestId: p.requestId, args };
}

const HIDDEN = new Set(["task_not_found", "workspace_not_found", "not_allowed", "access_revoked", "agent_disconnected"]);
/** Fixed API codes that mean the request itself can't be done as sent. They're named in the answer, never a body. */
const MALFORMED = new Set(["invalid_argument", "limit_exceeded", "commit_changed", "submission_mismatch", "self_sign_off"]);

function refusal(status: number, body: any): Error {
  const code = body?.error?.code;
  if (status === 404 || status === 403 || HIDDEN.has(code)) return new TaskNotFoundError("Task not found.");
  if (code === "version_conflict") return malformed("The task has changed since that version. Read it again with GetTask.");
  if (code === "invalid_transition") return new UnsupportedOperationError("The task's current state doesn't allow that.");
  if (code === "workspace_archived") return new UnsupportedOperationError("This task's room is archived.");
  if (code === "idempotency_mismatch") return malformed("This requestId was already used for a different request.");
  if (typeof code === "string" && MALFORMED.has(code)) return malformed(`Podster couldn't do that: ${code}.`);
  return new UpstreamError(status);
}

/**
 * One lifecycle call, answered with the task as `GetTask` reads it afterwards. A retry with the same `requestId`, task
 * and parameters does nothing new: the API's idempotency record answers it.
 */
export async function runLifecycle(api: ApiReads, callerId: string, method: LifecycleMethod, params: unknown, extensions: string[]): Promise<Task> {
  if (!extensions.includes(LIFECYCLE_URI)) throw new ExtensionSupportRequiredError(`Name ${LIFECYCLE_URI} in A2A-Extensions to call ${method}.`);
  const parsed = parse(method, params);
  const { status, body } = await api.command(LIFECYCLE_METHODS[method], { workspace_id: parsed.workspaceId, task_id: parsed.taskId, ...parsed.args }, `a2a:${parsed.requestId}`);
  if (status !== 200) throw refusal(status, body);
  try {
    return await readTask(api, callerId, parsed.a2aId);
  } catch (error) {
    // A decline or a release can leave the caller unable to see the task any more. The command already answered with
    // the task as it now is, so that's the answer, with no history, rather than a "not found" for something that worked.
    if (error instanceof TaskNotFoundError && body?.id === parsed.taskId) return toA2aTask(parsed.a2aId, body, callerId);
    throw error;
  }
}
