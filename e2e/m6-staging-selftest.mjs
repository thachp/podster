// Checks the parts of M6's staging run that need no network: which host it accepts, its arguments, which operations it
// reads from the contract as M6's, how two answers are compared, and what counts as an M6 field, name or event. Then
// the script itself, as a dry run, which sends nothing, and what its source does and doesn't do.
//
//   node m6-staging-selftest.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ABSENT_ROOM, agentCapabilities, answerShape, differences, fillPath, m6EventTypes, m6Fields, m6Names, m6Operations, neighbour, operationsProblem, parseArgs, personOnly, PLAN, scrub, secretProblem, SIGN_UPS, snake, STAGING, stagingOnly, Tally, toolAnswer,
} from "./m6-staging-lib.mjs";

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

// ---- the plan and its tally ----
const ids = PLAN.map((entry) => entry.id);
check(new Set(ids).size === ids.length && ids.every((id) => /^M6-S0[0-9][a-z]?$/.test(id)) && PLAN.every((entry) => entry.title.length > 0), "every check has one stable M6-S0x ID and a title");
{
  const lines = [];
  const tally = new Tally(PLAN, (line) => lines.push(line));
  tally.add("M6-S00", "pass", "x");
  tally.add("M6-S01a", "fail", "y");
  tally.skipRest("stopped");
  check(tally.results.length === PLAN.length && tally.exitCode() === 1 && lines.some((line) => line.startsWith("PASS M6-S00")) && lines.some((line) => line.startsWith("FAIL M6-S01a")) && lines.some((line) => line.startsWith("SKIP M6-S04")), "the tally prints PASS, FAIL and SKIP, lists every check, and fails the run on one failure");
  check(throws(() => tally.add("M6-S99", "pass")) && throws(() => tally.add("M6-S00", "pass")), "an ID outside the plan, or a second result, is a bug");
  const clean = new Tally(PLAN, () => {});
  clean.add("M6-S00", "pass");
  clean.skipRest("x");
  check(clean.exitCode() === 0, "skips don't fail a run that passed something");
}
check(scrub("cookie=abcdefghijklmnopqrstuvwxyz0123", ["abcdefghijklmnopqrstuvwxyz0123"]) === "cookie=[redacted]", "output is scrubbed of every secret the run handles");

// ---- the contract, read as the run reads it ----
const contract = readFileSync(join(here, "../packages/contracts/openapi.yaml"), "utf8");
const capabilities = readFileSync(join(here, "../packages/contracts/capabilities.yaml"), "utf8");
const operations = m6Operations(contract);
const want = ["getReleaseConfig", "setReleaseConfig", "approveRelease", "declineRelease", "getAppHostname", "requestAppHostname", "removeAppHostname", "createAppReport", "suspendApp", "liftAppSuspension", "suspendAppHost", "liftAppHostSuspension", "stopContentDomain", "resumeContentDomain"];
check(JSON.stringify(operations.map((op) => op.operation).sort()) === JSON.stringify([...want].sort()), `the contract's M6 operations are read, block and inline alike: ${operations.length}`);
check(JSON.stringify(operations.find((op) => op.operation === "removeAppHostname")) === JSON.stringify({ operation: "removeAppHostname", method: "DELETE", path: "/v1/workspaces/{ws}/app-hostname" }) && operations.find((op) => op.operation === "suspendAppHost")?.path === "/v1/moderation/app-hosts/{host}/suspend", "each with its method and path");
check(!operations.some((op) => ["releaseTask", "releaseRole", "getTaskReleaseStatus"].includes(op.operation)), "M5's release status and the task and role releases aren't M6's");
check(operationsProblem(operations, personOnly(capabilities), agentCapabilities(capabilities)) === null, "the real contract and capability list agree: every M6 operation is person-only, none an agent capability");
check(operationsProblem([], [], []) !== null, "a contract with no M6 operation is refused");
check(operationsProblem(operations, personOnly(capabilities).filter((id) => id !== "suspendApp"), []) !== null, "an M6 operation not listed person-only is refused");
check(operationsProblem(operations, personOnly(capabilities), [{ name: "get_release_config", operation: "getReleaseConfig" }]) !== null, "an M6 operation given to agents is refused");
check(operationsProblem([...operations, operations[0]], personOnly(capabilities), []) !== null, "an operation named twice is refused");
{
  const fake = "paths:\n  /v1/a:\n    get: { operationId: aOne, summary: \"x (M6, ADR 0010) y\" }\n  /v1/b:\n    post:\n      operationId: bTwo\n      summary: \"not it\"\n    put:\n      operationId: bThree\n      summary: \"(M6, ADR 0010)\"\ncomponents:\n  x: 1\n";
  check(JSON.stringify(m6Operations(fake)) === JSON.stringify([{ operation: "aOne", method: "GET", path: "/v1/a" }, { operation: "bThree", method: "PUT", path: "/v1/b" }]), "only operations whose own summary says M6 are read");
}

// ---- paths and names ----
check(fillPath("/v1/workspaces/{ws}/releases/{release}/approve", "ws_1") === `/v1/workspaces/ws_1/releases/rel_${"a1".repeat(16)}/approve` && fillPath("/v1/moderation/app-hosts/{host}/lift", "ws_1") === "/v1/moderation/app-hosts/app.example.com/lift", "parameters are filled with the room and fixed values");
check(throws(() => fillPath("/v1/{nope}", "ws_1")), "a parameter the script doesn't know is refused, never guessed");
check(neighbour("/v1/workspaces/ws_1/release-config") === "/v1/workspaces/ws_1/release-configx" && /^ws_0{32}$/.test(ABSENT_ROOM), "the neighbour is the path with one more character, and the absent room has the API's shape");
check(snake("getReleaseConfig") === "get_release_config" && snake("liftAppHostSuspension") === "lift_app_host_suspension", "an operation's tool name");
check(toolAnswer('{"error":"Tool get_release_config not found"}', "get_release_config") === toolAnswer('{"error":"Tool get_release_config_x not found"}', "get_release_config_x"), "a tool's own name is taken out of its answer before comparing");

// ---- comparing answers ----
{
  const base = [["content-type", "application/json"], ["strict-transport-security", "max-age=31536000"], ["date", "a"], ["cf-ray", "1"]];
  const body = '{"error":{"code":"not_found","message":"not_found"}}';
  const a = answerShape(404, base, body);
  check(a.code === "not_found" && !a.headerNames.includes("date") && !a.headerNames.includes("cf-ray"), "an answer's code is read, and headers that change on every request are left out");
  check(differences(a, answerShape(404, [...base.slice(0, 2), ["date", "b"], ["cf-ray", "2"]], body)).length === 0, "two answers that differ only by time and ray ID are alike");
  check(differences(a, answerShape(409, base, body)).some((d) => d.startsWith("status")), "a different status is a difference");
  check(differences(a, answerShape(404, base, '{"error":{"code":"release_not_available","message":"x"}}')).some((d) => d.startsWith("error code")), "a different code is a difference");
  check(differences(a, answerShape(404, [["content-type", "text/plain"], base[1]], body)).some((d) => d.startsWith("content-type")), "a different content type is a difference");
  check(differences(a, answerShape(404, [base[0]], body)).some((d) => d.includes("strict-transport-security")), "a missing security header is a difference");
  check(differences(a, answerShape(404, [...base, ["x-release", "1"]], body)).some((d) => d.includes("x-release")), "an extra header is a difference");
  check(differences(a, answerShape(404, base, `${body} `)).includes("a different body"), "a different body is a difference");
}

// ---- what counts as M6's ----
check(m6Fields({ id: "ws_1", name: "x", policy_version: 3, members: [{ id: "a" }] }).length === 0, "an ordinary room read has no M6 field");
check(JSON.stringify(m6Fields({ task: { id: "t" }, release_config: {}, roles: [{ app_label: "x" }] })) === JSON.stringify(["release_config", "roles[0].app_label"]), "an M6 field is found anywhere, with where it is");
check(m6Fields({ release: { exists: false } }).length === 0 && m6Fields({ release: { id: "rel_1" } }).length === 1, "M5's release: { exists: false } isn't M6's; any other release is");
check(JSON.stringify(m6Names(["get_task", "release_task", "release_role", "get_task_release_status", "get_release_config", "deploy_release", "request_app_hostname"], operations)) === JSON.stringify(["get_release_config", "deploy_release", "request_app_hostname"]), "M6 names are found, and the task and role releases and M5's release status aren't M6's");
check(JSON.stringify(m6EventTypes([{ type: "task.created" }, { type: "role.released" }, { type: "release.requested" }, { type: "app.suspended" }, { type: "release.requested" }])) === JSON.stringify(["release.requested", "app.suspended"]), "M6 event types are found, once each, and a role's release isn't one");

// ---- the script's source ----
const source = readFileSync(join(here, "m6-staging.mjs"), "utf8");
const lib = readFileSync(join(here, "m6-staging-lib.mjs"), "utf8");
check(source.includes("m6Operations(contractText)") && !/"\/v1\/workspaces\/\$\{room\}\/release-config"|getReleaseConfig"/.test(source), "the script reads the M6 routes from the contract and lists none itself");
check(!/cloudflare\.com|CLOUDFLARE_|wrangler/i.test(source) && !/cloudflare\.com|CLOUDFLARE_|wrangler/i.test(lib), "neither file calls Cloudflare or wrangler");
const code = source.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
check(!/RELEASES|test_releases_on|managed-switch|"enabled":\s*true|enabled: true/.test(code), "the script switches nothing on: no switch is named outside its comments, and no body turns release on");
check(!/spawn|exec(File)?Sync|child_process/.test(source), "the script starts no child process, so no environment is passed on");
check(!/readFileSync\([^)]*(ecret|\.podster)/i.test(source) && source.includes("process.env.PODSTER_E2E_SIGNUP_SECRET"), "the sign-up secret comes from the environment only, and no file is read for it");
check(/const say = \(line = ""\) => console\.log\(scrub\(line, secrets\)\)/.test(source) && !/console\.log\((?!`|"|scrub|USAGE|`)/.test(source.split("const say =")[1] ?? ""), "everything printed once a secret is held goes through scrub");
check(source.includes("PACE_MS") && /for \(let pages = 0; pages < 100/.test(source), "requests are paced, and the one loop over pages is bounded");
for (const { id } of PLAN) check(source.includes(`"${id}"`), `${id} has a check in the script`);
check((source.match(/await person\(/g) ?? []).length === SIGN_UPS.length, "the script signs up exactly the people the plan lists");

// ---- the script as a dry run ----
const work = mkdtempSync(join(tmpdir(), "podster-m6-selftest-"));
try {
  const run = (argv, env = {}) => spawnSync(process.execPath, [join(here, "m6-staging.mjs"), ...argv], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: "utf8", timeout: 60_000 });
  const secret = "s".repeat(40);
  const dry = run(["--base-url", STAGING, "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret });
  check(dry.status === 0 && dry.stdout.includes("Nothing was sent to staging") && PLAN.every(({ id }) => dry.stdout.includes(id)) && dry.stdout.includes(`M6 operations, read from the contract: ${want.length}.`), "a dry run prints the plan and the contract's M6 operations, and exits 0");
  check(!dry.stdout.includes(secret) && !dry.stderr.includes(secret), "a dry run never prints the secret");
  check(run(["--base-url", STAGING, "--dry-run"]).status === 2, "a dry run without the sign-up secret exits 2");
  check(run(["--base-url", "https://gateway.podster.dev", "--dry-run"], { PODSTER_E2E_SIGNUP_SECRET: secret }).status === 2, "another host exits 2");
  const empty = join(work, "empty.yaml");
  writeFileSync(empty, "paths: {}\n");
  check(run(["--base-url", STAGING, "--dry-run", "--contract", empty], { PODSTER_E2E_SIGNUP_SECRET: secret }).status === 2, "a contract with no M6 operation exits 2");
  check(run(["--base-url", STAGING, "--dry-run", "--contract", join(work, "missing.yaml")], { PODSTER_E2E_SIGNUP_SECRET: secret }).status === 2, "a contract that can't be read exits 2");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nM6 staging self-test: all passed");
process.exit(failed ? 1 : 0);
