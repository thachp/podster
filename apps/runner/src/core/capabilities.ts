/**
 * The capabilities Runner names when it registers its one agent (decision 230): what it uses, and nothing that merges,
 * releases, makes, assigns or cancels work. They must lie within the gateway's `RUNNER_CAPABILITIES`, the paired host's
 * defaults, or the plugin leaves the agent waiting for an approval the pairing never gives; a test reads the gateway's
 * list and holds this one inside it. `get_repo_access` stays out until M7 step 10 brings it back under its own rules.
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
] as const;

export type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];

/** Never named by Runner, whatever a later list says (decision 230; M7 plan, ruling L1 on #449). */
export const NEVER = ["merge_task", "deploy_release", "get_repo_access", "create_task", "assign_task", "cancel_task", "verify_task", "request_changes"] as const;
