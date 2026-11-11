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

/// A grant to `principal`, given by the room's owner.
fn grant_to(principal: &'static str, action: GrantAction) -> Grant<'static> {
    Grant {
        id: "g1",
        principal,
        provider_repo_id: REPO,
        action,
        delegated_by: "owner",
        expires_at: None,
        revoked_at: None,
    }
}

fn grant(action: GrantAction) -> Grant<'static> {
    grant_to("merger", action)
}

/// A principal and the person who controls it.
fn actor(id: &'static str, person: &'static str) -> Actor<'static> {
    Actor {
        id,
        person: Some(person),
    }
}

/// The submitting agent, owned by the person `p-sub`.
const SUBMITTER: Actor<'static> = Actor {
    id: "asg",
    person: Some("p-sub"),
};

/// A merge that passes: someone in the room with a merge grant from the current owner, controlled by a different person
/// from the submitter, names the approved submission and its commit, in a room whose repository is ready.
fn passing<'a>(task: &'a Task, grant: &'a Grant<'a>) -> MergeAuthority<'a> {
    MergeAuthority {
        task,
        request: Some(RequestState::Ready),
        link: Some(LinkStatus::Ready),
        link_repo_id: Some(REPO),
        requester: actor("merger", "p-merger"),
        requester_in_room: true,
        requester_connected: true,
        requester_controller_holds: true,
        submitter: SUBMITTER,
        grant: Some(grant),
        delegation_holder: Some("owner"),
        submission_no: 1,
        commit_sha: ABC,
        now: NOW,
    }
}

/// The proof of a passing recheck for the approved task.
fn authorized() -> MergeAuthorized {
    let (task, merge) = (approved(), grant(GrantAction::Merge));
    check_merge_authority(&passing(&task, &merge)).unwrap()
}

fn change(merge_state: MergeState, merge_reason: Option<&'static str>) -> Change<'static> {
    Change {
        merge_state,
        merge_reason,
        ..FRESH
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
    let proof = check_merge_authority(&passing(&task, &grant)).unwrap();
    assert_eq!(
        (proof.task_id(), proof.repo_id(), proof.commit_sha()),
        ("t", REPO, ABC)
    );
    assert_eq!(
        decide_merge_request(&passing(&task, &grant), Some(&FRESH)),
        Ok(MergeState::Requested)
    );
    // Asking changes nothing about the task: it stays completed, and the decision returns only the merge's state.
    assert_eq!(task.status, TaskStatus::Completed);
    assert_eq!(approved_commit(&task), Some(ABC));
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
    let someone_elses = grant_to("rev", GrantAction::Merge);
    use MergeRefusal as R;
    for (name, authority, refusal, code) in [
        (
            "removed from the room",
            MergeAuthority {
                requester_in_room: false,
                ..base
            },
            R::AccessRevoked,
            "access_revoked",
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
            "an agent whose linking person has left, or a person who has",
            MergeAuthority {
                requester_controller_holds: false,
                ..base
            },
            R::ControllerDeparted,
            "controller_departed",
        ),
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
            "the submitter",
            MergeAuthority {
                requester: SUBMITTER,
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
            "someone else's grant",
            MergeAuthority {
                grant: Some(&someone_elses),
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

/// A requester who was removed from the room keeps no merge authority, though their grant row survives: when asking,
/// and at the job's recheck of a merge they asked for while still in the room.
#[test]
fn a_removed_requester_with_a_surviving_grant_is_refused_at_the_request_and_at_the_recheck() {
    let (task, merge) = (approved(), grant(GrantAction::Merge));
    assert!(merge.is_live(NOW));
    let removed = MergeAuthority {
        requester_in_room: false,
        ..passing(&task, &merge)
    };
    // At the request, whatever state the change is in.
    for held in [FRESH, change(MergeState::Failed, Some("provider_refused"))] {
        assert_eq!(
            decide_merge_request(&removed, Some(&held)),
            Err(MergeRefusal::AccessRevoked)
        );
    }
    // At the job's recheck: no proof is made, so no step can be decided, and the merge fails under the refusal's name.
    let refusal = check_merge_authority(&removed).unwrap_err();
    assert_eq!(refusal, MergeRefusal::AccessRevoked);
    assert_eq!(
        MergeFailure::AuthorityLost(refusal).code(),
        "access_revoked"
    );
    assert!(!MergeFailure::AuthorityLost(refusal).needs_follow_up());
    // It comes before anything about the task or the grant.
    let removed_and_more = MergeAuthority {
        grant: None,
        link: Some(LinkStatus::Suspended),
        submission_no: 9,
        ..removed
    };
    assert_eq!(
        check_merge_authority(&removed_and_more),
        Err(MergeRefusal::AccessRevoked)
    );
}

/// A merge grant given by an owner who no longer holds the delegation doesn't count, at the request or at the recheck.
#[test]
fn a_grant_whose_giver_lost_ownership_merges_nothing() {
    let (task, merge) = (approved(), grant(GrantAction::Merge));
    for holder in [Some("new-owner"), None] {
        let stale = MergeAuthority {
            delegation_holder: holder,
            ..passing(&task, &merge)
        };
        assert_eq!(
            decide_merge_request(&stale, Some(&FRESH)),
            Err(MergeRefusal::Grant(GrantRefusal::GrantStale)),
            "{holder:?}"
        );
        assert_eq!(
            check_merge_authority(&stale),
            Err(MergeRefusal::Grant(GrantRefusal::GrantStale)),
            "{holder:?}"
        );
    }
    assert_eq!(
        MergeRefusal::Grant(GrantRefusal::GrantStale).code(),
        "grant_stale"
    );
    // Once the new owner grants again, it counts.
    let regranted = Grant {
        id: "g2",
        delegated_by: "new-owner",
        ..merge
    };
    let under_new_owner = MergeAuthority {
        delegation_holder: Some("new-owner"),
        ..passing(&task, &regranted)
    };
    assert_eq!(
        decide_merge_request(&under_new_owner, Some(&FRESH)),
        Ok(MergeState::Requested)
    );
}

/// AC-17 and M5-10: approval carries no merge. Whoever approved, asked for or administers the task is refused without a
/// separate merge grant, and the refusal is the same whether or not the task was approved.
#[test]
fn ac_17_an_approved_task_without_a_merge_grant_cant_be_merged() {
    let done = approved();
    let waiting = submitted();
    for task in [&done, &waiting] {
        for who in ["rev", "req", "owner", "merger"] {
            let push = grant_to(who, GrantAction::Push);
            for held in [None, Some(&push)] {
                let authority = MergeAuthority {
                    requester: actor(who, who),
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

/// M5-10 and decision 186: nobody merges work whose submitter answers to the same person they do, even holding a merge
/// grant. The rule compares controlling people, not IDs.
#[test]
fn m5_10_nobody_controlled_by_the_submitters_person_merges_the_work() {
    let task = approved();
    for (name, requester, expected) in [
        ("the submitting agent itself", SUBMITTER, false),
        // The submitter's row says one thing and the room another: the same ID is the same actor.
        (
            "the same agent under another person",
            actor("asg", "p-other"),
            false,
        ),
        (
            "the person who owns the submitting agent",
            actor("p-sub", "p-sub"),
            false,
        ),
        (
            "another agent of that owner",
            actor("sibling", "p-sub"),
            false,
        ),
        (
            "an agent whose owner the room can't name",
            Actor {
                id: "orphan",
                person: None,
            },
            false,
        ),
        ("another person", actor("p-merger", "p-merger"), true),
        ("another person's agent", actor("merger", "p-merger"), true),
        // M5-10: a reviewer may merge what they approved, with the grant, if a different person controls them.
        (
            "the reviewer, a different person",
            actor("rev", "rev"),
            true,
        ),
        (
            "the reviewer, an agent of another person",
            actor("rev", "p-rev"),
            true,
        ),
        (
            "the reviewer, an agent of the submitter's owner",
            actor("rev", "p-sub"),
            false,
        ),
    ] {
        let merge = grant_to(requester.id, GrantAction::Merge);
        let authority = MergeAuthority {
            requester,
            ..passing(&task, &merge)
        };
        let got = decide_merge_request(&authority, Some(&FRESH));
        if expected {
            assert_eq!(got, Ok(MergeState::Requested), "{name}");
        } else {
            assert_eq!(got, Err(MergeRefusal::SelfMerge), "{name}");
            assert_eq!(
                check_merge_authority(&authority),
                Err(MergeRefusal::SelfMerge),
                "{name}, at the recheck"
            );
        }
    }
    // A submitter whose controlling person is unknown is the same as anyone, so nothing merges until the room can say.
    let merge = grant(GrantAction::Merge);
    let unknown_submitter = MergeAuthority {
        submitter: Actor {
            id: "asg",
            person: None,
        },
        ..passing(&task, &merge)
    };
    assert_eq!(
        check_merge_authority(&unknown_submitter),
        Err(MergeRefusal::SelfMerge)
    );
    // The task's assignee is refused too, whatever the submission's row names as its submitter.
    let asg_grant = grant_to("asg", GrantAction::Merge);
    let row_says_other = MergeAuthority {
        requester: actor("asg", "p-asg"),
        submitter: actor("someone", "p-someone"),
        ..passing(&task, &asg_grant)
    };
    assert_eq!(
        check_merge_authority(&row_says_other),
        Err(MergeRefusal::SelfMerge)
    );
}

#[test]
fn the_same_controller_is_decided_by_person_and_fails_closed() {
    let unknown = |id| Actor { id, person: None };
    for (a, b, same) in [
        (actor("a", "p1"), actor("a", "p1"), true),
        (actor("a", "p1"), actor("b", "p1"), true),
        (actor("p1", "p1"), actor("b", "p1"), true),
        (actor("a", "p1"), actor("a", "p2"), true),
        (actor("a", "p1"), actor("b", "p2"), false),
        (unknown("a"), actor("b", "p2"), true),
        (actor("a", "p1"), unknown("b"), true),
        (unknown("a"), unknown("b"), true),
    ] {
        assert_eq!(same_controller(&a, &b), same, "{a:?} {b:?}");
        assert_eq!(same_controller(&b, &a), same, "{b:?} {a:?}");
    }
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

/// A change whose own reviewed commit was never written is bound by the task's approved submission alone, and by
/// nothing looser: the request still has to name that commit.
#[test]
fn a_change_with_no_reviewed_commit_is_bound_by_the_tasks_approved_submission() {
    let (task, merge) = (approved(), grant(GrantAction::Merge));
    let unrecorded = Change {
        reviewed_commit_sha: None,
        ..FRESH
    };
    assert_eq!(
        decide_merge_request(&passing(&task, &merge), Some(&unrecorded)),
        Ok(MergeState::Requested)
    );
    let naming_another = MergeAuthority {
        commit_sha: DEF,
        ..passing(&task, &merge)
    };
    assert_eq!(
        decide_merge_request(&naming_another, Some(&unrecorded)),
        Err(MergeRefusal::CommitChanged)
    );
    // A task whose approved submission recorded no commit has nothing a merge can name.
    let no_commit = Task {
        submission_commit: None,
        ..approved()
    };
    assert_eq!(approved_commit(&no_commit), None);
    assert_eq!(
        decide_merge_request(&passing(&no_commit, &merge), Some(&unrecorded)),
        Err(MergeRefusal::CommitChanged)
    );
    assert_eq!(approved_commit(&submitted()), None);
}

const REVIEWED: ReviewedBase<'static> = ReviewedBase {
    default_branch: "main",
    base_sha: Some(BASE),
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

const MERGED: PullObservation<'static> = PullObservation {
    state: PullState::Merged,
    default_branch_has_reviewed: Some(true),
    ..AS_REVIEWED
};

/// The only way to a proof of an observed merge: a rechecked authority and a read that shows it.
fn observed_merge(authorized: &MergeAuthorized) -> MergeObserved {
    match decide_merge_step(authorized, &REVIEWED, &MERGED, None) {
        MergeStep::Succeeded(seen) => seen,
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_merge_state_moves_only_along_its_three_events() {
    use MergeState as S;
    let seen = observed_merge(&authorized());
    assert_eq!((seen.task_id(), seen.commit_sha()), ("t", ABC));
    let events = [
        MergeEvent::Requested,
        MergeEvent::Succeeded(seen),
        MergeEvent::Failed,
    ];
    for from in [S::NotRequested, S::Requested, S::Succeeded, S::Failed] {
        for event in &events {
            let expected = match (from, event) {
                (S::NotRequested | S::Failed, MergeEvent::Requested) => Some(S::Requested),
                (S::Requested, MergeEvent::Succeeded(_)) => Some(S::Succeeded),
                (S::Requested, MergeEvent::Failed) => Some(S::Failed),
                _ => None,
            };
            assert_eq!(
                merge_transition("t", from, event),
                expected,
                "{from:?} {event:?}"
            );
        }
    }
    assert_eq!(events[0].name(), "merge.requested");
    assert_eq!(events[1].name(), "merge.succeeded");
    assert_eq!(events[2].name(), "merge.failed");
}

/// Success is bound to an observation of the same task. One made for another task moves nothing.
#[test]
fn a_merge_succeeds_only_on_an_observation_of_its_own_task() {
    let seen = MergeEvent::Succeeded(observed_merge(&authorized()));
    assert_eq!(
        merge_transition("t", MergeState::Requested, &seen),
        Some(MergeState::Succeeded)
    );
    assert_eq!(
        merge_transition("another-task", MergeState::Requested, &seen),
        None
    );
    // The proof names what the recheck authorized, so a proof for another task's commit can't be made from this one.
    let other_task = Task {
        id: "t2".into(),
        ..approved()
    };
    let merge = grant(GrantAction::Merge);
    let other = check_merge_authority(&passing(&other_task, &merge)).unwrap();
    let other_seen = MergeEvent::Succeeded(observed_merge(&other));
    assert_eq!(
        merge_transition("t", MergeState::Requested, &other_seen),
        None
    );
    assert_eq!(
        merge_transition("t2", MergeState::Requested, &other_seen),
        Some(MergeState::Succeeded)
    );
}

#[test]
fn the_job_marks_and_merges_only_the_pull_request_it_reviewed() {
    let authorized = authorized();
    assert_eq!(
        decide_merge_step(&authorized, &REVIEWED, &AS_REVIEWED, None),
        MergeStep::MarkAndMerge {
            sha: ABC.into(),
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
                decide_merge_step(&authorized, &REVIEWED, &observed, call),
                MergeStep::Failed(failure),
                "{name} {call:?}"
            );
        }
        assert_eq!(failure.code(), code, "{name}");
    }
    // Every difference is checked on a merged pull request too, so a merge of another commit never reads as success.
    for observed in [
        PullObservation {
            head_sha: DEF,
            ..MERGED
        },
        PullObservation {
            base_ref: "release",
            ..MERGED
        },
        PullObservation {
            head_repo_id: Some(REPO + 1),
            ..MERGED
        },
    ] {
        assert!(matches!(
            decide_merge_step(&authorized, &REVIEWED, &observed, None),
            MergeStep::Failed(_)
        ));
    }
}

/// M5-09: with a changed head the merge fails with `commit_changed`. The step touches no task, so it stays completed,
/// and the way on is a follow-up task.
#[test]
fn m5_09_a_changed_head_fails_the_merge_and_calls_for_a_follow_up() {
    let authorized = authorized();
    let moved = PullObservation {
        head_sha: DEF,
        ..AS_REVIEWED
    };
    let step = decide_merge_step(&authorized, &REVIEWED, &moved, None);
    assert_eq!(step, MergeStep::Failed(MergeFailure::CommitChanged));
    // GitHub's own refusal of a head that moved between the read and the call is the same failure.
    assert_eq!(
        decide_merge_step(
            &authorized,
            &REVIEWED,
            &AS_REVIEWED,
            Some(MergeCall::HeadModified)
        ),
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
        merge_transition("t", MergeState::Requested, &MergeEvent::Failed),
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
    let authorized = authorized();
    let moved_base = PullObservation {
        base_sha: MOVED_BASE,
        ..AS_REVIEWED
    };
    assert_eq!(
        decide_merge_step(&authorized, &REVIEWED, &moved_base, None),
        MergeStep::MarkAndMerge {
            sha: ABC.into(),
            base_moved: Some(true)
        }
    );
    let no_base_kept = ReviewedBase {
        base_sha: None,
        ..REVIEWED
    };
    assert_eq!(
        decide_merge_step(&authorized, &no_base_kept, &moved_base, None),
        MergeStep::MarkAndMerge {
            sha: ABC.into(),
            base_moved: None
        }
    );
}

/// A second merge call answers `200`, so success is read from the pull request and never from the call.
#[test]
fn success_comes_only_from_the_pull_requests_own_state() {
    let authorized = authorized();
    let merged = |contains| PullObservation {
        default_branch_has_reviewed: contains,
        ..MERGED
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
        let step = decide_merge_step(&authorized, &REVIEWED, &merged(Some(true)), call);
        assert!(
            matches!(&step, MergeStep::Succeeded(seen) if seen.task_id() == "t" && seen.commit_sha() == ABC),
            "{call:?} {step:?}"
        );
        // Merged, but the default branch wasn't read, or doesn't show the commit: not yet a success.
        for contains in [None, Some(false)] {
            assert_eq!(
                decide_merge_step(&authorized, &REVIEWED, &merged(contains), call),
                MergeStep::ReadAgain,
                "{call:?} {contains:?}"
            );
        }
    }
    // GitHub said yes and the pull request still reads as open: nothing is recorded, and nothing is called twice in a run.
    // A lost answer is the same. The next run starts from a fresh read.
    for call in [MergeCall::Accepted, MergeCall::Unknown] {
        assert_eq!(
            decide_merge_step(&authorized, &REVIEWED, &AS_REVIEWED, Some(call)),
            MergeStep::ReadAgain,
            "{call:?}"
        );
    }
    // A claim that the default branch has the commit means nothing while the pull request is open.
    let open_but_contained = PullObservation {
        default_branch_has_reviewed: Some(true),
        ..AS_REVIEWED
    };
    for call in [None, Some(MergeCall::Accepted)] {
        assert!(!matches!(
            decide_merge_step(&authorized, &REVIEWED, &open_but_contained, call),
            MergeStep::Succeeded(_)
        ));
    }
}

#[test]
fn a_refusal_by_github_is_a_failure_with_its_status() {
    let authorized = authorized();
    for status in [403, 405, 422] {
        let step = decide_merge_step(
            &authorized,
            &REVIEWED,
            &AS_REVIEWED,
            Some(MergeCall::Refused(status)),
        );
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
/// that refusal's own name (AC-13, AC-27). With no proof from the recheck, no step can be decided at all.
#[test]
fn the_jobs_recheck_fails_the_merge_when_authority_is_gone() {
    let (task, merge) = (approved(), grant(GrantAction::Merge));
    let revoked = Grant {
        revoked_at: Some(NOW - 1),
        ..merge
    };
    for (name, authority, code) in [
        (
            "the requester was removed from the room",
            MergeAuthority {
                requester_in_room: false,
                ..passing(&task, &merge)
            },
            "access_revoked",
        ),
        (
            "the grant was revoked",
            MergeAuthority {
                grant: Some(&revoked),
                ..passing(&task, &merge)
            },
            "grant_required",
        ),
        (
            "the room's ownership moved",
            MergeAuthority {
                delegation_holder: Some("new-owner"),
                ..passing(&task, &merge)
            },
            "grant_stale",
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

/// The approved commit comes from the task itself, so a caller can't pass off another commit as reviewed.
#[test]
fn a_merge_podster_didnt_make_is_named_for_what_it_was() {
    use MergeState as S;
    let done = approved();
    let waiting = submitted();
    let no_commit = Task {
        submission_commit: None,
        ..approved()
    };
    for (name, task, state, merged, expected, reason) in [
        (
            "the merge Podster asked for",
            &done,
            S::Requested,
            ABC,
            ObservedMerge::Requested,
            None,
        ),
        (
            "seen again after it was recorded",
            &done,
            S::Succeeded,
            ABC,
            ObservedMerge::Requested,
            None,
        ),
        (
            "the reviewed commit, never asked for",
            &done,
            S::NotRequested,
            ABC,
            ObservedMerge::Unrequested,
            Some("unrequested_merge"),
        ),
        (
            "the reviewed commit, after a failed merge",
            &done,
            S::Failed,
            ABC,
            ObservedMerge::Unrequested,
            Some("unrequested_merge"),
        ),
        (
            "another commit, while a merge was asked for",
            &done,
            S::Requested,
            DEF,
            ObservedMerge::Unreviewed,
            Some("unreviewed_merge"),
        ),
        // The submission's commit, on a task nobody approved yet.
        (
            "a commit still in review",
            &waiting,
            S::NotRequested,
            ABC,
            ObservedMerge::Unreviewed,
            Some("unreviewed_merge"),
        ),
        (
            "an approved task that recorded no commit",
            &no_commit,
            S::Requested,
            ABC,
            ObservedMerge::Unreviewed,
            Some("unreviewed_merge"),
        ),
    ] {
        let got = classify_observed_merge(task, state, merged);
        assert_eq!(got, expected, "{name}");
        assert_eq!(got.reason(), reason, "{name}");
    }
}

#[test]
fn a_change_stands_as_reviewed_only_with_a_recorded_review_no_changed_commit_and_a_watch() {
    use podster_core::repo_merge::{check_change_standing, ChangeStanding};
    let reviewed = "a1".repeat(20);
    let standing = ChangeStanding {
        reviewed_commit_sha: Some(&reviewed),
        commit_changed: false,
        watched: true,
    };
    assert_eq!(check_change_standing(&standing, &reviewed), Ok(()));
    // Approved while managed repositories were off: nothing was read, so nothing was reviewed here.
    let unread = ChangeStanding {
        reviewed_commit_sha: None,
        ..standing
    };
    assert_eq!(
        check_change_standing(&unread, &reviewed),
        Err(MergeRefusal::ReviewRequired)
    );
    assert_eq!(MergeRefusal::ReviewRequired.code(), "review_required");
    // Another commit than the reviewed one, or a head seen off it at any time, even if it's back.
    assert_eq!(
        check_change_standing(&standing, &"b2".repeat(20)),
        Err(MergeRefusal::CommitChanged)
    );
    let changed = ChangeStanding {
        commit_changed: true,
        ..standing
    };
    assert_eq!(
        check_change_standing(&changed, &reviewed),
        Err(MergeRefusal::CommitChanged)
    );
    let unwatched = ChangeStanding {
        watched: false,
        ..standing
    };
    assert_eq!(
        check_change_standing(&unwatched, &reviewed),
        Err(MergeRefusal::ChangeUnwatched)
    );
    assert_eq!(MergeRefusal::ChangeUnwatched.code(), "change_unwatched");
    // A changed commit is said before an unwatched change.
    let both = ChangeStanding {
        commit_changed: true,
        watched: false,
        ..standing
    };
    assert_eq!(
        check_change_standing(&both, &reviewed),
        Err(MergeRefusal::CommitChanged)
    );
}

#[test]
fn the_merge_calls_answer_is_read_by_status_and_never_as_a_merge() {
    use podster_core::repo_merge::merge_call;
    assert_eq!(merge_call(Some(200)), MergeCall::Accepted);
    assert_eq!(merge_call(Some(409)), MergeCall::HeadModified);
    for status in [None, Some(500), Some(502), Some(503), Some(599)] {
        assert_eq!(merge_call(status), MergeCall::Unknown, "{status:?}");
    }
    for status in [201, 204, 302, 401, 403, 404, 405, 422, 429] {
        assert_eq!(
            merge_call(Some(status)),
            MergeCall::Refused(status),
            "{status}"
        );
    }
}

#[test]
fn merge_caps_and_the_new_failure_codes() {
    use podster_core::repo_merge::{
        merge_attempt_allowed, merge_request_allowed, RequestLimit, MAX_MERGE_ATTEMPTS,
        MAX_MERGE_REQUESTS_PER_HOUR, MAX_MERGE_REQUESTS_PER_TASK,
    };
    assert!(merge_attempt_allowed(MAX_MERGE_ATTEMPTS - 1));
    assert!(!merge_attempt_allowed(MAX_MERGE_ATTEMPTS));
    assert_eq!(
        merge_request_allowed(MAX_MERGE_REQUESTS_PER_HOUR - 1, 0),
        Ok(())
    );
    assert_eq!(
        merge_request_allowed(MAX_MERGE_REQUESTS_PER_HOUR, 0),
        Err(RequestLimit::Room)
    );
    assert_eq!(
        merge_request_allowed(0, MAX_MERGE_REQUESTS_PER_TASK - 1),
        Ok(())
    );
    assert_eq!(
        merge_request_allowed(0, MAX_MERGE_REQUESTS_PER_TASK),
        Err(RequestLimit::Task)
    );
    // The task's lifetime limit is said first, since no wait lifts it.
    assert_eq!(
        merge_request_allowed(MAX_MERGE_REQUESTS_PER_HOUR, MAX_MERGE_REQUESTS_PER_TASK),
        Err(RequestLimit::Task)
    );
    assert_eq!(
        [RequestLimit::Room.code(), RequestLimit::Task.code()],
        ["rate_limited", "merge_request_limit"]
    );
    // An outcome that isn't known yet is settled only by a read: to succeeded with its proof, or to failed.
    assert_eq!(
        merge_transition("t", MergeState::Requested, &MergeEvent::OutcomeUnknown),
        Some(MergeState::OutcomeUnknown)
    );
    assert_eq!(
        merge_transition("t", MergeState::OutcomeUnknown, &MergeEvent::Failed),
        Some(MergeState::Failed)
    );
    assert_eq!(
        merge_transition("t", MergeState::OutcomeUnknown, &MergeEvent::Requested),
        None
    );
    assert_eq!(
        merge_transition("t", MergeState::Failed, &MergeEvent::OutcomeUnknown),
        None
    );
    assert_eq!(MergeEvent::OutcomeUnknown.name(), "merge.outcome_unknown");
    assert_eq!(
        MergeState::from_name("outcome_unknown"),
        Some(MergeState::OutcomeUnknown)
    );
    assert_eq!(
        MergeFailure::DefaultBranchChanged.code(),
        "default_branch_changed"
    );
    // A call on record can be asked about later, and only a read of GitHub makes it a success.
    let recorded = MergeAuthorized::when_called("t", REPO, ABC);
    assert_eq!(
        (
            recorded.task_id(),
            recorded.repo_id(),
            recorded.commit_sha()
        ),
        ("t", REPO, ABC)
    );
    let codes = [
        MergeFailure::PullDraft.code(),
        MergeFailure::MergedElsewhere.code(),
        MergeFailure::NotReady.code(),
        MergeFailure::AttemptsExhausted.code(),
        MergeFailure::RoomArchived.code(),
        MergeFailure::RoomSuspended.code(),
    ];
    assert_eq!(
        codes,
        [
            "pull_request_draft",
            "merged_elsewhere",
            "repo_not_ready",
            "merge_attempts_exhausted",
            "workspace_archived",
            "room_suspended"
        ]
    );
    // None of them is a changed commit, so none asks for a follow-up task by itself.
    for failure in [
        MergeFailure::PullDraft,
        MergeFailure::MergedElsewhere,
        MergeFailure::NotReady,
        MergeFailure::AttemptsExhausted,
    ] {
        assert!(!failure.needs_follow_up());
    }
}

#[test]
fn reads_of_an_unknown_outcome_back_off_and_stop() {
    use podster_core::repo_merge::{unknown_read_allowed, unknown_read_wait_ms, MAX_UNKNOWN_READS};
    assert_eq!(unknown_read_wait_ms(0), 15 * 60 * 1000);
    assert_eq!(unknown_read_wait_ms(1), 30 * 60 * 1000);
    assert_eq!(unknown_read_wait_ms(4), 4 * 60 * 60 * 1000);
    assert_eq!(unknown_read_wait_ms(5), 6 * 60 * 60 * 1000);
    assert_eq!(unknown_read_wait_ms(u32::MAX), 6 * 60 * 60 * 1000);
    assert!(unknown_read_allowed(MAX_UNKNOWN_READS - 1, true));
    assert!(!unknown_read_allowed(MAX_UNKNOWN_READS, true));
    // Nothing is read for a room that's archived or suspended, however few reads were made.
    assert!(!unknown_read_allowed(0, false));
}

#[test]
fn a_read_after_a_recorded_call_is_decided_one_way_everywhere() {
    use podster_core::repo_merge::{decide_landed, Landed};
    let auth = MergeAuthorized::when_called("t", REPO, ABC);
    let reviewed = ReviewedBase {
        default_branch: "main",
        base_sha: Some(BASE),
    };
    let seen = |state, head: &'static str, has| PullObservation {
        state,
        base_ref: "main",
        base_sha: BASE,
        head_repo_id: Some(REPO),
        head_sha: head,
        default_branch_has_reviewed: has,
    };
    // Merged, the reviewed commit, on the default branch, and the default branch read: landed.
    let merged = seen(PullState::Merged, ABC, Some(true));
    assert!(matches!(
        decide_landed(&auth, &reviewed, &merged, None, Some("main")),
        Landed::Merged {
            default_branch_differs: false,
            ..
        }
    ));
    // The default branch has since been changed: still the merge it was, and the caller degrades the link.
    assert!(matches!(
        decide_landed(&auth, &reviewed, &merged, None, Some("trunk")),
        Landed::Merged {
            default_branch_differs: true,
            ..
        }
    ));
    // The default branch couldn't be read: nothing is recorded without the comparison.
    assert_eq!(
        decide_landed(&auth, &reviewed, &merged, None, None),
        Landed::DefaultBranchUnread
    );
    // Not merged, or not yet on the default branch, or another commit: it didn't land.
    assert!(matches!(
        decide_landed(
            &auth,
            &reviewed,
            &seen(PullState::Open, ABC, Some(false)),
            None,
            Some("main")
        ),
        Landed::No(MergeStep::MarkAndMerge { .. })
    ));
    assert_eq!(
        decide_landed(
            &auth,
            &reviewed,
            &seen(PullState::Merged, ABC, None),
            None,
            Some("main")
        ),
        Landed::No(MergeStep::ReadAgain)
    );
    assert_eq!(
        decide_landed(
            &auth,
            &reviewed,
            &seen(PullState::Merged, DEF, Some(true)),
            None,
            Some("main")
        ),
        Landed::No(MergeStep::Failed(MergeFailure::CommitChanged))
    );
    assert_eq!(
        decide_landed(
            &auth,
            &reviewed,
            &seen(PullState::Closed, ABC, Some(false)),
            None,
            None
        ),
        Landed::No(MergeStep::Failed(MergeFailure::PullClosed))
    );
}

#[test]
fn a_final_unknown_may_be_asked_for_again_and_the_watch_settles_it() {
    use podster_core::repo_merge::{requestable_state, settle_unknown_from_watch, WatchSettles};
    assert_eq!(
        requestable_state(MergeState::OutcomeUnknown, true),
        MergeState::Failed
    );
    assert_eq!(
        requestable_state(MergeState::OutcomeUnknown, false),
        MergeState::OutcomeUnknown
    );
    for state in [
        MergeState::NotRequested,
        MergeState::Requested,
        MergeState::Succeeded,
        MergeState::Failed,
    ] {
        assert_eq!(requestable_state(state, true), state);
    }
    let auth = MergeAuthorized::when_called("t", REPO, ABC);
    let reviewed = ReviewedBase {
        default_branch: "main",
        base_sha: Some(BASE),
    };
    let settle = |state, head: &'static str, base: &'static str, reported: Option<&'static str>| {
        let seen = PullObservation {
            state,
            base_ref: base,
            base_sha: BASE,
            head_repo_id: Some(REPO),
            head_sha: head,
            default_branch_has_reviewed: None,
        };
        settle_unknown_from_watch(&auth, &reviewed, &seen, reported)
    };
    assert!(matches!(
        settle(PullState::Merged, ABC, "main", Some("main")),
        WatchSettles::Merged(_)
    ));
    assert_eq!(
        settle(PullState::Open, ABC, "main", Some("main")),
        WatchSettles::NotYet
    );
    assert_eq!(
        settle(PullState::Closed, ABC, "main", Some("main")),
        WatchSettles::Failed
    );
    assert_eq!(
        settle(PullState::Closed, ABC, "main", None),
        WatchSettles::Failed
    );
    // Merged at another commit, or into another branch: not the reviewed commit on the default branch.
    assert_eq!(
        settle(PullState::Merged, DEF, "main", Some("main")),
        WatchSettles::Failed
    );
    assert_eq!(
        settle(PullState::Merged, ABC, "release", Some("main")),
        WatchSettles::Failed
    );
    // The provider's default branch isn't the link's: not recorded as merged by the watch, and the link degrades.
    assert_eq!(
        settle(PullState::Merged, ABC, "main", Some("trunk")),
        WatchSettles::DefaultBranchDiffers
    );
    // The answer named no default branch: nothing is settled without the comparison.
    assert_eq!(
        settle(PullState::Merged, ABC, "main", None),
        WatchSettles::NotYet
    );
}

/// A2, for the owner to rule on: who "controls" an agent is the person who linked the credential a request came with,
/// recorded per request (`changes::controller_of`, `submitter_person`, `merge_requester_person`), not a property of the
/// agent. So a submission made through the credential person B linked is B's, and person A may merge it, even if A also
/// holds a credential for the same agent: nothing here sees A's. This pins today's behaviour so that a ruling which takes
/// every person holding a credential for the agent changes it on purpose.
#[test]
fn a2_today_the_controller_is_whoever_linked_the_credential_the_request_came_with() {
    let (task, grant) = (approved(), grant(GrantAction::Merge));
    let through_b = Actor {
        id: "asg",
        person: Some("p-b"),
    };
    let a = MergeAuthority {
        requester: actor("merger", "p-a"),
        submitter: through_b,
        ..passing(&task, &grant)
    };
    assert!(check_merge_authority(&a).is_ok());
    // The same agent's submission through A's credential is A's, and A is refused.
    let through_a = MergeAuthority {
        submitter: Actor {
            id: "asg",
            person: Some("p-a"),
        },
        ..a
    };
    assert_eq!(
        check_merge_authority(&through_a),
        Err(MergeRefusal::SelfMerge)
    );
}
