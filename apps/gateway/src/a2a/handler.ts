import { AgentCard } from "@a2a-js/sdk";
import type { A2ARequestHandler } from "@a2a-js/sdk/server";
import { ExtendedAgentCardNotConfiguredError, PushNotificationNotSupportedError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { agentCard } from "./card";

/**
 * Podster's own `A2ARequestHandler`, as ADR 0007 decides: the SDK's transport, not its `DefaultRequestHandler`, which
 * would run an executor and keep its own task store. Each operation will become one Podster read or command through the
 * API, so Rust decides. Until steps 7 to 10, nothing does: every operation answers its named error, and none reads a
 * parameter, so a refusal can't depend on whether a task exists.
 */
const notYet = (operation: string) => new UnsupportedOperationError(`${operation} isn't available yet. Podster's A2A support is in preview.`);
const noPush = () => new PushNotificationNotSupportedError("Push notifications aren't supported.");
const noStreaming = () => new UnsupportedOperationError("Streaming isn't supported.");

export class PodsterA2AHandler implements A2ARequestHandler {
  constructor(private readonly baseUrl: string) {}

  async getAgentCard() {
    return AgentCard.fromJSON(agentCard(this.baseUrl));
  }

  async getAuthenticatedExtendedAgentCard(): Promise<never> {
    throw new ExtendedAgentCardNotConfiguredError("Podster has no extended card.");
  }

  async sendMessage(): Promise<never> {
    throw notYet("SendMessage");
  }

  async getTask(): Promise<never> {
    throw notYet("GetTask");
  }

  async listTasks(): Promise<never> {
    throw notYet("ListTasks");
  }

  async cancelTask(): Promise<never> {
    throw notYet("CancelTask");
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
