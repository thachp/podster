//! Who may configure, ask for, approve and see a release (ADR 0010; decisions 213 and 215; AC-03, AC-10, AC-11, AC-17).

use podster_core::repo_grants::GrantRefusal;
use podster_policy::release::*;
use podster_policy::*;
use PrincipalKind::*;

const NOW: i64 = 1_000_000;

fn caller(id: &str, kind: PrincipalKind, role: Role) -> Caller {
    Caller {
        id: id.into(),
        kind,
        role,
        scopes: Scopes::for_role(role, false),
    }
}

fn grant<'a>(principal: &'a str) -> DeployGrant<'a> {
    DeployGrant {
        principal,
        delegated_by: "per_owner",
        expires_at: None,
        revoked_at: None,
    }
}

fn standing<'a>(grant: Option<&'a DeployGrant<'a>>) -> ReleaseStanding<'a> {
    ReleaseStanding {
        grant,
        delegation_holder: Some("per_owner"),
        through_public_claim: false,
        agent_connected: true,
        now: NOW,
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
                assert_eq!(
                    authorize_release_config(&c, holds),
                    expected,
                    "{kind:?} {role:?} {holds}"
                );
                assert_eq!(
                    authorize_approval(&c, holds),
                    expected,
                    "{kind:?} {role:?} {holds}"
                );
            }
        }
    }
}

#[test]
fn a_deployment_grant_counts_only_when_live_and_its_giver_still_holds_authority() {
    let live = grant("agt_a");
    assert_eq!(
        check_deploy_grant(Some(&live), "agt_a", Some("per_owner"), NOW),
        Ok(())
    );
    assert_eq!(
        check_deploy_grant(None, "agt_a", Some("per_owner"), NOW),
        Err(GrantRefusal::GrantRequired)
    );
    assert_eq!(
        check_deploy_grant(Some(&live), "agt_b", Some("per_owner"), NOW),
        Err(GrantRefusal::GrantRequired)
    );
    let revoked = DeployGrant {
        revoked_at: Some(NOW - 1),
        ..live
    };
    assert_eq!(
        check_deploy_grant(Some(&revoked), "agt_a", Some("per_owner"), NOW),
        Err(GrantRefusal::GrantRequired)
    );
    let expiring = DeployGrant {
        expires_at: Some(NOW + 1),
        ..live
    };
    assert_eq!(
        check_deploy_grant(Some(&expiring), "agt_a", Some("per_owner"), NOW),
        Ok(())
    );
    let expired = DeployGrant {
        expires_at: Some(NOW),
        ..live
    };
    assert_eq!(
        check_deploy_grant(Some(&expired), "agt_a", Some("per_owner"), NOW),
        Err(GrantRefusal::GrantExpired)
    );
    // The giver lost authority, or someone else holds it now: stale.
    assert_eq!(
        check_deploy_grant(Some(&live), "agt_a", None, NOW),
        Err(GrantRefusal::GrantStale)
    );
    assert_eq!(
        check_deploy_grant(Some(&live), "agt_a", Some("per_admin"), NOW),
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
    assert_eq!(
        authorize_deploy_release(&agent, false, &standing(Some(&g))),
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
    let outsider = caller("per_x", Person, Role::None);
    assert_eq!(
        authorize_deploy_release(&outsider, false, &standing(None)),
        Err(ReleaseDenial::NotParticipant)
    );
    // A participant in a private room is told that before anything about a grant.
    let member = caller("per_m", Person, Role::Member);
    assert_eq!(
        authorize_deploy_release(&member, false, &standing(None)),
        Err(ReleaseDenial::NeedsPublicRoom)
    );
}

#[test]
fn asking_for_a_release_needs_the_grant_not_a_review_a_merge_grant_or_a_role() {
    // An agent with the grant may ask (AC-17), and an agent never approves.
    let g = grant("agt_a");
    let agent = caller("agt_a", Agent, Role::Member);
    assert_eq!(
        authorize_deploy_release(&agent, true, &standing(Some(&g))),
        Ok(())
    );
    assert_eq!(
        authorize_approval(&caller("agt_a", Agent, Role::Owner), true),
        Err(ReleaseDenial::NotAllowed)
    );
    // The room's owner, a reviewer, anyone without a deployment grant: refused, whatever they did for the task.
    for (id, kind, role) in [
        ("per_owner", Person, Role::Owner),
        ("per_rev", Person, Role::Member),
        ("agt_b", Agent, Role::Admin),
    ] {
        assert_eq!(
            authorize_deploy_release(&caller(id, kind, role), true, &standing(Some(&g))),
            Err(ReleaseDenial::Grant(GrantRefusal::GrantRequired)),
            "{id}"
        );
    }
    // A person with the grant may ask too, and needs no connection.
    let p = grant("per_m");
    let person_standing = ReleaseStanding {
        agent_connected: false,
        ..standing(Some(&p))
    };
    assert_eq!(
        authorize_deploy_release(
            &caller("per_m", Person, Role::Member),
            true,
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
    // A grant dies with its giver: holding one isn't enough.
    let giver_gone = ReleaseStanding {
        delegation_holder: None,
        ..ok
    };
    assert_eq!(
        may_release_now("agt_a", Agent, Role::Member, &giver_gone),
        Err(ReleaseDenial::Grant(GrantRefusal::GrantStale))
    );
    let later = ReleaseStanding {
        now: NOW + 10,
        ..ok
    };
    let short = DeployGrant {
        expires_at: Some(NOW + 10),
        ..g
    };
    let short_standing = ReleaseStanding {
        grant: Some(&short),
        ..later
    };
    assert_eq!(
        may_release_now("agt_a", Agent, Role::Member, &short_standing),
        Err(ReleaseDenial::Grant(GrantRefusal::GrantExpired))
    );
}

#[test]
fn each_kind_of_caller_sees_only_its_share_of_release_state() {
    let view = |kind, role, sees_task, operator| {
        release_view(&caller("x", kind, role), sees_task, operator)
    };
    assert_eq!(view(Person, Role::Owner, false, false), ReleaseView::Full);
    assert_eq!(view(Person, Role::Admin, false, false), ReleaseView::Full);
    assert_eq!(
        view(Agent, Role::Owner, true, false),
        ReleaseView::TaskStatus
    );
    assert_eq!(view(Agent, Role::Admin, false, false), ReleaseView::Nothing);
    assert_eq!(
        view(Person, Role::Member, true, false),
        ReleaseView::TaskStatus
    );
    assert_eq!(
        view(Person, Role::Member, false, false),
        ReleaseView::Nothing
    );
    assert_eq!(
        view(Person, Role::Guest, true, false),
        ReleaseView::TaskStatus
    );
    // An operator sees the app and its suspension, and nothing private; a public viewer sees nothing.
    assert_eq!(
        view(Person, Role::None, false, true),
        ReleaseView::OperatorApp
    );
    assert_eq!(view(Agent, Role::None, false, true), ReleaseView::Nothing);
    assert_eq!(view(Person, Role::None, true, false), ReleaseView::Nothing);
    assert_eq!(view(Person, Role::None, false, false), ReleaseView::Nothing);
}
