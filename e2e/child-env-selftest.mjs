// Checks that a third-party program started by these scripts can't see a secret of ours.
//
//   node child-env-selftest.mjs
import { childEnv } from "./child-env.mjs";

let failed = 0;
const check = (passed, title) => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}`);
};
const parent = {
  PATH: "/usr/bin", HOME: "/home/x", PODSTER_E2E_SIGNUP_SECRET: "s", CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t",
  GITHUB_TOKEN: "g", ANTHROPIC_API_KEY: "k", AWS_SECRET_ACCESS_KEY: "w", SOME_PASSWORD: "p", npm_config_cache: "/c",
};
const env = childEnv({ RUN_SECONDS: "2", LANGSMITH_TRACING: "false" }, parent);
const names = Object.keys(env);
check(env.PATH === "/usr/bin" && env.HOME === "/home/x", "PATH and HOME are passed on");
check(env.RUN_SECONDS === "2" && env.LANGSMITH_TRACING === "false", "the tool's own named settings are passed on");
check(!names.includes("PODSTER_E2E_SIGNUP_SECRET"), "PODSTER_E2E_SIGNUP_SECRET isn't");
check(!names.some((n) => n.startsWith("CLOUDFLARE_")), "no CLOUDFLARE_* is");
check(!names.some((n) => /SECRET|TOKEN|KEY/i.test(n)), "nothing named like SECRET, TOKEN or KEY is");
check(names.every((n) => ["PATH", "HOME", "RUN_SECONDS", "LANGSMITH_TRACING"].includes(n)), "nothing else is");
let refused = false;
try {
  childEnv({ PODSTER_E2E_SIGNUP_SECRET: "x" }, parent);
} catch {
  refused = true;
}
check(refused, "naming a secret as the tool's own setting is refused");
// And the real environment, as these scripts run now.
check(!Object.keys(childEnv()).some((n) => /SECRET|TOKEN|KEY|^CLOUDFLARE_|^PODSTER_E2E_/i.test(n)), "this process's own environment gives a child none of those");
// Each script that starts third-party code passes it this environment: the kit and the servers, and the staging browser.
import { readFileSync } from "node:fs";
const uses = (file, pattern) => pattern.test(readFileSync(new URL(file, import.meta.url), "utf8"));
check(uses("./run-a2a-kit.mjs", /spawn\(join\(kit, "\.venv\/bin\/python"\), args, \{[^}]*env: childEnv\(\)/), "the kit starts with it");
check(uses("./run-fasta2a-check.mjs", /env: childEnv\(\{ RUN_SECONDS \}\)/), "fasta2a starts with it");
check(uses("./run-langgraph-check.mjs", /env: childEnv\(\{ LANGGRAPH_CLI_NO_ANALYTICS/), "LangGraph starts with it");
check(uses("./a2a-roundtrip.mjs", /chromium\.launch\(\{ env: childEnv\(\) \}\)/) && !uses("./a2a-roundtrip.mjs", /chromium\.launch\(\)/), "the staging browser starts with it");
// Every browser these scripts start, wherever it is: a launch without the allow-listed environment inherits everything of ours.
import { readdirSync } from "node:fs";
const LAUNCH = "launch(?:PersistentContext|Server)?";

/** The text of a call from just after its opening bracket to its matching close, across lines. Quoted text isn't counted. */
function callText(source, from) {
  let depth = 1;
  let quote = null;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return source.slice(from, i);
  }
  return source.slice(from);
}

/**
 * How many browsers `source` starts as it should, and each place it could start one any other way. The only form allowed
 * is `.launch({ env: childEnv(...) ... })` with one `env`, no `process.env` and nothing spread in. A launch reached through
 * a quoted name, taken out of its object or kept under another name can't be checked here, so each is refused.
 */
function launchProblems(source) {
  const problems = [];
  let allowed = 0;
  const shown = (at) => source.slice(at, at + 70).split("\n")[0];
  for (const found of source.matchAll(new RegExp(`\\.\\s*${LAUNCH}\\b\\s*(\\()?`, "g"))) {
    if (!found[1]) {
      problems.push(`keeps a launch under another name: ${shown(found.index)}`);
      continue;
    }
    const call = callText(source, found.index + found[0].length);
    const envs = call.match(/\benv\s*:/g)?.length ?? 0;
    if (!/^\{ env: childEnv\(/.test(call)) problems.push(`starts a browser with the full environment: ${shown(found.index)}`);
    else if (envs !== 1) problems.push(`sets a browser's environment ${envs} times, and the last one wins: ${shown(found.index)}`);
    else if (/process\.env|\.\.\./.test(call)) problems.push(`spreads something into a browser's options, or reads process.env there: ${shown(found.index)}`);
    else allowed++;
  }
  for (const found of source.matchAll(new RegExp(`\\[\\s*["'\`]${LAUNCH}["'\`]\\s*\\]`, "g"))) problems.push(`reaches a launch by a quoted name: ${shown(found.index)}`);
  for (const found of source.matchAll(new RegExp(`\\{[^{}=]*\\b${LAUNCH}\\b[^{}=]*\\}\\s*=[^=>]`, "g"))) problems.push(`takes a launch out of its object: ${shown(found.index)}`);
  return { allowed, problems };
}

// The check itself, on each way round it.
{
  const refuses = (source) => launchProblems(source).problems.length > 0 && launchProblems(source).allowed === 0;
  const good = launchProblems("const browser = await playwright.chromium.launch({ env: childEnv() });\nawait chromium.launch({ env: childEnv({ A: 1 }), headless: true });");
  check(good.allowed === 2 && good.problems.length === 0, "a browser started with the allow-listed environment is accepted, with other options too");
  check(refuses("await chromium.launch();") && refuses("await chromium.launch({ headless: true });"), "one started with no environment named is refused");
  check(refuses("await chromium.launch({ env: process.env });") && refuses("await chromium.launch({ env: { ...process.env } });"), "one given the full environment is refused");
  check(refuses('await chromium["launch"]();') && refuses("await chromium['launch']({ env: childEnv() });") && refuses('await playwright[name][ "launchPersistentContext" ](dir);'), "a launch reached by a quoted name is refused");
  check(refuses("const start = chromium.launch;\nawait start();") && refuses("const start = chromium.launch.bind(chromium);") && refuses("const { launch } = chromium;\nawait launch();") && refuses("const { launch: start } = playwright.chromium;"), "a launch kept under another name is refused");
  check(refuses("await chromium.launch({ env: childEnv(),\n  env: process.env });") && refuses("await chromium.launch({ env: childEnv(),\n  headless: true,\n  env: everything });"), "a second env on a following line is refused");
  check(refuses("await chromium.launch({ env: childEnv(), ...options });"), "options spread in are refused");
  check(refuses("await chromium.launchPersistentContext(dir, { env: childEnv() });") && refuses("await chromium.launchServer();"), "the other ways to start one are refused unless the environment comes first");
  const plain = launchProblems('function launch(ms) {}\nlaunch(1);\nawait work("Write the launch plan", inReview);');
  check(plain.allowed === 0 && plain.problems.length === 0, "a function or a sentence that only uses the word isn't a browser");
}

/** Every .mjs under e2e/, in its folders too, except what's installed or made by a run. */
function scriptsUnder(folder, prefix = "") {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "results") return [];
    if (entry.isDirectory()) return scriptsUnder(new URL(`${entry.name}/`, folder), `${prefix}${entry.name}/`);
    return entry.name.endsWith(".mjs") ? [`${prefix}${entry.name}`] : [];
  });
}
// Not this file, whose examples above are the wrong ways on purpose.
const scripts = scriptsUnder(new URL(".", import.meta.url)).filter((name) => name !== "child-env-selftest.mjs");
check(scripts.some((name) => name.includes("/")), `scripts in folders under e2e/ are read too (${scripts.length} in all)`);
let started = 0;
let wrong = 0;
for (const name of scripts) {
  const { allowed, problems } = launchProblems(readFileSync(new URL(name, import.meta.url), "utf8"));
  started += allowed;
  wrong += problems.length;
  for (const problem of problems) check(false, `${name} ${problem}`);
}
check(started >= 3, `the browsers these scripts start were found (${started})`);
check(wrong === 0, "every browser starts with the allow-listed environment");
// And the script that starts one for the accessibility run, which run-a11y.mjs starts in turn.
check(uses("./run-a11y.mjs", /args: \[join\(here, "a11y\.mjs"\)\],\s*options: \{[^\n]*env: childEnv\(/) && !uses("./run-a11y.mjs", /\.\.\.process\.env/), "a11y.mjs starts with it, and its own named settings");
console.log(failed ? `${failed} failed` : "child-env selftest passed");
process.exit(failed ? 1 : 0);
