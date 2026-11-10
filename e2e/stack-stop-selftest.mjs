// Checks that waiting for a stopped stack waits for every process under it, not only the one these scripts started.
// run-a11y.mjs writes into the Workers' SQLite files once they've stopped, and a runtime that outlives its launcher still
// has them open.
//
//   node stack-stop-selftest.mjs
import { spawn } from "node:child_process";
import { groupAlive, groupGone } from "./stack.mjs";

let failed = 0;
const check = (passed, title) => {
  if (!passed) failed++;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}`);
};

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
  const { proc, ready, exited } = launch(700);
  await ready;
  const started = Date.now();
  process.kill(-proc.pid, "SIGTERM");
  await exited;
  const launcherTook = Date.now() - started;
  check(groupAlive(proc.pid), "the group still counts as running once its launcher has exited");
  const gone = await groupGone(proc.pid, 10_000);
  const took = Date.now() - started;
  check(gone && !groupAlive(proc.pid), "waiting ends once the child under it has exited");
  check(launcherTook < 600 && took >= 600, "and not before", `launcher ${launcherTook} ms, group ${took} ms`);
}

{
  const { proc, ready } = launch(60_000);
  await ready;
  process.kill(-proc.pid, "SIGTERM");
  check((await groupGone(proc.pid, 300)) === false, "a child that won't end is reported, not waited on forever");
  process.kill(-proc.pid, "SIGKILL");
  check(await groupGone(proc.pid, 10_000), "and is gone once killed");
}

console.log(failed === 0 ? "\nthe stack's stop wait: all checks passed" : `\nthe stack's stop wait: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
