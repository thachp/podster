// The run-time parts that M6's two release runs on staging share: m6-release-staging.mjs (static sites) and
// m6-code-app-staging.mjs (apps with code). Moved here from m6-release-staging.mjs on 2026-11-25, unchanged in what they
// do, so the two runs sign up, push, merge, release and clean up the same way.
//
// `releaseRun` holds one run's state: its requests, the credentials scrubbed from its output, its test sessions, the
// agents it linked, the grants it gave and its scratch folder for git. Everything it sends goes to staging, to GitHub
// with the coding agent's short-lived token, or to an app's host on the content domain. The one child process is git,
// with gitEnv's environment, a home of its own and the token under one name in its environment, never on a command
// line or in a file.
//
// Output carries IDs, statuses and reason codes only. Every credential it handles is scrubbed from it, and an ID given
// to `mask` is printed as its label instead. Request lines name an app's host as `[app host]`.
//
// It imports lib.mjs's packages, so a script imports it only once it is past its dry run.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq, key, McpAgent, ok, Person, sleep, Target } from "./lib.mjs";
import { ASKPASS_SCRIPT, gitEnv } from "./m5-staging-lib.mjs";
import { contentNotFoundProblem, DEPLOY_GRANT, maskedPath, markerWaitState, MARKER_PATH, requestLine, scrub, SETTLED, STAGING, STAGING_ORG, statusProblems } from "./m6-release-staging-lib.mjs";

export const POLL_MS = 3000;

/** The run was told to stop. */
export class Halt extends Error {}
/** Release isn't on with a provider: the run ends with exit 3. */
export class NotOn extends Error {}

export const cause = (error) => {
  const parts = [];
  for (let at = error, depth = 0; at && depth < 4; at = at.cause, depth++) {
    const said = [at.code, at.message].filter(Boolean).join(" ");
    if (said && !parts.includes(said)) parts.push(said);
  }
  return parts.join(": ") || String(error);
};

/** A person's refusal: exactly this status and this code. */
export const refusedAs = (result, status, code, label) => eq([result.status, result.code ?? null], [status, code], label);
/** An agent's refusal over MCP, which carries a code and no status. */
export const refusedCode = (result, code, label) => eq([result.ok, result.code ?? null], [false, code], label);

/**
 * One run's state and the steps both runs take. `options` holds the waits, in seconds: setupWait, mergeWait,
 * releaseWait and takedownWait. `runName` begins every title the run gives. `workPrefix` names its scratch folder.
 */
export function releaseRun({ signupSecret, options, runName, workPrefix }) {
  const requests = [];
  const secrets = [signupSecret];
  /** IDs printed as a label instead, in the order given. */
  const masks = [];
  const out = (line) => {
    let text = scrub(line, secrets);
    for (const [id, label] of masks) text = text.split(id).join(label);
    return text;
  };
  /** Keeps a credential out of the run's output. Answers it. */
  const secret = (value) => {
    if (typeof value === "string" && value.length >= 8 && !secrets.includes(value)) secrets.push(value);
    return value;
  };
  /** Prints an ID as `label` from here on. Answers the ID. */
  const mask = (id, label) => {
    if (typeof id === "string" && id.length >= 6 && !masks.some(([held]) => held === id)) masks.push([id, label]);
    return id;
  };
  const say = (line = "") => console.log(out(line));
  /** Every request the run sends, each logged as it ends: start, method, path (an app's host masked), status, ms. Never a body, header or query. */
  function logRequest({ url, quiet, ...request }) {
    const entry = { ...request, path: maskedPath(url) };
    requests.push(entry);
    if (!quiet) console.log(out(requestLine(entry)));
  }
  const target = new Target(STAGING, { pollMs: POLL_MS, onRequest: logRequest });

  const state = { stopping: false };
  process.on("SIGINT", () => {
    if (state.stopping) process.exit(130);
    state.stopping = true;
    console.log("\nStopping at the next request; clean-up follows. Press Ctrl-C again to quit at once, without it.");
  });
  const pause = async (ms) => {
    if (state.stopping) throw new Halt("stopped by a signal");
    await sleep(ms);
  };
  /** Polls `read` until `done` accepts its answer, for at most `seconds`. Answers the value and how long it took. */
  async function within(seconds, what, read, done, stepMs = POLL_MS) {
    const start = Date.now();
    for (;;) {
      const value = await read();
      if (done(value)) return { value, seconds: Math.round((Date.now() - start) / 100) / 10 };
      ok(Date.now() - start < seconds * 1000, `${what} didn't happen within ${seconds} s`);
      await pause(stepMs);
    }
  }

  // ---- people and agents ----

  const sessions = [];
  const leftBehind = [];
  const counts = { signUpsAsked: 0, signUpUnknown: false };
  /** One take of the test sign-up, never sent twice: an answer lost in transport may have been taken. */
  async function signUpCookie(label, body) {
    ok(!counts.signUpUnknown, `the test sign-up for ${label} wasn't asked for: an earlier sign-up's outcome is unknown`);
    if (state.stopping) throw new Halt("stopped by a signal");
    counts.signUpsAsked++;
    let res;
    try {
      res = await target.http("/api/auth/sign-up/e2e", { method: "POST", headers: { authorization: `Bearer ${signupSecret}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, retry: false });
    } catch (error) {
      counts.signUpUnknown = true;
      throw new Error(`the test sign-up for ${label} failed in transport (${cause(error)}). Whether staging took it is unknown, so it wasn't asked again`);
    }
    ok(res.status === 200, `the test sign-up for ${label} answered ${res.status}. A 404 means it's off on staging, or PODSTER_E2E_SIGNUP_SECRET is wrong.`);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    for (const value of [cookie, ...cookie.split("; ").map((part) => part.slice(part.indexOf("=") + 1)).filter((value) => value.length >= 16)]) secret(value);
    sessions.push(cookie);
    return cookie;
  }
  async function person(label) {
    const made = await Person.fromCookie(target, label, await signUpCookie(label));
    leftBehind.push(`${label} ${made.id}`);
    return made;
  }
  const agents = [];
  async function agentOf(linker, label) {
    const agent = await McpAgent.connect(target, linker, `${runName} ${label}`);
    agents.push({ agent, linker });
    const keep = (held) => {
      secret(held?.access_token);
      secret(held?.refresh_token);
    };
    keep(agent.provider?.tokens?.());
    const save = agent.provider?.saveTokens;
    if (typeof save === "function") {
      agent.provider.saveTokens = (held) => {
        keep(held);
        return save(held);
      };
    }
    return agent;
  }

  // ---- GitHub and git ----

  async function github(path, { token, method = "GET", body } = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      redirect: "manual",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "e2e-check", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: only the status is used.
    }
    return { status: res.status, body: json };
  }
  const work = mkdtempSync(join(tmpdir(), workPrefix));
  const askpass = join(work, "askpass.sh");
  writeFileSync(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
  chmodSync(askpass, 0o700);
  function git(args, { cwd = work, credential } = {}) {
    return new Promise((resolve) => {
      const child = spawn("git", ["-c", "credential.helper=", "-c", "http.followRedirects=false", ...args], { cwd, env: gitEnv({ home: work, askpass, credential }), stdio: ["ignore", "pipe", "pipe"] });
      const got = { stdout: "", stderr: "" };
      child.stdout.on("data", (chunk) => (got.stdout += chunk));
      child.stderr.on("data", (chunk) => (got.stderr += chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout: "", stderr: error.code ?? "spawn_failed" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout: scrub(got.stdout, secrets), stderr: scrub(got.stderr, secrets) });
      });
    });
  }
  async function mustGit(args, opts, label) {
    const done = await git(args, opts);
    ok(done.code === 0, `${label}: git exited ${done.code}: ${done.stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? ""}`);
    return done;
  }
  const removeWork = () => rmSync(work, { recursive: true, force: true });

  // ---- an app's host, asked directly ----

  /**
   * One request to a host on the content domain, logged with the host masked (`quiet` records it without printing the
   * line). `body`, a string, is sent as it is. Answers status, headers, the cookies set and the body text.
   */
  async function hostAsk(url, { method = "GET", headers = {}, body, quiet = false } = {}) {
    const at = new Date().toISOString();
    const begun = performance.now();
    try {
      const res = await fetch(url, { method, redirect: "manual", headers: { "cache-control": "no-cache", ...headers }, body, signal: AbortSignal.timeout(30_000) });
      const text = method === "HEAD" ? "" : await res.text();
      logRequest({ url, method, at, ms: Math.round(performance.now() - begun), status: res.status, quiet });
      return { status: res.status, headers: [...res.headers], setCookies: res.headers.getSetCookie(), body: text, ms: Math.round(performance.now() - begun) };
    } catch (error) {
      logRequest({ url, method, at, ms: Math.round(performance.now() - begun), error: error?.name ?? "Error" });
      throw new Error(`a request to the app's host failed in transport (${error?.name ?? "Error"})`);
    }
  }
  const marker = (at) => hostAsk(`https://${at}${MARKER_PATH}`);

  // ---- a room's repository, tasks, grants and releases ----

  const statusOf = async (owner, task) => owner.must("GET", `/v1/workspaces/${task.room}/tasks/${task.id}/release-status`);
  const taskRead = async (owner, task) => owner.must("GET", `/v1/workspaces/${task.room}/tasks/${task.id}`);
  /** Grants the run gave, by ID, with the room each is in and the person who gave it, that clean-up takes back unless seen ended. */
  const grants = new Map();
  /** Each room's repository, by room. */
  const repos = new Map();

  /** A grant `owner` gives in room `at`, noted for clean-up before anything is asserted about it. */
  async function give(owner, principal, action, at) {
    const answer = await owner.dash("POST", `/v1/workspaces/${at}/repository/grants`, { policy_version: await owner.policyVersion(at), principal_id: principal.id, action });
    if (answer.body?.id) grants.set(answer.body.id, { what: `${action} grant to ${principal.id}`, room: at, owner });
    if (action === DEPLOY_GRANT.action && answer.status === 400 && answer.code === "invalid_argument") throw new NotOn("staging's grant route refuses the action deploy: no route gives a deploy grant there, so nothing can be released");
    ok(answer.ok, `giving a ${action} grant to ${principal.id}: HTTP ${answer.status} ${answer.code ?? ""}`);
    eq([answer.body.principal_id, answer.body.action, answer.body.state], [principal.id, action, "live"], `the ${action} grant`);
    return answer.body;
  }
  async function takeBack(id) {
    const { room: at, owner } = grants.get(id);
    const back = await owner.dash("DELETE", `/v1/workspaces/${at}/repository/grants/${id}`, { policy_version: await owner.policyVersion(at) });
    if ((back.ok && back.body?.revoked_at) || (back.status === 404 && back.code === "grant_not_found")) grants.delete(id);
    return back;
  }

  /** Adds a person of organization `org` to room `at`, in `role`. */
  async function addPerson(owner, org, who, role, at) {
    await owner.must("POST", `/v1/workspaces/${at}/members`, { principal_id: who.id, kind: "person", org_id: org, role, policy_version: await owner.policyVersion(at) });
  }

  /** Asks Podster for room `at`'s public repository in podsterdev, and waits for it. Answers it, noted by room. */
  async function setUpRepository(owner, at, tag) {
    const name = `e2e-m6-${tag}-${new Date().toISOString().slice(0, 16).replace(/\D/g, "")}-${randomBytes(2).toString("hex")}`;
    const asked = await owner.dash("POST", `/v1/workspaces/${at}/repository`, { name, visibility: "public" });
    leftBehind.push(`possibly the repository ${STAGING_ORG}/${name} on GitHub`);
    // Noted before it is ready, so clean-up names it even if its setup fails.
    repos.set(at, { full: `${STAGING_ORG}/${name}` });
    ok(asked.ok && asked.body?.request?.state === "pending", `asking for the repository: HTTP ${asked.status} ${asked.code ?? ""}`);
    const { value: read, seconds } = await within(options.setupWait, "the repository's setup", () => owner.must("GET", `/v1/workspaces/${at}/repository`), (r) => r.request?.state !== "pending");
    eq([read.request.state, read.repository?.status, read.repository?.full_name], ["ready", "ready", `${STAGING_ORG}/${name}`], "the room's repository");
    const repo = { id: read.repository.provider_repo_id, full: read.repository.full_name, defaultBranch: read.repository.default_branch, cloneUrl: `https://github.com/${read.repository.full_name}.git` };
    repos.set(at, repo);
    say(`     repository ${repo.id}, ${repo.full}, ready after ${seconds} s`);
    return repo;
  }

  /** A task for `coder` in room `at`, accepted, reviewed by `reviewer`. Its name is its branch's, so unique in the run. */
  async function newTask({ owner, coder, reviewer }, name, at) {
    const made = await owner.must("POST", `/v1/workspaces/${at}/tasks`, { title: `${runName} ${name}`, instructions: "Change the site.", acceptance_criteria: "A pull request.", assignee: coder.id, reviewer: reviewer.id }, { idempotencyKey: key() });
    const ids = { workspace_id: at, task_id: made.id };
    const accepted = await coder.must("accept_task", { ...ids, version: made.version });
    leftBehind.push(`task ${made.id}`);
    say(`     task ${name}: ${made.id}`);
    return { id: made.id, room: at, at: ids, version: accepted.version, name, title: made.title ?? `${runName} ${name}` };
  }
  /**
   * The coder's change for a task: its token, a branch off the default branch with one commit of `files`, pushed, and a
   * pull request; submitted; approved by `merger`; merged by `merger`, a person with a merge grant who doesn't control
   * the coder. Answers the task with its head and its merge commit.
   */
  async function changeAndMerge({ owner, coder, merger }, task, files) {
    const access = await coder.must("get_repo_access", task.at, false);
    ok(typeof access?.token === "string" && access.token.length >= 20, "the coder was given no token");
    const token = secret(access.token);
    const repo = repos.get(task.room);
    const dir = join(work, task.name);
    const branch = `e2e/${task.name}`;
    await mustGit(["clone", "-q", repo.cloneUrl, dir], {}, "git clone");
    await mustGit(["checkout", "-q", "-b", branch], { cwd: dir }, "git checkout");
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    await mustGit(["add", "--", ...Object.keys(files)], { cwd: dir }, "git add");
    await mustGit(["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", `e2e: ${task.name}`], { cwd: dir }, "git commit");
    const head = (await mustGit(["rev-parse", "HEAD"], { cwd: dir }, "git rev-parse")).stdout.trim();
    await mustGit(["push", "-q", "origin", branch], { cwd: dir, credential: token }, "pushing the task's branch");
    const opened = await github(`/repos/${repo.full}/pulls`, { token, method: "POST", body: { title: `e2e: ${task.name}`, head: branch, base: repo.defaultBranch } });
    eq([opened.status, opened.body?.head?.sha], [201, head], "opening the pull request");
    await coder.must("submit_task", { ...task.at, version: task.version, note: "Ready for review.", commit_sha: head, pr_number: opened.body.number });
    await merger.must("POST", `/v1/workspaces/${task.room}/tasks/${task.id}/verify`, { submission_no: 1, commit_sha: head });
    const asked = await merger.must("POST", `/v1/workspaces/${task.room}/tasks/${task.id}/merge`, { submission_no: 1, commit_sha: head });
    eq(asked.merge_state, "requested", "the merge as asked for");
    const { value: change, seconds } = await within(options.mergeWait, "the merge", async () => (await taskRead(owner, task)).change, (c) => ["succeeded", "failed", "outcome_unknown"].includes(c?.merge_state));
    eq([change.merge_state, change.merge_reason ?? null], ["succeeded", null], "the merge");
    ok(/^[0-9a-f]{40}$/.test(change.merge_sha ?? ""), "the merge recorded no commit");
    Object.assign(task, { head, pr: opened.body.number, mergeSha: change.merge_sha });
    say(`     ${task.name}: pull request ${task.pr}, head ${head}, merged as ${task.mergeSha} after ${seconds} s`);
    return task;
  }

  /** Waits for the latest release of `task` to be `releaseId` and settled. Answers the release part of its status. */
  async function settled(owner, task, releaseId) {
    const { value, seconds } = await within(options.releaseWait, `release ${releaseId} settling`, () => statusOf(owner, task), (s) => s.release?.release_id === releaseId && SETTLED.includes(s.release?.state));
    return { status: value, seconds };
  }
  /** Approves a release as `approver`, and waits for it to be served. Answers the status and the seconds it took. */
  async function approveAndServe({ owner, approver }, task, releaseId, hint = "") {
    const approved = await approver.must("POST", `/v1/workspaces/${task.room}/releases/${releaseId}/approve`, {});
    eq([approved.id, approved.approved_by], [releaseId, approver.id], "the approval");
    ok(approved.state !== "failed", `the approval ended the release failed, ${approved.failure_code}`);
    let outcome;
    try {
      outcome = await settled(owner, task, releaseId);
    } catch (error) {
      const last = (await statusOf(owner, task).catch(() => null))?.release;
      const stuck = ["queued", "uploading", "uncertain", "awaiting_confirmation"].includes(last?.state);
      throw new Error(`${cause(error)}; it was last ${last?.state ?? "unread"}${stuck ? ". A release stays queued or uploading when no content provider is configured, or when its room has spent its 2 uploads in the hour" : ""}`);
    }
    const problems = statusProblems(outcome.status, { taskId: task.id, mergeSha: task.mergeSha, release: { id: releaseId, state: "served", served: true } });
    ok(problems.length === 0, `${problems.join("; ")}${hint && outcome.status.release?.failure_code ? hint(outcome.status.release.failure_code) : ""}`);
    return outcome;
  }
  /** `host`'s not found, within the takedown wait. Answers how long it took. */
  async function hostDown(host, what) {
    const { seconds } = await within(options.takedownWait, what, () => hostAsk(`https://${host}/`), (answer) => contentNotFoundProblem(answer) === null);
    return seconds;
  }
  /**
   * `host`'s marker naming `releaseId` and `commit`, within the takedown wait: a host that answered not found can go on
   * answering it after a new release is served, for the content Worker's edge cache of the serve entry and KV's
   * propagation (HOST_CHANGE_SECONDS, which the default wait outlasts). Any answer but 200 is waited out; a 200 naming
   * another release or commit fails at once. Answers how long it took.
   */
  async function markerNamed(host, releaseId, commit, what) {
    let last;
    try {
      const { seconds } = await within(options.takedownWait, what, () => marker(host), (answer) => {
        last = answer;
        const named = markerWaitState(answer, releaseId, commit);
        ok(named !== "another", `${what}: the marker names another release or commit`);
        return named === "named";
      });
      return seconds;
    } catch (error) {
      if (error instanceof Halt || last?.status === 200) throw error;
      throw new Error(`${cause(error)}; the marker last answered ${last?.status ?? "nothing"}`);
    }
  }

  // ---- preflight, signed out ----

  async function preflight() {
    const card = await target.http("/.well-known/agent-configuration", { headers: { accept: "application/json" } });
    ok(card.status === 200 && /json/.test(card.headers.get("content-type") ?? ""), `staging's agent configuration answered ${card.status}, not 200 with JSON`);
    const signedOut = await target.http("/api/v1/workspaces", { headers: { origin: target.base } });
    const body = await signedOut.json().catch(() => null);
    ok(signedOut.status === 401 && body?.error?.code === "sign_in_required", `a signed-out request answered ${signedOut.status} ${body?.error?.code ?? ""}, not 401 sign_in_required`);
  }
  /** Whether staging lists deploy_release, signed out: every page of capabilities discovery, bounded at 20. */
  async function deployReleaseListed() {
    let cursor = 0;
    for (let pages = 0; pages < 20; pages++) {
      const res = await target.http(`/api/auth/capability/list?limit=100&cursor=${cursor}`, { headers: { accept: "application/json" } });
      ok(res.status === 200, `capabilities discovery answered ${res.status}`);
      const page = JSON.parse(await res.text());
      ok(Array.isArray(page?.capabilities), "capabilities discovery answered without a list");
      if (page.capabilities.some((c) => c?.name === "deploy_release")) return true;
      if (!page.has_more || page.capabilities.length === 0) return false;
      cursor += page.capabilities.length;
    }
    throw new Error("capabilities discovery ran past 20 pages");
  }

  // ---- clean-up ----

  /**
   * The clean-up both runs end with, after their own: every grant taken back, every agent disconnected, every session
   * signed out, and the scratch folder removed. Answers what it says, each line about something that could NOT be done
   * or about an agent.
   */
  async function cleanUpShared() {
    const said = [];
    for (const [id, { what }] of [...grants]) {
      const back = await takeBack(id).catch(() => null);
      if (grants.has(id)) said.push(`the ${what} (${id}) could NOT be taken back (${back ? `HTTP ${back.status} ${back.code ?? ""}` : "no answer"})`);
    }
    for (const { agent, linker } of agents) {
      await agent.close().catch(() => null);
      const gone = await linker.dash("POST", `/agents/${agent.id}/disconnect`, {}).catch(() => null);
      said.push(`agent ${agent.id} ${gone?.status === 200 ? "disconnected" : "could NOT be disconnected: its credential stays valid until it expires"}`);
    }
    for (const cookie of sessions.splice(0)) await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
    removeWork();
    return said;
  }

  return {
    target, requests, out, say, secret, mask, logRequest, pause, within,
    get stopping() {
      return state.stopping;
    },
    sessions, leftBehind,
    get signUpsAsked() {
      return counts.signUpsAsked;
    },
    get signUpUnknown() {
      return counts.signUpUnknown;
    },
    signUpCookie, person, agents, agentOf,
    github, git, mustGit, work, removeWork,
    hostAsk, marker,
    grants, repos, statusOf, taskRead, give, takeBack, addPerson, setUpRepository, newTask, changeAndMerge, settled, approveAndServe, hostDown, markerNamed,
    preflight, deployReleaseListed,
    cleanUpShared,
  };
}
