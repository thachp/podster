//! Expected outputs: M2 step 7. No I/O.
//!
//! An expected output is a result the room means to produce ([PRODUCT.md](../../../docs/spec/PRODUCT.md), "Expected output").
//! The owner and admins define them, a task's requester names one on the task, and the lead comes later (decision 54). Who may
//! do each is `podster-policy`'s `outputs` module; this module holds what a change must satisfy and what follows from it.
//!
//! A task names at most one output. Approving a task that names one makes that approved submission the output's current
//! version, so the output is Ready ([ADR 0006](../../../docs/adr/0006-uploads-and-scanning.md#expected-outputs)). Several tasks
//! can name the same output, such as a follow-up, and the latest approval is the current version. The room runs its commands
//! one at a time, so "latest" is simply the approval being recorded now.
//!
//! Nothing else moves a current version:
//!
//! - **Request changes** records nothing on the output. The task goes back to Accepted, so it stops counting as in review.
//! - **Cancel** records nothing either. A canceled task never counts as in review, and it keeps naming the output as history.
//! - **A file blocked or removed after approval** leaves the approval and the current version in place, as ADR 0006 says an
//!   approved submission keeps its approval. [`current_files_available`] says the version's files can no longer be downloaded,
//!   so a screen can say so beside Ready.
//!
//! The room reads its own rows and passes them in, and each room keeps its own outputs, so an output from another room is
//! never found. Titles and descriptions are agent or person content: shown, never acted on.
//!
//! **Proposed** throughout. The choices this makes that the ADR doesn't are listed in `docs/m2-step7-plan.md`.

use crate::submission_files::RoomFile;
use crate::{require_text, Task, TaskStatus};

/// The most expected outputs one room may define. A room's goal is a handful of results, and a card shows "n of m ready".
pub const MAX_EXPECTED_OUTPUTS: usize = 50;
/// The most outputs one room may ever define, removed ones included. A removed output keeps its row (decision 136), so
/// without this, define and remove could grow the table without end. Not an owner ruling: a bound the lead asked for.
pub const MAX_OUTPUTS_EVER_DEFINED: usize = 500;
/// An output's title, the same as a work role's.
pub const MAX_OUTPUT_TITLE_BYTES: usize = 200;
/// An output's optional description, the same as a work role's responsibilities.
pub const MAX_OUTPUT_DESCRIPTION_BYTES: usize = 4 * 1024;

/// Why a change to an output, or to the output a task names, was refused. It never carries a title or description, so it's
/// safe to log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputRefusal {
    /// The room is archived, so its outputs and links no longer change.
    RoomArchived,
    /// A title or description is empty where it can't be, or too long. Carries the field's name.
    InvalidArgument(&'static str),
    /// The room already has [`MAX_EXPECTED_OUTPUTS`], or has ever defined [`MAX_OUTPUTS_EVER_DEFINED`].
    TooMany,
    /// No such output in this room, or it was removed.
    NotFound,
    /// An output a live task names, or one that was ever Ready, can't be removed.
    InUse,
    /// The task changed since the caller read it: `expected_version` isn't its current version.
    VersionConflict,
    /// The task's output can change only while it's open, offered or accepted, so not while submitted or once finished. Changes
    /// requested puts it back in accepted, where it can change again (decision 137). A reviewer looking at a submission approves it for the output
    /// it named when submitted, and a finished task's approval has already counted or never will.
    InvalidTransition,
}

impl OutputRefusal {
    // codes: errors
    pub fn code(self) -> &'static str {
        match self {
            OutputRefusal::RoomArchived => "workspace_archived",
            OutputRefusal::InvalidArgument(_) => "invalid_argument",
            OutputRefusal::TooMany => "too_many_outputs",
            OutputRefusal::NotFound => "output_not_found",
            OutputRefusal::InUse => "output_in_use",
            OutputRefusal::VersionConflict => "version_conflict",
            OutputRefusal::InvalidTransition => "invalid_transition",
        }
    }
}

fn require_open_room(room_archived: bool) -> Result<(), OutputRefusal> {
    if room_archived {
        Err(OutputRefusal::RoomArchived)
    } else {
        Ok(())
    }
}

fn check_text(title: &str, description: Option<&str>) -> Result<(), OutputRefusal> {
    require_text(title, "title", MAX_OUTPUT_TITLE_BYTES)
        .map_err(|_| OutputRefusal::InvalidArgument("title"))?;
    if let Some(description) = description {
        require_text(description, "description", MAX_OUTPUT_DESCRIPTION_BYTES)
            .map_err(|_| OutputRefusal::InvalidArgument("description"))?;
    }
    Ok(())
}

/// Whether a new output may be defined. `existing` is how many outputs the room has now, and `ever_defined` how many it has
/// ever defined, removed ones included.
pub fn decide_define(
    room_archived: bool,
    existing: usize,
    ever_defined: usize,
    title: &str,
    description: Option<&str>,
) -> Result<(), OutputRefusal> {
    require_open_room(room_archived)?;
    check_text(title, description)?;
    if existing >= MAX_EXPECTED_OUTPUTS || ever_defined >= MAX_OUTPUTS_EVER_DEFINED {
        return Err(OutputRefusal::TooMany);
    }
    Ok(())
}

/// Whether an output's title or description may change. A Ready output may be renamed: its current version stays, since
/// what was approved is the submission, not the wording.
pub fn decide_edit(
    room_archived: bool,
    title: &str,
    description: Option<&str>,
) -> Result<(), OutputRefusal> {
    require_open_room(room_archived)?;
    check_text(title, description)
}

/// Whether an output may be removed. Removal keeps its row, as planned lines do, so a finished task that named it still points
/// at something, but it leaves listings and counts and can't be named again. `live_naming_tasks` counts the tasks that name it
/// and aren't completed or canceled, and `has_version` is whether it was ever Ready. A Ready output is part of the room's
/// record of what it produced, and a live task would be left working toward nothing.
pub fn decide_remove(
    room_archived: bool,
    live_naming_tasks: usize,
    has_version: bool,
) -> Result<(), OutputRefusal> {
    require_open_room(room_archived)?;
    if live_naming_tasks > 0 || has_version {
        return Err(OutputRefusal::InUse);
    }
    Ok(())
}

/// What happens to the output a task names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkChange {
    /// It already names that one, or names none and none was asked for. Nothing is recorded.
    Unchanged,
    /// It names this output now.
    Set(String),
    /// It names none now.
    Cleared,
}

impl LinkChange {
    /// Whether this moves the task's version. A real change does, so anyone acting on what they read before it, such as an
    /// assignee about to submit, gets `version_conflict` and rereads which output the task works toward. `Unchanged` records
    /// nothing, so it doesn't.
    pub fn moves_version(&self) -> bool {
        !matches!(self, LinkChange::Unchanged)
    }

    /// The task's version after this.
    pub fn next_version(&self, task_version: u64) -> u64 {
        if self.moves_version() {
            task_version.saturating_add(1)
        } else {
            task_version
        }
    }
}

/// Whether a task may name `requested`, or none for `None`, given that it names `current` now. Also used when a task is
/// created naming an output, with `Open` and no current one. `requested_exists` is whether the room has the output asked for,
/// and is ignored for `None`.
///
/// `expected_version` is the task version the caller last read, as `update_task` takes it, and must be `task_version`. It's
/// `None` only when the task is being created in the same command, so there's nothing older to have read.
///
/// A task can change its output only while open, offered or accepted, so again after changes are requested (decision 137).
/// Asking for what it already names is accepted whatever its status, and moves nothing.
pub fn decide_link(
    room_archived: bool,
    status: TaskStatus,
    task_version: u64,
    expected_version: Option<u64>,
    current: Option<&str>,
    requested: Option<&str>,
    requested_exists: bool,
) -> Result<LinkChange, OutputRefusal> {
    require_open_room(room_archived)?;
    if expected_version.is_some_and(|expected| expected != task_version) {
        return Err(OutputRefusal::VersionConflict);
    }
    if current == requested {
        return Ok(LinkChange::Unchanged);
    }
    if !matches!(
        status,
        TaskStatus::Open | TaskStatus::Offered | TaskStatus::Accepted
    ) {
        return Err(OutputRefusal::InvalidTransition);
    }
    match requested {
        None => Ok(LinkChange::Cleared),
        Some(_) if !requested_exists => Err(OutputRefusal::NotFound),
        Some(id) => Ok(LinkChange::Set(id.to_string())),
    }
}

/// An output's current version: the approved submission that made it Ready.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputVersion {
    pub output_id: String,
    pub task_id: String,
    pub submission_no: u32,
    pub approved_at: i64,
}

/// The version an approval records on an output, if any. Pass the task as `decide` returned it for `Command::Verify`, the
/// output it names, how many artifacts the approved submission carries (links and files together), and the time of approval.
///
/// Only a completed task with an approved submission records one, so a refused approval, a request for changes or a cancel
/// never does. A submission with only a note completes its task but carries no artifact, so it doesn't make an output Ready.
/// The version returned replaces the output's current one, whatever that was.
pub fn version_from_approval(
    task: &Task,
    output: Option<&str>,
    artifacts: usize,
    approved_at: i64,
) -> Option<OutputVersion> {
    let output_id = output?;
    let submission_no = task.approved_submission_no?;
    if task.status != TaskStatus::Completed || artifacts == 0 {
        return None;
    }
    Some(OutputVersion {
        output_id: output_id.to_string(),
        task_id: task.id.clone(),
        submission_no,
        approved_at,
    })
}

/// What a participant sees of an output's progress (DESIGN.md: Not started · In review · Ready).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputStatus {
    NotStarted,
    /// No approved version yet, and a task naming it is waiting for review.
    InReview,
    /// It has a current version. A follow-up in review doesn't change that.
    Ready,
}

impl OutputStatus {
    pub fn name(self) -> &'static str {
        match self {
            OutputStatus::NotStarted => "not_started",
            OutputStatus::InReview => "in_review",
            OutputStatus::Ready => "ready",
        }
    }
}

/// An output's status, from whether it has a current version and the statuses of the tasks naming it now. A listing computes
/// it to show; nothing authorizes from it.
pub fn output_status(has_version: bool, naming: &[TaskStatus]) -> OutputStatus {
    if has_version {
        OutputStatus::Ready
    } else if naming.contains(&TaskStatus::Submitted) {
        OutputStatus::InReview
    } else {
        OutputStatus::NotStarted
    }
}

/// Whether every stored file of an output's current version can still be downloaded. `files` is what the room reads now for
/// the files that submission names. False if any was removed or blocked after approval, or a row is missing. A version with no
/// stored files, only links, is available.
///
/// The answer says something about a submission, so a read shows it only to someone who may read that submission, never to
/// every participant who sees the output.
pub fn current_files_available(pinned: &[&str], files: &[RoomFile<'_>]) -> bool {
    pinned.iter().all(|id| {
        files
            .iter()
            .find(|file| file.id == *id)
            .is_some_and(|file| !file.removed && file.state.is_available())
    })
}

/// "n of m outputs ready" for a card: how many of the room's outputs have a current version, out of all of them.
pub fn ready_count(has_version: &[bool]) -> (usize, usize) {
    (
        has_version.iter().filter(|ready| **ready).count(),
        has_version.len(),
    )
}
