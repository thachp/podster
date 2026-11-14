// How long each API and gateway test took against its own time bound, read from vitest's JSON report after the suite
// runs in CI. A test that used more than a third of its bound fails the step, unless test-durations-allow.json lists it
// with a reason and a ceiling of its own, which it must stay under. The ten slowest are printed either way, so a slow
// runner shows in the log before a test times out.
//
//   node test-durations.mjs --suite api --package apps/api --report FILE
//   node test-durations.mjs --self-test
//
// Each test's bound is `meta.bound`, which apps/<package>/test/bound-meta.ts records from the test's own timeout (the
// config's testTimeout, or the one the test passes). A test that ran without one fails the step: the setup file is
// missing from the config, and nothing could be judged. Skipped and todo tests aren't judged.
//
// Exit codes: 0 when every test is within its share; 1 when one isn't, an entry is stale or unreasoned, or a test has
// no bound; 2 for a report or allow-list that can't be read.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ALLOW = join(here, "test-durations-allow.json");

/** The share of its bound a test may use before it fails the step. */
export const SHARE = 1 / 3;
/** The highest ceiling an allow-list entry may give: past it, a test is too near its timeout to be listed. */
export const MOST = 3 / 4;
const JUDGED = new Set(["passed", "failed"]);

/** Every judged test in a vitest JSON report, as `{ file, test, status, ms, bound }`, `file` relative to the package. */
export function tests(report, packageDir) {
  return report.testResults.flatMap((module) =>
    module.assertionResults
      .filter((result) => JUDGED.has(result.status))
      .map((result) => ({ file: relative(packageDir, module.name).split("\\").join("/"), test: result.fullName, status: result.status, ms: Math.round(result.duration ?? 0), bound: result.meta?.bound })),
  );
}

const pct = (share) => `${Math.round(share * 100)}%`;
const named = (t) => `${t.file} › ${t.test}`;

/** What's wrong with an entry itself, or null. */
function entryProblem(entry) {
  if (typeof entry.suite !== "string" || typeof entry.file !== "string" || typeof entry.test !== "string") return "it needs a suite, a file and a test";
  if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) return "it needs a reason";
  if (typeof entry.owed !== "boolean") return "it needs owed true or false";
  if (typeof entry.ceiling !== "number" || !(entry.ceiling > SHARE && entry.ceiling <= MOST)) return `its ceiling must be over ${pct(SHARE)} and at most ${pct(MOST)}`;
  return null;
}

/** The verdict on one suite's tests: `{ over, noBound, stale, unreasoned, allowed, settled }`. */
export function judge(found, allow, suite) {
  const mine = allow.filter((entry) => entry.suite === suite);
  const entryOf = (t) => mine.find((entry) => entry.file === t.file && entry.test === t.test);
  const noBound = found.filter((t) => !(typeof t.bound === "number" && t.bound > 0));
  const over = [];
  const allowed = [];
  for (const t of found) {
    if (noBound.includes(t)) continue;
    const share = t.ms / t.bound;
    const entry = entryOf(t);
    if (share <= SHARE) continue;
    if (entry && !entryProblem(entry) && share <= entry.ceiling) allowed.push({ ...t, share, entry });
    else over.push({ ...t, share, limit: entry && !entryProblem(entry) ? entry.ceiling : SHARE });
  }
  const stale = mine.filter((entry) => !found.some((t) => t.file === entry.file && t.test === entry.test));
  const unreasoned = mine.map((entry) => ({ entry, problem: entryProblem(entry) })).filter(({ problem }) => problem);
  // Listed, but within a third this run: worth knowing, never a failure, since a run's times vary.
  const settled = mine.filter((entry) => found.some((t) => t.file === entry.file && t.test === entry.test && t.bound > 0 && t.ms / t.bound <= SHARE));
  return { over, noBound, stale, unreasoned, allowed, settled };
}

/** The ten slowest, slowest first, each with its share of its bound. */
export function slowest(found, count = 10) {
  return [...found]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, count)
    .map((t) => `${String(t.ms).padStart(7)} ms of ${t.bound > 0 ? `${t.bound} (${pct(t.ms / t.bound)})` : "no bound"}  ${named(t)}`);
}

/** The step's whole output and exit code, for one suite's report. */
export function run(report, allow, { suite, packageDir }) {
  const found = tests(report, packageDir);
  const verdict = judge(found, allow, suite);
  const lines = [`${suite}: the ${Math.min(10, found.length)} slowest of ${found.length} tests:`, ...slowest(found)];
  for (const t of verdict.over) lines.push(`OVER ${named(t)}: ${t.ms} ms is ${pct(t.share)} of its ${t.bound} ms bound, over ${pct(t.limit)}${t.limit === SHARE ? "" : " (its entry's ceiling)"}`);
  for (const t of verdict.noBound) lines.push(`NO BOUND ${named(t)}: its meta has no bound, so test/bound-meta.ts isn't in the config's setupFiles`);
  for (const entry of verdict.stale) lines.push(`test-durations-allow.json: no such ${suite} test ran: ${entry.file} › ${entry.test}`);
  for (const { entry, problem } of verdict.unreasoned) lines.push(`test-durations-allow.json: ${problem}: ${entry.file} › ${entry.test}`);
  for (const t of verdict.allowed) lines.push(`listed ${named(t)}: ${pct(t.share)} of its bound, under its ceiling of ${pct(t.entry.ceiling)}${t.entry.owed ? " (owed)" : ""}`);
  for (const entry of verdict.settled) lines.push(`listed, but within ${pct(SHARE)} this run: ${entry.file} › ${entry.test}`);
  const failed = verdict.over.length + verdict.noBound.length + verdict.stale.length + verdict.unreasoned.length;
  lines.push(failed ? `\ntest-durations: ${suite} failed (${failed})` : `\ntest-durations: ${suite} passed: every test within ${pct(SHARE)} of its bound, or under its entry's ceiling`);
  return { lines, code: failed ? 1 : 0 };
}

function selfTest() {
  let failed = 0;
  const check = (passed, title, detail = "") => {
    if (!passed) failed++;
    console.log(`${passed ? "ok  " : "FAIL"} ${title}${passed || !detail ? "" : `\n     ${detail}`}`);
  };
  const pkg = "/repo/apps/api";
  const report = (...cases) => ({ testResults: [{ name: `${pkg}/test/a.spec.ts`, assertionResults: cases.map(([fullName, duration, bound, status = "passed"]) => ({ fullName, duration, status, meta: bound === undefined ? {} : { bound } })) }] });
  const entry = (more) => ({ suite: "api", file: "test/a.spec.ts", test: "slow", ceiling: 0.5, owed: true, reason: "waits out the product's own five-second limit", ...more });
  const verdict = (r, allow = []) => {
    const v = judge(tests(r, pkg), allow, "api");
    return { over: v.over.length, noBound: v.noBound.length, stale: v.stale.length, unreasoned: v.unreasoned.length, allowed: v.allowed.length, settled: v.settled.length };
  };
  const is = (title, got, wanted) => check(JSON.stringify(got) === JSON.stringify(wanted), title, `wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
  const none = { over: 0, noBound: 0, stale: 0, unreasoned: 0, allowed: 0, settled: 0 };

  is("a test within a third of its bound passes, and exactly a third is within", verdict(report(["quick", 100, 30000], ["edge", 10000, 30000])), none);
  is("a test over a third of its bound fails", verdict(report(["slow", 10001, 30000])), { ...none, over: 1 });
  is("the bound is the test's own: 6 s is over a third of a 15 s bound and within a third of 30 s", verdict(report(["short", 6000, 15000], ["long", 6000, 30000])), { ...none, over: 1 });
  is("a test with no bound in its meta fails, as does one with a zero bound", verdict(report(["bare", 10], ["zero", 10, 0])), { ...none, noBound: 2 });
  is("skipped and todo tests aren't judged, and a failed one is", verdict(report(["s", 0, undefined, "skipped"], ["t", 0, undefined, "todo"], ["f", 20000, 30000, "failed"])), { ...none, over: 1 });
  is("a listed test over a third but under its ceiling passes", verdict(report(["slow", 12000, 30000]), [entry()]), { ...none, allowed: 1 });
  is("a listed test over its own ceiling fails", verdict(report(["slow", 16000, 30000]), [entry()]), { ...none, over: 1 });
  is("an entry for a test that didn't run is stale", verdict(report(["quick", 100, 30000]), [entry()]), { ...none, stale: 1 });
  is("a listed test within a third is noted, not failed", verdict(report(["slow", 100, 30000]), [entry()]), { ...none, settled: 1 });
  is("an entry for another suite or file doesn't apply here", verdict(report(["slow", 12000, 30000]), [entry({ suite: "gateway" }), entry({ file: "test/b.spec.ts" })]), { ...none, over: 1, stale: 1 });
  is("an entry with no reason, no owed, or a ceiling out of range fails, and allows nothing", verdict(report(["slow", 12000, 30000]), [entry({ reason: "slow" }), entry({ owed: undefined }), entry({ ceiling: 0.9 }), entry({ ceiling: 0.3 })]), { ...none, over: 1, unreasoned: 4 });

  const ten = report(...Array.from({ length: 12 }, (_, i) => [`t${i}`, (i + 1) * 100, 30000]));
  const lines = slowest(tests(ten, pkg));
  check(lines.length === 10 && lines[0].includes("1200 ms of 30000 (4%)  test/a.spec.ts › t11") && lines[9].includes("› t2"), "the ten slowest are printed slowest first, with each one's bound and share", lines.join(" | "));
  const passing = run(ten, [], { suite: "api", packageDir: pkg });
  check(passing.code === 0 && passing.lines[0] === "api: the 10 slowest of 12 tests:" && /passed/.test(passing.lines.at(-1)), "a passing run still prints its ten slowest, and exits 0", passing.lines.join(" | "));
  const failing = run(report(["slow", 10001, 30000]), [], { suite: "api", packageDir: pkg });
  check(failing.code === 1 && failing.lines.some((line) => line === "OVER test/a.spec.ts › slow: 10001 ms is 33% of its 30000 ms bound, over 33%"), "a failing run names the test, its time, its bound and the share it went over, and exits 1", failing.lines.join(" | "));

  const list = JSON.parse(readFileSync(ALLOW, "utf8"));
  const problems = list.entries.map((e) => entryProblem(e)).filter(Boolean);
  check(Array.isArray(list.entries) && problems.length === 0 && list.entries.every((e) => ["api", "gateway"].includes(e.suite)), "every entry in test-durations-allow.json is well formed", problems.join("; "));

  console.log(failed ? `\n${failed} failed` : "\ntest-durations self-test: all passed");
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest());
  const option = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const [suite, packageName, reportPath] = [option("--suite"), option("--package"), option("--report")];
  if (!suite || !packageName || !reportPath) {
    console.error("usage: node test-durations.mjs --suite api --package apps/api --report FILE");
    process.exit(2);
  }
  let report;
  let allow;
  try {
    report = JSON.parse(readFileSync(resolve(reportPath), "utf8"));
    allow = JSON.parse(readFileSync(ALLOW, "utf8")).entries;
  } catch (error) {
    console.error(`test-durations: couldn't read the report or the allow-list: ${error.message}. The suite may not have run.`);
    process.exit(2);
  }
  const { lines, code } = run(report, allow, { suite, packageDir: join(root, packageName) });
  console.log(lines.join("\n"));
  process.exit(code);
}
