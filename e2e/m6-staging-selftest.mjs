// Checks the parts of M6's staging run that need no network: which host it accepts, its arguments, its exit code, which
// operations and fields it reads from the contract as M6's, how two answers are compared and what the API must have
// answered, and what counts as an M6 name or event. Then the script itself: as a dry run, which sends nothing; against
// m6-staging-standin.mjs, which answers every request on this machine; and what its source does and doesn't do. M6-S04's
// two phases are checked the same way: their arguments, their kept file and its refusals, and both phases run against
// the stand-in, one process after the other, as they'd run around a deploy.
//
//   npm ci          (once, in this directory: the script itself imports lib.mjs's packages)
//   node m6-staging-selftest.mjs
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ABSENT_ROOM, agentCapabilities, answerShape, CALLERS, COMPARED_HEADERS, differences, edgeRefusal, expectedAnswer, fillPath, KEPT_KIND, KEPT_MARGIN_SECONDS, keptFile, keptProblem, keptRecord, M6_EVENT, m6EventTypes, m6Fields, m6Keys, m6Names, m6Operations, mcpErrorProblem, neighbour,
  operationsProblem, pairProblem, parseArgs, personOnly, PHASE_PLANS, PHASE_SIGN_UPS, PLAN, PLANNED_TOOLS, planFor, QUEUE_KEYS, queueRefusalProblem, requestLine, requestPath, runOutcome, schemas, scrub, secretProblem, SESSION_SECONDS, SIGN_UPS, slowestLine, snake, STAGING, stagingOnly, Tally, toolAnswer, toolNotFound,
} from "./m6-staging-lib.mjs";
import { readKept, removeKept, writeKept } from "./m6-staging-kept.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// The runs below start m6-staging.mjs, which imports lib.mjs and with it this directory's packages. Without `npm ci` here
// every run fails on its import, and the cases read as the script's own failures. So the packages are found first, the
// way the script finds them, and their absence is said once and stops everything: exit 2, no case run.
const missing = ["@auth/agent", "@modelcontextprotocol/sdk/client/index.js"].filter((name) => {
  try {
    import.meta.resolve(name);
    return false;
  } catch {
    return true;
  }
});
if (missing.length) {
  console.error(`m6-staging-selftest: e2e's packages aren't installed (${missing.join(", ")} not found). Run npm ci in e2e first. No case was run.`);
  process.exit(2);
}

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

// ---- the one host, and arguments ----
check(stagingOnly(STAGING) === null && STAGING === "https://gateway-staging.podster.dev", "staging's gateway, and only it, is the host");
for (const other of ["https://gateway.podster.dev", "https://app-staging.podster.dev", "http://localhost:8787", "https://gateway-staging.podster.dev/api", "https://gateway-staging.podster.dev.example.com", ""]) check(typeof stagingOnly(other) === "string", `refused: ${other || "(empty)"}`);
const args = (...argv) => parseArgs(argv, {});
check(args("--base-url", STAGING).options?.base === STAGING && parseArgs([], { PODSTER_E2E_BASE_URL: STAGING }).options?.base === STAGING, "--base-url, or PODSTER_E2E_BASE_URL, takes staging");
check(Boolean(parseArgs([], {}).error) && Boolean(args("--base-url", "https://gateway.podster.dev").error), "no base URL, or another one, is refused");
check(args("--base-url", STAGING).options.dryRun === false && args("--dry-run", "--base-url", STAGING).options.dryRun === true, "--dry-run is off unless given");
check(Boolean(args("--base-url", STAGING, "--force").error) && Boolean(args("--base-url").error) && Boolean(args("--base-url", "--dry-run").error) && Boolean(args("--base-url", STAGING, "--contract").error), "an unknown flag and a missing value are refused: nothing is guessed");
check(args("--base-url", STAGING, "--contract", "a.yaml", "--capabilities", "b.yaml").options.contract === "a.yaml" && args("--base-url", STAGING, "--contract", "a.yaml", "--capabilities", "b.yaml").options.capabilities === "b.yaml", "--contract and --capabilities name their files");
check(args("--help").options?.help === true, "--help needs nothing else");
check(secretProblem(undefined) !== null && secretProblem("short") !== null && secretProblem("x".repeat(32)) === null, "the sign-up secret must be set and at least 32 characters");
check(SIGN_UPS.length === 2, "a run takes 2 test sign-ups, no more");

// ---- M6-S04's two phases: arguments, plans and the kept record ----
{
  const commit = "c".repeat(40);
  const before = args("--base-url", STAGING, "--before-deploy", "--deployed-commit", commit).options;
  const after = args("--base-url", STAGING, "--after-deploy", "--deployed-commit", commit).options;
  check(before?.phase === "before" && after?.phase === "after" && before.deployedCommit === commit && args("--base-url", STAGING).options.phase === null, "--before-deploy and --after-deploy pick a phase; the usual run has none");
  check(Boolean(args("--base-url", STAGING, "--before-deploy").error) && Boolean(args("--base-url", STAGING, "--after-deploy").error), "a phase needs --deployed-commit");
  check(Boolean(args("--base-url", STAGING, "--deployed-commit", commit).error), "--deployed-commit alone is refused");
  check(Boolean(args("--base-url", STAGING, "--before-deploy", "--after-deploy", "--deployed-commit", commit).error), "both phases at once are refused");
  for (const bad of ["c".repeat(7), "C".repeat(40), "g".repeat(40), "c".repeat(64), `${"c".repeat(40)} `]) check(Boolean(args("--base-url", STAGING, "--after-deploy", "--deployed-commit", bad).error), `--deployed-commit must be a full commit: refused ${JSON.stringify(bad.slice(0, 12))}`);
  check(JSON.stringify(PHASE_SIGN_UPS.before.length) === "1" && PHASE_SIGN_UPS.after.length === 0, "the first phase takes 1 test sign-up and the second none");
  const phaseIds = [...PHASE_PLANS.before, ...PHASE_PLANS.after].map((e) => e.id);
  check(JSON.stringify(phaseIds) === JSON.stringify(["M6-S04a", "M6-S04b", "M6-S04c", "M6-S04d", "M6-S04e"]) && !phaseIds.some((id) => PLAN.some((entry) => entry.id === id)), "the phases' checks are M6-S04a to M6-S04e, none of them the usual run's");
  check([...PHASE_PLANS.before, ...PHASE_PLANS.after].every((e) => !e.offline && !e.maySkip), "no phase check reads the checkout alone, and none may say SKIP");
  check(planFor(null) === PLAN && planFor("before") === PHASE_PLANS.before && planFor("after") === PHASE_PLANS.after, "each run follows its own plan");
  const phaseTally = (plan, results) => {
    const tally = new Tally(plan, () => {});
    for (const [id, status] of results) tally.add(id, status, "");
    tally.skipRest("x");
    return tally;
  };
  check(runOutcome(phaseTally(PHASE_PLANS.after, PHASE_PLANS.after.map((e) => [e.id, "pass"])), PHASE_PLANS.after).code === 0 && runOutcome(phaseTally(PHASE_PLANS.after, [["M6-S04b", "pass"]]), PHASE_PLANS.after).code === 1, "a phase exits 0 only when every one of its checks passed: a skip is unshown");
  check(runOutcome(phaseTally(PHASE_PLANS.before, [["M6-S04a", "fail"]]), PHASE_PLANS.before).code === 1, "a first phase that failed exits 1");

  const gateway = readFileSync(join(here, "../apps/gateway/src/test-people.ts"), "utf8");
  check(/export const TEST_SESSION_SECONDS = 2 \* 60 \* 60;/.test(gateway) && SESSION_SECONDS === 2 * 60 * 60, "the kept session's life is the gateway's TEST_SESSION_SECONDS");
  check(/So a test person can't be signed in to again/.test(gateway) && /stable === "operator"/.test(gateway), "the test sign-up signs no test person in again but the fixed operator, which the phases never ask for: so the first phase keeps its session");
  check(keptFile("/home/x") === "/home/x/.podster/m6-staging/s04.json", "the kept file is under the runner's home, outside the repository");
  const now = 1_800_000_000_000;
  const fresh = keptRecord({ commit, signedUpAt: now - 60_000, owner: "per_a", org: "org_b", room: "ws_c", task: "tsk_d", eventsSeen: 4, lastSeq: 4 }, "__Secure-better-auth.session_token=abcdefghijklmnop");
  const next = "d".repeat(40);
  check(fresh.kind === KEPT_KIND && fresh.base === STAGING && fresh.stale_at === now - 60_000 + (SESSION_SECONDS - KEPT_MARGIN_SECONDS) * 1000, "the kept record names the script, staging, and when it goes stale");
  check(!JSON.stringify(fresh).includes("s".repeat(32)) && Object.keys(fresh).sort().join() === "base,deployed_commit,events_seen,kind,last_seq,org,owner,room,session,signed_up_at,stale_at,task", "it holds the session, IDs, the commit, times and an event count, and nothing else");
  check(keptProblem(fresh, { now, commit: next }) === null, "a fresh record, with staging at another commit, is usable");
  check(/still at/.test(keptProblem(fresh, { now, commit }) ?? ""), "the same commit is refused: nothing was deployed");
  check(/stale/.test(keptProblem(fresh, { now: fresh.stale_at, commit: next }) ?? "") && keptProblem(fresh, { now: fresh.stale_at - 1, commit: next }) === null, `it's stale ${KEPT_MARGIN_SECONDS / 60} minutes before the session ends`);
  for (const [label, change] of [
    ["another kind", { kind: "x" }], ["another host", { base: "https://gateway.podster.dev" }], ["a short commit", { deployed_commit: "abc" }], ["a moved stale time", { stale_at: fresh.stale_at + 1 }], ["a time in the future", { signed_up_at: now + 1000, stale_at: now + 1000 + (SESSION_SECONDS - KEPT_MARGIN_SECONDS) * 1000 }],
    ["an ID out of shape", { room: "../x" }], ["no session", { session: "" }], ["no event count", { events_seen: 0 }], ["a sequence below the count", { last_seq: 1 }],
  ]) check(typeof keptProblem({ ...fresh, ...change }, { now, commit: next }) === "string", `a kept record with ${label} is refused`);
  check(typeof keptProblem(null, { now, commit: next }) === "string" && typeof keptProblem("x", { now, commit: next }) === "string", "something that isn't a record is refused");
}

// ---- the kept file, on disk ----
{
  const home = mkdtempSync(join(tmpdir(), "podster-m6-kept-"));
  try {
    const file = keptFile(home);
    check(readKept(file).missing === true, "no file reads as missing");
    writeKept(file, { a: 1 });
    check((statSync(file).mode & 0o777) === 0o600 && (statSync(dirname(file)).mode & 0o777) === 0o700, "it's written at mode 0600, in a directory at 0700");
    check(readKept(file).record?.a === 1, "and read back");
    check(throws(() => writeKept(file, { a: 2 })) && readKept(file).record?.a === 1, "a file already there is never overwritten");
    let refusal = "";
    try {
      writeKept(file, { a: 3 });
    } catch (error) {
      refusal = String(error.message);
    }
    check(/a file is already there/.test(refusal) && !refusal.includes(home) && !refusal.includes(".podster"), `the refusal says why without naming the path: ${refusal}`);
    check(JSON.stringify(readdirSync(dirname(file))) === JSON.stringify(["s04.json"]), "the temporary file is gone after a write, and after a refused one");
    chmodSync(file, 0o644);
    check(/read by others/.test(readKept(file).problem ?? ""), "a file others can read is refused");
    chmodSync(file, 0o600);
    chmodSync(dirname(file), 0o755);
    check(/opened by others/.test(readKept(file).problem ?? "") && throws(() => writeKept(join(dirname(file), "other.json"), {})), "a directory others can open is refused, for reading and writing");
    chmodSync(dirname(file), 0o700);
    writeFileSync(join(dirname(file), "target.json"), "{}", { mode: 0o600 });
    removeKept(file);
    symlinkSync(join(dirname(file), "target.json"), file);
    check(/link/.test(readKept(file).problem ?? "") && throws(() => writeKept(file, {})), "a link in its place is refused, and not written through");
    removeKept(file);
    writeFileSync(file, "not json", { mode: 0o600 });
    check(/JSON/.test(readKept(file).problem ?? ""), "a file that isn't JSON is refused");
    check(removeKept(file) && readKept(file).missing === true, "it's deleted");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ---- the plan, the tally and the exit code ----
// ---- M6-S02e: the operators' report list, as a test person sees it ----
{
  const refusal = { status: 403, code: "not_allowed", body: { error: { code: "not_allowed", message: "not_allowed" } } };
  check(queueRefusalProblem(refusal) === null, "M6-S02e: M4's refusal, 403 not_allowed with only an error, passes");
  check(JSON.stringify(QUEUE_KEYS) === JSON.stringify(["kind", "host"]), "M6-S02e looks for step 9's two keys, kind and host");
  for (const [label, answer] of [
    ["an operator's answer, as if a test person were one", { status: 200, code: undefined, body: { reports: [], next_cursor: null } }],
    ["another refusal", { status: 404, code: "not_found", body: { error: { code: "not_found" } } }],
    ["403 with another code", { status: 403, code: "access_revoked", body: { error: { code: "access_revoked" } } }],
    ["a refusal carrying kind", { ...refusal, body: { error: { code: "not_allowed", kind: "app" } } }],
    ["a refusal carrying a host, deep", { ...refusal, body: { error: { code: "not_allowed", detail: [{ host: "a.example.com" }] } } }],
    ["a refusal carrying reports", { ...refusal, body: { error: { code: "not_allowed" }, reports: [] } }],
    ["no answer at all", undefined],
  ]) check(typeof queueRefusalProblem(answer) === "string", `M6-S02e fails on ${label}`);
  check(PLAN.find((entry) => entry.id === "M6-S02e")?.title.includes("can't show the operator's own view") === true, "M6-S02e's title says what test people can't show");
}

const ids = PLAN.map((entry) => entry.id);
check(new Set(ids).size === ids.length && ids.every((id) => /^M6-S0[0-9][a-z]?$/.test(id)) && PLAN.every((entry) => entry.title.length > 0), "every check has one stable M6-S0x ID and a title");
check(JSON.stringify(PLAN.filter((e) => e.offline).map((e) => e.id)) === JSON.stringify(["M6-S00"]) && JSON.stringify(PLAN.filter((e) => e.maySkip).map((e) => e.id)) === JSON.stringify(["M6-S04"]), "only M6-S00 reads this checkout alone, and only M6-S04 may say SKIP");
const tallyOf = (results) => {
  const tally = new Tally(PLAN, () => {});
  for (const [id, status] of results) tally.add(id, status, "");
  tally.skipRest("x");
  return tally;
};
const staging = PLAN.filter((e) => !e.offline && !e.maySkip).map((e) => e.id);
check(runOutcome(tallyOf([["M6-S00", "pass"]])).code === 1 && runOutcome(tallyOf([["M6-S00", "pass"]])).shownOnStaging === 0, "a run where setup failed, with only the offline check passing, exits 1: blocker 1 of the review");
check(runOutcome(tallyOf([["M6-S00", "pass"], ...staging.map((id) => [id, "pass"])])).code === 0, "every staging check passing, with M6-S04 skipped, exits 0");
check(runOutcome(tallyOf([["M6-S00", "pass"], ...staging.slice(1).map((id) => [id, "pass"])])).code === 1 && JSON.stringify(runOutcome(tallyOf([["M6-S00", "pass"], ...staging.slice(1).map((id) => [id, "pass"])])).unshown) === JSON.stringify([staging[0]]), "one staging check skipped exits 1, naming it");
check(runOutcome(tallyOf([["M6-S00", "pass"], ...staging.map((id, at) => [id, at === 2 ? "fail" : "pass"])])).code === 1, "one failure exits 1");
{
  const lines = [];
  const tally = new Tally(PLAN, (line) => lines.push(line));
  tally.add("M6-S00", "pass", "x");
  tally.add("M6-S01a", "fail", "y");
  tally.skipRest("stopped");
  check(tally.results.length === PLAN.length && lines.some((line) => line.startsWith("PASS M6-S00")) && lines.some((line) => line.startsWith("FAIL M6-S01a")) && lines.some((line) => line.startsWith("SKIP M6-S04")), "the tally prints PASS, FAIL and SKIP, and lists every check");
  check(throws(() => tally.add("M6-S99", "pass")) && throws(() => tally.add("M6-S00", "pass")), "an ID outside the plan, or a second result, is a bug");
}
check(scrub("cookie=abcdefghijklmnopqrstuvwxyz0123", ["abcdefghijklmnopqrstuvwxyz0123"]) === "cookie=[redacted]", "output is scrubbed of every secret the run handles");

// ---- the contract, read as the run reads it ----
const contract = readFileSync(join(here, "../packages/contracts/openapi.yaml"), "utf8");
const capabilities = readFileSync(join(here, "../packages/contracts/capabilities.yaml"), "utf8");
const adr = readFileSync(join(here, "../docs/adr/0010-release-and-the-content-domain.md"), "utf8");
const operations = m6Operations(contract);
const want = ["getReleaseConfig", "setReleaseConfig", "approveRelease", "declineRelease", "getAppHostname", "requestAppHostname", "removeAppHostname", "createAppReport", "suspendApp", "liftAppSuspension", "suspendAppHost", "liftAppHostSuspension", "stopContentDomain", "resumeContentDomain", "listTakedownFindings", "getReleaseDelegation", "setReleaseDelegation"];
check(JSON.stringify(operations.map((op) => op.operation).sort()) === JSON.stringify([...want].sort()), `the contract's M6 operations are read, block and inline alike: ${operations.length}`);
check(JSON.stringify(operations.find((op) => op.operation === "removeAppHostname")) === JSON.stringify({ operation: "removeAppHostname", method: "DELETE", path: "/v1/workspaces/{ws}/app-hostname" }) && operations.find((op) => op.operation === "suspendAppHost")?.path === "/v1/moderation/app-hosts/{host}/suspend", "each with its method and path");
check(!operations.some((op) => ["releaseTask", "releaseRole", "getTaskReleaseStatus"].includes(op.operation)), "M5's release status and the task and role releases aren't M6's");
check(operationsProblem(operations, personOnly(capabilities), agentCapabilities(capabilities)) === null, "the real contract and capability list agree: every M6 operation is person-only, none an agent capability");
check(operationsProblem([], [], []) !== null && operationsProblem(operations, personOnly(capabilities).filter((id) => id !== "suspendApp"), []) !== null && operationsProblem(operations, personOnly(capabilities), [{ name: "get_release_config", operation: "getReleaseConfig" }]) !== null && operationsProblem([...operations, operations[0]], personOnly(capabilities), []) !== null, "no M6 operation, one not person-only, one given to agents, or one named twice is refused");
{
  const fake = "paths:\n  /v1/a:\n    get: { operationId: aOne, summary: \"x (M6, ADR 0010) y\" }\n  /v1/b:\n    post:\n      operationId: bTwo\n      summary: \"not it\"\n    put:\n      operationId: bThree\n      summary: \"(M6, ADR 0010)\"\ncomponents:\n  x: 1\n";
  check(JSON.stringify(m6Operations(fake)) === JSON.stringify([{ operation: "aOne", method: "GET", path: "/v1/a" }, { operation: "bThree", method: "PUT", path: "/v1/b" }]), "only operations whose own summary says M6 are read");
}

// ---- M6's fields, derived from the contract ----
const keys = m6Keys(contract);
const all = schemas(contract);
check(all.find((s) => s.name === "ReleaseConfig")?.properties.includes("default_host") && JSON.stringify(all.find((s) => s.name === "VerifyTask")?.properties) === JSON.stringify(["submission_no", "commit_sha"]), "schemas are read with their properties, block and inline alike");
for (const name of ["release_config", "app_hostname", "default_host", "custom_host", "approval_policy", "challenge_name"]) check(keys.includes(name), `M6's fields, derived from the contract, include ${name}`);
for (const name of ["id", "state", "version", "commit_sha", "requested_by", "reason", "hostname", "enabled", "release", "status", "task_id"]) check(!keys.includes(name), `a field other schemas or routes also name isn't counted as M6's: ${name}`);
check(m6Fields({ id: "ws_1", name: "x", policy_version: 3, members: [{ id: "a" }] }, keys).length === 0, "an ordinary room read has no M6 field");
check(JSON.stringify(m6Fields({ task: { id: "t" }, release_config: {}, roles: [{ default_host: "x" }] }, keys)) === JSON.stringify(["release_config", "roles[0].default_host"]), "an M6 field is found anywhere, with where it is");
check(m6Fields({ release: { exists: false } }, keys).length === 0 && m6Fields({ release: { id: "rel_1" } }, keys).length === 1, "M5's release: { exists: false } isn't M6's; any other release is");

// ---- names and events: the hand lists, pinned ----
for (const name of PLANNED_TOOLS) check(capabilities.includes(name) && adr.includes(name) && !agentCapabilities(capabilities).some((c) => c.name === name), `the planned tool ${name} is named in capabilities.yaml and ADR 0010, and isn't a capability yet`);
check(JSON.stringify(m6Names(["get_task", "release_task", "release_role", "get_task_release_status", "get_release_config", "deploy_release", "request_app_hostname"], operations)) === JSON.stringify(["get_release_config", "deploy_release", "request_app_hostname"]), "M6 names are the M6 operations as tools and the planned ones; the task and role releases and M5's release status aren't");
check(m6Names(agentCapabilities(capabilities).map((c) => c.name), operations).length === 0, "no capability the list gives agents today is counted as M6's");
{
  // Every event-shaped name the API and core write today: none may look like M6's, or M6-S02c would fail on it.
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".rs")) files.push(full);
    }
  };
  walk(join(here, "../crates/core/src"));
  walk(join(here, "../apps/api/src"));
  const named = new Set(files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1])));
  const clash = [...named].filter((name) => M6_EVENT.test(name) && !/\.(html|js|json|xml|dex)$/.test(name)).sort();
  // M6 step 4(a) writes three, each only from an operator's suspension, of an app or of a custom hostname a room
  // holds, which is behind the switch. So on staging, where release is switched off, M6-S02c still must find none.
  // Any other is a new name to account for here.
  // Decision 218's PR B adds two names that aren't events: `release_switch.granted` and `release_switch.revoked` are
  // the actions an operator's set of an organization's release switch is kept under in the operators' own record, and
  // are written only from that route, which is behind the switch. No room's event stream carries either.
  // Decision 218's PR C adds `app.unpublished`, written only when a room hears of a take of its organization's release
  // switch. Only an operator's set takes it, through that same route, so with release switched off nothing writes it.
  // Step 6 writes `app.unpublished` from more commands (archive, make private, an operator's room suspension), but only
  // for a room with a release configuration, which nothing gives a room while release is switched off. Its contract PR
  // adds `release.config_set`, written only by the room's release configuration route, which is behind the switch.
  // Step 6's follow-up to 6d adds `app.held` and `app.hold_lifted`, written only for a room with a release
  // configuration, which nothing gives a room while release is switched off.
  // Step 5's driver adds `release.uploaded`, written only when the room records a release's upload, which needs a
  // release that is uploading: nothing makes one while release is switched off.
  const BUILT_M6_EVENTS = ["app.held", "app.hold_lifted", "app.suspended", "app.suspension_lifted", "app.unpublished", "app_hostname.suspended", "release.config_set", "release.failed", "release.live", "release.upload_started", "release.uploaded", "release_switch.granted", "release_switch.revoked"];
  check(named.size > 20 && JSON.stringify(clash) === JSON.stringify(BUILT_M6_EVENTS), `the only M6 event names the API or core writes today are an app's hold and its lifting, its suspension and its lifting, its unpublish, a hostname's suspension, a room's release configuration set, a release failed, started uploading, recorded uploaded and committed live, and the operators' record of a release switch set (${named.size} read): ${clash.join(", ") || "none"}`);
}
check(JSON.stringify(m6EventTypes([{ type: "task.created" }, { type: "role.released" }, { type: "release.requested" }, { type: "deploy.started" }, { type: "app.suspended" }, { type: "release.requested" }])) === JSON.stringify(["release.requested", "deploy.started", "app.suspended"]), "M6 event types, deploy included, are found once each, and a role's release isn't one");

// ---- paths and callers ----
check(fillPath("/v1/workspaces/{ws}/releases/{release}/approve", "ws_1") === `/v1/workspaces/ws_1/releases/rel_${"a1".repeat(16)}/approve` && fillPath("/v1/moderation/app-hosts/{host}/lift", "ws_1") === "/v1/moderation/app-hosts/app.example.com/lift" && fillPath("/v1/orgs/{org}/release-delegation", "ws_1") === `/v1/orgs/org_${"0".repeat(32)}/release-delegation`, "parameters are filled with the room and fixed values");
check(throws(() => fillPath("/v1/{nope}", "ws_1")), "a parameter the script doesn't know is refused, never guessed");
check(neighbour("/v1/workspaces/ws_1/release-config") === "/v1/workspaces/ws_1/release-configx" && /^ws_0{32}$/.test(ABSENT_ROOM), "the neighbour is the path with one more character, and the absent room has the API's shape");
check(snake("getReleaseConfig") === "get_release_config" && snake("ReleaseConfig") === "release_config", "an operation's tool name, and a schema's field name");
{
  const room = operations.find((op) => op.operation === "getReleaseConfig");
  const moderation = operations.find((op) => op.operation === "suspendApp");
  check(JSON.stringify(Object.keys(CALLERS)) === JSON.stringify(["owner", "outsider", "absent", "malformed"]), "four kinds of caller");
  check(JSON.stringify([expectedAnswer("owner", room), expectedAnswer("outsider", room), expectedAnswer("absent", room), expectedAnswer("malformed", room)]) === JSON.stringify([[404, "not_found"], [404, "workspace_not_found"], [404, "workspace_not_found"], [400, "invalid_argument"]]), "a room's route: the answers releases.spec.ts shows the API gives each caller");
  check(["owner", "outsider", "absent", "malformed"].every((caller) => JSON.stringify(expectedAnswer(caller, moderation)) === JSON.stringify([404, "not_found"])), "outside a room's routes, the Worker's not_found, for every caller");
  check(throws(() => expectedAnswer("anyone", room)), "an unknown kind of caller is a bug");
}

// ---- comparing answers ----
{
  const json = [["content-type", "application/json"], ["strict-transport-security", "max-age=31536000"], ["date", "a"], ["cf-ray", "1"]];
  const notFound = '{"error":{"code":"not_found","message":"not_found"}}';
  const a = answerShape(404, json, notFound);
  check(a.code === "not_found" && !("date" in a.headers) && !("cf-ray" in a.headers) && "strict-transport-security" in a.headers, "an answer's code is read; only the compared headers are kept");
  check(differences(a, answerShape(404, [...json.slice(0, 2), ["date", "b"], ["cf-ray", "2"], ["nel", "x"], ["x-edge-odd", "1"]], notFound)).length === 0, "headers outside the compared list, an edge's occasional one included, don't make a difference");
  check(differences(a, answerShape(409, json, notFound)).some((d) => d.startsWith("status")), "a different status is a difference");
  check(differences(a, answerShape(404, json, '{"error":{"code":"release_not_available","message":"x"}}')).some((d) => d.startsWith("error code")), "a different code is a difference");
  check(differences(a, answerShape(404, [["content-type", "text/plain"], json[1]], notFound)).some((d) => d.startsWith("content-type")), "a different content type is a difference");
  check(differences(a, answerShape(404, [json[0]], notFound)).some((d) => d.includes("strict-transport-security")), "a missing security header is a difference");
  check(differences(a, answerShape(404, [...json, ["x-podster-release", "1"]], notFound)).some((d) => d.includes("x-podster-release")), "an extra product header is a difference");
  check(differences(a, answerShape(404, json, `${notFound} `)).includes("a different body"), "a different body is a difference");
  check(COMPARED_HEADERS.includes("content-type") && COMPARED_HEADERS.includes("cache-control") && COMPARED_HEADERS.includes("strict-transport-security") && COMPARED_HEADERS.includes("set-cookie"), "the compared headers include the content type, cache control, HSTS and Set-Cookie");
  // Blocker 2: alike isn't enough.
  check(pairProblem(a, a, [404, "not_found"]) === null, "alike, and the API's own answer for a missing route: shown");
  for (const [status, code, contentType] of [[429, "rate_limited", "application/json"], [401, "sign_in_required", "application/json"], [403, "not_allowed", "application/json"], [502, null, "text/html"], [503, null, "text/plain"]]) {
    const refused = answerShape(status, [["content-type", contentType]], code ? `{"error":{"code":"${code}"}}` : "<html>");
    const problem = pairProblem(refused, refused, [404, "not_found"]);
    check(typeof problem === "string" && problem.includes("gateway or edge refusal"), `both sides ${status}${code ? ` ${code}` : ""} alike fail as a gateway or edge refusal, never pass`);
  }
  const other = answerShape(404, json, '{"error":{"code":"workspace_not_found"}}');
  check(/not the API's 404 not_found/.test(pairProblem(other, other, [404, "not_found"]) ?? ""), "alike, but not the API's answer for this caller: a failure that names both");
  check(edgeRefusal(answerShape(403, json, '{"error":{"code":"access_revoked"}}')) === null, "the API's own access_revoked isn't counted as the edge's");
}

// ---- MCP ----
check(toolAnswer('{"error":"Tool get_release_config not found"}', "get_release_config") === toolAnswer('{"error":"Tool get_release_config_x not found"}', "get_release_config_x"), "a tool's own name is taken out of its answer before comparing");
{
  const rpc = (status, body, type = "application/json") => answerShape(status, [["content-type", type]], typeof body === "string" ? body : JSON.stringify(body));
  const sdkNotFound = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "MCP error -32602: Tool <tool> not found" }], isError: true } };
  check(mcpErrorProblem(rpc(200, sdkNotFound)) === null && mcpErrorProblem(rpc(200, { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Tool <tool> not found" } })) === null, "\"tool not found\" with HTTP 200, as the SDK's server sends it in a result marked isError, or as a JSON-RPC error, is the expected refusal");
  for (const [label, body] of [
    ["a result marked isError with no text", { jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } }],
    ["a disabled tool", { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "MCP error -32602: Tool <tool> disabled" }] } }],
    ["a known tool's refusal", { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "access_revoked" }] } }],
    ["an invalid argument", { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "MCP error -32602: Input validation error: Invalid arguments for tool <tool>" }] } }],
    ["an internal error", { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error" } }],
  ]) check(/other than "tool not found"/.test(mcpErrorProblem(rpc(200, body)) ?? ""), `${label} isn't "tool not found", so it fails M6-S01e`);
  check(toolNotFound(toolAnswer("MCP error -32602: Tool get_release_config not found", "get_release_config")) && toolNotFound("Tool <tool> not found") && !toolNotFound("Tool get_release_config not found") && !toolNotFound("MCP error -32602: Tool <tool> not found, and more"), "\"tool not found\" is matched only whole, with the tool's own name taken out");
  for (const [label, shape] of [["a 401", rpc(401, { error: "invalid_token" })], ["a 429", rpc(429, { error: { code: "rate_limited" } })], ["a 200 that isn't JSON-RPC", rpc(200, { ok: true })], ["a JSON-RPC success", rpc(200, { jsonrpc: "2.0", id: 1, result: { content: [] } })], ["an HTML page", rpc(200, "<html>", "text/html")]]) check(mcpErrorProblem(shape) !== null, `${label} isn't counted as an MCP refusal`);
}

// ---- each request's timing ----
{
  check(requestPath(`${STAGING}/api/v1/agents/agt_1/disconnect?code=abc&state=xyz`) === "/api/v1/agents/agt_1/disconnect", "a request's path keeps its IDs and drops staging's host and the query");
  check(requestPath("https://other.example/oauth/token?code=abc") === "https://other.example/oauth/token" && requestPath("not a url") === "(unreadable URL)", "another host is named without its query, and an unreadable URL is said to be one");
  const at = "2026-11-13T10:00:00.000Z";
  check(requestLine({ at, method: "POST", path: "/api/v1/agents/agt_1/disconnect", status: 200, ms: 312 }) === `req  ${at} POST /api/v1/agents/agt_1/disconnect 200 312 ms`, "a request's line is its start, method, path, status and milliseconds");
  check(requestLine({ at, method: "POST", path: "/x", error: "TimeoutError", ms: 60_001 }) === `req  ${at} POST /x TimeoutError 60001 ms`, "a request with no answer names its error instead of a status");
  const seven = [5, 70, 1, 60_001, 300, 2, 40].map((ms, i) => ({ at, method: "GET", path: `/r${i}`, status: 200, ms }));
  check(slowestLine(seven) === `Slowest 5 of 7 requests: GET /r3 200 60001 ms at ${at}; GET /r4 200 300 ms at ${at}; GET /r1 200 70 ms at ${at}; GET /r6 200 40 ms at ${at}; GET /r0 200 5 ms at ${at}.` && seven[0].ms === 5, "the summary names the five slowest, slowest first, and leaves the list as it was");
  check(slowestLine([]) === "Slowest requests: none was sent.", "a run that sent nothing says so");
}

/** Every request a stand-in run counted has its line, every line has its shape and no query, and the summary ends the run. */
function timingProblem(res) {
  const lines = (res.stdout ?? "").split("\n").filter((line) => line.startsWith("req  "));
  const shaped = /^req {2}\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z [A-Z]+ \/[^\s?]* (\d{3}|[A-Za-z]+) \d+ ms$/;
  if (lines.length !== res.requests) return `${lines.length} request line(s) for ${res.requests} request(s)`;
  const odd = lines.find((line) => !shaped.test(line));
  if (odd) return `a request line out of shape: ${odd}`;
  const summary = new RegExp(`Slowest ${Math.min(5, lines.length)} of ${lines.length} requests: `);
  if (lines.length && !summary.test(res.stdout)) return "no summary of the slowest requests";
  return null;
}

// ---- the script's source ----
const source = readFileSync(join(here, "m6-staging.mjs"), "utf8");
const lib = readFileSync(join(here, "m6-staging-lib.mjs"), "utf8");
const code = source.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
check(source.includes("m6Operations(contractText)") && source.includes("m6Keys(contractText)") && !/release-config"|getReleaseConfig"/.test(code), "the script reads the M6 routes and fields from the contract and lists none itself");
check(!/cloudflare\.com|CLOUDFLARE_|wrangler/i.test(code) && !/cloudflare\.com|CLOUDFLARE_|wrangler/i.test(lib), "neither file calls Cloudflare or wrangler");
check(!/RELEASES|test_releases_on|managed-switch|"enabled":\s*true|enabled: true/.test(code), "the script switches nothing on: no switch is named outside its comments, and no body turns release on");
check(!/spawn|exec(File)?Sync|child_process/.test(source), "the script starts no child process, so no environment is passed on");
check(!/readFileSync\([^)]*(ecret|\.podster)/i.test(source) && source.includes("process.env.PODSTER_E2E_SIGNUP_SECRET"), "the sign-up secret comes from the environment only, and no file is read for it");
{
  const keptSource = readFileSync(join(here, "m6-staging-kept.mjs"), "utf8");
  check(!/console\.|process\.std/.test(keptSource) && /O_EXCL/.test(keptSource) && /O_NOFOLLOW/.test(keptSource) && /0o600/.test(keptSource) && /0o700/.test(keptSource), "the kept-file module prints nothing, never overwrites, never follows a link, and writes at 0600 under 0700");
}
check(/const say = \(line = ""\) => console\.log\(scrub\(line, secrets\)\)/.test(source), "what the run prints goes through scrub");
check(source.includes("PACE_MS") && /for \(let pages = 0; pages < 100/.test(source) && /for \(let pages = 0; pages < 20/.test(source), "requests are paced, and every loop over pages is bounded");
check(/process\.exit\(outcome\.code\)/.test(source) && !/process\.exit\(tally\.exitCode\(\)\)/.test(source), "the exit code is the run's outcome, never the tally's alone: blocker 1");
check(/await preflight\(\)[\s\S]*await \(phase === "before" \? beforeDeploy : phase === "after" \? afterDeploy : main\)\(\)/.test(source) && source.indexOf("async function preflight") < source.indexOf("async function main") && !/preflight\(\)[\s\S]{0,400}person\(/.test(source.slice(source.indexOf("async function preflight"), source.indexOf("let owner;"))), "a signed-out preflight runs before main, and takes no sign-up");
{
  const body = source.slice(source.indexOf("async function main"));
  const first = body.indexOf('person("the room\'s owner")');
  const second = body.indexOf('person("a second person")');
  check(first > 0 && second > first && body.indexOf("addAgent(room, agent)") < second && body.indexOf("tally.skipRest(") < second, "the second sign-up is taken only after the owner's room and agent are made, and not at all if they fail");
}
check(/process\.on\("SIGINT"/.test(source) && /if \(stopping\) throw new Halt/.test(source), "Ctrl-C stops the flow at the next request");
check(/\/disconnect`/.test(source) && /leftBehind/.test(source) && /Left behind on staging/.test(source), "the agent is disconnected at the end, and what's left behind is printed");
check(/again\+\+/.test(source) && /pairProblem\(real, unknown, expectedAnswer\(caller, op\)\)/.test(source), "a differing pair is asked once more, and every pair must be the API's own answer");
check(/attempt >= 2/.test(source), "a transport error is retried once, then fails naming the request");
{
  const signUp = source.slice(source.indexOf("async function person"), source.indexOf("/** Disconnects an agent"));
  check(/"\/api\/auth\/sign-up\/e2e"[^\n]*\{ retry: false \}\)/.test(signUp) && /signUpUnknown = true/.test(signUp) && /ok\(!signUpUnknown/.test(signUp), "the sign-up is never retried in transport, and after one whose outcome is unknown no further sign-up is asked for");
  check(!/sign-up\/e2e/.test(source.replace(signUp, "")), "nothing else in the script sends the test sign-up");
}
check(/mcpErrorProblem\(shape\)/.test(source) && /toolNotFound\(sdkRealText\)/.test(source), "M6-S01e requires \"tool not found\" from the raw /mcp answer and through the SDK");
check(/again\+\+;\s*problems = await askTool\(name\)/.test(source), "M6-S01e asks a name once more after a first problem, as the routes are");
{
  const connect = source.slice(source.indexOf("async function agentOf"), source.indexOf("/** One request of a person's"));
  const failure = connect.slice(connect.indexOf("} catch (error) {"));
  check(/dash\("GET", "\/agents"\)/.test(failure) && /await disconnect\(linker, each\.id\)/.test(failure) && /if \(!halfMade\) leftBehind\.push/.test(failure) && /throw error;/.test(failure), "an agent whose connect failed midway is found by name and disconnected, or listed as left behind");
}
check(!/\bconst after = /.test(source), "no unused helper is left");
for (const { id } of PLAN) check(source.includes(`"${id}"`), `${id} has a check in the script`);
check((source.match(/await person\(/g) ?? []).length === SIGN_UPS.length + PHASE_SIGN_UPS.before.length + PHASE_SIGN_UPS.after.length, "the script signs up exactly the people the plans list");
for (const { id } of [...PHASE_PLANS.before, ...PHASE_PLANS.after]) check(source.includes(`"${id}"`), `${id} has a check in the script`);
{
  const before = source.slice(source.indexOf("async function beforeDeploy"), source.indexOf("async function afterDeploy"));
  const after = source.slice(source.indexOf("async function afterDeploy"), source.indexOf("const started = Date.now()"));
  check((before.match(/await person\(/g) ?? []).length === 1 && !/person\(/.test(after.replace(/Person\.fromCookie/g, "")), "the first phase signs up one person, and the second no one");
  check(before.includes("writeKept(keptAt, keptRecord({ commit: options.deployedCommit,") && /\}, owner\.cookie\)\);/.test(before) && !/signupSecret/.test(before) && (source.match(/writeKept\(/g) ?? []).length === 1, "the kept file is written once, by the first phase, with the owner's session and never the sign-up secret");
  check(before.indexOf("writeKept(") > before.indexOf("task.assignee_departed") && before.indexOf("keptSession = owner.cookie") > before.indexOf("writeKept("), "it's written only once the task is part-way, and the session is kept only once it's written");
  check(/if \(cookie !== keptSession\) await target\.http\("\/api\/auth\/sign-out"/.test(source), "every session is signed out but the one kept for the second phase");
  check(/if \(kept\) sessions\.push\(kept\.session\)/.test(source) && /if \(phase === "after"\) say\(removeKept\(keptAt\)/.test(source.slice(source.indexOf("} finally {"))), "the second phase signs the kept session out and deletes the file in its clean-up, whatever its checks found");
  check(/readsOnly: true/.test(after) && /kept\.last_seq/.test(after) && /kept\.events_seen/.test(after), "the second phase compares M6's reads on the older room, and its events against the first phase's count");
  check(source.indexOf("readKept(keptAt)") < source.indexOf("await preflight()") && source.indexOf("readKept(keptAt)") > source.indexOf("if (options.dryRun) {"), "the kept file is checked after a dry run would stop and before anything is sent");
  check(/secretCookie\(kept\.session\)/.test(source) && /const secrets = \[signupSecret, kept\?\.session\]/.test(source), "the kept session is scrubbed from the output like any other");
  check(/Run --before-deploy before a deploy and --after-deploy after it/.test(source), "the usual run's M6-S04 says how to run the two phases");
}

// ---- the script as a dry run ----
const work = mkdtempSync(join(tmpdir(), "podster-m6-selftest-"));
try {
  const run = (argv, env = {}) => spawnSync(process.execPath, [join(here, "m6-staging.mjs"), ...argv], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: "utf8" });
  const secret = "s".repeat(40);
  const dry = run(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret });
  check(dry.status === 0 && dry.stdout.includes("Nothing was sent to staging") && PLAN.every(({ id }) => dry.stdout.includes(id)) && dry.stdout.includes(`M6 operations, read from the contract: ${want.length}.`) && dry.stdout.includes("M6 fields, derived from the contract's M6 schemas: "), "a dry run prints the plan, the contract's M6 operations and fields, and exits 0");
  check(!dry.stdout.includes(secret) && !dry.stderr.includes(secret), "a dry run never prints the secret");
  check(run(["--base-url", STAGING, "--dry-run"]).status === 2, "a dry run without the sign-up secret exits 2");
  check(run(["--base-url", "https://gateway.podster.dev", "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret }).status === 2, "another host exits 2");
  const empty = join(work, "empty.yaml");
  writeFileSync(empty, "paths: {}\n");
  check(run(["--base-url", STAGING, "--dry-run", "--contract", empty], { PODSTER_E2E_SIGNUP_SECRET: secret }).status === 2, "a contract with no M6 operation exits 2");
  check(run(["--base-url", STAGING, "--dry-run", "--contract", join(work, "missing.yaml")], { PODSTER_E2E_SIGNUP_SECRET: secret }).status === 2, "a contract that can't be read exits 2");

  // The real script, not a dry run, against m6-staging-standin.mjs, which replaces fetch before the script loads, so
  // nothing leaves this machine. A stand-in that didn't load stops node before the script starts.
  const standIn = (mode) => {
    const res = spawnSync(process.execPath, ["--import", pathToFileURL(join(here, "m6-staging-standin.mjs")).href, join(here, "m6-staging.mjs"), "--base-url", STAGING], { env: { PATH: process.env.PATH, HOME: process.env.HOME, PODSTER_E2E_SIGNUP_SECRET: secret, M6_STANDIN: mode }, encoding: "utf8" });
    const counted = /stand-in counted: (\d+) requests, (\d+) test sign-ups/.exec(res.stdout);
    const loaded = res.stdout.startsWith(`stand-in for staging: ${mode}; nothing leaves this machine`);
    return { ...res, loaded, requests: counted ? Number(counted[1]) : NaN, signUps: counted ? Number(counted[2]) : NaN };
  };
  const dropped = standIn("drop-signup");
  check(dropped.loaded && dropped.signUps === 1, `a sign-up whose answer is lost in transport is sent once, not again: ${dropped.signUps} sign-up request(s)`);
  check(dropped.status === 1, `a run whose first sign-up's outcome is unknown exits 1, not ${dropped.status}`);
  check(/Whether staging took that sign-up is unknown/.test(dropped.stdout) && /Sign-ups asked for: 1, answered with a session: 0/.test(dropped.stdout) && /Checks shown on staging: 0/.test(dropped.stdout), "it says the sign-up's outcome is unknown, counts it, and shows nothing on staging");
  check(!dropped.stdout.includes(secret) && !dropped.stderr.includes(secret), "it never prints the secret");
  check(timingProblem(dropped) === null && /POST \/api\/auth\/sign-up\/e2e TypeError \d+ ms/.test(dropped.stdout), `each request is logged with its timing, and the lost sign-up names its error: ${timingProblem(dropped) ?? "ok"}`);
  const down = standIn("edge-down");
  check(down.loaded && down.status === 2 && down.signUps === 0 && /No sign-up was taken/.test(down.stderr), `an edge that answers 502 fails the preflight: exit ${down.status}, ${down.signUps} sign-up request(s)`);

  // M6-S04's two phases, each a process of its own against the stand-in, which keeps its state in a file between them
  // as staging would across a deploy. HOME is a directory of the self-test's, so the kept file is written there.
  const home = join(work, "home");
  mkdirSync(home);
  const kept = keptFile(home);
  const standinState = join(work, "standin.json");
  const [atBefore, atAfter] = ["1".repeat(40), "2".repeat(40)];
  const phaseArgs = (which, commit, extraArgs = []) => ["--import", pathToFileURL(join(here, "m6-staging-standin.mjs")).href, join(here, "m6-staging.mjs"), "--base-url", STAGING, `--${which}-deploy`, "--deployed-commit", commit, ...extraArgs];
  const phaseEnv = (which, extraEnv = {}) => ({ PATH: process.env.PATH, HOME: home, M6_STANDIN: "phases", M6_STANDIN_STATE: standinState, ...(which === "before" ? { PODSTER_E2E_SIGNUP_SECRET: secret } : {}), ...extraEnv });
  const counted = (res) => {
    const found = /stand-in counted: (\d+) requests, (\d+) test sign-ups, (\d+) sign-outs, (\d+) agent disconnects/.exec(res.stdout);
    return { ...res, requests: found ? Number(found[1]) : NaN, signUps: found ? Number(found[2]) : NaN, signOuts: found ? Number(found[3]) : NaN, disconnects: found ? Number(found[4]) : NaN, all: res.stdout + res.stderr };
  };
  const phaseRun = (which, commit, extraEnv = {}, extraArgs = []) => counted(spawnSync(process.execPath, phaseArgs(which, commit, extraArgs), { env: phaseEnv(which, extraEnv), encoding: "utf8" }));
  /**
   * A phase with Ctrl-C at a known point. The stand-in holds the first request that matches `gate` and says so; only
   * then does this send SIGINT, and the stand-in answers that request once the run's own SIGINT listener has run. So the
   * signal always lands while that request is open. Nothing here waits on time or kills on a timer: it waits for the
   * child to exit, however long that takes, and only the CI job's own limit bounds a run that never does. Such a child
   * can be asked what it's waiting on: `kill -USR2` it, and node writes a diagnostic report, its JavaScript stack and
   * open handles, into the self-test's directory, which `M6_SELFTEST_KEEP=1` keeps.
   */
  const gatedRun = (which, commit, gate) =>
    new Promise((resolve) => {
      const reports = join(work, "reports");
      const child = spawn(process.execPath, ["--report-on-signal", "--report-signal=SIGUSR2", `--report-dir=${reports}`, ...phaseArgs(which, commit)], { env: phaseEnv(which, { M6_STANDIN_GATE: gate }), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let signalled = false;
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
        if (!signalled && stdout.includes("stand-in: holding")) {
          signalled = true;
          child.kill("SIGINT");
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ ...counted({ status, stdout, stderr }), signalled }));
    });
  const secretFree = (res, also = []) => ![secret, ...also].some((value) => res.all.includes(value));

  const dryBefore = phaseRun("before", atBefore, {}, ["--dry-run"]);
  check(dryBefore.status === 0 && dryBefore.requests === 0 && /M6-S04a/.test(dryBefore.stdout) && !/M6-S01a/.test(dryBefore.stdout) && !existsSync(kept), "a dry run of the first phase prints its plan, sends nothing and writes no file");
  const dryAfter = phaseRun("after", atAfter, {}, ["--dry-run"]);
  check(dryAfter.status === 0 && dryAfter.requests === 0 && /M6-S04e/.test(dryAfter.stdout) && /Sign-ups this run takes: 0/.test(dryAfter.stdout), "a dry run of the second phase needs no sign-up secret and sends nothing");
  check(phaseRun("after", atAfter).status === 2 && /no kept file/.test(phaseRun("after", atAfter).stderr), "the second phase with no kept file is refused, exit 2");

  const first = phaseRun("before", atBefore);
  const record = readKept(kept).record;
  check(first.status === 0 && first.signUps === 1 && first.signOuts === 0 && /PASS M6-S04a/.test(first.stdout), `the first phase passes with 1 sign-up and keeps its session signed in: exit ${first.status}, ${first.signUps} sign-up(s), ${first.signOuts} sign-out(s)`);
  check(Boolean(record) && (statSync(kept).mode & 0o777) === 0o600 && record.deployed_commit === atBefore && /session_token=/.test(record.session ?? ""), "it keeps the session and the commit it was told, at mode 0600");
  check(!readFileSync(kept, "utf8").includes(secret), "the kept file never holds the sign-up secret");
  check(Boolean(record) && secretFree(first, [record.session, record.session.split("=")[1]]), "the first phase prints neither the secret nor the session");
  check(timingProblem(first) === null && /^Slowest 5 of \d+ requests: /m.test(first.stdout), `the first phase logs each of its requests and ends with its five slowest: ${timingProblem(first) ?? "ok"}`);
  check(/Every test session was signed out but the owner's, kept in ~\/\.podster\/m6-staging\/s04\.json/.test(first.stdout) && !first.all.includes(home), "it says the session is kept, and where, without naming the runner's home");
  const again = phaseRun("before", atBefore);
  check(again.status === 2 && again.requests === 0 && /still usable/.test(again.stderr) && JSON.stringify(readKept(kept).record) === JSON.stringify(record), "a second first phase while the kept file is usable is refused before anything is sent, and the file is untouched");
  const same = phaseRun("after", atBefore);
  check(same.status === 2 && same.requests === 0 && /deploy first/.test(same.stderr) && existsSync(kept), "the second phase at the same commit is refused before anything is sent, and the file is kept");
  chmodSync(kept, 0o644);
  const loose = phaseRun("after", atAfter);
  check(loose.status === 2 && loose.requests === 0 && /read by others/.test(loose.stderr), "a kept file others can read is refused");
  chmodSync(kept, 0o600);

  const second = phaseRun("after", atAfter);
  check(second.status === 0 && second.signUps === 0 && second.signOuts === 1 && ["M6-S04b", "M6-S04c", "M6-S04d", "M6-S04e"].every((id) => second.stdout.includes(`PASS ${id}`)), `the second phase passes with no sign-up, and signs the kept session out: exit ${second.status}, ${second.signUps} sign-up(s), ${second.signOuts} sign-out(s)`);
  check(!existsSync(kept) && /The kept file ~\/\.podster\/m6-staging\/s04\.json was deleted/.test(second.stdout), "it deletes the kept file");
  check(secretFree(second, [record.session, record.session.split("=")[1]]), "the second phase prints neither the secret nor the session");
  check(/the first phase's 4 still first/.test(second.stdout) && /offered to agent agt_\w+, accepted, submitted, completed/.test(second.stdout), "the older room's task is finished, and its earlier events are read first");
  check(phaseRun("after", atAfter).status === 2, "a second run of the second phase finds no file and is refused");

  // A kept session staging no longer accepts: the phase fails, and still deletes the file.
  check(phaseRun("before", atBefore).status === 0 && existsSync(kept), "the first phase runs again once the file is gone");
  const forgot = phaseRun("after", atAfter, { M6_STANDIN_FORGET: "1" });
  check(forgot.status === 1 && /the kept session wasn't accepted/.test(forgot.stdout) && /SKIP M6-S04b/.test(forgot.stdout) && !existsSync(kept), `a kept session that's no longer accepted fails the phase, exit ${forgot.status}, and the file is deleted`);

  // A stale file: refused before anything is sent, and deleted, since its session has ended.
  check(phaseRun("before", atBefore).status === 0, "the first phase runs once more");
  const old = readKept(kept).record;
  const shifted = { ...old, signed_up_at: old.signed_up_at - SESSION_SECONDS * 1000, stale_at: old.stale_at - SESSION_SECONDS * 1000 };
  removeKept(kept);
  writeKept(kept, shifted);
  const stale = phaseRun("after", atAfter);
  check(stale.status === 2 && stale.requests === 1 && stale.signOuts === 1 && /stale/.test(stale.stderr) && /sign-out answered 200/.test(stale.stderr) && !existsSync(kept), `a stale kept file is refused, its session signed out first, the one request sent, and the file deleted: ${stale.requests} request(s), ${stale.signOuts} sign-out(s)`);
  check(secretFree(stale, [shifted.session, shifted.session.split("=")[1]]), "that refusal prints neither the secret nor the session");
  check((stale.stdout.match(/^req {2}\S+ POST \/api\/auth\/sign-out 200 \d+ ms$/gm) ?? []).length === stale.requests, "the stale session's sign-out, sent before the clients load, is logged too");
  writeKept(kept, shifted);
  const replaced = phaseRun("before", atBefore);
  check(replaced.status === 0 && /was stale, [^\n]*: its session's sign-out answered 200, and the file was deleted/.test(replaced.stdout) && readKept(kept).record?.signed_up_at > shifted.signed_up_at, "a first phase signs a stale file's session out, deletes the file and keeps its own");
  check(secretFree(replaced, [shifted.session, shifted.session.split("=")[1]]), "and prints neither the secret nor the stale session");
  removeKept(kept);

  // Every local check comes before any request, so none costs a sign-up or a room.
  const foreign = { kind: "something else", session: "x".repeat(20) };
  writeKept(kept, foreign);
  const notOurs = phaseRun("before", atBefore);
  check(notOurs.status === 2 && notOurs.requests === 0 && /isn't a kept file of this script's/.test(notOurs.stderr) && JSON.stringify(readKept(kept).record) === JSON.stringify(foreign), "a file at the kept path that isn't this script's is refused before any request, and never deleted");
  const notOursAfter = phaseRun("after", atAfter);
  check(notOursAfter.status === 2 && notOursAfter.requests === 0 && existsSync(kept), "the second phase refuses it too, and leaves it");
  removeKept(kept);
  chmodSync(dirname(kept), 0o755);
  const openDir = phaseRun("before", atBefore);
  check(openDir.status === 2 && openDir.requests === 0 && openDir.signUps === 0 && /opened by others/.test(openDir.stderr), "a kept directory others can open is refused before the sign-up");
  chmodSync(dirname(kept), 0o700);
  rmSync(dirname(kept), { recursive: true });
  const elsewhere = join(work, "elsewhere");
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, dirname(kept));
  const linkedDir = phaseRun("before", atBefore);
  check(linkedDir.status === 2 && linkedDir.requests === 0 && /link/.test(linkedDir.stderr) && readdirSync(elsewhere).length === 0, "a kept directory that is a link is refused before the sign-up, and nothing is written through it");
  rmSync(dirname(kept));
  check([openDir, linkedDir, notOurs].every((res) => !res.all.includes(home)), "no refusal names the runner's home");

  // A kept file holding JSON that isn't an object is still a file there: refused before any request.
  for (const text of ["null", "0", "false"]) {
    mkdirSync(dirname(kept), { recursive: true, mode: 0o700 });
    writeFileSync(kept, text, { mode: 0o600 });
    const odd = phaseRun("before", atBefore);
    check(odd.status === 2 && odd.requests === 0 && odd.signUps === 0 && readFileSync(kept, "utf8") === text, `a kept file holding ${text} is refused before any request, and left as it is`);
    removeKept(kept);
  }
  // A directory the runner owns but can't write, which passes the mode check, fails the probe write before any request.
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  if (!root) {
    chmodSync(dirname(kept), 0o500);
    const readOnly = phaseRun("before", atBefore);
    check(readOnly.status === 2 && readOnly.requests === 0 && readOnly.signUps === 0 && /test write there failed/.test(readOnly.stderr), "a kept directory at 0500 fails the test write before any request");
    chmodSync(dirname(kept), 0o700);
  } else check(true, "a kept directory at 0500: not checked as root, which can write it");
  check(readdirSync(dirname(kept)).length === 0, "the test write leaves nothing behind");

  // Temporary files a killed run left are swept by either phase, after the directory checks; nothing else is.
  const leftover = (hex) => join(dirname(kept), `.s04.json.${hex}.tmp`);
  const unrelated = join(dirname(kept), ".s04.json.notours.tmp");
  for (const [which, commit] of [["before", atBefore], ["after", atAfter]]) {
    writeFileSync(leftover("0123456789abcdef"), JSON.stringify({ session: "x".repeat(20) }), { mode: 0o600 });
    writeFileSync(unrelated, "keep", { mode: 0o600 });
    const swept = phaseRun(which, commit);
    check(!existsSync(leftover("0123456789abcdef")) && existsSync(unrelated) && /1 temporary file\(s\) a killed run left/.test(swept.stdout), `the ${which === "before" ? "first" : "second"} phase sweeps a leftover temporary file and nothing else`);
    rmSync(unrelated);
  }
  removeKept(kept);

  // The second phase says what happened to a stale file it couldn't delete.
  if (!root) {
    writeKept(kept, shifted);
    chmodSync(dirname(kept), 0o500);
    const stuck = phaseRun("after", atAfter);
    chmodSync(dirname(kept), 0o700);
    check(stuck.status === 2 && /couldn't be deleted: delete ~\/\.podster\/m6-staging\/s04\.json by hand/.test(stuck.stderr) && !/the file was deleted/.test(stuck.stderr) && existsSync(kept), "a stale file the second phase can't delete is reported as not deleted");
    removeKept(kept);
  }

  // The disconnect in M6-S04a fails once: the agent stays on the clean-up list and is disconnected again.
  const flaky = phaseRun("before", atBefore, { M6_STANDIN_DISCONNECT_FAIL: "1" });
  check(flaky.status === 1 && flaky.disconnects === 2 && flaky.signOuts === 1 && !existsSync(kept) && /disconnected, so its OAuth credential no longer works/.test(flaky.stdout), `a failed disconnect fails M6-S04a, keeps the agent on the clean-up list, which disconnects it, and keeps nothing: exit ${flaky.status}, ${flaky.disconnects} disconnect(s)`);

  // Ctrl-C in each phase: the run stops at its next request, and still cleans up.
  const stopBefore = await gatedRun("before", atBefore, "/tasks");
  check(stopBefore.signalled && stopBefore.status === 1 && /stopped by a signal/.test(stopBefore.stdout) && stopBefore.signOuts === 1 && stopBefore.disconnects >= 1 && !existsSync(kept), `Ctrl-C in the first phase keeps no file, signs its session out and disconnects its agent: exit ${stopBefore.status}, ${stopBefore.signOuts} sign-out(s), ${stopBefore.disconnects} disconnect(s)`);
  check(phaseRun("before", atBefore).status === 0 && existsSync(kept), "the first phase runs again for the second's Ctrl-C");
  const keptSessionNow = readKept(kept).record.session;
  const stopAfter = await gatedRun("after", atAfter, "/assign");
  check(stopAfter.signalled && stopAfter.status === 1 && /stopped by a signal/.test(stopAfter.stdout) && stopAfter.signOuts === 1 && stopAfter.disconnects === 1 && !existsSync(kept), `Ctrl-C in the second phase still signs the kept session out, disconnects its agent and deletes the file: exit ${stopAfter.status}, ${stopAfter.signOuts} sign-out(s), ${stopAfter.disconnects} disconnect(s)`);
  check(secretFree(stopAfter, [keptSessionNow, keptSessionNow.split("=")[1]]), "and prints neither the secret nor the session");

  // Ctrl-C at the first phase's last request, the events page past its 4 events, after which nothing paces before the
  // file is written: only the run's own check of the stop keeps the file from being written.
  const stopLast = await gatedRun("before", atBefore, "/events?after=4");
  check(stopLast.signalled && stopLast.status === 1 && /stopped by a signal/.test(stopLast.stdout) && stopLast.signOuts === 1 && !existsSync(kept) && readdirSync(dirname(kept)).length === 0, `Ctrl-C at the first phase's last request keeps no file, whole or half-written, and signs the session out: exit ${stopLast.status}, ${stopLast.signOuts} sign-out(s)`);
  // Ctrl-C once every check of the second phase has run, during its clean-up's sign-out: nothing is cut short, the
  // outcome stands, and the clean-up still finishes.
  check(phaseRun("before", atBefore).status === 0 && existsSync(kept), "the first phase runs again for a stop during the second's clean-up");
  const stopLate = await gatedRun("after", atAfter, "POST /api/auth/sign-out");
  check(stopLate.signalled && stopLate.status === 0 && /nothing was cut short/.test(stopLate.stdout) && stopLate.signOuts === 1 && !existsSync(kept), `Ctrl-C during the second phase's clean-up leaves its passed outcome, exit ${stopLate.status}, and the clean-up still signs out and deletes the file`);
} finally {
  if (process.env.M6_SELFTEST_KEEP === "1") console.log(`kept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nM6 staging self-test: all passed");
process.exit(failed ? 1 : 0);
