//! Files on a submission, and the exact versions a reviewer approves: M2 step 6. No I/O.
//!
//! Design: [ADR 0006](../../../docs/adr/0006-uploads-and-scanning.md#exact-version-review). Rules people see: [upload
//! policy](../../../docs/spec/UPLOAD-POLICY.md). The room reads its own rows and passes them in, and each room keeps its own
//! files, so a file from another room is never found and gets the same answer as one that doesn't exist.
//!
//! A submission number is the version. Submissions can't change once made, and each file a submission names is pinned to the
//! hash and size it had then. Approval names a submission number, which `decide` already requires to be the latest, and
//! [`check_approval`] then refuses unless every file it names is still the one pinned and still Ready.
//!
//! **Proposed** throughout. The choices this makes that the ADR doesn't are listed in the step's plan.

use crate::files::{is_sha256, ObjectState};
use crate::{require_label, CoreError, MAX_ARTIFACTS};

/// The most files one uploader may hold for one task that no submission names yet, counting uploads still arriving. It's the
/// submission limit, since no submission could name more, and it stops an assignee filling the room's quota while the task
/// stays accepted.
pub const MAX_UNSUBMITTED_FILES_PER_TASK: usize = MAX_ARTIFACTS;

/// Whether one more upload for a task fits, given how many unsubmitted files and unfinished uploads the uploader already
/// holds for it.
pub fn fits_unsubmitted_cap(held: usize) -> bool {
    held < MAX_UNSUBMITTED_FILES_PER_TASK
}

/// A file's label on a submission, if one was given: the same rule as a link's label.
pub fn check_file_label(label: Option<&str>) -> Result<(), CoreError> {
    label.map_or(Ok(()), require_label)
}

/// A file in the room, as the room read it from current state. Its `Debug` leaves out nothing secret: an ID, a principal, a
/// state, a hash the room computed and a size. The name stays out, because a name is agent content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoomFile<'a> {
    pub id: &'a str,
    pub uploaded_by: &'a str,
    /// The task it was uploaded for, or `None` for an input asset.
    pub for_task: Option<&'a str>,
    pub state: ObjectState,
    /// Set when its bytes were removed (decision 57). Removal comes with step 8, and until then this is always false.
    pub removed: bool,
    pub sha256: &'a str,
    pub size: u64,
}

/// A file as a submission names it, fixed when the submission is made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinnedFile {
    pub object_id: String,
    pub sha256: String,
    pub size: u64,
}

/// Why a submission's files were refused. It never carries a name or bytes, so it's safe to log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmissionFileRefusal {
    /// More links and files together than one submission may carry.
    TooMany,
    /// The same file named twice.
    Duplicate,
    /// No such file here, or not one the submitter uploaded for this task. One answer for all three, so naming someone
    /// else's file can't tell the submitter it exists.
    NotFound,
    /// It's the submitter's, but its scan hasn't ended Ready: still uploading or scanning, blocked or failed.
    NotReady,
    /// Its bytes were removed.
    Removed,
}

impl SubmissionFileRefusal {
    pub fn code(self) -> &'static str {
        match self {
            SubmissionFileRefusal::TooMany => "too_many_artifacts",
            SubmissionFileRefusal::Duplicate => "duplicate_file",
            SubmissionFileRefusal::NotFound => "file_not_found",
            SubmissionFileRefusal::NotReady => "file_not_ready",
            SubmissionFileRefusal::Removed => "file_removed",
        }
    }
}

/// Why approval was refused because of a submission's files. Safe to log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalFileRefusal {
    /// A file the submission names is no longer Ready. The scanner can block a Ready file when a late report finds something.
    NotReady,
    /// A file the submission names had its bytes removed, so there's nothing to approve.
    Removed,
    /// A file isn't the one pinned, or is missing. Objects never change once stored, so this means the room's rows are wrong,
    /// and approval fails closed.
    Changed,
}

impl ApprovalFileRefusal {
    pub fn code(self) -> &'static str {
        match self {
            ApprovalFileRefusal::NotReady => "file_not_ready",
            ApprovalFileRefusal::Removed => "file_removed",
            ApprovalFileRefusal::Changed => "file_changed",
        }
    }
}

/// Whether someone may start an upload for a task's submission now: only while the task is waiting for one. Who may is
/// `podster-policy`'s `TaskAction::Submit`, the assignee. Changes requested puts a task back in `Accepted`, so this covers
/// a resubmission.
pub fn accepts_submission_uploads(status: crate::TaskStatus) -> bool {
    status == crate::TaskStatus::Accepted
}

/// The files a submission names, checked and pinned. `found` is what the room read for the IDs in `requested`, from its own
/// rows, in any order and with missing ones left out. `links` is how many HTTPS links the same submission carries, which count
/// toward the same limit.
///
/// A file must be one the submitter uploaded for this task, must be Ready, and can't have been removed. Ready only, so a
/// reviewer is never asked to look at a file nobody can download yet, and a submission never waits on a scan that might
/// block it. An agent waits for its upload's scan before submitting.
pub fn pin_submission_files(
    submitter: &str,
    task_id: &str,
    requested: &[&str],
    links: usize,
    found: &[RoomFile<'_>],
) -> Result<Vec<PinnedFile>, SubmissionFileRefusal> {
    if requested.len().saturating_add(links) > MAX_ARTIFACTS {
        return Err(SubmissionFileRefusal::TooMany);
    }
    let mut pinned: Vec<PinnedFile> = Vec::with_capacity(requested.len());
    for (index, id) in requested.iter().enumerate() {
        if requested.iter().take(index).any(|earlier| earlier == id) {
            return Err(SubmissionFileRefusal::Duplicate);
        }
        let file = found
            .iter()
            .find(|file| file.id == *id)
            .filter(|file| file.uploaded_by == submitter && file.for_task == Some(task_id))
            .ok_or(SubmissionFileRefusal::NotFound)?;
        if file.removed {
            return Err(SubmissionFileRefusal::Removed);
        }
        // A row whose hash isn't one the room computed can't be pinned, so it fails as not ready rather than pinning nothing.
        if !file.state.is_available() || !is_sha256(file.sha256) {
            return Err(SubmissionFileRefusal::NotReady);
        }
        pinned.push(PinnedFile {
            object_id: file.id.to_string(),
            sha256: file.sha256.to_string(),
            size: file.size,
        });
    }
    Ok(pinned)
}

/// Proof that [`check_approval`] passed for one submission's files. Its fields are private, so nothing else can make one,
/// and `decide` refuses `Verify` on a submission with files without it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovedFiles {
    task_id: String,
    submission_no: u32,
    count: usize,
}

impl ApprovedFiles {
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn submission_no(&self) -> u32 {
        self.submission_no
    }

    pub fn count(&self) -> usize {
        self.count
    }
}

/// Whether the files of the submission being approved still allow it. `pinned` is every file that task's submission
/// `submission_no` names, and `current` is what the room reads for them now. Run it before `decide`'s `Command::Verify`, in the same
/// transaction, and pass the proof in `Observed::approved_files`.
///
/// Requesting changes doesn't run this: a reviewer can always send work back, including because a file was blocked.
pub fn check_approval(
    task_id: &str,
    submission_no: u32,
    pinned: &[PinnedFile],
    current: &[RoomFile<'_>],
) -> Result<ApprovedFiles, ApprovalFileRefusal> {
    for file in pinned {
        let now = current
            .iter()
            .find(|row| row.id == file.object_id)
            .ok_or(ApprovalFileRefusal::Changed)?;
        if now.removed {
            return Err(ApprovalFileRefusal::Removed);
        }
        if now.sha256 != file.sha256 || now.size != file.size {
            return Err(ApprovalFileRefusal::Changed);
        }
        if !now.state.is_available() {
            return Err(ApprovalFileRefusal::NotReady);
        }
    }
    Ok(ApprovedFiles {
        task_id: task_id.to_string(),
        submission_no,
        count: pinned.len(),
    })
}
