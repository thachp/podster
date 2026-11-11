//! Who may grant, use and see a room's repository (ADR 0009, which is proposed; decisions 18 and 186). Denies by default.
//!
//! What a grant, a token request or a merge must satisfy beyond who is asking is `podster_core::repo_grants`,
//! `repo_access` and `repo_merge`. Nothing here takes an organization, an installation, a repository or a pull request
//! from a caller.
//!
//! | Action | Who |
//! | --- | --- |
//! | Give a `push` or `merge` grant | The room's owner, as a person, whose authority holds: the one who has both room authority and the repository's delegation. Neither side alone is enough (AC-10, AC-11), so an admin can't |
//! | Take a grant back | The room's owner; a person who administers the room's organization, so a grant can be pulled when the owner has left; and the grant's holder, for their own. Nobody else, and an agent never takes back another's |
//! | Receive a grant | A current participant, person or agent, who isn't there through a public claim |
//! | Ask for a repository token | The agent the task is assigned to, not there through a public claim, with a `push` grant that counts |
//! | Ask for a merge | A person or agent who can see the task, isn't there through a public claim, holds a `merge` grant that counts, and isn't controlled by the person who controls the submitter |
//! | See the room's repository and its state | A person who sees the whole room |
//! | See who holds grants | A human owner or admin, and each participant their own |
//! | See a task's change and merge state | Whoever can see the task |
//!
//! A grant counts only while it's live and its giver still holds the delegation: see `repo_grants::check_grant`.
//! Reviewing a task carries no grant, and neither does a role, a work-role title, an A2A message or a public claim
//! (AC-17, AC-24).
//!
//! **Order.** A route runs the function here before the decision in `podster_core`. These answer `task_not_found` to a
//! caller who can't see the task. The core decisions answer `task_not_linked` and `repo_not_ready` before they look at
//! a grant, so run alone they'd tell such a caller something about the task.

use podster_core::repo_grants::{check_grant, Grant, GrantRefusal, GrantUse};
use podster_core::repo_merge::{same_controller, Actor};
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
    /// `grantee_public`: a grant can't be given to someone in the room through a public claim. No spec says they can
    /// hold one, so it's refused until one does. The giver has the authority, and named the wrong grantee.
    GranteePublic,
    /// `public_participant`: the caller is in the room through a public claim, and uses no grant, even one given before
    /// that was so.
    PublicParticipant,
    /// `self_merge`: nobody merges work that the person controlling them also controls the submitter of.
    SelfMerge,
    /// `grant_required`, `grant_expired` or `grant_stale`
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
            RepoDenial::PublicParticipant => "public_participant",
            RepoDenial::SelfMerge => "self_merge",
            RepoDenial::Grant(refusal) => refusal.code(),
        }
    }
}

/// Whether someone holds the delegation for the room's repository. Podster's platform owns a managed repository and
/// delegates to the room's owner, for that repository only (decision 18). So it's the person who is the room's owner
/// now, with their owner authority still holding, which the room reads with `owner_authority_holds`. An agent stored as
/// an owner holds nothing, as everywhere else, and an admin doesn't hold it by being an admin.
pub fn holds_repository_delegation(
    kind: PrincipalKind,
    role: Role,
    owner_authority_holds: bool,
) -> bool {
    kind == PrincipalKind::Person && role == Role::Owner && owner_authority_holds
}

/// Who holds the delegation now, for `GrantUse::delegation_holder`: the room's recorded owner if they hold it, and
/// nobody otherwise. A grant counts at use only if this is who gave it.
pub fn delegation_holder(
    owner_id: &str,
    owner_kind: PrincipalKind,
    owner_authority_holds: bool,
) -> Option<&str> {
    holds_repository_delegation(owner_kind, Role::Owner, owner_authority_holds).then_some(owner_id)
}

/// Who may give a grant on the room's repository. Both sides are needed: authority to configure the room, which is a
/// human owner or admin, and the repository's delegation. `holds_delegation` is its own input so neither can stand in
/// for the other: an admin without the delegation is refused (AC-10), and so is someone who holds a delegation and
/// doesn't administer the room (AC-11). As the room wires it, with [`holds_repository_delegation`], only the owner passes.
pub fn authorize_grant(caller: &Caller, holds_delegation: bool) -> Result<(), RepoDenial> {
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

/// Who may take a grant back:
///
/// - its holder, their own, whoever they are and whether or not they're still in the room;
/// - the room's owner, any grant, by the delegation they hold;
/// - a person who administers the room's organization, any grant, with or without a place in the room, so a grant can
///   be pulled when the owner has left.
///
/// Nobody else: not a room admin, a member, the reviewer or whoever gave the grant, once they no longer hold the
/// delegation. An agent never takes back another principal's grant, whatever role is stored for it.
pub fn authorize_revoke(
    caller: &Caller,
    grantee: &str,
    holds_delegation: bool,
    administers_room_org: bool,
) -> Result<(), RepoDenial> {
    if caller.id == grantee {
        return Ok(());
    }
    let person = caller.kind == PrincipalKind::Person;
    if person && administers_room_org {
        return Ok(());
    }
    if caller.role == Role::None {
        return Err(RepoDenial::NotParticipant);
    }
    if person && caller.role == Role::Owner && holds_delegation {
        return Ok(());
    }
    Err(RepoDenial::NotAllowed)
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

/// What a caller's grant is checked against at use, read from the room's current state.
#[derive(Clone, Copy, Debug)]
pub struct GrantStanding<'a> {
    /// The caller's grant row for the action that isn't revoked, if any.
    pub grant: Option<&'a Grant<'a>>,
    /// The room's own linked repository.
    pub link_repo_id: i64,
    /// Who holds the repository's delegation now, from [`delegation_holder`].
    pub delegation_holder: Option<&'a str>,
    /// The caller is in the room only through a public claim, now. Checked at every use, not only when granting.
    pub through_public_claim: bool,
    pub now: i64,
}

fn check_standing(
    caller: &Caller,
    action: GrantAction,
    standing: &GrantStanding,
) -> Result<(), RepoDenial> {
    if standing.through_public_claim {
        return Err(RepoDenial::PublicParticipant);
    }
    let usage = GrantUse {
        principal: &caller.id,
        action,
        link_repo_id: standing.link_repo_id,
        delegation_holder: standing.delegation_holder,
        now: standing.now,
    };
    check_grant(standing.grant, &usage).map_err(RepoDenial::Grant)
}

/// Who may ask for a repository token for a task: the agent it's assigned to, holding a `push` grant that counts on the
/// room's repository. A person never gets one, and neither does an agent that can't see the task. The task's state, its
/// deadline and the repository's readiness are `repo_access::decide_access`, which runs after this.
pub fn authorize_repo_access(
    caller: &Caller,
    task: &Task,
    standing: &GrantStanding,
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
    check_standing(caller, GrantAction::Push, standing)
}

/// Who may ask for a merge of a task's approved work: a person or agent who can see the task, holds a `merge` grant
/// that counts on the room's repository, and isn't controlled by the person who controls the submitter (decision 186).
///
/// `caller_person` is the person who controls the caller: a person is their own, and an agent's is the person who owns
/// it. `submitter` is who made the approved submission, with theirs. The submitter, the submitting agent's owner and
/// that owner's other agents are all refused, and so is anyone whose controlling person the room can't name. That is
/// what "a reviewer can't merge their own work" means (M5-10): a reviewer may merge what they approved only with the
/// grant and only if a different person controls them.
///
/// Being the reviewer, the requester, an admin or the owner isn't enough without the grant, and approval carries none
/// (AC-17). The review itself and the commit are `repo_merge::check_merge_authority`, which runs after this.
pub fn authorize_merge(
    caller: &Caller,
    caller_person: Option<&str>,
    task: &Task,
    submitter: &Actor,
    standing: &GrantStanding,
) -> Result<(), RepoDenial> {
    if caller.role == Role::None {
        return Err(RepoDenial::NotParticipant);
    }
    if !can_see_task(caller, task) {
        return Err(RepoDenial::Hidden);
    }
    let me = Actor {
        id: &caller.id,
        person: caller_person,
    };
    if same_controller(&me, submitter) || task.assignee.as_deref() == Some(caller.id.as_str()) {
        return Err(RepoDenial::SelfMerge);
    }
    check_standing(caller, GrantAction::Merge, standing)
}

/// Who sees the room's repository, its request and its state: a person who sees the whole room, as the read that M5
/// step 2 built answers. An agent learns of the repository only through a token for a task.
pub fn sees_repository(caller: &Caller) -> bool {
    caller.kind == PrincipalKind::Person && sees_whole_room(caller)
}

/// Who sees a grant on the room's repository: a human owner or admin sees every one, in Manage access, and each
/// participant sees their own.
pub fn sees_grant(caller: &Caller, grantee: &str) -> bool {
    sees_every_grant(caller) || (caller.role != Role::None && caller.id == grantee)
}

/// Who sees every grant on the room's repository, and every grant's events: a human owner or admin.
pub fn sees_every_grant(caller: &Caller) -> bool {
    caller.role != Role::None && is_human_admin(caller)
}

/// Who is shown a task's change: its pull request and what Podster observed of it (M5 step 7a). People who can see the
/// task, and the task's own assignee and reviewer. Not another agent, and not a guest, which is what someone who joined
/// through a public claim is, even though each may read the task. Run after the task's own read is allowed. It shows
/// and never authorizes.
pub fn sees_task_change(caller: &Caller, task: &Task) -> bool {
    if !can_see_task(caller, task) {
        return false;
    }
    let party = task.assignee.as_deref() == Some(caller.id.as_str()) || task.reviewer == caller.id;
    party
        || (caller.kind == PrincipalKind::Person
            && !matches!(caller.role, Role::Guest | Role::None))
}

/// Who may ask for a degraded repository link to be rechecked (M5 step 7b): a Podster operator, as a person, and
/// nobody in the room. Rules that drifted mean someone with admin rights touched the repository, and the room's own
/// people may be who did. `is_operator` is the Worker's check of the verified caller against its configured operators.
pub fn authorize_recheck(kind: PrincipalKind, is_operator: bool) -> Result<(), RepoDenial> {
    if kind == PrincipalKind::Person && is_operator {
        Ok(())
    } else {
        Err(RepoDenial::NotAllowed)
    }
}

/// Who may read a task's release status: its checks and its merge, as Podster last observed them (M5 step 8). Whoever
/// is shown the task's change, and whoever asked for its merge, who otherwise couldn't learn how it ended. Someone
/// who can't see the task is told it doesn't exist. It shows and never authorizes.
pub fn authorize_release_status(
    caller: &Caller,
    task: &Task,
    asked_for_its_merge: bool,
) -> Result<(), RepoDenial> {
    if caller.role == Role::None {
        return Err(RepoDenial::NotParticipant);
    }
    if !can_see_task(caller, task) {
        return Err(RepoDenial::Hidden);
    }
    if sees_task_change(caller, task) || asked_for_its_merge {
        Ok(())
    } else {
        Err(RepoDenial::NotAllowed)
    }
}
