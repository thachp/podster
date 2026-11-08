//! Who may upload and see files in a workroom (decisions 53 and 58). Denies by default.
//!
//! Removing a file and an operator's takedown come with the steps that build them.

use podster_core::files::ObjectState;
use podster_core::Task;

use crate::{authorize_task, is_party, Caller, Role, TaskAction, TaskView, Verdict};

/// How much of a file someone may have. A route answers `Hidden` as if the file didn't exist, as it does for a hidden task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileView {
    Hidden,
    /// Name and status, not bytes.
    NameAndStatus,
    /// Name, status and, once the scan allows it, bytes.
    Full,
}

impl FileView {
    /// What an organization's admin gets of a file its agent can see: name and status, never bytes (decision 58).
    ///
    /// `oversight_view` in `apps/api` builds a caller that looks like a guest in the agent's place, so the views above would
    /// answer `Full`. Any route serving oversight must pass its answer through here.
    pub fn for_oversight(self) -> FileView {
        match self {
            FileView::Hidden => FileView::Hidden,
            FileView::NameAndStatus | FileView::Full => FileView::NameAndStatus,
        }
    }
}

/// Who may upload an input asset: an owner, admin, member or Coordinator (decision 53).
///
/// The decision names roles and presets, and a grant can be adjusted away from them. Until the owner rules on that, someone
/// must hold one of those roles and also keep at least a member's reach, so a member narrowed to their own tasks and a guest
/// widened to the whole room both stay refused. An agent stored as an admin counts as a guest, as everywhere else.
pub fn authorize_input_upload(caller: &Caller) -> Verdict {
    if caller.role == Role::None {
        return Verdict::NotParticipant;
    }
    let tasks = caller.effective_scopes().tasks;
    let holds_role = matches!(caller.role, Role::Owner | Role::Admin | Role::Member);
    if holds_role && tasks.sees_all() && tasks.can_create() {
        Verdict::Allow
    } else {
        Verdict::Forbidden
    }
}

/// How much of an input asset the caller gets. Whoever sees the whole room sees all of them, and anyone limited to their own
/// tasks only those linked to one. `linked_tasks` must hold every task the asset is linked to now.
pub fn input_asset_view(caller: &Caller, linked_tasks: &[&Task]) -> FileView {
    if caller.role == Role::None {
        return FileView::Hidden;
    }
    if caller.effective_scopes().tasks.sees_all()
        || linked_tasks.iter().any(|t| is_party(caller, t))
    {
        FileView::Full
    } else {
        FileView::Hidden
    }
}

/// How much of a submitted file the caller gets, as for submissions now: an artifact scope of `all` reads every one, and
/// narrower scopes read their own.
pub fn submitted_file_view(caller: &Caller, task: &Task, submitted_by: &str) -> FileView {
    if authorize_task(caller, task, TaskAction::Read) != Verdict::Allow {
        return FileView::Hidden;
    }
    let TaskView { artifacts, .. } = crate::task_view(caller, task);
    match artifacts {
        crate::ArtifactView::All => FileView::Full,
        crate::ArtifactView::OwnSubmissions if submitted_by == caller.id => FileView::Full,
        crate::ArtifactView::OwnSubmissions => FileView::Hidden,
    }
}

/// Who may start an upload for a task's submission: whoever may submit it, which is its assignee, a guest included. The
/// file counts toward the room's quota like any other. Whether the task is waiting for a submission is
/// `podster_core::submission_files::accepts_submission_uploads`.
pub fn authorize_submission_upload(caller: &Caller, task: &Task) -> Verdict {
    authorize_task(caller, task, TaskAction::Submit)
}

/// How much of a file uploaded for a task's submission the caller gets. Until a submission names it, only its uploader, while
/// they can still read the task, so nobody else in the room learns it exists. Once one does, as for submitted work, through
/// [`submitted_file_view`]. A file is only ever submitted by its uploader, so the uploader is its submitter.
///
/// The reviewer named on the task reads its submitted files whatever their artifact scope (decision 97). That widens access by
/// exactly that much: only that task's files, only once submitted, and only while they can read the task.
pub fn task_file_view(
    caller: &Caller,
    task: &Task,
    uploaded_by: &str,
    submitted: bool,
) -> FileView {
    if submitted {
        let named_reviewer = caller.id == task.reviewer
            && authorize_task(caller, task, TaskAction::Read) == Verdict::Allow;
        return if named_reviewer {
            FileView::Full
        } else {
            submitted_file_view(caller, task, uploaded_by)
        };
    }
    if caller.id == uploaded_by && authorize_task(caller, task, TaskAction::Read) == Verdict::Allow
    {
        FileView::Full
    } else {
        FileView::Hidden
    }
}

/// Whether someone can have a file's bytes now. Their current view and the scan both have to allow it, so an uploader can't
/// fetch their own blocked file. Call it on every use, from current state.
pub fn may_download(view: FileView, state: ObjectState) -> bool {
    match view {
        FileView::Full => state.is_available(),
        FileView::NameAndStatus | FileView::Hidden => false,
    }
}
