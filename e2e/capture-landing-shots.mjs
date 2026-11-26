// Captures the landing page's screenshots from the demo (demo.podster.dev), so they can be retaken when the demo changes.
// Each is the working column at 1440×900 CSS px, light theme, at 2x, without the sidebar and top bar. Needs `cwebp` on PATH.
//   node capture-landing-shots.mjs [--demo=https://demo.podster.dev] [--out=../apps/web/public/landing]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import playwright from "playwright";
import { childEnv } from "./child-env.mjs";

if (process.argv.includes("--help")) {
  console.log("Usage: node capture-landing-shots.mjs [--demo=URL] [--out=DIR]\nWrites one WebP per demo screen the landing page shows. Needs cwebp.");
  process.exit(0);
}
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const demo = arg("demo", "https://demo.podster.dev");
const out = resolve(arg("out", new URL("../apps/web/public/landing", import.meta.url).pathname));

/** File name → the demo's hash route. */
const SHOTS = { today: "home", board: "board", review: "review", ship: "ship", pairing: "k-pair", explore: "k-explore" };
// The working column: right of the 244px sidebar, below the 60px top bar, above the footer, clear of the scrollbar.
const CLIP = { x: 244, y: 61, width: 1188, height: 766 };
const LIMIT = 250 * 1024;

const scratch = mkdtempSync(join(tmpdir(), "landing-shots-"));
const browser = await playwright.chromium.launch({ env: childEnv() });
let failed = false;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
  const page = await context.newPage();
  for (const [name, route] of Object.entries(SHOTS)) {
    await page.goto(`${demo}/#${route}`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const png = join(scratch, `${name}.png`);
    await page.screenshot({ path: png, clip: CLIP });
    const webp = join(out, `${name}.webp`);
    execFileSync("cwebp", ["-quiet", "-q", "78", "-m", "6", "-sharp_yuv", png, "-o", webp], { env: childEnv() });
    const size = statSync(webp).size;
    if (size > LIMIT) failed = true;
    console.log(`${name}.webp ${Math.round(size / 1024)} KB${size > LIMIT ? " (over 250 KB)" : ""}`);
  }
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log("capture-landing-shots: ok");
