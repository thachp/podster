// Checks the parts of M5's staging run that need no network: which host it accepts, its arguments, how results are
// counted into an exit code, what its `git` child can see, and how it reads GitHub's answers. Then the script itself,
// as a dry run, which sends nothing.
//
//   node m5-staging-selftest.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { childEnv, forbidden } from "./child-env.mjs";
import { parseJsonc } from "./jsonc.mjs";
import { missingWranglers } from "./m4-staging-lib.mjs";
import {
  absentId, ASKPASS_SCRIPT, cloneUrlProblem, CREDENTIAL_ENV, deliveryBody, deliveryOutcomes, GrantLedger, gitEnv, leaks, loggedText, lostAuthorityEnding, mergeCommitProblems, movedHeadEnding, parseArgs, PLAN,
  releaseStatusProblems, repositoryOrgProblem, requesterProblem, reviewStatusProblems, rulesetProblems, scrub, secretProblem, SIGN_UPS, signDelivery, STAGING, STAGING_APP, STAGING_ORG, stagingConfig, stagingOnly,
  STEADY, steady, tailEnv, Tally, WEBHOOK_PATH, WEBHOOK_SECRET_ENV, webhookSecretProblem,
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
check(args("--base-url", STAGING).options.logs === true && args("--base-url", STAGING, "--skip-logs").options.logs === false, "the logs are tailed unless --skip-logs is given");

// ---- configuration ----
check(secretProblem(undefined) !== null && secretProblem("short") !== null && secretProblem("x".repeat(32)) === null, "the sign-up secret must be set and at least 32 characters");
// A configuration of this test's own, so nothing here depends on what apps/api/wrangler.jsonc holds today.
const vars = { GITHUB_ORG_LOGIN: "podsterdev", GITHUB_ORG_ID: "354820586", GITHUB_MERGE_APP_ID: "5695088" };
const read = stagingConfig(vars);
check(!read.error && read.org === "podsterdev" && read.orgId === 354820586 && read.mergeAppId === 5695088, "a configuration names the organization, its ID and the merge App");
check(!stagingConfig({ ...vars, MANAGED_REPOSITORIES: "false" }).error && !stagingConfig({ ...vars, MANAGED_REPOSITORIES: "true" }).error, "the switch isn't read from the file: staging is asked");
check(Boolean(stagingConfig({}).error) && Boolean(stagingConfig(undefined).error) && Boolean(stagingConfig({ ...vars, GITHUB_MERGE_APP_ID: "x" }).error) && Boolean(stagingConfig({ ...vars, GITHUB_ORG_LOGIN: "a/b" }).error), "a configuration with an ID missing or a malformed name is refused");
check(args("--base-url", STAGING, "--api-config", "/x/wrangler.jsonc").options.apiConfig === "/x/wrangler.jsonc" && args("--base-url", STAGING).options.apiConfig === undefined && Boolean(args("--base-url", STAGING, "--api-config").error), "--api-config names another file, and needs a value");
check(SIGN_UPS.length === 2 && !SIGN_UPS.some((take) => /operator/i.test(`${take.who} ${take.why}`)), "a run takes two sign-ups, and none is an operator's");

// ---- the organization, pinned in code ----
check(STAGING_ORG === "podsterdev", "the organization is podsterdev, in code");
for (const org of ["podsterx", "Podsterdev", "podsterdev-test", "another-organization"]) {
  const refused = stagingConfig({ ...vars, GITHUB_ORG_LOGIN: org });
  check(Boolean(refused.error) && refused.error.includes("podsterdev only") && refused.org === undefined, `a configuration naming ${org} is refused, with the rest of it right`);
}
check(requesterProblem("per_e2e_0123abcd", true) === null, "a test person staging says may ask is accepted");
for (const [id, may] of [["per_e2e_0123abcd", false], ["per_e2e_0123abcd", undefined], ["per_e2e_0123abcd", "true"], ["per_Xy7ordinary", true], ["per_e2e_", true], ["agt_e2e_0123", true], [undefined, true]]) {
  check(requesterProblem(id, may) !== null, `a person ${JSON.stringify(id)} told ${JSON.stringify(may)} is refused`);
}
check(repositoryOrgProblem("podsterdev/e2e-m5-1") === null, "a repository staging links under podsterdev is accepted");
for (const full of ["podsterx/e2e-m5-1", "podsterdev", "podsterdev/a/b", "other/podsterdev", "", undefined, null, 7]) {
  check(repositoryOrgProblem(full) !== null, `a linked repository of ${JSON.stringify(full)} is refused`);
}
{
  // The real file, as it is in this checkout: staging's block must name the pinned organization, or the run would refuse
  // itself, and a change of organization there must be a change here too.
  const real = parseJsonc(readFileSync(join(here, "../apps/api/wrangler.jsonc"), "utf8")).env?.staging?.vars;
  check(real?.GITHUB_ORG_LOGIN === "podsterdev", "apps/api/wrangler.jsonc names podsterdev for staging");
  check(!stagingConfig(real).error && stagingConfig(real).org === STAGING_ORG, "and the run accepts the real staging configuration");
  // The run's people are test people, so staging's list of who may ask must hold the entry for them, in a list that's well formed.
  const requesters = String(real?.REPOSITORY_REQUESTERS ?? "").split(",");
  check(requesters.includes("test-people") && requesters.every((entry) => entry === "test-people" || entry === "operators" || /^per_[A-Za-z0-9_-]+$/.test(entry)), "apps/api/wrangler.jsonc lets test people ask for a repository on staging, in a well-formed list");
}

// ---- grants that must not outlive the run ----
{
  const ledger = new GrantLedger();
  check(ledger.left().length === 0, "a run that gave no short grant has nothing to take back");
  ledger.note("pgr_short", "watcher's short merge grant");
  check(JSON.stringify(ledger.left()) === JSON.stringify([{ id: "pgr_short", what: "watcher's short merge grant" }]), "a short grant whose expiry was never seen is left for clean-up to take back");
  ledger.settle("pgr_short");
  check(ledger.left().length === 0, "one seen expired is taken off, and clean-up leaves it alone");
  ledger.note("pgr_a", "a");
  ledger.note("pgr_b", "b");
  ledger.settle("pgr_other");
  check(ledger.left().map((grant) => grant.id).join() === "pgr_a,pgr_b", "settling another grant takes none off, and they're listed in the order given");
  ledger.note(undefined, "a grant that was never given");
  ledger.note("", "an empty ID");
  check(ledger.left().length === 2, "a grant with no ID isn't listed: there's nothing to take back");
}
{
  // The script notes the short grant before it waits, settles it only once it's listed expired, and takes back what's left.
  const source = readFileSync(join(here, "m5-staging.mjs"), "utf8");
  const [given, waited, settled] = ['ledger.note(grant?.id, "watcher\'s short merge grant")', "the API listing the short grant as expired", "ledger.settle(grant.id)"].map((text) => source.indexOf(text));
  check(given > 0 && waited > given && settled > waited, "M5-G3 notes its grant before the wait and settles it only after");
  check(source.includes("for (const { id, what } of ledger.left())") && source.includes("/repository/grants/${id}`"), "clean-up takes back every grant left");
  check(!/operator|PODSTER_E2E_OPERATOR_COOKIE/i.test(source.replace(/No operator takes part[^\n]*\n[^\n]*/, "")), "the script has no operator step and reads no operator's session");
}

// ---- the plan and the results ----
const ids = PLAN.map((entry) => entry.id);
check(new Set(ids).size === ids.length && ids.every((id) => /^(M5|AC)-[0-9A-Z]+[a-z]?$/.test(id) && id.length <= 7) && PLAN.every((entry) => entry.title.length > 0), "every check has one stable ID and a title");
{
  // Every check the script runs is in the plan, and every planned check is run: a result for an unplanned ID would throw mid-run.
  const source = readFileSync(join(here, "m5-staging.mjs"), "utf8");
  const run = [...source.matchAll(/(?:check|lostAuthority)\("((?:M5|AC)-[0-9A-Za-z]+)"/g)].map((found) => found[1]);
  check(new Set(run).size === run.length && JSON.stringify([...run].sort()) === JSON.stringify([...ids].sort()), "the script runs each planned check once, and no other");
  // The gate's rows and access tests the extended run exists for each have a check.
  for (const id of ["M5-03a", "M5-03b", "M5-15a", "M5-13", "M5-16a", "M5-16b", "M5-12b", "M5-08b", "M5-09f", "AC-05a", "AC-05e", "AC-13a", "AC-13b", "AC-13c", "AC-13d", "AC-16", "M5-07c", "M5-07d", "M5-07e", "M5-06f", "M5-06g", "M5-C3"]) check(ids.includes(id), `the plan has ${id}`);
}
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

// ---- the webhook secret, and deliveries ----
check(WEBHOOK_SECRET_ENV === "PODSTER_M5_WEBHOOK_SECRET" && forbidden(WEBHOOK_SECRET_ENV) && throws(() => childEnv({ [WEBHOOK_SECRET_ENV]: "x" })), "the webhook secret's name is one child-env.mjs never passes on");
check(webhookSecretProblem(undefined) === null && webhookSecretProblem("") === null && webhookSecretProblem("w".repeat(32)) === null && typeof webhookSecretProblem("zq9-zq9") === "string", "the webhook secret may be unset, and a set one must be at least 32 characters");
check(!webhookSecretProblem("zq9-zq9").includes("zq9"), "a refused webhook secret isn't printed");
{
  const source = readFileSync(join(here, "m5-staging.mjs"), "utf8");
  const lib = readFileSync(join(here, "m5-staging-lib.mjs"), "utf8");
  check(!/webhook-secret|\.podster\/|readFileSync\([^)]*ecret/i.test(source) && !/webhook-secret|\.podster\//.test(lib), "neither file names the webhook secret's file or the directory it's kept in, and the script reads no secret from a file");
  check((source.match(/\bwebhookSecret\b/g) ?? []).length === 6 && source.includes("const webhookSecret = process.env[WEBHOOK_SECRET_ENV] || undefined;") && source.includes("const secrets = [signupSecret, webhookSecret].filter(Boolean);"), "the script takes the webhook secret from its one name, scrubs it from output, and uses it nowhere but to check and to sign");
  check(source.split("have(webhookSecret").length - 1 === 2 && !/writeFileSync\([^)]*ecret/.test(source), "only the two signed-delivery checks read it, each skipping without it, and it's never written");
  check(WEBHOOK_PATH === "/webhooks/github" && source.includes("target.http(WEBHOOK_PATH") && STAGING_APP === "https://app-staging.podster.dev", "deliveries go to the gateway's webhook route on staging, and the web app asked for a marker page is staging's");
}
{
  const body = deliveryBody({ repositoryId: 987, number: 7, head: "a".repeat(40), nonce: "n1" });
  const payload = JSON.parse(body);
  // What apps/gateway/src/github-webhook.ts reads from a pull_request delivery, and nothing a title or a branch could ride in.
  check(payload.repository.id === 987 && payload.pull_request.number === 7 && payload.pull_request.head.sha === "a".repeat(40), "a delivery's body names the repository's ID, the pull request's number and its head commit");
  check(JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(["action", "nonce", "number", "pull_request", "repository"]) && !/title|ref|login|url/.test(body), "and nothing else: no title, branch, login or URL");
  check(body !== deliveryBody({ repositoryId: 987, number: 7, head: "a".repeat(40), nonce: "n2" }), "a new nonce makes a new body, which the room takes as a new delivery");
  const key = "k".repeat(40);
  check(signDelivery(key, body) === `sha256=${createHmac("sha256", key).update(body).digest("hex")}` && /^sha256=[0-9a-f]{64}$/.test(signDelivery(key, body)), "a delivery is signed as GitHub signs one: HMAC-SHA256 of the body, in hex");
  check(signDelivery(key, body) !== signDelivery("j".repeat(40), body) && signDelivery(key, body) !== signDelivery(key, `${body} `), "another key, or another body, is another signature");
}
{
  // `wrangler tail` events, as the API logs a delivery: one JSON line of IDs and a fixed code.
  const line = (delivery, outcome, extra = {}) => ({ logs: [{ level: "log", message: [JSON.stringify({ at: "provider.delivery", delivery, outcome, ...extra })] }], exceptions: [] });
  const events = [line("d-1", "nudged", { room: "ws_1" }), { logs: [{ message: ["not json"] }, { message: [JSON.stringify({ at: "github.webhook", delivery: "d-1", outcome: "accepted" })] }] }, line("d-2", "no_room"), line("d-1", "replayed", { room: "ws_1" }), { logs: null }, {}];
  check(JSON.stringify(deliveryOutcomes(events, "d-1")) === JSON.stringify(["nudged", "replayed"]) && JSON.stringify(deliveryOutcomes(events, "d-2")) === JSON.stringify(["no_room"]), "the API's outcome for a delivery is read from its own log lines, in order");
  check(deliveryOutcomes(events, "d-3").length === 0 && deliveryOutcomes([], "d-1").length === 0, "a delivery the log doesn't hold has no outcome, and the gateway's line isn't taken for the API's");
}

// ---- what the Workers logged ----
{
  const event = { outcome: "ok", event: { request: { url: "https://gateway-staging.podster.dev/api/v1/workspaces/ws_1", headers: { cookie: "session-cookie-value-123" } } }, logs: [{ message: ['{"event":"merge.pass_failed","ws":"ws_1","task":"tsk_1","code":"provider_unavailable"}'] }], exceptions: [] };
  const text = loggedText([event]);
  check(text.includes("merge.pass_failed") && !text.includes("session-cookie-value-123") && !text.includes("gateway-staging"), "what a Worker logged is read from its logs and exceptions, never from the request the tail shows beside them");
  const needles = [{ label: "a token", value: "ghs_secretsecretsecret" }, { label: "a branch name", value: "e2e/change-1" }, { label: "a short one", value: "e2e" }, { label: "nothing", value: undefined }];
  check(leaks(text, needles).length === 0, "IDs and codes alone hold none of the run's strings");
  const leaked = leaks(`${text} pushed e2e/change-1 with ghs_secretsecretsecret e2e`, needles);
  check(JSON.stringify(leaked) === JSON.stringify(["a token", "a branch name"]) && !leaked.join().includes("ghs_"), "a token and a branch name in a log are found, by their labels and never their values; a string under 8 characters isn't looked for");
  check(JSON.stringify(Object.keys(tailEnv({ PATH: "/usr/bin", HOME: "/home/x", PODSTER_E2E_SIGNUP_SECRET: "s", [WEBHOOK_SECRET_ENV]: "w", CLOUDFLARE_API_TOKEN: "t", GITHUB_TOKEN: "g" })).sort()) === JSON.stringify(["HOME", "PATH"]), "wrangler tail gets the allow-listed names only: no secret of the run's, and no token");
}

// ---- IDs that name nothing, and what counts as a change ----
check(absentId("tsk_0123456789abcdef") === "tsk_fedcba9876543210" && absentId("ws_ab12") === "ws_21ba" && absentId("pgr_abab") === "pgr_baba", "an ID that names nothing keeps the shape of a real one");
check(absentId("tsk_aa") === null && absentId("nounderscore") === null, "an ID that reversing can't change, or with no prefix, gives none");
{
  const change = Object.fromEntries(STEADY.map((field, at) => [field, at]));
  check(JSON.stringify(steady({ ...change, pr_observed_at: 1, head_observed_at: 2 })) === JSON.stringify(steady({ ...change, pr_observed_at: 9, head_observed_at: 9 })), "reading a pull request again, with nothing changed, isn't a change");
  check(STEADY.every((field) => JSON.stringify(steady({ ...change, [field]: "other" })) !== JSON.stringify(steady(change))) && steady(null) === null, "a moved head, a new state or a merge is one, field by field");
}

// ---- merges the run can't force ----
{
  const failed = (reason) => ({ merge_state: "failed", merge_reason: reason, merge_sha: null });
  check(lostAuthorityEnding(failed("grant_required"), "grant_required").shown === true && lostAuthorityEnding(failed("access_revoked"), "access_revoked").shown === true, "a merge the job ended with the lost authority's own code is shown");
  const first = lostAuthorityEnding({ merge_state: "succeeded", merge_sha: "a".repeat(40) }, "grant_required");
  check(first.shown === false && !first.problem && first.why.length > 0, "a merge the job finished first shows nothing, and is a skip with its reason, not a failure");
  for (const [title, change] of [["another reason", failed("provider_refused")], ["the wrong authority's code", failed("access_revoked")], ["a failure that still names a merge commit", { ...failed("grant_required"), merge_sha: "a".repeat(40) }], ["a merge still requested", { merge_state: "requested" }], ["no change", null]])
    check(typeof lostAuthorityEnding(change, "grant_required").problem === "string", `refused: ${title}`);
  const reviewed = "b".repeat(40);
  check(movedHeadEnding({ change: failed("commit_changed"), reviewed }).shown === true, "a merge the job ended commit_changed is shown");
  for (const [title, found] of [
    ["Podster had already seen the move", { refusedCode: "commit_changed" }], ["GitHub refused the merge call", { change: failed("provider_refused"), reviewed }],
    ["GitHub merged exactly the reviewed commit", { change: { merge_state: "succeeded", merge_sha: "c".repeat(40) }, mergedSecondParent: reviewed, reviewed }],
  ]) check(movedHeadEnding(found).shown === false && !movedHeadEnding(found).problem, `not shown, and no failure: ${title}`);
  for (const [title, found] of [
    ["the request refused for another reason", { refusedCode: "grant_required" }], ["the request refused with no code", { refusedCode: null }], ["another commit merged", { change: { merge_state: "succeeded", merge_sha: "c".repeat(40) }, mergedSecondParent: "d".repeat(40), reviewed }],
    ["a merge with no second parent read", { change: { merge_state: "succeeded" }, reviewed }], ["a failure for another reason", { change: failed("grant_required"), reviewed }], ["a commit_changed that names a merge commit", { change: { ...failed("commit_changed"), merge_sha: "c".repeat(40) }, reviewed }],
  ]) check(typeof movedHeadEnding(found).problem === "string", `refused: ${title}`);
}

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
const asked = (prompt) => spawnSync("sh", ["-s", prompt], { input: ASKPASS_SCRIPT, env: { PATH: process.env.PATH, [CREDENTIAL_ENV]: token }, encoding: "utf8" });
check(asked("Username for 'https://github.com': ").stdout === "x-access-token\n" && asked("Password for 'https://x-access-token@github.com': ").stdout === `${token}\n`, "it answers git's two questions about github.com");
for (const prompt of [
  "Password for 'https://x-access-token@example.com': ", "Password for 'https://x-access-token@github.com.example.com': ", "Password for 'https://someone@github.com': ", "Password for 'http://x-access-token@github.com': ",
  "Password for 'https://x-access-token@github.com:8443': ", "Username for 'https://example.com': ", "Username for 'https://api.github.com': ", "Password for 'https://github.com': ", "",
]) {
  const answer = asked(prompt);
  check(answer.stdout === "" && answer.status !== 0, `it gives nothing to: ${prompt || "(no question)"}`);
}
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
  ["no review status", []], ["a status from another App", [{ ...status, creator: { login: "podster-staging-agent[bot]", type: "Bot" } }]],
  ["a status from a person", [{ ...status, creator: { login: "podster-staging-merge[bot]", type: "User" } }]], ["a pending status", [{ ...status, state: "pending" }]], ["an answer that isn't a list", { message: "Not Found" }],
]) check(reviewStatusProblems(statuses).length === 1, `refused: ${title}`);

{
  const twice = reviewStatusProblems([status, status]);
  const stranger = reviewStatusProblems([{ ...status, creator: { login: "someone", type: "User" } }]);
  check(twice.length === 1 && twice[0].includes("2 podster/review statuses were found") && twice[0].includes("retried"), "refused: two review statuses, said as more than one found");
  check(stranger.length === 1 && stranger[0].includes("the one status is") && !stranger[0].includes("were found"), "and a wrong creator is said differently");
}

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
// The API's configuration is a file of this test's own, with the switch off: a dry run reads no switch, and CI must not
// depend on what apps/api/wrangler.jsonc sets for staging today.
const fixtures = mkdtempSync(join(tmpdir(), "m5-selftest-"));
const apiConfig = join(fixtures, "wrangler.jsonc");
writeFileSync(apiConfig, `{ // a comment, as the real file has\n "env": { "staging": { "vars": ${JSON.stringify({ ...vars, MANAGED_REPOSITORIES: "false" })} } } }`);
const emptyConfig = join(fixtures, "empty.jsonc");
writeFileSync(emptyConfig, `{ "env": { "staging": { "vars": {} } } }`);
// --skip-logs, so these don't depend on whether this checkout has the apps' wrangler installs. The tails' own preflight is below.
const run = (argv, env = {}, config = apiConfig) => spawnSync(process.execPath, [join(here, "m5-staging.mjs"), ...argv, "--api-config", config], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: "utf8", timeout: 60_000 });
const script = (argv, env, config) => run([...argv, "--skip-logs"], env, config);
const secret = "s".repeat(40);
{
  const run = script(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret });
  check(run.status === 0 && run.stdout.includes("Nothing was sent") && ids.every((id) => run.stdout.includes(id)), "a dry run exits 0, names every check and says nothing was sent");
  check(run.stdout.includes("Sign-ups this run takes: 2") && !run.stdout.includes(secret) && !run.stderr.includes(secret), "it states its two sign-ups, and never the secret");
  const elsewhere = join(fixtures, "elsewhere.jsonc");
  writeFileSync(elsewhere, `{ "env": { "staging": { "vars": ${JSON.stringify({ ...vars, GITHUB_ORG_LOGIN: "podsterx" })} } } }`);
  const refused = script(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret }, elsewhere);
  check(refused.status === 2 && refused.stderr.includes("podsterdev only") && !refused.stdout.includes("Nothing was sent"), "told another organization, the script refuses to run, exit 2");
}
check(script(["--base-url", STAGING, "--dry-run"]).status === 2, "a dry run without the sign-up secret exits 2");
check(script(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret }, emptyConfig).status === 2 && script(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret }, join(fixtures, "missing.jsonc")).status === 2, "a dry run with no organization configured, or no file, exits 2");
for (const base of ["https://gateway.podster.dev", "http://localhost:8787", "https://gateway-staging.podster.dev.example.com"]) {
  const run = script(["--base-url", base], { PODSTER_E2E_SIGNUP_SECRET: secret });
  check(run.status === 2 && run.stderr.includes("Only https://gateway-staging.podster.dev"), `the script refuses ${base} before anything else`);
}
check(script(["--base-url", STAGING, "--yes"], { PODSTER_E2E_SIGNUP_SECRET: secret }).status === 2, "the script refuses an unknown flag");
{
  const skipped = script(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret });
  check(skipped.stdout.includes("not tailed (--skip-logs), so M5-13a and M5-13 will be skipped") && skipped.stdout.includes(`${WEBHOOK_SECRET_ENV} isn't set, so M5-16a and M5-16b will be skipped`), "a dry run says the logs won't be tailed, and that the signed deliveries will be skipped without their secret");
  const hook = "w".repeat(40);
  const signed = script(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret, [WEBHOOK_SECRET_ENV]: hook });
  check(signed.status === 0 && signed.stdout.includes("so M5-16a and M5-16b will run") && !signed.stdout.includes(hook) && !signed.stderr.includes(hook), "with the webhook secret set it says they'll run, and never prints it");
  const short = script(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret, [WEBHOOK_SECRET_ENV]: "too-short-to-be-one" });
  check(short.status === 2 && short.stderr.includes("shorter than the 32 characters") && !short.stderr.includes("too-short-to-be-one") && !short.stdout.includes("too-short-to-be-one"), "a webhook secret too short to be one is refused, exit 2, and not printed");
  // With the logs on, the run needs each app's own wrangler before anything is sent. Which way this checkout goes is read here, not assumed.
  const missing = missingWranglers(join(here, ".."));
  const tailed = run(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret });
  check(missing.length === 0 ? tailed.status === 0 && tailed.stdout.includes("`wrangler tail` for apps/api, apps/gateway, apps/web") : tailed.status === 2 && missing.every((app) => tailed.stderr.includes(`apps/${app}`)) && tailed.stderr.includes("--skip-logs") && !tailed.stdout.includes("Nothing was sent"), `with the logs on, a dry run ${missing.length === 0 ? "names the three tails" : `refuses, naming the ${missing.length} app(s) with no wrangler installed`}`);
}

rmSync(fixtures, { recursive: true, force: true });

console.log(failed ? `\n${failed} failed` : "\nM5 staging self-test: all passed");
process.exit(failed ? 1 : 0);
