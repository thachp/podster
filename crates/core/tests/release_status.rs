//! M6 step 7: the release beside checks and merge in a task's release status. What is shown is decided here, from the
//! room's own records, and nothing is ever said to be served unless the marker said so and the host still serves it.
#![allow(clippy::unwrap_used, clippy::panic)]

use podster_core::release::ReleaseState;
use podster_core::release_status::{
    release_report, release_state_from_name, AttemptHeld, HostHeld, ReleaseReport, StopSeen,
    UnknownReleaseState,
};

const SCRIPT: &str = "app1.rel_aa";
const OTHER: &str = "app1.rel_bb";

fn attempt(state: &'static str) -> AttemptHeld<'static> {
    AttemptHeld {
        id: "rel_aa",
        state,
        script_name: Some(SCRIPT),
        recorded_at: 70,
        failure_code: None,
    }
}

fn host() -> HostHeld<'static> {
    HostHeld {
        default_script: Some(SCRIPT),
        held: false,
        app_suspended: false,
        stop: StopSeen::Clear,
    }
}

fn served(report: Result<ReleaseReport, UnknownReleaseState>) -> bool {
    match report {
        Ok(ReleaseReport::Attempt { served, .. }) => served,
        Ok(ReleaseReport::NoRelease) => false,
        Err(_) => panic!("refused"),
    }
}

#[test]
fn every_state_the_room_has_reads_back_and_no_other() {
    for state in ReleaseState::ALL {
        assert_eq!(release_state_from_name(state.name()), Some(state));
    }
    for odd in ["", "Live", "deployed", "served ", "ok"] {
        assert_eq!(release_state_from_name(odd), None, "{odd:?}");
    }
}

#[test]
fn switched_off_or_with_no_attempt_there_is_no_release() {
    assert_eq!(
        release_report(false, &[attempt("served")], &host()),
        Ok(ReleaseReport::NoRelease)
    );
    assert_eq!(
        release_report(true, &[], &host()),
        Ok(ReleaseReport::NoRelease)
    );
}

#[test]
fn the_latest_attempt_is_reported_in_its_own_state_with_the_time_it_was_recorded() {
    for state in ReleaseState::ALL {
        let report = release_report(true, &[attempt(state.name())], &host()).unwrap();
        let ReleaseReport::Attempt {
            id,
            state: shown,
            observed_at,
            ..
        } = report
        else {
            panic!("{state:?}: no attempt");
        };
        assert_eq!((id, shown, observed_at), ("rel_aa", state, 70), "{state:?}");
    }
    let older = AttemptHeld {
        id: "rel_00",
        recorded_at: 10,
        ..attempt("failed")
    };
    let newer = AttemptHeld {
        id: "rel_11",
        recorded_at: 90,
        ..attempt("uploading")
    };
    let ReleaseReport::Attempt {
        id, observed_at, ..
    } = release_report(true, &[older, newer], &host()).unwrap()
    else {
        panic!("no attempt");
    };
    assert_eq!((id, observed_at), ("rel_11", 90));
}

#[test]
fn never_served_unless_the_marker_said_so_and_the_host_still_serves_it() {
    // Only `served`, the marker's own record, is ever served: `live` is switched with its marker not yet back.
    for state in ReleaseState::ALL {
        assert_eq!(
            served(release_report(true, &[attempt(state.name())], &host())),
            state == ReleaseState::Served,
            "{state:?}"
        );
    }
    // A served release whose host now serves something else, or nothing, isn't served.
    for default_script in [Some(OTHER), None] {
        let elsewhere = HostHeld {
            default_script,
            ..host()
        };
        assert!(!served(release_report(
            true,
            &[attempt("served")],
            &elsewhere
        )));
    }
    let no_script = AttemptHeld {
        script_name: None,
        ..attempt("served")
    };
    let nothing = HostHeld {
        default_script: None,
        ..host()
    };
    assert!(!served(release_report(true, &[no_script], &nothing)));
    // Held, suspended, or the whole domain stopped: the hosts serve nothing.
    for stopped in [
        HostHeld {
            held: true,
            ..host()
        },
        HostHeld {
            app_suspended: true,
            ..host()
        },
        HostHeld {
            stop: StopSeen::Stopped,
            ..host()
        },
        // A stop that couldn't be read is a stop.
        HostHeld {
            stop: StopSeen::Unread,
            ..host()
        },
    ] {
        assert!(!served(release_report(
            true,
            &[attempt("served")],
            &stopped
        )));
    }
    assert!(served(release_report(true, &[attempt("served")], &host())));
}

#[test]
fn an_earlier_attempt_still_served_stays_served_beside_a_later_one_that_failed() {
    // "An earlier release that was live stays live": the commit is still what the host serves.
    let earlier = attempt("served");
    let later = AttemptHeld {
        id: "rel_bb",
        state: "failed",
        script_name: Some(OTHER),
        recorded_at: 90,
        failure_code: Some("release_marker_missing"),
    };
    assert_eq!(
        release_report(true, &[earlier, later], &host()),
        Ok(ReleaseReport::Attempt {
            id: "rel_bb",
            state: ReleaseState::Failed,
            observed_at: 90,
            failure_code: Some("release_marker_missing"),
            served: true,
        })
    );
}

#[test]
fn a_failure_code_is_shown_only_for_a_failed_attempt() {
    for state in ReleaseState::ALL {
        let with_code = AttemptHeld {
            failure_code: Some("release_marker_missing"),
            ..attempt(state.name())
        };
        let Ok(ReleaseReport::Attempt { failure_code, .. }) =
            release_report(true, &[with_code], &host())
        else {
            panic!("{state:?}");
        };
        assert_eq!(
            failure_code.is_some(),
            state == ReleaseState::Failed,
            "{state:?}"
        );
    }
}

#[test]
fn a_state_the_room_does_not_recognise_is_refused_never_read_as_served() {
    for odd in ["deployed", "Served", ""] {
        assert_eq!(
            release_report(true, &[attempt(odd)], &host()),
            Err(UnknownReleaseState)
        );
        // Even beside an attempt that was served, and even an older one.
        assert_eq!(
            release_report(true, &[attempt(odd), attempt("served")], &host()),
            Err(UnknownReleaseState)
        );
    }
    // Switched off, nothing is read, so nothing is refused.
    assert_eq!(
        release_report(false, &[attempt("deployed")], &host()),
        Ok(ReleaseReport::NoRelease)
    );
}
