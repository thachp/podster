// How long each API and gateway test took against its own time bound, read from vitest's JSON report after the suite
// runs in CI. Three bands:
//
// - within a third of its bound: fine;
// - over a third: a warning, as a `::warning::` annotation on the test's file, and exit 0. test-durations-allow.json is
//   the owed list of these, each with why it's slow and what would bring it down; a warning names that, or says the
//   test isn't on the list;
// - over two thirds: the step fails, listed or not. That leaves a slow runner room before a test times out.
//
// The ten slowest are printed either way, so a slow runner shows in the log before it turns into a timeout.
//
//   node test-durations.mjs --suite api --package apps/api --report FILE
//   node test-durations.mjs --self-test
//
// Each test's bound is `meta.bound`, which apps/<package>/test/bound-meta.ts records from the test's own timeout (the
// config's testTimeout, or the one the test passes). A test that ran without one fails the step: the setup file is
// missing from the config, and nothing could be judged. Skipped and todo tests aren't judged.
//
// Exit codes: 0 when no test is over two thirds of its bound (warnings included); 1 when one is, an entry is stale or
// malformed, or a test has no bound; 2 for a report or owed list that can't be read.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ALLOW = join(here, "test-durations-allow.json");

/** Over this share of its bound, a test is warned about. */
export const WARN = 1 / 3;
/** Over this share of its bound, a test fails the step, whether it's on the owed list or not. */
export const FAIL = 2 / 3;
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
  if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) return "it needs a reason: why the test is slow";
  if (typeof entry.fix !== "string" || entry.fix.trim().length < 20) return "it needs a fix: what would bring it down";
  return null;
}

/** The verdict on one suite's tests: `{ failing, warned, noBound, stale, malformed, settled }`. */
export function judge(found, allow, suite) {
  const mine = allow.filter((entry) => entry.suite === suite);
  const entryOf = (t) => mine.find((entry) => entry.file === t.file && entry.test === t.test);
  const noBound = found.filter((t) => !(typeof t.bound === "number" && t.bound > 0));
  const failing = [];
  const warned = [];
  for (const t of found) {
    if (noBound.includes(t)) continue;
    const share = t.ms / t.bound;
    if (share > FAIL) failing.push({ ...t, share, entry: entryOf(t) });
    else if (share > WARN) warned.push({ ...t, share, entry: entryOf(t) });
  }
  const stale = mine.filter((entry) => !found.some((t) => t.file === entry.file && t.test === entry.test));
  const malformed = mine.map((entry) => ({ entry, problem: entryProblem(entry) })).filter(({ problem }) => problem);
  // Listed, but within a third this run: worth knowing, never a failure, since a run's times vary.
  const settled = mine.filter((entry) => found.some((t) => t.file === entry.file && t.test === entry.test && t.bound > 0 && t.ms / t.bound <= WARN));
  return { failing, warned, noBound, stale, malformed, settled };
}

/** A GitHub annotation's message, escaped as the runner wants it. */
const escaped = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** The ten slowest, slowest first, each with its share of its bound. */
export function slowest(found, count = 10) {
  return [...found]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, count)
    .map((t) => `${String(t.ms).padStart(7)} ms of ${t.bound > 0 ? `${t.bound} (${pct(t.ms / t.bound)})` : "no bound"}  ${named(t)}`);
}

/** The step's whole output and exit code, for one suite's report. `packageName` is the package's path in the repository. */
export function run(report, allow, { suite, packageDir, packageName }) {
  const found = tests(report, packageDir);
  const verdict = judge(found, allow, suite);
  const lines = [`${suite}: the ${Math.min(10, found.length)} slowest of ${found.length} tests:`, ...slowest(found)];
  const took = (t) => `${t.ms} ms is ${pct(t.share)} of its ${t.bound} ms bound`;
  const owed = (t) => (t.entry ? `On the owed list: ${t.entry.fix}` : "Not on the owed list: add it to e2e/test-durations-allow.json with why it's slow and what would bring it down");
  for (const t of verdict.warned) lines.push(`::warning file=${packageName}/${t.file}::${escaped(`${named(t)}: ${took(t)}, over ${pct(WARN)}; it fails over ${pct(FAIL)}. ${owed(t)}`)}`);
  for (const t of verdict.failing) lines.push(`::error file=${packageName}/${t.file}::${escaped(`${named(t)}: ${took(t)}, over ${pct(FAIL)}, so the step fails. ${owed(t)}`)}`);
  for (const t of verdict.noBound) lines.push(`NO BOUND ${named(t)}: its meta has no bound, so test/bound-meta.ts isn't in the config's setupFiles`);
  for (const entry of verdict.stale) lines.push(`test-durations-allow.json: no such ${suite} test ran: ${entry.file} › ${entry.test}`);
  for (const { entry, problem } of verdict.malformed) lines.push(`test-durations-allow.json: ${problem}: ${entry.file} › ${entry.test}`);
  for (const entry of verdict.settled) lines.push(`on the owed list, but within ${pct(WARN)} this run: ${entry.file} › ${entry.test}`);
  const failed = verdict.failing.length + verdict.noBound.length + verdict.stale.length + verdict.malformed.length;
  const warnings = verdict.warned.length ? `, ${verdict.warned.length} over ${pct(WARN)} (warned)` : "";
  lines.push(failed ? `\ntest-durations: ${suite} failed (${failed})` : `\ntest-durations: ${suite} passed: no test over ${pct(FAIL)} of its bound${warnings}`);
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
  const entry = (more) => ({ suite: "api", file: "test/a.spec.ts", test: "slow", reason: "waits out the product's own five-second limit", fix: "pass the limit in from the test", ...more });
  const verdict = (r, allow = []) => {
    const v = judge(tests(r, pkg), allow, "api");
    return { failing: v.failing.length, warned: v.warned.length, noBound: v.noBound.length, stale: v.stale.length, malformed: v.malformed.length, settled: v.settled.length };
  };
  const is = (title, got, wanted) => check(JSON.stringify(got) === JSON.stringify(wanted), title, `wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
  const none = { failing: 0, warned: 0, noBound: 0, stale: 0, malformed: 0, settled: 0 };

  // The three bands, each edge on its own side.
  is("band 1: within a third of its bound, and exactly a third, is fine", verdict(report(["quick", 100, 30000], ["edge", 10000, 30000])), none);
  is("band 2: over a third and up to two thirds is a warning, and exactly two thirds still is", verdict(report(["slow", 10001, 30000], ["edge", 20000, 30000])), { ...none, warned: 2 });
  is("band 3: over two thirds fails", verdict(report(["slower", 20001, 30000])), { ...none, failing: 1 });
  is("band 3 holds for a test on the owed list too: listing never passes it", verdict(report(["slow", 20001, 30000]), [entry()]), { ...none, failing: 1 });
  is("the bound is the test's own: 6 s is a warning against 15 s and fine against 30 s, and 11 s fails against 15 s", verdict(report(["short", 6000, 15000], ["long", 6000, 30000], ["shorter", 11000, 15000])), { ...none, failing: 1, warned: 1 });
  is("a test with no bound in its meta fails, as does one with a zero bound", verdict(report(["bare", 10], ["zero", 10, 0])), { ...none, noBound: 2 });
  is("skipped and todo tests aren't judged, and a failed one is", verdict(report(["s", 0, undefined, "skipped"], ["t", 0, undefined, "todo"], ["f", 25000, 30000, "failed"])), { ...none, failing: 1 });
  is("a listed test over a third is a warning, as an unlisted one is", verdict(report(["slow", 12000, 30000]), [entry()]), { ...none, warned: 1 });
  is("an entry for a test that didn't run is stale", verdict(report(["quick", 100, 30000]), [entry()]), { ...none, stale: 1 });
  is("a listed test within a third is noted, not failed", verdict(report(["slow", 100, 30000]), [entry()]), { ...none, settled: 1 });
  is("an entry for another suite or file doesn't apply here", verdict(report(["slow", 12000, 30000]), [entry({ suite: "gateway" }), entry({ file: "test/b.spec.ts" })]), { ...none, warned: 1, stale: 1 });
  is("an entry with no reason or no fix fails", verdict(report(["slow", 12000, 30000]), [entry({ reason: "slow" }), entry({ fix: undefined })]), { ...none, warned: 1, malformed: 2 });

  const ten = report(...Array.from({ length: 12 }, (_, i) => [`t${i}`, (i + 1) * 100, 30000]));
  const lines = slowest(tests(ten, pkg));
  check(lines.length === 10 && lines[0].includes("1200 ms of 30000 (4%)  test/a.spec.ts › t11") && lines[9].includes("› t2"), "the ten slowest are printed slowest first, with each one's bound and share", lines.join(" | "));
  const options = { suite: "api", packageDir: pkg, packageName: "apps/api" };
  const passing = run(ten, [], options);
  check(passing.code === 0 && passing.lines[0] === "api: the 10 slowest of 12 tests:" && passing.lines.at(-1) === "\ntest-durations: api passed: no test over 67% of its bound", "band 1's run prints its ten slowest, no annotation, and exits 0", passing.lines.join(" | "));
  const warning = run(report(["slow", 12000, 30000], ["50%\nmore", 12000, 30000]), [entry()], options);
  check(warning.code === 0 && warning.lines.includes("::warning file=apps/api/test/a.spec.ts::test/a.spec.ts › slow: 12000 ms is 40%25 of its 30000 ms bound, over 33%25; it fails over 67%25. On the owed list: pass the limit in from the test") && warning.lines.some((line) => line.startsWith("::warning file=apps/api/test/a.spec.ts::test/a.spec.ts › 50%25%0Amore: ") && line.endsWith("Not on the owed list: add it to e2e/test-durations-allow.json with why it's slow and what would bring it down")) && /2 over 33% \(warned\)$/.test(warning.lines.at(-1)), "band 2's run annotates each test as a warning, naming its fix or that it isn't listed, escapes the message, and exits 0", warning.lines.join(" | "));
  const failing = run(report(["slow", 20001, 30000]), [entry()], options);
  check(failing.code === 1 && failing.lines.includes("::error file=apps/api/test/a.spec.ts::test/a.spec.ts › slow: 20001 ms is 67%25 of its 30000 ms bound, over 67%25, so the step fails. On the owed list: pass the limit in from the test") && /failed \(1\)$/.test(failing.lines.at(-1)), "band 3's run annotates the test as an error and exits 1, listed or not", failing.lines.join(" | "));

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
  const { lines, code } = run(report, allow, { suite, packageDir: join(root, packageName), packageName });
  console.log(lines.join("\n"));
  process.exit(code);
}
