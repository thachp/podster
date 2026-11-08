//! What a remote A2A agent's reported task state means for a Podster task: M3 step 5. No I/O.
//!
//! Design: [ADR 0007](../../../docs/adr/0007-a2a.md#outbound-offers-to-a-registered-endpoint), decisions 112, 117 and 123.
//! Podster offers a task to an agent's registered A2A endpoint, records the one remote task that endpoint answered with, and
//! reads that task's state back by polling. [`decide_remote`] turns one read into at most one effect, given what Podster has
//! recorded now. A2A state decides nothing on its own:
//!
//! - It never verifies. There's no approval among the effects, so a remote agent can't sign off its own work.
//! - Every command it returns still goes through `podster-policy` and [`crate::decide`] against current state, as the agent's
//!   own act, with the room's disconnect fence. This module only says which command to try.
//! - Nothing a remote agent wrote becomes a command or a reason. Decline and release carry fixed reasons from here, and a
//!   status message becomes at most a thread message, which is data.
//!
//! A read is ignored, and changes nothing, when it's late or repeated (its number isn't newer than the last applied), when
//! reading for the attempt has ended, when it's for a remote task Podster didn't record, or when the endpoint it was sent to
//! has since been re-pointed, deleted or switched off. Reading ends at a terminal remote state, a stale endpoint, or once the
//! task is no longer offered to or held by the agent.
//!
//! **Proposed** details, as in the ADR: the 256-byte limit on a remote task ID, and how a held response is shown.

use crate::{Task, TaskStatus};

/// The longest remote task ID Podster stores or logs (ADR 0007, proposed).
pub const MAX_REMOTE_TASK_ID_BYTES: usize = 256;

/// Whether a remote agent's task ID may be stored and logged: 1 to [`MAX_REMOTE_TASK_ID_BYTES`] bytes of printable ASCII
/// with no whitespace. Anything else counts as a failed send or read, so the API can rely on every stored ID passing this.
pub fn valid_remote_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_REMOTE_TASK_ID_BYTES
        && id.bytes().all(|b| b.is_ascii_graphic())
}

/// A remote task's state, as A2A 1.0 names it (`TASK_STATE_*`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteState {
    Submitted,
    Working,
    InputRequired,
    Completed,
    Rejected,
    Failed,
    Canceled,
    AuthRequired,
    /// `TASK_STATE_UNSPECIFIED`, a 0.3 name, or anything a later version adds. Ignored.
    Unknown,
}

impl RemoteState {
    pub const KNOWN: [RemoteState; 8] = [
        RemoteState::Submitted,
        RemoteState::Working,
        RemoteState::InputRequired,
        RemoteState::Completed,
        RemoteState::Rejected,
        RemoteState::Failed,
        RemoteState::Canceled,
        RemoteState::AuthRequired,
    ];

    /// The A2A 1.0 name.
    pub fn name(self) -> &'static str {
        match self {
            RemoteState::Submitted => "TASK_STATE_SUBMITTED",
            RemoteState::Working => "TASK_STATE_WORKING",
            RemoteState::InputRequired => "TASK_STATE_INPUT_REQUIRED",
            RemoteState::Completed => "TASK_STATE_COMPLETED",
            RemoteState::Rejected => "TASK_STATE_REJECTED",
            RemoteState::Failed => "TASK_STATE_FAILED",
            RemoteState::Canceled => "TASK_STATE_CANCELED",
            RemoteState::AuthRequired => "TASK_STATE_AUTH_REQUIRED",
            RemoteState::Unknown => "unknown",
        }
    }

    /// Reads an A2A 1.0 state name exactly. Anything else is `Unknown`, so a lower-case or 0.3 name isn't guessed at.
    pub fn from_name(name: &str) -> RemoteState {
        RemoteState::KNOWN
            .into_iter()
            .find(|state| state.name() == name)
            .unwrap_or(RemoteState::Unknown)
    }

    /// A terminal remote task takes no more messages (spec 3.1.1), so reading it ends.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RemoteState::Completed
                | RemoteState::Rejected
                | RemoteState::Failed
                | RemoteState::Canceled
        )
    }
}

/// The fixed reason recorded when a remote state declines an offer. It never quotes the remote agent.
pub const DECLINE_REASON: &str = "The agent's A2A endpoint reported that it won't do this task.";
/// The fixed reason recorded when a remote state gives back an accepted task.
pub const RELEASE_REASON: &str = "The agent's A2A endpoint reported that it stopped this task.";

/// What Podster recorded about one offer attempt to an agent's endpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Attempt<'a> {
    /// The agent the task was offered to.
    pub agent: &'a str,
    /// The endpoint URL and registration version the offer was sent to, pinned when it was sent.
    pub endpoint_url: &'a str,
    pub endpoint_version: u64,
    /// The one remote task the endpoint answered the offer with.
    pub remote_task_id: &'a str,
    /// Whether a read of this attempt has already reported `WORKING`.
    pub working_seen: bool,
    /// The number of the last read applied, or 0 if none.
    pub last_read_no: u32,
    /// Whether reading for this attempt has ended.
    pub ended: bool,
}

/// The agent's endpoint as registered now, if it has one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Endpoint<'a> {
    pub url: &'a str,
    pub version: u64,
    /// False once repeated failures switched it off.
    pub active: bool,
}

/// One read of the remote task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RemoteRead<'a> {
    /// Each read job's number, in the order they were queued.
    pub read_no: u32,
    /// The task ID the remote response named.
    pub remote_task_id: &'a str,
    pub state: RemoteState,
}

/// Why a read changed nothing. Safe to log: it carries no remote content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ignored {
    /// Its number isn't newer than the last read applied: a repeat or a late, out-of-order delivery.
    Stale,
    /// Reading for this attempt already ended.
    Ended,
    /// The endpoint was re-pointed, deleted or switched off since the offer was sent to it.
    EndpointChanged,
    /// The response named a remote task Podster didn't record, or an ID that fails [`valid_remote_task_id`].
    OtherRemoteTask,
    /// The task is no longer offered to or held by this agent: declined, released, reassigned, canceled or finished.
    NotTheAgents,
    /// A state that means nothing for the task as it stands, such as `SUBMITTED`, or `WORKING` once accepted.
    NoEffect,
    /// A state this version doesn't know.
    UnknownState,
}

/// The one effect a read has. Commands are the agent's own, each with the task version it was decided against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteEffect {
    Nothing(Ignored),
    /// `accept_task`: the endpoint reported `WORKING` for an offer (decision 112).
    Accept {
        version: u64,
    },
    /// `submit_task` with what the remote task returned. Never `verify_task`.
    Submit {
        version: u64,
    },
    /// `decline_task`, with [`DECLINE_REASON`].
    Decline {
        version: u64,
    },
    /// `release_task`, with [`RELEASE_REASON`]: `decline_task` only applies to an offer.
    Release {
        version: u64,
    },
    /// One thread message from the remote status message, marked external. It grants nothing, including for
    /// `AUTH_REQUIRED` (spec 7.6.4).
    Message,
    /// `COMPLETED` before Podster recorded an acceptance: held as an unaccepted response and flagged to the requester, not
    /// taken as acceptance (decision 112). `working_seen` says whether this attempt had reported `WORKING`.
    Hold {
        working_seen: bool,
    },
    /// The remote task was canceled. Recorded, and Podster's own task is unchanged.
    RecordCanceled,
}

/// What [`decide_remote`] decided for one read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RemoteDecision {
    pub effect: RemoteEffect,
    /// Whether reading for this attempt ends now.
    pub stop_reading: bool,
    /// The attempt's `working_seen` after this read.
    pub working_seen: bool,
    /// Whether to record this read's number as the last applied. False for an ignored read that wasn't newer.
    pub applied: bool,
}

fn ignored(attempt: &Attempt<'_>, why: Ignored, stop_reading: bool) -> RemoteDecision {
    RemoteDecision {
        effect: RemoteEffect::Nothing(why),
        stop_reading,
        working_seen: attempt.working_seen,
        applied: false,
    }
}

/// Where the task stands for the agent the attempt offered it to.
enum Stage {
    Offered,
    Accepted,
    /// Submitted and waiting for review, still the agent's.
    InReview,
}

fn stage(task: &Task, agent: &str) -> Option<Stage> {
    if task.assignee.as_deref() != Some(agent) {
        return None;
    }
    match task.status {
        TaskStatus::Offered => Some(Stage::Offered),
        TaskStatus::Accepted => Some(Stage::Accepted),
        TaskStatus::Submitted => Some(Stage::InReview),
        TaskStatus::Open | TaskStatus::Completed | TaskStatus::Canceled => None,
    }
}

/// Decides what one read of a remote task means. `task` is the Podster task as stored now, `attempt` what was recorded about
/// the offer, `endpoint` the agent's endpoint as registered now, and `read` what the remote reported.
pub fn decide_remote(
    task: &Task,
    attempt: &Attempt<'_>,
    endpoint: Option<&Endpoint<'_>>,
    read: &RemoteRead<'_>,
) -> RemoteDecision {
    if attempt.ended {
        return ignored(attempt, Ignored::Ended, true);
    }
    if read.read_no <= attempt.last_read_no {
        return ignored(attempt, Ignored::Stale, false);
    }
    let pinned = endpoint.is_some_and(|now| {
        now.active && now.url == attempt.endpoint_url && now.version == attempt.endpoint_version
    });
    if !pinned {
        return ignored(attempt, Ignored::EndpointChanged, true);
    }
    if !valid_remote_task_id(read.remote_task_id) || read.remote_task_id != attempt.remote_task_id {
        return ignored(attempt, Ignored::OtherRemoteTask, false);
    }
    let Some(stage) = stage(task, attempt.agent) else {
        return ignored(attempt, Ignored::NotTheAgents, true);
    };
    let working_seen = attempt.working_seen || read.state == RemoteState::Working;
    let version = task.version;
    let effect = match (read.state, stage) {
        (RemoteState::Unknown, _) => RemoteEffect::Nothing(Ignored::UnknownState),
        (RemoteState::Submitted, _) => RemoteEffect::Nothing(Ignored::NoEffect),
        (RemoteState::Working, Stage::Offered) => RemoteEffect::Accept { version },
        (RemoteState::Working, Stage::Accepted | Stage::InReview) => {
            RemoteEffect::Nothing(Ignored::NoEffect)
        }
        (RemoteState::InputRequired | RemoteState::AuthRequired, _) => RemoteEffect::Message,
        (RemoteState::Completed, Stage::Offered) => RemoteEffect::Hold {
            working_seen: attempt.working_seen,
        },
        (RemoteState::Completed, Stage::Accepted) => RemoteEffect::Submit { version },
        // Already delivered and waiting for review: a repeated completion submits nothing more.
        (RemoteState::Completed, Stage::InReview) => RemoteEffect::Nothing(Ignored::NoEffect),
        (RemoteState::Rejected | RemoteState::Failed, Stage::Offered) => {
            RemoteEffect::Decline { version }
        }
        (RemoteState::Rejected | RemoteState::Failed, Stage::Accepted) => {
            RemoteEffect::Release { version }
        }
        // A submitted task can't be released. Its reviewer decides it.
        (RemoteState::Rejected | RemoteState::Failed, Stage::InReview) => {
            RemoteEffect::Nothing(Ignored::NoEffect)
        }
        (RemoteState::Canceled, _) => RemoteEffect::RecordCanceled,
    };
    RemoteDecision {
        effect,
        stop_reading: read.state.is_terminal(),
        working_seen,
        applied: true,
    }
}
