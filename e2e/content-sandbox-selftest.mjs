#!/usr/bin/env node
// The browser run's assertions, tested against a recorded run with no browser: that they pass on what was really
// seen, and fail for each thing decision 216 buys when it is taken away.
//   node e2e/content-sandbox-selftest.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, REFUSED, verdict } from "./content-sandbox-judge.mjs";

const docs = join(dirname(fileURLToPath(import.meta.url)), "../docs");
const recorded = readdirSync(docs).filter((name) => /^m6-content-sandbox-run-.*\.json$/.test(name)).sort().pop();
const run = JSON.parse(readFileSync(join(docs, recorded), "utf8"));
const DOMAIN = "sandbox-test.example";
let failures = 0;
const check = (holds, what) => { console.log(`${holds ? "ok  " : "FAIL"} ${what}`); if (!holds) failures += 1; };
const copy = (value) => JSON.parse(JSON.stringify(value));
const all = ["chromium", "firefox", "webkit"];

check(verdict(run, all, DOMAIN).failed.length === 0 && run.assertions.failed.length === 0, `the recorded run, ${recorded}, holds everything, for all three browsers`);

// Each thing the sandbox buys, taken away in turn, fails with a sentence that names it.
const broken = (change, says) => {
  const pass = copy(run.browsers.chromium);
  change(pass);
  const failed = judge("chromium", pass, DOMAIN);
  check(failed.some((line) => line.includes(says)), `fails when ${says}: ${failed.length} failure(s)`);
};
broken((pass) => { pass.results.origin.value = `https://appa.${DOMAIN}`; }, "the page's origin is `null`");
check(JSON.stringify(REFUSED) === JSON.stringify(["cookieWrite", "cookieWriteForDomain", "cookieRead", "localStorage", "sessionStorage", "indexedDB", "cacheApi"]), "the asserted refusals are the seven the control can show working");
for (const probe of REFUSED) {
  broken((pass) => { pass.results[probe] = { ok: true, value: "worked" }; }, `${probe} is refused`);
  // An error that isn't the sandbox's is no refusal: a harness fault mustn't pass as one.
  for (const error of ["TypeError", "NetworkError", "Error", ""]) broken((pass) => { pass.results[probe] = { ok: false, error }; }, `${probe} is refused with SecurityError`);
}
// A service worker's registration is recorded, never asserted: it fails in the control too, for the harness's reason.
{
  const pass = copy(run.browsers.chromium);
  pass.results.serviceWorker = { ok: true, value: "registered" };
  check(judge("chromium", pass, DOMAIN).length === 0 && run.browsers.chromium.withoutThePolicy.results.serviceWorker.ok === false, "a service worker's registration isn't asserted, since the control can't register one either");
}
broken((pass) => { delete pass.results.indexedDB; }, "indexedDB is refused");
broken((pass) => { pass.sibling.cookieRead = { ok: true, value: "shared=1" }; }, "a sibling host can't read a cookie");
broken((pass) => { pass.sibling.cookieRead = { ok: false, error: "TypeError" }; }, "a sibling host can't read a cookie");
broken((pass) => { pass.sibling.cookieWriteForDomain = { ok: true, value: "shared=1" }; }, "a sibling host can't write a cookie");
broken((pass) => { pass.requestsThatCarriedACookie = 1; }, "no request carries a cookie");
broken((pass) => { pass.requestsMade = 0; }, "no request carries a cookie");
broken((pass) => { pass.answersWithSetCookie = 1; }, "`Set-Cookie` never reaches the browser");
// "Never reaches the browser" must not be true only because the app sent none.
broken((pass) => { pass.appAnswersWithSetCookie = 0; }, "the test app sent `Set-Cookie`");
broken((pass) => { delete pass.appAnswersWithSetCookie; }, "the test app sent `Set-Cookie`");
broken((pass) => { pass.withoutThePolicy.appAnswersWithSetCookie = 0; }, "in the control too, an app's `Set-Cookie` is sent");
// "No request carries a cookie" means something only where the control shows one. It does in Chromium and Firefox.
broken((pass) => { pass.withoutThePolicy.requestsThatCarriedACookie = 0; }, "in the control requests carry the cookie");
{
  const firefox = copy(run.browsers.firefox);
  firefox.withoutThePolicy.requestsThatCarriedACookie = 0;
  check(judge("firefox", firefox, DOMAIN).some((line) => line.includes("in the control requests carry the cookie")), "and the same for Firefox");
  // WebKit's control shows none on any intercepted request, so that row isn't asserted for WebKit.
  check(run.browsers.webkit.withoutThePolicy.requestsThatCarriedACookie === 0 && judge("webkit", copy(run.browsers.webkit), DOMAIN).length === 0, "WebKit's control shows no cookie on a request, and the run doesn't claim otherwise");
}
broken((pass) => { pass.cookiesInTheBrowsersJar = ["from-app for .sandbox-test.example"]; }, "`Set-Cookie` never reaches the browser");
// A harness that could see nothing would pass the rows above. The control is what shows it could.
broken((pass) => { pass.withoutThePolicy.shown = false; }, "the control ran");
broken((pass) => { pass.withoutThePolicy.results.cookieWrite = { ok: false, error: "SecurityError" }; }, "in the control cookies and storage work");
broken((pass) => { pass.withoutThePolicy.sibling.cookieRead = { ok: true, value: "" }; }, "in the control the sibling reads the first app's cookie");
// The control itself, put where the sandboxed pass goes, fails nearly every row.
const swapped = copy(run.browsers.chromium.withoutThePolicy);
swapped.withoutThePolicy = copy(run.browsers.chromium.withoutThePolicy);
check(judge("chromium", swapped, DOMAIN).length >= 10, "the unsandboxed pass, judged as the sandboxed one, fails at least ten rows");

// Every installed browser must have run.
const missing = copy(run);
missing.browsers.firefox = { shown: false, why: "the run didn't finish in four minutes" };
check(verdict(missing, all, DOMAIN).failed.some((line) => line.startsWith("firefox: installed, and it didn't run")), "fails when an installed browser didn't run");
check(verdict(missing, ["chromium", "webkit"], DOMAIN).failed.length === 0, "and doesn't when that browser isn't installed");
check(verdict(run, [], DOMAIN).failed.length === 1, "fails when no browser is installed at all");

console.log(failures === 0 ? "content sandbox self-test: all passed" : `content sandbox self-test: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
