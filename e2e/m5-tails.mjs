// The log tails of m5-staging.mjs: `wrangler tail` as a child for each Worker, what it's allowed to see of the
// environment, how a tail that didn't start is told from one that did, and what wrangler said when it didn't. Kept apart
// so m5-staging-selftest.mjs can run all of it against stand-ins for wrangler, with no network and no login.
//
// Learned from a real tail against staging on 2026-11-11, which the first extended run didn't have:
// - With more than one account on the login and none named, wrangler exits 1 in under a second. So the account's ID is
//   passed on, and nothing else of Cloudflare's.
// - With `--format json` wrangler prints nothing when it connects: no banner, no line. A tail that is up and one that
//   never will be look the same until an event arrives, so "connected" is only ever shown by a request of the run's own
//   that the tail then holds.
// - The web app reaches the gateway by RPC, and that event carries no URL. A request to a public page shows in the web
//   app's tail and the API's, never in the gateway's: the gateway needs a request sent to it directly.
import { spawn } from "node:child_process";
import { childEnv } from "./child-env.mjs";
import { JsonStream } from "./tail-stream.mjs";

/** The one name of Cloudflare's a tail is given: which account's Workers to tail. An ID, not a credential. */
export const ACCOUNT_ENV = "CLOUDFLARE_ACCOUNT_ID";
export const TAIL_ARGS = ["tail", "--env", "staging", "--format", "json"];
/** How long every tail must stay up before anything is sent anywhere. A tail that can't start exits within a second or two. */
export const STAY_UP_SECONDS = 10;
const MAX_STDERR_CHARS = 16 * 1024;

/**
 * A tail's environment: child-env.mjs's allow-list, and the account's ID when it is one. child-env.mjs refuses every
 * `CLOUDFLARE_` name, which is right for every other child, so the exception is made here, by name, for this child
 * alone. No token, no key and no other `CLOUDFLARE_` name passes: the tail signs in with `wrangler login`.
 */
export function tailEnv(from = process.env) {
  const env = childEnv({}, from);
  const account = from[ACCOUNT_ENV];
  return typeof account === "string" && /^[0-9a-f]{32}$/.test(account) ? { ...env, [ACCOUNT_ENV]: account } : env;
}

/** Starts one tail. Its events are read as a stream of JSON values, and what it writes to stderr is kept, bounded. */
export function openTail({ app, bin, cwd, env = tailEnv() }) {
  const tail = { app, stream: new JsonStream(), error: null, stderr: "", proc: null };
  tail.proc = spawn(bin, TAIL_ARGS, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  // A missing wrangler, or one that can't start, is this tail's fault and not the run's.
  tail.proc.on("error", (error) => (tail.error = error.code ?? "spawn_failed"));
  tail.proc.stdout.setEncoding("utf8");
  tail.proc.stdout.on("data", (chunk) => tail.stream.push(chunk));
  tail.proc.stderr.setEncoding("utf8");
  tail.proc.stderr.on("data", (chunk) => {
    if (tail.stderr.length < MAX_STDERR_CHARS) tail.stderr += String(chunk).slice(0, MAX_STDERR_CHARS - tail.stderr.length);
  });
  return tail;
}

/** Why a tail can't be trusted now, or null: wrangler failed to start or has exited, or its stream overflowed. */
export const tailFault = (tail) =>
  tail.error ??
  (tail.proc?.exitCode !== null && tail.proc?.exitCode !== undefined ? `wrangler exited with code ${tail.proc.exitCode}` : null) ??
  (tail.proc?.signalCode ? `wrangler was stopped by ${tail.proc.signalCode}` : null) ??
  tail.stream.error;

/**
 * What wrangler said was wrong, for printing: its first error line and the line of detail after it. Colours are taken
 * out, and so is anything that could name an account or a person: wrangler lists every account of the login, by name and
 * ID, when it can't choose one, and that list is cut.
 */
export function wranglerReason(stderr) {
  const lines = String(stderr ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((line) => line.trim());
  const at = lines.findIndex((line) => line.includes("[ERROR]"));
  if (at < 0) return "wrangler said nothing about why";
  const said = [lines[at].replace(/^.*\[ERROR\]\s*/, "")];
  const detail = lines.slice(at + 1).find((line) => line.length > 0);
  if (detail && !/available accounts|`[^`]*`:\s*`/i.test(detail)) said.push(detail);
  return said.join(" ").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[an address]").replace(/\b[0-9a-f]{32}\b/g, "[an ID]").slice(0, 300);
}

const nap = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Watches the tails for `seconds` and answers the ones that didn't stay up, each with its fault and wrangler's reason.
 * It answers as soon as every tail has gone, and otherwise waits the whole time: staying up is the only thing a tail
 * shows before a request reaches it.
 */
export async function downWithin(tails, seconds, { step = 250 } = {}) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !tails.every(tailFault)) await nap(step);
  // A moment for a tail that has just exited to finish writing why.
  if (tails.some(tailFault)) await nap(Math.min(step, 250));
  return tails.filter(tailFault).map((tail) => ({ app: tail.app, fault: tailFault(tail), reason: wranglerReason(tail.stderr) }));
}

/** Asks every tail still running to stop. */
export function closeTails(tails) {
  for (const tail of tails) if (tail.proc && tail.proc.exitCode === null && !tail.proc.signalCode) tail.proc.kill("SIGINT");
}

/**
 * Whether an event is a request whose path or query holds `needle`. The URL is parsed and only those two parts are
 * looked at: a host, a header or a log line that happened to hold the same characters shows nothing about where a
 * request went.
 */
export function requestHolds(event, needle) {
  const address = event?.event?.request?.url;
  if (typeof address !== "string" || typeof needle !== "string" || !needle) return false;
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  return url.pathname.includes(needle) || url.search.includes(needle);
}

/** The apps whose tail holds no request carrying any of these markers. A marker is a string of the run's own, put in a request's path. */
export const without = (tails, markers) => tails.filter((tail) => !tail.stream.values.some((event) => markers.some((marker) => requestHolds(event, marker)))).map((tail) => tail.app);

/**
 * What a run prints when a tail didn't start, one line a tail. With no account named and wrangler saying it couldn't
 * choose one, it says what to set.
 */
export function refusalLines(down, env = process.env) {
  const lines = down.map(({ app, fault, reason }) => `the log tail for apps/${app} didn't start: ${fault}. wrangler said: ${reason}`);
  if (!env[ACCOUNT_ENV] && down.some(({ reason }) => /more than one account/i.test(reason))) lines.push(`${ACCOUNT_ENV} isn't set, and the wrangler login holds more than one account. Export the ID of the account that holds podster.dev, as scripts/deploy-staging needs it too`);
  else if (env[ACCOUNT_ENV] && !/^[0-9a-f]{32}$/.test(env[ACCOUNT_ENV])) lines.push(`${ACCOUNT_ENV} is set to something that isn't an account ID, so it wasn't passed on`);
  return lines;
}
