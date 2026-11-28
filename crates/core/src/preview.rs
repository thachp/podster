//! Previews of a room's app before production (M8 step 4; the preview plan, `docs/m8-preview-plan.md`, sections 3 and 5.6; ADR 0010's revision
//! on previews; decisions 250 to 259). Pure, with no I/O and no clock: every time is passed in, in milliseconds.
//!
//! - **The environment** ([`Environment`]): a release is `production` or `preview` (decision 250). A preview is a
//!   release record of reviewed, merged code only; what is releasable doesn't change.
//! - **The deployment's switch** ([`deployment_previews`]), read as `RELEASES` is.
//! - **The preview slot** ([`PreviewSlot`], [`PreviewServe`]): one per room (decision 257), with its own label, its
//!   access epoch and **its own serve state, a type of its own** so nothing a preview does can be stored as, or handed
//!   to, production's [`ServeState`] (the plan's 3.2). Its commands wrap production's, so replacement keeps the last
//!   working preview exactly as a release keeps the last live one: a replacement goes live only when its marker comes
//!   back, and a failed one is set back to what was served.
//! - **Asking for a preview** ([`preview_request`]): create or replace, one in flight, the room's shared caps.
//! - **Deleting one** ([`delete_preview`], [`preview_delete_trigger`]): every unpublish trigger but a visibility change
//!   (the plan's 3.3).
//! - **The access epoch** ([`raise_access_epoch`], [`epoch_honoured`], [`EpochRaise`]): revocation (the plan's 5.6).
//!
//! The build ID and the publish binding are [`crate::preview_build`]; tickets, sessions, cookies and the access limits
//! are [`crate::preview_access`]; the serve entry's preview form is [`crate::serve_entry::PREVIEW_MARK`]; hostname
//! roles are [`crate::hostnames::HostnameRole`]. Who may view and who may manage is `podster_policy::preview`.
//!
//! **Codes.** Every `code()` here is marked `reasons`: no route answers with one yet (M8 steps 6 to 10 will).

use crate::release::{
    clear_host, commit_live, confirm_served, is_label, open_host, release_allowed_today,
    script_owner, set_back, unpublish, CommitLiveRefusal, CommitMark, DesiredServe, InFlight,
    ReleaseCapRefusal, ReleaseState, ScriptOwner, ServeState, StaleCompletion, UnpublishTrigger,
};

// ---------------------------------------------------------------------------------------------------------------------
// The environment (the plan's 2 and 3.1; decision 250)
// ---------------------------------------------------------------------------------------------------------------------

/// Where a release goes. Production is what the room's app serves to everyone; a preview is served only behind the
/// access gate, to people who may view it (decision 252), from its own namespace, label, store and write budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Environment {
    Production,
    Preview,
}

impl Environment {
    pub const ALL: [Environment; 2] = [Environment::Production, Environment::Preview];

    pub fn name(self) -> &'static str {
        match self {
            Environment::Production => "production",
            Environment::Preview => "preview",
        }
    }

    /// The environment a value names, exactly. Anything else, a case twin included, is none.
    pub fn parse(value: &str) -> Option<Environment> {
        Self::ALL.into_iter().find(|env| env.name() == value)
    }
}

/// A release's environment as the room records it (`release_environment`, Workspace step 59, the plan's 9.4): **no row
/// is production**, so every release made before previews stays production's. A row naming anything else is a fault,
/// read as neither, so the caller fails closed instead of serving it anywhere.
pub fn recorded_environment(row: Option<&str>) -> Option<Environment> {
    match row {
        None => Some(Environment::Production),
        Some(value) => Environment::parse(value),
    }
}

/// `store_environment_mismatch`: an upload whose store binding names another environment's store (the plan's 3.1,
/// "Store", and section 8). A preview script binds only its preview label's store, a production script only its
/// production label's, so no preview code reaches production data or the reverse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoreEnvironmentMismatch;

impl StoreEnvironmentMismatch {
    // codes: reasons
    pub fn code(self) -> &'static str {
        "store_environment_mismatch"
    }
}

/// Whether a release of `release` may bind a store recorded for `store`: only its own environment's.
pub fn store_belongs(
    release: Environment,
    store: Environment,
) -> Result<(), StoreEnvironmentMismatch> {
    if release == store {
        Ok(())
    } else {
        Err(StoreEnvironmentMismatch)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The deployment's preview switch (the plan's 3.3; the contract's `previews_off`)
// ---------------------------------------------------------------------------------------------------------------------

/// The deployment's preview setting, the Worker variable `PREVIEWS`, read with `RELEASES`'s three readings
/// ([`crate::release::DeploymentRelease`]): exactly `true` is on; exactly `false` is off, and only that deletes every
/// preview (the plan's 3.3, "Added for previews"); anything else, unset or malformed, is undecided: new previews are
/// refused `previews_off` as when off, and nothing is deleted. So a typo takes nothing down and makes nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeploymentPreviews {
    On,
    Off,
    Undecided,
}

impl DeploymentPreviews {
    /// Whether previews may be asked for, read or mapped: only when on.
    pub fn allows_previews(self) -> bool {
        self == DeploymentPreviews::On
    }

    /// Whether it is the trigger that deletes every preview: only when off, exactly.
    pub fn deletes_previews(self) -> bool {
        self == DeploymentPreviews::Off
    }
}

/// The deployment's preview setting from the variable as written, `None` when it is unset.
pub fn deployment_previews(setting: Option<&str>) -> DeploymentPreviews {
    match setting {
        Some("true") => DeploymentPreviews::On,
        Some("false") => DeploymentPreviews::Off,
        _ => DeploymentPreviews::Undecided,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The preview slot and its serve state (the plan's 3.1 and 3.2)
// ---------------------------------------------------------------------------------------------------------------------

/// The hosts a preview slot may have: its default host, and at most one custom preview hostname (the plan's 3.2 and
/// section 7; decision 257).
pub const MAX_PREVIEW_HOSTS: usize = 2;

/// **A preview slot's serve state: production's shape, never production's type** (the plan's 3.2: "a second
/// `ServeState`, never mixed into production's, so nothing a preview does can write a production host. That is a
/// type-level separation in `crates/core`"). Its inner state is private: no conversion to a [`ServeState`] exists, so a
/// preview's state can't be passed to production's commands or stored as production's, and a production state can't
/// be passed here. Its commands below wrap production's, so a preview keeps exactly their guarantees: one flight at a
/// time by identity, a replacement live only on its marker, a set-back host by host, stale completions changing
/// nothing.
///
/// Two differences from production, both the plan's: **nothing is kept for a rollback** (3.1, "Kept scripts": a new
/// preview of the earlier commit does that job), so a confirmed replacement deletes the script it replaced; and every
/// script its hosts name is **under the slot's own preview label**, for its own release ([`preview_commit_live`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewServe {
    state: ServeState,
}

impl Default for PreviewServe {
    fn default() -> Self {
        Self::new()
    }
}

impl PreviewServe {
    /// A new slot's: epoch 0, one default host serving nothing, nothing in flight.
    pub fn new() -> PreviewServe {
        PreviewServe {
            state: ServeState {
                epoch: 0,
                hosts: vec![DesiredServe {
                    script: None,
                    version: 0,
                    closed: false,
                }],
                kept_previous: None,
                in_flight: None,
            },
        }
    }

    /// A slot's serve state as the room stored it (`preview_slot`, Workspace step 60): the default host first, which
    /// never closes, then at most one custom host. `None` for any other shape, so a damaged row is never served.
    pub fn from_stored(
        epoch: u64,
        hosts: Vec<DesiredServe>,
        in_flight: Option<InFlight>,
    ) -> Option<PreviewServe> {
        let default_open = hosts.first().is_some_and(|h| !h.closed);
        (default_open && hosts.len() <= MAX_PREVIEW_HOSTS).then_some(PreviewServe {
            state: ServeState {
                epoch,
                hosts,
                kept_previous: None,
                in_flight,
            },
        })
    }

    /// The slot's serve epoch, which only a deletion raises; a preview release commits only under the epoch it was
    /// asked under.
    pub fn epoch(&self) -> u64 {
        self.state.epoch
    }

    /// Each host's desired serve state, the default host first. Read-only: only the commands here change them.
    pub fn hosts(&self) -> &[DesiredServe] {
        &self.state.hosts
    }

    /// The preview release waiting for its marker, if one is.
    pub fn in_flight(&self) -> Option<&InFlight> {
        self.state.in_flight.as_ref()
    }

    /// The preview last confirmed served (the "last working preview"): the default host's script as the flight left
    /// it while a replacement's marker is out, or the default host's script now. Production's own rule
    /// ([`crate::release::confirmed_script`]).
    pub fn serving(&self) -> Option<String> {
        crate::release::confirmed_script(&self.state)
    }

    /// The slot with a custom preview host added, closed and serving nothing until [`preview_open_host`] opens it on a
    /// claim that is active. `None` if it already has one.
    pub fn with_custom_host(&self) -> Option<PreviewServe> {
        if self.state.hosts.len() >= MAX_PREVIEW_HOSTS {
            return None;
        }
        let mut state = self.state.clone();
        state.hosts.push(DesiredServe {
            script: None,
            version: 0,
            closed: true,
        });
        Some(PreviewServe { state })
    }
}

/// A room's one preview slot (the plan's 3.2; `preview_slot`, Workspace step 60): its preview label, drawn from the
/// same never-reused space as production's and never one of them, kept across replacements and retired when the
/// preview is deleted; its access epoch (the plan's 5.6); and its serve state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewSlot {
    pub label: String,
    pub access_epoch: u64,
    pub serve: PreviewServe,
}

/// Why the room refused to commit a preview release live.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewCommitRefusal {
    /// Production's refusal, as [`commit_live`] decides it. `release_in_flight` is answered `preview_in_flight` here.
    Commit(CommitLiveRefusal),
    /// `preview_script_mismatch`: the script isn't `<the slot's preview label>.<this release's ID>`. A production
    /// label's script, another room's, or another release's is never served on a preview host.
    ScriptMismatch,
}

impl PreviewCommitRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            PreviewCommitRefusal::Commit(CommitLiveRefusal::InFlight) => "preview_in_flight",
            PreviewCommitRefusal::Commit(refusal) => refusal.code(),
            PreviewCommitRefusal::ScriptMismatch => "preview_script_mismatch",
        }
    }
}

/// The room's commit of a preview release live (the plan's 3.2, "A replacement goes live only when its marker comes
/// back"): production's [`commit_live`] on the slot's own state, after checking that `script` is exactly the slot's
/// preview `label`, a `.`, and this release's own ID. Every open preview host goes to the script; the release waits
/// for its marker; what was served before is kept in the mark for a set-back. A second replacement while one is in
/// flight is refused (`preview_in_flight`), never queued.
pub fn preview_commit_live(
    serve: &PreviewServe,
    label: &str,
    release_epoch: u64,
    script: &str,
    release_id: &str,
    release: ReleaseState,
) -> Result<(PreviewServe, CommitMark), PreviewCommitRefusal> {
    let own = is_label(label)
        && matches!(
            script_owner(script),
            ScriptOwner::Podster { label: l, release_id: r } if l == label && r == release_id
        );
    if !own {
        return Err(PreviewCommitRefusal::ScriptMismatch);
    }
    commit_live(&serve.state, release_epoch, script, release_id, release)
        .map(|(state, mark)| (PreviewServe { state }, mark))
        .map_err(PreviewCommitRefusal::Commit)
}

/// What a preview release's marker coming back does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewConfirmed {
    pub serve: PreviewServe,
    /// The open hosts moved to the release here, the ones opened while it was in flight.
    pub caught_up: Vec<usize>,
    /// The scripts to delete now: what the hosts served before this release, which nothing names any more. Nothing is
    /// kept for a rollback (the plan's 3.1); the record of the release it replaced becomes `replaced`.
    pub delete: Vec<String>,
}

/// A preview release's marker came back through the preview host: it is served, the flight ends, and the preview it
/// replaced is deleted. Production's [`confirm_served`], with nothing kept. A late, repeated or stale success is
/// [`StaleCompletion`] and changes nothing.
pub fn preview_confirm_served(
    serve: &PreviewServe,
    mark: &CommitMark,
    script: &str,
) -> Result<PreviewConfirmed, StaleCompletion> {
    let confirmed = confirm_served(&serve.state, mark, script)?;
    let mut state = confirmed.state;
    state.kept_previous = None;
    let mut delete: Vec<String> = mark
        .before
        .iter()
        .flatten()
        .filter(|before| {
            before.as_str() != script
                && !state
                    .hosts
                    .iter()
                    .any(|h| h.script.as_ref() == Some(*before))
        })
        .cloned()
        .collect();
    delete.sort();
    delete.dedup();
    Ok(PreviewConfirmed {
        serve: PreviewServe { state },
        caught_up: confirmed.caught_up,
        delete,
    })
}

/// The set-back after a preview release's marker never came back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewSetBack {
    pub serve: PreviewServe,
    /// The hosts put back to what they served before.
    pub reverted: Vec<usize>,
    /// Whether the failed release's script may be deleted now: no host names it.
    pub delete_script: bool,
}

/// **A failed replacement leaves the last working preview serving** (the plan's 3.2): production's [`set_back`] on the
/// slot's state, host by host, under the commit's own epoch. Only the failure of the flight does anything; anything
/// else is [`StaleCompletion`]. Production never moves, since nothing here holds a production host.
pub fn preview_set_back(
    serve: &PreviewServe,
    mark: &CommitMark,
    script: &str,
) -> Result<PreviewSetBack, StaleCompletion> {
    set_back(&serve.state, mark, script).map(|back| PreviewSetBack {
        serve: PreviewServe { state: back.state },
        reverted: back.reverted,
        delete_script: back.delete_script,
    })
}

/// A custom preview hostname newly claimed and reported active opens on the preview last confirmed served, or
/// nothing (the plan's section 7, "Serving"): production's [`open_host`]. A preview has no rollback, so no flight is
/// ever a rollback's. `None` for the default host, or a host the slot doesn't have.
pub fn preview_open_host(serve: &PreviewServe, host: usize) -> Option<PreviewServe> {
    open_host(&serve.state, host, false).map(|state| PreviewServe { state })
}

/// A custom preview hostname's claim ending: that host alone serves nothing and closes, first, so its entry is removed
/// before the hostname is deleted at Cloudflare (the plan's section 7, "Removal"): production's [`clear_host`].
pub fn preview_clear_host(serve: &PreviewServe, host: usize) -> Option<PreviewServe> {
    clear_host(&serve.state, host).map(|state| PreviewServe { state })
}

// ---------------------------------------------------------------------------------------------------------------------
// Asking for a preview (the plan's 3.2 and 3.4; decision 257)
// ---------------------------------------------------------------------------------------------------------------------

/// Where the room's slot stands, from its own row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotStatus {
    /// No slot: the first preview makes one and draws its label.
    None,
    Active,
    /// Being taken down after a deletion; a new slot can be made only once it is gone.
    Deleting,
}

/// What a request for a preview does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewRequestPlan {
    /// Make the slot, draw its preview label, and record the first preview release.
    Create,
    /// Record a new preview release; the slot goes on serving the old one until the new one's marker comes back.
    Replace,
}

/// Why a request for a preview was refused, beyond who asked and where (`podster_policy::preview`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewRequestRefusal {
    /// `preview_in_flight`: a preview release is queued, uploading, uncertain or live and waiting for its marker, or the
    /// slot is being deleted. Refused, never queued (the plan's 3.2).
    InFlight,
    /// `preview_limit`: the room has asked for 20 releases and previews together in the rolling day (decision 257:
    /// previews share the room's caps).
    Limit,
}

impl PreviewRequestRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            PreviewRequestRefusal::InFlight => "preview_in_flight",
            PreviewRequestRefusal::Limit => "preview_limit",
        }
    }
}

/// Whether a preview release in `state` is a replacement in flight: asked for and not yet served or ended.
pub fn attempt_in_flight(state: ReleaseState) -> bool {
    matches!(
        state,
        ReleaseState::Queued
            | ReleaseState::Uploading
            | ReleaseState::Uncertain
            | ReleaseState::Live
    )
}

/// The room's decision on a request for a preview, after policy: `attempts` is the state of each of the room's preview
/// releases not yet final, and `asked_at` when each of the room's releases **and** previews was asked for. In the
/// contract's order: in flight (409) before the limit (429).
pub fn preview_request(
    slot: SlotStatus,
    attempts: &[ReleaseState],
    asked_at: &[i64],
    now: i64,
) -> Result<PreviewRequestPlan, PreviewRequestRefusal> {
    if slot == SlotStatus::Deleting || attempts.iter().any(|s| attempt_in_flight(*s)) {
        return Err(PreviewRequestRefusal::InFlight);
    }
    release_allowed_today(asked_at, now).map_err(|refusal| match refusal {
        ReleaseCapRefusal::DailyLimit | ReleaseCapRefusal::ReadBudget => {
            PreviewRequestRefusal::Limit
        }
    })?;
    Ok(match slot {
        SlotStatus::None => PreviewRequestPlan::Create,
        SlotStatus::Active | SlotStatus::Deleting => PreviewRequestPlan::Replace,
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// Deleting a preview (the plan's 3.2 and 3.3)
// ---------------------------------------------------------------------------------------------------------------------

/// What deletes a preview: a person asking, every unpublish trigger but a room changing visibility, and previews
/// switched off for the deployment (the plan's 3.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewDeleteTrigger {
    /// The room's owner or an admin deleted it (`deletePreview`).
    Requested,
    /// One of decision 204's unpublish triggers, which take production down too.
    Unpublish(UnpublishTrigger),
    /// `PREVIEWS` exactly `false` ([`DeploymentPreviews::deletes_previews`]).
    PreviewsOffForDeployment,
}

impl PreviewDeleteTrigger {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            PreviewDeleteTrigger::Requested => "preview_deleted",
            PreviewDeleteTrigger::Unpublish(trigger) => trigger.code(),
            PreviewDeleteTrigger::PreviewsOffForDeployment => "previews_off",
        }
    }
}

/// Whether an unpublish trigger deletes the preview too: **every one but the room made private** (the plan's 3.3: "Not
/// a trigger ... the room changing visibility. That raises the access epoch instead"; decision 251 lets a private room
/// have a preview). `NoReleaserLeft` is among them, as "every one of decision 204's unpublish triggers" reads.
pub fn preview_delete_trigger(trigger: UnpublishTrigger) -> Option<PreviewDeleteTrigger> {
    match trigger {
        UnpublishTrigger::RoomMadePrivate => None,
        other => Some(PreviewDeleteTrigger::Unpublish(other)),
    }
}

/// What deleting a preview does, in the trigger's own room transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewDeletion {
    /// Every host to nothing, its serve epoch up, nothing in flight: a commit begun before can never go live after.
    pub serve: PreviewServe,
    /// The access epoch raised, so no ticket or session for the preview is honoured once its entries are written.
    /// Already at [`MAX_ACCESS_EPOCH`] it stays there; the hosts serve nothing either way.
    pub access_epoch: u64,
    /// The scripts to delete from the preview namespace.
    pub delete_scripts: Vec<String>,
    /// The preview label, retired and never drawn again.
    pub retire_label: String,
}

/// Deleting the room's preview (the plan's 3.2, "Deleting the preview"): exactly as an unpublish takes production down
/// ([`unpublish`], decision 204), on the slot's own state, and the access epoch raised ([`EpochRaise::PreviewDeleted`]).
/// It never fails. Production is untouched: nothing here holds a production host.
pub fn delete_preview(slot: &PreviewSlot) -> PreviewDeletion {
    let (state, delete_scripts) = unpublish(&slot.serve.state);
    PreviewDeletion {
        serve: PreviewServe { state },
        access_epoch: raise_access_epoch(slot.access_epoch).unwrap_or(slot.access_epoch),
        delete_scripts,
        retire_label: slot.label.clone(),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The access epoch (the plan's 5.4 and 5.6)
// ---------------------------------------------------------------------------------------------------------------------

/// The largest access epoch: 15 decimal digits, so it is exact as a JavaScript number in the content Worker
/// (`serve-entry.fixture.json`'s `preview_epoch_pattern`). No entry, ticket or session ever carries more.
pub const MAX_ACCESS_EPOCH: u64 = 999_999_999_999_999;

/// Every change that can shrink who may view a preview, each of which raises its access epoch in the same room
/// transaction (the plan's 5.6). Told as `preview.access_revoked`, IDs only, never names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EpochRaise {
    ParticipantRemoved,
    RoleLowered,
    /// The room's owner changed.
    OwnerChanged,
    /// The room made private or public: not a deletion (the plan's 3.3).
    VisibilityChanged,
    PersonInvitationRevoked,
    PreviewDeleted,
    /// An operator suspended the preview's label or a host.
    OperatorSuspension,
    /// The notice path that tells a room a person left its organization (the plan's 5.6, proposed).
    OrganizationDeparture,
}

impl EpochRaise {
    pub const ALL: [EpochRaise; 8] = [
        EpochRaise::ParticipantRemoved,
        EpochRaise::RoleLowered,
        EpochRaise::OwnerChanged,
        EpochRaise::VisibilityChanged,
        EpochRaise::PersonInvitationRevoked,
        EpochRaise::PreviewDeleted,
        EpochRaise::OperatorSuspension,
        EpochRaise::OrganizationDeparture,
    ];

    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            EpochRaise::ParticipantRemoved => "participant_removed",
            EpochRaise::RoleLowered => "role_lowered",
            EpochRaise::OwnerChanged => "owner_changed",
            EpochRaise::VisibilityChanged => "visibility_changed",
            EpochRaise::PersonInvitationRevoked => "person_invitation_revoked",
            EpochRaise::PreviewDeleted => "preview_deleted",
            EpochRaise::OperatorSuspension => "operator_suspension",
            EpochRaise::OrganizationDeparture => "organization_departure",
        }
    }
}

/// `preview_epoch_exhausted`: the access epoch is at [`MAX_ACCESS_EPOCH`] and can't go up, so revocation can't be
/// written. The caller fails closed by deleting the preview, which takes every host down.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EpochExhausted;

impl EpochExhausted {
    // codes: reasons
    pub fn code(self) -> &'static str {
        "preview_epoch_exhausted"
    }
}

/// The access epoch one higher, never past [`MAX_ACCESS_EPOCH`].
pub fn raise_access_epoch(epoch: u64) -> Result<u64, EpochExhausted> {
    epoch
        .checked_add(1)
        .filter(|next| *next <= MAX_ACCESS_EPOCH)
        .ok_or(EpochExhausted)
}

/// Whether a ticket or session signed at epoch `token_epoch` is honoured on a host whose entry holds `entry_epoch`:
/// only when it isn't below it (the plan's 5.3, step 6: "`ep` not below the epoch in the host's serve entry"). A token
/// above the entry's is one signed after a raise the entry hasn't caught up with yet, and is honoured.
pub fn epoch_honoured(token_epoch: u64, entry_epoch: u64) -> bool {
    token_epoch >= entry_epoch
}
