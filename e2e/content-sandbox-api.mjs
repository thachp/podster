#!/usr/bin/env node
// Can a page under the content Worker's sandbox call an API on its own host, and what can any other page then do to
// that API? A spike, in real browsers, on this machine only (ADR 0010's proposed revision, section 3.5).
//
//   node e2e/content-sandbox-api.mjs [--out FILE] [--browser chromium|firefox|webkit]
//
// It starts the test-only entry apps/content/test/browser/api-entry.ts under `wrangler dev`: the content Worker's
// real handler for an app's pages, and a small API of the entry's own, which the content Worker doesn't have. Then
// each browser Playwright already has installed opens four pages, and each page calls the API in every way the
// entry can answer a browser's cross-origin rules. What each page got, and what the API received, are recorded.
//
// **How the browser reaches it, and why not as `content-sandbox.mjs` does.** That run intercepts each request in
// Playwright. Playwright answers a cross-origin preflight itself when it intercepts, so an interception can't show
// what a preflight does. Here nothing is intercepted. The browser is given a proxy on the loopback address, which
// passes every connection to a TLS server on the loopback address with a certificate made for this run and thrown
// away after it, which asks the local Worker. So every request, preflights included, is the browser's own.
//
// What it is not: no real DNS, no real certificate, no Cloudflare edge, and the API is not the content Worker's.
// `wrangler dev` is local only, and it, the proxy and the TLS server each listen on 127.0.0.1 alone. `wrangler`,
// `openssl` and each browser get the allow-listed environment from e2e/child-env.mjs. It downloads no browser.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { connect, createServer as createNet } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./child-env.mjs";
import { DOMAIN, ELSEWHERE, MODES, verdict } from "./content-sandbox-api-judge.mjs";
import * as playwright from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const content = join(here, "../apps/content");
const arg = (name) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const listening = (server) => new Promise((resolve, reject) => { server.on("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const freePort = async () => { const probe = createNet(); const port = await listening(probe); await new Promise((done) => probe.close(done)); return port; };
const port = await freePort();
const runId = randomBytes(16).toString("hex");
const RUN_ID = "x-content-browser-run-id";
const ASKED = "x-content-browser-run-url";
const local = `http://127.0.0.1:${port}`;
const out = arg("--out");
const READY_POLL_MS = 200;
/** The four pages, in the order they are opened. Each calls the same API, on the first app's host. */
const PAGES = { own: `https://appa.${DOMAIN}/`, sibling: `https://appb.${DOMAIN}/`, boxedElsewhere: `https://boxed.${ELSEWHERE}/`, plainElsewhere: `https://plain.${ELSEWHERE}/` };

// ---- the Worker, under wrangler dev, local only, from the spike's own entry ----
const scratch = mkdtempSync(join(tmpdir(), "content-sandbox-api-"));
const devLog = [];
const dev = spawn(join(content, "node_modules/.bin/wrangler"), ["dev", "test/browser/api-entry.ts", "--config", "test/browser/browser-run-only.wrangler.jsonc", "--ip", "127.0.0.1", "--port", String(port), "--local", "--var", `BROWSER_RUN_ID:${runId}`], {
  cwd: content,
  env: childEnv({ HOME: scratch, WRANGLER_SEND_METRICS: "false", CI: "true", NO_COLOR: "1" }),
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [dev.stdout, dev.stderr]) stream.on("data", (chunk) => devLog.push(String(chunk)));
const servers = [];
const stopAll = () => {
  if (dev.exitCode === null) dev.kill("SIGTERM");
  for (const server of servers) server.close();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(join(content, ".wrangler"), { recursive: true, force: true });
};
process.on("exit", stopAll);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(signal, () => { stopAll(); process.exit(code); });

async function ready() {
  for (let tries = 0; tries < 150; tries++) {
    if (dev.exitCode !== null) throw new Error(`wrangler dev exited with ${dev.exitCode}:\n${devLog.join("")}`);
    try {
      const answer = await fetch(`${local}/`);
      if (answer.status === 400 && answer.headers.get(RUN_ID) === runId) return;
      if (answer.headers.get(RUN_ID) !== null) throw new Error("another run's Worker is answering on this port");
    } catch (error) {
      if (String(error?.message).includes("another run")) throw error;
    }
    // The Worker has no event for "listening", so the run asks every 200 ms.
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(`wrangler dev never answered:\n${devLog.join("")}`);
}
/** The API's own record of what reached it since the last reset, read past the browser. */
async function seen() {
  const answer = await fetch(`${local}/__log`);
  if (answer.headers.get(RUN_ID) !== runId) throw new Error("the Worker on this port isn't this run's");
  return answer.json();
}
/** What this run's own TLS servers handed back to the browser since the last reset: each answer's address and status. */
const delivered = [];
const reset = async () => { delivered.length = 0; await fetch(`${local}/__reset`); };

// ---- a certificate for this run alone, and the two loopback servers the browser goes through ----
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(scratch, "run.pem"), "-out", join(scratch, "run.crt"), "-days", "1", "-subj", `/CN=${DOMAIN}`], { env: childEnv({ HOME: scratch }), stdio: "ignore" });
const tlsOptions = { key: readFileSync(join(scratch, "run.pem")), cert: readFileSync(join(scratch, "run.crt")) };
const HOP = new Set(["host", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "te"]);
const NOT_COPIED = new Set(["content-encoding", "transfer-encoding", "content-length", "connection", "keep-alive"]);
/**
 * A TLS server that asks the local Worker, with the address the browser asked for in one header. `control` takes the
 * content Worker's policy header off each answer: the same app with no sandbox, taken off by this run and never by
 * the Worker.
 */
function tlsServer(control) {
  return createHttps(tlsOptions, async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = {};
      for (const [name, value] of Object.entries(request.headers)) if (!HOP.has(name)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      headers[ASKED] = `https://${request.headers.host}${request.url}`;
      const body = Buffer.concat(chunks);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const answer = await fetch(`${local}/`, { method: request.method, headers, body: hasBody ? body : undefined, redirect: "manual" });
      const answered = {};
      for (const [name, value] of answer.headers.entries()) if (!NOT_COPIED.has(name)) answered[name] = value;
      if (control) delete answered["content-security-policy"];
      const bytes = Buffer.from(await answer.arrayBuffer());
      response.writeHead(answer.status, { ...answered, "content-length": String(bytes.length) });
      response.end(request.method === "HEAD" ? undefined : bytes);
      delivered.push({ method: request.method, host: request.headers.host, path: request.url, status: answer.status });
    } catch (error) {
      // The run's own failure, never the browser's refusal. It is counted, and any at all fails the run.
      delivered.push({ method: request.method, host: request.headers.host, path: request.url, status: 502, harness: true });
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(`the run couldn't ask the Worker: ${String(error?.message ?? error)}\n`);
    }
  });
}
/** A proxy that passes every connection the browser opens, whatever host it names, to one TLS server here. */
function proxyTo(tlsPort) {
  const proxy = createHttp((_, response) => { response.writeHead(502); response.end("only CONNECT\n"); });
  proxy.on("connect", (_, socket, head) => {
    const upstream = connect(tlsPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    for (const end of [socket, upstream]) end.on("error", () => { socket.destroy(); upstream.destroy(); });
  });
  return proxy;
}
async function through(control) {
  const tls = tlsServer(control);
  const tlsPort = await listening(tls);
  const proxy = proxyTo(tlsPort);
  const proxyPort = await listening(proxy);
  servers.push(tls, proxy);
  return `http://127.0.0.1:${proxyPort}`;
}

/** What the API received from one page, counted from its own log. */
function received(record) {
  const byMode = {};
  for (const mode of MODES) {
    const of = record.log.filter((entry) => entry.mode === mode);
    const actual = of.filter((entry) => !entry.preflight);
    const isJson = (entry) => String(entry.contentType ?? "").includes("application/json");
    byMode[mode] = {
      preflights: of.filter((entry) => entry.preflight).length,
      get: actual.filter((entry) => entry.method === "GET").length,
      postJson: actual.filter((entry) => entry.method === "POST" && isJson(entry)).length,
      putJson: actual.filter((entry) => entry.method === "PUT" && isJson(entry)).length,
      deleteJson: actual.filter((entry) => entry.method === "DELETE" && isJson(entry)).length,
      postText: actual.filter((entry) => entry.method === "POST" && !isJson(entry)).length,
      listAfter: record.lists[mode] ?? [],
    };
  }
  // What the run's own TLS server handed the browser for the API's reads: an answer the browser was given, with its
  // status, is not a network error, whatever the page was then allowed to see of it.
  const handed = {};
  for (const mode of MODES) handed[mode] = { readsAnswered200: delivered.filter((answer) => answer.method === "GET" && answer.path === `/api/${mode}/items` && answer.status === 200).length };
  return {
    byMode,
    origins: [...new Set(record.log.map((entry) => entry.origin))],
    withACookie: record.log.filter((entry) => entry.cookie).length,
    answersThatSetACookie: record.log.filter((entry) => entry.setCookie).length,
    requests: record.log.length,
    handedToTheBrowser: handed,
    harnessErrors: delivered.filter((answer) => answer.harness).length,
  };
}

// ---- one browser, with the policy or, as the control, without it ----
async function inBrowser(name, proxy, pages) {
  let browser;
  try {
    browser = await playwright[name].launch({ env: childEnv(), proxy: { server: proxy } });
  } catch (error) {
    return { shown: false, why: String(error?.message ?? error).split("\n")[0] };
  }
  try {
    // The certificate is this run's own, so the browser is told not to refuse it. Nothing else is told to it.
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    context.setDefaultTimeout(8000);
    context.setDefaultNavigationTimeout(20_000);
    const result = { shown: true, version: browser.version(), pages: {}, stepsThatDidNotFinish: [] };
    for (const key of pages) {
      await reset();
      const page = await context.newPage();
      let results = null;
      try {
        await page.goto(PAGES[key], { waitUntil: "domcontentloaded" });
        // The page writes its results into itself when its last call has answered or failed. The run waits for that.
        await page.locator('#results[data-done="1"]').waitFor({ state: "attached", timeout: 60_000 });
        results = JSON.parse(await page.locator("#results").textContent());
      } catch (error) {
        result.stepsThatDidNotFinish.push(`${key}: ${String(error?.message ?? error).split("\n")[0]}`);
      }
      result.pages[key] = { asked: PAGES[key], page: results, api: received(await seen()) };
      await page.close().catch(() => {});
    }
    return result;
  } catch (error) {
    return { shown: false, why: `the run failed: ${String(error?.message ?? error).split("\n")[0]}` };
  } finally {
    await Promise.race([browser.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }
}

let report;
try {
  await ready();
  const withPolicy = await through(false);
  const withoutPolicy = await through(true);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
  const wrangler = JSON.parse(execFileSync("node", ["-e", "process.stdout.write(JSON.stringify(require('./node_modules/wrangler/package.json').version))"], { cwd: content, encoding: "utf8" }));
  report = { ranAt: new Date().toISOString(), commit, wrangler, playwright: (await import("playwright/package.json", { with: { type: "json" } })).default.version, pages: PAGES, modes: MODES, browsers: {} };
  const only = arg("--browser");
  for (const name of ["chromium", "firefox", "webkit"].filter((name) => !only || name === only)) {
    const bounded = (run) => Promise.race([run, new Promise((resolve) => setTimeout(() => resolve({ shown: false, why: "the run didn't finish in five minutes" }), 300_000))]);
    report.browsers[name] = await bounded(inBrowser(name, withPolicy, Object.keys(PAGES)));
    // The control: the app's own page and its sibling's with the policy header taken off. The pages elsewhere never
    // had the policy, so they aren't shown twice.
    report.browsers[name].withoutThePolicy = await bounded(inBrowser(name, withoutPolicy, ["own", "sibling"]));
    console.error(`sandbox api: ${name} ${report.browsers[name].shown ? "shown" : `not shown (${report.browsers[name].why})`}`);
  }
  const said = devLog.join("");
  report.wranglerDev = { mentionedLoginOrAccount: /log ?in|oauth|account|unauthor|api token/i.test(said), listening: (said.match(/Ready on (\S+)/) ?? [])[1] ?? null, exitedEarly: dev.exitCode !== null };
} finally {
  stopAll();
}
const wanted = ["chromium", "firefox", "webkit"].filter((name) => !arg("--browser") || name === arg("--browser"));
const installed = wanted.filter((name) => { try { return existsSync(playwright[name].executablePath()); } catch { return false; } });
report.assertions = { ...verdict(report, installed), notInstalled: wanted.filter((name) => !installed.includes(name)) };
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(out, text); else process.stdout.write(text);
for (const failure of report.assertions.failed) console.error(`sandbox api: FAILED ${failure}`);
for (const name of report.assertions.notInstalled) console.error(`sandbox api: NOT SHOWN ${name}: not installed on this machine, so nothing is shown for it`);
console.error(`sandbox api: ${report.assertions.browsersRun.length} browser(s) run, ${report.assertions.failed.length} assertion(s) failed`);
process.exit(report.assertions.failed.length === 0 ? 0 : 1);
