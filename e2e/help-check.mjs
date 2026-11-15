// A check that every script an agent may run answers --help and does nothing else. CLAUDE.md says each such script
// has --help; PR #396 found nine staging scripts here that ignored it and started building or running.
//
//   node help-check.mjs [--self-test]
//
// What it runs, found by pattern so a new one is never left out:
// - every executable file under scripts/;
// - every file here named `*staging*.mjs` or `run-*.mjs`.
// A file that matches and isn't an entry point (a library, a preload) is in NOT_ENTRY with its reason, and every other
// file under scripts/ must be executable or be there too. An entry there that matches nothing fails, so the list
// can't go stale.
//
// Each runs as `<script> --help`, with child-env.mjs's allow-listed environment and nothing of ours that's secret, for
// at most TIMEOUT_MS. It passes when it exits 0 within that, prints a line with "usage" on stdout, and starts nothing:
// - a Node script runs with help-check-guard.mjs loaded first, which writes down and refuses any child process, fetch,
//   socket, HTTP request or name lookup;
// - a shell script runs with stand-ins first on PATH for the programs that build, deploy or reach the network (git,
//   gh, curl, npm, node, cargo, wrangler and the like), which write down that they ran and exit 97.
//
// KNOWN GAPS. It is a net, not a sandbox, and these pass it:
// - a shell script that calls a program by its full path (`/usr/bin/curl`), or one that isn't stood in for;
// - a Node script that reaches the network or a program through a native addon, `process.binding`, or a module
//   loaded before the guard;
// - anything that waits to start until after --help's output and exit;
// - a file written, changed or deleted: nothing stops or records a write;
// - work started in a `worker_threads` Worker, or a request through `node:http2`, neither of which the guard replaces;
// - a shell tool with no stand-in, such as jq, make, perl or rustc, or a build run through one of them.
//
// A floor keeps the patterns honest: if scripts/ or e2e/ gives fewer scripts to run than FLOOR names, it fails, so a
// moved folder or a broken pattern can't pass by checking nothing.
//
// Exit 1 if any script fails or the lists are wrong.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./child-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const GUARD = join(here, "help-check-guard.mjs");
const TIMEOUT_MS = 15_000;

/** Files the patterns match, or files under scripts/ that aren't executable, that aren't run, each with its reason. */
export const NOT_ENTRY = {
  "e2e/m4-staging-lib.mjs": "a library m4-staging.mjs and its self-test import",
  "e2e/m5-staging-lib.mjs": "a library m5-staging.mjs and its self-test import",
  "e2e/m6-staging-lib.mjs": "a library m6-staging.mjs and its self-test import",
  "e2e/m6-staging-kept.mjs": "a library m6-staging.mjs imports for its kept file",
  "e2e/m6-staging-standin.mjs": "a preload m6-staging-selftest.mjs loads with --import, never run by itself",
  "scripts/requesters-rule.mjs": "a module merge-gate's rule is read from, not executable",
  "scripts/test/lib.sh": "sourced by the self-tests, not executable",
  "scripts/test/fixtures/": "captured JSON the merge-gate self-test reads",
};

/** Programs a shell script's --help must never start. */
export const STOOD_IN = [
  "bun", "cargo", "curl", "docker", "gh", "git", "nc", "node", "npm", "npx", "pnpm", "python", "python3", "rustup", "scp", "ssh", "wget",
  "worker-build", "wrangler", "yarn",
];

/** The fewest scripts each folder must give to run: today's counts, 8 and 19, less a small margin. */
export const FLOOR = { "scripts/": 7, "e2e/": 17 };

const ENTRY = /^(?:.*staging.*|run-.*)\.mjs$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/**
 * What to run, from the repository at `base`: `{ run, skipped, problems }`, each path relative to `base`. `notEntry`
 * is NOT_ENTRY's shape; a key ending in `/` covers a whole directory.
 */
export function discover(base = root, notEntry = NOT_ENTRY, floor = FLOOR) {
  const run = [];
  const skipped = [];
  const problems = [];
  const used = new Set();
  const listed = (path) => Object.keys(notEntry).find((key) => (key.endsWith("/") ? path.startsWith(key) : path === key));
  const consider = (path, matches) => {
    const key = listed(path);
    if (key) {
      used.add(key);
      if (!String(notEntry[key] ?? "").trim()) problems.push(`${key} is in NOT_ENTRY with no reason`);
      skipped.push(path);
    } else if (matches) run.push(path);
    else problems.push(`${path} isn't executable and isn't in NOT_ENTRY: make it executable with --help, or list it with its reason`);
  };
  const scripts = join(base, "scripts");
  if (existsSync(scripts)) for (const file of walk(scripts)) consider(relative(base, file), (statSync(file).mode & 0o111) !== 0);
  for (const name of readdirSync(join(base, "e2e")).sort()) {
    if (ENTRY.test(name) && statSync(join(base, "e2e", name)).isFile()) consider(`e2e/${name}`, true);
  }
  for (const key of Object.keys(notEntry)) if (!used.has(key)) problems.push(`${key} is in NOT_ENTRY but matches no file: remove it`);
  for (const [folder, least] of Object.entries(floor)) {
    const found = run.filter((path) => path.startsWith(folder)).length;
    if (found < least) problems.push(`${folder} gave ${found} scripts to run, fewer than its floor of ${least}: a pattern or a folder is wrong`);
  }
  return { run, skipped, problems };
}

function standIns(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of STOOD_IN) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(`ran ${name}`)} >> "$HELP_CHECK_LOG"\nexit 97\n`);
    chmodSync(file, 0o755);
  }
}

/** Runs one script with --help. Returns null if it passed, or why it didn't. */
export const runHelp = (file, options) => helpRun(file, options).why;

/** Runs one script with --help: `{ why, stdout }`, `why` null if it passed. */
export function helpRun(file, { base = root, timeout = TIMEOUT_MS } = {}) {
  const work = mkdtempSync(join(tmpdir(), "help-check-"));
  try {
    const log = join(work, "started");
    writeFileSync(log, "");
    const bin = join(work, "bin");
    standIns(bin);
    const env = childEnv({ PATH: `${bin}:${process.env.PATH ?? ""}`, HELP_CHECK_LOG: log, HOME: work, TMPDIR: work });
    const path = join(base, file);
    const node = file.endsWith(".mjs") || file.endsWith(".js");
    const [command, args] = node ? [process.execPath, ["--import", GUARD, path, "--help"]] : [path, ["--help"]];
    const result = spawnSync(command, args, { cwd: dirname(path), env, encoding: "utf8", timeout, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
    const started = readFileSync(log, "utf8").split("\n").filter(Boolean);
    const why = [];
    if (result.error?.code === "ETIMEDOUT" || result.signal) why.push(`didn't finish within ${timeout / 1000} s`);
    else if (result.error) why.push(`couldn't be started: ${result.error.code ?? result.error.message}`);
    else if (result.status !== 0) why.push(`exited ${result.status}`);
    if (started.length) why.push(`started ${[...new Set(started)].join(", ")}`);
    if (!/usage/i.test(result.stdout ?? "")) why.push("printed no usage on stdout");
    return { why: why.length ? why.join("; ") : null, stdout: result.stdout ?? "" };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function selfTest() {
  let failed = 0;
  const base = mkdtempSync(join(tmpdir(), "help-check-cases-"));
  const expect = (title, got, wanted) => {
    const passed = wanted instanceof RegExp ? wanted.test(String(got)) : JSON.stringify(got) === JSON.stringify(wanted);
    if (!passed) failed++;
    console.log(`${passed ? "ok  " : "FAIL"} ${title}${passed ? "" : `\n     wanted ${wanted}\n     got    ${JSON.stringify(got)}`}`);
  };
  try {
    mkdirSync(join(base, "e2e"));
    mkdirSync(join(base, "scripts/test"), { recursive: true });
    const write = (file, text, mode = 0o644) => {
      writeFileSync(join(base, file), text);
      chmodSync(join(base, file), mode);
    };
    const usage = 'if (process.argv.includes("--help")) {\n  console.log("Usage: node x.mjs");\n  process.exit(0);\n}\n';
    write("e2e/run-good.mjs", usage);
    write("e2e/run-spawns.mjs", 'import { spawnSync } from "node:child_process";\nspawnSync("true");\nconsole.log("Usage: x");\n');
    write("e2e/run-spawns-later.mjs", 'import * as cp from "node:child_process";\nconsole.log("Usage: x");\ntry { cp.execFileSync("true"); } catch {}\n');
    write("e2e/run-fetches.mjs", 'console.log("Usage: x");\ntry { await fetch("https://example.invalid/"); } catch {}\n');
    write("e2e/run-connects.mjs", 'import net from "node:net";\nconsole.log("Usage: x");\ntry { net.connect(9, "127.0.0.1"); } catch {}\n');
    write("e2e/run-requests.mjs", 'import { request } from "node:https";\nconsole.log("Usage: x");\ntry { request("https://example.invalid/"); } catch {}\n');
    write("e2e/run-stderr.mjs", 'console.error("Usage: x");\n');
    write("e2e/run-fails.mjs", 'console.log("Usage: x");\nprocess.exit(2);\n');
    write("e2e/run-hangs.mjs", 'console.log("Usage: x");\nsetInterval(() => {}, 1000);\n');
    write("e2e/x-staging-lib.mjs", "export const a = 1;\n");
    write("e2e/other.mjs", "throw new Error('never run');\n");
    write("scripts/good", '#!/usr/bin/env bash\nif [ "${1:-}" = --help ]; then\n  cat <<EOF\nUsage: scripts/good\nEOF\n  exit 0\nfi\nexit 1\n', 0o755);
    write("scripts/curls", '#!/usr/bin/env bash\ncurl -s https://example.invalid/ || true\necho "Usage: scripts/curls"\n', 0o755);
    write("scripts/builds", '#!/usr/bin/env bash\necho "Usage: scripts/builds"\nnpm run build >/dev/null 2>&1 || true\n', 0o755);
    write("scripts/secret", '#!/usr/bin/env bash\necho "Usage: ${PODSTER_E2E_TOKEN:-none} ${CLOUDFLARE_API_TOKEN:-none}"\n', 0o755);
    write("scripts/test/lib.sh", "true\n");

    const notEntry = { "e2e/x-staging-lib.mjs": "a library", "scripts/test/lib.sh": "sourced" };
    const found = discover(base, notEntry, {});
    expect("the patterns find every run-*.mjs and executable script, and no other file", found.run.sort(), [
      "e2e/run-connects.mjs", "e2e/run-fails.mjs", "e2e/run-fetches.mjs", "e2e/run-good.mjs", "e2e/run-hangs.mjs", "e2e/run-requests.mjs", "e2e/run-spawns-later.mjs",
      "e2e/run-spawns.mjs", "e2e/run-stderr.mjs", "scripts/builds", "scripts/curls", "scripts/good", "scripts/secret",
    ]);
    expect("a listed library isn't run", found.skipped, ["scripts/test/lib.sh", "e2e/x-staging-lib.mjs"]);
    expect("with everything listed there's no problem", found.problems, []);
    expect("an unlisted staging library is run, and so fails closed", discover(base, { "scripts/test/lib.sh": "sourced" }, {}).run.includes("e2e/x-staging-lib.mjs"), true);
    expect("an unlisted file under scripts/ that isn't executable fails", discover(base, { "e2e/x-staging-lib.mjs": "a library" }, {}).problems, [
      "scripts/test/lib.sh isn't executable and isn't in NOT_ENTRY: make it executable with --help, or list it with its reason",
    ]);
    expect("an entry that matches nothing fails", discover(base, { ...notEntry, "e2e/gone-staging.mjs": "gone" }, {}).problems, ["e2e/gone-staging.mjs is in NOT_ENTRY but matches no file: remove it"]);
    expect("an entry with no reason fails", discover(base, { ...notEntry, "scripts/test/lib.sh": " " }, {}).problems, ["scripts/test/lib.sh is in NOT_ENTRY with no reason"]);

    const run = (file) => runHelp(file, { base, timeout: 3_000 });
    expect("a Node script that prints usage and exits passes", run("e2e/run-good.mjs"), null);
    expect("a Node script that starts a child process fails", run("e2e/run-spawns.mjs"), /started child_process\.spawnSync/);
    expect("  even through a namespace import, with the error caught and exit 0", run("e2e/run-spawns-later.mjs"), /^started child_process\.execFileSync$/);
    expect("a fetch fails, though caught", run("e2e/run-fetches.mjs"), /^started fetch$/);
    expect("a socket fails", run("e2e/run-connects.mjs"), /^started net\.connect$/);
    expect("an HTTPS request fails", run("e2e/run-requests.mjs"), /^started https\.request$/);
    expect("usage on stderr only fails", run("e2e/run-stderr.mjs"), /^printed no usage on stdout$/);
    expect("a non-zero exit fails", run("e2e/run-fails.mjs"), /^exited 2$/);
    expect("a script that keeps running fails on the timeout", run("e2e/run-hangs.mjs"), /^didn't finish within 3 s$/);
    expect("a shell script that prints usage with cat passes", run("scripts/good"), null);
    expect("a shell script that runs curl fails, though it exits 0", run("scripts/curls"), /^started ran curl$/);
    expect("a shell script that starts a build fails", run("scripts/builds"), /^started ran npm$/);
    const before = { ...process.env };
    process.env.PODSTER_E2E_TOKEN = "e2e-secret-value";
    process.env.CLOUDFLARE_API_TOKEN = "cf-secret-value";
    try {
      expect("our secrets never reach the script", helpRun("scripts/secret", { base, timeout: 3_000 }), { why: null, stdout: "Usage: none none\n" });
    } finally {
      for (const name of ["PODSTER_E2E_TOKEN", "CLOUDFLARE_API_TOKEN"]) if (before[name] === undefined) delete process.env[name];
    }
    const empty = mkdtempSync(join(tmpdir(), "help-check-empty-"));
    mkdirSync(join(empty, "e2e"));
    try {
      expect("discovery that finds nothing fails on the floor", discover(empty, {}, { "scripts/": 1, "e2e/": 1 }).problems, [
        "scripts/ gave 0 scripts to run, fewer than its floor of 1: a pattern or a folder is wrong",
        "e2e/ gave 0 scripts to run, fewer than its floor of 1: a pattern or a folder is wrong",
      ]);
      expect("  and so does the real floor", discover(empty, {}).problems.length, 2);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect("a folder below its floor fails, the other doesn't", discover(base, notEntry, { "scripts/": 5, "e2e/": 9 }).problems, [
      "scripts/ gave 4 scripts to run, fewer than its floor of 5: a pattern or a folder is wrong",
    ]);
    expect("the real lists have no problem, and meet the floor", discover().problems, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : "\nhelp-check self-test: all passed");
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest());
  const { run, skipped, problems } = discover();
  for (const problem of problems) console.log(`FAIL ${problem}`);
  let failedRuns = 0;
  for (const file of run) {
    const why = runHelp(file);
    if (why) failedRuns++;
    console.log(`${why ? "FAIL" : "ok  "} ${file} --help${why ? `: ${why}` : ""}`);
  }
  console.log(`(${skipped.length} files not run, each listed in NOT_ENTRY with its reason)`);
  const bad = problems.length + failedRuns;
  console.log(bad ? `\nhelp-check: ${failedRuns} of ${run.length} scripts failed, ${problems.length} list problems` : `\nhelp-check: ${run.length} scripts, each answered --help and started nothing`);
  process.exit(bad ? 1 : 0);
}
