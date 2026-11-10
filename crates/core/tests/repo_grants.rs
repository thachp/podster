#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::repo_grants::*;
use podster_core::repositories::GrantAction::{self, *};

const NOW: i64 = 1_800_000_000_000;
const HOUR: i64 = 60 * 60 * 1000;
const REPO: i64 = 4242;
const OTHER_REPO: i64 = 4243;

fn grant(action: GrantAction, expires_at: Option<i64>, revoked_at: Option<i64>) -> Grant<'static> {
    Grant {
        id: "g1",
        principal: "agent",
        provider_repo_id: REPO,
        action,
        delegated_by: "owner",
        expires_at,
        revoked_at,
    }
}

fn usage(action: GrantAction) -> GrantUse<'static> {
    GrantUse {
        principal: "agent",
        action,
        link_repo_id: REPO,
        delegation_holder: Some("owner"),
        now: NOW,
    }
}

#[test]
fn a_grant_is_live_until_it_expires_or_is_revoked() {
    for (name, g, live) in [
        ("no expiry", grant(Push, None, None), true),
        ("expires later", grant(Push, Some(NOW + 1), None), true),
        ("expires now", grant(Push, Some(NOW), None), false),
        ("expired", grant(Push, Some(NOW - HOUR), None), false),
        ("revoked", grant(Push, None, Some(NOW - 1)), false),
        (
            "revoked before its expiry",
            grant(Push, Some(NOW + HOUR), Some(NOW - 1)),
            false,
        ),
    ] {
        assert_eq!(g.is_live(NOW), live, "{name}");
    }
}

#[test]
fn granting_adds_a_row_replaces_one_or_changes_nothing() {
    let live = grant(Push, None, None);
    let live_until = grant(Push, Some(NOW + HOUR), None);
    let expired = grant(Push, Some(NOW - 1), None);
    let revoked = grant(Push, None, Some(NOW - 1));
    let merge = grant(Merge, None, None);
    let elsewhere = Grant {
        provider_repo_id: OTHER_REPO,
        ..live
    };
    let from_an_earlier_owner = Grant {
        delegated_by: "old-owner",
        ..live
    };
    for (name, held, expires_at, expected) in [
        ("nothing held", None, None, Ok(GrantPlan::Insert)),
        (
            "nothing held, with an expiry",
            None,
            Some(NOW + 1),
            Ok(GrantPlan::Insert),
        ),
        (
            "the same grant again",
            Some(&live),
            None,
            Ok(GrantPlan::Unchanged),
        ),
        (
            "the same grant and expiry again",
            Some(&live_until),
            Some(NOW + HOUR),
            Ok(GrantPlan::Unchanged),
        ),
        (
            "a new expiry",
            Some(&live),
            Some(NOW + HOUR),
            Ok(GrantPlan::RevokeThenInsert),
        ),
        (
            "an expiry lifted",
            Some(&live_until),
            None,
            Ok(GrantPlan::RevokeThenInsert),
        ),
        // Step 2's index counts an expired row as the principal's one grant, so it's revoked first.
        (
            "after an expiry",
            Some(&expired),
            None,
            Ok(GrantPlan::RevokeThenInsert),
        ),
        (
            "after an expiry, to the same time",
            Some(&expired),
            Some(NOW - 1),
            Err(GrantRefusal::InvalidExpiry),
        ),
        (
            "after an expiry, with a new one",
            Some(&expired),
            Some(NOW + HOUR),
            Ok(GrantPlan::RevokeThenInsert),
        ),
        // A revoked row holds no place, and a row for the other action isn't this grant.
        (
            "after a revocation",
            Some(&revoked),
            None,
            Ok(GrantPlan::Insert),
        ),
        (
            "holding the other action",
            Some(&merge),
            None,
            Ok(GrantPlan::Insert),
        ),
        (
            "a row for a repository the room isn't linked to",
            Some(&elsewhere),
            None,
            Ok(GrantPlan::RevokeThenInsert),
        ),
        // The new owner grants again over a row the old owner gave, which no longer counts.
        (
            "a row an earlier owner gave",
            Some(&from_an_earlier_owner),
            None,
            Ok(GrantPlan::RevokeThenInsert),
        ),
        (
            "an expiry now",
            None,
            Some(NOW),
            Err(GrantRefusal::InvalidExpiry),
        ),
        (
            "an expiry in the past",
            Some(&live),
            Some(NOW - HOUR),
            Err(GrantRefusal::InvalidExpiry),
        ),
    ] {
        assert_eq!(
            decide_grant(Some(REPO), held, "owner", Push, expires_at, NOW),
            expected,
            "{name}"
        );
    }
}

#[test]
fn nothing_is_granted_in_a_room_with_no_repository() {
    for action in [Push, Merge] {
        assert_eq!(
            decide_grant(None, None, "owner", action, None, NOW),
            Err(GrantRefusal::RepoNotLinked),
            "{action:?}"
        );
        assert_eq!(
            decide_grant(
                None,
                Some(&grant(action, None, None)),
                "owner",
                action,
                None,
                NOW
            ),
            Err(GrantRefusal::RepoNotLinked),
            "{action:?} held"
        );
    }
}

#[test]
fn taking_a_grant_back_works_once_and_then_changes_nothing() {
    assert_eq!(
        decide_revoke(Some(&grant(Merge, None, None))),
        Ok(RevokePlan::Revoke)
    );
    assert_eq!(
        decide_revoke(Some(&grant(Merge, Some(NOW - HOUR), None))),
        Ok(RevokePlan::Revoke),
        "an expired grant is revoked like any other"
    );
    assert_eq!(
        decide_revoke(Some(&grant(Merge, None, Some(NOW)))),
        Ok(RevokePlan::AlreadyRevoked)
    );
    assert_eq!(decide_revoke(None), Err(GrantRefusal::GrantNotFound));
}

#[test]
fn only_a_live_grant_for_this_principal_action_and_repository_counts() {
    for action in [Push, Merge] {
        let other = if action == Push { Merge } else { Push };
        let live = grant(action, None, None);
        for (name, held, expected) in [
            ("live", Some(live), Ok(())),
            (
                "live until later",
                Some(grant(action, Some(NOW + 1), None)),
                Ok(()),
            ),
            ("none", None, Err(GrantRefusal::GrantRequired)),
            (
                "expires now",
                Some(grant(action, Some(NOW), None)),
                Err(GrantRefusal::GrantExpired),
            ),
            (
                "expired",
                Some(grant(action, Some(NOW - HOUR), None)),
                Err(GrantRefusal::GrantExpired),
            ),
            (
                "revoked",
                Some(grant(action, None, Some(NOW - 1))),
                Err(GrantRefusal::GrantRequired),
            ),
            (
                "revoked and expired",
                Some(grant(action, Some(NOW - HOUR), Some(NOW - 1))),
                Err(GrantRefusal::GrantRequired),
            ),
            // AC-10: a delegation for another action, or another repository, is no grant.
            (
                "the other action",
                Some(grant(other, None, None)),
                Err(GrantRefusal::GrantRequired),
            ),
            (
                "another repository",
                Some(Grant {
                    provider_repo_id: OTHER_REPO,
                    ..live
                }),
                Err(GrantRefusal::GrantRequired),
            ),
            // A row read for the wrong principal is nobody's grant here.
            (
                "someone else's grant",
                Some(Grant {
                    principal: "other-agent",
                    ..live
                }),
                Err(GrantRefusal::GrantRequired),
            ),
        ] {
            assert_eq!(
                check_grant(held.as_ref(), &usage(action)),
                expected,
                "{action:?} {name}"
            );
        }
    }
}

/// A grant rests on its giver: once whoever gave it no longer holds the delegation, it stops counting, and the room's
/// new owner must grant again.
#[test]
fn a_grant_whose_giver_lost_the_delegation_doesnt_count() {
    for action in [Push, Merge] {
        let live = grant(action, None, None);
        for (name, holder, expected) in [
            ("the giver still holds it", Some("owner"), Ok(())),
            (
                "ownership moved to someone else",
                Some("new-owner"),
                Err(GrantRefusal::GrantStale),
            ),
            (
                "nobody holds it: the owner left",
                None,
                Err(GrantRefusal::GrantStale),
            ),
        ] {
            let usage = GrantUse {
                delegation_holder: holder,
                ..usage(action)
            };
            assert_eq!(
                check_grant(Some(&live), &usage),
                expected,
                "{action:?} {name}"
            );
        }
        // The new owner's own grant counts, and expiry is still named first on a row that's both.
        let regranted = Grant {
            id: "g2",
            delegated_by: "new-owner",
            ..live
        };
        let under_new_owner = GrantUse {
            delegation_holder: Some("new-owner"),
            ..usage(action)
        };
        assert_eq!(check_grant(Some(&regranted), &under_new_owner), Ok(()));
        let expired = grant(action, Some(NOW), None);
        assert_eq!(
            check_grant(Some(&expired), &under_new_owner),
            Err(GrantRefusal::GrantExpired)
        );
    }
}

/// AC-05: a repository ID that isn't the room's own link finds no grant, whoever supplied it.
#[test]
fn ac_05_a_substituted_repository_finds_no_grant() {
    let live = grant(Push, None, None);
    assert_eq!(check_grant(Some(&live), &usage(Push)), Ok(()));
    let substituted = GrantUse {
        link_repo_id: OTHER_REPO,
        ..usage(Push)
    };
    assert_eq!(
        check_grant(Some(&live), &substituted),
        Err(GrantRefusal::GrantRequired)
    );
}

fn rows() -> [Grant<'static>; 6] {
    let base = grant(Push, None, None);
    [
        base,
        Grant {
            id: "g2",
            action: Merge,
            ..base
        },
        Grant {
            id: "g3",
            principal: "reviewer",
            action: Merge,
            ..base
        },
        // Already revoked: nothing to do.
        Grant {
            id: "g4",
            revoked_at: Some(NOW - 1),
            ..base
        },
        // Expired and not revoked: still the principal's one row, so it's revoked with the rest.
        Grant {
            id: "g5",
            principal: "other-agent",
            expires_at: Some(NOW - 1),
            ..base
        },
        Grant {
            id: "g6",
            principal: "other-agent",
            action: Merge,
            delegated_by: "new-owner",
            ..base
        },
    ]
}

#[test]
fn removing_a_participant_revokes_every_grant_they_hold() {
    let rows = rows();
    assert_eq!(grants_ended_by_removal(&rows, "agent"), ["g1", "g2"]);
    assert_eq!(grants_ended_by_removal(&rows, "reviewer"), ["g3"]);
    assert_eq!(grants_ended_by_removal(&rows, "other-agent"), ["g5", "g6"]);
    // Removing whoever gave grants isn't this rule: that's the ownership change below.
    assert!(grants_ended_by_removal(&rows, "owner").is_empty());
    assert!(grants_ended_by_removal(&rows, "nobody").is_empty());
    assert!(grants_ended_by_removal(&[], "agent").is_empty());
}

#[test]
fn an_ownership_change_revokes_every_grant_the_new_owner_didnt_give() {
    let rows = rows();
    assert_eq!(
        grants_ended_by_ownership_change(&rows, Some("new-owner")),
        ["g1", "g2", "g3", "g5"]
    );
    // Nobody holds the delegation afterwards: every grant goes.
    assert_eq!(
        grants_ended_by_ownership_change(&rows, None),
        ["g1", "g2", "g3", "g5", "g6"]
    );
    // The same owner, such as a retried command: only the row another holder gave.
    assert_eq!(
        grants_ended_by_ownership_change(&rows, Some("owner")),
        ["g6"]
    );
    // Whatever this leaves is exactly what still counts at use, expiry aside.
    for holder in [Some("owner"), Some("new-owner"), None] {
        let ended = grants_ended_by_ownership_change(&rows, holder);
        for row in rows.iter().filter(|g| g.revoked_at.is_none()) {
            let usage = GrantUse {
                principal: row.principal,
                action: row.action,
                link_repo_id: REPO,
                delegation_holder: holder,
                now: NOW,
            };
            let stale = check_grant(Some(row), &usage) == Err(GrantRefusal::GrantStale);
            let expired = !row.is_live(NOW);
            assert_eq!(
                ended.contains(&row.id),
                stale || (expired && holder != Some(row.delegated_by)),
                "{} {holder:?}",
                row.id
            );
        }
    }
}

#[test]
fn refusals_have_stable_names() {
    for (refusal, code) in [
        (GrantRefusal::RepoNotLinked, "repo_not_linked"),
        (GrantRefusal::InvalidExpiry, "invalid_argument"),
        (GrantRefusal::GrantRequired, "grant_required"),
        (GrantRefusal::GrantExpired, "grant_expired"),
        (GrantRefusal::GrantStale, "grant_stale"),
        (GrantRefusal::GrantNotFound, "grant_not_found"),
    ] {
        assert_eq!(refusal.code(), code);
    }
}
