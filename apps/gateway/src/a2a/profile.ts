/**
 * What Podster's A2A surface offers, operation by operation. `docs/spec/A2A-PROFILE.md` lists the same table, and a
 * test holds the two together, so the card and the profile can't drift apart.
 *
 * Step 6 of the M3 plan: nothing is available yet. Every operation answers its named error, and steps 7 to 10 turn
 * them on one at a time, each updating this table and the profile in the same PR.
 */

export type MethodStatus =
  /** Not available yet. Answers `UnsupportedOperationError`. */
  | "not_yet"
  /** Off by decision 110. Answers the operation's own named error. */
  | "off";

export const A2A_METHODS = {
  SendMessage: "not_yet",
  GetTask: "not_yet",
  ListTasks: "not_yet",
  CancelTask: "not_yet",
  SendStreamingMessage: "off",
  SubscribeToTask: "off",
  CreateTaskPushNotificationConfig: "off",
  GetTaskPushNotificationConfig: "off",
  ListTaskPushNotificationConfigs: "off",
  DeleteTaskPushNotificationConfig: "off",
  GetExtendedAgentCard: "off",
} as const satisfies Record<string, MethodStatus>;

export type A2AMethod = keyof typeof A2A_METHODS;

/** Decisions 108 and 109: one binding and one version. */
export const A2A_BINDING = "JSONRPC";
export const A2A_VERSION = "1.0";
export const A2A_PATH = "/a2a";
export const CARD_PATH = "/.well-known/agent-card.json";

/** A request's body, at most this. A message is 16 KB (decision 123), so this leaves room for the envelope. */
export const MAX_A2A_BODY_BYTES = 64 * 1024;
