// Runs m4-staging.mjs against the local stack: the web app, the real gateway and the release build of the API under
// `wrangler dev`, with PUBLIC_ROOMS switched on for this run only. It's a rehearsal of M4's staging run, so the script is
// known to work before the owner switches public rooms on at the gate. Afterwards it checks the Workers' logs for the run's
// canaries, report note and tokens, as M4-16 does on staging.
//
//   node run-m4-staging.mjs [--skip-build] [--skip-web-build] [--public-rooms-off]
//
// With --public-rooms-off, the stack runs as staging does today, and the run passes only if the script stops at once with its
// "PUBLIC_ROOMS is off" message and exit code 3.
//
// No operator is named here, since people's IDs are made during the run, so M4-14's operator half is skipped.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.mjs";
import { freePort, local, prepareStack, repo, run, startGateway, startWrangler } from "./stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skipBuild = process.argv.includes("--skip-build");
const flagOff = process.argv.includes("--public-rooms-off");
const web = join(repo, "apps/web");
const { gateway, apiConfig, persist, privateKey, kid } = prepareStack({ skipBuild, apiVars: { ...(flagOff ? {} : { PUBLIC_ROOMS: "true" }), A2A_TOKEN_KEY: randomBytes(32).toString("hex"), EXPLORE_CURSOR_KEY: randomBytes(32).toString("hex") } });
if (!skipBuild && !process.argv.includes("--skip-web-build")) run("npm", ["run", "build"], web);

const [gatewayPort, webPort] = [await freePort(), await freePort()];
const gatewayBase = `http://localhost:${gatewayPort}`;
// Node resolves only plain localhost, and the public page needs no name of its own.
const app = `http://localhost:${webPort}`;
// The gateway's own limits, as staging enforces them, so a rehearsal shows the run paces itself.
const gatewayConfig = join(local, "gateway.wrangler.jsonc");
const { env: _env, ...gatewayBaseConfig } = parseJsonc(readFileSync(join(gateway, "wrangler.jsonc"), "utf8"));
writeFileSync(
  gatewayConfig,
  JSON.stringify({
    ...gatewayBaseConfig,
    main: join(gateway, "src/index.ts"),
    d1_databases: gatewayBaseConfig.d1_databases.map((db) => ({ ...db, migrations_dir: join(gateway, "migrations") })),
  }),
);
const registry = { WRANGLER_REGISTRY_PATH: join(local, "registry") };
// No APP_URL on the gateway: with one, it starts sessions only on the app's host, and this run's people sign up with a password
// on the gateway's, as the other local rehearsals do. The web app still reaches the gateway through its binding.
const vars = { AUTH_SECRET: randomBytes(32).toString("base64"), ASSERTION_SIGNING_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }), BASE_URL: gatewayBase, ENABLE_PASSWORD_SIGNIN: "true" };
const backend = startGateway({ gateway, apiConfig, persist, gatewayConfig, port: gatewayPort, inspectorPort: await freePort(), env: registry, vars, logLevel: "log" });
const dashboard = startWrangler({
  cwd: web,
  command: join(web, "node_modules/.bin/wrangler"),
  env: registry,
  logLevel: "log",
  args: ["--config", "dist/server/wrangler.json", "--port", String(webPort), "--inspector-port", String(await freePort()), "--var", `APP_URL:${app}`, "--var", `GATEWAY_URL:${gatewayBase}`],
});

const deadline = Date.now() + 120_000;
for (;;) {
  const page = await fetch(`http://127.0.0.1:${webPort}/sign-in`, { headers: { host: new URL(app).host }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  const up = await fetch(`${gatewayBase}/.well-known/agent-configuration`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (page?.status === 200 && up?.status === 200) break;
  if (Date.now() > deadline || backend.stack.exitCode !== null || dashboard.stack.exitCode !== null) {
    console.error(backend.log.join("").slice(-3000), dashboard.log.join("").slice(-3000));
    backend.stop();
    dashboard.stop();
    process.exit(1);
  }
  await new Promise((done) => setTimeout(done, 500));
}

const said = [];
const code = await new Promise((done) => {
  const proc = spawn(process.execPath, [join(here, "m4-staging.mjs"), "--base-url", gatewayBase, "--app-url", app], { cwd: here, stdio: ["ignore", "inherit", "pipe"], env: { ...process.env, PODSTER_E2E_SIGNUP_SECRET: "" } });
  proc.stderr.on("data", (chunk) => {
    said.push(String(chunk));
    process.stderr.write(chunk);
  });
  proc.on("exit", (status) => done(status ?? 1));
});
if (flagOff) {
  backend.stop();
  dashboard.stop();
  const stopped = code === 3 && said.join("").includes("PUBLIC_ROOMS is off");
  console.log(`${stopped ? "ok  " : "FAIL"} with public rooms off, the script stops at once and says why: exit ${code}`);
  process.exit(stopped ? 0 : 1);
}
await new Promise((done) => setTimeout(done, 1000));
backend.stop();
dashboard.stop();

const logged = backend.log.join("") + dashboard.log.join("");
let clean = true;
const report = (passed, title, detail = "") => {
  clean &&= passed;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}${detail ? `: ${detail}` : ""}`);
};
console.log("\n## the Workers' logs (M4-16, locally)");
const canaries = logged.match(/zq[a-z]+[0-9a-f]{12}/g) ?? [];
report(canaries.length === 0, "no canary in any log", canaries.length ? `${canaries.length} found` : "");
report(!logged.includes("Staging run report."), "no report note in any log");
const tokenLike = logged.match(/[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{24,}/g) ?? [];
report(tokenLike.length === 0, "no access token in any log", tokenLike.length ? `${tokenLike.length} found` : "");
const unhandled = logged.split("\n").filter((line) => /uncaught|unhandled/i.test(line));
report(unhandled.length === 0, "nothing unhandled in the Workers' logs", unhandled.length ? `${unhandled.length} unhandled` : "");
process.exit(code || (clean ? 0 : 1));
