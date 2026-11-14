//! The release job's driver (M6 step 5, the third PR; ADR 0010's "The release job"): what the room's alarm decides
//! for a release it is taking through its upload and its commit, as pure rules. The room keeps the state and does the
//! work; this decides, from what the room read, which command comes next, when it may be asked again, and when the
//! release has had enough attempts.
//!
//! - **Which step** ([`drive_step`]): a queued release is started; an uploading release whose upload the room hasn't
//!   recorded is uploaded; one whose upload is recorded is committed (staged, then confirmed). Anything else is not the
//!   driver's: an ended release, one that is live (the marker's wait is not built), and one whose upload is uncertain
//!   (nothing makes one yet).
//! - **What came of a step** ([`drive_outcome`]): the release moved on to another step, or out of the driver's hands,
//!   or it is where it was and waits. Only the release's state after the step decides that, never what the step's
//!   answer said of itself.
//! - **When to ask again** ([`drive_wait_ms`]): a wait that grows, from [`DRIVE_FIRST_WAIT_MS`] doubling to
//!   [`DRIVE_MAX_WAIT_MS`], and never before a time the step itself named, the read budget's.
//! - **How many attempts** ([`MAX_DRIVE_ATTEMPTS`]): past it the release ends, [`ATTEMPTS_EXHAUSTED`].
//! - **How often a room may read** ([`upload_slot`]): at most [`MAX_UPLOAD_ATTEMPTS_PER_ROOM_PER_HOUR`] upload attempts
//!   begun in a rolling hour in one room, whichever of its releases they are for. Each attempt reserves up to
//!   [`MAX_ATTEMPT_READS`] of the deployment's [`MAX_RELEASE_READS_PER_HOUR`], so one room, and so one waiting release,
//!   can hold at most [`MAX_ROOM_READS_PER_HOUR`] of them.
//! - **How long a step may be out** ([`DRIVE_LEASE_MS`]): a step that hasn't come back by then is taken for one that
//!   died with its object, and the release is taken up again.
//!
//! Every figure marked **Proposed** is the architect's to rule on.

use crate::release::{
    window_start, ReleaseState, ATTEMPT_DEADLINE_MS, FETCH_PASSES, MAX_RELEASE_READS_PER_HOUR,
    READ_WINDOW_MS, TREE_READS,
};
use crate::release_tree::MAX_FILES;

/// The code a release ends with when the driver has used up its attempts.
pub const ATTEMPTS_EXHAUSTED: &str = "release_attempts_exhausted";

/// The most steps the driver asks of one release, every kind counted, including those that moved it on. The happy path
/// is three: start, upload, commit. **Proposed.**
pub const MAX_DRIVE_ATTEMPTS: u32 = 8;

/// The first wait after a step that left a release where it was. **Proposed.**
pub const DRIVE_FIRST_WAIT_MS: i64 = 30_000;

/// The longest wait between two steps for one release. With [`MAX_DRIVE_ATTEMPTS`] the waits of a release that never
/// moves add up to about 16 minutes, inside its upload's hour. **Proposed.**
pub const DRIVE_MAX_WAIT_MS: i64 = 10 * 60 * 1000;

/// How long a release waits, counting no attempt, when the deployment doesn't allow release or the release path is
/// closed: the driver does nothing then, and looks again after this. **Proposed.**
pub const DRIVE_IDLE_MS: i64 = 10 * 60 * 1000;

/// How long one step may be out before the driver takes it for one that died with its object: an upload attempt's own
/// deadline and a minute for the room's checks and the revoke on either side. **Proposed.**
pub const DRIVE_LEASE_MS: i64 = ATTEMPT_DEADLINE_MS + 60_000;

/// The most upload attempts begun in one room in a rolling hour, over all its releases. **Proposed.**
pub const MAX_UPLOAD_ATTEMPTS_PER_ROOM_PER_HOUR: u32 = 2;

/// The most reads one upload attempt can reserve: the two trees, and each of the most files fetched twice.
pub const MAX_ATTEMPT_READS: u32 = TREE_READS + FETCH_PASSES * MAX_FILES as u32;

/// The most of the deployment's hourly reads one room can reserve under [`upload_slot`]: 1,204 of 3,000.
pub const MAX_ROOM_READS_PER_HOUR: u32 = MAX_UPLOAD_ATTEMPTS_PER_ROOM_PER_HOUR * MAX_ATTEMPT_READS;

// One room can never hold the deployment's budget alone: at most half of it, so another room always has room for a
// full-size attempt.
const _: () = assert!(MAX_ROOM_READS_PER_HOUR * 2 <= MAX_RELEASE_READS_PER_HOUR);
const _: () = assert!(MAX_RELEASE_READS_PER_HOUR - MAX_ROOM_READS_PER_HOUR >= MAX_ATTEMPT_READS);

/// One step the driver asks of the room for a release, each one of the room's existing commands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriveStep {
    /// A queued release: the recheck, and the upload started (`/internal/release-start-upload`).
    Start,
    /// An uploading release with no upload on record: the read and the upload (`/internal/release-upload`).
    Upload,
    /// An uploading release whose upload is recorded: the stage and the confirm (`/internal/release-commit-live`).
    Commit,
}

impl DriveStep {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            DriveStep::Start => "start",
            DriveStep::Upload => "upload",
            DriveStep::Commit => "commit",
        }
    }
}

/// The step for a release in `state`, with `uploaded` whether the room has recorded its upload; `None` for a release
/// that isn't the driver's.
pub fn drive_step(state: ReleaseState, uploaded: bool) -> Option<DriveStep> {
    match (state, uploaded) {
        (ReleaseState::Queued, _) => Some(DriveStep::Start),
        (ReleaseState::Uploading, false) => Some(DriveStep::Upload),
        (ReleaseState::Uploading, true) => Some(DriveStep::Commit),
        _ => None,
    }
}

/// What the driver does after a step, decided from the release as the room has it after the step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriveOutcome {
    /// The release moved on to another step: it is due again at once.
    Next,
    /// The release is out of the driver's hands: ended, live, or anything else that isn't a step.
    Done,
    /// It is where it was: ask again at this time.
    Retry { at: i64 },
    /// It is where it was and has had every attempt: end it, [`ATTEMPTS_EXHAUSTED`].
    GiveUp,
}

/// The wait after the `attempts`-th attempt left a release where it was: [`DRIVE_FIRST_WAIT_MS`] after the first,
/// doubling, at most [`DRIVE_MAX_WAIT_MS`]. Never less than the first wait.
pub fn drive_wait_ms(attempts: u32) -> i64 {
    let doublings = attempts.saturating_sub(1).min(20);
    DRIVE_FIRST_WAIT_MS
        .saturating_mul(1_i64 << doublings)
        .min(DRIVE_MAX_WAIT_MS)
}

/// What came of a step. `before` is the step that was asked; `after` the step the release is at now, from its state
/// and its upload's record after the step (`None` when it isn't the driver's any more); `attempts` how many the driver
/// has made for it, this one included; `retry_at` a time the step named, the read budget's, before which nothing fits.
///
/// - Another step: [`DriveOutcome::Next`].
/// - No step: [`DriveOutcome::Done`].
/// - The same step: it waits, by [`drive_wait_ms`] and never before `retry_at`; or, with every attempt made,
///   [`DriveOutcome::GiveUp`].
pub fn drive_outcome(
    before: DriveStep,
    after: Option<DriveStep>,
    attempts: u32,
    retry_at: Option<i64>,
    now: i64,
) -> DriveOutcome {
    match after {
        None => DriveOutcome::Done,
        Some(step) if step != before => DriveOutcome::Next,
        Some(_) if attempts >= MAX_DRIVE_ATTEMPTS => DriveOutcome::GiveUp,
        Some(_) => {
            let backoff = now.saturating_add(drive_wait_ms(attempts));
            DriveOutcome::Retry {
                at: retry_at.map_or(backoff, |at| at.max(backoff)),
            }
        }
    }
}

/// Whether one more attempt may be leased for a release that has had `attempts`: not once they are all made. A
/// release taken up again after a step died is leased here, so a step that keeps dying ends the release too.
pub fn may_lease(attempts: u32) -> bool {
    attempts < MAX_DRIVE_ATTEMPTS
}

/// Whether an upload attempt may begin in a room at `now`, given when its earlier ones began, in any order and for any
/// of its releases. `Ok` when fewer than [`MAX_UPLOAD_ATTEMPTS_PER_ROOM_PER_HOUR`] began in the rolling hour; otherwise
/// the first time one would, when enough of the oldest have left the hour.
pub fn upload_slot(began: &[i64], now: i64) -> Result<(), i64> {
    let start = window_start(now, READ_WINDOW_MS);
    let mut counting: Vec<i64> = began.iter().copied().filter(|at| *at >= start).collect();
    let limit = MAX_UPLOAD_ATTEMPTS_PER_ROOM_PER_HOUR as usize;
    if counting.len() < limit {
        return Ok(());
    }
    counting.sort_unstable();
    // The attempt that must leave the hour for one more to fit: the oldest, past what the limit leaves.
    let leaving = counting.get(counting.len() - limit).copied().unwrap_or(now);
    Err(leaving.saturating_add(READ_WINDOW_MS))
}

/// Whether the driver's own record of a step may be kept: the step's lease is still the one it was given (`attempt`
/// against the job's `attempts` now), and the room's release epoch and its app's hold have each stayed what they were
/// when the step was leased. If any moved, what the step answered is about a room that no longer is, and the driver
/// records nothing of it: the release is looked at afresh.
pub fn step_still_current(
    attempt: u32,
    attempts_now: u32,
    leased_epoch: i64,
    epoch_now: i64,
    leased_hold: i64,
    hold_now: i64,
) -> bool {
    attempt == attempts_now && leased_epoch == epoch_now && leased_hold == hold_now
}
