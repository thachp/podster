//! The release job's driver (M6 step 5, third PR): which step comes next, what came of one, when to ask again, the cap
//! on attempts, and the bound on how often a room reads.

use podster_core::release::{
    ReleaseState, ATTEMPT_DEADLINE_MS, MAX_RELEASE_READS_PER_HOUR, READ_WINDOW_MS,
};
use podster_core::release_driver::*;

const NOW: i64 = 1_000 * READ_WINDOW_MS;

// --- which step ------------------------------------------------------------------------------------------------------

#[test]
fn a_queued_release_is_started_an_uploading_one_uploaded_then_committed() {
    assert_eq!(
        drive_step(ReleaseState::Queued, false),
        Some(DriveStep::Start)
    );
    assert_eq!(
        drive_step(ReleaseState::Queued, true),
        Some(DriveStep::Start)
    );
    assert_eq!(
        drive_step(ReleaseState::Uploading, false),
        Some(DriveStep::Upload)
    );
    assert_eq!(
        drive_step(ReleaseState::Uploading, true),
        Some(DriveStep::Commit)
    );
}

#[test]
fn every_other_state_is_not_the_drivers() {
    for state in ReleaseState::ALL {
        if matches!(state, ReleaseState::Queued | ReleaseState::Uploading) {
            continue;
        }
        for uploaded in [false, true] {
            assert_eq!(drive_step(state, uploaded), None, "{state:?} {uploaded}");
        }
    }
}

#[test]
fn each_step_has_its_own_code() {
    let codes = [DriveStep::Start, DriveStep::Upload, DriveStep::Commit].map(DriveStep::code);
    assert_eq!(codes, ["start", "upload", "commit"]);
}

// --- what came of a step ---------------------------------------------------------------------------------------------

#[test]
fn a_release_that_moved_on_is_due_at_once_and_one_out_of_hand_is_done() {
    use DriveStep::*;
    for (before, after) in [(Start, Upload), (Upload, Commit), (Start, Commit)] {
        for attempts in [1, MAX_DRIVE_ATTEMPTS, MAX_DRIVE_ATTEMPTS + 3] {
            assert_eq!(
                drive_outcome(before, Some(after), attempts, None, NOW),
                DriveOutcome::Next,
                "{before:?} {after:?} {attempts}"
            );
        }
    }
    for before in [Start, Upload, Commit] {
        for attempts in [1, MAX_DRIVE_ATTEMPTS] {
            assert_eq!(
                drive_outcome(before, None, attempts, Some(NOW + 1), NOW),
                DriveOutcome::Done
            );
        }
    }
}

#[test]
fn a_release_where_it_was_waits_longer_each_time_up_to_the_most() {
    let waits: Vec<Option<i64>> = (1..=MAX_DRIVE_ATTEMPTS - 1)
        .map(|attempts| {
            match drive_outcome(
                DriveStep::Upload,
                Some(DriveStep::Upload),
                attempts,
                None,
                NOW,
            ) {
                DriveOutcome::Retry { at } => Some(at - NOW),
                _ => None,
            }
        })
        .collect();
    assert_eq!(
        waits,
        [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000].map(Some)
    );
    assert_eq!(drive_wait_ms(0), DRIVE_FIRST_WAIT_MS);
    assert_eq!(drive_wait_ms(1), DRIVE_FIRST_WAIT_MS);
    assert_eq!(drive_wait_ms(u32::MAX), DRIVE_MAX_WAIT_MS);
    // A step back to an earlier one is still not the same step: the room moved it, and the driver asks the next.
    assert_eq!(
        drive_outcome(DriveStep::Commit, Some(DriveStep::Upload), 3, None, NOW),
        DriveOutcome::Next
    );
}

#[test]
fn a_wait_is_never_before_the_time_the_step_named_nor_before_its_own_backoff() {
    let named = NOW + 45 * 60 * 1000;
    assert_eq!(
        drive_outcome(
            DriveStep::Upload,
            Some(DriveStep::Upload),
            1,
            Some(named),
            NOW
        ),
        DriveOutcome::Retry { at: named }
    );
    // A named time sooner than the backoff, or in the past, doesn't bring the next attempt closer.
    for early in [NOW - 1, NOW, NOW + DRIVE_FIRST_WAIT_MS - 1] {
        assert_eq!(
            drive_outcome(
                DriveStep::Upload,
                Some(DriveStep::Upload),
                1,
                Some(early),
                NOW
            ),
            DriveOutcome::Retry {
                at: NOW + DRIVE_FIRST_WAIT_MS
            }
        );
    }
}

#[test]
fn the_last_attempt_that_leaves_a_release_where_it_was_ends_it() {
    for step in [DriveStep::Start, DriveStep::Upload, DriveStep::Commit] {
        assert!(matches!(
            drive_outcome(step, Some(step), MAX_DRIVE_ATTEMPTS - 1, None, NOW),
            DriveOutcome::Retry { .. }
        ));
        for attempts in [MAX_DRIVE_ATTEMPTS, MAX_DRIVE_ATTEMPTS + 1] {
            assert_eq!(
                drive_outcome(step, Some(step), attempts, Some(NOW + 1), NOW),
                DriveOutcome::GiveUp
            );
        }
    }
    assert_eq!(ATTEMPTS_EXHAUSTED, "release_attempts_exhausted");
}

#[test]
fn a_lease_is_given_until_every_attempt_is_made() {
    assert!(may_lease(0));
    assert!(may_lease(MAX_DRIVE_ATTEMPTS - 1));
    assert!(!may_lease(MAX_DRIVE_ATTEMPTS));
    assert!(!may_lease(u32::MAX));
}

#[test]
fn the_waits_of_a_release_that_never_moves_fit_inside_its_uploads_hour() {
    // Three attempts move it on, and the rest wait, each up to its own backoff, with a lease each.
    let waits: i64 = (1..MAX_DRIVE_ATTEMPTS).map(drive_wait_ms).sum();
    assert!(waits + DRIVE_LEASE_MS < READ_WINDOW_MS, "{waits}");
    const { assert!(DRIVE_LEASE_MS > ATTEMPT_DEADLINE_MS) };
}

// --- how often a room reads ------------------------------------------------------------------------------------------

#[test]
fn a_room_begins_at_most_two_upload_attempts_in_a_rolling_hour() {
    assert_eq!(upload_slot(&[], NOW), Ok(()));
    assert_eq!(upload_slot(&[NOW - 10], NOW), Ok(()));
    // Two in the hour: the third waits for the older to leave it, to the millisecond.
    let older = NOW - 40 * 60 * 1000;
    let newer = NOW - 5 * 60 * 1000;
    for began in [[older, newer], [newer, older]] {
        assert_eq!(upload_slot(&began, NOW), Err(older + READ_WINDOW_MS));
        assert_eq!(
            upload_slot(&began, older + READ_WINDOW_MS - 1),
            Err(older + READ_WINDOW_MS)
        );
        assert_eq!(upload_slot(&began, older + READ_WINDOW_MS), Ok(()));
    }
    // Three in the hour, as a lower limit before it would have left: the second-newest must leave.
    let three = [NOW - 50 * 60 * 1000, NOW - 30 * 60 * 1000, NOW - 1];
    assert_eq!(
        upload_slot(&three, NOW),
        Err(NOW - 30 * 60 * 1000 + READ_WINDOW_MS)
    );
    // One that began an hour ago, to the millisecond, no longer counts.
    assert_eq!(upload_slot(&[NOW - READ_WINDOW_MS, NOW - 1], NOW), Ok(()));
    assert_eq!(
        upload_slot(&[NOW - READ_WINDOW_MS + 1, NOW - 1], NOW),
        Err(NOW + 1)
    );
}

#[test]
fn one_room_holds_at_most_two_full_attempts_and_leaves_room_for_another() {
    assert_eq!(MAX_ATTEMPT_READS, 602);
    assert_eq!(MAX_ROOM_READS_PER_HOUR, 1_204);
    const { assert!(MAX_ROOM_READS_PER_HOUR * 2 <= MAX_RELEASE_READS_PER_HOUR) };
}

// --- a step's record ---------------------------------------------------------------------------------------------------

#[test]
fn a_step_is_recorded_only_while_its_lease_the_epoch_and_the_hold_are_as_they_were() {
    assert!(step_still_current(3, 3, 2, 2, 7, 7));
    assert!(!step_still_current(3, 4, 2, 2, 7, 7), "another lease");
    assert!(!step_still_current(3, 3, 2, 3, 7, 7), "the epoch moved");
    assert!(!step_still_current(3, 3, 2, 2, 7, 8), "the hold moved");
}
