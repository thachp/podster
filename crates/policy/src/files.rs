//! Who may upload and see files in a workroom (decisions 53 and 58). Denies by default.
//!
//! Attaching a file to a submission and an operator's takedown come with the steps that build them.

use podster_core::files::ObjectState;
use podster_core::Task;

use crate::{
    authorize_task, is_human_admin, is_party, Caller, Role, TaskAction, TaskView, Verdict,
};

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

/// Whether someone can have a file's bytes now. Their current view and the scan both have to allow it, so an uploader can't
/// fetch their own blocked file. Call it on every use, from current state.
pub fn may_download(view: FileView, state: ObjectState) -> bool {
    match view {
        FileView::Full => state.is_available(),
        FileView::NameAndStatus | FileView::Hidden => false,
    }
}

/// Who may remove a file's bytes from inside the room: its owner or a human admin (decision 57). An agent stored as an admin
/// counts as a guest, as everywhere else, and the uploader has no say over their own file. Someone who can't see the file is
/// answered as if it didn't exist. `view` is the caller's current view of this file, from the same state.
///
/// A Podster operator, also named in decision 57, isn't a room participant, so their takedown needs its own route.
pub fn authorize_file_removal(caller: &Caller, view: FileView) -> Verdict {
    if caller.role == Role::None {
        return Verdict::NotParticipant;
    }
    if is_human_admin(caller) {
        return Verdict::Allow;
    }
    match view {
        FileView::Hidden => Verdict::Hidden,
        FileView::NameAndStatus | FileView::Full => Verdict::Forbidden,
    }
}
