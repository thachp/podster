/**
 * The repository path's rules (M7 step 10; RUNNER.md "Workroom repository and local task copy" and "Proposed GitHub
 * access"; ADR 0009). Pure: the node side (`src/node/repo-path.ts`) does the I/O and asks these functions what to accept.
 *
 * **Decision 230's own rules for `get_repo_access`.** Runner names the capability again only under these, since a
 * token with contents write can commit straight to a default branch that no ruleset protects:
 *
 * 1. **The owner scopes it.** A room has a repository only when the machine's owner named it in Runner's local
 *    configuration, by full name and GitHub's numeric ID (L4 on #455). Nothing Podster or the task sends selects or
 *    widens it: `get_repo_access`'s answer must name exactly that repository and its canonical clone URL, and GitHub's
 *    own answer for it must carry that ID.
 * 2. **Protected or nothing.** Before Runner fetches, pushes or opens anything, GitHub must say the default branch is
 *    under the three rules ADR 0009's rulesets put there (`pull_request`, `required_status_checks` and `update`). A
 *    repository without them, such as a private one on GitHub's Free plan, is refused (`repository_unprotected`).
 * 3. **One branch, never the default.** Runner pushes exactly one refspec, `refs/heads/podster/<task>` to itself, with
 *    no `+`, never a tag, and refuses a default branch that is, or sits under, `podster/`.
 * 4. **A fixed set of GitHub calls.** Read the repository, its branch rules and a ref; open, list and read a pull
 *    request. Never a merge, a ref update through the API, a review, a status or anything administrative.
 * 5. **The token stays on the host.** It is held in Runner's memory by the broker, handed to host Git only through the
 *    credential helper's inherited descriptor, and never reaches a container, a file, an argument, an environment
 *    variable, a URL, Git's configuration or a log.
 *
 * Agent content is data: nothing here reads task text; a pull request's title and body are fixed words and the task's ID.
 */

import { isFullName, type RepoScope } from "./policy.js";

export { isFullName, type RepoScope };
/** What `get_repo_access` answered, checked. The token is a secret: never logged, stored or put in an error. */
export type RepoAccess = { token: string; expires_at: number; repository: string; clone_url: string; authority_ends_at: number | null };

/** Why the repository path refused or failed, as a fixed code. Never text from GitHub, Git or Podster. */
export class RepoPathError extends Error {
  readonly code: string;
  /** Worth trying again later: the network, a rate limit, a branch that moved while read. */
  readonly transient: boolean;
  constructor(code: string, transient = false) {
    super(`repository path: ${code}`);
    this.code = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "unknown";
    this.transient = transient;
  }
}

/** Where the owner's configured repository lives, and the one origin Runner's GitHub calls reach. */
export const GIT_HOST = "github.com";
export const API_ORIGIN = "https://api.github.com";
/** The rules ADR 0009's two rulesets put on the default branch. All three must be there. */
export const REQUIRED_RULES = ["pull_request", "required_status_checks", "update"] as const;
/** The server returns the same token until 5 minutes before it expires; Runner asks again a minute before that. */
export const RENEW_BEFORE_MS = 6 * 60 * 1000;
/** The prefix of every task branch. */
export const BRANCH_PREFIX = "podster/";
/** The fixed identity of a commit Runner makes, so no name or address from anywhere else is ever used. */
export const COMMIT_IDENTITY = { name: "Podster Runner", email: "runner@podster.invalid" } as const;

const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TASK = /^[a-z0-9_-]{1,128}$/;
/** A branch name Runner will use or accept as a default branch: plain segments, no ref syntax. */
const BRANCH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export const isCommit = (v: unknown): v is string => typeof v === "string" && COMMIT.test(v);

/** GitHub compares names without case; so does Runner, and never by anything else. */
export const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A branch name that is safe on Git's command line and in a refspec: no `..`, `@{`, leading `-` or `.`, or `.lock`. */
export function isBranch(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 1 || v.length > 200 || !BRANCH.test(v)) return false;
  return v.split("/").every((s) => s !== "" && !s.startsWith(".") && !s.startsWith("-") && !s.endsWith(".lock") && !s.endsWith(".")) && !v.includes("..");
}

/** The one task branch for a task. Its ID is already lower case and path-safe (`policy.ts`). */
export function taskBranch(task_id: string): string {
  if (!TASK.test(task_id)) throw new RepoPathError("task_invalid");
  return `${BRANCH_PREFIX}${task_id}`;
}

/** The only URL Runner gives Git: GitHub's canonical HTTPS address for the scoped repository, with no credentials. */
export const cloneUrl = (full_name: string) => `https://${GIT_HOST}/${full_name}.git`;

/**
 * `get_repo_access`'s answer, checked against the contract's `RepoAccess` and the owner's scope. Any other field, a
 * permission other than the three the contract fixes, another repository or a clone URL other than the canonical one
 * refuses it.
 */
export function readAccess(answer: unknown, scope: RepoScope, now: number): RepoAccess {
  if (!isObj(answer)) throw new RepoPathError("access_invalid");
  const keys = ["token", "expires_at", "repository", "clone_url", "permissions", "authority_ends_at"];
  if (Object.keys(answer).length !== keys.length || !keys.every((k) => Object.hasOwn(answer, k))) throw new RepoPathError("access_invalid");
  const { token, expires_at, repository, clone_url, permissions, authority_ends_at } = answer;
  if (typeof token !== "string" || !TOKEN.test(token)) throw new RepoPathError("access_invalid");
  if (!isCount(expires_at) || expires_at <= now) throw new RepoPathError("access_expired");
  if (!(authority_ends_at === null || isCount(authority_ends_at))) throw new RepoPathError("access_invalid");
  if (!isObj(permissions) || Object.keys(permissions).length !== 3 || permissions.contents !== "write" || permissions.pull_requests !== "write" || permissions.metadata !== "read") throw new RepoPathError("access_permissions");
  if (!isFullName(repository) || !sameName(repository, scope.full_name)) throw new RepoPathError("repository_out_of_scope");
  if (typeof clone_url !== "string" || !sameName(clone_url, cloneUrl(scope.full_name))) throw new RepoPathError("clone_url_unexpected");
  return { token, expires_at, repository, clone_url, authority_ends_at };
}

/** Whether a held token should be asked for again: near its expiry, or past the task's authority. */
export function renewDue(access: RepoAccess, now: number): boolean {
  if (access.authority_ends_at !== null && now >= access.authority_ends_at) return true;
  return now >= access.expires_at - RENEW_BEFORE_MS;
}

/** GitHub's own answer for the repository, held to the owner's scope by its numeric ID. Answers its default branch. */
export function readRepository(answer: unknown, scope: RepoScope, task_id: string): { default_branch: string } {
  if (!isObj(answer)) throw new RepoPathError("repository_unreadable");
  if (answer.id !== scope.provider_repo_id) throw new RepoPathError("repository_id_mismatch");
  if (!isFullName(answer.full_name) || !sameName(answer.full_name, scope.full_name)) throw new RepoPathError("repository_renamed");
  if (answer.archived !== false || answer.disabled === true) throw new RepoPathError("repository_archived");
  const branch = answer.default_branch;
  if (!isBranch(branch)) throw new RepoPathError("default_branch_invalid");
  // The task branch can never be the default branch, or sit beside it under Runner's prefix.
  if (branch === taskBranch(task_id) || branch.startsWith(BRANCH_PREFIX) || `${branch}/`.startsWith(BRANCH_PREFIX)) throw new RepoPathError("default_branch_invalid");
  return { default_branch: branch };
}

/**
 * GitHub's rules for the default branch (`GET /repos/{repo}/rules/branches/{branch}`): every rule ADR 0009's rulesets
 * put there must be listed. A list missing one, or one Runner can't read, refuses: Runner never pushes where a
 * contents-write token could reach the default branch (decision 230).
 */
export function checkProtected(answer: unknown): void {
  if (!Array.isArray(answer)) throw new RepoPathError("repository_unprotected");
  const types = new Set(answer.filter(isObj).map((rule) => rule.type));
  for (const rule of REQUIRED_RULES) if (!types.has(rule)) throw new RepoPathError("repository_unprotected");
}

/** A ref as `GET /repos/{repo}/git/ref/heads/{branch}` answers it: the commit it points at. */
export function readRef(answer: unknown, branch: string): string {
  if (!isObj(answer) || answer.ref !== `refs/heads/${branch}` || !isObj(answer.object) || answer.object.type !== "commit" || !isCommit(answer.object.sha)) throw new RepoPathError("ref_unreadable");
  return answer.object.sha;
}

/**
 * A pull request as GitHub answers it, held to exactly what Runner opened: in the scoped repository, from the task
 * branch of that same repository (never a fork), to the default branch, open, not a draft, with the pushed commit as its
 * head. Answers its number.
 */
export function readPullRequest(answer: unknown, want: { scope: RepoScope; branch: string; default_branch: string; commit: string }): number {
  if (!isObj(answer) || !isCount(answer.number) || answer.number < 1) throw new RepoPathError("pull_request_unreadable");
  const head = answer.head;
  const base = answer.base;
  if (!isObj(head) || !isObj(base) || !isObj(head.repo) || !isObj(base.repo)) throw new RepoPathError("pull_request_unreadable");
  if (base.repo.id !== want.scope.provider_repo_id || head.repo.id !== want.scope.provider_repo_id) throw new RepoPathError("pull_request_wrong_repository");
  if (base.ref !== want.default_branch) throw new RepoPathError("pull_request_wrong_base");
  if (head.ref !== want.branch) throw new RepoPathError("pull_request_wrong_head");
  if (head.sha !== want.commit) throw new RepoPathError("pull_request_commit_changed");
  if (answer.state !== "open" || answer.draft === true) throw new RepoPathError("pull_request_not_open");
  return answer.number;
}

/** The pull request Runner opens: fixed words and the task's ID, never the task's text or the agent's. */
export function pullRequestBody(task_id: string, branch: string, default_branch: string) {
  return {
    title: `Podster task ${task_id}`,
    head: branch,
    base: default_branch,
    body: `Opened by Podster Runner for task ${task_id}. Review it in Podster; Runner never merges.`,
    draft: false,
    maintainer_can_modify: false,
  };
}

/**
 * The settings every host Git command Runner runs starts with (L2 on #459). With `--git-dir` and `--work-tree` named,
 * Git never looks for a `.git` in the task's folder, which the task can write; the Git folder itself is in Runner's home,
 * never mounted into a container. Hooks are off, `core.fsmonitor` is off, no system or global configuration is read
 * (`git-env`), only HTTPS reaches a remote, no redirect is followed, nothing recurses into submodules, and no credential
 * helper is used but Runner's own, and that only for a command that reaches GitHub.
 */
export function hardening(helper: string | null): string[] {
  const settings = [
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "core.untrackedCache=false",
    "core.symlinks=false",
    "core.autocrlf=false",
    "core.sshCommand=false",
    "core.askPass=",
    "protocol.allow=never",
    "protocol.https.allow=always",
    "http.followRedirects=false",
    "http.sslVerify=true",
    "http.proxy=",
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
    "push.recurseSubmodules=no",
    "gc.auto=0",
    "maintenance.auto=false",
    "commit.gpgSign=false",
    "tag.gpgSign=false",
    "credential.useHttpPath=false",
    // An empty value clears every helper named before it, so only Runner's own (or none) is left.
    "credential.helper=",
  ];
  if (helper !== null) settings.push(`credential.helper=${helper}`);
  return settings.flatMap((s) => ["-c", s]);
}

/** A path Runner gives Git on its command line or in a setting: absolute, plain characters only, so no shell reads it. */
export function isPlainPath(v: unknown): v is string {
  return typeof v === "string" && v.length > 1 && v.length < 1024 && /^\/[A-Za-z0-9/._-]+$/.test(v) && !v.split("/").includes("..");
}

/**
 * The location arguments of every Git command for one task: its Git folder and its work tree, both named, so Git never
 * looks for a `.git` in the work tree, which a task's shell can write (#461's finding), and trusts only that work tree.
 */
export function locate(git_dir: string, work_tree: string): string[] {
  if (!isPlainPath(git_dir) || !isPlainPath(work_tree)) throw new RepoPathError("path_unsafe");
  // `safe.directory` names only this work tree, on the command line, which Git counts as protected configuration.
  return ["-c", `safe.directory=${work_tree}`, `--git-dir=${git_dir}`, `--work-tree=${work_tree}`];
}

/** Fetches exactly one branch into one local ref: no tags, no submodules, no other refs. */
export function fetchArgs(full_name: string, branch: string, into: string): string[] {
  if (!isFullName(full_name) || !isBranch(branch) || !/^refs\/runner\/[a-z]+$/.test(into)) throw new RepoPathError("fetch_invalid");
  return ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", cloneUrl(full_name), `refs/heads/${branch}:${into}`];
}

/**
 * Pushes exactly the task branch to itself: no `+`, no tag, no other ref, never the default branch. A push the remote
 * can't fast-forward is refused by Git, so nothing Runner pushes rewrites a branch.
 */
export function pushArgs(full_name: string, branch: string, default_branch: string): string[] {
  if (!isFullName(full_name) || !isBranch(branch) || !branch.startsWith(BRANCH_PREFIX) || branch === default_branch) throw new RepoPathError("push_invalid");
  return ["push", "--porcelain", "--no-verify", "--no-follow-tags", "--recurse-submodules=no", cloneUrl(full_name), `refs/heads/${branch}:refs/heads/${branch}`];
}

/** One call to GitHub's API: a method and a path on `API_ORIGIN`, built here from checked parts only. */
export type GitHubRequest = { method: "GET" | "POST"; path: string; body?: unknown };

function checked(full_name: string, branch?: string) {
  if (!isFullName(full_name) || (branch !== undefined && !isBranch(branch))) throw new RepoPathError("request_invalid");
}

/**
 * Every GitHub call Runner makes, and no other (decision 230's rule 4): read the repository, its default branch's rules
 * and a branch's ref; open a pull request, and find one already open from the task branch. Nothing here can merge,
 * update a ref, review, set a status or change a setting.
 */
export const GITHUB = {
  repository: (full_name: string): GitHubRequest => (checked(full_name), { method: "GET", path: `/repos/${full_name}` }),
  rules: (full_name: string, branch: string): GitHubRequest => (checked(full_name, branch), { method: "GET", path: `/repos/${full_name}/rules/branches/${branch}` }),
  ref: (full_name: string, branch: string): GitHubRequest => (checked(full_name, branch), { method: "GET", path: `/repos/${full_name}/git/ref/heads/${branch}` }),
  openPull: (full_name: string, task_id: string, branch: string, default_branch: string): GitHubRequest => (
    checked(full_name, branch), checked(full_name, default_branch), { method: "POST", path: `/repos/${full_name}/pulls`, body: pullRequestBody(task_id, branch, default_branch) }
  ),
  findPull: (full_name: string, branch: string, default_branch: string): GitHubRequest => {
    checked(full_name, branch);
    checked(full_name, default_branch);
    const owner = full_name.split("/")[0];
    const query = `state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(default_branch)}&per_page=2`;
    return { method: "GET", path: `/repos/${full_name}/pulls?${query}` };
  },
} as const;
