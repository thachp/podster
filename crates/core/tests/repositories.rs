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
    assert!(names_commit(&Some("a1".repeat(20))));
    assert!(!names_commit(&None));
    assert!(!names_commit(&Some("main".into())));
    assert!(!names_commit(&Some(String::new())));
}

#[test]
fn only_a_ready_link_lets_coding_work_go_on_and_the_block_says_why() {
    use LinkStatus as L;
    use RequestState as R;
    for (request, link, expected) in [
        (Some(R::Ready), Some(L::Ready), Ok(())),
        (None, None, Err(WorkBlock::NoRepository)),
        (Some(R::Pending), None, Err(WorkBlock::SetupPending)),
        (Some(R::Failed), None, Err(WorkBlock::SetupFailed)),
        // An uncertain setup blocks exactly as a failed one does (M5-03).
        (Some(R::Uncertain), None, Err(WorkBlock::SetupUncertain)),
        // A request that says ready with no link beside it holds no repository ID.
        (Some(R::Ready), None, Err(WorkBlock::NoRepository)),
        (Some(R::Ready), Some(L::Degraded), Err(WorkBlock::Degraded)),
        (
            Some(R::Ready),
            Some(L::Suspended),
            Err(WorkBlock::Suspended),
        ),
        // The link decides once there is one, whatever the request row reads as.
        (None, Some(L::Degraded), Err(WorkBlock::Degraded)),
        (
            Some(R::Failed),
            Some(L::Suspended),
            Err(WorkBlock::Suspended),
        ),
    ] {
        assert_eq!(
            coding_work_allowed(request, link),
            expected,
            "{request:?} {link:?}"
        );
        // It never disagrees with the rule step 2 set.
        assert_eq!(
            coding_work_allowed(request, link).is_ok(),
            link_allows_work(link)
        );
    }
    for (block, reason) in [
        (WorkBlock::NoRepository, "no_repository"),
        (WorkBlock::SetupPending, "setup_pending"),
        (WorkBlock::SetupFailed, "setup_failed"),
        (WorkBlock::SetupUncertain, "setup_uncertain"),
        (WorkBlock::Degraded, "degraded"),
        (WorkBlock::Suspended, "suspended"),
    ] {
        assert_eq!(block.code(), "repo_not_ready");
        assert_eq!(block.reason(), reason);
    }
}

/// M5-15: a failed or uncertain setup blocks the room's coding tasks and nothing else.
#[test]
fn m5_15_a_failed_setup_blocks_coding_tasks_and_no_other_work() {
    let requests = [
        None,
        Some(RequestState::Pending),
        Some(RequestState::Failed),
        Some(RequestState::Uncertain),
        Some(RequestState::Ready),
    ];
    let links = [
        None,
        Some(LinkStatus::Ready),
        Some(LinkStatus::Degraded),
        Some(LinkStatus::Suspended),
    ];
    for request in requests {
        for link in links {
            assert_eq!(
                task_block(false, request, link),
                None,
                "{request:?} {link:?}"
            );
            assert_eq!(
                task_block(true, request, link),
                coding_work_allowed(request, link).err(),
                "{request:?} {link:?}"
            );
        }
    }
    assert_eq!(
        task_block(true, Some(RequestState::Failed), None),
        Some(WorkBlock::SetupFailed)
    );
    assert_eq!(
        task_block(true, Some(RequestState::Uncertain), None),
        Some(WorkBlock::SetupUncertain)
    );
    assert_eq!(
        task_block(true, Some(RequestState::Ready), Some(LinkStatus::Ready)),
        None
    );
}

#[test]
fn a_repository_name_is_lower_case_letters_digits_and_hyphens() {
    let longest = "a".repeat(MAX_REPO_NAME_BYTES);
    for good in [
        "room", "room-1", "1room", "a", "a-b-c", "a--b", "room-", &longest,
    ] {
        assert!(valid_repo_name(good), "{good}");
    }
    let too_long = "a".repeat(MAX_REPO_NAME_BYTES + 1);
    for bad in [
        "",
        "-room",
        ".github",
        "room.git",
        "Room",
        "my room",
        "room_1",
        "room/other",
        "rööm",
        "..",
        &too_long,
    ] {
        assert!(!valid_repo_name(bad), "{bad}");
    }
}

/// M5-03: a retry never goes back to a name, and nothing is adopted because a name matches.
#[test]
fn m5_03_a_retry_uses_a_new_name_and_never_adopts_by_name() {
    use RequestState as R;
    use RetryPlan::*;
    use RetryRefusal::*;
    let sent = ["room", "room-x7k2"];
    let fresh = Some("room-q1");
    for (name, state, holds_id, new_name, expected) in [
        ("no request", None, false, fresh, Err(NoRequest)),
        (
            "still pending",
            Some(R::Pending),
            false,
            fresh,
            Err(InProgress),
        ),
        (
            "already ready",
            Some(R::Ready),
            true,
            fresh,
            Err(AlreadyReady),
        ),
        // GitHub's answer gave an ID, so setup finishes on that repository, and no name is needed or used.
        (
            "failed, holding an ID",
            Some(R::Failed),
            true,
            None,
            Ok(ResumeHeldRepository),
        ),
        (
            "failed, holding an ID, with a name",
            Some(R::Failed),
            true,
            Some("room"),
            Ok(ResumeHeldRepository),
        ),
        (
            "failed, no ID",
            Some(R::Failed),
            false,
            fresh,
            Ok(CreateUnderNewName),
        ),
        (
            "uncertain",
            Some(R::Uncertain),
            false,
            fresh,
            Ok(CreateUnderNewName),
        ),
        // An uncertain request has no ID by definition, so a row that claims one still gets a new name.
        (
            "uncertain, claiming an ID",
            Some(R::Uncertain),
            true,
            fresh,
            Ok(CreateUnderNewName),
        ),
        (
            "uncertain, claiming an ID, no name",
            Some(R::Uncertain),
            true,
            None,
            Err(InvalidName),
        ),
        (
            "uncertain, the first name again",
            Some(R::Uncertain),
            false,
            Some("room"),
            Err(NameReused),
        ),
        (
            "uncertain, the last name again",
            Some(R::Uncertain),
            false,
            Some("room-x7k2"),
            Err(NameReused),
        ),
        (
            "failed, a name already sent",
            Some(R::Failed),
            false,
            Some("room"),
            Err(NameReused),
        ),
        (
            "uncertain, no name",
            Some(R::Uncertain),
            false,
            None,
            Err(InvalidName),
        ),
        (
            "uncertain, a bad name",
            Some(R::Uncertain),
            false,
            Some(".github"),
            Err(InvalidName),
        ),
    ] {
        assert_eq!(
            decide_retry(state, holds_id, &sent, new_name),
            expected,
            "{name}"
        );
    }
    for (refusal, code) in [
        (NoRequest, "repo_request_not_found"),
        (InProgress, "setup_in_progress"),
        (AlreadyReady, "already_ready"),
        (InvalidName, "invalid_argument"),
        (NameReused, "name_reused"),
    ] {
        assert_eq!(refusal.code(), code);
    }
}
