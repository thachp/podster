#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::{decide_create, NewTask, Task};
use podster_policy::outputs::*;
use podster_policy::*;
use PrincipalKind::*;

// Built through `decide_create`, so this keeps compiling as `Task` grows.
fn task(requester: &str, assignee: &str, reviewer: &str) -> Task {
    decide_create(
        requester,
        NewTask {
            id: "t".into(),
            title: "x".into(),
            instructions: "y".into(),
            acceptance_criteria: None,
            assignee: Some(assignee.into()),
            reviewer: Some(reviewer.into()),
            due_at: None,
            follow_up_of: None,
            has_linked_repository: false,
        },
    )
    .unwrap()
    .task
}

fn someone(kind: PrincipalKind, role: Role, scopes: Scopes) -> Caller {
    Caller {
        id: "me".into(),
        kind,
        role,
        scopes,
    }
}

#[test]
fn only_human_owners_and_admins_manage_outputs() {
    for role in [Role::Owner, Role::Admin] {
        assert_eq!(
            authorize_manage_outputs(&someone(Person, role, Scopes::PUBLIC_PARTICIPANT)),
            Verdict::Allow,
            "{role:?}"
        );
    }
    for (who, caller) in [
        ("member", someone(Person, Role::Member, Scopes::MEMBER)),
        (
            "coordinator",
            someone(Person, Role::Member, Scopes::COORDINATOR),
        ),
        ("guest", someone(Person, Role::Guest, Scopes::GUEST)),
        // The lead comes later (decision 54), and an agent stored as an admin is a guest.
        (
            "agent admin",
            someone(Agent, Role::Admin, Scopes::COORDINATOR),
        ),
        (
            "agent owner",
            someone(Agent, Role::Owner, Scopes::COORDINATOR),
        ),
        (
            "agent coordinator",
            someone(Agent, Role::Member, Scopes::COORDINATOR),
        ),
    ] {
        assert_eq!(
            authorize_manage_outputs(&caller),
            Verdict::Forbidden,
            "{who}"
        );
    }
    assert_eq!(
        authorize_manage_outputs(&someone(Person, Role::None, Scopes::MEMBER)),
        Verdict::NotParticipant
    );
}

#[test]
fn a_tasks_requester_or_a_human_admin_names_its_output() {
    let requester_agent = someone(Agent, Role::Member, Scopes::MEMBER);
    assert_eq!(
        authorize_output_link(&requester_agent, &task("me", "asg", "rev")),
        Verdict::Allow
    );
    // A guest who created its own task is its requester (decision 54 says requesters link).
    let guest_requester = someone(
        Agent,
        Role::Guest,
        Scopes {
            tasks: TaskScope::OwnCreate,
            ..Scopes::GUEST
        },
    );
    assert_eq!(
        authorize_output_link(&guest_requester, &task("me", "asg", "rev")),
        Verdict::Allow
    );
    for role in [Role::Owner, Role::Admin] {
        assert_eq!(
            authorize_output_link(
                &someone(Person, role, Scopes::PUBLIC_PARTICIPANT),
                &task("req", "asg", "rev")
            ),
            Verdict::Allow,
            "{role:?}"
        );
    }
}

#[test]
fn assignees_reviewers_and_other_members_do_not_name_it() {
    let member = someone(Agent, Role::Member, Scopes::COORDINATOR);
    for t in [
        task("req", "me", "rev"),
        task("req", "asg", "me"),
        task("req", "asg", "rev"),
    ] {
        assert_eq!(authorize_output_link(&member, &t), Verdict::Forbidden);
    }
    let agent_admin = someone(Agent, Role::Admin, Scopes::COORDINATOR);
    assert_eq!(
        authorize_output_link(&agent_admin, &task("req", "me", "rev")),
        Verdict::Forbidden
    );
}

#[test]
fn someone_who_cannot_see_the_task_is_told_it_does_not_exist() {
    let guest = someone(Agent, Role::Guest, Scopes::GUEST);
    assert_eq!(
        authorize_output_link(&guest, &task("req", "asg", "rev")),
        Verdict::Hidden
    );
    assert_eq!(
        authorize_output_link(
            &someone(Person, Role::None, Scopes::MEMBER),
            &task("me", "asg", "rev")
        ),
        Verdict::NotParticipant
    );
}

#[test]
fn every_participant_sees_outputs_but_only_tasks_they_can_see() {
    let guest = someone(Agent, Role::Guest, Scopes::GUEST);
    assert!(sees_outputs(&guest));
    assert!(sees_outputs(&someone(Agent, Role::Member, Scopes::MEMBER)));
    assert!(!sees_outputs(&someone(Person, Role::None, Scopes::MEMBER)));

    assert!(!sees_output_task(&guest, &task("req", "asg", "rev")));
    assert!(sees_output_task(&guest, &task("req", "me", "rev")));
    assert!(sees_output_task(
        &someone(Agent, Role::Member, Scopes::MEMBER),
        &task("req", "asg", "rev")
    ));
    assert!(!sees_output_task(
        &someone(Person, Role::None, Scopes::MEMBER),
        &task("me", "asg", "rev")
    ));
}

#[test]
fn only_those_who_may_read_a_submissions_files_learn_their_state() {
    let t = task("req", "asg", "rev");
    // Every artifact, or the named reviewer, or the submitter.
    assert!(sees_submission_files(
        &someone(Agent, Role::Member, Scopes::MEMBER),
        &t,
        "asg"
    ));
    let mut reviewer = someone(Agent, Role::Guest, Scopes::PUBLIC_PARTICIPANT);
    reviewer.id = "rev".into();
    reviewer.scopes = Scopes {
        review: ReviewScope::WhenNamed,
        ..Scopes::PUBLIC_PARTICIPANT
    };
    assert!(sees_submission_files(&reviewer, &t, "asg"));
    let mut submitter = someone(Agent, Role::Guest, Scopes::PUBLIC_PARTICIPANT);
    submitter.id = "asg".into();
    assert!(sees_submission_files(&submitter, &t, "asg"));
    // Seeing the task isn't enough: a member whose artifacts are limited to its own tasks, on someone else's.
    let narrowed = someone(
        Agent,
        Role::Member,
        Scopes {
            artifacts: ArtifactScope::Own,
            ..Scopes::MEMBER
        },
    );
    assert!(sees_output_task(&narrowed, &t));
    assert!(!sees_submission_files(&narrowed, &t, "asg"));
    // Nor is anything for a guest who can't see the task.
    assert!(!sees_submission_files(
        &someone(Agent, Role::Guest, Scopes::GUEST),
        &t,
        "asg"
    ));
}
