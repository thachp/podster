// Checks the bounds the accessibility run puts on its waits: one that never finishes is stopped at its bound and named,
// and one that finishes isn't touched. A run once waited 20 minutes on a page that never answered.
//
//   node bounded-selftest.mjs
import { bounded, boundMethods, callSite, Stalled, waitingFor } from "./bounded.mjs";

let failed = 0;
const check = (passed, title, detail) => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}${detail ? ` (${detail})` : ""}`);
};
const never = () => new Promise(() => {});
const caught = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

{
  const told = [];
  const started = Date.now();
  const pending = caught(bounded("a page that never answers", 200, never(), (error) => told.push(error)));
  check(waitingFor().includes("a page that never answers"), "a wait in progress is listed");
  const { error } = await pending;
  const took = Date.now() - started;
  check(error instanceof Stalled, "a wait that never finishes is stopped at its bound", `after ${took} ms`);
  check(took < 5_000, "and soon after the bound, not much later", `${took} ms`);
  check(error?.message === "waited 0 seconds for a page that never answers, and it didn't finish", "the failure names what was waited for", error?.message);
  check(told.length === 1 && told[0] === error, "the caller is told once, with the same failure");
  check(waitingFor().length === 0, "a stopped wait is no longer listed");
}

{
  const told = [];
  const { value } = await caught(bounded("something quick", 200, Promise.resolve(7), () => told.push(1)));
  const { error } = await caught(bounded("something that fails", 200, Promise.reject(new Error("its own failure")), () => told.push(1)));
  // Past the bound, so a timer left running would show.
  await new Promise((done) => setTimeout(done, 400));
  check(value === 7, "a wait that finishes gives its value");
  check(error?.message === "its own failure" && !(error instanceof Stalled), "a wait that fails gives its own failure, not a stall");
  check(told.length === 0, "neither is reported as stalled, then or later");
  check(waitingFor().length === 0, "neither is still listed");
}

{
  class Page {
    evaluate(answer) {
      return answer === "never" ? never() : Promise.resolve(`${answer} from ${this.name}`);
    }
  }
  const told = [];
  const real = boundMethods(Page.prototype, ["evaluate"], { ms: 200, file: "bounded-selftest.mjs", onStall: (error) => told.push(error) });
  const page = Object.assign(new Page(), { name: "the page" });
  check((await page.evaluate("an answer")) === "an answer from the page", "a bounded method still runs on its own object");
  const { error } = await caught(page.evaluate("never"));
  check(error instanceof Stalled && /^waited 0 seconds for evaluate\(\) at bounded-selftest\.mjs:\d+, /.test(error.message), "a bounded method that never answers names itself and the line that called it", error?.message);
  check(told.length === 1, "and reports the stall");
  check((await real.evaluate.call(page, "an answer")) === "an answer from the page", "the real method is handed back");
  let refused = false;
  try {
    boundMethods(Page.prototype, ["evaluateAll"], { ms: 200, file: "bounded-selftest.mjs" });
  } catch {
    refused = true;
  }
  check(refused, "a method that isn't there is refused, not silently left unbounded");
}

{
  const stack = "Error\n    at wrapped (file:///repo/e2e/bounded.mjs:55:14)\n    at openHeavy (file:///repo/e2e/a11y.mjs:1929:17)\n    at async keyboardPath (file:///repo/e2e/a11y.mjs:542:5)";
  check(callSite("a11y.mjs", stack) === "a11y.mjs:1929", "the calling line is the nearest one in the named file", callSite("a11y.mjs", stack));
  check(callSite("a11y.mjs", "Error\n    at somewhere else") === "a11y.mjs, at a line that couldn't be read", "a stack without that file says so");
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
