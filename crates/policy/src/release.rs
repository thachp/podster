//! Who may configure release, ask for one, approve one, and see its state (ADR 0010; decisions 199, 200, 213 and 215).
//! Denies by default.
//!
//! | Action | Who |
//! | --- | --- |
//! | Switch release on or off, set its configuration | A person who is the room's owner or a room admin, with that authority holding; switching on or changing it only where release may happen at all ([`release_room_allows`]). Never an agent (decision 215, AC-10, AC-11) |
//! | Map a custom hostname, or remove one (M6 step 8) | The same people; asking only where release may happen at all, release switched on in the room among them; removing always ([`authorize_custom_hostname`]) |
//! | Give a `deploy` grant, or take one back (M6 step 6) | Giving: a person who is the room's owner or a room admin, with that authority holding, in a public room ([`authorize_deploy_grant`]), to a current participant who isn't there through a public claim (decision 209) and isn't a person from another organization (`podster_policy::repositories::may_receive_grant`). An agent never gives one, and may hold one. Taking back: whoever may take back any grant on the room's repository (`podster_policy::repositories::authorize_revoke`) |
//! | Ask for a release (`deploy_release`) | Someone who may release now: a current participant, not there through a public claim, holding a live `deploy` grant on the room's repository whose giver still holds authority; for an agent, also its connection and the person who linked it still in the organization (AC-17). Only where release may happen at all, a public room first (decision 213) |
//! | Ask for a release (`requestRelease`, M6 step 6; an agent through `deploy_release`, 6g) | The same, the requester's controlling person still in their organization: a person themselves, an agent the person who linked its credential, whose link must be the one recorded at the request ([`authorize_release_request`], [`controller_unchanged`]). A rollback is a person's alone ([`may_ask_for_release`]) |
//! | Approve a release | A person who is the room's owner or a room admin, with that authority holding, where release may happen at all. Never an agent, whatever role is stored for it, and the grant doesn't matter. Self-approval is allowed, and so is approving a release one's own agent asked for (the owner's decision of 2026-11-16) |
//! | Decline a release | The same people, wherever they may still act on the room: only a deleted room or organization refuses ([`authorize_decline`]) |
//! | See the room's release configuration and every release | A human owner or admin |
//! | See a task's release status | Whoever can see the task |
//! | See an app's label, hosts and suspension | A Podster operator, as a person, and nothing private (decision 205) |
//! | Take release from an organization, or give it back (decision 218's switch) | A Podster operator, as a person, alone ([`authorize_release_switch_set`]) |
//! | See an organization's release switch | A Podster operator, or a person who administers that organization ([`authorize_release_switch_read`]) |
//!
//! What a release must satisfy beyond who is asking is `podster_core::release`. Approval of a task and a merge grant
//! give nothing toward a release (AC-17).

use podster_core::release::NotDelegatedCause;
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
    /// `release_not_delegated`: an operator took the ability to release from the room's organization, by decision
    /// 218's release switch.
    NotDelegated,
    /// `release_not_delegated` too, on the wire: an operator took the organization's provisioning delegation back. It
    /// only refuses. [`ReleaseDenial::not_delegated_cause`] tells the two apart.
    ProvisioningNotDelegated,
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
            ReleaseDenial::ProvisioningNotDelegated => "release_not_delegated",
            ReleaseDenial::OffForDeployment => "release_off_for_deployment",
            ReleaseDenial::ReleaseOff => "release_off",
            ReleaseDenial::Deleted => "workspace_deleted",
            ReleaseDenial::OrganizationDeleted => "organization_deleted",
            ReleaseDenial::RepoNotReady => "repo_not_ready",
            ReleaseDenial::Grant(refusal) => refusal.code(),
        }
    }

    /// Which fact refused, for a denial answered `release_not_delegated`; `None` for every other. Kept in the audit
    /// record, since the wire code is the same for both.
    pub fn not_delegated_cause(self) -> Option<NotDelegatedCause> {
        match self {
            ReleaseDenial::NotDelegated => Some(NotDelegatedCause::ReleaseSwitch),
            ReleaseDenial::ProvisioningNotDelegated => {
                Some(NotDelegatedCause::ProvisioningDelegation)
            }
            _ => None,
        }
    }
}

/// Whether someone holds authority over the room's release: a person who is the room's owner or a room admin now, with
/// that authority still holding (decision 215). An agent never does.
pub fn holds_release_authority(kind: PrincipalKind, role: Role, authority_holds: bool) -> bool {
    kind == PrincipalKind::Person && matches!(role, Role::Owner | Role::Admin) && authority_holds
}

/// One admin row of the room, as the room reads it: what kind of principal it is, and whether its place in the room
/// still stands, which its removal, its organization revoked from the room, or its organization's departure ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AdminPlace {
    pub kind: PrincipalKind,
    pub place_stands: bool,
}

/// ADR 0010's "somebody who may release now remains", as the architect's interim rule (ruling 3 of 2026-11-13, for the
/// owner to review): some person who is the room's owner or one of its admins is in the room and still in their
/// organization (decision 215). `owner_holds` is whether the room records no departure of its owner from the room's
/// organization; `admins` is every row the room holds with the admin role. An agent never counts, whatever role is
/// stored for it. The room reads its rows and passes them here; this decides.
pub fn someone_may_release(owner_holds: bool, admins: &[AdminPlace]) -> bool {
    holds_release_authority(PrincipalKind::Person, Role::Owner, owner_holds)
        || admins
            .iter()
            .any(|admin| holds_release_authority(admin.kind, Role::Admin, admin.place_stands))
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
    /// The organization holds decision 218's release switch.
    pub organization_may_release: bool,
    /// The organization holds M5's provisioning delegation, which only refuses.
    pub organization_may_provision: bool,
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
        organization_may_provision: true,
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
/// recheck order (`podster_core::release::recheck`): the deployment, the organization gone, its release switch, its
/// provisioning delegation, the room deleted, private, archived, its public surface and app suspended, its repository, and release in the room.
pub fn release_room_allows(room: &ReleaseRoom) -> Result<(), ReleaseDenial> {
    let checks = [
        (
            room.deployment_allows_release,
            ReleaseDenial::OffForDeployment,
        ),
        (room.organization_exists, ReleaseDenial::OrganizationDeleted),
        (room.organization_may_release, ReleaseDenial::NotDelegated),
        (
            room.organization_may_provision,
            ReleaseDenial::ProvisioningNotDelegated,
        ),
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

/// Who may set an organization's release switch, taking release from it or giving it back: a Podster operator, as a
/// person, alone (decision 218). An organization's own admin can't, and an agent never can.
pub fn authorize_release_switch_set(
    kind: PrincipalKind,
    is_operator: bool,
) -> Result<(), ReleaseDenial> {
    if kind == PrincipalKind::Person && is_operator {
        Ok(())
    } else {
        Err(ReleaseDenial::NotAllowed)
    }
}

/// Who may read an organization's release switch: a Podster operator, or a person who administers that organization,
/// as for the provisioning delegation. An agent never.
pub fn authorize_release_switch_read(
    kind: PrincipalKind,
    is_operator: bool,
    administers_org: bool,
) -> Result<(), ReleaseDenial> {
    if kind == PrincipalKind::Person && (is_operator || administers_org) {
        Ok(())
    } else {
        Err(ReleaseDenial::NotAllowed)
    }
}

/// Whether a notice about an organization's release switch may act on a room: only one that names the organization
/// that owns the room. Notices reach a room only over the Worker's internal binding, from the organization's own
/// object; this is the room's own check that the organization named is its own, so a notice meant for another
/// organization, or one naming none, never moves this room's applied switch. *Added in PR C of decision 218.*
///
/// What the room does with a notice it accepts, taking release away, is Podster's act, never the operator's: it is
/// audited and told to the room's managers as Podster, and the operator who set the switch is in the operators' own
/// record of the set.
pub fn release_switch_notice_is_for_room(room_org: &str, notice_org: &str) -> bool {
    !room_org.is_empty() && room_org == notice_org
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

/// A change to the room's custom hostname (M6 step 8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostnameChange {
    /// Ask to map a hostname: the room gets a challenge.
    Request,
    /// Remove the mapping, or drop a pending request. It only takes down.
    Remove,
}

/// Who may map a custom hostname to the room's app, or remove one, and where (M6 step 8; decisions 201, 207 and 215):
/// the same people as configure release. Asking is a change to the release configuration, so it needs everything
/// release needs at all, release switched on in the room among them ([`release_room_allows`]). Removing is always
/// allowed to them, as switching release off is, since it only takes down. An agent never.
pub fn authorize_custom_hostname(
    caller: &Caller,
    authority_holds: bool,
    room: &ReleaseRoom,
    change: HostnameChange,
) -> Result<(), ReleaseDenial> {
    let config = match change {
        HostnameChange::Request => ConfigChange::Change,
        HostnameChange::Remove => ConfigChange::TurnOff,
    };
    authorize_release_config(caller, authority_holds, room, config)
}

/// Who may delete the room's app's data, in the room (M6 stage 1, S4 of the store plan): **the room's owner or one of its
/// admins, as a person,** while their authority holds (still in the organization their place here is held in), as the
/// owner decided in decision 220 (7) and ADR 0010's revision, row 7 of its summary: "may be deleted by an operator and
/// also by the room's owner or an admin, as a person". The same people as configure release
/// ([`holds_release_authority`]). Never a member, and never an agent, whatever role is stored for it. It only takes
/// away, so no fact about the room refuses it: archived, private, suspended or with release off, they may still delete.
/// A Podster operator deletes through the operators' own route, which isn't a room participant's and isn't decided
/// here.
pub fn authorize_app_data_delete(
    caller: &Caller,
    authority_holds: bool,
) -> Result<(), ReleaseDenial> {
    if caller.role == Role::None {
        return Err(ReleaseDenial::NotParticipant);
    }
    if !holds_release_authority(caller.kind, caller.role, authority_holds) {
        return Err(ReleaseDenial::NotAllowed);
    }
    Ok(())
}

/// The room's own facts the custom hostname's proof job reads before each look in DNS and each ask of the hostname's
/// object (M6 step 8): those asking checked that only the room's rows can say, read again now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostnameProofRoom {
    pub organization_exists: bool,
    /// The organization's release switch as the room last applied it; `None` when that can't be read.
    pub organization_may_release: Option<bool>,
    pub deleted: bool,
    pub public: bool,
    pub archived: bool,
    pub public_surface_suspended: bool,
    pub app_suspended: bool,
}

impl HostnameProofRoom {
    /// A room where nothing stands in the way.
    pub const OPEN: HostnameProofRoom = HostnameProofRoom {
        organization_exists: true,
        organization_may_release: Some(true),
        deleted: false,
        public: true,
        archived: false,
        public_surface_suspended: false,
        app_suspended: false,
    };
}

/// What the proof job may do next for a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostnameProofStep {
    /// Look, or ask.
    Go,
    /// A fact couldn't be read: nothing is looked up or asked, nothing ends, and the job looks again in its turn.
    Wait,
    /// A fact was read and fails, with its code: the request ends, withdrawn at the object if its proof was taken there.
    End(ReleaseDenial),
}

/// Whether the proof job may go on, in [`release_room_allows`]'s order. A fact read and failing ends the request even
/// while another can't be read; only when nothing read fails does an unread one make it wait.
pub fn hostname_proof_room(room: &HostnameProofRoom) -> HostnameProofStep {
    let checks = [
        (room.organization_exists, ReleaseDenial::OrganizationDeleted),
        (
            room.organization_may_release != Some(false),
            ReleaseDenial::NotDelegated,
        ),
        (!room.deleted, ReleaseDenial::Deleted),
        (room.public, ReleaseDenial::NeedsPublicRoom),
        (!room.archived, ReleaseDenial::Archived),
        (
            !room.public_surface_suspended,
            ReleaseDenial::PublicSurfaceSuspended,
        ),
        (!room.app_suspended, ReleaseDenial::AppSuspended),
    ];
    match checks.into_iter().find(|(holds, _)| !holds) {
        Some((_, denial)) => HostnameProofStep::End(denial),
        None if room.organization_may_release.is_none() => HostnameProofStep::Wait,
        None => HostnameProofStep::Go,
    }
}

/// Who may approve a release, and where: the same people as configure it (decision 215), where release may happen now. Holding the deployment grant gives nothing here, and isn't needed: an agent never approves. A person who
/// may approve may approve a release they asked for (decided by the architect on the review of PR #309), or that an agent
/// they control asked for (the owner's decision of 2026-11-16, "Yes, allow it"): the commit was already merged under
/// decision 195's independent review.
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
    /// A person whose place here is held through another organization than the room's, now. They never release, whatever
    /// grant exists (decision 239, CROSS-ORG-PEOPLE.md). Never true for an agent.
    pub outside_person: bool,
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
    if standing.outside_person {
        return Err(ReleaseDenial::NotAllowed);
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

/// The person who controls an agent, as the link its credential carries (M6 step 6, 6g): who linked the credential,
/// when that link began, which is the link's generation (a link made again after its person left begins again), and the
/// agent's connection generation, which every disconnect moves and with it every link of the agent's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControllerLink<'a> {
    pub person: &'a str,
    pub linked_since: i64,
    pub generation: u64,
}

/// Whether an agent's controlling link now is exactly the one recorded when it asked for a release: the same person,
/// the same link and the same connection. Both must be known: nothing on record, or nothing read now, is never a match,
/// and two missing values aren't one.
pub fn controller_unchanged(
    recorded: Option<&ControllerLink>,
    current: Option<&ControllerLink>,
) -> bool {
    matches!((recorded, current), (Some(recorded), Some(current)) if recorded == current)
}

/// Who may ask for a release (`requestRelease`; for an agent, the `deploy_release` capability, M6 step 6, 6g), and
/// where: [`authorize_deploy_release`], then the requester's controlling person still in the organization the request is
/// held in (`requester_holds`): for a person, their own record, as the job's recheck asks of a requester; for an agent,
/// the record of the person who linked its credential. **For an agent, `standing.agent_connected` is its connection and
/// [`controller_unchanged`]:** an agent whose controlling link isn't the one recorded, or whose controlling person left,
/// is refused as no longer connected. An agent never asks through a public claim (decision 159): that is refused before
/// its grant is looked at.
pub fn authorize_release_request(
    caller: &Caller,
    room: &ReleaseRoom,
    standing: &ReleaseStanding,
    requester_holds: bool,
) -> Result<(), ReleaseDenial> {
    may_ask_for_deploy(caller, true)?;
    authorize_deploy_release(caller, room, standing)?;
    if !requester_holds {
        return Err(match caller.kind {
            PrincipalKind::Agent => ReleaseDenial::AgentDisconnected,
            _ => ReleaseDenial::NotAllowed,
        });
    }
    Ok(())
}

/// The part of [`authorize_release_request`] the room's rows and the caller's credential alone answer, asked before
/// anything is read outside the room: someone in the room, and, for an agent, a controlling person on its credential
/// (`controller_known`). A person is their own controller.
pub fn may_ask_for_deploy(caller: &Caller, controller_known: bool) -> Result<(), ReleaseDenial> {
    if caller.role == Role::None {
        return Err(ReleaseDenial::NotParticipant);
    }
    if caller.kind == PrincipalKind::Agent && !controller_known {
        return Err(ReleaseDenial::AgentDisconnected);
    }
    Ok(())
}

/// Who may give a `deploy` grant (M6 step 6), and where: a person who is the room's owner or a room admin, with that
/// authority holding (decisions 200 and 215, AC-10, AC-11), in a public room (decisions 199 and 213: only a public room
/// releases, so a grant elsewhere would be a row nothing could use). An agent never, whatever role is stored for it.
/// Who may hold one is `podster_policy::repositories::may_receive_grant`, as for a repository grant: never someone in
/// the room only through a public claim (decision 209). Nothing else about release is asked here: a grant authorizes
/// nothing by itself, and [`check_deploy_grant`] runs at the request, the approval and every pass of the job.
pub fn authorize_deploy_grant(
    caller: &Caller,
    authority_holds: bool,
    room_public: bool,
) -> Result<(), ReleaseDenial> {
    if caller.role == Role::None {
        return Err(ReleaseDenial::NotParticipant);
    }
    if !holds_release_authority(caller.kind, caller.role, authority_holds) {
        return Err(ReleaseDenial::NotAllowed);
    }
    require_public_room(room_public)
}

/// Who may ask for a rollback (`rollbackRelease`, 6h), by the room's rows alone, asked before anything is read outside
/// the room: someone in the room, and a person. No capability reaches a rollback.
pub fn may_ask_for_release(caller: &Caller) -> Result<(), ReleaseDenial> {
    if caller.role == Role::None {
        return Err(ReleaseDenial::NotParticipant);
    }
    if caller.kind != PrincipalKind::Person {
        return Err(ReleaseDenial::NotAllowed);
    }
    Ok(())
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
