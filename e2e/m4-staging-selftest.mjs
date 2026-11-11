// Checks the parts of M4's staging run that need no network: which answers count as Cloudflare's edge refusing a forged
// cf-connecting-ip (M4-10), fed both forms the edge really gives, and the missing installs its log tails are named by.
//
//   node m4-staging-selftest.mjs
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { edgeRefused, missingWranglers } from "./m4-staging-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (passed, title) => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}`);
};

// ---- the edge's refusal ----

// Cloudflare's HTML page for error 1000, as staging's edge gave it to Node's fetch on 2026-11-11, with its Ray ID, time and
// the client's address replaced.
const page = readFileSync(join(here, "fixtures/cloudflare-error-1000.html"), "utf8");
const plain = "error code: 1000\n";
const edge = { server: "cloudflare", "cf-ray": "0000000000000000-LAX" };
const html = { ...edge, "content-type": "text/html; charset=UTF-8" };
// The app's public headers, which every answer of its own carries, a 403 included.
const appHeaders = { "content-security-policy": "default-src 'none'; script-src 'none'", "x-robots-tag": "noindex, nofollow" };
const refused = (status, headers, body) => edgeRefused(status, new Headers(headers), body);

check(refused(403, edge, plain), "the plain text Cloudflare gives curl is the refusal");
check(refused(403, { ...edge, "content-type": "text/plain" }, "error code: 1000"), "and without its trailing newline");
check(refused(403, html, page), "the HTML page Cloudflare gives Node's fetch is the refusal");
check(refused(403, { "cf-ray": "x", "content-type": "text/html" }, page), "marked as Cloudflare's by cf-ray alone");
check(refused(403, { server: "cloudflare", "content-type": "text/html" }, page), "or by its server header alone");

check(!refused(200, html, page), "not when the status isn't 403");
check(!refused(404, edge, plain), "nor a 404 saying the same");
check(!refused(403, { ...html, ...appHeaders }, page), "not with the app's public headers: a 403 from the app itself");
check(!refused(403, { ...edge, ...appHeaders }, plain), "nor the plain text with them");
check(!refused(403, { ...html, "x-robots-tag": "noindex" }, page), "nor with only the app's x-robots-tag");
check(!refused(403, { "content-type": "text/html" }, page), "not without Cloudflare's server or cf-ray header");
check(!refused(403, { ...edge, "content-type": "text/plain" }, page), "not the page served as anything but HTML");
check(!refused(403, edge, "error code: 1020\n"), "not another error code in plain text");
check(!refused(403, edge, "error code: 1000\nmore"), "nor plain text with anything after it");
check(!refused(403, html, "<!doctype html><title>Forbidden</title><p>error code: 1000</p>"), "not any HTML that only mentions 1000");
const other = page.replace("DNS points to prohibited IP", "Access denied").replace("<span>1000</span>", "<span>1020</span>");
check(!refused(403, html, other), "not Cloudflare's page for another error");
check(!refused(403, html, page.replace("<span>1000</span>", "<span>1020</span>")), "nor the 1000 title over another error number");
check(!refused(403, html, page.replace(/<title>[^<]*<\/title>/, "<title>Error 1000</title>")), "nor the 1000 heading under another title");
check(!refused(403, html, ""), "not an empty body");
check(!refused(403, html, '{"error":{"code":"not_allowed"}}'), "not the API's JSON refusal");

// ---- the tails' installs ----

const repo = mkdtempSync(join(tmpdir(), "m4-selftest-"));
try {
  const install = (app) => {
    mkdirSync(join(repo, "apps", app, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(repo, "apps", app, "node_modules/.bin/wrangler"), "");
  };
  check(missingWranglers(repo).join() === "api,gateway,web", "a checkout with no installs names all three apps");
  install("gateway");
  check(missingWranglers(repo).join() === "api,web", "one installed, the other two are named");
  mkdirSync(join(repo, "apps", "web", "node_modules"), { recursive: true });
  check(missingWranglers(repo).join() === "api,web", "node_modules without wrangler is still missing");
  install("api");
  install("web");
  check(missingWranglers(repo).length === 0, "all three installed, nothing is named");
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
