#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::repo_grants::{Grant, GrantRefusal};
use podster_core::repo_merge::Actor;
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

/// A grant to `principal`, given by the room's owner.
fn grant(principal: &'static str, action: GrantAction) -> Grant<'static> {
    Grant {
        id: "g1",
        principal,
        provider_repo_id: REPO,
        action,
        delegated_by: "owner",
        expires_at: None,
        revoked_at: None,
    }
}

/// A caller's standing with this grant, while the owner who gave it still holds the delegation.
fn standing<'a>(grant: Option<&'a Grant<'a>>) -> GrantStanding<'a> {
    GrantStanding {
        grant,
        link_repo_id: REPO,
        delegation_holder: Some("owner"),
        through_public_claim: false,
        now: NOW,
    }
}

/// The submitting agent, owned by the person `p-sub`.
const SUBMITTER: Actor<'static> = Actor {
    id: "asg",
    person: Some("p-sub"),
};

const PARTIES: [&str; 4] = ["req", "asg", "rev", "stranger"];

/// Whether this kind and role sees a task they hold this place on, stated apart from the code: a human owner or admin
/// and a member see every task, and anyone else in the room only their own.
fn sees(kind: PrincipalKind, role: Role, party: &str) -> bool {
    let human_admin = kind == Person && matches!(role, Role::Owner | Role::Admin);
    human_admin || role == Role::Member || party != "stranger"
}

#[test]
fn only_the_rooms_owner_as_a_person_with_authority_holds_the_delegation() {
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for authority in [false, true] {
                assert_eq!(
                    holds_repository_delegation(kind, role, authority),
                    kind == Person && role == Role::Owner && authority,
                    "{kind:?} {role:?} {authority}"
                );
            }
        }
    }
    assert_eq!(delegation_holder("owner", Person, true), Some("owner"));
    // An owner who left, or rejoined under a newer membership, holds nothing, and neither does an agent stored as one.
    assert_eq!(delegation_holder("owner", Person, false), None);
    assert_eq!(delegation_holder("owner", Agent, true), None);
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
                    authorize_grant(&caller("me", kind, role), holds_delegation),
                    expected,
                    "{kind:?} {role:?} {holds_delegation}"
                );
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 2 * 5 * 2);
    // As the room wires it, the delegation is the owner's: only the owner grants, and an admin is refused.
    for (role, authority, expected) in [
        (Role::Owner, true, Ok(())),
        (Role::Owner, false, Err(RepoDenial::NoProviderDelegation)),
        (Role::Admin, true, Err(RepoDenial::NoProviderDelegation)),
        (Role::Member, true, Err(RepoDenial::NotAllowed)),
        (Role::Guest, true, Err(RepoDenial::NotAllowed)),
    ] {
        let who = caller("me", Person, role);
        assert_eq!(
            authorize_grant(
                &who,
                holds_repository_delegation(who.kind, who.role, authority)
            ),
            expected,
            "{role:?} {authority}"
        );
    }
    // An agent stored as the owner holds neither side.
    let agent_owner = caller("me", Agent, Role::Owner);
    assert!(!holds_repository_delegation(
        agent_owner.kind,
        agent_owner.role,
        true
    ));
    assert_eq!(
        authorize_grant(&agent_owner, true),
        Err(RepoDenial::NotAllowed)
    );
}

/// Who takes a grant back: the room's owner, a person who administers the room's organization, and the holder their
/// own. Nobody else, and an agent never another's.
#[test]
fn a_grant_is_taken_back_by_the_owner_an_organization_admin_or_its_holder() {
    let mut checked = 0;
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for own in [false, true] {
                for holds_delegation in [false, true] {
                    for org_admin in [false, true] {
                        let grantee = if own { "me" } else { "other" };
                        let person = kind == Person;
                        let expected = if own {
                            // Their own, whoever they are, still in the room or not.
                            Ok(())
                        } else if person && org_admin {
                            // With or without a place in the room, so a grant can be pulled when the owner has left.
                            Ok(())
                        } else if role == Role::None {
                            Err(RepoDenial::NotParticipant)
                        } else if person && role == Role::Owner && holds_delegation {
                            Ok(())
                        } else {
                            Err(RepoDenial::NotAllowed)
                        };
                        assert_eq!(
                            authorize_revoke(
                                &caller("me", kind, role),
                                grantee,
                                holds_delegation,
                                org_admin
                            ),
                            expected,
                            "{kind:?} {role:?} own={own} delegation={holds_delegation} org_admin={org_admin}"
                        );
                        checked += 1;
                    }
                }
            }
        }
    }
    assert_eq!(checked, 2 * 5 * 2 * 2 * 2);

    // Each rule, by name.
    let owner = caller("owner", Person, Role::Owner);
    assert_eq!(authorize_revoke(&owner, "agent", true, false), Ok(()));
    // An owner whose authority no longer holds isn't the room's owner for this.
    assert_eq!(
        authorize_revoke(&owner, "agent", false, false),
        Err(RepoDenial::NotAllowed)
    );
    let org_admin_outside = caller("org-admin", Person, Role::None);
    assert_eq!(
        authorize_revoke(&org_admin_outside, "agent", false, true),
        Ok(())
    );
    let holder = caller("agent", Agent, Role::Guest);
    assert_eq!(authorize_revoke(&holder, "agent", false, false), Ok(()));
    // A room admin, a member, a guest and whoever is in the room otherwise: nobody else.
    for role in [Role::Admin, Role::Member, Role::Guest] {
        assert_eq!(
            authorize_revoke(&caller("me", Person, role), "agent", false, false),
            Err(RepoDenial::NotAllowed),
            "{role:?}"
        );
        // A delegation flag on someone who isn't the owner changes nothing.
        assert_eq!(
            authorize_revoke(&caller("me", Person, role), "agent", true, false),
            Err(RepoDenial::NotAllowed),
            "{role:?}"
        );
    }
    // An agent never takes back another principal's grant, whatever is stored for it or claimed about it.
    for role in Role::ALL {
        for (holds_delegation, org_admin) in [(true, true), (true, false), (false, true)] {
            assert!(
                authorize_revoke(
                    &caller("bot", Agent, role),
                    "agent",
                    holds_delegation,
                    org_admin
                )
                .is_err(),
                "{role:?}"
            );
        }
    }
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

/// AC-24, at use: someone in the room through a public claim uses no grant, even a row given before that was so.
#[test]
fn a_public_claim_holder_uses_no_grant() {
    let task = task();
    let push = grant("asg", GrantAction::Push);
    let agent = caller("asg", Agent, Role::Guest);
    assert_eq!(
        authorize_repo_access(&agent, &task, &standing(Some(&push))),
        Ok(())
    );
    let public = GrantStanding {
        through_public_claim: true,
        ..standing(Some(&push))
    };
    assert_eq!(
        authorize_repo_access(&agent, &task, &public),
        Err(RepoDenial::PublicParticipant)
    );

    let merge = grant("rev", GrantAction::Merge);
    let reviewer = caller("rev", Agent, Role::Guest);
    assert_eq!(
        authorize_merge(
            &reviewer,
            Some("p-rev"),
            &task,
            &SUBMITTER,
            &standing(Some(&merge))
        ),
        Ok(())
    );
    let public = GrantStanding {
        through_public_claim: true,
        ..standing(Some(&merge))
    };
    assert_eq!(
        authorize_merge(&reviewer, Some("p-rev"), &task, &SUBMITTER, &public),
        Err(RepoDenial::PublicParticipant)
    );
    // With no grant at all the answer is the same, so it says nothing about what rows exist.
    let public_no_grant = GrantStanding {
        through_public_claim: true,
        ..standing(None)
    };
    assert_eq!(
        authorize_merge(
            &reviewer,
            Some("p-rev"),
            &task,
            &SUBMITTER,
            &public_no_grant
        ),
        Err(RepoDenial::PublicParticipant)
    );
}

#[test]
fn only_the_assigned_agent_with_a_push_grant_asks_for_a_token() {
    let task = task();
    let mut checked = 0;
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for party in PARTIES {
                let push = grant(party, GrantAction::Push);
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
                        authorize_repo_access(&caller(party, kind, role), &task, &standing(held)),
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
    let push = grant("asg", GrantAction::Push);
    let merge = grant("asg", GrantAction::Merge);
    let expired = Grant {
        expires_at: Some(NOW),
        ..push
    };
    let elsewhere = Grant {
        provider_repo_id: REPO + 1,
        ..push
    };
    let someone_elses = grant("other", GrantAction::Push);
    for (name, held, refusal) in [
        ("a merge grant", &merge, GrantRefusal::GrantRequired),
        ("an expired grant", &expired, GrantRefusal::GrantExpired),
        (
            "a grant on another repository",
            &elsewhere,
            GrantRefusal::GrantRequired,
        ),
        (
            "someone else's grant",
            &someone_elses,
            GrantRefusal::GrantRequired,
        ),
    ] {
        assert_eq!(
            authorize_repo_access(&agent, &task, &standing(Some(held))),
            Err(RepoDenial::Grant(refusal)),
            "{name}"
        );
    }
    // A grant whose giver no longer holds the delegation doesn't count.
    for holder in [Some("new-owner"), None] {
        let stale = GrantStanding {
            delegation_holder: holder,
            ..standing(Some(&push))
        };
        assert_eq!(
            authorize_repo_access(&agent, &task, &stale),
            Err(RepoDenial::Grant(GrantRefusal::GrantStale)),
            "{holder:?}"
        );
    }
}

/// AC-17, M5-10 and decision 186: a merge needs its own grant, whatever the caller's role or place on the task, and
/// nobody controlled by the submitter's person merges.
#[test]
fn ac_17_only_a_merge_grant_lets_someone_who_didnt_submit_ask_for_a_merge() {
    let task = task();
    let mut checked = 0;
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for party in PARTIES {
                let merge = grant(party, GrantAction::Merge);
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
                        authorize_merge(
                            &caller(party, kind, role),
                            Some("p-caller"),
                            &task,
                            &SUBMITTER,
                            &standing(held)
                        ),
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
    for who in [
        caller("rev", Person, Role::Member),
        caller("req", Person, Role::Member),
        caller("admin", Person, Role::Admin),
        caller("owner", Person, Role::Owner),
        caller("rev", Agent, Role::Guest),
    ] {
        let id: &'static str = match who.id.as_str() {
            "rev" => "rev",
            "req" => "req",
            "admin" => "admin",
            _ => "owner",
        };
        let merge = grant(id, GrantAction::Merge);
        let push = grant(id, GrantAction::Push);
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
        let someone_elses = grant("other", GrantAction::Merge);
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
            (
                "someone else's grant",
                Some(&someone_elses),
                GrantRefusal::GrantRequired,
            ),
        ] {
            assert_eq!(
                authorize_merge(&who, Some(id), &task, &SUBMITTER, &standing(held)),
                Err(RepoDenial::Grant(refusal)),
                "{id} {:?} with {name}",
                who.role
            );
        }
        assert_eq!(
            authorize_merge(&who, Some(id), &task, &SUBMITTER, &standing(Some(&merge))),
            Ok(())
        );
        // A grant from an owner who no longer holds the delegation doesn't count.
        let stale = GrantStanding {
            delegation_holder: Some("new-owner"),
            ..standing(Some(&merge))
        };
        assert_eq!(
            authorize_merge(&who, Some(id), &task, &SUBMITTER, &stale),
            Err(RepoDenial::Grant(GrantRefusal::GrantStale))
        );
    }
}

/// The submitter rule compares controlling people: the submitting agent's owner and that owner's other agents are
/// refused with the grant in hand, and a reviewer merges only if a different person controls them (M5-10).
#[test]
fn m5_10_a_merger_controlled_by_the_submitters_person_is_refused() {
    let task = task();
    for (name, who, person, expected) in [
        (
            "the person who owns the submitting agent",
            caller("p-sub", Person, Role::Owner),
            Some("p-sub"),
            Err(RepoDenial::SelfMerge),
        ),
        (
            "another agent of that owner",
            caller("sibling", Agent, Role::Member),
            Some("p-sub"),
            Err(RepoDenial::SelfMerge),
        ),
        (
            "the reviewer, an agent of that owner",
            caller("rev", Agent, Role::Guest),
            Some("p-sub"),
            Err(RepoDenial::SelfMerge),
        ),
        (
            "the reviewer, whose owner the room can't name",
            caller("rev", Agent, Role::Guest),
            None,
            Err(RepoDenial::SelfMerge),
        ),
        (
            "the submitting agent, claiming another person",
            caller("asg", Agent, Role::Member),
            Some("p-other"),
            Err(RepoDenial::SelfMerge),
        ),
        (
            "the reviewer, a different person",
            caller("rev", Person, Role::Member),
            Some("rev"),
            Ok(()),
        ),
        (
            "the reviewer, an agent of another person",
            caller("rev", Agent, Role::Guest),
            Some("p-rev"),
            Ok(()),
        ),
        (
            "another person's agent",
            caller("merger", Agent, Role::Member),
            Some("p-merger"),
            Ok(()),
        ),
    ] {
        let id: &'static str = match who.id.as_str() {
            "p-sub" => "p-sub",
            "sibling" => "sibling",
            "rev" => "rev",
            "asg" => "asg",
            _ => "merger",
        };
        let merge = grant(id, GrantAction::Merge);
        assert_eq!(
            authorize_merge(&who, person, &task, &SUBMITTER, &standing(Some(&merge))),
            expected,
            "{name}"
        );
    }
    // A submitter whose controlling person the room can't name is the same as anyone.
    let unknown_submitter = Actor {
        id: "asg",
        person: None,
    };
    let merge = grant("rev", GrantAction::Merge);
    assert_eq!(
        authorize_merge(
            &caller("rev", Person, Role::Member),
            Some("rev"),
            &task,
            &unknown_submitter,
            &standing(Some(&merge))
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
        (RepoDenial::PublicParticipant, "public_participant"),
        (RepoDenial::SelfMerge, "self_merge"),
        (
            RepoDenial::Grant(GrantRefusal::GrantRequired),
            "grant_required",
        ),
        (
            RepoDenial::Grant(GrantRefusal::GrantExpired),
            "grant_expired",
        ),
        (RepoDenial::Grant(GrantRefusal::GrantStale), "grant_stale"),
    ] {
        assert_eq!(denial.code(), code);
    }
    // The caller lacked the authority for the change.
    for code in [
        "self_merge",
        "no_provider_delegation",
        "grant_required",
        "grant_expired",
        "grant_stale",
        "public_participant",
        "access_revoked",
        "agent_disconnected",
        "not_allowed",
        "task_not_found",
    ] {
        assert!(is_authority_refusal("task.merge", code), "{code}");
    }
    // The caller has the authority and the request is wrong: naming a grantee who can't hold a grant, a state that
    // doesn't allow it, or a changed commit.
    for code in [
        "grantee_not_participant",
        "grantee_public",
        "repo_not_ready",
        "commit_changed",
        "not_approved",
        "deadline_unknown",
        "invalid_argument",
    ] {
        assert!(!is_authority_refusal("task.merge", code), "{code}");
    }
}
