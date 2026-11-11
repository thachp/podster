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
fn only_a_person_who_is_owner_or_admin_with_authority_holds_the_delegation() {
    let mut checked = 0;
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for authority in [false, true] {
                let expected =
                    kind == Person && matches!(role, Role::Owner | Role::Admin) && authority;
                assert_eq!(
                    holds_repository_delegation(kind, role, authority),
                    expected,
                    "{kind:?} {role:?} {authority}"
                );
                // A grant's giver counts exactly when they hold it.
                assert_eq!(
                    delegation_holder("giver", kind, role, authority),
                    expected.then_some("giver"),
                    "{kind:?} {role:?} {authority}"
                );
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 2 * 5 * 2);
    // Each rule, by name. The owner and an admin, as people whose authority holds.
    assert_eq!(
        delegation_holder("owner", Person, Role::Owner, true),
        Some("owner")
    );
    assert_eq!(
        delegation_holder("admin", Person, Role::Admin, true),
        Some("admin")
    );
    // One who left, or rejoined under a newer membership, holds nothing.
    assert_eq!(delegation_holder("owner", Person, Role::Owner, false), None);
    assert_eq!(delegation_holder("admin", Person, Role::Admin, false), None);
    // An admin demoted to member or guest, or removed, holds nothing: what they gave stops counting.
    for role in [Role::Member, Role::Guest, Role::None] {
        assert_eq!(
            delegation_holder("was-admin", Person, role, true),
            None,
            "{role:?}"
        );
    }
    // An agent stored as an owner or admin holds nothing.
    assert_eq!(delegation_holder("bot", Agent, Role::Owner, true), None);
    assert_eq!(delegation_holder("bot", Agent, Role::Admin, true), None);
}

/// AC-10 and AC-11, as the owner ruled on 2026-11-11 ("Owner and admins"): the room's repository is asked for, and its
/// grants given, by a person who is the room's owner or a room admin. Never an agent, and nobody with another role.
#[test]
fn ac_10_ac_11_the_repository_is_run_by_a_person_who_is_owner_or_admin() {
    let mut checked = 0;
    for kind in [Person, Agent] {
        for role in Role::ALL {
            let expected = if role == Role::None {
                Err(RepoDenial::NotParticipant)
            } else if kind == Person && matches!(role, Role::Owner | Role::Admin) {
                Ok(())
            } else {
                // AC-10: an agent, whatever role is stored for it. AC-11: a person with any other role.
                Err(RepoDenial::NotAllowed)
            };
            let who = caller("me", kind, role);
            assert_eq!(
                authorize_repository_admin(&who),
                expected,
                "{kind:?} {role:?}"
            );
            assert_eq!(authorize_grant(&who), expected, "{kind:?} {role:?}");
            checked += 1;
        }
    }
    assert_eq!(checked, 2 * 5);
    // Each rule, by name.
    assert_eq!(authorize_grant(&caller("me", Person, Role::Owner)), Ok(()));
    assert_eq!(authorize_grant(&caller("me", Person, Role::Admin)), Ok(()));
    for role in [Role::Member, Role::Guest] {
        assert_eq!(
            authorize_grant(&caller("me", Person, role)),
            Err(RepoDenial::NotAllowed),
            "{role:?}"
        );
    }
    // An agent stored as the owner or an admin is refused. A participant there through a public claim is an agent
    // with the guest role, so it's among these.
    for role in [Role::Owner, Role::Admin, Role::Member, Role::Guest] {
        assert_eq!(
            authorize_repository_admin(&caller("bot", Agent, role)),
            Err(RepoDenial::NotAllowed),
            "{role:?}"
        );
    }
}

/// Who takes a grant back: the room's owner or a room admin as a person, a person who administers the room's
/// organization, and the holder their own. Nobody else, and an agent never another's.
#[test]
fn a_grant_is_taken_back_by_the_owner_an_admin_an_organization_admin_or_its_holder() {
    let mut checked = 0;
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for own in [false, true] {
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
                    } else if person && matches!(role, Role::Owner | Role::Admin) {
                        Ok(())
                    } else {
                        Err(RepoDenial::NotAllowed)
                    };
                    assert_eq!(
                        authorize_revoke(&caller("me", kind, role), grantee, org_admin),
                        expected,
                        "{kind:?} {role:?} own={own} org_admin={org_admin}"
                    );
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 2 * 5 * 2 * 2);

    // Each rule, by name.
    let owner = caller("owner", Person, Role::Owner);
    assert_eq!(authorize_revoke(&owner, "agent", false), Ok(()));
    let admin = caller("admin", Person, Role::Admin);
    assert_eq!(authorize_revoke(&admin, "agent", false), Ok(()));
    let org_admin_outside = caller("org-admin", Person, Role::None);
    assert_eq!(authorize_revoke(&org_admin_outside, "agent", true), Ok(()));
    let holder = caller("agent", Agent, Role::Guest);
    assert_eq!(authorize_revoke(&holder, "agent", false), Ok(()));
    // A member, a guest and whoever is in the room otherwise: nobody else.
    for role in [Role::Member, Role::Guest] {
        assert_eq!(
            authorize_revoke(&caller("me", Person, role), "agent", false),
            Err(RepoDenial::NotAllowed),
            "{role:?}"
        );
    }
    // An agent never takes back another principal's grant, whatever is stored for it or claimed about it.
    for role in Role::ALL {
        for org_admin in [true, false] {
            assert!(
                authorize_revoke(&caller("bot", Agent, role), "agent", org_admin).is_err(),
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
            // A task's change is narrower than the task (M5 step 7a's ruling): a person who sees the task and isn't a
            // guest, or the task's own assignee or reviewer.
            for party in PARTIES {
                let who = caller(party, kind, role);
                let shown =
                    matches!(party, "asg" | "rev") || (kind == Person && role != Role::Guest);
                assert_eq!(
                    sees_task_change(&who, &task),
                    can_see_task(&who, &task) && shown,
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

#[test]
fn a_grant_change_has_a_fixed_name_when_refused() {
    assert_eq!(
        denied_change_name("POST", &["repository", "grants"]),
        Some("repo_grant.give")
    );
    assert_eq!(
        denied_change_name("DELETE", &["repository", "grants", "pgr_1"]),
        Some("repo_grant.revoke")
    );
    // Reading grants isn't a change.
    assert_eq!(denied_change_name("GET", &["repository", "grants"]), None);
    assert_eq!(
        denied_change_name("POST", &["repository", "grants", "pgr_1"]),
        None
    );
}

#[test]
fn a_grants_events_follow_who_may_see_the_grant() {
    for kind in REPO_GRANT_EVENTS {
        // A human owner or admin, the holder and whoever acted see it.
        for who in [
            caller("own", Person, Role::Owner),
            caller("adm", Person, Role::Admin),
            caller("holder", Agent, Role::Guest),
            caller("giver", Person, Role::Member),
        ] {
            assert!(
                can_see_event(&who, kind, "giver", None, Some("holder")),
                "{kind} {}",
                who.id
            );
        }
        // Someone who sees the whole room doesn't learn who holds a grant, nor does an agent stored as an admin.
        for who in [
            caller("mem", Agent, Role::Member),
            caller("mem", Person, Role::Member),
            caller("agt", Agent, Role::Admin),
        ] {
            assert!(
                !can_see_event(&who, kind, "giver", None, Some("holder")),
                "{kind} {}",
                who.id
            );
        }
        assert!(!can_see_event(
            &caller("holder", Agent, Role::None),
            kind,
            "giver",
            None,
            Some("holder")
        ));
    }
}

#[test]
fn naming_a_grant_one_may_not_see_counts_as_a_refusal_only_for_taking_one_back() {
    assert!(is_authority_refusal("repo_grant.revoke", "grant_not_found"));
    assert!(!is_authority_refusal("repo_grant.give", "grant_not_found"));
    assert!(!is_authority_refusal("member.revoke", "grant_not_found"));
}

#[test]
fn only_a_human_owner_or_admin_sees_every_grant() {
    assert!(sees_every_grant(&caller("o", Person, Role::Owner)));
    assert!(sees_every_grant(&caller("a", Person, Role::Admin)));
    for who in [
        caller("m", Person, Role::Member),
        caller("g", Person, Role::Guest),
        caller("x", Agent, Role::Admin),
        caller("n", Person, Role::None),
    ] {
        assert!(!sees_every_grant(&who), "{}", who.id);
    }
}

#[test]
fn a_tasks_change_is_shown_to_people_who_see_the_task_and_to_its_assignee_and_reviewer() {
    let t = task();
    // People in the room who see the task.
    for role in [Role::Owner, Role::Admin, Role::Member] {
        assert!(
            sees_task_change(&caller("someone", Person, role), &t),
            "{role:?}"
        );
    }
    // The task's own assignee and reviewer, whatever they are: an agent, a guest, a public-claim participant.
    for (id, kind, role) in [
        ("asg", Agent, Role::Member),
        ("asg", Agent, Role::Guest),
        ("rev", Agent, Role::Guest),
        ("rev", Person, Role::Guest),
    ] {
        assert!(
            sees_task_change(&caller(id, kind, role), &t),
            "{id} {kind:?} {role:?}"
        );
    }
    // Not another agent, even one that reads every task, and not a guest who is only the requester or reads the task.
    let mut reads_all = caller("other", Agent, Role::Member);
    reads_all.scopes = Scopes::for_role(Role::Admin, false);
    assert!(can_see_task(&reads_all, &t));
    assert!(!sees_task_change(&reads_all, &t));
    assert!(!sees_task_change(&caller("other", Agent, Role::Member), &t));
    assert!(!sees_task_change(&caller("req", Person, Role::Guest), &t));
    assert!(!sees_task_change(&caller("req", Agent, Role::Guest), &t));
    // Nobody who can't see the task, or who has left.
    assert!(!sees_task_change(&caller("asg", Agent, Role::None), &t));
    assert!(!sees_task_change(&caller("gone", Person, Role::None), &t));
}

#[test]
fn events_about_a_tasks_change_follow_the_change_and_its_other_events_follow_the_task() {
    let t = task();
    let reads_task_only = [
        caller("other", Agent, Role::Member),
        caller("req", Person, Role::Guest),
        caller("req", Agent, Role::Guest),
    ];
    let shown_change = [
        caller("someone", Person, Role::Member),
        caller("someone", Person, Role::Admin),
        caller("asg", Agent, Role::Guest),
        caller("rev", Person, Role::Guest),
    ];
    for kind in [
        "task_change.linked",
        "task_change.observed",
        "task_change.commit_changed",
        "task_change.merge_observed",
        "task_change.unwatched",
    ] {
        assert!(is_task_change_event(kind));
        for who in &shown_change {
            assert!(
                can_see_event(who, kind, "system", Some(&t), None),
                "{kind} {who:?}"
            );
        }
        for who in &reads_task_only {
            assert!(can_see_task(who, &t), "{who:?}");
            assert!(
                !can_see_event(who, kind, "system", Some(&t), None),
                "{kind} {who:?}"
            );
            // Having done it oneself doesn't show it either: the link event's actor is the assignee, who is shown anyway.
            assert!(
                !can_see_event(who, kind, &who.id, Some(&t), None),
                "{kind} {who:?}"
            );
        }
        assert!(!can_see_event(
            &caller("asg", Agent, Role::None),
            kind,
            "system",
            Some(&t),
            None
        ));
    }
    // The task's own events are as they were.
    for who in reads_task_only.iter().chain(&shown_change) {
        assert!(!is_task_change_event("task.submitted"));
        assert!(
            can_see_event(who, "task.submitted", "asg", Some(&t), None),
            "{who:?}"
        );
    }
}

#[test]
fn only_an_operator_as_a_person_may_recheck_a_repository() {
    assert_eq!(authorize_recheck(Person, true), Ok(()));
    assert_eq!(
        authorize_recheck(Person, false),
        Err(RepoDenial::NotAllowed)
    );
    assert_eq!(authorize_recheck(Agent, true), Err(RepoDenial::NotAllowed));
    assert_eq!(authorize_recheck(Agent, false), Err(RepoDenial::NotAllowed));
}

#[test]
fn a_release_status_is_for_those_shown_the_change_and_for_whoever_asked_for_the_merge() {
    let t = task();
    for who in [
        caller("someone", Person, Role::Member),
        caller("asg", Agent, Role::Guest),
        caller("rev", Person, Role::Guest),
    ] {
        assert_eq!(
            authorize_release_status(&who, &t, false),
            Ok(ReleaseView::Whole),
            "{who:?}"
        );
        assert_eq!(
            authorize_release_status(&who, &t, true),
            Ok(ReleaseView::Whole),
            "{who:?}"
        );
    }
    // Another agent that reads the task: only if it asked for the merge.
    let other = caller("other", Agent, Role::Member);
    assert_eq!(
        authorize_release_status(&other, &t, false),
        Err(RepoDenial::NotAllowed)
    );
    // And then only the merge: never more than its view of the change shows.
    assert_eq!(
        authorize_release_status(&other, &t, true),
        Ok(ReleaseView::MergeOnly)
    );
    // Having asked doesn't show a task that's hidden, and nobody outside the room is told anything.
    let guest = caller("stranger", Agent, Role::Guest);
    assert!(!can_see_task(&guest, &t));
    assert_eq!(
        authorize_release_status(&guest, &t, true),
        Err(RepoDenial::Hidden)
    );
    assert_eq!(
        authorize_release_status(&caller("asg", Agent, Role::None), &t, true),
        Err(RepoDenial::NotParticipant)
    );
}

#[test]
fn only_those_who_manage_access_are_told_how_each_participant_joined() {
    for (role, told) in [
        (Role::Owner, true),
        (Role::Admin, true),
        (Role::Member, false),
        (Role::Guest, false),
        (Role::None, false),
    ] {
        assert_eq!(
            sees_join_source(&caller("p", Person, role)),
            told,
            "{role:?}"
        );
        // An agent never manages access, whatever role its row says.
        assert!(
            !sees_join_source(&caller("a", Agent, role)),
            "agent {role:?}"
        );
    }
}
