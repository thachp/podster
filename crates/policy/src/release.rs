//! Who may configure release, ask for one, approve one, and see its state (ADR 0010; decisions 199, 200, 213 and 215).
//! Denies by default.
//!
//! | Action | Who |
//! | --- | --- |
//! | Switch release on or off, set its configuration | A person who is the room's owner or a room admin, with that authority holding. Never an agent (decision 215, AC-10, AC-11) |
//! | Ask for a release (`deploy_release`) | Someone who may release now: a current participant, not there through a public claim, holding a live `deploy` grant whose giver still holds authority; for an agent, also its connection and the person who linked it still in the organization (AC-17). Only in a public room (decision 213) |
//! | Approve or decline a release | A person who is the room's owner or a room admin, with that authority holding. Never an agent, whatever role is stored for it, and the grant doesn't matter |
//! | See the room's release configuration and every release | A human owner or admin |
//! | See a task's release status | Whoever can see the task |
//! | See an app's label, hosts and suspension | A Podster operator, as a person, and nothing private (decision 205) |
//!
//! What a release must satisfy beyond who is asking is `podster_core::release`. Approval of a task and a merge grant
//! give nothing toward a release (AC-17).

use podster_core::repo_grants::GrantRefusal;

use crate::{Caller, PrincipalKind, Role};

/// Why a release action was refused on who was asking or where.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseDenial {
    /// `not_a_participant`
    NotParticipant,
    /// `not_allowed`
    NotAllowed,
    /// `public_participant`: in the room only through a public claim.
    PublicParticipant,
    /// `release_needs_public_room`: only a public room releases (decision 213). Nothing is queued or stored to run later.
    NeedsPublicRoom,
    /// `agent_not_connected`: an agent whose connection is gone, or whose linking person has left the organization.
    AgentDisconnected,
    /// `grant_required`, `grant_expired` or `grant_stale`
    Grant(GrantRefusal),
}

impl ReleaseDenial {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            ReleaseDenial::NotParticipant => "not_a_participant",
            ReleaseDenial::NotAllowed => "not_allowed",
            ReleaseDenial::PublicParticipant => "public_participant",
            ReleaseDenial::NeedsPublicRoom => "release_needs_public_room",
            ReleaseDenial::AgentDisconnected => "agent_not_connected",
            ReleaseDenial::Grant(refusal) => refusal.code(),
        }
    }
}

/// Whether someone holds authority over the room's release: a person who is the room's owner or a room admin now, with
/// that authority still holding (decision 215). An agent never does.
pub fn holds_release_authority(kind: PrincipalKind, role: Role, authority_holds: bool) -> bool {
    kind == PrincipalKind::Person && matches!(role, Role::Owner | Role::Admin) && authority_holds
}

/// Who may switch release on or off and change its configuration. `authority_holds` is whether the caller's role still
/// stands, as the room reads it from its current rows.
pub fn authorize_release_config(
    caller: &Caller,
    authority_holds: bool,
) -> Result<(), ReleaseDenial> {
    if caller.role == Role::None {
        return Err(ReleaseDenial::NotParticipant);
    }
    if holds_release_authority(caller.kind, caller.role, authority_holds) {
        Ok(())
    } else {
        Err(ReleaseDenial::NotAllowed)
    }
}

/// Who may approve or decline a release: the same people as configure it. Holding the deployment grant gives nothing
/// here, and an agent never approves.
pub fn authorize_approval(caller: &Caller, authority_holds: bool) -> Result<(), ReleaseDenial> {
    authorize_release_config(caller, authority_holds)
}

/// One `deploy` grant row, as far as the decision needs it. The room's own row, never a caller's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeployGrant<'a> {
    pub principal: &'a str,
    /// Who gave it.
    pub delegated_by: &'a str,
    pub expires_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

/// The deployment grant check: the caller's own `deploy` grant, not revoked, not at its expiry, and given by someone who
/// still holds release authority now (`delegation_holder`, from [`delegation_holder`]). A grant dies with its giver's
/// authority, so holding one isn't enough.
pub fn check_deploy_grant(
    grant: Option<&DeployGrant>,
    principal: &str,
    delegation_holder: Option<&str>,
    now: i64,
) -> Result<(), GrantRefusal> {
    let grant = grant
        .filter(|g| g.principal == principal && g.revoked_at.is_none())
        .ok_or(GrantRefusal::GrantRequired)?;
    if grant.expires_at.is_some_and(|at| at <= now) {
        return Err(GrantRefusal::GrantExpired);
    }
    if delegation_holder != Some(grant.delegated_by) {
        return Err(GrantRefusal::GrantStale);
    }
    Ok(())
}

/// A grant's giver, if they still hold release authority: who `check_deploy_grant` compares against.
pub fn delegation_holder(
    giver_id: &str,
    kind: PrincipalKind,
    role: Role,
    authority_holds: bool,
) -> Option<&str> {
    holds_release_authority(kind, role, authority_holds).then_some(giver_id)
}

/// What the room reads about a caller who asks for a release, or about anyone whom "may release now" is asked of.
#[derive(Clone, Copy, Debug)]
pub struct ReleaseStanding<'a> {
    pub grant: Option<&'a DeployGrant<'a>>,
    /// The grant's giver if they still hold release authority, from [`delegation_holder`].
    pub delegation_holder: Option<&'a str>,
    /// In the room only through a public claim, now.
    pub through_public_claim: bool,
    /// For an agent: its connection holds, and the person who linked it is still in the organization. Ignored for a
    /// person.
    pub agent_connected: bool,
    pub now: i64,
}

/// Whether someone may release now: the test the command, the job's recheck and the "nobody left" trigger all use. A
/// current participant, not there through a public claim, a connected agent if an agent, holding a deployment grant
/// that counts.
pub fn may_release_now(
    id: &str,
    kind: PrincipalKind,
    role: Role,
    standing: &ReleaseStanding,
) -> Result<(), ReleaseDenial> {
    if role == Role::None {
        return Err(ReleaseDenial::NotParticipant);
    }
    if standing.through_public_claim {
        return Err(ReleaseDenial::PublicParticipant);
    }
    if kind == PrincipalKind::Agent && !standing.agent_connected {
        return Err(ReleaseDenial::AgentDisconnected);
    }
    check_deploy_grant(standing.grant, id, standing.delegation_holder, standing.now)
        .map_err(ReleaseDenial::Grant)
}

/// Who may ask for a release, at the command: someone in the room, then only in a public room, then someone who may
/// release now. A non-participant learns nothing of the room; a participant in a private room is told release needs a
/// public room before anything about their grant.
pub fn authorize_deploy_release(
    caller: &Caller,
    room_public: bool,
    standing: &ReleaseStanding,
) -> Result<(), ReleaseDenial> {
    if caller.role == Role::None {
        return Err(ReleaseDenial::NotParticipant);
    }
    if !room_public {
        return Err(ReleaseDenial::NeedsPublicRoom);
    }
    may_release_now(&caller.id, caller.kind, caller.role, standing)
}

/// Whether the room may have a release at all: only a public room releases. Asked at the command, at the approval, and
/// in every pass of the job, where a room made private is an unpublish trigger.
pub fn require_public_room(room_public: bool) -> Result<(), ReleaseDenial> {
    if room_public {
        Ok(())
    } else {
        Err(ReleaseDenial::NeedsPublicRoom)
    }
}

/// How much of a room's release state a caller sees.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseView {
    /// The configuration, every release, the app's hosts and its suspension: a human owner or admin.
    Full,
    /// One task's release status, beside its checks and merge, each with its time: whoever can see the task.
    TaskStatus,
    /// The app's label, hosts and suspension state, and nothing private: a Podster operator.
    OperatorApp,
    /// Nothing about a release: everyone else, and every public page.
    Nothing,
}

/// What a caller sees of a room's release state. `can_see_task` is the room's answer for the task asked about, if any;
/// `is_operator` the Worker's check of the verified caller against the deployment's operators. A public viewer, signed
/// in or not, sees nothing about a release on a public page.
pub fn release_view(caller: &Caller, can_see_task: bool, is_operator: bool) -> ReleaseView {
    if holds_release_authority(caller.kind, caller.role, true) {
        return ReleaseView::Full;
    }
    if caller.role != Role::None && can_see_task {
        return ReleaseView::TaskStatus;
    }
    if is_operator && caller.kind == PrincipalKind::Person {
        return ReleaseView::OperatorApp;
    }
    ReleaseView::Nothing
}
