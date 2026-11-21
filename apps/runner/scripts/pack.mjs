// Packs Runner's .tgz, the only way it should be packed: `node scripts/pack.mjs --out <folder>`, after `npm run build`.
//
// Runner bundles its production dependencies (`bundleDependencies`), installed from package-lock.json by `npm ci` with
// integrity checked, so an install gets the exact bytes CI tested. It doesn't ship npm-shrinkwrap.json: npm reads a
// dependency's shrinkwrap only after its per-platform check, so every entry installs, which put all eight Claude Code
// binaries and the dev tools on every machine (3.8 GB). And it installs no Claude Code binary at all: Runner runs Claude
// Code only in its own container (`claude-image/Dockerfile` fetches and checks it), and tells the SDK that binary's path,
// so the SDK never looks for one on the host.
//
// So the bundle must hold exactly the production tree, with no dev tool and none of the SDK's per-platform packages
// (`@anthropic-ai/claude-agent-sdk-*`). A plain `npm pack` in this folder would bundle whatever the dev install holds, so
// this packs from a fresh copy instead: package.json, package-lock.json and the `files`, installed with
// `npm ci --omit=dev --omit=optional`, scripts off. It refuses a platform package anywhere in package.json or the bundle.
// It prints the file's name and SHA-256. scripts/install-check.mjs then installs it as npx would and checks what lands.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, devOnlyNames, installedPackages, isPlatformBinary } from "./install-shape.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("usage: node scripts/pack.mjs --out <folder>\n");
  process.exit(message ? 1 : 0);
}

const args = process.argv.slice(2);
if (args.includes("--help")) usage();
const outAt = args.indexOf("--out");
if (outAt < 0 || !args[outAt + 1] || args.length !== 2) usage("pack.mjs needs --out <folder> and nothing else.");
const out = resolve(args[outAt + 1]);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
if (!existsSync(join(root, pkg.bin.podster))) usage(`${pkg.bin.podster} isn't built. Run \`npm run build\` first.`);
const declared = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).filter(isPlatformBinary);
if (declared.length > 0) usage(`package.json names ${declared.join(", ")}. Runner installs no Claude Code binary; see this script's header.`);
if (existsSync(join(root, "npm-shrinkwrap.json"))) usage("npm-shrinkwrap.json is back. Runner ships a bundle, not a shrinkwrap; see this script's header.");

const run = (cwd, argv) => {
  const r = spawnSync("npm", argv, { cwd, env: childEnv(), stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    process.stderr.write(r.stdout ?? "");
    throw new Error(`npm ${argv[0]} failed (exit ${r.status})`);
  }
  return r.stdout;
};

const stage = mkdtempSync(join(tmpdir(), "podster-pack-"));
try {
  for (const entry of ["package.json", "package-lock.json", ...pkg.files]) {
    const from = join(root, entry);
    if (!existsSync(from)) throw new Error(`${entry}, named in package.json, isn't there`);
    cpSync(from, join(stage, entry), { recursive: true });
  }
  run(stage, ["ci", "--ignore-scripts", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"]);

  // What gets bundled is exactly this tree: refuse a platform binary or a dev tool before packing it.
  const devOnly = devOnlyNames(lock);
  const bad = installedPackages(join(stage, "node_modules")).filter((p) => isPlatformBinary(p.name) || devOnly.has(p.name));
  if (bad.length > 0) throw new Error(`the bundle would carry ${bad.map((p) => p.name).join(", ")}`);

  mkdirSync(out, { recursive: true });
  const before = new Set(readdirSync(out));
  const packed = JSON.parse(run(stage, ["pack", "--ignore-scripts", "--json", "--pack-destination", out]));
  const file = packed[0].filename;
  if (before.has(file)) process.stderr.write(`note: replaced ${file} in ${out}\n`);
  const sha = createHash("sha256").update(readFileSync(join(out, file))).digest("hex");
  process.stdout.write(`${sha}  ${file}\n`);
  process.stdout.write(`packed ${packed[0].entryCount} files, ${(packed[0].size / 1e6).toFixed(1)} MB (${(packed[0].unpackedSize / 1e6).toFixed(1)} MB unpacked)\n`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
