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

fn grant(action: GrantAction, expires_at: Option<i64>, revoked_at: Option<i64>) -> Grant {
    Grant {
        provider_repo_id: REPO,
        action,
        expires_at,
        revoked_at,
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
            decide_grant(Some(REPO), held, Push, expires_at, NOW),
            expected,
            "{name}"
        );
    }
}

#[test]
fn nothing_is_granted_in_a_room_with_no_repository() {
    for action in [Push, Merge] {
        assert_eq!(
            decide_grant(None, None, action, None, NOW),
            Err(GrantRefusal::RepoNotLinked),
            "{action:?}"
        );
        assert_eq!(
            decide_grant(None, Some(&grant(action, None, None)), action, None, NOW),
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
fn only_a_live_grant_for_this_action_on_this_repository_counts() {
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
        ] {
            assert_eq!(
                check_grant(held.as_ref(), action, REPO, NOW),
                expected,
                "{action:?} {name}"
            );
        }
    }
}

/// AC-05: a repository ID that isn't the room's own link finds no grant, whoever supplied it.
#[test]
fn ac_05_a_substituted_repository_finds_no_grant() {
    let live = grant(Push, None, None);
    assert_eq!(check_grant(Some(&live), Push, REPO, NOW), Ok(()));
    assert_eq!(
        check_grant(Some(&live), Push, OTHER_REPO, NOW),
        Err(GrantRefusal::GrantRequired)
    );
}

#[test]
fn refusals_have_stable_names() {
    for (refusal, code) in [
        (GrantRefusal::RepoNotLinked, "repo_not_linked"),
        (GrantRefusal::InvalidExpiry, "invalid_argument"),
        (GrantRefusal::GrantRequired, "grant_required"),
        (GrantRefusal::GrantExpired, "grant_expired"),
        (GrantRefusal::GrantNotFound, "grant_not_found"),
    ] {
        assert_eq!(refusal.code(), code);
    }
}
