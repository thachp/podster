#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

//! M7 step 4: which of a task's prompt inputs a decision wrote, so the room can record who wrote each (RUNNER.md, "Prompt
//! inputs" and "The least-trusted author decides"; decision 228).

use podster_core::task_inputs::{written, PromptInput};
use podster_core::{decide, decide_create, Command, Decision, NewTask, Observed, TaskPatch};
use PromptInput::*;

fn created(criteria: Option<&str>) -> Decision {
    decide_create(
        "agt_lead",
        NewTask {
            id: "tsk_1".into(),
            title: "Design".into(),
            instructions: "Write it".into(),
            acceptance_criteria: criteria.map(str::to_string),
            assignee: Some("agt_bob".into()),
            reviewer: Some("agt_rev".into()),
            due_at: None,
            follow_up_of: None,
            has_linked_repository: false,
        },
    )
    .unwrap()
}

fn update(before: &Decision, patch: TaskPatch) -> Decision {
    decide(
        &before.task,
        "agt_lead",
        Command::Update {
            version: before.task.version,
            patch,
        },
        &Observed::default(),
    )
    .unwrap()
}

#[test]
fn names_are_fixed_and_round_trip() {
    let names: Vec<&str> = PromptInput::ALL.iter().map(|i| i.name()).collect();
    assert_eq!(
        names,
        [
            "title",
            "instructions",
            "acceptance_criteria",
            "change_request"
        ]
    );
    for input in PromptInput::ALL {
        assert_eq!(PromptInput::from_name(input.name()), Some(input));
    }
    for other in ["", "Title", "note", "due_at", "requester"] {
        assert_eq!(PromptInput::from_name(other), None, "{other}");
    }
}

#[test]
fn creating_a_task_writes_every_input_it_has() {
    let with = created(Some("Tests pass"));
    assert_eq!(
        written(None, &with),
        [Title, Instructions, AcceptanceCriteria]
    );
    // No criteria, so nobody wrote any.
    let without = created(None);
    assert_eq!(written(None, &without), [Title, Instructions]);
}

#[test]
fn an_update_writes_only_the_inputs_whose_text_changed() {
    let start = created(Some("Tests pass"));
    let title = update(
        &start,
        TaskPatch {
            title: Some("Design v2".into()),
            ..TaskPatch::default()
        },
    );
    assert_eq!(written(Some(&start.task), &title), [Title]);

    let both = update(
        &start,
        TaskPatch {
            instructions: Some("Write it again".into()),
            acceptance_criteria: Some("All tests pass".into()),
            ..TaskPatch::default()
        },
    );
    assert_eq!(
        written(Some(&start.task), &both),
        [Instructions, AcceptanceCriteria]
    );

    // Criteria added to a task that had none were written now.
    let bare = created(None);
    let added = update(
        &bare,
        TaskPatch {
            acceptance_criteria: Some("Tests pass".into()),
            ..TaskPatch::default()
        },
    );
    assert_eq!(written(Some(&bare.task), &added), [AcceptanceCriteria]);
}

#[test]
fn writing_the_same_text_again_writes_nothing() {
    let start = created(Some("Tests pass"));
    let same = update(
        &start,
        TaskPatch {
            title: Some("Design".into()),
            instructions: Some("Write it".into()),
            acceptance_criteria: Some("Tests pass".into()),
            ..TaskPatch::default()
        },
    );
    assert!(written(Some(&start.task), &same).is_empty());
    // A due date isn't a prompt input.
    let due = update(
        &start,
        TaskPatch {
            due_at: Some(1_900_000_000_000),
            ..TaskPatch::default()
        },
    );
    assert!(written(Some(&start.task), &due).is_empty());
}

#[test]
fn a_change_request_writes_the_change_request_and_nothing_else() {
    let start = created(Some("Tests pass"));
    let accepted = decide(
        &start.task,
        "agt_bob",
        Command::Accept { version: 1 },
        &Observed::default(),
    )
    .unwrap();
    let submitted = decide(
        &accepted.task,
        "agt_bob",
        Command::Submit {
            version: accepted.task.version,
            note: Some("done".into()),
            artifacts: vec![],
            commit_sha: None,
        },
        &Observed::default(),
    )
    .unwrap();
    assert!(written(Some(&accepted.task), &submitted).is_empty());
    let changes = decide(
        &submitted.task,
        "agt_rev",
        Command::RequestChanges {
            submission_no: 1,
            reason: "fix the tests".into(),
        },
        &Observed::default(),
    )
    .unwrap();
    assert_eq!(written(Some(&submitted.task), &changes), [ChangeRequest]);
}
