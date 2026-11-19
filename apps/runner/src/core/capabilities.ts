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
