// Checks the parts of M5's staging run that need no network: which host it accepts, its arguments, how results are
// counted into an exit code, what its `git` child can see, and how it reads GitHub's answers. Then the script itself,
// as a dry run, which sends nothing.
//
//   node m5-staging-selftest.mjs
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { childEnv, forbidden } from "./child-env.mjs";
import { parseJsonc } from "./jsonc.mjs";
import { missingWranglers } from "./m4-staging-lib.mjs";
import { probeArgs } from "./m5-delivery-probe.mjs";
import { ACCOUNT_ENV, closeTails, downWithin, openTail, refusalLines, requestHolds, STAY_UP_SECONDS, TAIL_ARGS, tailEnv, tailFault, without, wranglerReason } from "./m5-tails.mjs";
import {
  absentId, ASKPASS_SCRIPT, cloneUrlProblem, CREDENTIAL_ENV, deliveryBody, deliveryOutcomes, deliveryProblem, deliveryTrace, requestIsFor, GrantLedger, gitEnv, isCommitSha, LATE_MERGE_MS, CLOCK_SKEW_MS, leaks, loggedText, logHits, lostAuthorityEnding, worstCaseSeconds, mergeCommitProblems, movedHeadEnding, parseArgs, PLAN,
  releaseStatusProblems, repositoryOrgProblem, requesterProblem, reviewStatusProblems, rulesetProblems, scrub, secretProblem, SIGN_UPS, signDelivery, STAGING, STAGING_APP, STAGING_ORG, stagingConfig, stagingOnly,
  STEADY, steady, Tally, WEBHOOK_PATH, WEBHOOK_SECRET_ENV, webhookSecretProblem,
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
  const [given, waited] = ['const grant = await give(watcher, "merge", { expires_at: Date.now() + 20_000 });', "the API listing the short grant as expired"].map((text) => source.indexOf(text));
  const settled = source.indexOf("ledger.settle(grant.id)", waited);
  check(given > 0 && waited > given && settled > waited && source.includes("const give = async (principal, action, extra = {}) => gave(await owner.must("), "M5-G3's grant is noted as it's given, before the wait, and settled only after");
  check(source.includes("for (const { id, what } of ledger.left())") && source.includes("/repository/grants/${id}`"), "clean-up takes back every grant left");
  // Every grant the run gives goes through `gave`, directly or by `give`: no grant is asked for and left off the ledger.
  const lines = source.split("\n");
  const asked = lines.map((line, at) => [line, at]).filter(([line]) => /\.must\("POST", (?:grantsPath|`[^`]*\/repository\/grants`),/.test(line));
  const noted = asked.filter(([line, at]) => line.includes("gave(await ") || (/const grant = await other\.must/.test(line) && lines[at + 1].trim().startsWith("gave(grant, ")));
  check(asked.length === 5 && noted.length === asked.length, `each of the ${asked.length} places a grant is given notes it for clean-up, before anything is asserted about it`);
  const cleanUp = source.slice(source.indexOf("function cleanUp()"), source.indexOf('for (const signal of ["SIGINT", "SIGTERM"])'));
  check(cleanUp.includes("if (demoted)") && cleanUp.includes('role: "admin"') && cleanUp.includes("NOT made the first room's admin again"), "clean-up makes a demoted second person the room's admin again, and says so if it couldn't");
  check(cleanUp.includes("grantHome.get(id)") && cleanUp.includes("Clean-up could NOT take these grants back") && cleanUp.includes('back.code === "grant_not_found"'), "clean-up takes each grant back where it was given, counts one already ended as done, and prints what it couldn't undo");
  check(source.indexOf("if (down.ok) demoted = true;") > 0 && source.indexOf("demoted = false;", source.indexOf('check("AC-13d"')) > 0, "the demotion is marked the moment it's answered, and cleared only once the role is back");
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
  for (const id of ["M5-07f", "M5-C1", "M5-C8", "M5-03a", "M5-03b", "M5-15a", "M5-13", "M5-16a", "M5-16b", "M5-12b", "M5-08b", "M5-09f", "AC-05a", "AC-05e", "AC-13a", "AC-13b", "AC-13c", "AC-13d", "AC-16", "M5-07c", "M5-07d", "M5-07e", "M5-06f", "M5-06g", "M5-C3"]) check(ids.includes(id), `the plan has ${id}`);
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
  check((source.match(/\bwebhookSecret\b/g) ?? []).length === 6 && source.includes("const webhookSecret = process.env[WEBHOOK_SECRET_ENV] || undefined;") && source.includes('secret(webhookSecret, "the webhook secret");'), "the script takes the webhook secret from its one name, scrubs it from output, and uses it nowhere but to check and to sign");
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

// ---- a delivery with no line: what the tail held instead ----
{
  // The API's own request for a delivery, as its tail shows it: the ID is in the gateway's assertion, not the URL.
  const assertion = (claims) => `${Buffer.from('{"alg":"EdDSA"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;
  const request = (delivery, lines = [], ended = "ok") => ({ outcome: ended, logs: lines.map((fields) => ({ message: [JSON.stringify(fields)] })), exceptions: [], event: { request: { url: "https://api.internal/v1/provider/github/deliveries", method: "POST", headers: { "x-podster-assertion": assertion({ typ: "provider_delivery", provider: "github", delivery, body_sha256: "ab".repeat(32) }) } } } });
  const line = (delivery, outcome) => ({ at: "provider.delivery", delivery, room: "ws_1", ...(outcome === undefined ? {} : { outcome }) });
  check(requestIsFor(request("d-1"), "d-1") && !requestIsFor(request("d-1"), "d-2") && !requestIsFor(request("d-12"), "d-1") && !requestIsFor({ event: { request: { headers: { "x-podster-assertion": "not.a-token" } } } }, "d-1") && !requestIsFor({ event: { rpcMethod: "x" } }, "d-1") && !requestIsFor(request("d-1"), ""), "the API's request for a delivery is told by the ID in its assertion, exactly, and by nothing else");
  const good = deliveryTrace([request("d-1", [line("d-1", "unknown_change")])], "d-1");
  check(JSON.stringify(good) === JSON.stringify({ outcomes: ["unknown_change"], odd: [], requests: [{ ended: "ok", lines: 1 }] }) && deliveryProblem(good) === null && deliveryProblem(good, 2).text.includes("only 1 of 2 lines (unknown_change)"), "a line with an outcome is read, with the request it came in; one line where two are wanted is said as that");
  // A wrong value must never look like a wait: each is a finding, said as what it was.
  for (const [title, outcome, said] of [["no outcome", undefined, "a line with no outcome"], ["a null outcome", null, "a line whose outcome is null"], ["a number", 7, "a line whose outcome is a number"], ["an object", { code: "x" }, "a line whose outcome is a object"], ["text that isn't a code", "Unknown Change!", "a line whose outcome is not a code"], ["an empty outcome", "", "a line whose outcome is not a code"]]) {
    const trace = deliveryTrace([request("d-1", [line("d-1", outcome)])], "d-1");
    const problem = deliveryProblem(trace);
    check(trace.outcomes.length === 0 && trace.odd.join() === said && problem.text === `the API logged ${said} for it` && problem.lost === false, `a line with ${title} is reported as that, and isn't a line that never came`);
  }
  // No line: whether the API's request is in the tail decides what it means.
  const ran = deliveryProblem(deliveryTrace([request("d-1", [{ at: "something.else" }], "canceled"), request("d-2", [line("d-2", "no_room")])], "d-1"));
  check(ran.lost === false && ran.text.includes("holds no line for it, though it holds the API's own request for it (ended canceled, 1 line(s) logged)") && ran.text.includes("the API ran, and the line isn't there"), "no line, with the API's request for it in the tail: the API ran and logged no line, which is never sent again");
  const gone = deliveryProblem(deliveryTrace([request("d-2", [line("d-2", "no_room")]), { logs: null }, {}], "d-1"));
  check(gone.lost === true && gone.text.includes("no request of the API's for it either: the tail never delivered that event"), "no line and no request: the tail never delivered it, the one case where another delivery is sent");
  check(JSON.stringify(deliveryOutcomes([request("d-1", [line("d-1", "nudged")]), request("d-1", [line("d-1", "replayed")])], "d-1")) === JSON.stringify(["nudged", "replayed"]) && deliveryTrace([request("d-1", [line("d-1", "nudged")]), request("d-1", [line("d-1", "replayed")])], "d-1").requests.length === 2, "a delivery sent twice has two lines and two requests, in order");
  const source = readFileSync(join(here, "m5-staging.mjs"), "utf8");
  const body = source.slice(source.indexOf('check("M5-16b"'), source.indexOf("await check(", source.indexOf('check("M5-16b"') + 1));
  check(body.indexOf("for (const one of cases) one.sent = await send(one.repositoryId);") > 0 && body.indexOf("const problems = [];") < body.indexOf("let found = await traced(one.sent.id);") && body.indexOf("ok(problems.length === 0") > body.lastIndexOf("problems.push("), "M5-16b looks for each delivery's line by itself, and fails once at the end with both");
  check(body.includes("if (found.problem && found.lost) {") && (body.match(/await send\(/g) ?? []).length === 2 && body.includes("notes.push("), "it sends another only when the tail holds nothing of the first, once, and says that it did");
  check(source.includes("if (trace.odd.length || Date.now() > deadline) return { problem:"), "a line with a wrong outcome ends the wait at once");
  // The probe's arguments.
  check(JSON.stringify(probeArgs([]).options) === JSON.stringify({ pull: 999999, count: 3 }) && probeArgs(["--repository", "1454615252", "--pull", "5", "--count", "10"]).options.repository === 1454615252 && probeArgs(["--count", "10"]).options.count === 10, "the probe takes a repository, a pull request number and a count");
  for (const bad of [["--count", "11"], ["--count", "0"], ["--repository"], ["--repository", "abc"], ["--pull", "-1"], ["--base-url", "https://example.test"], ["--secret", "x"]]) check(Boolean(probeArgs(bad).error), `the probe refuses ${bad.join(" ")}`);
  const probe = readFileSync(join(here, "m5-delivery-probe.mjs"), "utf8");
  check(probe.includes("fetch(`${STAGING}${WEBHOOK_PATH}`") && (probe.match(/fetch\(/g) ?? []).length === 1 && !/readFileSync|writeFileSync|\.podster\//.test(probe) && probe.includes("const secret = process.env[WEBHOOK_SECRET_ENV] || undefined;"), "the probe sends to staging's webhook route and nowhere else, reads the secret from the environment and no file, and writes nothing");
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
  const ended = (reason) => ({ merge_state: "failed", merge_reason: reason, merge_sha: null });
  check(lostAuthorityEnding(ended("grant_required"), "grant_required").shown === true && lostAuthorityEnding(ended("access_revoked"), "access_revoked", { held: true }).shown === true, "a merge the job ended with the lost authority's own code is shown");
  // A merge that succeeded is never waved through. The authority ended at T, by Podster's clock.
  const T = 1_800_000_000_000;
  const merged = (finishedAt) => ({ merge_state: "succeeded", merge_sha: "a".repeat(40), merge_finished_at: finishedAt });
  const judge = (finishedAt, mergedAt, held) => lostAuthorityEnding(merged(finishedAt), "grant_required", { lostAt: T, mergedAt, held });
  // Held: the run saw the job not yet there once the authority had ended. Any merge is a failure, whatever the clocks say.
  for (const [title, finishedAt, mergedAt] of [
    ["GitHub's clock says well before", T + 500, T - 60_000], ["both clocks say before", T - 500, T - 4000], ["the same second", T + 300, T], ["just after", T + 1500, T + 1000], ["long after", T + 9000, T + 8000], ["no time from GitHub", T + 300, undefined],
  ]) {
    const held = judge(finishedAt, mergedAt, true);
    check(typeof held.problem === "string" && held.problem.includes("without authority") && !("shown" in held), `refused when the run held the job: a merge that succeeded, ${title}`);
  }
  check(typeof lostAuthorityEnding(merged(T), "grant_required", { held: true }).problem === "string", "refused when the run held the job, with no times at all");
  // Not held: only the times are left.
  const lost = judge(T - 400, T - 2000, false);
  check(lost.shown === false && lost.kind === "race_lost" && !lost.problem && lost.why.includes("race was lost") && lost.why.includes("before"), "not held, finished before the authority ended by Podster's own clock: the race was lost, a skip that says so");
  check(judge(undefined, T - 1000 - CLOCK_SKEW_MS, false).kind === "race_lost" && judge(undefined, T - 999 - CLOCK_SKEW_MS, false).kind === "cannot_tell", "by GitHub's clock alone, before means more than a second and the clock allowance before");
  check(judge(undefined, T - 1000, false).kind === "cannot_tell" && judge(T + 50, T - 2000, false).kind === "cannot_tell", "a second before by GitHub's clock isn't enough: the clocks may differ, so it can't be told");
  const late = judge(T + 9000, T + LATE_MERGE_MS + CLOCK_SKEW_MS, false);
  check(typeof late.problem === "string" && late.problem.includes("without authority") && late.problem.includes("7 s after") && !/-\d/.test(late.problem), "not held, merged past the late limit and the clock allowance: a failure, with the time said as after and never as a negative");
  const close = judge(T + 1500, T + LATE_MERGE_MS + CLOCK_SKEW_MS - 1, false);
  check(close.shown === false && close.kind === "cannot_tell" && !close.problem && close.why.includes("can't be told") && close.why.includes("3 s before to 7 s after"), "inside the window it can't be told: a skip of its own kind, which states the window's bounds");
  check(!/-\d/.test(lost.why) && !/-\d/.test(close.why) && !/-\d/.test(judge(T + 300, T - 5000, true).problem), "no message says a negative time");
  for (const [title, times] of [["no time for the authority ending", { mergedAt: T, held: false }], ["no time from GitHub", { lostAt: T, held: false }], ["no times at all", undefined]])
    check(typeof lostAuthorityEnding(merged(T - 5), "grant_required", times).problem === "string", `refused: a merge that succeeded with ${title}`);
  check([lost, close].every((ending) => ending.shown === false && ["race_lost", "cannot_tell"].includes(ending.kind)), "no merge that succeeded is ever shown as passing, and each skip says which kind it is");
  for (const [title, change] of [["another reason", ended("provider_refused")], ["the wrong authority's code", ended("access_revoked")], ["a failure that still names a merge commit", { ...ended("grant_required"), merge_sha: "a".repeat(40) }], ["a merge still requested", { merge_state: "requested" }], ["no change", null]])
    check(typeof lostAuthorityEnding(change, "grant_required", { lostAt: T, mergedAt: T, held: true }).problem === "string", `refused: ${title}`);
  {
    const source = readFileSync(join(here, "m5-staging.mjs"), "utf8");
    check(source.includes('entry.action === "repo_grant.revoked"') && source.includes("Date.parse(pull.merged_at)") && source.includes('then.clash === "requested" && then[label] === "requested"'), "the script reads when the authority ended from the room's audit log, when GitHub merged from the pull request, and whether the job was still behind");
    check(source.includes("lostAuthorityEnding(b.ends[label], reason, { lostAt: b.lost[label], mergedAt, held: b.held[label] })"), "and judges each of the three with all of them");
  }
  const reviewed = "b".repeat(40);
  check(movedHeadEnding({ change: ended("commit_changed"), reviewed }).shown === true, "a merge the job ended commit_changed is shown");
  for (const [title, found] of [
    ["Podster had already seen the move", { refusedCode: "commit_changed" }], ["GitHub refused the merge call", { change: ended("provider_refused"), reviewed }],
    ["GitHub merged exactly the reviewed commit", { change: { merge_state: "succeeded", merge_sha: "c".repeat(40) }, mergedSecondParent: reviewed, reviewed }],
  ]) check(movedHeadEnding(found).shown === false && !movedHeadEnding(found).problem, `not shown, and no failure: ${title}`);
  for (const [title, found] of [
    ["the request refused for another reason", { refusedCode: "grant_required" }], ["the request refused with no code", { refusedCode: null }], ["another commit merged", { change: { merge_state: "succeeded", merge_sha: "c".repeat(40) }, mergedSecondParent: "d".repeat(40), reviewed }],
    ["a merge with no second parent read", { change: { merge_state: "succeeded" }, reviewed }], ["a failure for another reason", { change: ended("grant_required"), reviewed }], ["a commit_changed that names a merge commit", { change: { ...ended("commit_changed"), merge_sha: "c".repeat(40) }, reviewed }],
  ]) check(typeof movedHeadEnding(found).problem === "string", `refused: ${title}`);
}

// ---- the review's other points ----
{
  const source = readFileSync(join(here, "m5-staging.mjs"), "utf8");
  const section = (id) => {
    const from = source.indexOf(`check("${id}"`);
    const next = source.indexOf("await check(", from + 1);
    return source.slice(from, next > 0 ? next : undefined);
  };
  // The tails start before anyone signs up.
  check(section("M5-13a").includes("podster-scanner isn't tailed") && section("M5-13").includes("lines before a tail connected") && section("M5-13").includes("sampling"), "the output says the scanner isn't tailed, and what a tail can miss");
  // Every credential the run is handed is scrubbed and looked for: agents' OAuth tokens and invitation tokens too.
  check(source.includes('secret(held?.access_token, "an agent\'s OAuth access token");') && source.includes('secret(held?.refresh_token, "an agent\'s OAuth refresh token");') && source.includes("keep(agent.provider?.tokens?.());"), "an agent's OAuth access and refresh tokens are added to the secrets when it connects");
  check(/agent\.provider\.saveTokens = \(held\) => \{\s*keep\(held\);\s*return save\(held\);/.test(source), "and again each time the SDK saves new ones after a refresh");
  check(!/secrets\.push\((?!value\))/.test(source) && (source.match(/\bsecret\([^)]*\)/g) ?? []).filter((call) => !/^secret\(value, kind\)$/.test(call)).every((call) => /, "[^"]+"\)$/.test(call)), "every credential is added with the kind it is, and none goes in without one");
  const accepts = [...source.matchAll(/\.accept\(([^,]+),/g)].map((found) => found[1]);
  check(accepts.length === 3 && accepts.every((arg) => arg === "secret(" + arg.slice(7, arg.indexOf(".token")) + ".token") && (source.match(/\.accept\(secret\(\w+\.token, "an invitation token"\)/g) ?? []).length === 3 && source.includes('{ token: secret(invited.token, "an invitation token") }') && !/[^(]\b\w+\.token\b(?=, other\.org)/.test(source), `each of the ${accepts.length + 1} invitation tokens is added to the secrets as it's used`);
  // What M5-13 prints for a hit: the Worker, the line's event name and the kind of string, from lines held in memory.
  {
    const token = `ghs_${"Z9".repeat(12)}`;
    const line = (fields) => ({ logs: [{ level: "log", message: [JSON.stringify(fields)] }], exceptions: [] });
    const needles = [{ label: "a repository token", value: token }, { label: "an agent's OAuth access token", value: "oauth-access-token-value" }, { label: "an invitation token", value: "inv_0123456789abcdef" }, { label: "the sign-up secret", value: "s".repeat(40) }, { label: "the webhook secret", value: "w".repeat(40) }, { label: "a branch name", value: "e2e/change-1" }, { label: "too short to look for", value: "e2e" }, { label: "nothing", value: undefined }];
    const clean = [{ app: "api", events: [line({ at: "provider.delivery", delivery: "d-1", room: "ws_1", outcome: "nudged" }), line({ event: "merge.pass_failed", ws: "ws_1", code: "provider_unavailable" }), { logs: null }, {}] }, { app: "gateway", events: [line({ at: "github.webhook", delivery: "d-1", outcome: "accepted" })] }];
    check(logHits(clean, needles).length === 0, "lines of IDs and codes hold nothing of the run's");
    const dirty = [
      { app: "api", events: [line({ event: "merge.pass_failed", ws: "ws_1", detail: `pushed e2e/change-1 with ${token}` }), line({ at: "provider.delivery", delivery: "d-1", outcome: "nudged" })] },
      { app: "gateway", events: [line({ at: "mcp.call", authorization: "Bearer oauth-access-token-value" }), { logs: [{ message: [`plain text with ${"s".repeat(40)}`] }], exceptions: [{ name: "Error", message: `invite inv_0123456789abcdef and ${"w".repeat(40)}` }] }] },
      { app: "web", events: [line({ at: `oauth-access-token-value`, note: "the event name itself is the token" }), { event: { request: { headers: { cookie: "s".repeat(40) } } }, logs: [], exceptions: [] }] },
    ];
    const hits = logHits(dirty, needles).map((hit) => `${hit.app} | ${hit.event} | ${hit.kind}`).sort();
    check(JSON.stringify(hits) === JSON.stringify([
      "api | merge.pass_failed | a branch name", "api | merge.pass_failed | a repository token", "api | merge.pass_failed | something shaped like a GitHub token",
      "gateway | a line with no event name | the sign-up secret", "gateway | an exception | an invitation token", "gateway | an exception | the webhook secret", "gateway | mcp.call | an agent's OAuth access token",
      "web | a line with no event name | an agent's OAuth access token",
    ]), "each hit names the Worker, the line's event name and the kind of string: a token, a secret, an invitation, a chosen name");
    const printed = JSON.stringify(logHits(dirty, needles));
    check(needles.every(({ value }) => typeof value !== "string" || value.length < 8 || !printed.includes(value)), "and never the string itself, not even when the event name is the string");
    check(!hits.some((hit) => hit.includes("too short")) && !printed.includes("cookie"), "a string under 8 characters isn't looked for, and the request beside a log line isn't searched");
    check(logHits([{ app: "api", events: [line({ at: "x", key: "-----BEGIN PRIVATE KEY-----" })] }], []).map((hit) => hit.kind).join() === "key material", "key material is found with no needle at all");
    check(section("M5-13").includes("logHits(tails.map((tail) => ({ app: tail.app, events: tail.stream.values })), needles)") && section("M5-13").includes("${hit.app}, in ${hit.event}: ${hit.kind}") && section("M5-13").includes("[...kinds].map(([value, kind]) => ({ label: kind, value }))"), "M5-13 searches every tail with every credential's kind, and prints each hit that way");
    check(section("M5-13").includes("which nothing here can tell"), "M5-13 says it can't tell whether the tail sampled");
  }
  // Clean-up names the merges the job hasn't ended.
  {
    const cleanUp = source.slice(source.indexOf("function cleanUp()"), source.indexOf('for (const signal of ["SIGINT", "SIGTERM"])'));
    check(cleanUp.includes("for (const { id, what } of mergesAsked)") && cleanUp.includes("Merges this run asked for that the job hasn't ended") && (source.match(/mergesAsked\.push\(/g) ?? []).length === 2 && source.indexOf("mergesAsked.push({ id: task.id, what: `${label} of the five") < source.indexOf('eq((await agent.must("merge_task"'), "clean-up names every merge still waiting for the job, each noted before it's asked for");
    check(source.includes("const waiting = { revoked: await approvedTask(\"revoked\"), demoted: await approvedTask(\"demoted\"), removed: await approvedTask(\"removed\") };") && !/const \[[^\]]*\bdemoted\b[^\]]*\] =/.test(source), "nothing in the five-merge step declares a `demoted` of its own over the run's flag");
    check(source.includes("unshown[ending.kind].push(id);") && source.includes("a race the run lost") && source.includes("where it can't be told which came first"), "a race lost and one that can't be told are counted apart at the end");
  }
  // Auto-merge shows nothing about the token, and says so.
  check(!PLAN.find((entry) => entry.id === "M5-06g").title.includes("auto-merge") && section("M5-06g").includes("recorded, not shown for the token: auto-merge") && !section("M5-06g").includes("refusedHere(\"auto"), "M5-06g records auto-merge as the repository's setting refusing it, and doesn't count it for the token");
  // The checks that judge nothing can't fail on what they probe.
  for (const id of ["M5-C3", "M5-C1", "M5-C8"]) {
    const body = section(id);
    const outside = body.replace(/await recorded\(seen, [^\n]*\n(?:(?:      |        )[^\n]*\n|    \}\);\n)*/g, "");
    check(body.includes("await recorded(seen,") && !/\b(eq|ok|refusedCode|refusedAs|refusedBy|mustGit|pullIn|taskIn)\(/.test(outside), `${id} records each step and asserts nothing about it`);
  }
  check(source.includes("seen.push(`${label}: not recorded (") && !section("M5-C3").includes('"victim"'), "a step that can't be made is recorded as that, and M5-C3 makes no task of its own");
  // A disconnect revokes the agent's OAuth grant and drops its link (apps/gateway/src/index.ts, revokeCredentials), so its
  // call ends as a transport's 401 or as an unclaimed agent, never as agent_disconnected. No code is promised: no answer, no token.
  check(!section("M5-07e").includes("agent_disconnected") && !section("M5-07e").includes("refusedCode(") && section("M5-07e").includes('ok(!answer.ok, "a disconnected agent\'s call was answered");') && section("M5-07e").includes('tokenless(answer, "a disconnected agent\'s call");'), "M5-07e wants no answer and no token from a disconnected agent, and names no code");
  check(section("M5-07e").indexOf("refusedByGithub(live.token") > section("M5-07e").indexOf("tokenless(answer") && !PLAN.find((entry) => entry.id === "M5-07e").title.includes("agent_disconnected"), "and then still times GitHub's refusal of the token it held");
  // The five merges: what finished is kept, and a grant leaves clean-up's list only once the audit log shows it ended.
  {
    const body = section("M5-09g");
    check(body.indexOf("batch = {") > 0 && body.indexOf("batch = {") < body.indexOf("await settledMerge(task)") && body.includes("late.push(") && body.indexOf('ok(late.length === 0') > body.indexOf("ledger.settle(id)"), "M5-09g keeps the step's state before it waits on any merge, and a merge that never ends doesn't lose the others");
    check(body.includes("for (const id of [watcherGrant.id, adminGrant.id, thirdGrant.id]) if (ended.has(id)) ledger.settle(id);") && (body.match(/ledger\.settle\(/g) ?? []).length === 1, "each of the three grants is settled only when the room's audit log shows it revoked");
    check(section("M5-12b").includes('have(b.ends.clash, "the second merge didn\'t end within the wait")') && source.includes('have(b.ends[label], "this merge didn\'t end within the wait")') && section("AC-16").includes("have(b.ends.land,"), "each check after it skips by itself if its own merge didn't end");
  }
  // The working token's hour.
  check(source.includes("await keepWorkingToken();") && source.includes("bench.expiresAt - Date.now() > RENEW_WITHIN_MS") && source.includes("const RENEW_WITHIN_MS = 10 * 60_000;") && source.includes('have(tasks.bench?.token, tasks.bench?.spent ??'), "before each check the working token is renewed once it's within ten minutes of its expiry, and one that ran out makes its checks skip with that reason");
  check(section("M5-07d").includes("bench.ended = true;") && section("M5-07d").indexOf("bench.ended = true;") < section("M5-07d").indexOf("owner.revoke(room, coder2.id)") && source.includes("bench.ended ||"), "nothing renews it once the check that ends it has begun");
  // A signal stops the flow before clean-up looks at anything.
  check(source.includes("if (stopping) throw new Halt(") && source.indexOf("if (stopping) throw new Halt(") < source.indexOf("  try {\n    tally.add(id, \"pass\"") && source.includes("Promise.race([flowDone, sleep(120_000)]).then(() => cleanUp())") && source.includes("} finally {\n  flowEnded();\n}") && source.includes("ok(!stopping, `${label}: the run was told to stop`);"), "on a signal the run halts at its next check or wait, and clean-up starts only once the flow has ended");
  check(section("M5-16a").includes('eq(await outcomeOf(one.id), "nudged"') && !section("M5-16a").includes("pr_observed_at"), "M5-16a is judged on the API's nudged line, not on a read that the routine poll makes too");
  for (const [id, read] of [["M5-16a", "await outcomeOf("], ["M5-16b", "await traced("]]) check(section(id).includes("logged();") && !section(id).includes("sleep(") && section(id).includes(read) && !section(id).includes("!== null"), `${id} needs the API's log, waits on its lines and on nothing fixed, and never passes without them`);
  check(source.includes('have(options.logs && tally.passed("M5-13a")'), "without a connected tail the two delivery checks are skipped, by name");
  const reads = [...source.matchAll(/publicRead\(`\/repos\/\$\{repo\.full\}\/commits\/\$\{([a-zA-Z.]+)\.merge_sha\}/g)].map((found) => found[1]);
  check(reads.length === 3 && reads.every((name) => source.includes(`ok(isCommitSha(${name}.merge_sha), `)), "a merge commit from Podster is checked to be 40 hex digits before it goes into a path to GitHub");
  check(isCommitSha("a".repeat(40)) && !["a".repeat(39), "A".repeat(40), `${"a".repeat(40)}/../x`, "", undefined, 7].some(isCommitSha), "only 40 lower-case hex digits are a commit ID");
  check(section("M5-07f").includes('refusedCode(answer, "grant_expired"') && section("M5-07f").includes("listed?.state === \"expired\"") && section("M5-07f").includes("refusedByGithub("), "M5-07f waits for the API to list the push grant expired, wants grant_expired, and times GitHub's refusal");
  const base = parseArgs(["--base-url", STAGING], {}).options;
  check(worstCaseSeconds(base) === 3 * 240 + 7 * 180 + 2 * 420 + 7 * 180 + 1150 && Math.round(worstCaseSeconds(base) / 60) === 87 && worstCaseSeconds({ ...base, observeWait: 10 }) === worstCaseSeconds(base) - 2 * 410 && worstCaseSeconds({ ...base, mergeWait: 10 }) === worstCaseSeconds(base) - 7 * 170, "the worst case is every bounded wait at its limit, and follows the flags");
}

// ---- the log tails, against stand-ins for wrangler ----
{
  // What a tail may see of the environment: the allow-list, and the account's ID by name. Nothing else of Cloudflare's.
  const account = "0123456789abcdef0123456789abcdef";
  const parentEnv = {
    PATH: "/usr/bin", HOME: "/home/x", PODSTER_E2E_SIGNUP_SECRET: "s", [WEBHOOK_SECRET_ENV]: "w", GITHUB_TOKEN: "g", CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_API_KEY: "k", CLOUDFLARE_EMAIL: "e@example.com",
    CLOUDFLARE_API_BASE_URL: "https://example.com", CLOUDFLARE_ENV: "production", CLOUDFLARE_ACCESS_CLIENT_SECRET: "x", CF_API_TOKEN: "t", CF_ACCOUNT_ID: account, WRANGLER_API_TOKEN: "t", WRANGLER_SEND_METRICS: "true",
  };
  const given = tailEnv(parentEnv);
  check(JSON.stringify(Object.keys(given).sort()) === JSON.stringify(["CLOUDFLARE_ACCOUNT_ID", "HOME", "PATH"]) && given.CLOUDFLARE_ACCOUNT_ID === account, "a tail gets the allow-listed names and CLOUDFLARE_ACCOUNT_ID, and nothing else");
  check(ACCOUNT_ENV === "CLOUDFLARE_ACCOUNT_ID" && Object.keys(given).filter((name) => /^(CLOUDFLARE|CF|WRANGLER)_/.test(name)).join() === "CLOUDFLARE_ACCOUNT_ID", "no other CLOUDFLARE_, CF_ or WRANGLER_ name passes: no token, key, address, base URL or environment");
  for (const name of Object.keys(parentEnv).filter((name) => /^CLOUDFLARE_/.test(name) && name !== ACCOUNT_ENV)) check(!(name in given), `${name} doesn't pass`);
  check(forbidden(ACCOUNT_ENV) && throws(() => childEnv({ [ACCOUNT_ENV]: account })), "child-env.mjs's own rule is unchanged: it still refuses the name for every other child");
  for (const [title, value] of [["unset", undefined], ["empty", ""], ["a name, not an ID", "podster"], ["too short", account.slice(1)], ["upper case", account.toUpperCase()], ["an ID with something after it", `${account}; rm -rf`]]) {
    const env = { PATH: "/usr/bin", HOME: "/home/x" };
    if (value !== undefined) env.CLOUDFLARE_ACCOUNT_ID = value;
    check(JSON.stringify(Object.keys(tailEnv(env)).sort()) === JSON.stringify(["HOME", "PATH"]), `an account ID that is ${title} isn't passed on`);
  }
  check(JSON.stringify(TAIL_ARGS) === JSON.stringify(["tail", "--env", "staging", "--format", "json"]), "a tail is `wrangler tail --env staging --format json`, and nothing more");

  // Stand-ins for wrangler, as the real one behaved against staging on 2026-11-11.
  const bins = mkdtempSync(join(tmpdir(), "m5-tails-"));
  const stand = (name, body) => {
    const file = join(bins, name);
    writeFileSync(file, `#!${process.execPath}\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  // With no account named and several on the login: exit 1 at once, listing every account by name and ID.
  const noAccount = stand("no-account", `process.stdout.write("\\n"); process.stderr.write("\\x1b[31m✘ \\x1b[41;31m[\\x1b[41;97mERROR\\x1b[41;31m]\\x1b[0m \\x1b[1mMore than one account available but unable to select one in non-interactive mode.\\x1b[0m\\n\\n  Please set the appropriate \`account_id\` in your Wrangler configuration file or assign it to the \`CLOUDFLARE_ACCOUNT_ID\` environment variable.\\n  Available accounts are (\`<name>\`: \`<account_id>\`):\\n    \`Someone's Account\`: \`${account}\`\\n    \`someone@example.com's Account\`: \`fedcba9876543210fedcba9876543210\`\\n"); process.exit(1);`);
  // On an account that hasn't the Worker.
  const wrongAccount = stand("wrong-account", `process.stderr.write("✘ [ERROR] A request to the Cloudflare API (/accounts/${account}/workers/scripts/podster-api-staging/tails) failed.\\n\\n  This Worker does not exist on your account. [code: 10007]\\n  \\n  If you think this is a bug, please open an issue\\n"); process.exit(1);`);
  // Up: nothing at all on connecting, then each event as indented JSON, until it's told to stop. It says what it was given.
  const up = stand("up", `process.on("SIGINT", () => process.exit(0)); const say = (url) => process.stdout.write(JSON.stringify({ outcome: "ok", logs: [], exceptions: [], event: { request: { url } }, args: process.argv.slice(2), account: process.env.CLOUDFLARE_ACCOUNT_ID ?? null, names: Object.keys(process.env).sort() }, null, 4) + "\\n"); setTimeout(() => say("https://api.internal/v1/public/workrooms/pub_marker-one"), 300); setInterval(() => {}, 1000);`);
  const open = (app, bin, env) => openTail({ app, bin, cwd: bins, env });

  const failing = [open("api", noAccount, tailEnv({ PATH: process.env.PATH })), open("gateway", wrongAccount, tailEnv({ PATH: process.env.PATH }))];
  const began = Date.now();
  const down = await downWithin(failing, 20);
  check(down.length === 2 && Date.now() - began < 10_000 && down.every((tail) => tail.fault === "wrangler exited with code 1"), "tails that can't start are found as soon as they've all gone, each by its exit, without waiting out the time");
  check(down[0].reason.startsWith("More than one account available but unable to select one in non-interactive mode. Please set the appropriate `account_id`") && down[1].reason.includes("This Worker does not exist on your account. [code: 10007]"), "each with what wrangler said was wrong");
  const printed = JSON.stringify(down) + refusalLines(down, {}).join("\n");
  check(!printed.includes(account) && !printed.includes("fedcba9876543210") && !printed.includes("@") && !printed.includes("Someone") && !/\x1b/.test(printed) && down[1].reason.includes("/accounts/[an ID]/"), "and never an account's ID or name, an address, or a colour code: wrangler's list of accounts is cut");
  const lines = refusalLines(down, {});
  check(lines.length === 3 && lines[0].startsWith("the log tail for apps/api didn't start: wrangler exited with code 1. wrangler said: ") && lines[2].includes("CLOUDFLARE_ACCOUNT_ID isn't set") && lines[2].includes("more than one account"), "the refusal names each tail, and says to set the account when none is named and wrangler couldn't choose");
  check(refusalLines(down, { CLOUDFLARE_ACCOUNT_ID: account }).length === 2 && refusalLines(down, { CLOUDFLARE_ACCOUNT_ID: "podster" }).at(-1).includes("isn't an account ID, so it wasn't passed on"), "it doesn't say that when the account is named, and says when what was set isn't an ID");
  check(wranglerReason("") === "wrangler said nothing about why" && wranglerReason(undefined) === "wrangler said nothing about why" && wranglerReason("x".repeat(5000)).length < 40 && wranglerReason(`✘ [ERROR] ${"y".repeat(5000)}`).length === 300, "a tail that said nothing is said as that, and a long reason is cut");

  const running = [open("api", up, tailEnv({ PATH: process.env.PATH, HOME: "/home/x", CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "t" })), open("gateway", up, tailEnv({ PATH: process.env.PATH }))];
  check((await downWithin(running, 1)).length === 0 && running.every((tail) => tailFault(tail) === null), "tails that stay up are none of them down, and the whole time is waited");
  const mixed = [running[0], open("web", wrongAccount, tailEnv({ PATH: process.env.PATH }))];
  check((await downWithin(mixed, 1)).map((tail) => tail.app).join() === "web", "with one up and one gone, only the one that's gone is named");
  // macOS adds one name of its own to every child's environment, which is the operating system's and not this run's.
  const first = running[0].stream.values[0];
  check(JSON.stringify(first?.args) === JSON.stringify(TAIL_ARGS) && first?.account === account && JSON.stringify((first?.names ?? []).filter((name) => name !== "__CF_USER_TEXT_ENCODING")) === JSON.stringify(["CLOUDFLARE_ACCOUNT_ID", "HOME", "PATH"]) && running[1].stream.values[0]?.account === null, "the child really is given the tail's arguments and the account's ID, and no token");
  check(JSON.stringify(without(running, ["marker-one"])) === "[]" && JSON.stringify(without(running, ["marker-two"])) === JSON.stringify(["api", "gateway"]) && JSON.stringify(without(running, ["marker-two", "marker-one"])) === "[]", "a tail is shown connected only by a marker it holds: any one of the markers sent");
  // A marker counts only in the path or the query of the request an event is for, read from the parsed URL.
  const event = (url, extra = {}) => ({ outcome: "ok", logs: [], exceptions: [], event: { request: { url, ...extra } } });
  check(requestHolds(event("https://api.internal/v1/public/workrooms/pub_abc123"), "abc123") && requestHolds(event("https://gateway.test/api/v1/workspaces/ws_abc123?x=1"), "abc123") && requestHolds(event("https://gateway.test/find?room=ws_abc123"), "abc123"), "a marker in a request's path or query is found");
  for (const [title, held] of [
    ["only in the host", event("https://abc123.test/v1/public/workrooms/pub_other")], ["only in the user name", event("https://abc123@gateway.test/x")], ["only in the fragment", event("https://gateway.test/x#abc123")],
    ["only in a header", event("https://gateway.test/x", { headers: { referer: "https://gateway.test/abc123" } })], ["only in a log line", { logs: [{ message: ["abc123"] }], event: { request: { url: "https://gateway.test/x" } } }],
    ["in an event with no request", { event: { rpcMethod: "getWorkroom", note: "abc123" } }], ["in a URL that isn't one", event("abc123")], ["in nothing", {}],
  ]) check(!requestHolds(held, "abc123"), `a marker ${title} isn't`);
  check(!requestHolds(event("https://gateway.test/abc123"), "") && !requestHolds(event("https://gateway.test/abc123"), undefined), "and an empty marker matches nothing");
  closeTails([...running, ...mixed]);
  await new Promise((done) => setTimeout(done, 400));
  check(running.every((tail) => tail.proc.exitCode === 0), "told to stop, a tail exits cleanly");
  rmSync(bins, { recursive: true, force: true });

  // The script: the tails are up, and shown to be, before anything is sent to staging or anyone signs up.
  const source = readFileSync(join(here, "m5-staging.mjs"), "utf8");
  const [started, stayed, refusedDown, dryExit, imported, marked, refusedUnseen, signUp] = [
    "    startTails();\n    const down = await downWithin(tails, STAY_UP_SECONDS);", "if (down.length) {", "no sign-up was taken. Fix the tails, or pass --skip-logs", 'console.log("\\nThe configuration is complete. Nothing was sent to staging or to GitHub.");',
    'await import("./lib.mjs")', "const missing = await markerInTails(60, false);", "no request of the run's own reached the log tail of", 'owner = await person("Room owner")',
  ].map((text) => source.indexOf(text));
  check(started > 0 && stayed > started && refusedDown > stayed && dryExit > refusedDown && imported > dryExit && marked > imported && refusedUnseen > marked && signUp > refusedUnseen, "in order: the tails start, must stay up, the dry run ends, and only then is staging sent the marker requests, all before the first sign-up");
  check((source.match(/startTails\(\);/g) ?? []).length === 1 && source.slice(refusedDown, dryExit).includes("process.exit(2);") && source.slice(refusedUnseen, signUp).includes("await cleanUp();\n      process.exit(2);"), "the tails are started once, and each of the two refusals stops the tails and exits 2");
  check(source.slice(started, dryExit).includes("if (options.logs)") && source.slice(started, dryExit).includes("stopTails();") && STAY_UP_SECONDS === 10, "a dry run starts the tails too, waits ten seconds on them and stops them, unless --skip-logs");
  const markers = source.slice(source.indexOf("async function markerInTails("), source.indexOf("/** Null when every tail holds a marker request"));
  check(markers.includes("`${STAGING_APP}/p/pub_${marker}`") && markers.includes("`${STAGING}/api/v1/workspaces/ws_${marker}`") && markers.indexOf("if (signedIn)") > markers.indexOf("ws_${marker}`);") && !/cookie|authorization/i.test(markers.slice(0, markers.indexOf("if (signedIn)"))), "the marker goes in a public page, which the web app's and the API's tails hold, and in a request straight to the gateway, which its tail holds: both with no credential");
  check(!source.includes("tailsBefore") && !source.includes("Not yet shown connected"), "nothing is left of carrying on with tails that weren't shown connected");
}

// ---- two races the last review found ----
{
  const source = readFileSync(join(here, "m5-staging.mjs"), "utf8");
  const section = (id) => source.slice(source.indexOf(`check("${id}"`), source.indexOf("await check(", source.indexOf(`check("${id}"`) + 1));
  const seen = section("M5-08b").indexOf("(c) => c.observed_head_sha === next");
  check(seen > 0 && section("M5-08b").includes("within(options.observeWait,") && seen < section("M5-08b").indexOf("advance = { task, next };"), "M5-08b ends only once Podster has seen the pushed head, so no later check that compares the change with itself can catch it mid-way");
  const body = section("M5-07c");
  check(body.includes('.task.status === "completed"') && body.indexOf('have(done, "the second coder has no task that reads as completed")') > 0 && body.indexOf("have(done,") < body.indexOf('taskIn(first(), "cancel"') && !body.includes("tasks.land ?? tasks.late"), "M5-07c finds a task that reads as completed before it makes or asks for anything, and skips without one");
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
  // Only where an install is missing: there the script refuses before it starts a tail. Where all three are installed
  // a dry run starts real tails, which asks Cloudflare, and this test asks nobody. The tails are tested below, against stand-ins.
  if (missing.length) {
    const tailed = run(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret });
    check(tailed.status === 2 && missing.every((app) => tailed.stderr.includes(`apps/${app}`)) && tailed.stderr.includes("--skip-logs") && !tailed.stdout.includes("Nothing was sent") && !tailed.stdout.includes("log tails started"), `with the logs on, a dry run refuses before starting any tail, naming the ${missing.length} app(s) with no wrangler installed`);
  } else console.log("ok   (every app has its wrangler here, so the logs-on dry run isn't run by this test: it would start real tails)");
}

rmSync(fixtures, { recursive: true, force: true });

console.log(failed ? `\n${failed} failed` : "\nM5 staging self-test: all passed");
process.exit(failed ? 1 : 0);
