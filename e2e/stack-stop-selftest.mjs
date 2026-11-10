// Checks that waiting for a stopped stack waits for every process under it, not only the one these scripts started.
// run-a11y.mjs writes into the Workers' SQLite files once they've stopped, and a runtime that outlives its launcher still
// has them open.
//
//   node stack-stop-selftest.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { groupAlive, groupGone } from "./stack.mjs";

let failed = 0;
const check = (passed, title, detail) => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}${detail ? ` (${detail})` : ""}`);
};

/** `promise`, or a failure after `ms`, so a child that never starts stops this test and not the whole job. */
function within(ms, promise, what) {
  let timer;
  const late = new Promise((_, fail) => (timer = setTimeout(() => fail(new Error(`${what} didn't happen within ${ms} ms`)), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// A launcher that ends on the signal, over a child that takes `lingerMs` longer, as wrangler's launcher is over its runtimes.
function launch(lingerMs) {
  const child = `process.on("SIGTERM", () => setTimeout(() => process.exit(0), ${lingerMs})); console.log("ready"); setInterval(() => {}, 1000);`;
  const launcher = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "inherit" }); setInterval(() => {}, 1000);`;
  const proc = spawn(process.execPath, ["-e", launcher], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  const ready = new Promise((done) => proc.stdout.once("data", done));
  const exited = new Promise((done) => proc.once("exit", done));
  return { proc, ready, exited };
}

{
  // The child lingers long enough that a slow runner still sees the launcher exit first. Nothing here needs the
  // launcher to be quick: the order is read from the group still being alive, not from a clock.
  const linger = 3_000;
  const { proc, ready, exited } = launch(linger);
  await within(30_000, ready, "the child starting");
  const started = Date.now();
  process.kill(-proc.pid, "SIGTERM");
  await within(30_000, exited, "the launcher exiting");
  const launcherTook = Date.now() - started;
  check(groupAlive(proc.pid), "the group still counts as running once its launcher has exited", `launcher ${launcherTook} ms`);
  const gone = await groupGone(proc.pid, 30_000);
  const took = Date.now() - started;
  check(gone && !groupAlive(proc.pid), "waiting ends once the child under it has exited");
  // The child can't exit sooner than it lingers, so this bound holds however slow the machine is.
  check(took >= linger, "and not before", `launcher ${launcherTook} ms, group ${took} ms, child lingers ${linger} ms`);
}

{
  const { proc, ready } = launch(60_000);
  await within(30_000, ready, "the child starting");
  process.kill(-proc.pid, "SIGTERM");
  check((await groupGone(proc.pid, 300)) === false, "a child that won't end is reported, not waited on forever");
  process.kill(-proc.pid, "SIGKILL");
  check(await groupGone(proc.pid, 10_000), "and is gone once killed");
}

// The wait is only worth anything if the accessibility run makes it: it has to stop the Workers, wait for every process
// to end, and only then write. `backend.gone` is `groupGone` on the stack's process group.
{
  const stack = readFileSync(new URL("./stack.mjs", import.meta.url), "utf8");
  const run = readFileSync(new URL("./run-a11y.mjs", import.meta.url), "utf8");
  check(/gone: \(timeout\) => groupGone\(stack\.pid, timeout\)/.test(stack), "a started stack's `gone` is groupGone on its own process group");
  const stop = run.indexOf("backend.stop();");
  const wait = run.indexOf("if (!(await backend.gone())) throw");
  const write = run.indexOf("await writeFileStates(");
  check(stop !== -1 && wait !== -1 && write !== -1, "run-a11y.mjs stops the Workers, waits for them to be gone, and writes the file states", `at ${stop}, ${wait}, ${write}`);
  check(stop < wait && wait < write, "in that order, and a stack that isn't gone throws before the write", `at ${stop}, ${wait}, ${write}`);
  check(run.split("writeFileStates(").length === 2, "and that is the only place it writes them");
}

console.log(failed === 0 ? "\nthe stack's stop wait: all checks passed" : `\nthe stack's stop wait: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
