//! Who may define expected outputs, name one on a task, and see them (decision 54). Denies by default.
//!
//! What a change must satisfy is `podster_core::expected_outputs`. The lead's part in this comes later, as for planned lines
//! (decision 45), so no agent defines outputs yet.

use podster_core::Task;

use crate::{authorize_task, can_see_task, is_human_admin, Caller, Role, TaskAction, Verdict};

/// Who may define, rename or remove the room's expected outputs: a human owner or admin. An agent stored as an admin counts as
/// a guest, as everywhere else.
pub fn authorize_manage_outputs(caller: &Caller) -> Verdict {
    if caller.role == Role::None {
        Verdict::NotParticipant
    } else if is_human_admin(caller) {
        Verdict::Allow
    } else {
        Verdict::Forbidden
    }
}

/// Who may change which output a task names: its requester, or a human owner or admin, the same as editing the task. Someone
/// who can't see the task gets `Hidden`. Naming one when creating a task needs only the right to create it, since the creator
/// is its requester.
pub fn authorize_output_link(caller: &Caller, task: &Task) -> Verdict {
    authorize_task(caller, task, TaskAction::Update)
}

/// Who sees the room's outputs, with their titles, descriptions and status: every participant (decision 54).
pub fn sees_outputs(caller: &Caller) -> bool {
    caller.role != Role::None
}

/// Whether the caller learns which task delivered an output's current version, or which tasks name it. Only for a task they
/// can see, so an output's status never names a task hidden from someone limited to their own.
pub fn sees_output_task(caller: &Caller, task: &Task) -> bool {
    can_see_task(caller, task)
}
