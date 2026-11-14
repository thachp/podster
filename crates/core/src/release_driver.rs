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
//!   [`DRIVE_MAX_WAIT_MS`], and never before a time the step itself named, the read budget's. It grows with the
//!   attempts in a row that left the release where it was ([`stalls_after`]), and starts again from the first wait
//!   once a step moves the release on.
//! - **How many attempts** ([`MAX_DRIVE_ATTEMPTS`]): past it the release ends, [`ATTEMPTS_EXHAUSTED`].
//! - **How often a room may read** ([`upload_slot`]): at most [`MAX_UPLOAD_ATTEMPTS_PER_ROOM_PER_HOUR`] upload attempts
//!   begun in a rolling hour in one room, whichever of its releases they are for. Each attempt reserves up to
//!   [`MAX_ATTEMPT_READS`] of the deployment's [`MAX_RELEASE_READS_PER_HOUR`], so one room, and so one waiting release,
//!   can hold at most [`MAX_ROOM_READS_PER_HOUR`] of them.
//! - **How long a step may be out** ([`DRIVE_LEASE_MS`]): a step that hasn't come back by then is taken for one that
//!   died with its object, and the release is taken up again. A step still running asks nothing more outside the room
//!   and writes nothing once its lease has run out ([`lease_holds`]).
//!
//! Every figure marked **Proposed** is the architect's to rule on.

use crate::release::{
    read_budget_wait, reads_wait_under, window_start, ReleaseState, ATTEMPT_DEADLINE_MS,
    FETCH_PASSES, MAX_RELEASE_READS_PER_HOUR, READ_WINDOW_MS, TREE_READS,
};
use crate::release_tree::MAX_FILES;

/// The code a release ends with when the driver has used up its attempts.
pub const ATTEMPTS_EXHAUSTED: &str = "release_attempts_exhausted";

/// The most steps the driver asks of one release, every kind counted, including those that moved it on. The happy path
/// is three: start, upload, commit. **Proposed.**
pub const MAX_DRIVE_ATTEMPTS: u32 = 8;

/// The first wait after a step that left a release where it was. **Proposed.**
pub const DRIVE_FIRST_WAIT_MS: i64 = 30_000;

/// The longest wait between two steps for one release. With [`MAX_DRIVE_ATTEMPTS`] the seven waits of a release that
/// never moves add up to 35.5 minutes (30 s, 1, 2, 4 and 8 minutes, then 10 and 10), inside its upload's hour with a
/// lease to spare. A release that moves on waits less: its waits start again from the first. **Proposed.**
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

/// The most of the deployment's hourly reads one owner may hold, over all its rooms and releases: what one room can
/// hold, 1,204 of 3,000, so an owner keeps exactly two full attempts (`docs/m6-release-read-share.md`, ruling 2). An
/// owner is the room's organization, else its owner person, else the room itself ([`read_owner_key`]). Two owners at
/// their whole share leave 592, less than a full attempt: a third owner's full-size release waits, which the ruling
/// accepts until contention is measured. **Proposed.**
pub const MAX_OWNER_READS_PER_HOUR: u32 = MAX_ROOM_READS_PER_HOUR;

// An owner can always make one full attempt, and never holds the deployment's budget alone: a full attempt of another
// owner always fits beside a whole share.
const _: () = assert!(MAX_OWNER_READS_PER_HOUR >= MAX_ATTEMPT_READS);
const _: () = assert!(MAX_RELEASE_READS_PER_HOUR - MAX_OWNER_READS_PER_HOUR >= MAX_ATTEMPT_READS);

/// The code a queued release waits under while its owner's share, or the deployment's hour, has no room for a full
/// attempt. It counts no attempt ([`waits_uncounted`]). **Proposed.**
pub const READ_SHARE_WAITING: &str = "release_reads_share";

/// The code a release waits under while another release's commit or rollback waits for its marker (`m6-plan.md`
/// ruling 7). Its wait is not built yet; it is named here so the two uncounted waits share one rule.
const IN_FLIGHT_WAITING: &str = "release_in_flight";

/// The waits that count no driver attempt, take no upload slot and so never end a release by the cap: the read share's
/// and the marker's ([`READ_SHARE_WAITING`] and `release_in_flight`). Nothing else.
pub fn waits_uncounted(code: &str) -> bool {
    matches!(code, READ_SHARE_WAITING | IN_FLIGHT_WAITING)
}

/// The owner a room's reads are charged to, as the key the deployment's budget keeps: `org:` the room's organization,
/// else `person:` its owner person, else `room:` the room itself. An empty value counts as none. `None` when the one
/// chosen isn't an ID, so a room whose owner can't be read reserves nothing.
pub fn read_owner_key(org: Option<&str>, person: Option<&str>, room: &str) -> Option<String> {
    let key = match (
        org.filter(|org| !org.is_empty()),
        person.filter(|person| !person.is_empty()),
    ) {
        (Some(org), _) => format!("org:{org}"),
        (None, Some(person)) => format!("person:{person}"),
        (None, None) => format!("room:{room}"),
    };
    is_read_owner_key(&key).then_some(key)
}

/// The longest ID an owner key carries.
const MAX_OWNER_ID_BYTES: usize = 128;

/// Whether `key` is an owner key as [`read_owner_key`] makes them: a kind, a colon, and an ID of letters, digits, `_`
/// and `-`.
pub fn is_read_owner_key(key: &str) -> bool {
    let Some((kind, id)) = key.split_once(':') else {
        return false;
    };
    matches!(kind, "org" | "person" | "room")
        && !id.is_empty()
        && id.len() <= MAX_OWNER_ID_BYTES
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The read share, asked for `needed` reads by one owner: `held_by_owner` is that owner's reservations and `held_all`
/// every reservation, the owner's among them, each as `(reserved_at, reads)` in any order. `Ok` when the reads fit both
/// the owner's share ([`MAX_OWNER_READS_PER_HOUR`]) and the deployment's hour now. Otherwise the later of the two times
/// each would fit, if nothing else were reserved meanwhile, or `None` when `needed` alone is past either.
pub fn read_share_wait(
    held_by_owner: &[(i64, u32)],
    held_all: &[(i64, u32)],
    needed: u32,
    now: i64,
) -> Result<(), Option<i64>> {
    let owner = reads_wait_under(MAX_OWNER_READS_PER_HOUR, held_by_owner, needed, now);
    let total = read_budget_wait(held_all, needed, now);
    match (owner, total) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(None), _) | (_, Err(None)) => Err(None),
        (Err(Some(at)), Ok(())) | (Ok(()), Err(Some(at))) => Err(Some(at)),
        (Err(Some(owner)), Err(Some(total))) => Err(Some(owner.max(total))),
    }
}

/// When a queued release told to wait by the read share is next due: the time the share named, and never sooner than
/// the first wait from `now`, so a clock that differs between two objects can't bring the release straight back.
pub fn read_share_due(retry_at: i64, now: i64) -> i64 {
    retry_at.max(now.saturating_add(DRIVE_FIRST_WAIT_MS))
}

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

/// The wait after the `attempts`-th attempt in a row left a release where it was: [`DRIVE_FIRST_WAIT_MS`] after the first,
/// doubling, at most [`DRIVE_MAX_WAIT_MS`]. Never less than the first wait.
pub fn drive_wait_ms(attempts: u32) -> i64 {
    let doublings = attempts.saturating_sub(1).min(20);
    DRIVE_FIRST_WAIT_MS
        .saturating_mul(1_i64 << doublings)
        .min(DRIVE_MAX_WAIT_MS)
}

/// What came of a step. `before` is the step that was asked; `after` the step the release is at now, from its state
/// and its upload's record after the step (`None` when it isn't the driver's any more); `attempts` how many the driver
/// has made for it, this one included; `stalled` how many attempts in a row before this one left it where it was
/// since it last moved on; `retry_at` a time the step named, the read budget's, before which nothing fits.
///
/// - Another step: [`DriveOutcome::Next`].
/// - No step: [`DriveOutcome::Done`].
/// - The same step: it waits, by [`drive_wait_ms`] of the attempts in a row that left it where it was, this one
///   included, and never before `retry_at`; or, with every attempt made, [`DriveOutcome::GiveUp`]. **The cap counts
///   every attempt; the wait counts only those since the release last moved on,** so a commit that stalls after a
///   good start and upload waits the first wait, not the third.
pub fn drive_outcome(
    before: DriveStep,
    after: Option<DriveStep>,
    attempts: u32,
    stalled: u32,
    retry_at: Option<i64>,
    now: i64,
) -> DriveOutcome {
    match after {
        None => DriveOutcome::Done,
        Some(step) if step != before => DriveOutcome::Next,
        Some(_) if attempts >= MAX_DRIVE_ATTEMPTS => DriveOutcome::GiveUp,
        Some(_) => {
            let backoff = now.saturating_add(drive_wait_ms(stalled.saturating_add(1)));
            DriveOutcome::Retry {
                at: retry_at.map_or(backoff, |at| at.max(backoff)),
            }
        }
    }
}

/// How many attempts in a row have left a release where it was, after a step: one more than `stalled` when it is at
/// the same step, and none once it moved on or out of the driver's hands.
pub fn stalls_after(before: DriveStep, after: Option<DriveStep>, stalled: u32) -> u32 {
    if after == Some(before) {
        stalled.saturating_add(1)
    } else {
        0
    }
}

/// Whether a step's lease, given until `until`, still holds at `now`. At `until` it has run out: from then a pass may
/// lease the release again, so the step it was given asks nothing more and writes nothing.
pub fn lease_holds(until: i64, now: i64) -> bool {
    now < until
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
