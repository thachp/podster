//! The ceiling on unpublishes for a repository's link, in the `Moderation` object (M6 step 6; decided by the architect
//! on 2026-11-14, for the owner to review).
//!
//! Each room reads its own repository's link, from its own alarm, so there is no pass over rooms that could count
//! them. This object is the one every room can ask, so the ceiling lives here, counted by time:
//! `podster_core::release::repo_unpublish_permit` decides, with `REPO_UNPUBLISH_CEILING` and its share, both Proposed.
//!
//! - **A room asks before it unpublishes for this cause,** `{ room, wanted: true, operator }`, and this object answers
//!   `{ permit }` in one transaction of its own: two rooms asking at once can't both take the last place. A grant is
//!   kept for the window, so a room whose unpublish failed after it is granted again.
//! - **Past the ceiling the room is held,** and so is every room that asks after it: the ceiling is tripped. Each held
//!   room is a finding of its own, `repo_unpublish_held`, by the room's ID, so an operator knows what to recheck.
//! - **It clears room by room.** An operator's recheck of a held room confirms it (`operator: true`), and it is granted.
//!   A room whose cause cleared, its link ready again or nothing up, says so (`wanted: false`): from an operator's
//!   recheck, from its own alarm, or in its answer to the reconcile's walk. Its finding goes with it. Once no room is
//!   held the trip clears. **The count is a true rolling hour** (the architect's ruling of 2026-11-14): clearing a trip
//!   never forgets the hour's grants, so held rooms that ask again proceed only within what the hour still has, and a
//!   grant the room didn't use, because its link healed meanwhile, still counts. Nothing that came down comes back.
//! - **An ask that stalled is told by the room's ID,** `repo_unpublish_stalled`: undecided, recorded here; no answer or
//!   a granted unpublish that failed, sent by the room. Any later answer here to that room takes it away.
//!
//! What it reads that it doesn't own: how many rooms have apps, from the app-label lookup table in D1. It only sizes
//! the ceiling, and only ever smaller than the fixed number: it never lets anything down that the number wouldn't. Read
//! before the transaction; one that can't be read decides nothing, and the room asks again later.
//!
//! The rooms' IDs are kept here, an operator-only store. Logs carry codes and counts.
use crate::error::ApiError;
use crate::store::{exec, int, rows, text};
use podster_core::release::{
    repo_unpublish_counts, repo_unpublish_permit, RepoUnpublishAsk, RepoUnpublishPermit,
};
use serde_json::{json, Value};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// The `Moderation` object's path for a room's ask. Nothing outside the Worker reaches it.
pub(crate) const PATH: &str = "/repo-unpublish";

/// `repo_unpublish_grant`: rooms granted within the window. `repo_unpublish_held`: rooms held past the ceiling.
/// `repo_unpublish_trip`: whether the ceiling is tripped, written last when it trips and cleared last when it clears.
pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS repo_unpublish_grant (room TEXT PRIMARY KEY CHECK (length(room) BETWEEN 1 AND 128), at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS repo_unpublish_held (room TEXT PRIMARY KEY CHECK (length(room) BETWEEN 1 AND 128), at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS repo_unpublish_trip (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), at INTEGER NOT NULL);
";

/// The operators' finding for each room the ceiling holds, by the room's ID.
pub(crate) const FINDING: &str = "repo_unpublish_held";
/// The operators' finding for a room whose ask stalled, by the room's ID, with why in `detail`.
pub(crate) const STALLED: &str = "repo_unpublish_stalled";

/// How many rooms have apps, by the app-label lookup table, or `None` when it can't be read.
pub(crate) async fn rooms_with_apps(env: &Env) -> Option<u64> {
    let found = env
        .d1("DB")
        .ok()?
        .prepare("SELECT count(DISTINCT workspace_id) AS n FROM app_label_index")
        .first::<Value>(None)
        .await
        .ok()??;
    found["n"].as_u64()
}

fn tripped(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(sql, "SELECT 1 AS tripped FROM repo_unpublish_trip", vec![])?.is_empty())
}

fn held_count(sql: &SqlStorage) -> R<i64> {
    Ok(
        rows(sql, "SELECT count(*) AS n FROM repo_unpublish_held", vec![])?
            .first()
            .map_or(0, |row| int(&row["n"])),
    )
}

/// Once no room is held, a tripped ceiling clears. The hour's grants stay: the count is a rolling hour, whatever cleared
/// the trip.
fn clear_if_done(sql: &SqlStorage) -> R<()> {
    if !tripped(sql)? || held_count(sql)? > 0 {
        return Ok(());
    }
    exec(sql, "DELETE FROM repo_unpublish_trip", vec![])?;
    console_log!("repo ceiling: cleared: code=repo_unpublish_cleared");
    Ok(())
}

/// A room no longer waits on the ceiling: its cause cleared, or nothing is up. Forgotten as held; if it was the last,
/// the ceiling clears.
pub(crate) fn noted(sql: &SqlStorage, room: &str) -> R<()> {
    exec(
        sql,
        "DELETE FROM repo_unpublish_held WHERE room = ?",
        vec![room.into()],
    )?;
    forget_findings(sql, room)?;
    clear_if_done(sql)
}

/// The room's two findings, held and stalled, taken away: it was answered, or no longer waits.
fn forget_findings(sql: &SqlStorage, room: &str) -> R<()> {
    exec(
        sql,
        "DELETE FROM takedown_finding WHERE code IN (?, ?) AND subject = ?",
        vec![FINDING.into(), STALLED.into(), room.into()],
    )
}

/// One room's ask, `{ room, wanted, operator }`, answered `{ permit }` with core's decision, or `noted` for a room that
/// no longer wants one. In the caller's transaction. `rooms_with_apps` was read before it.
pub(crate) fn ask(
    sql: &SqlStorage,
    body: &Value,
    rooms_with_apps: Option<u64>,
    now: i64,
) -> R<Value> {
    let room = body["room"]
        .as_str()
        .filter(|room| crate::valid_id(room))
        .ok_or_else(ApiError::invalid_argument)?;
    let Some(wanted) = body["wanted"].as_bool() else {
        return Err(ApiError::invalid_argument());
    };
    let operator = body["operator"] == true;
    if !wanted {
        noted(sql, room)?;
        return Ok(json!({ "permit": "noted" }));
    }
    // Grants that no longer count leave, by core's edge.
    let mut granted_before = false;
    let mut granted_in_window: u32 = 0;
    for row in rows(sql, "SELECT room, at FROM repo_unpublish_grant", vec![])? {
        let (Some(granted), at) = (text(&row["room"]), int(&row["at"])) else {
            continue;
        };
        if !repo_unpublish_counts(at, now) {
            exec(
                sql,
                "DELETE FROM repo_unpublish_grant WHERE room = ?",
                vec![granted.into()],
            )?;
        } else if granted == room {
            granted_before = true;
        } else {
            granted_in_window = granted_in_window.saturating_add(1);
        }
    }
    let permit = repo_unpublish_permit(RepoUnpublishAsk {
        operator,
        granted_before,
        tripped: tripped(sql)?,
        granted_in_window,
        rooms_with_apps,
    });
    match permit {
        RepoUnpublishPermit::Grant => {
            // An operator's confirmation isn't counted: it is that operator's act, not one of the ceiling's places.
            if !operator && !granted_before {
                exec(
                    sql,
                    "INSERT INTO repo_unpublish_grant (room, at) VALUES (?, ?)",
                    vec![room.into(), now.into()],
                )?;
            }
            noted(sql, room)?;
        }
        RepoUnpublishPermit::Hold => {
            exec(
                sql,
                "INSERT INTO repo_unpublish_held (room, at) VALUES (?, ?) ON CONFLICT (room) DO NOTHING",
                vec![room.into(), now.into()],
            )?;
            exec(
                sql,
                "INSERT INTO repo_unpublish_trip (singleton, at) VALUES (1, ?) ON CONFLICT (singleton) DO NOTHING",
                vec![now.into()],
            )?;
            exec(
                sql,
                "DELETE FROM takedown_finding WHERE code = ? AND subject = ?",
                vec![STALLED.into(), room.into()],
            )?;
            crate::reconcile::keep(sql, &json!({ "code": FINDING, "subject": room }), now)?;
            let held = held_count(sql)?;
            console_error!(
                "repo ceiling: an unpublish was held: code={} held={}",
                FINDING,
                held
            );
        }
        RepoUnpublishPermit::Undecided => {
            crate::reconcile::keep(
                sql,
                &json!({ "code": STALLED, "subject": room, "detail": "undecided" }),
                now,
            )?;
            console_error!(
                "repo ceiling: the rooms with apps couldn't be counted: code=rooms_uncounted"
            );
        }
    }
    Ok(json!({ "permit": permit.code() }))
}
