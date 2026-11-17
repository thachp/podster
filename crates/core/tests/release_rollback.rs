#![allow(clippy::unwrap_used, clippy::indexing_slicing)]
//! Rolling back to an earlier release (M6 step 6, 6h; ADR 0010's "Rollback"): which release may be rolled back to, when
//! a rollback may switch back to the room's kept script with no upload, and whose marker a rollback waits for. Pure:
//! every fact is passed in.

use podster_core::release::{
    commit_live, confirm_served, rollback, set_back, waiting_entry_keeps, CommitLiveRefusal,
    DesiredServe, ReleaseState, RollbackRefusal, ScriptAnswer, ServeState,
};
use podster_core::release_rollback::{
    aims_at_kept, marker_release, rollback_path, rollback_target, KeptFacts, KeptRefusal,
    RollbackPath, SwitchReads, TargetRefusal,
};

const LABEL: &str = "abcdefghijklmnopqrstuvwxyz";
const A: &str = "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B: &str = "rel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const R: &str = "rel_cccccccccccccccccccccccccccccccc";

fn script(release: &str) -> String {
    format!("{LABEL}.{release}")
}

const EXISTS: ScriptAnswer = ScriptAnswer::Read {
    status: 200,
    script_null: false,
};
const GONE: ScriptAnswer = ScriptAnswer::Read {
    status: 200,
    script_null: true,
};

fn kept_facts<'a>(kept: &'a str, target: &'a str) -> KeptFacts<'a> {
    KeptFacts {
        kept: Some(kept),
        target_script: Some(target),
        current_label: Some(LABEL),
        rollback_label: LABEL,
        app_suspended: false,
        queued_for_delete: false,
    }
}

const READ_CLEAR: SwitchReads = SwitchReads {
    finding_open: Some(false),
    script: Some(EXISTS),
};

#[test]
fn only_a_release_that_was_served_and_has_been_left_may_be_rolled_back_to() {
    for state in ReleaseState::ALL {
        for served in [false, true] {
            let ok = served && matches!(state, ReleaseState::Replaced | ReleaseState::Unpublished);
            assert_eq!(
                rollback_target(state, served).is_ok(),
                ok,
                "{state:?} served={served}"
            );
        }
    }
    // The release served now isn't one to roll back to; nor one never served.
    assert_eq!(
        rollback_target(ReleaseState::Served, true),
        Err(TargetRefusal::NotEarlier)
    );
    assert_eq!(
        rollback_target(ReleaseState::Replaced, false),
        Err(TargetRefusal::NotEarlier)
    );
    assert_eq!(TargetRefusal::NotEarlier.code(), "rollback_target_invalid");
}

#[test]
fn aims_at_the_kept_script_only_when_every_room_fact_holds() {
    let k = script(A);
    assert_eq!(aims_at_kept(&kept_facts(&k, &k)), Ok(k.as_str()));
    let other = script(B);
    let cases: [(&str, KeptFacts, KeptRefusal); 7] = [
        (
            "nothing kept",
            KeptFacts {
                kept: None,
                ..kept_facts(&k, &k)
            },
            KeptRefusal::NotKept,
        ),
        (
            "the kept script isn't the target's",
            kept_facts(&k, &other),
            KeptRefusal::NotKept,
        ),
        (
            "the target names no script",
            KeptFacts {
                target_script: None,
                ..kept_facts(&k, &k)
            },
            KeptRefusal::NotKept,
        ),
        (
            "the room has no current label: an unpublish retired it",
            KeptFacts {
                current_label: None,
                ..kept_facts(&k, &k)
            },
            KeptRefusal::LabelNotCurrent,
        ),
        (
            "the kept script's label isn't the room's current one",
            KeptFacts {
                current_label: Some("zzzz"),
                ..kept_facts(&k, &k)
            },
            KeptRefusal::LabelNotCurrent,
        ),
        (
            "the app or one of its hosts is suspended",
            KeptFacts {
                app_suspended: true,
                ..kept_facts(&k, &k)
            },
            KeptRefusal::Suspended,
        ),
        (
            "the kept script is queued for deletion",
            KeptFacts {
                queued_for_delete: true,
                ..kept_facts(&k, &k)
            },
            KeptRefusal::Deleting,
        ),
    ];
    for (why, facts, want) in cases {
        assert_eq!(aims_at_kept(&facts), Err(want), "{why}");
    }
    // The rollback's own label must be the kept script's: its record names that script under its own label.
    assert_eq!(
        aims_at_kept(&KeptFacts {
            rollback_label: "otherlabel",
            ..kept_facts(&k, &k)
        }),
        Err(KeptRefusal::LabelNotCurrent)
    );
    // A kept script that isn't a name Podster made is never aimed at.
    assert_eq!(
        aims_at_kept(&kept_facts("not-a-script", "not-a-script")),
        Err(KeptRefusal::NotKept)
    );
}

#[test]
fn switches_only_on_a_fresh_read_that_says_the_kept_script_exists_and_no_finding() {
    let k = script(A);
    let room = kept_facts(&k, &k);
    assert_eq!(rollback_path(&room, &READ_CLEAR), RollbackPath::Switch);

    // Each requirement, taken away in turn: a definite one uploads again, an unread one decides nothing.
    let gone = SwitchReads {
        script: Some(GONE),
        ..READ_CLEAR
    };
    assert_eq!(
        rollback_path(&room, &gone),
        RollbackPath::Upload("rollback_script_gone")
    );
    let deleted = SwitchReads {
        script: Some(ScriptAnswer::Delete {
            status: 404,
            code: Some(10007),
        }),
        ..READ_CLEAR
    };
    assert_eq!(
        rollback_path(&room, &deleted),
        RollbackPath::Upload("rollback_script_gone")
    );
    for unread in [
        None,
        Some(ScriptAnswer::Read {
            status: 404,
            script_null: false,
        }),
        Some(ScriptAnswer::Read {
            status: 500,
            script_null: false,
        }),
    ] {
        assert_eq!(
            rollback_path(
                &room,
                &SwitchReads {
                    script: unread,
                    ..READ_CLEAR
                }
            ),
            RollbackPath::Undecided("rollback_script_unread"),
            "{unread:?}"
        );
    }
    let finding = SwitchReads {
        finding_open: Some(true),
        ..READ_CLEAR
    };
    assert_eq!(
        rollback_path(&room, &finding),
        RollbackPath::Upload("rollback_finding_open")
    );
    let unread_finding = SwitchReads {
        finding_open: None,
        ..READ_CLEAR
    };
    assert_eq!(
        rollback_path(&room, &unread_finding),
        RollbackPath::Undecided("rollback_finding_unread")
    );
    // A read that fails definitely uploads again whatever else couldn't be read: an upload is always allowed.
    assert_eq!(
        rollback_path(
            &room,
            &SwitchReads {
                finding_open: None,
                script: Some(GONE)
            }
        ),
        RollbackPath::Upload("rollback_script_gone")
    );
    // The room's own facts come first, and need no read.
    for (facts, code) in [
        (KeptFacts { kept: None, ..room }, "rollback_not_kept"),
        (
            KeptFacts {
                current_label: None,
                ..room
            },
            "rollback_label_not_current",
        ),
        (
            KeptFacts {
                app_suspended: true,
                ..room
            },
            "rollback_suspended",
        ),
        (
            KeptFacts {
                queued_for_delete: true,
                ..room
            },
            "rollback_script_deleting",
        ),
    ] {
        let nothing = SwitchReads {
            finding_open: None,
            script: None,
        };
        assert_eq!(rollback_path(&facts, &nothing), RollbackPath::Upload(code));
    }
}

#[test]
fn waits_for_the_marker_of_the_release_whose_script_it_serves() {
    // An ordinary release: its own. A rollback switched to the kept script: that script's release.
    assert_eq!(marker_release(&script(R)), Some(R));
    assert_eq!(marker_release(&script(A)), Some(A));
    assert_eq!(marker_release("not-a-script"), None);
}

/// A room whose default host serves `B`, with `A` kept, and a custom host open on `B`.
fn serving_b_with_a_kept() -> ServeState {
    ServeState {
        epoch: 4,
        hosts: vec![
            DesiredServe {
                script: Some(script(B)),
                version: 7,
                closed: false,
            },
            DesiredServe {
                script: Some(script(B)),
                version: 3,
                closed: false,
            },
        ],
        kept_previous: Some(script(A)),
        in_flight: None,
    }
}

#[test]
fn a_switch_back_swaps_the_live_and_the_kept_script_and_deletes_neither() {
    let state = serving_b_with_a_kept();
    let (staged, mark) = rollback(&state, 4, true, R, ReleaseState::Uploading).unwrap();
    assert_eq!(staged.hosts[0].script.as_deref(), Some(script(A).as_str()));
    let flight = staged.in_flight.clone().unwrap();
    assert_eq!(
        (flight.release_id.as_str(), flight.script.as_str()),
        (R, script(A).as_str())
    );
    // While its marker is out, a custom host's entry holding the release being rolled away from isn't kept.
    assert!(!waiting_entry_keeps(&staged, &script(A), &script(B)));
    assert!(waiting_entry_keeps(&staged, &script(A), &script(A)));
    // Served: the release rolled away from becomes the kept one, and nothing is deleted.
    let confirmed = confirm_served(&staged, &mark, &script(A)).unwrap();
    assert_eq!(
        confirmed.state.kept_previous.as_deref(),
        Some(script(B).as_str())
    );
    assert_eq!(confirmed.after.delete, None);
    // Set back instead: the hosts go back to `B`, and the kept script, which the rollback's script is, isn't deleted.
    let back = set_back(&staged, &mark, &script(A)).unwrap();
    assert_eq!(
        back.state.hosts[0].script.as_deref(),
        Some(script(B).as_str())
    );
    assert_eq!(
        back.state.kept_previous.as_deref(),
        Some(script(A).as_str())
    );
    assert!(!back.delete_script);
}

#[test]
fn a_switch_back_needs_the_epoch_it_was_asked_under_and_no_other_flight() {
    let state = serving_b_with_a_kept();
    assert_eq!(
        rollback(&state, 3, true, R, ReleaseState::Uploading),
        Err(RollbackRefusal::Commit(CommitLiveRefusal::EpochMoved))
    );
    assert_eq!(
        rollback(&state, 4, false, R, ReleaseState::Uploading),
        Err(RollbackRefusal::NotKept)
    );
    let (other, _) = commit_live(&state, 4, &script(R), R, ReleaseState::Uploading).unwrap();
    assert_eq!(
        rollback(&other, 4, true, A, ReleaseState::Uploading),
        Err(RollbackRefusal::Commit(CommitLiveRefusal::InFlight))
    );
}
