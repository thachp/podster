#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::repo_grants::{Grant, GrantRefusal};
use podster_core::repositories::GrantAction;
use podster_core::{decide_create, NewTask, Task};
use podster_policy::repositories::*;
use podster_policy::*;
use PrincipalKind::*;

const NOW: i64 = 1_800_000_000_000;
const REPO: i64 = 4242;

// Built through `decide_create`, so this keeps compiling as `Task` grows.
fn task() -> Task {
    decide_create(
        "req",
        NewTask {
            id: "t".into(),
            title: "x".into(),
            instructions: "y".into(),
            acceptance_criteria: None,
            assignee: Some("asg".into()),
            reviewer: Some("rev".into()),
            due_at: None,
            follow_up_of: None,
            has_linked_repository: true,
        },
    )
    .unwrap()
    .task
}

fn caller(id: &str, kind: PrincipalKind, role: Role) -> Caller {
    Caller {
        id: id.into(),
        kind,
        role,
        scopes: Scopes::for_role(role, false),
    }
}

fn grant(action: GrantAction) -> Grant {
    Grant {
        provider_repo_id: REPO,
        action,
        expires_at: None,
        revoked_at: None,
    }
}

const PARTIES: [&str; 4] = ["req", "asg", "rev", "stranger"];

/// Whether this kind and role sees a task they hold this place on, stated apart from the code: a human owner or admin
/// and a member see every task, and anyone else in the room only their own.
fn sees(kind: PrincipalKind, role: Role, party: &str) -> bool {
    let human_admin = kind == Person && matches!(role, Role::Owner | Role::Admin);
    human_admin || role == Role::Member || party != "stranger"
}

#[test]
fn only_the_rooms_owner_as_a_person_holds_the_repositorys_delegation() {
    for kind in [Person, Agent] {
        for role in Role::ALL {
            assert_eq!(
                holds_repository_delegation(kind, role),
                kind == Person && role == Role::Owner,
                "{kind:?} {role:?}"
            );
        }
    }
}

/// AC-10 and AC-11: a grant needs room authority and the repository's delegation, and neither stands in for the other.
#[test]
fn ac_10_ac_11_granting_needs_room_authority_and_the_delegation_both() {
    let mut checked = 0;
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for holds_delegation in [false, true] {
                let human_admin = kind == Person && matches!(role, Role::Owner | Role::Admin);
                let expected = if role == Role::None {
                    Err(RepoDenial::NotParticipant)
                } else if !human_admin {
                    // AC-11: holding a delegation doesn't administer a room.
                    Err(RepoDenial::NotAllowed)
                } else if !holds_delegation {
                    // AC-10: administering a room isn't a delegation.
                    Err(RepoDenial::NoProviderDelegation)
                } else {
                    Ok(())
                };
                assert_eq!(
                    authorize_grant_change(&caller("me", kind, role), holds_delegation),
                    expected,
                    "{kind:?} {role:?} {holds_delegation}"
                );
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 2 * 5 * 2);
    // As the room wires it, the delegation is the owner's: an admin is refused and the owner allowed.
    for (role, expected) in [
        (Role::Owner, Ok(())),
        (Role::Admin, Err(RepoDenial::NoProviderDelegation)),
        (Role::Member, Err(RepoDenial::NotAllowed)),
        (Role::Guest, Err(RepoDenial::NotAllowed)),
    ] {
        let who = caller("me", Person, role);
        assert_eq!(
            authorize_grant_change(&who, holds_repository_delegation(who.kind, who.role)),
            expected,
            "{role:?}"
        );
    }
    // An agent stored as the owner holds neither side.
    let agent_owner = caller("me", Agent, Role::Owner);
    assert!(!holds_repository_delegation(
        agent_owner.kind,
        agent_owner.role
    ));
    assert_eq!(
        authorize_grant_change(&agent_owner, true),
        Err(RepoDenial::NotAllowed)
    );
}

/// AC-24: a public claim brings no repository authority, and nobody outside the room is given any.
#[test]
fn a_grant_goes_only_to_a_participant_who_isnt_there_through_a_public_claim() {
    for role in [Role::Owner, Role::Admin, Role::Member, Role::Guest] {
        assert_eq!(may_receive_grant(role, false), Ok(()), "{role:?}");
        assert_eq!(
            may_receive_grant(role, true),
            Err(RepoDenial::GranteePublic),
            "{role:?}"
        );
    }
    for public in [false, true] {
        assert_eq!(
            may_receive_grant(Role::None, public),
            Err(RepoDenial::GranteeNotParticipant)
        );
    }
}

#[test]
fn only_the_assigned_agent_with_a_push_grant_asks_for_a_token() {
    let task = task();
    let push = grant(GrantAction::Push);
    let mut checked = 0;
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for party in PARTIES {
                for held in [None, Some(&push)] {
                    let expected = if role == Role::None {
                        Err(RepoDenial::NotParticipant)
                    } else if !sees(kind, role, party) {
                        Err(RepoDenial::Hidden)
                    } else if kind != Agent || party != "asg" {
                        Err(RepoDenial::NotAllowed)
                    } else if held.is_none() {
                        Err(RepoDenial::Grant(GrantRefusal::GrantRequired))
                    } else {
                        Ok(())
                    };
                    assert_eq!(
                        authorize_repo_access(&caller(party, kind, role), &task, held, REPO, NOW),
                        expected,
                        "{kind:?} {role:?} {party} {held:?}"
                    );
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 2 * 5 * 4 * 2);
    let agent = caller("asg", Agent, Role::Guest);
    let merge = grant(GrantAction::Merge);
    let expired = Grant {
        expires_at: Some(NOW),
        ..push
    };
    let elsewhere = Grant {
        provider_repo_id: REPO + 1,
        ..push
    };
    for (name, held, refusal) in [
        ("a merge grant", &merge, GrantRefusal::GrantRequired),
        ("an expired grant", &expired, GrantRefusal::GrantExpired),
        (
            "a grant on another repository",
            &elsewhere,
            GrantRefusal::GrantRequired,
        ),
    ] {
        assert_eq!(
            authorize_repo_access(&agent, &task, Some(held), REPO, NOW),
            Err(RepoDenial::Grant(refusal)),
            "{name}"
        );
    }
}

/// AC-17, M5-10 and decision 186: a merge needs its own grant, whatever the caller's role or place on the task, and the
/// submitter never merges.
#[test]
fn ac_17_only_a_merge_grant_lets_someone_who_didnt_submit_ask_for_a_merge() {
    let task = task();
    let merge = grant(GrantAction::Merge);
    let mut checked = 0;
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for party in PARTIES {
                for held in [None, Some(&merge)] {
                    let expected = if role == Role::None {
                        Err(RepoDenial::NotParticipant)
                    } else if !sees(kind, role, party) {
                        Err(RepoDenial::Hidden)
                    } else if party == "asg" {
                        Err(RepoDenial::SelfMerge)
                    } else if held.is_none() {
                        Err(RepoDenial::Grant(GrantRefusal::GrantRequired))
                    } else {
                        Ok(())
                    };
                    assert_eq!(
                        authorize_merge(&caller(party, kind, role), &task, "asg", held, REPO, NOW),
                        expected,
                        "{kind:?} {role:?} {party} {held:?}"
                    );
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 2 * 5 * 4 * 2);

    // The reviewer, the requester, an admin and the owner are each refused without the grant, and a push grant isn't one.
    let push = grant(GrantAction::Push);
    let expired = Grant {
        expires_at: Some(NOW - 1),
        ..merge
    };
    let revoked = Grant {
        revoked_at: Some(NOW - 1),
        ..merge
    };
    let elsewhere = Grant {
        provider_repo_id: REPO + 1,
        ..merge
    };
    for who in [
        caller("rev", Person, Role::Member),
        caller("req", Person, Role::Member),
        caller("admin", Person, Role::Admin),
        caller("owner", Person, Role::Owner),
        caller("rev", Agent, Role::Guest),
    ] {
        for (name, held, refusal) in [
            ("nothing", None, GrantRefusal::GrantRequired),
            ("a push grant", Some(&push), GrantRefusal::GrantRequired),
            (
                "an expired grant",
                Some(&expired),
                GrantRefusal::GrantExpired,
            ),
            (
                "a revoked grant",
                Some(&revoked),
                GrantRefusal::GrantRequired,
            ),
            (
                "a grant on another repository",
                Some(&elsewhere),
                GrantRefusal::GrantRequired,
            ),
        ] {
            assert_eq!(
                authorize_merge(&who, &task, "asg", held, REPO, NOW),
                Err(RepoDenial::Grant(refusal)),
                "{} {:?} with {name}",
                who.id,
                who.role
            );
        }
        assert_eq!(
            authorize_merge(&who, &task, "asg", Some(&merge), REPO, NOW),
            Ok(())
        );
    }

    // Whoever the submission's row names as its submitter is refused, with the grant, and so is the task's assignee.
    let owner = caller("owner", Person, Role::Owner);
    assert_eq!(
        authorize_merge(&owner, &task, "owner", Some(&merge), REPO, NOW),
        Err(RepoDenial::SelfMerge)
    );
    assert_eq!(
        authorize_merge(
            &caller("asg", Agent, Role::Member),
            &task,
            "someone",
            Some(&merge),
            REPO,
            NOW
        ),
        Err(RepoDenial::SelfMerge)
    );
}

#[test]
fn the_repository_its_grants_and_a_tasks_change_are_seen_by_those_the_specs_name() {
    let task = task();
    for kind in [Person, Agent] {
        for role in Role::ALL {
            let who = caller("stranger", kind, role);
            let human_admin = kind == Person && matches!(role, Role::Owner | Role::Admin);
            // The room's repository: a person who sees the whole room, as step 2's read answers. Never an agent.
            assert_eq!(
                sees_repository(&who),
                kind == Person && (human_admin || role == Role::Member),
                "{kind:?} {role:?}"
            );
            // Grants: a human owner or admin sees everyone's, and anyone in the room their own.
            assert_eq!(sees_grant(&who, "other"), human_admin, "{kind:?} {role:?}");
            assert_eq!(
                sees_grant(&who, "stranger"),
                role != Role::None,
                "{kind:?} {role:?}"
            );
            // A task's change follows the task.
            for party in PARTIES {
                let who = caller(party, kind, role);
                assert_eq!(
                    sees_task_change(&who, &task),
                    can_see_task(&who, &task),
                    "{kind:?} {role:?} {party}"
                );
                assert_eq!(
                    sees_task_change(&who, &task),
                    role != Role::None && sees(kind, role, party),
                    "{kind:?} {role:?} {party}"
                );
            }
        }
    }
    // A person narrowed to their own tasks doesn't see the repository, though they're a member.
    let narrowed = Caller {
        scopes: Scopes::GUEST,
        ..caller("me", Person, Role::Member)
    };
    assert!(!sees_repository(&narrowed));
}

#[test]
fn denials_have_stable_names_and_count_as_refusals_of_authority() {
    for (denial, code) in [
        (RepoDenial::NotParticipant, "not_a_participant"),
        (RepoDenial::Hidden, "task_not_found"),
        (RepoDenial::NotAllowed, "not_allowed"),
        (RepoDenial::NoProviderDelegation, "no_provider_delegation"),
        (RepoDenial::GranteeNotParticipant, "grantee_not_participant"),
        (RepoDenial::GranteePublic, "grantee_public"),
        (RepoDenial::SelfMerge, "self_merge"),
        (
            RepoDenial::Grant(GrantRefusal::GrantRequired),
            "grant_required",
        ),
        (
            RepoDenial::Grant(GrantRefusal::GrantExpired),
            "grant_expired",
        ),
    ] {
        assert_eq!(denial.code(), code);
    }
    for code in [
        "self_merge",
        "no_provider_delegation",
        "grant_required",
        "grant_expired",
        "not_allowed",
        "task_not_found",
    ] {
        assert!(is_authority_refusal("task.merge", code), "{code}");
    }
    // Naming the wrong grantee, a state that doesn't allow it or a changed commit isn't a lack of authority.
    for code in [
        "grantee_not_participant",
        "grantee_public",
        "repo_not_ready",
        "commit_changed",
        "not_approved",
        "invalid_argument",
    ] {
        assert!(!is_authority_refusal("task.merge", code), "{code}");
    }
}
