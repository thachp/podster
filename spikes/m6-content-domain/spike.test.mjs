// Offline checks only. Nothing here calls Cloudflare or opens a browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { CLEAR_SITE_DATA, cookieNames, headerChanges, parseHost, preflight, sandboxCsp } from "./dispatch/src/route.js";
import { assetHash, isSpikeName, manifestOf, readApp, scriptFor, wranglerEnv } from "./lib.mjs";

const HERE = import.meta.dirname;

test("a first-level host maps to its mode and spike script, and nothing else maps", () => {
  assert.deepEqual(parseHost("a.opster.dev"), { mode: "raw", label: "a", script: "spike-m6-c-a" });
  assert.deepEqual(parseHost("H-Plain.OPSTER.dev"), { mode: "hardened", label: "plain", script: "spike-m6-c-plain" });
  assert.deepEqual(parseHost("w-a.opster.dev"), { mode: "workers", label: "a", script: "spike-m6-c-a" });
  for (const host of ["opster.dev", "x.a.opster.dev", "bad_label.opster.dev", "a.podster.dev", "a.opster.dev.evil.test", "h-.opster.dev", "-a.opster.dev"]) {
    assert.equal(parseHost(host), null, host);
  }
});

test("the dispatch Worker's own answers, by mode", () => {
  const raw = parseHost("a.opster.dev");
  const hard = parseHost("h-a.opster.dev");
  const work = parseHost("w-a.opster.dev");
  const req = (o) => ({ method: "GET", pathname: "/", serviceWorker: null, cookie: null, ...o });

  assert.equal(preflight(raw, req({})), null);
  assert.equal(preflight(raw, req({ serviceWorker: "script" })), null, "raw passes a service worker's script through");
  assert.equal(preflight(raw, req({ method: "POST" })), null);
  for (const t of [hard, work]) {
    assert.equal(preflight(t, req({ serviceWorker: "script" })).status, 403);
    assert.equal(preflight(t, req({ method: "POST" })).status, 405);
    assert.equal(preflight(t, req({})), null);
  }
  for (const t of [raw, hard, work]) {
    const gone = preflight(t, req({ pathname: "/__gone" }));
    assert.equal(gone.status, 404);
    assert.equal(gone.headers["clear-site-data"], CLEAR_SITE_DATA);
    const echo = preflight(t, req({ pathname: "/__echo-cookie", cookie: "b=2; a=secret-value" }));
    assert.deepEqual(JSON.parse(echo.body), { names: ["a", "b"] });
    assert.ok(!echo.body.includes("secret-value"), "values never leave");
  }
});

test("only the hardened mode changes the app's headers, and it strips Set-Cookie and sandboxes", () => {
  assert.deepEqual(headerChanges("raw"), { remove: [], set: {} });
  assert.deepEqual(headerChanges("workers"), { remove: [], set: {} });
  const h = headerChanges("hardened", "https://h-a.opster.dev");
  const csp = sandboxCsp("https://h-a.opster.dev");
  assert.deepEqual(h.remove, ["set-cookie"]);
  assert.equal(h.set["content-security-policy"], csp);
  assert.match(csp, /^sandbox /);
  assert.match(csp, /connect-src https:\/\/h-a\.opster\.dev;/);
  assert.doesNotMatch(csp, /'self'|allow-same-origin|allow-popups-to-escape-sandbox/);
  assert.match(h.set["cache-control"], /no-transform/);
});

test("cookie names never carry values", () => {
  assert.deepEqual(cookieNames(null), []);
  assert.deepEqual(cookieNames("z=1;  y = 2 ; x"), ["x", "y", "z"]);
});

test("clean-up only ever matches this spike's names", () => {
  assert.ok(isSpikeName("spike-m6-c-a"));
  assert.ok(isSpikeName("spike-m6-c-dispatch"));
  for (const name of ["spike-m6-c-", "spike-m6-dispatch", "spike-m6-a", "podster-api", "podster-staging-apps", "", undefined, null]) assert.ok(!isSpikeName(name), String(name));
  assert.equal(scriptFor("plain"), "spike-m6-c-plain");
  assert.throws(() => scriptFor("A"));
  assert.throws(() => scriptFor("a-b"));
});

test("the manifest is Cloudflare's documented hash of every file, with sizes", () => {
  const files = readApp(join(HERE, "apps", "probe"));
  assert.deepEqual(Object.keys(files), ["/_headers", "/hdr.html", "/index.html", "/probe.js", "/sw.js"]);
  const index = readFileSync(join(HERE, "apps", "probe", "index.html"));
  assert.equal(files["/index.html"].size, index.length);
  assert.equal(files["/index.html"].hash, assetHash(index.toString("base64"), "/index.html"));
  assert.match(files["/index.html"].hash, /^[0-9a-f]{32}$/);
  assert.notEqual(assetHash("aGk=", "/a.html"), assetHash("aGk=", "/a.js"), "the extension is part of the hash");
  const manifest = manifestOf(files);
  assert.deepEqual(Object.keys(manifest["/sw.js"]).sort(), ["hash", "size"]);
});

test("every spike file says it's a spike, and nothing names a token or an email", () => {
  for (const f of ["lib.mjs", "deploy.mjs", "upload.mjs", "cleanup.mjs", "hosts.mjs", "browser.mjs", "dispatch/src/index.js", "dispatch/src/route.js"]) {
    const text = readFileSync(join(HERE, f), "utf8");
    assert.match(text, /Spike only/, f);
    assert.doesNotMatch(text, /console\.log\([^)]*token/i, f);
    assert.doesNotMatch(text, /@[a-z0-9-]+\.(com|dev)/i, f);
  }
});

test("wrangler gets the allow-listed environment plus exactly CLOUDFLARE_ACCOUNT_ID", () => {
  const account = "0".repeat(32);
  const env = wranglerEnv({ PATH: "/bin", HOME: "/h", CLOUDFLARE_API_TOKEN: "x", PODSTER_E2E_SIGNUP_SECRET: "y", OTHER: "z" }, account);
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", CLOUDFLARE_ACCOUNT_ID: account });
  assert.throws(() => wranglerEnv({}, "not-an-account"));
});

test("no Cloudflare ID is kept in this folder", () => {
  const { readdirSync, statSync } = require("node:fs");
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const f of walk(HERE).filter((f) => !f.endsWith("spike.test.mjs"))) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /account_id"\s*:\s*"[0-9a-f]{32}"/, f);
    assert.doesNotMatch(text, /CLOUDFLARE_ACCOUNT_ID=[0-9a-f]{32}/, f);
    assert.doesNotMatch(text, /zone `[0-9a-f]{32}`|ZONE_ID = "/, f);
  }
});

test("the browser script never builds code from a string", () => {
  const text = readFileSync(join(HERE, "browser.mjs"), "utf8");
  assert.doesNotMatch(text, /evaluate\(\s*[`"']/);
  assert.doesNotMatch(text, /new Function|eval\(/);
  assert.match(text, /page\.evaluate\(inPage, \{ step, text/);
});
