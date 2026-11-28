//! The serve entry's mark that the script it names carries code (M6 stage 1, ADR 0010's revision, section 4's first
//! row). Pure, with no I/O.
//!
//! A serve entry names one script, in its host's form: on an app's default host the script's name alone
//! ([`crate::release::script_owner`]), on a custom hostname the script's name, `@`, then that host
//! ([`crate::hostnames::custom_entry_value`]). **An entry whose script's release carries code is [`CODE_MARK`] and then
//! exactly that form;** a static entry carries no mark and is exactly what it has always been.
//!
//! The mark ends in `:`, which no script's name Podster makes and no host Podster writes can hold, so no static entry,
//! of either form, can begin with it. It is taken off once, from the start only, and what is left is read exactly as a
//! static entry of that host is read: so a mark twice, a mark in another case or another word, or a mark anywhere but
//! the start, leaves something that is no script's entry, and is refused.
//!
//! `packages/contracts/serve-entry.fixture.json` holds the vectors; this, the private API's provider and the content
//! Worker (`apps/content/src/names.ts`, a copy of this rule) are each tested against them.

use crate::app_requests::HostKind;
use crate::hostnames::{custom_entry_script, custom_entry_value};
use crate::release::{script_owner, ScriptOwner};

/// Before a serve entry's value when its script's release carries code. Nothing else of the entry changes.
pub const CODE_MARK: &str = "code:";

/// A static entry's value, given its kind: unchanged when static, after [`CODE_MARK`] when it has code.
fn marked(kind: HostKind, value: String) -> String {
    match kind {
        HostKind::Static => value,
        HostKind::Code => format!("{CODE_MARK}{value}"),
    }
}

/// An entry's kind, and the static form left once its mark, if any, is taken off: once, from the start only.
fn unmarked(value: &str) -> (HostKind, &str) {
    match value.strip_prefix(CODE_MARK) {
        Some(rest) => (HostKind::Code, rest),
        None => (HostKind::Static, value),
    }
}

/// What an app's default host's entry holds for `script`, of `kind`: the script's name, marked when it has code.
/// `None` for a name Podster doesn't make. Which host may take which label is the writer's to check, as before.
pub fn default_entry_value(kind: HostKind, script: &str) -> Option<String> {
    matches!(script_owner(script), ScriptOwner::Podster { .. })
        .then(|| marked(kind, script.to_owned()))
}

/// The kind and the script a default host's entry names, or `None` for any value [`default_entry_value`] wouldn't
/// write.
pub fn default_entry_script(value: &str) -> Option<(HostKind, &str)> {
    let (kind, script) = unmarked(value);
    matches!(script_owner(script), ScriptOwner::Podster { .. }).then_some((kind, script))
}

/// What a custom hostname's entry holds for `script`, of `kind`: [`custom_entry_value`]'s form, marked when it has
/// code. `None` wherever that form is.
pub fn custom_entry_value_kind(kind: HostKind, host: &str, script: &str) -> Option<String> {
    custom_entry_value(host, script).map(|value| marked(kind, value))
}

/// A script's kind as the room's record of it holds it (`release_script_kind`, S3 of the store plan).
pub fn kind_name(kind: HostKind) -> &'static str {
    match kind {
        HostKind::Static => "static",
        HostKind::Code => "code",
    }
}

/// The kind a record names, or `None` for anything else, a case twin included.
pub fn kind_named(name: &str) -> Option<HostKind> {
    match name {
        "static" => Some(HostKind::Static),
        "code" => Some(HostKind::Code),
        _ => None,
    }
}

/// **A script's kind, from the room's record of it** (`None` when the room holds no record). **Static only when the
/// record says `static`;** anything else is code: no record at all, and a record that names a kind this rule doesn't
/// know (the architect's ruling on review, 2026-11-17, reversing "no record is static"). The room records a script's
/// kind before it writes the script, and room schema step 52 recorded every earlier script static, so a script with no
/// record is a fault, and the fault fails closed: a static entry for a script with code would let the content Worker
/// dispatch reads to it, its store bound, past the rules for a host with code, the code-apps switch and the write
/// counter. A code entry is held to those rules, and refused outright while code apps are off.
pub fn recorded_kind(record: Option<&str>) -> HostKind {
    match record {
        Some("static") => HostKind::Static,
        _ => HostKind::Code,
    }
}

/// **Whether an entry read back is exactly what the room wants** (S3 of the store plan; PR #415's open question 1):
/// the same script **and** the same kind. A kind that differs is as wrong as a script that differs, so a static entry
/// for a script with code, or a marked one for a static script, never matches. Either side unknown matches nothing.
pub fn entry_is(wanted: Option<(HostKind, &str)>, found: Option<(HostKind, &str)>) -> bool {
    match (wanted, found) {
        (Some((want_kind, want_script)), Some((found_kind, found_script))) => {
            want_kind == found_kind && want_script == found_script
        }
        _ => false,
    }
}

/// The kind and the script a custom hostname's entry names, read for exactly `host`: `None` for any value
/// [`custom_entry_value_kind`] wouldn't write for that host.
pub fn custom_entry_script_kind<'a>(host: &str, value: &'a str) -> Option<(HostKind, &'a str)> {
    let (kind, rest) = unmarked(value);
    custom_entry_script(host, rest).map(|script| (kind, script))
}

// ---------------------------------------------------------------------------------------------------------------------
// The preview form (M8 step 4)
// ---------------------------------------------------------------------------------------------------------------------

/// Before a preview host's entry (M8; the preview plan's 3.1, ADR 0010's revision on previews, item 2). A preview
/// entry is this mark, the preview slot's ID, `:`, the slot's access epoch in decimal, `:`, and then exactly the entry
/// a production host of the same form would hold: [`default_entry_value`]'s on a default preview host,
/// [`custom_entry_value_kind`]'s on a custom one. `packages/contracts/serve-entry.fixture.json` holds its vectors
/// (`valid_preview_entries` and the rest). The slot's ID was added by M8 step 4's security review: every ticket and
/// session names it too, so a host a later slot holds honours none of an earlier slot's.
///
/// **The forms cross:** no production reader reads a preview entry, since what follows a production entry's optional
/// code mark must be a script's name, and `preview:` can't begin one; and no preview reader reads a production entry,
/// since it must begin with this mark. The content Worker dispatches a preview entry only through the preview
/// namespace's binding and an unmarked one only through production's, so neither can name the other's script (M8 step
/// 8). The host's kind comes from its entry, never its name.
///
/// **The code mark stays in one place.** What follows the preview prefix is written and read only by the production
/// functions above, so the code mark is still put on in [`marked`] and taken off in [`unmarked`] and nowhere else
/// (`apps/content/test/entries.test.ts` counts those two sites).
pub const PREVIEW_MARK: &str = "preview:";

/// One preview entry, read back: the slot it names, its access epoch, and the kind and script of its production form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreviewEntry<'a> {
    pub slot: &'a str,
    pub epoch: u64,
    pub kind: HostKind,
    pub script: &'a str,
}

/// The epoch read back from exactly its written form, `0` or a digit other than `0` and at most 14 more, so it is
/// exact as a JavaScript number (the fixture's `preview_epoch_pattern`): no sign, no leading zero, no space.
fn parse_epoch(text: &str) -> Option<u64> {
    let digits = !text.is_empty() && text.len() <= 15 && text.bytes().all(|b| b.is_ascii_digit());
    let unpadded = text == "0" || !text.starts_with('0');
    if !(digits && unpadded) {
        return None;
    }
    text.parse::<u64>()
        .ok()
        .filter(|epoch| *epoch <= crate::preview::MAX_ACCESS_EPOCH)
}

/// `preview:<slot>:<epoch>:` for a slot's ID of its form and an epoch no larger than
/// [`crate::preview::MAX_ACCESS_EPOCH`]; `None` otherwise, so nothing else is ever written.
fn preview_prefix(slot: &str, epoch: u64) -> Option<String> {
    (crate::preview::is_slot_id(slot) && epoch <= crate::preview::MAX_ACCESS_EPOCH)
        .then(|| format!("{PREVIEW_MARK}{slot}:{epoch}:"))
}

/// The slot, the epoch and the production form left once the mark, the slot and the epoch are taken off: once, from
/// the start only, each part exactly its written form.
fn split_preview(value: &str) -> Option<(&str, u64, &str)> {
    let (slot, rest) = value.strip_prefix(PREVIEW_MARK)?.split_once(':')?;
    let (epoch, rest) = rest.split_once(':')?;
    if !crate::preview::is_slot_id(slot) {
        return None;
    }
    Some((slot, parse_epoch(epoch)?, rest))
}

/// What a default preview host's entry holds for `script`, of `kind`, for slot `slot` at access epoch `epoch`.
/// `None` for a name Podster doesn't make, a slot's ID not of its form, or an epoch past
/// [`crate::preview::MAX_ACCESS_EPOCH`]. That the script's label is the slot's preview label is the writer's to check,
/// as for production ([`crate::preview::preview_commit_live`] holds it).
pub fn preview_entry_value(slot: &str, epoch: u64, kind: HostKind, script: &str) -> Option<String> {
    let prefix = preview_prefix(slot, epoch)?;
    default_entry_value(kind, script).map(|value| prefix + &value)
}

/// What a default preview host's entry names, or `None` for any value [`preview_entry_value`] wouldn't write.
pub fn preview_entry_script(value: &str) -> Option<PreviewEntry<'_>> {
    let (slot, epoch, rest) = split_preview(value)?;
    let (kind, script) = default_entry_script(rest)?;
    Some(PreviewEntry {
        slot,
        epoch,
        kind,
        script,
    })
}

/// What a custom preview hostname's entry holds for `script`, of `kind`, for slot `slot` at access epoch `epoch`:
/// `None` wherever [`custom_entry_value_kind`] is, or [`preview_entry_value`] would be.
pub fn preview_custom_entry_value(
    slot: &str,
    epoch: u64,
    kind: HostKind,
    host: &str,
    script: &str,
) -> Option<String> {
    let prefix = preview_prefix(slot, epoch)?;
    custom_entry_value_kind(kind, host, script).map(|value| prefix + &value)
}

/// What a custom preview hostname's entry names, read for exactly `host`: `None` for any value
/// [`preview_custom_entry_value`] wouldn't write for that host.
pub fn preview_custom_entry_script_kind<'a>(
    host: &str,
    value: &'a str,
) -> Option<PreviewEntry<'a>> {
    let (slot, epoch, rest) = split_preview(value)?;
    let (kind, script) = custom_entry_script_kind(host, rest)?;
    Some(PreviewEntry {
        slot,
        epoch,
        kind,
        script,
    })
}
