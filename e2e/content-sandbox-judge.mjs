// What decision 216 buys, as assertions on one run of e2e/content-sandbox.mjs. These fail the run. Everything else
// the run records is an observation of what an ordinary app can do. Kept apart from the run so it can be tested
// against recorded results, with no browser: e2e/content-sandbox-selftest.mjs.

const REFUSED = ["cookieWrite", "cookieWriteForDomain", "cookieRead", "localStorage", "sessionStorage", "indexedDB", "cacheApi", "serviceWorker"];

/** What one browser's pass fails, as a list of sentences. Empty when it holds everything. */
export function judge(name, pass, domain) {
  const failed = [];
  const expect = (holds, what) => { if (!holds) failed.push(`${name}: ${what}`); };
  const refused = (result) => result !== undefined && result.ok === false;
  expect(pass.results?.origin?.ok === true && pass.results.origin.value === "null", "under the policy the page's origin is `null`");
  for (const probe of REFUSED) expect(refused(pass.results?.[probe]), `under the policy ${probe} is refused`);
  expect(refused(pass.sibling?.cookieRead), "a sibling host can't read a cookie");
  expect(refused(pass.sibling?.cookieWriteForDomain), "a sibling host can't write a cookie for the domain");
  expect(pass.requestsMade > 0 && pass.requestsThatCarriedACookie === 0, "no request carries a cookie");
  expect(pass.answersWithSetCookie === 0 && Array.isArray(pass.cookiesInTheBrowsersJar) && pass.cookiesInTheBrowsersJar.length === 0, "an app's `Set-Cookie` never reaches the browser");
  // The control must show the opposite, or the rows above would hold for a harness that could see nothing.
  const control = pass.withoutThePolicy ?? {};
  expect(control.shown === true, "the control ran");
  expect(control.results?.origin?.value === `https://appa.${domain}`, "in the control the page has its own origin");
  expect(control.results?.cookieWrite?.ok === true && control.results?.localStorage?.ok === true, "in the control cookies and storage work");
  expect(control.sibling?.cookieRead?.ok === true && String(control.sibling.cookieRead.value).includes("shared=1"), "in the control the sibling reads the first app's cookie");
  expect(control.answersWithSetCookie === 0, "in the control too, an app's `Set-Cookie` never reaches the browser");
  return failed;
}

/** The whole run's verdict: every installed browser must have run, and each must hold the above. */
export function verdict(report, installed, domain) {
  const failed = [];
  if (installed.length === 0) failed.push("no browser is installed for Playwright to launch");
  for (const name of installed) {
    const pass = report.browsers?.[name];
    if (!pass?.shown) failed.push(`${name}: installed, and it didn't run (${pass?.why ?? "no result"})`);
    else failed.push(...judge(name, pass, domain));
  }
  return { browsersInstalled: installed, browsersRun: installed.filter((name) => report.browsers?.[name]?.shown), failed };
}
