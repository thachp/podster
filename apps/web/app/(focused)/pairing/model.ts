/** A pairing session as the gateway answers it to its starter (M7 step 5): never the code, which only the start answers. */
export type PairingView = {
  agent_id: string;
  org_id: string;
  name: string;
  status: "pending" | "redeemed" | "activated" | "canceled" | "locked" | "expired";
  key_thumbprint: string | null;
  expires_at: number;
  /** Whether Runner has registered the one agent a confirmation will link. For the screen only: the API decides. */
  runner_ready?: boolean;
  plugin_agent_id?: string | null;
  /** For an activated session: whether its agent's directory rows are written, so it shows in the organization. */
  connected?: boolean;
  /** Why an activated session's agent can't be linked: its Runner agent is already linked to another agent. */
  link_problem?: "already_linked";
};

/** The gateway `pair` talks to when it's given no `--gateway`. */
const STAGING_GATEWAY = "https://gateway-staging.podster.dev";

/** A pairing's agent ID as the gateway makes it. Only an ID of this shape goes into a link or a command. */
export const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The command that pairs Runner from npm (`podster@test`), as its `pair` takes it: the agent ID, plus the gateway's origin
 * only when it isn't staging's, which `pair` uses by default. The code is never in it: Runner asks for the code and reads it without echo. Null for anything that isn't
 * plainly an origin and an ID, so nothing a person pastes into a shell carries more than those two.
 */
export function runnerPairCommand(gateway: string, agentId: string): string | null {
  let origin: string;
  try {
    origin = new URL(gateway).origin;
  } catch {
    return null;
  }
  if (!/^https?:\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d+)?$/.test(origin) || !AGENT_ID.test(agentId)) return null;
  const gatewayFlag = origin === STAGING_GATEWAY ? "" : ` --gateway ${origin}`;
  return `npx --ignore-scripts podster@test pair${gatewayFlag} --agent ${agentId}`;
}

/** Fixed words for a refused confirmation or cancel. Nothing from the answer is shown. */
export function pairingFailure(status: number, code: string) {
  if (status === 429) return "Too many tries. Wait a minute, then try again.";
  if (status >= 500) return "Something went wrong, and this may not have finished. Please try again.";
  if (code === "already_linked") return "Runner's agent is already connected to another agent in Podster, so it can't be connected here. Nothing else changed.";
  if (code === "invalid_transition") return "This pairing can't be confirmed now. Runner may not have finished setting up, or the pairing has ended.";
  if (code === "not_found") return "This pairing isn't yours, or it no longer exists.";
  return "That wasn't allowed. The key may not match, or you may no longer administer this organization.";
}
