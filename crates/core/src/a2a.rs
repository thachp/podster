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
//! A read is ignored, and changes nothing, when:
//!
//! - it's late or repeated: its number isn't newer than the last applied;
//! - reading for the attempt has ended;
//! - it's for a remote task Podster didn't record, or names an invalid one;
//! - the endpoint it was sent to has since been re-pointed, deleted or switched off;
//! - the task is no longer on the offer this attempt was sent for. Each offer is its own, so after a decline and a new offer
//!   to the same agent, or a release and a new acceptance, an old attempt can't act on the new one.
//!
//! Reading ends at a terminal remote state, a stale endpoint, or once the task is no longer on the attempt's offer.
//!
//! This module has no clock. Decision 117's 7-day cutoff on reading, and the back-off between reads, are the API's
//! (step 13).
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
    /// The offer this attempt was sent for, as the API recorded it when the task was offered: a task creation or `assign`
    /// naming the agent. A later offer, even to the same agent, has another.
    pub offer: &'a str,
    /// The endpoint URL and registration version the offer was sent to, pinned when it was sent.
    pub endpoint_url: &'a str,
    pub endpoint_version: u64,
    /// The one remote task the endpoint answered the offer with.
    pub remote_task_id: &'a str,
    /// Whether a read of this attempt has already reported `WORKING`.
    pub working_seen: bool,
    /// The number of the last read applied, or 0 if none.
    pub last_read_no: u32,
    /// The state the last applied read reported, if any, so a repeated `INPUT_REQUIRED` or `AUTH_REQUIRED` posts once.
    pub last_state: Option<RemoteState>,
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
    /// The response named a valid remote task other than the one Podster recorded.
    ForeignRemoteTask,
    /// The response named an ID that fails [`valid_remote_task_id`]. The API counts it as a failed read toward the endpoint's
    /// three failures in a row.
    InvalidRemoteTask,
    /// The task is no longer on this attempt's offer: declined, released, reassigned, re-offered, canceled or finished.
    NotTheAgents,
    /// The same `INPUT_REQUIRED` or `AUTH_REQUIRED` as the last read applied, so its message was already posted.
    Unchanged,
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
    /// `REJECTED` or `FAILED` after the agent submitted. A submitted task can't be released, so this is only recorded, for the
    /// reviewer to see, and the review decides.
    RecordReportedFailure,
}

/// What [`decide_remote`] decided for one read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RemoteDecision {
    pub effect: RemoteEffect,
    /// Whether reading for this attempt ends now.
    pub stop_reading: bool,
    /// The attempt's `working_seen` after this read.
    pub working_seen: bool,
    /// Whether to record this read's number and state as the last applied. False whenever the read was ignored before its
    /// state was considered: stale, ended, a changed endpoint, another or invalid remote task, or not the attempt's offer.
    /// True otherwise, including `Unchanged`, `NoEffect` and unknown states.
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

fn stage(task: &Task, attempt: &Attempt<'_>, current_offer: Option<&str>) -> Option<Stage> {
    if task.assignee.as_deref() != Some(attempt.agent) || current_offer != Some(attempt.offer) {
        return None;
    }
    match task.status {
        TaskStatus::Offered => Some(Stage::Offered),
        TaskStatus::Accepted => Some(Stage::Accepted),
        TaskStatus::Submitted => Some(Stage::InReview),
        TaskStatus::Open | TaskStatus::Completed | TaskStatus::Canceled => None,
    }
}

/// Decides what one read of a remote task means. `task` is the Podster task as stored now, and `current_offer` the offer it's
/// on now, as the API recorded it, or `None` if it isn't on one. `attempt` is what was recorded about the offer this read
/// follows, `endpoint` the agent's endpoint as registered now, and `read` what the remote reported.
pub fn decide_remote(
    task: &Task,
    current_offer: Option<&str>,
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
    if !valid_remote_task_id(read.remote_task_id) {
        return ignored(attempt, Ignored::InvalidRemoteTask, false);
    }
    if read.remote_task_id != attempt.remote_task_id {
        return ignored(attempt, Ignored::ForeignRemoteTask, false);
    }
    let Some(stage) = stage(task, attempt, current_offer) else {
        return ignored(attempt, Ignored::NotTheAgents, true);
    };
    let repeated = attempt.last_state == Some(read.state);
    let working_seen = attempt.working_seen || read.state == RemoteState::Working;
    let version = task.version;
    let effect = match (read.state, stage) {
        (RemoteState::Unknown, _) => RemoteEffect::Nothing(Ignored::UnknownState),
        (RemoteState::Submitted, _) => RemoteEffect::Nothing(Ignored::NoEffect),
        (RemoteState::Working, Stage::Offered) => RemoteEffect::Accept { version },
        (RemoteState::Working, Stage::Accepted | Stage::InReview) => {
            RemoteEffect::Nothing(Ignored::NoEffect)
        }
        (RemoteState::InputRequired | RemoteState::AuthRequired, _) if repeated => {
            RemoteEffect::Nothing(Ignored::Unchanged)
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
        // A submitted task can't be released. Its reviewer decides it, and learns the agent reported failure.
        (RemoteState::Rejected | RemoteState::Failed, Stage::InReview) => {
            RemoteEffect::RecordReportedFailure
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

/// Inbound, M3 step 9 (ADR 0007): whether a message that arrives over A2A may be posted to a task in `status`. A2A's
/// terminal states take no more messages (spec 3.1.1), so once a task is completed or canceled, an A2A message is
/// refused. A message over MCP isn't affected. The gateway names where a message came from, and this rule only ever
/// refuses more, so a wrong label can't grant anything.
pub fn accepts_inbound_message(status: TaskStatus) -> bool {
    !status.is_terminal()
}

/// Outbound, M3 step 12 (ADR 0007, decision 118): where one offer attempt stands before its send.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptState {
    /// Waiting to be sent, or to be sent again after a failed try.
    Queued,
    /// The endpoint answered, so nothing more is sent for it.
    Sent,
    /// Ended without an answer: the offer moved on, or the agent or its endpoint can't be sent to.
    Stopped,
}

impl AttemptState {
    pub fn name(self) -> &'static str {
        match self {
            AttemptState::Queued => "queued",
            AttemptState::Sent => "sent",
            AttemptState::Stopped => "stopped",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "queued" => Some(AttemptState::Queued),
            "sent" => Some(AttemptState::Sent),
            "stopped" => Some(AttemptState::Stopped),
            _ => None,
        }
    }
}

/// Why an attempt sends nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoSend {
    /// It already got an answer. A redelivered job sends nothing (ADR 0007, duplicates).
    AlreadySent,
    /// It already ended.
    Ended,
    /// Another delivery of the same job is sending it now.
    Busy,
    /// The task is no longer offered to this agent on this attempt's offer: accepted, declined, reassigned, re-offered,
    /// canceled or finished. Ends the attempt.
    OfferMovedOn,
}

/// Whether an attempt may be sent now. `task` is the task as stored now and `current_offer` the offer it's on now, as the API
/// recorded it. `leased` says whether another delivery holds the attempt. Only an offered task, still on the attempt's own
/// offer to the attempt's own agent, sends, so a task that moved on while queued sends nothing.
pub fn may_send(
    task: &Task,
    current_offer: Option<&str>,
    agent: &str,
    offer: &str,
    state: AttemptState,
    leased: bool,
) -> Result<(), NoSend> {
    may_send_kind(
        AttemptKind::Offer,
        task,
        current_offer,
        agent,
        offer,
        state,
        leased,
    )
}

/// What an attempt sends (decision 114, M3 step 13b).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptKind {
    /// A task offered to the agent: sent while the task is offered to it.
    Offer,
    /// A change request on a submission the agent's endpoint completed: a new A2A task with `referenceTaskIds` and the same
    /// `contextId`, sent while the task is back with the agent on that change request.
    ChangeRequest,
}

impl AttemptKind {
    pub fn name(self) -> &'static str {
        match self {
            AttemptKind::Offer => "offer",
            AttemptKind::ChangeRequest => "change_request",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "offer" => Some(AttemptKind::Offer),
            "change_request" => Some(AttemptKind::ChangeRequest),
            _ => None,
        }
    }

    /// The task status an attempt of this kind is for. A change request sends the task back to the agent as accepted.
    pub fn status(self) -> TaskStatus {
        match self {
            AttemptKind::Offer => TaskStatus::Offered,
            AttemptKind::ChangeRequest => TaskStatus::Accepted,
        }
    }
}

/// [`may_send`] for either kind. `current` is the event the task is on now for that kind: its latest offer, or its latest
/// change request, as the API recorded it. An attempt sends only while the task is in that kind's status, with the attempt's
/// agent, on the attempt's own event, so a newer offer or change request, or anything else that moved the task, sends nothing.
#[allow(clippy::too_many_arguments)]
pub fn may_send_kind(
    kind: AttemptKind,
    task: &Task,
    current: Option<&str>,
    agent: &str,
    trigger: &str,
    state: AttemptState,
    leased: bool,
) -> Result<(), NoSend> {
    match state {
        AttemptState::Sent => return Err(NoSend::AlreadySent),
        AttemptState::Stopped => return Err(NoSend::Ended),
        AttemptState::Queued => {}
    }
    if task.status != kind.status()
        || task.assignee.as_deref() != Some(agent)
        || current != Some(trigger)
    {
        return Err(NoSend::OfferMovedOn);
    }
    if leased {
        return Err(NoSend::Busy);
    }
    Ok(())
}

/// The longest offer text sent, in bytes: decision 123's 16 KB per message.
pub const MAX_OFFER_TEXT_BYTES: usize = 16 * 1024;

/// The text an offer carries (decision 118): the title, instructions and acceptance criteria, read at send time, and a
/// Podster link. It's cut at a character boundary to [`MAX_OFFER_TEXT_BYTES`], keeping the link, which is short.
pub fn offer_text(
    title: &str,
    instructions: &str,
    criteria: Option<&str>,
    link: Option<&str>,
) -> String {
    offer_text_with_files(title, instructions, criteria, &[], None, link)
}

/// One input file an offer names (M3 step 14, decision 121): its name, its ID, and a Podster link that needs the agent's own
/// credential to open, or none when it can't be downloaded yet. Never bytes, and never a public URL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputFile<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub link: Option<&'a str>,
}

/// At most this much of an offer goes to its list of input files. Past it, the rest are counted, not listed.
pub const MAX_FILES_SECTION_BYTES: usize = 4 * 1024;

/// The longest file name an offer shows, in characters. Longer ones are cut, with an ellipsis.
pub const MAX_OFFER_FILE_NAME_CHARS: usize = 120;

/// A file name as an offer shows it: the uploader's text, kept to one plain line. Control characters, line and paragraph
/// separators and bidi controls become spaces, a double quote becomes a single one so the name can't close its quotes, and
/// it's cut to [`MAX_OFFER_FILE_NAME_CHARS`].
pub fn offer_file_name(name: &str) -> String {
    let hidden = |c: char| {
        c.is_control()
            || matches!(c, '\u{2028}' | '\u{2029}' | '\u{0085}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
    };
    let clean: String = name
        .chars()
        .map(|c| {
            if hidden(c) {
                ' '
            } else if c == '"' {
                '\''
            } else {
                c
            }
        })
        .collect();
    if clean.chars().count() > MAX_OFFER_FILE_NAME_CHARS {
        clean
            .chars()
            .take(MAX_OFFER_FILE_NAME_CHARS - 1)
            .chain(['…'])
            .collect()
    } else {
        clean
    }
}

/// The input-file list. Each line puts Podster's link first and the name after it, in quotes, so a name can't pose as the
/// link. `host` is where the links are, the only place the agent should send its credential. The links are under the A2A
/// resource, `/a2a/files/...`, so the token they take is the agent's `/a2a` token, the one it reached Podster's A2A server
/// with. An `/mcp` token doesn't work there, as an `/a2a` token doesn't at `/v1/files` (ADR 0007, audiences).
fn files_section(files: &[InputFile<'_>], host: Option<&str>) -> String {
    if files.is_empty() {
        return String::new();
    }
    let at = host.map_or("the Podster gateway".to_string(), |host| host.to_string());
    let mut section = format!(
        "\n\n## Input files\n\nDownload each link with your Podster OAuth token for /a2a, as `Authorization: Bearer`. \
         Send it only to {at}.\n"
    );
    let mut listed = 0;
    for file in files {
        let name = offer_file_name(file.name);
        let line = match file.link {
            Some(link) => format!("\n- {link} \"{name}\" ({})", file.id),
            None => format!("\n- not ready yet: \"{name}\" ({})", file.id),
        };
        if section.len() + line.len() > MAX_FILES_SECTION_BYTES {
            break;
        }
        section.push_str(&line);
        listed += 1;
    }
    if listed < files.len() {
        section.push_str(&format!(
            "\n- and {} more, listed on the task",
            files.len() - listed
        ));
    }
    section
}

/// [`offer_text`] with the task's input files listed after the task's own text. The list and the link are kept whole, and
/// only the task's text is cut to fit.
pub fn offer_text_with_files(
    title: &str,
    instructions: &str,
    criteria: Option<&str>,
    files: &[InputFile<'_>],
    files_host: Option<&str>,
    link: Option<&str>,
) -> String {
    let mut body = format!("# {title}\n\n{instructions}");
    if let Some(criteria) = criteria.filter(|c| !c.trim().is_empty()) {
        body.push_str("\n\n## Acceptance criteria\n\n");
        body.push_str(criteria);
    }
    let tail = files_section(files, files_host)
        + &link
            .map(|link| format!("\n\nOn Podster: {link}"))
            .unwrap_or_default();
    let room = MAX_OFFER_TEXT_BYTES.saturating_sub(tail.len());
    if body.len() > room {
        let mut cut = room;
        while !body.is_char_boundary(cut) {
            cut -= 1;
        }
        body.truncate(cut);
    }
    body + &tail
}

/// M3 step 13 (decision 117): how long after each read the next one waits. It backs off from 1 minute to 1 hour, and stays at
/// an hour.
pub const READ_DELAYS_MINUTES: [i64; 7] = [1, 2, 4, 8, 16, 32, 60];
/// How long an attempt is read for after its send: 7 days.
pub const READ_FOR_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// The wait before read `next`, in milliseconds. Read 1 waits a minute after the send, and from read 7 on it's an hour.
pub fn read_delay_ms(next: u32) -> i64 {
    let at = next.max(1) as usize - 1;
    let minutes = READ_DELAYS_MINUTES
        .get(at)
        .or(READ_DELAYS_MINUTES.last())
        .copied()
        .unwrap_or(60);
    minutes * 60 * 1000
}

/// Whether another read is due to be queued: reading hasn't ended, and the 7 days aren't over. Once they are, reading ends.
pub fn reading_open(now: i64, read_until: i64, ended: bool) -> bool {
    !ended && now < read_until
}

/// Decision 123's caps on what a remote agent sends back. Past any of them, the whole answer is refused as a failed read, never
/// cut. What's kept is data: a status message becomes a thread message and artifacts become a submission's note and links,
/// each still checked by policy and `decide` as the agent's own command.
pub const MAX_REMOTE_PARTS: usize = 8;
pub const MAX_REMOTE_ARTIFACTS: usize = crate::MAX_ARTIFACTS;
pub const MAX_REMOTE_TEXT_BYTES: usize = 16 * 1024;

/// The text a change request carries (decision 114): which task, which submission it's about, the reviewer's reason, and the
/// Podster link. The reason is the reviewer's own words, read at send time, and is cut to fit like an offer's text.
pub fn change_request_text(
    title: &str,
    submission_no: u32,
    reason: &str,
    link: Option<&str>,
) -> String {
    offer_text_with_files(
        &format!("Changes requested: {title}"),
        &format!("The reviewer asked for changes to submission {submission_no}:\n\n{reason}"),
        None,
        &[],
        None,
        link,
    )
}
