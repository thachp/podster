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

/// The kind and the script a custom hostname's entry names, read for exactly `host`: `None` for any value
/// [`custom_entry_value_kind`] wouldn't write for that host.
pub fn custom_entry_script_kind<'a>(host: &str, value: &'a str) -> Option<(HostKind, &'a str)> {
    let (kind, rest) = unmarked(value);
    custom_entry_script(host, rest).map(|script| (kind, script))
}
