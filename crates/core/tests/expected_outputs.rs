#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::expected_outputs::*;
use podster_core::files::ObjectState::{self, *};
use podster_core::submission_files::RoomFile;
use podster_core::{decide, decide_create, Artifact, Command, NewTask, Observed, Task, TaskStatus};
use OutputRefusal as R;

const HASH: &str = "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34";

// Built through `decide_create` and `decide`, so these tests don't list `Task`'s fields and keep compiling as it grows.
fn created() -> Task {
    decide_create(
        "req",
        NewTask {
            id: "tsk_1".into(),
            title: "Write the report".into(),
            instructions: "Do it".into(),
            acceptance_criteria: None,
            assignee: Some("asg".into()),
            reviewer: Some("rev".into()),
            due_at: None,
            follow_up_of: None,
            has_linked_repository: false,
        },
    )
    .unwrap()
    .task
}

fn step(task: &Task, actor: &str, command: Command) -> Task {
    decide(task, actor, command, &Observed::default())
        .unwrap()
        .task
}

fn accepted() -> Task {
    let offered = created();
    step(
        &offered,
        "asg",
        Command::Accept {
            version: offered.version,
        },
    )
}

fn submitted() -> Task {
    let task = accepted();
    step(
        &task,
        "asg",
        Command::Submit {
            version: task.version,
            artifacts: vec![Artifact {
                uri: "https://example.com/report".into(),
                label: "Report".into(),
            }],
            note: None,
            commit_sha: None,
        },
    )
}

fn completed() -> Task {
    let task = submitted();
    step(
        &task,
        "rev",
        Command::Verify {
            submission_no: task.submission_no,
            commit_sha: None,
        },
    )
}

fn file(id: &'static str, state: ObjectState, removed: bool) -> RoomFile<'static> {
    RoomFile {
        id,
        uploaded_by: "asg",
        for_task: Some("tsk_1"),
        state,
        removed,
        sha256: HASH,
        size: 42,
    }
}

// Defining, editing and removing.

#[test]
fn an_output_needs_a_title_within_limits() {
    assert_eq!(decide_define(false, 0, "Final report", None), Ok(()));
    assert_eq!(
        decide_define(false, 0, "Final report", Some("A PDF for the board")),
        Ok(())
    );
    assert_eq!(
        decide_define(false, 0, "   ", None),
        Err(R::InvalidArgument("title"))
    );
    let long_title = "x".repeat(MAX_OUTPUT_TITLE_BYTES + 1);
    assert_eq!(
        decide_define(false, 0, &long_title, None),
        Err(R::InvalidArgument("title"))
    );
    assert_eq!(
        decide_define(false, 0, &"x".repeat(MAX_OUTPUT_TITLE_BYTES), None),
        Ok(())
    );
}

#[test]
fn a_description_is_optional_but_not_blank_or_too_long() {
    assert_eq!(
        decide_define(false, 0, "Report", Some("")),
        Err(R::InvalidArgument("description"))
    );
    let long = "x".repeat(MAX_OUTPUT_DESCRIPTION_BYTES + 1);
    assert_eq!(
        decide_define(false, 0, "Report", Some(&long)),
        Err(R::InvalidArgument("description"))
    );
    assert_eq!(
        decide_edit(false, "Report", Some(&long)),
        Err(R::InvalidArgument("description"))
    );
    let at_limit = "x".repeat(MAX_OUTPUT_DESCRIPTION_BYTES);
    assert_eq!(MAX_OUTPUT_DESCRIPTION_BYTES, 4096);
    assert_eq!(decide_define(false, 0, "Report", Some(&at_limit)), Ok(()));
    assert_eq!(decide_edit(false, "Report", Some(&at_limit)), Ok(()));
}

#[test]
fn limits_count_bytes_not_characters() {
    // 101 characters, 202 bytes: under the title limit in characters, over it in bytes.
    let accented = "é".repeat(101);
    assert_eq!(accented.chars().count(), 101);
    assert_eq!(accented.len(), 202);
    assert_eq!(
        decide_define(false, 0, &accented, None),
        Err(R::InvalidArgument("title"))
    );
    assert_eq!(
        decide_edit(false, &accented, None),
        Err(R::InvalidArgument("title"))
    );
    // 100 of them is exactly 200 bytes, which fits.
    assert_eq!(decide_define(false, 0, &"é".repeat(100), None), Ok(()));
    let accented_description = "é".repeat(MAX_OUTPUT_DESCRIPTION_BYTES / 2 + 1);
    assert_eq!(
        decide_define(false, 0, "Report", Some(&accented_description)),
        Err(R::InvalidArgument("description"))
    );
}

#[test]
fn a_room_holds_at_most_the_limit() {
    assert_eq!(
        decide_define(false, MAX_EXPECTED_OUTPUTS - 1, "One more", None),
        Ok(())
    );
    assert_eq!(
        decide_define(false, MAX_EXPECTED_OUTPUTS, "Too many", None),
        Err(R::TooMany)
    );
}

#[test]
fn an_archived_room_refuses_every_change() {
    assert_eq!(decide_define(true, 0, "Report", None), Err(R::RoomArchived));
    assert_eq!(decide_edit(true, "Report", None), Err(R::RoomArchived));
    assert_eq!(decide_remove(true, 0, false), Err(R::RoomArchived));
    assert_eq!(
        decide_link(
            true,
            TaskStatus::Open,
            5,
            Some(5),
            None,
            Some("out_1"),
            true
        ),
        Err(R::RoomArchived)
    );
    assert_eq!(R::RoomArchived.code(), "workspace_archived");
}

#[test]
fn renaming_is_allowed_and_checked() {
    assert_eq!(decide_edit(false, "Board report", None), Ok(()));
    assert_eq!(
        decide_edit(false, "", None),
        Err(R::InvalidArgument("title"))
    );
    assert_eq!(
        decide_edit(false, &"x".repeat(MAX_OUTPUT_TITLE_BYTES), None),
        Ok(())
    );
    assert_eq!(
        decide_edit(false, &"x".repeat(MAX_OUTPUT_TITLE_BYTES + 1), None),
        Err(R::InvalidArgument("title"))
    );
}

#[test]
fn only_an_output_no_live_task_names_and_never_ready_can_be_removed() {
    assert_eq!(decide_remove(false, 0, false), Ok(()));
    assert_eq!(decide_remove(false, 1, false), Err(R::InUse));
    assert_eq!(decide_remove(false, 0, true), Err(R::InUse));
    assert_eq!(R::InUse.code(), "output_in_use");
}

// Naming an output on a task.

#[test]
fn a_task_can_name_an_output_before_it_is_submitted() {
    for status in [TaskStatus::Open, TaskStatus::Offered, TaskStatus::Accepted] {
        assert_eq!(
            decide_link(false, status, 5, Some(5), None, Some("out_1"), true),
            Ok(LinkChange::Set("out_1".into())),
            "{status:?}"
        );
        assert_eq!(
            decide_link(
                false,
                status,
                5,
                Some(5),
                Some("out_1"),
                Some("out_2"),
                true
            ),
            Ok(LinkChange::Set("out_2".into())),
            "{status:?}"
        );
        assert_eq!(
            decide_link(false, status, 5, Some(5), Some("out_1"), None, false),
            Ok(LinkChange::Cleared),
            "{status:?}"
        );
    }
}

#[test]
fn a_submitted_or_finished_task_keeps_its_output() {
    for status in [
        TaskStatus::Submitted,
        TaskStatus::Completed,
        TaskStatus::Canceled,
    ] {
        assert_eq!(
            decide_link(
                false,
                status,
                5,
                Some(5),
                Some("out_1"),
                Some("out_2"),
                true
            ),
            Err(R::InvalidTransition),
            "{status:?}"
        );
        assert_eq!(
            decide_link(false, status, 5, Some(5), Some("out_1"), None, false),
            Err(R::InvalidTransition),
            "{status:?}"
        );
        assert_eq!(
            decide_link(false, status, 5, Some(5), None, Some("out_1"), true),
            Err(R::InvalidTransition),
            "{status:?}"
        );
    }
}

#[test]
fn asking_for_what_it_already_names_changes_nothing_in_any_status() {
    for status in TaskStatus::ALL {
        assert_eq!(
            decide_link(
                false,
                status,
                5,
                Some(5),
                Some("out_1"),
                Some("out_1"),
                true
            ),
            Ok(LinkChange::Unchanged)
        );
        assert_eq!(
            decide_link(false, status, 5, Some(5), None, None, false),
            Ok(LinkChange::Unchanged)
        );
    }
}

#[test]
fn naming_an_output_the_room_lacks_is_not_found() {
    assert_eq!(
        decide_link(
            false,
            TaskStatus::Open,
            5,
            Some(5),
            None,
            Some("out_x"),
            false
        ),
        Err(R::NotFound)
    );
    assert_eq!(R::NotFound.code(), "output_not_found");
}

// Approval and what doesn't count as one.

#[test]
fn approving_a_task_that_names_an_output_makes_its_submission_the_current_version() {
    let task = completed();
    assert_eq!(task.status, TaskStatus::Completed);
    assert_eq!(
        version_from_approval(&task, Some("out_1"), 1, 1_700),
        Some(OutputVersion {
            output_id: "out_1".into(),
            task_id: "tsk_1".into(),
            submission_no: task.approved_submission_no.unwrap(),
            approved_at: 1_700,
        })
    );
}

#[test]
fn approving_a_task_that_names_no_output_records_nothing() {
    assert_eq!(version_from_approval(&completed(), None, 1, 1_700), None);
}

#[test]
fn an_approval_with_no_artifact_does_not_make_an_output_ready() {
    assert_eq!(
        version_from_approval(&completed(), Some("out_1"), 0, 1_700),
        None
    );
}

#[test]
fn request_changes_records_no_version_and_stops_counting_as_in_review() {
    let task = submitted();
    assert_eq!(output_status(false, &[task.status]), OutputStatus::InReview);
    let returned = step(
        &task,
        "rev",
        Command::RequestChanges {
            submission_no: task.submission_no,
            reason: "Needs a summary".into(),
        },
    );
    assert_eq!(returned.status, TaskStatus::Accepted);
    assert_eq!(version_from_approval(&returned, Some("out_1"), 1, 1), None);
    assert_eq!(
        output_status(false, &[returned.status]),
        OutputStatus::NotStarted
    );
}

#[test]
fn a_canceled_task_records_no_version_and_never_counts_as_in_review() {
    let task = submitted();
    let canceled = step(
        &task,
        "req",
        Command::Cancel {
            version: task.version,
            reason: "No longer needed".into(),
        },
    );
    assert_eq!(canceled.status, TaskStatus::Canceled);
    assert_eq!(version_from_approval(&canceled, Some("out_1"), 1, 1), None);
    assert_eq!(
        output_status(false, &[canceled.status]),
        OutputStatus::NotStarted
    );
    // A Ready output stays Ready when a follow-up naming it is canceled.
    assert_eq!(
        output_status(true, &[TaskStatus::Completed, canceled.status]),
        OutputStatus::Ready
    );
}

#[test]
fn tasks_that_are_not_completed_record_no_version_even_with_a_number() {
    // A stale approved number on a task that isn't completed must not count.
    let mut task = completed();
    for status in [
        TaskStatus::Open,
        TaskStatus::Offered,
        TaskStatus::Accepted,
        TaskStatus::Submitted,
        TaskStatus::Canceled,
    ] {
        task.status = status;
        assert_eq!(
            version_from_approval(&task, Some("out_1"), 1, 1),
            None,
            "{status:?}"
        );
    }
    let mut unapproved = completed();
    unapproved.approved_submission_no = None;
    assert_eq!(
        version_from_approval(&unapproved, Some("out_1"), 1, 1),
        None
    );
}

// Status.

#[test]
fn status_follows_the_version_then_review() {
    assert_eq!(output_status(false, &[]), OutputStatus::NotStarted);
    assert_eq!(
        output_status(false, &[TaskStatus::Open, TaskStatus::Accepted]),
        OutputStatus::NotStarted
    );
    assert_eq!(
        output_status(false, &[TaskStatus::Accepted, TaskStatus::Submitted]),
        OutputStatus::InReview
    );
    assert_eq!(output_status(true, &[]), OutputStatus::Ready);
    // A follow-up in review doesn't take Ready away.
    assert_eq!(
        output_status(true, &[TaskStatus::Completed, TaskStatus::Submitted]),
        OutputStatus::Ready
    );
    assert_eq!(OutputStatus::NotStarted.name(), "not_started");
    assert_eq!(OutputStatus::InReview.name(), "in_review");
    assert_eq!(OutputStatus::Ready.name(), "ready");
}

#[test]
fn ready_count_counts_outputs_with_a_version() {
    assert_eq!(ready_count(&[]), (0, 0));
    assert_eq!(ready_count(&[true, false, true]), (2, 3));
}

// The current version's files.

#[test]
fn a_version_of_links_only_is_available() {
    assert!(current_files_available(&[], &[]));
}

#[test]
fn a_version_whose_files_are_ready_is_available() {
    let files = [file("obj_1", Ready, false), file("obj_2", Ready, false)];
    assert!(current_files_available(&["obj_1", "obj_2"], &files));
}

#[test]
fn a_file_blocked_or_removed_after_approval_makes_the_version_unavailable() {
    assert!(!current_files_available(
        &["obj_1", "obj_2"],
        &[file("obj_1", Ready, false), file("obj_2", Blocked, false)]
    ));
    assert!(!current_files_available(
        &["obj_1"],
        &[file("obj_1", Ready, true)]
    ));
    for state in [Uploading, Scanning, Failed] {
        assert!(!current_files_available(
            &["obj_1"],
            &[file("obj_1", state, false)]
        ));
    }
}

#[test]
fn a_missing_row_fails_closed() {
    assert!(!current_files_available(
        &["obj_1", "obj_2"],
        &[file("obj_1", Ready, false)]
    ));
}

#[test]
fn refusal_codes_are_stable() {
    assert_eq!(R::InvalidArgument("title").code(), "invalid_argument");
    assert_eq!(R::TooMany.code(), "too_many_outputs");
    assert_eq!(R::InvalidTransition.code(), "invalid_transition");
}

#[test]
fn a_stale_version_is_refused_before_anything_else() {
    for status in TaskStatus::ALL {
        assert_eq!(
            decide_link(false, status, 5, Some(4), None, Some("out_1"), true),
            Err(R::VersionConflict),
            "{status:?}"
        );
        // Even asking for what it already names.
        assert_eq!(
            decide_link(
                false,
                status,
                5,
                Some(6),
                Some("out_1"),
                Some("out_1"),
                true
            ),
            Err(R::VersionConflict),
            "{status:?}"
        );
    }
    assert_eq!(R::VersionConflict.code(), "version_conflict");
    // Naming one as the task is created has no older version to check.
    assert_eq!(
        decide_link(false, TaskStatus::Open, 1, None, None, Some("out_1"), true),
        Ok(LinkChange::Set("out_1".into()))
    );
}

#[test]
fn a_real_change_moves_the_version_and_unchanged_does_not() {
    let set = LinkChange::Set("out_1".into());
    assert!(set.moves_version());
    assert_eq!(set.next_version(5), 6);
    assert!(LinkChange::Cleared.moves_version());
    assert_eq!(LinkChange::Cleared.next_version(5), 6);
    assert!(!LinkChange::Unchanged.moves_version());
    assert_eq!(LinkChange::Unchanged.next_version(5), 5);
}

#[test]
fn after_changes_are_requested_the_output_can_change_again() {
    let task = submitted();
    let returned = step(
        &task,
        "rev",
        Command::RequestChanges {
            submission_no: task.submission_no,
            reason: "Wrong output".into(),
        },
    );
    assert_eq!(
        decide_link(
            false,
            returned.status,
            returned.version,
            Some(returned.version),
            Some("out_1"),
            Some("out_2"),
            true
        ),
        Ok(LinkChange::Set("out_2".into()))
    );
}
