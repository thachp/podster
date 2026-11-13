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
  // No page's request carried a cookie: there is nothing for a request to ride on.
  for (const [key, shown] of Object.entries(pass.pages ?? {})) expect(shown.api?.withACookie === 0, `no request from ${key} carried a cookie`);
  // With no answer to its preflight, a JSON write never reaches the API, from any page.
  for (const [key, shown] of Object.entries(pass.pages ?? {})) {
    for (const mode of NO_PREFLIGHT_ANSWER) {
      const got = shown.api?.byMode?.[mode] ?? {};
      expect(got.postJson === 0 && got.putJson === 0 && got.deleteJson === 0, `from ${key}, with no preflight answer (${mode}), no JSON write reached the API`);
    }
  }
  // With no `Access-Control-Allow-Origin` at all, a page on another origin reads nothing back.
  for (const key of ["own", "boxedElsewhere", "plainElsewhere"]) {
    const calls = pass.pages?.[key]?.page?.calls?.none ?? {};
    expect(calls.get?.ok === false && calls.getAfter?.ok === false, `from ${key}, with no cross-origin header, the page can't read the API's answer`);
  }
  // The harness carries real preflights: where one is answered, the API received it.
  expect(own.api?.byMode?.star?.preflights > 0, "the API received the browser's own preflight from the app's page");
  // The control must show the opposite, or the refusals above would hold for a harness that could show nothing.
  const control = pass.withoutThePolicy ?? {};
  const controlOwn = control.pages?.own ?? {};
  expect(control.shown === true, "the control ran");
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
