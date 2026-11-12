// M5's staging run (step 10 of docs/m5-plan.md): managed repositories end to end, against staging and the real GitHub
// organization staging is configured for, `podsterdev`. A room's owner asks for a repository, an agent pushes a branch
// and opens a pull request with its short-lived token, the room's admin, a second person, reviews it, and merge_task
// merges the reviewed commit. The owner controls the coder, so a review by the owner merges nothing (M5-10e, A1).
// Around that, each refusal with its one exact answer.
//
//   node m5-staging.mjs --base-url https://gateway-staging.podster.dev [--dry-run] [--skip-logs]
//
// Extended on 2026-11-11 with what the first three runs left unshown, each named in docs/m5-plan.md: a second room,
// which the second person owns and the first has no place in, whose setup GitHub really refuses (a name it already
// holds) and a retry then completes; that room's IDs tried in the first room's routes (AC-05); approval after the
// branch advances (AC-31); merges whose authority ends while they wait for the job (AC-13); a merge GitHub refuses;
// tokens after a cancel, a disconnect and a removal (AC-27); more of what the agent's token can't do on GitHub; signed
// webhook deliveries, only when the owner sets PODSTER_M5_WEBHOOK_SECRET for the run; and the three Workers' logs,
// tailed with `wrangler tail` as m4-staging.mjs does. Three of those can't be forced from outside and say SKIP, with
// why, when the run didn't show them: M5-09f, and AC-13a to AC-13c if the job got there first.
//
// Staging's gateway is the only base URL it accepts. There is no local rehearsal of this script: locally GitHub is a
// fake, and merge-check.mjs and repo-access-check.mjs are the rehearsals against it.
//
// People: two takes of staging's test sign-up, of its 6 a minute and 40 a day: the room's owner, and a second person
// who is the room's admin, and who owns the second room. No operator takes part: every organization may have managed repositories unless an operator
// took that back (decision 194, 2026-11-11). Staging lets only the people its REPOSITORY_REQUESTERS names ask for a
// repository; both of the run's people are test people, whom that list holds by its `test-people` entry, and the run
// stops before asking if the room's read says its owner may not. Agents are made under these people and take none. Every test session is
// signed out at the end. The room is in an organization the owner makes for the run, which the second person joins.
//
// The organization on GitHub is pinned in code to `podsterdev`: the run refuses a configuration naming another, and
// fails a repository staging links anywhere else.
//
// GitHub: Podster's own calls go out from staging. This script also asks GitHub directly, three ways. Without a
// credential, about sixteen reads of the public API, of the 60 an hour GitHub allows an address, to see what anyone sees: the repository, its rulesets, the merge commit
// and the status on the reviewed commit. With the agent's token from get_repo_access, to open a pull request and to try
// what must be refused. And through `git`, to push. `git` is a child process with child-env.mjs's allow-listed
// environment, a home directory of its own, and the token under one name in its environment: the token is never printed,
// never on a command line and never written to a file. No App key is read or used here.
//
// Every assertion of Podster's own answers wants one exact answer: a status and a code from a person's call, and a code
// from an agent's, since MCP carries no HTTP status. GitHub's answers to the calls the first runs made are exact too.
// For the calls added on 2026-11-11 that nobody had made against GitHub, a refusal is one of a short list of statuses
// (403 or 404, and 422 for a workflow file), the status is printed, and what the call would have changed is read back
// and must be unchanged. M5-C3 judges nothing: it records what GitHub answered, for gaps the security review named. A check that can't run says SKIP and why. Exit codes: 0 when nothing failed, 1 when a check
// failed or nothing passed, 2 for a refused configuration, 3 when managed repositories are off on staging.
//
// Clean-up: the product has no way to delete a repository, and this script holds no credential that could. It prints
// the two repositories it made, for the owner to archive or delete in GitHub. The three rooms, their tasks and their
// people stay, as every staging run's do. M5-07e leaves one agent disconnected, and the second person ends as the first
// room's admin again. It touches no repository it didn't make.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.mjs";
import { missingWranglers, TAILED_APPS } from "./m4-staging-lib.mjs";
import {
  absentId, ASKPASS_SCRIPT, cloneUrlProblem, deliveryBody, deliveryProblem, deliveryTrace, gatewaySaid, stopWaiting, isCommitSha, logHits, worstCaseSeconds, GrantLedger, gitEnv, lostAuthorityEnding, MERGE_APP_SLUG, mergeCommitProblems, movedHeadEnding,
  parseArgs, PLAN, releaseStatusProblems, repositoryOrgProblem, requesterProblem, reviewStatusProblems, rulesetProblems, scrub, secretProblem, SIGN_UPS, signDelivery, STAGING, STAGING_APP,
  stagingConfig, STATUS_CONTEXT, steady, Tally, USAGE, WEBHOOK_PATH, WEBHOOK_SECRET_ENV, webhookSecretProblem,
} from "./m5-staging-lib.mjs";
import { RoomPublisher } from "./room-publisher.mjs";
import { ACCOUNT_ENV, closeTails, downWithin, openTail, refusalLines, requestHolds, STAY_UP_SECONDS, tailFault as tailProblem, without } from "./m5-tails.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const parsed = parseArgs(process.argv.slice(2), process.env);
if (parsed.error) {
  console.error(`${parsed.error}\n\n${USAGE}`);
  process.exit(2);
}
const options = parsed.options;
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;
/** Staging's webhook secret, only when the owner set it for this run. No file is read for it, and it's used to sign and nothing else. */
const webhookSecret = process.env[WEBHOOK_SECRET_ENV] || undefined;
const repoRoot = join(here, "..");
/** `wrangler tail` for each app, each from that app's own installed wrangler, with m5-tails.mjs's environment. */
const tails = [];
function startTails() {
  for (const app of TAILED_APPS) {
    const cwd = join(repoRoot, "apps", app);
    tails.push(openTail({ app, bin: join(cwd, "node_modules/.bin/wrangler"), cwd }));
  }
}
const stopTails = () => closeTails(tails);
const config = (() => {
  try {
    return stagingConfig(parseJsonc(readFileSync(options.apiConfig ?? join(here, "../apps/api/wrangler.jsonc"), "utf8")).env?.staging?.vars);
  } catch {
    return { error: "the API's wrangler file couldn't be read" };
  }
})();
const signUpsNeeded = SIGN_UPS;

// ---- the plan, and the configuration, before anything is sent ----

{
  const gitFound = spawnSync("git", ["--version"], { env: gitEnv({ home: tmpdir(), askpass: "/usr/bin/false" }), stdio: "ignore" }).status === 0;
  // The tails start from each app's own installed wrangler. Checked before anything is sent, so a checkout without them stops here.
  const uninstalled = options.logs ? missingWranglers(repoRoot) : [];
  const noWrangler = uninstalled.length ? `the log tails need each app's own wrangler, and ${uninstalled.map((app) => `apps/${app}`).join(", ")} ${uninstalled.length === 1 ? "has" : "have"} none installed. Run \`npm ci\` there first, or pass --skip-logs` : null;
  const problems = [secretProblem(signupSecret), webhookSecretProblem(webhookSecret), config.error, gitFound ? null : "git isn't on the PATH", noWrangler].filter(Boolean);
  console.log(`M5's staging run, against ${STAGING}${options.dryRun ? " (dry run: nothing is sent)" : ""}`);
  console.log(`\nSign-ups this run takes: ${signUpsNeeded.length}, of the test sign-up's 6 a minute and 40 a day.`);
  for (const { who, why } of signUpsNeeded) console.log(`  - ${who}: ${why}`);
  if (!config.error) console.log(`\nGitHub: repositories are made in ${config.org} (${config.orgId}); the merge App is ${MERGE_APP_SLUG} (${config.mergeAppId}).`);
  console.log(`Waits, in seconds: setup ${options.setupWait}, merge ${options.mergeWait}, a moved head ${options.observeWait}, revocation ${options.revokeWait}.`);
  console.log(`If every one of those and the run's other bounded waits ran to its limit, the waits alone would come to about ${Math.round(worstCaseSeconds(options) / 60)} minutes. The one run so far took 7 minutes 23 seconds.`);
  console.log(`Logs: ${options.logs ? `\`wrangler tail\` for ${TAILED_APPS.map((app) => `apps/${app}`).join(", ")}, with your wrangler login` : "not tailed (--skip-logs), so M5-13a and M5-13 will be skipped"}.`);
  console.log(`Signed webhook deliveries: ${webhookSecret ? `${WEBHOOK_SECRET_ENV} is set, so M5-16a and M5-16b will run` : `${WEBHOOK_SECRET_ENV} isn't set, so M5-16a and M5-16b will be skipped`}.`);
  if (options.dryRun) {
    console.log(`\nThe ${PLAN.length} checks, in order:`);
    for (const { id, title } of PLAN) console.log(`  ${id.padEnd(7)} ${title}`);
    console.log("\nClean-up: it can't delete the two repositories it makes. It prints their names, for the owner to archive or delete in GitHub.");
  }
  for (const problem of problems) console.error(`\nRefused: ${problem}.`);
  if (problems.length) process.exit(2);
  // The log tails, before anything is sent to staging and before any sign-up: a real run and a dry run alike. Starting
  // a tail asks Cloudflare and nobody else. One that can't start exits at once, and wrangler says why.
  if (options.logs) {
    startTails();
    const down = await downWithin(tails, STAY_UP_SECONDS);
    if (down.length) {
      stopTails();
      for (const line of refusalLines(down)) console.error(`\nRefused: ${line}.`);
      console.error("\nNothing was sent to staging, and no sign-up was taken. Fix the tails, or pass --skip-logs to run without them.");
      process.exit(2);
    }
    console.log(`\nThe three log tails started and stayed up for ${STAY_UP_SECONDS} s${process.env[ACCOUNT_ENV] ? `, for the account ${ACCOUNT_ENV} names` : ""}.`);
  }
  if (options.dryRun) {
    stopTails();
    if (options.logs) console.log("Whether events reach them isn't shown here: that takes a request to staging, and a dry run sends it none. The run itself shows it before its first sign-up.");
    console.log("\nThe configuration is complete. Nothing was sent to staging or to GitHub.");
    process.exit(0);
  }
}

// The clients come with the e2e packages, which a dry run doesn't need.
const { eq, key, McpAgent, ok, Person, sleep, Target } = await import("./lib.mjs");

const POLL_MS = 2000;
const target = new Target(STAGING, { pollMs: POLL_MS });
const RUN = `M5 staging ${new Date().toISOString().slice(0, 16)}`;
/**
 * Nothing here may reach the output: every credential the run handles, each with the kind it is. The kind is what
 * M5-13 prints if it finds one in a log, never the value.
 */
const secrets = [];
const kinds = new Map();
/** Keeps a credential out of the run's output, and on the list M5-13 looks for in the logs. Answers it. */
const secret = (value, kind) => {
  if (typeof value === "string" && value.length >= 8 && !kinds.has(value)) {
    secrets.push(value);
    kinds.set(value, kind);
  }
  return value;
};
secret(signupSecret, "the sign-up secret");
secret(webhookSecret, "the webhook secret");
/** The run's own mark, in every note it submits, so M5-13 can look for a note in the Workers' logs. */
const MARK = randomBytes(8).toString("hex");
const NOTE = `Ready for review (${MARK}).`;
/** Every name this run chose that a log must not hold: repositories, branches and pull request titles. */
const chosen = [];
const choose = (label, value) => chosen.push({ label, value });
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const say = (line = "") => console.log(scrub(line, secrets));
const tally = new Tally(PLAN, say);

// ---- checks ----

/** A check that can't run here, with why. */
class Skip extends Error {}
/** The run can't go on. */
class Stop extends Error {}
const cause = (error) => {
  const parts = [];
  for (let at = error, depth = 0; at && depth < 4; at = at.cause, depth++) {
    const said = [at.code, at.message].filter(Boolean).join(" ");
    if (said && !parts.includes(said)) parts.push(said);
  }
  return parts.join(": ") || String(error);
};
/** Runs one check. Its function answers a detail to print, throws to fail, or throws a Skip. Answers whether it passed. */
/** Set by a signal. The run halts at its next check or wait, and clean-up starts only once it has. */
let stopping = false;
/** The run was told to stop. Not a check's failure: it ends the flow. */
class Halt extends Error {}
/** Resolved when the run's flow has ended, however it ended. */
let flowEnded;
const flowDone = new Promise((done) => (flowEnded = done));
async function check(id, run) {
  // Outside the try, so a stop ends the flow instead of being counted as this check's failure.
  if (stopping) throw new Halt("stopped by a signal");
  await keepWorkingToken();
  try {
    tally.add(id, "pass", (await run()) ?? "");
    return true;
  } catch (error) {
    tally.add(id, error instanceof Skip ? "skip" : "fail", cause(error));
    return false;
  }
}
/** Skips a check whose ground an earlier one didn't lay. The earlier failure is what fails the run. */
const after = (...ids) => {
  const missing = ids.filter((id) => !tally.passed(id));
  if (missing.length) throw new Skip(`not run: it needs ${missing.join(" and ")} to have passed`);
};
const have = (value, what) => {
  if (value === undefined || value === null || value === false) throw new Skip(`not run: ${what}`);
  return value;
};
/** A person's refusal: exactly this status and this code. */
const refusedAs = (result, status, code, label) => eq([result.status, result.code ?? null], [status, code], label);
/** An agent's refusal over MCP, which carries a code and no status: exactly this code. */
const refusedCode = (result, code, label) => eq([result.ok, result.code ?? null], [false, code], label);
/** GitHub's own refusal of a call nobody had tried on staging before: one of these statuses, which the result names. */
const refusedBy = (status, allowed, label) => ok(allowed.includes(status), `${label}: GitHub answered ${status}, not ${allowed.join(" or ")}`);
const tokenless = (result, label) => ok(!/gh[a-z]_/.test(JSON.stringify(result ?? null)) && !JSON.stringify(result ?? null).includes('"token"'), `${label}: the answer carried a token`);
/** Polls `read` every `stepMs` until `done` accepts its answer, for at most `seconds`. Answers the value and how long it took. */
async function within(seconds, label, read, done, stepMs = POLL_MS) {
  const start = Date.now();
  for (;;) {
    ok(!stopping, `${label}: the run was told to stop`);
    const value = await read();
    const took = Math.round((Date.now() - start) / 100) / 10;
    if (done(value)) return { value, seconds: took };
    ok(Date.now() - start < seconds * 1000, `${label} didn't happen within ${seconds} s`);
    await sleep(stepMs);
  }
}

// ---- people and agents ----

const sessions = [];
const agents = [];
let signUpsTaken = 0;
async function signUpCookie(label, body) {
  const res = await target.http("/api/auth/sign-up/e2e", { method: "POST", headers: { authorization: `Bearer ${signupSecret}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  ok(res.status === 200, `the test sign-up for ${label} answered ${res.status}. A 404 means it's off on staging, or PODSTER_E2E_SIGNUP_SECRET is wrong.`);
  signUpsTaken++;
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  // The whole cookie and each value in it long enough to be a secret, so a short value can't blank ordinary output.
  for (const value of [cookie, ...cookie.split("; ").map((part) => part.slice(part.indexOf("=") + 1)).filter((value) => value.length >= 16)]) secret(value, "a session cookie");
  sessions.push(cookie);
  return cookie;
}
const person = async (label) => Person.fromCookie(target, label, await signUpCookie(label));
async function agentOf(linker, label) {
  const agent = await McpAgent.connect(target, linker, `${RUN} ${label}`);
  agents.push(agent);
  // The agent's own credential: its OAuth access token and the refresh token beside it, now and each time the SDK
  // saves new ones after a refresh.
  const keep = (held) => {
    secret(held?.access_token, "an agent's OAuth access token");
    secret(held?.refresh_token, "an agent's OAuth refresh token");
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

// ---- GitHub, asked directly ----

/** One call to GitHub's API, with the agent's token or with nothing. Only the status and the parsed body come back. */
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
  return { status: res.status, body: json, spent: res.headers.get("x-ratelimit-remaining") === "0" };
}
/** A read as anyone makes it, with no credential. GitHub allows an address 60 of these an hour, and a run makes about ten. */
let publicReads = 0;
async function publicRead(path, label) {
  publicReads++;
  const res = await github(path);
  ok(!(res.spent && [403, 429].includes(res.status)), "GitHub's hourly allowance for reads without a credential is used up from this address. Run again once it resets.");
  eq(res.status, 200, `${label}, read from GitHub without a credential`);
  return res.body;
}

// ---- git, as a child process ----

/** A directory of this run's own, for git's home, its clones and the askpass script. Removed at the end. */
const work = mkdtempSync(join(tmpdir(), "podster-m5-"));
const askpass = join(work, "askpass.sh");
writeFileSync(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
chmodSync(askpass, 0o700);
/** Runs git with no configuration but its own, and the token, when given, in its environment only. Output comes back scrubbed. */
function git(args, { cwd = work, credential } = {}) {
  return new Promise((resolve) => {
    // No helper may keep the token, and no redirect may carry a request, and so the token, to another host.
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
/** The tip of a branch on GitHub, read with git and no credential. */
async function tipOf(branch, from = repo) {
  const listed = await mustGit(["ls-remote", from.cloneUrl, `refs/heads/${branch}`], {}, `reading ${branch}'s tip`);
  const sha = listed.stdout.split(/\s/)[0];
  ok(/^[0-9a-f]{40}$/.test(sha), `${branch} has no tip on GitHub`);
  return sha;
}
/** One more commit in a clone: a file of its own, named for nothing in Podster, since the repository is public. */
async function commitIn(dir, name, file = `${name}.txt`, content = `${name}\n`) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  await mustGit(["add", "--", file], { cwd: dir }, "git add");
  await mustGit(["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", `e2e: ${name}`], { cwd: dir }, "git commit");
  return (await mustGit(["rev-parse", "HEAD"], { cwd: dir }, "git rev-parse")).stdout.trim();
}

// ---- the run's state ----

let owner, other, coder, merger, watcher, guest;
/** The organization the owner made for this run, which the room is in and the second person joined. */
let team;
/** The second person's calls as the room's admin carry the room's organization. Their own agents stay in their own. */
const asAdmin = () => ({ org: team });
/** Grants this run gave that must not be left live: clean-up takes back whatever wasn't seen ended. */
const ledger = new GrantLedger();
let room;
/** The room's repository: GitHub's ID, its full name, its default branch and its clone URL. */
let repo;
/** Every repository that may now exist on GitHub because of this run, by full name, with why it's listed. */
const made = new Map();
function noteMade(name, why) {
  const full = `${config.org}/${name}`;
  if (!made.has(full)) say(`     a repository may now exist on GitHub: ${full} (${why})`);
  made.set(full, why);
}
/**
 * Asks for the room's repository. Any answer but a plain refusal is recorded at once, before any assertion about it,
 * so clean-up names the repository even when the request was one this run expected to be refused.
 */
async function askRepository(body, who = owner, options = undefined, inRoom = room) {
  let result;
  try {
    result = await who.dash("POST", `/v1/workspaces/${inRoom}/repository`, body, options);
  } catch (error) {
    noteMade(body.name, "a request's answer never came, so it may have been taken");
    throw error;
  }
  if (result.ok) noteMade(result.body?.request?.name ?? body.name, "a request was accepted");
  else if (result.status >= 500) noteMade(body.name, `a request answered HTTP ${result.status}, so it may have been taken`);
  return result;
}
/** Each task: its ID, where it is, the agent's token for it, and its branch, pull request and commits once they exist. */
const tasks = {};
const grants = {};
const publisher = new RoomPublisher({ putTimeoutMs: 30_000, stopWaitMs: 60_000, sleep });

const taskRead = async (who, id) => who.must("GET", `/v1/workspaces/${room}/tasks/${id}`);
const changeOf = async (id) => (await taskRead(owner, id)).change;
/** Where each grant the run gave lives, and who takes it back: the first room and its owner unless said. */
const grantHome = new Map();
/** Notes a grant the run gave, so clean-up takes it back on every way out unless the run saw it ended. Answers the grant. */
function gave(grant, what, home = undefined) {
  ledger.note(grant?.id, what);
  if (home && grant?.id) grantHome.set(grant.id, home);
  return grant;
}
/** Set while the second person is demoted in the first room, so clean-up makes them its admin again. */
let demoted = false;
/** Every merge the extended checks asked for, so clean-up names any the job hasn't ended. */
const mergesAsked = [];
/** The skips that aren't "couldn't run": a race the run lost, and one it can't tell about. Counted apart at the end. */
const unshown = { race_lost: [], cannot_tell: [], tail_lost: [] };
const give = async (principal, action, extra = {}) => gave(await owner.must("POST", `/v1/workspaces/${room}/repository/grants`, { policy_version: await owner.policyVersion(room), principal_id: principal.id, action, ...extra }), `${action} grant to ${principal.id}`);
const listedGrant = async (id) => (await owner.must("GET", `/v1/workspaces/${room}/repository/grants`)).grants.find((g) => g.id === id);
const askMerge = (agent, task) => agent.call("merge_task", { ...task.at, submission_no: 1, commit_sha: task.head, idempotency_key: key() });
/**
 * A task for the coder, accepted, made now that the repository is ready, so it's linked to it. Who reviews: the second
 * person, the room's admin, who controls neither the coder nor anything of the owner's, so the review is independent of
 * the submitter's person, as a merge needs (the owner's decision of 2026-11-11 on review A1). The merger, that person's
 * agent, merges. `reviewer: owner` is for the check that a review by the submitter's own person merges nothing.
 */
async function newTask(name, reviewer = other) {
  const task = await owner.must("POST", `/v1/workspaces/${room}/tasks`, { title: `${RUN} ${name}`, instructions: "Change the code.", acceptance_criteria: "A pull request.", assignee: coder.id, reviewer: reviewer.id }, { idempotencyKey: key() });
  const at = { workspace_id: room, task_id: task.id };
  const accepted = await coder.must("accept_task", { ...at, version: task.version });
  say(`     task ${name}: ${task.id}`);
  return (tasks[name] = { id: task.id, at, version: accepted.version });
}
/** The coder's token for a task, kept out of the output from the moment it arrives. */
async function tokenFor(task) {
  const access = await coder.must("get_repo_access", task.at, false);
  ok(typeof access?.token === "string" && access.token.length >= 20, "the answer carried no token");
  secret(access.token, "a repository token");
  task.token = access.token;
  return access;
}
/** A branch off the default branch's tip with one commit, pushed with the task's token, and a pull request for it. */
async function branchAndPullRequest(task, name) {
  const dir = join(work, name);
  await mustGit(["clone", "-q", repo.cloneUrl, dir], {}, "git clone");
  await mustGit(["checkout", "-q", "-b", `e2e/${name}`], { cwd: dir }, "git checkout");
  const head = await commitIn(dir, name);
  await mustGit(["push", "-q", "origin", `e2e/${name}`], { cwd: dir, credential: task.token }, "pushing the task's branch");
  eq(await tipOf(`e2e/${name}`), head, "the branch's tip on GitHub");
  choose("a branch name", `e2e/${name}`);
  choose("a pull request title", `e2e: ${name}`);
  const opened = await github(`/repos/${repo.full}/pulls`, { token: task.token, method: "POST", body: { title: `e2e: ${name}`, head: `e2e/${name}`, base: repo.defaultBranch } });
  eq([opened.status, opened.body?.head?.sha, opened.body?.base?.ref], [201, head, repo.defaultBranch], "opening the pull request");
  Object.assign(task, { dir, branch: `e2e/${name}`, head, pr: opened.body.number });
  return task;
}

// ---- the same steps for any room, repository and agent (the extended checks) ----

/** The second room, which the second person owns and the first has no place in; its repository; and its coding agent. */
let roomB, repoB, coderB;
/** A room that never asks for a repository. */
let plain;
/** The first room's second coding agent, for the extended checks, with a mint allowance of its own. */
let coder2;
/** The second person's calls in their own organization, where the second room is. */
const asSelf = () => ({ org: other.personalOrg });
const versionOf = async (who, inRoom, options) => (await who.must("GET", `/v1/workspaces/${inRoom}`, undefined, options)).policy_version;
/** Where work happens: `first()` is the first room with the second coder, `second()` the second room. */
const first = () => ({ room, repo, agent: coder2, maker: owner, options: undefined, tag: "a" });
const second = () => ({ room: roomB, repo: repoB, agent: coderB, maker: other, options: asSelf(), tag: "b" });
/** A task in `ctx`'s room for its agent, accepted. */
async function taskIn(ctx, name, reviewer) {
  const made = await ctx.maker.must("POST", `/v1/workspaces/${ctx.room}/tasks`, { title: `${RUN} ${name}`, instructions: "Change the code.", acceptance_criteria: "A pull request.", assignee: ctx.agent.id, ...(reviewer ? { reviewer: reviewer.id } : {}) }, { idempotencyKey: key(), ...ctx.options });
  const at = { workspace_id: ctx.room, task_id: made.id };
  const accepted = await ctx.agent.must("accept_task", { ...at, version: made.version });
  say(`     task ${name}: ${made.id}`);
  return (tasks[name] = { id: made.id, at, version: accepted.version, agent: ctx.agent });
}
/** The agent's token for a task, kept out of the output from the moment it arrives, with the expiry it disclosed. */
async function tokenIn(ctx, task) {
  const access = await ctx.agent.must("get_repo_access", task.at, false);
  ok(typeof access?.token === "string" && access.token.length >= 20, "the answer carried no token");
  secret(access.token, "a repository token");
  Object.assign(task, { token: access.token, expiresAt: access.expires_at, permissions: access.permissions });
  return access;
}
/**
 * A branch with one commit and a pull request for it, in `ctx`'s repository. The push and the pull request come with
 * `credential`: a token reaches every branch of its repository but the default one, so one live token serves many tasks.
 */
async function pullIn(ctx, task, name, { credential = task.token, file, content } = {}) {
  const dir = join(work, `${ctx.tag}-${name}`);
  const branch = `e2e/${name}`;
  await mustGit(["clone", "-q", ctx.repo.cloneUrl, dir], {}, "git clone");
  await mustGit(["checkout", "-q", "-b", branch], { cwd: dir }, "git checkout");
  const head = await commitIn(dir, name, file, content);
  await mustGit(["push", "-q", "origin", branch], { cwd: dir, credential }, "pushing the task's branch");
  eq(await tipOf(branch, ctx.repo), head, "the branch's tip on GitHub");
  choose("a branch name", branch);
  choose("a pull request title", `e2e: ${name}`);
  const opened = await github(`/repos/${ctx.repo.full}/pulls`, { token: credential, method: "POST", body: { title: `e2e: ${name}`, head: branch, base: ctx.repo.defaultBranch } });
  eq([opened.status, opened.body?.head?.sha, opened.body?.base?.ref], [201, head, ctx.repo.defaultBranch], "opening the pull request");
  Object.assign(task, { dir, branch, head, pr: opened.body.number });
  return task;
}
/** The live token the first room's second coder works with, for a task it never submits. */
const benchToken = () => have(tasks.bench?.token, tasks.bench?.spent ?? "the second coder holds no live token");
/** How near its disclosed expiry the working token is renewed: twice the five minutes inside which Podster mints anew. */
const RENEW_WITHIN_MS = 10 * 60_000;
/**
 * A token lives an hour, and a run whose waits run long can outlast it. Before each check, once the working token is
 * within ten minutes of its expiry, it's asked for again: Podster returns the same one until five minutes before, then
 * a new one. If that fails and the token has run out, the checks that need it say SKIP with this reason, not FAIL.
 */
async function keepWorkingToken() {
  const bench = tasks.bench;
  if (!bench?.token || bench.ended || !coder2 || !Number.isFinite(bench.expiresAt) || bench.expiresAt - Date.now() > RENEW_WITHIN_MS) return;
  const again = await coder2.call("get_repo_access", bench.at).catch(() => null);
  if (again?.ok && typeof again.data?.token === "string") {
    Object.assign(bench, { token: secret(again.data.token, "a repository token"), expiresAt: again.data.expires_at });
  } else if (bench.expiresAt - Date.now() < 60_000) {
    Object.assign(bench, { token: null, spent: `the working token reached its hour's expiry, and asking again was refused ${again?.code ?? "with no answer"}` });
  }
}
/** A task of the second coder's with a pull request, submitted. Reviewed by the room's admin, the second person. */
async function submittedTask(name, extra = {}) {
  const task = await taskIn(first(), name, other);
  await pullIn(first(), task, name, { credential: benchToken(), ...extra });
  await coder2.must("submit_task", { ...task.at, version: task.version, note: NOTE, commit_sha: task.head, pr_number: task.pr });
  return task;
}
/** The same, approved by the second person. */
async function approvedTask(name, extra) {
  const task = await submittedTask(name, extra);
  await other.must("POST", `/v1/workspaces/${room}/tasks/${task.id}/verify`, { submission_no: 1, commit_sha: task.head }, asAdmin());
  return task;
}
/** A pull request as GitHub shows it to the working token. */
const pullOnGithub = async (task) => (await github(`/repos/${repo.full}/pulls/${task.pr}`, { token: benchToken() })).body;
/** Waits until GitHub refuses a token, and answers how long that took beside how long the token was disclosed to live. */
async function refusedByGithub(token, expiresAt, from, label) {
  const { seconds } = await within(options.revokeWait, label, async () => (await github(`/repos/${from.full}`, { token })).status, (status) => status === 401, 5000);
  const disclosed = Number.isFinite(expiresAt) ? `${Math.max(0, Math.round((expiresAt - Date.now()) / 60_000))} more minutes` : "an unknown time";
  return `GitHub answered 401 after ${seconds} s; the token was disclosed to live ${disclosed}`;
}

// ---- GitHub's deliveries, sent by this run ----

/** One delivery to the gateway's webhook route. Only the status and the code or acceptance come back. */
async function deliver(body, { id = randomUUID(), secret, signature } = {}) {
  const res = await target.http(WEBHOOK_PATH, { method: "POST", retry: false, headers: { "content-type": "application/json", "user-agent": "e2e-check", "x-github-event": "pull_request", "x-github-delivery": id, "x-hub-signature-256": signature ?? signDelivery(secret, body) }, body });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: only the status is used.
  }
  return { id, status: res.status, code: parsed?.error?.code ?? null, accepted: parsed?.accepted ?? null };
}

// ---- the Workers' logs (M5-13) ----

/**
 * The apps whose tail holds no marker request after `seconds`, or every app if a tail has stopped. Three requests carry
 * the marker, since no one request shows in all three tails: a public page that doesn't exist, which the web app and
 * the API each log; a request straight to the gateway, which it refuses itself; and, once someone has signed in, a
 * signed-in read of a room that doesn't exist, which the gateway and the API each log. The first two carry no credential.
 */
async function markerInTails(seconds, signedIn) {
  const marker = randomBytes(16).toString("hex");
  const deadline = Date.now() + seconds * 1000;
  const get = (url) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) }).then((res) => res.arrayBuffer()).catch(() => null);
  for (;;) {
    if (tails.some(tailProblem)) return tails.map((tail) => tail.app);
    await get(`${STAGING_APP}/p/pub_${marker}`);
    await get(`${STAGING}/api/v1/workspaces/ws_${marker}`);
    if (signedIn) await owner.dash("GET", `/v1/workspaces/ws_${marker}`).catch(() => null);
    const missing = without(tails, [marker]);
    if (missing.length === 0 || Date.now() > deadline) return missing;
    await sleep(3000);
  }
}
/** Null when every tail holds a marker request of the run's own within `seconds`, or what's wrong. */
async function markerInEveryTail(seconds) {
  const missing = await markerInTails(seconds, true);
  const broken = tails.filter(tailProblem).map((tail) => `${tail.app}: ${tailProblem(tail)}`);
  if (broken.length) return broken.join(", ");
  return missing.length ? `the marker never arrived in the tail of ${missing.join(", ")} within ${seconds} s` : null;
}
/**
 * What the API's tail holds of a delivery once it holds `lines` lines for it: `{ outcomes }`, or `{ problem, lost }`
 * saying what was there instead once `stopWaiting` says to stop. A line with a missing or malformed outcome is said as
 * that. With too few lines, it says whether the tail holds the API's own requests for the delivery, and what the
 * gateway's tail says of it.
 */
async function traced(deliveryId, lines = 1) {
  const [api, gateway] = ["api", "gateway"].map((app) => tails.find((tail) => tail.app === app));
  ok(api && gateway && tally.passed("M5-13a"), "the API's and the gateway's logs aren't tailed");
  const began = Date.now();
  for (;;) {
    ok(!stopping, "the run was told to stop");
    const trace = deliveryTrace(api.stream.values, deliveryId);
    const accepted = gatewaySaid(gateway.stream.values, deliveryId).filter((outcome) => outcome === "accepted").length;
    const problem = deliveryProblem(trace, lines, accepted);
    const waited = Date.now() - began;
    if (stopWaiting(trace, problem, { waited, accepted, lines })) {
      if (!problem) return { outcomes: trace.outcomes.join(",") };
      return { problem: `for delivery ${deliveryId}, after ${trace.odd.length ? "its line arrived" : `${Math.round(waited / 1000)} s`}, ${problem.text}`, lost: problem.lost };
    }
    await sleep(2000);
  }
}
// ---- clean-up ----

let cleaned = null;
function cleanUp() {
  cleaned ??= (async () => {
    stopTails();
    const { left } = await publisher.stop();
    if (left) say(`\nA room this run made public couldn't be made private again: ${room}.`);
    // The second person is the first room's admin again, if the run stopped while it had them demoted.
    if (demoted) {
      const up = await (async () => owner.dash("POST", `/v1/workspaces/${room}/members/${other.id}/role`, { role: "admin", policy_version: await owner.policyVersion(room) }))().catch(() => null);
      say(`\nThe second person (${other?.id}) was ${up?.ok ? "made the first room's admin again" : `NOT made the first room's admin again: ${up ? `HTTP ${up.status} ${up.code ?? ""}` : "no answer"}. They're a member of ${room}`}.`);
      if (up?.ok) demoted = false;
    }
    // Every grant the run gave and didn't see ended is taken back, on every way out, so none stays live and no token
    // it backs outlives the run: taking a push grant back revokes the token held under it.
    const undone = [];
    for (const { id, what } of ledger.left()) {
      const home = grantHome.get(id) ?? { room, who: owner, options: undefined };
      const back = await (async () => home.who.dash("DELETE", `/v1/workspaces/${home.room}/repository/grants/${id}`, { policy_version: await versionOf(home.who, home.room, home.options) }, home.options))().catch(() => null);
      const gone = back?.ok && back.body?.revoked_at !== null && back.body?.revoked_at !== undefined;
      // Already ended some other way, such as its holder's removal: there's nothing left to take back.
      const ended = back?.status === 404 && back.code === "grant_not_found";
      if (gone || ended) ledger.settle(id);
      else undone.push(`the ${what} (${id}) in ${home.room}: ${back ? `HTTP ${back.status} ${back.code ?? ""}` : "no answer"}`);
    }
    if (undone.length) {
      say("\nClean-up could NOT take these grants back. The room's owner takes them back on Team:");
      for (const line of undone) say(`  - ${line}`);
    }
    // A merge still waiting for the job. Nothing takes a request back: the job ends it, and with its grant gone it
    // ends failed. Named here so nobody is surprised by a `merge.failed` after the run.
    const waiting = [];
    for (const { id, what } of mergesAsked) {
      const read = await owner.dash("GET", `/v1/workspaces/${room}/tasks/${id}`).catch(() => null);
      const state = read?.body?.change?.merge_state;
      if (!read?.ok) waiting.push(`task ${id}, ${what}: its state couldn't be read (${read ? `HTTP ${read.status}` : "no answer"})`);
      else if (!["succeeded", "failed", "not_requested"].includes(state)) waiting.push(`task ${id}, ${what}: ${state}`);
    }
    if (waiting.length) {
      say(`\nMerges this run asked for that the job hasn't ended, in ${room}. The job ends each by itself; nothing can take a request back:`);
      for (const line of waiting) say(`  - ${line}`);
    }
    for (const agent of agents) await agent.close().catch(() => null);
    for (const cookie of sessions.splice(0)) {
      await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
    }
    rmSync(work, { recursive: true, force: true });
    return left;
  })();
  return cleaned;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.error(`\nStopped by ${signal}. Waiting for the step in hand to end, then cleaning up.`);
    // The flow stops first, so nothing it was about to do, a demotion or a grant, can land after clean-up has looked.
    // A request in hand is bounded at 30 seconds; two minutes is the longest this waits before cleaning up anyway.
    stopping = true;
    Promise.race([flowDone, sleep(120_000)]).then(() => cleanUp()).finally(() => process.exit(130));
  });
}

// ---- the run ----

let stopped = null;
try {
  // The Workers' logs, for M5-13. The tails are up already. Before anyone signs up, each must hold a request of the
  // run's own, sent with no credential: a tail that is up and one that will never deliver look the same until then.
  // Without that the run stops here, having spent nothing.
  if (options.logs) {
    const missing = await markerInTails(60, false);
    if (missing.length) {
      const down = tails.filter(tailProblem).map((tail) => `${tail.app}: ${tailProblem(tail)}`);
      console.error(`\nRefused: no request of the run's own reached the log tail of ${missing.join(", ")} within 60 s${down.length ? ` (${down.join(", ")})` : ""}. Nothing but those requests was sent to staging, and no sign-up was taken. Pass --skip-logs to run without the tails.`);
      await cleanUp();
      process.exit(2);
    }
    say("     log tails: all three held a request of the run's own before the first sign-up");
  }

  say("\n## the room, and the switch");
  owner = await person("Room owner");
  // An organization of the run's own, so a second person can join it and be the room's admin: nobody is invited into a
  // personal one.
  await owner.useNewOrg(`${RUN} team`);
  team = owner.org;
  room = await owner.createRoom(`${RUN} repository`);
  say(`     room ${room}, owner ${owner.id}, organization ${team}`);
  const repositoryPath = `/v1/workspaces/${room}/repository`;
  const name = `e2e-m5-${new Date().toISOString().slice(0, 16).replace(/\D/g, "")}-${randomBytes(2).toString("hex")}`;

  {
    const read = await owner.dash("GET", repositoryPath);
    if (read.status === 404 && read.code === "not_found") {
      console.error("\nMANAGED_REPOSITORIES is off on staging: the room's repository route answers as a missing one. Nothing here can run until it's on.");
      await cleanUp();
      process.exit(3);
    }
    if (!(await check("M5-00", () => eq([read.status, read.body?.request, read.body?.repository], [200, null, null], "the room's repository read")))) throw new Stop("the room's repository can't be read");
    // Staging lets only the people its REPOSITORY_REQUESTERS names ask. The run's people are test people, which that
    // list holds by its `test-people` entry: without it nothing below can run, and nothing would reach GitHub.
    const closed = requesterProblem(owner.id, read.body?.may_request);
    if (closed) {
      console.error(`\n${closed}. Nothing here can run until it does.`);
      await cleanUp();
      process.exit(3);
    }
  }

  // A tail that can't connect fails its check, and the run goes on without it.
  await check("M5-13a", async () => {
    if (!options.logs) throw new Skip("--skip-logs was given, so no log was tailed");
    const problem = await markerInEveryTail(120);
    ok(problem === null, problem);
    return "all three were shown connected before the first sign-up, and still are. podster-scanner isn't tailed: this run sends it nothing";
  });
  choose("a repository name", name);
  // A room that never asks, and what podsterdev holds before anything is asked for: M5-01c reads both again at the end.
  let orgBefore = null;
  try {
    plain = await owner.createRoom(`${RUN} no repository`);
    orgBefore = new Set((await publicRead(`/orgs/${config.org}/repos?type=public&sort=created&direction=desc&per_page=100`, "podsterdev's repositories")).map((r) => r.id));
  } catch (error) {
    say(`     podsterdev's repositories couldn't be listed at the start, so M5-01c will be skipped: ${cause(error)}`);
  }

  say("\n## the room's admin, a second person");
  try {
    other = await person("Second person");
    const invited = await owner.must("POST", `/orgs/${team}/invitations`, { role: "member" });
    await other.must("POST", "/org-invitations/accept", { token: secret(invited.token, "an invitation token") });
    await owner.must("POST", `/v1/workspaces/${room}/members`, { principal_id: other.id, kind: "person", org_id: team, role: "admin", policy_version: await owner.policyVersion(room) });
    say(`     second person ${other.id}, a member of ${team} and an admin of the room`);
  } catch (error) {
    throw new Stop(`the room's admin couldn't be set up: ${cause(error)}`);
  }

  await check("M5-14", async () => {
    const held = await owner.dash("GET", `/v1/orgs/${team}/provisioning-delegation`);
    eq([held.status, held.body?.provider, held.body?.granted, held.body?.set_by, held.body?.set_at], [200, "github", true, null, null], "the organization's delegation, which nobody set");
    eq((await owner.must("GET", repositoryPath)).delegated, true, "what the owner is told");
    const theirs = await other.dash("GET", repositoryPath, undefined, asAdmin());
    eq([theirs.status, theirs.body?.delegated, theirs.body?.request, theirs.body?.repository], [200, true, null, null], "what the room's admin is told");
  });

  say("\n## the repository");
  await check("M5-04", async () => {
    refusedAs(await askRepository({ name, visibility: "public", organization: "another-organization" }), 400, "invalid_argument", "a request naming an organization");
    refusedAs(await askRepository({ name, visibility: "public", installation_id: 1 }), 400, "invalid_argument", "a request naming an installation");
    eq((await owner.must("GET", repositoryPath)).request, null, "what the room holds afterwards");
  });

  const ready = await check("M5-01", async () => {
    // The room's admin asks, not its owner.
    const asked = await askRepository({ name, visibility: "public" }, other, asAdmin());
    eq([asked.status, asked.body?.request?.state, asked.body?.request?.name, asked.body?.request?.visibility, asked.body?.request?.requested_by, asked.body?.repository], [200, "pending", name, "public", other.id, null], "the request as recorded");
    const { value: read, seconds } = await within(options.setupWait, "the repository's setup", () => owner.must("GET", repositoryPath), (r) => r.request?.state !== "pending");
    eq([read.request.state, read.request.reason], ["ready", null], "the request's state and reason");
    const link = read.repository;
    eq(repositoryOrgProblem(link?.full_name), null, "the organization staging linked the repository under");
    eq([link?.status, link?.provider, link?.visibility, link?.full_name], ["ready", "github", "public", `${config.org}/${name}`], "the linked repository");
    ok(Number.isInteger(link.provider_repo_id) && link.provider_repo_id > 0 && link.verified_at > 0, "the link records no repository ID from GitHub, or no read-back");
    repo = { id: link.provider_repo_id, full: link.full_name, defaultBranch: link.default_branch, cloneUrl: `https://github.com/${link.full_name}.git` };
    return `repository ${repo.id}, ${repo.full}, ready after ${seconds} s`;
  });
  if (!ready) throw new Stop("the room has no ready repository");

  await check("M5-02", async () => {
    eq((await owner.must("GET", `/v1/workspaces/${room}/visibility`)).visibility, "private", "the room's visibility");
    const seen = await publicRead(`/repos/${repo.full}`, "the repository");
    eq([seen.id, seen.private, seen.visibility, seen.owner?.login, seen.owner?.id, seen.default_branch, seen.archived], [repo.id, false, "public", config.org, config.orgId, repo.defaultBranch, false], "the repository on GitHub");
  });

  await check("M5-01b", async () => {
    const listed = await publicRead(`/repos/${repo.full}/rulesets?includes_parents=false`, "the rulesets");
    ok(Array.isArray(listed) && listed.length <= 4, `GitHub lists ${listed?.length} rulesets, not 2`);
    const rulesets = [];
    for (const { id } of listed) rulesets.push(await publicRead(`/repos/${repo.full}/rulesets/${id}`, `ruleset ${id}`));
    const { problems, bypassRead } = rulesetProblems(rulesets, config.mergeAppId);
    ok(problems.length === 0, problems.join("; "));
    return `rulesets ${rulesets.map((set) => set.id).join(" and ")}; ${bypassRead ? "their bypass lists match too" : "GitHub shows bypass lists to administrators only, so those are Podster's own read-back to check, not this one's"}`;
  });

  say("\n## a second room, whose setup GitHub refuses");
  await check("M5-03a", async () => {
    roomB = (await other.must("POST", "/v1/workspaces", { name: `${RUN} second` }, asSelf())).id;
    say(`     second room ${roomB}, in the second person's own organization ${other.personalOrg}`);
    const path = `/v1/workspaces/${roomB}/repository`;
    // The first room's repository holds this name on GitHub, so GitHub itself refuses to make another.
    const asked = await askRepository({ name, visibility: "public" }, other, asSelf(), roomB);
    eq([asked.status, asked.body?.request?.state, asked.body?.request?.name], [200, "pending", name], "the request as recorded");
    const { value: read, seconds } = await within(options.setupWait, "the second room's setup ending", () => other.must("GET", path, undefined, asSelf()), (r) => r.request?.state !== "pending");
    eq([read.request.state, read.request.reason, read.repository], ["failed", "name_taken", null], "the failed request, and the room's link");
    // A retry takes no name from anyone, and waits a minute from the failed run.
    refusedAs(await other.dash("POST", `${path}/retry`, { name: `${name}-mine` }, { ...asSelf(), timeoutMs: 30_000 }), 400, "invalid_argument", "a retry naming a repository");
    refusedAs(await other.dash("POST", `${path}/retry`, {}, { ...asSelf(), timeoutMs: 30_000 }), 429, "retry_too_soon", "a retry at once");
    const afterwards = await other.must("GET", path, undefined, asSelf());
    eq([afterwards.request?.state, afterwards.repository], ["failed", null], "the request after the refused retries");
    eq((await owner.must("GET", repositoryPath)).repository?.provider_repo_id, repo.id, "the first room's link");
    return `GitHub refused the name after ${seconds} s`;
  });

  await check("M5-15a", async () => {
    after("M5-03a");
    coderB = await agentOf(other, "second-room coder");
    await other.must("POST", `/v1/workspaces/${roomB}/members`, { principal_id: coderB.id, kind: "agent", org_id: coderB.org, role: "member", policy_version: await versionOf(other, roomB, asSelf()) }, asSelf());
    // A task made while the room has no ready repository isn't a coding task, and is worked on as any other.
    const made = await other.must("POST", `/v1/workspaces/${roomB}/tasks`, { title: `${RUN} second-plain`, instructions: "Write it.", assignee: coderB.id }, { idempotencyKey: key(), ...asSelf() });
    const at = { workspace_id: roomB, task_id: made.id };
    const accepted = await coderB.must("accept_task", { ...at, version: made.version });
    const answer = await coderB.call("get_repo_access", at);
    refusedCode(answer, "task_not_linked", "a token for a task made while setup was failed");
    tokenless(answer, "a token for a task made while setup was failed");
    await coderB.must("submit_task", { ...at, version: accepted.version, note: NOTE });
    eq((await other.must("GET", `/v1/workspaces/${roomB}/tasks/${made.id}`, undefined, asSelf())).task.status, "submitted", "the task that needs no repository");
    // The first room and its repository are as they were.
    ok(/^[0-9a-f]{40}$/.test(await tipOf(repo.defaultBranch)), "the first room's repository has no default branch on GitHub");
    eq((await owner.must("GET", repositoryPath)).repository?.status, "ready", "the first room's link");
    return `second-room coder ${coderB.id}`;
  });

  say("\n## the agents");
  try {
    coder = await agentOf(owner, "coder");
    await owner.addAgent(room, coder);
    merger = await agentOf(other, "merger");
    watcher = await agentOf(other, "watcher");
    guest = await agentOf(other, "guest");
    const asMembers = await owner.invite(room, other.org, { role: "member" });
    eq([...((await other.accept(secret(asMembers.token, "an invitation token"), other.org, [merger, watcher])).body?.agents ?? [])].sort(), [merger.id, watcher.id].sort(), "the second person's agents joining as members");
    const asGuest = await owner.invite(room, other.org);
    eq((await other.accept(secret(asGuest.token, "an invitation token"), other.org, [guest])).body?.agents, [guest.id], "the second person's guest joining");
    say(`     coder ${coder.id}; merger ${merger.id}; watcher ${watcher.id}; guest ${guest.id}`);
    await newTask("change-1");
  } catch (error) {
    throw new Stop(`the people and agents couldn't be set up: ${cause(error)}`);
  }
  const t1 = tasks["change-1"];

  say("\n## grants, and the agent's token");
  await check("M5-A1", async () => {
    const promoted = await owner.dash("POST", `/v1/workspaces/${room}/members/${coder.id}/role`, { role: "admin", policy_version: await owner.policyVersion(room) });
    refusedAs(promoted, 400, "invalid_argument", "making an agent a room admin");
    const tools = await coder.tools();
    eq(tools.filter((tool) => /repositor|grant|delegat/.test(tool) && tool !== "get_repo_access"), [], "an agent's tools for asking for a repository, granting or delegating");
  });

  await check("M5-05", async () => {
    const answer = await coder.call("get_repo_access", t1.at);
    refusedCode(answer, "grant_required", "asking with no grant");
    tokenless(answer, "asking with no grant");
  });

  await check("M5-G2", async () => {
    // The room's admin gives it, not its owner.
    const grant = await other.must("POST", `/v1/workspaces/${room}/repository/grants`, { policy_version: await owner.policyVersion(room), principal_id: coder.id, action: "push" }, asAdmin());
    gave(grant, "coder's push grant, from the room's admin");
    eq([grant.principal_id, grant.action, grant.state, grant.expires_at, grant.revoked_at, grant.delegated_by], [coder.id, "push", "live", null, null, other.id], "the grant");
    eq((await listedGrant(grant.id))?.state, "live", "the grant as listed");
    grants.push = grant.id;
    return `grant ${grant.id}`;
  });

  await check("M5-06a", async () => {
    after("M5-G2");
    const access = await tokenFor(t1);
    eq([access.repository, cloneUrlProblem(access.clone_url, repo.full), access.authority_ends_at], [repo.full, null, null], "the repository the token is for");
    eq(Object.entries(access.permissions ?? {}).sort(), [["contents", "write"], ["metadata", "read"], ["pull_requests", "write"]], "the token's permissions");
    ok(access.expires_at > Date.now() && access.expires_at <= Date.now() + 61 * 60_000, "the token doesn't expire within the hour");
    const again = await coder.must("get_repo_access", t1.at, false);
    secret(again.token, "a repository token");
    eq(digest(again.token), digest(access.token), "asking again, by the token's hash");
    return `expires ${new Date(access.expires_at).toISOString()}`;
  });

  let tipBefore;
  await check("M5-06b", async () => {
    after("M5-06a");
    tipBefore = await tipOf(repo.defaultBranch);
    await branchAndPullRequest(t1, "change-1");
    return `pull request ${t1.pr}, head ${t1.head}`;
  });

  await check("M5-06c", async () => {
    after("M5-06b");
    await mustGit(["checkout", "-q", repo.defaultBranch], { cwd: t1.dir }, "git checkout");
    await commitIn(t1.dir, "direct");
    const pushed = await git(["push", "origin", `HEAD:refs/heads/${repo.defaultBranch}`], { cwd: t1.dir, credential: t1.token });
    const said = pushed.stdout + pushed.stderr;
    // What git itself said of the refusal, already scrubbed, for when it isn't the refusal this expects.
    const lines = said.split("\n").filter((line) => /^\s*!|^remote:|^error:|^fatal:/.test(line)).slice(0, 5).join(" | ").slice(0, 500);
    ok(pushed.code !== 0, `git push to the default branch wasn't refused: git exited 0${lines ? `, saying: ${lines}` : ""}`);
    ok(said.includes("[remote rejected]"), `git push failed (exit ${pushed.code}) without GitHub's "[remote rejected]", so it isn't shown that GitHub's rules refused it. git said: ${lines || "nothing"}`);
    eq(await tipOf(repo.defaultBranch), tipBefore, "the default branch's tip");
    return `git exited ${pushed.code}; GitHub's rule code GH013 ${said.includes("GH013") ? "named" : "not named"}`;
  });

  await check("M5-06d", async () => {
    after("M5-06b");
    const call = (method, path, body) => github(`/repos/${repo.full}/${path}`, { token: t1.token, method, body });
    eq((await call("PUT", "contents/e2e-direct.txt", { message: "e2e: direct", content: Buffer.from("direct\n").toString("base64"), branch: repo.defaultBranch })).status, 409, "a commit straight to the default branch");
    eq((await call("PATCH", `git/refs/heads/${repo.defaultBranch}`, { sha: t1.head, force: true })).status, 422, "moving the default branch's ref");
    eq((await call("PUT", `pulls/${t1.pr}/merge`, { sha: t1.head, merge_method: "merge" })).status, 405, "the agent merging its own pull request");
    eq(await tipOf(repo.defaultBranch), tipBefore, "the default branch's tip");
  });

  await check("M5-06e", async () => {
    after("M5-06b");
    const call = (method, path, body) => github(`/repos/${repo.full}${path}`, { token: t1.token, method, body });
    eq((await call("POST", `/statuses/${t1.head}`, { state: "success", context: STATUS_CONTEXT })).status, 403, "setting the review status");
    eq((await call("PATCH", "", { description: "e2e" })).status, 403, "changing the repository's settings");
  });

  say("\n## the task's change");
  await check("M5-08a", async () => {
    after("M5-06b");
    await coder.must("submit_task", { ...t1.at, version: t1.version, note: NOTE, commit_sha: t1.head, pr_number: t1.pr });
    const read = await taskRead(owner, t1.id);
    eq([read.task.status, read.submissions.at(-1)?.submission_no, read.submissions.at(-1)?.commit_sha], ["submitted", 1, t1.head], "the task and its submission");
    const c = read.change;
    ok(c && typeof c === "object", "the task shows no change");
    eq(
      [c.provider_repo_id, c.pr_number, c.submission_no, c.pr_state, c.pr_draft, c.observed_head_sha, c.head_in_repository, c.base_is_default, c.reviewed_commit_sha, c.commit_changed, c.watched, c.merge_state],
      [repo.id, t1.pr, 1, "open", false, t1.head, true, true, null, false, true, "not_requested"],
      "the task's change",
    );
    ok(c.pr_observed_at > 0 && c.head_observed_at > 0, "the change carries no observation times");
  });

  await check("M5-07a", async () => {
    after("M5-08a");
    const answer = await coder.call("get_repo_access", t1.at);
    refusedCode(answer, "task_not_active", "asking again after submitting");
    tokenless(answer, "asking again after submitting");
    const { seconds } = await within(options.revokeWait, "GitHub refusing the submitted task's token", async () => (await github(`/repos/${repo.full}`, { token: t1.token })).status, (status) => status === 401, 5000);
    return `GitHub answered 401 for the old token after ${seconds} s`;
  });

  say("\n## merge");
  await check("M5-10a", async () => {
    after("M5-08a");
    grants.merge = (await give(merger, "merge")).id;
    refusedCode(await askMerge(merger, t1), "not_approved", "a merge-grant holder, before approval");
    eq((await changeOf(t1.id)).merge_state, "not_requested", "the merge's state");
  });

  let approved = false;
  await check("M5-10b", async () => {
    after("M5-08a");
    await other.must("POST", `/v1/workspaces/${room}/tasks/${t1.id}/verify`, { submission_no: 1, commit_sha: t1.head }, asAdmin());
    const read = await taskRead(owner, t1.id);
    eq([read.task.status, read.change.reviewed_commit_sha], ["completed", t1.head], "the approved task and its reviewed commit");
    approved = true;
    for (const holder of [owner, coder]) await give(holder, "merge");
    refusedAs(await owner.dash("POST", `/v1/workspaces/${room}/tasks/${t1.id}/merge`, { submission_no: 1, commit_sha: t1.head }), 403, "self_merge", "the person who controls the submitter");
    refusedCode(await askMerge(coder, t1), "self_merge", "the submitter");
    eq((await changeOf(t1.id)).merge_state, "not_requested", "the merge's state");
  });

  await check("M5-10c", async () => {
    have(approved, "the task wasn't approved");
    refusedCode(await askMerge(watcher, t1), "grant_required", "an agent another person controls, with no merge grant");
    eq((await changeOf(t1.id)).merge_state, "not_requested", "the merge's state");
  });

  await check("M5-G3", async () => {
    have(approved, "the task wasn't approved");
    // Noted as it's given, before anything is asserted about it: if the wait below runs out, clean-up takes it back,
    // so the watcher is never left holding a live merge grant.
    const grant = await give(watcher, "merge", { expires_at: Date.now() + 20_000 });
    eq([grant.state, grant.principal_id], ["live", watcher.id], "the short grant");
    // The API's own clock decides, never this machine's: merge_task is only sent once the API lists the grant as
    // expired. Sent a moment early on a skewed clock, it would be a real merge by a live grant.
    const { seconds } = await within(90, "the API listing the short grant as expired", () => listedGrant(grant.id), (listed) => listed?.state === "expired");
    // Seen expired by the API's own word: it can't merge any more, and there's nothing to take back.
    ledger.settle(grant.id);
    refusedCode(await askMerge(watcher, t1), "grant_expired", "asking on an expired grant");
    return `grant ${grant.id}, listed as expired after ${seconds} s`;
  });

  await check("M5-10d", async () => {
    after("M5-06b");
    have(approved, "the task wasn't approved");
    const c = await changeOf(t1.id);
    eq([c.merge_state, c.pr_state, c.merge_sha], ["not_requested", "open", null], "the task's change");
    eq(await tipOf(repo.defaultBranch), tipBefore, "the default branch's tip");
  });

  let merged = null;
  await check("M5-09a", async () => {
    have(grants.merge, "the merging agent holds no merge grant");
    have(approved, "the task wasn't approved");
    const asked = await merger.must("merge_task", { ...t1.at, submission_no: 1, commit_sha: t1.head });
    eq([asked.merge_state, asked.task_id, asked.commit_sha, asked.submission_no], ["requested", t1.id, t1.head, 1], "the request as recorded");
    const { value: done, seconds } = await within(options.mergeWait, "the merge", () => changeOf(t1.id), (c) => ["succeeded", "failed"].includes(c.merge_state));
    eq([done.merge_state, done.merge_reason, done.pr_state, done.merge_requested_by, done.reviewed_commit_sha], ["succeeded", null, "merged", merger.id, t1.head], "the task's change");
    ok(/^[0-9a-f]{40}$/.test(done.merge_sha ?? ""), "the change records no merge commit");
    eq((await taskRead(owner, t1.id)).task.status, "completed", "the task's status");
    merged = done;
    return `merge commit ${done.merge_sha}, after ${seconds} s`;
  });

  await check("M5-09b", async () => {
    after("M5-09a");
    const pull = await publicRead(`/repos/${repo.full}/pulls/${t1.pr}`, "the pull request");
    eq([pull.merged, pull.merge_commit_sha, pull.head?.sha, pull.base?.ref], [true, merged.merge_sha, t1.head, repo.defaultBranch], "the pull request on GitHub");
    eq(await tipOf(repo.defaultBranch), merged.merge_sha, "the default branch's tip");
    ok(isCommitSha(merged.merge_sha), "the change records no merge commit");
    const problems = mergeCommitProblems(await publicRead(`/repos/${repo.full}/commits/${merged.merge_sha}`, "the merge commit"), { tipBefore, reviewed: t1.head });
    ok(problems.length === 0, problems.join("; "));
  });

  await check("M5-09c", async () => {
    after("M5-09a");
    const problems = reviewStatusProblems(await publicRead(`/repos/${repo.full}/commits/${t1.head}/statuses`, "the reviewed commit's statuses"));
    ok(problems.length === 0, problems.join("; "));
    return `by ${MERGE_APP_SLUG}[bot]`;
  });

  await check("M5-09d", async () => {
    after("M5-09a");
    refusedCode(await askMerge(merger, t1), "already_merged", "asking again");
  });

  await check("M5-10e", async () => {
    after("M5-09a");
    // The owner, who controls the coder, reviews this one: the task's review completes as ever, and its merge is refused.
    const t4 = await newTask("change-4", owner);
    await tokenFor(t4);
    await branchAndPullRequest(t4, "change-4");
    await coder.must("submit_task", { ...t4.at, version: t4.version, note: NOTE, commit_sha: t4.head, pr_number: t4.pr });
    await owner.must("POST", `/v1/workspaces/${room}/tasks/${t4.id}/verify`, { submission_no: 1, commit_sha: t4.head });
    eq((await taskRead(owner, t4.id)).task.status, "completed", "the task reviewed by the submitter's own person");
    refusedCode(await askMerge(merger, t4), "self_review", "a merge-grant holder asking to merge it");
    eq((await changeOf(t4.id)).merge_state, "not_requested", "the merge's state");
    const pull = await publicRead(`/repos/${repo.full}/pulls/${t4.pr}`, "the pull request");
    eq([pull.merged, pull.state], [false, "open"], "the pull request on GitHub");
  });

  say("\n## a head that moves after review");
  let moved = null;
  await check("M5-11a", async () => {
    after("M5-G2");
    const t2 = await newTask("change-2");
    await tokenFor(t2);
    await branchAndPullRequest(t2, "change-2");
    await coder.must("submit_task", { ...t2.at, version: t2.version, note: NOTE, commit_sha: t2.head, pr_number: t2.pr });
    await other.must("POST", `/v1/workspaces/${room}/tasks/${t2.id}/verify`, { submission_no: 1, commit_sha: t2.head }, asAdmin());
    eq((await changeOf(t2.id)).reviewed_commit_sha, t2.head, "the reviewed commit");
    // The submitted task's token is revoked, so the push comes with the token of another task the agent still works on:
    // a token reaches every branch of the repository but the default one.
    const t3 = await newTask("change-3");
    await tokenFor(t3);
    const next = await commitIn(t2.dir, "change-2-later");
    await mustGit(["push", "-q", "origin", t2.branch], { cwd: t2.dir, credential: t3.token }, "pushing a later commit to the reviewed branch");
    const { seconds } = await within(options.observeWait, "Podster seeing the moved head", () => changeOf(t2.id), (c) => c.commit_changed === true && c.observed_head_sha === next, 3000);
    moved = { t2, next };
    return `pull request ${t2.pr}: head ${t2.head} reviewed, ${next} pushed, seen after ${seconds} s. The script can't see which brought it: a few seconds suggests the webhook, a minute or more the poll`;
  });

  await check("M5-09e", async () => {
    after("M5-11a");
    have(grants.merge, "the merging agent holds no merge grant");
    const { t2, next } = moved;
    const tip = await tipOf(repo.defaultBranch);
    refusedCode(await askMerge(merger, t2), "commit_changed", "merging the reviewed commit after the head moved");
    const c = await changeOf(t2.id);
    eq([c.merge_state, c.merge_sha, c.reviewed_commit_sha, c.commit_changed], ["not_requested", null, t2.head, true], "the task's change");
    eq((await taskRead(owner, t2.id)).task.status, "completed", "the task's status");
    const pull = await publicRead(`/repos/${repo.full}/pulls/${t2.pr}`, "the second pull request");
    eq([pull.merged, pull.state, pull.head?.sha], [false, "open", next], "the pull request on GitHub");
    eq(await tipOf(repo.defaultBranch), tip, "the default branch's tip");
  });

  say("\n## release status");
  await check("M5-12", async () => {
    after("M5-09a");
    const path = (id) => `/v1/workspaces/${room}/tasks/${id}/release-status`;
    const first = await owner.dash("GET", path(t1.id));
    if (first.status === 404 && first.code === "not_found") throw new Skip("the release-status route answers as a missing one on staging: step 8 isn't deployed");
    // The change is read on both sides of the status, and the three must agree, so a refresh in between isn't taken for a difference.
    for (const task of [t1, moved?.t2].filter(Boolean)) {
      for (let tries = 0; ; tries++) {
        const before = await changeOf(task.id);
        const status = await owner.dash("GET", path(task.id));
        const afterwards = await changeOf(task.id);
        if (JSON.stringify(before) !== JSON.stringify(afterwards) && tries < 3) continue;
        eq(status.status, 200, `release status for ${task.id}`);
        const problems = releaseStatusProblems(status.body, afterwards, task.id);
        ok(problems.length === 0, `${task.id}: ${problems.join("; ")}`);
        break;
      }
    }
    return moved ? "for the merged task and the one whose head moved" : "for the merged task only";
  });

  say("\n## who is shown a change");
  await check("M5-V1", async () => {
    after("M5-08a");
    const t3 = have(tasks["change-3"], "there's no task without a pull request to compare with");
    eq((await changeOf(t1.id))?.pr_number, t1.pr, "the owner's read of the change");
    eq((await changeOf(t3.id)) ?? null, null, "the owner's read of a task with no pull request");
    const [shown, none] = [await watcher.must("get_task", t1.at, false), await watcher.must("get_task", t3.at, false)];
    eq([shown.task?.id, shown.change, none.task?.id, none.change], [t1.id, null, t3.id, null], "what an agent that isn't a party reads");
  });

  await check("M5-V2", async () => {
    const t2 = have(tasks["change-2"]?.pr && tasks["change-2"], "there's no second task with a pull request");
    // An ID of the same shape that names no task.
    const cut = t2.id.lastIndexOf("_") + 1;
    const missing = { workspace_id: room, task_id: t2.id.slice(0, cut) + [...t2.id.slice(cut)].reverse().join("") };
    ok(missing.task_id !== t2.id, "couldn't make an ID that names no task");
    for (const [tool, args] of [["get_task", {}], ["get_repo_access", {}], ["merge_task", { submission_no: 1, commit_sha: t2.head, idempotency_key: key() }]]) {
      const [real, absent] = [await guest.call(tool, { ...t2.at, ...args }), await guest.call(tool, { ...missing, ...args })];
      refusedCode(real, "task_not_found", `the guest's ${tool} on the task`);
      refusedCode(absent, "task_not_found", `the guest's ${tool} on a task that doesn't exist`);
      tokenless(real, `the guest's ${tool}`);
    }
    refusedCode(await watcher.call("get_task", missing), "task_not_found", "a member's read of a task that doesn't exist");
  });

  say("\n## a grant taken back, and a public claimant");
  await check("M5-G4", async () => {
    after("M5-G2");
    const t3 = have(tasks["change-3"]?.token && tasks["change-3"], "no task holds a live token");
    eq((await github(`/repos/${repo.full}`, { token: t3.token })).status, 200, "the token before the grant is taken back");
    const taken = await owner.dash("DELETE", `/v1/workspaces/${room}/repository/grants/${grants.push}`, { policy_version: await owner.policyVersion(room) });
    eq([taken.status, taken.body?.state, taken.body?.revoked_at > 0], [200, "revoked", true], "taking the grant back");
    ledger.settle(grants.push);
    const answer = await coder.call("get_repo_access", t3.at);
    refusedCode(answer, "grant_required", "asking after the grant was taken back");
    tokenless(answer, "asking after the grant was taken back");
    const { seconds } = await within(options.revokeWait, "GitHub refusing the token the grant backed", async () => (await github(`/repos/${repo.full}`, { token: t3.token })).status, (status) => status === 401, 5000);
    return `GitHub answered 401 for the token after ${seconds} s`;
  });

  await check("M5-G1", async () => {
    const visibility = await owner.must("GET", `/v1/workspaces/${room}/visibility`);
    if (visibility.public_rooms_enabled !== true) throw new Skip("PUBLIC_ROOMS is off on staging, so nobody can join through a public claim");
    const claimant = await agentOf(other, "claimant");
    await other.must("PUT", `/agents/${claimant.id}/participation-policy`, { policy: "public_claims" });
    await owner.must("PUT", `/v1/workspaces/${room}/review-policy`, { require_person: true, policy_version: await owner.policyVersion(room) });
    const opening = await owner.must("POST", `/v1/workspaces/${room}/roles`, { title: "Observer", responsibilities: "Watch", preset: "public_participant", capacity: 1, publicly_claimable: true, policy_version: await owner.policyVersion(room) });
    const published = await publisher.publish(owner, room);
    ok(published.ok, `publishing the room answered ${published.status} ${published.code ?? ""}`);
    try {
      const handle = published.body.public_handle;
      await within(60, "the public room being served", () => claimant.call("get_public_workroom", { handle }), (r) => r.ok);
      const claimed = await claimant.call("claim_public_opening", { idempotency_key: randomUUID(), handle, role_id: opening.id });
      ok(claimed.ok, `the public claim answered ${claimed.code ?? "nothing"}`);
      const refused = await owner.dash("POST", `/v1/workspaces/${room}/repository/grants`, { policy_version: await owner.policyVersion(room), principal_id: claimant.id, action: "push" });
      refusedAs(refused, 400, "grantee_public", "a grant to a public-claim participant");
      eq(((await owner.must("GET", `/v1/workspaces/${room}/repository/grants`)).grants ?? []).filter((g) => g.principal_id === claimant.id), [], "the claimant's grants");
      return `claimant ${claimant.id}`;
    } finally {
      const back = await publisher.unpublish(owner, room).catch(() => null);
      if (!back?.ok) say("     the room couldn't be made private again here; clean-up tries again");
    }
  });

  // ---- the extended checks (2026-11-11): what the first three runs left unshown on staging ----
  const grantsPath = `/v1/workspaces/${room}/repository/grants`;

  say("\n## the second room's repository, by a retry");
  await check("M5-03b", async () => {
    after("M5-03a");
    const path = `/v1/workspaces/${roomB}/repository`;
    // A retry waits a minute from the failed run. Whatever is left of that is waited out here, asking every ten seconds.
    let used;
    const { value: taken, seconds } = await within(180, "the retry being taken", () => other.dash("POST", `${path}/retry`, {}, { ...asSelf(), idempotencyKey: (used = key()), timeoutMs: 30_000 }), (r) => !(r.status === 429 && r.code === "retry_too_soon"), 10_000);
    // Recorded before anything is asserted: a repository may exist from here on, under a name only the server knows.
    const placeholder = `${name}-<6 hex digits>`;
    if (taken.ok || taken.status >= 500) noteMade(placeholder, "the second room's retry was taken, under a name the server makes");
    eq([taken.status, taken.body?.request?.state, taken.body?.request?.name, taken.body?.repository ?? null], [200, "pending", name, null], "the retry as recorded");
    const again = await other.dash("POST", `${path}/retry`, {}, { ...asSelf(), idempotencyKey: used, timeoutMs: 30_000 });
    eq([again.status, JSON.stringify(again.body)], [200, JSON.stringify(taken.body)], "the same retry sent again");
    const { value: read, seconds: setup } = await within(options.setupWait, "the second repository's setup", () => other.must("GET", path, undefined, asSelf()), (r) => r.request?.state !== "pending");
    eq([read.request.state, read.request.reason], ["ready", null], "the request's state and reason");
    const link = read.repository;
    eq(repositoryOrgProblem(link?.full_name), null, "the organization the second repository is under");
    made.delete(`${config.org}/${placeholder}`);
    made.set(link.full_name, "the second room's retry made it");
    ok(new RegExp(`^${config.org}/${name}-[0-9a-f]{6}$`).test(link.full_name), `the second repository is ${link.full_name}, not the chosen name with six digits of the server's`);
    ok(Number.isInteger(link.provider_repo_id) && link.provider_repo_id > 0 && link.provider_repo_id !== repo.id, "the second room is linked to the first room's repository, or to none");
    eq([link.status, link.visibility], ["ready", "public"], "the second link");
    choose("a repository name", link.full_name.split("/")[1]);
    repoB = { id: link.provider_repo_id, full: link.full_name, defaultBranch: link.default_branch, cloneUrl: `https://github.com/${link.full_name}.git` };
    // Nothing was deleted, adopted or moved: the first repository is where it was, and the first room still holds it.
    const still = await publicRead(`/repos/${repo.full}`, "the first repository");
    eq([still.id, still.archived], [repo.id, false], "the first room's repository on GitHub");
    eq((await owner.must("GET", repositoryPath)).repository?.provider_repo_id, repo.id, "the first room's link");
    return `${repoB.full} (${repoB.id}); the retry was taken after ${seconds} s more, and set up in ${setup} s`;
  });

  say("\n## a second coder, and work in the second room");
  await check("M5-S1", async () => {
    coder2 = await agentOf(owner, "second coder");
    await owner.addAgent(room, coder2);
    const grant = await give(coder2, "push");
    eq([grant.state, grant.principal_id], ["live", coder2.id], "the second coder's push grant");
    const bench = await taskIn(first(), "bench", other);
    await tokenIn(first(), bench);
    await pullIn(first(), bench, "bench");
    return `second coder ${coder2.id}; pull request ${bench.pr}`;
  });

  await check("M5-S2", async () => {
    after("M5-03b", "M5-15a");
    const grant = await other.must("POST", `/v1/workspaces/${roomB}/repository/grants`, { policy_version: await versionOf(other, roomB, asSelf()), principal_id: coderB.id, action: "push" }, asSelf());
    gave(grant, "second-room coder's push grant", { room: roomB, who: other, options: asSelf() });
    eq([grant.state, grant.delegated_by], ["live", other.id], "the second room's push grant");
    grants.second = grant.id;
    const done = await taskIn(second(), "second-1");
    await tokenIn(second(), done);
    await pullIn(second(), done, "second-1");
    await coderB.must("submit_task", { ...done.at, version: done.version, note: NOTE, commit_sha: done.head, pr_number: done.pr });
    eq((await other.must("GET", `/v1/workspaces/${roomB}/tasks/${done.id}`, undefined, asSelf())).change?.pr_number, done.pr, "the second room's change");
    const live = await taskIn(second(), "second-2");
    await tokenIn(second(), live);
    return `grant ${grant.id}; pull request ${done.pr} in ${repoB.full}`;
  });

  say("\n## the token, again");
  await check("M5-07b", async () => {
    after("M5-S1");
    const bench = tasks.bench;
    const again = await coder2.must("get_repo_access", bench.at, false);
    secret(again.token, "a repository token");
    eq([digest(again.token), again.expires_at, JSON.stringify(again.permissions)], [digest(bench.token), bench.expiresAt, JSON.stringify(bench.permissions)], "asking again: the token by its hash, its expiry and its permissions");
    return `it still expires ${new Date(bench.expiresAt).toISOString()}`;
  });

  await check("M5-06f", async () => {
    after("M5-S1", "M5-03b");
    const bench = { ...tasks.bench, token: benchToken() };
    const tip = await tipOf(repoB.defaultBranch, repoB);
    const made = await github(`/repos/${repoB.full}/git/refs`, { token: bench.token, method: "POST", body: { ref: "refs/heads/e2e/intruder", sha: tip } });
    refusedBy(made.status, [403, 404], "creating a branch in the second room's repository");
    const pushed = await git(["push", repoB.cloneUrl, "HEAD:refs/heads/e2e/intruder"], { cwd: bench.dir, credential: bench.token });
    ok(pushed.code !== 0, "git push to the second room's repository wasn't refused: git exited 0");
    eq((await mustGit(["ls-remote", repoB.cloneUrl, "refs/heads/e2e/intruder"], {}, "reading the second repository's branches")).stdout.trim(), "", "the branch in the second room's repository");
    eq(await tipOf(repoB.defaultBranch, repoB), tip, "the second repository's default branch");
    eq((await github(`/repos/${repo.full}`, { token: bench.token })).status, 200, "the token on its own repository, afterwards");
    return `GitHub answered ${made.status} to the API call, and git exited ${pushed.code}`;
  });

  await check("M5-06g", async () => {
    after("M5-S1");
    const bench = { ...tasks.bench, token: benchToken() };
    const call = (method, path, body) => github(`/repos/${repo.full}${path}`, { token: bench.token, method, body });
    const seen = [];
    const refusedHere = (label, status, allowed) => {
      refusedBy(status, allowed, label);
      seen.push(`${label} ${status}`);
    };
    // A workflow file, through the API and through git, on a branch the token may otherwise write.
    const workflow = "on: push\njobs:\n  e2e:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n";
    const file = ".github/workflows/e2e.yml";
    refusedHere("a workflow file through the API", (await call("PUT", `/contents/${file}`, { message: "e2e: workflow", content: Buffer.from(workflow).toString("base64"), branch: bench.branch })).status, [403, 404, 422]);
    await commitIn(bench.dir, "workflow", file, workflow);
    const pushed = await git(["push", "origin", bench.branch], { cwd: bench.dir, credential: bench.token });
    await mustGit(["reset", "-q", "--hard", bench.head], { cwd: bench.dir }, "git reset");
    ok(pushed.code !== 0, "git push of a workflow file wasn't refused: git exited 0");
    seen.push(`a workflow file through git: exit ${pushed.code}`);
    eq(await tipOf(bench.branch), bench.head, "the branch's tip after both");
    eq((await call("GET", `/contents/${file}?ref=${encodeURIComponent(bench.branch)}`)).status, 404, "the workflow file on the branch");
    // A forced push that would rewind the default branch: its tip is this branch's parent, and that commit's parent is older.
    const tip = await tipOf(repo.defaultBranch);
    const older = await git(["rev-parse", "--verify", "-q", `${bench.head}~2`], { cwd: bench.dir });
    if (older.code === 0) {
      const forced = await git(["push", "--force", "origin", `${older.stdout.trim()}:refs/heads/${repo.defaultBranch}`], { cwd: bench.dir, credential: bench.token });
      ok(forced.code !== 0, "a forced git push to the default branch wasn't refused: git exited 0");
      seen.push(`a forced push rewinding the default branch: exit ${forced.code}`);
    } else seen.push("a forced push rewinding the default branch: not tried, the default branch has one commit");
    eq(await tipOf(repo.defaultBranch), tip, "the default branch's tip after the forced push");
    // The rulesets: a new one, and the two that protect the default branch.
    const before = await call("GET", "/rulesets?includes_parents=false");
    eq([before.status, before.body?.length], [200, 2], "the rulesets, read with the token");
    const ids = before.body.map((set) => set.id);
    refusedHere("a new ruleset", (await call("POST", "/rulesets", { name: "e2e", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["refs/heads/e2e/*"], exclude: [] } }, rules: [{ type: "deletion" }] })).status, [403, 404]);
    refusedHere("switching a ruleset off", (await call("PUT", `/rulesets/${ids[0]}`, { enforcement: "disabled" })).status, [403, 404]);
    refusedHere("deleting a ruleset", (await call("DELETE", `/rulesets/${ids[1]}`)).status, [403, 404]);
    const afterwards = await call("GET", "/rulesets?includes_parents=false");
    eq(JSON.stringify((afterwards.body ?? []).map((set) => [set.id, set.enforcement]).sort()), JSON.stringify(ids.map((id) => [id, "active"]).sort()), "the rulesets afterwards");
    refusedHere("Actions permissions", (await call("PUT", "/actions/permissions", { enabled: false })).status, [403, 404]);
    refusedHere("the default branch", (await call("PATCH", "", { default_branch: bench.branch })).status, [403]);
    eq((await call("GET", "")).body?.default_branch, repo.defaultBranch, "the default branch afterwards");
    // Auto-merge, which only GitHub's GraphQL API switches on. Provisioning leaves `allow_auto_merge` off, so GitHub
    // refuses this whoever asks: it's recorded, and shows nothing about what the token may do. Only an answer that
    // switched it on would be a failure.
    const node = (await call("GET", `/pulls/${bench.pr}`)).body?.node_id;
    const auto = typeof node === "string" && node ? await github("/graphql", { token: bench.token, method: "POST", body: { query: "mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }", variables: { id: node } } }) : null;
    eq((await call("GET", `/pulls/${bench.pr}`)).body?.auto_merge ?? null, null, "the pull request's auto-merge afterwards");
    seen.push(`recorded, not shown for the token: auto-merge ${auto ? `answered ${auto.status}${Array.isArray(auto.body?.errors) ? ` with ${auto.body.errors.length} error(s), ${auto.body.errors[0]?.type ?? "untyped"}` : ""}` : "not tried"}, in a repository that has it switched off for everyone`);
    return seen.join("; ");
  });

  say("\n## approval after the branch advances");
  let advance = null;
  await check("M5-08b", async () => {
    after("M5-S1");
    const task = await submittedTask("advance");
    const next = await commitIn(task.dir, "advance-later");
    await mustGit(["push", "-q", "origin", task.branch], { cwd: task.dir, credential: benchToken() }, "pushing a later commit to the submitted branch");
    await within(60, "GitHub showing the pull request's new head", async () => (await pullOnGithub(task))?.head?.sha, (sha) => sha === next, 2000);
    const verify = (sha) => other.dash("POST", `/v1/workspaces/${room}/tasks/${task.id}/verify`, { submission_no: 1, commit_sha: sha }, asAdmin());
    refusedAs(await verify(task.head), 409, "commit_changed", "approving the submitted commit after the branch advanced");
    refusedAs(await verify(next), 409, "commit_changed", "approving the new head, which no submission named");
    const read = await taskRead(owner, task.id);
    eq([read.task.status, read.change?.reviewed_commit_sha ?? null, read.change?.merge_state], ["submitted", null, "not_requested"], "the task and its change afterwards");
    // Podster's own sight of the new head, before anything later compares this change with itself: GitHub's delivery
    // for the push, or the poll, could otherwise land between two reads of a later check and look like a change.
    const { seconds } = await within(options.observeWait, "Podster seeing the pushed head", () => changeOf(task.id), (c) => c.observed_head_sha === next, 3000);
    advance = { task, next };
    return `pull request ${task.pr}: ${task.head} submitted, ${next} pushed, and seen by Podster after ${seconds} s`;
  });

  say("\n## another room's IDs");
  const secondRoomNow = async () => {
    const theirs = tasks["second-1"];
    const read = await other.must("GET", `/v1/workspaces/${roomB}/tasks/${theirs.id}`, undefined, asSelf());
    const listed = await other.must("GET", `/v1/workspaces/${roomB}/repository/grants`, undefined, asSelf());
    return JSON.stringify([listed.grants, read.task.status, read.task.version, steady(read.change)]);
  };
  let secondBefore = null;
  await check("AC-05a", async () => {
    after("M5-S1", "M5-S2");
    secondBefore = await secondRoomNow();
    const theirs = tasks["second-1"];
    const none = { grant: have(absentId(grants.second), "no grant ID that names nothing could be made"), task: have(absentId(theirs.id), "no task ID that names nothing could be made") };
    const version = await owner.policyVersion(room);
    const mine = (await owner.must("GET", grantsPath)).grants.map((g) => g.id).sort();
    const tasksPath = `/v1/workspaces/${room}/tasks`;
    const named = { submission_no: 1, commit_sha: theirs.head };
    for (const [label, call, real, absent, status, code] of [
      ["taking back a grant", (id) => owner.dash("DELETE", `${grantsPath}/${id}`, { policy_version: version }), grants.second, none.grant, 404, "grant_not_found"],
      ["reading a task", (id) => owner.dash("GET", `${tasksPath}/${id}`), theirs.id, none.task, 404, "task_not_found"],
      ["merging a task", (id) => owner.dash("POST", `${tasksPath}/${id}/merge`, named), theirs.id, none.task, 404, "task_not_found"],
      ["approving a task", (id) => owner.dash("POST", `${tasksPath}/${id}/verify`, named), theirs.id, none.task, 404, "task_not_found"],
      ["reading a task's release status", (id) => owner.dash("GET", `${tasksPath}/${id}/release-status`), theirs.id, none.task, 404, "task_not_found"],
    ]) {
      refusedAs(await call(real), status, code, `${label}, by the second room's ID`);
      refusedAs(await call(absent), status, code, `${label}, by an ID that names nothing`);
    }
    // A repository can't be named at all: the second room's ID is refused as any number is.
    for (const id of [repoB.id, 1]) refusedAs(await owner.dash("POST", grantsPath, { policy_version: version, principal_id: watcher.id, action: "push", provider_repo_id: id }), 400, "invalid_argument", `a grant naming repository ${id}`);
    eq((await owner.must("GET", grantsPath)).grants.map((g) => g.id).sort(), mine, "the first room's grants afterwards");
  });

  await check("AC-05b", async () => {
    after("AC-05a");
    const theirs = tasks["second-1"];
    const nowhere = have(absentId(roomB), "no room ID that names nothing could be made");
    const named = { submission_no: 1, commit_sha: theirs.head };
    for (const [label, call] of [
      ["reading the repository", (r) => owner.dash("GET", `/v1/workspaces/${r}/repository`)],
      ["reading the grants", (r) => owner.dash("GET", `/v1/workspaces/${r}/repository/grants`)],
      ["giving a grant", (r) => owner.dash("POST", `/v1/workspaces/${r}/repository/grants`, { policy_version: 1, principal_id: coder.id, action: "push" })],
      ["taking a grant back", (r) => owner.dash("DELETE", `/v1/workspaces/${r}/repository/grants/${grants.second}`, { policy_version: 1 })],
      ["retrying the setup", (r) => owner.dash("POST", `/v1/workspaces/${r}/repository/retry`, {}, { timeoutMs: 30_000 })],
      ["reading a task", (r) => owner.dash("GET", `/v1/workspaces/${r}/tasks/${theirs.id}`)],
      ["merging a task", (r) => owner.dash("POST", `/v1/workspaces/${r}/tasks/${theirs.id}/merge`, named)],
      ["reading a task's release status", (r) => owner.dash("GET", `/v1/workspaces/${r}/tasks/${theirs.id}/release-status`)],
    ]) {
      refusedAs(await call(roomB), 404, "workspace_not_found", `${label}, in the second room`);
      refusedAs(await call(nowhere), 404, "workspace_not_found", `${label}, in a room that doesn't exist`);
    }
  });

  await check("AC-05c", async () => {
    after("AC-05a");
    const theirs = tasks["second-1"];
    const [noTask, noRoom] = [have(absentId(theirs.id), "no task ID that names nothing could be made"), have(absentId(roomB), "no room ID that names nothing could be made")];
    for (const [tool, extra] of [["get_task", () => ({})], ["get_repo_access", () => ({})], ["get_task_release_status", () => ({})], ["merge_task", () => ({ submission_no: 1, commit_sha: theirs.head, idempotency_key: key() })]]) {
      for (const [workspace_id, task_id, code, label] of [
        [room, theirs.id, "task_not_found", "the second room's task, named in its own room"],
        [room, noTask, "task_not_found", "a task that doesn't exist"],
        [roomB, theirs.id, "workspace_not_found", "the second room's task, in the second room"],
        [noRoom, theirs.id, "workspace_not_found", "a room that doesn't exist"],
      ]) {
        const answer = await coder2.call(tool, { workspace_id, task_id, ...extra() });
        refusedCode(answer, code, `the first room's agent, ${tool} for ${label}`);
        tokenless(answer, `${tool} for ${label}`);
      }
    }
  });

  await check("AC-05d", async () => {
    after("AC-05a");
    const [bench, theirs, live] = [tasks.bench, tasks["second-1"], tasks["second-2"]];
    // A commit: the first room's agent names its own pull request with a commit only the second repository has.
    for (const [sha, label] of [[theirs.head, "a commit only the second room's repository has"], [randomBytes(20).toString("hex"), "a commit nobody has"]]) {
      refusedCode(await coder2.call("submit_task", { ...bench.at, version: bench.version, note: NOTE, commit_sha: sha, pr_number: bench.pr, idempotency_key: key() }), "commit_changed", `a submission naming ${label}`);
    }
    // A pull request number: the second room's agent names one only the first repository has.
    ok(bench.pr > theirs.pr, `the first room's pull request ${bench.pr} isn't past the second repository's only one, ${theirs.pr}, so it can't stand for a number the second lacks`);
    for (const [number, label] of [[bench.pr, "a number only the first room's repository has"], [99_999, "a number nobody has"]]) {
      refusedCode(await coderB.call("submit_task", { ...live.at, version: live.version, note: NOTE, commit_sha: bench.head, pr_number: number, idempotency_key: key() }), "pull_request_not_found", `a submission naming ${label}`);
    }
    const [mine, yours] = [await taskRead(owner, bench.id), await other.must("GET", `/v1/workspaces/${roomB}/tasks/${live.id}`, undefined, asSelf())];
    eq([mine.task.status, mine.change ?? null, yours.task.status, yours.change ?? null], ["accepted", null, "accepted", null], "both tasks afterwards");
  });

  await check("AC-05e", async () => {
    after("AC-05a");
    eq(await secondRoomNow(), secondBefore, "the second room's grants, task and change, as its owner reads them");
  });

  say("\n## deliveries");
  await check("M5-11b", async () => {
    const { task, next } = have(advance, "there's no watched change to send a delivery about");
    const before = JSON.stringify(steady(await changeOf(task.id)));
    const body = deliveryBody({ repositoryId: repo.id, number: task.pr, head: next, nonce: randomUUID() });
    const wrong = await deliver(body, { secret: randomBytes(32).toString("hex") });
    eq([wrong.status, wrong.code], [401, "invalid_signature"], "a delivery signed with a key that isn't staging's");
    const malformed = await deliver(body, { signature: "sha256=not-a-signature" });
    eq([malformed.status, malformed.code], [401, "invalid_signature"], "a delivery whose signature isn't one");
    // Both were refused at the gateway, which sends the API nothing for them, so there's nothing to wait for.
    eq(JSON.stringify(steady(await changeOf(task.id))), before, "the task's change afterwards");
  });

  /** Only the API's own log says what became of a delivery, so without a connected tail these two can't be shown. */
  const logged = () => have(options.logs && tally.passed("M5-13a"), "no log was tailed, and only the API's log says what became of a delivery");
  await check("M5-16a", async () => {
    const key = have(webhookSecret, `${WEBHOOK_SECRET_ENV} isn't set, so no delivery can be signed`);
    logged();
    const { task, next } = have(advance, "there's no watched change to send a delivery about");
    /**
     * One attempt: a new delivery, the same delivery again, and its body under a new ID. Each line is judged by itself.
     * A wrong outcome, or a request of the API's with no line, throws: that is the product's. A line the tail never
     * delivered ends the attempt and is answered as `lost`, naming which delivery it was: nothing is concluded from it.
     */
    const attempt = async () => {
      const body = deliveryBody({ repositoryId: repo.id, number: task.pr, head: next, nonce: randomUUID() });
      const judge = async (what, id, lines, wanted) => {
        const found = await traced(id, lines);
        if (found.problem && found.lost) return `${what}: ${found.problem}`;
        ok(!found.problem, `${what}: ${found.problem}`);
        eq(found.outcomes, wanted, `what the API logged for ${what}`);
        return null;
      };
      const one = await deliver(body, { secret: key });
      eq([one.status, one.accepted], [202, true], "the first delivery");
      // The API's own word that the room took it. A read of the pull request soon after proves nothing: the routine
      // poll reads it too.
      let lost = await judge("the first delivery", one.id, 1, "nudged");
      if (lost) return { lost };
      const read = await changeOf(task.id);
      const sameId = await deliver(body, { id: one.id, secret: key });
      eq([sameId.status, sameId.accepted], [202, true], "the same delivery again");
      // Each line is written once the room has answered, so by then a replay has done whatever it was going to do.
      lost = await judge("the same delivery sent again under its ID", one.id, 2, "nudged,replayed");
      if (lost) return { lost };
      const newId = await deliver(body, { secret: key });
      eq([newId.status, newId.accepted], [202, true], "its body under a new ID");
      lost = await judge("its body sent under a new ID", newId.id, 1, "replayed");
      if (lost) return { lost };
      eq(JSON.stringify(steady(await changeOf(task.id))), JSON.stringify(steady(read)), "the task's change after both");
      return {};
    };
    // Sending a lost delivery again can't show what it was: once taken, it answers `replayed`, never `nudged`. So a
    // lost line ends its attempt, and a whole new one is made, with a new body, at most once more. Only an attempt
    // whose three lines were all seen passes. Two attempts each missing a line show nothing, and say SKIP.
    const first = await attempt();
    if (!first.lost) return "the API logged nudged, then replayed twice";
    const second = await attempt();
    if (second.lost) {
      unshown.tail_lost.push("M5-16a");
      throw new Skip(`not shown by this run: the tail lost a line in each of two attempts, and nothing that did arrive contradicted. First, ${first.lost}. Then, ${second.lost}`);
    }
    return `the API logged nudged, then replayed twice, at the second attempt. The first attempt showed nothing: ${first.lost}`;
  });

  await check("M5-16b", async () => {
    const key = have(webhookSecret, `${WEBHOOK_SECRET_ENV} isn't set, so no delivery can be signed`);
    logged();
    const { task, next } = have(advance, "there's no watched change to send a delivery about");
    after("M5-S2");
    ok(task.pr !== tasks["second-1"].pr, "the first room's pull request has the number of the second room's, so the delivery would name a change there");
    const [before, theirs] = [JSON.stringify(steady(await changeOf(task.id))), await secondRoomNow()];
    // Each is judged by itself, so one run answers both. GitHub's repository 1 is nobody's room.
    const cases = [
      { what: "the delivery naming the second room's repository", repositoryId: repoB.id, wanted: "unknown_change" },
      { what: "the delivery naming a repository no room has", repositoryId: 1, wanted: "no_room" },
    ];
    const send = (repositoryId) => deliver(deliveryBody({ repositoryId, number: task.pr, head: next, nonce: randomUUID() }), { secret: key });
    for (const one of cases) one.sent = await send(one.repositoryId);
    eq(cases.flatMap((one) => [one.sent.status, one.sent.accepted]), [202, true, 202, true], "both deliveries");
    const problems = [];
    const notes = [];
    const lostTwice = [];
    for (const one of cases) {
      let found = await traced(one.sent.id);
      // Only when the tail holds nothing of it at all, not even the API's request: another is sent, once, as a new
      // delivery with a new body, and its line is the one judged. A request the tail does hold is never sent again.
      if (found.problem && found.lost) {
        const again = await send(one.repositoryId);
        eq([again.status, again.accepted], [202, true], `${one.what}, sent again`);
        notes.push(`${one.what} was sent again once: ${found.problem}`);
        found = await traced(again.id);
      }
      // Lost twice: nothing was seen of it either time. That shows nothing, and isn't the product's failure.
      if (found.problem && found.lost) lostTwice.push(`${one.what}: ${found.problem}`);
      else if (found.problem) problems.push(`${one.what}: ${found.problem}`);
      else if (found.outcomes !== one.wanted) problems.push(`${one.what}: the API logged ${found.outcomes}, not ${one.wanted}`);
    }
    ok(problems.length === 0, [...problems, ...lostTwice, ...notes].join("; "));
    if (lostTwice.length) {
      unshown.tail_lost.push("M5-16b");
      throw new Skip(`not shown by this run: the tail lost a line twice, and nothing that did arrive contradicted. ${[...lostTwice, ...notes].join("; ")}`);
    }
    eq([JSON.stringify(steady(await changeOf(task.id))), await secondRoomNow()], [before, theirs], "the first room's change, and the second room, afterwards");
    return `the API logged unknown_change for the second room's repository, and no_room for nobody's${notes.length ? `. ${notes.join("; ")}` : ""}`;
  });

  say("\n## a merge asked for before Podster sees a moved head");
  const settledMerge = async (task) => (await within(options.mergeWait, `the merge of ${task.id} ending`, () => changeOf(task.id), (c) => ["succeeded", "failed"].includes(c.merge_state))).value;
  await check("M5-09f", async () => {
    after("M5-S1");
    have(grants.merge, "the merging agent holds no merge grant");
    const task = await approvedTask("late");
    const tip = await tipOf(repo.defaultBranch);
    const next = await commitIn(task.dir, "late-later");
    // The push, and at once the request: before a delivery or a poll can have shown Podster the new head.
    await mustGit(["push", "-q", "origin", task.branch], { cwd: task.dir, credential: benchToken() }, "pushing a later commit to the reviewed branch");
    mergesAsked.push({ id: task.id, what: `the one asked for right after a push, by ${merger.id}` });
    const asked = await merger.call("merge_task", { ...task.at, submission_no: 1, commit_sha: task.head, idempotency_key: key() });
    const change = asked.ok ? await settledMerge(task) : null;
    if (change?.merge_state === "succeeded") ok(isCommitSha(change.merge_sha), "the change records no merge commit");
    const parent = change?.merge_state === "succeeded" ? (await publicRead(`/repos/${repo.full}/commits/${change.merge_sha}`, "the merge commit")).parents?.[1]?.sha : undefined;
    const ending = movedHeadEnding({ refusedCode: asked.ok ? undefined : (asked.code ?? null), change, mergedSecondParent: parent, reviewed: task.head });
    ok(!ending.problem, ending.problem);
    eq((await taskRead(owner, task.id)).task.status, "completed", "the task's status");
    if (!ending.shown) throw new Skip(`not shown by this run: ${ending.why}`);
    const { value: pull } = await within(60, "GitHub showing the pull request's new head", () => pullOnGithub(task), (p) => p?.head?.sha === next, 2000);
    eq([pull.merged, pull.state], [false, "open"], "the pull request on GitHub");
    eq(await tipOf(repo.defaultBranch), tip, "the default branch's tip");
    refusedCode(await askMerge(merger, task), "commit_changed", "asking again");
    return `pull request ${task.pr}: the request was taken, and the job ended it commit_changed`;
  });

  say("\n## five merges at once, and authority that ends while three of them wait");
  let batch = null;
  await check("M5-09g", async () => {
    after("M5-S1");
    have(grants.merge, "the merging agent holds no merge grant");
    // Two more agents of the second person's, who controls nothing the submitter's person does.
    const [second2, third] = [await agentOf(other, "merger-2"), await agentOf(other, "merger-3")];
    const invited = await owner.invite(room, other.org, { role: "member" });
    eq([...((await other.accept(secret(invited.token, "an invitation token"), other.org, [second2, third])).body?.agents ?? [])].sort(), [second2.id, third.id].sort(), "the two agents joining as members");
    // Three merge grants: the watcher's from the owner, sent with a key the run keeps; one from the room's admin; one from the owner.
    const watcherBody = { policy_version: await owner.policyVersion(room), principal_id: watcher.id, action: "merge" };
    const watcherKey = key();
    const watcherGrant = gave(await owner.must("POST", grantsPath, watcherBody, { idempotencyKey: watcherKey }), "watcher's merge grant");
    const adminGrant = gave(await other.must("POST", grantsPath, { policy_version: await owner.policyVersion(room), principal_id: second2.id, action: "merge" }, asAdmin()), "merger-2's merge grant, from the room's admin");
    const thirdGrant = await give(third, "merge");
    eq([watcherGrant.state, adminGrant.state, adminGrant.delegated_by, thirdGrant.state], ["live", "live", other.id, "live"], "the three merge grants");
    // Five approved tasks. The first two change the same file, so GitHub can't merge the second once the first has landed.
    const land = await approvedTask("land", { file: "shared.txt", content: "land\n" });
    const clash = await approvedTask("clash", { file: "shared.txt", content: "clash\n" });
    // Named as one object: a `demoted` of this block's own would hide the run's flag of that name.
    const waiting = { revoked: await approvedTask("revoked"), demoted: await approvedTask("demoted"), removed: await approvedTask("removed") };
    const tip = await tipOf(repo.defaultBranch);
    const ask = async (agent, task, label) => {
      // Noted before it's sent, so clean-up names it if the run stops while it still waits for the job.
      mergesAsked.push({ id: task.id, what: `${label} of the five, asked for by ${agent.id}` });
      eq((await agent.must("merge_task", { ...task.at, submission_no: 1, commit_sha: task.head })).merge_state, "requested", `the request for ${label}`);
    };
    // The job takes two merges a pass, oldest first, one after the other. So the last three wait behind two passes
    // that each talk to GitHub several times, and each loses its authority as soon as its request is in: about one
    // round trip later, where the two passes ahead take seconds.
    await ask(merger, land, "the first");
    await ask(merger, clash, "the second");
    await ask(watcher, waiting.revoked, "the third");
    const took = await owner.dash("DELETE", `${grantsPath}/${watcherGrant.id}`, { policy_version: await owner.policyVersion(room) });
    await ask(second2, waiting.demoted, "the fourth");
    const down = await owner.dash("POST", `/v1/workspaces/${room}/members/${other.id}/role`, { role: "member", policy_version: await owner.policyVersion(room) });
    // From here clean-up makes them the room's admin again, whatever stops the run.
    if (down.ok) demoted = true;
    await ask(third, waiting.removed, "the fifth");
    const out = await owner.dash("DELETE", `/v1/workspaces/${room}/members/${third.id}`, { policy_version: await owner.policyVersion(room) });
    // What the job had and hadn't reached once all three had lost their authority: read after the last answer.
    const then = {};
    for (const [label, task] of Object.entries({ clash, ...waiting })) then[label] = (await changeOf(task.id)).merge_state;
    // Kept from here, so whatever finishes can still be judged if one merge never ends within its wait.
    const ends = {};
    const held = Object.fromEntries(["revoked", "demoted", "removed"].map((label) => [label, then.clash === "requested" && then[label] === "requested"]));
    batch = { land, clash, ...waiting, tip, ends, lost: {}, held, then, watcherBody, watcherKey, watcherGrant, adminGrant, thirdGrant, second2, third };
    eq([took.status, took.body?.state, down.status, out.status], [200, "revoked", 200, 200], "the grant taken back, the admin demoted and the agent removed");
    const late = [];
    for (const [label, task] of Object.entries({ land, clash, ...waiting })) {
      try {
        ends[label] = await settledMerge(task);
      } catch (error) {
        late.push(`${label}: ${cause(error)}`);
      }
    }
    // When Podster recorded each authority ending, by its own clock: the room's audit log, by the grant that ended.
    // A grant is taken off clean-up's list only once the log shows it ended, never on the word of the call that should have ended it.
    const ended = new Map((await owner.audit(room)).filter((entry) => entry.action === "repo_grant.revoked").map((entry) => [entry.target_id, entry.created_at]));
    Object.assign(batch.lost, { revoked: ended.get(watcherGrant.id), demoted: ended.get(adminGrant.id), removed: ended.get(thirdGrant.id) });
    for (const id of [watcherGrant.id, adminGrant.id, thirdGrant.id]) if (ended.has(id)) ledger.settle(id);
    ok(late.length === 0, `not every merge ended within the wait: ${late.join("; ")}`);
    eq([ends.land.merge_state, ends.land.merge_reason, ends.land.pr_state, ends.land.merge_requested_by], ["succeeded", null, "merged", merger.id], "the first merge");
    ok(isCommitSha(ends.land.merge_sha), "the first merge records no merge commit");
    const problems = mergeCommitProblems(await publicRead(`/repos/${repo.full}/commits/${ends.land.merge_sha}`, "the first merge's commit"), { tipBefore: tip, reviewed: land.head });
    ok(problems.length === 0, problems.join("; "));
    return `merge commit ${ends.land.merge_sha}; the other four ended ${["clash", "revoked", "demoted", "removed"].map((label) => `${ends[label].merge_state} ${ends[label].merge_reason ?? ""}`.trim()).join(", ")}`;
  });

  await check("M5-12b", async () => {
    const b = have(batch, "the five merges weren't asked for");
    const ended = have(b.ends.clash, "the second merge didn't end within the wait");
    eq([ended.merge_state, ended.merge_reason, ended.merge_sha ?? null, ended.pr_state], ["failed", "provider_refused", null, "open"], "the change GitHub couldn't merge");
    const status = await owner.dash("GET", `/v1/workspaces/${room}/tasks/${b.clash.id}/release-status`);
    eq(status.status, 200, "its release status");
    const problems = releaseStatusProblems(status.body, await changeOf(b.clash.id), b.clash.id);
    ok(problems.length === 0, problems.join("; "));
    eq([status.body.merge.state, status.body.merge.reason, typeof status.body.merge.observed_at], ["failed", "provider_refused", "number"], "the merge as reported, with its time");
    // Whoever asked reads how it went, and is shown the merge alone.
    const theirs = await merger.must("get_task_release_status", b.clash.at, false);
    eq([theirs.merge?.state, theirs.merge?.reason, theirs.pull_request, theirs.checks], ["failed", "provider_refused", null, null], "what the agent that asked is shown");
    eq((await taskRead(owner, b.clash.id)).task.status, "completed", "the task's status");
    return `checks: ${JSON.stringify(status.body.checks?.state ?? null)}. Staging doesn't read checks (GITHUB_AGENT_APP_READS_CHECKS is unset), so a failed check can't be shown here`;
  });

  await check("AC-16", async () => {
    after("M5-03a", "M5-12b");
    const b = batch;
    have(b.ends.land, "the first merge didn't end within the wait");
    // The merge GitHub refused landed nothing: its pull request is open, and its commit isn't in the default branch.
    const pull = await pullOnGithub(b.clash);
    eq([pull?.merged, pull?.state, pull?.head?.sha], [false, "open", b.clash.head], "the refused pull request on GitHub");
    const compared = (await github(`/repos/${repo.full}/compare/${repo.defaultBranch}...${b.clash.head}`, { token: benchToken() })).body?.status;
    ok(["ahead", "diverged"].includes(compared), `GitHub says the refused commit is ${compared} of the default branch, so it's in it`);
    // What was left behind: the merge App's mark on a commit that didn't merge. The agent's token still can't merge it.
    const marks = (await publicRead(`/repos/${repo.full}/commits/${b.clash.head}/statuses`, "the refused commit's statuses")).filter((s) => s.context === STATUS_CONTEXT).map((s) => s.state);
    eq((await github(`/repos/${repo.full}/pulls/${b.clash.pr}/merge`, { token: benchToken(), method: "PUT", body: { sha: b.clash.head, merge_method: "merge" } })).status, 405, "the agent's token merging that pull request");
    eq((await pullOnGithub(b.clash))?.merged, false, "the pull request afterwards");
    return `the name GitHub refused ended name_taken (M5-03a), and the merge provider_refused; the unmerged commit carries ${marks.length ? `the mark ${marks.join(", ")}` : "no mark"}. That pull request also conflicts, so the 405 doesn't show the rules alone refusing a marked commit`;
  });

  const lostAuthority = (id, label, reason) =>
    check(id, async () => {
      const b = have(batch, "the five merges weren't asked for");
      have(b.ends[label], "this merge didn't end within the wait");
      const pull = await pullOnGithub(b[label]);
      const mergedAt = typeof pull?.merged_at === "string" ? Date.parse(pull.merged_at) : undefined;
      const ending = lostAuthorityEnding(b.ends[label], reason, { lostAt: b.lost[label], mergedAt, held: b.held[label] });
      ok(!ending.problem, ending.problem);
      eq((await taskRead(owner, b[label].id)).task.status, "completed", "the task's status");
      if (!ending.shown) {
        unshown[ending.kind].push(id);
        throw new Skip(`not shown by this run: ${ending.why}`);
      }
      eq([pull?.merged, pull?.state, pull?.head?.sha], [false, "open", b[label].head], "the pull request on GitHub");
      return `the job ended it ${reason}, and the pull request is open. When the authority ended, ${b.held[label] ? "the run saw the job hadn't reached it" : `the job was already past the merge ahead of it (${b.then.clash}), so it was a closer race`}`;
    });
  await lostAuthority("AC-13a", "revoked", "grant_required");
  await lostAuthority("AC-13b", "demoted", "grant_required");
  await lostAuthority("AC-13c", "removed", "access_revoked");

  await check("AC-13d", async () => {
    const b = have(batch, "the five merges weren't asked for");
    // The same request with the same key gets its stored answer, and gives nothing.
    const replay = await owner.dash("POST", grantsPath, b.watcherBody, { idempotencyKey: b.watcherKey });
    eq([replay.status, replay.body?.id], [200, b.watcherGrant.id], "the stored answer to the grant, sent again");
    // An admin again: what they gave before doesn't come back.
    await owner.must("POST", `/v1/workspaces/${room}/members/${other.id}/role`, { role: "admin", policy_version: await owner.policyVersion(room) });
    demoted = false;
    const listed = (await owner.must("GET", grantsPath)).grants;
    eq(listed.filter((g) => [watcher.id, b.second2.id, b.third.id].includes(g.principal_id) && g.state === "live").map((g) => g.id), [], "live grants of the three who lost theirs");
    refusedCode(await askMerge(watcher, b.revoked), "grant_required", "the agent whose grant was taken back, asking again");
    refusedCode(await askMerge(b.second2, b.demoted), "grant_required", "the agent whose grant the demoted admin gave, asking again");
  });

  say("\n## tokens whose authority ends");
  await check("M5-07f", async () => {
    after("M5-S1");
    // A third coder, so the grant that ends is its own and no other check's.
    const coder3 = await agentOf(owner, "third coder");
    await owner.addAgent(room, coder3);
    const grant = await give(coder3, "push", { expires_at: Date.now() + 30_000 });
    eq([grant.state, grant.principal_id], ["live", coder3.id], "the short push grant");
    const task = await taskIn({ ...first(), agent: coder3 }, "expiring", other);
    await tokenIn({ ...first(), agent: coder3 }, task);
    eq((await github(`/repos/${repo.full}`, { token: task.token })).status, 200, "the token while the grant is live");
    // The API's own clock decides when it has expired, never this machine's.
    const { seconds } = await within(90, "the API listing the short push grant as expired", () => listedGrant(grant.id), (listed) => listed?.state === "expired");
    ledger.settle(grant.id);
    const answer = await coder3.call("get_repo_access", task.at);
    refusedCode(answer, "grant_expired", "asking again once the grant has expired");
    tokenless(answer, "asking again once the grant has expired");
    return `listed as expired after ${seconds} s; ${await refusedByGithub(task.token, task.expiresAt, repo, "GitHub refusing the token the expired grant backed")}`;
  });

  await check("M5-07c", async () => {
    after("M5-S1");
    // A task that reads as completed now, found before any token is asked for: one that was made and never approved
    // is still the agent's to work on, and asking for its token would be given one.
    let done = null;
    for (const candidate of [tasks.land, tasks.late].filter(Boolean)) {
      if ((await taskRead(owner, candidate.id)).task.status === "completed") {
        done = candidate;
        break;
      }
    }
    have(done, "the second coder has no task that reads as completed");
    const task = await taskIn(first(), "cancel", other);
    await tokenIn(first(), task);
    eq((await github(`/repos/${repo.full}`, { token: task.token })).status, 200, "the token before the task is canceled");
    await owner.must("POST", `/v1/workspaces/${room}/tasks/${task.id}/cancel`, { version: (await taskRead(owner, task.id)).task.version, reason: "Not needed." });
    for (const [at, label] of [[task.at, "a canceled task"], [done.at, "a completed task"]]) {
      const answer = await coder2.call("get_repo_access", at);
      refusedCode(answer, "task_not_active", `asking for ${label}`);
      tokenless(answer, `asking for ${label}`);
    }
    return refusedByGithub(task.token, task.expiresAt, repo, "GitHub refusing the canceled task's token");
  });

  /** For the checks that judge nothing: runs one step and records what it answered, or that it couldn't be made. */
  const recorded = async (seen, label, step) => {
    try {
      seen.push(`${label}: ${await step()}`);
    } catch (error) {
      seen.push(`${label}: not recorded (${cause(error).slice(0, 120)})`);
    }
  };

  await check("M5-C1", async () => {
    after("M5-S1");
    const seen = [];
    const limit = async () => {
      const core = (await github("/rate_limit", { token: benchToken() })).body?.resources?.core;
      return core ? `${core.remaining} of ${core.limit} left` : "not shown";
    };
    await recorded(seen, "before", limit);
    // One read of Podster's own: a submission naming a commit nobody has makes it read the pull request, and is refused.
    await recorded(seen, "one read by Podster, through a refused submission", async () => (await coder2.call("submit_task", { ...tasks.bench.at, version: tasks.bench.version, note: NOTE, commit_sha: randomBytes(20).toString("hex"), pr_number: tasks.bench.pr, idempotency_key: key() })).code ?? "accepted");
    await recorded(seen, "after", limit);
    return `${seen.join("; ")}. Other calls of the run's and of Podster's fall between the two, so the difference is an upper bound`;
  });

  await check("M5-C8", async () => {
    after("M5-S1");
    const seen = [];
    const call = (path) => github(`/repos/${repo.full}${path}`, { token: benchToken() });
    await recorded(seen, "the repository", async () => {
      const shown = (await call("")).body ?? {};
      return ["allow_forking", "allow_auto_merge", "allow_merge_commit", "allow_squash_merge", "allow_rebase_merge", "delete_branch_on_merge", "has_issues", "has_wiki"].map((field) => `${field} ${field in shown ? JSON.stringify(shown[field]) : "not shown"}`).join(", ");
    });
    await recorded(seen, "collaborators", async () => (await call("/collaborators")).status);
    await recorded(seen, "default workflow permissions", async () => (await call("/actions/permissions/workflow")).status);
    return `${seen.join("; ")}. The organization's base permission needs an organization's credential, and isn't read`;
  });

  await check("M5-C3", async () => {
    after("M5-S1");
    const token = benchToken();
    const seen = [];
    const call = (method, path, body) => github(`/repos/${repo.full}${path}`, { token, method, body });
    // Another agent's task. Its pull request is finished with by now, and nothing after this check reads it.
    const others = tasks["change-4"]?.pr && tasks["change-4"].dir ? tasks["change-4"] : null;
    const tag = `e2e-${MARK}`;
    let [tagged, released] = [0, null];
    await recorded(seen, "create a tag", async () => (tagged = (await call("POST", "/git/refs", { ref: `refs/tags/${tag}`, sha: tasks.bench.head })).status));
    await recorded(seen, "create a release", async () => (released = await call("POST", "/releases", { tag_name: tag, name: "e2e" })).status);
    if (released?.status === 201) await recorded(seen, "delete that release", async () => (await call("DELETE", `/releases/${released.body.id}`)).status);
    if (tagged === 201 || released?.status === 201) await recorded(seen, "delete the tag", async () => (await call("DELETE", `/git/refs/tags/${tag}`)).status);
    if (others) {
      await recorded(seen, "force-push another agent's task branch", async () => {
        for (const args of [["checkout", "-q", others.branch], ["reset", "-q", "--hard", others.head], ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "--amend", "-m", "e2e: rewritten"]]) await mustGit(args, { cwd: others.dir }, "git");
        return `git exit ${(await git(["push", "--force", "origin", others.branch], { cwd: others.dir, credential: token })).code}`;
      });
      await recorded(seen, "close its pull request", async () => (await call("PATCH", `/pulls/${others.pr}`, { state: "closed" })).status);
      await recorded(seen, "delete its branch", async () => (await call("DELETE", `/git/refs/heads/${others.branch}`)).status);
    } else seen.push("another task's branch and pull request: not tried, the run has no finished task of another agent's");
    return `${seen.join("; ")}. Known gaps, recorded and not judged; uploading a release asset wasn't tried`;
  });

  await check("M5-07e", async () => {
    after("M5-S2");
    const live = tasks["second-2"];
    eq((await github(`/repos/${repoB.full}`, { token: live.token })).status, 200, "the token before the agent is disconnected");
    eq((await other.must("POST", `/agents/${coderB.id}/disconnect`, undefined, asSelf())).status, "disconnected", "the agent's connection");
    // A disconnect ends the agent's credential itself: the gateway revokes its OAuth grant and drops its link. So the
    // call is refused before any tool runs, as a transport's 401 or as an agent nobody has claimed, and which of the
    // two isn't Podster's promise. What is: no answer, and no token. The refusal is printed, scrubbed.
    const answer = await coderB.call("get_repo_access", live.at);
    ok(!answer.ok, "a disconnected agent's call was answered");
    tokenless(answer, "a disconnected agent's call");
    say(`     the disconnected agent's call was refused: ${String(answer.code ?? "with no code").slice(0, 80)}`);
    return refusedByGithub(live.token, live.expiresAt, repoB, "GitHub refusing the disconnected agent's token");
  });

  await check("M5-07d", async () => {
    after("M5-S1");
    const bench = tasks.bench;
    const held = benchToken();
    eq((await github(`/repos/${repo.full}`, { token: held })).status, 200, "the token before the agent is removed");
    // From here the working token is meant to be refused: nothing renews it.
    bench.ended = true;
    await owner.revoke(room, coder2.id);
    const answer = await coder2.call("get_repo_access", bench.at);
    refusedCode(answer, "access_revoked", "a removed agent asking again");
    tokenless(answer, "a removed agent asking again");
    return refusedByGithub(held, bench.expiresAt, repo, "GitHub refusing the removed agent's token");
  });

  say("\n## what podsterdev gained, and the logs");
  await check("M5-01c", async () => {
    after("M5-03b");
    const before = have(orgBefore, "podsterdev's repositories couldn't be listed at the start");
    const read = await owner.must("GET", `/v1/workspaces/${plain}/repository`);
    eq([read.request, read.repository], [null, null], "the room that never asked");
    const gained = (await publicRead(`/orgs/${config.org}/repos?type=public&sort=created&direction=desc&per_page=100`, "podsterdev's repositories")).filter((r) => !before.has(r.id)).map((r) => r.full_name).sort();
    eq(gained, [repo.full, repoB.full].sort(), "the repositories podsterdev gained while three rooms were made");
    return "another run, or another person asking, at the same time would fail this";
  });

  await check("M5-13", async () => {
    if (!options.logs) throw new Skip("--skip-logs was given, so no log was tailed");
    after("M5-13a");
    // Every tail must still be alive now: a closing marker has to reach each.
    const closing = await markerInEveryTail(60);
    ok(closing === null, `at the end, ${closing}`);
    await sleep(3000);
    stopTails();
    for (const tail of tails) ok(!(tail.error ?? tail.stream.error), `the ${tail.app}'s tail: ${tail.error ?? tail.stream.error}`);
    const ids = [room, roomB].filter(Boolean);
    for (const tail of tails.filter((t) => t.app !== "web")) ok(tail.stream.values.some((event) => ids.some((id) => requestHolds(event, id))), `the ${tail.app}'s tail holds none of this run's own requests`);
    const needles = [...[...kinds].map(([value, kind]) => ({ label: kind, value })), ...chosen, { label: "the run's name, which every title carries", value: RUN }, { label: "a submission's note", value: MARK }];
    // A hit is named by the Worker, the log line's own event name and the kind of string it held: never the string.
    const hits = logHits(tails.map((tail) => ({ app: tail.app, events: tail.stream.values })), needles);
    ok(hits.length === 0, `the Workers logged what they mustn't: ${hits.map((hit) => `${hit.app}, in ${hit.event}: ${hit.kind}`).join("; ")}`);
    return `${tails.map((tail) => `${tail.app} ${tail.stream.values.length} events`).join(", ")}; ${needles.filter((n) => typeof n.value === "string" && n.value.length >= 8).length} strings looked for. What this can't see: lines before a tail connected (all three were shown connected before the first sign-up, so that is only what came before the run), whether wrangler tail dropped any event by sampling under load, which nothing here can tell, and podster-scanner, which isn't tailed`;
  });
} catch (error) {
  stopped = error instanceof Stop || error instanceof Halt ? error.message : `the run broke: ${cause(error)}`;
  console.error(scrub(`\nStopped: ${stopped}`, secrets));
} finally {
  flowEnded();
}
// Stopped by a signal: its handler cleans up and exits. Nothing more is done here.
if (stopping) await new Promise(() => {});

tally.skipRest(stopped ? "not reached: the run stopped" : "not reached");
// What the room holds now, whatever the checks made of it: a retried setup would carry a name of the server's own.
if (owner && room) {
  const held = await owner.dash("GET", `/v1/workspaces/${room}/repository`).catch(() => null);
  if (held?.body?.request?.name) noteMade(held.body.request.name, "the room holds a request for it");
  const full = held?.body?.repository?.full_name;
  if (typeof full === "string" && !made.has(full)) made.set(full, "the room is linked to it");
}
if (other && roomB) {
  const held = await other.dash("GET", `/v1/workspaces/${roomB}/repository`, undefined, asSelf()).catch(() => null);
  const full = held?.body?.repository?.full_name;
  if (typeof full === "string" && !made.has(full)) made.set(full, "the second room is linked to it");
}
const left = await cleanUp();

say("\n## clean-up");
if (made.size) {
  say("This run can't delete what it made on GitHub: the product has no delete, and the script holds no credential that could.");
  say("For the owner to look for, and archive or delete, at github.com:");
  for (const [full, why] of made) say(`  - ${full} (${why})`);
} else say("No request for a repository was accepted or left unanswered, and the room holds none, so this run made none.");
say(`The rooms ${[room, roomB, plain].filter(Boolean).join(", ") || "(none)"} and their tasks stay on staging, as every run's do. ${signUpsTaken} test sign-ups were taken, and ${publicReads} reads of GitHub without a credential.`);

const failed = tally.ids("fail");
const skipped = tally.ids("skip");
if (failed.length) say(`\nFailed: ${failed.join(", ")}`);
if (skipped.length) say(`Skipped: ${skipped.join(", ")}`);
if (unshown.race_lost.length) say(`  of those, a race the run lost, with the merge landing before the authority ended: ${unshown.race_lost.join(", ")}`);
if (unshown.cannot_tell.length) say(`  of those, where it can't be told which came first: ${unshown.cannot_tell.join(", ")}`);
if (unshown.tail_lost.length) say(`  of those, where the log tail lost a line in each of two attempts: ${unshown.tail_lost.join(", ")}`);
const exitCode = stopped || left ? 1 : tally.exitCode();
say(`\nM5 on staging: ${tally.summary()}${stopped ? "; the run stopped early" : ""}${left ? "; a room was left public" : ""}. Exit ${exitCode}.`);
process.exit(exitCode);
