#![allow(clippy::expect_used, clippy::indexing_slicing)]
//! A custom hostname's marker (M6 step 8e; ADR 0010's "Custom domains", step 5, and "The release job", step 6): when a
//! custom host counts as switched, what a fetch of its marker comes to, its set-back, and its reopening. Every bound is
//! shown to the millisecond.

use podster_core::custom_marker::*;
use podster_core::release::{
    open_host, CommitMark, DesiredServe, InFlight, ServeState, MARKER_WAIT_MS,
};
use podster_core::release_marker::MARKER_POLL_MS;

const NOW: i64 = 1_900_000_000_000;
const SCRIPT: &str = "label.rel_8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f";
const BEFORE: &str = "label.rel_6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d";

/// A custom host that the applier has written at exactly what the room wants, for a release served on the default host.
fn switched_host() -> CustomHost<'static> {
    CustomHost {
        closed: false,
        version: 4,
        script: Some(SCRIPT),
        applied_version: Some(4),
        applied_script: Some(SCRIPT),
        refused_version: None,
        served_on_default: true,
        held: false,
    }
}

fn host(script: Option<&str>, version: u64, closed: bool) -> DesiredServe {
    DesiredServe {
        script: script.map(str::to_owned),
        version,
        closed,
    }
}

/// A room serving `SCRIPT` on its default host at 7 and on one custom host at 4, nothing in flight.
fn state() -> ServeState {
    ServeState {
        epoch: 2,
        hosts: vec![host(Some(SCRIPT), 7, false), host(Some(SCRIPT), 4, false)],
        kept_previous: Some(BEFORE.to_owned()),
        in_flight: None,
    }
}

// --- the switch ------------------------------------------------------------------------------------------------------

#[test]
fn a_custom_host_is_switched_only_once_written_for_a_release_served_on_the_default_host() {
    assert!(custom_switched(&switched_host()));
    type Change = fn(&mut CustomHost<'static>);
    let cases: [(&str, Change); 9] = [
        ("closed", |h| h.closed = true),
        ("wants nothing", |h| h.script = None),
        ("written at another version", |h| {
            h.applied_version = Some(3)
        }),
        ("nothing written", |h| h.applied_version = None),
        ("written with another script", |h| {
            h.applied_script = Some(BEFORE)
        }),
        ("written with nothing", |h| h.applied_script = None),
        ("refused at its version", |h| h.refused_version = Some(4)),
        // Until the default host's marker confirms the release, a custom host is never asked for it.
        ("not served on the default host", |h| {
            h.served_on_default = false
        }),
        // A held app's entry is taken down, and a marker read then could be a stale entry's.
        ("held", |h| h.held = true),
    ];
    for (what, change) in cases {
        let mut h = switched_host();
        change(&mut h);
        assert!(!custom_switched(&h), "{what}");
    }
    // A refusal at an earlier version doesn't count against this one.
    let mut earlier = switched_host();
    earlier.refused_version = Some(3);
    assert!(custom_switched(&earlier));
}

// --- a fetch, and what came of it ------------------------------------------------------------------------------------

#[test]
fn a_switched_custom_host_is_fetched_until_its_wait_ends_and_set_back_at_the_end_to_the_millisecond(
) {
    assert_eq!(custom_plan(NOW, NOW), CustomPlan::Fetch);
    assert_eq!(
        custom_plan(NOW, NOW + MARKER_WAIT_MS - 1),
        CustomPlan::Fetch
    );
    assert_eq!(
        custom_plan(NOW, NOW + MARKER_WAIT_MS),
        CustomPlan::SetBack {
            code: CUSTOM_MARKER_MISSING
        }
    );
}

#[test]
fn only_its_own_marker_records_a_release_served_on_a_custom_host_and_a_host_that_moved_records_nothing(
) {
    // Seen, whenever the fetch ends: it is what the host serves.
    assert_eq!(
        custom_record(true, true, NOW, NOW + MARKER_WAIT_MS + 1),
        CustomRecord::Served
    );
    // Not seen: fetched again after the poll, never past the wait's end, and set back at the end.
    assert_eq!(
        custom_record(true, false, NOW, NOW + 1),
        CustomRecord::Retry {
            at: NOW + 1 + MARKER_POLL_MS
        }
    );
    assert_eq!(
        custom_record(true, false, NOW, NOW + MARKER_WAIT_MS - 1),
        CustomRecord::Retry {
            at: NOW + MARKER_WAIT_MS
        }
    );
    assert_eq!(
        custom_record(true, false, NOW, NOW + MARKER_WAIT_MS),
        CustomRecord::SetBack {
            code: CUSTOM_MARKER_MISSING
        }
    );
    // The host moved while the fetch was out (closed when its claim ended, switched by a later release, written again):
    // what came back is about a host that no longer is. Seen or not, nothing is kept, and nothing is set back. A
    // marker answered after a deletion (spike D, item 12) is never taken for anything.
    for seen in [true, false] {
        assert_eq!(
            custom_record(false, seen, NOW, NOW + MARKER_WAIT_MS),
            CustomRecord::Moved
        );
    }
}

// --- the set-back ----------------------------------------------------------------------------------------------------

#[test]
fn the_set_back_takes_only_that_custom_host_to_nothing_and_only_at_exactly_what_was_checked() {
    let s = state();
    let after = custom_set_back(&s, 1, 4, SCRIPT).expect("set back");
    assert_eq!(after.hosts[1], host(None, 5, false));
    // The default host, the epoch, the kept script and the flight are untouched.
    assert_eq!(after.hosts[0], s.hosts[0]);
    assert_eq!(
        (after.epoch, &after.kept_previous, &after.in_flight),
        (s.epoch, &s.kept_previous, &s.in_flight)
    );
    // Never the default host, which has its own marker; never a host that moved, closed or names another script.
    assert_eq!(custom_set_back(&s, 0, 7, SCRIPT), None);
    assert_eq!(custom_set_back(&s, 1, 3, SCRIPT), None);
    assert_eq!(custom_set_back(&s, 1, 4, BEFORE), None);
    assert_eq!(custom_set_back(&s, 2, 4, SCRIPT), None);
    let mut closed = state();
    closed.hosts[1] = host(None, 4, true);
    assert_eq!(custom_set_back(&closed, 1, 4, SCRIPT), None);
    // A version that can't go up stays where it is.
    let mut full = state();
    full.hosts[1] = host(Some(SCRIPT), u64::MAX - 1, false);
    assert_eq!(custom_set_back(&full, 1, u64::MAX - 1, SCRIPT), None);
}

#[test]
fn a_set_back_custom_host_reopens_on_the_release_last_confirmed_only_if_nothing_moved_since() {
    let s = custom_set_back(&state(), 1, 4, SCRIPT).expect("set back");
    let reopened = custom_reopen(&s, 1, 4, false).expect("reopened");
    assert_eq!(reopened.hosts[1], host(Some(SCRIPT), 6, false));
    assert_eq!(reopened.hosts[0], s.hosts[0]);
    // Moved since the set-back: closed, written by a commit, or at another version. Nothing is reopened.
    assert_eq!(custom_reopen(&s, 1, 3, false), None);
    assert_eq!(custom_reopen(&s, 0, 6, false), None);
    let mut closed = s.clone();
    closed.hosts[1] = host(None, 6, true);
    assert_eq!(custom_reopen(&closed, 1, 5, false), None);
    let mut written = s.clone();
    written.hosts[1] = host(Some(BEFORE), 5, false);
    assert_eq!(custom_reopen(&written, 1, 4, false), None);
    // An unpublished room has no release confirmed: it reopens on nothing, which serves nothing.
    let mut unpublished = s.clone();
    unpublished.hosts[0] = host(None, 8, false);
    assert_eq!(
        custom_reopen(&unpublished, 1, 4, false).map(|s| s.hosts[1].clone()),
        Some(host(None, 6, false))
    );
}

#[test]
fn the_reopen_waits_a_minute_doubling_to_an_hour() {
    let waits: Vec<i64> = (0..=8).map(reopen_wait_ms).collect();
    assert_eq!(
        waits,
        vec![60_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]
    );
    assert_eq!(reopen_wait_ms(u32::MAX), 3_600_000);
}

/// The architect's ruling L1 on #448, 2026-11-18: during a rollback's flight, the release last confirmed is the one being
/// rolled away from, so no custom host opens on it, by routing's start or by a reopening after a set-back.
#[test]
fn no_custom_host_opens_while_a_rollback_is_in_flight() {
    let set_back = custom_set_back(&state(), 1, 4, SCRIPT).expect("set back");
    // A rollback from `SCRIPT` back to `BEFORE`, waiting for its marker on the default host.
    let mut rolling = set_back.clone();
    rolling.hosts[0] = host(Some(BEFORE), 8, false);
    rolling.in_flight = Some(InFlight {
        release_id: "rel_4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b".to_owned(),
        script: BEFORE.to_owned(),
        mark: CommitMark {
            epoch: 2,
            versions: vec![Some(8), None],
            before: vec![Some(SCRIPT.to_owned()), None],
        },
    });
    assert_eq!(custom_reopen(&rolling, 1, 4, true), None);
    assert_eq!(open_host(&rolling, 1, true), None);
    // The same flight read as an ordinary commit's opens on the release before it, which is what a commit keeps.
    assert_eq!(
        open_host(&rolling, 1, false).map(|s| s.hosts[1].clone()),
        Some(host(Some(SCRIPT), 6, false))
    );
    // With no flight, the flag changes nothing.
    assert!(custom_reopen(&set_back, 1, 4, true).is_some());
    assert!(open_host(&set_back, 1, true).is_some());
}
