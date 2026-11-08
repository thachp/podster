// The local gateway and API, shared by the journey and the accessibility checks. Everything lives in e2e/.local and is
// thrown away, so each run starts empty.
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, "..");
export const local = join(here, ".local");
const gateway = join(repo, "apps/gateway");
const api = join(repo, "apps/api");
export const wrangler = join(gateway, "node_modules/.bin/wrangler");
const quiet = { CI: "1", WRANGLER_SEND_METRICS: "false" };

export function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...quiet, ...env } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
}

// Below the range the system hands out for port 0: 32768 and up on Linux, 49152 and up on macOS. The port is only checked here and bound
// later, and the Workers bind many port 0 sockets while starting, so a port from that range can be taken in between.
const PORTS = { first: 20_000, last: 32_767 };
const handedOut = new Set();

const isFree = (port) =>
  new Promise((done) => {
    const server = createServer();
    server.on("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });

export async function freePort() {
  for (let tries = 0; tries < 200; tries++) {
    const port = PORTS.first + Math.floor(Math.random() * (PORTS.last - PORTS.first + 1));
    if (handedOut.has(port) || !(await isFree(port))) continue;
    handedOut.add(port);
    return port;
  }
  throw new Error(`no free port between ${PORTS.first} and ${PORTS.last}`);
}

/** Builds the API, makes throwaway keys, writes its local config and applies both apps' migrations. */
export function prepareStack({ skipBuild = false } = {}) {
  if (!existsSync(wrangler)) {
    console.error("Run `npm ci` in apps/gateway first: this uses that app's pinned wrangler.");
    process.exit(2);
  }
  rmSync(local, { recursive: true, force: true });
  mkdirSync(local, { recursive: true });

  // A real release build, with no failpoints, because that's what a deployment runs.
  if (!skipBuild) run("worker-build", ["--release"], api);

  // A throwaway key pair per run, in the formats docs/staging.md describes.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const kid = "e2e-local";

  // The API's own config, except for what a local run has to differ on. `--var` reaches only the first Worker, so its key
  // goes here. It runs the build above rather than its own. Both apps name their local database `local-only`, which would
  // put their tables in one file, so this one gets its own, as on a deployment.
  const apiConfig = join(local, "api.wrangler.jsonc");
  const { build: _build, env: _env, ...apiBase } = parseJsonc(readFileSync(join(api, "wrangler.jsonc"), "utf8"));
  writeFileSync(
    apiConfig,
    JSON.stringify({
      ...apiBase,
      main: join(api, "build/index.js"),
      vars: { ASSERTION_KEYS: JSON.stringify({ [kid]: publicKey.export({ format: "jwk" }).x }) },
      d1_databases: apiBase.d1_databases.map((db) => ({ ...db, database_id: "e2e-api", migrations_dir: join(api, "migrations") })),
    }),
  );

  const persist = join(local, "state");
  run(wrangler, ["d1", "migrations", "apply", "podster-gateway", "--local", "--persist-to", persist], gateway);
  run(wrangler, ["d1", "migrations", "apply", "podster-api", "--local", "--persist-to", persist, "-c", apiConfig], gateway);
  return { gateway, apiConfig, persist, privateKey, kid };
}

/** Starts a Worker's `wrangler dev` in its own process group, so it can be stopped with all its children. */
export function startWrangler({ cwd, command = wrangler, args, env = {}, logLevel = "warn" }) {
  const log = [];
  const stack = spawn(command, ["dev", ...args, "--ip", "127.0.0.1", "--show-interactive-dev-session=false", "--log-level", logLevel], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, ...quiet, ...env } });
  for (const stream of [stack.stdout, stack.stderr]) stream.on("data", (chunk) => log.push(chunk.toString()));
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-stack.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  };
  process.on("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));
  return { stack, log, stop };
}

export function startGateway({ gateway: cwd, apiConfig, persist, vars, port, inspectorPort, gatewayConfig = join(cwd, "wrangler.jsonc"), extraArgs = [], env = {}, logLevel }) {
  const args = ["-c", gatewayConfig, "-c", apiConfig, ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`]), ...extraArgs, "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", persist];
  return startWrangler({ cwd, args, env, logLevel });
}
