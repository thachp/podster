/**
 * The repository path on the owner's machine (M7 step 10; RUNNER.md "Workroom repository and local task copy"). The
 * lifecycle calls it for a room whose owner named a repository in Runner's configuration:
 *
 * - **The broker** (`RepoBroker`) asks Podster for the task's token with `get_repo_access`, the only place in Runner that
 *   does, and holds it in memory, keyed by task, outside every container. A call that comes within 6 minutes of its
 *   expiry asks again, which the server answers only after every check again (a full recheck; it never extends a token).
 *   Each refusal is reported by its code. A token GitHub stops taking (`401`) is dropped as revoked.
 * - **`prepare`** checks the answer against the owner's scope, reads the repository from GitHub by its numeric ID, refuses
 *   one whose default branch isn't under ADR 0009's rules, reads the commit the run starts from, makes a fresh Git folder
 *   in Runner's home and a fresh work tree in the task's folder, fetches exactly one branch, checks out the task branch at
 *   that commit, and verifies the head and a clean tree before answering it for the decision to pin.
 * - **`publish`**, after the run's container is confirmed stopped, asks for the token again (renewing after a full
 *   recheck if it's due), checks the repository and its rules again, walks the work tree without following anything and
 *   refuses any link or `.git` look-alike the task left, commits on top of the pinned commit under a fixed identity,
 *   pushes the one task branch, and opens its pull request, or finds the one it opened before, and verifies it.
 *
 * Host-side folder access goes through `safe-fs.ts` (`lstat`, `O_NOFOLLOW`, `realpath`; L3 on #459). Git runs as
 * `git.ts` says (L2 on #459). Logs carry IDs and codes only.
 */
import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { GatewayError, meaningOf } from "../core/errors.js";
import type { Publication, PublishWords, RepoTask, RepositoryPath } from "../core/lifecycle.js";
import { pullText } from "../core/pull-text.js";
import {
  checkProtected,
  COMMIT_IDENTITY,
  fetchArgs,
  GITHUB,
  hardening,
  isCommit,
  locate,
  pushArgs,
  readAccess,
  readPullRequest,
  readRef,
  readRepository,
  renewDue,
  RepoPathError,
  taskBranch,
  type GitHubRequest,
  type RepoAccess,
  type RepoScope,
} from "../core/repository.js";
import type { Clock, Logger } from "../core/runtime.js";
import { foldedSegment } from "../core/tool-policy.js";
import { checkedHelper, findGit, gitCli, type GitExec } from "./git.js";
import { githubApi, type GitHubCall } from "./github-api.js";
import { ensureFolder, MAX_FOLDER_ENTRIES, removeOwnFolder } from "./safe-fs.js";

/** Podster's refusals of `get_repo_access` worth asking again later; any other refusal is final for this attempt. */
const PASSING = new Set(["repo_access_busy", "rate_limited", "provider_unavailable", "standing_unknown", "repo_access_unavailable"]);

/** How Runner asks Podster for something as its agent: `Poller.request`. An authority error throws, and ends the run. */
export type AgentRequest = (capability: "get_repo_access", args: Record<string, unknown>) => Promise<unknown>;

const key = (workspace_id: string, task_id: string) => `${workspace_id}/${task_id}`;

/** Holds each task's token in memory, outside every container, and asks Podster again only when it's due. */
export class RepoBroker {
  private readonly held = new Map<string, RepoAccess>();
  private readonly request: AgentRequest;
  private readonly clock: Clock;
  private readonly log: Logger;
  constructor(request: AgentRequest, clock: Clock, log: Logger) {
    this.request = request;
    this.clock = clock;
    this.log = log;
  }

  /** The task's token, checked against the owner's scope: the one held, or a new one after the server's full recheck. */
  async access(workspace_id: string, task_id: string, scope: RepoScope): Promise<RepoAccess> {
    const k = key(workspace_id, task_id);
    const held = this.held.get(k);
    const ids = { workspace: workspace_id, task: task_id };
    if (held && !renewDue(held, this.clock.now())) return held;
    let answer: unknown;
    try {
      answer = await this.request("get_repo_access", { workspace_id, task_id });
    } catch (error) {
      this.held.delete(k);
      if (!(error instanceof GatewayError)) throw error;
      const meaning = meaningOf(error);
      // An authority error is the lifecycle's: it stops everything and retires the key.
      if (meaning === "authority") throw error;
      this.log("repo.access", "refused", { ...ids, status: error.status, code: error.code });
      if (meaning === "transient" || meaning === "rate_limited" || PASSING.has(error.code)) throw new RepoPathError(error.code === "unknown" ? "access_unavailable" : error.code, true);
      throw new RepoPathError(error.code === "unknown" ? "access_refused" : error.code);
    }
    let access: RepoAccess;
    try {
      access = readAccess(answer, scope, this.clock.now());
    } catch (error) {
      this.held.delete(k);
      this.log("repo.access", "refused", error instanceof RepoPathError ? { ...ids, code: error.code, ...error.detail } : { ...ids, code: "access_invalid" });
      throw error;
    }
    this.held.set(k, access);
    this.log("repo.access", held ? "renewed" : "issued", ids);
    return access;
  }

  /** A token GitHub no longer takes: dropped and reported, so the next use asks Podster again. */
  revoked(workspace_id: string, task_id: string): void {
    this.held.delete(key(workspace_id, task_id));
    this.log("repo.access", "revoked", { workspace: workspace_id, task: task_id });
  }

  forget(workspace_id: string, task_id: string): void {
    this.held.delete(key(workspace_id, task_id));
  }

  /** How many tokens are held, for tests. */
  get size(): number {
    return this.held.size;
  }
}

export type RepoPathDeps = {
  /** Runner's home. Each task's Git folder is under `git/` in it, never in a folder a container mounts. */
  home: string;
  broker: RepoBroker;
  git: GitExec;
  github: GitHubCall;
  /** Runner's credential helper (`git.ts`'s `checkedHelper`). */
  helper: string;
  log: Logger;
  /** Waits between reads of a pull request whose head lags the push. */
  wait?: (ms: number) => Promise<void>;
  /** The web app's origin for the task's page link, from `appOriginFor`'s fixed table; null leaves the link out. */
  app_origin?: string | null;
};

/** Reads of a pull request whose head still shows the commit before the push, and the wait between them. */
export const PR_READS = 5;
export const PR_READ_WAIT_MS = 2_000;

export class GitRepositoryPath implements RepositoryPath {
  private readonly deps: RepoPathDeps;
  constructor(deps: RepoPathDeps) {
    this.deps = deps;
  }

  /** A task's Git folder: in Runner's home, apart from the work tree, which is the task's folder. */
  gitDir(workspace_id: string, task_id: string): string {
    return join(this.deps.home, "git", workspace_id, task_id);
  }

  private async api(task: RepoTask, access: RepoAccess, request: GitHubRequest, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
    try {
      return await this.deps.github(request, access.token, signal);
    } catch (error) {
      if (error instanceof RepoPathError && error.code === "token_revoked") this.deps.broker.revoked(task.workspace_id, task.task_id);
      throw error;
    }
  }

  private async read(task: RepoTask, access: RepoAccess, request: GitHubRequest, signal: AbortSignal, missing: string): Promise<unknown> {
    const answer = await this.api(task, access, request, signal);
    if (answer.status === 404) throw new RepoPathError(missing);
    if (answer.status === 403 || answer.status === 429) throw new RepoPathError("github_refused", true);
    if (answer.status >= 500) throw new RepoPathError("github_unavailable", true);
    if (answer.status !== 200) throw new RepoPathError("github_refused");
    return answer.body;
  }

  /** The repository as GitHub has it, held to the scope, with its default branch under ADR 0009's rules. */
  private async checked(task: RepoTask, access: RepoAccess, signal: AbortSignal): Promise<{ default_branch: string }> {
    const scope = scopeOf(task);
    const repo = readRepository(await this.read(task, access, GITHUB.repository(scope.full_name), signal, "repository_gone"), scope, task.task_id);
    // A branch with no rules is answered as an empty list, or not at all where rules aren't available: both refuse.
    const rules = await this.api(task, access, GITHUB.rules(scope.full_name, repo.default_branch), signal);
    checkProtected(rules.status === 200 ? rules.body : null);
    return repo;
  }

  private async git(task: RepoTask, args: string[], opts: { secret?: string; signal: AbortSignal }): Promise<{ code: number; stdout: string; stderr: string }> {
    const helper = opts.secret === undefined ? null : this.deps.helper;
    return this.deps.git([...hardening(helper), ...locate(this.gitDir(task.workspace_id, task.task_id), task.task_folder), ...args], { secret: opts.secret, signal: opts.signal });
  }

  private async head(task: RepoTask, signal: AbortSignal, rev = "HEAD"): Promise<string> {
    const answer = await this.git(task, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], { signal });
    const sha = answer.stdout.trim();
    if (answer.code !== 0 || !isCommit(sha)) throw new RepoPathError("checkout_unverified");
    return sha;
  }

  private async clean(task: RepoTask, signal: AbortSignal): Promise<boolean> {
    const answer = await this.git(task, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=no"], { signal });
    if (answer.code !== 0) throw new RepoPathError("checkout_unverified");
    return answer.stdout === "";
  }

  /**
   * The task's folder never holds Runner's home or sits in it, checked both as written and as the file system resolves
   * them (ruling 4 on #462). The policy refuses such a configuration too; this holds whatever reaches here.
   */
  private async apart(task: RepoTask): Promise<void> {
    const plain = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    const root = dirname(dirname(task.task_folder));
    if (plain(root, this.deps.home) || plain(task.task_folder, this.deps.home)) throw new RepoPathError("path_unsafe");
    const real = async (p: string) => {
      // The nearest part of the path that exists, resolved: a folder not made yet is judged by where it would land.
      let at = p;
      for (;;) {
        try {
          return join(await realpath(at), relative(at, p));
        } catch {
          const up = dirname(at);
          if (up === at) return p;
          at = up;
        }
      }
    };
    if (plain(await real(root), await real(this.deps.home))) throw new RepoPathError("path_unsafe");
  }

  async prepare(task: RepoTask & { continue_from: string | null }, signal: AbortSignal): Promise<{ repository_id: string; base_commit: string }> {
    await this.apart(task);
    const scope = scopeOf(task);
    const access = await this.deps.broker.access(task.workspace_id, task.task_id, scope);
    const { default_branch } = await this.checked(task, access, signal);
    const branch = task.repository.branch;
    // The commit the run starts from: what Runner last pushed, while the task branch still points at it; else the default
    // branch's head. A task branch someone else moved is never built on.
    let start: string;
    let from: string;
    if (task.continue_from !== null) {
      if (!isCommit(task.continue_from)) throw new RepoPathError("record_invalid");
      const head = readRef(await this.read(task, access, GITHUB.ref(scope.full_name, branch), signal, "task_branch_gone"), branch);
      if (head !== task.continue_from) throw new RepoPathError("task_branch_moved");
      start = head;
      from = branch;
    } else {
      start = readRef(await this.read(task, access, GITHUB.ref(scope.full_name, default_branch), signal, "default_branch_gone"), default_branch);
      from = default_branch;
    }

    // A fresh Git folder and a fresh work tree, both made by Runner, mode 0700, through no link.
    const gitDir = this.gitDir(task.workspace_id, task.task_id);
    await removeOwnFolder(gitDir);
    await removeOwnFolder(task.task_folder);
    await ensureFolder(join(this.deps.home, "git"), gitDir, { makeRoot: true });
    await ensureFolder(dirname(dirname(task.task_folder)), task.task_folder, { makeRoot: true });
    // No templates, so no sample hooks or anything else from the system's Git is copied in.
    if ((await this.git(task, ["init", "--quiet", "--template="], { signal })).code !== 0) throw new RepoPathError("git_init_failed");
    const fetched = await this.git(task, fetchArgs(scope.full_name, from, "refs/runner/start"), { secret: access.token, signal });
    if (fetched.code !== 0) throw this.gitFailure(task, fetched, "fetch_failed");
    // Pinned and verified: the commit fetched must be the one GitHub's API named; a branch that moved between is retried.
    if ((await this.head(task, signal, "refs/runner/start")) !== start) throw new RepoPathError("base_moved", true);
    if ((await this.git(task, ["checkout", "--quiet", "--no-track", "-b", branch, start], { signal })).code !== 0) throw new RepoPathError("checkout_failed");
    if ((await this.head(task, signal)) !== start || !(await this.clean(task, signal))) throw new RepoPathError("checkout_unverified");
    this.deps.log("repo.checkout", "verified", { workspace: task.workspace_id, task: task.task_id });
    return { repository_id: String(scope.provider_repo_id), base_commit: start };
  }

  async publish(task: RepoTask & { base_commit: string } & Partial<PublishWords>, signal: AbortSignal): Promise<Publication> {
    const scope = scopeOf(task);
    const branch = task.repository.branch;
    // The task's ID is checked before the words name it.
    taskBranch(task.task_id);
    const text = pullText({ workspace_id: task.workspace_id, task_id: task.task_id, title: task.title ?? null, change_type: task.change_type ?? null, app_origin: this.deps.app_origin ?? null });
    // Renewed after a full server recheck when it's due: a run can outlast the hour a token lives.
    const access = await this.deps.broker.access(task.workspace_id, task.task_id, scope);
    const { default_branch } = await this.checked(task, access, signal);
    await this.apart(task);
    await checkWorkTree(task.task_folder);
    // Nothing in a container can reach the Git folder, so its head is the pinned commit, or Runner's own one commit on
    // it from an earlier try that a passing failure stopped (ruling 5 on #462); anything else refuses.
    const before = await this.head(task, signal);
    if (before !== task.base_commit && (await this.head(task, signal, "HEAD^")) !== task.base_commit) throw new RepoPathError("checkout_moved");
    // `:/` names the whole work tree from its top, whatever Git's working folder is.
    if ((await this.git(task, ["add", "--all", "--", ":/"], { signal })).code !== 0) throw new RepoPathError("commit_failed");
    if (before === task.base_commit) {
      if (await this.clean(task, signal)) return { kind: "no_changes" };
      const identity = ["-c", `user.name=${COMMIT_IDENTITY.name}`, "-c", `user.email=${COMMIT_IDENTITY.email}`];
      const committed = await this.git(task, [...identity, "commit", "--quiet", "--no-verify", "--no-gpg-sign", "--cleanup=verbatim", "-m", text.commit_message], { signal });
      if (committed.code !== 0) throw new RepoPathError("commit_failed");
    } else if (!(await this.clean(task, signal))) throw new RepoPathError("commit_unexpected");
    const commit = await this.head(task, signal);
    // Exactly one commit of Runner's on top of the pinned one.
    if ((await this.head(task, signal, "HEAD^")) !== task.base_commit) throw new RepoPathError("commit_unexpected");

    const pushed = await this.git(task, pushArgs(scope.full_name, branch, default_branch), { secret: access.token, signal });
    if (pushed.code !== 0) throw this.gitFailure(task, pushed, "push_failed");
    if (!pushed.stdout.split("\n").some((line) => /^[*= ]\t/.test(line) && line.includes(`refs/heads/${branch}:refs/heads/${branch}`))) throw new RepoPathError("push_unconfirmed");

    const want = { scope, branch, default_branch, commit };
    const opened = await this.api(task, access, GITHUB.openPull(scope.full_name, text, branch, default_branch), signal);
    if (opened.status !== 201 && opened.status !== 422) {
      if (opened.status >= 500 || opened.status === 403 || opened.status === 429) throw new RepoPathError("github_unavailable", true);
      throw new RepoPathError("pull_request_refused");
    }
    // A 422 is one already open from the task branch: Runner's own from an earlier run, read and held to the same checks.
    // GitHub can show a pull request's head from before the push for a moment, so a lagging head is read again, a few
    // times, before it counts as a passing failure (ruling 5 on #462). Every other mismatch refuses at once.
    let pr: number | null = null;
    let body: unknown = opened.status === 201 ? opened.body : null;
    for (let read = 0; pr === null; read++) {
      if (body === null) {
        const found = await this.read(task, access, GITHUB.findPull(scope.full_name, branch, default_branch), signal, "pull_request_not_found");
        if (!Array.isArray(found) || found.length !== 1) throw new RepoPathError("pull_request_not_found");
        body = found[0];
      }
      try {
        pr = readPullRequest(body, want);
      } catch (error) {
        if (!(error instanceof RepoPathError) || error.code !== "pull_request_commit_changed") throw error;
        if (read + 1 >= PR_READS) throw new RepoPathError("pull_request_commit_changed", true);
        body = null;
        await (this.deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(PR_READ_WAIT_MS);
      }
    }
    this.deps.log("repo.publish", "pull_request", { workspace: task.workspace_id, task: task.task_id, count: pr });
    return { kind: "published", branch, commit, pr_number: pr };
  }

  forget(workspace_id: string, task_id: string): void {
    this.deps.broker.forget(workspace_id, task_id);
  }

  /** A failed fetch or push, by a fixed code: a refused credential reads as a revoked token. Git's words are never kept. */
  private gitFailure(task: RepoTask, result: { stdout: string; stderr: string }, fallback: string): RepoPathError {
    const text = `${result.stdout}\n${result.stderr}`;
    if (/Authentication failed|could not read (Username|Password)|returned error: 40[13]|Invalid username or (password|token)/i.test(text)) {
      this.deps.broker.revoked(task.workspace_id, task.task_id);
      return new RepoPathError("token_revoked");
    }
    if (/\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first/.test(text)) return new RepoPathError("push_rejected");
    if (/Could not resolve host|Failed to connect|Connection timed out|Operation timed out|unable to access/i.test(text)) return new RepoPathError("github_unreachable", true);
    return new RepoPathError(fallback);
  }
}

const scopeOf = (task: RepoTask): RepoScope => ({ full_name: task.repository.full_name, provider_repo_id: task.repository.provider_repo_id });

/**
 * The work tree, walked with `lstat` and never through a link, before anything is committed from it: no link of any
 * kind, nothing named `.git` or folding to it at any depth (a nested repository would be read by host Git), and no more
 * entries than the folder bound allows.
 */
export async function checkWorkTree(folder: string, maxEntries = MAX_FOLDER_ENTRIES): Promise<void> {
  const stack = [folder];
  let entries = 0;
  while (stack.length > 0) {
    const at = stack.pop() as string;
    const info = await lstat(at);
    if (info.isSymbolicLink()) throw new RepoPathError("work_tree_link");
    if (!info.isDirectory()) {
      if (!info.isFile()) throw new RepoPathError("work_tree_special");
      continue;
    }
    const dir = await opendir(at);
    for await (const entry of dir) {
      if (++entries > maxEntries) throw new RepoPathError("work_tree_too_large");
      if (foldedSegment(entry.name) === ".git") throw new RepoPathError("work_tree_git");
      stack.push(join(at, entry.name));
    }
  }
}

/**
 * The repository path `run` uses: Git from a fixed place, Runner's own credential helper, and GitHub's API with no proxy
 * or trust from the environment. Null, with a log line by code, when any of them can't be had: a room with a repository
 * then refuses its tasks (`repository_unavailable`), and every other room runs as before.
 */
export async function hostRepositoryPath(home: string, request: AgentRequest, clock: Clock, log: Logger, opts: { git?: string | null; helper?: string; github?: GitHubCall; app_origin?: string | null } = {}): Promise<GitRepositoryPath | null> {
  const program = opts.git === undefined ? findGit() : opts.git;
  if (!program) {
    log("repo.setup", "unavailable", { code: "git_not_found" });
    return null;
  }
  let helper: string;
  try {
    helper = await checkedHelper(opts.helper);
  } catch {
    log("repo.setup", "unavailable", { code: "helper_unavailable" });
    return null;
  }
  let github: GitHubCall;
  try {
    github = opts.github ?? githubApi();
  } catch {
    log("repo.setup", "unavailable", { code: "environment_refused" });
    return null;
  }
  // An empty home for Git, so it reads no one's settings; the Git folders sit beside it, under `git/`.
  const gitHome = await ensureFolder(home, join(home, "git-home"));
  return new GitRepositoryPath({ home, broker: new RepoBroker(request, clock, log), git: gitCli(program, gitHome), github, helper, log, app_origin: opts.app_origin ?? null });
}
