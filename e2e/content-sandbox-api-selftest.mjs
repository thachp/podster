#!/usr/bin/env node
// The API spike's assertions, tested against a recorded run with no browser: that they pass on what was really seen,
// and fail for each property when it is taken away.
//   node e2e/content-sandbox-api-selftest.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CALLS, DOMAIN, judge, MODES, NO_PREFLIGHT_ANSWER, PREFLIGHTED, verdict } from "./content-sandbox-api-judge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const docs = join(here, "../docs");
const recorded = readdirSync(docs).filter((name) => /^m6-sandbox-api-run-.*\.json$/.test(name)).sort().pop();
const run = JSON.parse(readFileSync(join(docs, recorded), "utf8"));
let failures = 0;
const check = (holds, what) => { console.log(`${holds ? "ok  " : "FAIL"} ${what}`); if (!holds) failures += 1; };
const copy = (value) => JSON.parse(JSON.stringify(value));
const all = ["chromium", "firefox", "webkit"];

check(verdict(run, all).failed.length === 0 && run.assertions.failed.length === 0, `the recorded run, ${recorded}, holds everything, for all three browsers`);
check(JSON.stringify(run.modes) === JSON.stringify(MODES), "the run's ways of answering are the judge's");
// The judge's two lists are the test entry's and the page's own, read from the entry's source.
const entry = readFileSync(join(here, "../apps/content/test/browser/api-entry.ts"), "utf8");
check(entry.includes(`export const MODES = ${JSON.stringify(MODES).replace(/,/g, ", ")} as const;`), "the test entry answers in exactly those ways");
check(CALLS.every((call) => entry.includes(`calls.${call} = `)) && PREFLIGHTED.every((call) => CALLS.includes(call)), "the page makes exactly the calls the judge names");
check(entry.includes(`const DOMAIN = "${DOMAIN}";`), "the test entry's domain is the judge's");

// Each property, taken away in turn, fails with a sentence that names it.
const broken = (change, says) => {
  const pass = copy(run.browsers.chromium);
  change(pass);
  const failed = judge("chromium", pass);
  check(failed.some((line) => line.includes(says)), `fails when not: ${says} (${failed.length} failure(s))`);
};
broken((pass) => { pass.pages.own.page.origin = `https://appa.${DOMAIN}`; }, "has the origin `null`");
broken((pass) => { pass.pages.own.api.origins = ["null", `https://appa.${DOMAIN}`]; }, "with `Origin: null`");
broken((pass) => { pass.pages.own.api.origins = []; }, "with `Origin: null`");
for (const key of ["own", "boxedElsewhere", "plainElsewhere"]) {
  broken((pass) => { pass.pages[key].api.withACookie = 1; }, `no request from ${key} carried one`);
  // A server that never offered a cookie proves nothing about the browser.
  broken((pass) => { pass.pages[key].api.answersThatSetACookie = 0; }, `the API set a cookie on its answers to ${key}`);
}
broken((pass) => { pass.withoutThePolicy.pages.own.api.withACookie = 0; }, "in the control, on its own origin, requests carry the API's cookie");
// A step that didn't finish, a page that never loaded, and a failure of the run's own servers each fail the run.
broken((pass) => { pass.stepsThatDidNotFinish = ["sibling: timeout"]; }, "every step finished");
broken((pass) => { pass.withoutThePolicy.stepsThatDidNotFinish = ["own: timeout"]; }, "every step of the control finished");
broken((pass) => { pass.pages.sibling.page = null; }, "sibling loaded and gave its results");
broken((pass) => { pass.pages.plainElsewhere.api.harnessErrors = 1; }, "the run's own servers answered every request from plainElsewhere");
// "Can't read" must be the browser's refusal: the read reached the API, the answer was handed over, the page got an
// error, and the same read works elsewhere. Each taken away fails.
for (const key of ["own", "boxedElsewhere", "plainElsewhere"]) {
  broken((pass) => { pass.pages[key].api.byMode.none.get = 0; }, `from ${key}, with no cross-origin header, both reads reached the API`);
  broken((pass) => { pass.pages[key].api.handedToTheBrowser.none.readsAnswered200 = 0; }, `from ${key}, with no cross-origin header, both reads reached the API`);
  broken((pass) => { pass.pages[key].page.calls.none.get = { ok: false, error: "AbortError" }; }, `from ${key}, with no cross-origin header, the page can't read`);
  broken((pass) => { pass.pages[key].page.calls.star.get = { ok: false, error: "TypeError" }; }, `from ${key}, the same read works where the API allows any origin`);
}
for (const mode of NO_PREFLIGHT_ANSWER) {
  for (const call of PREFLIGHTED) broken((pass) => { pass.pages.boxedElsewhere.api.byMode[mode][call] = 1; }, `with no preflight answer (${mode}), no JSON write reached the API`);
}
for (const key of ["own", "boxedElsewhere", "plainElsewhere"]) broken((pass) => { pass.pages[key].page.calls.none.get = { ok: true, status: 200, items: [] }; }, `from ${key}, with no cross-origin header`);
broken((pass) => { pass.pages.own.api.byMode.star.preflights = 0; }, "received the browser's own preflight");
broken((pass) => { pass.withoutThePolicy.shown = false; }, "the control ran");
broken((pass) => { pass.withoutThePolicy.pages.own.page.origin = "null"; }, "in the control the app's page has its own origin");
broken((pass) => { pass.withoutThePolicy.pages.own.page.calls.none.putJson = { ok: false, error: "TypeError" }; }, "in the control, on its own origin, putJson works");

// A browser that is installed and didn't run fails the run; one that isn't installed doesn't.
check(verdict({ browsers: { chromium: { shown: false, why: "it crashed" } } }, ["chromium"]).failed.length === 1, "an installed browser that didn't run fails the run");
check(verdict(run, []).failed.length === 1, "no installed browser at all fails the run");
// What the run observes and never asserts stays out of the judge: a page whose every write failed still passes if
// the properties hold, so "a todo app works" is read from the record, not from the exit code. One read is asserted,
// where the API allows any origin, only to show the page reaches the API at all.
{
  const pass = copy(run.browsers.chromium);
  for (const mode of ["star", "null"]) for (const call of ["postJson", "putJson", "postText", "deleteJson"]) pass.pages.own.page.calls[mode][call] = { ok: false, error: "TypeError" };
  check(judge("chromium", pass).length === 0, "whether the app's own writes work is an observation: the judge doesn't assert it");
}
console.log(failures === 0 ? "\nsandbox api self-test: all passed" : `\nsandbox api self-test: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
