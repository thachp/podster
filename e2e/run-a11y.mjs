// Starts the gateway, the API and the dashboard's production build, then runs a11y.mjs against them.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.mjs";
import { freePort, local, prepareStack, repo, run, startGateway, startWrangler } from "./stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skipBuild = process.argv.includes("--skip-build");
// Checked before anything builds, and `--browser firefox` is refused rather than quietly running Chromium.
const browserArgs = process.argv.slice(2).filter((arg) => arg.startsWith("--browser"));
const browserName = browserArgs[0]?.slice("--browser=".length);
if (browserArgs.length > 1 || (browserArgs.length === 1 && !["chromium", "firefox", "webkit"].includes(browserName))) {
  console.error(`Choose one browser, as --browser=chromium, --browser=firefox or --browser=webkit, not: ${browserArgs.join(" ")}`);
  process.exit(2);
}
const web = join(repo, "apps/web");

const { gateway, apiConfig, persist, privateKey, kid } = prepareStack({ skipBuild });
if (!skipBuild && !process.argv.includes("--skip-web-build")) run("npm", ["run", "build"], web);

const [gatewayPort, webPort] = [await freePort(), await freePort()];
const gatewayBase = `http://localhost:${gatewayPort}`;
// WebKit on macOS can't resolve a name under localhost, and the app's own port keeps it apart from the gateway.
const app = `http://${browserName === "webkit" ? "" : "app."}localhost:${webPort}`;
// One person walks every screen in seconds, well past a real person's limit of 120 reads a minute, so only this run's
// config raises the limits. Everything else about the gateway is its own.
const gatewayConfig = join(local, "gateway.wrangler.jsonc");
const { env: _env, ...gatewayBaseConfig } = parseJsonc(readFileSync(join(gateway, "wrangler.jsonc"), "utf8"));
writeFileSync(
  gatewayConfig,
  JSON.stringify({
    ...gatewayBaseConfig,
    main: join(gateway, "src/index.ts"),
    d1_databases: gatewayBaseConfig.d1_databases.map((db) => ({ ...db, migrations_dir: join(gateway, "migrations") })),
    ratelimits: gatewayBaseConfig.ratelimits.map((limit) => ({ ...limit, simple: { limit: 100_000, period: 60 } })),
  }),
);
// Workers in separate processes find each other through a registry, and another run's must not answer for these.
const registry = { WRANGLER_REGISTRY_PATH: join(local, "registry") };
const backend = startGateway({
  gateway,
  apiConfig,
  persist,
  gatewayConfig,
  port: gatewayPort,
  inspectorPort: await freePort(),
  env: registry,
  vars: { AUTH_SECRET: randomBytes(32).toString("base64"), ASSERTION_SIGNING_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }), BASE_URL: gatewayBase, APP_URL: app, ENABLE_PASSWORD_SIGNIN: "true", STRICT_PER_MINUTE: "100000" },
});
const dashboard = startWrangler({
  cwd: web,
  command: join(web, "node_modules/.bin/wrangler"),
  env: registry,
  args: ["--config", "dist/server/wrangler.json", "--port", String(webPort), "--inspector-port", String(await freePort()), "--var", `APP_URL:${app}`, "--var", `GATEWAY_URL:${gatewayBase}`],
});

async function waitForStack() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (backend.stack.exitCode !== null || dashboard.stack.exitCode !== null) break;
    // The sign-in page reads through the binding, so it answers only once the dashboard reaches the gateway.
    const res = await fetch(`http://127.0.0.1:${webPort}/sign-in`, { headers: { host: new URL(app).host }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    const up = await fetch(`${gatewayBase}/.well-known/agent-configuration`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (res?.status === 200 && up?.status === 200) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  console.error(backend.log.join("").slice(-3000), dashboard.log.join("").slice(-3000));
  throw new Error("the local stack didn't come up");
}

let code = 1;
try {
  await waitForStack();
  console.log(`dashboard is up at ${app}\n`);
  code = await new Promise((done) => {
    const proc = spawn(process.execPath, [join(here, "a11y.mjs")], { cwd: here, stdio: "inherit", env: { ...process.env, ...(browserName ? { PODSTER_A11Y_BROWSER: browserName } : {}), PODSTER_A11Y_APP: app, PODSTER_A11Y_GATEWAY: gatewayBase } });
    proc.on("exit", (status) => done(status ?? 1));
  });
  if (code !== 0) console.error(`\n--- end of the Workers' logs ---\n${backend.log.join("").slice(-2000)}\n${dashboard.log.join("").slice(-2000)}`);
} catch (error) {
  console.error(error);
} finally {
  backend.stop();
  dashboard.stop();
}
process.exit(code);
