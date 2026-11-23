// Installs a packed Runner .tgz the way `npx podster@test` does and checks what lands on disk:
//
//   node scripts/install-check.mjs <podster-….tgz> [--budget-mb <n>]
//
// npm treats a package from a registry differently from a local .tgz: only a registry's package is installed through its
// shipped npm-shrinkwrap.json, which is how 0.0.1-test.11 put 3.8 GB on disk. So this serves the .tgz from a registry on
// 127.0.0.1, with the `_hasShrinkwrap` flag npm's registry sets, and passes every other request through to
// registry.npmjs.org for the packages Runner's lock names. It installs `podster@<version>` into a fresh folder with scripts
// off and an empty npm config, then fails if any Claude Code binary is there (Runner runs Claude Code only in its own
// container, and tells the SDK so), or any dev-only package, or the install passes the budget, or the installed SDK,
// given Runner's own options, starts anything but the container's binary, or npm asked the registry for any package but
// Runner's (with no shrinkwrap, everything must come from the bundle), or the installed CLI's `--help` or any of Runner's
// modules that load a bundled SDK fails to start. It publishes nothing and sends no credential.
// It isn't packed.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, devOnlyNames, folderBytes, installedPackages, installProblems, mb, resolutionProblems, tarballProblems } from "./install-shape.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
/**
 * The production tree was about 43 MB, with no Claude Code binary (each is about 350 MB). The experimental OpenAI adapter's
 * three pinned packages (2026-11-22) brought it to 82.2 MB, `openai` alone 24.2 MB, so the budget went from 60 to 100 MB:
 * still far below one Claude Code binary, which is what it is here to catch. Bundling `@modelcontextprotocol/client`, which
 * agents-core imports at load though npm lists it as optional (0.0.1-test.18 couldn't start without it), made it 90.9 MB.
 */
const DEFAULT_BUDGET_MB = 100;
const UPSTREAM = "https://registry.npmjs.org";

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("usage: node scripts/install-check.mjs <podster-….tgz> [--budget-mb <n>]\n");
  process.exit(message ? 1 : 0);
}

const args = process.argv.slice(2);
if (args.includes("--help")) usage();
let budgetMb = DEFAULT_BUDGET_MB;
const budgetAt = args.indexOf("--budget-mb");
if (budgetAt >= 0) {
  budgetMb = Number(args[budgetAt + 1]);
  if (!Number.isFinite(budgetMb) || budgetMb <= 0) usage("--budget-mb needs a positive number.");
  args.splice(budgetAt, 2);
}
if (args.length !== 1) usage("install-check.mjs needs one .tgz.");
const tarball = resolve(args[0]);
const bytes = readFileSync(tarball);

// Every child is killed after 5 minutes, so a hung start fails the check instead of waiting for CI's job limit.
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const run = (cmd, argv, opts) =>
  new Promise((done, fail) => {
    const child = spawn(cmd, argv, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      process.stderr.write(`install check: ${cmd} timed out after ${RUN_TIMEOUT_MS / 1000} s\n`);
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", (e) => (clearTimeout(timer), fail(e)));
    child.on("close", (status) => (clearTimeout(timer), done({ status, out })));
  });

// The package's own manifest and whether it ships a shrinkwrap, from the .tgz itself.
const listing = await run("tar", ["-tzf", tarball], {});
if (listing.status !== 0) usage(`can't read ${tarball}`);
const shipsShrinkwrap = listing.out.split("\n").includes("package/npm-shrinkwrap.json");
const manifest = JSON.parse((await run("tar", ["-xzOf", tarball, "package/package.json"], {})).out);
const { name, version } = manifest;
const file = basename(tarball);

// The only other packages it passes through: the ones Runner's lock names, plus the package's own dependencies, each by
// a fixed URL built from that list, never from the request. npm asks for nothing else here: the shrinkwrap's or bundle's
// packages come by their recorded tarball URLs, straight from npm's registry.
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const passThrough = new Map();
for (const known of [
  ...Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }),
  ...Object.entries(lock.packages).filter(([path]) => path !== "").map(([path, entry]) => entry.name ?? path.slice(path.lastIndexOf("node_modules/") + 13)),
]) {
  passThrough.set(`/${known}`, `${UPSTREAM}/${known.replaceAll("/", "%2f")}`);
}

/** Runs the installed package's own `claudeOptions` through its bundled SDK's `query`, recording each command spawned. */
const START_PROBE = `
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
const driver = await import(pathToFileURL(join(root, "build/node/claude-driver.js")).href);
const sdk = await import(pathToFileURL(createRequire(join(root, "package.json")).resolve("@anthropic-ai/claude-agent-sdk")).href);
const commands = [];
const abort = new AbortController();
const session = { frame: "probe", allowed_tools: ["StructuredOutput"], limits: { turns: 1 }, result_schema: { type: "object" } };
const options = driver.claudeOptions({
  session, cwd: "/work", env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1" },
  mcp: sdk.createSdkMcpServer({ name: "runner", version: "1.0.0", tools: [] }), hook: async () => ({}), abortController: abort,
  spawn: (o) => { commands.push(o.command); return spawn(process.execPath, ["-e", ""], { stdio: ["pipe", "pipe", "pipe"] }); },
});
try { for await (const _ of sdk.query({ prompt: "x", options })) break; } catch (e) { if (commands.length === 0) { console.error(String(e && e.message)); process.exit(1); } }
abort.abort();
console.log(JSON.stringify(commands));
process.exit(0);
`;

/** Every request npm made for anything but Runner's own package, forwarded or refused: with no shrinkwrap, there must be none. */
const asked = [];

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    const base = `http://127.0.0.1:${server.address().port}`;
    if (decodeURIComponent(url.pathname) === `/${name}`) {
      const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      const shasum = createHash("sha1").update(bytes).digest("hex");
      const doc = {
        name,
        "dist-tags": { latest: version, test: version },
        versions: { [version]: { ...manifest, _hasShrinkwrap: shipsShrinkwrap, dist: { tarball: `${base}/${name}/-/${file}`, integrity, shasum } } },
      };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(doc));
      return;
    }
    if (url.pathname === `/${name}/-/${file}`) {
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
      return;
    }
    // A package Runner names is the public registry's, passed through unchanged, with no credential. Anything else: 404.
    asked.push(url.pathname);
    const target = passThrough.get(decodeURIComponent(url.pathname));
    if (!target) {
      res.writeHead(404).end();
      return;
    }
    const upstream = await fetch(target, { headers: { accept: req.headers.accept === "application/json" ? "application/json" : "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" } });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(502).end();
  }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));

const work = mkdtempSync(join(tmpdir(), "podster-install-check-"));
let failed = true;
try {
  const project = join(work, "project");
  const npmrc = join(work, "npmrc");
  writeFileSync(npmrc, "");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "install-check", version: "0.0.0", private: true }));
  const registry = `http://127.0.0.1:${server.address().port}/`;
  const install = await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", `--userconfig=${npmrc}`, `--registry=${registry}`, "--replace-registry-host=never", `${name}@${version}`],
    { cwd: project, env: childEnv() },
  );
  process.stdout.write(install.out);
  if (install.status !== 0) throw new Error(`npm install failed (exit ${install.status})`);

  const nodeModules = join(project, "node_modules");
  const packages = installedPackages(nodeModules);
  const sdk = packages.find((p) => p.name === "@anthropic-ai/claude-agent-sdk");
  if (!sdk) throw new Error("the Claude Agent SDK isn't installed");
  const total = folderBytes(nodeModules);

  // Where the bytes went, biggest first.
  const sizes = packages.map((p) => ({ ...p, bytes: folderBytes(p.dir) })).sort((a, b) => b.bytes - a.bytes);
  process.stdout.write(`\n${name}@${version} (${shipsShrinkwrap ? "ships" : "no"} npm-shrinkwrap.json) on ${process.platform}-${process.arch}\n`);
  process.stdout.write(`installed: ${packages.length} packages, ${mb(total)} MB (budget ${budgetMb} MB)\n`);
  for (const p of sizes.filter((p) => p.name !== name).slice(0, 5)) process.stdout.write(`  ${mb(p.bytes).padStart(8)} MB  ${p.name}@${p.version}\n`);

  // The .tgz itself first: packed on this host, a bundled binary could be this host's and pass the install's checks.
  const devOnly = devOnlyNames(lock);
  const problems = [
    ...tarballProblems({ paths: listing.out.split("\n").filter(Boolean), devOnly }),
    ...installProblems({ packages, devOnly, bytes: total, budgetBytes: budgetMb * 1e6 }),
    ...resolutionProblems({ shipsShrinkwrap, asked }),
  ];
  process.stdout.write(`requests beyond ${name} at the local registry: ${asked.length}\n`);

  // With no binary installed, the installed SDK, given Runner's own options, must start only the container's binary,
  // through Runner's spawn (a stand-in here that exits at once, so nothing runs and no model is called).
  const installedRoot = join(nodeModules, ...name.split("/"));
  const probe = join(work, "start-probe.mjs");
  writeFileSync(probe, START_PROBE);
  const started = await run(process.execPath, [probe, installedRoot], { cwd: project, env: childEnv() });
  const commands = started.status === 0 ? JSON.parse(started.out.trim().split("\n").pop() ?? "null") : null;
  process.stdout.write(`the installed SDK started: ${JSON.stringify(commands)}\n`);
  if (!Array.isArray(commands) || commands.length !== 1 || commands[0] !== "/opt/claude/claude") problems.push("the installed SDK, given Runner's options, didn't start exactly /opt/claude/claude");

  // And Runner's modules that load the bundled SDKs import from the installed package: the Claude ones, and the
  // experimental OpenAI adapter's, which the CLI loads only when the policy picks it. Importing them runs no command.
  for (const module of ["build/node/claude-engine.js", "build/node/claude-driver.js", "build/node/openai-engine.js", "build/node/openai-driver.js"]) {
    const loaded = await run(process.execPath, ["--input-type=module", "-e", "await import(process.argv[1]);", join(installedRoot, module)], { cwd: project, env: childEnv() });
    if (loaded.status !== 0) problems.push(`the installed ${module} doesn't load`);
  }

  // And the installed CLI itself starts, as `npx podster@test --help` would: it loads every module the CLI imports at
  // start, and touches no network, key, home folder or Docker (help prints and returns before any of them).
  const cli = await run(process.execPath, [join(installedRoot, manifest.bin.podster), "--help"], { cwd: project, env: childEnv() });
  process.stdout.write(`the installed CLI's --help exited ${cli.status}\n`);
  if (cli.status !== 0 || !cli.out.includes("Podster Runner")) problems.push(`the installed CLI didn't start (\`--help\` exited ${cli.status})`);

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`install check: ${problem}\n`);
    process.exitCode = 1;
  } else {
    failed = false;
    process.stdout.write("install check passed\n");
  }
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}
