// M6's staging acceptance run with release switched ON, for static sites (docs/m6-plan.md, "The gate" and "Acceptance
// tests"). m6-staging.mjs shows release switched off; this shows it on: a room's approved, merged commit releases its
// `site` directory to its default host on the content domain, and around that each part of the gate that a script can
// show from outside:
//
// - disabled deployment publishes nothing (M6-01, M6-23);
// - checks, merge and release are reported apart, failure included: "Merged · Deployment failed" (M6-07, M6-08, UI-02,
//   M6-25);
// - claiming a role grants no deploy right (expanded criterion 3);
// - the deployment access tests AC-05, AC-10, AC-11, AC-13, AC-16 and AC-17;
// - takedown by an operator, and unpublish (M6-16, M6-19, M6-27);
// - the content host can't read or set the application's cookies (M6-12).
//
// Custom domains (M6-14, M6-15, M6-26) and apps with code are out of scope for now: their checks are in the plan, always
// say SKIP, and are listed apart. They never stop exit 0.
//
//   node m6-release-staging.mjs --base-url https://gateway-staging.podster.dev [--dry-run]
//
// **Not yet run against staging,** because release isn't switched on there. It also can't run until a route gives a
// `deploy` grant: on 2026-11-23 none does (docs/m6-plan.md, "Owed to step 6"). The run assumes M5's grant route with
// the action `deploy` and refuses, offline and before anything is sent, while the contract doesn't list it.
//
// Before anything is sent it reads the contract. Before any sign-up, signed out: staging's agent configuration answers,
// a signed-out room list is 401, capabilities discovery lists `deploy_release` (the gateway lists it only while the API
// says RELEASES is exactly true), and an unknown app's host on podster.site gets the content Worker's own not found.
// After the owner's sign-up only: the room answers its release configuration, and a request isn't refused
// `release_not_available`, which staging answers while a provider is configured and the release path isn't complete.
// Whether a provider is configured can't be read from outside before that: a release that never leaves the queue fails
// M6-R06, saying so.
//
// People: 4 takes of staging's test sign-up, of its 6 a minute and 40 a day: the room's owner, its admin, a member who
// holds the deploy grant, and staging's fixed test operator, who must be in the API's OPERATORS (m4-staging.mjs
// --operator-id prints its ID). One agent, made under the owner, takes none. A sign-up is never sent twice.
//
// GitHub: one public repository in podsterdev, made by Podster for the room. The coding agent pushes with its
// short-lived token through `git`, a child process with child-env.mjs's environment, a home of its own and the token
// under one name in its environment, never on a command line or in a file; and opens each pull request with that token.
// The browser for M6-R09 and M6-R12 is Playwright's Chromium, launched with child-env.mjs's environment.
//
// Output carries IDs, statuses and reason codes only. Every credential it handles is scrubbed from it. Request lines
// name an app's host as `[app host]`.
//
// Exit codes: 0 only when every in-scope check passed and none said SKIP; 1 otherwise, naming what wasn't shown; 2 for
// a refused configuration or a failed preflight, with no sign-up taken; 3 when release isn't on with a provider, with at
// most the owner's sign-up taken.
//
// Clean-up, on every way out, Ctrl-C included: release switched off in the room (which unpublishes), a suspension the
// run left lifted, an organization's release given back, the room made private, every grant taken back, the agent
// disconnected, every session signed out. Left behind, as every staging run's are: the test people, the organization,
// the two rooms and their tasks, and the repository, which this script can't delete: it prints its name for the owner
// to archive or delete on GitHub.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./child-env.mjs";
import { ASKPASS_SCRIPT, gitEnv } from "./m5-staging-lib.mjs";
import {
  CONTENT_DOMAIN, contentNotFoundProblem, defaultHostProblem, DEPLOY_GRANT, deployGrantProblem, EXIT, fixedHeaderProblems, maskedPath, markerProblem, MARKER_PATH, outOfScopeReason, parseArgs, PLAN, REFUSED_SITE, requestLine, resultUrlProblem,
  runOutcome, scrub, secretProblem, SETTLED, SIGN_UPS, SITE, slowestLine, STAGING, STAGING_APP, STAGING_ORG, statusProblems, Tally, unknownLabel, USAGE,
} from "./m6-release-staging-lib.mjs";
import { RoomPublisher } from "./room-publisher.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const parsed = parseArgs(process.argv.slice(2), process.env);
if (parsed.error) {
  console.error(`${parsed.error}\n\n${USAGE}`);
  process.exit(EXIT.refused);
}
const options = parsed.options;
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;

// ---- the contract and the configuration, before anything is sent ----

const contractText = (() => {
  try {
    return readFileSync(options.contract ?? join(here, "../packages/contracts/openapi.yaml"), "utf8");
  } catch {
    return null;
  }
})();
const grantProblem = deployGrantProblem(contractText);
{
  console.log(`M6's staging run with release switched on, for static sites, against ${STAGING}${options.dryRun ? " (dry run: nothing is sent)" : ""}`);
  console.log(`\nSign-ups this run takes: ${SIGN_UPS.length}, of the test sign-up's 6 a minute and 40 a day.`);
  for (const { who, why } of SIGN_UPS) console.log(`  - ${who}: ${why}`);
  console.log(`\nContent domain: ${CONTENT_DOMAIN}. GitHub organization: ${STAGING_ORG}. The deploy grant: POST ${DEPLOY_GRANT.path} with the action "${DEPLOY_GRANT.action}" (an assumption: see the header).`);
  console.log(`Waits, in seconds: repository ${options.setupWait}, merge ${options.mergeWait}, release ${options.releaseWait}, takedown ${options.takedownWait}.`);
  if (options.dryRun) {
    console.log(`\nThe ${PLAN.length} checks, in order:`);
    for (const entry of PLAN) console.log(`  ${entry.id.padEnd(7)} ${entry.title}${entry.outOfScope ? ` [out of scope: ${entry.outOfScope}; always SKIP, listed apart]` : ""}`);
  }
  const problem = secretProblem(signupSecret);
  if (grantProblem) {
    console.error(`\nRefused: ${grantProblem}. The run can't ask for a release without one. Nothing was sent.`);
    process.exit(EXIT.releaseNotOn);
  }
  if (problem && !options.dryRun) {
    console.error(`\nRefused: ${problem}. Nothing was sent.`);
    process.exit(EXIT.refused);
  }
  if (options.dryRun) {
    console.log(`\nThe configuration is complete${problem ? `, but for the sign-up secret: ${problem}` : ""}. Nothing was sent to staging, GitHub or ${CONTENT_DOMAIN}.`);
    process.exit(problem ? EXIT.refused : 0);
  }
}

// The clients come with the e2e packages, which a dry run doesn't need.
const { eq, key, McpAgent, ok, Person, sleep, Target } = await import("./lib.mjs");

const POLL_MS = 3000;
const requests = [];
const secrets = [signupSecret];
/** Keeps a credential out of the run's output. Answers it. */
const secret = (value) => {
  if (typeof value === "string" && value.length >= 8 && !secrets.includes(value)) secrets.push(value);
  return value;
};
const say = (line = "") => console.log(scrub(line, secrets));
/** Every request the run sends, each logged as it ends: start, method, path (an app's host masked), status, ms. Never a body, header or query. */
function logRequest({ url, ...request }) {
  const entry = { ...request, path: maskedPath(url) };
  requests.push(entry);
  console.log(scrub(requestLine(entry), secrets));
}
const target = new Target(STAGING, { pollMs: POLL_MS, onRequest: logRequest });
const RUN = `M6 release ${new Date().toISOString().slice(0, 16)}`;
const tally = new Tally(PLAN, say);

// ---- checks ----

/** A check that can't run here, with why. */
class Skip extends Error {}
/** The run can't go on. */
class Stop extends Error {}
/** Release isn't on with a provider: the run ends with exit 3. */
class NotOn extends Error {}
/** The run was told to stop. */
class Halt extends Error {}
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nStopping at the next request; clean-up follows. Press Ctrl-C again to quit at once, without it.");
});
const cause = (error) => {
  const parts = [];
  for (let at = error, depth = 0; at && depth < 4; at = at.cause, depth++) {
    const said = [at.code, at.message].filter(Boolean).join(" ");
    if (said && !parts.includes(said)) parts.push(said);
  }
  return parts.join(": ") || String(error);
};
async function check(id, run) {
  if (stopping) throw new Halt("stopped by a signal");
  try {
    tally.add(id, "pass", (await run()) ?? "");
    return true;
  } catch (error) {
    if (error instanceof Halt || error instanceof NotOn) throw error;
    tally.add(id, error instanceof Skip ? "skip" : "fail", cause(error));
    return false;
  }
}
/** Fails a check whose ground an earlier one didn't lay: every in-scope check must pass, so this is never a SKIP. */
const after = (...ids) => {
  const missing = ids.filter((id) => !tally.passed(id));
  if (missing.length) throw new Error(`not shown: it needs ${missing.join(" and ")} to have passed`);
};
const pause = async (ms) => {
  if (stopping) throw new Halt("stopped by a signal");
  await sleep(ms);
};
/** A person's refusal: exactly this status and this code. */
const refusedAs = (result, status, code, label) => eq([result.status, result.code ?? null], [status, code], label);
/** An agent's refusal over MCP, which carries a code and no status. */
const refusedCode = (result, code, label) => eq([result.ok, result.code ?? null], [false, code], label);
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

// ---- people and the agent ----

const sessions = [];
const leftBehind = [];
let signUpsAsked = 0;
let signUpUnknown = false;
/** One take of the test sign-up, never sent twice: an answer lost in transport may have been taken. */
async function signUpCookie(label, body) {
  ok(!signUpUnknown, `the test sign-up for ${label} wasn't asked for: an earlier sign-up's outcome is unknown`);
  if (stopping) throw new Halt("stopped by a signal");
  signUpsAsked++;
  let res;
  try {
    res = await target.http("/api/auth/sign-up/e2e", { method: "POST", headers: { authorization: `Bearer ${signupSecret}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, retry: false });
  } catch (error) {
    signUpUnknown = true;
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
  const agent = await McpAgent.connect(target, linker, `${RUN} ${label}`);
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
const work = mkdtempSync(join(tmpdir(), "podster-m6-release-"));
const askpass = join(work, "askpass.sh");
writeFileSync(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
chmodSync(askpass, 0o700);
function git(args, { cwd = work, credential } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "credential.helper=", "-c", "http.followRedirects=false", ...args], { cwd, env: gitEnv({ home: work, askpass, credential }), stdio: ["ignore", "pipe", "pipe"] });
    const out = { stdout: "", stderr: "" };
    child.stdout.on("data", (chunk) => (out.stdout += chunk));
    child.stderr.on("data", (chunk) => (out.stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: error.code ?? "spawn_failed" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: scrub(out.stdout, secrets), stderr: scrub(out.stderr, secrets) });
    });
  });
}
async function mustGit(args, opts, label) {
  const done = await git(args, opts);
  ok(done.code === 0, `${label}: git exited ${done.code}: ${done.stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? ""}`);
  return done;
}

// ---- the app's host, asked directly ----

/** One request to a host on the content domain, logged with the host masked. Answers status, headers and body text. */
async function hostAsk(url, { method = "GET", headers = {} } = {}) {
  const at = new Date().toISOString();
  const begun = performance.now();
  try {
    const res = await fetch(url, { method, redirect: "manual", headers: { "cache-control": "no-cache", ...headers }, signal: AbortSignal.timeout(30_000) });
    const body = method === "HEAD" ? "" : await res.text();
    logRequest({ url, method, at, ms: Math.round(performance.now() - begun), status: res.status });
    return { status: res.status, headers: [...res.headers], setCookies: res.headers.getSetCookie(), body };
  } catch (error) {
    logRequest({ url, method, at, ms: Math.round(performance.now() - begun), error: error?.name ?? "Error" });
    throw new Error(`a request to the app's host failed in transport (${error?.name ?? "Error"})`);
  }
}
const marker = (at) => hostAsk(`https://${at}${MARKER_PATH}`);

/** Playwright's Chromium, with child-env.mjs's environment: never a secret of ours. */
async function withBrowser(run) {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({ env: childEnv() });
  try {
    return await run(browser);
  } finally {
    await browser.close().catch(() => null);
  }
}

// ---- the run's state ----

let owner, admin, member, operator, coder;
/** The organization the owner made for the run, which the room is in and the two other people join. */
let team;
let room, otherRoom, otherTask;
let repo;
/** The app's default host and label, once it has one. */
let host, appLabel;
const publisher = new RoomPublisher({ putTimeoutMs: 30_000, stopWaitMs: 60_000, sleep });
/** What clean-up must undo, set as each is done and cleared once undone. */
const undo = { releaseOn: false, suspended: null, delegationTaken: false };
/** Grants the run gave, by ID, that clean-up takes back unless seen ended. */
const grants = new Map();
const tasks = {};

const releasesPath = () => `/v1/workspaces/${room}/releases`;
const statusOf = async (task) => owner.must("GET", `/v1/workspaces/${room}/tasks/${task.id}/release-status`);
const taskRead = async (task) => owner.must("GET", `/v1/workspaces/${room}/tasks/${task.id}`);
const configOf = async () => owner.must("GET", `/v1/workspaces/${room}/release-config`);
/** A member's request for a release of `task`'s merged commit. */
const askRelease = (who, task, body = {}, options = undefined) => who.dash("POST", releasesPath(), { task_id: task.id, commit_sha: task.mergeSha, ...body }, options);

/** A grant the run gives, noted for clean-up before anything is asserted about it. */
async function give(principal, action) {
  const answer = await owner.dash("POST", `/v1/workspaces/${room}/repository/grants`, { policy_version: await owner.policyVersion(room), principal_id: principal.id, action });
  if (answer.body?.id) grants.set(answer.body.id, `${action} grant to ${principal.id}`);
  if (action === DEPLOY_GRANT.action && answer.status === 400 && answer.code === "invalid_argument") throw new NotOn("staging's grant route refuses the action deploy: no route gives a deploy grant there, so nothing can be released");
  ok(answer.ok, `giving a ${action} grant to ${principal.id}: HTTP ${answer.status} ${answer.code ?? ""}`);
  eq([answer.body.principal_id, answer.body.action, answer.body.state], [principal.id, action, "live"], `the ${action} grant`);
  return answer.body;
}
async function takeBack(id) {
  const back = await owner.dash("DELETE", `/v1/workspaces/${room}/repository/grants/${id}`, { policy_version: await owner.policyVersion(room) });
  if ((back.ok && back.body?.revoked_at) || (back.status === 404 && back.code === "grant_not_found")) grants.delete(id);
  return back;
}

/** A task for the coder, accepted, reviewed by the admin. */
async function newTask(name) {
  const made = await owner.must("POST", `/v1/workspaces/${room}/tasks`, { title: `${RUN} ${name}`, instructions: "Change the site.", acceptance_criteria: "A pull request.", assignee: coder.id, reviewer: admin.id }, { idempotencyKey: key() });
  const at = { workspace_id: room, task_id: made.id };
  const accepted = await coder.must("accept_task", { ...at, version: made.version });
  leftBehind.push(`task ${made.id}`);
  say(`     task ${name}: ${made.id}`);
  return (tasks[name] = { id: made.id, at, version: accepted.version, name });
}
/**
 * The coder's change for a task: its token, a branch off the default branch with one commit of `files`, pushed, and a
 * pull request; submitted; approved by the admin; merged by the admin, a person with a merge grant who doesn't control
 * the coder. Answers the task with its head and its merge commit.
 */
async function changeAndMerge(task, files) {
  const access = await coder.must("get_repo_access", task.at, false);
  ok(typeof access?.token === "string" && access.token.length >= 20, "the coder was given no token");
  const token = secret(access.token);
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
  await admin.must("POST", `/v1/workspaces/${room}/tasks/${task.id}/verify`, { submission_no: 1, commit_sha: head });
  const asked = await admin.must("POST", `/v1/workspaces/${room}/tasks/${task.id}/merge`, { submission_no: 1, commit_sha: head });
  eq(asked.merge_state, "requested", "the merge as asked for");
  const { value: change, seconds } = await within(options.mergeWait, "the merge", async () => (await taskRead(task)).change, (c) => ["succeeded", "failed", "outcome_unknown"].includes(c?.merge_state));
  eq([change.merge_state, change.merge_reason ?? null], ["succeeded", null], "the merge");
  ok(/^[0-9a-f]{40}$/.test(change.merge_sha ?? ""), "the merge recorded no commit");
  Object.assign(task, { head, pr: opened.body.number, mergeSha: change.merge_sha });
  say(`     ${task.name}: pull request ${task.pr}, head ${head}, merged as ${task.mergeSha} after ${seconds} s`);
  return task;
}

/** Waits for the latest release of `task` to be `releaseId` and settled. Answers the release part of its status. */
async function settled(task, releaseId) {
  const { value, seconds } = await within(options.releaseWait, `release ${releaseId} settling`, () => statusOf(task), (s) => s.release?.release_id === releaseId && SETTLED.includes(s.release?.state));
  return { status: value, seconds };
}
/** Approves a release as the admin, and waits for it to be served. Answers the status and the seconds it took. */
async function approveAndServe(task, releaseId) {
  const approved = await admin.must("POST", `${releasesPath()}/${releaseId}/approve`, {});
  eq([approved.id, approved.approved_by], [releaseId, admin.id], "the approval");
  ok(approved.state !== "failed", `the approval ended the release failed, ${approved.failure_code}`);
  let outcome;
  try {
    outcome = await settled(task, releaseId);
  } catch (error) {
    const last = (await statusOf(task).catch(() => null))?.release;
    const stuck = ["queued", "uploading", "uncertain", "awaiting_confirmation"].includes(last?.state);
    throw new Error(`${cause(error)}; it was last ${last?.state ?? "unread"}${stuck ? ". A release that stays queued or uploading is what staging does with no content provider configured" : ""}`);
  }
  const problems = statusProblems(outcome.status, { taskId: task.id, mergeSha: task.mergeSha, release: { id: releaseId, state: "served", served: true } });
  ok(problems.length === 0, problems.join("; "));
  return outcome;
}
/** The host's not found, within the wait. Answers how long it took. */
async function hostDown(what) {
  const { seconds } = await within(options.takedownWait, what, () => hostAsk(`https://${host}/`), (answer) => contentNotFoundProblem(answer) === null);
  return seconds;
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

// ---- the run ----

async function main() {
  say("\n## the owner, the room, and whether release answers");
  owner = await person("the room's owner");
  await owner.useNewOrg(`${RUN} team`);
  team = owner.org;
  leftBehind.push(`the run's organization ${team}`);
  room = await owner.createRoom(`${RUN} release`);
  leftBehind.push(`room ${room}`);
  say(`     owner ${owner.id}; organization ${team}; room ${room}`);
  {
    const config = await owner.dash("GET", `/v1/workspaces/${room}/release-config`);
    if (config.status === 404 && config.code === "not_found") throw new NotOn("the room's release configuration answers as a missing route: RELEASES isn't exactly true on staging");
    ok(config.ok, `the room's release configuration answered ${config.status} ${config.code ?? ""}`);
    eq([config.body.enabled, config.body.version, config.body.default_host], [false, 0, null], "a new room's release configuration");
    // Nothing is in this room to release: a request is refused, and which refusal says whether the path is open.
    const probe = await owner.dash("POST", releasesPath(), { task_id: "tsk_e2e_probe", commit_sha: "0".repeat(40) });
    if (probe.status === 409 && probe.code === "release_not_available") throw new NotOn("a request is refused release_not_available: a provider is configured and the release path isn't complete (RELEASE_PATH_COMPLETE is false)");
    refusedAs(probe, 409, "release_needs_public_room", "a request in a new, private room");
  }

  say("\n## the room's admin, a member, the agent and the repository");
  const joinRoom = async (who, role) => {
    const invited = await owner.must("POST", `/orgs/${team}/invitations`, { role: "member" });
    await who.must("POST", "/org-invitations/accept", { token: secret(invited.token) });
    who.org = who.actingOrg = team;
    await owner.must("POST", `/v1/workspaces/${room}/members`, { principal_id: who.id, kind: "person", org_id: team, role, policy_version: await owner.policyVersion(room) });
  };
  admin = await person("the room's admin");
  await joinRoom(admin, "admin");
  member = await person("a member");
  await joinRoom(member, "member");
  coder = await agentOf(owner, "coder");
  leftBehind.push(`agent ${coder.id}`);
  await owner.addAgent(room, coder);
  otherRoom = await owner.createRoom(`${RUN} other`);
  leftBehind.push(`room ${otherRoom}`);
  otherTask = (await owner.must("POST", `/v1/workspaces/${otherRoom}/tasks`, { title: `${RUN} elsewhere`, instructions: "Nothing." }, { idempotencyKey: key() })).id;
  say(`     admin ${admin.id}; member ${member.id}; coder ${coder.id}; another room ${otherRoom} with task ${otherTask}`);

  const name = `e2e-m6-${new Date().toISOString().slice(0, 16).replace(/\D/g, "")}-${randomBytes(2).toString("hex")}`;
  const asked = await owner.dash("POST", `/v1/workspaces/${room}/repository`, { name, visibility: "public" });
  leftBehind.push(`possibly the repository ${STAGING_ORG}/${name} on GitHub`);
  ok(asked.ok && asked.body?.request?.state === "pending", `asking for the repository: HTTP ${asked.status} ${asked.code ?? ""}`);
  const { value: read, seconds } = await within(options.setupWait, "the repository's setup", () => owner.must("GET", `/v1/workspaces/${room}/repository`), (r) => r.request?.state !== "pending");
  eq([read.request.state, read.repository?.status, read.repository?.full_name], ["ready", "ready", `${STAGING_ORG}/${name}`], "the room's repository");
  repo = { id: read.repository.provider_repo_id, full: read.repository.full_name, defaultBranch: read.repository.default_branch, cloneUrl: `https://github.com/${read.repository.full_name}.git` };
  say(`     repository ${repo.id}, ${repo.full}, ready after ${seconds} s`);
  await give(coder, "push");
  await give(admin, "merge");
  const t1 = await changeAndMerge(await newTask("site"), SITE);

  say("\n## release switched off publishes nothing");
  await check("M6-R01", async () => {
    refusedAs(await askRelease(member, t1), 409, "release_needs_public_room", "a request in the private room");
    const published = await publisher.publish(owner, room);
    ok(published.ok, `making the room public: HTTP ${published.status} ${published.code ?? ""}`);
    refusedAs(await askRelease(member, t1), 409, "release_off", "a request in the public room, with release off in the room");
    const config = await configOf();
    eq([config.enabled, config.default_host], [false, null], "the room's release configuration");
    eq((await admin.must("GET", `/v1/workspaces/${room}/release-approvals`)).releases, [], "the releases awaiting approval");
    const problems = statusProblems(await statusOf(t1), { taskId: t1.id, mergeSha: t1.mergeSha, release: "none" });
    ok(problems.length === 0, problems.join("; "));
    return "refused release_needs_public_room while private and release_off while public; no host, no release, status { exists: false }";
  });

  say("\n## the organization's release switch");
  try {
    operator = await Person.fromCookie(target, "the test operator", await signUpCookie("the test operator", { stable: "operator" }));
    say(`     test operator ${operator.id}`);
  } catch (error) {
    if (error instanceof Halt) throw error;
    say(`     the test operator couldn't sign in: ${cause(error)}`);
  }
  const delegationPath = `/v1/orgs/${team}/release-delegation`;
  await check("M6-R02", async () => {
    ok(operator, "the test operator didn't sign in");
    refusedAs(await owner.dash("PUT", delegationPath, { granted: false }), 403, "not_allowed", "the owner, an admin of the organization, setting its release switch");
    const taken = await operator.dash("PUT", delegationPath, { granted: false });
    if (taken.status === 403) throw new Error(`the test operator was refused (${taken.code}): it isn't in staging's OPERATORS. m4-staging.mjs --operator-id prints its ID for the owner to add`);
    ok(taken.ok, `the operator taking release: HTTP ${taken.status} ${taken.code ?? ""}`);
    undo.delegationTaken = true;
    eq(taken.body.granted, false, "the switch after the take");
    refusedAs(await owner.dash("PUT", `/v1/workspaces/${room}/release-config`, { enabled: true, expected_version: 0 }), 409, "release_not_delegated", "the owner switching release on");
    const config = await configOf();
    eq([config.enabled, config.version], [false, 0], "the configuration after the refusal");
    const back = await operator.must("PUT", delegationPath, { granted: true });
    eq(back.granted, true, "the switch given back");
    undo.delegationTaken = false;
    return `generation ${back.generation}, last take ${back.last_take}`;
  });

  say("\n## who may configure and approve");
  await check("M6-R03", async () => {
    const on = await admin.must("PUT", `/v1/workspaces/${room}/release-config`, { enabled: true, expected_version: 0 });
    undo.releaseOn = true;
    eq([on.enabled, on.version, on.set_by], [true, 1, admin.id], "the configuration the admin set");
    refusedAs(await member.dash("GET", `/v1/workspaces/${room}/release-config`), 403, "not_allowed", "the member reading the configuration");
    refusedAs(await member.dash("PUT", `/v1/workspaces/${room}/release-config`, { enabled: false, expected_version: 1 }), 403, "not_allowed", "the member setting the configuration");
    refusedAs(await member.dash("GET", `/v1/workspaces/${room}/release-approvals`), 403, "not_allowed", "the member listing approvals");
    eq((await configOf()).version, 1, "the configuration's version afterwards");
  });

  say("\n## claiming a role grants no deploy right");
  await check("M6-R04", async () => {
    after("M6-R03");
    const opening = await owner.must("POST", `/v1/workspaces/${room}/roles`, { title: "DevOps", responsibilities: "Deploys the room's app.", preset: "member", capacity: 1, policy_version: await owner.policyVersion(room) });
    await owner.must("POST", `/v1/workspaces/${room}/roles/${opening.id}/invites`, { policy_version: await owner.policyVersion(room), principal_id: coder.id });
    await coder.must("claim_role", { workspace_id: room, role_id: opening.id });
    ok((await coder.tools()).includes("deploy_release"), "the agent isn't offered deploy_release, so its refusal would show nothing");
    refusedCode(await coder.call("deploy_release", { workspace_id: room, task_id: t1.id, commit_sha: t1.mergeSha, idempotency_key: key() }), "grant_required", "the DevOps agent asking for a release");
    refusedAs(await askRelease(member, t1), 403, "grant_required", "the member, with no grant");
    refusedAs(await askRelease(owner, t1), 403, "grant_required", "the owner, with no grant of their own");
    const problems = statusProblems(await statusOf(t1), { taskId: t1.id, mergeSha: t1.mergeSha, release: "none" });
    ok(problems.length === 0, `the completed, merged task: ${problems.join("; ")}`);
    return `opening ${opening.id} claimed by ${coder.id}; refused grant_required to it, the member and the owner`;
  });

  await give(member, DEPLOY_GRANT.action);

  say("\n## what may be asked for");
  await check("M6-R05", async () => {
    after("M6-R03");
    refusedAs(await askRelease(member, t1, { commit_sha: t1.head }), 409, "commit_not_releasable", "the task branch's head");
    refusedAs(await askRelease(member, t1, { task_id: otherTask }), 404, "task_not_found", "another room's task");
    refusedAs(await askRelease(member, t1, { environment: "staging" }), 400, "invalid_argument", "another environment");
    for (const field of ["repository_id", "account_id", "namespace", "host", "label", "script_name"]) refusedAs(await askRelease(member, t1, { [field]: "e2e" }), 400, "invalid_argument", `a request naming ${field}`);
    refusedAs(await admin.dash("POST", `${releasesPath()}/rel_${randomBytes(16).toString("hex")}/approve`, {}), 404, "not_found", "approving a release this room doesn't have");
    eq((await admin.must("GET", `/v1/workspaces/${room}/release-approvals`)).releases, [], "the releases awaiting approval");
    const problems = statusProblems(await statusOf(t1), { taskId: t1.id, mergeSha: t1.mergeSha, release: "none" });
    ok(problems.length === 0, problems.join("; "));
  });

  say("\n## the release");
  let first;
  await check("M6-R06", async () => {
    after("M6-R03");
    const once = key();
    const asked = await askRelease(member, t1, {}, { idempotencyKey: once });
    ok(asked.ok, `the member's request: HTTP ${asked.status} ${asked.code ?? ""}`);
    eq([asked.body.state, asked.body.commit_sha, asked.body.requested_by, asked.body.approved_by], ["awaiting_approval", t1.mergeSha, member.id, null], "the release as asked for");
    const again = await askRelease(member, t1, {}, { idempotencyKey: once });
    eq([again.status, again.body?.id], [200, asked.body.id], "the same request with the same key");
    const waiting = (await admin.must("GET", `/v1/workspaces/${room}/release-approvals`)).releases;
    eq(waiting.map((r) => r.id), [asked.body.id], "the releases awaiting approval");
    refusedAs(await member.dash("POST", `${releasesPath()}/${asked.body.id}/approve`, {}), 403, "not_allowed", "its requester, who isn't an admin, approving it");
    const { seconds } = await approveAndServe(t1, asked.body.id);
    const config = await configOf();
    const at = defaultHostProblem(config.default_host);
    ok(!at.problem, at.problem);
    [host, appLabel] = [config.default_host, at.label];
    const status = await statusOf(t1);
    eq(resultUrlProblem(status.release.result_url, host), null, "the result URL");
    eq(markerProblem(await marker(host), asked.body.id, t1.mergeSha), null, "the host's marker");
    first = asked.body.id;
    return `release ${first} served after ${seconds} s at the app's default host, label ${appLabel}`;
  });

  say("\n## what the host serves");
  await check("M6-R07", async () => {
    after("M6-R06");
    const index = await hostAsk(`https://${host}/`);
    eq([index.status, index.body], [200, SITE["site/index.html"]], "the site's index");
    ok(/^text\/html/.test(new Headers(index.headers).get("content-type") ?? ""), "the index isn't served as HTML");
    const problems = fixedHeaderProblems(index.headers);
    ok(problems.length === 0, `the index: ${problems.join("; ")}`);
    const text = await hostAsk(`https://${host}/hello.txt`);
    eq([text.status, text.body], [200, SITE["site/hello.txt"]], "the site's text file");
    eq((await hostAsk(`https://${host}/`, { method: "HEAD" })).status, 200, "HEAD of the index");
    for (const method of ["POST", "PUT", "DELETE"]) eq((await hostAsk(`https://${host}/`, { method })).status, 405, `${method} of the index`);
    const missing = await hostAsk(`https://${host}/e2e-${randomBytes(4).toString("hex")}.txt`);
    eq(contentNotFoundProblem(missing), null, "a path the site doesn't have");
  });

  await check("M6-R08", async () => {
    after("M6-R06");
    ok(!defaultHostProblem(host).problem, "the host isn't an app's default host on the content domain");
    const plain = await hostAsk(`https://${host}/`);
    // Podster's own cookie names, with values of the run's own: never a real session, which the content domain must not see.
    const names = owner.cookie.split("; ").map((pair) => pair.slice(0, pair.indexOf("=")));
    const carried = await hostAsk(`https://${host}/`, { headers: { cookie: names.map((n) => `${n}=${randomBytes(12).toString("hex")}`).join("; "), authorization: `Bearer ${randomBytes(24).toString("hex")}` } });
    eq([carried.status, carried.body], [plain.status, plain.body], "an answer to a request carrying Podster's cookie names and an Authorization header");
    for (const answer of [plain, carried]) eq(answer.setCookies, [], "cookies set by the host");
    return `${names.length} cookie name(s) carried; no answer set a cookie`;
  });

  await check("M6-R09", async () => {
    after("M6-R06");
    const probe = randomBytes(16).toString("hex");
    const seen = await withBrowser(async (browser) => {
      const context = await browser.newContext();
      await context.addCookies([{ name: "e2e_probe", value: probe, domain: ".podster.dev", path: "/", secure: true, sameSite: "Lax" }]);
      const page = await context.newPage();
      const loaded = await page.goto(`https://${host}/`, { waitUntil: "load", timeout: 60_000 });
      ok(loaded?.status() === 200, `the page answered ${loaded?.status()}`);
      const inPage = await page.evaluate(async (api) => {
        const out = {};
        try {
          out.read = document.cookie;
        } catch (error) {
          out.readThrew = error.name;
        }
        try {
          document.cookie = "e2e_set=1; domain=podster.dev; path=/; secure";
          document.cookie = "e2e_host=1; path=/; secure";
        } catch (error) {
          out.setThrew = error.name;
        }
        try {
          out.after = document.cookie;
        } catch (error) {
          out.afterThrew = error.name;
        }
        try {
          out.api = (await fetch(api, { credentials: "include" })).status;
        } catch (error) {
          out.apiThrew = error.name;
        }
        return out;
      }, `${STAGING}/api/v1/me`);
      return { inPage, jar: (await context.cookies()).map((c) => `${c.name}@${c.domain}`) };
    });
    ok(!String(seen.inPage.read ?? "").includes(probe), "the page read the cookie set for podster.dev");
    ok(!/e2e_/.test(String(seen.inPage.after ?? "")), "the page reads a cookie it set");
    eq(seen.jar, ["e2e_probe@.podster.dev"], "the browser's cookies afterwards");
    ok(seen.inPage.api === undefined, `the page reached the application's API (HTTP ${seen.inPage.api})`);
    return `reading cookies: ${seen.inPage.readThrew ?? "empty"}; setting: ${seen.inPage.setThrew ?? "ignored"}; the API: ${seen.inPage.apiThrew}`;
  });

  say("\n## an agent's request, declined");
  await check("M6-R10", async () => {
    after("M6-R06");
    await give(coder, DEPLOY_GRANT.action);
    const asked = await coder.must("deploy_release", { workspace_id: room, task_id: t1.id, commit_sha: t1.mergeSha });
    eq([asked.state, asked.requested_by, asked.commit_sha], ["awaiting_approval", coder.id, t1.mergeSha], "the agent's release as asked for");
    const declined = await admin.must("POST", `${releasesPath()}/${asked.id}/decline`, {});
    eq([declined.state, declined.declined_by], ["declined", admin.id], "the declined release");
    eq(markerProblem(await marker(host), first, t1.mergeSha), null, "the host's marker");
    return `release ${asked.id} asked for by ${coder.id}, declined`;
  });

  say("\n## a release that fails, beside a merge that succeeded");
  let t2;
  await check("M6-R11", async () => {
    after("M6-R06");
    t2 = await changeAndMerge(await newTask("refused"), REFUSED_SITE);
    const asked = await askRelease(member, t2);
    ok(asked.ok, `the member's request: HTTP ${asked.status} ${asked.code ?? ""}`);
    await admin.must("POST", `${releasesPath()}/${asked.body.id}/approve`, {});
    const { status, seconds } = await settled(t2, asked.body.id);
    const problems = statusProblems(status, { taskId: t2.id, mergeSha: t2.mergeSha, release: { id: asked.body.id, state: "failed", served: false, failed: true } });
    ok(problems.length === 0, problems.join("; "));
    eq((await taskRead(t2)).task.status, "completed", "the task's status");
    const earlier = statusProblems(await statusOf(t1), { taskId: t1.id, mergeSha: t1.mergeSha, release: { id: first, state: "served", served: true } });
    ok(earlier.length === 0, `the first task: ${earlier.join("; ")}`);
    eq(markerProblem(await marker(host), first, t1.mergeSha), null, "the host's marker");
    return `release ${asked.body.id} failed ${status.release.failure_code} after ${seconds} s; merge succeeded at ${status.merge.observed_at}, release at ${status.release.observed_at}, checks ${status.checks.state ?? "unread"}`;
  });

  await check("M6-R12", async () => {
    after("M6-R11");
    const shown = await withBrowser(async (browser) => {
      const context = await browser.newContext();
      const appHost = new URL(STAGING_APP).hostname;
      const cookies = owner.cookie.split("; ").map((pair) => ({ name: pair.slice(0, pair.indexOf("=")), value: pair.slice(pair.indexOf("=") + 1), domain: appHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }));
      await context.addCookies([...cookies, { name: "podster-org", value: team, domain: appHost, path: "/", secure: true, sameSite: "Lax" }]);
      const page = await context.newPage();
      const stageOf = async (task, headline) => {
        await page.goto(`${STAGING_APP}/w/${room}/tasks?task=${task.id}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.getByText(headline, { exact: true }).first().waitFor({ timeout: 30_000 });
        return page.getByTestId("deployment-stage").first().innerText({ timeout: 10_000 });
      };
      return { failed: await stageOf(t2, "Merged · Deployment failed"), live: await stageOf(t1, "Merged · Live") };
    });
    ok(!/\bLive\b/.test(shown.failed), "the failed task's deployment stage says Live");
    return "\"Merged · Deployment failed\" on the failed task, \"Merged · Live\" on the served one";
  });

  say("\n## authority that ends before the approval");
  await check("M6-R13", async () => {
    after("M6-R06");
    const asked = await askRelease(member, t1);
    ok(asked.ok, `the member's request: HTTP ${asked.status} ${asked.code ?? ""}`);
    const held = [...grants].find(([, what]) => what === `${DEPLOY_GRANT.action} grant to ${member.id}`);
    ok(held, "the member's deploy grant isn't on the run's list");
    const back = await takeBack(held[0]);
    ok(back.ok, `taking the member's grant back: HTTP ${back.status} ${back.code ?? ""}`);
    const approved = await admin.dash("POST", `${releasesPath()}/${asked.body.id}/approve`, {});
    ok(approved.ok && approved.body?.state === "failed" && typeof approved.body?.failure_code === "string", `the approval after the grant was taken back answered HTTP ${approved.status} ${approved.code ?? approved.body?.state ?? ""}, not the release failed`);
    eq(markerProblem(await marker(host), first, t1.mergeSha), null, "the host's marker");
    await give(member, DEPLOY_GRANT.action);
    return `release ${asked.body.id} failed ${approved.body.failure_code}; the member was given a new grant`;
  });

  say("\n## takedown");
  await check("M6-R14", async () => {
    after("M6-R06");
    ok(operator, "the test operator didn't sign in");
    const report = await member.must("POST", "/v1/app-reports", { address: `https://${host}/`, reason: "other" }, { idempotencyKey: key() });
    ok(/^[A-Za-z0-9_]+$/.test(report.id ?? ""), "the report has no ID");
    const suspended = await operator.dash("POST", `/v1/moderation/apps/${appLabel}/suspend`, { reason: "other" });
    ok(suspended.ok, `the operator's suspension: HTTP ${suspended.status} ${suspended.code ?? ""}`);
    undo.suspended = appLabel;
    eq([suspended.body.label, suspended.body.suspended], [appLabel, true], "the suspension");
    const down = await hostDown("the host stopping after the suspension");
    refusedAs(await askRelease(member, t1), 409, "app_suspended", "a request while the app is suspended");
    const lifted = await operator.must("POST", `/v1/moderation/apps/${appLabel}/lift`, { reason: "other" });
    eq(lifted.suspended, false, "the lift");
    undo.suspended = null;
    for (let looks = 0; looks < 3; looks++) {
      await pause(POLL_MS);
      eq(contentNotFoundProblem(await hostAsk(`https://${host}/`)), null, "the host after the lift");
    }
    return `report ${report.id}; the host answered not found ${down} s after the suspension, and still did after the lift`;
  });

  await check("M6-R15", async () => {
    after("M6-R14");
    const asked = await askRelease(member, t1);
    ok(asked.ok, `the member's new request: HTTP ${asked.status} ${asked.code ?? ""}`);
    const { seconds } = await approveAndServe(t1, asked.body.id);
    const config = await configOf();
    const at = defaultHostProblem(config.default_host);
    ok(!at.problem, at.problem);
    [host, appLabel] = [config.default_host, at.label];
    eq(markerProblem(await marker(host), asked.body.id, t1.mergeSha), null, "the host's marker");
    return `release ${asked.body.id} served after ${seconds} s`;
  });

  say("\n## unpublish");
  await check("M6-R16", async () => {
    after("M6-R06");
    const config = await configOf();
    const off = await admin.must("PUT", `/v1/workspaces/${room}/release-config`, { enabled: false, expected_version: config.version });
    undo.releaseOn = false;
    eq(off.enabled, false, "the configuration switched off");
    const down = await hostDown("the host stopping after release was switched off");
    const status = await statusOf(t1);
    eq([status.release?.exists, status.release?.served, status.release?.result_url], [true, false, null], "the first task's release after the unpublish");
    eq(status.release.state, "unpublished", "the state of the release that was served");
    return `the host answered not found ${down} s after release was switched off; release ${status.release.release_id} is kept, unpublished`;
  });

  say("\n## the room made private again");
  await check("M6-R17", async () => {
    const back = await publisher.unpublish(owner, room);
    ok(back.ok, `making the room private: HTTP ${back.status} ${back.code ?? ""}`);
    eq((await owner.must("GET", `/v1/workspaces/${room}/visibility`)).visibility, "private", "the room's visibility");
    refusedAs(await askRelease(member, t1), 409, "release_needs_public_room", "a request in the private room");
    if (host) eq(contentNotFoundProblem(await hostAsk(`https://${host}/`)), null, "the host");
  });
}

// ---- clean-up ----

async function cleanUp() {
  const said = [];
  if (undo.suspended && operator) {
    const lifted = await operator.dash("POST", `/v1/moderation/apps/${undo.suspended}/lift`, { reason: "other" }).catch(() => null);
    said.push(lifted?.ok ? "the app's suspension was lifted" : `the app's suspension could NOT be lifted (${lifted ? `HTTP ${lifted.status} ${lifted.code ?? ""}` : "no answer"}): an operator lifts label ${undo.suspended}`);
  }
  if (undo.delegationTaken && operator) {
    const back = await operator.dash("PUT", `/v1/orgs/${team}/release-delegation`, { granted: true }).catch(() => null);
    said.push(back?.ok ? "the organization's release was given back" : `the organization's release could NOT be given back: an operator gives it back to ${team}`);
  }
  if (undo.releaseOn && room) {
    const config = await (admin ?? owner).dash("GET", `/v1/workspaces/${room}/release-config`).catch(() => null);
    const off = config?.ok ? await (admin ?? owner).dash("PUT", `/v1/workspaces/${room}/release-config`, { enabled: false, expected_version: config.body.version }).catch(() => null) : null;
    said.push(off?.ok ? "release was switched off in the room, which unpublishes its app" : `release could NOT be switched off in room ${room}: its owner switches it off`);
  }
  const { left } = await publisher.stop();
  if (left) said.push(`the room ${room} could NOT be made private again`);
  for (const [id, what] of [...grants]) {
    const back = await takeBack(id).catch(() => null);
    if (grants.has(id)) said.push(`the ${what} (${id}) could NOT be taken back (${back ? `HTTP ${back.status} ${back.code ?? ""}` : "no answer"})`);
  }
  for (const { agent, linker } of agents) {
    await agent.close().catch(() => null);
    const gone = await linker.dash("POST", `/agents/${agent.id}/disconnect`, {}).catch(() => null);
    said.push(`agent ${agent.id} ${gone?.status === 200 ? "disconnected" : "could NOT be disconnected: its credential stays valid until it expires"}`);
  }
  for (const cookie of sessions.splice(0)) await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
  rmSync(work, { recursive: true, force: true });
  return said;
}

const started = Date.now();
try {
  await preflight();
} catch (error) {
  console.error(scrub(`\nRefused: the signed-out preflight failed: ${cause(error)}.\nNo sign-up was taken.`, secrets));
  rmSync(work, { recursive: true, force: true });
  process.exit(EXIT.refused);
}
{
  let listed;
  let refusal = null;
  try {
    listed = await deployReleaseListed();
    if (!listed) refusal = "staging's capabilities discovery doesn't list deploy_release, so the API doesn't say RELEASES is exactly true";
    else {
      const unknown = await hostAsk(`https://${unknownLabel(randomBytes(26))}.${CONTENT_DOMAIN}/`);
      const problem = contentNotFoundProblem(unknown);
      if (problem) refusal = `an unknown app's host on ${CONTENT_DOMAIN} wasn't the content Worker's not found: ${problem}`;
    }
  } catch (error) {
    refusal = `whether release is on couldn't be read: ${cause(error)}`;
  }
  if (refusal) {
    console.error(scrub(`\nRefused: ${refusal}. Release isn't on with a provider on staging.\nNo sign-up was taken.`, secrets));
    rmSync(work, { recursive: true, force: true });
    process.exit(EXIT.releaseNotOn);
  }
  say("     signed out: deploy_release is listed, and the content domain answers an unknown host with the content Worker's not found");
}
let notOn = null;
let halted = false;
let cleanupLines = [];
try {
  await main();
} catch (error) {
  if (error instanceof NotOn) notOn = cause(error);
  halted = error instanceof Halt;
  say(`\nThe run stopped: ${cause(error)}`);
} finally {
  const notRun = stopping || halted ? "not run: the run was stopped by a signal" : "not run: the run stopped before it";
  for (const entry of PLAN) if (!tally.has(entry.id)) tally.add(entry.id, "skip", entry.outOfScope ? outOfScopeReason(entry) : notRun);
  cleanupLines = await cleanUp();
}
say("\n## clean-up");
for (const line of cleanupLines) say(`  - ${line}`);
if (repo) say(`  - the repository ${repo.full} stays on GitHub: the owner archives or deletes it`);
if (notOn) {
  say(`\nRelease isn't on with a provider on staging: ${notOn}. Sign-ups taken: ${signUpsAsked}.`);
  say(`Left behind on staging: ${leftBehind.join("; ") || "nothing"}. Every test session was signed out.`);
  say(slowestLine(requests));
  process.exit(EXIT.releaseNotOn);
}
const outcome = runOutcome(tally, PLAN);
say(`\n${tally.summary()}, in ${Math.round((Date.now() - started) / 1000)} s. Sign-ups asked for: ${signUpsAsked}.`);
if (signUpUnknown) say("A sign-up's answer was lost in transport: whether staging took it is unknown, and it wasn't asked again.");
say(`Out of scope for now, skipped by design and not counted: ${PLAN.filter((e) => e.outOfScope).map((e) => `${e.id} (${e.outOfScope})`).join(", ")}.`);
if (outcome.unshown.length) say(`Not shown, so the run doesn't count as passed: ${outcome.unshown.join(", ")}.`);
say(`Left behind on staging: ${leftBehind.join("; ") || "nothing"}. Every test session was signed out.`);
say(slowestLine(requests));
process.exit(outcome.code);
