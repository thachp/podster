#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use podster_core::repositories::*;

#[test]
fn every_state_reads_back_from_its_name_and_nothing_else_does() {
    for name in ["pending", "ready", "failed", "uncertain"] {
        assert_eq!(RequestState::from_name(name).unwrap().name(), name);
    }
    for name in ["ready", "degraded", "suspended"] {
        assert_eq!(LinkStatus::from_name(name).unwrap().name(), name);
    }
    for name in ["public", "private"] {
        assert_eq!(RepoVisibility::from_name(name).unwrap().name(), name);
    }
    for name in ["push", "merge"] {
        assert_eq!(GrantAction::from_name(name).unwrap().name(), name);
    }
    for name in ["not_requested", "requested", "succeeded", "failed"] {
        assert_eq!(MergeState::from_name(name).unwrap().name(), name);
    }
    // A request's states aren't a link's, and nothing is read loosely.
    assert_eq!(LinkStatus::from_name("pending"), None);
    assert_eq!(LinkStatus::from_name("uncertain"), None);
    assert_eq!(RequestState::from_name("degraded"), None);
    assert_eq!(LinkStatus::from_name("Ready"), None);
    assert_eq!(LinkStatus::from_name(""), None);
    assert_eq!(GrantAction::from_name("admin"), None);
    assert_eq!(GrantAction::from_name("deploy"), None);
    assert_eq!(RepoVisibility::from_name("internal"), None);
    assert_eq!(MergeState::from_name("merged"), None);
}

#[test]
fn only_a_ready_link_lets_a_token_be_issued_or_a_merge_run() {
    assert!(link_allows_work(Some(LinkStatus::Ready)));
    assert!(!link_allows_work(Some(LinkStatus::Degraded)));
    assert!(!link_allows_work(Some(LinkStatus::Suspended)));
    // No link at all, or a stored status this code can't read.
    assert!(!link_allows_work(None));
    assert!(!link_allows_work(LinkStatus::from_name("unknown")));
}

#[test]
fn a_commit_is_named_only_by_its_full_id() {
    assert!(valid_commit_sha(&"a1".repeat(20)));
    assert!(valid_commit_sha(&"0f".repeat(32)));
    for bad in ["", "main", "a1b2c3d", "refs/heads/main", "HEAD"] {
        assert!(!valid_commit_sha(bad), "{bad}");
    }
    assert!(!valid_commit_sha(&"A1".repeat(20)));
    assert!(!valid_commit_sha(&"a1".repeat(21)));
    assert!(!valid_commit_sha(&"g1".repeat(20)));
}
