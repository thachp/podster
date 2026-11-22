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
 * Agent content is data: nothing here reads task text. A pull request's title, body and commit message come from
 * `pull-text.ts`, which makes the task's title inert on GitHub and links the task's page only from fixed parts.
 */

import { isFullName, type RepoScope } from "./policy.js";

export { isFullName, type RepoScope };
/** What `get_repo_access` answered, checked. The token is a secret: never logged, stored or put in an error. */
export type RepoAccess = { token: string; expires_at: number; repository: string; clone_url: string; authority_ends_at: number | null };

/** Why the repository path refused or failed, as a fixed code. Never text from GitHub, Git or Podster. */
export type AccessDetail = { names?: string; count?: number; length?: number; prefix?: "yes" | "no"; type?: string; stage?: RepoStage; exit_code?: number };

/**
 * Where on the repository path a failure happened (#520): `facts`, GitHub's API answers read before any Git command
 * (the repository, its rules, the start ref); `fetch` and `push`, host Git against GitHub; `checkout`, host Git on this
 * machine only. A fixed word, for the log and the local diagnostics file.
 */
export type RepoStage = "facts" | "fetch" | "checkout" | "push";

const KEY_NAME = /^[a-z_]{1,40}$/;

/** The JSON type name of a value, as a fixed word. */
const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export class RepoPathError extends Error {
  readonly code: string;
  /** Worth trying again later: the network, a rate limit, a branch that moved while read. */
  readonly transient: boolean;
  /** Fixed-shape facts about a refused answer, for the log: key names, a length, a type. Never a value. */
  readonly detail: AccessDetail;
  constructor(code: string, transient = false, detail: AccessDetail = {}) {
    super(`repository path: ${code}`);
    this.detail = detail;
    this.code = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "unknown";
    this.transient = transient;
  }
}

/** Where the owner's configured repository lives, and the one origin Runner's GitHub calls reach. */
export const GIT_HOST = "github.com";
export const API_ORIGIN = "https://api.github.com";
/** The rules ADR 0009's two rulesets put on the default branch. All three must be there. */
export const REQUIRED_RULES = ["pull_request", "required_status_checks", "update"] as const;
/**
 * When Runner asks for a held token again. Every `get_repo_access` call reruns the server's whole decision
 * (`decide_access`), but the server answers the token it holds while more than 5 minutes of it are left
 * (`TOKEN_RENEW_BEFORE_MS` in `crates/core/src/repo_access.rs`), and mints a new one only after that. At 6 minutes, as
 * this was first set, a renewal got the same token back. At 4 minutes it is inside the server's window, so a renewal is
 * a new token, minted after that full recheck (#462's review, item 9).
 */
export const RENEW_BEFORE_MS = 4 * 60 * 1000;
/**
 * The folders at the top of the work tree (/work) where tools in the task's container keep caches and installs: npm's
 * global prefix (the task image's npmrc), cargo's home (`CARGO_HOME`), and `.cache`, which holds the task's `HOME`
 * (`.cache/home`, so every tool's dot folder lands there) and the caches the other toolchains' `TOOLCHAIN_ENV` puts
 * there (uv's, the .NET CLI's, NuGet's, Maven's and Gradle's). Runner writes them into the `info/exclude` of its own Git folder,
 * which no container can reach, so they are never committed, whatever the repository's own `.gitignore` says. A file the
 * repository tracks under one of them is still committed as usual: an exclude applies only to untracked files.
 */
export const WORK_TREE_CACHES = [".cache", ".cargo", ".npm-global"] as const;
/**
 * Runner's default ignore list, written into its own `info/exclude` after the cache folders and applied to every
 * repository whatever its `.gitignore` says, so a repository with none can still publish after an install and never
 * commits what an agent leaves behind:
 * - dependency folders that hold links: `node_modules/` and `.venv/` at any depth (a monorepo nests them);
 * - Python's `__pycache__/` and `.pytest_cache/` at any depth;
 * - package managers' caches at any depth: npm's `.npm-cache/` and `.npm/`, Yarn's `.yarn/cache/` (led by `**` and a slash, so it isn't
 *   anchored at the top, as a line with a `/` inside would be), pnpm's `.pnpm-store/`, and `.cache/` (2026-11-21: an
 *   agent ran npm with its cache at `/work/.npm-cache`, and Runner's one commit held 524 cache files, about 140 MB, so the
 *   push failed). `.cache/` at any depth also covers the top `.cache` that `WORK_TREE_CACHES` names, which holds the
 *   task's `HOME`; both lines stay, the first anchored there whatever this list says;
 * - at the top only: cargo's build folder `/target/`, wrangler's local state `/.wrangler/`, and agents' scratch `/.tmp/`;
 * - `.DS_Store` at any depth;
 * - `.env` and `.env.*` at any depth, except `.env.example`, `.env.sample` and `.env.template`, so an agent-written
 *   `.env` is never committed.
 * Folder lines end in `/`, so a link by one of those names isn't excluded and the work tree check still refuses it; a
 * folder Git then ignores whole is skipped by that check (`ignoredFolders`), unless another ignored entry is listed
 * beneath it (`wholeFolders`), so an excluded `.env` that is a link is always reached and refuses, at any depth. An exclude applies only to untracked files:
 * a file the repository tracks under or by one of these names is still committed as usual, and a folder holding one is
 * walked by the work tree check as before.
 */
export const WORK_TREE_DEFAULT_IGNORE = [
  "node_modules/",
  ".venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".npm-cache/",
  ".npm/",
  "**/.yarn/cache/",
  ".pnpm-store/",
  ".cache/",
  "/target/",
  "/.wrangler/",
  "/.tmp/",
  ".DS_Store",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
] as const;
/**
 * The `info/exclude` Runner writes: each cache folder, anchored at the work tree's top, as a folder only, then the
 * default ignore list (`WORK_TREE_DEFAULT_IGNORE`) as written there.
 */
export const WORK_TREE_EXCLUDE = [...WORK_TREE_CACHES.map((name) => `/${name}/`), ...WORK_TREE_DEFAULT_IGNORE].map((line) => `${line}\n`).join("");

/**
 * The most one publish commits, checked after `git add --all` and before the commit (2026-11-21: a commit of npm's cache,
 * 524 files and about 140 MB, made the push fail). All three are fixed here, in code:
 * - `file_bytes`, 50 MiB for any one file: GitHub warns about a file over 50 MiB and refuses one over 100 MiB (GH001),
 *   so this refuses before GitHub would, with room to spare (`work_tree_file_too_large`);
 * - `bytes`, 50 MiB for all the files the commit adds or changes, as Git stores them uncompressed: a task's change is
 *   source and a lock file, which is kilobytes to a few megabytes; a push of hundreds of megabytes is what fails over
 *   HTTPS, and anything near this is almost always a cache, a build or a download the agent left (`work_tree_too_large`);
 * - `files`, 5,000 paths added, changed or deleted, far past any hand-made change and under the 1 MB Runner reads of
 *   Git's list of them (`work_tree_too_large`).
 * A file over `file_bytes` is named by its own code even when the total is over too. **Proposed** figures.
 */
export const COMMIT_LIMITS = Object.freeze({ files: 5_000, bytes: 50 * 1024 * 1024, file_bytes: 50 * 1024 * 1024 });

/** Changed paths in a commit-to-be, and the blobs it adds or changes, from `git diff --raw -z --no-abbrev`. */
export type StagedChanges = { paths: number; blobs: string[] };

const NO_OBJECT = /^0+$/;

/**
 * Reads `git diff --cached --raw -z --no-renames --no-abbrev` as bytes: each entry is `:<old mode> <new mode> <old id>
 * <new id> <status>` then the path, NUL after each. Counts every path, and keeps each new blob ID the commit would add:
 * none for a deletion, none for a submodule (mode 160000), which carries no content. Anything else shaped refuses.
 */
export function readStagedChanges(listing: Uint8Array): StagedChanges {
  const parts = Buffer.from(listing.buffer, listing.byteOffset, listing.byteLength).toString("latin1").split("\0");
  if (parts.at(-1) === "") parts.pop();
  if (parts.length % 2 !== 0) throw new RepoPathError("commit_failed");
  const blobs: string[] = [];
  for (let at = 0; at < parts.length; at += 2) {
    const head = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z])$/.exec(parts[at]);
    if (!head || parts[at + 1] === "") throw new RepoPathError("commit_failed");
    const [, , mode, , id, status] = head;
    if (status !== "D" && mode !== "160000" && !NO_OBJECT.test(id)) blobs.push(id);
  }
  return { paths: parts.length / 2, blobs };
}

/**
 * Refuses a commit-to-be over `COMMIT_LIMITS`, given its path count and each added or changed blob's size, in bytes, as
 * `git cat-file --batch-check=%(objectsize)` answers them: one file too large first, then too many paths or bytes.
 */
export function checkCommitSize(paths: number, sizes: readonly number[], limits: { files: number; bytes: number; file_bytes: number } = COMMIT_LIMITS): void {
  if (sizes.some((size) => size > limits.file_bytes)) throw new RepoPathError("work_tree_file_too_large");
  if (paths > limits.files || sizes.reduce((sum, size) => sum + size, 0) > limits.bytes) throw new RepoPathError("work_tree_too_large");
}

/** The prefix of every task branch. */
export const BRANCH_PREFIX = "podster/";
/** The fixed identity of a commit Runner makes, so no name or address from anywhere else is ever used. */
export const COMMIT_IDENTITY = { name: "Podster Runner", email: "runner@podster.invalid" } as const;

/**
 * The longest installation token Runner takes. GitHub's installation tokens are now `ghs_APPID_JWT`, "~520 characters"
 * that "will vary", with no published maximum, and GitHub says to treat them as opaque (changelog, 2026-04-24 and
 * 2026-10-02). This leaves room for that to grow while keeping a hostile answer bounded. The server holds the same bound
 * (`INSTALLATION_TOKEN_MAX` in `crates/core/src/repo_access.rs`).
 */
export const MAX_ACCESS_TOKEN = 4096;
/**
 * A token's characters: a JWT's base64url segments, their dots, and the `_` of `ghs_APPID_`. Never whitespace, a control
 * character, `:`, `@`, `/`, `=` or anything else that could end or bend an `Authorization` header, a URL or a line of Git's
 * credential protocol.
 */
const TOKEN = new RegExp(`^[A-Za-z0-9._-]{20,${MAX_ACCESS_TOKEN}}$`);
/** Whether a string can be an installation token: its characters and length, nothing about its contents. */
export const isAccessToken = (v: string): boolean => TOKEN.test(v);
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

/** The pull request's address, for a submission's link (M7 step 11): the scoped repository and Runner's own number. */
export const pullRequestUrl = (full_name: string, number: number) => `https://${GIT_HOST}/${full_name}/pull/${number}`;

/**
 * `get_repo_access`'s answer, checked against the contract's `RepoAccess` and the owner's scope. Any other field, a
 * permission other than the three the contract fixes, another repository or a clone URL other than the canonical one
 * refuses it.
 */
export function readAccess(answer: unknown, scope: RepoScope, now: number): RepoAccess {
  if (!isObj(answer)) throw new RepoPathError("access_not_object", false, { type: typeName(answer) });
  const keys = ["token", "expires_at", "repository", "clone_url", "permissions", "authority_ends_at"];
  if (Object.keys(answer).length !== keys.length || !keys.every((k) => Object.hasOwn(answer, k))) {
    // Only key names that look like names, at most 10, so a hostile answer can't put text in a log.
    const names = Object.keys(answer).sort().slice(0, 10).map((k) => (KEY_NAME.test(k) ? k : "?")).join(",");
    throw new RepoPathError("access_fields", false, { count: Object.keys(answer).length, ...(names ? { names } : {}) });
  }
  const { token, expires_at, repository, clone_url, permissions, authority_ends_at } = answer;
  if (typeof token !== "string") throw new RepoPathError("access_token_format", false, { type: typeName(token) });
  if (!isAccessToken(token)) throw new RepoPathError("access_token_format", false, { length: token.length, prefix: /^[a-z]{3}_/.test(token) ? "yes" : "no" });
  if (!isCount(expires_at) || expires_at <= now) throw new RepoPathError("access_expired");
  if (!(authority_ends_at === null || isCount(authority_ends_at))) throw new RepoPathError("access_authority_invalid");
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

/** The pull request Runner opens: its title and body from `pullText`, never anything else of the task's or the agent's. */
export function pullRequestBody(text: { title: string; body: string }, branch: string, default_branch: string) {
  return {
    title: text.title,
    head: branch,
    base: default_branch,
    body: text.body,
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
    // No excludes file: what Git ignores, and so what a publish may skip, comes only from the repository's
    // `.gitignore` files and Runner's own `info/exclude`, never `$HOME/.config/git/ignore` or anyone's global setting.
    "core.excludesFile=/dev/null",
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
  // Through `/bin/sh` by its path, so the helper needs no execute bit (the ruling on #470). The path is plain (`isPlainPath`).
  if (helper !== null) settings.push(`credential.helper=!/bin/sh ${helper}`);
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

/**
 * The oldest Git Runner works with: 2.29, the first with `fetch --no-write-fetch-head` (`fetchArgs`). An older Git
 * refuses that option with its usage text and exit 129, which before #520 read only as `fetch_failed`.
 */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 29];

/** `git --version`'s major and minor, or null when the answer isn't Git's usual `git version X.Y…` line. */
export function parseGitVersion(text: string): [number, number] | null {
  const m = /^git version (\d{1,4})\.(\d{1,4})(?:[.\s]|$)/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Whether a version read by `parseGitVersion` is at least `MIN_GIT_VERSION`. */
export const gitVersionSupported = (v: readonly [number, number]) => v[0] > MIN_GIT_VERSION[0] || (v[0] === MIN_GIT_VERSION[0] && v[1] >= MIN_GIT_VERSION[1]);

/**
 * Why a host Git command against GitHub failed, read from its exit code and its words (#520). The words are matched
 * here and never kept, logged or put in an error; only the cause, a fixed word, leaves. Checked in this order, since one
 * failure often says several things (`unable to access` comes with nearly every transport failure):
 *
 * - `auth`: GitHub refused the credential (401, or Git found none to send).
 * - `access_denied`: GitHub took the credential but refused the repository to it (403, `Permission to … denied`).
 * - `repository_not_found`: GitHub answered that no such repository is visible to the credential (404); for an App's
 *   token, the App isn't installed on it or the token's scope leaves it out.
 * - `ref_missing`: the repository has no such branch (`couldn't find remote ref`).
 * - `dns`, `network`, `tls`: the name didn't resolve; the connection failed, was reset or timed out (and Runner's own
 *   time limit, exit 124); the TLS handshake or the certificate check failed.
 * - `too_large`, `rejected`: a push GitHub or the way to it refused for its size, or as not a fast-forward.
 * - `git_too_old`: Git didn't know an option Runner passes (exit 129, `unknown option`, its usage text).
 * - `https_unavailable`: this Git can't speak HTTPS (no `git-remote-https`).
 * - `local_write`: Git couldn't write Runner's own Git folder (a lock, a permission, a full or read-only disk).
 * - `unknown`: none of these.
 */
export type GitCause = "auth" | "access_denied" | "repository_not_found" | "ref_missing" | "dns" | "network" | "tls" | "too_large" | "rejected" | "git_too_old" | "https_unavailable" | "local_write" | "unknown";

export function gitFailureCause(result: { code: number; stdout: string; stderr: string }, op: "fetch" | "push"): GitCause {
  const text = `${result.stdout}\n${result.stderr}`;
  if (/Authentication failed|could not read (Username|Password)|returned error: 401|Invalid username or (password|token)/i.test(text)) return "auth";
  if (/returned error: 403|Permission to \S+ denied|Write access to repository not granted/i.test(text)) return "access_denied";
  if (/Repository not found|repository '[^'\n]*' not found|returned error: 404/i.test(text)) return "repository_not_found";
  if (/couldn't find remote ref|could not find remote ref/i.test(text)) return "ref_missing";
  if (/Could not resolve (host|proxy)|Temporary failure in name resolution|Name or service not known|nodename nor servname/i.test(text)) return "dns";
  // A timeout or a connection that failed is the network's, whatever else Git said with it: `RPC failed; curl 28
  // Operation timed out` is one. Runner's own time limit (124) is one too.
  if (result.code === 124 || /Failed to connect|Connection (timed out|reset|refused)|Operation timed out|timed out/i.test(text)) return "network";
  if (/SSL certificate problem|certificate verif|server certificate|SSL connect error|SSL_connect|SSL_ERROR|gnutls_handshake|TLS connect error|unable to get local issuer|CAfile|CApath/i.test(text)) return "tls";
  // Only for a push, on a clear sign of size: an HTTP 413, a pack over a limit, or GitHub's large-file refusal; checked
  // before the plain rejection, since GH001 arrives as one. A bare `RPC failed` or `remote end hung up` says neither.
  if (op === "push" && /HTTP 413|returned error: 413|pack exceeds|GH001|exceeds GitHub's file size limit|this exceeds/i.test(text)) return "too_large";
  if (/\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first/.test(text)) return "rejected";
  if (result.code === 129 || /unknown option|unknown switch|^usage: git /im.test(text)) return "git_too_old";
  if (/unable to find remote helper|remote-https|transport 'https' not allowed|Protocol "?https"? not supported/i.test(text)) return "https_unavailable";
  if (/cannot lock ref|unable to (write|create|append)|could not write|Permission denied|No space left|Read-only file system|insufficient permission|Disk quota/i.test(text)) return "local_write";
  if (/unable to access/i.test(text)) return "network";
  return "unknown";
}

/**
 * The fixed code a failed fetch or push is refused with, by its cause, and whether it's tried again later. A fetch
 * names its cause under `fetch_` (#520), so the release reason and `podster why` say which; a push keeps its codes from
 * before (`token_revoked`, `github_unreachable`, `push_too_large`, `push_rejected`, `push_failed`) and names the causes
 * it had none for under `push_`. `revoke`: the token is dropped, so the next use asks Podster again.
 */
export function gitFailureCode(cause: GitCause, op: "fetch" | "push"): { code: string; transient: boolean; revoke: boolean } {
  const passing = cause === "dns" || cause === "network" || cause === "tls";
  if (op === "fetch") {
    const codes: Record<GitCause, string> = {
      auth: "fetch_auth_failed",
      access_denied: "fetch_access_denied",
      repository_not_found: "fetch_repository_not_found",
      // GitHub's API named the branch a moment before: read afresh at the next turn.
      ref_missing: "fetch_ref_missing",
      dns: "fetch_dns_failed",
      network: "fetch_unreachable",
      tls: "fetch_tls_failed",
      too_large: "fetch_failed",
      rejected: "fetch_failed",
      git_too_old: "fetch_git_too_old",
      https_unavailable: "fetch_https_unavailable",
      local_write: "fetch_local_write_failed",
      unknown: "fetch_failed",
    };
    return { code: codes[cause], transient: passing || cause === "ref_missing", revoke: cause === "auth" || cause === "access_denied" };
  }
  const codes: Record<GitCause, string> = {
    auth: "token_revoked",
    access_denied: "token_revoked",
    repository_not_found: "push_repository_not_found",
    ref_missing: "push_failed",
    dns: "github_unreachable",
    network: "github_unreachable",
    tls: "github_unreachable",
    too_large: "push_too_large",
    rejected: "push_rejected",
    git_too_old: "push_git_too_old",
    https_unavailable: "push_https_unavailable",
    local_write: "push_local_write_failed",
    unknown: "push_failed",
  };
  return { code: codes[cause], transient: passing, revoke: cause === "auth" || cause === "access_denied" };
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
  openPull: (full_name: string, text: { title: string; body: string }, branch: string, default_branch: string): GitHubRequest => (
    checked(full_name, branch), checked(full_name, default_branch), { method: "POST", path: `/repos/${full_name}/pulls`, body: pullRequestBody(text, branch, default_branch) }
  ),
  findPull: (full_name: string, branch: string, default_branch: string): GitHubRequest => {
    checked(full_name, branch);
    checked(full_name, default_branch);
    const owner = full_name.split("/")[0];
    const query = `state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(default_branch)}&per_page=2`;
    return { method: "GET", path: `/repos/${full_name}/pulls?${query}` };
  },
} as const;
