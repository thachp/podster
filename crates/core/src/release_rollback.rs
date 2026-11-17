//! Rolling back to an earlier release (M6 step 6, 6h; ADR 0010's "Rollback", decision 203): what the room decides, as
//! pure rules. Pure, with no I/O and no clock.
//!
//! **A rollback is its own release record,** asked for by a person as any release is (`release_request`), and approved
//! as any release is: the same approval, the same recheck on every pass. Its record names the release it rolls back
//! to, whose commit it releases. Nothing is rewritten.
//!
//! **Which release may be rolled back to** ([`rollback_target`]): one the room served once and has since left,
//! `replaced` or `unpublished`. The release served now isn't one, and a release never served isn't one.
//!
//! **Switching back, with no upload,** happens only when everything below holds; otherwise the rollback is a new
//! release of that commit, uploaded again under the rollback's own script, which takes an upload slot and the read
//! budget as any upload does. In the order they are asked:
//! 1. **the room's own facts** ([`aims_at_kept`]): the target's script is the room's kept script; that script's label is
//!    the room's current one, and the rollback's own (after an unpublish there is nothing kept, and a new label means a
//!    new release); no suspension of the app or of its default host, which is the same thing; and the kept script isn't
//!    queued for deletion, by anything;
//! 2. **the operators' record** ([`SwitchReads::finding_open`]): no takedown finding open against that script, read at
//!    the switch;
//! 3. **Cloudflare's own answer for that script, read at the switch** ([`SwitchReads::script`]): a read answering `200`
//!    with a script object (`release::script_exists`). Gone (`release::script_gone`) uploads again; any other answer
//!    decides nothing, and the switch is asked again.
//!
//! **What isn't decided here, and where it is:** the room's current release epoch, `releasable_commit` and the
//! reviewer rule as the room has it now are core's recheck's (`release::recheck`), which the room runs at the switch's
//! stage and again at its confirm, and which fails the release rather than uploading; the epoch again, and one flight
//! at a time, are `release::rollback`'s. A closed custom host is never written by a switch, as by a commit.

use crate::release::{
    script_exists, script_gone, script_owner, ReleaseState, ScriptAnswer, ScriptOwner,
};

/// Why a release can't be rolled back to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetRefusal {
    /// `rollback_target_invalid`: the release was never served, or is still what the room serves or is about to.
    NotEarlier,
}

impl TargetRefusal {
    // codes: errors
    pub fn code(self) -> &'static str {
        match self {
            TargetRefusal::NotEarlier => "rollback_target_invalid",
        }
    }
}

/// Whether a release in `state`, which the room recorded served at some time if `ever_served`, may be rolled back to.
pub fn rollback_target(state: ReleaseState, ever_served: bool) -> Result<(), TargetRefusal> {
    if ever_served && matches!(state, ReleaseState::Replaced | ReleaseState::Unpublished) {
        Ok(())
    } else {
        Err(TargetRefusal::NotEarlier)
    }
}

/// What the room's own rows say, inside its transaction, of the script a rollback would switch back to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeptFacts<'a> {
    /// The room's kept script (`ServeState::kept_previous`), if it keeps one.
    pub kept: Option<&'a str>,
    /// The script the target release's record names, if it names one.
    pub target_script: Option<&'a str>,
    /// The room's current label, if it has one.
    pub current_label: Option<&'a str>,
    /// The label the rollback's own record was asked under.
    pub rollback_label: &'a str,
    /// An operator's suspension holds on the room's app, by any of its labels: its default host's suspension.
    pub app_suspended: bool,
    /// The kept script is queued for deletion, whatever queued it, gone or not.
    pub queued_for_delete: bool,
}

/// Why a rollback isn't switched back to the kept script, by the room's own facts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeptRefusal {
    /// `rollback_not_kept`: nothing is kept, or what is kept isn't the target's script.
    NotKept,
    /// `rollback_label_not_current`: the kept script's label isn't the room's current one, or the rollback's own.
    LabelNotCurrent,
    /// `rollback_suspended`: the app, or its default host, is suspended.
    Suspended,
    /// `rollback_script_deleting`: the kept script is queued for deletion.
    Deleting,
}

impl KeptRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            KeptRefusal::NotKept => "rollback_not_kept",
            KeptRefusal::LabelNotCurrent => "rollback_label_not_current",
            KeptRefusal::Suspended => "rollback_suspended",
            KeptRefusal::Deleting => "rollback_script_deleting",
        }
    }
}

/// The kept script a rollback may aim at, by the room's own facts alone, in the module's order; or why not.
pub fn aims_at_kept<'a>(f: &KeptFacts<'a>) -> Result<&'a str, KeptRefusal> {
    let kept = f
        .kept
        .filter(|kept| Some(*kept) == f.target_script)
        .ok_or(KeptRefusal::NotKept)?;
    let ScriptOwner::Podster { label, .. } = script_owner(kept) else {
        return Err(KeptRefusal::NotKept);
    };
    if f.current_label != Some(label) || f.rollback_label != label {
        return Err(KeptRefusal::LabelNotCurrent);
    }
    if f.app_suspended {
        return Err(KeptRefusal::Suspended);
    }
    if f.queued_for_delete {
        return Err(KeptRefusal::Deleting);
    }
    Ok(kept)
}

/// What the room read outside itself at the switch, for the kept script. `None` is a read that gave no answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwitchReads {
    /// Whether the operators' record holds a takedown finding whose subject is the kept script.
    pub finding_open: Option<bool>,
    /// Cloudflare's answer to a read of the kept script.
    pub script: Option<ScriptAnswer>,
}

/// What a rollback does at its switch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RollbackPath {
    /// Switch every open host back to the kept script, through `release::rollback`.
    Switch,
    /// A new release of the target's commit: the rollback's own script, uploaded again. The reason, by its code.
    Upload(&'static str),
    /// Nothing is decided: a read gave no answer. The switch is asked again. The reason, by its code.
    Undecided(&'static str),
}

/// The switch's decision: the room's facts first; then a read that definitely refuses; then a read that couldn't be
/// made; and only when every one holds, the switch.
pub fn rollback_path(room: &KeptFacts, reads: &SwitchReads) -> RollbackPath {
    if let Err(refusal) = aims_at_kept(room) {
        return RollbackPath::Upload(refusal.code());
    }
    if reads.finding_open == Some(true) {
        return RollbackPath::Upload("rollback_finding_open");
    }
    if reads.script.is_some_and(script_gone) {
        return RollbackPath::Upload("rollback_script_gone");
    }
    if reads.finding_open.is_none() {
        return RollbackPath::Undecided("rollback_finding_unread");
    }
    match reads.script {
        Some(answer) if script_exists(answer) => RollbackPath::Switch,
        _ => RollbackPath::Undecided("rollback_script_unread"),
    }
}

/// The release whose marker the host must serve for a release whose record names `script`: the script's own release,
/// by its name. For an ordinary release that is itself; for a rollback switched back, the release it rolls back to.
/// `None` for a name Podster didn't make, which no marker matches.
pub fn marker_release(script: &str) -> Option<&str> {
    match script_owner(script) {
        ScriptOwner::Podster { release_id, .. } => Some(release_id),
        ScriptOwner::Foreign => None,
    }
}
