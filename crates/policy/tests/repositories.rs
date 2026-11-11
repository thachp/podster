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

/// Asking for the repository, or retrying its setup, under a deployment's list of requesters: the room's rule first,
/// then the list, for every kind, role and setting.
#[test]
fn a_deployments_list_narrows_who_may_ask_and_never_widens_it() {
    use podster_core::provisioning::RepositoryRequesters;
    const TEST_PERSON: &str = "per_e2e_0123456789abcdef";
    let settings: [(Option<&str>, &[&str]); 9] = [
        // Unset: everyone the room's rule lets.
        (None, &["per_listed", "per_other", TEST_PERSON]),
        (Some("per_listed"), &["per_listed"]),
        (Some("per_listed,test-people"), &["per_listed", TEST_PERSON]),
        (Some("test-people"), &[TEST_PERSON]),
        // A list without the entry holds no test person.
        (Some("per_listed,per_second"), &["per_listed"]),
        // Empty and malformed: nobody.
        (Some(""), &[]),
        (Some("per_listed,"), &[]),
        (Some("per_listed,everyone"), &[]),
        (Some("*"), &[]),
    ];
    let mut checked = 0;
    for (setting, allowed) in settings {
        let requesters = RepositoryRequesters::parse(setting);
        for id in ["per_listed", "per_other", TEST_PERSON] {
            for kind in [Person, Agent] {
                for role in Role::ALL {
                    let who = caller(id, kind, role);
                    let runs_it = kind == Person && matches!(role, Role::Owner | Role::Admin);
                    let expected = if role == Role::None {
                        Err(RepoDenial::NotParticipant)
                    } else if !runs_it {
                        // The room's rule answers first, so the list tells nothing to anyone it wouldn't concern.
                        Err(RepoDenial::NotAllowed)
                    } else if allowed.contains(&id) {
                        Ok(())
                    } else {
                        Err(RepoDenial::RequestsClosed)
                    };
                    assert_eq!(
                        authorize_repository_request(&who, &requesters, &[]),
                        expected,
                        "{setting:?} {id} {kind:?} {role:?}"
                    );
                    // The list bears on asking alone: running the repository and giving its grants don't read it.
                    assert_eq!(
                        authorize_repository_admin(&who).is_ok(),
                        runs_it && role != Role::None,
                        "{setting:?} {id} {kind:?} {role:?}"
                    );
                    assert_eq!(authorize_grant(&who), authorize_repository_admin(&who));
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 9 * 3 * 2 * 5);
    assert_eq!(
        RepoDenial::RequestsClosed.code(),
        "repository_requests_closed"
    );
    // An agent whose ID is listed, or reads as a test person's, stored as the owner: never.
    let listed_agent = RepositoryRequesters::parse(Some("per_listed,test-people"));
    for id in ["per_listed", TEST_PERSON] {
        assert_eq!(
            authorize_repository_request(&caller(id, Agent, Role::Owner), &listed_agent, &[]),
            Err(RepoDenial::NotAllowed)
        );
    }
}

/// The `operators` entry: the deployment's own operators may ask, only where the setting holds the entry, and only as
/// people who run the room.
#[test]
fn the_operators_entry_admits_the_deployments_operators_and_never_an_agent() {
    use podster_core::provisioning::RepositoryRequesters;
    use podster_policy::moderation::parse_operators;
    const OP: &str = "per_operator_one";
    const TEST_PERSON: &str = "per_e2e_0123456789abcdef";
    // (the setting, the deployment's OPERATORS as configured, who may ask of an operator, a test person and another)
    let cases: [(Option<&str>, &str, &[&str]); 9] = [
        // The entry, and the caller among the operators.
        (
            Some("operators,test-people"),
            "per_operator_one, per_operator_two",
            &[OP, TEST_PERSON],
        ),
        (Some("operators"), "per_operator_one", &[OP]),
        // The entry, and the caller not among them.
        (
            Some("operators,test-people"),
            "per_operator_two",
            &[TEST_PERSON],
        ),
        // The entry, and OPERATORS unset or empty: it admits nobody.
        (Some("operators,test-people"), "", &[TEST_PERSON]),
        (Some("operators"), "", &[]),
        (Some("operators"), " , ", &[]),
        // No entry: an operator isn't implied.
        (Some("test-people"), "per_operator_one", &[TEST_PERSON]),
        // An unknown word beside it closes the list, operators included.
        (Some("operators,admins"), "per_operator_one", &[]),
        // Unset: everyone the room's rule lets, whatever OPERATORS says.
        (None, "", &[OP, TEST_PERSON, "per_other"]),
    ];
    let mut checked = 0;
    for (setting, configured, allowed) in cases {
        let requesters = RepositoryRequesters::parse(setting);
        let operators = parse_operators(configured);
        for id in [OP, TEST_PERSON, "per_other"] {
            for kind in [Person, Agent] {
                for role in Role::ALL {
                    let runs_it = kind == Person && matches!(role, Role::Owner | Role::Admin);
                    let expected = if role == Role::None {
                        Err(RepoDenial::NotParticipant)
                    } else if !runs_it {
                        // An operator who is a member or a guest of the room, and an agent whose ID is among the
                        // operators, get the room's own refusal.
                        Err(RepoDenial::NotAllowed)
                    } else if allowed.contains(&id) {
                        Ok(())
                    } else {
                        Err(RepoDenial::RequestsClosed)
                    };
                    assert_eq!(
                        authorize_repository_request(
                            &caller(id, kind, role),
                            &requesters,
                            &operators
                        ),
                        expected,
                        "{setting:?} {configured:?} {id} {kind:?} {role:?}"
                    );
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 9 * 3 * 2 * 5);
    // By name: an agent stored as the room's owner, with an ID the deployment lists as an operator.
    assert_eq!(
        authorize_repository_request(
            &caller(OP, Agent, Role::Owner),
            &RepositoryRequesters::parse(Some("operators")),
            &[OP]
        ),
        Err(RepoDenial::NotAllowed)
    );
}

/// The deploy script's own rule for a well-formed list is JavaScript (`scripts/requesters-rule.mjs`), since it can't
/// run this Rust. Both read the same fixture, so a change to one grammar that the other doesn't follow fails here or
/// in `scripts/test/deploy-staging-selftest`.
#[test]
fn the_list_is_read_as_the_deploy_scripts_rule_reads_it() {
    use podster_core::provisioning::RepositoryRequesters;
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../scripts/test/fixtures/requesters-grammar.json"
    ))
    .unwrap();
    let values = |key: &str| -> Vec<String> {
        fixture[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect()
    };
    let (valid, invalid) = (values("valid"), values("invalid"));
    assert!(valid.len() >= 5 && invalid.len() >= 5);
    for value in &valid {
        assert_ne!(
            RepositoryRequesters::parse(Some(value)),
            RepositoryRequesters::nobody(),
            "{value:?} is well formed, and lets somebody ask"
        );
    }
    for value in &invalid {
        assert_eq!(
            RepositoryRequesters::parse(Some(value)),
            RepositoryRequesters::nobody(),
            "{value:?} is malformed, and lets nobody ask"
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
            // A room admin who controls the submitting agent may give grants, and still can't merge that work.
            "a room admin who owns the submitting agent",
            caller("p-sub", Person, Role::Admin),
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

#[test]
fn a_person_administers_only_the_organizations_their_identity_lists() {
    let orgs = vec!["org_a".to_string()];
    assert!(administers_org(Person, &orgs, Some("org_a")));
    assert!(!administers_org(Person, &orgs, Some("org_b")));
    assert!(!administers_org(Person, &orgs, None));
    assert!(!administers_org(Person, &[], Some("org_a")));
    // An agent never does, whatever it's said to administer.
    assert!(!administers_org(Agent, &orgs, Some("org_a")));
}

#[test]
fn an_organizations_delegation_is_read_by_operators_and_its_admins_and_set_by_operators_alone() {
    assert!(authorize_delegation_read(Person, true, false).is_ok());
    assert!(authorize_delegation_read(Person, false, true).is_ok());
    assert_eq!(
        authorize_delegation_read(Person, false, false),
        Err(RepoDenial::NotAllowed)
    );
    assert_eq!(
        authorize_delegation_read(Agent, true, true),
        Err(RepoDenial::NotAllowed)
    );
    assert!(authorize_delegation_set(Person, true).is_ok());
    // The organization's own admin can't give it authority over Podster's GitHub organization.
    assert_eq!(
        authorize_delegation_set(Person, false),
        Err(RepoDenial::NotAllowed)
    );
    assert_eq!(
        authorize_delegation_set(Agent, true),
        Err(RepoDenial::NotAllowed)
    );
}

#[test]
fn an_organization_admin_takes_any_grant_back_with_or_without_a_place_in_the_room() {
    // AC-11. Outside the room the API resolves them with no role, and they still pass as the organization's admin.
    let outside = caller("org-admin", Person, Role::None);
    assert!(authorize_revoke(&outside, "someone", true).is_ok());
    assert_eq!(
        authorize_revoke(&outside, "someone", false),
        Err(RepoDenial::NotParticipant)
    );
    let member = caller("org-admin", Person, Role::Member);
    assert!(authorize_revoke(&member, "someone", true).is_ok());
    // An agent is never an organization's admin, whatever the API was told.
    let agent = caller("agt", Agent, Role::None);
    assert_eq!(
        authorize_revoke(&agent, "someone", true),
        Err(RepoDenial::NotParticipant)
    );
}

#[test]
fn a_merge_refused_by_policy_in_the_job_keeps_the_code_the_request_would_have_answered() {
    for denial in [
        RepoDenial::NotParticipant,
        RepoDenial::Hidden,
        RepoDenial::PublicParticipant,
        RepoDenial::SelfMerge,
        RepoDenial::NotAllowed,
        RepoDenial::Grant(GrantRefusal::GrantRequired),
        RepoDenial::Grant(GrantRefusal::GrantStale),
    ] {
        let expected = match denial {
            RepoDenial::NotParticipant => "access_revoked",
            other => other.code(),
        };
        assert_eq!(denial.as_merge_refusal().code(), expected, "{denial:?}");
    }
}

#[test]
fn every_m5_event_type_is_known_and_follows_the_switch() {
    for kind in [
        "repository.requested",
        "repository.retry_requested",
        "repository.setup_failed",
        "repository.ready",
        "repository.degraded",
        "repository.ready_again",
        "repository.read_refused",
        "repo_grant.given",
        "repo_grant.revoked",
        "repo_access.issued",
        "repo_token.mint_unknown",
        "repo_token.unrevocable",
        "task_change.linked",
        "task_change.observed",
        "task_change.commit_changed",
        "task_change.merge_observed",
        "task_change.checks_observed",
        "task_change.unwatched",
        "merge.requested",
        "merge.succeeded",
        "merge.failed",
        "merge.outcome_unknown",
        "merge.outcome_unknown_final",
    ] {
        assert!(is_managed_repository_event(kind), "{kind}");
        assert!(shows_with_switch(kind, true), "{kind}");
        assert!(!shows_with_switch(kind, false), "{kind}");
    }
    for kind in [
        "task.created",
        "task.completed",
        "member.added",
        "room.unpublished",
    ] {
        assert!(!is_managed_repository_event(kind), "{kind}");
        assert!(shows_with_switch(kind, false), "{kind}");
    }
}

#[test]
fn a_repositorys_events_are_for_those_who_may_read_the_repository() {
    let owner = caller("owner", Person, Role::Owner);
    let member = caller("mem", Person, Role::Member);
    let guest = caller("gst", Person, Role::Guest);
    // An agent that sees the whole room is still not shown the repository, as GET repository answers it nothing.
    let admin_agent = caller("agt", Agent, Role::Admin);
    let worker = caller("wrk", Agent, Role::Member);
    for kind in [
        "repository.requested",
        "repository.degraded",
        "repository.read_refused",
    ] {
        assert!(can_see_event(&owner, kind, "owner", None, None), "{kind}");
        assert_eq!(
            can_see_event(&member, kind, "owner", None, None),
            sees_repository(&member),
            "{kind}"
        );
        for who in [&guest, &admin_agent, &worker] {
            assert!(
                !can_see_event(who, kind, "owner", None, None),
                "{kind} {}",
                who.id
            );
        }
        // Even whoever acted, once they no longer read the repository.
        assert!(!can_see_event(&guest, kind, "gst", None, None), "{kind}");
    }
}

#[test]
fn a_tokens_events_are_for_those_who_see_the_holders_grant() {
    let t = task();
    let owner = caller("owner", Person, Role::Owner);
    let assignee = caller("asg", Agent, Role::Member);
    let reviewer = caller("rev", Person, Role::Member);
    let member = caller("mem", Person, Role::Member);
    for kind in [
        "repo_access.issued",
        "repo_token.mint_unknown",
        "repo_token.unrevocable",
    ] {
        // The holder, who is the actor, and a human owner or admin.
        assert!(
            can_see_event(&assignee, kind, "asg", Some(&t), Some("grt_1")),
            "{kind}"
        );
        assert!(
            can_see_event(&owner, kind, "asg", Some(&t), Some("grt_1")),
            "{kind}"
        );
        // Not everyone else who can read the task.
        assert!(can_see_task(&reviewer, &t));
        assert!(
            !can_see_event(&reviewer, kind, "asg", Some(&t), Some("grt_1")),
            "{kind}"
        );
        assert!(
            !can_see_event(&member, kind, "asg", Some(&t), Some("grt_1")),
            "{kind}"
        );
        // And never without a task to hang it on.
        assert!(
            !can_see_event(&owner, kind, "asg", None, Some("grt_1")),
            "{kind}"
        );
    }
}

/// A1, decided by the owner on 2026-11-11: a commit is merged into a managed repository only if the review that approved
/// it came from someone not controlled by the submitter's person. Ordinary task review stays as it is: the submitter's
/// own person may still approve the task, and only the merge is refused.
#[test]
fn a1_the_submitters_own_person_may_still_approve_but_their_review_merges_nothing() {
    let task = task();
    // `rev`, the reviewer, is the person who controls `asg`, the submitting agent. The task's review allows it, as before.
    let reviewer = caller("rev", Person, Role::Member);
    assert_eq!(
        authorize_task(&reviewer, &task, TaskAction::Verify),
        Verdict::Allow
    );
    let submitter = Actor {
        id: "asg",
        person: Some("rev"),
    };
    // A different person with a merge grant may ask, and the review isn't independent, so it's refused.
    let other = caller("p-other", Person, Role::Member);
    let theirs = grant("p-other", GrantAction::Merge);
    assert_eq!(
        authorize_merge(
            &other,
            Some("p-other"),
            &task,
            &submitter,
            &standing(Some(&theirs))
        ),
        Ok(())
    );
    let review = Actor {
        id: "rev",
        person: Some("rev"),
    };
    assert_eq!(
        independent_review(Some(&review), &submitter),
        Err(RepoDenial::SelfReview)
    );
    assert_eq!(RepoDenial::SelfReview.code(), "self_review");
}

#[test]
fn a1_only_an_independent_review_lets_a_commit_be_merged_whoever_merges() {
    let task = task();
    // The submitter is `asg`, an agent `p-sub` controls.
    let reviewers: [(&str, Option<Actor>, bool); 7] = [
        (
            "the submitter's person",
            Some(Actor {
                id: "p-sub",
                person: Some("p-sub"),
            }),
            false,
        ),
        (
            "another agent of the submitter's person",
            Some(Actor {
                id: "sibling",
                person: Some("p-sub"),
            }),
            false,
        ),
        (
            "the submitter itself",
            Some(Actor {
                id: "asg",
                person: Some("p-sub"),
            }),
            false,
        ),
        (
            "another person",
            Some(Actor {
                id: "p-rev",
                person: Some("p-rev"),
            }),
            true,
        ),
        (
            "another person's agent",
            Some(Actor {
                id: "agt-rev",
                person: Some("p-rev"),
            }),
            true,
        ),
        (
            "someone whose person wasn't recorded",
            Some(Actor {
                id: "agt-old",
                person: None,
            }),
            false,
        ),
        (
            "nobody recorded, from before the room kept reviewers",
            Some(Actor {
                id: "",
                person: None,
            }),
            false,
        ),
    ];
    // Mergers: a person, an agent of another person, the reviewer itself, and the submitter's person.
    let mergers: [(&str, &'static str, PrincipalKind, Option<&str>); 4] = [
        ("another person", "p-merge", Person, Some("p-merge")),
        (
            "another person's agent",
            "agt-merge",
            Agent,
            Some("p-merge"),
        ),
        ("the reviewer's person", "p-rev", Person, Some("p-rev")),
        ("the submitter's person", "p-sub", Person, Some("p-sub")),
    ];
    for (merger_name, id, kind, merger_person) in &mergers {
        let merger = caller(id, *kind, Role::Member);
        let merge = grant(id, GrantAction::Merge);
        let allowed = authorize_merge(
            &merger,
            *merger_person,
            &task,
            &SUBMITTER,
            &standing(Some(&merge)),
        );
        for (reviewer_name, reviewer, independent) in &reviewers {
            let label = format!("{merger_name} merging after {reviewer_name}");
            let decided = allowed.and_then(|()| independent_review(reviewer.as_ref(), &SUBMITTER));
            let expected = if *merger_person == Some("p-sub") {
                Err(RepoDenial::SelfMerge)
            } else if *independent {
                Ok(())
            } else if reviewer.as_ref().is_some_and(|r| r.id.is_empty()) {
                // The same code, said as "review it again": nothing shows the review wasn't independent.
                Err(RepoDenial::ReviewUnrecorded)
            } else if reviewer.as_ref().is_some_and(|r| r.person.is_none()) {
                // The same code, said as "who controls the reviewer isn't known".
                Err(RepoDenial::ReviewerUnknown)
            } else {
                Err(RepoDenial::SelfReview)
            };
            assert_eq!(decided, expected, "{label}");
        }
    }
    // With no approval on record this says nothing, and core refuses it as `not_approved` or `review_required`.
    assert_eq!(independent_review(None, &SUBMITTER), Ok(()));
    // A merge refused for it in the job keeps its code.
    assert_eq!(
        RepoDenial::SelfReview.as_merge_refusal().code(),
        "self_review"
    );
    assert_eq!(RepoDenial::ReviewUnrecorded.code(), "self_review");
    assert_eq!(RepoDenial::ReviewerUnknown.code(), "self_review");
    assert_eq!(
        RepoDenial::ReviewerUnknown.as_merge_refusal().code(),
        "self_review"
    );
    assert_eq!(
        RepoDenial::ReviewUnrecorded.as_merge_refusal().code(),
        "self_review"
    );
}
