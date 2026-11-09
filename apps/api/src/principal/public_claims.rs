//! Public claim counts on a `Principal` (M4 step 8, decision 162). Each Principal keeps its own, exactly, in its own single
//! thread, so two claims at once can't both pass a limit:
//!
//! - **An agent's** public claims active now, at most 3, and made in the last hour, at most 5.
//! - **The linking person's**, for every agent they linked across all their organizations: 3 at once and 5 an hour.
//! - **An organization's**, for its agents: 20 an hour.
//!
//! A claim is reserved here before the room decides, then confirmed or released. A reservation the Worker never settled
//! counts until it's two minutes old, so a lost answer can only refuse, never let a claim past a limit. An entry is keyed
//! by the room, and for a person or organization also by the agent, so asking again for the same claim counts once.
//!
//! "Active now" is kept here, but the room decides when a claim ends. When a count is at its limit, the Worker asks each
//! listed room whether that claim is still held, and ends the ones that aren't before asking again ([`crate::public`]).
use super::*;
use podster_core::public_claims::{
    check_agent_active, check_hourly, check_person_active, claims_in_window, HourlyCounts,
    PublicClaimLimit,
};

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS public_claim (key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, state TEXT NOT NULL,
  at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS public_claim_hour (seq INTEGER PRIMARY KEY, key TEXT NOT NULL, at INTEGER NOT NULL);
";

/// How long an unsettled reservation keeps counting, in milliseconds.
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

/// Reserves one public claim, or refuses at a limit. `{ whose, key, workspace_id, replace_stale }`.
pub(super) fn reserve(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    exec(sql, SCHEMA, vec![])?;
    let whose = whose(body)?;
    let key = field(body, "key")?;
    let workspace = field(body, "workspace_id")?;
    exec(
        sql,
        "DELETE FROM public_claim_hour WHERE at <= ?",
        vec![(now - HOUR_MS).into()],
    )?;
    exec(
        sql,
        "DELETE FROM public_claim WHERE state = 'pending' AND at <= ?",
        vec![(now - PENDING_MS).into()],
    )?;
    if let Some(row) = rows(
        sql,
        "SELECT state FROM public_claim WHERE key = ?",
        vec![key.into()],
    )?
    .first()
    {
        // The same claim asked for again while it's being made counts once. An active one the room says has ended is
        // stale, and the Worker says so.
        if row["state"].as_str() == Some("pending") || body["replace_stale"].as_bool() != Some(true)
        {
            return Ok(json!({ "reserved": true, "counted": false }));
        }
        exec(
            sql,
            "DELETE FROM public_claim WHERE key = ?",
            vec![key.into()],
        )?;
    }
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
    // An organization's count is hourly only, so its entry is only there to make a retry count once.
    exec(
        sql,
        "INSERT INTO public_claim (key, workspace_id, state, at) VALUES (?, ?, 'pending', ?)",
        vec![key.into(), workspace.into(), now.into()],
    )?;
    exec(
        sql,
        "INSERT INTO public_claim_hour (key, at) VALUES (?, ?)",
        vec![key.into(), now.into()],
    )?;
    Ok(json!({ "reserved": true, "counted": true }))
}

/// Settles a reservation: `confirm` keeps it, `release` gives it back, hour included, when the room refused, and `end`
/// drops an active claim the room says has ended, keeping its hour. `{ key, outcome }`.
pub(super) fn settle(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    exec(sql, SCHEMA, vec![])?;
    let key = field(body, "key")?;
    match body["outcome"].as_str() {
        Some("confirm") => exec(
            sql,
            "UPDATE public_claim SET state = 'active', at = ? WHERE key = ? AND state = 'pending'",
            vec![now.into(), key.into()],
        )?,
        Some("release") => {
            let pending = !rows(
                sql,
                "SELECT key FROM public_claim WHERE key = ? AND state = 'pending'",
                vec![key.into()],
            )?
            .is_empty();
            if pending {
                exec(
                    sql,
                    "DELETE FROM public_claim WHERE key = ?",
                    vec![key.into()],
                )?;
                exec(
                    sql,
                    "DELETE FROM public_claim_hour WHERE seq = (SELECT MAX(seq) FROM public_claim_hour WHERE key = ?)",
                    vec![key.into()],
                )?;
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
