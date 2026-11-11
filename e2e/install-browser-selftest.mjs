// Checks install-browser.mjs's decision with nothing real behind it: no download, no apt, no browser.
//
//   node install-browser-selftest.mjs
import { readFileSync } from "node:fs";
import { ATTEMPTS, backoffMs, FONT_PACKAGES, install, PINNED, WARNING_MARK } from "./install-browser.mjs";

let failed = 0;
const check = (passed, title) => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}`);
};

const ALL = { Arabic: true, Thai: true, Hebrew: true };
const starts = (glyphs = ALL, thai = "Liberation Serif") => ({ started: true, version: "chromium 1", glyphs, fonts: { Arabic: "DejaVu Sans", Thai: thai, Hebrew: "Liberation Serif" } });
const NO_THAI = starts({ Arabic: true, Thai: false, Hebrew: true });
const PINNED_THAI = starts(ALL, "Noto Sans Thai");
/** One run of `install`, with each step answering from a list in turn (its last answer repeats). */
async function run({ platform = "linux", download = [true], deps = [true], pin = [true], found = starts() }) {
  const calls = { download: 0, deps: 0, pin: 0, check: 0, slept: [], pinned: [] };
  // What the browser shows each time it's started: one answer every time, or a list in turn.
  const shows = Array.isArray(found) ? found : [found];
  const lines = [];
  const answer = (name, list) => async () => {
    const ok = list[Math.min(calls[name]++, list.length - 1)];
    return ok ? { ok: true } : { ok: false, why: `${name} said no` };
  };
  const result = await install({
    platform,
    download: answer("download", download),
    deps: answer("deps", deps),
    pin: async (scripts) => (calls.pinned.push(scripts.join()), answer("pin", pin)()),
    check: async () => shows[Math.min(calls.check++, shows.length - 1)],
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
  check(r.code === 0 && r.path === "fallback" && r.calls.pin === 0, "packages never installed, the browser starts and has every font: the run goes on, with no font installed");
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
  const r = await run({ deps: [false], found: [NO_THAI, PINNED_THAI] });
  check(r.code === 0 && r.path === "fallback" && r.calls.pinned.join("|") === "Thai" && r.calls.check === 2, "packages never installed and one script has no font: its pinned font is installed and the browser started again");
  const warning = r.lines.filter((line) => line.startsWith(WARNING_MARK));
  check(warning.length === 1 && warning[0].includes("Thai in Noto Sans Thai (pinned package)") && warning[0].includes("Arabic in DejaVu Sans (runner image)") && warning[0].includes("Hebrew in Liberation Serif (runner image)"), "and the warning says which font drew each script and where it came from");
  check(r.text.includes("Thai in Liberation Serif (NO GLYPH: drawn as a box)"), "after saying which script was drawn as a box before");
}
{
  const r = await run({ deps: [false], found: [NO_THAI, NO_THAI] });
  check(r.code === 1 && !r.text.includes(WARNING_MARK) && /still has no font for Thai\b/.test(r.text) && r.text.includes(FONT_PACKAGES), "a script still drawn as a box after its pinned font was installed: fails, naming it and the packages");
}
{
  const r = await run({ deps: [false], pin: [false], found: [NO_THAI, PINNED_THAI] });
  check(r.code === 1 && r.calls.check === 1 && !r.text.includes(WARNING_MARK) && r.text.includes("pin said no"), "a pinned font that can't be installed: fails with why");
}
{
  const r = await run({ deps: [false], found: starts({ Arabic: false, Thai: false, Hebrew: true }) });
  check(r.code === 1 && r.calls.pin === 0 && !r.text.includes(WARNING_MARK) && /no font for Arabic,/.test(r.text) && !PINNED.Arabic, "a script with no font and none pinned for it: fails, naming it, without installing anything");
}
{
  const r = await run({ deps: [false], found: [NO_THAI, { started: false, error: "it crashed" }] });
  check(r.code === 1 && r.text.includes("it crashed") && !r.text.includes(WARNING_MARK), "a browser that stops starting once the pinned font is in: fails with its error");
}
{
  const r = await run({ found: NO_THAI });
  check(r.code === 0 && r.path === "packages" && r.calls.pin === 0, "the pinned font is never installed when the packages were");
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
// The pinned fonts: an exact version with its hash in the lockfile, a development dependency only, and the file and its
// licence really in the package.
const manifest = JSON.parse(text("./package.json"));
const lock = JSON.parse(text("./package-lock.json"));
for (const [name, font] of Object.entries(PINNED)) {
  const locked = lock.packages[`node_modules/${font.package}`];
  check(/^\d+\.\d+\.\d+$/.test(manifest.devDependencies?.[font.package] ?? "") && !manifest.dependencies[font.package], `${name}'s font is a development dependency at an exact version`);
  check(locked?.version === manifest.devDependencies?.[font.package] && /^sha512-/.test(locked?.integrity ?? "") && locked.dev === true && !locked.hasInstallScript && !locked.dependencies, "the lockfile holds that version's hash, and the package runs nothing on install and brings nothing else");
  const inPackage = (file) => readFileSync(new URL(`./node_modules/${font.package}/${file}`, import.meta.url));
  let shipped = false;
  try {
    // A static TrueType file as shipped, which fontconfig reads, and the Open Font License beside it.
    shipped = inPackage(font.file).subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) && inPackage(font.licence).includes("SIL OPEN FONT LICENSE Version 1.1");
  } catch {}
  check(shipped, `the package has ${font.file} as TrueType and its Open Font License`);
}
// And CI installs the browser this way and no other.
const workflow = text("../.github/workflows/ci.yml");
check(/- run: node install-browser\.mjs\n\s+working-directory: e2e/.test(workflow), "ci.yml installs the browser with install-browser.mjs");
check(!/playwright install/.test(workflow.replace(/^\s*#.*$/gm, "")), "and nowhere with `playwright install`, which fails the job when apt's mirror is down");

console.log(failed ? `${failed} failed` : "install-browser selftest passed");
process.exit(failed ? 1 : 0);
