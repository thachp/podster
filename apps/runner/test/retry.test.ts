// Riding out a brief outage (the 2026-11-21 report): which failures are tried again, the capped, jittered backoff, and
// fatal failures thrown at once.
import { describe, expect, it } from "vitest";
import { AuthorityEnded } from "../src/core/poller.js";
import { GatewayError } from "../src/core/errors.js";
import { backoffMs, LONGEST_BACKOFF_MS, retryable, retryTransient, STOPPED } from "../src/core/retry.js";
import { TestClock } from "./fake-gateway.js";

const options = (clock: TestClock, lines: string[], signal = new AbortController().signal) => ({
  at: "runner.start",
  agent: "agt_one",
  clock,
  log: (at: string, outcome: string, fields?: object) => void lines.push(JSON.stringify({ at, outcome, ...fields })),
  signal,
  firstMs: 10_000,
  random: () => 0,
});

describe("which failures are tried again", () => {
  it("tries the network, the server's own failures and rate limits again, and nothing else", () => {
    for (const error of [new GatewayError(0, "network"), new GatewayError(0, "discovery_failed"), new GatewayError(0, "bad_answer"), new GatewayError(503, "unknown"), new GatewayError(500, "internal"), new GatewayError(429, "rate_limited")]) expect([error.message, retryable(error)]).toEqual([error.message, true]);
    for (const error of [new GatewayError(401, "invalid_jwt"), new GatewayError(403, "agent_revoked"), new GatewayError(403, "not_allowed"), new GatewayError(404, "not_found"), new GatewayError(0, "no_local_key"), new GatewayError(0, "wrong_origin"), new AuthorityEnded(), new Error("Runner's run policy can't be used"), new TypeError("fetch failed")]) expect([error.message, retryable(error)]).toEqual([error.message, false]);
  });
});

describe("the backoff", () => {
  it("doubles from the first wait up to its cap, and jitter only shortens it, by at most half and never below the first wait", () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, 10_000, () => 0))).toEqual([10_000, 20_000, 40_000, 80_000]);
    expect(backoffMs(30, 10_000, () => 0)).toBe(LONGEST_BACKOFF_MS);
    expect(backoffMs(1_000, 10_000, () => 0)).toBe(LONGEST_BACKOFF_MS);
    // The first wait is never cut: an outage never polls faster than the interval.
    expect(backoffMs(1, 10_000, () => 0.999)).toBe(10_000);
    expect(backoffMs(2, 10_000, () => 0.999)).toBe(10_010);
    expect(backoffMs(3, 10_000, () => 0.5)).toBe(30_000);
    expect(backoffMs(30, 10_000, () => 0.999)).toBe(150_150);
    // An interval longer than the cap is kept.
    expect(backoffMs(5, 30 * 60_000, () => 0.5)).toBe(30 * 60_000);
    // A fixed spread of random answers, edges included: every wait lies between half the full wait (or the first) and the full wait.
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999_999]) {
      for (const n of [1, 2, 3, 6, 12]) {
        const full = Math.min(10_000 * 2 ** (n - 1), LONGEST_BACKOFF_MS);
        const wait = backoffMs(n, 10_000, () => r);
        expect([n, r, wait >= Math.max(10_000, full / 2) && wait <= full]).toEqual([n, r, true]);
      }
    }
    // A random source that answers out of range can't make the wait longer, shorter than the first, or negative.
    expect(backoffMs(2, 10_000, () => 7)).toBe(10_000);
    expect(backoffMs(2, 10_000, () => -3)).toBe(20_000);
    expect(backoffMs(2, 10_000, () => Number.NaN)).toBe(20_000);
  });
});

describe("trying again", () => {
  it("answers once fetch stops throwing, after one ID-only line and one wait per failure", async () => {
    const clock = new TestClock();
    const lines: string[] = [];
    let calls = 0;
    const answer = await retryTransient(async () => {
      calls++;
      if (calls <= 3) throw new GatewayError(0, "network");
      return "ok";
    }, options(clock, lines));
    expect(answer).toBe("ok");
    expect(calls).toBe(4);
    expect(clock.idles).toEqual([10_000, 20_000, 40_000]);
    expect(lines).toEqual([1, 2, 3].map((count) => JSON.stringify({ at: "runner.start", outcome: "retry", agent: "agt_one", status: 0, code: "network", count })));
  });

  it("waits at least as long as a Retry-After asks", async () => {
    const clock = new TestClock();
    let calls = 0;
    await retryTransient(async () => {
      if (calls++ === 0) throw new GatewayError(429, "rate_limited", 60);
      return null;
    }, options(clock, []));
    expect(clock.idles).toEqual([60_000]);
  });

  it("throws a fatal failure at once, without a wait or a retry line", async () => {
    for (const fatal of [new AuthorityEnded(), new GatewayError(403, "not_allowed"), new Error("Runner's run policy can't be used")]) {
      const clock = new TestClock();
      const lines: string[] = [];
      let calls = 0;
      await expect(
        retryTransient(async () => {
          calls++;
          throw fatal;
        }, options(clock, lines)),
      ).rejects.toBe(fatal);
      expect([calls, clock.idles, lines]).toEqual([1, [], []]);
    }
  });

  it("stops trying once the owner stops Runner", async () => {
    const clock = new TestClock();
    const stop = new AbortController();
    clock.onIdle = () => stop.abort();
    let calls = 0;
    const answer = await retryTransient(async () => {
      calls++;
      throw new GatewayError(0, "network");
    }, options(clock, [], stop.signal));
    expect(answer).toBe(STOPPED);
    expect(calls).toBe(1);
  });
});
