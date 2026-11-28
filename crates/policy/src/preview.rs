//! Who may view a room's preview, and who may make, replace, delete or map one (M8 step 4; the preview plan,
//! `docs/m8-preview-plan.md`, sections 5.3, 5.6, 5.7 and 9.1; decisions 251, 252 and 253). Denies by default.
//!
//! | Action | Who |
//! | --- | --- |
//! | View a preview: open its host, read `getPreview` ([`may_view`]) | A **person** whose own role in the room is owner, admin, member or guest, their place still holding: a person from another organization with an accepted person invitation has their own role and may (decision 239). **Not** an agent, someone here only through a public claim, an organization admin's read-only oversight, or a person with no role here. A public room's preview too (decision 252) |
//! | Make or replace a preview, map or check its custom hostname ([`PreviewChange`]) | The room's owner or an admin, **as a person**, still in the organization their place here is held in, with no grant (decision 253); where previews are on and everything release needs holds **but a public room** (decision 251). Never an agent, whatever role is stored for it |
//! | Delete a preview, remove its custom hostname | The same people; no gate, since it only takes down |
//! | Read the custom preview hostname's setup facts | The same people, while previews are on |
//!
//! `previews_off` always comes after who is asking, as release switched off does: the room answers who first. A preview's
//! room facts are production's (`crate::release::release_room_allows`) with the room's visibility left out.
//!
//! The access route (`/v1/preview-access`) answers every refusal with one code, `preview_access_refused`, so it never
//! tells anyone which hosts exist ([`decide_access`]).

use podster_core::preview::DeploymentPreviews;

use crate::release::{release_room_allows, ReleaseDenial, ReleaseRoom};
use crate::{Caller, PrincipalKind, Role};

/// Why a preview action was refused on who was asking or where.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewDenial {
    /// `not_a_participant`: no role in the room.
    NotParticipant,
    /// `not_allowed`: an agent; a person without the role the action needs; or one whose place, or whose owner or admin
    /// authority, no longer holds.
    NotAllowed,
    /// `public_participant`: in the room only through a public claim.
    PublicParticipant,
    /// `previews_off`: `PREVIEWS` is anything but exactly `true`.
    PreviewsOff,
    /// One of release's room facts, by its own code: everything release needs but a public room.
    Release(ReleaseDenial),
}

impl PreviewDenial {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            PreviewDenial::NotParticipant => "not_a_participant",
            PreviewDenial::NotAllowed => "not_allowed",
            PreviewDenial::PublicParticipant => "public_participant",
            PreviewDenial::PreviewsOff => "previews_off",
            PreviewDenial::Release(denial) => denial.code(),
        }
    }
}

/// What the room reads, now, about a person who would view: whether their place is only a public claim, and whether it
/// still holds (their organization, for a person of the room's own; their accepted invitation, for one from another),
/// as the room reads it from its own rows and the gateway's assertion (decision 30).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ViewStanding {
    pub through_public_claim: bool,
    pub place_holds: bool,
}

/// **Who may view a preview** (the plan's 5.7; decisions 252 and 253): a person with a role of their own in the room,
/// not there through a public claim, whose place still holds. The dashboard's own rule for seeing the room
/// (`crate::authorize_workroom`): owner, admins, members and guests. In this order: no role; an agent, which doesn't
/// browse and gets no ticket, whatever role is stored for it; a public claim; a place that no longer holds.
pub fn may_view(caller: &Caller, standing: ViewStanding) -> Result<(), PreviewDenial> {
    if caller.role == Role::None {
        return Err(PreviewDenial::NotParticipant);
    }
    if caller.kind != PrincipalKind::Person {
        return Err(PreviewDenial::NotAllowed);
    }
    if standing.through_public_claim {
        return Err(PreviewDenial::PublicParticipant);
    }
    if !standing.place_holds {
        return Err(PreviewDenial::NotAllowed);
    }
    Ok(())
}

/// Who may read the room's preview (`getPreview`): whoever [`may_view`], and then only while previews are on.
pub fn authorize_preview_read(
    caller: &Caller,
    standing: ViewStanding,
    previews: DeploymentPreviews,
) -> Result<(), PreviewDenial> {
    may_view(caller, standing)?;
    if !previews.allows_previews() {
        return Err(PreviewDenial::PreviewsOff);
    }
    Ok(())
}

/// A change to the room's preview, or a read of its custom hostname's setup (the plan's 9.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewChange {
    /// `requestPreview`: create or replace from a task's merged commit.
    Request,
    /// `deletePreview`. It only takes down.
    Delete,
    /// `getPreviewHostname`: the custom preview hostname's whole request, setup facts included.
    HostnameRead,
    /// `requestPreviewHostname`.
    HostnameRequest,
    /// `removePreviewHostname`. It only takes down.
    HostnameRemove,
    /// `checkPreviewHostname`.
    HostnameCheck,
}

/// **Who may change the room's preview, and where** (the plan's 9.1; decisions 251 and 253). In the contract's order:
///
/// 1. Who, on the room's rows: no role is `not_a_participant`; anyone but a person who is the room's owner or an admin
///    is `not_allowed`: every agent, an agent stored as owner or admin included, and every member and guest. No grant
///    is asked for or counts.
/// 2. Deleting and removing stop here but for the asker's own record: they only take down, so they pass no gate,
///    `previews_off` included, in an archived, private or suspended room too.
/// 3. `previews_off`, after who is asking.
/// 4. For a request and a check, everything release needs at all ([`release_room_allows`]) **but a public room**: a
///    private room may have a preview (decision 251), so `release_needs_public_room` is never the answer. A read of the
///    hostname's setup asks none of these.
/// 5. Last, the asker still in the organization their place here is held in (`authority_holds`): `not_allowed`.
pub fn authorize_preview_change(
    caller: &Caller,
    authority_holds: bool,
    previews: DeploymentPreviews,
    room: &ReleaseRoom,
    change: PreviewChange,
) -> Result<(), PreviewDenial> {
    if caller.role == Role::None {
        return Err(PreviewDenial::NotParticipant);
    }
    let owner_or_admin =
        caller.kind == PrincipalKind::Person && matches!(caller.role, Role::Owner | Role::Admin);
    if !owner_or_admin {
        return Err(PreviewDenial::NotAllowed);
    }
    match change {
        PreviewChange::Delete | PreviewChange::HostnameRemove => {}
        PreviewChange::HostnameRead => {
            if !previews.allows_previews() {
                return Err(PreviewDenial::PreviewsOff);
            }
        }
        PreviewChange::Request | PreviewChange::HostnameRequest | PreviewChange::HostnameCheck => {
            if !previews.allows_previews() {
                return Err(PreviewDenial::PreviewsOff);
            }
            release_room_allows(&ReleaseRoom {
                public: true,
                ..*room
            })
            .map_err(PreviewDenial::Release)?;
        }
    }
    if !authority_holds {
        return Err(PreviewDenial::NotAllowed);
    }
    Ok(())
}

/// What the room reads, from its own state alone, about the host a person asks to open (the plan's 5.3, step 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccessFacts {
    /// The host is the room's current preview host, default or custom. A production host, another room's host and an
    /// unknown one are all not.
    pub host_is_rooms_preview_host: bool,
    pub preview_exists: bool,
    /// An operator suspended the preview's label or the host.
    pub preview_suspended: bool,
}

/// Why access to a preview host was refused. **Every one answers `preview_access_refused` (404)**, so the route never
/// tells anyone which hosts exist, which room holds one, or whether they lack access (the plan's 5.3, step 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewAccessRefusal {
    NotThisRoomsPreviewHost,
    NoPreview,
    Suspended,
    Viewer(PreviewDenial),
}

impl PreviewAccessRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        "preview_access_refused"
    }
}

/// **Whether a person gets a ticket for a preview host** (the plan's 5.3, step 3): the host must be the room's current
/// preview host, the preview must exist and not be suspended, and the caller must pass [`may_view`] now. The host is
/// checked first, so nothing about the caller is asked of a host that isn't this room's. The limits come before this,
/// in their own objects (`podster_core::preview_access`).
pub fn decide_access(
    caller: &Caller,
    standing: ViewStanding,
    facts: AccessFacts,
) -> Result<(), PreviewAccessRefusal> {
    if !facts.host_is_rooms_preview_host {
        return Err(PreviewAccessRefusal::NotThisRoomsPreviewHost);
    }
    if !facts.preview_exists {
        return Err(PreviewAccessRefusal::NoPreview);
    }
    if facts.preview_suspended {
        return Err(PreviewAccessRefusal::Suspended);
    }
    may_view(caller, standing).map_err(PreviewAccessRefusal::Viewer)
}

/// Whether a participant's role change raises the preview's access epoch (the plan's 5.6, "a role lowered"): any move
/// down [`Role::ALL`]'s order, which runs from owner to no role, removal included. A role raised or unchanged doesn't.
pub fn role_change_raises_epoch(before: Role, after: Role) -> bool {
    let rank = |role: Role| Role::ALL.iter().position(|r| *r == role);
    matches!((rank(before), rank(after)), (Some(b), Some(a)) if a > b)
}
