//! Podster's command decisions: pure Rust with no I/O.
//!
//! Each command is checked against the current task and yields the next task plus the events to record. The
//! Workspace Durable Object commits both, with outbox and idempotency rows, in one transaction. Who may issue a
//! command is decided by `podster-policy`, before this runs.

use std::collections::{BTreeMap, BTreeSet};

pub mod a2a;
pub mod asset_links;
pub mod baseline;
pub mod expected_outputs;
pub mod files;
pub mod public_claims;
pub mod removal;
pub mod submission_files;

pub const MAX_ARTIFACTS: usize = 10;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
pub const MAX_TITLE_BYTES: usize = 500;
pub const MAX_INSTRUCTIONS_BYTES: usize = 64 * 1024;
pub const MAX_CRITERIA_BYTES: usize = 16 * 1024;
pub const MAX_REASON_BYTES: usize = 4 * 1024;
pub const MAX_NOTE_BYTES: usize = 16 * 1024;
pub const MAX_URI_BYTES: usize = 2 * 1024;
pub const MAX_LABEL_BYTES: usize = 256;
pub const MAX_REFERENCE_BYTES: usize = 128;
pub const MAX_GOAL_BYTES: usize = 2 * 1024;
pub const MAX_CONTEXT_BYTES: usize = 32 * 1024;
pub const MAX_ROLE_TITLE_BYTES: usize = 200;
pub const MAX_RESPONSIBILITIES_BYTES: usize = 4 * 1024;
pub const MAX_ROLE_CAPACITY: i64 = 50;
pub const MAX_PLANNED_LABEL_BYTES: usize = 200;
pub const MAX_PLANNED_RELATIONSHIPS: i64 = 100;
pub const MAX_TASK_DURATION_DAYS: i64 = 260;
pub const MAX_PREDECESSORS_PER_TASK: usize = 50;
pub const MAX_PLAN_EDGES: i64 = 5_000;
/// How many edges the cycle check walks back through before refusing. Canceling and finishing free `MAX_PLAN_EDGES`, so a long
/// chain of finished work can pass that, and a limit as low as that would leave it impossible to extend. It holds up the
/// room while it runs, at about 4 ms per 1,000 edges measured locally, so this is about 100 ms.
pub const MAX_PLAN_WALK_EDGES: i64 = 25_000;
/// Over this many tasks, a plan read says it isn't complete, and there's no forecast from it.
pub const MAX_PLAN_TASKS: i64 = 3_000;

pub type PrincipalId = String;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TaskStatus {
    Open,
    Offered,
    Accepted,
    Submitted,
    Completed,
    Canceled,
}

impl TaskStatus {
    pub const ALL: [TaskStatus; 6] = [
        TaskStatus::Open,
        TaskStatus::Offered,
        TaskStatus::Accepted,
        TaskStatus::Submitted,
        TaskStatus::Completed,
        TaskStatus::Canceled,
    ];

    /// The status name in the API and storage.
    pub fn name(self) -> &'static str {
        match self {
            TaskStatus::Open => "open",
            TaskStatus::Offered => "offered",
            TaskStatus::Accepted => "accepted",
            TaskStatus::Submitted => "submitted",
            TaskStatus::Completed => "completed",
            TaskStatus::Canceled => "canceled",
        }
    }

    pub fn from_name(name: &str) -> Option<TaskStatus> {
        TaskStatus::ALL.into_iter().find(|s| s.name() == name)
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, TaskStatus::Completed | TaskStatus::Canceled)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub instructions: String,
    pub acceptance_criteria: Option<String>,
    pub requester: PrincipalId,
    pub assignee: Option<PrincipalId>,
    pub reviewer: PrincipalId,
    pub status: TaskStatus,
    pub version: u64,
    pub due_at: Option<i64>,
    pub follow_up_of: Option<String>,
    pub has_linked_repository: bool,
    /// The latest submission's number, or 0 if none.
    pub submission_no: u32,
    pub submission_commit: Option<String>,
    /// The submission a reviewer approved, set only by `Verify`. A completed task can't be submitted to again, so it can't move.
    pub approved_submission_no: Option<u32>,
    /// How many stored files the latest submission names. `Verify` refuses a submission with files unless the room proves
    /// it checked them, so a caller that skips the check fails closed.
    pub submission_files: u32,
    /// Set when an assignee leaves after submitting, so a change request reopens the task.
    pub assignee_departed: bool,
    /// Set when a departed reviewer has no eligible fallback, until `set_reviewer` runs.
    pub needs_reviewer: bool,
    /// Set when the requester departs, until `set_requester` runs.
    pub needs_requester: bool,
}

impl Task {
    /// Whether a departure left this task needing an owner, admin or lead.
    pub fn needs_attention(&self) -> bool {
        self.needs_reviewer || self.needs_requester
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewTask {
    pub id: String,
    pub title: String,
    pub instructions: String,
    pub acceptance_criteria: Option<String>,
    pub assignee: Option<PrincipalId>,
    pub reviewer: Option<PrincipalId>,
    pub due_at: Option<i64>,
    pub follow_up_of: Option<String>,
    pub has_linked_repository: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub instructions: Option<String>,
    pub acceptance_criteria: Option<String>,
    pub due_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Update {
        version: u64,
        patch: TaskPatch,
    },
    SetReviewer {
        version: u64,
        reviewer: PrincipalId,
    },
    SetRequester {
        version: u64,
        requester: PrincipalId,
    },
    Assign {
        version: u64,
        assignee: PrincipalId,
    },
    Accept {
        version: u64,
    },
    Decline {
        version: u64,
        reason: String,
    },
    Release {
        version: u64,
        reason: String,
    },
    Submit {
        version: u64,
        artifacts: Vec<Artifact>,
        note: Option<String>,
        commit_sha: Option<String>,
    },
    RequestChanges {
        submission_no: u32,
        reason: String,
    },
    Verify {
        submission_no: u32,
        commit_sha: Option<String>,
    },
    Cancel {
        version: u64,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artifact {
    pub uri: String,
    pub label: String,
}

/// State observed outside the task, such as a pull request's latest head, or the room's files.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Observed {
    pub head_sha: Option<String>,
    /// For `Submit`: how many stored files the submission names, already checked by `submission_files::pin_submission_files`.
    /// They count toward the same limit as links, and a submission of files alone needs no link or note.
    pub submission_files: usize,
    /// For `Verify`: proof that `submission_files::check_approval` passed for this submission's files. Only that function
    /// makes one, and a submission with files can't be approved without it.
    pub approved_files: Option<submission_files::ApprovedFiles>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    TaskCreated,
    TaskOffered,
    TaskReassigned,
    TaskUpdated,
    TaskReviewerChanged,
    TaskRequesterChanged,
    TaskAccepted,
    TaskDeclined,
    TaskReleased,
    TaskSubmitted,
    TaskChangesRequested,
    TaskCompleted,
    TaskCanceled,
    TaskAssigneeDeparted,
    TaskNeedsAttention,
}

impl EventKind {
    /// The event name in the API and inbox.
    pub fn name(self) -> &'static str {
        match self {
            EventKind::TaskCreated => "task.created",
            EventKind::TaskOffered => "task.offered",
            EventKind::TaskReassigned => "task.reassigned",
            EventKind::TaskUpdated => "task.updated",
            EventKind::TaskReviewerChanged => "task.reviewer_changed",
            EventKind::TaskRequesterChanged => "task.requester_changed",
            EventKind::TaskAccepted => "task.accepted",
            EventKind::TaskDeclined => "task.declined",
            EventKind::TaskReleased => "task.released",
            EventKind::TaskSubmitted => "task.submitted",
            EventKind::TaskChangesRequested => "task.changes_requested",
            EventKind::TaskCompleted => "task.completed",
            EventKind::TaskCanceled => "task.canceled",
            EventKind::TaskAssigneeDeparted => "task.assignee_departed",
            EventKind::TaskNeedsAttention => "task.needs_attention",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventDraft {
    pub kind: EventKind,
    /// Who gets an inbox event, without the actor.
    pub recipients: BTreeSet<PrincipalId>,
    /// The stated reason, for transitions that require one.
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub task: Task,
    pub events: Vec<EventDraft>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoreError {
    /// `invalid_transition`
    InvalidTransition,
    /// `version_conflict`
    VersionConflict,
    /// `commit_changed`
    CommitChanged,
    /// `submission_mismatch`
    SubmissionMismatch,
    /// `self_sign_off`
    SelfSignOff,
    /// `not_allowed`
    NotAllowed,
    /// `invalid_argument`
    InvalidArgument(&'static str),
    /// `files_not_checked`: `Verify` on a submission with files, without proof they were checked. A bug in the caller, never
    /// something a client can cause.
    FilesNotChecked,
}

impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::InvalidTransition => "invalid_transition",
            CoreError::VersionConflict => "version_conflict",
            CoreError::CommitChanged => "commit_changed",
            CoreError::SubmissionMismatch => "submission_mismatch",
            CoreError::SelfSignOff => "self_sign_off",
            CoreError::NotAllowed => "not_allowed",
            CoreError::InvalidArgument(_) => "invalid_argument",
            CoreError::FilesNotChecked => "files_not_checked",
        }
    }
}

fn require_text(value: &str, field: &'static str, max_bytes: usize) -> Result<(), CoreError> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(CoreError::InvalidArgument(field));
    }
    Ok(())
}

fn require_version(task: &Task, version: u64) -> Result<(), CoreError> {
    if task.version != version {
        return Err(CoreError::VersionConflict);
    }
    Ok(())
}

fn require_status(task: &Task, allowed: &[TaskStatus]) -> Result<(), CoreError> {
    if !allowed.contains(&task.status) {
        return Err(CoreError::InvalidTransition);
    }
    Ok(())
}

fn require_non_terminal(task: &Task) -> Result<(), CoreError> {
    if task.status.is_terminal() {
        return Err(CoreError::InvalidTransition);
    }
    Ok(())
}

fn event<'a>(
    kind: EventKind,
    actor: &str,
    recipients: impl IntoIterator<Item = &'a PrincipalId>,
) -> EventDraft {
    let recipients = recipients
        .into_iter()
        .filter(|p| p.as_str() != actor)
        .cloned()
        .collect();
    EventDraft {
        kind,
        recipients,
        reason: None,
    }
}

/// A workroom's goal and context, which are optional. They're text for participants to read, and nothing acts on them.
pub fn validate_brief(goal: Option<&str>, context: Option<&str>) -> Result<(), CoreError> {
    let usable = |text: &str, max: usize| !text.trim().is_empty() && text.len() <= max;
    if goal.is_some_and(|g| !usable(g, MAX_GOAL_BYTES)) {
        return Err(CoreError::InvalidArgument("goal"));
    }
    if context.is_some_and(|c| !usable(c, MAX_CONTEXT_BYTES)) {
        return Err(CoreError::InvalidArgument("context"));
    }
    Ok(())
}

/// A work role's text and number of openings.
pub fn validate_role(title: &str, responsibilities: &str, capacity: i64) -> Result<(), CoreError> {
    require_text(title, "title", MAX_ROLE_TITLE_BYTES)?;
    require_text(
        responsibilities,
        "responsibilities",
        MAX_RESPONSIBILITIES_BYTES,
    )?;
    if !(1..=MAX_ROLE_CAPACITY).contains(&capacity) {
        return Err(CoreError::InvalidArgument("capacity"));
    }
    Ok(())
}

/// A planned line between two work roles: from one to another, with words to say what flows along it.
pub fn validate_planned_relationship(
    from_role: &str,
    to_role: &str,
    label: &str,
) -> Result<(), CoreError> {
    if from_role == to_role {
        return Err(CoreError::InvalidArgument("to_role_id"));
    }
    require_text(label, "label", MAX_PLANNED_LABEL_BYTES)
}

/// A task's plan: a duration in whole working days, where none means Not estimated and there's no zero, and the tasks that
/// come first.
pub fn validate_task_plan(
    successor: &str,
    duration_days: Option<i64>,
    predecessors: &[String],
) -> Result<(), CoreError> {
    if duration_days.is_some_and(|days| !(1..=MAX_TASK_DURATION_DAYS).contains(&days)) {
        return Err(CoreError::InvalidArgument("duration_days"));
    }
    if predecessors.len() > MAX_PREDECESSORS_PER_TASK {
        return Err(CoreError::InvalidArgument("predecessors"));
    }
    let unique: BTreeSet<&str> = predecessors.iter().map(String::as_str).collect();
    if unique.len() != predecessors.len() || unique.contains(successor) {
        return Err(CoreError::InvalidArgument("predecessors"));
    }
    Ok(())
}

/// What an edit would do to a task's stored plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlanChange {
    pub adds_predecessors: bool,
    pub changes_duration: bool,
    /// Every predecessor it removes is canceled.
    pub removes_only_canceled: bool,
}

/// A plan belongs to its successor, so a finished task's plan no longer changes, though a `Submitted` one's can. The one
/// exception is removing a canceled predecessor, because that edge withholds a finish until someone does.
pub fn plan_change_allowed(status: TaskStatus, change: PlanChange) -> Result<(), CoreError> {
    let only_removes_canceled =
        !change.adds_predecessors && !change.changes_duration && change.removes_only_canceled;
    if status.is_terminal() && !only_removes_canceled {
        return Err(CoreError::InvalidTransition);
    }
    Ok(())
}

/// Whether giving `successor` these predecessors would close a loop. `edges` are the room's other edges, as
/// `(predecessor, successor)`, and any it holds for `successor` itself are ignored, because those are being replaced.
pub fn plan_would_cycle(
    successor: &str,
    predecessors: &[String],
    edges: &[(String, String)],
) -> bool {
    let mut before: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (predecessor, task) in edges {
        if task != successor {
            before
                .entry(task.as_str())
                .or_default()
                .push(predecessor.as_str());
        }
    }
    let mut seen = BTreeSet::new();
    let mut waiting: Vec<&str> = predecessors.iter().map(String::as_str).collect();
    while let Some(task) = waiting.pop() {
        if task == successor {
            return true;
        }
        if seen.insert(task) {
            waiting.extend(before.get(task).into_iter().flatten().copied());
        }
    }
    false
}

/// What a room knows about someone asking to fill an opening.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaimState {
    pub holds_this: bool,
    pub holds_another: bool,
    pub invited: bool,
    pub filled: i64,
    pub capacity: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimOutcome {
    /// Asking again changes nothing and takes no second opening.
    AlreadyHeld,
    Claim,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimRefusal {
    NotInvited,
    Full,
    HoldsAnother,
}

/// Whether a claim goes ahead. In a private room an opening is claimed only by invitation, and the other checks don't run
/// first, so someone uninvited doesn't learn whether an opening is full.
pub fn decide_claim(state: &ClaimState) -> Result<ClaimOutcome, ClaimRefusal> {
    if state.holds_this {
        return Ok(ClaimOutcome::AlreadyHeld);
    }
    if !state.invited {
        return Err(ClaimRefusal::NotInvited);
    }
    if state.holds_another {
        return Err(ClaimRefusal::HoldsAnother);
    }
    if state.filled >= state.capacity {
        return Err(ClaimRefusal::Full);
    }
    Ok(ClaimOutcome::Claim)
}

/// A recorded offer, submission or change request between two participants, or a message in a thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandoffKind {
    Offer,
    Submission,
    ChangeRequest,
    Message,
}

impl HandoffKind {
    pub fn name(self) -> &'static str {
        match self {
            HandoffKind::Offer => "offer",
            HandoffKind::Submission => "submission",
            HandoffKind::ChangeRequest => "change_request",
            HandoffKind::Message => "message",
        }
    }
}

/// Who an event hands work to, if it's a handoff at all, read from the task as it stands right after the event. A
/// reassignment comes with an offer to the new assignee, and only tells the old one, so it isn't one by itself. Handing
/// something to yourself isn't a handoff, so a requester offering a task to itself draws no line.
pub fn handoff_of<'a>(
    kind: EventKind,
    actor: &str,
    task: &'a Task,
) -> Option<(HandoffKind, &'a str)> {
    let (handoff, to) = match kind {
        EventKind::TaskOffered => (HandoffKind::Offer, task.assignee.as_deref()?),
        EventKind::TaskSubmitted => (HandoffKind::Submission, task.reviewer.as_str()),
        EventKind::TaskChangesRequested => (HandoffKind::ChangeRequest, task.assignee.as_deref()?),
        _ => return None,
    };
    (to != actor).then_some((handoff, to))
}

/// Short references such as commit hashes and task IDs.
fn require_reference(value: &Option<String>, field: &'static str) -> Result<(), CoreError> {
    if value
        .as_ref()
        .is_some_and(|v| v.is_empty() || v.len() > MAX_REFERENCE_BYTES)
    {
        return Err(CoreError::InvalidArgument(field));
    }
    Ok(())
}

fn require_criteria(criteria: &Option<String>) -> Result<(), CoreError> {
    if criteria
        .as_ref()
        .is_some_and(|c| c.len() > MAX_CRITERIA_BYTES)
    {
        return Err(CoreError::InvalidArgument("acceptance_criteria"));
    }
    Ok(())
}

/// Artifact links must be HTTPS, because a dashboard will render them. Public, so links held from a remote A2A agent
/// are checked the same way before they're kept.
pub fn require_artifact(artifact: &Artifact) -> Result<(), CoreError> {
    let authority = artifact
        .uri
        .strip_prefix("https://")
        .map(|rest| rest.split(['/', '?', '#']).next().unwrap_or(""));
    let valid = authority.is_some_and(|host| !host.is_empty() && !host.contains('@'))
        && artifact.uri.len() <= MAX_URI_BYTES
        && !artifact
            .uri
            .chars()
            .any(|c| c.is_whitespace() || c.is_control());
    if !valid {
        return Err(CoreError::InvalidArgument("uri"));
    }
    require_label(&artifact.label)
}

/// A label on a link or a file: some text, at most `MAX_LABEL_BYTES`.
pub fn require_label(label: &str) -> Result<(), CoreError> {
    require_text(label, "label", MAX_LABEL_BYTES)
}

/// Decides `create_task`. The reviewer defaults to the requester and can never be the assignee.
pub fn decide_create(actor: &str, new: NewTask) -> Result<Decision, CoreError> {
    require_text(&new.title, "title", MAX_TITLE_BYTES)?;
    require_text(&new.instructions, "instructions", MAX_INSTRUCTIONS_BYTES)?;
    require_criteria(&new.acceptance_criteria)?;
    require_reference(&new.follow_up_of, "follow_up_of")?;
    let reviewer = new.reviewer.unwrap_or_else(|| actor.to_string());
    if new.assignee.as_deref() == Some(reviewer.as_str()) {
        return Err(CoreError::SelfSignOff);
    }
    let status = if new.assignee.is_some() {
        TaskStatus::Offered
    } else {
        TaskStatus::Open
    };
    let task = Task {
        id: new.id,
        title: new.title,
        instructions: new.instructions,
        acceptance_criteria: new.acceptance_criteria,
        requester: actor.to_string(),
        assignee: new.assignee,
        reviewer,
        status,
        version: 1,
        due_at: new.due_at,
        follow_up_of: new.follow_up_of,
        has_linked_repository: new.has_linked_repository,
        submission_no: 0,
        submission_commit: None,
        approved_submission_no: None,
        submission_files: 0,
        assignee_departed: false,
        needs_reviewer: false,
        needs_requester: false,
    };
    let events = match &task.assignee {
        Some(assignee) => vec![event(EventKind::TaskOffered, actor, [assignee])],
        None => vec![event(EventKind::TaskCreated, actor, [])],
    };
    Ok(Decision { task, events })
}

/// Decides any command on an existing task. Bumps `version` on every change.
pub fn decide(
    task: &Task,
    actor: &str,
    command: Command,
    observed: &Observed,
) -> Result<Decision, CoreError> {
    let mut next = task.clone();
    let reason = match &command {
        Command::Decline { reason, .. }
        | Command::Release { reason, .. }
        | Command::RequestChanges { reason, .. }
        | Command::Cancel { reason, .. } => Some(reason.clone()),
        _ => None,
    };
    let mut events = match command {
        Command::Update { version, patch } => {
            require_version(task, version)?;
            require_non_terminal(task)?;
            require_status(
                task,
                &[TaskStatus::Open, TaskStatus::Offered, TaskStatus::Accepted],
            )?;
            if patch == TaskPatch::default() {
                return Err(CoreError::InvalidArgument("patch"));
            }
            require_criteria(&patch.acceptance_criteria)?;
            if let Some(title) = &patch.title {
                require_text(title, "title", MAX_TITLE_BYTES)?;
            }
            if let Some(instructions) = &patch.instructions {
                require_text(instructions, "instructions", MAX_INSTRUCTIONS_BYTES)?;
            }
            let material = patch
                .instructions
                .as_ref()
                .is_some_and(|v| *v != task.instructions)
                || patch.acceptance_criteria.is_some()
                    && patch.acceptance_criteria != task.acceptance_criteria;
            if let Some(title) = patch.title {
                next.title = title;
            }
            if let Some(instructions) = patch.instructions {
                next.instructions = instructions;
            }
            if patch.acceptance_criteria.is_some() {
                next.acceptance_criteria = patch.acceptance_criteria;
            }
            if patch.due_at.is_some() {
                next.due_at = patch.due_at;
            }
            if material && task.status == TaskStatus::Accepted {
                next.status = TaskStatus::Offered;
                vec![event(EventKind::TaskOffered, actor, &task.assignee)]
            } else {
                vec![event(
                    EventKind::TaskUpdated,
                    actor,
                    task.assignee.iter().chain([&task.reviewer]),
                )]
            }
        }
        Command::SetReviewer { version, reviewer } => {
            require_version(task, version)?;
            require_non_terminal(task)?;
            if task.assignee.as_deref() == Some(reviewer.as_str()) {
                return Err(CoreError::SelfSignOff);
            }
            next.reviewer = reviewer;
            next.needs_reviewer = false;
            vec![event(
                EventKind::TaskReviewerChanged,
                actor,
                [&next.reviewer],
            )]
        }
        Command::SetRequester { version, requester } => {
            require_version(task, version)?;
            require_non_terminal(task)?;
            next.requester = requester;
            next.needs_requester = false;
            vec![event(
                EventKind::TaskRequesterChanged,
                actor,
                [&next.requester],
            )]
        }
        Command::Assign { version, assignee } => {
            require_version(task, version)?;
            require_status(task, &[TaskStatus::Open, TaskStatus::Offered])?;
            if assignee == task.reviewer {
                return Err(CoreError::SelfSignOff);
            }
            if assignee == actor && actor != task.requester {
                return Err(CoreError::NotAllowed);
            }
            if task.assignee.as_deref() == Some(assignee.as_str()) {
                return Err(CoreError::InvalidTransition);
            }
            next.status = TaskStatus::Offered;
            next.assignee = Some(assignee);
            let mut drafts = vec![event(EventKind::TaskOffered, actor, &next.assignee)];
            if task.assignee.is_some() {
                drafts.push(event(EventKind::TaskReassigned, actor, &task.assignee));
            }
            drafts
        }
        Command::Accept { version } => {
            require_version(task, version)?;
            require_status(task, &[TaskStatus::Offered])?;
            next.status = TaskStatus::Accepted;
            vec![event(
                EventKind::TaskAccepted,
                actor,
                [&task.requester, &task.reviewer],
            )]
        }
        Command::Decline { version, reason } => {
            require_version(task, version)?;
            require_status(task, &[TaskStatus::Offered])?;
            require_text(&reason, "reason", MAX_REASON_BYTES)?;
            next.status = TaskStatus::Open;
            next.assignee = None;
            vec![event(EventKind::TaskDeclined, actor, [&task.requester])]
        }
        Command::Release { version, reason } => {
            require_version(task, version)?;
            require_status(task, &[TaskStatus::Accepted])?;
            require_text(&reason, "reason", MAX_REASON_BYTES)?;
            next.status = TaskStatus::Open;
            next.assignee = None;
            vec![event(EventKind::TaskReleased, actor, [&task.requester])]
        }
        Command::Submit {
            version,
            artifacts,
            note,
            commit_sha,
        } => {
            require_version(task, version)?;
            require_status(task, &[TaskStatus::Accepted])?;
            if artifacts.len().saturating_add(observed.submission_files) > MAX_ARTIFACTS {
                return Err(CoreError::InvalidArgument("artifacts"));
            }
            for artifact in &artifacts {
                require_artifact(artifact)?;
            }
            if note.as_ref().is_some_and(|n| n.len() > MAX_NOTE_BYTES) {
                return Err(CoreError::InvalidArgument("note"));
            }
            let has_note = note.as_deref().is_some_and(|n| !n.trim().is_empty());
            if artifacts.is_empty() && observed.submission_files == 0 && !has_note {
                return Err(CoreError::InvalidArgument("artifacts"));
            }
            require_reference(&commit_sha, "commit_sha")?;
            if task.has_linked_repository && commit_sha.is_none() {
                return Err(CoreError::InvalidArgument("commit_sha"));
            }
            if let (Some(head), Some(sha)) = (&observed.head_sha, &commit_sha) {
                if head != sha {
                    return Err(CoreError::CommitChanged);
                }
            }
            next.status = TaskStatus::Submitted;
            next.submission_no = task.submission_no.saturating_add(1);
            next.submission_commit = commit_sha;
            next.submission_files = observed.submission_files as u32;
            vec![event(EventKind::TaskSubmitted, actor, [&task.reviewer])]
        }
        Command::RequestChanges {
            submission_no,
            reason,
        } => {
            require_status(task, &[TaskStatus::Submitted])?;
            if submission_no != task.submission_no {
                return Err(CoreError::SubmissionMismatch);
            }
            require_text(&reason, "reason", MAX_REASON_BYTES)?;
            if task.assignee_departed {
                next.status = TaskStatus::Open;
                next.assignee = None;
                next.assignee_departed = false;
                vec![event(
                    EventKind::TaskChangesRequested,
                    actor,
                    [&task.requester],
                )]
            } else {
                next.status = TaskStatus::Accepted;
                vec![event(
                    EventKind::TaskChangesRequested,
                    actor,
                    &task.assignee,
                )]
            }
        }
        Command::Verify {
            submission_no,
            commit_sha,
        } => {
            require_reference(&commit_sha, "commit_sha")?;
            require_status(task, &[TaskStatus::Submitted])?;
            if task.assignee.as_deref() == Some(actor) {
                return Err(CoreError::SelfSignOff);
            }
            if submission_no != task.submission_no {
                return Err(CoreError::SubmissionMismatch);
            }
            if task.submission_files > 0 {
                let checked = observed.approved_files.as_ref().is_some_and(|proof| {
                    proof.task_id() == task.id
                        && proof.submission_no() == submission_no
                        && proof.count() == task.submission_files as usize
                });
                if !checked {
                    return Err(CoreError::FilesNotChecked);
                }
            }
            if task.has_linked_repository {
                if commit_sha.is_none() {
                    return Err(CoreError::InvalidArgument("commit_sha"));
                }
                if commit_sha != task.submission_commit {
                    return Err(CoreError::CommitChanged);
                }
                if observed.head_sha.is_some() && observed.head_sha != task.submission_commit {
                    return Err(CoreError::CommitChanged);
                }
            }
            next.status = TaskStatus::Completed;
            next.approved_submission_no = Some(submission_no);
            vec![event(
                EventKind::TaskCompleted,
                actor,
                task.assignee.iter().chain([&task.requester]),
            )]
        }
        Command::Cancel { version, reason } => {
            require_version(task, version)?;
            require_non_terminal(task)?;
            require_text(&reason, "reason", MAX_REASON_BYTES)?;
            next.status = TaskStatus::Canceled;
            vec![event(
                EventKind::TaskCanceled,
                actor,
                task.assignee
                    .iter()
                    .chain([&task.requester, &task.reviewer]),
            )]
        }
    };
    for draft in &mut events {
        draft.reason.clone_from(&reason);
    }
    if next.status.is_terminal() {
        next.needs_reviewer = false;
        next.needs_requester = false;
    }
    next.version = task.version.saturating_add(1);
    Ok(Decision { task: next, events })
}

/// Applies the departure rules for one departing participant.
/// Returns `None` when the task is terminal or the participant has no role on it.
///
/// `requester_can_review` says whether the requester is eligible under the reviewer rules, such as a room's
/// person-review policy. The task never completes because of a departure.
/// A reviewer who can't review any more falls back to the requester, if the requester can, and otherwise the task is
/// flagged for an owner or admin. `task` already reflects anything else that changed with it.
fn replace_reviewer(
    task: &mut Task,
    former: &str,
    requester_can_review: bool,
    events: &mut Vec<EventDraft>,
) {
    let requester_usable = task.requester != former
        && task.assignee.as_deref() != Some(task.requester.as_str())
        && requester_can_review;
    if requester_usable {
        task.reviewer = task.requester.clone();
        let requester = task.requester.clone();
        events.push(event(EventKind::TaskReviewerChanged, former, [&requester]));
    } else {
        task.needs_reviewer = true;
        events.push(event(EventKind::TaskNeedsAttention, former, []));
    }
}

/// An owner or admin took review away from someone still named as a task's reviewer. They stay in the room, so this
/// follows only the reviewer half of the departure rules. The actor on the event is the former reviewer, as on departure.
pub fn apply_review_ended(
    task: &Task,
    former: &str,
    requester_can_review: bool,
) -> Option<Decision> {
    if task.status.is_terminal() || task.reviewer != former {
        return None;
    }
    let mut next = task.clone();
    let mut events = Vec::new();
    replace_reviewer(&mut next, former, requester_can_review, &mut events);
    next.version = task.version.saturating_add(1);
    Some(Decision { task: next, events })
}

pub fn apply_departure(
    task: &Task,
    departed: &str,
    requester_can_review: bool,
) -> Option<Decision> {
    if task.status.is_terminal() {
        return None;
    }
    let mut next = task.clone();
    let mut events = Vec::new();
    if task.assignee.as_deref() == Some(departed) {
        if task.status == TaskStatus::Submitted {
            next.assignee_departed = true;
            events.push(event(
                EventKind::TaskAssigneeDeparted,
                departed,
                [&task.reviewer],
            ));
        } else {
            next.status = TaskStatus::Open;
            next.assignee = None;
            events.push(event(
                EventKind::TaskAssigneeDeparted,
                departed,
                [&task.requester],
            ));
        }
    }
    if task.reviewer == departed {
        replace_reviewer(&mut next, departed, requester_can_review, &mut events);
    }
    if task.requester == departed {
        next.needs_requester = true;
        events.push(event(EventKind::TaskNeedsAttention, departed, []));
    }
    if events.is_empty() {
        return None;
    }
    next.version = task.version.saturating_add(1);
    Some(Decision { task: next, events })
}
