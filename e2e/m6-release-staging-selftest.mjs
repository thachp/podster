// Checks the parts of M6's release-on staging run that need no network: its arguments, the one host it accepts, what it
// refuses to start without, its plan and exit code, and how it judges a content host's answers and a task's release
// status. Then the script itself: --help, dry runs, which send nothing, and runs against m6-release-staging-standin.mjs,
// which answers every request on this machine, for each way it refuses before it has anything to check.
//
//   npm ci          (once, in this directory: the script itself imports lib.mjs's packages)
//   node m6-release-staging-selftest.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTENT_DOMAIN, contentNotFoundProblem, GRANT_LOST_CODE, defaultHostProblem, deployGrantProblem, EXIT, fixedHeaderProblems, HOST_CHANGE_SECONDS, KV_CACHE_SECONDS, LABEL, markerBody, markerProblem, markerWaitState, maskedPath, parseArgs, PLAN, REFUSED_SITE, resultUrlProblem, runOutcome, SIGN_UPS, SITE, STAGING,
  stateAfterUnpublish, statusProblems, Tally, unknownLabel, WAITS,
} from "./m6-release-staging-lib.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node m6-release-staging-selftest.mjs

Checks M6's release-on staging run without the network: its arguments, its refusals, its plan and exit code, how it
judges answers, a dry run and runs against m6-release-staging-standin.mjs. Run npm ci in this directory once first.
It takes no options and sends nothing anywhere.`);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const missing = ["@auth/agent", "@modelcontextprotocol/sdk/client/index.js"].filter((name) => {
  try {
    import.meta.resolve(name);
    return false;
  } catch {
    return true;
  }
});
if (missing.length) {
  console.error(`m6-release-staging-selftest: e2e's packages aren't installed (${missing.join(", ")} not found). Run npm ci in e2e first. No case was run.`);
  process.exit(2);
}

let failed = 0;
const check = (passed, title) => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}`);
};

// ---- arguments ----

{
  const good = parseArgs(["--base-url", STAGING]);
  check(good.options?.base === STAGING && good.options.releaseWait === 300, "staging's gateway is accepted, with the default waits");
  check(Boolean(parseArgs(["--base-url", "https://gateway.podster.dev"]).error), "another host is refused");
  check(Boolean(parseArgs(["--base-url", `${STAGING}/api`]).error), "staging with a path is refused");
  check(Boolean(parseArgs(["--base-url", STAGING, "--nope"]).error), "an unknown flag is refused");
  check(Boolean(parseArgs(["--base-url", STAGING, "--release-wait"]).error), "a flag with no value is refused");
  check(Boolean(parseArgs(["--base-url", STAGING, "--release-wait", "5"]).error) && Boolean(parseArgs(["--base-url", STAGING, "--release-wait", "1801"]).error), "a wait outside 10 to 1800 seconds is refused");
  check(parseArgs(["--base-url", STAGING, "--takedown-wait", "60"]).options?.takedownWait === 60, "a wait in bounds is taken");
  check(Boolean(parseArgs([]).error) && parseArgs([], { PODSTER_E2E_BASE_URL: STAGING }).options?.base === STAGING, "the base URL comes from the flag or the environment, never a default");
  check(parseArgs(["--help"]).options?.help === true, "--help needs nothing else");
}

// ---- what it refuses to start without ----

const contract = readFileSync(join(here, "../packages/contracts/openapi.yaml"), "utf8");
// The grant route's action list, whichever actions this checkout's contract gives it. Both fixtures are made from it,
// so the gate is shown both ways whatever the checkout holds.
const GRANT_ACTIONS = /action: \{ type: string, enum: \[push, merge(?:, deploy)?\] \}, expires_at/;
const withDeploy = contract.replace(GRANT_ACTIONS, "action: { type: string, enum: [push, merge, deploy] }, expires_at");
const withoutDeploy = contract.replace(GRANT_ACTIONS, "action: { type: string, enum: [push, merge] }, expires_at");
{
  check(GRANT_ACTIONS.test(contract) && withDeploy !== withoutDeploy, "the contract's grant route is read where this self-test expects it");
  check(deployGrantProblem(contract) === null, "this checkout's contract gives a deploy grant on the grant route");
  const missing = deployGrantProblem(withoutDeploy);
  check(typeof missing === "string" && missing.includes("no route gives a deploy grant"), "a contract whose grant route takes push and merge only is refused, and the run says so");
  check(deployGrantProblem(withDeploy) === null, "a contract whose grant route takes deploy is accepted");
  check(typeof deployGrantProblem(null) === "string", "an unreadable contract is refused");
  check(typeof deployGrantProblem("openapi: 3.1.0\npaths: {}\n") === "string", "a contract without the grant route is refused");
  // Only the grant route's own action list counts: deploy named on another route isn't a deploy grant.
  check(typeof deployGrantProblem(`${withoutDeploy}\n  /v1/elsewhere:\n    post:\n      requestBody: { schema: { properties: { action: { type: string, enum: [deploy] } } } }\n`) === "string", "deploy listed on another route isn't taken for the grant route's");
}

{
  const sandbox = [["content-security-policy", "sandbox allow-scripts; default-src https://x.podster.site"]];
  check(contentNotFoundProblem({ status: 404, body: "not_found\n", headers: sandbox }) === null, "the content Worker's not found is recognised");
  check(contentNotFoundProblem({ status: 200, body: "not_found\n", headers: sandbox }) !== null, "a 200 isn't a not found");
  check(contentNotFoundProblem({ status: 404, body: "Not Found", headers: sandbox }) !== null, "another body isn't the content Worker's");
  check(contentNotFoundProblem({ status: 404, body: "not_found", headers: [] }) !== null, "an answer without the sandbox isn't the content Worker's");
  check(contentNotFoundProblem({ status: 404, body: "not_found", headers: [...sandbox, ["set-cookie", "a=b"]] }) !== null, "an answer that sets a cookie is refused");
  check(LABEL.test(unknownLabel(new Uint8Array(26).map((_, i) => i * 7))), "an unknown label has an app label's shape");
}

// ---- judging hosts, markers and statuses ----

{
  const label = "abcdefghijklmnopqrstuvwxyz";
  const host = `${label}.${CONTENT_DOMAIN}`;
  check(defaultHostProblem(host).problem === null && defaultHostProblem(host).label === label, "an app's default host is accepted, with its label");
  check(defaultHostProblem(`${label}.podster.dev`).problem !== null, "a host under podster.dev is refused");
  check(defaultHostProblem(`${label}.example.com`).problem !== null, "a host on another domain is refused");
  check(defaultHostProblem(`a.${label}.${CONTENT_DOMAIN}`).problem !== null && defaultHostProblem(`short.${CONTENT_DOMAIN}`).problem !== null, "a host two labels deep, or with a label of the wrong shape, is refused");
  check(defaultHostProblem(null).problem !== null, "no host is refused");
  check(resultUrlProblem(`https://${host}/`, host) === null && resultUrlProblem(`http://${host}/`, host) !== null, "the result URL must be the host's own HTTPS root");
  const rel = `rel_${"a".repeat(32)}`;
  const sha = "b".repeat(40);
  check(markerBody(rel, sha) === `{"release_id":"${rel}","commit":"${sha}"}\n`, "the marker is what the release job writes");
  check(markerProblem({ status: 200, body: markerBody(rel, sha) }, rel, sha) === null, "the right marker passes");
  check(markerProblem({ status: 200, body: markerBody(rel, "c".repeat(40)) }, rel, sha) !== null && markerProblem({ status: 404, body: "" }, rel, sha) !== null, "another commit's marker, or none, fails");
  const handle = readFileSync(join(here, "../apps/content/src/handle.ts"), "utf8");
  check(handle.match(/^export const KV_CACHE_SECONDS = (\d+);$/m)?.[1] === String(KV_CACHE_SECONDS), "the edge cache the waits are sized from is the content Worker's KV_CACHE_SECONDS");
  check(WAITS["--takedown-wait"][1] >= HOST_CHANGE_SECONDS + 30, "the default host wait outlasts the edge cache and KV's propagation, with margin");
  check(markerWaitState({ status: 200, body: markerBody(rel, sha) }, rel, sha) === "named", "a re-served host's marker naming the new release ends the wait");
  check(["", "not_found"].every((body) => markerWaitState({ status: 404, body }, rel, sha) === "waiting") && markerWaitState({ status: 502, body: "" }, rel, sha) === "waiting", "a cached not found, or another error, is waited out");
  check(markerWaitState({ status: 200, body: markerBody(`rel_${"d".repeat(32)}`, sha) }, rel, sha) === "another" && markerWaitState({ status: 200, body: markerBody(rel, "c".repeat(40)) }, rel, sha) === "another", "a served marker naming an old release, or another commit, is never waited out");
  check(stateAfterUnpublish("served") === "unpublished" && stateAfterUnpublish("live") === "unpublished", "a served or live release ends unpublished");
  check(["queued", "uploading", "uncertain"].every((state) => stateAfterUnpublish(state) === "failed"), "a release still on its way ends failed");
  check(["declined", "failed", "replaced", "unpublished"].every((state) => stateAfterUnpublish(state) === state), "an ended release stays as it ended");
  check(stateAfterUnpublish("awaiting_approval") === null && stateAfterUnpublish(undefined) === null, "a release awaiting approval, or none, isn't judged");
  check(maskedPath(`https://${host}/.well-known/podster-release.json`) === `https://[app host].${CONTENT_DOMAIN}/.well-known/podster-release.json` && !maskedPath(`https://${host}/`).includes(label), "request lines never name an app's label");
  check(maskedPath(`${STAGING}/api/v1/me?x=1`) === "/api/v1/me", "request lines carry no query");
  const fixed = [["referrer-policy", "no-referrer"], ["x-content-type-options", "nosniff"], ["strict-transport-security", "max-age=31536000; includeSubDomains"], ["content-security-policy", "sandbox allow-scripts; default-src https://x"]];
  check(fixedHeaderProblems(fixed).length === 0, "the content Worker's fixed headers pass");
  check(fixedHeaderProblems(fixed.slice(1)).length === 1 && fixedHeaderProblems([...fixed, ["set-cookie", "a=b"]]).length === 1, "a missing fixed header, or a cookie, fails");

  const status = (release) => ({ task_id: "tsk_1", linked: true, pull_request: null, checks: { commit_sha: null, state: null, counts: null, observed_at: null }, merge: { state: "succeeded", reason: null, observed_at: 5, sha, requested_by: "per_1" }, release });
  const served = { exists: true, release_id: rel, commit_sha: sha, state: "served", observed_at: 6, failure_code: null, served: true, result_url: `https://${host}/` };
  const failedRelease = { ...served, state: "failed", failure_code: "release_refused_name", served: false, result_url: null };
  const want = (release) => ({ taskId: "tsk_1", mergeSha: sha, release });
  check(statusProblems(status({ exists: false }), want("none")).length === 0, "a task with nothing asked for reads { exists: false }");
  check(statusProblems(status(served), want("none")).length === 1, "a release where none was asked for fails");
  check(statusProblems(status(served), want({ id: rel, state: "served", served: true })).length === 0, "a served release passes");
  check(statusProblems(status(failedRelease), want({ id: rel, state: "failed", served: false, failed: true })).length === 0, "a failed release with its reason code passes");
  check(statusProblems(status({ ...failedRelease, failure_code: null }), want({ id: rel, state: "failed", served: false, failed: true })).length > 0, "a failure without a reason code fails");
  check(statusProblems(status({ ...failedRelease, result_url: `https://${host}/` }), want({ id: rel, state: "failed", served: false, failed: true })).length > 0, "a failed release with a result URL fails: no false success");
  check(statusProblems({ ...status(served), merge: { state: "requested", observed_at: 5, sha: null } }, want({ id: rel, state: "served", served: true })).length > 0, "a merge not reported succeeded fails");
  check(statusProblems({ ...status(served), checks: null }, want({ id: rel, state: "served", served: true })).length > 0, "checks not reported on their own fail");
  check(statusProblems(status({ ...served, observed_at: null }), want({ id: rel, state: "served", served: true })).length > 0, "a release without its own time fails");
}

{
  const core = readFileSync(join(here, "../crates/core/src/release.rs"), "utf8");
  const spec = readFileSync(join(here, "../apps/api/test/release-approval.spec.ts"), "utf8");
  check(core.includes(`RecheckFailure::RequesterLostAuthority => "${GRANT_LOST_CODE}"`) && /requester's grant was revoked.*"requester_lost_authority"/.test(spec), "AC-13's code is core's, and the API's approval test names it for a revoked grant");
}

// ---- the plan and the exit code ----

{
  const ids = PLAN.map((entry) => entry.id);
  check(new Set(ids).size === ids.length, "every check's ID is its own");
  const outside = PLAN.filter((entry) => entry.outOfScope).map((entry) => entry.id);
  check(JSON.stringify(outside) === JSON.stringify(["M6-X14", "M6-X15", "M6-X26", "M6-X13"]), "custom domains and apps with code are the only out-of-scope checks");
  const gate = ["AC-05", "AC-10", "AC-11", "AC-13", "AC-16", "AC-17", "UI-02", "criterion 3", "M6-12", "M6-16", "M6-19", "M6-01"];
  check(gate.every((name) => PLAN.some((entry) => !entry.outOfScope && entry.title.includes(name))), "every gate item the brief names has an in-scope check");
  const run = (results) => {
    const tally = new Tally(PLAN, () => {});
    for (const entry of PLAN) tally.add(entry.id, results(entry), "");
    return runOutcome(tally, PLAN);
  };
  check(run((entry) => (entry.outOfScope ? "skip" : "pass")).code === 0, "every in-scope check passed and the out-of-scope ones skipped: exit 0");
  const oneSkip = run((entry) => (entry.outOfScope || entry.id === "M6-R09" ? "skip" : "pass"));
  check(oneSkip.code === 1 && JSON.stringify(oneSkip.unshown) === JSON.stringify(["M6-R09"]), "an in-scope SKIP fails the run, named");
  check(run((entry) => (entry.outOfScope ? "skip" : entry.id === "M6-R11" ? "fail" : "pass")).code === 1, "a failure fails the run");
  check(run((entry) => (entry.outOfScope ? "skip" : "pass")).outOfScope.length === 4, "out-of-scope checks are listed apart");
  check(SIGN_UPS.length === 4, "the run plans 4 takes of the test sign-up");
  check(Object.keys(SITE).every((path) => path.startsWith("site/")) && Object.keys(REFUSED_SITE).some((path) => path.endsWith("/_headers")), "the site is under site/, and the failing commit adds _headers");
  check(EXIT.releaseNotOn === 3 && EXIT.refused === 2, "exit 3 is release not on, exit 2 a refusal");
}

// ---- the script's source ----

{
  const source = readFileSync(join(here, "m6-release-staging.mjs"), "utf8");
  check(/spawn\("git", \[[^\]]*\], \{ cwd, env: gitEnv\(/.test(source) && (source.match(/spawn\(/g) ?? []).length === 1, "the one child process it starts is git, with gitEnv's environment");
  check(!/api\.cloudflare\.com|wrangler|gh run/.test(source), "it calls no Cloudflare API, no wrangler and no gh run");
  check(source.includes("publisher.stop()") && source.includes("takeBack(id)") && source.includes("/disconnect"), "clean-up makes the room private, takes grants back and disconnects the agent");
}

// ---- the script itself ----

const scratch = mkdtempSync(join(tmpdir(), "m6-release-selftest-"));
const fixture = join(scratch, "openapi.yaml");
writeFileSync(fixture, withDeploy);
const noGrant = join(scratch, "openapi-no-deploy.yaml");
writeFileSync(noGrant, withoutDeploy);
const SECRET = "x".repeat(40);
/** Runs the script, with the stand-in in `mode` when given. Answers its exit code, its output and the stand-in's counts. */
function script(args, { mode, secret = SECRET } = {}) {
  const env = { PATH: process.env.PATH, HOME: scratch, ...(secret ? { PODSTER_E2E_SIGNUP_SECRET: secret } : {}), ...(mode ? { M6_RELEASE_STANDIN: mode } : {}) };
  const preload = mode ? ["--import", join(here, "m6-release-staging-standin.mjs")] : [];
  const done = spawnSync(process.execPath, [...preload, join(here, "m6-release-staging.mjs"), ...args], { cwd: here, env, encoding: "utf8", timeout: 60_000 });
  const out = `${done.stdout}${done.stderr}`;
  const counted = out.match(/stand-in: (\d+) requests, (\d+) sign-ups, (\d+) sign-outs/);
  return { code: done.status, out, requests: counted ? Number(counted[1]) : null, signUps: counted ? Number(counted[2]) : null, signOuts: counted ? Number(counted[3]) : null };
}
const base = ["--base-url", STAGING];
try {
  {
    const help = script(["--help"], { secret: null });
    check(help.code === 0 && /^Usage:/m.test(help.out), "--help prints the usage and exits 0");
    const bad = script(["--base-url", "https://example.com"]);
    check(bad.code === EXIT.refused, "another host exits 2");
  }
  {
    const today = script([...base, "--dry-run"], { mode: "edge-down" });
    check(today.code === 0 && !today.out.includes("no route gives a deploy grant") && today.requests === 0, "a dry run on this checkout's contract gets past the deploy grant's gate, exits 0 and sends nothing");
    const missingGrant = script([...base, "--dry-run", "--contract", noGrant], { mode: "edge-down" });
    check(missingGrant.code === EXIT.releaseNotOn && missingGrant.out.includes("no route gives a deploy grant") && missingGrant.requests === 0, "a dry run on a contract without the deploy grant exits 3, naming it, and sends nothing");
    const dry = script([...base, "--dry-run", "--contract", fixture], { mode: "edge-down" });
    check(dry.code === 0 && dry.out.includes("Nothing was sent") && dry.requests === 0, "a dry run with a contract that gives the grant exits 0 and sends nothing");
    check(PLAN.every((entry) => dry.out.includes(entry.id)) && dry.out.includes("[out of scope: custom domains"), "the dry run prints every check, out-of-scope ones marked");
    const noSecret = script([...base, "--dry-run", "--contract", fixture], { mode: "edge-down", secret: null });
    check(noSecret.code === EXIT.refused && noSecret.requests === 0, "a dry run without the sign-up secret exits 2");
    const real = script([...base, "--contract", noGrant], { mode: "edge-down", secret: null });
    check(real.code === EXIT.releaseNotOn && real.requests === 0, "a real run on a contract without the deploy grant is refused before anything is sent");
    const checkout = script([...base], { mode: "off" });
    check(checkout.code === EXIT.releaseNotOn && checkout.signUps === 0 && checkout.out.includes("deploy_release"), "a real run on this checkout's contract stops at the next gate, release on: exit 3, no sign-up");
  }
  {
    const down = script([...base, "--contract", fixture], { mode: "edge-down" });
    check(down.code === EXIT.refused && down.signUps === 0 && down.out.includes("No sign-up was taken"), "an edge that answers 502 fails the preflight: exit 2, no sign-up");
    const off = script([...base, "--contract", fixture], { mode: "off" });
    check(off.code === EXIT.releaseNotOn && off.signUps === 0 && off.out.includes("deploy_release"), "release off on staging: exit 3, no sign-up, naming deploy_release");
    const noContent = script([...base, "--contract", fixture], { mode: "no-content" });
    check(noContent.code === EXIT.releaseNotOn && noContent.signUps === 0 && noContent.out.includes(CONTENT_DOMAIN), "no content Worker on the content domain: exit 3, no sign-up");
    const notAvailable = script([...base, "--contract", fixture], { mode: "not-available" });
    check(notAvailable.code === EXIT.releaseNotOn && notAvailable.signUps === 1 && notAvailable.signOuts === 1 && notAvailable.out.includes("release_not_available"), "a provider with the release path incomplete: exit 3 after the owner's sign-up alone, signed out");
    check(!notAvailable.out.includes(SECRET) && !/podster_session=s{10}/.test(notAvailable.out), "neither the sign-up secret nor the session reaches the output");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} case(s) failed.` : "\nm6-release-staging-selftest: every case passed.");
process.exit(failed ? 1 : 0);
