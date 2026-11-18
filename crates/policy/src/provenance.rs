//! Who reads a task's provenance (M7 step 4; decision 228; M7 security review S-29). Denies by default.
//!
//! A task's provenance is its requester's organization, the room's visibility, and who last wrote each prompt input
//! (`podster_core::task_inputs`) with that author's organization, each marked `external` for the reader. Runner's run policy
//! reads it to apply "the least-trusted author decides" on the owner's machine (RUNNER.md, "Run policy and budget").
//!
//! It is a read only. It authorizes nothing on the server: no command, policy or grant here takes an author, an
//! organization or a visibility from it, and Runner trusts it only as far as it trusts Podster (RUNNER.md, "Enforced
//! locally, within limits"). It discloses the requester's organization and each input author's organization to whoever
//! may read the task, which is the same audience its history already names those authors to.

use podster_core::Task;

use crate::{authorize_task, Caller, TaskAction, Verdict};

/// Whether the caller sees a task's provenance: exactly those who may read the task, and nobody else.
pub fn sees_provenance(caller: &Caller, task: &Task) -> bool {
    authorize_task(caller, task, TaskAction::Read) == Verdict::Allow
}

/// Whether an author counts as external to the reader: always, unless both name the same organization. An author the room
/// has no record of, or with no organization, is external, so run policy treats them as the least trusted.
pub fn is_external(author_org: Option<&str>, reader_org: &str) -> bool {
    match author_org {
        Some(org) if !org.is_empty() => org != reader_org,
        _ => true,
    }
}

/// Whether a prompt input counts as external to the reader: if any author who ever wrote it is external, or is no longer
/// active, or if any write's author isn't known. `authors` is each author's `(external, active)`. Every author is kept, so
/// the last writer can't hide an earlier one (F1), and inactivity is folded in here, one fail-closed answer for every
/// reader rather than one left to Runner (G2). An input with no recorded author at all is external.
pub fn input_external(authors: &[(bool, bool)], unknown: bool) -> bool {
    unknown
        || authors.is_empty()
        || authors
            .iter()
            .any(|(external, active)| *external || !active)
}

/// Whether the requester counts as external to the reader: unless they were recorded in the reader's organization when
/// they became requester and are still active there (G2).
pub fn requester_external(recorded_org: Option<&str>, reader_org: &str, active: bool) -> bool {
    is_external(recorded_org, reader_org) || !active
}

/// Whether an author, or the requester, is active: a current participant of the room, held now in the organization
/// recorded when they wrote or took the part. Read from the room's current state each time. An input or requester with
/// someone who isn't is external in the answer (G2); the server authorizes nothing from it.
pub fn author_active(
    participant: bool,
    held_org: Option<&str>,
    recorded_org: Option<&str>,
) -> bool {
    participant && recorded_org.is_some() && held_org == recorded_org
}
