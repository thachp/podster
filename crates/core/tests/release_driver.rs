//! The release job's driver (M6 step 5, third PR): which step comes next, what came of one, when to ask again, the cap
//! on attempts, and the bound on how often a room reads.

use podster_core::release::{
    reads_wait_under, ReleaseState, ATTEMPT_DEADLINE_MS, MAX_RELEASE_READS_PER_HOUR, READ_WINDOW_MS,
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
                drive_outcome(before, Some(after), attempts, attempts - 1, None, NOW),
                DriveOutcome::Next,
                "{before:?} {after:?} {attempts}"
            );
        }
    }
    for before in [Start, Upload, Commit] {
        for attempts in [1, MAX_DRIVE_ATTEMPTS] {
            assert_eq!(
                drive_outcome(before, None, attempts, 0, Some(NOW + 1), NOW),
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
                attempts - 1,
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
        drive_outcome(DriveStep::Commit, Some(DriveStep::Upload), 3, 2, None, NOW),
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
            0,
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
                0,
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
            drive_outcome(step, Some(step), MAX_DRIVE_ATTEMPTS - 1, 0, None, NOW),
            DriveOutcome::Retry { .. }
        ));
        for attempts in [MAX_DRIVE_ATTEMPTS, MAX_DRIVE_ATTEMPTS + 1] {
            assert_eq!(
                drive_outcome(step, Some(step), attempts, 0, Some(NOW + 1), NOW),
                DriveOutcome::GiveUp
            );
        }
    }
    assert_eq!(ATTEMPTS_EXHAUSTED, "release_attempts_exhausted");
}

#[test]
fn the_wait_starts_again_from_the_first_once_a_step_moves_the_release_on() {
    use DriveStep::*;
    // A start and an upload that each moved it on, then a commit that left it where it was: the third attempt, the
    // first in a row to stall, waits the first wait, not the third.
    let mut stalled = 0;
    for (attempt, (before, after)) in [(Start, Upload), (Upload, Commit)].into_iter().enumerate() {
        let attempts = attempt as u32 + 1;
        assert_eq!(
            drive_outcome(before, Some(after), attempts, stalled, None, NOW),
            DriveOutcome::Next
        );
        stalled = stalls_after(before, Some(after), stalled);
        assert_eq!(stalled, 0);
    }
    assert_eq!(
        drive_outcome(Commit, Some(Commit), 3, stalled, None, NOW),
        DriveOutcome::Retry {
            at: NOW + DRIVE_FIRST_WAIT_MS
        }
    );
    // In a row, the waits double as before.
    let mut waits = Vec::new();
    for attempts in 3..MAX_DRIVE_ATTEMPTS {
        if let DriveOutcome::Retry { at } =
            drive_outcome(Commit, Some(Commit), attempts, stalled, None, NOW)
        {
            waits.push(at - NOW);
        }
        stalled = stalls_after(Commit, Some(Commit), stalled);
    }
    assert_eq!(waits, [30_000, 60_000, 120_000, 240_000, 480_000]);
    // The cap still counts every attempt, those that moved it on included.
    assert_eq!(
        drive_outcome(Commit, Some(Commit), MAX_DRIVE_ATTEMPTS, 0, None, NOW),
        DriveOutcome::GiveUp
    );
    // A step that moved it on, or out of the driver's hands, starts the count again.
    assert_eq!(stalls_after(Upload, Some(Commit), 5), 0);
    assert_eq!(stalls_after(Commit, None, 5), 0);
    assert_eq!(stalls_after(Commit, Some(Commit), u32::MAX), u32::MAX);
}

#[test]
fn a_lease_holds_until_the_millisecond_it_runs_out() {
    let until = NOW + DRIVE_LEASE_MS;
    assert!(lease_holds(until, NOW));
    assert!(lease_holds(until, until - 1));
    assert!(!lease_holds(until, until));
    assert!(!lease_holds(until, until + 1));
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
    // 35.5 minutes, as `DRIVE_MAX_WAIT_MS` says.
    assert_eq!(waits, 2_130_000);
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

// --- the read share (docs/m6-release-read-share.md) -----------------------------------------------------------------

#[test]
fn an_owner_keeps_exactly_two_full_attempts_and_two_owners_leave_592() {
    assert_eq!(MAX_OWNER_READS_PER_HOUR, 1_204);
    assert_eq!(MAX_OWNER_READS_PER_HOUR, 2 * MAX_ATTEMPT_READS);
    assert_eq!(MAX_RELEASE_READS_PER_HOUR, 3_000);
    assert_eq!(
        MAX_RELEASE_READS_PER_HOUR - 2 * MAX_OWNER_READS_PER_HOUR,
        592
    );
    const { assert!(MAX_OWNER_READS_PER_HOUR >= MAX_ATTEMPT_READS) };
    const { assert!(MAX_RELEASE_READS_PER_HOUR - MAX_OWNER_READS_PER_HOUR >= MAX_ATTEMPT_READS) };
}

#[test]
fn an_owner_fits_to_exactly_1204_and_waits_at_1205_until_its_oldest_leaves_the_hour() {
    let first = NOW - 1_000;
    let mine = [(first, 602), (NOW - 10, 600)];
    // 1,202 held: two more fit, exactly the share; three don't.
    assert_eq!(read_share_wait(&mine, &mine, 2, NOW), Ok(()));
    assert_eq!(
        read_share_wait(&mine, &mine, 3, NOW),
        Err(Some(first + READ_WINDOW_MS))
    );
    // Nothing held: the whole share fits at once, a read more never does.
    assert_eq!(read_share_wait(&[], &[], 1_204, NOW), Ok(()));
    assert_eq!(read_share_wait(&[], &[], 1_205, NOW), Err(None));
    // A millisecond before the oldest leaves, it still waits; at that millisecond it fits.
    let at = first + READ_WINDOW_MS;
    assert_eq!(read_share_wait(&mine, &mine, 3, at - 1), Err(Some(at)));
    assert_eq!(read_share_wait(&mine, &mine, 3, at), Ok(()));
}

#[test]
fn the_total_binds_across_owners_and_the_later_of_the_two_times_wins() {
    // Two owners, each at its whole share; a third owner has nothing of its own.
    let one = [(NOW - 3_000, 602), (NOW - 2_000, 602)];
    let two = [(NOW - 1_500, 602), (NOW - 500, 602)];
    let all: Vec<(i64, u32)> = one.iter().chain(&two).copied().collect();
    // 592 are left: exactly 592 fit, a full attempt waits for the first of them to leave the hour.
    assert_eq!(read_share_wait(&[], &all, 592, NOW), Ok(()));
    assert_eq!(
        read_share_wait(&[], &all, 593, NOW),
        Err(Some(NOW - 3_000 + READ_WINDOW_MS))
    );
    assert_eq!(
        read_share_wait(&[], &all, MAX_ATTEMPT_READS, NOW),
        Err(Some(NOW - 3_000 + READ_WINDOW_MS))
    );
    // The total alone can't decide for an owner past its share: the first owner waits for its own oldest, though the
    // total would let a small read through.
    assert_eq!(
        read_share_wait(&one, &one, 1, NOW),
        Err(Some(NOW - 3_000 + READ_WINDOW_MS))
    );
    // Both bind: the owner's oldest row leaves first and makes room in its share, but not yet in the total, which waits
    // for another owner's row. The later wins.
    let mine = [(NOW - 1_000, 100), (NOW - 20, 900)];
    let full: Vec<(i64, u32)> = mine.iter().copied().chain([(NOW - 500, 2_000)]).collect();
    assert_eq!(
        reads_wait_under(MAX_OWNER_READS_PER_HOUR, &mine, 300, NOW),
        Err(Some(NOW - 1_000 + READ_WINDOW_MS))
    );
    assert_eq!(
        read_share_wait(&mine, &full, 300, NOW),
        Err(Some(NOW - 500 + READ_WINDOW_MS))
    );
    // And the other way round: the total frees first, the owner's own row later.
    let late = [(NOW - 10, 1_204)];
    let spread: Vec<(i64, u32)> = late
        .iter()
        .copied()
        .chain([(NOW - 4_000, 1_204), (NOW - 3_000, 592)])
        .collect();
    assert_eq!(
        read_share_wait(&late, &spread, 10, NOW),
        Err(Some(NOW - 10 + READ_WINDOW_MS))
    );
    // Reservations from before the hour count for nobody.
    let old = [(NOW - READ_WINDOW_MS - 1, 1_204)];
    assert_eq!(read_share_wait(&old, &old, 1_204, NOW), Ok(()));
}

#[test]
fn the_share_and_the_total_alone_agree_with_the_budget_for_the_deployment() {
    // With one owner holding nothing, the share is the deployment's budget, as before it.
    let held = [(NOW - 10, 2_995)];
    assert_eq!(
        read_share_wait(&[], &held, 6, NOW),
        podster_core::release::read_budget_wait(&held, 6, NOW)
    );
    assert_eq!(
        read_share_wait(&[], &held, 6, NOW),
        Err(Some(NOW - 10 + READ_WINDOW_MS))
    );
    assert_eq!(read_share_wait(&[], &held, 5, NOW), Ok(()));
}

#[test]
fn only_the_share_and_the_markers_waits_count_no_attempt() {
    assert_eq!(READ_SHARE_WAITING, "release_reads_share");
    assert!(waits_uncounted(READ_SHARE_WAITING));
    assert!(waits_uncounted(
        podster_core::release::CommitLiveRefusal::InFlight.code()
    ));
    for code in [
        "release_reads_budget",
        "release_upload_attempts",
        "release_driver_idle",
        "release_step_no_progress",
        "release_attempts_exhausted",
        "standing_unknown",
        "",
        "release_reads_share ",
    ] {
        assert!(!waits_uncounted(code), "{code}");
    }
}

#[test]
fn a_share_wait_is_due_when_the_share_said_and_never_sooner_than_the_first_wait() {
    assert_eq!(
        read_share_due(NOW + READ_WINDOW_MS, NOW),
        NOW + READ_WINDOW_MS
    );
    assert_eq!(read_share_due(NOW + 1, NOW), NOW + DRIVE_FIRST_WAIT_MS);
    assert_eq!(read_share_due(NOW - 5, NOW), NOW + DRIVE_FIRST_WAIT_MS);
}

#[test]
fn the_owner_is_the_organization_else_the_person_else_the_room() {
    assert_eq!(
        read_owner_key(Some("org_a"), Some("per_b"), "ws_c").as_deref(),
        Some("org:org_a")
    );
    assert_eq!(
        read_owner_key(Some(""), Some("per_b"), "ws_c").as_deref(),
        Some("person:per_b")
    );
    assert_eq!(
        read_owner_key(None, None, "ws_c").as_deref(),
        Some("room:ws_c")
    );
    assert_eq!(
        read_owner_key(None, Some(""), "ws_c").as_deref(),
        Some("room:ws_c")
    );
    // An owner that isn't an ID is no owner: nothing falls back past it.
    assert_eq!(read_owner_key(Some("org a"), Some("per_b"), "ws_c"), None);
    assert_eq!(read_owner_key(None, None, ""), None);
    for key in ["org:a", "person:per_1", "room:ws-1_x"] {
        assert!(is_read_owner_key(key), "{key}");
    }
    for key in [
        "org:",
        "a",
        "team:a",
        "org:a:b",
        "org:a b",
        "Org:a",
        &format!("org:{}", "a".repeat(129)),
    ] {
        assert!(!is_read_owner_key(key), "{key}");
    }
    assert!(is_read_owner_key(&format!("org:{}", "a".repeat(128))));
}
