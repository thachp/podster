//! The room's releases awaiting a person's approval (`listReleaseApprovals`; M6 step 10(b), ADR 0010, decision 199),
//! for a person's Needs attention.
//!
//! **Who** is `podster_policy::release::release_view`: only someone who sees the room's release in full, a person who is
//! the room's owner or an admin by the room's rows, who are exactly those `authorize_approval` and `authorize_decline`
//! let decide (decision 215). Everyone else in the room gets `not_allowed`, and an agent never gets here: the Worker
//! refuses it by its kind first. As `getReleaseConfig`, nobody's `Principal` is asked, since a read grants nothing; the
//! approve and decline commands check the person's standing again.
//!
//! **What** is every release in `awaiting_approval` that started under the room's current release epoch while release is
//! on in the room: one under an earlier epoch is ended by the room's bookkeeping (`release_commit::end_stale`) and is
//! never offered. IDs, a commit and times only; nothing an agent wrote. A read: nothing is written or logged.
use super::*;
use podster_core::release::ReleaseState;
use podster_policy::release::{release_view, ReleaseView};

/// The most listed at once. A room asks for at most `MAX_RELEASES_PER_ROOM_PER_DAY` a day, so this is days of asks.
const LISTED: i64 = 50;

/// `GET release-approvals`.
pub(super) fn read(sql: &SqlStorage, who: &Participant) -> R<Value> {
    if release_view(&who.caller, true, false, false) != ReleaseView::Full {
        return Err(ApiError::not_allowed());
    }
    let awaiting = ReleaseState::AwaitingApproval.name();
    let found = rows(
        sql,
        "SELECT r.id, r.task_id, r.commit_sha, r.state, r.requested_by, r.requested_at FROM release r
           JOIN release_config c ON c.enabled = 1 AND r.release_epoch = c.release_epoch
          WHERE r.state = ? ORDER BY r.seq DESC LIMIT ?",
        vec![awaiting.into(), (LISTED + 1).into()],
    )?;
    let more = found.len() as i64 > LISTED;
    let releases: Vec<Value> = found
        .iter()
        .take(LISTED as usize)
        .map(|row| {
            json!({
                "id": text(&row["id"]),
                "task_id": text(&row["task_id"]),
                "commit_sha": text(&row["commit_sha"]),
                "state": awaiting,
                "requested_by": text(&row["requested_by"]),
                "requested_at": int(&row["requested_at"]),
            })
        })
        .collect();
    Ok(json!({ "releases": releases, "more": more }))
}
