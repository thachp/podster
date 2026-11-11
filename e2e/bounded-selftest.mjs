// Checks the bounds the accessibility run puts on its waits: one that never finishes is stopped at its bound and named,
// and one that finishes isn't touched. A run once waited 20 minutes on a page that never answered.
//
//   node bounded-selftest.mjs
import { readFileSync } from "node:fs";
import { bounded, boundMethods, callSite, groupsUnder, Stalled, startBounded, waitingFor } from "./bounded.mjs";
import { groupAlive } from "./stack.mjs";

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

// The bound on a whole script, as run-a11y.mjs puts on a11y.mjs: made to fire, with a short bound, on a script that never
// exits and won't stop when asked, over a "browser" in a group of its own that won't either, as Playwright starts one.
{
  const stubborn = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  const script = `const { spawn } = require("node:child_process"); process.on("SIGTERM", () => {}); const browser = spawn(process.execPath, ["-e", ${JSON.stringify(`${stubborn} console.log(process.pid);`)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] }); setInterval(() => {}, 1000);`;
  let told = 0;
  const started = Date.now();
  const { proc, done } = startBounded({ command: process.execPath, args: ["-e", script], options: { stdio: ["ignore", "pipe", "inherit"], env: { PATH: process.env.PATH, ONLY_THIS: "1" } }, ms: 3_000, graceMs: 1_000, onLate: () => told++ });
  const browser = Number(await bounded("the stand-in browser starting", 30_000, new Promise((got) => proc.stdout.once("data", (chunk) => got(String(chunk).trim())))));
  check(Number.isInteger(browser) && groupAlive(browser) && groupAlive(proc.pid), "a script and its browser are running, each in its own group");
  check(groupsUnder(proc.pid).includes(browser), "the browser's group is found under the script");
  const ended = await bounded("a late script being stopped", 60_000, done);
  const took = Date.now() - started;
  check(ended.late === true && ended.code === 1, "a script that never exits is stopped at its bound, as a failure", `after ${took} ms`);
  check(told === 1, "and the caller is told once");
  check(!groupAlive(proc.pid), "nothing of the script is left, though it ignored being asked to stop");
  check(!groupAlive(browser), "nothing of its browser is left either, though it was in a group of its own");
  check(ended.stopped === true, "and it says everything stopped");
}

{
  const exits = (status) => startBounded({ command: process.execPath, args: ["-e", `process.stdout.write(JSON.stringify(Object.keys(process.env).sort())); process.exit(${status});`], options: { stdio: ["ignore", "pipe", "inherit"], env: { ONLY_THIS: "1" } }, ms: 30_000 });
  let told = 0;
  const fine = exits(0);
  let seen = "";
  fine.proc.stdout.on("data", (chunk) => (seen += chunk));
  const first = await fine.done;
  const second = await startBounded({ command: process.execPath, args: ["-e", "process.exit(3)"], ms: 30_000, onLate: () => told++ }).done;
  check(first.code === 0 && first.late === false, "a script that exits in time gives its status");
  check(second.code === 3 && second.late === false && told === 0, "a failing one gives its own, and neither is called late");
  // macOS adds one name of its own to every process.
  check(JSON.stringify(JSON.parse(seen).filter((name) => name !== "__CF_USER_TEXT_ENCODING")) === '["ONLY_THIS"]', "a script gets the environment it's given, and no more", seen);
}

// run-a11y.mjs uses it, so its bound is this one.
check(/const checks = startBounded\(\{/.test(readFileSync(new URL("./run-a11y.mjs", import.meta.url), "utf8")), "run-a11y.mjs starts a11y.mjs with this bound");

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
