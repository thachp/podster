//! A provider call whose answer was lost (M6 step 5): which calls leave a release `uncertain`, what the script's write
//! answered, what a read settles, and every bound, to the millisecond.

use podster_core::release::{ScriptAnswer, IN_FLIGHT_EXEMPTION_MS};
use podster_core::release_driver::{waits_uncounted, DriveStep, MAX_DRIVE_ATTEMPTS};
use podster_core::release_uncertain::*;

const SINCE: i64 = 1_900_000_000_000;

// --- which calls -----------------------------------------------------------------------------------------------------

#[test]
fn only_the_scripts_write_leaves_a_release_uncertain_and_every_other_call_is_retried() {
    use ProviderCall as C;
    for (call, expected) in [
        (C::UploadSession, LostAnswer::Retried),
        (C::UploadBucket, LostAnswer::Retried),
        (C::ScriptWrite, LostAnswer::Uncertain),
        (C::ScriptRead, LostAnswer::Retried),
        (C::ScriptDelete, LostAnswer::Retried),
        (C::EntryWrite, LostAnswer::Retried),
        (C::EntryDelete, LostAnswer::Retried),
        (C::EntryRead, LostAnswer::Retried),
    ] {
        assert_eq!(on_lost_answer(call), expected, "{call:?}");
    }
}

// --- the script's write ----------------------------------------------------------------------------------------------

#[test]
fn the_write_is_written_only_on_its_own_answer_refused_only_on_a_4xx_and_unknown_otherwise() {
    assert_eq!(
        script_write_outcome(ScriptWriteAnswer::NotSent),
        WriteOutcome::NotWritten
    );
    assert_eq!(
        script_write_outcome(ScriptWriteAnswer::NoAnswer),
        WriteOutcome::Unknown
    );
    for status in 100..=599_u16 {
        for success in [false, true] {
            for names_script in [false, true] {
                let expected = if status == 200 && success && names_script {
                    WriteOutcome::Written
                } else if (400..=499).contains(&status) {
                    WriteOutcome::NotWritten
                } else {
                    WriteOutcome::Unknown
                };
                assert_eq!(
                    script_write_outcome(ScriptWriteAnswer::Answered {
                        status,
                        success,
                        names_script
                    }),
                    expected,
                    "{status} {success} {names_script}"
                );
            }
        }
    }
}

// --- what a read settles ---------------------------------------------------------------------------------------------

#[test]
fn only_a_reads_200_settles_a_script_object_as_written_and_null_as_absent() {
    assert_eq!(settle_read(None), SettleRead::Unknown);
    for status in 100..=599_u16 {
        for script_null in [false, true] {
            let expected = match (status, script_null) {
                (200, false) => SettleRead::Written,
                (200, true) => SettleRead::Absent,
                _ => SettleRead::Unknown,
            };
            assert_eq!(
                settle_read(Some(ScriptAnswer::Read {
                    status,
                    script_null
                })),
                expected,
                "{status} {script_null}"
            );
        }
    }
    // A delete's answer never settles anything, even the one that says gone.
    for (status, code) in [(200, None), (404, Some(10007)), (404, None), (500, None)] {
        assert_eq!(
            settle_read(Some(ScriptAnswer::Delete { status, code })),
            SettleRead::Unknown
        );
    }
}

// --- the bounds ------------------------------------------------------------------------------------------------------

#[test]
fn the_wait_doubles_from_five_seconds_to_a_minute() {
    let waits: Vec<i64> = (0..8).map(settle_wait_ms).collect();
    assert_eq!(
        waits,
        [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]
    );
    assert_eq!(settle_wait_ms(u32::MAX), SETTLE_MAX_WAIT_MS);
}

#[test]
fn reads_are_bounded_by_their_count_and_by_the_deadline_to_the_millisecond() {
    let deadline = SINCE + SETTLE_DEADLINE_MS;
    assert_eq!(settle_deadline(SINCE), deadline);
    assert!(may_settle(0, SINCE, SINCE));
    assert!(may_settle(MAX_SETTLE_ATTEMPTS - 1, SINCE, deadline - 1));
    assert!(!may_settle(MAX_SETTLE_ATTEMPTS, SINCE, SINCE));
    assert!(!may_settle(0, SINCE, deadline));
    assert_eq!(settle_next(0, SINCE, deadline), SettleNext::GiveUp);
    assert_eq!(
        settle_next(MAX_SETTLE_ATTEMPTS, SINCE, SINCE),
        SettleNext::GiveUp
    );
    // A read a millisecond before the deadline is followed by one at the deadline, never past it, which then ends it.
    assert_eq!(
        settle_next(1, SINCE, deadline - 1),
        SettleNext::At(deadline)
    );
    assert_eq!(
        settle_next(1, SINCE, deadline - 10_001),
        SettleNext::At(deadline - 1)
    );
    assert_eq!(
        settle_next(1, SINCE, deadline - 10_000),
        SettleNext::At(deadline)
    );
}

#[test]
fn a_release_that_never_settles_is_read_six_times_within_its_deadline_and_ends() {
    // It became uncertain at SINCE; each read settles nothing, and is made the moment it is due.
    let mut now = SINCE;
    let mut reads = Vec::new();
    let mut settles = 0;
    while let SettleNext::At(at) = settle_next(settles, SINCE, now) {
        now = at;
        reads.push(at - SINCE);
        settles += 1;
    }
    assert_eq!(reads, [5_000, 15_000, 35_000, 75_000, 135_000, 195_000]);
    assert_eq!(settles, MAX_SETTLE_ATTEMPTS);
    assert!(now < SINCE + SETTLE_DEADLINE_MS);
    const { assert!(SETTLE_DEADLINE_MS < IN_FLIGHT_EXEMPTION_MS) };
}

#[test]
fn a_release_whose_reads_are_late_ends_at_its_deadline_whatever_reads_it_has_left() {
    // Each read comes a minute and a half after it was due: the provider's answer, or the room, is slow.
    let mut now = SINCE;
    let mut settles = 0;
    let mut reads = Vec::new();
    while let SettleNext::At(at) = settle_next(settles, SINCE, now) {
        now = at + 90_000;
        if !may_settle(settles, SINCE, now) {
            break;
        }
        reads.push(now - SINCE);
        settles += 1;
    }
    assert_eq!(reads, [95_000, 195_000, 305_000, 435_000, 585_000]);
    assert!(settles < MAX_SETTLE_ATTEMPTS);
    assert_eq!(settle_next(settles, SINCE, now), SettleNext::GiveUp);
}

// --- what the driver makes of it -------------------------------------------------------------------------------------

#[test]
fn the_driver_settles_by_its_own_bounds_and_moves_on_once_settled() {
    let now = SINCE + 1_000;
    // Newly uncertain, from an upload: the first read after the first wait.
    assert_eq!(
        settle_outcome(false, true, Some(DriveStep::Upload), 0, now, now),
        Some(SettleDrive::Retry { at: now + 5_000 })
    );
    // Still uncertain after a read: the next wait, by the reads made.
    assert_eq!(
        settle_outcome(true, true, Some(DriveStep::Upload), 2, SINCE, now),
        Some(SettleDrive::Retry { at: now + 20_000 })
    );
    // Out of reads, or out of time.
    assert_eq!(
        settle_outcome(
            true,
            true,
            Some(DriveStep::Upload),
            MAX_SETTLE_ATTEMPTS,
            SINCE,
            now
        ),
        Some(SettleDrive::Unsettled)
    );
    assert_eq!(
        settle_outcome(
            true,
            true,
            Some(DriveStep::Upload),
            1,
            SINCE,
            SINCE + SETTLE_DEADLINE_MS
        ),
        Some(SettleDrive::Unsettled)
    );
    // Settled written, to the commit; or absent, back at the upload, which is not a stall.
    for after in [DriveStep::Commit, DriveStep::Upload] {
        assert_eq!(
            settle_outcome(true, false, Some(after), 1, SINCE, now),
            Some(SettleDrive::Next),
            "{after:?}"
        );
    }
    // Ended while uncertain: the driver's own rules say done.
    assert_eq!(settle_outcome(true, false, None, 1, SINCE, now), None);
    // Never uncertain: the driver's own rules.
    for after in [
        None,
        Some(DriveStep::Start),
        Some(DriveStep::Upload),
        Some(DriveStep::Commit),
    ] {
        assert_eq!(settle_outcome(false, false, after, 0, SINCE, now), None);
    }
}

#[test]
fn reads_made_settling_never_count_toward_the_drivers_cap() {
    assert_eq!(counted_attempts(8, 6), 2);
    assert_eq!(counted_attempts(3, 0), 3);
    assert_eq!(counted_attempts(2, 5), 0);
    // A release with a start, an upload, every read and a commit is still within the cap.
    assert!(counted_attempts(3 + MAX_SETTLE_ATTEMPTS, MAX_SETTLE_ATTEMPTS) < MAX_DRIVE_ATTEMPTS);
}

// --- meanwhile -------------------------------------------------------------------------------------------------------

#[test]
fn nothing_else_goes_live_while_a_release_is_uncertain() {
    let (own, other) = ("rel_a", "rel_b");
    assert!(!commit_waits_on_uncertain(own, &[]));
    assert!(!commit_waits_on_uncertain(own, &[own]));
    assert!(commit_waits_on_uncertain(own, &[other]));
    assert!(commit_waits_on_uncertain(own, &[own, other]));
    // The wait counts no driver attempt: the uncertain release ends by its own bounds.
    assert!(waits_uncounted(COMMIT_WAITS_UNCERTAIN));
}

#[test]
fn every_outcome_has_a_code_of_its_own() {
    let codes = [
        UNCERTAIN,
        SETTLED_WRITTEN,
        SETTLED_ABSENT,
        SETTLE_UNKNOWN,
        UNSETTLED,
        COMMIT_WAITS_UNCERTAIN,
    ];
    let mut seen: Vec<&str> = Vec::new();
    for code in codes {
        assert!((1..=64).contains(&code.len()), "{code}");
        assert!(
            code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'),
            "{code}"
        );
        assert!(!seen.contains(&code), "{code}");
        seen.push(code);
    }
}
