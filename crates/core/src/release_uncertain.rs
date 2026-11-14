//! A provider call whose answer was lost (M6 step 5; ADR 0010's "The release job"; `m6-plan.md`, "`uncertain`
//! settling by the provider's own answer"), as pure rules: which calls can leave an outcome unknown, what an answer to
//! the script's write says, what a read of the script settles, the bounds on settling, and what the room may not do
//! meanwhile. The room keeps the state and makes the calls; this decides.
//!
//! - **Which calls** ([`on_lost_answer`]): only the script's write leaves a release `uncertain`. Every other call the
//!   release path makes is retried as it is, because a repeat does no harm and something already reads back its effect.
//! - **The script's write** ([`script_write_outcome`]): written only on the answer that says so; not written only when
//!   nothing was sent or the provider refused in so many words, a `4xx`; anything else, no answer among it, is unknown.
//! - **Settling** ([`settle_read`]): the provider's own read of the release's script, and only that: a script object is
//!   written, `"script": null` is absent, anything else settles nothing.
//! - **Bounds** ([`settle_next`]): at most [`MAX_SETTLE_ATTEMPTS`] reads in a release's life, none later than
//!   [`SETTLE_DEADLINE_MS`] after the release became uncertain, with a wait that doubles from
//!   [`SETTLE_FIRST_WAIT_MS`] to [`SETTLE_MAX_WAIT_MS`]. Past them the release ends, [`UNSETTLED`].
//! - **Meanwhile** ([`commit_waits_on_uncertain`]): no other release of the room goes live, [`COMMIT_WAITS_UNCERTAIN`].
//!
//! Every figure marked **Proposed** is the architect's to rule on. The clock is always passed in.

use crate::release::{ScriptAnswer, IN_FLIGHT_EXEMPTION_MS};
use crate::release_driver::DriveStep;

/// Why a release became `uncertain`: its script's write was asked for and its answer was lost.
pub const UNCERTAIN: &str = "release_upload_outcome_unknown";
/// The provider's read found the release's script: its upload is recorded, and the release is uploading again, ready to
/// commit.
pub const SETTLED_WRITTEN: &str = "release_settled_written";
/// The provider's read said the release's script isn't there: the release is uploading again, and its upload is tried
/// again, as a whole.
pub const SETTLED_ABSENT: &str = "release_settled_absent";
/// The provider's read settled nothing: no answer, or not one of the two above. The release stays `uncertain`.
pub const SETTLE_UNKNOWN: &str = "release_settle_unknown";
/// The release ends: it was still `uncertain` when its reads or its time ran out. Its script, which may exist, is
/// queued for deletion as any failed release's is.
pub const UNSETTLED: &str = "release_upload_unsettled";
/// A commit waits under this, counting no driver attempt, while another release of the room is `uncertain`.
pub const COMMIT_WAITS_UNCERTAIN: &str = "release_uncertain";

/// The most reads of its script one release is settled by, over its whole life: it can be `uncertain` more than once,
/// and the reads are counted across every time. **Proposed.**
pub const MAX_SETTLE_ATTEMPTS: u32 = 6;

/// How long after a release became `uncertain` it may still be settled. **Proposed.**
pub const SETTLE_DEADLINE_MS: i64 = 10 * 60 * 1000;

/// The wait before the first read after a release became `uncertain`, so the provider has had a moment to settle its
/// own state. It doubles after each read that settled nothing. **Proposed.**
pub const SETTLE_FIRST_WAIT_MS: i64 = 5_000;

/// The longest wait between two reads. **Proposed.**
pub const SETTLE_MAX_WAIT_MS: i64 = 60_000;

// Settling ends well inside the upload's hour, which ends an `uncertain` release whatever else happens.
const _: () = assert!(SETTLE_DEADLINE_MS < IN_FLIGHT_EXEMPTION_MS);
// Every read fits inside the deadline even at the longest waits: 5 s, 10, 20, 40, 60 and 60 is 195 s.
const _: () = assert!(SETTLE_FIRST_WAIT_MS * 3 + SETTLE_MAX_WAIT_MS * 3 < SETTLE_DEADLINE_MS);

/// Every call the release path makes to the provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderCall {
    /// The upload session, with the manifest.
    UploadSession,
    /// One request of a bucket's files.
    UploadBucket,
    /// The release's script, written from the completion token.
    ScriptWrite,
    /// A read of a script, for the delete job, a rollback or settling.
    ScriptRead,
    /// A script's deletion, by the delete job.
    ScriptDelete,
    /// A host's serve entry, by the applier.
    EntryWrite,
    /// A host's serve entry removed, by the applier.
    EntryDelete,
    /// A read of a host's serve entry.
    EntryRead,
}

/// What the room does when a call's answer is lost.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LostAnswer {
    /// The release becomes `uncertain`, and the provider's own read settles it.
    Uncertain,
    /// The call is asked again as it is: a repeat does no harm, and its effect is read back before anything is recorded.
    Retried,
}

/// What a lost answer means for each call.
///
/// - **The script's write: `uncertain`.** The script exists from this call on, if it went through. Whether it does is a
///   fact the room needs before it may commit the release, and the release mustn't be committed on a guess nor written
///   off while a script may stand under its name. So the release waits, `uncertain`, for the provider's read.
/// - **The session and a bucket: retried.** Nothing exists that anything could serve until the script is written. The
///   provider keeps the files it holds under the script's name, so a new session asks only for what is missing.
/// - **A script's deletion: retried.** The delete job counts a script gone only on the provider's own word, a delete
///   answered `404` with code `10007` or a read answered `"script": null`, so a lost answer is asked again.
/// - **A serve entry's write or removal: retried.** The applier reads the entry back before it records anything, and
///   the write is the same each time. A release whose entry is written is already `live`, and its marker settles what
///   the host serves (`crate::release_marker`).
/// - **A read: retried.** It changes nothing.
pub fn on_lost_answer(call: ProviderCall) -> LostAnswer {
    match call {
        ProviderCall::ScriptWrite => LostAnswer::Uncertain,
        ProviderCall::UploadSession
        | ProviderCall::UploadBucket
        | ProviderCall::ScriptRead
        | ProviderCall::ScriptDelete
        | ProviderCall::EntryWrite
        | ProviderCall::EntryDelete
        | ProviderCall::EntryRead => LostAnswer::Retried,
    }
}

/// What came back from the script's write, as the room's module for the provider read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScriptWriteAnswer {
    /// Nothing was sent: the attempt's deadline had passed, or the script's name or the token wasn't of its form.
    NotSent,
    /// Sent, and no answer could be read: unreachable after sending, timed out, or longer than any answer expected.
    NoAnswer,
    /// An answer: its status, whether its body said `"success": true`, and whether it named this script.
    Answered {
        status: u16,
        success: bool,
        names_script: bool,
    },
}

/// What the room makes of the script's write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteOutcome {
    /// The provider said, in so many words, that this script is written.
    Written,
    /// Nothing was written: nothing was sent, or the provider refused. The upload waits and is tried again.
    NotWritten,
    /// It may or may not be written: the release becomes `uncertain`.
    Unknown,
}

/// The script's write, judged. **Only a `4xx` is read as a refusal** (**Proposed**: no spike saw the provider answer an
/// error): the provider said it didn't take the request. A `5xx`, a `200` that doesn't say success or names another
/// script, a page in place of an answer, and no answer at all may each follow a write that went through.
pub fn script_write_outcome(answer: ScriptWriteAnswer) -> WriteOutcome {
    match answer {
        ScriptWriteAnswer::NotSent => WriteOutcome::NotWritten,
        ScriptWriteAnswer::NoAnswer => WriteOutcome::Unknown,
        ScriptWriteAnswer::Answered {
            status: 200,
            success: true,
            names_script: true,
        } => WriteOutcome::Written,
        ScriptWriteAnswer::Answered { status, .. } if (400..=499).contains(&status) => {
            WriteOutcome::NotWritten
        }
        ScriptWriteAnswer::Answered { .. } => WriteOutcome::Unknown,
    }
}

/// What a read of the release's script settles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettleRead {
    /// A `200` with a script object: the script is there, and its upload went through.
    Written,
    /// A `200` with `"script": null`: the script isn't there.
    Absent,
    /// Anything else, no answer included. Never read as either.
    Unknown,
}

/// A read of the release's script, judged. A delete's answer is never a settling read.
pub fn settle_read(answer: Option<ScriptAnswer>) -> SettleRead {
    match answer {
        Some(ScriptAnswer::Read {
            status: 200,
            script_null: false,
        }) => SettleRead::Written,
        Some(ScriptAnswer::Read {
            status: 200,
            script_null: true,
        }) => SettleRead::Absent,
        _ => SettleRead::Unknown,
    }
}

/// The wait before the next read, with `settles` reads already made: [`SETTLE_FIRST_WAIT_MS`] with none, doubling with
/// each, at most [`SETTLE_MAX_WAIT_MS`].
pub fn settle_wait_ms(settles: u32) -> i64 {
    SETTLE_FIRST_WAIT_MS
        .saturating_mul(1_i64 << settles.min(20))
        .min(SETTLE_MAX_WAIT_MS)
}

/// The time past which a release that became `uncertain` at `since` is no longer settled.
pub fn settle_deadline(since: i64) -> i64 {
    since.saturating_add(SETTLE_DEADLINE_MS)
}

/// Whether one more read may be made at `now`, with `settles` made in the release's life and the release `uncertain`
/// since `since`: fewer than [`MAX_SETTLE_ATTEMPTS`], and before its deadline. At the deadline, not.
pub fn may_settle(settles: u32, since: i64, now: i64) -> bool {
    settles < MAX_SETTLE_ATTEMPTS && now < settle_deadline(since)
}

/// What comes next for a release still `uncertain`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettleNext {
    /// Read again at this time: never past the deadline.
    At(i64),
    /// No more reads: end the release, [`UNSETTLED`].
    GiveUp,
}

/// What comes next for a release still `uncertain` at `now`, with `settles` reads made and the release `uncertain`
/// since `since`. Past [`may_settle`], the end. Otherwise the next read after [`settle_wait_ms`], and at the latest at
/// the deadline, where [`may_settle`] then ends it.
pub fn settle_next(settles: u32, since: i64, now: i64) -> SettleNext {
    if !may_settle(settles, since, now) {
        return SettleNext::GiveUp;
    }
    SettleNext::At(
        now.saturating_add(settle_wait_ms(settles))
            .min(settle_deadline(since)),
    )
}

/// What the driver makes of a step for a release that was, or now is, `uncertain`. `None` for any other step, which
/// the driver's own rules decide.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettleDrive {
    /// It was settled: whatever it is at now is due at once, and its stalls start again.
    Next,
    /// It is still `uncertain`: read again at this time. No stall is counted: settling has its own bounds.
    Retry { at: i64 },
    /// It is still `uncertain` and has had every read or all its time: end it, [`UNSETTLED`].
    Unsettled,
}

/// The driver's outcome for a step that touched an `uncertain` release. `was_uncertain` is whether it was `uncertain`
/// when the step was run, `now_uncertain` whether it is after; `after` the step it is at now (`None` when it is out of
/// the driver's hands); `settles` and `since` its reads and since when it is `uncertain`.
///
/// - Still, or newly, `uncertain`: [`settle_next`].
/// - Settled to another step, an upload's retry among them: [`SettleDrive::Next`]. Settling absent leaves it at the
///   upload it was at, which is not a stall: the provider's answer moved it on.
/// - Anything else, an ended release among them: `None`.
pub fn settle_outcome(
    was_uncertain: bool,
    now_uncertain: bool,
    after: Option<DriveStep>,
    settles: u32,
    since: i64,
    now: i64,
) -> Option<SettleDrive> {
    if now_uncertain {
        return Some(match settle_next(settles, since, now) {
            SettleNext::At(at) => SettleDrive::Retry { at },
            SettleNext::GiveUp => SettleDrive::Unsettled,
        });
    }
    (was_uncertain && after.is_some()).then_some(SettleDrive::Next)
}

/// The driver attempts the cap counts: every attempt but the reads that settled, or tried to settle, an `uncertain`
/// release. Settling has its own bounds, so a release that was `uncertain` isn't ended by the cap for having been.
pub fn counted_attempts(attempts: u32, settles: u32) -> u32 {
    attempts.saturating_sub(settles)
}

/// Whether a commit of release `own` waits because another release of the room is `uncertain` (`uncertain`, every
/// such release's ID). **While one is, nothing new goes live:** its script may stand, and whether it does is unsettled.
pub fn commit_waits_on_uncertain(own: &str, uncertain: &[&str]) -> bool {
    uncertain.iter().any(|id| *id != own)
}
