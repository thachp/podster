#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

//! How `decide` treats a submission's stored files: they count as content and toward the limit, and approving a submission
//! that has them needs proof the room checked them.

use podster_core::files::ObjectState;
use podster_core::submission_files::{check_approval, PinnedFile, RoomFile};
use podster_core::TaskStatus::*;
use podster_core::*;

const HASH: &str = "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34";

fn task(status: TaskStatus) -> Task {
    Task {
        id: "t".into(),
        title: "title".into(),
        instructions: "instructions".into(),
        acceptance_criteria: None,
        requester: "req".into(),
        assignee: Some("asg".into()),
        reviewer: "rev".into(),
        status,
        version: 5,
        due_at: None,
        follow_up_of: None,
        has_linked_repository: false,
        submission_no: 2,
        submission_commit: None,
        approved_submission_no: None,
        submission_files: 0,
        assignee_departed: false,
        needs_reviewer: false,
        needs_requester: false,
    }
}

fn submit(links: usize) -> Command {
    Command::Submit {
        version: 5,
        artifacts: (0..links)
            .map(|i| Artifact {
                uri: format!("https://example.com/{i}"),
                label: "link".into(),
            })
            .collect(),
        note: None,
        commit_sha: None,
    }
}

fn with_files(count: usize) -> Observed {
    Observed {
        submission_files: count,
        ..Observed::default()
    }
}

fn verify(submission_no: u32) -> Command {
    Command::Verify {
        submission_no,
        commit_sha: None,
    }
}

/// Proof for `count` ready files, made the only way there is.
fn proof(submission_no: u32, count: usize) -> Observed {
    let ids: Vec<String> = (0..count).map(|i| format!("obj_{i}")).collect();
    let pinned: Vec<PinnedFile> = ids
        .iter()
        .map(|id| PinnedFile {
            object_id: id.clone(),
            sha256: HASH.into(),
            size: 1,
        })
        .collect();
    let current: Vec<RoomFile<'_>> = ids
        .iter()
        .map(|id| RoomFile {
            id,
            uploaded_by: "asg",
            for_task: Some("t"),
            state: ObjectState::Ready,
            removed: false,
            sha256: HASH,
            size: 1,
        })
        .collect();
    Observed {
        approved_files: Some(check_approval(submission_no, &pinned, &current).unwrap()),
        ..Observed::default()
    }
}

fn submitted_with_files(count: u32) -> Task {
    Task {
        submission_files: count,
        ..task(Submitted)
    }
}

// ---- submitting ----

#[test]
fn a_submission_of_files_alone_needs_no_link_or_note() {
    let decision = decide(&task(Accepted), "asg", submit(0), &with_files(1)).unwrap();
    assert_eq!(decision.task.status, Submitted);
    assert_eq!(decision.task.submission_files, 1);
}

#[test]
fn nothing_at_all_is_still_refused() {
    assert_eq!(
        decide(&task(Accepted), "asg", submit(0), &with_files(0)).unwrap_err(),
        CoreError::InvalidArgument("artifacts")
    );
}

#[test]
fn links_and_files_together_stay_within_the_limit() {
    let at_limit = decide(
        &task(Accepted),
        "asg",
        submit(MAX_ARTIFACTS - 3),
        &with_files(3),
    );
    assert_eq!(at_limit.unwrap().task.submission_files, 3);
    assert_eq!(
        decide(
            &task(Accepted),
            "asg",
            submit(MAX_ARTIFACTS - 3),
            &with_files(4)
        )
        .unwrap_err(),
        CoreError::InvalidArgument("artifacts")
    );
}

#[test]
fn a_new_submission_records_its_own_count_not_the_last_ones() {
    let before = Task {
        submission_files: 4,
        ..task(Accepted)
    };
    let decision = decide(&before, "asg", submit(1), &with_files(0)).unwrap();
    assert_eq!(decision.task.submission_files, 0);
}

// ---- approving ----

#[test]
fn approving_files_without_the_check_is_refused() {
    let task = submitted_with_files(2);
    assert_eq!(
        decide(&task, "rev", verify(2), &Observed::default()).unwrap_err(),
        CoreError::FilesNotChecked
    );
    assert_eq!(CoreError::FilesNotChecked.code(), "files_not_checked");
}

#[test]
fn proof_for_another_submission_or_another_count_is_refused() {
    let task = submitted_with_files(2);
    assert_eq!(
        decide(&task, "rev", verify(2), &proof(1, 2)).unwrap_err(),
        CoreError::FilesNotChecked
    );
    assert_eq!(
        decide(&task, "rev", verify(2), &proof(2, 1)).unwrap_err(),
        CoreError::FilesNotChecked
    );
    assert_eq!(
        decide(&task, "rev", verify(2), &proof(2, 0)).unwrap_err(),
        CoreError::FilesNotChecked
    );
}

#[test]
fn approving_files_with_the_check_completes_the_task() {
    let decision = decide(&submitted_with_files(2), "rev", verify(2), &proof(2, 2)).unwrap();
    assert_eq!(decision.task.status, Completed);
    assert_eq!(decision.task.approved_submission_no, Some(2));
}

#[test]
fn a_stale_number_still_says_so_before_anything_about_files() {
    assert_eq!(
        decide(
            &submitted_with_files(2),
            "rev",
            verify(1),
            &Observed::default()
        )
        .unwrap_err(),
        CoreError::SubmissionMismatch
    );
}

#[test]
fn a_submission_without_files_is_approved_as_before() {
    let decision = decide(&task(Submitted), "rev", verify(2), &Observed::default()).unwrap();
    assert_eq!(decision.task.status, Completed);
}

#[test]
fn requesting_changes_never_needs_the_check() {
    let changes = Command::RequestChanges {
        submission_no: 2,
        reason: "a file was blocked".into(),
    };
    let decision = decide(
        &submitted_with_files(2),
        "rev",
        changes,
        &Observed::default(),
    )
    .unwrap();
    assert_eq!(decision.task.status, Accepted);
}
