// One app's write budget (ADR 0010's proposed revision, stage 1, rows 4a and 4b; decision 220), for the write counter.
//
// **A mirror of `crates/core/src/write_budget.rs`, which is the rule.** The content Worker is TypeScript and can't
// call the Rust core, so the rule is written again here, line for line, and pure. Rust's `i64` milliseconds are
// `bigint` here, saturating at `i64`'s ends as Rust's `saturating_*` do, and a `u32` count is a whole `number`. The
// package's test of it reads the Rust source and fails if the rule's code or its refusal codes change until this copy
// is read against them again, and it runs every one of core's own cases against this copy.
//
// **The cap's figure and its window's length are the owner's and aren't named here** (ruling 9 on the stage-1
// questions). Both come from two settings, read by `capFromSettings`; there is no constant, no default and no
// fallback, so a missing or malformed setting is no cap, and the counter refuses every write.

import type { Checked } from "./requests";

const I64_MAX = 2n ** 63n - 1n;
const I64_MIN = -(2n ** 63n);
const U32_MAX = 2 ** 32 - 1;

const saturate = (value: bigint) => (value > I64_MAX ? I64_MAX : value < I64_MIN ? I64_MIN : value);
/** Rust's `rem_euclid` for a positive divisor. */
const remEuclid = (value: bigint, by: bigint) => ((value % by) + by) % by;

/** One app's cap: at most `writes` writes in each window of `windowMs` milliseconds. Made only by `newWriteCap`. */
export interface WriteCap {
  readonly writes: number;
  readonly windowMs: bigint;
}

/** `WriteCap::new`: null unless the window is at least a millisecond. A cap of zero writes is allowed, and refuses every write. */
export function newWriteCap(writes: number, windowMs: bigint): WriteCap | null {
  if (!Number.isInteger(writes) || writes < 0 || writes > U32_MAX) return null;
  if (windowMs <= 0n || windowMs > I64_MAX) return null;
  return { writes, windowMs };
}

/** The start of the window `nowMs` falls in: windows are aligned to the epoch, so every counter agrees on them. */
export function windowStart(nowMs: bigint, windowMs: bigint): bigint {
  return saturate(nowMs - remEuclid(nowMs, windowMs));
}

/** The first millisecond after the window that starts at `startMs`. */
export function windowEnd(startMs: bigint, windowMs: bigint): bigint {
  return saturate(startMs + windowMs);
}

/** What the counter holds for an app, as it was read. */
export type StoredCount = { kind: "nothing" } | { kind: "counted"; windowStartMs: bigint; writes: number } | { kind: "unreadable" };

/** Why a write is refused, by its code, as `BudgetRefusal::code` has them. */
export type BudgetRefusal = { code: "write_budget_spent"; retryAfterMs: bigint } | { code: "write_budget_unknown" };

/** Every refusal's code. */
export const BUDGET_REFUSAL_CODES = ["write_budget_spent", "write_budget_unknown"] as const;

/**
 * The status the content Worker answers each refusal with (not core's; core gives none). Spent is `429`, "too many
 * requests", with a `Retry-After`. Unknown is `503`, as the plan has it: the budget couldn't be read, so the write is
 * refused for now, and the next one asks again.
 */
export const BUDGET_REFUSAL_STATUS: Readonly<Record<BudgetRefusal["code"], number>> = {
  write_budget_spent: 429,
  write_budget_unknown: 503,
};

/** A write admitted, and the count to record for it, in the same step as admitting it. */
export interface Admitted {
  windowStartMs: bigint;
  writes: number;
}

/**
 * `admit_write`: whether one more write may pass at `nowMs`, given what the counter holds. A stored count is stale,
 * and stands for a fresh window with no writes, when its window (taken at this cap's length) has ended, or when it is
 * stamped more than one window ahead. Otherwise a count on this cap's windows is held to, and one off them is unknown
 * until its window would have ended. See the Rust source for the whole reasoning.
 */
export function admitWrite(cap: WriteCap, stored: StoredCount, nowMs: bigint): Checked<Admitted, BudgetRefusal> {
  const current = windowStart(nowMs, cap.windowMs);
  let start: bigint;
  let writes: number;
  if (stored.kind === "unreadable") return { ok: false, refusal: { code: "write_budget_unknown" } };
  if (stored.kind === "nothing") {
    [start, writes] = [current, 0];
  } else {
    const ended = windowEnd(stored.windowStartMs, cap.windowMs) <= nowMs;
    const tooFarAhead = saturate(stored.windowStartMs - nowMs) > cap.windowMs;
    if (ended || tooFarAhead) {
      [start, writes] = [current, 0];
    } else if (remEuclid(stored.windowStartMs, cap.windowMs) !== 0n) {
      return { ok: false, refusal: { code: "write_budget_unknown" } };
    } else {
      [start, writes] = [stored.windowStartMs, stored.writes];
    }
  }
  if (writes >= cap.writes) return { ok: false, refusal: { code: "write_budget_spent", retryAfterMs: saturate(windowEnd(start, cap.windowMs) - nowMs) } };
  return { ok: true, value: { windowStartMs: start, writes: writes + 1 } };
}

/** `retry_after_seconds`: a wait in milliseconds as a `Retry-After` in whole seconds, rounded up and at least one. */
export function retryAfterSeconds(waitMs: bigint): bigint {
  const wait = waitMs > 0n ? waitMs : 0n;
  const seconds = wait / 1000n + (wait % 1000n !== 0n ? 1n : 0n);
  return seconds > 1n ? seconds : 1n;
}

/** A whole number written as a setting is: decimal digits only, with no sign, space or leading zero. */
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;

/**
 * The cap, from its two settings: the number of writes, and the window's length in milliseconds, each a decimal
 * string. Null, so every write is refused, if either is missing, isn't a string, isn't written exactly so, or is out
 * of what core's `u32` and `i64` hold, or if the window is under a millisecond.
 */
export function capFromSettings(writes: unknown, windowMs: unknown): WriteCap | null {
  if (typeof writes !== "string" || typeof windowMs !== "string") return null;
  if (!DECIMAL.test(writes) || !DECIMAL.test(windowMs)) return null;
  const count = BigInt(writes);
  if (count > BigInt(U32_MAX)) return null;
  return newWriteCap(Number(count), BigInt(windowMs));
}
