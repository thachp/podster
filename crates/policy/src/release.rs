//! Who may configure release, ask for one, approve one, and see its state (ADR 0010; decisions 199, 200, 213 and 215).
//! Denies by default.
//!
//! | Action | Who |
//! | --- | --- |
//! | Switch release on or off, set its configuration | A person who is the room's owner or a room admin, with that authority holding; switching on or changing it only where release may happen at all ([`release_room_allows`]). Never an agent (decision 215, AC-10, AC-11) |
//! | Ask for a release (`deploy_release`) | Someone who may release now: a current participant, not there through a public claim, holding a live `deploy` grant on the room's repository whose giver still holds authority; for an agent, also its connection and the person who linked it still in the organization (AC-17). Only where release may happen at all, a public room first (decision 213) |
//! | Approve a release | A person who is the room's owner or a room admin, with that authority holding, where release may happen at all. Never an agent, whatever role is stored for it, and the grant doesn't matter. Self-approval is allowed (decided by the architect, for the owner to review) |
//! | Decline a release | The same people, wherever they may still act on the room: only a deleted room or organization refuses ([`authorize_decline`]) |
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
    /// `workspace_archived`
    Archived,
    /// `public_surface_suspended`: an operator suspended the room's public surface (M4).
    PublicSurfaceSuspended,
    /// `app_suspended`: an operator suspended the room's app.
    AppSuspended,
    /// `release_not_delegated`: an operator took the ability to release from the room's organization.
    NotDelegated,
    /// `release_off_for_deployment`: the deployment's own configuration doesn't allow release.
    OffForDeployment,
    /// `release_off`: release is switched off in the room. Added after the second review of PR #309.
    ReleaseOff,
    /// `workspace_deleted`. Added after the second review of PR #309.
    Deleted,
    /// `organization_deleted`. Added after the second review of PR #309.
    OrganizationDeleted,
    /// `repo_not_ready`: the room's repository is stopped, gone, or its link isn't ready. Added after the second review
    /// of PR #309.
    RepoNotReady,
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
            ReleaseDenial::Archived => "workspace_archived",
            ReleaseDenial::PublicSurfaceSuspended => "public_surface_suspended",
            ReleaseDenial::AppSuspended => "app_suspended",
            ReleaseDenial::NotDelegated => "release_not_delegated",
            ReleaseDenial::OffForDeployment => "release_off_for_deployment",
            ReleaseDenial::ReleaseOff => "release_off",
            ReleaseDenial::Deleted => "workspace_deleted",
            ReleaseDenial::OrganizationDeleted => "organization_deleted",
            ReleaseDenial::RepoNotReady => "repo_not_ready",
            ReleaseDenial::Grant(refusal) => refusal.code(),
        }
    }
}

/// Whether someone holds authority over the room's release: a person who is the room's owner or a room admin now, with
/// that authority still holding (decision 215). An agent never does.
pub fn holds_release_authority(kind: PrincipalKind, role: Role, authority_holds: bool) -> bool {
    kind == PrincipalKind::Person && matches!(role, Role::Owner | Role::Admin) && authority_holds
}

/// What the room and its deployment say, now, about whether release may happen there at all. Read from the room's
/// current state and its organization's, never from a caller. Every `podster_core::release::UnpublishTrigger` but
/// `NoReleaserLeft` has its field here, so each is refused at the command; "nobody may release" is the caller's own
/// test, [`may_release_now`].
///
/// **Step 2 must also call `podster_core::release::recheck` at the command,** with the same facts it will pass the
/// job, so a command and the job's first pass can't disagree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseRoom {
    pub deployment_allows_release: bool,
    pub organization_may_release: bool,
    pub public: bool,
    pub archived: bool,
    pub public_surface_suspended: bool,
    pub app_suspended: bool,
    /// Added after the second review of PR #309.
    pub release_on_in_room: bool,
    /// Added after the second review of PR #309.
    pub deleted: bool,
    /// Added after the second review of PR #309.
    pub organization_exists: bool,
    /// Added after the second review of PR #309.
    pub repository_ready: bool,
}

impl ReleaseRoom {
    /// A room where nothing stands in the way.
    pub const OPEN: ReleaseRoom = ReleaseRoom {
        deployment_allows_release: true,
        organization_may_release: true,
        public: true,
        archived: false,
        public_surface_suspended: false,
        app_suspended: false,
        release_on_in_room: true,
        deleted: false,
        organization_exists: true,
        repository_ready: true,
    };
}

/// Whether release may happen in the room at all, with the ADR's code for the first reason it can't, in the job's
/// recheck order (`podster_core::release::recheck`): the deployment, the organization gone, the organization's ability,
/// the room deleted, private, archived, its public surface and app suspended, its repository, and release in the room.
pub fn release_room_allows(room: &ReleaseRoom) -> Result<(), ReleaseDenial> {
    let checks = [
        (
            room.deployment_allows_release,
            ReleaseDenial::OffForDeployment,
        ),
        (room.organization_exists, ReleaseDenial::OrganizationDeleted),
        (room.organization_may_release, ReleaseDenial::NotDelegated),
        (!room.deleted, ReleaseDenial::Deleted),
        (room.public, ReleaseDenial::NeedsPublicRoom),
        (!room.archived, ReleaseDenial::Archived),
        (
            !room.public_surface_suspended,
            ReleaseDenial::PublicSurfaceSuspended,
        ),
        (!room.app_suspended, ReleaseDenial::AppSuspended),
        (room.repository_ready, ReleaseDenial::RepoNotReady),
        (room.release_on_in_room, ReleaseDenial::ReleaseOff),
    ];
    match checks.into_iter().find(|(holds, _)| !holds) {
        Some((_, denial)) => Err(denial),
        None => Ok(()),
    }
}

/// A change to the room's release configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigChange {
    /// Switch release on.
    TurnOn,
    /// Change the configuration while it is on.
    Change,
    /// Switch release off. Always allowed to whoever may configure it, whatever the room's state: it only takes down.
    TurnOff,
}

/// Who may switch release on or off and change its configuration, and where: a person who is the room's owner or a
/// room admin, with that authority holding (`authority_holds`, as the room reads it from its current rows); and, except
/// to switch it off, only where [`release_room_allows`] does. An agent never, whatever role is stored for it.
pub fn authorize_release_config(
    caller: &Caller,
    authority_holds: bool,
    room: &ReleaseRoom,
    change: ConfigChange,
) -> Result<(), ReleaseDenial> {
    if caller.role == Role::None {
        return Err(ReleaseDenial::NotParticipant);
    }
    if !holds_release_authority(caller.kind, caller.role, authority_holds) {
        return Err(ReleaseDenial::NotAllowed);
    }
    match change {
        ConfigChange::TurnOff => Ok(()),
        // Switching it on is what changes `release_on_in_room`, so that one fact doesn't refuse it.
        ConfigChange::TurnOn => release_room_allows(&ReleaseRoom {
            release_on_in_room: true,
            ..*room
        }),
        ConfigChange::Change => release_room_allows(room),
    }
}

/// Who may approve a release, and where: the same people as configure it (decision 215), where release may happen now. Holding the deployment grant gives nothing here, and isn't needed: an agent never approves. A person who
/// may approve may approve a release they asked for, or that an agent they control asked for (decided by the architect
/// on the review of PR #309, for the owner to review): the commit was already merged under decision 195's independent
/// review.
pub fn authorize_approval(
    caller: &Caller,
    authority_holds: bool,
    room: &ReleaseRoom,
) -> Result<(), ReleaseDenial> {
    authorize_release_config(caller, authority_holds, room, ConfigChange::Change)
}

/// Who may decline a release, and where: the same people as approve it, wherever they may still act on the room at all.
/// Declining only ever reduces what is published, so a private, archived or suspended room, a repository not ready,
/// release switched off in the room or for the deployment, and an organization whose ability was taken back all allow
/// it. Only a deleted room or a deleted organization refuses, because then there is no room left to act on.
pub fn authorize_decline(
    caller: &Caller,
    authority_holds: bool,
    room: &ReleaseRoom,
) -> Result<(), ReleaseDenial> {
    if caller.role == Role::None {
        return Err(ReleaseDenial::NotParticipant);
    }
    if !holds_release_authority(caller.kind, caller.role, authority_holds) {
        return Err(ReleaseDenial::NotAllowed);
    }
    if !room.organization_exists {
        return Err(ReleaseDenial::OrganizationDeleted);
    }
    if room.deleted {
        return Err(ReleaseDenial::Deleted);
    }
    Ok(())
}

/// One `deploy` grant row, as far as the decision needs it. The room's own row, never a caller's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeployGrant<'a> {
    pub principal: &'a str,
    /// The row's action, as stored: only `deploy` is a deployment grant.
    pub action: &'a str,
    /// The repository the grant is on, by GitHub's ID.
    pub provider_repo_id: i64,
    /// Who gave it.
    pub delegated_by: &'a str,
    pub expires_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

/// The action a deployment grant's row holds.
pub const DEPLOY_ACTION: &str = "deploy";

/// The deployment grant check: the caller's own grant, for exactly the `deploy` action on exactly the room's linked
/// repository (`link_repo_id`), not revoked, not at its expiry, and given by someone who still holds release authority
/// now (`delegation_holder`, from [`delegation_holder`]). A grant for another action or repository is no grant at all,
/// as for M5's grants, and a grant dies with its giver's authority, so holding one isn't enough.
pub fn check_deploy_grant(
    grant: Option<&DeployGrant>,
    principal: &str,
    link_repo_id: i64,
    delegation_holder: Option<&str>,
    now: i64,
) -> Result<(), GrantRefusal> {
    let grant = grant
        .filter(|g| {
            g.principal == principal
                && g.action == DEPLOY_ACTION
                && g.provider_repo_id == link_repo_id
                && g.revoked_at.is_none()
        })
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
    /// The room's own linked repository.
    pub link_repo_id: i64,
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
    check_deploy_grant(
        standing.grant,
        id,
        standing.link_repo_id,
        standing.delegation_holder,
        standing.now,
    )
    .map_err(ReleaseDenial::Grant)
}

/// Who may ask for a release, at the command: someone in the room, then only where [`release_room_allows`] does, a
/// public room first among those, then someone who may release now. A non-participant learns nothing of the room; a
/// participant in a private room is told release needs a public room before anything about their grant.
pub fn authorize_deploy_release(
    caller: &Caller,
    room: &ReleaseRoom,
    standing: &ReleaseStanding,
) -> Result<(), ReleaseDenial> {
    if caller.role == Role::None {
        return Err(ReleaseDenial::NotParticipant);
    }
    release_room_allows(room)?;
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

/// What a caller sees of a room's release state. `authority_holds` is whether the caller's owner or admin role still
/// stands, so a lapsed owner doesn't see everything; `can_see_task` is the room's answer for the task asked about, if
/// any; `is_operator` the Worker's check of the verified caller against the deployment's operators. A public viewer,
/// signed in or not, sees nothing about a release on a public page.
pub fn release_view(
    caller: &Caller,
    authority_holds: bool,
    can_see_task: bool,
    is_operator: bool,
) -> ReleaseView {
    if holds_release_authority(caller.kind, caller.role, authority_holds) {
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
