import { Task } from "@a2a-js/sdk";
import { A2AError, ExtensionSupportRequiredError, RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
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

/**
 * Method names carry the extension's name and version, so they can't collide with A2A's own. The engineer's three steps
 * (the architect's ruling of 2026-11-14) added `ClaimRole`, `GetRepoAccess`, and `SubmitTask`'s commit and pull request.
 */
export const LIFECYCLE_METHODS = {
  "podster.lifecycle.v1.AcceptTask": "accept_task",
  "podster.lifecycle.v1.DeclineTask": "decline_task",
  "podster.lifecycle.v1.ReleaseTask": "release_task",
  "podster.lifecycle.v1.SubmitTask": "submit_task",
  "podster.lifecycle.v1.ClaimRole": "claim_role",
  "podster.lifecycle.v1.GetRepoAccess": "get_repo_access",
  "podster.lifecycle.v1.DeployRelease": "deploy_release",
} as const;
export type LifecycleMethod = keyof typeof LIFECYCLE_METHODS;
export const isLifecycleMethod = (method: unknown): method is LifecycleMethod => typeof method === "string" && Object.hasOwn(LIFECYCLE_METHODS, method);

/** The one method that exists only while managed repositories are switched on, as MCP's `get_repo_access` tool does. */
export const REPOSITORY_METHOD = "podster.lifecycle.v1.GetRepoAccess";

/**
 * The one method that exists only while the API answers the release routes (M6 step 6, 6g), as MCP's `deploy_release`
 * tool does: an agent asks for a release of a task's merged commit.
 */
export const RELEASE_METHOD = "podster.lifecycle.v1.DeployRelease";

/**
 * Every capability an `/a2a` token reaches, and nothing else: the reads behind `GetTask` and `ListTasks`, `SendMessage`'s
 * post, and the lifecycle methods. `packages/contracts/capabilities.yaml` lists the same set under `a2a`, and a test holds
 * the two together, so the token's reach can't widen without a contract change. The API still decides every call.
 */
export const A2A_CAPABILITIES = ["get_task", "list_tasks", "list_workspaces", "send_message", ...Object.values(LIFECYCLE_METHODS)] as const;

/** What one lifecycle call answers: the task, as `GetTask` reads it, or for the methods that aren't about one task, a plain object. */
export type LifecycleResult = { task: Task } | { value: Record<string, unknown> };

/**
 * Options the gateway works out, never from the request: its own managed-repository switch, and whether the API itself
 * said it answers the release routes now. A missing `releases` is no.
 */
export type LifecycleOptions = { managedRepositories: boolean; releases?: boolean };

/** Whether a method exists under these options: GetRepoAccess only with managed repositories, DeployRelease only with release. */
export const methodListed = (method: string, options: LifecycleOptions) => (method !== REPOSITORY_METHOD || options.managedRepositories) && (method !== RELEASE_METHOD || options.releases === true);

/** Which extensions a request named in `A2A-Extensions`: each comma-separated entry, trimmed. */
export const activated = (header: string | null) => (header ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Whether the lifecycle extension is one of them, compared whole, so a URI that only contains it doesn't count. */
export const lifecycleActive = (extensions: string[]) => extensions.some((uri) => uri === LIFECYCLE_URI);

/** A `requestId` becomes the API's idempotency key, `a2a-lc:<requestId>`, which holds at most 255 bytes, apart from messages' keys. */
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
  "podster.lifecycle.v1.SubmitTask": ["id", "version", "requestId", "note", "artifacts", "files", "commitSha", "prNumber"],
  "podster.lifecycle.v1.ClaimRole": ["workspaceId", "roleId", "requestId"],
  // No requestId: MCP's get_repo_access takes no idempotency key, and the API keeps none, because a stored answer would be
  // a second copy of the token. Asking again is safe.
  "podster.lifecycle.v1.GetRepoAccess": ["id"],
  // The task by its A2A ID, the commit its merge confirmed, and the key: MCP's deploy_release's `task_id` and `commit_sha`.
  "podster.lifecycle.v1.DeployRelease": ["id", "commitSha", "requestId"],
};

/** A path value the API decides on: 1 to 200 printable characters with no spaces. The API answers for one that doesn't exist. */
const PATH_ID = /^[\x21-\x7e]{1,200}$/;

type Parsed = { workspaceId: string; taskId?: string; roleId?: string; a2aId?: string; requestId?: string; args: Record<string, unknown> };

function parse(method: LifecycleMethod, params: unknown, options: LifecycleOptions): Parsed {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw malformed("params must be an object.");
  const p = params as Record<string, unknown>;
  const names = ALLOWED[method];
  for (const key of Object.keys(p)) {
    // A2A's own `tenant` may come along empty. A non-empty one is refused like any other parameter, by name: Podster
    // never reads a client's tenant for anything.
    if (key === "tenant" && (p.tenant === undefined || p.tenant === "")) continue;
    if (!names.includes(key)) throw malformed(`${method} takes no ${key}.`);
  }
  if (method === "podster.lifecycle.v1.ClaimRole") {
    // The room and the opening are the caller's choice to name, as in MCP's claim_role. The room decides whether the
    // caller may claim it: who is claiming comes only from the token.
    if (typeof p.workspaceId !== "string" || !PATH_ID.test(p.workspaceId) || p.workspaceId === "." || p.workspaceId === "..") throw malformed("workspaceId is the room's ID.");
    if (typeof p.roleId !== "string" || !PATH_ID.test(p.roleId) || p.roleId === "." || p.roleId === "..") throw malformed("roleId is the opening's ID.");
    if (typeof p.requestId !== "string" || !REQUEST_ID.test(p.requestId)) throw malformed("requestId is 1 to 200 printable characters with no spaces.");
    return { workspaceId: p.workspaceId, roleId: p.roleId, requestId: p.requestId, args: {} };
  }
  const target = parseA2aTaskId(p.id);
  if (!target) throw new TaskNotFoundError("Task not found.");
  if (method === REPOSITORY_METHOD) return { ...target, a2aId: p.id as string, args: {} };
  if (method === RELEASE_METHOD) {
    // Only the type is checked here, as MCP's tool schema does: the room decides whether it is the task's merged commit.
    if (typeof p.commitSha !== "string" || p.commitSha === "") throw malformed("commitSha is the commit Podster's merge confirmed for the task, as text.");
    if (typeof p.requestId !== "string" || !REQUEST_ID.test(p.requestId)) throw malformed("requestId is 1 to 200 printable characters with no spaces.");
    return { ...target, a2aId: p.id as string, requestId: p.requestId, args: { commit_sha: p.commitSha } };
  }
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
    // Files are only ones the agent uploaded with create_upload for this task (decision 121): this names them, and the API's
    // rules decide whether they may be submitted. Podster never takes bytes or a URL to fetch here.
    // Each list is sent only when given, so the API gets exactly the body MCP's submit_task sends for the same arguments.
    const files = p.files ?? [];
    if (!Array.isArray(files) || files.length > MAX_ARTIFACTS) throw malformed(`files is a list of at most ${MAX_ARTIFACTS} uploads.`);
    const fileList = files.map((f) => {
      const keys = f && typeof f === "object" ? Object.keys(f) : [];
      if (!f || typeof f !== "object" || Array.isArray(f) || typeof (f as any).id !== "string" || keys.some((k) => k !== "id" && k !== "label") || ((f as any).label !== undefined && typeof (f as any).label !== "string")) {
        throw malformed("Each file is { id, label? }, an upload from create_upload for this task.");
      }
      return (f as any).label === undefined ? { id: (f as any).id } : { id: (f as any).id, label: (f as any).label };
    });
    if (p.files !== undefined) args.files = fileList;
    const artifacts = p.artifacts ?? [];
    if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS) throw malformed(`artifacts is a list of at most ${MAX_ARTIFACTS} links.`);
    const artifactList = artifacts.map((a) => {
      if (!a || typeof a !== "object" || typeof (a as any).uri !== "string" || typeof (a as any).label !== "string" || Object.keys(a).some((k) => k !== "uri" && k !== "label")) {
        throw malformed("Each artifact is { uri, label }.");
      }
      return { uri: (a as any).uri, label: (a as any).label };
    });
    if (p.artifacts !== undefined) args.artifacts = artifactList;
    // The commit and the pull request, as MCP's submit_task takes them. Only their types are checked here, as MCP's tool
    // schema does: the API decides whether they're needed, well formed and the task's (M5 step 7a).
    if (p.commitSha !== undefined) {
      if (typeof p.commitSha !== "string") throw malformed("commitSha is the commit's SHA, as text.");
      args.commit_sha = p.commitSha;
    }
    // A task's pull request exists only while managed repositories are on, as MCP's submit_task offers pr_number only
    // then. Off, it's dropped unread, as MCP's tool drops a field it doesn't offer, and never reaches the API.
    if (p.prNumber !== undefined && options.managedRepositories) {
      if (!Number.isSafeInteger(p.prNumber)) throw malformed("prNumber is the pull request's number, a whole number.");
      args.pr_number = p.prNumber;
    }
  }
  return { ...target, a2aId: p.id as string, requestId: p.requestId, args };
}

const HIDDEN = new Set(["task_not_found", "workspace_not_found", "not_allowed", "access_revoked", "agent_disconnected"]);
/** Fixed API codes that mean the request itself can't be done as sent. They're named in the answer, never a body. */
const MALFORMED = new Set(["invalid_argument", "limit_exceeded", "commit_changed", "submission_mismatch", "self_sign_off"]);

/** A submission's files, refused after the task itself was found and authorized, so naming them reveals nothing. */
const FILE_REFUSALS = new Set(["file_not_found", "file_not_ready", "file_removed", "duplicate_file", "too_many_artifacts"]);

/**
 * A submission's pull request (M5 step 7a), refused after the task was found and authorized, exactly as MCP's
 * `submit_task` names them. Checked before the status, because `pull_request_not_found` is a 404 about the pull request,
 * not the task.
 */
const PULL_REQUEST_REFUSALS = new Set(["pull_request_not_found", "pull_request_from_fork", "pull_request_wrong_base", "pull_request_not_open", "pull_request_draft", "pull_request_in_use", "pull_request_changed"]);
/** The room's repository can't take a submission now: a state, not the request. */
const REPOSITORY_STATE = new Set(["repo_not_ready", "pull_request_unread", "change_not_found", "task_not_linked"]);

/**
 * Codes an answer may name for a call that can be tried again later. They still answer "Internal error", as any failure
 * of the API does, with the code alongside so an agent knows to wait, as MCP's answer tells it.
 */
const RETRYABLE = new Set(["rate_limited", "standing_unknown", "repo_access_unavailable", "provider_unavailable", "provider_mismatch", "upstream_unavailable"]);

/**
 * `ClaimRole`'s and `GetRepoAccess`'s refusals, by the API's fixed code, so each names exactly what MCP's `claim_role` and
 * `get_repo_access` answer. On a task, the codes every lifecycle method reads as missing (`HIDDEN`) still do, so a task
 * the caller can't act on answers as one that doesn't exist, as AcceptTask's and SubmitTask's do.
 */
const CLAIM_REFUSALS = new Set(["not_allowed", "already_claimed", "role_full", "role_not_found", "workspace_not_found", "access_revoked", "agent_disconnected", "workspace_archived"]);
const REPO_ACCESS_REFUSALS = new Set([
  "grant_required", "grant_expired", "grant_stale", "public_participant", "controller_departed",
  "task_not_linked", "repo_not_ready", "task_not_active", "repo_access_busy", "deadline_passed", "deadline_unknown", "budget_exhausted", "budget_unknown", "workspace_archived",
  // The API's own switch off, while the gateway's is on: it answers as a route that doesn't exist, and MCP says so too.
  "not_found",
]);
/**
 * `DeployRelease`'s refusals, each the room's fixed code as MCP's `deploy_release` answers it (`requestRelease`'s
 * contract): who is asking and where, the grant, what is asked for, and the gate on the release path. `not_found` is the
 * API answering the route as one that doesn't exist, as it does once release is switched off after the card was read.
 */
const RELEASE_REFUSALS = new Set([
  "agent_not_connected", "public_participant", "grant_required", "grant_expired", "grant_stale",
  "release_off_for_deployment", "release_not_delegated", "release_needs_public_room", "workspace_archived", "public_surface_suspended", "app_suspended", "repo_not_ready", "release_off",
  "commit_not_releasable", "reviewer_rule_changed", "no_releaser", "release_pending", "release_limit", "release_not_available",
  "not_found",
]);

/** The API's fixed code, in the error's `ErrorInfo.metadata.code`, so a client can read it as it reads MCP's. */
const named = <E extends A2AError>(make: (o: { message: string; metadata: Record<string, string> }) => E, message: string, code: string) => make({ message, metadata: { code } });
const malformedCode = (message: string, code: string) => named((o) => new RequestMalformedError(o), message, code);
const refusedCode = (message: string, code: string) => named((o) => new UnsupportedOperationError(o), message, code);
const retryLater = (code: string) => named((o) => new A2AError(o), "Internal error", code);

function refusal(status: number, body: any): Error {
  const code = body?.error?.code;
  if (typeof code === "string" && FILE_REFUSALS.has(code)) return malformedCode(`Podster couldn't take those files: ${code}.`, code);
  if (typeof code === "string" && PULL_REQUEST_REFUSALS.has(code)) return malformedCode(`Podster couldn't take that pull request: ${code}.`, code);
  if (typeof code === "string" && REPOSITORY_STATE.has(code)) return refusedCode(`The room's repository can't take that now: ${code}.`, code);
  if (status === 404 || status === 403 || HIDDEN.has(code)) return new TaskNotFoundError("Task not found.");
  if (code === "version_conflict") return malformedCode("The task has changed since that version. Read it again with GetTask.", code);
  if (code === "invalid_transition") return refusedCode("The task's current state doesn't allow that.", code);
  if (code === "workspace_archived") return refusedCode("This task's room is archived.", code);
  if (code === "idempotency_mismatch") return malformedCode("This requestId was already used for a different request.", code);
  if (typeof code === "string" && MALFORMED.has(code)) return malformedCode(`Podster couldn't do that: ${code}.`, code);
  if (typeof code === "string" && RETRYABLE.has(code)) return retryLater(code);
  return new UpstreamError(status);
}

/** A refusal of `ClaimRole`, `GetRepoAccess` or `DeployRelease`, named by its code as MCP names it. */
function namedRefusal(method: LifecycleMethod, status: number, body: any): Error {
  const code = body?.error?.code;
  const refusals = method === "podster.lifecycle.v1.ClaimRole" ? CLAIM_REFUSALS : method === RELEASE_METHOD ? RELEASE_REFUSALS : REPO_ACCESS_REFUSALS;
  if (typeof code !== "string") return new UpstreamError(status);
  if ((method === REPOSITORY_METHOD || method === RELEASE_METHOD) && (HIDDEN.has(code) || (status === 404 && code !== "not_found"))) return new TaskNotFoundError("Task not found.");
  if (refusals.has(code)) return refusedCode(`Podster refused that: ${code}.`, code);
  if (code === "idempotency_mismatch") return malformedCode("This requestId was already used for a different request.", code);
  if (code === "invalid_argument") return malformedCode(`Podster couldn't do that: ${code}.`, code);
  if (RETRYABLE.has(code)) return retryLater(code);
  return new UpstreamError(status);
}

/** The token's answer, exactly the contract's `RepoAccess` fields. Anything else from the API is a failure, never passed on. */
function repoAccess(body: any): Record<string, unknown> {
  const ok =
    body && typeof body === "object" &&
    typeof body.token === "string" && Number.isSafeInteger(body.expires_at) && typeof body.repository === "string" && typeof body.clone_url === "string" &&
    body.permissions && typeof body.permissions === "object" && (body.authority_ends_at === null || Number.isSafeInteger(body.authority_ends_at));
  if (!ok) throw new UpstreamError(200);
  const { token, expires_at, repository, clone_url, permissions, authority_ends_at } = body;
  return { token, expires_at, repository, clone_url, permissions, authority_ends_at };
}

/** The release's answer, exactly the contract's `Release` fields. Anything else from the API is a failure, never passed on. */
const RELEASE_FIELDS = ["id", "commit_sha", "environment", "state", "requested_by", "requested_at", "approved_by", "approved_at", "declined_by", "declined_at", "result_url", "failure_code", "finished_at", "rollback_to"] as const;
function releaseAnswer(body: any): Record<string, unknown> {
  const ok = body && typeof body === "object" && !Array.isArray(body) && typeof body.id === "string" && typeof body.state === "string" && RELEASE_FIELDS.every((field) => field in body);
  if (!ok) throw new UpstreamError(200);
  return Object.fromEntries(RELEASE_FIELDS.map((field) => [field, body[field]]));
}

/**
 * One lifecycle call. A task's command answers with the task as `GetTask` reads it afterwards, and a retry with the same
 * `requestId`, task and parameters does nothing new: the API's idempotency record answers it. `ClaimRole` answers the
 * claim and `GetRepoAccess` the token, each as MCP's tool does.
 */
export async function runLifecycle(api: ApiReads, callerId: string, method: LifecycleMethod, params: unknown, extensions: string[], options: LifecycleOptions): Promise<LifecycleResult> {
  if (!lifecycleActive(extensions)) throw new ExtensionSupportRequiredError(`Name ${LIFECYCLE_URI} in A2A-Extensions to call ${method}.`);
  // The route never gets here for GetRepoAccess while the switch is off, or for DeployRelease while the API doesn't answer
  // the release routes. Checked again, so this can't be the only guard.
  if (!methodListed(method, options)) throw new UnsupportedOperationError("Not available.");
  const parsed = parse(method, params, options);
  if (method === "podster.lifecycle.v1.ClaimRole") {
    const { status, body } = await api.command("claim_role", { workspace_id: parsed.workspaceId, role_id: parsed.roleId }, `a2a-lc:${parsed.requestId}`);
    if (status !== 200) throw namedRefusal(method, status, body);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new UpstreamError(200);
    return { value: body };
  }
  if (method === REPOSITORY_METHOD) {
    // No idempotency key, as MCP sends none. The token is in the answer only: nothing here logs it or keeps it.
    const { status, body } = await api.command("get_repo_access", { workspace_id: parsed.workspaceId, task_id: parsed.taskId });
    if (status !== 200) throw namedRefusal(method, status, body);
    return { value: repoAccess(body) };
  }
  if (method === RELEASE_METHOD) {
    const { status, body } = await api.command("deploy_release", { workspace_id: parsed.workspaceId, task_id: parsed.taskId, ...parsed.args }, `a2a-lc:${parsed.requestId}`);
    if (status !== 200) throw namedRefusal(method, status, body);
    return { value: releaseAnswer(body) };
  }
  const { status, body } = await api.command(LIFECYCLE_METHODS[method], { workspace_id: parsed.workspaceId, task_id: parsed.taskId, ...parsed.args }, `a2a-lc:${parsed.requestId}`);
  if (status !== 200) throw refusal(status, body);
  try {
    return { task: await readTask(api, callerId, parsed.a2aId!) };
  } catch (error) {
    // A decline or a release can leave the caller unable to see the task any more. The command already answered with
    // the task as it now is, so that's the answer, with no history, rather than a "not found" for something that worked.
    if (error instanceof TaskNotFoundError && body?.id === parsed.taskId) return { task: toA2aTask(parsed.a2aId!, body, callerId) };
    throw error;
  }
}
