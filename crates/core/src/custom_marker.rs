//! A custom hostname's marker (M6 step 8e; ADR 0010's "Custom domains", step 5, and "The release job", step 6): what
//! the room decides, as pure rules, about the marker of a release on one of its custom hosts.
//!
//! **A custom host takes a release only after its default host's marker confirmed it** (step 8c, kept): the applier
//! writes a custom host's entry only for a release recorded `served`. So the custom host's marker is a second check, of
//! that host alone, once its entry is written:
//!
//! - **Switched** ([`custom_switched`]): the host is open, wants a script whose release is served on the default host,
//!   and the applier has recorded exactly that script written at exactly that version, not refused there, while the app
//!   isn't held. Until then nothing is fetched.
//! - **The fetch** ([`custom_plan`]): from the switch, at most [`MARKER_WAIT_MS`] (ADR 0010's provisional 30 seconds),
//!   as for the default host; then set back.
//! - **What came of it** ([`custom_record`]): **only that host's own marker records the release served on it.** A host
//!   that moved while the fetch was out, closed when its claim ended among them, records nothing, seen or not: after a
//!   deletion the edge can still answer for a name (spike D, item 12), so a marker is never taken as proof of anything
//!   about a host the room no longer serves.
//! - **The set-back** ([`custom_set_back`]): only that custom host goes to nothing, at exactly the version and script
//!   checked, so its applier takes the entry down. The release stays served on its default host, where its own marker
//!   came back. Nothing is put back to an earlier release: what a custom host served before isn't known to be there.
//! - **Again** ([`custom_reopen`], [`reopen_wait_ms`]): a set-back host, if nothing moved since, opens again on the
//!   release last confirmed served, after a wait that doubles from a minute to an hour, and is checked again.
//!
//! Every figure marked **Proposed** is the architect's to rule on.

use crate::release::{bump, open_host, DesiredServe, ServeState, MARKER_WAIT_MS};
use crate::release_marker::{marker_outcome, MarkerOutcome};

/// The code a custom host is set back with when its marker never came back as its release's within [`MARKER_WAIT_MS`]
/// of its switch.
pub const CUSTOM_MARKER_MISSING: &str = "custom_marker_missing";
/// The job's code while it waits to fetch a custom host's marker again.
pub const AWAITING_CUSTOM_MARKER: &str = "custom_marker_awaiting";
/// The first wait before a set-back custom host is opened again. **Proposed.**
pub const REOPEN_FIRST_MS: i64 = 60_000;
/// The longest wait before a set-back custom host is opened again. **Proposed.**
pub const REOPEN_MAX_MS: i64 = 60 * 60 * 1000;

const _: () = assert!(REOPEN_FIRST_MS > MARKER_WAIT_MS && REOPEN_FIRST_MS < REOPEN_MAX_MS);

/// What the room's rows say of one custom host, for its marker. Versions are as stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CustomHost<'a> {
    pub closed: bool,
    pub version: i64,
    pub script: Option<&'a str>,
    pub applied_version: Option<i64>,
    pub applied_script: Option<&'a str>,
    /// The version the applier refused the host at, if any.
    pub refused_version: Option<i64>,
    /// A release with the host's script is recorded `served`: its marker came back through the default host.
    pub served_on_default: bool,
    /// The room's app is held because nobody may release (step 6).
    pub held: bool,
}

/// Whether the room's applier has switched a custom host to a release its default host's marker confirmed: see the
/// module's note. A missing value on any side is never a match.
pub fn custom_switched(host: &CustomHost<'_>) -> bool {
    let Some(script) = host.script else {
        return false;
    };
    !host.closed
        && !host.held
        && host.served_on_default
        && host.applied_version == Some(host.version)
        && host.applied_script == Some(script)
        && host.refused_version != Some(host.version)
}

/// What the room does now for a switched custom host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CustomPlan {
    /// The wait hasn't run out: fetch the marker.
    Fetch,
    /// The wait has run out: the host is set back, with this code.
    SetBack { code: &'static str },
}

/// What to do for a custom host the room first saw switched at `switched_at`: fetch until [`MARKER_WAIT_MS`] from
/// then, and set back at that end, to the millisecond.
pub fn custom_plan(switched_at: i64, now: i64) -> CustomPlan {
    if now >= switched_at.saturating_add(MARKER_WAIT_MS) {
        CustomPlan::SetBack {
            code: CUSTOM_MARKER_MISSING,
        }
    } else {
        CustomPlan::Fetch
    }
}

/// What came of one fetch of a custom host's marker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CustomRecord {
    /// Its own marker came back: the release is recorded served on this host.
    Served,
    /// It didn't, and the wait isn't over: fetch again at this time.
    Retry { at: i64 },
    /// It didn't, and the wait is over: the host is set back.
    SetBack { code: &'static str },
    /// The host moved while the fetch was out: nothing is kept and nothing is set back.
    Moved,
}

/// What came of a fetch recorded at `now`, for a host switched at `switched_at`. `still` is whether the host is still
/// exactly what the fetch was leased for: open, the same version and script, written by the same apply, not refused,
/// and the app not held. `seen` is whether that release's own marker came back.
pub fn custom_record(still: bool, seen: bool, switched_at: i64, now: i64) -> CustomRecord {
    if !still {
        return CustomRecord::Moved;
    }
    match marker_outcome(seen, switched_at, now) {
        MarkerOutcome::Served => CustomRecord::Served,
        MarkerOutcome::Retry { at } => CustomRecord::Retry { at },
        MarkerOutcome::SetBack { .. } => CustomRecord::SetBack {
            code: CUSTOM_MARKER_MISSING,
        },
    }
}

/// The set-back of custom host `host`, checked at `version` for `script`: that host alone goes to nothing, open, its
/// version one higher, so its applier takes the entry down. `None`, and nothing changes, for the default host, a host
/// that isn't there, is closed, has moved from the version or names another script, or whose version can't go up.
pub fn custom_set_back(
    state: &ServeState,
    host: usize,
    version: u64,
    script: &str,
) -> Option<ServeState> {
    if host == 0 {
        return None;
    }
    let target = state.hosts.get(host)?;
    if target.closed || target.version != version || target.script.as_deref() != Some(script) {
        return None;
    }
    let next = bump(version)?;
    let mut after = state.clone();
    *after.hosts.get_mut(host)? = DesiredServe {
        script: None,
        version: next,
        closed: false,
    };
    Some(after)
}

/// A custom host set back at `set_back_version` opens again, through `release::open_host`, on the release the room last
/// confirmed served, if nothing moved since: it is still open, serves nothing, and is at exactly the version the
/// set-back wrote. `None` otherwise, and during a rollback's flight (`flight_is_rollback`, as `open_host` reads it).
pub fn custom_reopen(
    state: &ServeState,
    host: usize,
    set_back_version: u64,
    flight_is_rollback: bool,
) -> Option<ServeState> {
    if host == 0 {
        return None;
    }
    let target = state.hosts.get(host)?;
    if target.closed || target.script.is_some() || Some(target.version) != bump(set_back_version) {
        return None;
    }
    open_host(state, host, flight_is_rollback)
}

/// The wait before a custom host set back `set_backs` times in a row is opened again: [`REOPEN_FIRST_MS`], doubling
/// from the second, to [`REOPEN_MAX_MS`].
pub fn reopen_wait_ms(set_backs: u32) -> i64 {
    let doublings = set_backs.saturating_sub(1).min(16);
    REOPEN_FIRST_MS
        .saturating_mul(1_i64 << doublings)
        .min(REOPEN_MAX_MS)
}
