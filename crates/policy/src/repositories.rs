//! Who may grant, use and see a room's repository (ADR 0009, which is proposed; decisions 18 and 186). Denies by default.
//!
//! What a grant, a token request or a merge must satisfy beyond who is asking is `podster_core::repo_grants`,
//! `repo_access` and `repo_merge`. Nothing here takes an organization, an installation, a repository or a pull request
//! from a caller.
//!
//! | Action | Who |
//! | --- | --- |
//! | Give or take back a `push` or `merge` grant | A human owner or admin, who also holds the repository's delegation. Neither side alone is enough (AC-10, AC-11). The delegation is the room owner's, for that repository only |
//! | Receive a grant | A current participant, person or agent, who isn't there through a public claim |
//! | Ask for a repository token | The agent the task is assigned to, with a live `push` grant |
//! | Ask for a merge | A person or agent who can see the task, holds a live `merge` grant and didn't submit the work |
//! | See the room's repository and its state | A person who sees the whole room |
//! | See who holds grants | A human owner or admin, and each participant their own |
//! | See a task's change and merge state | Whoever can see the task |
//!
//! Reviewing a task carries no grant, and neither does a role, a work-role title, an A2A message or a public claim
//! (AC-17, AC-24).

use podster_core::repo_grants::{check_grant, Grant, GrantRefusal};
use podster_core::repositories::GrantAction;
use podster_core::Task;

use crate::{can_see_task, is_human_admin, sees_whole_room, Caller, PrincipalKind, Role};

/// Why a repository action was refused on who was asking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepoDenial {
    /// `not_a_participant`
    NotParticipant,
    /// `task_not_found`: the caller may not know the task exists.
    Hidden,
    /// `not_allowed`
    NotAllowed,
    /// `no_provider_delegation`: the caller administers the room and doesn't hold the repository's delegation.
    NoProviderDelegation,
    /// `grantee_not_participant`: a grant can't be given to someone who isn't in the room.
    GranteeNotParticipant,
    /// `grantee_public`: someone in the room through a public claim. No spec says they can hold a grant, so it's refused
    /// until one does.
    GranteePublic,
    /// `self_merge`: whoever submitted the work never merges it.
    SelfMerge,
    /// `grant_required` or `grant_expired`
    Grant(GrantRefusal),
}

impl RepoDenial {
    pub fn code(self) -> &'static str {
        match self {
            RepoDenial::NotParticipant => "not_a_participant",
            RepoDenial::Hidden => "task_not_found",
            RepoDenial::NotAllowed => "not_allowed",
            RepoDenial::NoProviderDelegation => "no_provider_delegation",
            RepoDenial::GranteeNotParticipant => "grantee_not_participant",
            RepoDenial::GranteePublic => "grantee_public",
            RepoDenial::SelfMerge => "self_merge",
            RepoDenial::Grant(refusal) => refusal.code(),
        }
    }
}

/// Whether someone holds the delegation for the room's repository. Podster's platform owns a managed repository and
/// delegates to the room's owner, for that repository only (decision 18). So it's the person who is the room's owner
/// now. An agent stored as an owner holds nothing, as everywhere else, and an admin doesn't hold it by being an admin.
///
/// The room must also check the owner's authority still holds, with `owner_authority_holds`, before it passes this on.
pub fn holds_repository_delegation(kind: PrincipalKind, role: Role) -> bool {
    kind == PrincipalKind::Person && role == Role::Owner
}

/// Who may give or take back a grant on the room's repository. Both sides are needed: authority to configure the room,
/// which is a human owner or admin, and the repository's delegation. `holds_delegation` is its own input so neither can
/// stand in for the other: an admin without the delegation is refused (AC-10), and so is someone who holds a delegation
/// and doesn't administer the room (AC-11).
pub fn authorize_grant_change(caller: &Caller, holds_delegation: bool) -> Result<(), RepoDenial> {
    if caller.role == Role::None {
        return Err(RepoDenial::NotParticipant);
    }
    if !is_human_admin(caller) {
        return Err(RepoDenial::NotAllowed);
    }
    if !holds_delegation {
        return Err(RepoDenial::NoProviderDelegation);
    }
    Ok(())
}

/// Who a grant may be given to: a current participant of the room, person or agent. `through_public_claim` says they're
/// in the room only through a public claim. Taking a grant back needs none of this, so someone who left can still lose one.
pub fn may_receive_grant(role: Role, through_public_claim: bool) -> Result<(), RepoDenial> {
    if role == Role::None {
        return Err(RepoDenial::GranteeNotParticipant);
    }
    if through_public_claim {
        return Err(RepoDenial::GranteePublic);
    }
    Ok(())
}

/// Who may ask for a repository token for a task: the agent it's assigned to, holding a live `push` grant on the room's
/// repository. A person never gets one, and neither does an agent that can't see the task. `link_repo_id` is the room's
/// own link. The task's state, its deadline and the repository's readiness are `repo_access::decide_access`.
pub fn authorize_repo_access(
    caller: &Caller,
    task: &Task,
    grant: Option<&Grant>,
    link_repo_id: i64,
    now: i64,
) -> Result<(), RepoDenial> {
    if caller.role == Role::None {
        return Err(RepoDenial::NotParticipant);
    }
    if !can_see_task(caller, task) {
        return Err(RepoDenial::Hidden);
    }
    if caller.kind != PrincipalKind::Agent || task.assignee.as_deref() != Some(caller.id.as_str()) {
        return Err(RepoDenial::NotAllowed);
    }
    check_grant(grant, GrantAction::Push, link_repo_id, now).map_err(RepoDenial::Grant)
}

/// Who may ask for a merge of a task's approved work: a person or agent who can see the task, didn't submit the work
/// and holds a live `merge` grant on the room's repository (decision 186). Being the reviewer, the requester, an admin
/// or the owner isn't enough without the grant, and approval carries none (AC-17). `submitter` is who made the approved
/// submission. The review itself and the commit are `repo_merge::check_merge_authority`.
pub fn authorize_merge(
    caller: &Caller,
    task: &Task,
    submitter: &str,
    grant: Option<&Grant>,
    link_repo_id: i64,
    now: i64,
) -> Result<(), RepoDenial> {
    if caller.role == Role::None {
        return Err(RepoDenial::NotParticipant);
    }
    if !can_see_task(caller, task) {
        return Err(RepoDenial::Hidden);
    }
    if caller.id == submitter || task.assignee.as_deref() == Some(caller.id.as_str()) {
        return Err(RepoDenial::SelfMerge);
    }
    check_grant(grant, GrantAction::Merge, link_repo_id, now).map_err(RepoDenial::Grant)
}

/// Who sees the room's repository, its request and its state: a person who sees the whole room, as the read that M5
/// step 2 built answers. An agent learns of the repository only through a token for a task.
pub fn sees_repository(caller: &Caller) -> bool {
    caller.kind == PrincipalKind::Person && sees_whole_room(caller)
}

/// Who sees a grant on the room's repository: a human owner or admin sees every one, in Manage access, and each
/// participant sees their own.
pub fn sees_grant(caller: &Caller, grantee: &str) -> bool {
    caller.role != Role::None && (is_human_admin(caller) || caller.id == grantee)
}

/// Who sees a task's change: its pull request number, commits, checks and merge state, and the merge events. Whoever
/// can see the task, as it stands now.
pub fn sees_task_change(caller: &Caller, task: &Task) -> bool {
    can_see_task(caller, task)
}
