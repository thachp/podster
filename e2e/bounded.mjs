// Upper bounds for the accessibility run's waits. Playwright bounds its own actions, but not a script run in the page: an
// `evaluate` whose promise never settles, because the page's main thread is busy or an animation frame never comes, waits
// for ever. One did, and the job ran to its 25-minute limit with nothing saying where it stopped.
import { basename } from "node:path";

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
