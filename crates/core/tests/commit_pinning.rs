#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::*;
use TaskStatus::*;

fn abc() -> String {
    "ab".repeat(20)
}

fn def() -> String {
    "de".repeat(20)
}

fn task(status: TaskStatus, linked: bool) -> Task {
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
        has_linked_repository: linked,
        submission_no: 0,
        submission_commit: None,
        approved_submission_no: None,
        submission_files: 0,
        assignee_departed: false,
        needs_reviewer: false,
        needs_requester: false,
    }
}

fn submit(version: u64, sha: Option<&str>) -> Command {
    Command::Submit {
        version,
        artifacts: vec![],
        note: Some("done".into()),
        commit_sha: sha.map(Into::into),
    }
}

fn verify(submission_no: u32, sha: Option<&str>) -> Command {
    Command::Verify {
        submission_no,
        commit_sha: sha.map(Into::into),
    }
}

fn head(sha: &str) -> Observed {
    Observed {
        head_sha: Some(sha.into()),
        ..Observed::default()
    }
}

fn submitted(sha: &str) -> Task {
    decide(
        &task(Accepted, true),
        "asg",
        submit(5, Some(sha)),
        &Observed::default(),
    )
    .unwrap()
    .task
}

#[test]
fn a_linked_task_takes_only_a_full_commit_id_on_submit_and_verify() {
    let long = "a".repeat(41);
    let upper = "AB".repeat(20);
    let bad: [Option<&str>; 8] = [
        None,
        Some(""),
        Some("main"),
        Some("abc"),
        Some("a1b2c3d"),
        Some("refs/heads/main"),
        Some(&long),
        Some(&upper),
    ];
    let waiting = submitted(&abc());
    for sha in bad {
        assert_eq!(
            decide(
                &task(Accepted, true),
                "asg",
                submit(5, sha),
                &Observed::default()
            )
            .unwrap_err(),
            CoreError::InvalidArgument("commit_sha"),
            "submit {sha:?}"
        );
        assert_eq!(
            decide(&waiting, "rev", verify(1, sha), &Observed::default()).unwrap_err(),
            CoreError::InvalidArgument("commit_sha"),
            "verify {sha:?}"
        );
    }
    for sha in [abc(), "0f".repeat(32)] {
        let next = decide(
            &task(Accepted, true),
            "asg",
            submit(5, Some(&sha)),
            &Observed::default(),
        )
        .unwrap()
        .task;
        assert_eq!(next.submission_commit.as_deref(), Some(sha.as_str()));
    }
}

#[test]
fn a_task_with_no_linked_repository_needs_no_commit() {
    let plain = task(Accepted, false);
    for sha in [None, Some("abc")] {
        let next = decide(&plain, "asg", submit(5, sha), &Observed::default())
            .unwrap()
            .task;
        assert_eq!(next.status, Submitted, "{sha:?}");
        assert_eq!(
            decide(&next, "rev", verify(1, None), &Observed::default())
                .unwrap()
                .task
                .status,
            Completed
        );
    }
}

#[test]
fn a_submission_records_its_commit_and_changes_requested_needs_none() {
    let waiting = submitted(&abc());
    assert_eq!(waiting.submission_no, 1);
    assert_eq!(waiting.submission_commit, Some(abc()));
    let back = decide(
        &waiting,
        "rev",
        Command::RequestChanges {
            submission_no: 1,
            reason: "tests fail".into(),
        },
        &Observed::default(),
    )
    .unwrap()
    .task;
    assert_eq!(back.status, Accepted);
}

#[test]
fn a_submission_cant_name_a_commit_the_branch_isnt_at() {
    assert_eq!(
        decide(
            &task(Accepted, true),
            "asg",
            submit(5, Some(&abc())),
            &head(&def())
        )
        .unwrap_err(),
        CoreError::CommitChanged
    );
}

/// AC-31 and M5-08: the submission records commit abc, the branch advances to def, and the reviewer approves.
#[test]
fn ac_31_approval_cant_bind_to_a_commit_the_branch_moved_to() {
    let waiting = submitted(&abc());
    // The reviewer names the commit they looked at, and the head has moved.
    assert_eq!(
        decide(&waiting, "rev", verify(1, Some(&abc())), &head(&def())).unwrap_err(),
        CoreError::CommitChanged
    );
    // The reviewer names the new head, with or without an observation of it.
    for observed in [Observed::default(), head(&def()), head(&abc())] {
        assert_eq!(
            decide(&waiting, "rev", verify(1, Some(&def())), &observed).unwrap_err(),
            CoreError::CommitChanged,
            "{observed:?}"
        );
    }
    // Before approval, a moved head means the agent submits again, as a new numbered submission with its own commit.
    let again = decide(
        &waiting,
        "rev",
        Command::RequestChanges {
            submission_no: 1,
            reason: "the branch moved".into(),
        },
        &Observed::default(),
    )
    .unwrap()
    .task;
    let second = decide(
        &again,
        "asg",
        submit(again.version, Some(&def())),
        &head(&def()),
    )
    .unwrap()
    .task;
    assert_eq!(
        (second.submission_no, second.submission_commit.clone()),
        (2, Some(def()))
    );
    // The first submission's approval no longer fits, by number or by commit.
    assert_eq!(
        decide(&second, "rev", verify(1, Some(&abc())), &head(&def())).unwrap_err(),
        CoreError::SubmissionMismatch
    );
    assert_eq!(
        decide(&second, "rev", verify(2, Some(&abc())), &head(&def())).unwrap_err(),
        CoreError::CommitChanged
    );
    let done = decide(&second, "rev", verify(2, Some(&def())), &head(&def()))
        .unwrap()
        .task;
    assert_eq!(
        (done.status, done.approved_submission_no),
        (Completed, Some(2))
    );
}

/// AC-17: approval completes the task and is one event. It asks for no merge, and a completed task takes no command
/// that could change what was reviewed.
#[test]
fn ac_17_approval_alone_never_merges() {
    let waiting = submitted(&abc());
    let approved = decide(&waiting, "rev", verify(1, Some(&abc())), &head(&abc())).unwrap();
    assert_eq!(
        approved
            .events
            .iter()
            .map(|e| e.kind.name())
            .collect::<Vec<_>>(),
        ["task.completed"]
    );
    assert_eq!(approved.task.submission_commit, Some(abc()));
    assert_eq!(
        decide(
            &approved.task,
            "asg",
            submit(approved.task.version, Some(&def())),
            &Observed::default()
        )
        .unwrap_err(),
        CoreError::InvalidTransition
    );
    assert_eq!(
        decide(
            &approved.task,
            "rev",
            verify(1, Some(&abc())),
            &Observed::default()
        )
        .unwrap_err(),
        CoreError::InvalidTransition
    );
}
