// Checks install-browser.mjs's decision with nothing real behind it: no download, no apt, no browser.
//
//   node install-browser-selftest.mjs
import { readFileSync } from "node:fs";
import { ATTEMPTS, backoffMs, FONT_PACKAGES, install, WARNING_MARK } from "./install-browser.mjs";

let failed = 0;
const check = (passed, title) => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}`);
};

const ALL = { Arabic: true, Thai: true, Hebrew: true };
const starts = (glyphs = ALL) => ({ started: true, version: "chromium 1", glyphs, fonts: { Arabic: "DejaVu Sans" } });
/** One run of `install`, with each step answering from a list in turn (its last answer repeats). */
async function run({ platform = "linux", download = [true], deps = [true], found = starts() }) {
  const calls = { download: 0, deps: 0, check: 0, slept: [] };
  const lines = [];
  const answer = (name, list) => async () => {
    const ok = list[Math.min(calls[name]++, list.length - 1)];
    return ok ? { ok: true } : { ok: false, why: `${name} said no` };
  };
  const result = await install({
    platform,
    download: answer("download", download),
    deps: answer("deps", deps),
    check: async () => (calls.check++, found),
    sleep: async (ms) => void calls.slept.push(ms),
    say: (line) => lines.push(line),
  });
  return { ...result, calls, lines, text: lines.join("\n") };
}

{
  const r = await run({});
  check(r.code === 0 && r.path === "packages" && r.calls.deps === 1 && r.calls.slept.length === 0, "packages installed first time: done, no waiting");
  check(r.calls.check === 1, "the browser is started once even then");
  check(!r.text.includes(WARNING_MARK), "and there's no warning");
}
{
  const r = await run({ deps: [false, false, true] });
  check(r.code === 0 && r.path === "packages" && r.calls.deps === 3, "packages installed on the third attempt: done");
  check(r.calls.slept.join() === [backoffMs(1), backoffMs(2)].join() && backoffMs(2) > backoffMs(1) && backoffMs(ATTEMPTS) <= 30_000, "with a short, growing wait between attempts");
  check(!r.text.includes(WARNING_MARK), "and there's no warning");
}
{
  const r = await run({ deps: [false] });
  check(r.calls.deps === ATTEMPTS && ATTEMPTS === 3, "the packages are tried three times and no more");
  check(r.code === 0 && r.path === "fallback", "packages never installed, the browser starts and has every font: the run goes on");
  check(r.lines.filter((line) => line.startsWith(WARNING_MARK)).length === 1, "with the warning line, once, at the start of a line");
  check(r.text.includes("deps said no") && r.text.includes("runner image's own libraries and fonts"), "which says why and what the run is using");
}
{
  const r = await run({ deps: [false], found: { started: false, error: "error while loading shared libraries: libnss3.so" } });
  check(r.code === 1 && r.text.includes("libnss3.so") && !r.text.includes(WARNING_MARK), "packages never installed and the browser can't start: fails with the browser's error");
}
{
  const r = await run({ found: { started: false, error: "Executable doesn't exist" } });
  check(r.code === 1 && r.text.includes("Executable doesn't exist"), "a browser that can't start fails even when the packages installed");
}
{
  const r = await run({ deps: [false], found: starts({ Arabic: true, Thai: false, Hebrew: true }) });
  check(r.code === 1 && !r.text.includes(WARNING_MARK), "packages never installed and one script has no font: fails");
  check(/no font for Thai\b/.test(r.text) && r.text.includes(FONT_PACKAGES) && !/no font for [^.]*Arabic/.test(r.text), "naming that script and the packages");
}
{
  const r = await run({ deps: [false], found: starts(null) });
  check(r.code === 1 && !r.text.includes(WARNING_MARK), "packages never installed and the fonts can't be told: fails");
}
{
  const r = await run({ found: starts({ Arabic: false, Thai: false, Hebrew: false }) });
  check(r.code === 0 && r.path === "packages", "the fonts are only asked about when the packages couldn't be installed");
}
{
  const r = await run({ download: [false] });
  check(r.code === 1 && r.calls.download === ATTEMPTS && r.calls.deps === 0 && r.calls.check === 0, "a browser that can't be downloaded fails after three attempts, before anything else");
  const later = await run({ download: [false, true] });
  check(later.code === 0 && later.calls.download === 2, "and one that downloads on the second attempt goes on");
}
{
  const r = await run({ platform: "darwin", deps: [false] });
  check(r.code === 0 && r.path === "no-packages" && r.calls.deps === 0 && r.calls.check === 1 && !r.text.includes(WARNING_MARK), "off Linux there are no packages to install, and the browser is still started");
}

// The letters asked about are the ones the accessibility run seeds. Read as text: importing either file would need Playwright.
const text = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const letters = [...text("./browser-launch-check.mjs").match(/export const SCRIPTS = \{([^}]*)\}/)[1].matchAll(/"([^"]+)"/g)].map((found) => found[1]);
const seeded = text("./a11y.mjs").match(/const scripts = \[([^\]]*)\];/)?.[1] ?? "";
check(letters.length === 3 && letters.every((letter) => seeded.includes(`byBytes("${letter}`)), `the scripts asked about are the ones a11y.mjs seeds (${letters.join(" ")})`);
// And CI installs the browser this way and no other.
const workflow = text("../.github/workflows/ci.yml");
check(/- run: node install-browser\.mjs\n\s+working-directory: e2e/.test(workflow), "ci.yml installs the browser with install-browser.mjs");
check(!/playwright install/.test(workflow.replace(/^\s*#.*$/gm, "")), "and nowhere with `playwright install`, which fails the job when apt's mirror is down");

console.log(failed ? `${failed} failed` : "install-browser selftest passed");
process.exit(failed ? 1 : 0);
