//! Asking for a release of a task's merged commit (M6 step 6, `requestRelease`): what the room decides once policy has
//! said who may ask. Pure: every fact is passed in.

use podster_core::release::{
    CommitRecord, CommitRefusal, ReleaseCapRefusal, ReleaseState, ENVIRONMENT,
    MAX_RELEASES_PER_ROOM_PER_DAY, RELEASE_WINDOW_MS,
};
use podster_core::release_request::{
    pending_for_commit, request_release, ReleaseRequest, RequestRefusal,
};

const SHA: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";
const OTHER_SHA: &str = "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34";
const REPO: i64 = 4242;
const NOW: i64 = 1_800_000_000_000;

fn record(sha: &str) -> CommitRecord<'_> {
    CommitRecord {
        sha,
        provider_repo_id: REPO,
        merged_by_podster: true,
        confirmed_on_default_branch: true,
        task_completed: true,
    }
}

fn open<'a>(commit: Option<&'a CommitRecord<'a>>, asked_at: &'a [i64]) -> ReleaseRequest<'a> {
    ReleaseRequest {
        asked_sha: SHA,
        environment: ENVIRONMENT,
        commit,
        room_repo_id: REPO,
        reviewer_rule_holds: true,
        app_held: false,
        pending_for_commit: false,
        asked_at,
        now: NOW,
    }
}

#[test]
fn a_reviewed_merged_commit_of_a_completed_task_may_be_asked_for() {
    let commit = record(SHA);
    assert_eq!(request_release(&open(Some(&commit), &[])), Ok(()));
}

#[test]
fn only_the_commit_podsters_merge_confirmed_for_the_task_is_releasable() {
    let fine = record(SHA);
    let cases = [
        (
            "no merge on record",
            ReleaseRequest {
                commit: None,
                ..open(None, &[])
            },
        ),
        (
            "another sha than the merge's",
            ReleaseRequest {
                asked_sha: OTHER_SHA,
                ..open(Some(&fine), &[])
            },
        ),
        (
            "another repository than the room's",
            ReleaseRequest {
                room_repo_id: REPO + 1,
                ..open(Some(&fine), &[])
            },
        ),
    ];
    for (why, request) in cases {
        assert_eq!(
            request_release(&request),
            Err(RequestRefusal::Commit(CommitRefusal::NotReleasable)),
            "{why}"
        );
    }
    for (why, commit) in [
        (
            "merged by hand",
            CommitRecord {
                merged_by_podster: false,
                ..record(SHA)
            },
        ),
        (
            "not confirmed on the default branch",
            CommitRecord {
                confirmed_on_default_branch: false,
                ..record(SHA)
            },
        ),
        (
            "the task isn't completed",
            CommitRecord {
                task_completed: false,
                ..record(SHA)
            },
        ),
    ] {
        assert_eq!(
            request_release(&open(Some(&commit), &[])),
            Err(RequestRefusal::Commit(CommitRefusal::NotReleasable)),
            "{why}"
        );
    }
}

#[test]
fn there_is_one_environment() {
    let commit = record(SHA);
    let refused = request_release(&ReleaseRequest {
        environment: "staging",
        ..open(Some(&commit), &[])
    });
    assert_eq!(
        refused,
        Err(RequestRefusal::Commit(CommitRefusal::UnknownEnvironment))
    );
    assert_eq!(
        refused.map_err(RequestRefusal::code),
        Err("invalid_argument")
    );
}

#[test]
fn a_task_reviewed_against_the_rooms_rule_now_is_needed() {
    let commit = record(SHA);
    assert_eq!(
        request_release(&ReleaseRequest {
            reviewer_rule_holds: false,
            ..open(Some(&commit), &[])
        }),
        Err(RequestRefusal::ReviewerRuleChanged)
    );
}

#[test]
fn nothing_is_asked_for_while_the_app_is_held_because_nobody_may_release() {
    let commit = record(SHA);
    let refused = request_release(&ReleaseRequest {
        app_held: true,
        ..open(Some(&commit), &[])
    });
    assert_eq!(refused, Err(RequestRefusal::Held));
    assert_eq!(refused.map_err(RequestRefusal::code), Err("no_releaser"));
}

#[test]
fn a_commit_already_waiting_or_on_its_way_is_not_asked_for_twice() {
    let commit = record(SHA);
    let refused = request_release(&ReleaseRequest {
        pending_for_commit: true,
        ..open(Some(&commit), &[])
    });
    assert_eq!(refused, Err(RequestRefusal::Pending));
    assert_eq!(
        refused.map_err(RequestRefusal::code),
        Err("release_pending")
    );
}

#[test]
fn which_states_hold_a_commit_pending() {
    for state in ReleaseState::ALL {
        let pending = matches!(
            state,
            ReleaseState::AwaitingApproval
                | ReleaseState::Queued
                | ReleaseState::Uploading
                | ReleaseState::Uncertain
        );
        assert_eq!(pending_for_commit(state), pending, "{}", state.name());
    }
}

#[test]
fn twenty_asks_in_a_rolling_day_and_no_more_to_the_millisecond() {
    let commit = record(SHA);
    let max = MAX_RELEASES_PER_ROOM_PER_DAY;
    // The oldest of twenty asks was exactly a day ago less a millisecond: it still counts, so the twenty-first waits.
    let recent: Vec<i64> = std::iter::repeat_n(NOW - 1, max - 1).collect();
    let mut asked: Vec<i64> = vec![NOW - RELEASE_WINDOW_MS + 1];
    asked.extend(&recent);
    let refused = request_release(&open(Some(&commit), &asked));
    assert_eq!(
        refused,
        Err(RequestRefusal::Limit(ReleaseCapRefusal::DailyLimit))
    );
    assert_eq!(refused.map_err(RequestRefusal::code), Err("release_limit"));
    // A millisecond older it is a day old, and no longer counts.
    let mut older: Vec<i64> = vec![NOW - RELEASE_WINDOW_MS];
    older.extend(&recent);
    assert_eq!(request_release(&open(Some(&commit), &older)), Ok(()));
    // The same, seen a millisecond later by the clock.
    assert_eq!(
        request_release(&ReleaseRequest {
            now: NOW + 1,
            ..open(Some(&commit), &asked)
        }),
        Ok(())
    );
    // Nineteen asks leave room for one more.
    assert_eq!(request_release(&open(Some(&commit), &recent)), Ok(()));
}

#[test]
fn the_first_fact_that_fails_is_the_answer_in_order() {
    // Environment and commit, then the reviewer rule, then the hold, then a pending ask, then the cap.
    let fine = record(SHA);
    let full: Vec<i64> = vec![NOW; MAX_RELEASES_PER_ROOM_PER_DAY];
    let everything_wrong = ReleaseRequest {
        environment: "preview",
        commit: None,
        reviewer_rule_holds: false,
        app_held: true,
        pending_for_commit: true,
        ..open(None, &full)
    };
    assert_eq!(
        request_release(&everything_wrong),
        Err(RequestRefusal::Commit(CommitRefusal::UnknownEnvironment))
    );
    let steps = [
        RequestRefusal::Commit(CommitRefusal::NotReleasable),
        RequestRefusal::ReviewerRuleChanged,
        RequestRefusal::Held,
        RequestRefusal::Pending,
        RequestRefusal::Limit(ReleaseCapRefusal::DailyLimit),
    ];
    let mut request = ReleaseRequest {
        environment: ENVIRONMENT,
        ..everything_wrong
    };
    for expected in steps {
        assert_eq!(request_release(&request), Err(expected));
        match expected {
            RequestRefusal::Commit(_) => request.commit = Some(&fine),
            RequestRefusal::ReviewerRuleChanged => request.reviewer_rule_holds = true,
            RequestRefusal::Held => request.app_held = false,
            RequestRefusal::Pending => request.pending_for_commit = false,
            RequestRefusal::Limit(_) => request.asked_at = &[],
        }
    }
    assert_eq!(request_release(&request), Ok(()));
}

#[test]
fn every_refusal_has_its_code() {
    let codes: Vec<&str> = [
        RequestRefusal::Commit(CommitRefusal::NotReleasable),
        RequestRefusal::Commit(CommitRefusal::UnknownEnvironment),
        RequestRefusal::ReviewerRuleChanged,
        RequestRefusal::Held,
        RequestRefusal::Pending,
        RequestRefusal::Limit(ReleaseCapRefusal::DailyLimit),
    ]
    .into_iter()
    .map(RequestRefusal::code)
    .collect();
    assert_eq!(
        codes,
        [
            "commit_not_releasable",
            "invalid_argument",
            "reviewer_rule_changed",
            "no_releaser",
            "release_pending",
            "release_limit"
        ]
    );
}

#[test]
fn a_request_starts_awaiting_a_persons_approval_and_nothing_else() {
    assert_eq!(
        podster_core::release_request::REQUESTED_STATE,
        ReleaseState::AwaitingApproval
    );
}
