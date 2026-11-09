//! Public claim counts on a `Principal` (M4 step 8, decisions 162 and 173). Each Principal keeps its own, exactly, in its
//! own single thread, so two claims at once can't both pass a limit:
//!
//! - **An agent's** public claims active now, at most 3, and made in the last hour, at most 5.
//! - **The linking person's**, for every agent they linked across all their organizations: 3 at once and 5 an hour.
//! - **An organization's**, for its agents: 20 an hour.
//!
//! A claim is reserved here before the room decides, then confirmed or released. An entry is keyed by the room, and for a
//! person or organization also by the agent, so asking again for the same claim counts once. Each request holds its own
//! reservation on the entry, so one request's refusal can't give back a count another request's claim is using: the entry
//! and its hour go only when its last reservation is released and it was never confirmed. An entry the Worker never
//! settled becomes active after two minutes, so a lost answer can only hold a count, never free one while a claim stands.
//!
//! "Active now" is kept here, but the room decides when a claim ends. When a count is at its limit, the Worker asks each
//! listed room whether that claim is still held, and ends the ones it says aren't ([`crate::public`]).
use super::*;
use podster_core::public_claims::{
    check_agent_active, check_hourly, check_person_active, claims_in_window, HourlyCounts,
    PublicClaimLimit,
};

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS public_claim (key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, state TEXT NOT NULL,
  at INTEGER NOT NULL, hour_seq INTEGER);
CREATE TABLE IF NOT EXISTS public_claim_hour (seq INTEGER PRIMARY KEY, key TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS public_claim_reservation (key TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (key, id));
";

/// How long an unsettled entry stays pending, in milliseconds, before it counts as a claim.
const PENDING_MS: i64 = 2 * 60 * 1000;
const HOUR_MS: i64 = 60 * 60 * 1000;

/// Whose count this Principal keeps for a claim.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Whose {
    Agent,
    Person,
    Org,
}

fn whose(body: &Value) -> R<Whose> {
    match body["whose"].as_str() {
        Some("agent") => Ok(Whose::Agent),
        Some("person") => Ok(Whose::Person),
        Some("org") => Ok(Whose::Org),
        _ => Err(ApiError::invalid_argument()),
    }
}

fn field<'a>(body: &'a Value, name: &str) -> R<&'a str> {
    body[name]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(ApiError::invalid_argument)
}

/// A refusal at a limit, as an answer the Worker reads. `active` lists the claims counted as active, by key and room, so
/// the Worker can check stale ones with their rooms. It's IDs only, and never reaches a client.
fn at_limit(limit: PublicClaimLimit, active: Vec<Value>) -> Value {
    json!({ "reserved": false, "code": limit.code(), "reason": limit.reason(), "active": active })
}

fn tidy(sql: &SqlStorage, whose: Whose, now: i64) -> R<()> {
    exec(
        sql,
        "DELETE FROM public_claim_hour WHERE at <= ?",
        vec![(now - HOUR_MS).into()],
    )?;
    // Never dropped: an unsettled entry becomes a claim, and only its room's answer at the limit frees it.
    exec(
        sql,
        "UPDATE public_claim SET state = 'active' WHERE state = 'pending' AND at <= ?",
        vec![(now - PENDING_MS).into()],
    )?;
    if whose == Whose::Org {
        // An organization's entries only make a retry count once, so they go after the hour.
        exec(
            sql,
            "DELETE FROM public_claim WHERE at <= ?",
            vec![(now - HOUR_MS).into()],
        )?;
    }
    exec(
        sql,
        "DELETE FROM public_claim_reservation WHERE key NOT IN (SELECT key FROM public_claim)",
        vec![],
    )?;
    Ok(())
}

/// Reserves one public claim, or refuses at a limit. `{ whose, key, workspace_id, reservation }`. A key already held,
/// pending or active, is the same claim asked for again, so it takes this request's reservation and counts nothing.
pub(super) fn reserve(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    exec(sql, SCHEMA, vec![])?;
    let whose = whose(body)?;
    let key = field(body, "key")?;
    let workspace = field(body, "workspace_id")?;
    let reservation = field(body, "reservation")?;
    tidy(sql, whose, now)?;
    let held = !rows(
        sql,
        "SELECT key FROM public_claim WHERE key = ?",
        vec![key.into()],
    )?
    .is_empty();
    if !held {
        let active = rows(sql, "SELECT key, workspace_id FROM public_claim", vec![])?;
        let hour: Vec<i64> = rows(sql, "SELECT at FROM public_claim_hour", vec![])?
            .iter()
            .map(|row| int(&row["at"]) / 1000)
            .collect();
        let in_hour = claims_in_window(&hour, now / 1000);
        let active_count = u32::try_from(active.len()).unwrap_or(u32::MAX);
        let checked = match whose {
            Whose::Agent => check_agent_active(active_count).and_then(|()| {
                check_hourly(HourlyCounts {
                    agent: in_hour,
                    ..Default::default()
                })
            }),
            Whose::Person => check_person_active(active_count).and_then(|()| {
                check_hourly(HourlyCounts {
                    person: in_hour,
                    ..Default::default()
                })
            }),
            Whose::Org => check_hourly(HourlyCounts {
                org: in_hour,
                ..Default::default()
            }),
        };
        if let Err(limit) = checked {
            let listed = active
                .iter()
                .map(|row| json!({ "key": row["key"], "workspace_id": row["workspace_id"] }))
                .collect();
            return Ok(at_limit(limit, listed));
        }
        exec(
            sql,
            "INSERT INTO public_claim_hour (key, at) VALUES (?, ?)",
            vec![key.into(), now.into()],
        )?;
        exec(
            sql,
            "INSERT INTO public_claim (key, workspace_id, state, at, hour_seq) VALUES (?, ?, 'pending', ?, last_insert_rowid())",
            vec![key.into(), workspace.into(), now.into()],
        )?;
    }
    exec(
        sql,
        "INSERT OR IGNORE INTO public_claim_reservation (key, id) VALUES (?, ?)",
        vec![key.into(), reservation.into()],
    )?;
    Ok(json!({ "reserved": true, "counted": !held }))
}

/// Settles a reservation. `{ key, outcome, reservation?, workspace_id?, whose? }`:
///
/// - **`confirm`** makes the entry active, for the room's yes, or for a retry of a claim the room says it holds. It's
///   idempotent, and makes the entry if it went missing, so a lost answer can't leave a standing claim uncounted.
/// - **`release`** gives back this request's reservation when the room refused. The entry and its hour go only when no
///   reservation is left on it and it was never confirmed, so another request's claim keeps its count.
/// - **`end`** drops an active entry the room says has ended, keeping its hour.
pub(super) fn settle(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    exec(sql, SCHEMA, vec![])?;
    let key = field(body, "key")?;
    match body["outcome"].as_str() {
        Some("confirm") => {
            let workspace = field(body, "workspace_id")?;
            exec(
                sql,
                "INSERT INTO public_claim (key, workspace_id, state, at) VALUES (?, ?, 'active', ?)
                   ON CONFLICT (key) DO UPDATE SET state = 'active'",
                vec![key.into(), workspace.into(), now.into()],
            )?;
            exec(
                sql,
                "DELETE FROM public_claim_reservation WHERE key = ?",
                vec![key.into()],
            )?;
            // An organization's count is hourly only, so its entry has done its work once the claim stands.
            if body["whose"].as_str() == Some("org") {
                exec(
                    sql,
                    "DELETE FROM public_claim WHERE key = ?",
                    vec![key.into()],
                )?;
            }
        }
        Some("release") => {
            let reservation = field(body, "reservation")?;
            exec(
                sql,
                "DELETE FROM public_claim_reservation WHERE key = ? AND id = ?",
                vec![key.into(), reservation.into()],
            )?;
            let others = !rows(
                sql,
                "SELECT id FROM public_claim_reservation WHERE key = ?",
                vec![key.into()],
            )?
            .is_empty();
            let entry = rows(
                sql,
                "SELECT state, hour_seq FROM public_claim WHERE key = ?",
                vec![key.into()],
            )?;
            if let Some(entry) = entry.first() {
                if entry["state"].as_str() == Some("pending") && !others {
                    exec(
                        sql,
                        "DELETE FROM public_claim WHERE key = ?",
                        vec![key.into()],
                    )?;
                    if let Some(seq) = entry["hour_seq"].as_i64() {
                        exec(
                            sql,
                            "DELETE FROM public_claim_hour WHERE seq = ?",
                            vec![seq.into()],
                        )?;
                    }
                }
            }
        }
        Some("end") => exec(
            sql,
            "DELETE FROM public_claim WHERE key = ? AND state = 'active'",
            vec![key.into()],
        )?,
        _ => return Err(ApiError::invalid_argument()),
    }
    Ok(json!({ "settled": true }))
}
