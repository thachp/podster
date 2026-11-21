/**
 * Riding out a brief outage (the 2026-11-21 report: `run` printed "gateway answered 0 network" and exited on its first
 * request, though the gateway answered seconds later). A request that failed at the network, timed out, or met the
 * server's own failure or a rate limit is tried again with capped exponential backoff and jitter; anything else is
 * thrown at once, so an authority error, a refusal, a policy problem or a local fault stays fatal.
 *
 * There is no upper bound on tries (RUNNER.md, "Brief network failures", Proposed). A Runner that can't reach Podster
 * starts nothing once its offline grace period passes, so waiting costs nothing, and giving up would leave an
 * unattended Runner stopped until a person restarted it. The owner stops it with Ctrl-C or `stop`.
 *
 * Each try logs one line with IDs, the status, a fixed code and the count: never a body, a URL or a token.
 */
import { GatewayError } from "./errors.js";
import type { Clock, Logger } from "./runtime.js";

/** Longest wait between tries while the gateway can't be reached (Proposed). */
export const LONGEST_BACKOFF_MS = 5 * 60 * 1000;
/**
 * A wait is cut by up to this share of itself, at random, so Runners that lost the gateway together don't return together,
 * but never below the first wait: an outage never makes Runner poll more often than its interval (Proposed).
 */
export const JITTER = 0.5;

/** Status-0 codes that are the network's, not this machine's: a missing key or a refused origin isn't tried again. */
const NETWORK_CODES = new Set(["network", "discovery_failed", "bad_answer"]);

/** Whether a failure is worth trying again: the network, the server's own failure, or a rate limit. */
export function retryable(error: unknown): error is GatewayError {
  if (!(error instanceof GatewayError)) return false;
  if (error.status === 0) return NETWORK_CODES.has(error.code);
  return error.status === 429 || error.status >= 500;
}

/**
 * The wait before try `failures + 1`: `firstMs` doubled for each failure after the first, capped at `LONGEST_BACKOFF_MS`,
 * then cut by up to `JITTER` of itself, and never below `firstMs` (so an interval longer than the cap is kept as it is).
 * `random` answers in [0, 1); 0 gives the whole wait.
 */
export function backoffMs(failures: number, firstMs: number, random: () => number = Math.random): number {
  const full = Math.min(firstMs * 2 ** Math.min(Math.max(failures, 1) - 1, 20), LONGEST_BACKOFF_MS);
  const r = random();
  const share = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0;
  return Math.max(1, firstMs, Math.round(full * (1 - JITTER * share)));
}

export type RetryOptions = {
  /** The log line's place, such as `runner.start`. */
  at: string;
  agent?: string;
  clock: Clock;
  log: Logger;
  /** The local stop: the wait ends at once, and nothing more is tried. */
  signal: AbortSignal;
  /** The first wait, before backoff and jitter. */
  firstMs: number;
  random?: () => number;
};

/** What `retryTransient` answers when the owner stopped it while it waited. */
export const STOPPED: unique symbol = Symbol("stopped");

/**
 * Calls `attempt` until it answers, waiting between tries while it fails in a way worth trying again. Any other failure
 * is thrown as it is. Answers `STOPPED` if the local stop came first.
 */
export async function retryTransient<T>(attempt: () => Promise<T>, options: RetryOptions): Promise<T | typeof STOPPED> {
  let failures = 0;
  for (;;) {
    if (options.signal.aborted) return STOPPED;
    try {
      return await attempt();
    } catch (error) {
      if (!retryable(error)) throw error;
      failures++;
      options.log(options.at, "retry", { agent: options.agent, status: error.status, code: error.code, count: failures });
      const wait = Math.max(backoffMs(failures, options.firstMs, options.random), (error.retryAfter ?? 0) * 1000);
      await options.clock.idle(wait, options.signal);
    }
  }
}
