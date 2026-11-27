// #520 and #525: Runner on a real Git 2.25, Ubuntu 20.04's, which WSL installs. CI's `runner` job runs it on GitHub's
// Ubuntu runner through vitest.linux.config.ts, with RUNNER_LINUX_DOCKER=1; set RUNNER_OLD_GIT_DOCKER=1 to run it on a
// Mac with Docker. Never in the default config. It starts the official `buildpack-deps:focal-scm` image (Ubuntu 20.04 with
// its own Git, pinned by digest; it downloads nothing once pulled), and runs Runner's real setup, `prepare` and `publish` with every host Git
// command run by that Git, as the owner's user, against a local bare repository standing in for GitHub. No GitHub, no
// token, no provider. It proves:
// - setup reads `git version 2.25.1`, accepts it, and leaves out `--no-write-fetch-head`, which 2.25 refuses;
// - the whole checkout (init, fetch, `rev-parse --end-of-options`, checkout, status with `core.fsmonitor=false`) and
//   publish (`ls-files`, `diff --end-of-options`, `cat-file`, commit, push) work on it, and the push lands;
// - with the flag, 2.25 answers exit 129 and its usage text, which Runner reads as `fetch_git_too_old`, not `fetch_failed`.
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneUrl, fetchArgs, gitFailureCause, gitFailureCode, hardening, locate } from "../src/core/repository.js";
import { lineLogger } from "../src/core/runtime.js";
import { dockerHost, findDocker } from "../src/node/docker-sandbox.js";
import { findGit, gitCli, gitEnv } from "../src/node/git.js";
import type { GitHubCall } from "../src/node/github-api.js";
import { hostRepositoryPath } from "../src/node/repo-path.js";

const ON = process.env.RUNNER_OLD_GIT_DOCKER === "1" || (process.platform === "linux" && process.env.RUNNER_LINUX_DOCKER === "1");
const docker = findDocker();
const hostGit = findGit();
// Ubuntu 20.04 with its own Git 2.25.1 already installed, pinned by digest, so setup never waits on an apt mirror
// (main's CI hung 10 minutes in apt-get on 2026-11-23).
const IMAGE = "buildpack-deps:focal-scm@sha256:fa56fe73b4475655b2f39d6376b6a6664d24b5c43227f709d4a923609f3286a1";
const NAME = `podster-old-git-${process.pid}`;
const NOW = 1_800_000_000_000;
const SCOPE = { full_name: "podsterdev/todo-app", provider_repo_id: 9001 };
const TOKEN = "ghs_TestToken0123456789abcdefABCDEF";
const ACCESS = { token: TOKEN, expires_at: NOW + 60 * 60 * 1000, repository: SCOPE.full_name, clone_url: cloneUrl(SCOPE.full_name), permissions: { contents: "write", metadata: "read", pull_requests: "write" }, authority_ends_at: null };

const dockerEnv = () => ({ PATH: "/usr/bin:/bin:/usr/local/bin", ...(dockerHost() ? { DOCKER_HOST: dockerHost() as string } : {}), HOME: process.env.HOME ?? "/" });
const run = (args: string[]) => execFileSync(docker as string, args, { env: dockerEnv(), stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 }).toString();
const sh = (cwd: string, ...args: string[]) => execFileSync(hostGit as string, args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();

describe.skipIf(!ON || docker === null || hostGit === null)("Runner on Git 2.25 (#520, #525)", () => {
  let root = "";
  let wrapper = "";
  let remote = "";

  beforeAll(async () => {
    // The real path, so the folder is mounted where Runner names it (a Mac's /var is a link to /private/var).
    root = await realpath(await mkdtemp(join(tmpdir(), "runner-oldgit-")));
    run(["run", "-d", "--rm", "--name", NAME, "--network", "bridge", "-v", `${root}:${root}`, IMAGE, "sleep", "3600"]);
    expect(run(["exec", NAME, "git", "--version"]).trim()).toBe("git version 2.25.1");
    // A local bare repository standing in for GitHub, made with the host's Git.
    const seed = join(root, "seed");
    await mkdir(seed);
    sh(seed, "init", "--quiet");
    sh(seed, "checkout", "--quiet", "-b", "main");
    await writeFile(join(seed, "README.md"), "hello\n");
    sh(seed, "add", "README.md");
    sh(seed, "commit", "--quiet", "-m", "first");
    remote = join(root, "remote.git");
    sh(root, "clone", "--quiet", "--bare", seed, remote);
    // Runner's Git program: runs the container's Git as this user, in the same folder, with exactly Runner's Git
    // environment, and with GitHub's URL swapped for the local bare repository (file transport allowed for it only).
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    const names = Object.keys(gitEnv(root, {})).map((n) => `-e ${n}`).join(" ");
    const dockerConfig = join(root, "docker-config");
    await mkdir(dockerConfig);
    wrapper = join(root, "bin", "git");
    await mkdir(join(root, "bin"));
    await writeFile(
      wrapper,
      [
        "#!/bin/sh",
        `n=$#`,
        `for a in "$@"; do if [ "$a" = "${cloneUrl(SCOPE.full_name)}" ]; then a="${remote}"; fi; set -- "$@" "$a"; done`,
        `shift $n`,
        ...(dockerHost() ? [`DOCKER_HOST='${dockerHost()}'; export DOCKER_HOST`] : []),
        `DOCKER_CONFIG='${dockerConfig}'; export DOCKER_CONFIG`,
        `exec '${docker}' exec -i -u ${uid}:${gid} -w "$PWD" ${names} ${NAME} git -c protocol.file.allow=always "$@"`,
        "",
      ].join("\n"),
    );
    await chmod(wrapper, 0o700);
  }, 900_000);

  afterAll(async () => {
    spawnSync(docker as string, ["rm", "-f", NAME], { env: dockerEnv(), stdio: "ignore" });
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("sets up on 2.25 without --no-write-fetch-head, checks out, commits and pushes the task branch", async () => {
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const taskFolder = join(root, "work", "room_1", "task_1");
    const head = (b: string) => {
      try {
        return sh(remote, "rev-parse", `refs/heads/${b}`);
      } catch {
        return null;
      }
    };
    const calls: string[] = [];
    const github: GitHubCall = async (request) => {
      calls.push(`${request.method} ${request.path}`);
      const p = request.path;
      if (p === "/repos/podsterdev/todo-app") return { status: 200, body: { id: 9001, full_name: "podsterdev/todo-app", archived: false, private: true, default_branch: "main" } };
      if (p === "/repos/podsterdev/todo-app/rules/branches/main") return { status: 200, body: [{ type: "pull_request" }, { type: "required_status_checks" }, { type: "update" }] };
      const ref = /^\/repos\/podsterdev\/todo-app\/git\/ref\/heads\/(.+)$/.exec(p);
      if (ref) {
        const sha = head(ref[1]);
        return sha ? { status: 200, body: { ref: `refs/heads/${ref[1]}`, object: { type: "commit", sha } } } : { status: 404, body: null };
      }
      if (p === "/repos/podsterdev/todo-app/pulls" && request.method === "POST") return { status: 201, body: { number: 12, state: "open", draft: false, head: { ref: "podster/task_1", sha: head("podster/task_1"), repo: { id: 9001 } }, base: { ref: "main", repo: { id: 9001 } } } };
      return { status: 404, body: null };
    };
    const logged: string[] = [];
    const clock = { now: () => NOW, idle: async () => undefined };
    const path = await hostRepositoryPath(home, async () => ({ ...ACCESS }), clock, lineLogger((l) => logged.push(l)), { git: wrapper, github });
    expect(logged).toEqual([]);
    expect(path).not.toBeNull();
    const task = { workspace_id: "room_1", task_id: "task_1", task_folder: taskFolder, repository: { ...SCOPE, branch: "podster/task_1" } };
    const signal = new AbortController().signal;
    const checkout = await path!.prepare({ ...task, continue_from: null }, signal);
    expect(checkout).toEqual({ repository_id: "9001", base_commit: head("main") });
    // 2.25 wrote FETCH_HEAD into the task's Git folder in Runner's home, never into the task's folder.
    const gitDir = path!.gitDir("room_1", "task_1");
    expect(sh(root, "--git-dir", gitDir, "rev-parse", "refs/runner/start")).toBe(head("main"));
    await writeFile(join(taskFolder, "hello.txt"), "hi from 2.25\n");
    const published = await path!.publish({ ...task, base_commit: checkout.base_commit }, signal);
    expect(published).toMatchObject({ kind: "published", branch: "podster/task_1", pr_number: 12 });
    expect(head("podster/task_1")).toBe((published as { commit: string }).commit);
    expect(sh(remote, "show", "podster/task_1:hello.txt")).toBe("hi from 2.25");
    expect(sh(remote, "rev-parse", "podster/task_1^")).toBe(checkout.base_commit);
  });

  it("shows what 2.25 does with Runner's flags: --no-write-fetch-head refused as fetch_git_too_old; --end-of-options and core.fsmonitor=false work", async () => {
    const home = join(root, "home2");
    await mkdir(home, { mode: 0o700 });
    const git = gitCli(wrapper, home);
    expect((await git(["--version"], {})).stdout.trim()).toBe("git version 2.25.1");
    const loc = locate(join(root, "gd2"), join(root, "wt2"));
    await mkdir(join(root, "wt2"));
    expect((await git([...hardening(null), ...loc, "init", "--quiet", "--template="], {})).code).toBe(0);
    const refused = await git([...hardening(null), ...loc, ...fetchArgs(SCOPE.full_name, "main", "refs/runner/start")], {});
    expect(refused.code).toBe(129);
    expect(refused.stderr).toContain("unknown option `no-write-fetch-head'");
    expect(gitFailureCode(gitFailureCause(refused, "fetch"), "fetch")).toEqual({ code: "fetch_git_too_old", transient: false, revoke: false });
    expect((await git([...hardening(null), ...loc, ...fetchArgs(SCOPE.full_name, "main", "refs/runner/start", false)], {})).code).toBe(0);
    const main = sh(remote, "rev-parse", "refs/heads/main");
    const parsed = await git([...hardening(null), ...loc, "rev-parse", "--verify", "--quiet", "--end-of-options", "refs/runner/start^{commit}"], {});
    expect([parsed.code, parsed.stdout.trim()]).toEqual([0, main]);
    expect((await git([...hardening(null), ...loc, "rev-parse", "--verify", "--quiet", "--end-of-options", "refs/runner/none^{commit}"], {})).code).toBe(1);
    expect((await git([...hardening(null), ...loc, "checkout", "--quiet", "--no-track", "-b", "podster/task_2", main], {})).code).toBe(0);
    // `core.fsmonitor=false`: 2.25 reads the setting as a hook's path; `false` exits 1, so Git scans as usual.
    const status = await git([...hardening(null), ...loc, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=no"], {});
    expect([status.code, status.stdout]).toEqual([0, ""]);
    await writeFile(join(root, "wt2", "new.txt"), "x\n");
    expect((await git([...hardening(null), ...loc, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=no"], {})).stdout).toBe("?? new.txt\n");
  });
});
