//! Who may grant, use and see a room's repository (ADR 0009, which is proposed; decisions 18 and 186). Denies by default.
//!
//! What a grant, a token request or a merge must satisfy beyond who is asking is `podster_core::repo_grants`,
//! `repo_access` and `repo_merge`. Nothing here takes an organization, an installation, a repository or a pull request
//! from a caller.
//!
//! | Action | Who |
//! | --- | --- |
//! | Ask for the room's repository, or retry its setup | A person who is the room's owner or a room admin, whose authority holds. Never an agent (AC-10) |
//! | Give a `push` or `merge` grant | The same: a person who is the room's owner or a room admin, whose authority holds. Never an agent, whatever role is stored for it, and nobody without that room role (AC-10, AC-11) |
//! | Take a grant back | The room's owner or a room admin, as a person; a person who administers the room's organization, so a grant can be pulled when the owner has left; and the grant's holder, for their own. Nobody else, and an agent never takes back another's |
//! | Receive a grant | A current participant, person or agent, who isn't there through a public claim |
//! | Ask for a repository token | The agent the task is assigned to, not there through a public claim, with a `push` grant that counts |
//! | Ask for a merge | A person or agent who can see the task, isn't there through a public claim, holds a `merge` grant that counts, and isn't controlled by the person who controls the submitter; and the commit's approving review came from someone the submitter's person doesn't control ([`independent_review`]) |
//! | See the room's repository and its state | A person who sees the whole room |
//! | See who holds grants | A human owner or admin, and each participant their own |
//! | See a task's change and merge state | Whoever can see the task |
//!
//! A grant counts only while it's live and its giver is still a person who is the room's owner or a room admin, with
//! their authority holding: see [`holds_repository_delegation`] and `repo_grants::check_grant`. The owner's decision of
//! 2026-11-11 ("Owner and admins") replaced the earlier rule that only the room's owner held the delegation.
//! Reviewing a task carries no grant, and neither does a role, a work-role title, an A2A message or a public claim
//! (AC-17, AC-24).
//!
//! **Order.** A route runs the function here before the decision in `podster_core`. These answer `task_not_found` to a
//! caller who can't see the task. The core decisions answer `task_not_linked` and `repo_not_ready` before they look at
//! a grant, so run alone they'd tell such a caller something about the task.

use podster_core::repo_grants::{check_grant, Grant, GrantRefusal, GrantUse};
use podster_core::repo_merge::{same_controller, Actor, MergeRefusal};
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
    /// `self_review`: the commit's approving review came from someone the submitter's own person controls, or from
    /// someone whose controlling person the room didn't record. It needs an independent review before it's merged.
    SelfReview,
    /// `self_review` as well, for an approval recorded before the room kept who gave it: the review may well have been
    /// independent, and nothing says so, so the commit needs to be reviewed again before it's merged. Its own variant so
    /// the answer can say that rather than ask for someone else.
    ReviewUnrecorded,
    /// `grant_required`, `grant_expired` or `grant_stale`
    Grant(GrantRefusal),
}

impl RepoDenial {
    /// The same refusal as a merge records it when the job's recheck finds the requester's authority gone, with the code
    /// the request itself would have answered.
    pub fn as_merge_refusal(self) -> MergeRefusal {
        match self {
            RepoDenial::NotParticipant => MergeRefusal::AccessRevoked,
            RepoDenial::Hidden => MergeRefusal::TaskHidden,
            RepoDenial::PublicParticipant => MergeRefusal::PublicParticipant,
            RepoDenial::SelfMerge => MergeRefusal::SelfMerge,
            RepoDenial::SelfReview | RepoDenial::ReviewUnrecorded => MergeRefusal::SelfReview,
            RepoDenial::Grant(refusal) => MergeRefusal::Grant(refusal),
            RepoDenial::NotAllowed
            | RepoDenial::GranteeNotParticipant
            | RepoDenial::GranteePublic => MergeRefusal::NotAllowed,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            RepoDenial::NotParticipant => "not_a_participant",
            RepoDenial::Hidden => "task_not_found",
            RepoDenial::NotAllowed => "not_allowed",
            RepoDenial::GranteeNotParticipant => "grantee_not_participant",
            RepoDenial::GranteePublic => "grantee_public",
            RepoDenial::PublicParticipant => "public_participant",
            RepoDenial::SelfMerge => "self_merge",
            RepoDenial::SelfReview | RepoDenial::ReviewUnrecorded => "self_review",
            RepoDenial::Grant(refusal) => refusal.code(),
        }
    }
}

/// Whether someone holds authority over the room's repository: to ask for it, and to give and take back its grants.
/// Podster's platform owns a managed repository and delegates it to those who run the room, for that repository only
/// (decision 18, as the owner changed it on 2026-11-11: "Owner and admins"). So it's a person who is the room's owner
/// or a room admin now, with that authority still holding, which the room reads from its own current rows and the
/// person's standing in their organization. An agent stored as an owner or admin holds nothing, as everywhere else. A
/// participant there through a public claim is a guest by definition, so never passes.
pub fn holds_repository_delegation(kind: PrincipalKind, role: Role, authority_holds: bool) -> bool {
    kind == PrincipalKind::Person && matches!(role, Role::Owner | Role::Admin) && authority_holds
}

/// A grant's giver, for `GrantUse::delegation_holder`, if they still hold authority over the room's repository:
/// `kind` and `role` are what the room records for them now, and `authority_holds` whether that role still stands.
/// Nobody otherwise. A grant counts at use only if this is who gave it.
pub fn delegation_holder(
    giver_id: &str,
    kind: PrincipalKind,
    role: Role,
    authority_holds: bool,
) -> Option<&str> {
    holds_repository_delegation(kind, role, authority_holds).then_some(giver_id)
}

/// Who may ask for the room's repository or retry its setup, and who may give a grant on it: a person who is the
/// room's owner or a room admin. The caller's role is the one the room resolved from its current rows, which gives a
/// role only while it stands. An agent is refused whatever role is stored for it (AC-10), and so is a person with any
/// other role (AC-11). Nothing a client sends is read.
pub fn authorize_repository_admin(caller: &Caller) -> Result<(), RepoDenial> {
    if caller.role == Role::None {
        return Err(RepoDenial::NotParticipant);
    }
    if !holds_repository_delegation(caller.kind, caller.role, true) {
        return Err(RepoDenial::NotAllowed);
    }
    Ok(())
}

/// Who may give a grant on the room's repository: see [`authorize_repository_admin`].
pub fn authorize_grant(caller: &Caller) -> Result<(), RepoDenial> {
    authorize_repository_admin(caller)
}

/// Whether the caller administers an organization: a person whose verified identity lists it among the organizations
/// they administer. An agent never does. `org` is the organization in question, from the room's own row or the route,
/// never from a body; `None` when there isn't one, and then nobody does.
pub fn administers_org(kind: PrincipalKind, admin_orgs: &[String], org: Option<&str>) -> bool {
    kind == PrincipalKind::Person && org.is_some_and(|org| admin_orgs.iter().any(|o| o == org))
}

/// Who may read an organization's provisioning delegation: a Podster operator, as a person, or a person who administers
/// that organization ([`administers_org`]). `is_operator` is the Worker's check of the verified caller.
pub fn authorize_delegation_read(
    kind: PrincipalKind,
    is_operator: bool,
    administers_org: bool,
) -> Result<(), RepoDenial> {
    if kind == PrincipalKind::Person && (is_operator || administers_org) {
        Ok(())
    } else {
        Err(RepoDenial::NotAllowed)
    }
}

/// Who may set an organization's provisioning delegation: a Podster operator, as a person, alone. An organization's own
/// admin can't give it authority over Podster's GitHub organization.
pub fn authorize_delegation_set(kind: PrincipalKind, is_operator: bool) -> Result<(), RepoDenial> {
    if kind == PrincipalKind::Person && is_operator {
        Ok(())
    } else {
        Err(RepoDenial::NotAllowed)
    }
}

/// Who may take a grant back:
///
/// - its holder, their own, whoever they are and whether or not they're still in the room;
/// - the room's owner or a room admin, as a person, any grant;
/// - a person who administers the room's organization ([`administers_org`]), any grant, with or without a place in the
///   room, so a grant can be pulled when the owner has left (AC-11).
///
/// Nobody else: not a member, the reviewer or whoever gave the grant, once they're no longer the owner or an admin.
/// An agent never takes back another principal's grant, whatever role is stored for it.
pub fn authorize_revoke(
    caller: &Caller,
    grantee: &str,
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
    if holds_repository_delegation(caller.kind, caller.role, true) {
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
    /// The grant's giver, if they still hold authority over the room's repository, from [`delegation_holder`].
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

/// Whether the review that made a task's commit the reviewed one counts for a merge into a managed repository: the
/// owner's decision of 2026-11-11 on review A1. It must come from someone independent of the submitter, which means the
/// reviewer's controlling person differs from the submitter's: a person is their own, and an agent's is whoever linked
/// the credential it came with, per credential and as recorded when it approved, as [`authorize_merge`] reads the
/// merger's. A person or an agent may review, and a person or an agent may merge. A controlling person the room didn't
/// record, on either side, refuses, as `self_merge` does: an approval recorded before the room kept its reviewer is one.
///
/// `reviewer` is `None` only when no approval with a reviewed commit is on record, and then this says nothing: the core
/// decision refuses that as `not_approved` or `review_required`. Ordinary task review isn't touched: the submitter's own
/// person may still approve the task, and only its merge is refused. Run after [`authorize_merge`] allows, so a caller
/// who may not merge learns nothing about the review. It compares Podster accounts: one human with two accounts isn't
/// something it can see.
pub fn independent_review(reviewer: Option<&Actor>, submitter: &Actor) -> Result<(), RepoDenial> {
    match reviewer {
        // Who approved, or the person who controlled them then, wasn't recorded: reviewed again, it's known.
        Some(reviewer) if reviewer.id.is_empty() || reviewer.person.is_none() => {
            Err(RepoDenial::ReviewUnrecorded)
        }
        Some(reviewer) if same_controller(reviewer, submitter) => Err(RepoDenial::SelfReview),
        _ => Ok(()),
    }
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

/// Who is told, in the room read, whether each participant joined through a public claim: those who manage the room's
/// access, a human owner or admin, by the caller's current role. It's information for the grant form, which offers no
/// grant a participant can't hold. It shows and never authorizes: `may_receive_grant` decides a grant from the room's own
/// row at the time.
pub fn sees_join_source(caller: &Caller) -> bool {
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
) -> Result<ReleaseView, RepoDenial> {
    if caller.role == Role::None {
        return Err(RepoDenial::NotParticipant);
    }
    if !can_see_task(caller, task) {
        return Err(RepoDenial::Hidden);
    }
    if sees_task_change(caller, task) {
        Ok(ReleaseView::Whole)
    } else if asked_for_its_merge {
        Ok(ReleaseView::MergeOnly)
    } else {
        Err(RepoDenial::NotAllowed)
    }
}

/// How much of a release status a caller is shown. Never more than their view of the task's change shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseView {
    /// The pull request, the checks and the merge: for those shown the task's change.
    Whole,
    /// The merge alone, for whoever asked for it and isn't shown the change: how their request ended, and nothing
    /// of the pull request or its checks.
    MergeOnly,
}
