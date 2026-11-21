/**
 * Plain-English explanations of Runner's failure codes (the owner's request of 2026-11-20: "I need to know why certain
 * actions failed, the detail, instead of just the code"). A fixed table keyed by code: each says what happened and what
 * to do. Nothing is interpolated but the code itself, which is a fixed shape, so no task text, error message or secret
 * can reach the terminal through it. A code with no entry says so and points to the local diagnostics file.
 *
 * None of this reaches the room: a start failure reaches it as one generic code, `runner_could_not_start`, in Runner's
 * fixed note (`composeBlockedNote`), and the specific code and its explanation stay on the owner's machine.
 */

export type Explanation = { what: string; todo: string };

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

const group = (codes: string[], what: string, todo: string): [string, Explanation][] => codes.map((c) => [c, { what, todo }]);
const SEND = "send the code and the matching entry in the diagnostics file to whoever supports your Runner.";
const SUPPORT = `If it happens again, ${SEND}`;
const RESTART = `Restart Runner with \`run\`; if it happens again, ${SEND}`;

const TABLE = new Map<string, Explanation>([
  // The run policy and the network.
  ...group(["egress_proxy_unavailable"], "The room's policy lists network hosts, but this Runner has no egress proxy to hold them, so the run didn't start.", "Start Runner with `run`, which builds and pins its egress proxy image, or set rooms[].network to [] in policy.json."),
  ...group(["docker_engine_too_old"], "The room's policy lists network hosts, and this Docker Engine is older than 26, which could carry a task's DNS lookups past the egress proxy, so the run didn't start.", "Update Docker (Docker Desktop, or Docker Engine 26 or later), or set rooms[].network to [] in policy.json."),
  ...group(["toolchain_image_unavailable"], "The room's policy names toolchains, and Runner couldn't build, check or pin their image, so the run didn't start.", "Check that Docker is running and this machine can reach the toolchains' download sites (static.rust-lang.org for Rust, GitHub for Python); the details file says which step failed. The next offer tries again, or set rooms[].toolchains to [] in policy.json."),
  ...group(["egress_proxy_not_ready", "egress_subnet_invalid", "egress_hosts_invalid", "egress_program_invalid"], "Runner's egress proxy for the room's listed hosts couldn't be started, so the run didn't start.", "Check that Docker is running; the details file has more. Restart Runner with `run` if it keeps happening."),
  ...group(["config_invalid", "budget_invalid"], "Runner's run policy can't be read or used.", "Fix policy.json; `run` names the field it refused when it starts."),
  ...group(["clock_invalid"], "This machine's clock went back past the day Runner last counted spend.", "Set the clock right; the task waits until then."),
  ...group(["authority_stale"], "Runner hasn't heard from Podster recently enough to trust this agent's access.", "Check the network connection; the task waits and is tried again."),
  ...group(["room_not_configured"], "This room isn't in Runner's run policy.", "Add the room to rooms[] in policy.json if Runner should work in it."),
  ...group(["requester_out_of_scope", "author_out_of_scope"], "Someone who wrote this task isn't in an organization the room's policy allows.", "Add their organization to rooms[].allowed_orgs if Runner should take their tasks."),
  ...group(["day_budget_exhausted"], "Today's spend cap is used up.", "The task waits for tomorrow, or raise day_caps.spend_micro_usd in policy.json."),
  ...group(["attempts_exhausted"], "This task was tried too many times today.", "It's tried again tomorrow."),
  ...group(["owner_declined"], "You declined the task at the terminal.", "Nothing to do."),
  ...group(["prompt_unavailable", "provenance_invalid", "prompt_mismatch", "task_invalid"], "The task's inputs couldn't be read exactly as Podster listed them, so no prompt was built.", `Ask the room to check the task; if it happens again, ${SEND}`),
  ...group(["prompt_too_large", "prompt_invalid"], "The task's words are too large, or not text Runner can hand to the agent.", "Ask the room to shorten the task."),
  ...group(["blocked_same_inputs"], "The agent already answered blocked on these exact inputs, so Runner won't pay for the same answer again.", "Change the task, request changes, post a message on the task, or change the room's policy (such as adding shell), and it runs again."),
  ...group(["run_blocked"], "The agent reported it is blocked and couldn't finish.", "Read its reason on the task's thread. If it needs a shell, add \"shell\" to rooms[].tools in policy.json; if it needs a host on the internet, list that exact host name in rooms[].network."),
  ...group(["note_scan_unknown", "note_scan_exhausted"], "Runner couldn't read the task's thread to check whether its note landed before a restart.", "It tries again with a growing wait; after six tries it posts its fixed note once."),
  ...group(["runner_could_not_start"], "Runner couldn't start a run for this task.", "The log line before it has the cause code, and the details file has the raw error."),
  // A run that never started.
  ...group(["docker_unavailable"], "Runner couldn't run Docker.", "Start Docker (Docker Desktop on a Mac), then the next offer runs."),
  ...group(["container_failed", "container_invalid", "strays_remain"], "The task's container couldn't be started or prepared.", "Check that Docker is running and the task image is built; the details file has Docker's exit code and output."),
  ...group(["workspace_on_windows_drive"], "The task's folder is on a Windows drive, where Runner can't protect its files.", "Move workspace_root in policy.json into the Linux file system."),
  ...group(["adapter_unavailable", "transport_unavailable"], "Runner has no agent SDK or provider for this room's policy.", "Start Runner with a provider key file, and check policy.json's adapter."),
  ...group(["broker_invalid", "run_ref_invalid", "halted", "start_failed"], "Runner couldn't set the run up.", RESTART),
  ...group(["relay_check_failed", "relay_check_unix_only", "relay_port", "relay_socket_path", "relay_socket_path_too_long", "listener_not_loopback", "listener_socket_host", "listener_socket_path", "listener_socket_unsafe"], "Runner's link between Claude Code's container and its model broker couldn't be set up.", "Start Runner with a shorter --home (the default ~/.podster-runner) and check Docker; the details file has more."),
  ...group(["upstream_not_allowed", "headers_not_allowed"], "A model request didn't match the one provider address Runner allows.", SUPPORT),
  // A run that ended without a result to submit.
  ...group(["run_failed", "driver_failed", "sdk_error", "exec_exited", "plugins_unexpected"], "The agent's run failed before it gave a result.", "The details file has the driver's code; the task is released, and offered again by the room."),
  ...group(["run_timed_out", "run_time"], "The run used its whole time cap.", "Raise caps.run_time_ms in policy.json, or ask for a smaller task."),
  ...group(["run_budget_stopped", "spend_cap", "turns_exhausted", "output_tokens_exhausted", "max_turns"], "The run reached one of its caps on spend, turns or output.", "Raise the matching cap in policy.json's caps, or ask for a smaller task."),
  ...group(["refusal_ignored", "tool_refused_unchecked"], "The agent's SDK ran a tool call Runner had refused, so Runner stopped the run.", SUPPORT),
  ...group(["disk_bound"], "The run wrote more to disk than Runner allows.", "Ask for a smaller task."),
  ...group(["stopped", "stopped_locally"], "The run was stopped on this machine.", "Nothing to do; it's released once its stop is confirmed."),
  ...group(["runner_restarted", "run_interrupted"], "Runner stopped while a run was going.", "Nothing to do; the task is released once the old run is confirmed stopped."),
  ...group(["offline_grace", "revoked", "canceled", "not_readable", "inputs_changed", "policy_changed"], "The run was stopped because the task, its inputs, its access or the policy changed while it ran.", "Nothing to do; the task is read again."),
  ...group(["result_missing"], "The agent ended without giving its structured result.", `The task is released; if it keeps happening, ${SEND}`),
  ...group(["result_invalid"], "The agent's structured result broke one of Runner's rules.", "The details file names the rule."),
  ...group(["result_not_object", "result_missing_field", "result_unknown_field", "result_status_invalid"], "The agent's result wasn't shaped as Runner's result: status, summary and files.", "The agent was told and may resubmit; nothing to do unless it keeps happening."),
  ...group(["result_summary_empty", "result_summary_too_long", "result_summary_control_char"], "The agent's result summary was empty, too long, or held a control character.", "The agent was told and may resubmit; nothing to do unless it keeps happening."),
  ...group(["result_files_not_list", "result_too_many_files", "result_file_outside_folder", "result_file_not_allowed", "result_file_duplicate"], "The agent's result named files Runner can't accept.", "The agent was told and may resubmit; nothing to do unless it keeps happening."),
  // Tool calls and model requests Runner refused.
  ...group(["call_invalid", "input_invalid", "tool_not_allowed", "shell_not_allowed", "path_outside_folder", "path_not_allowed", "run_stopped"], "Runner refused one of the agent's tool calls.", "Nothing to do unless the agent needs that tool: shell needs rooms[].tools to list shell."),
  ...group(["method_not_allowed", "query_not_allowed", "body_too_large", "body_invalid", "body_not_allowed", "model_not_allowed", "model_unpriced", "upstream_failed"], "Runner refused or couldn't send one of the agent's model requests.", SUPPORT),
  // The repository path.
  ...group(["repository_unavailable", "helper_unavailable", "git_unavailable"], "Runner can't work with this room's repository on this machine.", "Check that Git is installed and the room's repository is set in policy.json."),
  ...group(["repository_out_of_scope", "clone_url_unexpected", "repository_id_mismatch", "repository_renamed", "repository_archived", "repository_unprotected", "repository_unreadable"], "The room's repository isn't the one Runner's policy allows, or can't be used as it is.", "Check rooms[].repository in policy.json against the room's repository on GitHub."),
  ...group(["path_unsafe", "unsafe", "work_tree_git", "work_tree_link", "work_tree_special", "work_tree_too_large"], "The task's folder held something Runner won't commit or push.", "The details file names the check; the task is released."),
  ...group(["access_authority_invalid", "access_expired", "access_fields", "access_invalid", "access_not_object", "access_permissions", "access_token_format", "token_revoked"], "Podster's repository access for this task wasn't usable.", "Try again later; if it keeps happening, check the room's repository settings in Podster."),
  ...group(["github_unavailable", "github_unreachable", "github_refused", "github_answer_too_large"], "GitHub couldn't be reached or refused a request.", "Check the network; Runner tries again later."),
  ...group(["checkout_failed", "checkout_moved", "checkout_unverified", "fetch_invalid", "git_init_failed", "default_branch_invalid", "ref_unreadable", "base_moved", "task_branch_moved"], "Runner couldn't prepare a clean checkout of the repository.", "Runner tries again later; the details file has more."),
  ...group(["commit_failed", "commit_unexpected", "push_invalid", "push_rejected", "push_unconfirmed", "repo_publish_failed", "publish_failed"], "Runner couldn't commit or push the run's work.", "Runner retries for an hour, then releases the task; check the task branch's protection on GitHub."),
  ...group(["pull_request_commit_changed", "pull_request_not_found", "pull_request_not_open", "pull_request_refused", "pull_request_unreadable", "pull_request_wrong_base", "pull_request_wrong_head", "pull_request_wrong_repository", "pull_request_unread"], "The task's pull request wasn't as Runner pushed it.", "Check the pull request on GitHub; the task is released if it can't be submitted."),
  ...group(["run_no_changes"], "The run changed nothing, so there was nothing to submit.", "The task is released."),
  ...group(["record_invalid", "repo_record_invalid", "result_record_invalid"], "Runner's own record of this run was incomplete.", SUPPORT),
  // Podster's answers.
  ...group(["version_conflict", "invalid_transition", "commit_changed", "not_allowed", "not_found", "task_not_found", "idempotency_mismatch"], "Podster refused the call: the task had changed, or wasn't this agent's to act on.", "Nothing to do; the task is read again."),
  ...group(["accept_unexpected", "unknown", "unexpected", "network", "too_large", "not_data", "bad_answer", "unreadable", "request_invalid"], "Runner got an answer it didn't expect.", SUPPORT),
  // Runner's own state.
  ...group(["accept_without_decision", "start_without_decision", "reservation_invalid", "docker_rm_lingers", "docker_network_lingers", "docker_exec_ls_cut", "docker_ps_cut", "docker_ps_output", "diagnostics_folder_unsafe", "diagnostics_file_unsafe"], "Runner's own bookkeeping or cleanup didn't go as expected.", RESTART),
]);

/** Codes with a fixed prefix and a varying part: a Docker command's step and exit code, or a Podster refusal's code. */
const PREFIXES: [RegExp, Explanation][] = [
  [/^docker_[a-z_]+_(?:\d+|x|cut|output)$/, { what: "A Docker command failed.", todo: "Check that Docker is running; the details file has its exit code and output." }],
  [/^(?:submit|accept|give_up|consume|pin|issue)_/, { what: "Podster or Runner's policy refused a step for this task.", todo: "The rest of the code says which; the task is read again or released." }],
  [/^repo_/, { what: "A step on the room's repository failed.", todo: "The details file has the cause." }],
  [/^task_[a-z_]+$/, { what: "The task's state changed, so Runner left it.", todo: "Nothing to do." }],
  [/^policy_/, { what: "The run policy changed while the run went.", todo: "Nothing to do; the task is evaluated again." }],
];

/** The explanation for a code, and whether the table knows it. A `repo_` code is explained by the code under it. */
export function explain(code: string): Explanation & { known: boolean } {
  const exact = TABLE.get(code) ?? (code.startsWith("repo_") ? TABLE.get(code.slice(5)) : undefined);
  if (exact) return { ...exact, known: true };
  const prefixed = CODE.test(code) ? PREFIXES.find(([pattern]) => pattern.test(code)) : undefined;
  if (prefixed) return { ...prefixed[1], known: true };
  return { what: "Runner has no explanation for this code.", todo: "The diagnostics file has the details.", known: false };
}

/** Every code the table names exactly. */
export const EXPLAINED_CODES: readonly string[] = [...TABLE.keys()];

/** Outcomes of a log line that are a failure, a refusal or a stop: the terminal explains their code. */
export const FAILURE_OUTCOMES = new Set([
  "start_failed",
  "run_failed",
  "run_timed_out",
  "run_budget_stopped",
  "result_missing",
  "result_invalid",
  "run_blocked",
  "released",
  "declined",
  "refused",
  "refuse",
  "pin_refused",
  "unavailable",
  "not_submitted",
  "nothing_to_submit",
  "reason_not_posted",
  "given_up",
  "halted",
  "held",
  "waiting",
]);

/** The terminal's line under a failure: what happened and what to do, the code, and where the details are. */
export function explainLine(code: string, diagnosticsFile: string): string {
  const e = explain(CODE.test(code) ? code : "unknown");
  return `  why: ${e.what} ${e.todo} (code ${CODE.test(code) ? code : "unknown"}; details: ${diagnosticsFile})`;
}
