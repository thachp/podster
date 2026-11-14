//! The release job's marker (M6 step 5; ADR 0010's "The release job", step 6): when the switch has happened, what to do
//! now, whose marker came back, and what came of a fetch. Every bound is shown to the millisecond.

use podster_core::release::MARKER_WAIT_MS;
use podster_core::release_marker::*;
use podster_core::release_tree::marker_body;

const NOW: i64 = 1_900_000_000_000;
const REL: &str = "rel_8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f";
const OTHER: &str = "rel_6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d";
const COMMIT: &str = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const SCRIPT: &str = "label.rel_8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f";
const BEFORE: &str = "label.rel_6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d";

/// The marker as the job uploads it, written out here so the test doesn't lean on the code it checks.
fn body(release: &str, commit: &str) -> String {
    format!("{{\"release_id\":\"{release}\",\"commit\":\"{commit}\"}}\n")
}

#[test]
fn the_body_here_is_the_one_the_job_uploads() {
    assert_eq!(marker_body(REL, COMMIT), Some(body(REL, COMMIT)));
}

// --- the switch ------------------------------------------------------------------------------------------------------

#[test]
fn the_switch_is_the_default_hosts_entry_applied_at_exactly_the_commits_version_and_script() {
    assert!(marker_switched(
        6,
        Some(SCRIPT),
        Some(6),
        SCRIPT,
        Some(6),
        Some(SCRIPT)
    ));
    // The entry still names the release before, or is at another version.
    assert!(!marker_switched(
        6,
        Some(SCRIPT),
        Some(6),
        SCRIPT,
        Some(5),
        Some(BEFORE)
    ));
    assert!(!marker_switched(
        6,
        Some(SCRIPT),
        Some(6),
        SCRIPT,
        Some(6),
        Some(BEFORE)
    ));
    assert!(!marker_switched(
        6,
        Some(SCRIPT),
        Some(6),
        SCRIPT,
        Some(7),
        Some(SCRIPT)
    ));
    // The host wants something else now: a later version, or another script.
    assert!(!marker_switched(
        7,
        Some(SCRIPT),
        Some(6),
        SCRIPT,
        Some(6),
        Some(SCRIPT)
    ));
    assert!(!marker_switched(
        6,
        None,
        Some(6),
        SCRIPT,
        Some(6),
        Some(SCRIPT)
    ));
}

#[test]
fn a_missing_value_is_never_a_switch() {
    // No version the commit wrote, no entry applied, or no script on either side: never a match, `None == None` least.
    assert!(!marker_switched(
        6,
        Some(SCRIPT),
        None,
        SCRIPT,
        Some(6),
        Some(SCRIPT)
    ));
    assert!(!marker_switched(
        6,
        Some(SCRIPT),
        Some(6),
        SCRIPT,
        None,
        Some(SCRIPT)
    ));
    assert!(!marker_switched(
        6,
        Some(SCRIPT),
        Some(6),
        SCRIPT,
        Some(6),
        None
    ));
    assert!(!marker_switched(6, None, Some(6), "", Some(6), None));
    assert!(!marker_switched(
        6,
        Some(""),
        Some(6),
        "",
        Some(6),
        Some("")
    ));
}

// --- whose marker ----------------------------------------------------------------------------------------------------

#[test]
fn only_this_releases_own_marker_answered_200_is_seen() {
    let ours = body(REL, COMMIT);
    assert!(marker_seen(Some((200, ours.as_bytes())), REL, COMMIT));
    // The release before's, the same release under another commit, and anything not byte for byte.
    let before = body(OTHER, COMMIT);
    assert!(!marker_seen(Some((200, before.as_bytes())), REL, COMMIT));
    let other_commit = body(REL, &"d4".repeat(20));
    assert!(!marker_seen(
        Some((200, other_commit.as_bytes())),
        REL,
        COMMIT
    ));
    assert!(!marker_seen(
        Some((200, ours.trim_end().as_bytes())),
        REL,
        COMMIT
    ));
    assert!(!marker_seen(
        Some((200, format!("{ours} ").as_bytes())),
        REL,
        COMMIT
    ));
    // Its bytes under another status, nothing, or no answer at all.
    for status in [201, 204, 304, 404, 500] {
        assert!(
            !marker_seen(Some((status, ours.as_bytes())), REL, COMMIT),
            "{status}"
        );
    }
    assert!(!marker_seen(Some((200, b"")), REL, COMMIT));
    assert!(!marker_seen(None, REL, COMMIT));
}

#[test]
fn a_release_or_commit_that_isnt_one_sees_nothing() {
    // `marker_body` makes nothing for these, so no body can match them, an empty one least.
    assert!(!marker_seen(Some((200, b"")), "rel_x", COMMIT));
    assert!(!marker_seen(Some((200, b"")), REL, "c3"));
}

#[test]
fn an_answer_longer_than_the_bound_is_never_seen() {
    let padded = vec![b' '; MARKER_MAX_BYTES + 1];
    assert!(!marker_seen(Some((200, &padded)), REL, COMMIT));
    assert!(body(REL, COMMIT).len() < MARKER_MAX_BYTES);
}

// --- what to do now --------------------------------------------------------------------------------------------------

#[test]
fn before_the_switch_it_waits_and_looks_again_never_past_the_switchs_bound() {
    assert_eq!(
        marker_plan(NOW, None, NOW),
        MarkerPlan::Wait {
            at: NOW + MARKER_POLL_MS,
            code: AWAITING_SWITCH
        }
    );
    // Near the end, the next look is at the end itself.
    let end = NOW + MARKER_SWITCH_WAIT_MS;
    assert_eq!(
        marker_plan(NOW, None, end - 1),
        MarkerPlan::Wait {
            at: end,
            code: AWAITING_SWITCH
        }
    );
    // At the end, to the millisecond, and after it: set back.
    assert_eq!(
        marker_plan(NOW, None, end),
        MarkerPlan::SetBack { code: NOT_SWITCHED }
    );
    assert_eq!(
        marker_plan(NOW, None, end + 1),
        MarkerPlan::SetBack { code: NOT_SWITCHED }
    );
}

#[test]
fn after_the_switch_it_fetches_until_the_markers_wait_runs_out() {
    let switched = NOW + 60_000;
    assert_eq!(
        marker_plan(NOW, Some(switched), switched),
        MarkerPlan::Fetch
    );
    assert_eq!(
        marker_plan(NOW, Some(switched), switched + MARKER_WAIT_MS - 1),
        MarkerPlan::Fetch
    );
    assert_eq!(
        marker_plan(NOW, Some(switched), switched + MARKER_WAIT_MS),
        MarkerPlan::SetBack {
            code: MARKER_MISSING
        }
    );
    // The marker's own wait runs from the switch, even when the switch came late in its own bound.
    let late = NOW + MARKER_SWITCH_WAIT_MS - 1;
    assert_eq!(
        marker_plan(NOW, Some(late), late + MARKER_WAIT_MS - 1),
        MarkerPlan::Fetch
    );
}

#[test]
fn the_bounds_are_as_proposed() {
    assert_eq!(MARKER_WAIT_MS, 30_000);
    assert_eq!(MARKER_SWITCH_WAIT_MS, 10 * 60 * 1000);
    assert_eq!(MARKER_POLL_MS, 5_000);
    assert_eq!(MARKER_FETCH_TIMEOUT_MS, 5_000);
    assert_eq!(MARKER_LEASE_MS, 15_000);
    for code in [
        MARKER_MISSING,
        NOT_SWITCHED,
        AWAITING_SWITCH,
        AWAITING_MARKER,
    ] {
        assert!((1..=64).contains(&code.len()), "{code}");
    }
}

// --- what came of a fetch --------------------------------------------------------------------------------------------

#[test]
fn a_marker_seen_is_served_whenever_the_fetch_ends() {
    for now in [
        NOW,
        NOW + MARKER_WAIT_MS - 1,
        NOW + MARKER_WAIT_MS,
        NOW + 10 * MARKER_WAIT_MS,
    ] {
        assert_eq!(
            marker_outcome(true, NOW, now),
            MarkerOutcome::Served,
            "{now}"
        );
    }
}

#[test]
fn a_marker_not_seen_is_fetched_again_never_past_the_wait_and_set_back_at_its_end() {
    assert_eq!(
        marker_outcome(false, NOW, NOW),
        MarkerOutcome::Retry {
            at: NOW + MARKER_POLL_MS
        }
    );
    assert_eq!(
        marker_outcome(false, NOW, NOW + MARKER_WAIT_MS - 1),
        MarkerOutcome::Retry {
            at: NOW + MARKER_WAIT_MS
        }
    );
    assert_eq!(
        marker_outcome(false, NOW, NOW + MARKER_WAIT_MS),
        MarkerOutcome::SetBack {
            code: MARKER_MISSING
        }
    );
}

#[test]
fn a_release_that_is_never_seen_is_looked_at_a_bounded_number_of_times() {
    // Fetch at the switch and at every retry: the count is the wait over the poll, and one more.
    let mut now = NOW;
    let mut fetches = 0;
    loop {
        assert_eq!(marker_plan(NOW, Some(NOW), now), MarkerPlan::Fetch);
        fetches += 1;
        match marker_outcome(false, NOW, now) {
            MarkerOutcome::Retry { at } => {
                assert!(at > now);
                now = at;
            }
            other => {
                assert_eq!(other, MarkerOutcome::Retry { at: now + 1 });
                break;
            }
        }
        if marker_plan(NOW, Some(NOW), now) != MarkerPlan::Fetch {
            break;
        }
    }
    assert_eq!(fetches, (MARKER_WAIT_MS / MARKER_POLL_MS) as usize);
    assert_eq!(
        marker_plan(NOW, Some(NOW), now),
        MarkerPlan::SetBack {
            code: MARKER_MISSING
        }
    );
}
