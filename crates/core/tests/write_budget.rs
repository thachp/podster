#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! One app's write budget (ADR 0010's revision, rows 4a and 4b): fixed windows aligned to the epoch, the cap as a
//! parameter with no default, a count that can't be read refusing, and every edge to the millisecond, both ways.

use podster_core::write_budget::*;

const HOUR: i64 = 60 * 60 * 1000;

fn cap(writes: u32) -> WriteCap {
    WriteCap::new(writes, HOUR).expect("a valid cap")
}

#[test]
fn a_cap_needs_a_window_of_at_least_a_millisecond() {
    assert!(WriteCap::new(10, 1).is_some());
    assert!(WriteCap::new(10, 0).is_none());
    assert!(WriteCap::new(10, -1).is_none());
    assert!(WriteCap::new(10, i64::MIN).is_none());
    let c = WriteCap::new(7, 1_000).unwrap();
    assert_eq!((c.writes(), c.window_ms()), (7, 1_000));
}

#[test]
fn windows_are_aligned_to_the_epoch_at_each_edge() {
    assert_eq!(window_start(0, HOUR), 0);
    assert_eq!(window_start(HOUR - 1, HOUR), 0);
    assert_eq!(window_start(HOUR, HOUR), HOUR);
    assert_eq!(window_start(HOUR + 1, HOUR), HOUR);
    assert_eq!(window_start(-1, HOUR), -HOUR);
    assert_eq!(window_end(HOUR, HOUR), 2 * HOUR);
    assert_eq!(window_end(i64::MAX - 1, HOUR), i64::MAX);
    // No panic at the ends of the clock.
    let _ = window_start(i64::MIN, HOUR);
    let _ = window_start(i64::MAX, HOUR);
}

#[test]
fn the_first_write_opens_the_current_window() {
    let now = 5 * HOUR + 123;
    assert_eq!(
        admit_write(cap(3), StoredCount::Nothing, now),
        Ok(Admitted {
            window_start_ms: 5 * HOUR,
            writes: 1
        })
    );
}

#[test]
fn the_cap_at_the_boundary() {
    let now = 5 * HOUR + 10;
    let at = |writes| StoredCount::Counted {
        window_start_ms: 5 * HOUR,
        writes,
    };
    assert_eq!(
        admit_write(cap(3), at(2), now),
        Ok(Admitted {
            window_start_ms: 5 * HOUR,
            writes: 3
        })
    );
    assert_eq!(
        admit_write(cap(3), at(3), now),
        Err(BudgetRefusal::Spent {
            retry_after_ms: HOUR - 10
        })
    );
    // Past the cap, as when the owner lowers the figure inside a window: refused the same way.
    assert_eq!(
        admit_write(cap(3), at(9), now),
        Err(BudgetRefusal::Spent {
            retry_after_ms: HOUR - 10
        })
    );
}

#[test]
fn counting_up_from_nothing_admits_exactly_the_cap() {
    let c = cap(5);
    let now = 7 * HOUR;
    let mut stored = StoredCount::Nothing;
    let mut admitted = 0;
    for _ in 0..20 {
        match admit_write(c, stored, now) {
            Ok(a) => {
                admitted += 1;
                stored = StoredCount::Counted {
                    window_start_ms: a.window_start_ms,
                    writes: a.writes,
                };
            }
            Err(BudgetRefusal::Spent { .. }) => {}
            Err(other) => panic!("{other:?}"),
        }
    }
    assert_eq!(admitted, 5);
}

#[test]
fn the_window_ends_to_the_millisecond() {
    let spent = StoredCount::Counted {
        window_start_ms: 5 * HOUR,
        writes: 3,
    };
    assert_eq!(
        admit_write(cap(3), spent, 6 * HOUR - 1),
        Err(BudgetRefusal::Spent { retry_after_ms: 1 })
    );
    assert_eq!(
        admit_write(cap(3), spent, 6 * HOUR),
        Ok(Admitted {
            window_start_ms: 6 * HOUR,
            writes: 1
        })
    );
    // The window's first millisecond is in it.
    assert_eq!(
        admit_write(cap(3), spent, 5 * HOUR),
        Err(BudgetRefusal::Spent {
            retry_after_ms: HOUR
        })
    );
}

#[test]
fn a_count_from_a_later_window_is_held_to_when_the_clock_goes_back() {
    let later = StoredCount::Counted {
        window_start_ms: 6 * HOUR,
        writes: 3,
    };
    assert_eq!(
        admit_write(cap(3), later, 6 * HOUR - 1),
        Err(BudgetRefusal::Spent {
            retry_after_ms: HOUR + 1
        })
    );
    let room = StoredCount::Counted {
        window_start_ms: 6 * HOUR,
        writes: 1,
    };
    assert_eq!(
        admit_write(cap(3), room, 6 * HOUR - 1),
        Ok(Admitted {
            window_start_ms: 6 * HOUR,
            writes: 2
        })
    );
}

#[test]
fn an_unreadable_count_refuses_and_records_nothing() {
    for c in [cap(0), cap(1), cap(u32::MAX)] {
        assert_eq!(
            admit_write(c, StoredCount::Unreadable, HOUR),
            Err(BudgetRefusal::Unknown)
        );
    }
}

#[test]
fn a_count_not_on_this_caps_windows_is_unknown() {
    for start in [5 * HOUR + 1, 5 * HOUR - 1, 1, -1] {
        assert_eq!(
            admit_write(
                cap(3),
                StoredCount::Counted {
                    window_start_ms: start,
                    writes: 0
                },
                5 * HOUR + 10
            ),
            Err(BudgetRefusal::Unknown),
            "{start}"
        );
    }
    // A count kept under a shorter window, read under a longer one, is unknown too.
    let half = StoredCount::Counted {
        window_start_ms: HOUR / 2,
        writes: 0,
    };
    assert_eq!(admit_write(cap(3), half, HOUR), Err(BudgetRefusal::Unknown));
}

#[test]
fn a_cap_of_zero_refuses_every_write() {
    assert_eq!(
        admit_write(cap(0), StoredCount::Nothing, HOUR + 5),
        Err(BudgetRefusal::Spent {
            retry_after_ms: HOUR - 5
        })
    );
}

#[test]
fn the_largest_cap_does_not_overflow() {
    let full = StoredCount::Counted {
        window_start_ms: 0,
        writes: u32::MAX - 1,
    };
    assert_eq!(
        admit_write(cap(u32::MAX), full, 1),
        Ok(Admitted {
            window_start_ms: 0,
            writes: u32::MAX
        })
    );
    let spent = StoredCount::Counted {
        window_start_ms: 0,
        writes: u32::MAX,
    };
    assert!(admit_write(cap(u32::MAX), spent, 1).is_err());
}

#[test]
fn retry_after_rounds_up_to_whole_seconds() {
    assert_eq!(retry_after_seconds(1), 1);
    assert_eq!(retry_after_seconds(999), 1);
    assert_eq!(retry_after_seconds(1_000), 1);
    assert_eq!(retry_after_seconds(1_001), 2);
    assert_eq!(retry_after_seconds(0), 1);
    assert_eq!(retry_after_seconds(-5), 1);
    assert_eq!(retry_after_seconds(HOUR), 3_600);
}

#[test]
fn refusals_have_codes() {
    assert_eq!(
        BudgetRefusal::Spent { retry_after_ms: 1 }.code(),
        "write_budget_spent"
    );
    assert_eq!(BudgetRefusal::Unknown.code(), "write_budget_unknown");
}
