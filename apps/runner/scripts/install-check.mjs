// Installs a packed Runner .tgz the way `npx podster@test` does and checks what lands on disk:
//
//   node scripts/install-check.mjs <podster-….tgz> [--budget-mb <n>]
//
// npm treats a package from a registry differently from a local .tgz: only a registry's package is installed through its
// shipped npm-shrinkwrap.json, which is how 0.0.1-test.11 put 3.8 GB on disk. So this serves the .tgz from a registry on
// 127.0.0.1, with the `_hasShrinkwrap` flag npm's registry sets, and passes every other request through to
// registry.npmjs.org. It installs `podster@<version>` into a fresh folder with scripts off and an empty npm config, then
// fails unless only this host's Claude Code binary is there, no dev-only package is, the SDK finds its binary, and the
// whole install fits the budget. It publishes nothing and sends no credential. It isn't packed.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, devOnlyNames, folderBytes, hostPlatformPackage, installedPackages, installProblems, isPlatformBinary, mb, PLATFORM_PREFIX, tarballProblems } from "./install-shape.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
/** The host's Claude Code binary is about 350 MB of it; the rest of the production tree is about 60 MB. */
const DEFAULT_BUDGET_MB = 500;
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

const run = (cmd, argv, opts) =>
  new Promise((done, fail) => {
    const child = spawn(cmd, argv, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", fail);
    child.on("close", (status) => done({ status, out }));
  });

// The package's own manifest and whether it ships a shrinkwrap, from the .tgz itself.
const listing = await run("tar", ["-tzf", tarball], {});
if (listing.status !== 0) usage(`can't read ${tarball}`);
const shipsShrinkwrap = listing.out.split("\n").includes("package/npm-shrinkwrap.json");
const manifest = JSON.parse((await run("tar", ["-xzOf", tarball, "package/package.json"], {})).out);
const { name, version } = manifest;
const file = basename(tarball);

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
    // Anything else is the public registry's, passed through unchanged, with no credential.
    const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, { headers: { accept: req.headers.accept ?? "application/json" } });
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
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const sdk = packages.find((p) => p.name === "@anthropic-ai/claude-agent-sdk");
  if (!sdk) throw new Error("the Claude Agent SDK isn't installed");
  const supported = Object.keys(JSON.parse(readFileSync(join(sdk.dir, "package.json"), "utf8")).optionalDependencies ?? {});
  const host = hostPlatformPackage();
  const total = folderBytes(nodeModules);

  // Where the bytes went, biggest first.
  const sizes = packages.map((p) => ({ ...p, bytes: folderBytes(p.dir) })).sort((a, b) => b.bytes - a.bytes);
  process.stdout.write(`\n${name}@${version} (${shipsShrinkwrap ? "ships" : "no"} npm-shrinkwrap.json) on ${process.platform}-${process.arch}\n`);
  process.stdout.write(`installed: ${packages.length} packages, ${mb(total)} MB (budget ${budgetMb} MB)\n`);
  process.stdout.write(`Claude Code binaries: ${packages.filter((p) => isPlatformBinary(p.name)).map((p) => p.name.slice(PLATFORM_PREFIX.length)).join(", ") || "none"}\n`);
  for (const p of sizes.filter((p) => p.name !== name).slice(0, 5)) process.stdout.write(`  ${mb(p.bytes).padStart(8)} MB  ${p.name}@${p.version}\n`);

  // The .tgz itself first: packed on this host, a bundled binary could be this host's and pass the install's checks.
  const devOnly = devOnlyNames(lock);
  const problems = [
    ...tarballProblems({ paths: listing.out.split("\n").filter(Boolean), devOnly }),
    ...installProblems({ packages, host, supported, devOnly, bytes: total, budgetBytes: budgetMb * 1e6 }),
  ];

  // The SDK must find this host's binary from where it's installed, as it does when Runner starts a run.
  if (supported.includes(host)) {
    const probe = `const { createRequire } = require("node:module"); createRequire(process.argv[1]).resolve(process.argv[2]);`;
    const found = await run(process.execPath, ["-e", probe, join(sdk.dir, "package.json"), `${host}/package.json`], { cwd: project, env: childEnv() });
    if (found.status !== 0) problems.push(`the SDK can't resolve ${host} from ${sdk.dir}`);
  }

  // And Runner's modules that load the bundled SDK, MCP SDK and zod import from the installed package. Importing them
  // runs no command.
  const installed = join(nodeModules, ...name.split("/"));
  for (const module of ["build/node/claude-engine.js", "build/node/claude-driver.js"]) {
    const loaded = await run(process.execPath, ["--input-type=module", "-e", "await import(process.argv[1]);", join(installed, module)], { cwd: project, env: childEnv() });
    if (loaded.status !== 0) problems.push(`the installed ${module} doesn't load`);
  }

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
