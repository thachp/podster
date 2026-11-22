/**
 * Plain-English explanations of Runner's failure codes (the owner's request of 2026-11-20: "I need to know why certain
 * actions failed, the detail, instead of just the code"). A fixed table keyed by code: each says what happened and what
 * to do. Nothing is interpolated but the code itself, which is a fixed shape, so no task text, error message or secret
 * can reach the terminal through it. A code with no entry says so and points to the local diagnostics file.
 *
 * None of this reaches the room: a start failure reaches it as one generic code, `runner_could_not_start`, in Runner's
 * fixed note (`composeBlockedNote`), and the specific code and its explanation stay on the owner's machine.
 */

import { COMMIT_LIMITS } from "./repository.js";

/** A byte limit in whole MiB, for the fixed text below. */
const MIB = (bytes: number) => Math.round(bytes / (1024 * 1024));

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
  ...group(["toolchain_image_unavailable"], "The room's policy names toolchains, and Runner couldn't build, check or pin their image, so the run didn't start.", "Check that Docker is running and this machine can reach the toolchains' download sites (static.rust-lang.org for Rust, GitHub for Python and Java, builds.dotnet.microsoft.com for .NET, archive.apache.org for Java's Maven); the details file says which step failed. The next offer tries again, or set rooms[].toolchains to [] in policy.json."),
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
  ...group(["task_home_invalid"], "Runner couldn't make the task's home folder, .cache/home in its folder, so the run didn't start: in a repository room, the repository's .cache or .cache/home is a link or a file.", "Remove the link or file at .cache or .cache/home from the repository, or point the room at another repository."),
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
  ...group(["task_not_linked"], "Podster said this task isn't linked to the room's repository, so Runner ran it without one: an empty folder, no repository token, and no commit, push or pull request. Its result is submitted as text.", "Nothing to do. If the task needed the repository, ask the room to check the repository in Podster and make the task again once it's ready."),
  ...group(["task_folder_unsafe"], "Runner couldn't empty the task's folder before a run without the repository: the folder or the room's folder above it is a link, or not where the run policy puts it.", "The task is released; check the folder under workspace_root in policy.json and remove any link there."),
  ...group(["repository_unavailable", "helper_unavailable", "git_unavailable"], "Runner can't work with this room's repository on this machine.", "Check that Git is installed and the room's repository is set in policy.json."),
  ...group(["repository_out_of_scope", "clone_url_unexpected", "repository_id_mismatch", "repository_renamed", "repository_archived", "repository_unprotected", "repository_unreadable"], "The room's repository isn't the one Runner's policy allows, or can't be used as it is.", "Check rooms[].repository in policy.json against the room's repository on GitHub."),
  ...group(["path_unsafe", "unsafe", "work_tree_git", "work_tree_link", "work_tree_special"], "The task's folder held something Runner won't commit or push.", "The details file names the check; the task is released."),
  ...group(["work_tree_too_large"], `The run's change was too large to commit: more than ${MIB(COMMIT_LIMITS.bytes)} MB, more than ${COMMIT_LIMITS.files.toLocaleString("en-US")} files, or more folder entries than Runner walks. Almost always it's a cache, a build or a download the agent left in the task's folder.`, "The task is released; add that folder to the repository's .gitignore, or ask for a smaller task."),
  ...group(["work_tree_file_too_large"], `One file in the run's change was over ${MIB(COMMIT_LIMITS.file_bytes)} MB, which GitHub warns about, close to the 100 MB it refuses.`, "The task is released; keep large files out of the repository, such as with .gitignore, or ask for a task that doesn't make them."),
  ...group(["work_tree_workflow"], "The task changed a GitHub workflow file, which Runner never commits.", "The task is released; a workflow change goes through a person."),
  ...group(["work_tree_name"], "A file or folder name in the task's folder isn't valid UTF-8, so Runner can't check it exactly.", "The task is released; rename or remove that entry if the run made it."),
  ...group(["work_tree_timeout"], "Git took too long listing what the repository ignores, so nothing was committed.", "The task is released; a .gitignore that isn't a plain file, such as a pipe, can cause this."),
  ...group(["work_tree_ignored_too_many"], "Git listed more ignored paths than Runner reads, so nothing was committed.", "Ignore whole folders in .gitignore rather than many single files; the task is released."),
  ...group(["access_authority_invalid", "access_expired", "access_fields", "access_invalid", "access_not_object", "access_permissions", "access_token_format", "token_revoked"], "Podster's repository access for this task wasn't usable.", "Try again later; if it keeps happening, check the room's repository settings in Podster."),
  ...group(["github_unavailable", "github_unreachable", "github_refused", "github_answer_too_large"], "GitHub couldn't be reached or refused a request.", "Check the network; Runner tries again later."),
  ...group(["checkout_failed", "checkout_moved", "checkout_unverified", "fetch_invalid", "git_init_failed", "default_branch_invalid", "ref_unreadable", "base_moved", "task_branch_moved"], "Runner couldn't prepare a clean checkout of the repository.", "Runner tries again later; the details file has more."),
  // A failed fetch or push, by its cause (#520). Git's own words never reach these lines; `podster why` adds the stage
  // and Git's exit code from the local diagnostics file.
  ...group(["fetch_auth_failed"], "GitHub refused this task's repository token when Git fetched the repository.", "Runner asks Podster for a new token next time; if it keeps happening, check in Podster that the room's GitHub App installation is still active."),
  ...group(["fetch_access_denied"], "GitHub took this task's repository token but refused it the repository when Git fetched it (HTTP 403).", "Check that the Podster GitHub App is installed on the room's repository with read access to its contents; the task is released."),
  ...group(["fetch_repository_not_found", "push_repository_not_found"], "GitHub said no such repository is visible to this task's token: the Podster GitHub App isn't installed on it, or the repository was moved or deleted.", "Check the room's repository in Podster and that the Podster GitHub App is installed on it; the task is released."),
  ...group(["fetch_ref_missing"], "Git found no such branch on GitHub, though GitHub's API had named it a moment before.", "Runner tries again later; if it keeps happening, check the repository's default branch on GitHub."),
  ...group(["fetch_dns_failed"], "This machine couldn't look up GitHub's address when Git fetched the repository.", "Check this machine's DNS (in WSL, /etc/resolv.conf); Runner tries again later."),
  ...group(["fetch_unreachable"], "Git couldn't connect to GitHub, or the fetch timed out. Runner's Git uses no proxy from the environment.", "Check this machine's network, VPN or firewall for direct HTTPS to GitHub; Runner tries again later."),
  ...group(["fetch_tls_failed"], "Git couldn't make a verified TLS connection to GitHub: the certificate check or the handshake failed.", "Check this machine's CA certificates (on Debian or Ubuntu, the ca-certificates package) and any proxy or security tool that intercepts TLS; Runner tries again later."),
  ...group(["git_too_old", "fetch_git_too_old", "push_git_too_old"], "This machine's Git is older than 2.25, or refused an option Runner passes, so Runner can't check out the room's repository.", "Install Git 2.25 or later at the path Runner uses (/usr/bin/git, /opt/homebrew/bin/git or /usr/local/bin/git), then restart Runner with `run`; `podster why` shows Git's exit code."),
  ...group(["fetch_https_unavailable", "push_https_unavailable"], "This machine's Git can't reach GitHub over HTTPS: its git-remote-https helper is missing.", "Reinstall Git with HTTPS support (on Debian or Ubuntu, the git package), then restart Runner with `run`."),
  ...group(["fetch_local_write_failed", "push_local_write_failed"], "Git couldn't write Runner's own Git folder for this task: a lock, a permission, or a full or read-only disk.", "Check free space and permissions in Runner's home (--home, by default ~/.podster-runner); the task is released."),
  ...group(["fetch_failed"], "Git couldn't fetch the room's repository, for a reason Runner doesn't recognise.", `\`podster why\` shows Git's exit code. Check \`git --version\` (2.25 or later) and \`git ls-remote\` of the repository on this machine; if both work, ${SEND}`),
  ...group(["push_too_large"], "GitHub or the network refused the push as too large, or dropped the connection while it was sent.", "The task is released; check what the task's branch would add, and keep caches and large files out with .gitignore."),
  ...group(["commit_failed", "commit_unexpected", "push_failed", "push_invalid", "push_rejected", "push_unconfirmed", "repo_publish_failed", "publish_failed"], "Runner couldn't commit or push the run's work.", "Runner retries for an hour, then releases the task; check the task branch's protection on GitHub."),
  ...group(["pull_request_commit_changed", "pull_request_not_found", "pull_request_not_open", "pull_request_refused", "pull_request_unreadable", "pull_request_wrong_base", "pull_request_wrong_head", "pull_request_wrong_repository", "pull_request_unread"], "The task's pull request wasn't as Runner pushed it.", "Check the pull request on GitHub; the task is released if it can't be submitted."),
  ...group(["run_no_changes"], "The run changed nothing, so there was nothing to submit.", "The task is released."),
  ...group(["record_invalid", "repo_record_invalid", "result_record_invalid"], "Runner's own record of this run was incomplete.", SUPPORT),
  // Podster's answers.
  ...group(["version_conflict", "invalid_transition", "commit_changed", "not_allowed", "not_found", "task_not_found", "idempotency_mismatch"], "Podster refused the call: the task had changed, or wasn't this agent's to act on.", "Nothing to do; the task is read again."),
  ...group(["network"], "Runner couldn't reach Podster: the request failed on the network before any answer came back.", "Nothing to do for a brief failure: Runner tries again, with longer waits between tries. If it goes on, check this machine's network, VPN or proxy."),
  ...group(["discovery_failed"], "Runner asked the gateway how to sign its requests and got an answer that isn't Podster's, or none it could read: a proxy, a sign-in page such as Cloudflare Access, or the wrong address may be answering instead.", "Runner tries again, with longer waits between tries. If it goes on, check the gateway address Runner was paired with, and any proxy, VPN or access page between this machine and Podster."),
  ...group(["bad_answer"], "Runner got an answer it couldn't read as Podster's: it wasn't the JSON Podster sends, or was cut short. A proxy or a sign-in page such as Cloudflare Access may be answering instead.", "Runner tries again. If it goes on, check the gateway address Runner was paired with, and any proxy, VPN or access page between this machine and Podster; if none, send the code and the matching entry in the diagnostics file to whoever supports your Runner."),
  ...group(["gateway_unreachable"], "Runner hasn't reached Podster for longer than its offline grace period, so it starts nothing new until it does.", "Check this machine's network, VPN or proxy; Runner keeps trying and checks this agent's access again once Podster answers. Stop it with Ctrl-C or `stop`."),
  ...group(["accept_unexpected", "unknown", "unexpected", "too_large", "not_data", "unreadable", "request_invalid"], "Runner got an answer it didn't expect.", SUPPORT),
  // Pairing and role invitations (#542).
  ...group(["pair_again_for_roles"], "This Runner was paired before it could answer role invitations, so room invites to this agent aren't answered from this machine. Tasks still run as before, and roles it already holds stay.", "Nothing to do unless you want invites answered from this machine; you can leave this agent as it is. Pairing again makes a new agent with a new ID, never this one: stop Runner, run `forget`, choose Add an agent in Podster, run `npx podster@test pair --agent <agt_…>` with the new agent's ID, and start it with `run`. Then add the new agent to each room and give it its roles and any push or merge grants again; this agent keeps its place until you remove it."),
  ...group(["invalid_capabilities"], "This Podster doesn't offer managed repositories, so Runner paired without repository access.", "Nothing to do; tasks in rooms without a repository run as usual."),
  ...group(["review_hold_expired"], "A result held for your review went unanswered for a day, so Runner submitted it with its fixed note only, never the agent's words.", "Nothing to do; answer held results sooner to share the agent's summary."),
  ...group(["git_not_found"], "Runner found no Git at the paths it uses (/usr/bin/git, /opt/homebrew/bin/git or /usr/local/bin/git), so tasks in rooms with a repository are refused.", "Install Git 2.25 or later at one of those paths, then restart Runner with `run`."),
  ...group(["environment_refused"], "Runner won't reach GitHub with a proxy or TLS trust taken from the environment, so tasks in rooms with a repository are refused.", "Unset NODE_USE_ENV_PROXY, NODE_TLS_REJECT_UNAUTHORIZED=0, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and the --use-env-proxy, --use-openssl-ca and --use-system-ca flags, then restart Runner with `run`."),
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
  "grace_passed",
  // Not a failure: a task Podster says isn't linked runs without the room's repository, and the terminal says so.
  "without_repository",
]);

/**
 * Whether a log line gets a plain-English line under it: a failure, or a try again whose count is a power of two (1, 2,
 * 4, 8, …), so a long outage keeps saying why Runner is waiting without a line under every try.
 */
export function explained(outcome: string, count: number | undefined): boolean {
  if (FAILURE_OUTCOMES.has(outcome)) return true;
  return outcome === "retry" && typeof count === "number" && Number.isSafeInteger(count) && count >= 1 && (count & (count - 1)) === 0;
}

/** The terminal's line under a failure: what happened and what to do, the code, and where the details are. */
export function explainLine(code: string, diagnosticsFile: string): string {
  const e = explain(CODE.test(code) ? code : "unknown");
  return `  why: ${e.what} ${e.todo} (code ${CODE.test(code) ? code : "unknown"}; details: ${diagnosticsFile})`;
}
