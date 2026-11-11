//! A task's release status: its checks and its merge, each as Podster last observed it, with the time of that
//! observation (M5 step 8, ADR 0009, which is proposed). No I/O.
//!
//! A read of this never asks the provider anything. Checks are what the room's own refresh job last read for the pull
//! request's head, and a merge is what the merge job and the refresh job recorded. The two are reported apart: a check
//! can fail on a task whose merge succeeded, and a merge can fail on one whose checks pass. No release exists in M5.
//!
//! Only states and counts are kept of checks. A status's context, a check run's name and anything else its author
//! wrote are provider content, and never reach here.

use crate::repositories::MergeState;

/// What the head commit's commit statuses and check runs come to, together.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChecksState {
    /// At least one failed, errored, timed out, was cancelled or needs action.
    Failure,
    /// None failed, and at least one hasn't finished.
    Pending,
    /// At least one, and every one passed, was neutral or was skipped.
    Success,
    /// The commit has no status and no check run.
    None,
}

impl ChecksState {
    pub fn name(self) -> &'static str {
        match self {
            ChecksState::Failure => "failure",
            ChecksState::Pending => "pending",
            ChecksState::Success => "success",
            ChecksState::None => "none",
        }
    }

    pub fn from_name(name: &str) -> Option<ChecksState> {
        [
            ChecksState::Failure,
            ChecksState::Pending,
            ChecksState::Success,
            ChecksState::None,
        ]
        .into_iter()
        .find(|state| state.name() == name)
    }
}

/// How many of a commit's statuses and check runs are in each state. Counts only.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ChecksCounts {
    pub success: u32,
    pub failure: u32,
    pub pending: u32,
}

/// One commit status or check run, as the provider states it. `conclusion` is a check run's, once it has completed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CheckSeen<'a> {
    /// A commit status's `state`, or a check run's `status`.
    pub state: &'a str,
    pub conclusion: Option<&'a str>,
}

/// How one status or check run counts. Anything unrecognised is pending: an unknown word is never read as a pass.
fn class(seen: &CheckSeen) -> ChecksState {
    match (seen.state, seen.conclusion) {
        ("success", None) | ("completed", Some("success" | "neutral" | "skipped")) => {
            ChecksState::Success
        }
        ("failure" | "error", None)
        | (
            "completed",
            Some(
                "failure" | "timed_out" | "cancelled" | "action_required" | "startup_failure"
                | "stale",
            ),
        ) => ChecksState::Failure,
        _ => ChecksState::Pending,
    }
}

/// Sums up a commit's statuses and check runs. A failure anywhere is a failure; otherwise anything unfinished is
/// pending; otherwise, with at least one, success.
pub fn summarize_checks(seen: &[CheckSeen]) -> (ChecksState, ChecksCounts) {
    let mut counts = ChecksCounts::default();
    for one in seen {
        match class(one) {
            ChecksState::Success => counts.success = counts.success.saturating_add(1),
            ChecksState::Failure => counts.failure = counts.failure.saturating_add(1),
            ChecksState::Pending | ChecksState::None => {
                counts.pending = counts.pending.saturating_add(1)
            }
        }
    }
    let state = if counts.failure > 0 {
        ChecksState::Failure
    } else if counts.pending > 0 {
        ChecksState::Pending
    } else if counts.success > 0 {
        ChecksState::Success
    } else {
        ChecksState::None
    };
    (state, counts)
}

/// What the room holds of a task's change, for its release status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Held<'a> {
    pub checks_state: Option<&'a str>,
    pub checks_observed_at: Option<i64>,
    pub merge_state: Option<&'a str>,
    pub merge_reason: Option<&'a str>,
    /// When the last merge Podster was asked for ended, either way.
    pub merge_finished_at: Option<i64>,
    /// When a merge Podster didn't ask for was first seen.
    pub merge_observed_at: Option<i64>,
    pub merge_requested_at: Option<i64>,
}

/// A task's checks, as last observed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChecksReport {
    /// Podster hasn't read the head commit's checks. That says nothing about whether any exist or pass.
    Unobserved,
    Observed {
        state: ChecksState,
        at: i64,
    },
}

/// A task's merge, with the time of the observation that the state rests on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MergeReport<'a> {
    pub state: MergeState,
    pub reason: Option<&'a str>,
    /// When what the state says was recorded: the end of a requested merge, the sighting of one nobody asked for,
    /// or the request itself while it's under way. `None` when no merge was ever asked for or seen.
    pub observed_at: Option<i64>,
}

/// The two reports, apart. Neither is inferred from the other, and a state the room doesn't recognise is never read as
/// a pass or as merged.
pub fn report<'a>(held: Option<&Held<'a>>) -> (ChecksReport, MergeReport<'a>) {
    let Some(held) = held else {
        return (
            ChecksReport::Unobserved,
            MergeReport {
                state: MergeState::NotRequested,
                reason: None,
                observed_at: None,
            },
        );
    };
    let checks = match (
        held.checks_state.and_then(ChecksState::from_name),
        held.checks_observed_at,
    ) {
        (Some(state), Some(at)) => ChecksReport::Observed { state, at },
        _ => ChecksReport::Unobserved,
    };
    let state = held
        .merge_state
        .and_then(MergeState::from_name)
        .unwrap_or(MergeState::NotRequested);
    let observed_at = match state {
        MergeState::Succeeded | MergeState::Failed => held.merge_finished_at,
        MergeState::Requested | MergeState::OutcomeUnknown => held.merge_requested_at,
        MergeState::NotRequested => held.merge_observed_at,
    };
    (
        checks,
        MergeReport {
            state,
            reason: held.merge_reason,
            observed_at,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(state: &str) -> CheckSeen<'_> {
        CheckSeen {
            state,
            conclusion: None,
        }
    }

    fn run<'a>(state: &'a str, conclusion: Option<&'a str>) -> CheckSeen<'a> {
        CheckSeen { state, conclusion }
    }

    #[test]
    fn a_failure_anywhere_is_a_failure_then_anything_unfinished_is_pending() {
        assert_eq!(summarize_checks(&[]).0, ChecksState::None);
        let passing = [
            status("success"),
            run("completed", Some("success")),
            run("completed", Some("neutral")),
            run("completed", Some("skipped")),
        ];
        assert_eq!(
            summarize_checks(&passing),
            (
                ChecksState::Success,
                ChecksCounts {
                    success: 4,
                    failure: 0,
                    pending: 0
                }
            )
        );
        for unfinished in [
            status("pending"),
            run("queued", None),
            run("in_progress", None),
        ] {
            let mut all = passing.to_vec();
            all.push(unfinished);
            assert_eq!(
                summarize_checks(&all).0,
                ChecksState::Pending,
                "{unfinished:?}"
            );
        }
        for failed in [
            status("failure"),
            status("error"),
            run("completed", Some("failure")),
            run("completed", Some("timed_out")),
            run("completed", Some("cancelled")),
            run("completed", Some("action_required")),
            run("completed", Some("startup_failure")),
            run("completed", Some("stale")),
        ] {
            let all = [passing[0], status("pending"), failed];
            assert_eq!(summarize_checks(&all).0, ChecksState::Failure, "{failed:?}");
        }
    }

    #[test]
    fn a_word_nobody_knows_is_never_a_pass() {
        for odd in [
            status("SUCCESS"),
            status(""),
            status("passed"),
            run("completed", Some("great")),
            run("completed", None),
            run("success", Some("success")),
        ] {
            assert_eq!(summarize_checks(&[odd]).0, ChecksState::Pending, "{odd:?}");
        }
    }

    #[test]
    fn check_states_round_trip() {
        for state in [
            ChecksState::Failure,
            ChecksState::Pending,
            ChecksState::Success,
            ChecksState::None,
        ] {
            assert_eq!(ChecksState::from_name(state.name()), Some(state));
        }
        assert_eq!(ChecksState::from_name("passing"), None);
    }

    fn held<'a>() -> Held<'a> {
        Held {
            checks_state: Some("failure"),
            checks_observed_at: Some(50),
            merge_state: Some("succeeded"),
            merge_reason: None,
            merge_finished_at: Some(90),
            merge_observed_at: None,
            merge_requested_at: Some(80),
        }
    }

    #[test]
    fn checks_and_merge_are_reported_apart_each_with_its_own_time() {
        // A failed check on a merged task, and a failed merge on a passing one: neither changes the other.
        let (checks, merge) = report(Some(&held()));
        assert_eq!(
            checks,
            ChecksReport::Observed {
                state: ChecksState::Failure,
                at: 50
            }
        );
        assert_eq!(
            (merge.state, merge.reason, merge.observed_at),
            (MergeState::Succeeded, None, Some(90))
        );
        let failed = Held {
            checks_state: Some("success"),
            merge_state: Some("failed"),
            merge_reason: Some("commit_changed"),
            ..held()
        };
        let (checks, merge) = report(Some(&failed));
        assert_eq!(
            checks,
            ChecksReport::Observed {
                state: ChecksState::Success,
                at: 50
            }
        );
        assert_eq!(
            (merge.state, merge.reason, merge.observed_at),
            (MergeState::Failed, Some("commit_changed"), Some(90))
        );
    }

    #[test]
    fn nothing_observed_is_said_as_that_and_never_as_a_pass() {
        let (checks, merge) = report(None);
        assert_eq!(checks, ChecksReport::Unobserved);
        assert_eq!(
            (merge.state, merge.observed_at),
            (MergeState::NotRequested, None)
        );
        for unread in [
            Held {
                checks_state: None,
                ..held()
            },
            Held {
                checks_observed_at: None,
                ..held()
            },
            Held {
                checks_state: Some("passing"),
                ..held()
            },
        ] {
            assert_eq!(report(Some(&unread)).0, ChecksReport::Unobserved);
        }
        // A merge state the room doesn't recognise is not requested, never merged.
        let odd = Held {
            merge_state: Some("merged"),
            ..held()
        };
        assert_eq!(report(Some(&odd)).1.state, MergeState::NotRequested);
    }

    #[test]
    fn a_merges_time_is_of_what_its_state_says() {
        let at = |state: &'static str| {
            report(Some(&Held {
                merge_state: Some(state),
                merge_observed_at: Some(70),
                ..held()
            }))
            .1
            .observed_at
        };
        assert_eq!(at("requested"), Some(80));
        assert_eq!(at("outcome_unknown"), Some(80));
        assert_eq!(at("succeeded"), Some(90));
        assert_eq!(at("failed"), Some(90));
        // One nobody asked Podster for: when it was seen.
        assert_eq!(at("not_requested"), Some(70));
    }
}
