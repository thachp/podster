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
const scripts = readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".mjs") && name !== "child-env-selftest.mjs");
const launches = scripts.flatMap((name) => {
  const source = readFileSync(new URL(name, import.meta.url), "utf8");
  return [...source.matchAll(/\.(launch|launchPersistentContext|launchServer)\(([^\n]*)/g)].map((found) => ({ name, call: `${found[1]}(${found[2]}`.slice(0, 60), listed: /^\{ env: childEnv\(/.test(found[2]) && !/process\.env/.test(found[2]) }));
});
check(launches.length >= 3, `the browsers these scripts start were found (${launches.length})`);
for (const launch of launches.filter((found) => !found.listed)) check(false, `${launch.name} starts a browser with the full environment: ${launch.call}`);
check(launches.every((found) => found.listed), "every browser starts with the allow-listed environment");
// And the script that starts one for the accessibility run, which run-a11y.mjs starts in turn.
check(uses("./run-a11y.mjs", /args: \[join\(here, "a11y\.mjs"\)\],\s*options: \{[^\n]*env: childEnv\(/) && !uses("./run-a11y.mjs", /\.\.\.process\.env/), "a11y.mjs starts with it, and its own named settings");
console.log(failed ? `${failed} failed` : "child-env selftest passed");
process.exit(failed ? 1 : 0);
