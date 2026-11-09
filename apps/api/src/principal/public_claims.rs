//! Public claim counts on a `Principal` (M4 step 8, decisions 162 and 173). Each Principal keeps its own, exactly, in its
//! own single thread, so two claims at once can't both pass a limit:
//!
//! - **An agent's** public claims active now, at most 3, and made in the last hour, at most 5.
//! - **The linking person's**, for every agent they linked across all their organizations: 3 at once and 5 an hour.
//! - **An organization's**, for its agents: 20 an hour.
//!
//! A claim is reserved here before the room decides, then confirmed or released. An entry is keyed by the room, and for a
//! person or organization also by the agent, so asking again for a claim the room says the agent holds counts once, and
//! asking after it ended counts again ([`reserve`]). Each request holds its own
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
        "UPDATE public_claim SET state = 'active' WHERE state IN ('pending', 'replacing') AND at <= ?",
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

/// The room's word on whether the agent holds the claim now, as the Worker read it just before.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Held {
    Yes,
    No,
    Unknown,
}

fn held(body: &Value) -> R<Held> {
    match body["held"].as_str() {
        Some("yes") => Ok(Held::Yes),
        Some("no") => Ok(Held::No),
        Some("unknown") => Ok(Held::Unknown),
        _ => Err(ApiError::invalid_argument()),
    }
}

/// Reserves one public claim, or refuses at a limit. `{ whose, key, workspace_id, reservation, held }`:
///
/// - **A retry**, when the room says it holds the claim and an entry is here: it takes this request's reservation,
///   counts nothing, and answers `retry`, so the room takes the request only as a retry. An organization's entry goes
///   once the claim is confirmed, so for an organization a retry needs no entry.
/// - **Stale**, any other entry, pending ones included: the room said the claim isn't held or didn't answer, so this may
///   be a new claim, and nothing here learns when a claim ends. It's counted afresh, with every limit and an hour.
///   Counting twice in a race is the price, and fails closed. If the room said the claim isn't held and the old entry
///   is settled, it and its reservations go first, so a lost answer can't keep the new one alive. If the room didn't
///   answer, or the old entry is still unsettled with reservations on it, another request's claim may stand on it, so
///   it's kept as `replacing`, and a refusal puts it back: a claim that may still stand is never left uncounted.
pub(super) fn reserve(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    exec(sql, SCHEMA, vec![])?;
    let whose = whose(body)?;
    let key = field(body, "key")?;
    let workspace = field(body, "workspace_id")?;
    let reservation = field(body, "reservation")?;
    let held = held(body)?;
    tidy(sql, whose, now)?;
    let entry = rows(
        sql,
        "SELECT state, (SELECT COUNT(*) FROM public_claim_reservation r WHERE r.key = c.key) AS live
           FROM public_claim c WHERE key = ?",
        vec![key.into()],
    )?;
    let existing = !entry.is_empty();
    // Another request is still out on it: its room answer may be lost with its claim committed.
    let unsettled = entry
        .first()
        .is_some_and(|e| e["state"].as_str() != Some("active") && int(&e["live"]) > 0);
    if held == Held::Yes && (existing || whose == Whose::Org) {
        take(sql, key, reservation)?;
        return Ok(json!({ "reserved": true, "counted": false, "retry": true }));
    }
    let mut replacing = false;
    if existing {
        if held == Held::No && !unsettled {
            // The room's word: the claim ended. Its hour stays.
            exec(
                sql,
                "DELETE FROM public_claim WHERE key = ?",
                vec![key.into()],
            )?;
            exec(
                sql,
                "DELETE FROM public_claim_reservation WHERE key = ?",
                vec![key.into()],
            )?;
        } else {
            replacing = true;
        }
    }
    // The key's own entry, if kept, is being counted afresh, so it isn't counted twice here.
    let active = rows(
        sql,
        "SELECT key, workspace_id FROM public_claim WHERE key != ?",
        vec![key.into()],
    )?;
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
    if replacing {
        exec(
            sql,
            "UPDATE public_claim SET workspace_id = ?, state = 'replacing', at = ?, hour_seq = last_insert_rowid()
               WHERE key = ?",
            vec![workspace.into(), now.into(), key.into()],
        )?;
    } else {
        exec(
            sql,
            "INSERT INTO public_claim (key, workspace_id, state, at, hour_seq) VALUES (?, ?, 'pending', ?, last_insert_rowid())",
            vec![key.into(), workspace.into(), now.into()],
        )?;
    }
    take(sql, key, reservation)?;
    Ok(json!({ "reserved": true, "counted": true, "retry": false }))
}

fn take(sql: &SqlStorage, key: &str, reservation: &str) -> R<()> {
    exec(
        sql,
        "INSERT OR IGNORE INTO public_claim_reservation (key, id) VALUES (?, ?)",
        vec![key.into(), reservation.into()],
    )
}

/// Settles a reservation. `{ key, outcome, reservation?, workspace_id?, whose? }`:
///
/// - **`confirm`** makes the entry active, for the room's yes, or for a retry of a claim the room says it holds. It's
///   idempotent, and makes the entry if it went missing, so a lost answer can't leave a standing claim uncounted.
/// - **`release`** gives back this request's reservation when the room refused. The entry and its hour go only when no
///   reservation is left on it and it was never confirmed, so another request's claim keeps its count. An entry that was
///   `replacing` an older one goes back to that one, active, giving back only the new hour, even with the older one's
///   reservations still on it.
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
                let state = entry["state"].as_str();
                // A `replacing` entry goes back to what it replaced whatever else is on it, since reservations left on it
                // are the older request's, whose claim may stand. A pending one goes only with its last reservation.
                if (state == Some("pending") && !others) || state == Some("replacing") {
                    if state == Some("pending") {
                        exec(
                            sql,
                            "DELETE FROM public_claim WHERE key = ?",
                            vec![key.into()],
                        )?;
                    } else {
                        // The claim it replaced may still stand, so it's put back as it was.
                        exec(
                            sql,
                            "UPDATE public_claim SET state = 'active', hour_seq = NULL WHERE key = ?",
                            vec![key.into()],
                        )?;
                    }
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
