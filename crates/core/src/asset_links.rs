//! Input assets linked to tasks: M2 step 5 (decision 53). No I/O.
//!
//! Whoever sees the whole room sees every input asset, and someone limited to their own tasks sees only those linked to one of
//! their tasks. A link is what gives that narrower view, so it's read from current state on every use, and unlinking ends it.
//! A link grants nothing else: no task access, no upload, no change to the task.
//!
//! The states a file may be linked in, the task states that take a link and the limit per task are decisions 101, 102 and 105.

use crate::files::ObjectState;
use crate::submission_files::RoomFile;
use crate::TaskStatus;

/// The most input assets one task may have linked at once.
pub const MAX_LINKED_ASSETS: usize = 50;

/// Why a link was refused. It never carries a name, so it's safe to log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkRefusal {
    /// Not an input asset: it was uploaded for a submission, so it's linked to its task by being submitted, if at all.
    NotInputAsset,
    /// Its bytes haven't all arrived, or its scan ended blocked or failed, so nobody could ever have it.
    NotAvailable,
    /// Its bytes were removed.
    Removed,
    /// The task is completed or canceled, so nobody is working on it to need the file.
    TaskClosed,
    /// The task already has as many linked assets as it may.
    TooMany,
}

impl LinkRefusal {
    pub fn code(self) -> &'static str {
        match self {
            LinkRefusal::NotInputAsset => "file_not_found",
            LinkRefusal::NotAvailable => "file_not_available",
            LinkRefusal::Removed => "file_removed",
            LinkRefusal::TaskClosed => "task_closed",
            LinkRefusal::TooMany => "limit_exceeded",
        }
    }
}

/// Whether a file in a state can be linked: one that's arrived and may yet be, or already is, downloadable.
pub fn linkable_state(state: ObjectState) -> bool {
    match state {
        ObjectState::Scanning | ObjectState::Ready => true,
        ObjectState::Uploading | ObjectState::Blocked | ObjectState::Failed => false,
    }
}

/// Whether a task takes a new link. Unlinking is always allowed, whatever the task's state.
pub fn task_takes_links(status: TaskStatus) -> bool {
    !matches!(status, TaskStatus::Completed | TaskStatus::Canceled)
}

/// Checks a new link of `file` to a task in `status` that has `linked_now` assets linked already. Linking a file that's already
/// linked to the task isn't a new link, so the caller answers it as done without asking here.
///
/// A submission file answers as if it weren't there, as the room answers a file someone can't see.
pub fn check_link(
    file: &RoomFile,
    status: TaskStatus,
    linked_now: usize,
) -> Result<(), LinkRefusal> {
    if file.for_task.is_some() {
        return Err(LinkRefusal::NotInputAsset);
    }
    if file.removed {
        return Err(LinkRefusal::Removed);
    }
    if !linkable_state(file.state) {
        return Err(LinkRefusal::NotAvailable);
    }
    if !task_takes_links(status) {
        return Err(LinkRefusal::TaskClosed);
    }
    if linked_now >= MAX_LINKED_ASSETS {
        return Err(LinkRefusal::TooMany);
    }
    Ok(())
}
