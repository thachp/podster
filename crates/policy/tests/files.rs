#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::files::ObjectState;
use podster_core::{Task, TaskStatus};
use podster_policy::files::*;
use podster_policy::*;
use PrincipalKind::*;

fn task(requester: &str, assignee: &str, reviewer: &str) -> Task {
    Task {
        id: "t".into(),
        title: "x".into(),
        instructions: "y".into(),
        acceptance_criteria: None,
        requester: requester.into(),
        assignee: Some(assignee.into()),
        reviewer: reviewer.into(),
        status: TaskStatus::Accepted,
        version: 1,
        due_at: None,
        follow_up_of: None,
        has_linked_repository: false,
        submission_no: 0,
        submission_commit: None,
        approved_submission_no: None,
        submission_files: 0,
        assignee_departed: false,
        needs_reviewer: false,
        needs_requester: false,
    }
}

fn someone(kind: PrincipalKind, role: Role, scopes: Scopes) -> Caller {
    Caller {
        id: "me".into(),
        kind,
        role,
        scopes,
    }
}

fn narrowed(tasks: TaskScope) -> Scopes {
    Scopes {
        tasks,
        ..Scopes::MEMBER
    }
}

#[test]
fn owners_admins_members_and_coordinators_upload_input_assets() {
    for (who, caller) in [
        (
            "owner",
            someone(Person, Role::Owner, Scopes::PUBLIC_PARTICIPANT),
        ),
        (
            "admin",
            someone(Person, Role::Admin, Scopes::PUBLIC_PARTICIPANT),
        ),
        ("member", someone(Person, Role::Member, Scopes::MEMBER)),
        (
            "member agent",
            someone(Agent, Role::Member, Preset::Member.scopes()),
        ),
        (
            "coordinator",
            someone(Agent, Role::Member, Preset::Coordinator.scopes()),
        ),
    ] {
        assert_eq!(authorize_input_upload(&caller), Verdict::Allow, "{who}");
    }
}

#[test]
fn guests_and_outsiders_do_not() {
    for (who, caller) in [
        ("guest", someone(Person, Role::Guest, Scopes::GUEST)),
        (
            "guest agent",
            someone(Agent, Role::Guest, Preset::Guest.scopes()),
        ),
        (
            "public",
            someone(Agent, Role::Guest, Preset::PublicParticipant.scopes()),
        ),
    ] {
        assert_eq!(authorize_input_upload(&caller), Verdict::Forbidden, "{who}");
    }
    let outsider = someone(Person, Role::None, Scopes::MEMBER);
    assert_eq!(authorize_input_upload(&outsider), Verdict::NotParticipant);
}

#[test]
fn an_agent_stored_as_an_admin_counts_as_a_guest() {
    for role in [Role::Owner, Role::Admin] {
        let agent = someone(Agent, role, Scopes::COORDINATOR);
        assert_eq!(
            authorize_input_upload(&agent),
            Verdict::Forbidden,
            "{role:?}"
        );
    }
}

/// Decision 53 names roles and presets, not adjusted grants. These pin the fail-closed answer until the owner rules.
#[test]
fn adjusted_grants_stay_refused_for_now() {
    for (who, caller) in [
        (
            "member narrowed to own",
            someone(Agent, Role::Member, narrowed(TaskScope::Own)),
        ),
        (
            "member narrowed to own and create",
            someone(Agent, Role::Member, narrowed(TaskScope::OwnCreate)),
        ),
        (
            "member who can't create",
            someone(Agent, Role::Member, narrowed(TaskScope::All)),
        ),
        (
            "guest widened to all",
            someone(Agent, Role::Guest, narrowed(TaskScope::AllCreate)),
        ),
        (
            "guest widened to coordinate",
            someone(Agent, Role::Guest, narrowed(TaskScope::Coordinate)),
        ),
    ] {
        assert_eq!(authorize_input_upload(&caller), Verdict::Forbidden, "{who}");
    }
}

#[test]
fn whoever_sees_the_whole_room_sees_every_input_asset() {
    let unrelated = task("a", "b", "c");
    for (who, caller) in [
        (
            "owner",
            someone(Person, Role::Owner, Scopes::PUBLIC_PARTICIPANT),
        ),
        (
            "admin",
            someone(Person, Role::Admin, Scopes::PUBLIC_PARTICIPANT),
        ),
        ("member", someone(Person, Role::Member, Scopes::MEMBER)),
        (
            "coordinator",
            someone(Agent, Role::Member, Scopes::COORDINATOR),
        ),
        (
            "read-only room scope",
            someone(Agent, Role::Member, narrowed(TaskScope::All)),
        ),
    ] {
        assert_eq!(
            input_asset_view(&caller, &[]),
            FileView::Full,
            "{who}, unlinked"
        );
        assert_eq!(
            input_asset_view(&caller, &[&unrelated]),
            FileView::Full,
            "{who}, linked elsewhere"
        );
    }
}

#[test]
fn a_guest_sees_only_assets_linked_to_their_tasks() {
    let guest = someone(Agent, Role::Guest, Scopes::GUEST);
    let theirs = [
        ("as requester", task("me", "b", "c")),
        ("as assignee", task("a", "me", "c")),
        ("as reviewer", task("a", "b", "me")),
    ];
    let others = task("a", "b", "c");
    for (how, mine) in &theirs {
        assert_eq!(input_asset_view(&guest, &[mine]), FileView::Full, "{how}");
        assert_eq!(
            input_asset_view(&guest, &[&others, mine]),
            FileView::Full,
            "{how}, among others"
        );
    }
    assert_eq!(input_asset_view(&guest, &[&others]), FileView::Hidden);
    assert_eq!(
        input_asset_view(&guest, &[]),
        FileView::Hidden,
        "linked to nothing"
    );
}

#[test]
fn a_public_participant_and_a_narrowed_member_are_limited_the_same_way() {
    let others = task("a", "b", "c");
    let mine = task("a", "me", "c");
    for caller in [
        someone(Agent, Role::Guest, Scopes::PUBLIC_PARTICIPANT),
        someone(Agent, Role::Member, narrowed(TaskScope::Own)),
        someone(Agent, Role::Owner, Scopes::COORDINATOR),
    ] {
        assert_eq!(
            input_asset_view(&caller, &[&others]),
            FileView::Hidden,
            "{caller:?}"
        );
        assert_eq!(
            input_asset_view(&caller, &[&mine]),
            FileView::Full,
            "{caller:?}"
        );
    }
}

#[test]
fn someone_no_longer_in_the_room_sees_nothing() {
    let mine = task("me", "me", "me");
    let gone = someone(Agent, Role::None, Scopes::COORDINATOR);
    assert_eq!(input_asset_view(&gone, &[&mine]), FileView::Hidden);
    assert_eq!(submitted_file_view(&gone, &mine, "me"), FileView::Hidden);
}

#[test]
fn submitted_files_follow_the_artifact_scope() {
    let mine = task("a", "me", "c");
    let others = task("a", "b", "c");

    let member = someone(Person, Role::Member, Scopes::MEMBER);
    assert_eq!(submitted_file_view(&member, &others, "b"), FileView::Full);

    let guest = someone(Agent, Role::Guest, Scopes::GUEST);
    assert_eq!(
        submitted_file_view(&guest, &mine, "someone"),
        FileView::Full,
        "own scope, party"
    );
    assert_eq!(
        submitted_file_view(&guest, &others, "b"),
        FileView::Hidden,
        "not their task"
    );

    let public = someone(Agent, Role::Guest, Scopes::PUBLIC_PARTICIPANT);
    assert_eq!(
        submitted_file_view(&public, &mine, "me"),
        FileView::Full,
        "shared scope, their own"
    );
    assert_eq!(
        submitted_file_view(&public, &mine, "someone"),
        FileView::Hidden,
        "shared scope, not theirs"
    );
    assert_eq!(
        submitted_file_view(&public, &others, "me"),
        FileView::Hidden,
        "can't see the task"
    );
}

#[test]
fn oversight_gets_name_and_status_never_bytes() {
    assert_eq!(FileView::Full.for_oversight(), FileView::NameAndStatus);
    assert_eq!(
        FileView::NameAndStatus.for_oversight(),
        FileView::NameAndStatus
    );
    assert_eq!(FileView::Hidden.for_oversight(), FileView::Hidden);
}

/// Built the way `oversight_view` in `apps/api` builds its caller: the agent's ID, as a guest, with oversight's narrower scopes.
fn overseer_of(agent_scopes: Scopes) -> Caller {
    someone(Agent, Role::Guest, agent_scopes.for_oversight())
}

#[test]
fn oversight_shows_only_what_the_agents_own_tasks_hold() {
    let mine = task("a", "me", "c");
    let others = task("a", "b", "c");
    // A Coordinator sees the whole room, and its organization's admin still only sees its own tasks.
    let overseer = overseer_of(Scopes::COORDINATOR);
    let view = |linked: &[&Task]| input_asset_view(&overseer, linked).for_oversight();
    assert_eq!(view(&[&mine]), FileView::NameAndStatus);
    assert_eq!(view(&[&others]), FileView::Hidden);
    assert_eq!(view(&[]), FileView::Hidden);
    assert_eq!(
        submitted_file_view(&overseer, &mine, "me").for_oversight(),
        FileView::NameAndStatus
    );
    assert_eq!(
        submitted_file_view(&overseer, &others, "b").for_oversight(),
        FileView::Hidden
    );
}

#[test]
fn oversight_can_never_download_in_any_state() {
    let mine = task("a", "me", "c");
    let view = input_asset_view(&overseer_of(Scopes::MEMBER), &[&mine]).for_oversight();
    for state in ObjectState::ALL {
        assert!(!may_download(view, state), "{state:?}");
    }
}

#[test]
fn a_download_needs_both_access_and_a_finished_clean_scan() {
    for state in ObjectState::ALL {
        let ready = state == ObjectState::Ready;
        assert_eq!(may_download(FileView::Full, state), ready, "{state:?}");
        assert!(!may_download(FileView::NameAndStatus, state), "{state:?}");
        assert!(!may_download(FileView::Hidden, state), "{state:?}");
    }
}

#[test]
fn an_uploader_cannot_fetch_their_own_blocked_file() {
    let member = someone(Person, Role::Member, Scopes::MEMBER);
    let view = input_asset_view(&member, &[]);
    assert!(!may_download(view, ObjectState::Blocked));
    assert!(!may_download(view, ObjectState::Failed));
    assert!(!may_download(view, ObjectState::Scanning));
}

// ---- files uploaded for a submission ----

#[test]
fn only_the_assignee_uploads_for_a_submission_a_guest_included() {
    let theirs = task("a", "me", "c");
    let others = task("a", "b", "c");
    let guest = someone(Agent, Role::Guest, Scopes::GUEST);
    assert_eq!(authorize_submission_upload(&guest, &theirs), Verdict::Allow);
    let member = someone(Person, Role::Member, Scopes::MEMBER);
    assert_eq!(
        authorize_submission_upload(&member, &theirs),
        Verdict::Allow
    );
    assert_eq!(
        authorize_submission_upload(&member, &others),
        Verdict::Forbidden
    );
    assert_eq!(
        authorize_submission_upload(&guest, &others),
        Verdict::Hidden
    );
    let gone = someone(Agent, Role::None, Scopes::GUEST);
    assert_eq!(
        authorize_submission_upload(&gone, &theirs),
        Verdict::NotParticipant
    );
}

fn named(id: &str, caller: Caller) -> Caller {
    Caller {
        id: id.into(),
        ..caller
    }
}

#[test]
fn an_unsubmitted_file_is_its_uploaders_alone() {
    let t = task("a", "me", "c");
    let uploader = someone(Agent, Role::Guest, Scopes::GUEST);
    assert_eq!(task_file_view(&uploader, &t, "me", false), FileView::Full);
    for (who, caller) in [
        (
            "owner",
            named(
                "o",
                someone(Person, Role::Owner, Scopes::PUBLIC_PARTICIPANT),
            ),
        ),
        (
            "member",
            named("m", someone(Person, Role::Member, Scopes::MEMBER)),
        ),
        (
            "requester",
            named("a", someone(Person, Role::Member, Scopes::MEMBER)),
        ),
        (
            "reviewer",
            named("c", someone(Person, Role::Member, Scopes::MEMBER)),
        ),
    ] {
        assert_eq!(
            task_file_view(&caller, &t, "me", false),
            FileView::Hidden,
            "{who}"
        );
        assert_eq!(
            task_file_view(&caller, &t, "me", false).for_oversight(),
            FileView::Hidden,
            "{who}"
        );
    }
}

#[test]
fn an_uploader_who_left_or_lost_the_task_sees_nothing_of_an_unsubmitted_file() {
    let gone = someone(Agent, Role::None, Scopes::GUEST);
    assert_eq!(
        task_file_view(&gone, &task("a", "me", "c"), "me", false),
        FileView::Hidden
    );
    let reassigned = someone(Agent, Role::Guest, Scopes::GUEST);
    assert_eq!(
        task_file_view(&reassigned, &task("a", "b", "c"), "me", false),
        FileView::Hidden
    );
}

#[test]
fn a_submitted_file_follows_the_artifact_scope() {
    let t = task("a", "b", "c");
    let member = someone(Person, Role::Member, Scopes::MEMBER);
    assert_eq!(task_file_view(&member, &t, "b", true), FileView::Full);
    let guest = someone(Agent, Role::Guest, Scopes::GUEST);
    assert_eq!(task_file_view(&guest, &t, "b", true), FileView::Hidden);
}

#[test]
fn the_named_reviewer_reads_the_tasks_submitted_files_even_when_limited_to_their_own() {
    // A public participant has the `shared` artifact scope, which alone would show them only what they submitted.
    let reviewer = named("c", someone(Agent, Role::Guest, Scopes::PUBLIC_PARTICIPANT));
    let theirs = task("a", "b", "c");
    assert_eq!(
        submitted_file_view(&reviewer, &theirs, "b"),
        FileView::Hidden
    );
    assert_eq!(
        task_file_view(&reviewer, &theirs, "b", true),
        FileView::Full
    );
    // Nothing unsubmitted, and no other task's files.
    assert_eq!(
        task_file_view(&reviewer, &theirs, "b", false),
        FileView::Hidden
    );
    let other = task("a", "b", "z");
    assert_eq!(
        task_file_view(&reviewer, &other, "b", true),
        FileView::Hidden
    );
    // Not once they're out of the room.
    let gone = named("c", someone(Agent, Role::None, Scopes::PUBLIC_PARTICIPANT));
    assert_eq!(task_file_view(&gone, &theirs, "b", true), FileView::Hidden);
    // And the requester, also a party, gets no more than their scope gives.
    let requester = named("a", someone(Agent, Role::Guest, Scopes::PUBLIC_PARTICIPANT));
    assert_eq!(
        task_file_view(&requester, &theirs, "b", true),
        FileView::Hidden
    );
}

#[test]
fn anyone_allowed_to_approve_can_read_what_they_approve() {
    // Every combination of scopes, for every role and kind: if `Verify` is allowed, the submitted file reads in full.
    let mut allowed = 0;
    for role in [Role::Owner, Role::Admin, Role::Member, Role::Guest] {
        for kind in [Person, Agent] {
            for tasks in TaskScope::ALL {
                for artifacts in ArtifactScope::ALL {
                    for conversations in ConversationScope::ALL {
                        for review in ReviewScope::ALL {
                            let scopes = Scopes {
                                tasks,
                                artifacts,
                                conversations,
                                review,
                            };
                            let reviewer = named("c", someone(kind, role, scopes));
                            let t = Task {
                                status: TaskStatus::Submitted,
                                ..task("a", "b", "c")
                            };
                            if authorize_task(&reviewer, &t, TaskAction::Verify) == Verdict::Allow {
                                allowed += 1;
                                assert_eq!(
                                    task_file_view(&reviewer, &t, "b", true),
                                    FileView::Full,
                                    "{role:?} {kind:?} {scopes:?}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    assert!(
        allowed > 0,
        "no combination may approve, so this proves nothing"
    );
}
