// M5's staging run (step 10 of docs/m5-plan.md): managed repositories end to end, against staging and the real GitHub
// organization staging is configured for, `podsterdev`. A room's owner asks for a repository, an agent pushes a branch
// and opens a pull request with its short-lived token, the task is reviewed, and merge_task merges the reviewed commit.
// Around that, each refusal with its one exact answer.
//
//   node m5-staging.mjs --base-url https://gateway-staging.podster.dev [--dry-run]
//
// Staging's gateway is the only base URL it accepts. There is no local rehearsal of this script: locally GitHub is a
// fake, and merge-check.mjs and repo-access-check.mjs are the rehearsals against it.
//
// People: three takes of staging's test sign-up, of its 6 a minute and 40 a day: the room's owner, a second person, and
// the fixed test operator M4's run uses, who gives the owner's organization the provisioning delegation and must be
// named in the API's OPERATORS. With PODSTER_E2E_OPERATOR_COOKIE set to an operator's session, that one is used instead
// and the run takes two. Agents are made under these people and take none. Every test session is signed out at the end.
//
// GitHub: Podster's own calls go out from staging. This script also asks GitHub directly, three ways. Without a
// credential, about ten reads of the public API, to see what anyone sees: the repository, its rulesets, the merge commit
// and the status on the reviewed commit. With the agent's token from get_repo_access, to open a pull request and to try
// what must be refused. And through `git`, to push. `git` is a child process with child-env.mjs's allow-listed
// environment, a home directory of its own, and the token under one name in its environment: the token is never printed,
// never on a command line and never written to a file. No App key is read or used here.
//
// Every assertion wants one exact answer: a status and a code from a person's call, and a code from an agent's, since
// MCP carries no HTTP status. A check that can't run says SKIP and why. Exit codes: 0 when nothing failed, 1 when a check
// failed or nothing passed, 2 for a refused configuration, 3 when managed repositories are off on staging.
//
// Clean-up: the product has no way to delete a repository, and this script holds no credential that could. It prints
// the repositories it made, for the owner to archive or delete in GitHub. The room, its tasks and its people stay, as
// every staging run's do.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.mjs";
import {
  ASKPASS_SCRIPT, cloneUrlProblem, gitEnv, MERGE_APP_SLUG, mergeCommitProblems, parseArgs, PLAN, releaseStatusProblems, reviewStatusProblems, rulesetProblems,
  scrub, secretProblem, SIGN_UPS, STAGING, stagingConfig, STATUS_CONTEXT, Tally, USAGE,
} from "./m5-staging-lib.mjs";
import { RoomPublisher } from "./room-publisher.mjs";

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
const operatorCookie = process.env.PODSTER_E2E_OPERATOR_COOKIE;
const config = stagingConfig(parseJsonc(readFileSync(join(here, "../apps/api/wrangler.jsonc"), "utf8")).env?.staging?.vars);
const signUpsNeeded = operatorCookie ? SIGN_UPS.slice(0, 2) : SIGN_UPS;

// ---- the plan, and the configuration, before anything is sent ----

{
  const gitFound = spawnSync("git", ["--version"], { env: gitEnv({ home: tmpdir(), askpass: "/usr/bin/false" }), stdio: "ignore" }).status === 0;
  const problems = [secretProblem(signupSecret), config.error, gitFound ? null : "git isn't on the PATH"].filter(Boolean);
  console.log(`M5's staging run, against ${STAGING}${options.dryRun ? " (dry run: nothing is sent)" : ""}`);
  console.log(`\nSign-ups this run takes: ${signUpsNeeded.length}, of the test sign-up's 6 a minute and 40 a day.`);
  for (const { who, why } of signUpsNeeded) console.log(`  - ${who}: ${why}`);
  if (operatorCookie) console.log("  The operator is the session in PODSTER_E2E_OPERATOR_COOKIE, which takes no sign-up and isn't signed out.");
  if (!config.error) console.log(`\nGitHub: repositories are made in ${config.org} (${config.orgId}); the merge App is ${MERGE_APP_SLUG} (${config.mergeAppId}).`);
  console.log(`Waits, in seconds: setup ${options.setupWait}, merge ${options.mergeWait}, a moved head ${options.observeWait}, revocation ${options.revokeWait}.`);
  if (options.dryRun) {
    console.log(`\nThe ${PLAN.length} checks, in order:`);
    for (const { id, title } of PLAN) console.log(`  ${id.padEnd(7)} ${title}`);
    console.log("\nClean-up: it can't delete the repository it makes. It prints the name, for the owner to archive or delete in GitHub.");
  }
  for (const problem of problems) console.error(`\nRefused: ${problem}.`);
  if (problems.length) process.exit(2);
  if (options.dryRun) {
    console.log("\nThe configuration is complete. Nothing was sent.");
    process.exit(0);
  }
}

// The clients come with the e2e packages, which a dry run doesn't need.
const { eq, key, McpAgent, ok, Person, sleep, Target } = await import("./lib.mjs");

const POLL_MS = 2000;
const target = new Target(STAGING, { pollMs: POLL_MS });
const RUN = `M5 staging ${new Date().toISOString().slice(0, 16)}`;
/** Nothing here may reach the output: the sign-up secret, every session and every repository token. */
const secrets = [signupSecret, operatorCookie].filter(Boolean);
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
async function check(id, run) {
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
const tokenless = (result, label) => ok(!/gh[a-z]_/.test(JSON.stringify(result ?? null)) && !JSON.stringify(result ?? null).includes('"token"'), `${label}: the answer carried a token`);
/** Polls `read` every `stepMs` until `done` accepts its answer, for at most `seconds`. Answers the value and how long it took. */
async function within(seconds, label, read, done, stepMs = POLL_MS) {
  const start = Date.now();
  for (;;) {
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
  secrets.push(cookie, ...cookie.split("; ").map((part) => part.slice(part.indexOf("=") + 1)).filter((value) => value.length >= 16));
  sessions.push(cookie);
  return cookie;
}
const person = async (label) => Person.fromCookie(target, label, await signUpCookie(label));
/** An operator: the session given, or staging's one fixed test operator, the same person every run. */
const operatorPerson = async () => Person.fromCookie(target, "Operator", operatorCookie ?? (await signUpCookie("the test operator", { stable: "operator" })));
async function agentOf(owner, label) {
  const agent = await McpAgent.connect(target, owner, `${RUN} ${label}`);
  agents.push(agent);
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
    const child = spawn("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv({ home: work, askpass, credential }), stdio: ["ignore", "pipe", "pipe"] });
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
async function tipOf(branch) {
  const listed = await mustGit(["ls-remote", repo.cloneUrl, `refs/heads/${branch}`], {}, `reading ${branch}'s tip`);
  const sha = listed.stdout.split(/\s/)[0];
  ok(/^[0-9a-f]{40}$/.test(sha), `${branch} has no tip on GitHub`);
  return sha;
}
/** One more commit in a clone: a file of its own, named for nothing in Podster, since the repository is public. */
async function commitIn(dir, name) {
  writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
  await mustGit(["add", "--", `${name}.txt`], { cwd: dir }, "git add");
  await mustGit(["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", `e2e: ${name}`], { cwd: dir }, "git commit");
  return (await mustGit(["rev-parse", "HEAD"], { cwd: dir }, "git rev-parse")).stdout.trim();
}

// ---- the run's state ----

let owner, other, operator, coder, merger, watcher, guest;
/** Whether this run gave the owner's organization the delegation, which clean-up takes back. */
let delegated = false;
let room;
/** The room's repository: GitHub's ID, its full name, its default branch and its clone URL. */
let repo;
const made = [];
/** Each task: its ID, where it is, the agent's token for it, and its branch, pull request and commits once they exist. */
const tasks = {};
const grants = {};
const publisher = new RoomPublisher({ putTimeoutMs: 30_000, stopWaitMs: 60_000, sleep });

const taskRead = async (who, id) => who.must("GET", `/v1/workspaces/${room}/tasks/${id}`);
const changeOf = async (id) => (await taskRead(owner, id)).change;
const give = async (principal, action, extra = {}) => owner.must("POST", `/v1/workspaces/${room}/repository/grants`, { policy_version: await owner.policyVersion(room), principal_id: principal.id, action, ...extra });
const listedGrant = async (id) => (await owner.must("GET", `/v1/workspaces/${room}/repository/grants`)).grants.find((g) => g.id === id);
const askMerge = (agent, task) => agent.call("merge_task", { ...task.at, submission_no: 1, commit_sha: task.head, idempotency_key: key() });
/** A task for the coder, accepted, made now that the repository is ready, so it's linked to it. */
async function newTask(name) {
  const task = await owner.must("POST", `/v1/workspaces/${room}/tasks`, { title: `${RUN} ${name}`, instructions: "Change the code.", acceptance_criteria: "A pull request.", assignee: coder.id, reviewer: owner.id }, { idempotencyKey: key() });
  const at = { workspace_id: room, task_id: task.id };
  const accepted = await coder.must("accept_task", { ...at, version: task.version });
  say(`     task ${name}: ${task.id}`);
  return (tasks[name] = { id: task.id, at, version: accepted.version });
}
/** The coder's token for a task, kept out of the output from the moment it arrives. */
async function tokenFor(task) {
  const access = await coder.must("get_repo_access", task.at, false);
  ok(typeof access?.token === "string" && access.token.length >= 20, "the answer carried no token");
  secrets.push(access.token);
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
  const opened = await github(`/repos/${repo.full}/pulls`, { token: task.token, method: "POST", body: { title: `e2e: ${name}`, head: `e2e/${name}`, base: repo.defaultBranch } });
  eq([opened.status, opened.body?.head?.sha, opened.body?.base?.ref], [201, head, repo.defaultBranch], "opening the pull request");
  Object.assign(task, { dir, branch: `e2e/${name}`, head, pr: opened.body.number });
  return task;
}

// ---- clean-up ----

let cleaned = null;
function cleanUp() {
  cleaned ??= (async () => {
    const { left } = await publisher.stop();
    if (left) say(`\nA room this run made public couldn't be made private again: ${room}.`);
    // The test organization keeps nothing it no longer needs. A linked repository isn't touched by this.
    if (delegated) {
      const back = await operator.dash("PUT", `/v1/orgs/${owner.org}/provisioning-delegation`, { granted: false }).catch(() => null);
      say(`\nThe delegation was ${back?.ok && back.body?.granted === false ? "taken back from" : "NOT taken back from"} ${owner.org}.`);
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
    console.error(`\nStopped by ${signal}.`);
    cleanUp().finally(() => process.exit(130));
  });
}

// ---- the run ----

let stopped = null;
try {
  say("\n## the room, and the switch");
  owner = await person("Room owner");
  room = await owner.createRoom(`${RUN} repository`);
  say(`     room ${room}, owner ${owner.id}, organization ${owner.org}`);
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
  }

  await check("M5-14", async () => {
    refusedAs(await owner.dash("POST", repositoryPath, { name, visibility: "public" }), 403, "not_delegated", "asking without the delegation");
    const read = await owner.must("GET", repositoryPath);
    eq([read.request, read.repository], [null, null], "what the room holds afterwards");
  });

  say("\n## the delegation, from an operator");
  {
    operator = await operatorPerson();
    const set = await operator.dash("PUT", `/v1/orgs/${owner.org}/provisioning-delegation`, { granted: true });
    say(`     operator ${operator.id}: HTTP ${set.status} ${set.code ?? ""}`);
    if (set.status === 403) throw new Stop(`${operator.id} isn't an operator on staging. The owner names it in the API's OPERATORS (docs/staging.md), or the run is given an operator's session in PODSTER_E2E_OPERATOR_COOKIE.`);
    if (!(set.status === 200 && set.body?.granted === true)) throw new Stop(`the delegation couldn't be given: HTTP ${set.status} ${set.code ?? ""}`);
    delegated = true;
  }

  say("\n## the repository");
  await check("M5-04", async () => {
    refusedAs(await owner.dash("POST", repositoryPath, { name, visibility: "public", organization: "another-organization" }), 400, "invalid_argument", "a request naming an organization");
    refusedAs(await owner.dash("POST", repositoryPath, { name, visibility: "public", installation_id: 1 }), 400, "invalid_argument", "a request naming an installation");
    eq((await owner.must("GET", repositoryPath)).request, null, "what the room holds afterwards");
  });

  const ready = await check("M5-01", async () => {
    const asked = await owner.dash("POST", repositoryPath, { name, visibility: "public" });
    eq([asked.status, asked.body?.request?.state, asked.body?.request?.name, asked.body?.request?.visibility, asked.body?.repository], [200, "pending", name, "public", null], "the request as recorded");
    made.push(`${config.org}/${name}`);
    const { value: read, seconds } = await within(options.setupWait, "the repository's setup", () => owner.must("GET", repositoryPath), (r) => r.request?.state !== "pending");
    eq([read.request.state, read.request.reason], ["ready", null], "the request's state and reason");
    const link = read.repository;
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

  say("\n## the second person, and the agents");
  try {
    other = await person("Second person");
    coder = await agentOf(owner, "coder");
    await owner.addAgent(room, coder);
    merger = await agentOf(other, "merger");
    watcher = await agentOf(other, "watcher");
    guest = await agentOf(other, "guest");
    const asMembers = await owner.invite(room, other.org, { role: "member" });
    eq([...((await other.accept(asMembers.token, other.org, [merger, watcher])).body?.agents ?? [])].sort(), [merger.id, watcher.id].sort(), "the second person's agents joining as members");
    const asGuest = await owner.invite(room, other.org);
    eq((await other.accept(asGuest.token, other.org, [guest])).body?.agents, [guest.id], "the second person's guest joining");
    say(`     second person ${other.id}; coder ${coder.id}; merger ${merger.id}; watcher ${watcher.id}; guest ${guest.id}`);
    await newTask("change-1");
  } catch (error) {
    throw new Stop(`the people and agents couldn't be set up: ${cause(error)}`);
  }
  const t1 = tasks["change-1"];

  say("\n## grants, and the agent's token");
  await check("M5-05", async () => {
    const answer = await coder.call("get_repo_access", t1.at);
    refusedCode(answer, "grant_required", "asking with no grant");
    tokenless(answer, "asking with no grant");
  });

  await check("M5-G2", async () => {
    const grant = await give(coder, "push");
    eq([grant.principal_id, grant.action, grant.state, grant.expires_at, grant.revoked_at, grant.delegated_by], [coder.id, "push", "live", null, null, owner.id], "the grant");
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
    secrets.push(again.token);
    const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
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
    eq([pushed.code !== 0, said.includes("[remote rejected]")], [true, true], "git push to the default branch was refused by GitHub itself");
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
    await coder.must("submit_task", { ...t1.at, version: t1.version, note: "Ready for review.", commit_sha: t1.head, pr_number: t1.pr });
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
    await owner.must("POST", `/v1/workspaces/${room}/tasks/${t1.id}/verify`, { submission_no: 1, commit_sha: t1.head });
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
    const grant = await give(watcher, "merge", { expires_at: Date.now() + 20_000 });
    eq([grant.state, grant.principal_id], ["live", watcher.id], "the short grant");
    // Until two seconds past its expiry, a poll interval at a time.
    while (Date.now() < grant.expires_at + 2000) await sleep(Math.min(POLL_MS, grant.expires_at + 2000 - Date.now()));
    refusedCode(await askMerge(watcher, t1), "grant_expired", "asking on an expired grant");
    eq((await listedGrant(grant.id))?.state, "expired", "the grant as listed");
    return `grant ${grant.id}`;
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

  say("\n## a head that moves after review");
  let moved = null;
  await check("M5-11a", async () => {
    after("M5-G2");
    const t2 = await newTask("change-2");
    await tokenFor(t2);
    await branchAndPullRequest(t2, "change-2");
    await coder.must("submit_task", { ...t2.at, version: t2.version, note: "Ready for review.", commit_sha: t2.head, pr_number: t2.pr });
    await owner.must("POST", `/v1/workspaces/${room}/tasks/${t2.id}/verify`, { submission_no: 1, commit_sha: t2.head });
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
} catch (error) {
  stopped = error instanceof Stop ? error.message : `the run broke: ${cause(error)}`;
  console.error(scrub(`\nStopped: ${stopped}`, secrets));
}

tally.skipRest(stopped ? "not reached: the run stopped" : "not reached");
const left = await cleanUp();

say("\n## clean-up");
if (made.length) {
  say("This run can't delete what it made on GitHub: the product has no delete, and the script holds no credential that could.");
  say("For the owner to archive or delete, at github.com:");
  for (const full of made) say(`  - ${full}`);
} else say("No repository was asked for.");
say(`The room ${room ?? "(none)"} and its tasks stay on staging, as every run's do. ${signUpsTaken} test sign-ups were taken, and ${publicReads} reads of GitHub without a credential.`);

const failed = tally.ids("fail");
const skipped = tally.ids("skip");
if (failed.length) say(`\nFailed: ${failed.join(", ")}`);
if (skipped.length) say(`Skipped: ${skipped.join(", ")}`);
const exitCode = stopped || left ? 1 : tally.exitCode();
say(`\nM5 on staging: ${tally.summary()}${stopped ? "; the run stopped early" : ""}${left ? "; a room was left public" : ""}. Exit ${exitCode}.`);
process.exit(exitCode);
