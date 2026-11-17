//! A task's release status: its checks and its merge, each as Podster last observed it, with the time of that
//! observation (M5 step 8, ADR 0009, which is proposed). No I/O.
//!
//! A read of this never asks the provider anything. Checks are what the room's own refresh job last read for the pull
//! request's head, and a merge is what the merge job and the refresh job recorded. The two are reported apart: a check
//! can fail on a task whose merge succeeded, and a merge can fail on one whose checks pass. M5 had no releases.
//!
//! Only states and counts are kept of checks. A status's context, a check run's name and anything else its author
//! wrote are provider content, and never reach here.
//!
//! M6 step 7 adds the release beside them: the latest attempt to release the task's merged commit, in the room's own
//! state, and whether that commit is served. Served is never inferred from `live`: only the marker coming back through
//! the host records a release `served`, and the host must still be set to it with nothing keeping it dark.

use crate::release::ReleaseState;
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

// ---------------------------------------------------------------------------------------------------------------------
// The release (M6 step 7, ADR 0010)
// ---------------------------------------------------------------------------------------------------------------------

/// A release's state as a task's release status says it. The room's own states but one: the room's `live` (switched,
/// its marker not yet back) is `awaiting_confirmation`, so the word `live` is never said of a release at all. Whether
/// the app is live is `served` alone, with its address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseStatusState {
    AwaitingApproval,
    Queued,
    Uploading,
    Uncertain,
    AwaitingConfirmation,
    Served,
    Replaced,
    Unpublished,
    Declined,
    Failed,
}

impl ReleaseStatusState {
    pub fn name(self) -> &'static str {
        match self {
            ReleaseStatusState::AwaitingApproval => "awaiting_approval",
            ReleaseStatusState::Queued => "queued",
            ReleaseStatusState::Uploading => "uploading",
            ReleaseStatusState::Uncertain => "uncertain",
            ReleaseStatusState::AwaitingConfirmation => "awaiting_confirmation",
            ReleaseStatusState::Served => "served",
            ReleaseStatusState::Replaced => "replaced",
            ReleaseStatusState::Unpublished => "unpublished",
            ReleaseStatusState::Declined => "declined",
            ReleaseStatusState::Failed => "failed",
        }
    }

    pub const ALL: [ReleaseStatusState; 10] = [
        ReleaseStatusState::AwaitingApproval,
        ReleaseStatusState::Queued,
        ReleaseStatusState::Uploading,
        ReleaseStatusState::Uncertain,
        ReleaseStatusState::AwaitingConfirmation,
        ReleaseStatusState::Served,
        ReleaseStatusState::Replaced,
        ReleaseStatusState::Unpublished,
        ReleaseStatusState::Declined,
        ReleaseStatusState::Failed,
    ];

    /// The room's state, as the status says it.
    pub fn of(state: ReleaseState) -> ReleaseStatusState {
        match state {
            ReleaseState::AwaitingApproval => ReleaseStatusState::AwaitingApproval,
            ReleaseState::Queued => ReleaseStatusState::Queued,
            ReleaseState::Uploading => ReleaseStatusState::Uploading,
            ReleaseState::Uncertain => ReleaseStatusState::Uncertain,
            ReleaseState::Live => ReleaseStatusState::AwaitingConfirmation,
            ReleaseState::Served => ReleaseStatusState::Served,
            ReleaseState::Replaced => ReleaseStatusState::Replaced,
            ReleaseState::Unpublished => ReleaseStatusState::Unpublished,
            ReleaseState::Declined => ReleaseStatusState::Declined,
            ReleaseState::Failed => ReleaseStatusState::Failed,
        }
    }
}

/// A release's state by its stored name: exactly one of the room's states, or nothing.
pub fn release_state_from_name(name: &str) -> Option<ReleaseState> {
    ReleaseState::ALL
        .into_iter()
        .find(|state| state.name() == name)
}

/// One attempt to release the task's commit, as the room holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AttemptHeld<'a> {
    pub id: &'a str,
    pub state: &'a str,
    /// The script it serves, its own or, for a rollback, an earlier release's.
    pub script_name: Option<&'a str>,
    /// When the room recorded the state it is in.
    pub recorded_at: i64,
    pub failure_code: Option<&'a str>,
}

/// The stop for the whole content domain, as asked for this read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopSeen {
    Clear,
    Stopped,
    /// Not asked, or no answer that says either. Read as stopped.
    Unread,
}

/// What the room's default host serves now, and whatever keeps every host serving nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostHeld<'a> {
    /// The script the room's default host is set to serve.
    pub default_script: Option<&'a str>,
    /// The app is held because nobody who may release remains.
    pub held: bool,
    /// An operator suspended the app.
    pub app_suspended: bool,
    /// The room is public now. Only a public room's app is served, so a room made private serves nothing, whether or
    /// not its unpublish has run yet.
    pub room_public: bool,
    pub stop: StopSeen,
}

/// The release part of a task's release status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseReport<'a> {
    /// Release is switched off for the deployment or the room, or nothing was asked for this commit.
    NoRelease,
    /// The latest attempt for the commit, in the room's own state as the status says it, with the time the room
    /// recorded it.
    Attempt {
        id: &'a str,
        state: ReleaseStatusState,
        observed_at: i64,
        /// Only for a failed attempt.
        failure_code: Option<&'a str>,
        /// The commit is what the room's default host serves: an attempt for it is `served`, which only its marker
        /// coming back through the host records, the host is still set to its script, and nothing keeps the host
        /// serving nothing. Never inferred from `live`, which is switched with its marker not yet back.
        served: bool,
    },
}

/// A stored release state the room doesn't recognise. The read is refused rather than guessed at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnknownReleaseState;

/// The release beside checks and merge, for the task's merged commit. `attempts` are that commit's releases in the
/// order they were asked for. Switched off, nothing is read and there is no release, as before M6.
pub fn release_report<'a>(
    switched_on: bool,
    attempts: &[AttemptHeld<'a>],
    host: &HostHeld,
) -> Result<ReleaseReport<'a>, UnknownReleaseState> {
    if !switched_on {
        return Ok(ReleaseReport::NoRelease);
    }
    let mut states = Vec::with_capacity(attempts.len());
    for attempt in attempts {
        states.push(release_state_from_name(attempt.state).ok_or(UnknownReleaseState)?);
    }
    let Some((latest, &state)) = attempts.last().zip(states.last()) else {
        return Ok(ReleaseReport::NoRelease);
    };
    let hosts_serve =
        host.room_public && !host.held && !host.app_suspended && host.stop == StopSeen::Clear;
    let served = hosts_serve
        && attempts.iter().zip(&states).any(|(attempt, &state)| {
            state == ReleaseState::Served
                && attempt.script_name.is_some()
                && attempt.script_name == host.default_script
        });
    Ok(ReleaseReport::Attempt {
        id: latest.id,
        state: ReleaseStatusState::of(state),
        observed_at: latest.recorded_at,
        failure_code: latest
            .failure_code
            .filter(|_| state == ReleaseState::Failed),
        served,
    })
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
