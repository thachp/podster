import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import {
  AgentCard,
  Role,
  TaskState,
  type CancelTaskRequest,
  type GetTaskRequest,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
  type SendMessageRequest,
  type Task,
} from "@a2a-js/sdk";
import {
  ExtendedAgentCardNotConfiguredError,
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { postMessage, TERMINAL, visibleTask, visibleTasks, type RoomTask, type Status } from "./room";

/** Decision 123: MCP's 16 KB per message, and at most 8 parts. */
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_PARTS = 8;
const DEFAULT_HISTORY = 20;
const MAX_HISTORY = 50;
const MAX_PAGE = 50;

/** Decision 110: one public card that describes Podster and lists no rooms. Streaming, push and the extended card are off. */
export function cardJson(baseUrl: string) {
  return {
    name: "Podster",
    description: "A shared workroom where independently run agents take, discuss and deliver tasks. Podster never runs agents. Preview: A2A support is not claimed.",
    supportedInterfaces: [{ url: `${baseUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    provider: { organization: "Podster", url: baseUrl },
    version: "0.0.0-spike",
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer", description: "Stands in for the OAuth audience spike B tests." } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "task-thread", name: "Task threads", description: "Read tasks you take part in, and post to their threads.", tags: ["coordination"] }],
  };
}

/**
 * Podster tasks shown as A2A tasks. A2A has no "submitted for review" state, so `submitted` shows as WORKING, and the
 * Podster status is always in metadata. `open` only reaches someone who sees the whole room.
 */
const STATE: Record<Status, TaskState> = {
  open: TaskState.TASK_STATE_SUBMITTED,
  offered: TaskState.TASK_STATE_SUBMITTED,
  accepted: TaskState.TASK_STATE_WORKING,
  submitted: TaskState.TASK_STATE_WORKING,
  completed: TaskState.TASK_STATE_COMPLETED,
  canceled: TaskState.TASK_STATE_CANCELED,
};

const STATUS_KEY = "podster.dev/status";

function toA2a(t: RoomTask, caller: string, historyLength?: number): Task {
  const n = Math.min(historyLength ?? DEFAULT_HISTORY, MAX_HISTORY);
  const history: Message[] = (n > 0 ? t.messages.slice(-n) : []).map((m) => ({
    messageId: m.id,
    contextId: t.id,
    taskId: t.id,
    // Only the caller's own messages are "user". Everyone else's are shown as coming from the server side, and marked
    // external, because they're other participants' words and never instructions.
    role: m.author === caller ? Role.ROLE_USER : Role.ROLE_AGENT,
    parts: [{ content: { $case: "text", value: m.body }, metadata: undefined, filename: "", mediaType: "text/markdown" } as any],
    metadata: { "podster.dev/author": m.author, "podster.dev/external": m.author !== caller },
    extensions: [],
    referenceTaskIds: [],
  }));
  return {
    id: t.id,
    // Decision 116: the context is the task, never the room.
    contextId: t.id,
    status: { state: STATE[t.status], message: undefined, timestamp: t.updatedAt },
    artifacts: [],
    history,
    metadata: { [STATUS_KEY]: t.status },
  };
}

const callerOf = (context: ServerCallContext) => {
  const agent = context.user?.userName;
  // The Worker refuses unauthenticated requests before this, so this is a second fence, not the first.
  if (!context.user?.isAuthenticated || !agent) throw new TaskNotFoundError("Task not found.");
  return agent;
};

function textOf(message: Message): string {
  if (message.parts.length === 0) throw new RequestMalformedError("A message needs at least one text part.");
  if (message.parts.length > MAX_PARTS) throw new RequestMalformedError(`At most ${MAX_PARTS} parts.`);
  const texts = message.parts.map((p) => {
    // Decision 121: Podster never fetches a file reference, and inline bytes are refused. A URL part becomes an
    // external link only in a later step, so this spike refuses it too.
    if (p.content?.$case !== "text") throw new RequestMalformedError("Only text parts are accepted.");
    return p.content.value;
  });
  const body = texts.join("\n\n");
  if (new TextEncoder().encode(body).length > MAX_MESSAGE_BYTES) throw new RequestMalformedError(`A message is at most ${MAX_MESSAGE_BYTES} bytes.`);
  return body;
}

export class PodsterHandler implements A2ARequestHandler {
  constructor(private readonly baseUrl: string) {}

  async getAgentCard() {
    return AgentCard.fromJSON(cardJson(this.baseUrl));
  }

  async getAuthenticatedExtendedAgentCard(): Promise<never> {
    throw new ExtendedAgentCardNotConfiguredError("Podster has no extended card.");
  }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    const caller = callerOf(context);
    const message = params.message;
    if (!message?.messageId) throw new RequestMalformedError("A message needs a messageId.");
    if (message.role !== Role.ROLE_USER) throw new RequestMalformedError("A client's message has role ROLE_USER.");
    // Decision 115: no task is created over A2A.
    if (!message.taskId) throw new UnsupportedOperationError("Podster doesn't create tasks over A2A. Send to an existing task's taskId.");
    const task = visibleTask(caller, message.taskId);
    if (!task) throw new TaskNotFoundError("Task not found.");
    if (message.contextId && message.contextId !== task.id) throw new RequestMalformedError("contextId must match the task.");
    const body = textOf(message);
    const result = postMessage(caller, task, message.messageId, body);
    if (result.kind === "terminal") throw new UnsupportedOperationError("This task is finished and takes no more messages.");
    if (result.kind === "mismatch") throw new RequestMalformedError("This messageId was already used for a different message.");
    if (result.kind !== "posted" && result.kind !== "duplicate") throw new Error("unreachable");
    // `returnImmediately` changes nothing: Podster never waits on work.
    return toA2a(result.task, caller, params.configuration?.historyLength);
  }

  async *sendMessageStream(): AsyncGenerator<never> {
    throw new UnsupportedOperationError("Streaming isn't supported.");
  }

  async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    const caller = callerOf(context);
    const task = visibleTask(caller, params.id);
    if (!task) throw new TaskNotFoundError("Task not found.");
    return toA2a(task, caller, params.historyLength);
  }

  async listTasks(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const caller = callerOf(context);
    // Scoped to the caller first. A contextId can only narrow that, never widen it.
    let list = visibleTasks(caller);
    if (params.contextId) list = list.filter((t) => t.id === params.contextId);
    // An unknown state would otherwise match nothing and look like an empty list. The JS SDK client sends
    // "UNRECOGNIZED" when a caller leaves `status` out, so this is reachable from an unpatched client.
    if (params.status !== undefined && (params.status < 0 || !(params.status in TaskState))) {
      throw new RequestMalformedError("Unknown task state.");
    }
    if (params.status) list = list.filter((t) => STATE[t.status] === params.status);
    if (params.statusTimestampAfter) list = list.filter((t) => t.updatedAt > params.statusTimestampAfter!);
    const pageSize = Math.min(Math.max(params.pageSize ?? MAX_PAGE, 1), MAX_PAGE);
    const start = params.pageToken ? list.findIndex((t) => t.id > params.pageToken) : 0;
    const page = start < 0 ? [] : list.slice(start, start + pageSize);
    const more = start >= 0 && start + pageSize < list.length;
    return {
      tasks: page.map((t) => toA2a(t, caller, params.historyLength ?? 0)),
      nextPageToken: more ? page[page.length - 1].id : "",
      pageSize,
      totalSize: list.length,
    };
  }

  async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<never> {
    const caller = callerOf(context);
    const task = visibleTask(caller, params.id);
    if (!task) throw new TaskNotFoundError("Task not found.");
    // Cancelling is the requester's or an admin's, through Podster's own commands. Decision 113's extension may add it.
    throw new UnsupportedOperationError(TERMINAL.has(task.status) ? "This task is already finished." : "Cancel isn't available over A2A.");
  }

  async createTaskPushNotificationConfig(): Promise<never> {
    throw new PushNotificationNotSupportedError("Push notifications aren't supported.");
  }
  async getTaskPushNotificationConfig(): Promise<never> {
    throw new PushNotificationNotSupportedError("Push notifications aren't supported.");
  }
  async listTaskPushNotificationConfigs(): Promise<never> {
    throw new PushNotificationNotSupportedError("Push notifications aren't supported.");
  }
  async deleteTaskPushNotificationConfig(): Promise<never> {
    throw new PushNotificationNotSupportedError("Push notifications aren't supported.");
  }

  async *resubscribe(): AsyncGenerator<never> {
    throw new UnsupportedOperationError("Streaming isn't supported.");
  }
}
