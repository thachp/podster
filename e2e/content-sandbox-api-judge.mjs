// What must hold in one run of e2e/content-sandbox-api.mjs, as assertions. **Only what is a security property, or
// what shows the harness can see anything, is asserted.** Whether a todo app works under the sandbox, and what any
// other page can do to its API, are the run's observations: they are recorded and never asserted. Kept apart from the
// run so it can be tested against a recorded result, with no browser: e2e/content-sandbox-api-selftest.mjs.

/** The apps' domain, and another that is nothing to do with them. The same two names the test entry uses. */
export const DOMAIN = "sandbox-test.example";
export const ELSEWHERE = "elsewhere-test.example";
/** The ways the test API answers a browser's cross-origin rules. The same list the test entry has. */
export const MODES = ["none", "star", "null", "star-nopre", "null-nopre"];
/** The ways that give no answer to a preflight. */
export const NO_PREFLIGHT_ANSWER = ["none", "star-nopre", "null-nopre"];
/** The calls a page makes that a browser asks leave for first: a JSON body is not a simple request. */
export const PREFLIGHTED = ["postJson", "putJson", "deleteJson"];
/** The four pages a pass opens. */
export const PAGE_KEYS = ["own", "sibling", "boxedElsewhere", "plainElsewhere"];
/** Every call a page makes, in the order it makes them. */
export const CALLS = ["get", "postJson", "putJson", "postText", "getAfter", "deleteJson"];

/** What one browser's pass fails, as a list of sentences. Empty when it holds everything. */
export function judge(name, pass) {
  const failed = [];
  const expect = (holds, what) => { if (!holds) failed.push(`${name}: ${what}`); };
  const own = pass.pages?.own ?? {};
  // The page is sandboxed, and the API saw it as such.
  expect(own.page?.origin === "null", "under the policy the app's own page has the origin `null`");
  expect(Array.isArray(own.api?.origins) && own.api.origins.length > 0 && own.api.origins.every((origin) => origin === "null"), "every request from the app's own page reached the API with `Origin: null`");
  // Every step finished and every page gave its results: a page that never loaded shows nothing, and passes nothing.
  expect(Array.isArray(pass.stepsThatDidNotFinish) && pass.stepsThatDidNotFinish.length === 0, "every step finished");
  for (const key of PAGE_KEYS) expect(pass.pages?.[key]?.page?.calls !== undefined, `${key} loaded and gave its results`);
  // The run's own servers never failed: a failure of the harness is never taken for a browser's refusal.
  for (const [key, shown] of Object.entries(pass.pages ?? {})) expect(shown.api?.harnessErrors === 0, `the run's own servers answered every request from ${key}`);
  // The API offers a cookie on every answer, and no page's request ever carried one. The sibling's page sends the
  // API nothing at all, so there it says nothing, and isn't asked.
  for (const key of ["own", "boxedElsewhere", "plainElsewhere"]) {
    const api = pass.pages?.[key]?.api ?? {};
    expect(api.answersThatSetACookie > 0 && api.withACookie === 0, `the API set a cookie on its answers to ${key}, and no request from ${key} carried one`);
  }
  // With no answer to its preflight, a JSON write never reaches the API, from any page.
  for (const [key, shown] of Object.entries(pass.pages ?? {})) {
    for (const mode of NO_PREFLIGHT_ANSWER) {
      const got = shown.api?.byMode?.[mode] ?? {};
      expect(got.postJson === 0 && got.putJson === 0 && got.deleteJson === 0, `from ${key}, with no preflight answer (${mode}), no JSON write reached the API`);
    }
  }
  // With no `Access-Control-Allow-Origin` at all, a page on another origin reads nothing back, **and that is the
  // browser's refusal:** both reads reached the API, both answers were handed to the browser with status 200, and
  // the page was still given an error. The same page reads the same API where the header allows it, so the path works.
  for (const key of ["own", "boxedElsewhere", "plainElsewhere"]) {
    const shown = pass.pages?.[key] ?? {};
    const calls = shown.page?.calls?.none ?? {};
    const refused = (call) => call?.ok === false && call.error === "TypeError";
    expect(shown.api?.byMode?.none?.get === 2 && shown.api?.handedToTheBrowser?.none?.readsAnswered200 === 2, `from ${key}, with no cross-origin header, both reads reached the API and both answers were handed to the browser`);
    expect(refused(calls.get) && refused(calls.getAfter), `from ${key}, with no cross-origin header, the page can't read the API's answer`);
    expect(shown.page?.calls?.star?.get?.ok === true, `from ${key}, the same read works where the API allows any origin`);
  }
  // The harness carries real preflights: where one is answered, the API received it.
  expect(own.api?.byMode?.star?.preflights > 0, "the API received the browser's own preflight from the app's page");
  // The control must show the opposite, or the refusals above would hold for a harness that could show nothing.
  const control = pass.withoutThePolicy ?? {};
  const controlOwn = control.pages?.own ?? {};
  expect(control.shown === true, "the control ran");
  expect(Array.isArray(control.stepsThatDidNotFinish) && control.stepsThatDidNotFinish.length === 0, "every step of the control finished");
  // On its own origin the browser keeps the API's cookie and sends it: so "no request carried one" means something.
  expect(controlOwn.api?.withACookie > 0, "in the control, on its own origin, requests carry the API's cookie");
  expect(controlOwn.page?.origin === `https://appa.${DOMAIN}`, "in the control the app's page has its own origin");
  for (const mode of MODES) {
    for (const call of CALLS) expect(controlOwn.page?.calls?.[mode]?.[call]?.ok === true, `in the control, on its own origin, ${call} works however the API answers (${mode})`);
  }
  return failed;
}

/** The whole run's verdict: every installed browser must have run, and each must hold the above. */
export function verdict(report, installed) {
  const failed = [];
  if (installed.length === 0) failed.push("no browser is installed for Playwright to launch");
  for (const name of installed) {
    const pass = report.browsers?.[name];
    if (!pass?.shown) failed.push(`${name}: installed, and it didn't run (${pass?.why ?? "no result"})`);
    else failed.push(...judge(name, pass));
  }
  return { browsersInstalled: installed, browsersRun: installed.filter((name) => report.browsers?.[name]?.shown), failed };
}
