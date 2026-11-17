import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as budget from "../src/budget";
import { admitWrite, BUDGET_REFUSAL_CODES, BUDGET_REFUSAL_STATUS, type BudgetRefusal, capFromSettings, newWriteCap, retryAfterSeconds, type StoredCount, windowEnd, type WriteCap, windowStart } from "../src/budget";

// The content Worker's copy of `podster_core::write_budget` (ADR 0010's revision, rows 4a and 4b). The Rust module is
// the rule; `src/budget.ts` is a mirror, because the Worker is TypeScript. The first block keeps the two in step by
// reading the Rust source; the second runs every one of core's own cases (`crates/core/tests/write_budget.rs`), by the
// same names, against the mirror; the last reads the two settings the cap comes from.

const RUST = readFileSync(new URL("../../../crates/core/src/write_budget.rs", import.meta.url), "utf8");
const RUST_TESTS = readFileSync(new URL("../../../crates/core/tests/write_budget.rs", import.meta.url), "utf8");

/** The Rust source with every comment line dropped and each line trimmed: what the rule is, not what it says. */
const codeOf = (source: string) =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"))
    .join("\n");
const fingerprint = (source: string) => createHash("sha256").update(codeOf(source)).digest("hex");

/**
 * The fingerprint of `write_budget.rs`'s code, as the mirror was last checked against it. A change to the Rust rule
 * fails here until the mirror is read against it again and this line is updated with it.
 */
const CHECKED_AGAINST = "ac5ff0eb530fd92eeeea226d3c0c569dc095d6ed8cb08c20402a6a1076cd3fbc";

/** Each variant's code, from `code()`'s arms, such as `BudgetRefusal::Spent { .. } => "write_budget_spent",`. */
function rustCodes(source: string): Record<string, string> {
  const codes: Record<string, string> = {};
  for (const line of source.split("\n").map((text) => text.trim())) {
    if (!line.startsWith("BudgetRefusal::") || !line.endsWith('",')) continue;
    const arrow = line.indexOf(' => "');
    if (arrow === -1) continue;
    const variant = line.slice("BudgetRefusal::".length, arrow).replace(" { .. }", "");
    codes[variant] = line.slice(arrow + ' => "'.length, -'",'.length);
  }
  return codes;
}

/** The names of core's own tests of the rule. */
const rustTestNames = () => [...RUST_TESTS.matchAll(/#\[test\]\s*\nfn ([a-z0-9_]+)\(\)/g)].map((match) => match[1]).sort();

describe("the mirror keeps step with crates/core", () => {
  it("was checked against the rule as it is now", () => {
    expect(fingerprint(RUST)).toBe(CHECKED_AGAINST);
  });

  it("would see a change to the rule, and not one to its comments", () => {
    // A control for the check above: one figure changed in the code changes the fingerprint; a comment doesn't.
    const changed = RUST.replace("let too_far_ahead = window_start_ms.saturating_sub(now_ms) > cap.window_ms;", "let too_far_ahead = window_start_ms.saturating_sub(now_ms) >= cap.window_ms;");
    expect(changed).not.toBe(RUST);
    expect(fingerprint(changed)).not.toBe(fingerprint(RUST));
    const commented = RUST.replace("/// The start of the window", "/// The very start of the window");
    expect(commented).not.toBe(RUST);
    expect(fingerprint(commented)).toBe(fingerprint(RUST));
  });

  it("has every refusal code, and no other, and core names no figure the mirror could lack", () => {
    expect(rustCodes(RUST)).toEqual({ Spent: "write_budget_spent", Unknown: "write_budget_unknown" });
    expect([...BUDGET_REFUSAL_CODES].sort()).toEqual(Object.values(rustCodes(RUST)).sort());
    // Each code has the status this Worker answers it with: spent is "too many requests", and unknown is a refusal
    // for now, as an unreadable stop or entry is.
    expect(BUDGET_REFUSAL_STATUS).toEqual({ write_budget_spent: 429, write_budget_unknown: 503 });
    // Core holds no constant: the cap and its window are the caller's. The mirror holds none either.
    expect(RUST.split("\n").filter((line) => /^\s*(pub )?const /.test(line))).toEqual([]);
    const constants = Object.keys(budget).filter((name) => /^[A-Z0-9_]+$/.test(name));
    expect(constants.sort()).toEqual(["BUDGET_REFUSAL_CODES", "BUDGET_REFUSAL_STATUS"]);
  });

  it("runs every one of core's cases, by the same names", () => {
    const names = rustTestNames();
    expect(names.length).toBe(18);
    expect(names).toEqual(Object.keys(CORE_CASES).sort());
  });
});

// i64's ends, as core's cases use them.
const I64_MAX = 2n ** 63n - 1n;
const I64_MIN = -(2n ** 63n);
const U32_MAX = 2 ** 32 - 1;
const HOUR = 60n * 60n * 1000n;

const capOf = (writes: number): WriteCap => {
  const made = newWriteCap(writes, HOUR);
  if (made === null) throw new Error("a valid cap");
  return made;
};
const counted = (windowStartMs: bigint, writes: number): StoredCount => ({ kind: "counted", windowStartMs, writes });
const NOTHING: StoredCount = { kind: "nothing" };
const UNREADABLE: StoredCount = { kind: "unreadable" };
const admitted = (windowStartMs: bigint, writes: number) => ({ ok: true, value: { windowStartMs, writes } });
const refused = (refusal: BudgetRefusal) => ({ ok: false, refusal });
const spent = (retryAfterMs: bigint) => refused({ code: "write_budget_spent", retryAfterMs });
const UNKNOWN = refused({ code: "write_budget_unknown" });
const fresh = (now: bigint) => admitted(windowStart(now, HOUR), 1);

/** Core's cases, each under the name of its Rust test. */
const CORE_CASES: Record<string, () => void> = {
  a_cap_needs_a_window_of_at_least_a_millisecond() {
    expect(newWriteCap(10, 1n)).not.toBeNull();
    expect(newWriteCap(10, 0n)).toBeNull();
    expect(newWriteCap(10, -1n)).toBeNull();
    expect(newWriteCap(10, I64_MIN)).toBeNull();
    expect(newWriteCap(7, 1_000n)).toEqual({ writes: 7, windowMs: 1_000n });
    // What a Rust `u32` and `i64` can't hold is no cap either.
    for (const writes of [-1, 1.5, U32_MAX + 1, Number.NaN, Number.POSITIVE_INFINITY]) expect(newWriteCap(writes, HOUR), String(writes)).toBeNull();
    expect(newWriteCap(U32_MAX, I64_MAX)).toEqual({ writes: U32_MAX, windowMs: I64_MAX });
    expect(newWriteCap(1, I64_MAX + 1n)).toBeNull();
  },
  windows_are_aligned_to_the_epoch_at_each_edge() {
    expect(windowStart(0n, HOUR)).toBe(0n);
    expect(windowStart(HOUR - 1n, HOUR)).toBe(0n);
    expect(windowStart(HOUR, HOUR)).toBe(HOUR);
    expect(windowStart(HOUR + 1n, HOUR)).toBe(HOUR);
    expect(windowStart(-1n, HOUR)).toBe(-HOUR);
    expect(windowEnd(HOUR, HOUR)).toBe(2n * HOUR);
    expect(windowEnd(I64_MAX - 1n, HOUR)).toBe(I64_MAX);
    // No throw at the ends of the clock, and the start saturates as Rust's does.
    expect(windowStart(I64_MIN, HOUR)).toBe(I64_MIN);
    expect(windowStart(I64_MAX, HOUR)).toBe(I64_MAX - (I64_MAX % HOUR));
  },
  the_first_write_opens_the_current_window() {
    expect(admitWrite(capOf(3), NOTHING, 5n * HOUR + 123n)).toEqual(admitted(5n * HOUR, 1));
  },
  the_cap_at_the_boundary() {
    const now = 5n * HOUR + 10n;
    expect(admitWrite(capOf(3), counted(5n * HOUR, 2), now)).toEqual(admitted(5n * HOUR, 3));
    expect(admitWrite(capOf(3), counted(5n * HOUR, 3), now)).toEqual(spent(HOUR - 10n));
    expect(admitWrite(capOf(3), counted(5n * HOUR, 9), now)).toEqual(spent(HOUR - 10n));
  },
  counting_up_from_nothing_admits_exactly_the_cap() {
    const now = 7n * HOUR;
    let stored: StoredCount = NOTHING;
    let taken = 0;
    for (let i = 0; i < 20; i += 1) {
      const answer = admitWrite(capOf(5), stored, now);
      if (answer.ok) {
        taken += 1;
        stored = counted(answer.value.windowStartMs, answer.value.writes);
      } else {
        expect(answer.refusal.code).toBe("write_budget_spent");
      }
    }
    expect(taken).toBe(5);
  },
  the_window_ends_to_the_millisecond() {
    const full = counted(5n * HOUR, 3);
    expect(admitWrite(capOf(3), full, 6n * HOUR - 1n)).toEqual(spent(1n));
    expect(admitWrite(capOf(3), full, 6n * HOUR)).toEqual(admitted(6n * HOUR, 1));
    expect(admitWrite(capOf(3), full, 5n * HOUR)).toEqual(spent(HOUR));
  },
  a_count_from_a_later_window_is_held_to_when_the_clock_goes_back() {
    expect(admitWrite(capOf(3), counted(6n * HOUR, 3), 6n * HOUR - 1n)).toEqual(spent(HOUR + 1n));
    expect(admitWrite(capOf(3), counted(6n * HOUR, 1), 6n * HOUR - 1n)).toEqual(admitted(6n * HOUR, 2));
  },
  an_unreadable_count_refuses_and_records_nothing() {
    for (const cap of [capOf(0), capOf(1), capOf(U32_MAX)]) expect(admitWrite(cap, UNREADABLE, HOUR)).toEqual(UNKNOWN);
  },
  a_count_off_this_caps_windows_that_overlaps_now_is_unknown() {
    for (const start of [5n * HOUR + 1n, 5n * HOUR - 1n, 4n * HOUR + 11n, 6n * HOUR - 1n]) {
      for (const writes of [0, 3, U32_MAX]) expect(admitWrite(capOf(3), counted(start, writes), 5n * HOUR + 10n), `${start} ${writes}`).toEqual(UNKNOWN);
    }
    expect(admitWrite(capOf(3), counted(HOUR / 2n, 0), HOUR)).toEqual(UNKNOWN);
  },
  a_count_off_this_caps_windows_older_than_the_current_window_is_stale() {
    const now = 5n * HOUR + 10n;
    for (const start of [1n, -1n, HOUR / 2n, 3n * HOUR + 7n, 4n * HOUR + 10n]) expect(admitWrite(capOf(3), counted(start, U32_MAX), now), String(start)).toEqual(fresh(now));
  },
  a_count_off_this_caps_windows_is_unknown_only_until_its_window_would_have_ended() {
    const off = counted(5n * HOUR + 1n, 3);
    expect(admitWrite(capOf(3), off, 6n * HOUR)).toEqual(UNKNOWN);
    expect(admitWrite(capOf(3), off, 6n * HOUR + 1n)).toEqual(fresh(6n * HOUR + 1n));
    expect(admitWrite(capOf(3), off, 6n * HOUR + 2n)).toEqual(fresh(6n * HOUR + 2n));
  },
  a_count_on_this_caps_windows_more_than_a_window_ahead_is_stale() {
    const ahead = counted(6n * HOUR, 3);
    expect(admitWrite(capOf(3), ahead, 5n * HOUR)).toEqual(spent(2n * HOUR));
    expect(admitWrite(capOf(3), ahead, 5n * HOUR + 1n)).toEqual(spent(2n * HOUR - 1n));
    expect(admitWrite(capOf(3), ahead, 5n * HOUR - 1n)).toEqual(fresh(5n * HOUR - 1n));
    for (const start of [10n * HOUR, 1_000n * HOUR, windowStart(I64_MAX, HOUR)]) expect(admitWrite(capOf(3), counted(start, 3), 5n * HOUR), String(start)).toEqual(fresh(5n * HOUR));
  },
  a_count_off_this_caps_windows_more_than_a_window_ahead_is_stale() {
    const ahead = counted(6n * HOUR + 1n, 3);
    expect(admitWrite(capOf(3), ahead, 5n * HOUR + 1n)).toEqual(UNKNOWN);
    expect(admitWrite(capOf(3), ahead, 5n * HOUR + 2n)).toEqual(UNKNOWN);
    expect(admitWrite(capOf(3), ahead, 5n * HOUR)).toEqual(fresh(5n * HOUR));
    expect(admitWrite(capOf(3), counted(I64_MAX, 3), 5n * HOUR)).toEqual(fresh(5n * HOUR));
  },
  no_stored_count_refuses_for_longer_than_two_windows() {
    const now = 5n * HOUR + 10n;
    for (let offset = -3n * HOUR; offset <= 3n * HOUR; offset += 997n) {
      const stored = counted(now + offset, 3);
      if (!admitWrite(capOf(3), stored, now).ok) expect(admitWrite(capOf(3), stored, now + 2n * HOUR), String(offset)).toEqual(fresh(now + 2n * HOUR));
    }
  },
  a_cap_of_zero_refuses_every_write() {
    expect(admitWrite(capOf(0), NOTHING, HOUR + 5n)).toEqual(spent(HOUR - 5n));
  },
  the_largest_cap_does_not_overflow() {
    expect(admitWrite(capOf(U32_MAX), counted(0n, U32_MAX - 1), 1n)).toEqual(admitted(0n, U32_MAX));
    expect(admitWrite(capOf(U32_MAX), counted(0n, U32_MAX), 1n).ok).toBe(false);
  },
  retry_after_rounds_up_to_whole_seconds() {
    expect([1n, 999n, 1_000n, 1_001n, 0n, -5n, HOUR].map(retryAfterSeconds)).toEqual([1n, 1n, 1n, 2n, 1n, 1n, 3_600n]);
  },
  refusals_have_codes() {
    expect(BUDGET_REFUSAL_CODES).toEqual(["write_budget_spent", "write_budget_unknown"]);
  },
};

describe("core's cases, against the mirror", () => {
  for (const [name, run] of Object.entries(CORE_CASES)) it(name, run);
});

describe("the cap, from two settings with no default", () => {
  it("reads the owner's figures, 300 writes per 600,000 ms, as decimal strings", () => {
    expect(capFromSettings("300", "600000")).toEqual({ writes: 300, windowMs: 600_000n });
    // A cap of zero is a cap, and refuses every write.
    const zero = capFromSettings("0", "600000");
    expect(zero).toEqual({ writes: 0, windowMs: 600_000n });
    if (zero === null) throw new Error("a cap");
    expect(admitWrite(zero, NOTHING, 1n).ok).toBe(false);
    // The ends a Rust `u32` and `i64` hold.
    expect(capFromSettings(String(U32_MAX), String(I64_MAX))).toEqual({ writes: U32_MAX, windowMs: I64_MAX });
  });

  it("is no cap, so every write is refused, when either setting is missing or malformed", () => {
    const missing = [undefined, null, "", 300, 600000, true, {}, ["300"]];
    for (const value of missing) {
      expect(capFromSettings(value, "600000"), `writes ${JSON.stringify(value)}`).toBeNull();
      expect(capFromSettings("300", value), `window ${JSON.stringify(value)}`).toBeNull();
    }
    const malformed = [" 300", "300 ", "+300", "-1", "3e2", "0x12C", "300.0", "0300", "00", "١٠", "300\n", "3_00"];
    for (const value of malformed) {
      expect(capFromSettings(value, "600000"), `writes ${JSON.stringify(value)}`).toBeNull();
      expect(capFromSettings("300", value), `window ${JSON.stringify(value)}`).toBeNull();
    }
    // Past what core's types hold, and a window under a millisecond.
    expect(capFromSettings(String(U32_MAX + 1), "600000")).toBeNull();
    expect(capFromSettings("300", String(I64_MAX + 1n))).toBeNull();
    expect(capFromSettings("300", "0")).toBeNull();
    expect(capFromSettings("99999999999999999999999", "600000")).toBeNull();
  });

  it("names no figure of its own anywhere in the Worker's source: the owner's cap lives only in the settings", () => {
    for (const name of ["budget.ts", "counter.ts", "handle.ts", "index.ts"]) {
      const text = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
      expect(text, name).not.toMatch(/600[_,]?000|10 \* 60/);
      // The handler compares statuses with 300, which is no cap; the rest name no 300 at all.
      if (name !== "handle.ts") expect(text, name).not.toMatch(/\b300\b/);
    }
    // And neither the rule nor the counter falls back to anything when a setting is missing.
    for (const name of ["budget.ts", "counter.ts"]) expect(readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"), name).not.toMatch(/\?\?|\|\| ?["'0-9]/);
  });
});
