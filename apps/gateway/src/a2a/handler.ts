import { AgentCard } from "@a2a-js/sdk";
import type { A2ARequestHandler } from "@a2a-js/sdk/server";
import type { CancelTaskRequest, GetTaskRequest, ListTasksRequest } from "@a2a-js/sdk";
import { A2AError, ExtendedAgentCardNotConfiguredError, PushNotificationNotSupportedError, TaskNotCancelableError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { agentCard } from "./card";
import { listTasks, readTask, UpstreamError, type ApiReads, type ReadNotes } from "./reads";

/**
 * Podster's own `A2ARequestHandler`, as ADR 0007 decides: the SDK's transport, not its `DefaultRequestHandler`, which
 * would run an executor and keep its own task store. Each operation is one Podster read or command through the API, as
 * the calling agent, so Rust decides. Step 8 turned on the reads and cancel's answer. Messages and the lifecycle follow
 * in steps 9 and 10, and until then those answer their named error without reading a parameter.
 */
export type A2ACaller = { agentId: string; api: ApiReads; notes?: ReadNotes };

/**
 * Only the SDK's named errors reach a client as themselves. Anything else, an API that couldn't answer or a fault here,
 * reaches it as a fixed "Internal error", and the log gets IDs and a status, never a message or a body.
 */
async function guarded<T>(operation: string, agentId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof A2AError) throw error;
    console.error(JSON.stringify({ event: "a2a.internal_error", operation, agent: agentId, status: error instanceof UpstreamError ? error.status : null }));
    throw new Error("Internal error");
  }
}

const notYet = (operation: string) => new UnsupportedOperationError(`${operation} isn't available yet. Podster's A2A support is in preview.`);
const noPush = () => new PushNotificationNotSupportedError("Push notifications aren't supported.");
const noStreaming = () => new UnsupportedOperationError("Streaming isn't supported.");

export class PodsterA2AHandler implements A2ARequestHandler {
  constructor(
    private readonly baseUrl: string,
    private readonly caller?: A2ACaller,
  ) {}

  /** Every read needs the caller the gateway authenticated. The route never builds a handler for reads without one. */
  private who(): A2ACaller {
    if (!this.caller) throw new UnsupportedOperationError("Sign in to use Podster's A2A interface.");
    return this.caller;
  }

  async getAgentCard() {
    return AgentCard.fromJSON(agentCard(this.baseUrl));
  }

  async getAuthenticatedExtendedAgentCard(): Promise<never> {
    throw new ExtendedAgentCardNotConfiguredError("Podster has no extended card.");
  }

  async sendMessage(): Promise<never> {
    throw notYet("SendMessage");
  }

  async getTask(params: GetTaskRequest) {
    const { agentId, api } = this.who();
    return guarded("GetTask", agentId, () => readTask(api, agentId, params.id, params.historyLength));
  }

  async listTasks(params: ListTasksRequest) {
    const { agentId, api, notes } = this.who();
    return guarded("ListTasks", agentId, () => listTasks(api, agentId, params, notes));
  }

  /**
   * Cancelling belongs to the requester or an admin, through Podster's own commands (ADR 0007), so over A2A it never
   * cancels. A task the caller can see answers `TaskNotCancelableError`, and one it can't the same `TaskNotFoundError` as
   * a missing one, so the answer tells nothing more than `GetTask` would.
   */
  async cancelTask(params: CancelTaskRequest): Promise<never> {
    const { agentId, api } = this.who();
    await guarded("CancelTask", agentId, () => readTask(api, agentId, params.id, 0));
    throw new TaskNotCancelableError("Tasks are canceled by their requester or an admin in Podster, not over A2A.");
  }

  // Never reached: the route refuses streaming methods before the handler, so no response is held open. Kept as a second fence.
  async *sendMessageStream(): AsyncGenerator<never> {
    throw noStreaming();
  }

  async *resubscribe(): AsyncGenerator<never> {
    throw noStreaming();
  }

  async createTaskPushNotificationConfig(): Promise<never> {
    throw noPush();
  }

  async getTaskPushNotificationConfig(): Promise<never> {
    throw noPush();
  }

  async listTaskPushNotificationConfigs(): Promise<never> {
    throw noPush();
  }

  async deleteTaskPushNotificationConfig(): Promise<never> {
    throw noPush();
  }
}
