// #520: a failed fetch or push is read into a fixed cause and code, never kept as Git's words; the explanation table,
// the diagnostics file and the log carry the cause and the stage.
import { describe, expect, it } from "vitest";
import { explain } from "../src/core/explain.js";
import { fetchArgs, gitFailureCause, gitFailureCode, gitVersionSupported, MIN_GIT_VERSION, NO_FETCH_HEAD_VERSION, parseGitVersion, RepoPathError, type GitCause } from "../src/core/repository.js";
import { logLine } from "../src/core/runtime.js";
import { diagnosticLine, whyLines } from "../src/node/diagnostics.js";

const URL = "https://github.com/podsterdev/creator-demo.git";
const r = (code: number, stderr: string) => ({ code, stdout: "", stderr });

describe("gitFailureCause", () => {
  it("reads each cause from Git's own words, first match by a fixed order", () => {
    const cases: [ReturnType<typeof r>, GitCause][] = [
      [r(128, `fatal: Authentication failed for '${URL}/'\n`), "auth"],
      [r(128, "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n"), "auth"],
      [r(128, `fatal: unable to access '${URL}/': The requested URL returned error: 401\n`), "auth"],
      [r(128, `remote: Write access to repository not granted.\nfatal: unable to access '${URL}/': The requested URL returned error: 403\n`), "access_denied"],
      [r(128, `remote: Repository not found.\nfatal: repository '${URL}/' not found\n`), "repository_not_found"],
      [r(128, "fatal: couldn't find remote ref refs/heads/main\n"), "ref_missing"],
      [r(128, `fatal: unable to access '${URL}/': Could not resolve host: github.com\n`), "dns"],
      [r(128, `fatal: unable to access '${URL}/': Failed to connect to github.com port 443: Connection refused\n`), "network"],
      [r(128, "error: RPC failed; curl 28 Operation timed out after 300000 milliseconds\n"), "network"],
      [r(124, ""), "network"],
      [r(128, `fatal: unable to access '${URL}/': SSL certificate problem: unable to get local issuer certificate\n`), "tls"],
      [r(128, `fatal: unable to access '${URL}/': gnutls_handshake() failed: The TLS connection was non-properly terminated.\n`), "tls"],
      [r(129, "error: unknown option `no-write-fetch-head'\nusage: git fetch [<options>] [<repository> [<refspec>...]]\n"), "git_too_old"],
      [r(129, ""), "git_too_old"],
      [r(128, "fatal: unable to find remote helper for 'https'\n"), "https_unavailable"],
      [r(128, "error: cannot lock ref 'refs/runner/start': Unable to create '/h/refs/runner/start.lock': File exists.\n"), "local_write"],
      [r(128, "fatal: write error: No space left on device\n"), "local_write"],
      [r(128, `fatal: unable to access '${URL}/': Empty reply from server\n`), "network"],
      [r(128, "fatal: the remote end hung up unexpectedly\n"), "unknown"],
      [r(1, ""), "unknown"],
    ];
    for (const [result, cause] of cases) expect([result.stderr, gitFailureCause(result, "fetch")]).toEqual([result.stderr, cause]);
    // Size only for a push.
    expect(gitFailureCause(r(1, "error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413\n"), "push")).toBe("too_large");
    expect(gitFailureCause(r(1, " ! [rejected]  podster/t -> podster/t (non-fast-forward)\n"), "push")).toBe("rejected");
  });
});

describe("gitFailureCode", () => {
  const causes: GitCause[] = ["auth", "access_denied", "repository_not_found", "ref_missing", "dns", "network", "tls", "too_large", "rejected", "git_too_old", "https_unavailable", "local_write", "unknown"];

  it("names a fetch's cause under fetch_, tries the network's and a missing ref again, and drops a refused token", () => {
    expect(Object.fromEntries(causes.map((c) => [c, gitFailureCode(c, "fetch")]))).toEqual({
      auth: { code: "fetch_auth_failed", transient: false, revoke: true },
      access_denied: { code: "fetch_access_denied", transient: false, revoke: true },
      repository_not_found: { code: "fetch_repository_not_found", transient: false, revoke: false },
      ref_missing: { code: "fetch_ref_missing", transient: true, revoke: false },
      dns: { code: "fetch_dns_failed", transient: true, revoke: false },
      network: { code: "fetch_unreachable", transient: true, revoke: false },
      tls: { code: "fetch_tls_failed", transient: true, revoke: false },
      too_large: { code: "fetch_failed", transient: false, revoke: false },
      rejected: { code: "fetch_failed", transient: false, revoke: false },
      git_too_old: { code: "fetch_git_too_old", transient: false, revoke: false },
      https_unavailable: { code: "fetch_https_unavailable", transient: false, revoke: false },
      local_write: { code: "fetch_local_write_failed", transient: false, revoke: false },
      unknown: { code: "fetch_failed", transient: false, revoke: false },
    });
  });

  it("keeps a push's codes from before #520", () => {
    expect(gitFailureCode("auth", "push")).toEqual({ code: "token_revoked", transient: false, revoke: true });
    expect(gitFailureCode("access_denied", "push")).toEqual({ code: "token_revoked", transient: false, revoke: true });
    for (const c of ["dns", "network", "tls"] as const) expect(gitFailureCode(c, "push")).toEqual({ code: "github_unreachable", transient: true, revoke: false });
    expect(gitFailureCode("too_large", "push").code).toBe("push_too_large");
    expect(gitFailureCode("rejected", "push").code).toBe("push_rejected");
    expect(gitFailureCode("unknown", "push").code).toBe("push_failed");
  });

  it("has a plain-English line for every code it can answer, and for setup's git_too_old", () => {
    const codes = new Set(causes.flatMap((c) => [gitFailureCode(c, "fetch").code, gitFailureCode(c, "push").code]));
    codes.add("git_too_old");
    for (const code of codes) {
      expect([code, explain(code).known]).toEqual([code, true]);
      expect([code, explain(`repo_${code}`)]).toEqual([code, explain(code)]);
    }
    expect(explain("repo_fetch_git_too_old").todo).toContain("2.25");
    expect(explain("repo_fetch_failed").what).not.toBe(explain("repo_anything_else").what);
  });
});

describe("Git's version", () => {
  it("reads git --version's usual line, holds it to 2.25, and gives --no-write-fetch-head only to 2.29 or later", () => {
    expect(MIN_GIT_VERSION).toEqual([2, 25]);
    expect(NO_FETCH_HEAD_VERSION).toEqual([2, 29]);
    expect(parseGitVersion("git version 2.50.1 (Apple Git-155)\n")).toEqual([2, 50]);
    expect(parseGitVersion("git version 2.25.1\n")).toEqual([2, 25]);
    expect(parseGitVersion("git version 2.43.0.windows.1")).toEqual([2, 43]);
    expect(parseGitVersion("hub version 2.14")).toBeNull();
    expect(parseGitVersion("")).toBeNull();
    for (const [v, ok] of [[[2, 24], false], [[2, 25], true], [[2, 28], true], [[2, 29], true], [[3, 0], true], [[1, 99], false]] as const) expect(gitVersionSupported(v)).toBe(ok);
    for (const [v, ok] of [[[2, 25], false], [[2, 28], false], [[2, 29], true], [[2, 43], true]] as const) expect(gitVersionSupported(v, NO_FETCH_HEAD_VERSION)).toBe(ok);
    expect(fetchArgs("podsterdev/todo-app", "main", "refs/runner/start")).toContain("--no-write-fetch-head");
    expect(fetchArgs("podsterdev/todo-app", "main", "refs/runner/start", false)).toEqual(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "https://github.com/podsterdev/todo-app.git", "refs/heads/main:refs/runner/start"]);
  });
});

describe("the stage, in the log and the diagnostics file", () => {
  it("logs a stage only as a fixed lower-case word", () => {
    expect(logLine("lifecycle.repository", "refused", { code: "fetch_git_too_old", stage: "fetch" })).toBe('{"at":"lifecycle.repository","outcome":"refused","code":"fetch_git_too_old","stage":"fetch"}');
    expect(logLine("x", "y", { stage: "fetch https://github.com/a" })).toBe('{"at":"x","outcome":"y"}');
  });

  it("writes the stage and Git's exit code, never Git's words, and podster why names the stage", () => {
    const error = new RepoPathError("fetch_git_too_old", false, { stage: "fetch", exit_code: 129 });
    const line = JSON.parse(diagnosticLine({ at: "lifecycle.repository", code: error.code, workspace: "wsp_1", task: "tsk_1", error }, 0)) as Record<string, unknown>;
    expect(line).toMatchObject({ code: "fetch_git_too_old", stage: "fetch", exit_code: 129, transient: 0, message: "repository path: fetch_git_too_old" });
    const why = whyLines("tsk_1", line, "/h/logs/errors.jsonl");
    expect(why[0]).toContain("at lifecycle.repository (stage fetch): This machine's Git is older than 2.25");
    expect(why[0]).toContain("(code fetch_git_too_old)");
    expect(whyLines("tsk_1", { ...line, stage: "fetch\u001b[2J" }, "/f")[0]).not.toContain("stage");
  });
});
