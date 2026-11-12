//! Who may configure, ask for, approve and see a release (ADR 0010; decisions 213 and 215; AC-03, AC-10, AC-11, AC-17).

use podster_core::repo_grants::GrantRefusal;
use podster_policy::release::*;
use podster_policy::*;
use PrincipalKind::*;

const NOW: i64 = 1_000_000;
const REPO: i64 = 77;

fn caller(id: &str, kind: PrincipalKind, role: Role) -> Caller {
    Caller {
        id: id.into(),
        kind,
        role,
        scopes: Scopes::for_role(role, false),
    }
}

fn grant(principal: &str) -> DeployGrant<'_> {
    DeployGrant {
        principal,
        action: DEPLOY_ACTION,
        provider_repo_id: REPO,
        delegated_by: "per_owner",
        expires_at: None,
        revoked_at: None,
    }
}

fn standing<'a>(grant: Option<&'a DeployGrant<'a>>) -> ReleaseStanding<'a> {
    ReleaseStanding {
        grant,
        link_repo_id: REPO,
        delegation_holder: Some("per_owner"),
        through_public_claim: false,
        agent_connected: true,
        now: NOW,
    }
}

/// Each of the room's facts that stops release, with the code it answers.
type RoomChange = fn(&mut ReleaseRoom);
const ROOM_CHANGES: [(RoomChange, ReleaseDenial); 10] = [
    (
        |r| r.deployment_allows_release = false,
        ReleaseDenial::OffForDeployment,
    ),
    (
        |r| r.organization_exists = false,
        ReleaseDenial::OrganizationDeleted,
    ),
    (
        |r| r.organization_may_release = false,
        ReleaseDenial::NotDelegated,
    ),
    (|r| r.deleted = true, ReleaseDenial::Deleted),
    (|r| r.public = false, ReleaseDenial::NeedsPublicRoom),
    (|r| r.archived = true, ReleaseDenial::Archived),
    (
        |r| r.public_surface_suspended = true,
        ReleaseDenial::PublicSurfaceSuspended,
    ),
    (|r| r.app_suspended = true, ReleaseDenial::AppSuspended),
    (|r| r.repository_ready = false, ReleaseDenial::RepoNotReady),
    (|r| r.release_on_in_room = false, ReleaseDenial::ReleaseOff),
];

#[test]
fn the_rooms_facts_refuse_with_the_adrs_codes_in_order() {
    assert_eq!(release_room_allows(&ReleaseRoom::OPEN), Ok(()));
    for (i, (change, denial)) in ROOM_CHANGES.iter().enumerate() {
        let mut alone = ReleaseRoom::OPEN;
        change(&mut alone);
        assert_eq!(release_room_allows(&alone), Err(*denial), "{denial:?}");
        let mut with_later = ReleaseRoom::OPEN;
        for (later, _) in ROOM_CHANGES.iter().skip(i) {
            later(&mut with_later);
        }
        assert_eq!(
            release_room_allows(&with_later),
            Err(*denial),
            "{denial:?} first"
        );
    }
    let codes: Vec<&str> = ROOM_CHANGES.iter().map(|(_, d)| d.code()).collect();
    assert_eq!(
        codes,
        [
            "release_off_for_deployment",
            "organization_deleted",
            "release_not_delegated",
            "workspace_deleted",
            "release_needs_public_room",
            "workspace_archived",
            "public_surface_suspended",
            "app_suspended",
            "repo_not_ready",
            "release_off"
        ]
    );
}

#[test]
fn every_unpublish_trigger_but_the_callers_own_test_has_its_refusal_at_the_command() {
    use podster_core::release::UnpublishTrigger as T;
    let codes: Vec<&str> = ROOM_CHANGES.iter().map(|(_, d)| d.code()).collect();
    for trigger in T::ALL {
        if trigger == T::NoReleaserLeft {
            continue; // the caller's own `may_release_now`
        }
        assert!(
            codes.contains(&trigger.code()),
            "{trigger:?} has no refusal at the command"
        );
    }
}

#[test]
fn only_the_rooms_owner_and_admins_as_people_configure_and_approve() {
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for holds in [true, false] {
                let c = caller("x", kind, role);
                let expected = if role == Role::None {
                    Err(ReleaseDenial::NotParticipant)
                } else if kind == Person && matches!(role, Role::Owner | Role::Admin) && holds {
                    Ok(())
                } else {
                    Err(ReleaseDenial::NotAllowed)
                };
                for change in [
                    ConfigChange::TurnOn,
                    ConfigChange::Change,
                    ConfigChange::TurnOff,
                ] {
                    assert_eq!(
                        authorize_release_config(&c, holds, &ReleaseRoom::OPEN, change),
                        expected,
                        "{kind:?} {role:?} {holds} {change:?}"
                    );
                }
                assert_eq!(
                    authorize_approval(&c, holds, &ReleaseRoom::OPEN),
                    expected,
                    "{kind:?} {role:?} {holds}"
                );
            }
        }
    }
}

#[test]
fn configuring_and_approving_refuse_where_release_cant_happen_but_switching_off_never_does() {
    let owner = caller("per_owner", Person, Role::Owner);
    for (change, denial) in ROOM_CHANGES {
        let mut room = ReleaseRoom::OPEN;
        change(&mut room);
        // Switching release on is what changes the room's own switch, so that fact alone doesn't refuse it.
        let turn_on = if denial == ReleaseDenial::ReleaseOff {
            Ok(())
        } else {
            Err(denial)
        };
        assert_eq!(
            authorize_release_config(&owner, true, &room, ConfigChange::TurnOn),
            turn_on,
            "{denial:?}"
        );
        assert_eq!(
            authorize_release_config(&owner, true, &room, ConfigChange::Change),
            Err(denial),
            "{denial:?}"
        );
        assert_eq!(
            authorize_approval(&owner, true, &room),
            Err(denial),
            "{denial:?}"
        );
        assert_eq!(
            authorize_release_config(&owner, true, &room, ConfigChange::TurnOff),
            Ok(()),
            "{denial:?}"
        );
    }
    // Someone who may not configure learns nothing about the room from the answer.
    let mut private = ReleaseRoom::OPEN;
    private.public = false;
    assert_eq!(
        authorize_approval(&caller("per_m", Person, Role::Member), true, &private),
        Err(ReleaseDenial::NotAllowed)
    );
}

#[test]
fn approving_needs_no_grant_and_self_approval_is_allowed() {
    // An admin with no deployment grant approves (decision 215); the grant isn't an input to approval at all.
    assert_eq!(
        authorize_approval(
            &caller("per_admin", Person, Role::Admin),
            true,
            &ReleaseRoom::OPEN
        ),
        Ok(())
    );
    // The person who asked, or whose agent asked, may approve: approval takes no requester.
    let asker = caller("per_owner", Person, Role::Owner);
    let g = grant("per_owner");
    assert_eq!(
        authorize_deploy_release(&asker, &ReleaseRoom::OPEN, &standing(Some(&g))),
        Ok(())
    );
    assert_eq!(authorize_approval(&asker, true, &ReleaseRoom::OPEN), Ok(()));
    // An agent with the grant gets nothing toward approving.
    assert_eq!(
        authorize_approval(
            &caller("agt_a", Agent, Role::Admin),
            true,
            &ReleaseRoom::OPEN
        ),
        Err(ReleaseDenial::NotAllowed)
    );
}

#[test]
fn a_deployment_grant_counts_only_for_deploy_on_the_rooms_repository_live_and_with_its_giver() {
    let live = grant("agt_a");
    let check = |g: Option<&DeployGrant>, who: &str, repo: i64, holder: Option<&str>| {
        check_deploy_grant(g, who, repo, holder, NOW)
    };
    assert_eq!(check(Some(&live), "agt_a", REPO, Some("per_owner")), Ok(()));
    assert_eq!(
        check(None, "agt_a", REPO, Some("per_owner")),
        Err(GrantRefusal::GrantRequired)
    );
    assert_eq!(
        check(Some(&live), "agt_b", REPO, Some("per_owner")),
        Err(GrantRefusal::GrantRequired)
    );
    // Another action or another repository is no grant at all.
    for action in ["push", "merge", "Deploy", ""] {
        let other = DeployGrant { action, ..live };
        assert_eq!(
            check(Some(&other), "agt_a", REPO, Some("per_owner")),
            Err(GrantRefusal::GrantRequired),
            "{action}"
        );
    }
    assert_eq!(
        check(Some(&live), "agt_a", REPO + 1, Some("per_owner")),
        Err(GrantRefusal::GrantRequired)
    );
    let revoked = DeployGrant {
        revoked_at: Some(NOW - 1),
        ..live
    };
    assert_eq!(
        check(Some(&revoked), "agt_a", REPO, Some("per_owner")),
        Err(GrantRefusal::GrantRequired)
    );
    let expiring = DeployGrant {
        expires_at: Some(NOW + 1),
        ..live
    };
    assert_eq!(
        check(Some(&expiring), "agt_a", REPO, Some("per_owner")),
        Ok(())
    );
    let expired = DeployGrant {
        expires_at: Some(NOW),
        ..live
    };
    assert_eq!(
        check(Some(&expired), "agt_a", REPO, Some("per_owner")),
        Err(GrantRefusal::GrantExpired)
    );
    // The giver lost authority, or someone else holds it now: stale.
    assert_eq!(
        check(Some(&live), "agt_a", REPO, None),
        Err(GrantRefusal::GrantStale)
    );
    assert_eq!(
        check(Some(&live), "agt_a", REPO, Some("per_admin")),
        Err(GrantRefusal::GrantStale)
    );
    assert_eq!(
        delegation_holder("per_owner", Person, Role::Owner, true),
        Some("per_owner")
    );
    assert_eq!(
        delegation_holder("per_admin", Person, Role::Admin, true),
        Some("per_admin")
    );
    assert_eq!(
        delegation_holder("per_owner", Person, Role::Owner, false),
        None
    );
    assert_eq!(delegation_holder("agt_x", Agent, Role::Owner, true), None);
    assert_eq!(delegation_holder("per_m", Person, Role::Member, true), None);
}

#[test]
fn only_a_public_room_releases_and_a_private_rooms_request_is_refused_by_name() {
    let g = grant("agt_a");
    let agent = caller("agt_a", Agent, Role::Member);
    let mut private = ReleaseRoom::OPEN;
    private.public = false;
    assert_eq!(
        authorize_deploy_release(&agent, &private, &standing(Some(&g))),
        Err(ReleaseDenial::NeedsPublicRoom)
    );
    assert_eq!(
        ReleaseDenial::NeedsPublicRoom.code(),
        "release_needs_public_room"
    );
    assert_eq!(
        require_public_room(false),
        Err(ReleaseDenial::NeedsPublicRoom)
    );
    assert_eq!(require_public_room(true), Ok(()));
    // Someone outside the room learns nothing of its visibility.
    assert_eq!(
        authorize_deploy_release(
            &caller("per_x", Person, Role::None),
            &private,
            &standing(None)
        ),
        Err(ReleaseDenial::NotParticipant)
    );
    // A participant in a private room is told that before anything about a grant.
    assert_eq!(
        authorize_deploy_release(
            &caller("per_m", Person, Role::Member),
            &private,
            &standing(None)
        ),
        Err(ReleaseDenial::NeedsPublicRoom)
    );
    // Every other fact refuses the command too.
    for (change, denial) in ROOM_CHANGES {
        let mut room = ReleaseRoom::OPEN;
        change(&mut room);
        assert_eq!(
            authorize_deploy_release(&agent, &room, &standing(Some(&g))),
            Err(denial),
            "{denial:?}"
        );
    }
}

#[test]
fn asking_for_a_release_needs_the_grant_not_a_review_a_merge_grant_or_a_role() {
    let g = grant("agt_a");
    let agent = caller("agt_a", Agent, Role::Member);
    assert_eq!(
        authorize_deploy_release(&agent, &ReleaseRoom::OPEN, &standing(Some(&g))),
        Ok(())
    );
    for (id, kind, role) in [
        ("per_owner", Person, Role::Owner),
        ("per_rev", Person, Role::Member),
        ("agt_b", Agent, Role::Admin),
    ] {
        assert_eq!(
            authorize_deploy_release(
                &caller(id, kind, role),
                &ReleaseRoom::OPEN,
                &standing(Some(&g))
            ),
            Err(ReleaseDenial::Grant(GrantRefusal::GrantRequired)),
            "{id}"
        );
    }
    let merge = DeployGrant {
        action: "merge",
        ..grant("agt_a")
    };
    assert_eq!(
        authorize_deploy_release(&agent, &ReleaseRoom::OPEN, &standing(Some(&merge))),
        Err(ReleaseDenial::Grant(GrantRefusal::GrantRequired))
    );
    let p = grant("per_m");
    let person_standing = ReleaseStanding {
        agent_connected: false,
        ..standing(Some(&p))
    };
    assert_eq!(
        authorize_deploy_release(
            &caller("per_m", Person, Role::Member),
            &ReleaseRoom::OPEN,
            &person_standing
        ),
        Ok(())
    );
}

#[test]
fn may_release_now_is_the_jobs_test_too() {
    let g = grant("agt_a");
    let ok = standing(Some(&g));
    assert_eq!(may_release_now("agt_a", Agent, Role::Member, &ok), Ok(()));
    assert_eq!(
        may_release_now("agt_a", Agent, Role::None, &ok),
        Err(ReleaseDenial::NotParticipant)
    );
    let public = ReleaseStanding {
        through_public_claim: true,
        ..ok
    };
    assert_eq!(
        may_release_now("agt_a", Agent, Role::Guest, &public),
        Err(ReleaseDenial::PublicParticipant)
    );
    let disconnected = ReleaseStanding {
        agent_connected: false,
        ..ok
    };
    assert_eq!(
        may_release_now("agt_a", Agent, Role::Member, &disconnected),
        Err(ReleaseDenial::AgentDisconnected)
    );
    assert_eq!(
        ReleaseDenial::AgentDisconnected.code(),
        "agent_not_connected"
    );
    let giver_gone = ReleaseStanding {
        delegation_holder: None,
        ..ok
    };
    assert_eq!(
        may_release_now("agt_a", Agent, Role::Member, &giver_gone),
        Err(ReleaseDenial::Grant(GrantRefusal::GrantStale))
    );
    let moved = ReleaseStanding {
        link_repo_id: REPO + 1,
        ..ok
    };
    assert_eq!(
        may_release_now("agt_a", Agent, Role::Member, &moved),
        Err(ReleaseDenial::Grant(GrantRefusal::GrantRequired))
    );
    let short = DeployGrant {
        expires_at: Some(NOW + 10),
        ..g
    };
    let later = ReleaseStanding {
        grant: Some(&short),
        now: NOW + 10,
        ..ok
    };
    assert_eq!(
        may_release_now("agt_a", Agent, Role::Member, &later),
        Err(ReleaseDenial::Grant(GrantRefusal::GrantExpired))
    );
}

#[test]
fn each_kind_of_caller_sees_only_its_share_of_release_state() {
    let view = |kind, role, holds, sees_task, operator| {
        release_view(&caller("x", kind, role), holds, sees_task, operator)
    };
    assert_eq!(
        view(Person, Role::Owner, true, false, false),
        ReleaseView::Full
    );
    assert_eq!(
        view(Person, Role::Admin, true, false, false),
        ReleaseView::Full
    );
    // A lapsed owner or admin doesn't see everything.
    assert_eq!(
        view(Person, Role::Owner, false, true, false),
        ReleaseView::TaskStatus
    );
    assert_eq!(
        view(Person, Role::Admin, false, false, false),
        ReleaseView::Nothing
    );
    assert_eq!(
        view(Agent, Role::Owner, true, true, false),
        ReleaseView::TaskStatus
    );
    assert_eq!(
        view(Agent, Role::Admin, true, false, false),
        ReleaseView::Nothing
    );
    assert_eq!(
        view(Person, Role::Member, true, true, false),
        ReleaseView::TaskStatus
    );
    assert_eq!(
        view(Person, Role::Member, true, false, false),
        ReleaseView::Nothing
    );
    assert_eq!(
        view(Person, Role::Guest, true, true, false),
        ReleaseView::TaskStatus
    );
    // An operator sees the app and its suspension, and nothing private; a public viewer sees nothing.
    assert_eq!(
        view(Person, Role::None, false, false, true),
        ReleaseView::OperatorApp
    );
    assert_eq!(
        view(Agent, Role::None, false, false, true),
        ReleaseView::Nothing
    );
    assert_eq!(
        view(Person, Role::None, false, true, false),
        ReleaseView::Nothing
    );
    assert_eq!(
        view(Person, Role::None, false, false, false),
        ReleaseView::Nothing
    );
}

#[test]
fn declining_is_allowed_wherever_the_room_can_still_be_acted_on() {
    let owner = caller("per_owner", Person, Role::Owner);
    for (change, denial) in ROOM_CHANGES {
        let mut room = ReleaseRoom::OPEN;
        change(&mut room);
        let expected = match denial {
            ReleaseDenial::Deleted | ReleaseDenial::OrganizationDeleted => Err(denial),
            _ => Ok(()),
        };
        assert_eq!(
            authorize_decline(&owner, true, &room),
            expected,
            "{denial:?}"
        );
    }
    // Who may decline is who may approve: never an agent, a member, or a lapsed owner.
    assert_eq!(
        authorize_decline(
            &caller("agt_a", Agent, Role::Owner),
            true,
            &ReleaseRoom::OPEN
        ),
        Err(ReleaseDenial::NotAllowed)
    );
    assert_eq!(
        authorize_decline(
            &caller("per_m", Person, Role::Member),
            true,
            &ReleaseRoom::OPEN
        ),
        Err(ReleaseDenial::NotAllowed)
    );
    assert_eq!(
        authorize_decline(&owner, false, &ReleaseRoom::OPEN),
        Err(ReleaseDenial::NotAllowed)
    );
    assert_eq!(
        authorize_decline(
            &caller("per_x", Person, Role::None),
            true,
            &ReleaseRoom::OPEN
        ),
        Err(ReleaseDenial::NotParticipant)
    );
}
