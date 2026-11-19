#![allow(clippy::unwrap_used, clippy::indexing_slicing)]
//! The read of a repository's rules while an agent holds a token for it: when one is due.
use podster_core::provisioning::{
    held_token_read_due_at, HELD_TOKEN_READS_PER_HOUR, HELD_TOKEN_READ_MS,
};
use podster_core::repo_access::READ_BACK_REUSE_MS;

const HOUR: i64 = 60 * 60 * 1000;
const NOW: i64 = 10 * HOUR;

#[test]
fn no_token_held_means_no_read() {
    assert_eq!(held_token_read_due_at(None, NOW - HOUR, &[], NOW), None);
    assert_eq!(held_token_read_due_at(None, 0, &[NOW - 1], NOW), None);
}

#[test]
fn due_an_interval_after_the_mint_that_read_the_rules() {
    // A token minted a moment ago: its mint read the rules back, or reused a read up to a minute older, so the next
    // read is an interval on from the oldest that read could be.
    let mint = NOW - 5_000;
    assert_eq!(
        held_token_read_due_at(Some(mint), NOW - HOUR, &[], NOW),
        Some(mint - READ_BACK_REUSE_MS + HELD_TOKEN_READ_MS)
    );
}

#[test]
fn due_an_interval_after_the_rules_were_last_found_right() {
    let mint = NOW - 30 * 60_000;
    let right = NOW - 2 * 60_000;
    assert_eq!(
        held_token_read_due_at(Some(mint), right, &[], NOW),
        Some(right + HELD_TOKEN_READ_MS)
    );
}

#[test]
fn an_attempt_that_found_nothing_waits_an_interval_too() {
    // A read that couldn't be made moves nothing it found, but the next waits an interval after it.
    let mint = NOW - 50 * 60_000;
    let attempt = NOW - 3 * 60_000;
    assert_eq!(
        held_token_read_due_at(Some(mint), mint, &[attempt], NOW),
        Some(attempt + HELD_TOKEN_READ_MS)
    );
    // Attempts out of order: the latest counts.
    assert_eq!(
        held_token_read_due_at(Some(mint), mint, &[attempt, attempt - 20 * 60_000], NOW),
        Some(attempt + HELD_TOKEN_READ_MS)
    );
}

#[test]
fn long_held_and_never_read_is_due_now_or_in_the_past() {
    let mint = NOW - 45 * 60_000;
    let due = held_token_read_due_at(Some(mint), mint, &[], NOW).unwrap();
    assert!(due <= NOW);
}

#[test]
fn the_hourly_cap_holds() {
    // Six attempts in the hour, the last over an interval ago: the interval allows one, the cap doesn't, until the
    // oldest is an hour old.
    let mint = NOW - 2 * HOUR;
    let attempts: Vec<i64> = (0..6).map(|n| NOW - 59 * 60_000 + n * 60_000).collect();
    let due = held_token_read_due_at(Some(mint), mint, &attempts, NOW).unwrap();
    assert_eq!(due, attempts[0] + HOUR);
    assert!(due > NOW);
    // Five in the hour: the interval decides.
    assert_eq!(
        held_token_read_due_at(Some(mint), mint, &attempts[1..], NOW),
        Some(attempts[5] + HELD_TOKEN_READ_MS)
    );
    // Attempts older than the hour don't count against the cap: ten of them, and the read is due by the interval.
    let old: Vec<i64> = (0..10).map(|n| NOW - 2 * HOUR + n * 60_000).collect();
    assert_eq!(
        held_token_read_due_at(Some(mint), mint, &old, NOW),
        Some(mint + HELD_TOKEN_READ_MS)
    );
}

#[test]
fn the_interval_alone_never_exceeds_the_cap() {
    // Reads taken as soon as each is due never meet the cap in any hour.
    assert!(HOUR / HELD_TOKEN_READ_MS <= HELD_TOKEN_READS_PER_HOUR as i64);
    let mint = 0;
    let mut attempts = Vec::new();
    let mut now = 0;
    while now < 5 * HOUR {
        let due = held_token_read_due_at(Some(mint), mint, &attempts, now).unwrap();
        now = due.max(now);
        let in_hour = attempts.iter().filter(|at| **at > now - HOUR).count();
        assert!(in_hour < HELD_TOKEN_READS_PER_HOUR);
        attempts.push(now);
    }
}

#[test]
fn saturates_rather_than_overflowing() {
    assert_eq!(
        held_token_read_due_at(Some(i64::MAX), i64::MAX, &[], NOW),
        Some(i64::MAX)
    );
    assert_eq!(
        held_token_read_due_at(Some(i64::MIN), i64::MIN, &[], NOW),
        Some(i64::MIN + HELD_TOKEN_READ_MS)
    );
}
