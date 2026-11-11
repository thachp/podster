// Checks the parts of M5's staging run that need no network: which host it accepts, its arguments, how results are
// counted into an exit code, what its `git` child can see, and how it reads GitHub's answers. Then the script itself,
// as a dry run, which sends nothing.
//
//   node m5-staging-selftest.mjs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forbidden } from "./child-env.mjs";
import { parseJsonc } from "./jsonc.mjs";
import {
  ASKPASS_SCRIPT, cloneUrlProblem, CREDENTIAL_ENV, gitEnv, mergeCommitProblems, parseArgs, PLAN, releaseStatusProblems, reviewStatusProblems, rulesetProblems, scrub,
  secretProblem, SIGN_UPS, STAGING, stagingConfig, stagingOnly, Tally,
} from "./m5-staging-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (passed, title) => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}`);
};
const throws = (run) => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};

// ---- the one host ----
check(stagingOnly(STAGING) === null && stagingOnly(`${STAGING}/`) === null, "staging's gateway is accepted, with or without a trailing slash");
for (const other of [
  "https://gateway.podster.dev", "https://podster.dev", "https://app-staging.podster.dev", "http://gateway-staging.podster.dev", "https://gateway-staging.podster.dev:8443",
  "https://gateway-staging.podster.dev.example.com", "https://example.com/gateway-staging.podster.dev", "https://user@gateway-staging.podster.dev", "https://gateway-staging.podster.dev/api",
  "https://gateway-staging.podster.dev/?x=1", "http://localhost:8787", "http://127.0.0.1:8787", "gateway-staging.podster.dev", "",
]) check(typeof stagingOnly(other) === "string", `refused: ${other || "(empty)"}`);

// ---- arguments ----
const args = (...argv) => parseArgs(argv, {});
check(args("--base-url", STAGING).options?.base === STAGING && args("--base-url", `${STAGING}/`).options?.base === STAGING, "--base-url takes staging");
check(parseArgs([], { PODSTER_E2E_BASE_URL: STAGING }).options?.base === STAGING, "PODSTER_E2E_BASE_URL is the fallback");
check(Boolean(parseArgs([], {}).error), "no base URL is refused");
check(Boolean(args("--base-url", "https://gateway.podster.dev").error) && Boolean(parseArgs([], { PODSTER_E2E_BASE_URL: "http://localhost:8787" }).error), "another host is refused, from the flag or the environment");
check(args("--base-url", STAGING).options.dryRun === false && args("--dry-run", "--base-url", STAGING).options.dryRun === true, "--dry-run is off unless given");
check(Boolean(args("--base-url", STAGING, "--force").error) && Boolean(args("--base-url").error) && Boolean(args("--base-url", "--dry-run").error), "an unknown flag and a missing value are refused");
check(args("--base-url", STAGING, "--observe-wait-s", "600").options.observeWait === 600 && args("--base-url", STAGING).options.setupWait === 240, "a wait is taken, and has a default");
for (const bad of ["5", "1801", "ten", "-30", "12.5"]) check(Boolean(args("--base-url", STAGING, "--merge-wait-s", bad).error), `a wait of ${bad} is refused`);
check(args("--help").options?.help === true, "--help needs nothing else");

// ---- configuration ----
check(secretProblem(undefined) !== null && secretProblem("short") !== null && secretProblem("x".repeat(32)) === null, "the sign-up secret must be set and at least 32 characters");
const vars = parseJsonc(readFileSync(join(here, "../apps/api/wrangler.jsonc"), "utf8")).env?.staging?.vars;
const real = stagingConfig(vars);
check(!real.error && real.org === "podsterdev" && real.orgId > 0 && real.mergeAppId > 0, "staging's own configuration names podsterdev, its ID and the merge App");
check(Boolean(stagingConfig({ ...vars, MANAGED_REPOSITORIES: "false" }).error) && Boolean(stagingConfig({}).error) && Boolean(stagingConfig({ ...vars, GITHUB_MERGE_APP_ID: "x" }).error), "a configuration with the switch off, or an ID missing, is refused");
check(SIGN_UPS.length === 3, "a run takes three sign-ups");

// ---- the plan and the results ----
const ids = PLAN.map((entry) => entry.id);
check(new Set(ids).size === ids.length && ids.every((id) => /^M5-[0-9A-Z]+[a-z]?$/.test(id)) && PLAN.every((entry) => entry.title.length > 0), "every check has one stable ID and a title");
const quiet = () => new Tally(PLAN, () => {});
{
  const tally = quiet();
  check(tally.exitCode() === 1, "a run where nothing passed doesn't exit 0");
  tally.add("M5-00", "pass");
  tally.add("M5-14", "skip", "why");
  check(tally.exitCode() === 0 && tally.summary() === "1 passed, 0 failed, 1 skipped", "passes and a skip exit 0, and the skip is counted");
  tally.add("M5-04", "fail", "why");
  check(tally.exitCode() === 1 && tally.counts().fail === 1 && tally.ids("fail").join() === "M5-04", "one failure exits 1, by its ID");
  check(throws(() => tally.add("M5-00", "pass")) && throws(() => tally.add("M5-99", "pass")) && throws(() => tally.add("M5-01", "ok")), "a second result, an unplanned ID and an unknown status are refused");
  tally.skipRest("not reached");
  check(tally.results.length === PLAN.length && tally.counts().skip === PLAN.length - 2 && tally.passed("M5-00") && !tally.passed("M5-04"), "a run that stops early lists every check");
}
{
  const lines = [];
  const tally = new Tally(PLAN, (line) => lines.push(line));
  tally.add("M5-00", "pass");
  tally.add("M5-14", "fail", "HTTP 500");
  tally.add("M5-04", "skip", "why");
  check(lines[0].startsWith("PASS M5-00") && lines[1].startsWith("FAIL M5-14") && lines[1].includes("HTTP 500") && lines[2].startsWith("SKIP M5-04"), "each result is printed as PASS, FAIL or SKIP with its ID");
}

// ---- nothing secret is printed ----
const token = `ghs_${"a1B2".repeat(9)}`;
check(scrub(`before ${token} after`, []) === "before [redacted] after" && scrub("cookie=abcdefghijklmnopqrstu", ["abcdefghijklmnopqrstu"]) === "cookie=[redacted]", "a GitHub token and a named secret are taken out of output");
check(scrub("pull request 7, head 0123abc", ["", undefined]) === "pull request 7, head 0123abc", "ordinary output is left alone");

// ---- what git gets ----
const parent = { PATH: "/usr/bin", HOME: "/home/x", PODSTER_E2E_SIGNUP_SECRET: "s", PODSTER_E2E_OPERATOR_COOKIE: "c", CLOUDFLARE_API_TOKEN: "t", GITHUB_TOKEN: "g", GH_TOKEN: "g", SSH_AUTH_SOCK: "/s", GIT_ASKPASS: "/evil" };
const plain = gitEnv({ home: "/tmp/w", askpass: "/tmp/w/askpass.sh", from: parent });
const withToken = gitEnv({ home: "/tmp/w", askpass: "/tmp/w/askpass.sh", credential: token, from: parent });
const allowed = ["PATH", "HOME", "LC_ALL", "GIT_ASKPASS", "GIT_TERMINAL_PROMPT", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"];
check(JSON.stringify(Object.keys(plain).sort()) === JSON.stringify([...allowed].sort()), "git gets the allow-listed names and its own settings, and nothing else");
check(plain.HOME === "/tmp/w" && plain.GIT_ASKPASS === "/tmp/w/askpass.sh" && plain.GIT_CONFIG_GLOBAL === "/dev/null" && plain.GIT_TERMINAL_PROMPT === "0", "its home, askpass and configuration are the run's own, not the caller's");
check(!Object.values(plain).includes(token) && !(CREDENTIAL_ENV in plain), "without a push, it gets no token");
check(JSON.stringify(Object.keys(withToken).sort()) === JSON.stringify([...allowed, CREDENTIAL_ENV].sort()) && withToken[CREDENTIAL_ENV] === token, "for a push, the token is under one name only");
check(Object.entries(withToken).filter(([, value]) => value === token).length === 1 && !Object.keys(withToken).some((n) => n !== CREDENTIAL_ENV && forbidden(n)), "and no secret of ours is beside it");
check(!ASKPASS_SCRIPT.includes("ghs_") && ASKPASS_SCRIPT.includes(`$${CREDENTIAL_ENV}`), "the askpass script holds no token, only the name it reads");
const asked = (prompt) => spawnSync("sh", ["-s", prompt], { input: ASKPASS_SCRIPT, env: { PATH: process.env.PATH, [CREDENTIAL_ENV]: token }, encoding: "utf8" }).stdout;
check(asked("Username for 'https://github.com': ") === "x-access-token\n" && asked("Password for 'https://x-access-token@github.com': ") === `${token}\n`, "it answers git's two questions");
check(cloneUrlProblem("https://github.com/podsterdev/e2e.git", "podsterdev/e2e") === null, "the repository's own clone URL is accepted");
for (const url of ["https://github.com.example.com/podsterdev/e2e.git", "http://github.com/podsterdev/e2e.git", "https://x@github.com/podsterdev/e2e.git", "https://github.com/other/e2e.git", "https://github.com/podsterdev/e2e", undefined])
  check(cloneUrlProblem(url, "podsterdev/e2e") !== null, `the token isn't offered to ${url}`);

// ---- GitHub's answers ----
const APP = 5695088;
const onDefault = { target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } } };
const review = { id: 1, ...onDefault, rules: [{ type: "pull_request", parameters: {} }, { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "podster/review", integration_id: APP }] } }] };
const update = { id: 2, ...onDefault, rules: [{ type: "update" }] };
const none = (found) => found.problems.length === 0;
check(none(rulesetProblems([review, update], APP)) && none(rulesetProblems([update, review], APP)) && rulesetProblems([review, update], APP).bypassRead === false, "ADR 0009's two rulesets match, in either order, and the bypass lists are said to be unread");
const withBypass = [{ ...review, bypass_actors: [] }, { ...update, bypass_actors: [{ actor_type: "Integration", actor_id: APP, bypass_mode: "always" }] }];
check(none(rulesetProblems(withBypass, APP)) && rulesetProblems(withBypass, APP).bypassRead === true, "with bypass lists shown, the right ones match");
const wrong = {
  "only one ruleset": [review],
  "a third ruleset": [review, update, { ...update, id: 3 }],
  "the update rule missing": [review, { ...update, rules: [{ type: "deletion" }] }],
  "one ruleset holding all three rules": [{ ...review, rules: [...review.rules, { type: "update" }] }, update],
  "a ruleset that isn't active": [review, { ...update, enforcement: "evaluate" }],
  "a ruleset on another branch": [{ ...review, conditions: { ref_name: { include: ["refs/heads/dev"], exclude: [] } } }, update],
  "a ruleset with an exclusion": [review, { ...update, conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: ["refs/heads/main"] } } }],
  "the status pinned to another App": [review, update].map((set) => JSON.parse(JSON.stringify(set).replace(String(APP), "42"))),
  "a second required status": [{ ...review, rules: [review.rules[0], { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "podster/review", integration_id: APP }, { context: "ci", integration_id: APP }] } }] }, update],
  "a bypass actor on the review ruleset": [{ ...review, bypass_actors: [{ actor_type: "Integration", actor_id: APP, bypass_mode: "always" }] }, withBypass[1]],
  "a second bypass actor on the update ruleset": [withBypass[0], { ...update, bypass_actors: [...withBypass[1].bypass_actors, { actor_type: "OrganizationAdmin", actor_id: 1, bypass_mode: "always" }] }],
  "no rulesets": [],
};
for (const [title, sets] of Object.entries(wrong)) check(!none(rulesetProblems(sets, APP)), `refused: ${title}`);

const [TIP, HEAD] = ["a".repeat(40), "b".repeat(40)];
check(mergeCommitProblems({ parents: [{ sha: TIP }, { sha: HEAD }] }, { tipBefore: TIP, reviewed: HEAD }).length === 0, "a merge commit of the old tip and the reviewed commit is accepted");
for (const [title, parents] of [["a squash or rebase, with one parent", [TIP]], ["the parents the other way round", [HEAD, TIP]], ["another commit merged", [TIP, "c".repeat(40)]], ["a third parent", [TIP, HEAD, "c".repeat(40)]], ["no parents", []]])
  check(mergeCommitProblems({ parents: parents.map((sha) => ({ sha })) }, { tipBefore: TIP, reviewed: HEAD }).length === 1, `refused: ${title}`);

const status = { context: "podster/review", state: "success", creator: { login: "podster-staging-merge[bot]", type: "Bot" } };
check(reviewStatusProblems([status, { context: "ci", state: "failure", creator: { login: "x", type: "User" } }]).length === 0, "one review status from the merge App is accepted, whatever else is there");
for (const [title, statuses] of [
  ["no review status", []], ["two review statuses", [status, status]], ["a status from another App", [{ ...status, creator: { login: "podster-staging-agent[bot]", type: "Bot" } }]],
  ["a status from a person", [{ ...status, creator: { login: "podster-staging-merge[bot]", type: "User" } }]], ["a pending status", [{ ...status, state: "pending" }]], ["an answer that isn't a list", { message: "Not Found" }],
]) check(reviewStatusProblems(statuses).length === 1, `refused: ${title}`);

const change = { pr_number: 7, pr_state: "merged", reviewed_commit_sha: HEAD, observed_head_sha: HEAD, commit_changed: false, merge_state: "succeeded", merge_reason: null, merge_sha: TIP, merge_requested_by: "agt_1" };
const release = {
  task_id: "tsk_1", linked: true, release: { exists: false },
  pull_request: { pr_number: 7, pr_state: "merged", pr_observed_at: 5, reviewed_commit_sha: HEAD, observed_head_sha: HEAD, head_observed_at: 5, commit_changed: false },
  checks: { commit_sha: null, state: null, counts: null, observed_at: null },
  merge: { state: "succeeded", reason: null, observed_at: 9, sha: TIP, requested_by: "agt_1" },
};
const wrongRelease = (edit) => releaseStatusProblems(edit(JSON.parse(JSON.stringify(release))), change, "tsk_1").length > 0;
check(releaseStatusProblems(release, change, "tsk_1").length === 0, "a release status that says what the change says is accepted, with checks unread");
check(!wrongRelease((r) => ((r.checks = { commit_sha: HEAD, state: "success", counts: { success: 1, failure: 0, pending: 0 }, observed_at: 6 }), r)), "and with checks read for the head it shows");
check(wrongRelease((r) => ((r.checks = { commit_sha: "c".repeat(40), state: "success", counts: { success: 1, failure: 0, pending: 0 }, observed_at: 6 }), r)), "refused: checks beside a head they weren't read for");
check(wrongRelease((r) => ((r.checks.state = "success"), r)), "refused: checks with no commit");
check(wrongRelease((r) => ((r.checks = null), r)), "refused: no checks for someone shown the change");
check(wrongRelease((r) => ((r.merge.state = "failed"), r)) && wrongRelease((r) => ((r.merge.sha = HEAD), r)), "refused: a merge that differs from the change");
check(wrongRelease((r) => ((r.pull_request.observed_head_sha = TIP), r)) && wrongRelease((r) => ((r.pull_request = null), r)), "refused: a pull request that differs from the change, or is missing");
check(wrongRelease((r) => ((r.release = { exists: true }), r)) && wrongRelease((r) => (delete r.release, r)), "refused: a release that exists, or none said");
check(wrongRelease((r) => ((r.task_id = "tsk_2"), r)), "refused: another task's status");

// ---- the script itself, as a dry run ----
const script = (argv, env = {}) => spawnSync(process.execPath, [join(here, "m5-staging.mjs"), ...argv], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: "utf8", timeout: 60_000 });
const secret = "s".repeat(40);
{
  const run = script(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret });
  check(run.status === 0 && run.stdout.includes("Nothing was sent") && ids.every((id) => run.stdout.includes(id)), "a dry run exits 0, names every check and says nothing was sent");
  check(run.stdout.includes("Sign-ups this run takes: 3") && !run.stdout.includes(secret) && !run.stderr.includes(secret), "it states its three sign-ups, and never the secret");
  const two = script(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret, PODSTER_E2E_OPERATOR_COOKIE: "session=abc" });
  check(two.status === 0 && two.stdout.includes("Sign-ups this run takes: 2") && !two.stdout.includes("session=abc"), "with an operator's session it takes two, and never prints the session");
}
check(script(["--base-url", STAGING, "--dry-run"]).status === 2, "a dry run without the sign-up secret exits 2");
for (const base of ["https://gateway.podster.dev", "http://localhost:8787", "https://gateway-staging.podster.dev.example.com"]) {
  const run = script(["--base-url", base], { PODSTER_E2E_SIGNUP_SECRET: secret });
  check(run.status === 2 && run.stderr.includes("Only https://gateway-staging.podster.dev"), `the script refuses ${base} before anything else`);
}
check(script(["--base-url", STAGING, "--yes"], { PODSTER_E2E_SIGNUP_SECRET: secret }).status === 2, "the script refuses an unknown flag");

console.log(failed ? `\n${failed} failed` : "\nM5 staging self-test: all passed");
process.exit(failed ? 1 : 0);
