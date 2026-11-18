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
