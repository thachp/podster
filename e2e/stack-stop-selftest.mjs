// Checks that waiting for a stopped stack waits for every process under it, not only the one these scripts started.
// run-a11y.mjs writes into the Workers' SQLite files once they've stopped, and a runtime that outlives its launcher still
// has them open.
//
//   node stack-stop-selftest.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setFileStatesWhileStopped } from "./asset-fixture.mjs";
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

// `setFileStatesWhileStopped` is the one way file states are written: stop, wait for every process, then write.
{
  const order = [];
  const stack = { stop: () => order.push("stop"), gone: async (timeout) => (order.push(`gone ${timeout}`), true) };
  const write = async (persist, changes) => (order.push(`write ${persist} ${changes}`), "written");
  const result = await setFileStatesWhileStopped(stack, "folder", "changes", { timeout: 1234, write });
  check(order.join(", ") === "stop, gone 1234, write folder changes" && result === "written", "it stops, waits for the stack to be gone, then writes what it was given, in that order", order.join(", "));
}
{
  const order = [];
  let release;
  const stack = { stop: () => order.push("stop"), gone: () => new Promise((done) => (release = () => (order.push("gone"), done(true)))) };
  const pending = setFileStatesWhileStopped(stack, "folder", [], { write: async () => order.push("write") });
  await new Promise((later) => setTimeout(later, 200));
  check(order.join(", ") === "stop", "while the stack isn't yet gone, it has stopped it and written nothing", order.join(", "));
  release();
  await pending;
  check(order.join(", ") === "stop, gone, write", "and it writes as soon as the stack is gone", order.join(", "));
}
{
  const order = [];
  const stack = { stop: () => order.push("stop"), gone: async () => (order.push("gone"), false) };
  let error;
  await setFileStatesWhileStopped(stack, "folder", [], { write: async () => order.push("write") }).catch((caught) => (error = caught));
  check(error instanceof Error && order.join(", ") === "stop, gone", "a stack that isn't gone in time throws, and nothing is written", `${order.join(", ")}; ${error?.message}`);
}
{
  // With real processes: the write sees nothing left of a group whose child outlives its launcher.
  const { proc, ready } = launch(1_000);
  await within(30_000, ready, "the child starting");
  const stack = { stop: () => process.kill(-proc.pid, "SIGTERM"), gone: (timeout) => groupGone(proc.pid, timeout) };
  let aliveAtWrite;
  await setFileStatesWhileStopped(stack, "folder", [], { write: async () => (aliveAtWrite = groupAlive(proc.pid)) });
  check(aliveAtWrite === false, "by the time it writes, every process of a real stack has ended");
}
{
  const { proc, ready } = launch(60_000);
  await within(30_000, ready, "the child starting");
  const stack = { stop: () => process.kill(-proc.pid, "SIGTERM"), gone: (timeout) => groupGone(proc.pid, timeout) };
  let wrote = false;
  const error = await setFileStatesWhileStopped(stack, "folder", [], { timeout: 300, write: async () => (wrote = true) }).then(() => null, (caught) => caught);
  check(error instanceof Error && !wrote, "a real stack that won't end throws, and nothing is written");
  process.kill(-proc.pid, "SIGKILL");
  await groupGone(proc.pid, 10_000);
}

// The order is the function's, tested above. What is left to read from source is that the accessibility run can reach
// the writer no other way: the writer isn't exported, and the run imports the one function and calls it.
{
  const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
  const fixture = await import("./asset-fixture.mjs");
  check(typeof fixture.setFileStatesWhileStopped === "function" && !("writeFileStates" in fixture), "asset-fixture.mjs exports setFileStatesWhileStopped, and not the writer itself", Object.keys(fixture).join(", "));
  check(/gone: \(timeout\) => groupGone\(stack\.pid, timeout\)/.test(read("./stack.mjs")), "a started stack's `gone` is groupGone on its own process group");
  const run = read("./run-a11y.mjs");
  const imports = run.match(/^import .* from "\.\/asset-fixture\.mjs";$/gm) ?? [];
  check(imports.length === 1 && imports[0] === 'import { setFileStatesWhileStopped } from "./asset-fixture.mjs";', "run-a11y.mjs imports that one function from it, by its own name", imports.join(" | "));
  check(!/writeFileStates|import\(|node:sqlite|DatabaseSync/.test(run), "and has no other way to the writer or to the files: no writeFileStates, dynamic import or SQLite of its own");
  check(/await setFileStatesWhileStopped\(backend, persist, message\.changes\);/.test(run), "and calls it on the backend it started");
}

console.log(failed === 0 ? "\nthe stack's stop wait: all checks passed" : `\nthe stack's stop wait: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
