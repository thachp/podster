// M7 step 10, the repository path: the owner's scope in the run policy and the decision bound to the repository and a
// pinned base (L4 on #455), decision 230's own rules for `get_repo_access`, the broker holding the token on the host,
// and host Git that reads nothing from the task's folder (L2/L3 on #459; #461's finding). Git runs for real here only on
// this machine's folders: the fetch and push are pointed at a local bare repository, and GitHub's API is a fake.
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath as realpathOf, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayError } from "../src/core/errors.js";
import { consumeRunDecision, evaluate, issueRunDecision, parsePolicyConfig, pinRunBase, repositoryOf, type Decision, type RunBinding } from "../src/core/policy.js";
import {
  checkProtected,
  cloneUrl,
  fetchArgs,
  GITHUB,
  hardening,
  isAccessToken,
  locate,
  MAX_ACCESS_TOKEN,
  pushArgs,
  readAccess,
  readPullRequest,
  readRepository,
  renewDue,
  RENEW_BEFORE_MS,
  RepoPathError,
  type GitHubRequest,
} from "../src/core/repository.js";
import { lineLogger } from "../src/core/runtime.js";
import { checkedHelper, findGit, gitCli, gitEnv, HELPER_PATH, PACKAGE_ROOT, type GitExec } from "../src/node/git.js";
import { githubApi, type GitHubCall } from "../src/node/github-api.js";
import { checkWorkTree, GitRepositoryPath, RepoBroker } from "../src/node/repo-path.js";

const OWNER = "org_owner";
const ROOM = "room_1";
const TASK = "task_1";
const NOW = 1_800_000_000_000;
const SCOPE = { full_name: "podsterdev/todo-app", provider_repo_id: 9001 };
const TOKEN = "ghs_TestToken0123456789abcdefABCDEF";
/**
 * A made-up token in GitHub's current installation-token shape, `ghs_APPID_JWT`: base64url segments joined by dots, with
 * `-` and `_` in them. 390 characters by default, as a real one on staging was (0.0.1-test.4 refused it).
 */
function longToken(length = 390): string {
  const head = "ghs_1234567_eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.";
  const tail = ".Zq9-Xk3_Lm7Vb2Nc8Wd4Ts6Yh-0_aB";
  const body = "eyJpc3MiOiJnaXRodWIiLCJzdWIiOiJ4In0-_abcXYZ019".repeat(Math.ceil(length / 40));
  return head + body.slice(0, length - head.length - tail.length) + tail;
}
const LONG = longToken();
const CAPS = { spend_micro_usd: 2_000_000, run_time_ms: 30 * 60_000, turns: 40, output_tokens: 50_000, max_tokens: 4_096 };

const temps: string[] = [];
async function temp(prefix = "runner-repo-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

function config(repository: unknown = SCOPE, extra: Record<string, unknown> = {}) {
  // "omit": no repository key at all.
  return {
    version: 1,
    revision: 3,
    owner_org: OWNER,
    adapter: "claude_agent_sdk",
    workspace_root: "/Users/owner/podster-runner/work",
    caps: { ...CAPS },
    day_caps: { spend_micro_usd: 10_000_000 },
    rooms: [{ room_id: ROOM, mode: "unattended", allowed_orgs: [], acknowledged: { trust_statement: true, public_room_warning: false }, ...(repository === "omit" ? {} : { repository }) }],
    ...extra,
  };
}
const internal = { id: "per_In", org: OWNER, external: false, active: true, written_at: 1 };
const PROVENANCE = { room_visibility: "private", requester: { id: "per_In", org: OWNER, external: false, active: true }, inputs: [{ input: "title", external: false, authors: [internal] }, { input: "instructions", external: false, authors: [internal] }] };
function decide(cfg: unknown = config()): Decision {
  return evaluate({ config: cfg, provenance: PROVENANCE, prompt: { inputs: ["title", "instructions"], change_request_event_id: null }, task: { id: TASK, workspace_id: ROOM }, authority_fresh: true, budget: { spent_today_micro_usd: 0, reserved_micro_usd: 0 }, now: NOW });
}
const BINDING: RunBinding = { task_id: TASK, workspace_id: ROOM, task_version: 2, input_hash: "a".repeat(64), repository_id: "9001", base_commit: null };
const BASE = "b".repeat(40);

describe("the owner's repository scope in the run policy (L4 on #455)", () => {
  it("is a room's own setting, by full name and GitHub's ID, and a run fact with the task's one branch", () => {
    const d = decide();
    expect(d.outcome).toBe("run");
    expect(d.facts?.repository).toEqual({ ...SCOPE, branch: `podster/${TASK}` });
    expect(decide(config("omit")).facts?.repository).toBeNull();
    expect(decide(config(null)).facts?.repository).toBeNull();
  });

  it("refuses the whole configuration for a repository setting that is anything but exactly that", () => {
    for (const bad of [
      { full_name: "podsterdev/todo-app" },
      { ...SCOPE, extra: 1 },
      { ...SCOPE, provider_repo_id: 0 },
      { ...SCOPE, provider_repo_id: "9001" },
      { ...SCOPE, full_name: "podsterdev/../x" },
      { ...SCOPE, full_name: "podsterdev/todo.git" },
      { ...SCOPE, full_name: "https://github.com/podsterdev/todo" },
      { ...SCOPE, full_name: "podsterdev/-option" },
      { ...SCOPE, full_name: "-x/todo" },
      { ...SCOPE, full_name: "podster dev/todo" },
      "podsterdev/todo-app",
    ]) {
      expect([bad, parsePolicyConfig(config(bad)).ok]).toEqual([bad, false]);
      expect(decide(config(bad))).toMatchObject({ outcome: "refuse", reason: "config_invalid" });
    }
  });
});

describe("Runner's home and the workspace root never overlap (ruling 4 on #462)", () => {
  const HOME = "/Users/owner/.podster-runner";
  it("refuses the whole configuration when either holds the other, checked both ways", () => {
    for (const root of [`${HOME}/git`, HOME, `${HOME}/work`, "/Users/owner", "/Users"]) {
      expect([root, parsePolicyConfig(config(SCOPE, { workspace_root: root }), { runner_home: HOME }).ok]).toEqual([root, false]);
      expect(evaluate({ config: config(SCOPE, { workspace_root: root }), runner_home: HOME, provenance: PROVENANCE, prompt: { inputs: ["title", "instructions"], change_request_event_id: null }, task: { id: TASK, workspace_id: ROOM }, authority_fresh: true, budget: { spent_today_micro_usd: 0, reserved_micro_usd: 0 }, now: NOW })).toMatchObject({ outcome: "refuse", reason: "config_invalid" });
    }
    for (const root of ["/Users/owner/podster-runner/work", `${HOME}-work`, "/Users/owner/.podster"]) expect([root, parsePolicyConfig(config(SCOPE, { workspace_root: root }), { runner_home: HOME }).ok]).toEqual([root, true]);
    expect(parsePolicyConfig(config(SCOPE, { workspace_root: `${HOME}/git` }), { runner_home: "relative/home" }).ok).toBe(false);
  });
});

describe("a decision bound to the repository and a pinned base", () => {
  it("is issued naming the scoped repository and no base, and nothing else", () => {
    expect(issueRunDecision(decide(), BINDING, NOW)).toMatchObject({ ok: true, record: { repository_id: "9001", base_commit: null } });
    for (const binding of [{ ...BINDING, repository_id: "9002" }, { ...BINDING, repository_id: null }, { ...BINDING, base_commit: BASE }, { ...BINDING, repository_id: "repo_1" }]) {
      expect(issueRunDecision(decide(), binding, NOW)).toEqual({ ok: false, reason: "binding_invalid" });
    }
    // A room with no repository binds none.
    expect(issueRunDecision(decide(config(null)), BINDING, NOW)).toEqual({ ok: false, reason: "binding_invalid" });
  });

  it("can't be consumed before its base is pinned, is pinned once, and is then spent only against that base", () => {
    const issued = issueRunDecision(decide(), BINDING, NOW);
    if (!issued.ok) throw new Error("not issued");
    expect(consumeRunDecision(issued.record, decide(), { ...BINDING, base_commit: BASE }, NOW + 1)).toEqual({ ok: false, reason: "base_unpinned" });
    const pinned = pinRunBase(issued.record, BASE, NOW + 1);
    if (!pinned.ok) throw new Error("not pinned");
    expect(pinned.record.base_commit).toBe(BASE);
    expect(pinRunBase(pinned.record, "c".repeat(40), NOW + 2)).toEqual({ ok: false, reason: "already_pinned" });
    // A restart between the pin and the consume checks out the same commit again: accepted as already pinned (ruling 6).
    expect(pinRunBase(pinned.record, BASE, NOW + 2)).toEqual({ ok: true, record: pinned.record });
    expect(consumeRunDecision(pinned.record, decide(), { ...BINDING, base_commit: "c".repeat(40) }, NOW + 2)).toEqual({ ok: false, reason: "binding_changed" });
    expect(consumeRunDecision(pinned.record, decide(), { ...BINDING, repository_id: "9002", base_commit: BASE }, NOW + 2)).toEqual({ ok: false, reason: "binding_changed" });
    // The owner rescoped the room after the decision: its facts changed.
    expect(consumeRunDecision(pinned.record, decide(config({ ...SCOPE, full_name: "podsterdev/other" })), { ...BINDING, base_commit: BASE }, NOW + 2)).toEqual({ ok: false, reason: "facts_changed" });
    const consumed = consumeRunDecision(pinned.record, decide(), { ...BINDING, base_commit: BASE }, NOW + 2);
    expect(consumed).toMatchObject({ ok: true, record: { consumed: true, base_commit: BASE } });
    if (!consumed.ok) throw new Error("not consumed");
    expect(pinRunBase(consumed.record, BASE, NOW + 3)).toEqual({ ok: false, reason: "consumed" });
    expect(repositoryOf(consumed.record)).toEqual({ repository: { ...SCOPE, branch: `podster/${TASK}` }, task_folder: `/Users/owner/podster-runner/work/${ROOM}/${TASK}` });
  });

  it("refuses a pin with no repository, a base that isn't a commit, or after expiry", () => {
    const plain = issueRunDecision(decide(config(null)), { ...BINDING, repository_id: null }, NOW);
    if (!plain.ok) throw new Error("not issued");
    expect(pinRunBase(plain.record, BASE, NOW)).toEqual({ ok: false, reason: "no_repository" });
    expect(repositoryOf(plain.record)).toBeNull();
    const issued = issueRunDecision(decide(), BINDING, NOW);
    if (!issued.ok) throw new Error("not issued");
    for (const bad of ["HEAD", "b".repeat(39), "B".repeat(40), "--upload-pack=x"]) expect(pinRunBase(issued.record, bad, NOW)).toEqual({ ok: false, reason: "base_invalid" });
    expect(pinRunBase(issued.record, BASE, NOW + 10 * 60 * 1000 + 1)).toEqual({ ok: false, reason: "expired" });
  });
});

const ACCESS = { token: TOKEN, expires_at: NOW + 60 * 60 * 1000, repository: SCOPE.full_name, clone_url: cloneUrl(SCOPE.full_name), permissions: { contents: "write", metadata: "read", pull_requests: "write" }, authority_ends_at: null };

describe("decision 230's own rules", () => {
  it("takes `get_repo_access`'s answer only for the owner's repository, its canonical URL and the contract's three permissions", () => {
    expect(readAccess(ACCESS, SCOPE, NOW).token).toBe(TOKEN);
    const refused: [string, unknown, string][] = [
      ["another repository", { ...ACCESS, repository: "podsterdev/other" }, "repository_out_of_scope"],
      ["a clone URL elsewhere", { ...ACCESS, clone_url: "https://evil.example/podsterdev/todo-app.git" }, "clone_url_unexpected"],
      ["a clone URL with credentials", { ...ACCESS, clone_url: `https://x:${TOKEN}@github.com/podsterdev/todo-app.git` }, "clone_url_unexpected"],
      ["administration", { ...ACCESS, permissions: { ...ACCESS.permissions, administration: "write" } }, "access_permissions"],
      ["workflows", { ...ACCESS, permissions: { contents: "write", metadata: "read", workflows: "write" } }, "access_permissions"],
      ["an extra field", { ...ACCESS, merge_url: "x" }, "access_fields"],
      ["a token with a newline", { ...ACCESS, token: `${TOKEN}\nprotocol=https` }, "access_token_format"],
      ["an expired token", { ...ACCESS, expires_at: NOW }, "access_expired"],
    ];
    for (const [what, answer, code] of refused) expect([what, (() => { try { readAccess(answer, SCOPE, NOW); return "taken"; } catch (e) { return (e as RepoPathError).code; } })()]).toEqual([what, code]);
  });

  it("names why it refused an answer: not an object, the fields, the token's format, the authority", () => {
    const code = (v: unknown) => { try { readAccess(v, SCOPE, NOW); return "taken"; } catch (e) { return (e as RepoPathError).code; } };
    expect(code("text")).toBe("access_not_object");
    expect(code(null)).toBe("access_not_object");
    expect(code([ACCESS])).toBe("access_not_object");
    expect(code({ ...ACCESS, merge_url: "x" })).toBe("access_fields");
    const { token: _t, ...without } = ACCESS;
    expect(code(without)).toBe("access_fields");
    expect(code({ ...ACCESS, token: "short" })).toBe("access_token_format");
    expect(code({ ...ACCESS, token: 7 })).toBe("access_token_format");
    expect(code({ ...ACCESS, token: `${TOKEN}:x` })).toBe("access_token_format");
    expect(code({ ...ACCESS, authority_ends_at: "soon" })).toBe("access_authority_invalid");
    expect(code({ ...ACCESS, authority_ends_at: undefined })).toBe("access_authority_invalid");
  });

  it("takes GitHub's current installation tokens, `ghs_APPID_JWT` and hundreds of characters long, up to 4096", () => {
    expect(LONG.length).toBe(390);
    expect(LONG).toMatch(/^ghs_[0-9]+_eyJ[^.]+\.[^.]+\.[^.]+$/);
    for (const token of [TOKEN, LONG, longToken(520), longToken(MAX_ACCESS_TOKEN)]) expect([token.length, readAccess({ ...ACCESS, token }, SCOPE, NOW).token === token]).toEqual([token.length, true]);
    expect(MAX_ACCESS_TOKEN).toBe(4096);
  });

  it("refuses a token with anything that could break a header, a URL or a Git credential line, or one over 4096", () => {
    const code = (token: string) => { try { readAccess({ ...ACCESS, token }, SCOPE, NOW); return "taken"; } catch (e) { return (e as RepoPathError).code; } };
    const bad: [string, string][] = [
      ["too long", longToken(MAX_ACCESS_TOKEN + 1)],
      ["too short", "ghs_1234567_eyJ.a.b"],
      ["a space", `${LONG.slice(0, 200)} ${LONG.slice(201)}`],
      ["a tab", `${LONG}\t`],
      ["a newline", `${LONG}\nhost=evil.example`],
      ["a carriage return", `${LONG}\r\nx-evil: 1`],
      ["a colon", `${LONG.slice(0, 100)}:${LONG.slice(101)}`],
      ["an at sign", `${LONG.slice(0, 100)}@${LONG.slice(101)}`],
      ["a slash", `${LONG.slice(0, 100)}/${LONG.slice(101)}`],
      ["an equals sign", `${LONG}=`],
      ["a NUL", `${LONG.slice(0, 100)}\u0000${LONG.slice(101)}`],
      ["a DEL", `${LONG}\u007f`],
      ["a non-ASCII letter", `${LONG.slice(0, 100)}é${LONG.slice(101)}`],
    ];
    for (const [what, token] of bad) {
      expect([what, isAccessToken(token), code(token)]).toEqual([what, false, "access_token_format"]);
    }
  });

  it("logs one fixed-shape line for each refusal, with key names, a token's length and shape, or a type, and no token character", async () => {
    const secret = "ghs_Zq9Xk3Lm7Vb2Nc8Wd4Ts-6Yh!"; // not a valid token: it has a "!"
    const run = async (answer: unknown) => {
      const logged: string[] = [];
      const broker = new RepoBroker(async () => answer, { now: () => NOW, idle: async () => undefined }, lineLogger((l) => logged.push(l)));
      const error = await broker.access(ROOM, TASK, SCOPE).catch((e: RepoPathError) => e);
      return { error: error as RepoPathError, lines: logged.map((l) => JSON.parse(l) as Record<string, unknown>), text: logged.join("\n") };
    };
    const odd = "Bad Key!";
    const fields = await run({ ...ACCESS, [odd]: secret, zeta: 1, alpha: 2 });
    expect(fields.error.code).toBe("access_fields");
    expect(fields.lines).toEqual([{ at: "repo.access", outcome: "refused", workspace: ROOM, task: TASK, code: "access_fields", count: 9, names: "?,alpha,authority_ends_at,clone_url,expires_at,permissions,repository,token,zeta" }]);
    expect(fields.text).not.toContain(secret);
    expect(fields.text).not.toContain("Bad");
    const many = await run(Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`k${String.fromCharCode(97 + i)}`, secret])));
    expect(many.lines[0].count).toBe(14);
    expect(String(many.lines[0].names).split(",").length).toBe(10);
    expect(many.text).not.toContain(secret);
    const token = await run({ ...ACCESS, token: secret });
    expect(token.error.code).toBe("access_token_format");
    expect(token.lines).toEqual([{ at: "repo.access", outcome: "refused", workspace: ROOM, task: TASK, code: "access_token_format", length: secret.length, prefix: "yes" }]);
    for (const piece of ["ghs", "Zq9", "Xk3", secret.slice(0, 6), secret.slice(-6)]) expect(token.text).not.toContain(piece);
    const bare = await run({ ...ACCESS, token: "NoPrefixHere!123456789012" });
    expect(bare.lines[0]).toMatchObject({ code: "access_token_format", length: 25, prefix: "no" });
    expect(bare.text).not.toContain("NoPrefix");
    const notObject = await run(secret);
    expect(notObject.error.code).toBe("access_not_object");
    expect(notObject.lines).toEqual([{ at: "repo.access", outcome: "refused", workspace: ROOM, task: TASK, code: "access_not_object", type: "string" }]);
    expect(notObject.text).not.toContain(secret);
    expect((await run(null)).lines[0]).toMatchObject({ type: "null" });
    expect((await run([secret])).lines[0]).toMatchObject({ type: "array" });
    const authority = await run({ ...ACCESS, authority_ends_at: secret });
    expect(authority.lines).toEqual([{ at: "repo.access", outcome: "refused", workspace: ROOM, task: TASK, code: "access_authority_invalid" }]);
    expect(authority.text).not.toContain(secret);
  });

  it("renews a token only near its expiry or past the task's authority", () => {
    const access = readAccess(ACCESS, SCOPE, NOW);
    expect(renewDue(access, NOW)).toBe(false);
    expect(renewDue(access, ACCESS.expires_at - RENEW_BEFORE_MS)).toBe(true);
    expect(renewDue({ ...access, authority_ends_at: NOW + 5 }, NOW + 5)).toBe(true);
  });

  it("holds GitHub's repository to the scope's numeric ID, and never takes a default branch under Runner's prefix", () => {
    const repo = { id: 9001, full_name: "PodsterDev/Todo-App", archived: false, default_branch: "main" };
    expect(readRepository(repo, SCOPE, TASK)).toEqual({ default_branch: "main" });
    const code = (v: unknown) => { try { readRepository(v, SCOPE, TASK); return "taken"; } catch (e) { return (e as RepoPathError).code; } };
    expect(code({ ...repo, id: 9002 })).toBe("repository_id_mismatch");
    expect(code({ ...repo, full_name: "podsterdev/renamed" })).toBe("repository_renamed");
    expect(code({ ...repo, archived: true })).toBe("repository_archived");
    for (const branch of ["podster/task_1", "podster", "podster/x", "-main", "main..x", "a@{1}"]) expect([branch, code({ ...repo, default_branch: branch })]).toEqual([branch, "default_branch_invalid"]);
  });

  it("refuses a repository whose default branch lacks any of ADR 0009's three rules, as on a private repository on the Free plan", () => {
    expect(() => checkProtected([{ type: "pull_request" }, { type: "required_status_checks" }, { type: "update" }, { type: "deletion" }])).not.toThrow();
    for (const rules of [[], [{ type: "pull_request" }, { type: "required_status_checks" }], [{ type: "update" }], null, { message: "Upgrade to GitHub Pro" }]) {
      expect(() => checkProtected(rules)).toThrow(/repository_unprotected/);
    }
  });

  it("pushes exactly the task branch to itself, with no `+` and no tag, and fetches one branch with no tags", () => {
    const push = pushArgs(SCOPE.full_name, "podster/task_1", "main");
    expect(push.at(-1)).toBe("refs/heads/podster/task_1:refs/heads/podster/task_1");
    expect(push).toContain("--no-verify");
    expect(push.join(" ")).not.toMatch(/\+refs|--force|--tags|--mirror|--all|--delete/);
    expect(() => pushArgs(SCOPE.full_name, "main", "main")).toThrow(/push_invalid/);
    expect(() => pushArgs(SCOPE.full_name, "podster/x", "podster/x")).toThrow(/push_invalid/);
    const fetch = fetchArgs(SCOPE.full_name, "main", "refs/runner/start");
    expect(fetch).toEqual(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "https://github.com/podsterdev/todo-app.git", "refs/heads/main:refs/runner/start"]);
  });

  it("makes only the fixed GitHub calls, none of which can merge, move a ref or administer", () => {
    const requests: GitHubRequest[] = [GITHUB.repository(SCOPE.full_name), GITHUB.rules(SCOPE.full_name, "main"), GITHUB.ref(SCOPE.full_name, "main"), GITHUB.openPull(SCOPE.full_name, TASK, "podster/task_1", "main"), GITHUB.findPull(SCOPE.full_name, "podster/task_1", "main")];
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /repos/podsterdev/todo-app",
      "GET /repos/podsterdev/todo-app/rules/branches/main",
      "GET /repos/podsterdev/todo-app/git/ref/heads/main",
      "POST /repos/podsterdev/todo-app/pulls",
      "GET /repos/podsterdev/todo-app/pulls?state=open&head=podsterdev%3Apodster%2Ftask_1&base=main&per_page=2",
    ]);
    for (const r of requests) expect(r.path).not.toMatch(/merge|dispatch|hooks|rulesets|collaborators|statuses|reviews|actions/);
    // The pull request carries fixed words and the task's ID, never task text.
    expect(requests[3].body).toEqual({ title: "Podster task task_1", head: "podster/task_1", base: "main", body: "Opened by Podster Runner for task task_1. Review it in Podster; Runner never merges.", draft: false, maintainer_can_modify: false });
  });

  it("holds a pull request to the repository, never a fork, the default branch and the pushed commit", () => {
    const want = { scope: SCOPE, branch: "podster/task_1", default_branch: "main", commit: BASE };
    const pr = { number: 7, state: "open", draft: false, head: { ref: "podster/task_1", sha: BASE, repo: { id: 9001 } }, base: { ref: "main", repo: { id: 9001 } } };
    expect(readPullRequest(pr, want)).toBe(7);
    expect(() => readPullRequest({ ...pr, head: { ...pr.head, repo: { id: 1 } } }, want)).toThrow(/wrong_repository/);
    expect(() => readPullRequest({ ...pr, base: { ...pr.base, ref: "dev" } }, want)).toThrow(/wrong_base/);
    expect(() => readPullRequest({ ...pr, head: { ...pr.head, sha: "c".repeat(40) } }, want)).toThrow(/commit_changed/);
    expect(() => readPullRequest({ ...pr, draft: true }, want)).toThrow(/not_open/);
  });

  it("starts every Git command with hooks and fsmonitor off, no helper but Runner's, and the Git folder named", () => {
    const args = [...hardening("/opt/runner/git/credential-helper"), ...locate("/home/o/.runner/git/r/t", "/work/r/t")];
    const settings = args.filter((_, i) => args[i - 1] === "-c");
    for (const s of ["core.hooksPath=/dev/null", "core.fsmonitor=false", "protocol.allow=never", "protocol.https.allow=always", "http.followRedirects=false", "submodule.recurse=false", "safe.directory=/work/r/t"]) expect(settings).toContain(s);
    // The empty helper clears any named before it, so Runner's own is the only one.
    // Run through /bin/sh by its path (the ruling on #470), so the helper needs no execute bit.
    expect(settings.indexOf("credential.helper=")).toBeLessThan(settings.indexOf("credential.helper=!/bin/sh /opt/runner/git/credential-helper"));
    expect(settings.filter((s) => s.startsWith("credential.helper="))).toEqual(["credential.helper=", "credential.helper=!/bin/sh /opt/runner/git/credential-helper"]);
    expect(hardening(null).filter((a) => a.startsWith("credential.helper="))).toEqual(["credential.helper="]);
    expect(args.slice(-2)).toEqual(["--git-dir=/home/o/.runner/git/r/t", "--work-tree=/work/r/t"]);
    expect(() => locate("/home/o dir/git", "/work")).toThrow(/path_unsafe/);
    expect(() => locate("/home/o/git", "/work/$(x)")).toThrow(/path_unsafe/);
  });
});

describe("the credential helper", () => {
  const runHelper = (input: string, fd3: string | null, action = "get") => {
    const result = spawnSync(HELPER_PATH, [action], { input, stdio: ["pipe", "pipe", "pipe", fd3 === null ? "ignore" : "pipe"], env: { PATH: "/usr/bin:/bin", PODSTER_TOKEN: "ghs_FromTheEnvironment0000000000" }, ...(fd3 === null ? {} : {}) });
    return result;
  };
  async function viaFd3(input: string, token: string, action = "get") {
    const { spawn } = await import("node:child_process");
    return new Promise<string>((resolve) => {
      const child = spawn(HELPER_PATH, [action], { stdio: ["pipe", "pipe", "ignore", "pipe"], env: { PATH: "/usr/bin:/bin" } });
      let out = "";
      child.stdout?.on("data", (c) => (out += c));
      // The helper may exit without reading either, as it should for anything but GitHub: a write it never reads is
      // reset, as in `git.ts`, and that is no failure here.
      const fd3 = child.stdio[3] as NodeJS.WritableStream & { on(event: "error", fn: () => void): void };
      fd3.on("error", () => undefined);
      child.stdin?.on("error", () => undefined);
      fd3.end(`${token}\n`);
      child.stdin?.end(input);
      child.on("close", () => resolve(out));
    });
  }

  it("is a plain path to a file only its owner can change", async () => {
    expect(await checkedHelper()).toBe(HELPER_PATH);
  });

  it("needs no execute bit: mode 0644 inside the package's folder is enough, and any write by others, a link or a path outside is refused", async () => {
    const root = await temp();
    await mkdir(join(root, "git"));
    const helper = join(root, "git", "credential-helper");
    await writeFile(helper, await readFile(HELPER_PATH, "utf8"), { mode: 0o644 });
    await chmod(helper, 0o644);
    expect(await checkedHelper(helper, root)).toBe(helper);
    for (const mode of [0o664, 0o646, 0o666]) {
      await chmod(helper, mode);
      await expect(checkedHelper(helper, root)).rejects.toThrow(/helper_unavailable/);
    }
    await chmod(helper, 0o644);
    // Outside the package's own folder.
    const elsewhere = await temp();
    expect(await checkedHelper(helper, root)).toBe(helper);
    await expect(checkedHelper(helper, elsewhere)).rejects.toThrow(/helper_unavailable/);
    await expect(checkedHelper(helper, `${root}-other`)).rejects.toThrow(/helper_unavailable/);
    // A link, even inside the folder.
    await symlink(helper, join(root, "git", "link"));
    await expect(checkedHelper(join(root, "git", "link"), root)).rejects.toThrow(/helper_unavailable/);
    // The packaged helper is checked against the package's own folder.
    expect(HELPER_PATH.startsWith(`${PACKAGE_ROOT}/`)).toBe(true);
  });

  it.skipIf(findGit() === null)("is run by real Git through /bin/sh at mode 0644, answering with the token from descriptor 3", async () => {
    const root = await temp();
    const helper = join(root, "credential-helper");
    await writeFile(helper, await readFile(HELPER_PATH, "utf8"), { mode: 0o644 });
    await chmod(helper, 0o644);
    const { spawn } = await import("node:child_process");
    const out = await new Promise<string>((resolve) => {
      const child = spawn(findGit() as string, [...hardening(helper), "credential", "fill"], { stdio: ["pipe", "pipe", "ignore", "pipe"], env: gitEnv(join(root, "git-home"), { PATH: "/usr/bin:/bin" }) });
      let text = "";
      child.stdout?.on("data", (c) => (text += c));
      const fd3 = child.stdio[3] as NodeJS.WritableStream & { on(event: "error", fn: () => void): void };
      fd3.on("error", () => undefined);
      fd3.end(`${TOKEN}\n`);
      child.stdin?.end("protocol=https\nhost=github.com\n\n");
      child.on("close", () => resolve(text));
    });
    expect(out).toContain(`password=${TOKEN}`);
  });

  it("answers `get` for https://github.com only, with the token from descriptor 3 and nothing else", async () => {
    expect(await viaFd3("protocol=https\nhost=github.com\n\n", TOKEN)).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    for (const input of ["protocol=https\nhost=evil.example\n\n", "protocol=http\nhost=github.com\n\n", "protocol=https\nhost=github.com.evil.example\n\n"]) expect([input, await viaFd3(input, TOKEN)]).toEqual([input, ""]);
    expect(await viaFd3("protocol=https\nhost=github.com\n\n", TOKEN, "store")).toBe("");
    // A token that isn't plain can't add lines or fields to Git's credential protocol: only one plain line is ever read.
    expect(await viaFd3("protocol=https\nhost=github.com\n\n", "ghs_x host=evil")).toBe("");
    expect(await viaFd3("protocol=https\nhost=github.com\n\n", "ghs_x\nhost=evil")).toBe("username=x-access-token\npassword=ghs_x\n");
  });

  it("answers GitHub's current 390-character `ghs_APPID_JWT` tokens and ones up to 4096, and nothing for one with `:`, `@`, `/` or longer", async () => {
    const get = "protocol=https\nhost=github.com\n\n";
    for (const token of [LONG, longToken(MAX_ACCESS_TOKEN)]) expect(await viaFd3(get, token)).toBe(`username=x-access-token\npassword=${token}\n`);
    for (const token of [`${LONG}:x`, `x@${LONG}`, `${LONG}/x`, `${LONG}=`, `${LONG}\tx`, longToken(MAX_ACCESS_TOKEN + 1)]) expect([token.length, await viaFd3(get, token)]).toEqual([token.length, ""]);
  });

  it("answers nothing with no descriptor 3, and never reads the environment", () => {
    const result = runHelper("protocol=https\nhost=github.com\n\n", null);
    expect(result.stdout.toString()).toBe("");
  });
});

describe("Git as Runner runs it", () => {
  it("never inherits Git's or a secret's variables, and reads no system or global configuration", () => {
    const env = gitEnv("/h/git-home", { PATH: "/usr/bin", HOME: "/Users/owner", GIT_DIR: "/evil", GIT_CONFIG_PARAMETERS: "'core.fsmonitor=x'", GH_TOKEN: TOKEN, GIT_SSL_NO_VERIFY: "1", HTTPS_PROXY: "http://proxy" });
    expect(env).toMatchObject({ HOME: "/h/git-home", PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
    for (const name of ["GIT_DIR", "GIT_CONFIG_PARAMETERS", "GH_TOKEN", "GIT_SSL_NO_VERIFY", "HTTPS_PROXY"]) expect(env).not.toHaveProperty(name);
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  });

  it("runs Git with its own empty home as the working folder, never the task's folder", async () => {
    const dir = await temp();
    const fake = join(dir, "git");
    await writeFile(fake, `#!/bin/sh\npwd\n`);
    await chmod(fake, 0o700);
    const home = join(dir, "git-home");
    await mkdir(home);
    const answer = await gitCli(fake, home, { PATH: "/opt/evil/bin:/usr/bin" })([], {});
    expect(await realpathOf(answer.stdout.trim())).toBe(await realpathOf(home));
  });

  it("hands the token to the child's descriptor 3 only: never an argument or the environment", async () => {
    const dir = await temp();
    const fake = join(dir, "git");
    // A stand-in for Git that reports what it got: its arguments, its environment, and what descriptor 3 holds.
    await writeFile(fake, `#!/bin/sh\nprintf 'args=%s\\n' "$*"\nenv | sed 's/^/env=/'\nIFS= read -r t <&3 && printf 'fd3=%s\\n' "$t"\nexit 0\n`);
    await chmod(fake, 0o700);
    const git = gitCli(fake, dir, { PATH: "/usr/bin:/bin" });
    const withSecret = await git(["fetch", "https://github.com/podsterdev/todo-app.git"], { secret: TOKEN });
    expect(withSecret.stdout).toContain(`fd3=${TOKEN}`);
    expect(withSecret.stdout.split("\n").filter((l) => !l.startsWith("fd3=")).join("\n")).not.toContain(TOKEN);
    const without = await git(["status"], {});
    expect(without.stdout).not.toContain("fd3=");
  });
});

// ---- The repository path, end to end on real Git against a local bare repository, with a fake GitHub API ----

const realGit = findGit();
const sh = (cwd: string, ...args: string[]) => execFileSync(realGit as string, args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();

/** A "GitHub": a local bare repository with `main`, and an API answering for it. */
async function world() {
  const root = await temp();
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  await mkdir(seed);
  sh(seed, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(seed, "README.md"), "hello\n");
  sh(seed, "add", "README.md");
  sh(seed, "commit", "--quiet", "-m", "first");
  sh(root, "clone", "--quiet", "--bare", seed, remote);
  const workRoot = join(root, "work");
  const taskFolder = join(workRoot, ROOM, TASK);
  const calls: { method: string; path: string }[] = [];
  const api = { rules: [{ type: "pull_request" }, { type: "required_status_checks" }, { type: "update" }] as unknown, repoId: 9001, pullStatus: 201, revoked: false, lag: 0 };
  const github: GitHubCall = async (request, token) => {
    calls.push({ method: request.method, path: request.path });
    expect(token).toBe(TOKEN);
    if (api.revoked) throw new RepoPathError("token_revoked");
    const p = request.path;
    const head = (b: string) => { try { return sh(remote, "rev-parse", `refs/heads/${b}`); } catch { return null; } };
    if (p === "/repos/podsterdev/todo-app") return { status: 200, body: { id: api.repoId, full_name: "podsterdev/todo-app", archived: false, default_branch: "main" } };
    if (p === "/repos/podsterdev/todo-app/rules/branches/main") return { status: 200, body: api.rules };
    const ref = /^\/repos\/podsterdev\/todo-app\/git\/ref\/heads\/(.+)$/.exec(p);
    if (ref) {
      const sha = head(ref[1]);
      return sha ? { status: 200, body: { ref: `refs/heads/${ref[1]}`, object: { type: "commit", sha } } } : { status: 404, body: null };
    }
    // GitHub's pull request can show the head it had before the push for a moment: `lag` reads answer the old one.
    const lagging = api.lag > 0;
    if (lagging && (p.includes("/pulls"))) api.lag--;
    const pr = { number: 12, state: "open", draft: false, head: { ref: "podster/task_1", sha: lagging ? "0".repeat(40) : head("podster/task_1"), repo: { id: 9001 } }, base: { ref: "main", repo: { id: 9001 } } };
    if (p === "/repos/podsterdev/todo-app/pulls" && request.method === "POST") return { status: api.pullStatus, body: api.pullStatus === 201 ? pr : { message: "exists" } };
    if (p.startsWith("/repos/podsterdev/todo-app/pulls?")) return { status: 200, body: [pr] };
    return { status: 404, body: null };
  };
  // Real Git, with the network pointed at the local bare repository: the URL swapped, and file transport allowed for it.
  const gitHome = join(root, "git-home");
  await mkdir(gitHome, { mode: 0o700 });
  const real = gitCli(realGit as string, gitHome, { PATH: "/usr/bin:/bin" });
  const gitCalls: { args: string[]; secret: boolean }[] = [];
  /** What the next push answers instead of pushing, as Git prints a refused credential. */
  const fakes: { push: { code: number; stdout: string; stderr: string } | null; extraCommit: boolean } = { push: null, extraCommit: false };
  const git: GitExec = async (args, opts) => {
    gitCalls.push({ args, secret: opts.secret !== undefined });
    expect(args.join(" ")).not.toContain(TOKEN);
    if (args.includes("push") && fakes.push) return fakes.push;
    if (args.includes("commit") && fakes.extraCommit) {
      // Something other than Runner's one commit lands first: what the `HEAD^` check is there for.
      fakes.extraCommit = false;
      await real([...args.slice(0, args.indexOf("commit")), "commit", "--quiet", "--allow-empty", "--only", "-m", "extra"], opts);
    }
    const swapped = args.map((a) => (a === cloneUrl(SCOPE.full_name) ? remote : a));
    const network = swapped.includes(remote);
    return real(network ? ["-c", "protocol.file.allow=always", ...swapped] : swapped, opts);
  };
  const tokens: string[] = [];
  const request = async (capability: string, args: Record<string, unknown>) => {
    tokens.push(capability);
    expect(args).toEqual({ workspace_id: ROOM, task_id: TASK });
    return { ...ACCESS };
  };
  const logged: string[] = [];
  const clock = { now: () => NOW, idle: async () => undefined };
  const broker = new RepoBroker(request, clock, lineLogger((l) => logged.push(l)));
  const path = new GitRepositoryPath({ home, broker, git, github, helper: HELPER_PATH, log: lineLogger((l) => logged.push(l)), wait: async () => undefined });
  const task = { workspace_id: ROOM, task_id: TASK, task_folder: taskFolder, repository: { ...SCOPE, branch: "podster/task_1" } };
  return { root, home, remote, seed, taskFolder, calls, api, gitCalls, fakes, tokens, logged, broker, path, task, signal: new AbortController().signal, head: (b: string) => sh(remote, "rev-parse", `refs/heads/${b}`) };
}

describe.skipIf(realGit === null)("the repository path on real Git (no network)", () => {
  it("checks out the default branch's head, verified, with its Git folder in Runner's home and none in the task folder", async () => {
    const w = await world();
    const main = w.head("main");
    expect(await w.path.prepare({ ...w.task, continue_from: null }, w.signal)).toEqual({ repository_id: "9001", base_commit: main });
    expect(await readFile(join(w.taskFolder, "README.md"), "utf8")).toBe("hello\n");
    expect(await readdir(w.taskFolder)).toEqual(["README.md"]);
    expect((await lstat(join(w.home, "git", ROOM, TASK, "HEAD"))).isFile()).toBe(true);
    expect(((await lstat(w.taskFolder)).mode & 0o777).toString(8)).toBe("700");
    // The token went to Git only for the fetch, through descriptor 3; every other command had none.
    expect(w.gitCalls.filter((c) => c.secret).map((c) => c.args[c.args.indexOf(`--work-tree=${w.taskFolder}`) + 1])).toEqual(["fetch"]);
    expect(w.tokens).toEqual(["get_repo_access"]);
    expect(w.logged.join("\n")).not.toContain(TOKEN);
  });

  it("refuses an unprotected repository or one GitHub names by another ID before any Git command runs", async () => {
    const w = await world();
    w.api.rules = [];
    await expect(w.path.prepare({ ...w.task, continue_from: null }, w.signal)).rejects.toMatchObject({ code: "repository_unprotected" });
    w.api.rules = [{ type: "pull_request" }, { type: "required_status_checks" }, { type: "update" }];
    w.api.repoId = 1;
    await expect(w.path.prepare({ ...w.task, continue_from: null }, w.signal)).rejects.toMatchObject({ code: "repository_id_mismatch" });
    expect(w.gitCalls).toEqual([]);
  });

  it("#461: a task's own `.git/hooks/post-checkout` and `.git/config` with `core.fsmonitor` are never run or read by Runner's Git", async () => {
    const w = await world();
    const base = (await w.path.prepare({ ...w.task, continue_from: null }, w.signal)).base_commit;
    const marker = join(w.root, "ran");
    const planted = join(w.taskFolder, ".git");
    // What a task's shell can write in its folder: a hook and a configuration that would each run a command.
    // A whole repository, as `git init` in the task's shell would make one, so plain Git would take it as the folder's own.
    sh(w.taskFolder, "init", "--quiet");
    await mkdir(join(planted, "hooks"), { recursive: true });
    const script = `#!/bin/sh\necho ran >> ${marker}\n`;
    for (const hook of ["post-checkout", "pre-commit", "post-commit", "pre-push", "reference-transaction"]) {
      await writeFile(join(planted, "hooks", hook), script);
      await chmod(join(planted, "hooks", hook), 0o755);
    }
    await writeFile(join(planted, "fsmonitor"), script);
    await chmod(join(planted, "fsmonitor"), 0o755);
    await writeFile(join(planted, "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = ${join(planted, "fsmonitor")}\n\thooksPath = ${join(planted, "hooks")}\n[credential]\n\thelper = !${join(planted, "fsmonitor")}\n`);
    // Runner's Git, as it runs it, over the planted folder: status, add, checkout and commit.
    const git = (args: string[]) => (w.path as unknown as { git: (t: unknown, a: string[], o: unknown) => Promise<{ code: number }> }).git(w.task, args, { signal: w.signal });
    expect((await git(["status", "--porcelain"])).code).toBe(0);
    expect((await git(["checkout", "--quiet", "-B", "podster/task_1", base])).code).toBe(0);
    await writeFile(join(w.taskFolder, "a.txt"), "work\n");
    expect((await git(["add", "a.txt"])).code).toBe(0);
    expect((await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "x"])).code).toBe(0);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    // Runner's real Git folder is untouched by the plant, and the publication refuses a work tree holding one.
    expect(sh(w.root, `--git-dir=${join(w.home, "git", ROOM, TASK)}`, "rev-parse", "--is-bare-repository")).toBe("false");
    await expect(w.path.publish({ ...w.task, base_commit: base }, w.signal)).rejects.toMatchObject({ code: "work_tree_git" });
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    // The control: plain Git, run in the task folder the way a careless host tool would, does run the plant.
    try {
      sh(w.taskFolder, "status");
    } catch {
      // Its outcome doesn't matter, only whether the plant ran.
    }
    expect(await readFile(marker, "utf8")).toContain("ran");
  });

  it("ignores hooks and fsmonitor even in Runner's own Git folder's configuration: none is trusted", async () => {
    const w = await world();
    const base = (await w.path.prepare({ ...w.task, continue_from: null }, w.signal)).base_commit;
    const gitDir = join(w.home, "git", ROOM, TASK);
    const marker = join(w.root, "ran");
    const script = join(w.root, "script");
    await writeFile(script, `#!/bin/sh\necho ran >> ${marker}\n`);
    await chmod(script, 0o755);
    await mkdir(join(gitDir, "hooks"), { recursive: true });
    for (const hook of ["pre-commit", "post-commit", "pre-push", "post-checkout"]) {
      await writeFile(join(gitDir, "hooks", hook), `#!/bin/sh\necho ran >> ${marker}\n`);
      await chmod(join(gitDir, "hooks", hook), 0o755);
    }
    sh(w.root, `--git-dir=${gitDir}`, "config", "core.fsmonitor", script);
    await writeFile(join(w.taskFolder, "a.txt"), "work\n");
    const published = await w.path.publish({ ...w.task, base_commit: base }, w.signal);
    expect(published).toMatchObject({ kind: "published", branch: "podster/task_1", pr_number: 12 });
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes one commit on the pinned base to the task branch, opens its pull request, and continues from it on a rerun", async () => {
    const w = await world();
    const base = (await w.path.prepare({ ...w.task, continue_from: null }, w.signal)).base_commit;
    await writeFile(join(w.taskFolder, "feature.txt"), "done\n");
    const first = await w.path.publish({ ...w.task, base_commit: base }, w.signal);
    if (first.kind !== "published") throw new Error("not published");
    expect(first.commit).toBe(w.head("podster/task_1"));
    expect(sh(w.remote, "rev-parse", `${first.commit}^`)).toBe(base);
    // Runner's fixed identity and words, never the task's.
    expect(sh(w.remote, "log", "-1", "--format=%an <%ae>|%s", first.commit)).toBe("Podster Runner <runner@podster.invalid>|Podster task task_1");
    // The default branch never moved.
    expect(w.head("main")).toBe(base);
    expect(w.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/repos/podsterdev/todo-app/pulls"]);
    // Only the task branch was pushed, and the token went to Git only for the fetch and the push.
    expect(w.gitCalls.filter((c) => c.secret).map((c) => c.args.find((a) => a === "fetch" || a === "push"))).toEqual(["fetch", "push"]);

    // A rerun: a fresh checkout from what Runner pushed, while the task branch still points at it.
    w.api.pullStatus = 422;
    expect(await w.path.prepare({ ...w.task, continue_from: first.commit }, w.signal)).toEqual({ repository_id: "9001", base_commit: first.commit });
    expect(await readFile(join(w.taskFolder, "feature.txt"), "utf8")).toBe("done\n");
    await writeFile(join(w.taskFolder, "feature.txt"), "done again\n");
    const second = await w.path.publish({ ...w.task, base_commit: first.commit }, w.signal);
    expect(second).toMatchObject({ kind: "published", pr_number: 12 });
    if (second.kind === "published") expect(sh(w.remote, "rev-parse", `${second.commit}^`)).toBe(first.commit);
  });

  it("never builds on a task branch someone else moved, and publishes nothing for a run that changed nothing", async () => {
    const w = await world();
    const base = (await w.path.prepare({ ...w.task, continue_from: null }, w.signal)).base_commit;
    expect(await w.path.publish({ ...w.task, base_commit: base }, w.signal)).toEqual({ kind: "no_changes" });
    await expect(w.path.prepare({ ...w.task, continue_from: "c".repeat(40) }, w.signal)).rejects.toMatchObject({ code: "task_branch_gone" });
    await writeFile(join(w.taskFolder, "x.txt"), "x\n");
    const first = await w.path.publish({ ...w.task, base_commit: base }, w.signal);
    if (first.kind !== "published") throw new Error("not published");
    // Another agent's token can write any branch but the default one (ADR 0009): Runner refuses to continue from it.
    sh(w.seed, "fetch", "--quiet", w.remote, "podster/task_1:other");
    sh(w.seed, "checkout", "--quiet", "other");
    await writeFile(join(w.seed, "evil.txt"), "x\n");
    sh(w.seed, "add", "evil.txt");
    sh(w.seed, "commit", "--quiet", "-m", "moved");
    sh(w.seed, "push", "--quiet", w.remote, "other:podster/task_1");
    await expect(w.path.prepare({ ...w.task, continue_from: first.commit }, w.signal)).rejects.toMatchObject({ code: "task_branch_moved" });
  });

  it("refuses a work tree with a link, before Git adds anything", async () => {
    const w = await world();
    const base = (await w.path.prepare({ ...w.task, continue_from: null }, w.signal)).base_commit;
    await symlink("/etc/passwd", join(w.taskFolder, "passwd"));
    await expect(w.path.publish({ ...w.task, base_commit: base }, w.signal)).rejects.toMatchObject({ code: "work_tree_link" });
    expect(w.gitCalls.some((c) => c.args.includes("add"))).toBe(false);
  });

  it("reports a revoked token: GitHub's 401 drops it, and the next use asks Podster again", async () => {
    const w = await world();
    const base = (await w.path.prepare({ ...w.task, continue_from: null }, w.signal)).base_commit;
    w.api.revoked = true;
    await expect(w.path.publish({ ...w.task, base_commit: base }, w.signal)).rejects.toMatchObject({ code: "token_revoked" });
    expect(w.broker.size).toBe(0);
    expect(w.logged.some((l) => l.includes('"outcome":"revoked"'))).toBe(true);
    w.api.revoked = false;
    await writeFile(join(w.taskFolder, "y.txt"), "y\n");
    expect(await w.path.publish({ ...w.task, base_commit: base }, w.signal)).toMatchObject({ kind: "published" });
    expect(w.tokens).toEqual(["get_repo_access", "get_repo_access"]);
  });
});

describe.skipIf(realGit === null)("the review of #462: Git's own refusals and Runner's one commit", () => {
  it("reads Git's refused credential on push as a revoked token, and drops it from the broker", async () => {
    const w = await world();
    const base = (await w.path.prepare({ ...w.task, continue_from: null }, w.signal)).base_commit;
    await writeFile(join(w.taskFolder, "a.txt"), "a\n");
    w.fakes.push = { code: 128, stdout: "", stderr: "fatal: Authentication failed for 'https://github.com/podsterdev/todo-app.git/'\n" };
    await expect(w.path.publish({ ...w.task, base_commit: base }, w.signal)).rejects.toMatchObject({ code: "token_revoked" });
    expect(w.broker.size).toBe(0);
    expect(w.logged.some((l) => l.includes('"outcome":"revoked"'))).toBe(true);
    w.fakes.push = { code: 128, stdout: "", stderr: "remote: Permission to podsterdev/todo-app.git denied.\nfatal: unable to access 'https://github.com/podsterdev/todo-app.git/': The requested URL returned error: 403\n" };
    await expect(w.path.publish({ ...w.task, base_commit: base }, w.signal)).rejects.toMatchObject({ code: "token_revoked" });
    expect(w.broker.size).toBe(0);
  });

  it("refuses to push anything but one commit of its own on the pinned base", async () => {
    const w = await world();
    const base = (await w.path.prepare({ ...w.task, continue_from: null }, w.signal)).base_commit;
    await writeFile(join(w.taskFolder, "a.txt"), "a\n");
    w.fakes.extraCommit = true;
    await expect(w.path.publish({ ...w.task, base_commit: base }, w.signal)).rejects.toMatchObject({ code: "commit_unexpected" });
    expect(w.gitCalls.some((c) => c.args.includes("push"))).toBe(false);
  });

  it("refuses a task folder inside Runner's home, or its home inside the workspace root (ruling 4)", async () => {
    const w = await world();
    const inside = { ...w.task, task_folder: join(w.home, "git", ROOM, TASK) };
    await expect(w.path.prepare({ ...inside, continue_from: null }, w.signal)).rejects.toMatchObject({ code: "path_unsafe" });
    // A workspace root that holds Runner's home: the home sits inside the root.
    const holding = { ...w.task, task_folder: join(w.root, ROOM, TASK) };
    await expect(w.path.prepare({ ...holding, continue_from: null }, w.signal)).rejects.toMatchObject({ code: "path_unsafe" });
    expect(w.gitCalls).toEqual([]);
  });

  it("retries the pull request read a few times while GitHub's head lags the push (ruling 5)", async () => {
    const w = await world();
    const base = (await w.path.prepare({ ...w.task, continue_from: null }, w.signal)).base_commit;
    await writeFile(join(w.taskFolder, "a.txt"), "a\n");
    w.api.lag = 2;
    expect(await w.path.publish({ ...w.task, base_commit: base }, w.signal)).toMatchObject({ kind: "published", pr_number: 12 });
    w.api.lag = 100;
    await writeFile(join(w.taskFolder, "b.txt"), "b\n");
    const second = await w.path.prepare({ ...w.task, continue_from: w.head("podster/task_1") }, w.signal);
    await writeFile(join(w.taskFolder, "b.txt"), "b\n");
    await expect(w.path.publish({ ...w.task, base_commit: second.base_commit }, w.signal)).rejects.toMatchObject({ code: "pull_request_commit_changed", transient: true });
  });

  it("publishes again after a passing failure without making a second commit", async () => {
    const w = await world();
    const base = (await w.path.prepare({ ...w.task, continue_from: null }, w.signal)).base_commit;
    await writeFile(join(w.taskFolder, "a.txt"), "a\n");
    w.fakes.push = { code: 128, stdout: "", stderr: "fatal: unable to access 'https://github.com/podsterdev/todo-app.git/': Could not resolve host: github.com\n" };
    await expect(w.path.publish({ ...w.task, base_commit: base }, w.signal)).rejects.toMatchObject({ code: "github_unreachable", transient: true });
    w.fakes.push = null;
    const again = await w.path.publish({ ...w.task, base_commit: base }, w.signal);
    if (again.kind !== "published") throw new Error("not published");
    expect(sh(w.remote, "rev-parse", `${again.commit}^`)).toBe(base);
  });
});

describe("the broker", () => {
  it("holds a 390-character `ghs_APPID_JWT` token from `get_repo_access` and gives it back whole, with none of it in a log", async () => {
    const logged: string[] = [];
    const broker = new RepoBroker(async () => ({ ...ACCESS, token: LONG }), { now: () => NOW, idle: async () => undefined }, lineLogger((l) => logged.push(l)));
    const access = await broker.access(ROOM, TASK, SCOPE);
    expect(access.token).toBe(LONG);
    expect(logged.map((l) => JSON.parse(l).outcome)).toEqual(["issued"]);
    for (const piece of [LONG, LONG.slice(0, 20), LONG.slice(-20), LONG.slice(150, 190)]) expect(logged.join("\n")).not.toContain(piece);
  });

  it("holds the token, asks again only when it's due, and reports each refusal by its code with no token in a log", async () => {
    const logged: string[] = [];
    let now = NOW;
    let answer: unknown = { ...ACCESS };
    let calls = 0;
    const broker = new RepoBroker(async () => {
      calls++;
      if (answer instanceof Error) throw answer;
      return answer;
    }, { now: () => now, idle: async () => undefined }, lineLogger((l) => logged.push(l)));
    await broker.access(ROOM, TASK, SCOPE);
    await broker.access(ROOM, TASK, SCOPE);
    expect(calls).toBe(1);
    now = ACCESS.expires_at - RENEW_BEFORE_MS;
    answer = { ...ACCESS, expires_at: now + 60 * 60 * 1000 };
    await broker.access(ROOM, TASK, SCOPE);
    expect(calls).toBe(2);
    expect(logged.map((l) => JSON.parse(l).outcome)).toEqual(["issued", "renewed"]);
    broker.forget(ROOM, TASK);
    const cases: [GatewayError, string, boolean][] = [
      [new GatewayError(403, "grant_required"), "grant_required", false],
      [new GatewayError(409, "repo_not_ready"), "repo_not_ready", false],
      [new GatewayError(409, "task_not_active"), "task_not_active", false],
      [new GatewayError(409, "repo_access_busy"), "repo_access_busy", true],
      [new GatewayError(429, "rate_limited"), "rate_limited", true],
      [new GatewayError(503, "standing_unknown"), "standing_unknown", true],
    ];
    for (const [error, code, transient] of cases) {
      answer = error;
      await expect(broker.access(ROOM, TASK, SCOPE)).rejects.toMatchObject({ code, transient });
    }
    // An authority error is the lifecycle's to act on, as it is.
    answer = new GatewayError(403, "agent_revoked");
    await expect(broker.access(ROOM, TASK, SCOPE)).rejects.toBeInstanceOf(GatewayError);
    answer = { ...ACCESS, repository: "podsterdev/other" };
    await expect(broker.access(ROOM, TASK, SCOPE)).rejects.toMatchObject({ code: "repository_out_of_scope" });
    expect(broker.size).toBe(0);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });
});

describe("GitHub's API, as Runner reaches it", () => {
  it("reaches only api.github.com, never follows a redirect, sends the token only as a header, and reads a 401 as revoked", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const api = githubApi((async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status });
    }) as unknown as typeof fetch, {}, []);
    expect(await api(GITHUB.repository(SCOPE.full_name), TOKEN)).toEqual({ status: 200, body: { ok: true } });
    expect(seen[0].url).toBe("https://api.github.com/repos/podsterdev/todo-app");
    expect(seen[0].init.redirect).toBe("error");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    await expect(api({ method: "GET", path: "//evil.example/x" }, TOKEN)).rejects.toMatchObject({ code: "request_invalid" });
    await expect(api({ method: "GET", path: "/repos/../user" }, TOKEN)).rejects.toMatchObject({ code: "request_invalid" });
    status = 401;
    await expect(api(GITHUB.repository(SCOPE.full_name), TOKEN)).rejects.toMatchObject({ code: "token_revoked" });
    status = 200;
    expect(await api(GITHUB.repository(SCOPE.full_name), LONG)).toEqual({ status: 200, body: { ok: true } });
    expect((seen.at(-1)?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${LONG}`);
    const before = seen.length;
    for (const token of [`${LONG}\r\nx-evil: 1`, `${LONG} x`, longToken(MAX_ACCESS_TOKEN + 1)]) await expect(api(GITHUB.repository(SCOPE.full_name), token)).rejects.toMatchObject({ code: "access_invalid" });
    expect(seen.length).toBe(before);
    expect(() => githubApi(fetch, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, [])).toThrow();
    expect(() => githubApi(fetch, { NODE_USE_ENV_PROXY: "1" }, [])).toThrow();
  });
});

describe("the work tree check", () => {
  it("refuses `.git` and its look-alikes at any depth, links, and special files", async () => {
    const dir = await temp();
    await writeFile(join(dir, "ok.txt"), "x");
    await checkWorkTree(dir);
    for (const name of [".git", ".GIT", ".gi​t", "．git"]) {
      const d = await temp();
      await mkdir(join(d, "src", name), { recursive: true });
      await expect(checkWorkTree(d)).rejects.toMatchObject({ code: "work_tree_git" });
    }
    const big = await temp();
    for (let i = 0; i < 5; i++) await writeFile(join(big, `f${i}`), "x");
    await expect(checkWorkTree(big, 3)).rejects.toMatchObject({ code: "work_tree_too_large" });
  });
});
