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
    /// The branch it targets. `None` when the provider's name for it isn't one a branch of ours could have, such as
    /// one too long to be the default branch: that reads as "not the default branch", never as unreadable.
    pub base_ref: Option<String>,
    pub base_sha: String,
    pub state: PullState,
    /// Whether its author still marks it as a draft. A flag, and nothing else about it.
    pub draft: bool,
    /// The default branch of the repository the pull request is in, as the provider's answer about the pull request
    /// says. `None` if it didn't say. Compared with the link's, and never kept.
    pub repo_default_branch: Option<String>,
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
    /// Its author still marks it as a draft. A draft can't be merged, and review is of work marked ready.
    Draft,
    /// Another task in the room already has this pull request.
    InUse,
    /// The task already has a different pull request.
    Changed,
}

impl LinkRefusal {
    // codes: errors
    pub fn code(self) -> &'static str {
        match self {
            LinkRefusal::NotFound => "pull_request_not_found",
            LinkRefusal::FromFork => "pull_request_from_fork",
            LinkRefusal::WrongBase => "pull_request_wrong_base",
            LinkRefusal::NotOpen => "pull_request_not_open",
            LinkRefusal::Draft => "pull_request_draft",
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

/// Whether the pull request targets the linked repository's default branch.
pub fn targets_default(linked: &Linked, seen: &PullSeen) -> bool {
    !linked.default_branch.is_empty() && seen.base_ref.as_deref() == Some(linked.default_branch)
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
    if !targets_default(linked, seen) {
        return Err(LinkRefusal::WrongBase);
    }
    if seen.state != PullState::Open {
        return Err(LinkRefusal::NotOpen);
    }
    if seen.draft {
        return Err(LinkRefusal::Draft);
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
    pub draft: Option<bool>,
    pub reviewed_commit_sha: Option<&'a str>,
    /// Whether the head has already been recorded as having left the reviewed commit. That record is never cleared.
    pub commit_changed_recorded: bool,
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
    /// The head is off the reviewed commit and that hasn't been recorded yet. The approval stands, the reviewed commit
    /// stays the reviewed commit, and the fact is recorded once and kept, even if the branch is later put back.
    pub commit_changed: bool,
    /// A merge seen for the first time, and whether Podster asked for it.
    pub merge: Option<ObservedMerge>,
}

/// Compares a fresh read with what the room held. It decides only what to record: nothing here un-approves a task, moves
/// a reviewed commit, or counts a merge as Podster's.
pub fn observe(task: &Task, linked: &Linked, held: &Held, seen: &PullSeen) -> Observation {
    let base_is_default = targets_default(linked, seen);
    let changed = held.head_sha != Some(seen.head_sha.as_str())
        || held.head_repo_id != seen.head_repo_id
        || held.base_is_default != Some(base_is_default)
        || held.state != Some(seen.state)
        || held.draft != Some(seen.draft);
    let commit_changed = !held.commit_changed_recorded
        && held
            .reviewed_commit_sha
            .is_some_and(|reviewed| reviewed != seen.head_sha);
    let merge = (seen.state == PullState::Merged && !held.merge_recorded)
        .then(|| classify_observed_merge(task, held.merge_state, &seen.head_sha));
    Observation {
        changed,
        commit_changed,
        merge,
    }
}

/// After this many reads in a row that found no such pull request, the job stops watching the change. Proposed.
pub const MAX_NOT_FOUND_READS: u32 = 5;

/// Where a read of a pull request failed: getting the token for it, or reading with the token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadStage {
    Mint,
    Read,
}

/// What a failed read by the refresh job means for what's read next. A pull request that isn't there is no failure:
/// the provider answered, and only that answer counts towards giving up on a change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadFailure {
    /// The provider refused Podster itself: `401` or `403` at either stage, or `404` when asking for the token, which
    /// is the installation gone and says nothing about any pull request. A key, a permission or the installation: every
    /// change in the room would fail the same way, so the whole room's reads wait and no change is given up on.
    Credential,
    /// GitHub limited how fast Podster may call it (`crate::rate_limit`). It says nothing about the key, the
    /// installation or any pull request, so it's never `Credential` and never counts towards giving up on a change.
    /// The room's reads wait for the time GitHub gave, and nothing is recorded as a refusal.
    RateLimited,
    /// Anything else: no answer, an error, or an answer that couldn't be read. That change waits.
    Other,
}

/// `rate_limited` is whether the answer was a rate limit by `crate::rate_limit::rate_limit_wait_ms`, which is decided
/// before the status is looked at: a limit is a `403` or `429` too.
pub fn classify_read_failure(stage: ReadStage, status: u16, rate_limited: bool) -> ReadFailure {
    match (stage, status) {
        _ if rate_limited => ReadFailure::RateLimited,
        (_, 401 | 403) | (ReadStage::Mint, 404) => ReadFailure::Credential,
        _ => ReadFailure::Other,
    }
}

/// The reason code recorded when the room's reads wait because the provider refused Podster.
pub const CREDENTIAL_FAILED: &str = "provider_credential_failed";

/// How long to wait after a run of failed reads: a minute, doubling to an hour. Zero failures is no wait.
pub fn read_retry_wait_ms(consecutive_failures: u32) -> i64 {
    match consecutive_failures {
        0 => 0,
        failures => crate::provider_deliveries::poll_wait_ms(failures - 1),
    }
}

/// Whether a change that keeps answering "no such pull request" stops being watched.
pub fn stops_watching(consecutive_not_found: u32) -> bool {
    consecutive_not_found >= MAX_NOT_FOUND_READS
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
            base_ref: Some("main".to_string()),
            base_sha: sha("b2"),
            state: PullState::Open,
            draft: false,
            repo_default_branch: Some("main".to_string()),
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
            draft: Some(false),
            reviewed_commit_sha: reviewed,
            commit_changed_recorded: false,
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
                    base_ref: Some("release".to_string()),
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
            LinkRefusal::Draft,
        ]
        .into_iter()
        .map(LinkRefusal::code)
        .collect();
        assert_eq!(codes.len(), 7);
    }

    #[test]
    fn a_fork_is_refused_before_its_base_or_state_is_looked_at() {
        let pull = PullSeen {
            head_repo_id: Some(1),
            base_ref: Some("other".to_string()),
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
    fn a_head_off_the_reviewed_commit_is_recorded_once_and_stays_recorded_when_put_back() {
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
        // Once recorded, nothing records it again: not the same head, a further one, or the reviewed commit put back.
        let later = sha("d4");
        let recorded = Held {
            commit_changed_recorded: true,
            ..held(&later, Some(&reviewed))
        };
        assert!(!observe(&approved, &LINKED, &recorded, &moved).commit_changed);
        let further = PullSeen {
            head_sha: sha("e5"),
            ..seen()
        };
        assert!(!observe(&approved, &LINKED, &recorded, &further).commit_changed);
        let back = observe(&approved, &LINKED, &recorded, &seen());
        assert!(back.changed && !back.commit_changed);
        // A room that held the moved head without the record, as one upgraded mid-way would, still records it.
        assert!(observe(&approved, &LINKED, &held(&later, Some(&reviewed)), &moved).commit_changed);
    }

    #[test]
    fn a_draft_is_refused_after_everything_else_and_going_back_to_draft_is_a_change() {
        let draft = PullSeen {
            draft: true,
            ..seen()
        };
        assert_eq!(check_pull(&LINKED, 7, &draft), Err(LinkRefusal::Draft));
        let closed_draft = PullSeen {
            state: PullState::Closed,
            ..draft.clone()
        };
        assert_eq!(
            check_pull(&LINKED, 7, &closed_draft),
            Err(LinkRefusal::NotOpen)
        );
        let reviewed = sha("a1");
        let got = observe(
            &task(TaskStatus::Completed, true),
            &LINKED,
            &held(&reviewed, Some(&reviewed)),
            &draft,
        );
        assert!(got.changed && !got.commit_changed);
        assert_eq!(got.merge, None);
    }

    #[test]
    fn a_base_with_no_usable_name_is_never_the_default_branch() {
        let unnamed = PullSeen {
            base_ref: None,
            ..seen()
        };
        assert_eq!(
            check_pull(&LINKED, 7, &unnamed),
            Err(LinkRefusal::WrongBase)
        );
        let nameless = Linked {
            repo_id: REPO,
            default_branch: "",
        };
        let empty = PullSeen {
            base_ref: Some(String::new()),
            ..seen()
        };
        assert_eq!(
            check_pull(&nameless, 7, &empty),
            Err(LinkRefusal::WrongBase)
        );
    }

    #[test]
    fn failed_reads_wait_longer_each_time_and_a_missing_pull_request_stops_being_watched() {
        assert_eq!(read_retry_wait_ms(0), 0);
        assert_eq!(read_retry_wait_ms(1), 60_000);
        assert_eq!(read_retry_wait_ms(2), 120_000);
        assert_eq!(read_retry_wait_ms(7), 3_600_000);
        assert_eq!(read_retry_wait_ms(u32::MAX), 3_600_000);
        for stage in [ReadStage::Mint, ReadStage::Read] {
            for refused in [401, 403] {
                assert_eq!(
                    classify_read_failure(stage, refused, false),
                    ReadFailure::Credential
                );
            }
            for other in [0, 422, 429, 500, 502] {
                assert_eq!(
                    classify_read_failure(stage, other, false),
                    ReadFailure::Other,
                    "{other}"
                );
            }
        }
        // No token because the installation is gone is a credential problem. It never counts as a missing pull request.
        assert_eq!(
            classify_read_failure(ReadStage::Mint, 404, false),
            ReadFailure::Credential
        );
        assert_eq!(
            classify_read_failure(ReadStage::Read, 404, false),
            ReadFailure::Other
        );
        assert!(!stops_watching(MAX_NOT_FOUND_READS - 1));
        assert!(stops_watching(MAX_NOT_FOUND_READS));
    }

    #[test]
    fn a_rate_limit_is_never_a_refused_credential() {
        // A `403` or `429` that GitHub marked as a limit, at either stage, is its own outcome.
        for stage in [ReadStage::Mint, ReadStage::Read] {
            for status in [403, 429] {
                assert_eq!(
                    classify_read_failure(stage, status, true),
                    ReadFailure::RateLimited,
                    "{status}"
                );
            }
        }
        // The same statuses without the limit's signals are what they were.
        assert_eq!(
            classify_read_failure(ReadStage::Read, 403, false),
            ReadFailure::Credential
        );
        assert_eq!(
            classify_read_failure(ReadStage::Read, 429, false),
            ReadFailure::Other
        );
    }

    #[test]
    fn a_new_base_branch_a_fork_head_or_a_closed_state_is_a_change() {
        let head = sha("a1");
        for pull in [
            PullSeen {
                base_ref: Some("other".to_string()),
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
