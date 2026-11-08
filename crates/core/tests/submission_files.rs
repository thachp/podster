#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::files::ObjectState::{self, *};
use podster_core::submission_files::*;
use podster_core::{TaskStatus, MAX_ARTIFACTS};
use ApprovalFileRefusal as A;
use SubmissionFileRefusal as S;

const HASH: &str = "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34";
const OTHER_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn file(id: &'static str, state: ObjectState) -> RoomFile<'static> {
    RoomFile {
        id,
        uploaded_by: "asg",
        for_task: Some("tsk_1"),
        state,
        removed: false,
        sha256: HASH,
        size: 42,
    }
}

fn pin(requested: &[&str], links: usize, found: &[RoomFile<'_>]) -> Result<Vec<PinnedFile>, S> {
    pin_submission_files("asg", "tsk_1", requested, links, found)
}

// ---- which files a submission may name ----

#[test]
fn ready_files_the_submitter_uploaded_for_this_task_are_pinned_in_the_order_named() {
    let found = [file("obj_b", Ready), file("obj_a", Ready)];
    let pinned = pin(&["obj_a", "obj_b"], 0, &found).unwrap();
    assert_eq!(
        pinned,
        vec![
            PinnedFile {
                object_id: "obj_a".into(),
                sha256: HASH.into(),
                size: 42
            },
            PinnedFile {
                object_id: "obj_b".into(),
                sha256: HASH.into(),
                size: 42
            },
        ]
    );
}

#[test]
fn no_files_is_allowed_and_pins_nothing() {
    assert_eq!(pin(&[], 3, &[]).unwrap(), vec![]);
}

#[test]
fn only_ready_counts() {
    for state in [Uploading, Scanning, Blocked, Failed] {
        assert_eq!(
            pin(&["obj_a"], 0, &[file("obj_a", state)]),
            Err(S::NotReady),
            "{state:?}"
        );
    }
}

#[test]
fn a_file_the_room_doesnt_have_is_not_found() {
    // Another room's file is never in `found`, because each room reads only its own rows.
    assert_eq!(
        pin(&["obj_elsewhere"], 0, &[file("obj_a", Ready)]),
        Err(S::NotFound)
    );
}

#[test]
fn someone_elses_file_answers_as_if_it_didnt_exist() {
    let theirs = RoomFile {
        uploaded_by: "other",
        ..file("obj_a", Ready)
    };
    assert_eq!(pin(&["obj_a"], 0, &[theirs]), Err(S::NotFound));
    // Even when it isn't ready, so the answer can't tell its state either.
    let theirs_scanning = RoomFile {
        uploaded_by: "other",
        ..file("obj_a", Scanning)
    };
    assert_eq!(pin(&["obj_a"], 0, &[theirs_scanning]), Err(S::NotFound));
}

#[test]
fn a_file_uploaded_for_another_task_or_as_an_input_asset_is_not_found() {
    let other_task = RoomFile {
        for_task: Some("tsk_2"),
        ..file("obj_a", Ready)
    };
    assert_eq!(pin(&["obj_a"], 0, &[other_task]), Err(S::NotFound));
    let input_asset = RoomFile {
        for_task: None,
        ..file("obj_a", Ready)
    };
    assert_eq!(pin(&["obj_a"], 0, &[input_asset]), Err(S::NotFound));
}

#[test]
fn a_removed_file_is_refused_even_if_it_was_ready() {
    let removed = RoomFile {
        removed: true,
        ..file("obj_a", Ready)
    };
    assert_eq!(pin(&["obj_a"], 0, &[removed]), Err(S::Removed));
}

#[test]
fn a_row_without_a_real_hash_cant_be_pinned() {
    for bad in ["", "ABCD", &HASH[1..]] {
        let row = RoomFile {
            sha256: bad,
            ..file("obj_a", Ready)
        };
        assert_eq!(pin(&["obj_a"], 0, &[row]), Err(S::NotReady), "{bad:?}");
    }
}

#[test]
fn the_same_file_twice_is_refused() {
    assert_eq!(
        pin(&["obj_a", "obj_a"], 0, &[file("obj_a", Ready)]),
        Err(S::Duplicate)
    );
}

#[test]
fn links_and_files_share_one_limit() {
    let ids: Vec<String> = (0..MAX_ARTIFACTS).map(|i| format!("obj_{i}")).collect();
    let found: Vec<RoomFile<'_>> = ids
        .iter()
        .map(|id| RoomFile {
            id,
            ..file("unused", Ready)
        })
        .collect();
    let all: Vec<&str> = ids.iter().map(String::as_str).collect();
    assert_eq!(pin(&all, 0, &found).unwrap().len(), MAX_ARTIFACTS);
    assert_eq!(pin(&all, 1, &found), Err(S::TooMany));
    assert_eq!(
        pin(&all[..MAX_ARTIFACTS - 2], 2, &found).unwrap().len(),
        MAX_ARTIFACTS - 2
    );
    assert_eq!(pin(&all[..MAX_ARTIFACTS - 2], 3, &found), Err(S::TooMany));
}

#[test]
fn the_first_bad_file_decides_and_nothing_is_pinned() {
    let found = [file("obj_a", Ready), file("obj_b", Scanning)];
    assert_eq!(pin(&["obj_a", "obj_b"], 0, &found), Err(S::NotReady));
    // Two bad files: the one named first decides, whichever way round.
    let found = [file("obj_scanning", Scanning)];
    assert_eq!(
        pin(&["obj_scanning", "obj_missing"], 0, &found),
        Err(S::NotReady)
    );
    assert_eq!(
        pin(&["obj_missing", "obj_scanning"], 0, &found),
        Err(S::NotFound)
    );
}

#[test]
fn someone_elses_removed_file_answers_as_if_it_didnt_exist() {
    let theirs = RoomFile {
        uploaded_by: "other",
        removed: true,
        ..file("obj_a", Ready)
    };
    assert_eq!(pin(&["obj_a"], 0, &[theirs]), Err(S::NotFound));
}

#[test]
fn a_duplicate_is_refused_even_when_not_next_to_its_twin() {
    let found = [file("a", Ready), file("b", Ready)];
    assert_eq!(pin(&["a", "b", "a"], 0, &found), Err(S::Duplicate));
}

#[test]
fn a_removed_file_says_removed_whatever_its_scan_state() {
    for state in [Uploading, Scanning, Blocked, Failed] {
        let removed = RoomFile {
            removed: true,
            ..file("obj_a", state)
        };
        assert_eq!(pin(&["obj_a"], 0, &[removed]), Err(S::Removed), "{state:?}");
    }
}

#[test]
fn uploads_for_a_submission_start_only_while_the_task_waits_for_one() {
    for status in TaskStatus::ALL {
        assert_eq!(
            accepts_submission_uploads(status),
            status == TaskStatus::Accepted,
            "{status:?}"
        );
    }
}

#[test]
fn refusal_codes_are_stable() {
    assert_eq!(S::TooMany.code(), "too_many_artifacts");
    assert_eq!(S::Duplicate.code(), "duplicate_file");
    assert_eq!(S::NotFound.code(), "file_not_found");
    assert_eq!(S::NotReady.code(), "file_not_ready");
    assert_eq!(S::Removed.code(), "file_removed");
    assert_eq!(A::NotReady.code(), "file_not_ready");
    assert_eq!(A::Removed.code(), "file_removed");
    assert_eq!(A::Changed.code(), "file_changed");
}

// ---- approving the exact versions pinned ----

fn pinned(id: &str) -> PinnedFile {
    PinnedFile {
        object_id: id.into(),
        sha256: HASH.into(),
        size: 42,
    }
}

#[test]
fn approval_passes_when_every_pinned_file_is_unchanged_and_ready() {
    let current = [file("obj_a", Ready), file("obj_b", Ready)];
    let proof = check_approval("tsk_1", 4, &[pinned("obj_a"), pinned("obj_b")], &current).unwrap();
    // The proof names the submission and how many files it checked, which `decide` compares with the task.
    assert_eq!((proof.submission_no(), proof.count()), (4, 2));
}

#[test]
fn a_submission_with_no_files_can_be_approved_as_today() {
    let proof = check_approval("tsk_1", 1, &[], &[]).unwrap();
    assert_eq!((proof.submission_no(), proof.count()), (1, 0));
}

#[test]
fn a_file_blocked_after_submitting_stops_approval() {
    // A late report can block a Ready file, and the files can't be read until then.
    let current = [file("obj_a", Ready), file("obj_b", Blocked)];
    assert_eq!(
        check_approval("tsk_1", 1, &[pinned("obj_a"), pinned("obj_b")], &current),
        Err(A::NotReady)
    );
    for state in [Uploading, Scanning, Failed] {
        assert_eq!(
            check_approval("tsk_1", 1, &[pinned("obj_a")], &[file("obj_a", state)]),
            Err(A::NotReady),
            "{state:?}"
        );
    }
}

#[test]
fn a_removed_file_stops_approval() {
    let removed = RoomFile {
        removed: true,
        ..file("obj_a", Ready)
    };
    assert_eq!(
        check_approval("tsk_1", 1, &[pinned("obj_a")], &[removed]),
        Err(A::Removed)
    );
}

#[test]
fn anything_but_the_pinned_bytes_fails_closed() {
    assert_eq!(
        check_approval("tsk_1", 1, &[pinned("obj_a")], &[]),
        Err(A::Changed)
    );
    let other_hash = RoomFile {
        sha256: OTHER_HASH,
        ..file("obj_a", Ready)
    };
    assert_eq!(
        check_approval("tsk_1", 1, &[pinned("obj_a")], &[other_hash]),
        Err(A::Changed)
    );
    let other_size = RoomFile {
        size: 43,
        ..file("obj_a", Ready)
    };
    assert_eq!(
        check_approval("tsk_1", 1, &[pinned("obj_a")], &[other_size]),
        Err(A::Changed)
    );
}

#[test]
fn changed_bytes_say_changed_even_when_also_not_ready() {
    for state in [Uploading, Scanning, Blocked, Failed] {
        let both = RoomFile {
            sha256: OTHER_HASH,
            ..file("obj_a", state)
        };
        assert_eq!(
            check_approval("tsk_1", 1, &[pinned("obj_a")], &[both]),
            Err(A::Changed),
            "{state:?}"
        );
    }
}

#[test]
fn approval_ignores_files_the_submission_doesnt_name() {
    // A blocked file on an earlier submission, or another task, says nothing about this one.
    let current = [file("obj_a", Ready), file("obj_old", Blocked)];
    assert!(check_approval("tsk_1", 1, &[pinned("obj_a")], &current).is_ok());
}

#[test]
fn the_proof_names_the_task_it_checked() {
    let proof = check_approval("tsk_9", 3, &[], &[]).unwrap();
    assert_eq!(proof.task_id(), "tsk_9");
}

#[test]
fn one_uploader_holds_at_most_ten_unsubmitted_files_for_a_task() {
    assert_eq!(MAX_UNSUBMITTED_FILES_PER_TASK, podster_core::MAX_ARTIFACTS);
    assert!(fits_unsubmitted_cap(0));
    assert!(fits_unsubmitted_cap(MAX_UNSUBMITTED_FILES_PER_TASK - 1));
    assert!(!fits_unsubmitted_cap(MAX_UNSUBMITTED_FILES_PER_TASK));
}

#[test]
fn a_file_label_follows_the_link_label_rule() {
    use podster_core::{CoreError, MAX_LABEL_BYTES};
    assert_eq!(check_file_label(None), Ok(()));
    assert_eq!(check_file_label(Some("Final report")), Ok(()));
    assert_eq!(check_file_label(Some(&"x".repeat(MAX_LABEL_BYTES))), Ok(()));
    for bad in ["", "   ", &"x".repeat(MAX_LABEL_BYTES + 1)] {
        assert_eq!(
            check_file_label(Some(bad)),
            Err(CoreError::InvalidArgument("label")),
            "{bad:?}"
        );
    }
}
