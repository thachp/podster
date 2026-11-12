// Checks the parts of M6's staging run that need no network: which host it accepts, its arguments, its exit code, which
// operations and fields it reads from the contract as M6's, how two answers are compared and what the API must have
// answered, and what counts as an M6 name or event. Then the script itself: as a dry run, which sends nothing; against
// m6-staging-standin.mjs, which answers every request on this machine; and what its source does and doesn't do.
//
//   node m6-staging-selftest.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ABSENT_ROOM, agentCapabilities, answerShape, CALLERS, COMPARED_HEADERS, differences, edgeRefusal, expectedAnswer, fillPath, M6_EVENT, m6EventTypes, m6Fields, m6Keys, m6Names, m6Operations, mcpErrorProblem, neighbour, operationsProblem, pairProblem,
  parseArgs, personOnly, PLAN, PLANNED_TOOLS, runOutcome, schemas, scrub, secretProblem, SIGN_UPS, snake, STAGING, stagingOnly, Tally, toolAnswer, toolNotFound,
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

// ---- the plan, the tally and the exit code ----
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
const want = ["getReleaseConfig", "setReleaseConfig", "approveRelease", "declineRelease", "getAppHostname", "requestAppHostname", "removeAppHostname", "createAppReport", "suspendApp", "liftAppSuspension", "suspendAppHost", "liftAppHostSuspension", "stopContentDomain", "resumeContentDomain"];
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
  const clash = [...named].filter((name) => M6_EVENT.test(name) && !/\.(html|js|json|xml|dex)$/.test(name));
  check(named.size > 20 && clash.length === 0, `no event name the API or core writes today looks like M6's (${named.size} read)${clash.length ? `: ${clash.join(", ")}` : ""}`);
}
check(JSON.stringify(m6EventTypes([{ type: "task.created" }, { type: "role.released" }, { type: "release.requested" }, { type: "deploy.started" }, { type: "app.suspended" }, { type: "release.requested" }])) === JSON.stringify(["release.requested", "deploy.started", "app.suspended"]), "M6 event types, deploy included, are found once each, and a role's release isn't one");

// ---- paths and callers ----
check(fillPath("/v1/workspaces/{ws}/releases/{release}/approve", "ws_1") === `/v1/workspaces/ws_1/releases/rel_${"a1".repeat(16)}/approve` && fillPath("/v1/moderation/app-hosts/{host}/lift", "ws_1") === "/v1/moderation/app-hosts/app.example.com/lift", "parameters are filled with the room and fixed values");
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

// ---- the script's source ----
const source = readFileSync(join(here, "m6-staging.mjs"), "utf8");
const lib = readFileSync(join(here, "m6-staging-lib.mjs"), "utf8");
const code = source.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
check(source.includes("m6Operations(contractText)") && source.includes("m6Keys(contractText)") && !/release-config"|getReleaseConfig"/.test(code), "the script reads the M6 routes and fields from the contract and lists none itself");
check(!/cloudflare\.com|CLOUDFLARE_|wrangler/i.test(code) && !/cloudflare\.com|CLOUDFLARE_|wrangler/i.test(lib), "neither file calls Cloudflare or wrangler");
check(!/RELEASES|test_releases_on|managed-switch|"enabled":\s*true|enabled: true/.test(code), "the script switches nothing on: no switch is named outside its comments, and no body turns release on");
check(!/spawn|exec(File)?Sync|child_process/.test(source), "the script starts no child process, so no environment is passed on");
check(!/readFileSync\([^)]*(ecret|\.podster)/i.test(source) && source.includes("process.env.PODSTER_E2E_SIGNUP_SECRET"), "the sign-up secret comes from the environment only, and no file is read for it");
check(/const say = \(line = ""\) => console\.log\(scrub\(line, secrets\)\)/.test(source), "what the run prints goes through scrub");
check(source.includes("PACE_MS") && /for \(let pages = 0; pages < 100/.test(source) && /for \(let pages = 0; pages < 20/.test(source), "requests are paced, and every loop over pages is bounded");
check(/process\.exit\(outcome\.code\)/.test(source) && !/process\.exit\(tally\.exitCode\(\)\)/.test(source), "the exit code is the run's outcome, never the tally's alone: blocker 1");
check(/await preflight\(\)[\s\S]*await main\(\)/.test(source) && source.indexOf("async function preflight") < source.indexOf("async function main") && !/preflight\(\)[\s\S]{0,400}person\(/.test(source.slice(source.indexOf("async function preflight"), source.indexOf("let owner;"))), "a signed-out preflight runs before main, and takes no sign-up");
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
check((source.match(/await person\(/g) ?? []).length === SIGN_UPS.length, "the script signs up exactly the people the plan lists");

// ---- the script as a dry run ----
const work = mkdtempSync(join(tmpdir(), "podster-m6-selftest-"));
try {
  const run = (argv, env = {}) => spawnSync(process.execPath, [join(here, "m6-staging.mjs"), ...argv], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: "utf8", timeout: 60_000 });
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
    const res = spawnSync(process.execPath, ["--import", pathToFileURL(join(here, "m6-staging-standin.mjs")).href, join(here, "m6-staging.mjs"), "--base-url", STAGING], { env: { PATH: process.env.PATH, HOME: process.env.HOME, PODSTER_E2E_SIGNUP_SECRET: secret, M6_STANDIN: mode }, encoding: "utf8", timeout: 60_000 });
    const counted = /stand-in counted: (\d+) requests, (\d+) test sign-ups/.exec(res.stdout);
    const loaded = res.stdout.startsWith(`stand-in for staging: ${mode}; nothing leaves this machine`);
    return { ...res, loaded, requests: counted ? Number(counted[1]) : NaN, signUps: counted ? Number(counted[2]) : NaN };
  };
  const dropped = standIn("drop-signup");
  check(dropped.loaded && dropped.signUps === 1, `a sign-up whose answer is lost in transport is sent once, not again: ${dropped.signUps} sign-up request(s)`);
  check(dropped.status === 1, `a run whose first sign-up's outcome is unknown exits 1, not ${dropped.status}`);
  check(/Whether staging took that sign-up is unknown/.test(dropped.stdout) && /Sign-ups asked for: 1, answered with a session: 0/.test(dropped.stdout) && /Checks shown on staging: 0/.test(dropped.stdout), "it says the sign-up's outcome is unknown, counts it, and shows nothing on staging");
  check(!dropped.stdout.includes(secret) && !dropped.stderr.includes(secret), "it never prints the secret");
  const down = standIn("edge-down");
  check(down.loaded && down.status === 2 && down.signUps === 0 && /No sign-up was taken/.test(down.stderr), `an edge that answers 502 fails the preflight: exit ${down.status}, ${down.signUps} sign-up request(s)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nM6 staging self-test: all passed");
process.exit(failed ? 1 : 0);
