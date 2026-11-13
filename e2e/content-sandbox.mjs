#!/usr/bin/env node
// The content Worker's sandbox, in real browsers (M6 step 4(b), decision 216). A local run, on this machine only.
//
//   node e2e/content-sandbox.mjs [--out FILE] [--port N] [--browser chromium|firefox|webkit]
//
// It starts the content Worker's real handler in the real Workers runtime, under `wrangler dev`, from the test-only
// entry and configuration in apps/content/test/browser, then shows each browser Playwright already has installed a
// small static app through it, and records what worked. It adds nothing to the sandbox: it only reports.
//
// What it is not:
//   - No real DNS, no real TLS and no Cloudflare edge. The browser's requests are intercepted by Playwright and
//     answered from the local Worker, with the address the browser asked for passed in one header.
//   - A service worker's script is fetched by the browser outside that interception, so nothing here shows a
//     registration succeeding or failing at the network. Under the sandbox the registration is refused in the page.
//   - `wrangler dev` here is local only: no `--remote`, no tunnel, and it listens on the loopback address alone.
//
// Both `wrangler` and each browser get the allow-listed environment from e2e/child-env.mjs: nothing of ours that is
// secret, no CLOUDFLARE_ variable, and a HOME that is an empty temporary folder, so no login is there to be used.
// It downloads no browser: an engine Playwright can't launch is recorded as not shown.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./child-env.mjs";
import * as playwright from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const content = join(here, "../apps/content");
const arg = (name) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const port = Number(arg("--port") ?? 8799);
const out = arg("--out");
const DOMAIN = "sandbox-test.example";
const A = `https://appa.${DOMAIN}`;
const B = `https://appb.${DOMAIN}`;
const ASKED = "x-content-browser-run-url";
const local = `http://127.0.0.1:${port}/`;

// ---- the Worker, under wrangler dev, local only ----
const home = mkdtempSync(join(tmpdir(), "content-sandbox-home-"));
const devLog = [];
const dev = spawn(join(content, "node_modules/.bin/wrangler"), ["dev", "--config", "test/browser/browser-run-only.wrangler.jsonc", "--ip", "127.0.0.1", "--port", String(port), "--local"], {
  cwd: content,
  env: childEnv({ HOME: home, WRANGLER_SEND_METRICS: "false", CI: "true", NO_COLOR: "1" }),
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [dev.stdout, dev.stderr]) stream.on("data", (chunk) => devLog.push(String(chunk)));
const stopDev = () => { if (dev.exitCode === null) dev.kill("SIGTERM"); rmSync(home, { recursive: true, force: true }); rmSync(join(content, ".wrangler"), { recursive: true, force: true }); };
process.on("exit", stopDev);

/** One request to the Worker, as if it had been asked at `url`. */
async function ask(url, init = {}) {
  const response = await fetch(local, { ...init, headers: { ...(init.headers ?? {}), [ASKED]: url }, redirect: "manual" });
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), setCookie: response.headers.getSetCookie(), body: Buffer.from(await response.arrayBuffer()) };
}
async function ready() {
  for (let tries = 0; tries < 150; tries++) {
    if (dev.exitCode !== null) throw new Error(`wrangler dev exited with ${dev.exitCode}:\n${devLog.join("")}`);
    try { if ((await fetch(local)).status === 400) return; } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`wrangler dev never answered:\n${devLog.join("")}`);
}

// ---- what the handler does in the real Workers runtime, asked directly ----
async function inWorkerd() {
  const pick = (answer, names) => Object.fromEntries(names.map((name) => [name, answer.headers[name] ?? null]));
  const page = await ask(`${A}/`);
  const missing = await ask(`${A}/nope`);
  const noApp = await ask(`https://appc.${DOMAIN}/`);
  const notAnApp = await ask(`https://deep.appa.${DOMAIN}/`);
  const plain = await ask(`http://appa.${DOMAIN}/docs?x=1`);
  const post = await ask(`${A}/`, { method: "POST" });
  const worker = await ask(`${A}/sw.js`, { headers: { "service-worker": "script" } });
  const head = await ask(`${A}/`, { method: "HEAD" });
  return {
    page: { status: page.status, headerNames: Object.keys(page.headers).sort(), setCookie: page.setCookie, appHeader: page.headers["x-app-header"] ?? null, policy: page.headers["content-security-policy"], cacheControl: page.headers["cache-control"] },
    appsOwnNotFound: { status: missing.status, ...pick(missing, ["cache-control", "clear-site-data"]) },
    hostWithNoEntry: { status: noApp.status, ...pick(noApp, ["cache-control", "clear-site-data"]) },
    hostThatIsNoApps: { status: notAnApp.status, policy: notAnApp.headers["content-security-policy"] },
    plainHttp: { status: plain.status, location: plain.headers.location ?? null },
    post: { status: post.status, allow: post.headers.allow ?? null },
    serviceWorkerHeader: { status: worker.status },
    head: { status: head.status, bodyBytes: head.body.length, contentLength: head.headers["content-length"] ?? null },
  };
}

// ---- one browser ----
async function inBrowser(name) {
  let browser;
  try {
    browser = await playwright[name].launch({ env: childEnv() });
  } catch (error) {
    return { shown: false, why: String(error?.message ?? error).split("\n")[0] };
  }
  try {
    const context = await browser.newContext();
    // No step waits long: a step a browser never finishes is recorded as that, and the run goes on.
    context.setDefaultTimeout(8000);
    context.setDefaultNavigationTimeout(15_000);
    const failed = [];
    // Every wait on the browser goes through here, with a bound of its own: some of Playwright's calls have none.
    const step = async (name, run, fallback) => {
      let timer;
      const bound = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("no answer from the browser in 25 seconds")), 25_000); });
      try { return await Promise.race([run(), bound]); } catch (error) { failed.push(`${name}: ${String(error?.message ?? error).split("\n")[0]}`); return fallback; } finally { clearTimeout(timer); }
    };
    /** Every request the browser made, in order, with whether it carried a cookie. */
    const asked = [];
    const waiting = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      const headers = { ...request.headers() };
      delete headers.host;
      asked.push({ method: request.method(), url, cookie: "cookie" in headers, kind: request.resourceType() });
      for (const wait of waiting.filter((w) => url.includes(w.part))) wait.seen();
      if (!url.startsWith(`https://`) || !new URL(url).hostname.endsWith(`.${DOMAIN}`)) return route.abort("namenotresolved");
      const answer = await ask(url, { method: request.method(), headers });
      await route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
    });
    const seen = (part) => new Promise((resolve) => waiting.push({ part, seen: resolve }));
    const requested = (part) => asked.some((request) => request.url.includes(part));
    const dialogs = [];
    const downloads = [];
    /** Pages the browser opened by itself: every page of the context but the ones this run opens. */
    let pagesOpened = 0;
    context.on("page", () => { pagesOpened += 1; });

    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on("dialog", (dialog) => { dialogs.push(dialog.type()); dialog.dismiss().catch(() => {}); });
    page.on("download", (download) => downloads.push(download.suggestedFilename()));
    const first = await step("open the app", () => page.goto(`${A}/`, { waitUntil: "domcontentloaded" }), null);
    await step("the app's own probes", () => page.locator('#results[data-done="1"]').waitFor({ state: "attached", timeout: 20_000 }));
    const results = await step("read the probes", async () => JSON.parse(await page.locator("#results").textContent()), {});
    const frameLoaded = requested("/frame.html");
    const framed = page.frames().length > 1 ? await step("look into the frame", () => page.frames()[1].locator("#framed").count(), 0) : 0;

    // Each of these is something a visitor does. The app's own handler asks for a sentinel file when the action
    // has been taken, so the run knows the browser has had its turn; then it gives the browser a moment, since
    // "nothing was asked for" has no event of its own to wait on.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
// A click doesn't wait for whatever it starts: under the sandbox it may start nothing at all.
    const act = (selector, sentinel) => step(`act ${sentinel}`, async () => { const done = seen(`/sentinel?after=${sentinel}`); await page.locator(selector).click({ noWaitAfter: true }); await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 3000))]); await settle(); });
    const pagesBeforePopup = pagesOpened;
    await act("#popup", "popup");
    const popupsOpened = pagesOpened - pagesBeforePopup;
    await act("#modal", "modal");
    await act("#download", "download");
    await act("#submit", "form");
    const afterActions = { url: page.url(), actions: (await step("read the actions", () => page.locator("#actions").textContent(), "") ?? "").trim().split("\n").filter(Boolean) };
    const form = { requested: requested("/submitted"), navigated: page.url().includes("/submitted") };
    const download = { requested: requested("/file.bin"), downloads: [...downloads] };

    // A plain link to another page of the same app.
    let link = { navigated: false };
    if (!form.navigated) {
      await step("click a link", () => page.locator("#next").click({ noWaitAfter: true }));
      link = await step("the next page", async () => { await page.locator("#second").waitFor({ state: "attached", timeout: 5000 }); return { navigated: true, url: page.url() }; }, { navigated: false, url: page.url() });
    }

    // The sibling app's host, in the same browser: what it can see of the first.
    const sibling = await context.newPage();
    sibling.setDefaultTimeout(8000);
    await step("open the sibling app", () => sibling.goto(`${B}/`, { waitUntil: "domcontentloaded" }));
    await step("the sibling's probes", () => sibling.locator('#results[data-done="1"]').waitFor({ state: "attached", timeout: 20_000 }));
    const siblingResults = await step("read the sibling's probes", async () => JSON.parse(await sibling.locator("#results").textContent()), {});
    const jar = await step("read the browser's cookie jar", () => context.cookies(), []);

    return {
      shown: true,
      version: browser.version(),
      firstPageStatus: first?.status() ?? null,
      results,
      frame: { requested: frameLoaded, rendered: framed > 0 },
      fontFileRequested: requested("/font.woff2"),
      otherHostImageRequested: requested("elsewhere.example/pixel.png"),
      popup: { pagesOpened: popupsOpened, requested: requested("/popup.html"), afterActions: afterActions.actions.filter((line) => line.startsWith("window.open")) },
      modal: { dialogs, afterActions: afterActions.actions.filter((line) => line.startsWith("alert")) },
      download,
      form,
      link,
      sibling: { cookieRead: siblingResults.cookieRead, cookieWriteForDomain: siblingResults.cookieWriteForDomain, localStorage: siblingResults.localStorage },
      cookiesInTheBrowsersJar: jar.map((cookie) => `${cookie.name} for ${cookie.domain}`),
      requestsThatCarriedACookie: asked.filter((request) => request.cookie).length,
      requestsToOtherHosts: [...new Set(asked.filter((request) => !new URL(request.url).hostname.endsWith(`.${DOMAIN}`)).map((request) => request.url))],
      requestsMade: asked.length,
      stepsThatDidNotFinish: failed,
    };
  } catch (error) {
    return { shown: false, why: `the run failed: ${String(error?.message ?? error).split("\n")[0]}` };
  } finally {
    await Promise.race([browser.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }
}

let report;
try {
  await ready();
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
  const wrangler = JSON.parse(execFileSync("node", ["-e", "process.stdout.write(JSON.stringify(require('./node_modules/wrangler/package.json').version))"], { cwd: content, encoding: "utf8" }));
  report = { ranAt: new Date().toISOString(), commit, wrangler, playwright: playwright.chromium ? (await import("playwright/package.json", { with: { type: "json" } })).default.version : null, workerd: await inWorkerd(), browsers: {} };
  const only = arg("--browser");
  for (const name of ["chromium", "firefox", "webkit"].filter((name) => !only || name === only)) {
    // One browser gets four minutes in all. Past that it is recorded as not shown, and the next one runs.
    report.browsers[name] = await Promise.race([inBrowser(name), new Promise((resolve) => setTimeout(() => resolve({ shown: false, why: "the run didn't finish in four minutes" }), 240_000))]);
    console.error(`content sandbox: ${name} ${report.browsers[name].shown ? "shown" : `not shown (${report.browsers[name].why})`}`);
  }
  // What wrangler dev said, for the record of whether it tried anything to do with an account or a login.
  const said = devLog.join("");
  report.wranglerDev = { mentionedLoginOrAccount: /log ?in|oauth|account|unauthor|api token/i.test(said), listening: (said.match(/Ready on (\S+)/) ?? [])[1] ?? null, exitedEarly: dev.exitCode !== null };
} finally {
  stopDev();
}
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(out, text); else process.stdout.write(text);
const shown = Object.values(report.browsers).filter((browser) => browser.shown).length;
console.error(`content sandbox: ${shown} of 3 browsers shown`);
process.exit(shown > 0 ? 0 : 1);
