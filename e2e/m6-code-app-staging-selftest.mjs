// Checks the parts of M6's staging run with an app with code that need no network: its plan and exit code, the
// figures it holds the deployed content Worker to (read from apps/content and apps/outbound), the app it releases (its
// module run here, with stand-ins for its bindings, fetch and sockets), and how it judges a host's answers. Then the
// script itself: --help, dry runs, which send nothing, and runs against m6-release-staging-standin.mjs, which answers
// every request on this machine, for each way it refuses before it has anything to check.
//
//   npm ci          (once, in this directory: the script itself imports lib.mjs's packages)
//   node m6-code-app-staging-selftest.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterHeadersLine, afterHeadersProblem, APP_LIMITS, appFiles, budgetRefusalProblem, burstPlan, BURST_NEEDS_MS, CLOCK_MARGIN_MS, codeHeaderProblems, CONTENT_DOMAIN, EXIT, LIGHT_ROUNDS, MANIFEST, moduleAnswer, moduleSource, outboundProblems, OUTBOUND_REFUSAL, parseArgs, PLAN, PREFLIGHT_ALLOWANCE, preflightProblem,
  Results, runOutcome, SIGN_UPS, spinProblem, SPIN_ROUNDS, STAGING, STOP_WITHIN_MS, windowStart, WRITE_CAP,
} from "./m6-code-app-staging-lib.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node m6-code-app-staging-selftest.mjs

Checks M6's staging run with an app with code without the network: its plan and exit code, the figures it expects,
the app's module (run here with stand-ins), how it judges answers, a dry run and runs against
m6-release-staging-standin.mjs. Run npm ci in this directory once first. It takes no options and sends nothing anywhere.`);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const missing = ["@auth/agent", "@modelcontextprotocol/sdk/client/index.js"].filter((name) => {
  try {
    import.meta.resolve(name);
    return false;
  } catch {
    return true;
  }
});
if (missing.length) {
  console.error(`m6-code-app-staging-selftest: e2e's packages aren't installed (${missing.join(", ")} not found). Run npm ci in e2e first. No case was run.`);
  process.exit(2);
}

let failed = 0;
const check = (passed, title) => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}`);
};

// ---- the plan and the exit code ----

{
  const ids = PLAN.map((entry) => entry.id);
  check(new Set(ids).size === ids.length, "every check's ID is its own");
  check(JSON.stringify(PLAN.filter((e) => e.outOfScope).map((e) => e.id)) === '["M6-CX1"]' && JSON.stringify(PLAN.filter((e) => e.recordOnly).map((e) => e.id)) === "[]", "one check is out of scope (the store's deletion), and none is only recorded: C09 is judged since 2026-11-26");
  const owed = ["marker", "read", "budget", "fetch", "connect()", "spins", "after its answer's headers", "Unpublish"];
  check(owed.every((word) => PLAN.some((entry) => entry.title.includes(word))), "every item the plan owes a staging run has a check");
  const outcome = (status) => {
    const results = new Results(PLAN, () => {});
    for (const entry of PLAN) results.add(entry.id, entry.outOfScope ? "outOfScope" : entry.recordOnly ? "recorded" : status(entry), "");
    return runOutcome(results, PLAN);
  };
  check(outcome(() => "pass").code === 0, "every judged check passed: exit 0, out of scope and recorded aside");
  const one = outcome((entry) => (entry.id === "M6-C06" ? "fail" : "pass"));
  check(one.code === 1 && JSON.stringify(one.failed) === '["M6-C06"]', "a failure fails the run, named");
  const partial = new Results(PLAN, () => {});
  partial.add("M6-C01", "pass");
  check(runOutcome(partial, PLAN).code === 1, "a judged check with no result fails the run");
  const lines = [];
  // A plan with one recorded-only entry, to show how one prints: the run's own plan has none.
  const TOY = [...PLAN, { id: "T-R01", title: "a toy record", outOfScope: null, recordOnly: "a toy" }];
  const printed = new Results(TOY, (line) => lines.push(line));
  printed.add("M6-C01", "pass");
  printed.add("M6-C02", "fail", "why");
  printed.add("M6-CX1", "outOfScope", "why");
  printed.add("T-R01", "recorded", "seen");
  check(["PASS M6-C01", "FAIL M6-C02", "OUT OF SCOPE M6-CX1", "RECORDED T-R01"].every((start, at) => lines[at].startsWith(start)), "results print as PASS, FAIL, OUT OF SCOPE and RECORDED");
  const refuses = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  check(refuses(() => new Results(PLAN, () => {}).add("M6-C01", "outOfScope")) && refuses(() => new Results(PLAN, () => {}).add("M6-CX1", "pass")) && refuses(() => new Results(TOY, () => {}).add("T-R01", "pass")) && refuses(() => new Results(PLAN, () => {}).add("M6-C09", "recorded")) && refuses(() => printed.add("M6-C01", "pass")), "a judged check can't be out of scope or recorded, nor the others judged, nor any added twice");
  check(SIGN_UPS.length === 2, "the run plans 2 takes of the test sign-up");
  check(parseArgs(["--base-url", STAGING]).options?.base === STAGING && Boolean(parseArgs(["--base-url", "https://example.com"]).error) && parseArgs(["--help"]).options?.help === true, "the arguments are the release run's: staging only");
}

// ---- the figures, read where they are set ----

{
  // The content Worker's configured figures, as its own configuration test pins them, exactly: a change to the
  // configuration fails that test until the test is changed with it. This reads that pin, never the configuration file:
  // no script here but the browser runs names the package's run-time files (that test's own rule).
  const pinned = readFileSync(join(root, "apps/content/test/config.test.ts"), "utf8").match(/expect\(config\.vars\)\.toEqual\((\{[^}]*\})\)/)?.[1] ?? "";
  const vars = (name) => pinned.match(new RegExp(`${name}: "([0-9]+)"`))?.[1];
  check(Number(vars("WRITE_BUDGET_WRITES")) === WRITE_CAP.writes && Number(vars("WRITE_BUDGET_WINDOW_MS")) === WRITE_CAP.windowMs, "the write budget is the content Worker's configured one");
  check(Number(vars("APP_LIMIT_CPU_MS")) === APP_LIMITS.cpuMs && Number(vars("APP_LIMIT_SUBREQUESTS")) === APP_LIMITS.subRequests, "the dispatch's limits are the content Worker's configured ones");
  const refuse = readFileSync(join(root, "apps/outbound/src/refuse.ts"), "utf8");
  check(refuse.includes(`REFUSED_STATUS = ${OUTBOUND_REFUSAL.status};`) && refuse.includes(`REFUSED_BODY = ${JSON.stringify(OUTBOUND_REFUSAL.body)};`), "the outbound refusal is podster-outbound's");
  const requests = readFileSync(join(root, "apps/content/src/requests.ts"), "utf8");
  check(requests.includes(`CODE_ALLOW_METHODS = "${PREFLIGHT_ALLOWANCE.methods}"`) && requests.includes(`CODE_ALLOW_HEADERS = "${PREFLIGHT_ALLOWANCE.headers}"`) && requests.includes('CODE_CACHE_CONTROL = "no-store"') && requests.includes('CODE_ALLOW_ORIGIN = "null"'), "the preflight's allowance, no-store and origin null are the content Worker's");
  const core = readFileSync(join(root, "crates/core/src/app_code.rs"), "utf8");
  check(core.includes('MANIFEST_PATH: &str = "podster-app.json"') && core.includes('MODULES_DIRECTORY: &str = "worker"') && core.includes('MANIFEST_FIELDS: [&str; 2] = ["main", "store"]') && core.includes('STORE_BINDING_NAME: &str = "STORE"'), "the manifest's path and fields, the modules directory and the store's name are core's");
  check(core.includes("pub const CODE_RELEASES_COMPLETE: bool = true;"), "this checkout's gate for apps with code is open");
  const handle = readFileSync(join(root, "apps/content/src/handle.ts"), "utf8");
  check(handle.includes("export const CODE_APPS_ENABLED: boolean = true;"), "this checkout's content Worker serves apps with code");
}

// ---- the app ----

const TAG = "e2e-selftest";
{
  const files = appFiles(TAG);
  check(Object.keys(files).every((path) => path.startsWith("site/")) && JSON.stringify(Object.keys(files).sort()) === '["site/index.html","site/podster-app.json","site/worker/index.js"]', "the app is a page, the manifest and one module, under site/");
  check(JSON.stringify(JSON.parse(files["site/podster-app.json"])) === JSON.stringify(MANIFEST) && files[`site/worker/${MANIFEST.main}`] !== undefined && MANIFEST.store === true, "the manifest names the module and asks for its store, and nothing else");
  let threw = false;
  try {
    moduleSource("Not A Tag");
  } catch {
    threw = true;
  }
  check(threw, "a tag that isn't lowercase letters, digits and dashes is refused");
}

// The module itself, run here: its one import replaced by a stand-in socket, its fetch by a stand-in outbound Worker.
const scratch = mkdtempSync(join(tmpdir(), "m6-code-app-selftest-"));
try {
  const source = moduleSource(TAG);
  check(source.startsWith('import { connect } from "cloudflare:sockets";\n'), "the module's one import is the platform's sockets");
  const checked = join(scratch, "index.mjs");
  writeFileSync(checked, source);
  const syntax = spawnSync(process.execPath, ["--check", checked], { encoding: "utf8" });
  check(syntax.status === 0, "the module is valid JavaScript");
  const sockets = [];
  globalThis.__standinConnect = ({ hostname, port }) => {
    sockets.push(`${hostname}:${port}`);
    const refused = Promise.reject(Object.assign(new Error("proxy request failed, cannot connect to the specified address"), { name: "Error" }));
    refused.catch(() => {});
    return { opened: refused, close() {} };
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(OUTBOUND_REFUSAL.body, { status: OUTBOUND_REFUSAL.status });
  const runnable = source.replace('import { connect } from "cloudflare:sockets";\n', "const connect = (to) => globalThis.__standinConnect(to);\n").replace(String(SPIN_ROUNDS), String(LIGHT_ROUNDS));
  const loaded = join(scratch, "runnable.mjs");
  writeFileSync(loaded, runnable);
  const { default: worker } = await import(loaded);
  const ask = async (path, init = {}, env = { STORE: { prepare: () => ({ first: async () => ({ seven: 7 }) }) } }) => {
    const res = await worker.fetch(new Request(`https://app.${CONTENT_DOMAIN}${path}`, init), env);
    return { status: res.status, headers: [...res.headers], body: await res.text() };
  };
  const plain = await ask("/anything");
  const answered = moduleAnswer(plain.body, TAG);
  check(plain.status === 200 && answered?.path === "/anything" && JSON.stringify(answered.env) === '["STORE"]', "the module answers any path with its source, its path and its bindings' names");
  const dropped = new Headers(plain.headers);
  check(["set-cookie", "access-control-allow-origin", "access-control-allow-credentials", "x-app-probe"].every((name) => dropped.has(name)) && dropped.get("cache-control") === "public, max-age=3600", "every module answer carries the headers the content Worker must drop");
  check(moduleAnswer(plain.body, "e2e-other") === null && moduleAnswer("not json", TAG) === null, "an answer from another run's module, or not JSON, isn't this module's");
  const echoed = await ask("/api/echo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: 3 }) });
  check(moduleAnswer(echoed.body, TAG)?.received?.n === 3 && moduleAnswer(echoed.body, TAG)?.method === "POST", "a write's body comes back as the module received it");
  check(JSON.stringify(moduleAnswer((await ask("/api/store")).body, TAG)?.store) === '{"seven":7}', "the module reads a row from its store");
  check(moduleAnswer((await ask("/api/store", {}, {})).body, TAG)?.store === "none", "without a store, it says so");
  const outbound = moduleAnswer((await ask("/api/outbound")).body, TAG);
  check(outboundProblems(outbound).length === 0 && sockets.length === 2, "with fetch refused and sockets refused at opened, the module's report passes");
  globalThis.fetch = async () => new Response("hello", { status: 200 });
  globalThis.__standinConnect = () => ({ opened: Promise.resolve(), writable: { getWriter: () => ({ write: async () => {} }) }, readable: { getReader: () => ({ read: async () => ({ value: new Uint8Array(5) }) }) }, close() {} });
  const open = moduleAnswer((await ask("/api/outbound")).body, TAG);
  check(outboundProblems(open).length === 4, "with the network reachable, every fetch and socket fails the check");
  globalThis.fetch = realFetch;
  check(typeof moduleAnswer((await ask("/api/spin-light")).body, TAG)?.spun === "number", "the light work answers with its result");
  const streamed = await ask("/api/after-headers");
  check(streamed.status === 200 && streamed.body.startsWith("start\n") && streamed.body.endsWith("end\n"), "unstopped, the streamed answer begins, does its work and ends");
} catch (error) {
  check(false, `the module ran here: ${error?.message ?? error}`);
}

// ---- judging answers ----

{
  const good = [["referrer-policy", "no-referrer"], ["x-content-type-options", "nosniff"], ["strict-transport-security", "max-age=31536000; includeSubDomains"], ["content-security-policy", "sandbox allow-scripts; default-src https://x"], ["cache-control", "no-store"], ["access-control-allow-origin", "null"]];
  check(codeHeaderProblems(good).length === 0, "the fixed headers of a host with code pass");
  check(codeHeaderProblems(good.map(([n, v]) => [n, n === "access-control-allow-origin" ? "*" : v])).length === 1, "an answer readable by any page fails");
  check(codeHeaderProblems(good.map(([n, v]) => [n, n === "cache-control" ? "public, max-age=3600" : v])).length === 1, "an answer that may be kept fails");
  check(codeHeaderProblems([...good, ["x-app-probe", "1"], ["access-control-allow-credentials", "true"]]).length === 2, "the app's own headers passed on fail");
  check(codeHeaderProblems([...good, ["set-cookie", "a=1"]]).length === 1, "a cookie set fails");

  const allowance = [["access-control-allow-origin", "null"], ["access-control-allow-methods", PREFLIGHT_ALLOWANCE.methods], ["access-control-allow-headers", PREFLIGHT_ALLOWANCE.headers], ["cache-control", "no-store"]];
  check(preflightProblem({ status: 204, body: "", headers: allowance }) === null, "the fixed preflight answer passes");
  check(preflightProblem({ status: 403, body: "", headers: allowance }) !== null && preflightProblem({ status: 204, body: "", headers: allowance.map(([n, v]) => [n, n === "access-control-allow-origin" ? "*" : v]) }) !== null, "a refused preflight, or one readable by any page, fails");

  const refusedSocket = { hostname: "h", port: 80, opened: false, bytes: 0, at: "opened", error: { name: "Error" } };
  const report = { fetches: [{ url: "x", ...OUTBOUND_REFUSAL }], sockets: [refusedSocket] };
  check(outboundProblems(report).length === 0, "fetches refused by podster-outbound and a socket refused at opened pass");
  check(outboundProblems({ ...report, fetches: [{ url: "x", status: 403, body: "other" }] }).length === 1, "a 403 that isn't podster-outbound's fails");
  check(outboundProblems({ ...report, sockets: [{ ...refusedSocket, error: { name: "ProbeTimeout" } }] }).length === 1, "a socket that only timed out isn't a refusal");
  check(outboundProblems({ ...report, sockets: [] }).length === 1 && outboundProblems(null).length === 1, "no socket tried, or no report, fails");

  const stopped = { status: 502, body: "app_error\n", headers: good };
  check(spinProblem(stopped, 800, TAG) === null, "502 app_error, quickly, with the fixed headers, passes");
  check(spinProblem(stopped, STOP_WITHIN_MS + 1, TAG) !== null, "a stop later than the bound fails: it wasn't the CPU limit");
  check(spinProblem({ status: 200, body: JSON.stringify({ from: "module", tag: TAG, spun: 1 }), headers: good }, 3000, TAG)?.includes("didn't stop"), "a spin the module finished fails, saying the limit didn't stop it");
  check(spinProblem({ status: 500, body: "x", headers: good }, 100, TAG) !== null, "any other answer fails");

  const W = WRITE_CAP.windowMs;
  const base = 1_000 * W;
  check(windowStart(base + 1234) === base && windowStart(base) === base, "windows are aligned to the epoch");
  const mid = burstPlan(base + 60_000, [base + 30_000]);
  check(mid.waitMs === 0 && mid.windowStartMs === base && mid.admitted.least === WRITE_CAP.writes - 1 && mid.admitted.most === WRITE_CAP.writes - 1, "mid-window, an earlier write in it leaves one fewer for the burst");
  const late = burstPlan(base + W - BURST_NEEDS_MS + 1, [base + 30_000]);
  check(late.waitMs === BURST_NEEDS_MS - 1 + CLOCK_MARGIN_MS && late.windowStartMs === base + W && late.admitted.least === WRITE_CAP.writes && late.admitted.most === WRITE_CAP.writes, "too near the window's end, it waits for the next, where nothing earlier counts");
  const early = burstPlan(base + 1_000, []);
  check(early.waitMs === CLOCK_MARGIN_MS - 1_000, "just after a window starts, it waits out the clock margin");
  const edge = burstPlan(base + 60_000, [base - 1_000, base + 2_000]);
  check(edge.admitted.least === WRITE_CAP.writes - 2 && edge.admitted.most === WRITE_CAP.writes, "writes within the clock margin of the window's start may or may not count");
  check(burstPlan(base + 60_000, [base - W]).admitted.most === WRITE_CAP.writes, "a write in an earlier window doesn't count");

  const now = base + 400_000;
  const spent = (retry, extra = []) => ({ status: 429, body: "write_budget_spent\n", headers: [...good, ["retry-after", retry], ["access-control-expose-headers", "retry-after"], ...extra] });
  check(budgetRefusalProblem(spent("200"), now) === null, "429 write_budget_spent with a Retry-After to the window's end passes");
  check(budgetRefusalProblem(spent("60"), now) !== null, "a Retry-After far from the window's end fails");
  check(budgetRefusalProblem(spent("0"), now) !== null && budgetRefusalProblem(spent("abc"), now) !== null && budgetRefusalProblem(spent("601"), now) !== null, "a Retry-After that isn't whole seconds within the window fails");
  check(budgetRefusalProblem({ ...spent("200"), headers: spent("200").headers.filter(([n]) => n !== "access-control-expose-headers") }, now) !== null, "a Retry-After the page can't read fails");
  check(budgetRefusalProblem({ status: 503, body: "write_budget_unknown\n", headers: good }, now) !== null, "a budget that couldn't be read isn't the budget spent");

  const line = afterHeadersLine({ status: 200, contentType: "text/plain", cacheControl: "no-store", allowOrigin: "null", text: "start\n", bytes: 6, ended: false, error: "TypeError (UND_ERR_SOCKET)", ms: 900 });
  check(line.includes("status 200") && line.includes("6 byte(s)") && line.includes("TypeError"), "what a visitor got after the headers is one line");

  // C09, judged since 2026-11-26: an aborted body or the content Worker's own 502 passes; a clean truncated 200 fails.
  const seenAs = (over) => ({ status: 200, headers: good, text: "start\n", bytes: 6, ended: false, error: "TypeError (UND_ERR_SOCKET)", ms: 900, ...over });
  check(afterHeadersProblem(seenAs({})) === null, "a 200 whose body was aborted after the module's start passes");
  check(afterHeadersProblem(seenAs({ error: "TypeError (ERR_STREAM_PREMATURE_CLOSE)" })) === null, "an aborted body passes whatever the socket's error code");
  check(afterHeadersProblem(seenAs({ status: 502, text: "app_error\n", bytes: 10, ended: true, error: undefined })) === null, "the content Worker's own 502 app_error, held before the headers, passes");
  check(afterHeadersProblem(seenAs({ ended: true, error: undefined }))?.includes("truncated 200"), "a truncated 200 whose body ended normally fails: staging's 2026-11-25 answer");
  check(afterHeadersProblem(seenAs({ ended: true, error: undefined, text: "start\nspun 1\nend\n", bytes: 17 }))?.includes("didn't stop"), "a whole answer fails: the limit didn't stop the module");
  check(afterHeadersProblem(seenAs({ error: "TimeoutError" }))?.includes("hung"), "a body that only hung until the run gave up isn't an abort");
  check(afterHeadersProblem(seenAs({ status: 502, text: "app_error\n", ended: false, bytes: 3 })) !== null && afterHeadersProblem(seenAs({ status: 502, text: "other\n", ended: true, error: undefined })) !== null, "a 502 whose body failed, or that isn't app_error, fails");
  check(afterHeadersProblem(seenAs({ headers: good.map(([n, v]) => [n, n === "cache-control" ? "public, max-age=60" : v]) })) !== null, "an aborted 200 without the fixed headers fails");
  check(afterHeadersProblem(seenAs({ text: "", bytes: 0 })) !== null, "an aborted 200 that didn't begin with the module's start fails");
  check(afterHeadersProblem({ status: undefined, error: "TypeError (ECONNRESET)" }) !== null && afterHeadersProblem(seenAs({ status: 500, ended: true })) !== null, "no answer, or any other status, fails");
}

// ---- the script's source ----

{
  const script = readFileSync(join(here, "m6-code-app-staging.mjs"), "utf8");
  check(!/spawn\(/.test(script) && !/playwright/.test(script), "the script starts no process of its own and no browser: git is m6-release-run.mjs's");
  check(!/api\.cloudflare\.com|gh run|npx /.test(script), "it calls no Cloudflare API, no npx tool and no gh run");
  check(script.includes("publisher.stop()") && script.includes("cleanUpShared()") && /enabled: false/.test(script), "clean-up switches release off, makes the room private, and runs the shared clean-up");
  check(script.includes('run.mask(owner.id, "[owner]")') && script.includes('run.mask(admin.id, "[admin]")'), "both people's IDs are printed as their role");
  check(script.includes("quiet: true") && /for \(let n = 1; n <= WRITE_CAP\.writes \+ BURST_SPARE; n\+\+\)/.test(script), "the burst is bounded and sent one at a time");
}

// ---- the script itself ----

const contract = readFileSync(join(root, "packages/contracts/openapi.yaml"), "utf8");
const noGrant = join(scratch, "openapi-no-deploy.yaml");
writeFileSync(noGrant, contract.replace(/(action: \{ type: string, enum: \[)([^\]]*)\]/g, (whole, start, list) => `${start}${list.split(",").map((v) => v.trim()).filter((v) => v !== "deploy").join(", ")}]`));
const SECRET = "x".repeat(40);
/** Runs the script, with the stand-in in `mode` when given. Answers its exit code, its output and the stand-in's counts. */
function script(args, { mode, secret = SECRET } = {}) {
  const env = { PATH: process.env.PATH, HOME: scratch, ...(secret ? { PODSTER_E2E_SIGNUP_SECRET: secret } : {}), ...(mode ? { M6_RELEASE_STANDIN: mode } : {}) };
  const preload = mode ? ["--import", join(here, "m6-release-staging-standin.mjs")] : [];
  const done = spawnSync(process.execPath, [...preload, join(here, "m6-code-app-staging.mjs"), ...args], { cwd: here, env, encoding: "utf8", timeout: 60_000 });
  const out = `${done.stdout}${done.stderr}`;
  const counted = out.match(/stand-in: (\d+) requests, (\d+) sign-ups, (\d+) sign-outs/);
  return { code: done.status, out, requests: counted ? Number(counted[1]) : null, signUps: counted ? Number(counted[2]) : null, signOuts: counted ? Number(counted[3]) : null };
}
const base = ["--base-url", STAGING];
try {
  {
    const help = script(["--help"], { secret: null });
    check(help.code === 0 && /^Usage:/m.test(help.out), "--help prints the usage and exits 0");
    check(script(["--base-url", "https://example.com"]).code === EXIT.refused, "another host exits 2");
  }
  {
    const dry = script([...base, "--dry-run"], { mode: "edge-down" });
    check(dry.code === 0 && dry.out.includes("Nothing was sent") && dry.requests === 0, "a dry run on this checkout's contract exits 0 and sends nothing");
    check(PLAN.every((entry) => dry.out.includes(entry.id)) && dry.out.includes("[out of scope:") && !dry.out.includes("[recorded, not judged:"), "the dry run prints every check, marking the out-of-scope one, and none as only recorded");
    const missingGrant = script([...base, "--dry-run", "--contract", noGrant], { mode: "edge-down" });
    check(missingGrant.code === EXIT.releaseNotOn && missingGrant.out.includes("no route gives a deploy grant") && missingGrant.requests === 0, "a contract without the deploy grant exits 3, naming it, and sends nothing");
    const noSecret = script([...base, "--dry-run"], { mode: "edge-down", secret: null });
    check(noSecret.code === EXIT.refused && noSecret.requests === 0, "a dry run without the sign-up secret exits 2");
    const realNoSecret = script([...base], { mode: "edge-down", secret: null });
    check(realNoSecret.code === EXIT.refused && realNoSecret.requests === 0, "a real run without the sign-up secret exits 2 and sends nothing");
  }
  {
    const down = script([...base], { mode: "edge-down" });
    check(down.code === EXIT.refused && down.signUps === 0 && down.out.includes("No sign-up was taken"), "an edge that answers 502 fails the preflight: exit 2, no sign-up");
    const off = script([...base], { mode: "off" });
    check(off.code === EXIT.releaseNotOn && off.signUps === 0 && off.out.includes("deploy_release"), "release off on staging: exit 3, no sign-up, naming deploy_release");
    const noContent = script([...base], { mode: "no-content" });
    check(noContent.code === EXIT.releaseNotOn && noContent.signUps === 0 && noContent.out.includes(CONTENT_DOMAIN), "no content Worker on the content domain: exit 3, no sign-up");
    const notAvailable = script([...base], { mode: "not-available" });
    check(notAvailable.code === EXIT.releaseNotOn && notAvailable.signUps === 1 && notAvailable.signOuts === 1 && notAvailable.out.includes("release_not_available"), "a provider with the release path incomplete: exit 3 after the owner's sign-up alone, signed out");
    check(!notAvailable.out.includes(SECRET) && !/podster_session=s{10}/.test(notAvailable.out), "neither the sign-up secret nor the session reaches the output");
    check(!notAvailable.out.includes("per_e2e_standin") && notAvailable.out.includes("[owner]"), "the owner's person ID is printed as [owner]");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} case(s) failed.` : "\nm6-code-app-staging-selftest: every case passed.");
process.exit(failed ? 1 : 0);
