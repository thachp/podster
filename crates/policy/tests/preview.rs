#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! Who may view a preview, and who may make, replace, delete or map one (M8 step 4; the preview plan's 5.3, 5.6, 5.7
//! and 9.1; decisions 251, 252 and 253): viewing by a person's own role in the room, managing by the room's owner and
//! admins as people, never an agent.

use podster_core::preview::DeploymentPreviews;
use podster_policy::preview::*;
use podster_policy::release::{ReleaseDenial, ReleaseRoom};
use podster_policy::*;
use PrincipalKind::*;

fn caller(kind: PrincipalKind, role: Role) -> Caller {
    Caller {
        id: "per_X1".into(),
        kind,
        role,
        scopes: Scopes::for_role(role, false),
    }
}

const STANDS: ViewStanding = ViewStanding {
    through_public_claim: false,
    place_holds: true,
};

// --- may_view ----------------------------------------------------------------------------------------------------------

#[test]
fn a_person_with_any_role_of_their_own_may_view() {
    for role in [Role::Owner, Role::Admin, Role::Member, Role::Guest] {
        assert_eq!(may_view(&caller(Person, role), STANDS), Ok(()), "{role:?}");
    }
}

#[test]
fn an_agent_never_views_whatever_role_is_stored_for_it() {
    for role in Role::ALL {
        let result = may_view(&caller(Agent, role), STANDS);
        assert!(result.is_err(), "{role:?}");
        if role != Role::None {
            assert_eq!(result, Err(PreviewDenial::NotAllowed), "{role:?}");
        }
    }
}

#[test]
fn nobody_without_a_role_here_views_an_organization_admins_oversight_included() {
    // An organization admin's read-only oversight and a person from another organization with no role are both no
    // role in the room.
    assert_eq!(
        may_view(&caller(Person, Role::None), STANDS),
        Err(PreviewDenial::NotParticipant)
    );
}

#[test]
fn someone_here_only_through_a_public_claim_never_views() {
    let claim = ViewStanding {
        through_public_claim: true,
        ..STANDS
    };
    for role in [Role::Owner, Role::Admin, Role::Member, Role::Guest] {
        assert_eq!(
            may_view(&caller(Person, role), claim),
            Err(PreviewDenial::PublicParticipant),
            "{role:?}"
        );
    }
}

#[test]
fn a_person_whose_place_no_longer_holds_doesnt_view() {
    let gone = ViewStanding {
        place_holds: false,
        ..STANDS
    };
    for role in [Role::Owner, Role::Admin, Role::Member, Role::Guest] {
        assert_eq!(
            may_view(&caller(Person, role), gone),
            Err(PreviewDenial::NotAllowed),
            "{role:?}"
        );
    }
}

/// Every combination of kind, role, claim and standing: viewing is exactly a person, with a role, not through a public
/// claim, whose place holds.
#[test]
fn exhaustively_may_view_is_exactly_a_person_with_a_role_of_their_own() {
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for through_public_claim in [false, true] {
                for place_holds in [false, true] {
                    let standing = ViewStanding {
                        through_public_claim,
                        place_holds,
                    };
                    let expected = kind == Person
                        && role != Role::None
                        && !through_public_claim
                        && place_holds;
                    assert_eq!(
                        may_view(&caller(kind, role), standing).is_ok(),
                        expected,
                        "{kind:?} {role:?} {standing:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn reading_the_preview_answers_who_first_and_previews_off_after() {
    let off = DeploymentPreviews::Off;
    let undecided = DeploymentPreviews::Undecided;
    assert_eq!(
        authorize_preview_read(
            &caller(Person, Role::Member),
            STANDS,
            DeploymentPreviews::On
        ),
        Ok(())
    );
    for previews in [off, undecided] {
        assert_eq!(
            authorize_preview_read(&caller(Person, Role::Member), STANDS, previews),
            Err(PreviewDenial::PreviewsOff)
        );
        // Who is asking comes first: refused callers never learn previews are off.
        assert_eq!(
            authorize_preview_read(&caller(Agent, Role::Admin), STANDS, previews),
            Err(PreviewDenial::NotAllowed)
        );
        assert_eq!(
            authorize_preview_read(&caller(Person, Role::None), STANDS, previews),
            Err(PreviewDenial::NotParticipant)
        );
    }
    assert_eq!(PreviewDenial::PreviewsOff.code(), "previews_off");
}

// --- managing ----------------------------------------------------------------------------------------------------------

const CHANGES: [PreviewChange; 6] = [
    PreviewChange::Request,
    PreviewChange::Delete,
    PreviewChange::HostnameRead,
    PreviewChange::HostnameRequest,
    PreviewChange::HostnameRemove,
    PreviewChange::HostnameCheck,
];

#[test]
fn only_the_owner_and_admins_as_people_manage_a_preview() {
    let on = DeploymentPreviews::On;
    for change in CHANGES {
        for role in [Role::Owner, Role::Admin] {
            assert_eq!(
                authorize_preview_change(
                    &caller(Person, role),
                    true,
                    on,
                    &ReleaseRoom::OPEN,
                    change
                ),
                Ok(()),
                "{change:?} {role:?}"
            );
        }
        for role in [Role::Member, Role::Guest] {
            assert_eq!(
                authorize_preview_change(
                    &caller(Person, role),
                    true,
                    on,
                    &ReleaseRoom::OPEN,
                    change
                ),
                Err(PreviewDenial::NotAllowed),
                "{change:?} {role:?}"
            );
        }
        // Decision 253: never an agent, an agent stored as owner or admin included, and no grant changes that.
        for role in [Role::Owner, Role::Admin, Role::Member, Role::Guest] {
            assert_eq!(
                authorize_preview_change(
                    &caller(Agent, role),
                    true,
                    on,
                    &ReleaseRoom::OPEN,
                    change
                ),
                Err(PreviewDenial::NotAllowed),
                "{change:?} {role:?}"
            );
        }
        assert_eq!(
            authorize_preview_change(
                &caller(Person, Role::None),
                true,
                on,
                &ReleaseRoom::OPEN,
                change
            ),
            Err(PreviewDenial::NotParticipant),
            "{change:?}"
        );
        // An owner or admin no longer in the organization their place is held in.
        assert_eq!(
            authorize_preview_change(
                &caller(Person, Role::Owner),
                false,
                on,
                &ReleaseRoom::OPEN,
                change
            ),
            Err(PreviewDenial::NotAllowed),
            "{change:?}"
        );
    }
}

#[test]
fn a_private_room_may_have_a_preview() {
    let private = ReleaseRoom {
        public: false,
        ..ReleaseRoom::OPEN
    };
    for change in CHANGES {
        assert_eq!(
            authorize_preview_change(
                &caller(Person, Role::Owner),
                true,
                DeploymentPreviews::On,
                &private,
                change
            ),
            Ok(()),
            "{change:?}"
        );
    }
}

type RoomChange = fn(&mut ReleaseRoom);

/// The room's facts that stop asking for a preview, each with its code, in the contract's order.
const ROOM_STOPS: [(RoomChange, ReleaseDenial); 10] = [
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
fn asking_needs_previews_on_then_everything_release_needs_but_a_public_room() {
    let owner = caller(Person, Role::Owner);
    for change in [
        PreviewChange::Request,
        PreviewChange::HostnameRequest,
        PreviewChange::HostnameCheck,
        PreviewChange::HostnameRead,
    ] {
        for previews in [DeploymentPreviews::Off, DeploymentPreviews::Undecided] {
            assert_eq!(
                authorize_preview_change(&owner, true, previews, &ReleaseRoom::OPEN, change),
                Err(PreviewDenial::PreviewsOff),
                "{change:?}"
            );
        }
        for (stop, denial) in ROOM_STOPS {
            let mut room = ReleaseRoom::OPEN;
            stop(&mut room);
            let expected = if change == PreviewChange::HostnameRead {
                Ok(())
            } else {
                Err(PreviewDenial::Release(denial))
            };
            assert_eq!(
                authorize_preview_change(&owner, true, DeploymentPreviews::On, &room, change),
                expected,
                "{change:?} {denial:?}"
            );
            // previews_off is answered before any fact of the room.
            assert_eq!(
                authorize_preview_change(&owner, true, DeploymentPreviews::Off, &room, change),
                Err(PreviewDenial::PreviewsOff),
                "{change:?} {denial:?}"
            );
        }
    }
}

#[test]
fn every_room_stop_is_answered_in_order_and_before_the_askers_own_record() {
    let owner = caller(Person, Role::Owner);
    // Stack the stops from the last to the first: each time, the first that applies is the answer.
    let mut room = ReleaseRoom::OPEN;
    for (stop, denial) in ROOM_STOPS.iter().rev() {
        stop(&mut room);
        assert_eq!(
            authorize_preview_change(
                &owner,
                false,
                DeploymentPreviews::On,
                &room,
                PreviewChange::Request
            ),
            Err(PreviewDenial::Release(*denial))
        );
    }
}

#[test]
fn deleting_and_removing_pass_no_gate() {
    let owner = caller(Person, Role::Owner);
    let mut worst = ReleaseRoom::OPEN;
    for (stop, _) in ROOM_STOPS {
        stop(&mut worst);
    }
    worst.public = false;
    for change in [PreviewChange::Delete, PreviewChange::HostnameRemove] {
        for previews in [
            DeploymentPreviews::On,
            DeploymentPreviews::Off,
            DeploymentPreviews::Undecided,
        ] {
            assert_eq!(
                authorize_preview_change(&owner, true, previews, &worst, change),
                Ok(()),
                "{change:?} {previews:?}"
            );
        }
    }
}

// --- the access route --------------------------------------------------------------------------------------------------

const FACTS: AccessFacts = AccessFacts {
    host_is_rooms_preview_host: true,
    preview_exists: true,
    preview_suspended: false,
};

#[test]
fn access_is_given_on_the_rooms_own_preview_host_to_whoever_may_view() {
    assert_eq!(
        decide_access(&caller(Person, Role::Guest), STANDS, FACTS),
        Ok(())
    );
}

#[test]
fn every_refusal_of_access_is_one_answer() {
    let cases = [
        (
            caller(Person, Role::Owner),
            STANDS,
            AccessFacts {
                host_is_rooms_preview_host: false,
                ..FACTS
            },
            PreviewAccessRefusal::NotThisRoomsPreviewHost,
        ),
        (
            caller(Person, Role::Owner),
            STANDS,
            AccessFacts {
                preview_exists: false,
                ..FACTS
            },
            PreviewAccessRefusal::NoPreview,
        ),
        (
            caller(Person, Role::Owner),
            STANDS,
            AccessFacts {
                preview_suspended: true,
                ..FACTS
            },
            PreviewAccessRefusal::Suspended,
        ),
        (
            caller(Agent, Role::Owner),
            STANDS,
            FACTS,
            PreviewAccessRefusal::Viewer(PreviewDenial::NotAllowed),
        ),
        (
            caller(Person, Role::None),
            STANDS,
            FACTS,
            PreviewAccessRefusal::Viewer(PreviewDenial::NotParticipant),
        ),
        (
            caller(Person, Role::Member),
            ViewStanding {
                through_public_claim: true,
                ..STANDS
            },
            FACTS,
            PreviewAccessRefusal::Viewer(PreviewDenial::PublicParticipant),
        ),
    ];
    for (who, standing, facts, refusal) in cases {
        let result = decide_access(&who, standing, facts);
        assert_eq!(result, Err(refusal));
        assert_eq!(refusal.code(), "preview_access_refused");
    }
}

#[test]
fn the_host_is_checked_before_anything_about_the_caller() {
    // A stranger asking about a host that isn't this room's learns only the one answer, by the host check.
    let result = decide_access(
        &caller(Person, Role::None),
        STANDS,
        AccessFacts {
            host_is_rooms_preview_host: false,
            preview_exists: false,
            preview_suspended: true,
        },
    );
    assert_eq!(result, Err(PreviewAccessRefusal::NotThisRoomsPreviewHost));
}

// --- the epoch on role changes -----------------------------------------------------------------------------------------

#[test]
fn a_role_lowered_or_taken_away_raises_the_epoch_and_a_role_raised_doesnt() {
    let rank = |r: Role| Role::ALL.iter().position(|x| *x == r).unwrap();
    for before in Role::ALL {
        for after in Role::ALL {
            // Role::ALL runs from the most to the least.
            assert_eq!(
                role_change_raises_epoch(before, after),
                rank(after) > rank(before),
                "{before:?} -> {after:?}"
            );
        }
    }
}
