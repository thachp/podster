/**
 * The capabilities Runner names when it registers its one agent (decision 230): what it uses, and nothing that merges,
 * releases, makes, assigns or cancels work. They must lie within the gateway's `RUNNER_CAPABILITIES`, the paired host's
 * defaults, or the plugin leaves the agent waiting for an approval the pairing never gives; a test reads the gateway's
 * list and holds this one inside it.
 *
 * `get_repo_access` is back (M7 step 10), under the repository path's own rules (`repository.ts`): only for a repository
 * the owner scoped locally, only where GitHub shows the default branch under ADR 0009's rules, one task branch and never
 * the default one, a fixed set of GitHub calls with no merge, and the token kept in Runner's broker on the host. Only
 * `src/node/repo-path.ts` calls it; a test holds that.
 *
 * `set_a2a_endpoint` and `verify_a2a_endpoint` (M7 step 14) are called only when the owner starts `run` with the inbound
 * nudge switched on, and only with `delivery: "nudge"`: they register the owner's HTTPS address and prove Runner holds
 * its signing secret. Neither grants anything in a room, and the nudge sends nothing until a person who administers the
 * agent's organization switches it on in Podster. Only `src/core/nudge.ts` names them; a test holds that.
 *
 * `list_role_openings`, `claim_role` and `decline_role` (issue 522) answer a role invite as this agent, under the owner's
 * local policy (`roles.ts`): the room decides each call, only for the invite naming this agent, and a claim copies only
 * the opening's preset. Neither accepts or declines a task. Only `src/core/roles.ts` names them; a test holds that.
 *
 * Step 6 calls only the reads and the inbox. The lifecycle calls are named now so the registered agent is the one later
 * steps use: Runner registers once per pairing and never again by itself.
 */
export const RUNNER_CAPABILITIES = [
  "get_identity",
  "list_workspaces",
  "get_workspace",
  "get_workroom_brief",
  "read_inbox",
  "ack_inbox",
  "list_tasks",
  "get_task",
  "accept_task",
  "decline_task",
  "release_task",
  "send_message",
  "list_messages",
  "submit_task",
  "create_upload",
  "get_asset_link",
  "list_assets",
  "get_repo_access",
  "set_a2a_endpoint",
  "verify_a2a_endpoint",
  "list_role_openings",
  "claim_role",
  "decline_role",
] as const;

/**
 * Capabilities a deployment lists only while a feature is switched on: `get_repo_access` only where managed repositories
 * are. Where the plugin refuses the whole list as naming one it doesn't have (`invalid_capabilities`), Runner registers
 * once more without these, and nothing else is ever dropped or added.
 */
export const SWITCHED = ["get_repo_access"] as const;

export type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];

/** Never named by Runner, whatever a later list says (decision 230). `get_repo_access` left this list in step 10. */
export const NEVER = ["merge_task", "deploy_release", "create_task", "assign_task", "cancel_task", "verify_task", "request_changes"] as const;

/**
 * The capability names the bitset in Runner's stored agent connection stands for, bit 0 first (issue 527, `storage.ts`).
 * Append only: a name is never removed, reordered or reused, or a stored record would read as different grants; a test
 * pins it. A granted name that isn't here (one added to `RUNNER_CAPABILITIES` and not appended) is stored by name
 * instead, so nothing is dropped, only stored less compactly.
 */
export const STORED_CAPABILITY_BITS: readonly string[] = Object.freeze([
  "get_identity",
  "list_workspaces",
  "get_workspace",
  "get_workroom_brief",
  "read_inbox",
  "ack_inbox",
  "list_tasks",
  "get_task",
  "accept_task",
  "decline_task",
  "release_task",
  "send_message",
  "list_messages",
  "submit_task",
  "create_upload",
  "get_asset_link",
  "list_assets",
  "get_repo_access",
  "set_a2a_endpoint",
  "verify_a2a_endpoint",
  "list_role_openings",
  "claim_role",
  "decline_role",
]);
