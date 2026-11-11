// Whether the test browser can start on this machine as it is, and whether it has a real glyph for each script the
// accessibility run times. install-browser.mjs runs this after installing the browser, and relies on it when the system
// packages couldn't be installed.
//
//   node browser-launch-check.mjs [--browser=firefox|webkit]
//
// The last line it prints is JSON: {"started":true,"version":"…","glyphs":{"Arabic":true,…}|null,"fonts":{…}}.
// `glyphs` is null when this can't tell a glyph from a missing one here. It exits 1 with the browser's own error if the
// browser can't start or can't run a page.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as playwright from "playwright";
import { childEnv } from "./child-env.mjs";

// The scripts a11y.mjs seeds as "unbroken scripts", "unbroken Arabic" and "alternating directions", by the letter it uses.
// install-browser-selftest.mjs checks these are still the letters there.
export const SCRIPTS = { Arabic: "ع", Thai: "ก", Hebrew: "א" };

const BOUND_MS = 60_000;

/** On Linux, whether fontconfig, which the browser asks, lists a font with this letter. True where that can't be asked. */
function installed(letter) {
  if (process.platform !== "linux") return true;
  const listed = spawnSync("fc-list", [`:charset=${letter.codePointAt(0).toString(16)}`, "family"], { encoding: "utf8", env: childEnv(), timeout: 10_000 });
  return listed.status !== 0 || listed.stdout.trim() !== "";
}

/** What the browser showed, or throws the browser's own error. */
async function look(browserName) {
  // The browser is someone else's program, so it gets the allow-listed environment and nothing of ours.
  const browser = await playwright[browserName].launch({ env: childEnv() });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    const sum = await page.evaluate(() => 1 + 1);
    if (sum !== 2) throw new Error(`the page answered ${sum} to 1 + 1`);
    // A letter no font covers is drawn as the "missing" box, the same box for every such letter. Two code points that
    // aren't assigned to anything say what that box looks like here; a letter drawn as anything else has a glyph.
    const drawn = await page.evaluate((letters) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const draw = (letter) => {
        context.clearRect(0, 0, 64, 64);
        context.font = "32px sans-serif";
        context.textBaseline = "middle";
        context.fillText(letter, 16, 32);
        const pixels = context.getImageData(0, 0, 64, 64).data;
        let ink = 0;
        let hash = 0;
        for (let i = 3; i < pixels.length; i += 4) {
          if (pixels[i]) ink++;
          hash = (hash * 31 + pixels[i]) | 0;
        }
        return `${ink}:${hash}`;
      };
      return { missing: [draw("͸"), draw("͹")], letters: Object.fromEntries(Object.entries(letters).map(([name, letter]) => [name, draw(letter)])) };
    }, SCRIPTS);
    const [missing, other] = drawn.missing;
    const glyphs = missing !== other ? null : Object.fromEntries(Object.entries(drawn.letters).map(([name, picture]) => [name, picture !== missing && !picture.startsWith("0:") && installed(SCRIPTS[name])]));
    // Which font draws each, where the browser can say (Chromium). For the log only; nothing is decided on it.
    const fonts = {};
    if (browserName === "chromium") {
      try {
        await page.setContent(Object.entries(SCRIPTS).map(([name, letter]) => `<p id="${name}">${letter}</p>`).join(""));
        const session = await page.context().newCDPSession(page);
        await session.send("DOM.enable");
        await session.send("CSS.enable");
        const { root } = await session.send("DOM.getDocument");
        for (const name of Object.keys(SCRIPTS)) {
          const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${name}` });
          const used = await session.send("CSS.getPlatformFontsForNode", { nodeId });
          fonts[name] = used.fonts.map((font) => font.familyName).join(", ");
        }
      } catch {
        // Not being able to name the fonts isn't a failure to start.
      }
    }
    return { started: true, version: `${browserName} ${browser.version()}`, glyphs, fonts };
  } finally {
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browserName = process.argv.find((arg) => arg.startsWith("--browser="))?.slice("--browser=".length) ?? "chromium";
  if (!["chromium", "firefox", "webkit"].includes(browserName)) {
    console.error(`There's no browser called ${browserName}.`);
    process.exit(2);
  }
  const late = setTimeout(() => {
    console.error(`FAIL ${browserName} hadn't started and answered a page ${BOUND_MS / 1000} seconds after it was asked to.`);
    process.exit(1);
  }, BOUND_MS);
  try {
    const found = await look(browserName);
    clearTimeout(late);
    console.log(JSON.stringify(found));
    process.exit(0);
  } catch (error) {
    console.error(`FAIL ${browserName} can't start here:\n${error?.message ?? error}`);
    process.exit(1);
  }
}
