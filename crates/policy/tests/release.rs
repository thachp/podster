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
const ROOM_CHANGES: [(RoomChange, ReleaseDenial); 11] = [
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
    (
        |r| r.organization_may_provision = false,
        ReleaseDenial::ProvisioningNotDelegated,
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
fn only_the_rooms_owner_or_an_admin_as_a_person_deletes_its_apps_data() {
    // S4 of the store plan, decision 220 (7): the owner or an admin, as a person, while their authority holds. Never a
    // member, and never an agent, an agent holding the admin role included.
    let mut allowed = Vec::new();
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for holds in [true, false] {
                let got = authorize_app_data_delete(&caller("x", kind, role), holds);
                let expected = if role == Role::None {
                    Err(ReleaseDenial::NotParticipant)
                } else if kind == Person && matches!(role, Role::Owner | Role::Admin) && holds {
                    Ok(())
                } else {
                    Err(ReleaseDenial::NotAllowed)
                };
                assert_eq!(got, expected, "{kind:?} {role:?} {holds}");
                if got.is_ok() {
                    allowed.push((kind, role, holds));
                }
            }
        }
    }
    assert_eq!(
        allowed,
        [(Person, Role::Owner, true), (Person, Role::Admin, true)]
    );
    assert_eq!(
        authorize_app_data_delete(&caller("x", Agent, Role::Admin), true),
        Err(ReleaseDenial::NotAllowed)
    );
}

#[test]
fn only_those_who_configure_release_map_a_custom_hostname_and_only_where_release_may_happen() {
    // M6 step 8: asking to map a name is a change to the release configuration, so it needs everything a change
    // needs, release switched on in the room among them. Removing one only takes down, so it is always theirs.
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
                for change in [HostnameChange::Request, HostnameChange::Remove] {
                    assert_eq!(
                        authorize_custom_hostname(&c, holds, &ReleaseRoom::OPEN, change),
                        expected,
                        "{kind:?} {role:?} {holds} {change:?}"
                    );
                }
            }
        }
    }
    let owner = caller("per_owner", Person, Role::Owner);
    for (change, denial) in ROOM_CHANGES {
        let mut room = ReleaseRoom::OPEN;
        change(&mut room);
        assert_eq!(
            authorize_custom_hostname(&owner, true, &room, HostnameChange::Request),
            Err(denial),
            "{denial:?}"
        );
        assert_eq!(
            authorize_custom_hostname(&owner, true, &room, HostnameChange::Remove),
            Ok(()),
            "{denial:?}"
        );
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

#[test]
fn the_two_organization_denials_share_a_code_and_keep_their_cause() {
    use podster_core::release::NotDelegatedCause;
    assert_eq!(
        ReleaseDenial::NotDelegated.not_delegated_cause(),
        Some(NotDelegatedCause::ReleaseSwitch)
    );
    assert_eq!(
        ReleaseDenial::ProvisioningNotDelegated.not_delegated_cause(),
        Some(NotDelegatedCause::ProvisioningDelegation)
    );
    for (_, denial) in ROOM_CHANGES {
        let expected = match denial {
            ReleaseDenial::NotDelegated => Some(NotDelegatedCause::ReleaseSwitch),
            ReleaseDenial::ProvisioningNotDelegated => {
                Some(NotDelegatedCause::ProvisioningDelegation)
            }
            _ => None,
        };
        assert_eq!(denial.not_delegated_cause(), expected, "{denial:?}");
    }
    assert_eq!(ReleaseDenial::NotAllowed.not_delegated_cause(), None);
}

#[test]
fn only_an_operator_as_a_person_sets_the_release_switch() {
    assert_eq!(authorize_release_switch_set(Person, true), Ok(()));
    assert_eq!(
        authorize_release_switch_set(Person, false),
        Err(ReleaseDenial::NotAllowed)
    );
    for operator in [true, false] {
        assert_eq!(
            authorize_release_switch_set(Agent, operator),
            Err(ReleaseDenial::NotAllowed),
            "{operator}"
        );
    }
}

#[test]
fn an_operator_or_the_organizations_admin_reads_the_release_switch() {
    assert_eq!(authorize_release_switch_read(Person, true, false), Ok(()));
    assert_eq!(authorize_release_switch_read(Person, false, true), Ok(()));
    assert_eq!(authorize_release_switch_read(Person, true, true), Ok(()));
    assert_eq!(
        authorize_release_switch_read(Person, false, false),
        Err(ReleaseDenial::NotAllowed)
    );
    for (operator, admin) in [(true, true), (true, false), (false, true), (false, false)] {
        assert_eq!(
            authorize_release_switch_read(Agent, operator, admin),
            Err(ReleaseDenial::NotAllowed),
            "{operator} {admin}"
        );
    }
}

#[test]
fn a_switch_notice_acts_only_on_a_room_of_the_organization_it_names() {
    assert!(release_switch_notice_is_for_room("org_a", "org_a"));
    for (room, notice) in [
        ("org_a", "org_b"),
        ("org_a", ""),
        ("", ""),
        ("", "org_a"),
        ("org_a", "org_a "),
        ("org_a", "ORG_A"),
    ] {
        assert!(
            !release_switch_notice_is_for_room(room, notice),
            "{room:?} {notice:?}"
        );
    }
}

// --- somebody who may release remains (the interim rule) -------------------------------------------------------------

#[test]
fn someone_may_release_while_the_owner_holds_or_a_person_admin_keeps_their_place() {
    let person = |stands| AdminPlace {
        kind: PrincipalKind::Person,
        place_stands: stands,
    };
    let agent = |stands| AdminPlace {
        kind: PrincipalKind::Agent,
        place_stands: stands,
    };
    // Someone may.
    assert!(someone_may_release(true, &[]));
    assert!(someone_may_release(false, &[person(true)]));
    assert!(someone_may_release(
        false,
        &[agent(true), person(false), person(true)]
    ));
    // Nobody may: the owner left, and no person admin's place stands. An agent never counts.
    assert!(!someone_may_release(false, &[]));
    assert!(!someone_may_release(false, &[person(false)]));
    assert!(!someone_may_release(false, &[agent(true)]));
    assert!(!someone_may_release(false, &[agent(true), person(false)]));
}

#[test]
fn the_proof_job_goes_on_only_where_asking_still_could_and_waits_on_what_it_cant_read() {
    // M6 step 8, the deep review's S3: before each look and each ask, the room's own facts that asking checked.
    let open = HostnameProofRoom::OPEN;
    assert_eq!(hostname_proof_room(&open), HostnameProofStep::Go);
    type Change = fn(&mut HostnameProofRoom);
    let ends: [(Change, ReleaseDenial); 7] = [
        (
            |r| r.organization_exists = false,
            ReleaseDenial::OrganizationDeleted,
        ),
        (
            |r| r.organization_may_release = Some(false),
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
    ];
    for (change, denial) in ends {
        let mut room = open;
        change(&mut room);
        assert_eq!(
            hostname_proof_room(&room),
            HostnameProofStep::End(denial),
            "{denial:?}"
        );
        // A fact read and failing ends it even while the organization's switch can't be read.
        if denial != ReleaseDenial::NotDelegated {
            room.organization_may_release = None;
            assert_eq!(
                hostname_proof_room(&room),
                HostnameProofStep::End(denial),
                "{denial:?}, the switch unread"
            );
        }
    }
    // The organization's switch, as the room last applied it, can't be read: nothing is looked up or asked, and
    // nothing ends.
    let unread = HostnameProofRoom {
        organization_may_release: None,
        ..open
    };
    assert_eq!(hostname_proof_room(&unread), HostnameProofStep::Wait);
}

fn link(person: &str, linked_since: i64, generation: u64) -> ControllerLink<'_> {
    ControllerLink {
        person,
        linked_since,
        generation,
    }
}

#[test]
fn an_agents_controller_holds_only_while_its_link_is_exactly_the_one_recorded() {
    let recorded = link("per_c", 10, 3);
    assert!(controller_unchanged(
        Some(&recorded),
        Some(&link("per_c", 10, 3))
    ));
    // Another person, a link made again (a later generation of the link) or a connection made again: not the same.
    for (why, current) in [
        ("another person", link("per_d", 10, 3)),
        ("the link made again", link("per_c", 11, 3)),
        ("the agent connected again", link("per_c", 10, 4)),
    ] {
        assert!(
            !controller_unchanged(Some(&recorded), Some(&current)),
            "{why}"
        );
    }
    // Nothing on record, nothing now, or neither: never a match. Two missing values are not a match.
    assert!(!controller_unchanged(None, Some(&recorded)));
    assert!(!controller_unchanged(Some(&recorded), None));
    assert!(!controller_unchanged(None, None));
}

#[test]
fn an_agent_asks_only_with_a_controller_on_record_and_never_through_a_public_claim() {
    let g = grant("agt_a");
    let room = ReleaseRoom::OPEN;
    let agent = caller("agt_a", Agent, Role::Member);
    let held = standing(Some(&g));
    // A connected agent with a live grant, whose controlling person still holds, may ask (6g).
    assert_eq!(
        authorize_release_request(&agent, &room, &held, true),
        Ok(())
    );
    assert_eq!(may_ask_for_deploy(&agent, true), Ok(()));
    // With no controlling person on its credential, it is refused before anything is read.
    assert_eq!(
        may_ask_for_deploy(&agent, false),
        Err(ReleaseDenial::AgentDisconnected)
    );
    // A person needs no link: they are their own controller.
    assert_eq!(
        may_ask_for_deploy(&caller("per_m", Person, Role::Member), false),
        Ok(())
    );
    assert_eq!(
        may_ask_for_deploy(&caller("agt_a", Agent, Role::None), true),
        Err(ReleaseDenial::NotParticipant)
    );
    // Its controlling person having left the organization refuses it as an agent no longer connected.
    assert_eq!(
        authorize_release_request(&agent, &room, &held, false),
        Err(ReleaseDenial::AgentDisconnected)
    );
    // Its link not the one recorded, or its connection gone.
    let moved = ReleaseStanding {
        agent_connected: false,
        ..held
    };
    assert_eq!(
        authorize_release_request(&agent, &room, &moved, true),
        Err(ReleaseDenial::AgentDisconnected)
    );
    // Through a public claim, whatever it holds (decision 159): refused by that, before its grant.
    let public = ReleaseStanding {
        through_public_claim: true,
        ..held
    };
    for role in [Role::Guest, Role::Member] {
        assert_eq!(
            authorize_release_request(&caller("agt_a", Agent, role), &room, &public, true),
            Err(ReleaseDenial::PublicParticipant),
            "{role:?}"
        );
    }
    // A rollback stays a person's: the person-only rule still refuses every agent.
    assert_eq!(may_ask_for_release(&agent), Err(ReleaseDenial::NotAllowed));
    // An agent asks by a grant of its own, whatever its role.
    for role in [Role::Admin, Role::Owner] {
        assert_eq!(
            authorize_release_request(&caller("agt_b", Agent, role), &room, &held, true),
            Err(ReleaseDenial::Grant(GrantRefusal::GrantRequired)),
            "{role:?}"
        );
    }
}

#[test]
fn a_persons_request_needs_what_asking_needs_and_their_own_standing() {
    let p = grant("per_m");
    let member = caller("per_m", Person, Role::Member);
    let room = ReleaseRoom::OPEN;
    let held = standing(Some(&p));
    assert_eq!(
        authorize_release_request(&member, &room, &held, true),
        Ok(())
    );
    // A person who left the organization their place here is held in may not, whatever else holds.
    assert_eq!(
        authorize_release_request(&member, &room, &held, false),
        Err(ReleaseDenial::NotAllowed)
    );
    // Someone not in the room learns nothing more.
    assert_eq!(
        authorize_release_request(&caller("per_m", Person, Role::None), &room, &held, true),
        Err(ReleaseDenial::NotParticipant)
    );
    // The room's facts refuse in the deployment rule's order, a private room first among the room's.
    for (change, denial) in ROOM_CHANGES {
        let mut room = ReleaseRoom::OPEN;
        change(&mut room);
        assert_eq!(
            authorize_release_request(&member, &room, &held, true),
            Err(denial)
        );
    }
    // The grant: none, another action, expired, or one whose giver no longer holds authority.
    let merge = DeployGrant {
        action: "merge",
        ..grant("per_m")
    };
    let expired = DeployGrant {
        expires_at: Some(NOW),
        ..grant("per_m")
    };
    let stale = ReleaseStanding {
        delegation_holder: None,
        ..standing(Some(&p))
    };
    for (why, standing, refusal) in [
        ("no grant", standing(None), GrantRefusal::GrantRequired),
        (
            "a merge grant",
            standing(Some(&merge)),
            GrantRefusal::GrantRequired,
        ),
        (
            "expired",
            standing(Some(&expired)),
            GrantRefusal::GrantExpired,
        ),
        ("its giver lost authority", stale, GrantRefusal::GrantStale),
    ] {
        assert_eq!(
            authorize_release_request(&member, &room, &standing, true),
            Err(ReleaseDenial::Grant(refusal)),
            "{why}"
        );
    }
    // In the room through a public claim only.
    let public = ReleaseStanding {
        through_public_claim: true,
        ..standing(Some(&p))
    };
    assert_eq!(
        authorize_release_request(&member, &room, &public, true),
        Err(ReleaseDenial::PublicParticipant)
    );
    // The owner and an admin ask as anyone does: by a grant of their own, not by their role.
    for role in [Role::Owner, Role::Admin] {
        assert_eq!(
            authorize_release_request(
                &caller("per_x", Person, role),
                &room,
                &standing(Some(&p)),
                true
            ),
            Err(ReleaseDenial::Grant(GrantRefusal::GrantRequired)),
            "{role:?}"
        );
    }
}
