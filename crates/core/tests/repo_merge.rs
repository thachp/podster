#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::repo_grants::{Grant, GrantRefusal};
use podster_core::repo_merge::*;
use podster_core::repositories::{GrantAction, LinkStatus, MergeState, RequestState};
use podster_core::{decide, Command, Observed, Task, TaskStatus};

const NOW: i64 = 1_800_000_000_000;
const REPO: i64 = 4242;
const ABC: &str = "abababababababababababababababababababab";
const DEF: &str = "dededededededededededededededededededede";
const BASE: &str = "0000000000000000000000000000000000000001";
const MOVED_BASE: &str = "0000000000000000000000000000000000000002";

fn accepted() -> Task {
    Task {
        id: "t".into(),
        title: "title".into(),
        instructions: "instructions".into(),
        acceptance_criteria: None,
        requester: "req".into(),
        assignee: Some("asg".into()),
        reviewer: "rev".into(),
        status: TaskStatus::Accepted,
        version: 5,
        due_at: None,
        follow_up_of: None,
        has_linked_repository: true,
        submission_no: 0,
        submission_commit: None,
        approved_submission_no: None,
        submission_files: 0,
        assignee_departed: false,
        needs_reviewer: false,
        needs_requester: false,
    }
}

fn submitted() -> Task {
    let submit = Command::Submit {
        version: 5,
        artifacts: vec![],
        note: Some("done".into()),
        commit_sha: Some(ABC.into()),
    };
    decide(&accepted(), "asg", submit, &Observed::default())
        .unwrap()
        .task
}

/// A task whose first submission, of commit abc, was approved by its reviewer, through the task's own decisions.
fn approved() -> Task {
    let verify = Command::Verify {
        submission_no: 1,
        commit_sha: Some(ABC.into()),
    };
    decide(&submitted(), "rev", verify, &Observed::default())
        .unwrap()
        .task
}

fn grant(action: GrantAction) -> Grant {
    Grant {
        provider_repo_id: REPO,
        action,
        expires_at: None,
        revoked_at: None,
    }
}

/// A merge that passes: someone with a live merge grant, who isn't the submitter, names the approved submission and its
/// commit, in a room whose repository is ready.
fn passing<'a>(task: &'a Task, grant: &'a Grant) -> MergeAuthority<'a> {
    MergeAuthority {
        task,
        request: Some(RequestState::Ready),
        link: Some(LinkStatus::Ready),
        link_repo_id: Some(REPO),
        requester: "merger",
        requester_connected: true,
        submitter: "asg",
        grant: Some(grant),
        submission_no: 1,
        commit_sha: ABC,
        now: NOW,
    }
}

fn change(merge_state: MergeState, merge_reason: Option<&'static str>) -> Change<'static> {
    Change {
        provider_repo_id: REPO,
        submission_no: 1,
        reviewed_commit_sha: Some(ABC),
        merge_state,
        merge_reason,
    }
}

const FRESH: Change<'static> = Change {
    provider_repo_id: REPO,
    submission_no: 1,
    reviewed_commit_sha: Some(ABC),
    merge_state: MergeState::NotRequested,
    merge_reason: None,
};

#[test]
fn a_granted_merger_who_isnt_the_submitter_asks_for_the_approved_commit() {
    let (task, grant) = (approved(), grant(GrantAction::Merge));
    assert_eq!(check_merge_authority(&passing(&task, &grant)), Ok(()));
    assert_eq!(
        decide_merge_request(&passing(&task, &grant), Some(&FRESH)),
        Ok(MergeState::Requested)
    );
    // Asking changes nothing about the task: it stays completed, and the decision returns only the merge's state.
    assert_eq!(task.status, TaskStatus::Completed);
}

#[test]
fn every_missing_piece_of_authority_refuses_by_name() {
    let task = approved();
    let merge = grant(GrantAction::Merge);
    let base = passing(&task, &merge);
    let unlinked = Task {
        has_linked_repository: false,
        ..approved()
    };
    let waiting = submitted();
    let canceled = Task {
        status: TaskStatus::Canceled,
        ..submitted()
    };
    let expired = Grant {
        expires_at: Some(NOW),
        ..merge
    };
    let revoked = Grant {
        revoked_at: Some(NOW - 1),
        ..merge
    };
    let push_only = grant(GrantAction::Push);
    let elsewhere = Grant {
        provider_repo_id: REPO + 1,
        ..merge
    };
    use MergeRefusal as R;
    for (name, authority, refusal, code) in [
        (
            "a task with no repository",
            MergeAuthority {
                task: &unlinked,
                ..base
            },
            R::TaskNotLinked,
            "task_not_linked",
        ),
        (
            "a degraded repository",
            MergeAuthority {
                link: Some(LinkStatus::Degraded),
                ..base
            },
            R::RepoNotReady,
            "repo_not_ready",
        ),
        (
            "a suspended repository",
            MergeAuthority {
                link: Some(LinkStatus::Suspended),
                ..base
            },
            R::RepoNotReady,
            "repo_not_ready",
        ),
        (
            "no repository",
            MergeAuthority {
                link: None,
                request: Some(RequestState::Failed),
                ..base
            },
            R::RepoNotReady,
            "repo_not_ready",
        ),
        (
            "a ready link with no repository ID",
            MergeAuthority {
                link_repo_id: None,
                ..base
            },
            R::RepoNotReady,
            "repo_not_ready",
        ),
        (
            "a disconnected agent",
            MergeAuthority {
                requester_connected: false,
                ..base
            },
            R::AgentDisconnected,
            "agent_disconnected",
        ),
        (
            "the submitter",
            MergeAuthority {
                requester: "asg",
                ..base
            },
            R::SelfMerge,
            "self_merge",
        ),
        (
            "no grant",
            MergeAuthority {
                grant: None,
                ..base
            },
            R::Grant(GrantRefusal::GrantRequired),
            "grant_required",
        ),
        (
            "an expired grant",
            MergeAuthority {
                grant: Some(&expired),
                ..base
            },
            R::Grant(GrantRefusal::GrantExpired),
            "grant_expired",
        ),
        (
            "a revoked grant",
            MergeAuthority {
                grant: Some(&revoked),
                ..base
            },
            R::Grant(GrantRefusal::GrantRequired),
            "grant_required",
        ),
        (
            "a push grant",
            MergeAuthority {
                grant: Some(&push_only),
                ..base
            },
            R::Grant(GrantRefusal::GrantRequired),
            "grant_required",
        ),
        (
            "a grant on another repository",
            MergeAuthority {
                grant: Some(&elsewhere),
                ..base
            },
            R::Grant(GrantRefusal::GrantRequired),
            "grant_required",
        ),
        (
            "a branch name for a commit",
            MergeAuthority {
                commit_sha: "main",
                ..base
            },
            R::InvalidCommit,
            "invalid_argument",
        ),
        (
            "a short commit",
            MergeAuthority {
                commit_sha: "abababa",
                ..base
            },
            R::InvalidCommit,
            "invalid_argument",
        ),
        (
            "a task still in review",
            MergeAuthority {
                task: &waiting,
                ..base
            },
            R::NotApproved,
            "not_approved",
        ),
        (
            "a canceled task",
            MergeAuthority {
                task: &canceled,
                ..base
            },
            R::NotApproved,
            "not_approved",
        ),
        (
            "another submission",
            MergeAuthority {
                submission_no: 2,
                ..base
            },
            R::SubmissionMismatch,
            "submission_mismatch",
        ),
        (
            "another commit",
            MergeAuthority {
                commit_sha: DEF,
                ..base
            },
            R::CommitChanged,
            "commit_changed",
        ),
    ] {
        assert_eq!(check_merge_authority(&authority), Err(refusal), "{name}");
        assert_eq!(
            decide_merge_request(&authority, Some(&FRESH)),
            Err(refusal),
            "{name}, as a request"
        );
        assert_eq!(refusal.code(), code, "{name}");
    }
}

/// AC-17 and M5-10: approval carries no merge. Whoever approved, asked for or administers the task is refused without a
/// separate merge grant, and the refusal is the same whether or not the task was approved.
#[test]
fn ac_17_an_approved_task_without_a_merge_grant_cant_be_merged() {
    let done = approved();
    let waiting = submitted();
    let push = grant(GrantAction::Push);
    for task in [&done, &waiting] {
        for who in ["rev", "req", "owner", "merger"] {
            for held in [None, Some(&push)] {
                let authority = MergeAuthority {
                    requester: who,
                    grant: held,
                    ..passing(task, &push)
                };
                assert_eq!(
                    decide_merge_request(&authority, Some(&FRESH)),
                    Err(MergeRefusal::Grant(GrantRefusal::GrantRequired)),
                    "{who} {:?} {held:?}",
                    task.status
                );
            }
        }
    }
}

/// M5-10 and decision 186: whoever submitted the work never merges it, even holding a merge grant.
#[test]
fn m5_10_the_submitter_never_merges_their_own_work() {
    let task = approved();
    let merge = grant(GrantAction::Merge);
    let as_submitter = MergeAuthority {
        requester: "asg",
        ..passing(&task, &merge)
    };
    assert_eq!(
        decide_merge_request(&as_submitter, Some(&FRESH)),
        Err(MergeRefusal::SelfMerge)
    );
    // The submission's own row names the submitter, and the task's assignee is refused too, whichever the room read.
    let row_says_other = MergeAuthority {
        requester: "asg",
        submitter: "someone",
        ..passing(&task, &merge)
    };
    assert_eq!(
        check_merge_authority(&row_says_other),
        Err(MergeRefusal::SelfMerge)
    );
    let submitted_by_merger = MergeAuthority {
        submitter: "merger",
        ..passing(&task, &merge)
    };
    assert_eq!(
        check_merge_authority(&submitted_by_merger),
        Err(MergeRefusal::SelfMerge)
    );
    // The reviewer may merge what they approved, with the grant: they didn't submit it.
    let reviewer = MergeAuthority {
        requester: "rev",
        ..passing(&task, &merge)
    };
    assert_eq!(
        decide_merge_request(&reviewer, Some(&FRESH)),
        Ok(MergeState::Requested)
    );
}

#[test]
fn a_merge_is_asked_for_once_and_again_only_after_a_failure_that_wasnt_the_commit() {
    let (task, merge) = (approved(), grant(GrantAction::Merge));
    let authority = passing(&task, &merge);
    let other_repo = Change {
        provider_repo_id: REPO + 1,
        ..FRESH
    };
    let other_submission = Change {
        submission_no: 2,
        ..FRESH
    };
    let other_commit = Change {
        reviewed_commit_sha: Some(DEF),
        ..FRESH
    };
    let unrecorded = Change {
        reviewed_commit_sha: None,
        ..FRESH
    };
    for (name, held, expected) in [
        ("no pull request", None, Err(MergeRefusal::ChangeNotFound)),
        (
            "a pull request on another repository",
            Some(other_repo),
            Err(MergeRefusal::ChangeNotFound),
        ),
        (
            "a change for another submission",
            Some(other_submission),
            Err(MergeRefusal::SubmissionMismatch),
        ),
        (
            "a change reviewed at another commit",
            Some(other_commit),
            Err(MergeRefusal::CommitChanged),
        ),
        (
            "a change with no reviewed commit recorded",
            Some(unrecorded),
            Ok(MergeState::Requested),
        ),
        ("never asked", Some(FRESH), Ok(MergeState::Requested)),
        (
            "already asked",
            Some(change(MergeState::Requested, None)),
            Err(MergeRefusal::AlreadyRequested),
        ),
        (
            "already merged",
            Some(change(MergeState::Succeeded, None)),
            Err(MergeRefusal::AlreadyMerged),
        ),
        (
            "failed on GitHub's refusal",
            Some(change(MergeState::Failed, Some("provider_refused"))),
            Ok(MergeState::Requested),
        ),
        (
            "failed on lost authority",
            Some(change(MergeState::Failed, Some("grant_required"))),
            Ok(MergeState::Requested),
        ),
        (
            "failed with no reason kept",
            Some(change(MergeState::Failed, None)),
            Ok(MergeState::Requested),
        ),
        // Decision 25: changed code goes to a follow-up task, never to another merge of this one.
        (
            "failed because the head moved",
            Some(change(MergeState::Failed, Some("commit_changed"))),
            Err(MergeRefusal::CommitChanged),
        ),
    ] {
        assert_eq!(
            decide_merge_request(&authority, held.as_ref()),
            expected,
            "{name}"
        );
    }
    assert_eq!(MergeRefusal::ChangeNotFound.code(), "change_not_found");
    assert_eq!(
        MergeRefusal::AlreadyRequested.code(),
        "merge_already_requested"
    );
    assert_eq!(MergeRefusal::AlreadyMerged.code(), "already_merged");
}

#[test]
fn the_merge_state_moves_only_along_its_three_events() {
    use MergeEvent as E;
    use MergeState as S;
    for from in [S::NotRequested, S::Requested, S::Succeeded, S::Failed] {
        for event in [E::Requested, E::Succeeded, E::Failed] {
            let expected = match (from, event) {
                (S::NotRequested, E::Requested) => Some(S::Requested),
                (S::Failed, E::Requested) => Some(S::Requested),
                (S::Requested, E::Succeeded) => Some(S::Succeeded),
                (S::Requested, E::Failed) => Some(S::Failed),
                _ => None,
            };
            assert_eq!(
                merge_transition(from, event),
                expected,
                "{from:?} {event:?}"
            );
        }
    }
    assert_eq!(E::Requested.name(), "merge.requested");
    assert_eq!(E::Succeeded.name(), "merge.succeeded");
    assert_eq!(E::Failed.name(), "merge.failed");
}

const REVIEWED: Reviewed<'static> = Reviewed {
    commit_sha: ABC,
    base_sha: Some(BASE),
    repo_id: REPO,
    default_branch: "main",
};

/// The pull request as it was reviewed: open, into the default branch, from the linked repository, at the reviewed commit.
const AS_REVIEWED: PullObservation<'static> = PullObservation {
    state: PullState::Open,
    base_ref: "main",
    base_sha: BASE,
    head_repo_id: Some(REPO),
    head_sha: ABC,
    default_branch_has_reviewed: None,
};

#[test]
fn the_job_marks_and_merges_only_the_pull_request_it_reviewed() {
    assert_eq!(
        decide_merge_step(&REVIEWED, &AS_REVIEWED, None),
        MergeStep::MarkAndMerge {
            sha: ABC,
            base_moved: Some(false)
        }
    );
    for (name, observed, failure, code) in [
        (
            "the head moved",
            PullObservation {
                head_sha: DEF,
                ..AS_REVIEWED
            },
            MergeFailure::CommitChanged,
            "commit_changed",
        ),
        (
            "the base was pointed at another branch",
            PullObservation {
                base_ref: "release",
                ..AS_REVIEWED
            },
            MergeFailure::BaseChanged,
            "base_changed",
        ),
        (
            "the head is in a fork",
            PullObservation {
                head_repo_id: Some(REPO + 1),
                ..AS_REVIEWED
            },
            MergeFailure::HeadRepoChanged,
            "head_repo_changed",
        ),
        (
            "the head's repository is gone",
            PullObservation {
                head_repo_id: None,
                ..AS_REVIEWED
            },
            MergeFailure::HeadRepoChanged,
            "head_repo_changed",
        ),
        (
            "the pull request was closed",
            PullObservation {
                state: PullState::Closed,
                ..AS_REVIEWED
            },
            MergeFailure::PullClosed,
            "pull_request_closed",
        ),
    ] {
        // Before a call, after any answer to one, and whatever state the pull request reads as: nothing is marked.
        for call in [
            None,
            Some(MergeCall::Accepted),
            Some(MergeCall::HeadModified),
            Some(MergeCall::Refused(405)),
            Some(MergeCall::Unknown),
        ] {
            assert_eq!(
                decide_merge_step(&REVIEWED, &observed, call),
                MergeStep::Failed(failure),
                "{name} {call:?}"
            );
        }
        assert_eq!(failure.code(), code, "{name}");
    }
    // Every difference is checked on a merged pull request too, so a merge of another commit never reads as success.
    let merged_elsewhere = PullObservation {
        state: PullState::Merged,
        head_sha: DEF,
        default_branch_has_reviewed: Some(true),
        ..AS_REVIEWED
    };
    assert_eq!(
        decide_merge_step(&REVIEWED, &merged_elsewhere, None),
        MergeStep::Failed(MergeFailure::CommitChanged)
    );
}

/// M5-09: with a changed head the merge fails with `commit_changed`. The step touches no task, so it stays completed,
/// and the way on is a follow-up task.
#[test]
fn m5_09_a_changed_head_fails_the_merge_and_calls_for_a_follow_up() {
    let moved = PullObservation {
        head_sha: DEF,
        ..AS_REVIEWED
    };
    let step = decide_merge_step(&REVIEWED, &moved, None);
    assert_eq!(step, MergeStep::Failed(MergeFailure::CommitChanged));
    // GitHub's own refusal of a head that moved between the read and the call is the same failure.
    assert_eq!(
        decide_merge_step(&REVIEWED, &AS_REVIEWED, Some(MergeCall::HeadModified)),
        MergeStep::Failed(MergeFailure::CommitChanged)
    );
    assert!(MergeFailure::CommitChanged.needs_follow_up());
    assert!(MergeFailure::AuthorityLost(MergeRefusal::CommitChanged).needs_follow_up());
    for other in [
        MergeFailure::BaseChanged,
        MergeFailure::HeadRepoChanged,
        MergeFailure::PullClosed,
        MergeFailure::ProviderRefused(405),
        MergeFailure::AuthorityLost(MergeRefusal::Grant(GrantRefusal::GrantRequired)),
    ] {
        assert!(!other.needs_follow_up(), "{other:?}");
    }
    assert_eq!(
        merge_transition(MergeState::Requested, MergeEvent::Failed),
        Some(MergeState::Failed)
    );
    // And asking again is refused, as the request's own table shows.
    let (task, merge) = (approved(), grant(GrantAction::Merge));
    assert_eq!(task.status, TaskStatus::Completed);
    assert_eq!(
        decide_merge_request(
            &passing(&task, &merge),
            Some(&change(
                MergeState::Failed,
                Some(MergeFailure::CommitChanged.code())
            ))
        ),
        Err(MergeRefusal::CommitChanged)
    );
}

#[test]
fn a_moved_base_still_merges_and_is_reported() {
    let moved_base = PullObservation {
        base_sha: MOVED_BASE,
        ..AS_REVIEWED
    };
    assert_eq!(
        decide_merge_step(&REVIEWED, &moved_base, None),
        MergeStep::MarkAndMerge {
            sha: ABC,
            base_moved: Some(true)
        }
    );
    let no_base_kept = Reviewed {
        base_sha: None,
        ..REVIEWED
    };
    assert_eq!(
        decide_merge_step(&no_base_kept, &moved_base, None),
        MergeStep::MarkAndMerge {
            sha: ABC,
            base_moved: None
        }
    );
}

/// A second merge call answers `200`, so success is read from the pull request and never from the call.
#[test]
fn success_comes_only_from_the_pull_requests_own_state() {
    let merged = |contains| PullObservation {
        state: PullState::Merged,
        default_branch_has_reviewed: contains,
        ..AS_REVIEWED
    };
    let calls = [
        None,
        Some(MergeCall::Accepted),
        Some(MergeCall::HeadModified),
        Some(MergeCall::Refused(405)),
        Some(MergeCall::Unknown),
    ];
    for call in calls {
        // Merged, and the default branch is seen to contain the reviewed commit. A retried job finds this first and
        // never calls again.
        assert_eq!(
            decide_merge_step(&REVIEWED, &merged(Some(true)), call),
            MergeStep::Succeeded,
            "{call:?}"
        );
        // Merged, but the default branch wasn't read, or doesn't show the commit: not yet a success.
        for contains in [None, Some(false)] {
            assert_eq!(
                decide_merge_step(&REVIEWED, &merged(contains), call),
                MergeStep::ReadAgain,
                "{call:?} {contains:?}"
            );
        }
    }
    // GitHub said yes and the pull request still reads as open: nothing is recorded, and nothing is called twice in a run.
    assert_eq!(
        decide_merge_step(&REVIEWED, &AS_REVIEWED, Some(MergeCall::Accepted)),
        MergeStep::ReadAgain
    );
    // A lost answer is the same. The next run starts from a fresh read.
    assert_eq!(
        decide_merge_step(&REVIEWED, &AS_REVIEWED, Some(MergeCall::Unknown)),
        MergeStep::ReadAgain
    );
    // A claim that the default branch has the commit means nothing while the pull request is open.
    let open_but_contained = PullObservation {
        default_branch_has_reviewed: Some(true),
        ..AS_REVIEWED
    };
    assert_eq!(
        decide_merge_step(&REVIEWED, &open_but_contained, Some(MergeCall::Accepted)),
        MergeStep::ReadAgain
    );
}

#[test]
fn a_refusal_by_github_is_a_failure_with_its_status() {
    for status in [403, 405, 422] {
        let step = decide_merge_step(&REVIEWED, &AS_REVIEWED, Some(MergeCall::Refused(status)));
        assert_eq!(
            step,
            MergeStep::Failed(MergeFailure::ProviderRefused(status))
        );
    }
    assert_eq!(
        MergeFailure::ProviderRefused(405).code(),
        "provider_refused"
    );
}

/// The job rechecks authority before its external call, and a requester who lost it since asking fails the merge under
/// that refusal's own name (AC-13, AC-27).
#[test]
fn the_jobs_recheck_fails_the_merge_when_authority_is_gone() {
    let (task, merge) = (approved(), grant(GrantAction::Merge));
    let revoked = Grant {
        revoked_at: Some(NOW - 1),
        ..merge
    };
    for (name, authority, code) in [
        (
            "the grant was revoked",
            MergeAuthority {
                grant: Some(&revoked),
                ..passing(&task, &merge)
            },
            "grant_required",
        ),
        (
            "the agent was disconnected",
            MergeAuthority {
                requester_connected: false,
                ..passing(&task, &merge)
            },
            "agent_disconnected",
        ),
        (
            "the repository was suspended",
            MergeAuthority {
                link: Some(LinkStatus::Suspended),
                ..passing(&task, &merge)
            },
            "repo_not_ready",
        ),
    ] {
        let refusal = check_merge_authority(&authority).unwrap_err();
        assert_eq!(MergeFailure::AuthorityLost(refusal).code(), code, "{name}");
    }
}

#[test]
fn a_merge_podster_didnt_make_is_named_for_what_it_was() {
    use MergeState as S;
    for (name, state, merged, reviewed, expected, reason) in [
        (
            "the merge Podster asked for",
            S::Requested,
            ABC,
            Some(ABC),
            ObservedMerge::Requested,
            None,
        ),
        (
            "seen again after it was recorded",
            S::Succeeded,
            ABC,
            Some(ABC),
            ObservedMerge::Requested,
            None,
        ),
        (
            "the reviewed commit, never asked for",
            S::NotRequested,
            ABC,
            Some(ABC),
            ObservedMerge::Unrequested,
            Some("unrequested_merge"),
        ),
        (
            "the reviewed commit, after a failed merge",
            S::Failed,
            ABC,
            Some(ABC),
            ObservedMerge::Unrequested,
            Some("unrequested_merge"),
        ),
        (
            "another commit, while a merge was asked for",
            S::Requested,
            DEF,
            Some(ABC),
            ObservedMerge::Unreviewed,
            Some("unreviewed_merge"),
        ),
        (
            "a commit nobody approved",
            S::NotRequested,
            ABC,
            None,
            ObservedMerge::Unreviewed,
            Some("unreviewed_merge"),
        ),
    ] {
        let got = classify_observed_merge(state, merged, reviewed);
        assert_eq!(got, expected, "{name}");
        assert_eq!(got.reason(), reason, "{name}");
    }
}
