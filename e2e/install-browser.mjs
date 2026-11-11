// Installs the browser the browser checks drive, without depending on the runner's package mirror.
//
//   node install-browser.mjs [--browser=firefox|webkit]
//
// `npx playwright install --with-deps chromium` did both halves at once, and failed the job whenever apt couldn't reach
// the mirror, before any check ran. On GitHub's Ubuntu image every library Chromium needs is already there, and apt only
// adds fonts. So:
//
//   1. The browser itself comes from Playwright's own download host, with no apt.
//   2. The system packages are tried up to three times, each attempt bounded, because a mirror that doesn't resolve
//      makes apt wait ten minutes before it gives up.
//   3. Whatever happened, the browser is started once (browser-launch-check.mjs). If it can't start, this fails with its
//      error.
//   4. If the packages couldn't be installed, this goes on only if the browser has a real glyph for each script the
//      accessibility run times (Arabic, Thai, Hebrew). Those checks put an upper bound on how long the main thread is
//      blocked laying such text out, and text drawn as "missing" boxes is never shaped, so it would pass having measured
//      nothing. Without the glyphs this fails and names them. With them it prints WARNING_MARK and goes on.
//
// The decision is `install` below, with what it does passed in, so install-browser-selftest.mjs runs it with no network.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childEnv } from "./child-env.mjs";

/** The line to search a run's log for: the run used the runner image's own libraries and fonts. */
export const WARNING_MARK = "WARNING browser-system-packages-not-installed";
export const ATTEMPTS = 3;
/** One attempt at the packages takes about 8 seconds when the mirror answers. */
export const DEPS_SECONDS = 90;
export const backoffMs = (attempt) => attempt * 5_000;
/** What `playwright install-deps chromium` adds to GitHub's Ubuntu 24.04 image, as of 2026-11-11: fonts only. */
export const FONT_PACKAGES = "fonts-freefont-ttf fonts-ipafont-gothic fonts-tlwg-loma-otf fonts-unifont fonts-wqy-zenhei xfonts-cyrillic xfonts-scalable";

/**
 * Installs and decides. `download()` and `deps()` answer `{ ok, why }`, `check()` answers what browser-launch-check.mjs
 * printed, or `{ started: false, error }`. Answers `{ code, path }`, where path is "packages", "fallback" or "no-packages"
 * (not Linux, where there are none to install).
 */
export async function install({ platform, download, deps, check, sleep, say }) {
  const tried = async (what, attempt) => {
    let last;
    for (let n = 1; n <= ATTEMPTS; n++) {
      last = await attempt();
      if (last.ok) return last;
      say(`${what}: attempt ${n} of ${ATTEMPTS} failed (${last.why})`);
      if (n < ATTEMPTS) await sleep(backoffMs(n));
    }
    return last;
  };
  const browser = await tried("downloading the browser", download);
  if (!browser.ok) {
    say(`FAIL the browser couldn't be downloaded: ${browser.why}`);
    return { code: 1, path: null };
  }
  let path = "no-packages";
  let why = "";
  if (platform === "linux") {
    const packages = await tried("installing the browser's system packages", deps);
    path = packages.ok ? "packages" : "fallback";
    why = packages.why ?? "";
  }
  const found = await check();
  if (!found?.started) {
    say(`FAIL the browser can't start${path === "fallback" ? `, and its system packages couldn't be installed (${why})` : ""}:\n${found?.error ?? "no answer from browser-launch-check.mjs"}`);
    return { code: 1, path };
  }
  const fonts = Object.entries(found.fonts ?? {}).map(([name, font]) => `${name} in ${font || "no font"}`).join(", ");
  say(`the browser starts: ${found.version}${fonts ? `; it draws ${fonts}` : ""}`);
  if (path !== "fallback") {
    say(path === "packages" ? "ok   the browser and its system packages are installed" : `ok   the browser is installed (no system packages to install on ${platform})`);
    return { code: 0, path };
  }
  // Without the packages, the checks that time these scripts are only real if the text is really drawn.
  if (!found.glyphs) {
    say(`FAIL the browser's system packages couldn't be installed (${why}), and it can't be told here whether the browser has a font for the scripts the accessibility run times. That run's checks on unbroken Arabic, Thai and Hebrew text would mean nothing if it doesn't, so this stops. The packages are: ${FONT_PACKAGES}`);
    return { code: 1, path };
  }
  const missing = Object.entries(found.glyphs).filter(([, has]) => !has).map(([name]) => name);
  if (missing.length) {
    say(`FAIL the browser's system packages couldn't be installed (${why}), and without them it has no font for ${missing.join(", ")}. The accessibility run's checks on unbroken ${missing.join(", ")} text would time boxes, not text, and pass having measured nothing, so this stops. The packages are: ${FONT_PACKAGES}`);
    return { code: 1, path };
  }
  say(`${WARNING_MARK}: tried ${ATTEMPTS} times (${why}). The browser starts and has a font for ${Object.keys(found.glyphs).join(", ")}, so the run goes on with the runner image's own libraries and fonts, not the ones Playwright installs (${FONT_PACKAGES}). Every check still runs; text may be drawn in other fonts than on a run without this line.`);
  return { code: 0, path };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browserName = process.argv.find((arg) => arg.startsWith("--browser="))?.slice("--browser=".length) ?? "chromium";
  if (!["chromium", "firefox", "webkit"].includes(browserName)) {
    console.error(`There's no browser called ${browserName}.`);
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const cli = join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
  // Playwright's installer and the browser are someone else's programs: the allow-listed environment, and where the
  // browsers are kept if that was moved.
  const env = childEnv(Object.fromEntries(["PLAYWRIGHT_BROWSERS_PATH", "CI"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])));
  const ran = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: here, stdio: "inherit", env, ...options });
    if (result.error) return { ok: false, why: result.error.code === "ETIMEDOUT" ? "timed out" : result.error.message, result };
    return { ok: result.status === 0, why: `exit ${result.status ?? result.signal}`, result };
  };
  const { code, path } = await install({
    platform: process.platform,
    download: () => ran(process.execPath, [cli, "install", browserName], { timeout: 5 * 60_000 }),
    // As root under `timeout`, so a mirror that never answers costs DEPS_SECONDS, and apt and everything it started is
    // stopped with it. Playwright would otherwise call sudo itself, and a process it started that way can't be stopped
    // from here.
    deps: () => {
      const bounded = ["timeout", "-k", "10", String(DEPS_SECONDS), process.execPath, cli, "install-deps", browserName];
      const { ok, why, result } = process.getuid?.() === 0 ? ran(bounded[0], bounded.slice(1)) : ran("sudo", ["-n", ...bounded]);
      return { ok, why: result.status === 124 || result.status === 137 ? `no answer in ${DEPS_SECONDS} seconds` : why };
    },
    check: () => {
      const { ok, result } = ran(process.execPath, [join(here, "browser-launch-check.mjs"), `--browser=${browserName}`], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 90_000 });
      if (!ok) return { started: false, error: `${result.stderr ?? ""}${result.error?.message ?? ""}`.trim() };
      try {
        return JSON.parse(result.stdout.trim().split("\n").at(-1));
      } catch {
        return { started: false, error: `browser-launch-check.mjs printed something else: ${result.stdout}` };
      }
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    say: (line) => {
      console.log(line);
      // On the run's summary page too, not only in the step's log.
      if (process.env.GITHUB_ACTIONS && line.startsWith(WARNING_MARK)) console.log(`::warning title=Browser system packages not installed::${line}`);
    },
  });
  console.log(`install-browser: ${code === 0 ? "done" : "failed"}${path ? ` (path: ${path})` : ""}`);
  process.exit(code);
}
