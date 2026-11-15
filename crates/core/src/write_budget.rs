//! The arithmetic of one app's write budget (ADR 0010's proposed revision, stage 1, rows 4a and 4b, decided by the
//! owner on 2026-11-13 as decision 220). Pure, with no I/O, and not wired anywhere yet.
//!
//! Each app has a budget of write requests in fixed windows, counted for that app alone (the architect's ruling of
//! 2026-11-13 on the plan's question 1: one counter for each app, in fixed windows). A write past the budget is refused
//! by the content Worker until the window ends; reads go on. Only a request [`crate::app_requests::check_request`]
//! classed as a write is counted.
//!
//! **The cap's figure is the owner's and isn't named.** So is the window's length, which nothing names either. Both
//! are given to [`WriteCap::new`] by the caller; this module holds no figure for either and has no default, so nothing
//! here can ship a cap by accident.
//!
//! A count that couldn't be read refuses the write and records nothing (review standard 3): an unread budget is never
//! taken for an unspent one.

/// One app's cap: at most `writes` write requests in each window of `window_ms` milliseconds. Made only by
/// [`WriteCap::new`], from figures the caller holds. It has no default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WriteCap {
    writes: u32,
    window_ms: i64,
}

impl WriteCap {
    /// `None` unless the window is at least a millisecond. A cap of zero writes is allowed, and refuses every write.
    pub fn new(writes: u32, window_ms: i64) -> Option<WriteCap> {
        (window_ms > 0).then_some(WriteCap { writes, window_ms })
    }

    pub fn writes(self) -> u32 {
        self.writes
    }

    pub fn window_ms(self) -> i64 {
        self.window_ms
    }
}

/// The start of the window `now_ms` falls in: windows are aligned to the epoch, so every counter agrees on them.
pub fn window_start(now_ms: i64, window_ms: i64) -> i64 {
    now_ms.saturating_sub(now_ms.rem_euclid(window_ms))
}

/// The first millisecond after the window that starts at `start_ms`.
pub fn window_end(start_ms: i64, window_ms: i64) -> i64 {
    start_ms.saturating_add(window_ms)
}

/// What the counter holds for an app, as it was read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoredCount {
    /// Read, and nothing is held: no write was counted yet.
    Nothing,
    /// Read: `writes` were counted in the window that starts at `window_start_ms`.
    Counted { window_start_ms: i64, writes: u32 },
    /// Couldn't be read.
    Unreadable,
}

/// Why a write is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BudgetRefusal {
    /// `write_budget_spent`: the window's writes are used. `retry_after_ms` is how long until the window ends.
    Spent { retry_after_ms: i64 },
    /// `write_budget_unknown`: the count couldn't be read, or what was read isn't a count this rule wrote. Nothing is
    /// recorded, and the next write asks again.
    Unknown,
}

impl BudgetRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            BudgetRefusal::Spent { .. } => "write_budget_spent",
            BudgetRefusal::Unknown => "write_budget_unknown",
        }
    }
}

/// A write admitted, and the count to record for it, in the same step as admitting it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Admitted {
    pub window_start_ms: i64,
    pub writes: u32,
}

/// Whether one more write may pass at `now_ms`, given what the counter holds.
///
/// - A count from an earlier window is spent: the write opens a new window.
/// - A count from this window, or from a later one (the clock went back), is held to: the write is admitted only if
///   it is under the cap, and a refusal waits for that window's end.
/// - A count whose window isn't aligned to the cap's windows wasn't written by this rule under this cap, so it is
///   unknown and refuses, as an unreadable one does.
pub fn admit_write(
    cap: WriteCap,
    stored: StoredCount,
    now_ms: i64,
) -> Result<Admitted, BudgetRefusal> {
    let current = window_start(now_ms, cap.window_ms);
    let (start, writes) = match stored {
        StoredCount::Unreadable => return Err(BudgetRefusal::Unknown),
        StoredCount::Nothing => (current, 0),
        StoredCount::Counted {
            window_start_ms,
            writes,
        } => {
            if window_start_ms.rem_euclid(cap.window_ms) != 0 {
                return Err(BudgetRefusal::Unknown);
            }
            if window_start_ms < current {
                (current, 0)
            } else {
                (window_start_ms, writes)
            }
        }
    };
    if writes >= cap.writes {
        return Err(BudgetRefusal::Spent {
            retry_after_ms: window_end(start, cap.window_ms).saturating_sub(now_ms),
        });
    }
    Ok(Admitted {
        window_start_ms: start,
        writes: writes + 1,
    })
}

/// A wait in milliseconds as a `Retry-After` in whole seconds, rounded up and at least one.
pub fn retry_after_seconds(wait_ms: i64) -> i64 {
    let seconds = wait_ms.max(0) / 1000 + i64::from(wait_ms.max(0) % 1000 != 0);
    seconds.max(1)
}
