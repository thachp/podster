#!/usr/bin/env node
// Builds the Rust API Worker for one test suite, into that suite's own folder, and stamps the folder with the features
// it was built with and a hash of what was built. Each suite's vitest config calls `assertApiBuild` on its folder, so a
// build made with other features, or overwritten since by anything else, fails the run before a test starts.
//
// Why: the gateway's tests once rebuilt the API without failpoints into apps/api/build, the folder the API's own tests
// use, and the API's failpoint tests then failed with errors such as "missing caller". Now:
//
//   - apps/api's tests:     apps/api/build,         --features failpoints (wrangler.jsonc's `main` is there)
//   - apps/gateway's tests: apps/gateway/build/api, no features (the shipping build)
//
// so the order the suites run in can't matter, and a stale or mismatched folder is named, with the command that fixes it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = join(ROOT, "apps/api");
export const STAMP = "podster-build.json";
const HASHED = ["index.js", "index_bg.wasm"];

const USAGE = `Usage: scripts/build-api-worker.mjs --out-dir DIR [--features LIST]
       scripts/build-api-worker.mjs --self-test

Builds apps/api with worker-build --release (through scripts/with-pinned-rust) into DIR, a path
relative to apps/api, with the cargo features in LIST (comma-separated; none when left out). It
removes DIR/${STAMP} first and writes it again only when the build succeeds, recording the
features and the SHA-256 of ${HASHED.join(" and ")}.

The vitest configs of apps/api and apps/gateway check that stamp with assertApiBuild, so a folder
built with other features, or rebuilt since by anything else (wrangler deploy, e2e/run-local.mjs,
a plain worker-build), fails the run with the command that fixes it.

Exit 0 on success, worker-build's exit code when it fails, 2 on bad arguments.
--self-test checks the stamp and its check against a temporary folder; it builds nothing.`;

function hashes(dir) {
  return Object.fromEntries(HASHED.map((name) => [name, createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")]));
}

const normal = (features) => [...new Set(features.map((f) => f.trim()).filter(Boolean))].sort();

/** Records, in DIR, the features it was just built with and the hash of what was built. */
export function writeStamp(dir, features) {
  writeFileSync(join(dir, STAMP), JSON.stringify({ features: normal(features), sha256: hashes(dir) }, null, 2) + "\n");
}

/**
 * Throws, saying what's wrong and how to fix it, unless DIR holds a build stamped with exactly FEATURES and unchanged
 * since. DIR is a path or a file: URL; FIX is the command that rebuilds it.
 */
export function assertApiBuild(dir, features, fix) {
  const path = dir instanceof URL ? fileURLToPath(dir) : String(dir);
  const want = normal(features);
  const show = (list) => (list.length ? list.join(",") : "no features");
  const fail = (why) => {
    throw new Error(`The API Worker build in ${path} ${why}. These tests need it built with ${show(want)}. Run: ${fix}`);
  };
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(join(path, STAMP), "utf8"));
  } catch {
    fail(`has no readable ${STAMP}, so what it was built with can't be told (it was never built by scripts/build-api-worker.mjs, or a build failed)`);
  }
  const got = normal(Array.isArray(stamp.features) ? stamp.features : []);
  if (got.join(",") !== want.join(",")) fail(`was built with ${show(got)}`);
  let now;
  try {
    now = hashes(path);
  } catch {
    fail(`is missing ${HASHED.join(" or ")}`);
  }
  for (const name of HASHED) {
    if (stamp.sha256?.[name] !== now[name]) fail(`has a ${name} that changed after it was stamped: something else rebuilt it (wrangler deploy, e2e/run-local.mjs or a plain worker-build)`);
  }
}

function selfTest() {
  let failed = 0;
  const check = (name, fn, expected) => {
    let message = null;
    try {
      fn();
    } catch (error) {
      message = error.message;
    }
    const ok = expected === null ? message === null : message !== null && message.includes(expected);
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(message)}`}`);
  };
  const dir = mkdtempSync(join(tmpdir(), "build-api-worker-"));
  try {
    const fix = "npm run pretest";
    check("an unbuilt folder fails, naming the stamp", () => assertApiBuild(dir, ["failpoints"], fix), `has no readable ${STAMP}`);
    writeFileSync(join(dir, "index.js"), "export default {}\n");
    writeFileSync(join(dir, "index_bg.wasm"), "plain");
    check("a build with no stamp fails", () => assertApiBuild(dir, [], fix), `has no readable ${STAMP}`);
    writeStamp(dir, []);
    check("a plain build passes a check for no features", () => assertApiBuild(dir, [], fix), null);
    check("a plain build fails a check for failpoints, naming both", () => assertApiBuild(dir, ["failpoints"], fix), "was built with no features. These tests need it built with failpoints. Run: npm run pretest");
    writeStamp(dir, ["failpoints"]);
    check("a failpoints build passes a check for failpoints", () => assertApiBuild(pathToFileURL(dir + "/"), [" failpoints", "failpoints"], fix), null);
    check("a failpoints build fails a check for no features", () => assertApiBuild(dir, [], fix), "was built with failpoints. These tests need it built with no features");
    writeFileSync(join(dir, "index_bg.wasm"), "rebuilt plain");
    check("a stamped build overwritten since fails, naming the file", () => assertApiBuild(dir, ["failpoints"], fix), "has a index_bg.wasm that changed after it was stamped");
    writeStamp(dir, ["failpoints"]);
    writeFileSync(join(dir, "index.js"), "export default { changed: true }\n");
    check("a changed index.js fails too", () => assertApiBuild(dir, ["failpoints"], fix), "has a index.js that changed");
    rmSync(join(dir, "index.js"));
    check("a missing file fails", () => assertApiBuild(dir, ["failpoints"], fix), "is missing");
    writeFileSync(join(dir, STAMP), "not json");
    check("an unreadable stamp fails", () => assertApiBuild(dir, ["failpoints"], fix), `has no readable ${STAMP}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `build-api-worker self-test: ${failed} failed` : "build-api-worker self-test: all passed");
  return failed ? 1 : 0;
}

function main(args) {
  if (args[0] === "-h" || args[0] === "--help") {
    console.log(USAGE);
    return 0;
  }
  if (args.length === 1 && args[0] === "--self-test") return selfTest();
  let outDir;
  let features = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out-dir" && args[i + 1] && !args[i + 1].startsWith("-")) outDir = args[++i];
    else if (args[i] === "--features" && args[i + 1] && !args[i + 1].startsWith("-")) features = normal(args[++i].split(","));
    else {
      console.error(`build-api-worker: unexpected argument '${args[i]}'\n\n${USAGE}`);
      return 2;
    }
  }
  if (!outDir) {
    console.error(`build-api-worker: --out-dir is required\n\n${USAGE}`);
    return 2;
  }
  const out = resolve(API, outDir);
  rmSync(join(out, STAMP), { force: true });
  const build = ["worker-build", "--release", "--out-dir", outDir, ...(features.length ? ["--features", features.join(",")] : [])];
  const result = spawnSync(join(ROOT, "scripts/with-pinned-rust"), build, { cwd: API, stdio: "inherit" });
  if (result.error) {
    console.error(`build-api-worker: couldn't run worker-build: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) return result.status ?? 1;
  if (!existsSync(join(out, "index_bg.wasm"))) {
    console.error(`build-api-worker: worker-build succeeded but ${out} has no index_bg.wasm`);
    return 1;
  }
  writeStamp(out, features);
  console.log(`build-api-worker: built ${out} with ${features.length ? features.join(",") : "no features"}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
