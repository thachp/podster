// The browser's path for a file's bytes: the real helper, in a real browser, on a real page with its real CSP, through the web
// Worker, the gateway and the API to local storage. All three Workers run in one process, so the two bindings are real ones, as
// on a deployment. The helper has no screen yet, so it's built by itself and put on a page.
//
//   node run-upload-browser.mjs [--skip-build] [--skip-web-build] [--browser=firefox|webkit]
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as playwright from "playwright";
import { parseJsonc } from "./jsonc.mjs";
import { key, Person, Target } from "./lib.mjs";
import { freePort, local, prepareStack, repo, run, startWrangler } from "./stack.mjs";

const browserName = process.argv.find((arg) => arg.startsWith("--browser="))?.slice("--browser=".length) ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(browserName)) throw new Error(`Unknown browser: ${browserName}`);
const skipBuild = process.argv.includes("--skip-build");
const web = join(repo, "apps/web");
const MB100 = 100_000_000;

const { gateway, apiConfig, persist, privateKey, kid } = prepareStack({ skipBuild });
if (!skipBuild && !process.argv.includes("--skip-web-build")) run("npm", ["run", "build"], web);

const helper = spawnSync(join(web, "node_modules/.bin/esbuild"), ["lib/uploads/client.ts", "--bundle", "--format=iife", "--global-name=podsterUpload", "--log-level=error"], { cwd: web, encoding: "utf8" });
if (helper.status !== 0) throw new Error(`building the helper failed: ${helper.stderr}`);

const port = await freePort();
// localhost and not a name under it, because WebKit on macOS can't resolve one.
const app = `http://localhost:${port}`;
const gatewayConfig = join(local, "gateway.wrangler.jsonc");
const { env: _env, ...gatewayBase } = parseJsonc(readFileSync(join(gateway, "wrangler.jsonc"), "utf8"));
writeFileSync(
  gatewayConfig,
  JSON.stringify({
    ...gatewayBase,
    main: join(gateway, "src/index.ts"),
    d1_databases: gatewayBase.d1_databases.map((db) => ({ ...db, migrations_dir: join(gateway, "migrations") })),
    ratelimits: gatewayBase.ratelimits.map((limit) => ({ ...limit, simple: { limit: 100_000, period: 60 } })),
    // `--var` reaches only the first Worker.
    vars: { ...gatewayBase.vars, AUTH_SECRET: randomBytes(32).toString("base64"), ASSERTION_SIGNING_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }), BASE_URL: app, APP_URL: app, ENABLE_PASSWORD_SIGNIN: "true", STRICT_PER_MINUTE: "100000" },
  }),
);
const stack = startWrangler({
  cwd: web,
  command: join(web, "node_modules/.bin/wrangler"),
  logLevel: "log",
  env: { WRANGLER_REGISTRY_PATH: join(local, "registry") },
  args: ["-c", "dist/server/wrangler.json", "-c", gatewayConfig, "-c", apiConfig, "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `APP_URL:${app}`, "--var", `GATEWAY_URL:${app}`],
});

const failures = [];
const check = (passed, title, detail = "") => {
  if (!passed) failures.push(title);
  console.log(`${passed ? "ok  " : "FAIL"} ${title}${detail ? `: ${detail}` : ""}`);
};

async function waitForStack() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && stack.stack.exitCode === null) {
    const res = await fetch(`${app}/sign-in`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (res?.status === 200) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  console.error(stack.log.join("").slice(-3000));
  throw new Error("the local stack didn't come up");
}

async function main() {
  await waitForStack();
  const big = join(local, "notes-100mb.txt");
  writeFileSync(big, Buffer.alloc(MB100, "some notes\n"));
  const small = join(local, "notes-small.txt");
  writeFileSync(small, Buffer.alloc(200_000, "some notes\n"));
  const refused = join(local, "setup.exe");
  writeFileSync(refused, "not really a program\n");

  const browser = await playwright[browserName].launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${app}/sign-in`);
  const signedUp = await page.evaluate(async ([name, email, password]) => (await fetch("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, password }) })).status, ["Ada Owner", `${key()}@example.test`, `pw-${key()}`]);
  if (signedUp !== 200) throw new Error(`sign-up answered ${signedUp}`);
  const cookies = await context.cookies();
  const owner = await Person.fromCookie(new Target(app, { pollMs: 150 }), "owner", cookies.map((c) => `${c.name}=${c.value}`).join("; "));
  const room = await owner.createRoom(`Browser upload ${key()}`);

  // Everything the page sends and every token it's given, watched from outside the page.
  const tokens = [];
  const urls = [];
  const violations = [];
  page.on("request", (request) => urls.push(request.url()));
  page.on("response", async (response) => {
    if (response.url().endsWith(`/api/v1/workspaces/${room}/uploads`)) tokens.push((await response.json().catch(() => null))?.token);
  });
  await page.goto(`${app}/rooms`);
  await page.evaluate(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => window.__violations.push(event.violatedDirective));
    const input = document.createElement("input");
    input.type = "file";
    input.id = "upload-file";
    document.body.append(input);
  });
  // The page's own CSP allows inline scripts, so this runs under it like anything else there.
  await page.addScriptTag({ content: helper.stdout });
  const choose = (path) => page.setInputFiles("#upload-file", path);
  const upload = (extra = "") =>
    page.evaluate(
      async ([workspace, extra]) => {
        const phases = [];
        let events = 0;
        let sent = 0;
        const started = performance.now();
        let hashed;
        const stop = new AbortController();
        const result = await window.podsterUpload.uploadFile(workspace, document.getElementById("upload-file").files[0], {
          signal: stop.signal,
          onProgress(progress) {
            if (phases.at(-1) !== progress.phase) phases.push(progress.phase);
            if (progress.phase === "reserving") hashed = performance.now() - started;
            if (progress.phase === "sending") {
              events++;
              sent = progress.sent;
              if (extra === "cancel" && progress.sent > 0) stop.abort();
            }
          },
        });
        return { result: { ...result, retry: Boolean(result.retry) }, phases, events, sent, hashMs: Math.round(hashed ?? 0), ms: Math.round(performance.now() - started) };
      },
      [room, extra],
    );

  await choose(big);
  const full = await upload();
  check(full.result.ok && full.result.data.state === "scanning" && full.result.data.size === MB100, "100 MB from disk reaches storage and starts scanning", JSON.stringify(full.result.data ?? full.result));
  check(full.phases.join() === "hashing,reserving,sending,storing", "it goes through each phase in order", full.phases.join());
  check(full.events > 1 && full.sent === MB100, "progress is reported along the way, up to the whole file", `${full.events} progress events, last ${full.sent}; hashing ${full.hashMs} ms, in all ${full.ms} ms`);

  await choose(refused);
  const blocked = await upload();
  check(blocked.result.code === "executable_refused" && !blocked.phases.includes("sending"), "a refused type stops at the reservation", blocked.result.code);

  await choose(big);
  const canceled = await upload("cancel");
  check(canceled.result.code === "upload_canceled", "canceling stops a send in progress", `${canceled.result.code}, after ${canceled.sent} bytes`);

  // A real token used by hand, so the path can be seen refusing.
  await choose(small);
  const raw = (path, headers, body = "x") =>
    page.evaluate(
      ([path, headers, body]) =>
        new Promise((done) => {
          const request = new XMLHttpRequest();
          request.open("PUT", path);
          for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
          request.onload = () => done({ status: request.status, text: request.responseText });
          request.onerror = () => done({ status: 0, text: "" });
          request.send(body);
        }),
      [path, headers, body],
    );
  const open = await owner.must("POST", `/v1/workspaces/${room}/uploads`, { name: "open.txt", size: 1, sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" });
  tokens.push(open.token);
  const path = `/api${open.upload_path}`;
  check((await raw(path, {})).status === 404, "the session cookie alone doesn't authorize the bytes route");
  check((await raw(path, { authorization: `Bearer upl_${"0".repeat(64)}` })).status === 404, "nor does a session with a wrong token");
  const longer = await raw(path, { authorization: `Bearer ${open.token}` }, "more than was announced");
  check(longer.status === 422, "more than was announced is refused through the web Worker", String(longer.status));
  const right = await raw(path, { authorization: `Bearer ${open.token}` });
  check(right.status === 200, "the same upload with the right bytes and the token is kept", String(right.status));
  // The API answers long before the sender finishes, which is what left errors nothing could catch on the gateway's hop (#116).
  const over = await owner.must("POST", `/v1/workspaces/${room}/uploads`, { name: "over.txt", size: 1, sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" });
  tokens.push(over.token);
  await choose(big);
  const overrun = await page.evaluate(
    ([path, token]) =>
      new Promise((done) => {
        const request = new XMLHttpRequest();
        request.open("PUT", path);
        request.setRequestHeader("authorization", `Bearer ${token}`);
        request.onload = () => done(request.status);
        request.onerror = () => done(0);
        request.send(document.getElementById("upload-file").files[0]);
      }),
    [`/api${over.upload_path}`, over.token],
  );
  // A browser may see the connection end before it sees the answer, and the helper would offer a retry that gets the answer.
  check(overrun === 422 || overrun === 0, "100 MB against a 1-byte reservation ends early", overrun === 0 ? "the browser saw the connection end" : "the browser saw 422");
  const direct = await page.evaluate(async (base) => {
    try {
      await fetch(`${base}/v1/uploads/x/y`, { method: "PUT", body: "x" });
      return "reached";
    } catch {
      return "blocked";
    }
  }, `http://127.0.0.1:${port}`);
  check(direct === "blocked", "the CSP still blocks any other host, so bytes can't go around this one", direct);
  const blockedViolations = await page.evaluate(() => window.__violations);
  check(blockedViolations.length === 1 && /connect-src/.test(blockedViolations[0]), "and that's the only thing the CSP had to block", blockedViolations.join() || "nothing");
  violations.push(...blockedViolations);

  const wrongMethod = await page.evaluate(async (path) => (await fetch(path, { method: "POST", body: "x" })).status, path);
  check(wrongMethod === 405, "only PUT reaches the route", String(wrongMethod));

  // Where a token could have ended up.
  const real = tokens.filter(Boolean);
  check(real.length >= 4, "the check saw the tokens it's looking for", String(real.length));
  const stored = await page.evaluate(async () => {
    const databases = indexedDB.databases ? await indexedDB.databases() : [];
    return JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie, databases, history: location.href });
  });
  const inCookies = JSON.stringify(await context.cookies());
  await browser.close();
  await new Promise((done) => setTimeout(done, 1000));
  stack.stop();
  const logged = stack.log.join("");
  check(!real.some((token) => stored.includes(token) || inCookies.includes(token)), "no token in storage, cookies or the address");
  check(!real.some((token) => urls.some((url) => url.includes(token))), "no token in any URL the page asked for", `${urls.length} requests`);
  check(logged.includes("PUT /api/v1/uploads"), "the Workers' log holds the upload requests, so looking in it means something");
  check(!real.some((token) => logged.includes(token)), "no token in the Workers' log");
  const unhandled = logged.split("\n").filter((line) => /uncaught|unhandled/i.test(line));
  check(unhandled.length === 0, "nothing unhandled in the Workers' log", unhandled.slice(0, 3).join(" / ").slice(0, 500));
}

let code = 1;
try {
  await main();
  code = failures.length ? 1 : 0;
} catch (error) {
  console.error(error);
  console.error(stack.log.join("").slice(-2000));
} finally {
  stack.stop();
}
console.log(failures.length ? `\n${failures.length} failed` : code === 0 ? `\nAll passed in ${browserName}` : "");
process.exit(code);
