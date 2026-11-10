//! A task's pull request: whether it may be the task's change, and what a later read of it means (M5 step 7a, ADR 0009,
//! which is proposed). No I/O.
//!
//! The room reads the pull request from the provider with Podster's own token and passes what it saw here. Nothing a
//! client sends is trusted for any of it but the number and the commit it names, and both are checked against the read.
//!
//! - **Linking** ([`check_pull`], [`check_pull_number`]): at submission and again at review. The pull request must be in
//!   the room's repository, come from that same repository and never a fork, target its default branch, and be open.
//!   Whether its head is the commit named is [`crate::decide`]'s, through `Observed::head_sha`.
//! - **Watching** ([`watched`]): which changes the refresh job reads again. Staleness itself is
//!   [`crate::provider_deliveries::stale`]'s.
//! - **Observing** ([`observe`]): what a fresh read changes. A head that moved after review is recorded and never
//!   un-approves or re-pins (decision 25). A merge nobody asked Podster for is recorded with its reason and never treated
//!   as success.

use crate::repo_merge::{classify_observed_merge, ObservedMerge, PullState};
use crate::repositories::MergeState;
use crate::{Task, TaskStatus};

/// The names `pr_state` is stored and shown under.
pub fn pull_state_name(state: PullState) -> &'static str {
    match state {
        PullState::Open => "open",
        PullState::Closed => "closed",
        PullState::Merged => "merged",
    }
}

pub fn pull_state_from_name(name: &str) -> Option<PullState> {
    [PullState::Open, PullState::Closed, PullState::Merged]
        .into_iter()
        .find(|state| pull_state_name(*state) == name)
}

/// The room's linked repository, from its own `repo_link`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Linked<'a> {
    pub repo_id: i64,
    pub default_branch: &'a str,
}

/// A pull request as Podster's own read of the provider gave it. Only IDs, commit IDs, the base branch and a state: no
/// title, body, head branch name or author is ever read into this.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullSeen {
    pub number: i64,
    /// The repository the pull request is in, which is its base's.
    pub repo_id: Option<i64>,
    /// The repository its head branch is in. `None` when the provider names none, as for a deleted fork.
    pub head_repo_id: Option<i64>,
    pub head_sha: String,
    pub base_ref: String,
    pub base_sha: String,
    pub state: PullState,
    /// The merge commit, once merged.
    pub merge_sha: Option<String>,
    /// The provider's ID for the account that merged it.
    pub merged_by_id: Option<i64>,
}

/// Why a pull request can't be a task's change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkRefusal {
    /// No such pull request in the room's repository, or the read answered about another one.
    NotFound,
    /// Its head is in another repository. A fork's pull request is never a task change.
    FromFork,
    /// It doesn't target the repository's default branch.
    WrongBase,
    /// It's closed or already merged.
    NotOpen,
    /// Another task in the room already has this pull request.
    InUse,
    /// The task already has a different pull request.
    Changed,
}

impl LinkRefusal {
    pub fn code(self) -> &'static str {
        match self {
            LinkRefusal::NotFound => "pull_request_not_found",
            LinkRefusal::FromFork => "pull_request_from_fork",
            LinkRefusal::WrongBase => "pull_request_wrong_base",
            LinkRefusal::NotOpen => "pull_request_not_open",
            LinkRefusal::InUse => "pull_request_in_use",
            LinkRefusal::Changed => "pull_request_changed",
        }
    }
}

/// Whether a task may name this pull request number: once per room, and the same one for the task's whole life. A new
/// head of the same pull request is a new submission. A different pull request is a different change, so it needs its
/// own task: the first one's record, and anything observed on it since, is never replaced.
pub fn check_pull_number(
    tasks_own: Option<i64>,
    named: i64,
    held_by_another_task: bool,
) -> Result<(), LinkRefusal> {
    if named <= 0 {
        return Err(LinkRefusal::NotFound);
    }
    if tasks_own.is_some_and(|own| own != named) {
        return Err(LinkRefusal::Changed);
    }
    if held_by_another_task {
        return Err(LinkRefusal::InUse);
    }
    Ok(())
}

/// Whether the pull request read just now may be this task's change. Checked at submission and again at review, on a
/// fresh read each time, because an agent's token can edit a pull request.
pub fn check_pull(linked: &Linked, named: i64, seen: &PullSeen) -> Result<(), LinkRefusal> {
    if seen.number != named || seen.repo_id != Some(linked.repo_id) {
        return Err(LinkRefusal::NotFound);
    }
    if seen.head_repo_id != Some(linked.repo_id) {
        return Err(LinkRefusal::FromFork);
    }
    if seen.base_ref != linked.default_branch {
        return Err(LinkRefusal::WrongBase);
    }
    if seen.state != PullState::Open {
        return Err(LinkRefusal::NotOpen);
    }
    Ok(())
}

/// Whether the refresh job reads this change again. Only work that's waiting on a review or approved and not yet seen
/// merged. An open pull request is polled; a closed one is read only when a delivery says something happened to it.
pub fn watched(status: TaskStatus, state: Option<PullState>, nudged_since_read: bool) -> bool {
    matches!(status, TaskStatus::Submitted | TaskStatus::Completed)
        && match state {
            Some(PullState::Merged) => false,
            Some(PullState::Closed) => nudged_since_read,
            Some(PullState::Open) | None => true,
        }
}

/// What the room held about a change before a read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Held<'a> {
    pub head_sha: Option<&'a str>,
    pub head_repo_id: Option<i64>,
    /// Whether the base was the default branch at the last read.
    pub base_is_default: Option<bool>,
    pub state: Option<PullState>,
    pub reviewed_commit_sha: Option<&'a str>,
    pub merge_state: MergeState,
    /// Whether a merge has already been recorded for it.
    pub merge_recorded: bool,
}

/// What a fresh read changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Observation {
    /// Something the room holds differs from what was read, so this is recorded with an event. A read that found
    /// nothing new only moves the observation time.
    pub changed: bool,
    /// The head has just moved off the reviewed commit. The approval stands, the reviewed commit stays the reviewed
    /// commit, and the fact is recorded once.
    pub commit_changed: bool,
    /// A merge seen for the first time, and whether Podster asked for it.
    pub merge: Option<ObservedMerge>,
}

/// Compares a fresh read with what the room held. It decides only what to record: nothing here un-approves a task, moves
/// a reviewed commit, or counts a merge as Podster's.
pub fn observe(task: &Task, linked: &Linked, held: &Held, seen: &PullSeen) -> Observation {
    let base_is_default = seen.base_ref == linked.default_branch;
    let changed = held.head_sha != Some(seen.head_sha.as_str())
        || held.head_repo_id != seen.head_repo_id
        || held.base_is_default != Some(base_is_default)
        || held.state != Some(seen.state);
    let commit_changed = held.reviewed_commit_sha.is_some_and(|reviewed| {
        reviewed != seen.head_sha && held.head_sha.is_none_or(|head| head == reviewed)
    });
    let merge = (seen.state == PullState::Merged && !held.merge_recorded)
        .then(|| classify_observed_merge(task, held.merge_state, &seen.head_sha));
    Observation {
        changed,
        commit_changed,
        merge,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO: i64 = 4_100;
    const LINKED: Linked = Linked {
        repo_id: REPO,
        default_branch: "main",
    };

    fn sha(byte: &str) -> String {
        byte.repeat(20)
    }

    fn seen() -> PullSeen {
        PullSeen {
            number: 7,
            repo_id: Some(REPO),
            head_repo_id: Some(REPO),
            head_sha: sha("a1"),
            base_ref: "main".to_string(),
            base_sha: sha("b2"),
            state: PullState::Open,
            merge_sha: None,
            merged_by_id: None,
        }
    }

    fn task(status: TaskStatus, approved: bool) -> Task {
        Task {
            id: "tsk_1".to_string(),
            title: "t".to_string(),
            instructions: "i".to_string(),
            acceptance_criteria: None,
            requester: "per_r".to_string(),
            assignee: Some("agt_a".to_string()),
            reviewer: "per_v".to_string(),
            status,
            version: 3,
            due_at: None,
            follow_up_of: None,
            has_linked_repository: true,
            submission_no: 1,
            submission_commit: Some(sha("a1")),
            approved_submission_no: approved.then_some(1),
            submission_files: 0,
            assignee_departed: false,
            needs_reviewer: false,
            needs_requester: false,
        }
    }

    fn held<'a>(head: &'a str, reviewed: Option<&'a str>) -> Held<'a> {
        Held {
            head_sha: Some(head),
            head_repo_id: Some(REPO),
            base_is_default: Some(true),
            state: Some(PullState::Open),
            reviewed_commit_sha: reviewed,
            merge_state: MergeState::NotRequested,
            merge_recorded: false,
        }
    }

    #[test]
    fn pull_states_round_trip() {
        for state in [PullState::Open, PullState::Closed, PullState::Merged] {
            assert_eq!(pull_state_from_name(pull_state_name(state)), Some(state));
        }
        assert_eq!(pull_state_from_name("OPEN"), None);
        assert_eq!(pull_state_from_name(""), None);
    }

    #[test]
    fn a_pull_request_in_the_rooms_repository_on_its_default_branch_and_open_may_be_linked() {
        assert_eq!(check_pull(&LINKED, 7, &seen()), Ok(()));
    }

    #[test]
    fn each_way_a_pull_request_isnt_the_tasks_is_refused_with_its_own_code() {
        let cases = [
            (
                PullSeen {
                    number: 8,
                    ..seen()
                },
                LinkRefusal::NotFound,
            ),
            (
                PullSeen {
                    repo_id: Some(REPO + 1),
                    ..seen()
                },
                LinkRefusal::NotFound,
            ),
            (
                PullSeen {
                    repo_id: None,
                    ..seen()
                },
                LinkRefusal::NotFound,
            ),
            (
                PullSeen {
                    head_repo_id: Some(REPO + 1),
                    ..seen()
                },
                LinkRefusal::FromFork,
            ),
            (
                PullSeen {
                    head_repo_id: None,
                    ..seen()
                },
                LinkRefusal::FromFork,
            ),
            (
                PullSeen {
                    base_ref: "release".to_string(),
                    ..seen()
                },
                LinkRefusal::WrongBase,
            ),
            (
                PullSeen {
                    state: PullState::Closed,
                    ..seen()
                },
                LinkRefusal::NotOpen,
            ),
            (
                PullSeen {
                    state: PullState::Merged,
                    ..seen()
                },
                LinkRefusal::NotOpen,
            ),
        ];
        for (pull, refusal) in cases {
            assert_eq!(check_pull(&LINKED, 7, &pull), Err(refusal), "{pull:?}");
        }
        let codes: std::collections::BTreeSet<_> = [
            LinkRefusal::NotFound,
            LinkRefusal::FromFork,
            LinkRefusal::WrongBase,
            LinkRefusal::NotOpen,
            LinkRefusal::InUse,
            LinkRefusal::Changed,
        ]
        .into_iter()
        .map(LinkRefusal::code)
        .collect();
        assert_eq!(codes.len(), 6);
    }

    #[test]
    fn a_fork_is_refused_before_its_base_or_state_is_looked_at() {
        let pull = PullSeen {
            head_repo_id: Some(1),
            base_ref: "other".to_string(),
            state: PullState::Closed,
            ..seen()
        };
        assert_eq!(check_pull(&LINKED, 7, &pull), Err(LinkRefusal::FromFork));
    }

    #[test]
    fn a_task_keeps_one_pull_request_and_a_pull_request_one_task() {
        assert_eq!(check_pull_number(None, 7, false), Ok(()));
        assert_eq!(check_pull_number(Some(7), 7, false), Ok(()));
        assert_eq!(
            check_pull_number(Some(7), 8, false),
            Err(LinkRefusal::Changed)
        );
        assert_eq!(check_pull_number(None, 7, true), Err(LinkRefusal::InUse));
        assert_eq!(
            check_pull_number(None, 0, false),
            Err(LinkRefusal::NotFound)
        );
        assert_eq!(
            check_pull_number(None, -3, false),
            Err(LinkRefusal::NotFound)
        );
    }

    #[test]
    fn only_work_awaiting_review_or_approved_and_unmerged_is_watched() {
        for status in [TaskStatus::Submitted, TaskStatus::Completed] {
            assert!(watched(status, None, false));
            assert!(watched(status, Some(PullState::Open), false));
            assert!(!watched(status, Some(PullState::Closed), false));
            assert!(watched(status, Some(PullState::Closed), true));
            assert!(!watched(status, Some(PullState::Merged), true));
        }
        for status in [TaskStatus::Open, TaskStatus::Accepted, TaskStatus::Canceled] {
            assert!(!watched(status, Some(PullState::Open), true), "{status:?}");
        }
    }

    #[test]
    fn a_read_that_finds_nothing_new_changes_nothing() {
        let head = sha("a1");
        let got = observe(
            &task(TaskStatus::Submitted, false),
            &LINKED,
            &held(&head, None),
            &seen(),
        );
        assert_eq!(
            got,
            Observation {
                changed: false,
                commit_changed: false,
                merge: None
            }
        );
    }

    #[test]
    fn a_moved_head_before_review_is_a_change_and_not_a_changed_commit() {
        let head = sha("c3");
        let got = observe(
            &task(TaskStatus::Submitted, false),
            &LINKED,
            &held(&head, None),
            &seen(),
        );
        assert!(got.changed);
        assert!(!got.commit_changed);
    }

    #[test]
    fn a_head_that_moves_off_the_reviewed_commit_is_recorded_once() {
        let reviewed = sha("a1");
        let moved = PullSeen {
            head_sha: sha("d4"),
            ..seen()
        };
        let approved = task(TaskStatus::Completed, true);
        let first = observe(
            &approved,
            &LINKED,
            &held(&reviewed, Some(&reviewed)),
            &moved,
        );
        assert!(first.changed && first.commit_changed);
        // The room now holds the moved head. Reading it again, or seeing it move further, says nothing new about review.
        let later = sha("d4");
        let again = observe(&approved, &LINKED, &held(&later, Some(&reviewed)), &moved);
        assert!(!again.changed && !again.commit_changed);
        let further = PullSeen {
            head_sha: sha("e5"),
            ..seen()
        };
        let third = observe(&approved, &LINKED, &held(&later, Some(&reviewed)), &further);
        assert!(third.changed && !third.commit_changed);
    }

    #[test]
    fn a_new_base_branch_a_fork_head_or_a_closed_state_is_a_change() {
        let head = sha("a1");
        for pull in [
            PullSeen {
                base_ref: "other".to_string(),
                ..seen()
            },
            PullSeen {
                head_repo_id: None,
                ..seen()
            },
            PullSeen {
                state: PullState::Closed,
                ..seen()
            },
        ] {
            let got = observe(
                &task(TaskStatus::Submitted, false),
                &LINKED,
                &held(&head, None),
                &pull,
            );
            assert!(got.changed, "{pull:?}");
            assert_eq!(got.merge, None);
        }
    }

    #[test]
    fn a_merge_nobody_asked_for_is_classified_and_recorded_once() {
        let reviewed = sha("a1");
        let merged = PullSeen {
            state: PullState::Merged,
            merge_sha: Some(sha("f6")),
            merged_by_id: Some(99),
            ..seen()
        };
        // Approved, and merged at the reviewed commit, but Podster never asked.
        let approved = task(TaskStatus::Completed, true);
        let got = observe(
            &approved,
            &LINKED,
            &held(&reviewed, Some(&reviewed)),
            &merged,
        );
        assert_eq!(got.merge, Some(ObservedMerge::Unrequested));
        // Never approved.
        let got = observe(
            &task(TaskStatus::Submitted, false),
            &LINKED,
            &held(&reviewed, None),
            &merged,
        );
        assert_eq!(got.merge, Some(ObservedMerge::Unreviewed));
        // Approved, but what merged isn't what was reviewed.
        let other = PullSeen {
            head_sha: sha("d4"),
            ..merged.clone()
        };
        let got = observe(
            &approved,
            &LINKED,
            &held(&reviewed, Some(&reviewed)),
            &other,
        );
        assert_eq!(got.merge, Some(ObservedMerge::Unreviewed));
        assert!(got.commit_changed);
        // One Podster asked for is the merge job's to record.
        let requested = Held {
            merge_state: MergeState::Requested,
            ..held(&reviewed, Some(&reviewed))
        };
        assert_eq!(
            observe(&approved, &LINKED, &requested, &merged).merge,
            Some(ObservedMerge::Requested)
        );
        // Already recorded: nothing again.
        let recorded = Held {
            merge_recorded: true,
            state: Some(PullState::Merged),
            ..held(&reviewed, Some(&reviewed))
        };
        let got = observe(&approved, &LINKED, &recorded, &merged);
        assert_eq!(got.merge, None);
        assert!(!got.changed);
    }
}
