//! The release job's marker (M6 step 5; ADR 0010's "The release job", step 6): what the room decides, as pure rules,
//! for a release it has committed live and whose flight is open, until the release is recorded served or set back.
//!
//! - **Has the switch happened** ([`marker_switched`]): the room's applier has recorded the default host's entry as
//!   written for exactly the version and the script the commit wrote, and the host still wants them. Until then
//!   nothing is fetched: a marker fetched before the switch would be the release before's.
//! - **What to do now** ([`marker_plan`]): wait for the switch, at most [`MARKER_SWITCH_WAIT_MS`] from going live;
//!   fetch the marker, while within [`MARKER_WAIT_MS`] (ADR 0010's provisional 30 seconds) of the switch; or set the
//!   release back once either bound has run out.
//! - **Whose marker came back** ([`marker_seen`]): exactly this release's body, as the job uploaded it, answered `200`.
//!   Anything else, an older release's marker, an error, no answer, is not this release's, and never confirms it.
//! - **What came of a fetch** ([`marker_outcome`]): served, asked again after [`MARKER_POLL_MS`], or set back.
//!
//! A release recorded served is core's `release::confirm_served`; a set-back is `release::set_back`, host by host,
//! and only where the epoch and each host's version are still exactly what the commit wrote. Neither is decided here.
//!
//! Every figure marked **Proposed** is the architect's to rule on.

use crate::release::MARKER_WAIT_MS;
use crate::release_tree::marker_body;

/// How long after going live the room waits for its applier to switch the default host's entry, before the release
/// is set back as [`NOT_SWITCHED`]. The applier retries on its own backoff; a provider that won't take a write for
/// this long sets the release back, and the set-back is the applier's to write in turn. **Proposed.**
pub const MARKER_SWITCH_WAIT_MS: i64 = 10 * 60 * 1000;

/// How often the room looks again: for the switch while it waits for it, and for the marker after a fetch that didn't
/// show this release's. **Proposed.**
pub const MARKER_POLL_MS: i64 = 5_000;

/// How long one fetch of the marker may take before it is no answer. **Proposed.**
pub const MARKER_FETCH_TIMEOUT_MS: i64 = 5_000;

/// The longest marker answer read. The marker is about a hundred bytes; anything longer isn't it. **Proposed.**
pub const MARKER_MAX_BYTES: usize = 1024;

/// How long a marker step may be out before the driver takes it for one that died with its object: one fetch and the
/// room's two transactions either side. **Proposed.**
pub const MARKER_LEASE_MS: i64 = MARKER_FETCH_TIMEOUT_MS + 10_000;

// A step still within its fetch's own time is never taken for a dead one, and there is room to look more than once
// inside the marker's wait.
const _: () = assert!(MARKER_LEASE_MS > MARKER_FETCH_TIMEOUT_MS);
const _: () = assert!(MARKER_POLL_MS > 0 && MARKER_POLL_MS < MARKER_WAIT_MS);
const _: () = assert!(MARKER_POLL_MS < MARKER_SWITCH_WAIT_MS);

/// The code a release ends with when its marker never came back as its own within [`MARKER_WAIT_MS`] of the switch.
pub const MARKER_MISSING: &str = "release_marker_missing";
/// The code a release ends with when the applier never switched its default host within [`MARKER_SWITCH_WAIT_MS`].
pub const NOT_SWITCHED: &str = "release_not_switched";
/// The job's code while it waits for the applier to switch the default host.
pub const AWAITING_SWITCH: &str = "release_awaiting_switch";
/// The job's code while it waits to fetch the marker again.
pub const AWAITING_MARKER: &str = "release_awaiting_marker";

/// Whether the room's applier has switched the default host to the release in flight: the host wants the flight's
/// script at the version the commit wrote, and its entry is recorded applied at exactly that version and script. A
/// missing value on any side is never a match.
pub fn marker_switched(
    desired_version: i64,
    desired_script: Option<&str>,
    flight_version: Option<i64>,
    flight_script: &str,
    applied_version: Option<i64>,
    applied_script: Option<&str>,
) -> bool {
    let Some(written) = flight_version else {
        return false;
    };
    !flight_script.is_empty()
        && desired_version == written
        && desired_script == Some(flight_script)
        && applied_version == Some(written)
        && applied_script == Some(flight_script)
}

/// Whether a fetch of the marker through the host answered with this release's own marker: `200`, and the body exactly
/// as the job uploaded it for this release and commit. No answer is `None`, and is never this release's.
pub fn marker_seen(answer: Option<(u16, &[u8])>, release_id: &str, commit_sha: &str) -> bool {
    let Some((status, body)) = answer else {
        return false;
    };
    status == 200
        && body.len() <= MARKER_MAX_BYTES
        && marker_body(release_id, commit_sha).is_some_and(|marker| marker.as_bytes() == body)
}

/// What the room does now for the release in flight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkerPlan {
    /// The switch is recorded and the wait hasn't run out: fetch the marker.
    Fetch,
    /// Look again at this time, with this code: the switch hasn't happened yet.
    Wait { at: i64, code: &'static str },
    /// A bound has run out: the release fails with this code, and is set back.
    SetBack { code: &'static str },
}

/// What to do for a release that went live at `live_at`, with `switched_at` when the room first saw its default host
/// switched, if it is switched now. The switch's bound runs from going live, the marker's from the switch; each is
/// over at its end, to the millisecond.
pub fn marker_plan(live_at: i64, switched_at: Option<i64>, now: i64) -> MarkerPlan {
    match switched_at {
        Some(switched) if now >= switched.saturating_add(MARKER_WAIT_MS) => MarkerPlan::SetBack {
            code: MARKER_MISSING,
        },
        Some(_) => MarkerPlan::Fetch,
        None => {
            let bound = live_at.saturating_add(MARKER_SWITCH_WAIT_MS);
            if now >= bound {
                MarkerPlan::SetBack { code: NOT_SWITCHED }
            } else {
                MarkerPlan::Wait {
                    at: now.saturating_add(MARKER_POLL_MS).min(bound),
                    code: AWAITING_SWITCH,
                }
            }
        }
    }
}

/// What came of one fetch of the marker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkerOutcome {
    /// This release's marker came back: it is recorded served.
    Served,
    /// It didn't, and the wait isn't over: fetch again at this time.
    Retry { at: i64 },
    /// It didn't, and the wait is over: the release fails, [`MARKER_MISSING`], and is set back.
    SetBack { code: &'static str },
}

/// What came of a fetch recorded at `now`, for a release switched at `switched_at`. **A marker that came back as this
/// release's is recorded served whenever the fetch ends:** it is what the host serves. Otherwise the release is
/// fetched again, never past the wait's end, and at that end it is set back.
pub fn marker_outcome(seen: bool, switched_at: i64, now: i64) -> MarkerOutcome {
    if seen {
        return MarkerOutcome::Served;
    }
    let end = switched_at.saturating_add(MARKER_WAIT_MS);
    if now >= end {
        MarkerOutcome::SetBack {
            code: MARKER_MISSING,
        }
    } else {
        MarkerOutcome::Retry {
            at: now.saturating_add(MARKER_POLL_MS).min(end),
        }
    }
}
