// What an install of Runner's package should hold, shared by scripts/pack.mjs and scripts/install-check.mjs, and tested by
// test/install-shape.test.ts. It isn't packed.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The Claude Agent SDK's per-platform packages: each holds one Claude Code binary, about 350 MB. */
export const PLATFORM_PREFIX = "@anthropic-ai/claude-agent-sdk-";
export const isPlatformBinary = (name) => name.startsWith(PLATFORM_PREFIX);

/** Package names that only the dev tree uses (typecheck, tests, build), from package-lock.json. */
export function devOnlyNames(lock) {
  const dev = new Set();
  const prod = new Set();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") continue;
    const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    (entry.dev ? dev : prod).add(name);
  }
  for (const name of prod) dev.delete(name);
  return dev;
}

/** Every package under a node_modules folder, nested ones too, with its folder. Links aren't followed. */
export function installedPackages(nodeModules) {
  const found = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const at = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        visit(at);
        continue;
      }
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(at, "package.json"), "utf8"));
      } catch {
        continue;
      }
      found.push({ name: manifest.name ?? entry.name, version: manifest.version, dir: at });
      visit(join(at, "node_modules"));
    }
  };
  visit(nodeModules);
  return found;
}

/** The package names a packed .tgz bundles, from its file list (`package/node_modules/…`, nested ones too). */
export function bundledNames(paths) {
  const names = new Set();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] !== "node_modules" || !parts[i + 1] || parts[i + 1].startsWith(".")) continue;
      names.add(parts[i + 1].startsWith("@") ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1]);
    }
  }
  return names;
}

/** What's wrong with a packed .tgz: a shipped shrinkwrap (npm then installs every entry), or a bundled binary or dev tool. */
export function tarballProblems({ paths, devOnly }) {
  const problems = [];
  if (paths.includes("package/npm-shrinkwrap.json")) problems.push("ships npm-shrinkwrap.json, which npm installs whole, every platform and dev entry");
  const bundled = [...bundledNames(paths)];
  const binaries = bundled.filter(isPlatformBinary).sort();
  if (binaries.length > 0) problems.push(`bundles Claude Code binaries: ${binaries.join(", ")}`);
  const dev = bundled.filter((name) => devOnly.has(name)).sort();
  if (dev.length > 0) problems.push(`bundles dev-only packages: ${dev.join(", ")}`);
  return problems;
}

/** Bytes on disk under a folder, by file size, without following links. */
export function folderBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const at = stack.pop();
    const st = lstatSync(at);
    if (st.isDirectory()) for (const name of readdirSync(at)) stack.push(join(at, name));
    else total += st.size;
  }
  return total;
}

/**
 * What's wrong with an installed tree: any Claude Code binary (Runner runs Claude Code only in its own container), a
 * dev-only package, or more bytes than the budget. An empty list means it's right.
 */
export function installProblems({ packages, devOnly, bytes, budgetBytes }) {
  const problems = [];
  const binaries = [...new Set(packages.map((p) => p.name).filter(isPlatformBinary))].sort();
  if (binaries.length > 0) problems.push(`installs Claude Code binaries: ${binaries.join(", ")}`);
  const dev = [...new Set(packages.map((p) => p.name).filter((name) => devOnly.has(name)))].sort();
  if (dev.length > 0) problems.push(`installs dev-only packages: ${dev.join(", ")}`);
  if (bytes > budgetBytes) problems.push(`installs ${mb(bytes)} MB, over the ${mb(budgetBytes)} MB budget`);
  return problems;
}

export const mb = (bytes) => (bytes / 1e6).toFixed(1);

/** The environment npm gets from these scripts: only what it needs to start, never our secrets. */
export function childEnv(own = {}, from = process.env) {
  const env = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA"]) {
    if (from[name] !== undefined) env[name] = from[name];
  }
  return { ...env, ...own };
}
