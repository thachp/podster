// Upper bounds for the accessibility run's waits. Playwright bounds its own actions, but not a script run in the page: an
// `evaluate` whose promise never settles, because the page's main thread is busy or an animation frame never comes, waits
// for ever. One did, and the job ran to its 25-minute limit with nothing saying where it stopped.
import { execFileSync, spawn } from "node:child_process";
import { basename } from "node:path";
import { groupAlive, groupGone } from "./stack.mjs";

/** A wait that reached its bound. Nothing retries one: the run stops and says what it was waiting for. */
export class Stalled extends Error {}

/** What's being waited for now, oldest first, for saying where a run stopped. */
const waiting = new Map();
let nextWait = 0;
export const waitingFor = () => [...waiting.values()];

/**
 * `work`, or a `Stalled` after `ms` that names `what`. `onStall` is told as well, for a caller that swallows rejections.
 * The work itself can't be cancelled, so whoever catches this should stop rather than carry on beside it.
 */
export function bounded(what, ms, work, onStall) {
  const id = nextWait++;
  waiting.set(id, what);
  let timer;
  const late = new Promise((_, fail) => {
    timer = setTimeout(() => {
      const error = new Stalled(`waited ${Math.round(ms / 1000)} seconds for ${what}, and it didn't finish`);
      onStall?.(error);
      fail(error);
    }, ms);
  });
  return Promise.race([Promise.resolve(work), late]).finally(() => {
    clearTimeout(timer);
    waiting.delete(id);
  });
}

/** The line of `file` that called, as `a11y.mjs:1929`, read from a stack. */
export function callSite(file, stack = new Error().stack) {
  const line = stack.split("\n").find((frame) => frame.includes(`/${file}:`));
  const at = line?.match(/([^/\\]+:\d+):\d+\)?$/)?.[1];
  return at ?? `${basename(file)}, at a line that couldn't be read`;
}

/**
 * Bounds `methods` on a Playwright class through its prototype, so every call in `file` is bounded without each one saying
 * so. The first argument to `onStall` names the method and the line that called it. Returns the real methods, for a caller
 * that has to ask a page something after a stall without waiting on it again.
 */
export function boundMethods(prototype, methods, { ms, file, onStall }) {
  const real = {};
  for (const method of methods) {
    const original = prototype[method];
    if (typeof original !== "function") throw new Error(`there's no ${method}() to bound`);
    real[method] = original;
    prototype[method] = function (...args) {
      return bounded(`${method}() at ${callSite(file)}`, ms, original.apply(this, args), onStall);
    };
  }
  return real;
}

/** Signals every process in the group `pid` leads. A group that's already gone is fine. */
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * The process groups that `pid`'s descendants are in, other than its own and ours. Playwright starts a browser in a group
 * of its own, so stopping a script's group doesn't reach its browser. Read before the script is signalled, while they're
 * still its descendants.
 */
export function groupsUnder(pid) {
  let rows;
  try {
    rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  } catch {
    return [];
  }
  const under = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [child, parent] of rows) {
      if (!under.has(parent) || under.has(child)) continue;
      under.add(child);
      grew = true;
    }
  }
  const ours = rows.find(([row]) => row === process.pid)?.[2];
  return [...new Set(rows.filter(([row]) => under.has(row)).map(([, , group]) => group))].filter((group) => group !== pid && group !== ours && group > 1);
}

/**
 * Starts `command` in its own process group and bounds it. If it hasn't exited after `ms`, `onLate` is told, the group is
 * asked to stop, and whatever is left after `graceMs`, in that group or in a group one of its descendants started, is
 * killed. `done` gives the exit status, with 1 for a process that was killed or ran late, and `late` says which. It
 * settles only once every one of those processes has ended, or `stopped` is false.
 */
export function startBounded({ command, args, options = {}, ms, graceMs = 10_000, onLate }) {
  const proc = spawn(command, args, { ...options, detached: true });
  let late = false;
  // If this process ends first, the child's group goes with it.
  const sweep = () => signalGroup(proc.pid, "SIGTERM");
  process.on("exit", sweep);
  const done = new Promise((settle) => {
    const timer = setTimeout(async () => {
      late = true;
      onLate?.();
      const groups = groupsUnder(proc.pid);
      signalGroup(proc.pid, "SIGTERM");
      let stopped = await groupGone(proc.pid, graceMs);
      if (!stopped) {
        signalGroup(proc.pid, "SIGKILL");
        stopped = await groupGone(proc.pid, graceMs);
      }
      for (const group of groups) {
        if (!groupAlive(group)) continue;
        signalGroup(group, "SIGKILL");
        stopped = (await groupGone(group, graceMs)) && stopped;
      }
      process.off("exit", sweep);
      settle({ code: 1, late: true, stopped });
    }, ms);
    proc.on("error", () => {
      if (late) return;
      clearTimeout(timer);
      process.off("exit", sweep);
      settle({ code: 1, late: false, stopped: true });
    });
    proc.on("exit", (status) => {
      if (late) return;
      clearTimeout(timer);
      process.off("exit", sweep);
      // A killed process has no status, and that's a failure.
      settle({ code: status ?? 1, late: false, stopped: true });
    });
  });
  return { proc, done };
}
