//! Who holds a custom hostname (M6 step 2, ADR 0010's "Custom domains", decision 201).
//!
//! One object for each normalized hostname, named by it. It holds at most one claim that isn't ended, which is what
//! makes one hostname one room's: a D1 row must never decide that. A hostname's suspension lives here too, with no
//! room, so it outlives every claim.
//!
//! **What is built:** its state (step 2), and an operator's suspension of the name and its lifting (step 4(a)), decided
//! by `podster_core::hostnames::suspend` and `lift`. A suspension stays through and after any claim, and advances the
//! name's generation, as a lift does, so no request made before either can claim after it. If a room holds the name
//! when it is suspended, the claim starts ending at once and the room is told, by a notice this object keeps and sends
//! again, from its alarm, until the room has answered. Lifting restores nothing.
//!
//! **Built with step 8's first PR:** giving the claim to the first room whose proof passed, by
//! `podster_core::hostnames::decide_ask`, recorded with the request's ID and the generation it was made under; and a
//! room's withdrawal of a request it never committed as claimed, which frees a claim given for it at once and is kept,
//! so an ask that arrives after it is refused. Its read also answers the name's generation, which a room keeps with a
//! request it makes.
//!
//! **Built with step 8b:** the long end of a claim a room committed. The room says the claim is ending, and the object
//! marks it so (`podster_core::hostnames::begin_end`): it serves nothing from then, and is never granted again. Once
//! the room has cleared the host and read the custom hostname gone at Cloudflare, it says so, and the object frees the
//! claim (`free_ended`), only that room's and request's, and only once it is ending. Each answers what it did, and
//! asking again changes nothing more. The object never calls Cloudflare: the room's job does, and the object takes the
//! room's word, as it takes its word that its proof matched. Its read answers what it holds, and for a hostname nobody
//! has asked about it answers empty and leaves no state behind.
//!
//! - `hostname`: the name this object is for, with the name's `generation`, which core's `suspend`, `lift` and `free`
//!   each advance (`podster_core::hostnames::HostnameRecord`), and when it was last freed, suspended and lifted. A
//!   request is honoured only under the generation it was made under, which the room keeps with the request.
//! - `claim.generation`: the name's generation the claim was given under, which is its request's own. A notice
//!   carries it, so the room acts only for the request it was made for. **Whatever gives a claim (step 8) must set it.**
//! - `claim`: every claim there has been. `held` is 1 while a claim is `live` or `ending` and null once `ended`, and it
//!   is unique, so two claims can't hold the name at once. A claim that is `ending` still holds the name: it is freed
//!   only after the custom hostname is read as gone at Cloudflare.
//! - `suspension`: an operator's suspension of the name. While it holds, nobody gets a claim or starts a challenge.
//! - `withdrawn`: each request a room withdrew here (step 8), by the room's and the request's IDs. Such a request is
//!   never granted, whichever of the ask and the withdrawal arrived first.
//! - `notice`: what the object owes a room, kept and sent again until the room has answered: that the name was
//!   suspended while that room held it.
//!
//! Logs carry IDs only, and never a hostname.
use crate::error::ApiError;
use crate::forward;
use crate::store::{exec, int, rows, text, transaction_sync};
use podster_core::hostnames::{
    begin_end, decide_ask, free_ended, lift, suspend, withdraw, Claim, ClaimDecision, EndBegun,
    FreeOutcome, HostnameRecord, Withdrawal,
};
use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// Forward-only, as the room's are: a change is a new entry, never an edit.
const MIGRATIONS: &[&str] = &["
CREATE TABLE hostname (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), name TEXT NOT NULL, created_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (typeof(generation) = 'integer' AND generation >= 0), last_freed_at INTEGER, last_suspended_at INTEGER, last_lifted_at INTEGER);
CREATE TABLE claim (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('live', 'ending', 'ended')),
  held INTEGER UNIQUE CHECK (held = 1), claimed_at INTEGER NOT NULL, proved_at INTEGER, ended_at INTEGER, end_reason TEXT, updated_at INTEGER NOT NULL,
  CHECK ((held IS NOT NULL) = (state IN ('live', 'ending'))), UNIQUE (workspace_id, request_id));
CREATE TABLE suspension (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), reason TEXT NOT NULL, suspended_at INTEGER NOT NULL, lifted_at INTEGER);
CREATE TABLE notice (seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, claim_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, answered_at INTEGER);
", "
ALTER TABLE claim ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (typeof(generation) = 'integer' AND generation >= 0);
", "
CREATE TABLE withdrawn (workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (workspace_id, request_id)) WITHOUT ROWID;
"];

/// Whether this object holds anything. This only reads, so asking about an unknown hostname leaves no state.
fn initialized(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
        vec![],
    )?
    .is_empty())
}

/// Applies pending migrations. Callers run this inside a transaction.
fn migrate(sql: &SqlStorage) -> R<()> {
    exec(
        sql,
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
        vec![],
    )?;
    let found = rows(sql, "SELECT version FROM schema_version", vec![])?;
    let current = found.first().map_or(0, |row| int(&row["version"])) as usize;
    for migration in MIGRATIONS.iter().skip(current) {
        exec(sql, migration, vec![])?;
    }
    if found.is_empty() {
        exec(
            sql,
            "INSERT INTO schema_version (version) VALUES (0)",
            vec![],
        )?;
    }
    exec(
        sql,
        "UPDATE schema_version SET version = ?",
        vec![(MIGRATIONS.len() as i64).into()],
    )
}

/// What the object holds: the claim that holds the name, if any, by its IDs, whether the name is suspended, and the
/// name's generation, which a room keeps with a request it makes (M6 step 8). Never the hostname itself.
fn read(sql: &SqlStorage) -> R<Value> {
    if !initialized(sql)? {
        return Ok(json!({ "claim": null, "suspended": false, "generation": 0 }));
    }
    let generation = rows(sql, "SELECT generation FROM hostname", vec![])?
        .first()
        .map_or(0, |row| int(&row["generation"]));
    let claim = rows(
        sql,
        "SELECT id, workspace_id, request_id, state, claimed_at FROM claim WHERE held = 1",
        vec![],
    )?
    .into_iter()
    .next()
    .unwrap_or(Value::Null);
    let suspended = !rows(
        sql,
        "SELECT 1 AS held FROM suspension WHERE lifted_at IS NULL",
        vec![],
    )?
    .is_empty();
    Ok(json!({ "claim": claim, "suspended": suspended, "generation": generation }))
}

/// Records the normalized name this object is for, on the first call that writes, and refuses a call that names
/// another, so a mistake in routing can't act on the wrong name. Callers run this inside a transaction.
fn own_name(sql: &SqlStorage, body: &Value, now: i64) -> R<()> {
    let hostname = body["hostname"]
        .as_str()
        .filter(|name| podster_core::hostnames::normalize(name).ok().as_deref() == Some(*name))
        .ok_or_else(ApiError::invalid_argument)?;
    migrate(sql)?;
    exec(
        sql,
        "INSERT INTO hostname (singleton, name, created_at) VALUES (1, ?, ?) ON CONFLICT (singleton) DO NOTHING",
        vec![hostname.into(), now.into()],
    )?;
    let named = rows(sql, "SELECT name FROM hostname", vec![])?;
    if named.first().and_then(|row| row["name"].as_str()) != Some(hostname) {
        return Err(ApiError::internal("this object is for another hostname"));
    }
    Ok(())
}

/// A room and one of its requests, as a call names them. Both are IDs Podster made, checked against their form.
fn room_and_request(body: &Value) -> R<(String, String)> {
    let id = |value: &Value, prefix: &str| {
        value
            .as_str()
            .filter(|id| {
                id.strip_prefix(prefix).is_some_and(|rest| {
                    rest.len() == 32
                        && rest
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                })
            })
            .map(str::to_owned)
            .ok_or_else(ApiError::invalid_argument)
    };
    Ok((
        id(&body["workspace_id"], "ws_")?,
        id(
            &body["request_id"],
            crate::workspace::HOSTNAME_REQUEST_PREFIX,
        )?,
    ))
}

/// Whether the room withdrew this request here, or a claim it was given has ended: either way it is never granted.
fn withdrawn(sql: &SqlStorage, room: &str, request: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT 1 AS w FROM withdrawn WHERE workspace_id = ? AND request_id = ?
         UNION ALL SELECT 1 AS w FROM claim WHERE workspace_id = ? AND request_id = ? AND state = 'ended'",
        vec![room.into(), request.into(), room.into(), request.into()],
    )?
    .is_empty())
}

/// The path a room asks for the claim on, once its proof matched (M6 step 8). Nothing outside the Worker reaches it.
pub(crate) const INTERNAL_CLAIM: &str = "/internal/claim";
/// The path a room withdraws a request on that it never committed as claimed (M6 step 8).
pub(crate) const INTERNAL_WITHDRAW: &str = "/internal/withdraw";

/// `{ hostname, workspace_id, request_id, requested_at, generation }`: a room asks for the claim, after its proof
/// matched for this request's own value, inside the caller's transaction. Decided by `podster_core::hostnames::
/// decide_ask`: one hostname, one room; suspension first; a request the room withdrew is never granted. A grant
/// records the claim with **both the request's ID and the generation it was made under**, which a suspension's notice
/// carries back to the room. Asking again for the same room and request gets the same answer. Answers
/// `{ decision }`, core's code.
fn ask_claim(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let (room, request) = room_and_request(body)?;
    let requested_at = body["requested_at"]
        .as_i64()
        .ok_or_else(ApiError::invalid_argument)?;
    let generation = body["generation"]
        .as_u64()
        .ok_or_else(ApiError::invalid_argument)?;
    own_name(sql, body, now)?;
    let before = held(sql)?;
    let was_withdrawn = withdrawn(sql, &room, &request)?;
    let ask = podster_core::hostnames::ClaimAsk {
        room: &room,
        request: &request,
        requested_at,
        // The room asks only after its proof matched, for this request's own value.
        proof_matched: true,
        generation,
    };
    let decision = decide_ask(&before.record(), &ask, was_withdrawn, now);
    if decision == ClaimDecision::Granted && before.claim.is_none() {
        let stored = i64::try_from(generation).unwrap_or(i64::MAX);
        exec(
            sql,
            "INSERT INTO claim (id, workspace_id, request_id, state, held, claimed_at, proved_at, updated_at, generation)
               VALUES (?, ?, ?, 'live', 1, ?, ?, ?, ?)",
            vec![
                format!("hcl_{}", uuid::Uuid::new_v4().simple()).into(),
                room.as_str().into(),
                request.as_str().into(),
                now.into(),
                now.into(),
                now.into(),
                stored.into(),
            ],
        )?;
    }
    Ok(json!({ "decision": decision.code() }))
}

/// `{ hostname, workspace_id, request_id }`: a room withdraws a request it never committed as claimed, inside the
/// caller's transaction (`podster_core::hostnames::withdraw`). A claim given for exactly that room and request, live or
/// ending, is freed at once, and the name's generation advances; a claim anyone else holds is untouched. Either way
/// the request is recorded as withdrawn, so an ask for it that arrives later is refused. Asking again changes nothing
/// more. Answers `{ withdrawn: true, freed }`.
fn withdraw_request(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let (room, request) = room_and_request(body)?;
    own_name(sql, body, now)?;
    let before = held(sql)?;
    let (after, outcome) = withdraw(&before.record(), &room, &request, now);
    let freed = outcome == Withdrawal::Freed;
    if freed {
        let stored = i64::try_from(after.generation).unwrap_or(i64::MAX);
        exec(
            sql,
            "UPDATE claim SET state = 'ended', held = NULL, ended_at = ?, end_reason = coalesce(end_reason, 'hostname_request_withdrawn'), updated_at = ?
               WHERE workspace_id = ? AND request_id = ? AND held = 1",
            vec![now.into(), now.into(), room.as_str().into(), request.as_str().into()],
        )?;
        exec(
            sql,
            "UPDATE hostname SET generation = ?, last_freed_at = ?",
            vec![stored.into(), after.last_freed_at.into()],
        )?;
    }
    exec(
        sql,
        "INSERT INTO withdrawn (workspace_id, request_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        vec![room.as_str().into(), request.as_str().into(), now.into()],
    )?;
    Ok(json!({ "withdrawn": true, "freed": freed }))
}

/// The path a room says its committed claim is ending on (M6 step 8b).
pub(crate) const INTERNAL_END: &str = "/internal/end";
/// The path a room frees its ending claim on, once Cloudflare read its custom hostname gone (M6 step 8b).
pub(crate) const INTERNAL_FREE: &str = "/internal/free";

/// `{ hostname, workspace_id, request_id, reason }`: a room says its committed claim is ending, inside the caller's
/// transaction (`podster_core::hostnames::begin_end`). Only exactly that room's and request's claim is marked, with the
/// reason as the room gave it, a code. Answers `{ ending: true }` when it now is, or was, and `{ ending: false }` when
/// the object holds no claim for that request, which changes nothing.
fn end_request(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let (room, request) = room_and_request(body)?;
    let reason = body["reason"]
        .as_str()
        .filter(|code| {
            (1..=64).contains(&code.len())
                && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        })
        .ok_or_else(ApiError::invalid_argument)?;
    own_name(sql, body, now)?;
    let before = held(sql)?;
    let (_, begun) = begin_end(&before.record(), &room, &request);
    if begun == EndBegun::Ending {
        exec(
            sql,
            "UPDATE claim SET state = 'ending', end_reason = coalesce(end_reason, ?), updated_at = ?
               WHERE workspace_id = ? AND request_id = ? AND held = 1 AND state = 'live'",
            vec![reason.into(), now.into(), room.as_str().into(), request.as_str().into()],
        )?;
    }
    Ok(json!({ "ending": begun == EndBegun::Ending }))
}

/// `{ hostname, workspace_id, request_id }`: a room frees its ending claim, inside the caller's transaction
/// (`podster_core::hostnames::free_ended`), once it cleared the host and read the custom hostname gone at Cloudflare.
/// Answers `{ freed, held }`: `held` false when the object holds no claim for that request, freed already or never;
/// `freed` false and `held` true when the claim is still live, which frees nothing.
fn free_request(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let (room, request) = room_and_request(body)?;
    own_name(sql, body, now)?;
    let before = held(sql)?;
    let (after, outcome) = free_ended(&before.record(), &room, &request, now);
    if outcome == FreeOutcome::Freed {
        exec(
            sql,
            "UPDATE claim SET state = 'ended', held = NULL, ended_at = ?, updated_at = ?
               WHERE workspace_id = ? AND request_id = ? AND held = 1 AND state = 'ending'",
            vec![
                now.into(),
                now.into(),
                room.as_str().into(),
                request.as_str().into(),
            ],
        )?;
        exec(
            sql,
            "UPDATE hostname SET generation = ?, last_freed_at = ?",
            vec![
                i64::try_from(after.generation).unwrap_or(i64::MAX).into(),
                after.last_freed_at.into(),
            ],
        )?;
    }
    Ok(json!({
        "freed": outcome == FreeOutcome::Freed,
        "held": outcome != FreeOutcome::NotHeld,
    }))
}

/// The object's path for an operator's suspension and its lifting. Nothing outside the Worker reaches it.
pub(crate) const INTERNAL_SUSPENSION: &str = "/internal/suspension";

const FIRST_WAIT_MS: i64 = 5_000;
const LONGEST_WAIT_MS: i64 = 5 * 60 * 1000;
/// Notices sent in one alarm. A name has one room at most, so one notice at a time in practice.
const BATCH: i64 = 8;
/// A notice is told to operators once it has gone unanswered this many times: with the waits, over half an hour. It
/// is told again on each try after that, so the telling itself needs no retry of its own.
const NOTICE_REPORT_AFTER: i64 = 12;
/// The reconcile's call: wakes the object, and answers what it holds. Nothing outside the Worker reaches it.
pub(crate) const INTERNAL_WAKE: &str = "/internal/wake";

fn wait_ms(attempts: i64) -> i64 {
    FIRST_WAIT_MS
        .saturating_mul(1_i64 << attempts.clamp(0, 6) as u32)
        .min(LONGEST_WAIT_MS)
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

/// What the object holds, as owned values core's record borrows from.
struct Held {
    claim: Option<(String, String, String)>,
    ending: bool,
    suspended: bool,
    last_freed_at: Option<i64>,
    last_suspended_at: Option<i64>,
    last_lifted_at: Option<i64>,
    generation: u64,
}

impl Held {
    fn record(&self) -> HostnameRecord<'_> {
        HostnameRecord {
            claim: self
                .claim
                .as_ref()
                .map(|(_, room, request)| Claim { room, request }),
            ending: self.ending,
            suspended: self.suspended,
            last_freed_at: self.last_freed_at,
            last_suspended_at: self.last_suspended_at,
            last_lifted_at: self.last_lifted_at,
            generation: self.generation,
        }
    }
}

fn held(sql: &SqlStorage) -> R<Held> {
    let name = rows(
        sql,
        "SELECT generation, last_freed_at, last_suspended_at, last_lifted_at FROM hostname",
        vec![],
    )?;
    let name = name
        .first()
        .ok_or_else(|| ApiError::internal("no hostname row"))?;
    let claim = rows(
        sql,
        "SELECT id, workspace_id, request_id, state FROM claim WHERE held = 1",
        vec![],
    )?;
    let claim = claim.first();
    let time = |value: &Value| (!value.is_null()).then(|| int(value));
    Ok(Held {
        claim: claim.and_then(|row| {
            Some((
                text(&row["id"])?,
                text(&row["workspace_id"])?,
                text(&row["request_id"])?,
            ))
        }),
        ending: claim.is_some_and(|row| row["state"].as_str() == Some("ending")),
        suspended: !rows(
            sql,
            "SELECT 1 AS held FROM suspension WHERE lifted_at IS NULL",
            vec![],
        )?
        .is_empty(),
        last_freed_at: time(&name["last_freed_at"]),
        last_suspended_at: time(&name["last_suspended_at"]),
        last_lifted_at: time(&name["last_lifted_at"]),
        generation: int(&name["generation"]).max(0) as u64,
    })
}

/// The suspension now: `{ suspended, reason, at }`.
fn suspension(sql: &SqlStorage) -> R<Value> {
    Ok(rows(
        sql,
        "SELECT reason, suspended_at FROM suspension WHERE lifted_at IS NULL",
        vec![],
    )?
    .first()
    .map_or(
        json!({ "suspended": false, "reason": null, "at": null }),
        |row| json!({ "suspended": true, "reason": row["reason"], "at": row["suspended_at"] }),
    ))
}

/// `{ hostname, suspended, reason }`: an operator suspends the name or lifts that, inside the caller's transaction.
/// `hostname` is the normalized name this object is for: the first call records it, and a call that names another is
/// refused, so a mistake in routing can't suspend the wrong name. Doing what's already so changes nothing, and
/// advances no generation. Answers `{ suspended, reason, at }`.
fn set_suspension(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let suspended = body["suspended"]
        .as_bool()
        .ok_or_else(ApiError::invalid_argument)?;
    let reason = body["reason"]
        .as_str()
        .and_then(podster_policy::moderation::Reason::from_name)
        .ok_or_else(ApiError::invalid_argument)?;
    own_name(sql, body, now)?;
    let before = held(sql)?;
    if before.suspended == suspended {
        return suspension(sql);
    }
    let record = before.record();
    let stored = |generation: u64| i64::try_from(generation).unwrap_or(i64::MAX);
    if suspended {
        let (after, plan) = suspend(&record, now);
        exec(
            sql,
            "UPDATE hostname SET generation = ?, last_suspended_at = ?",
            vec![
                stored(after.generation).into(),
                after.last_suspended_at.into(),
            ],
        )?;
        exec(
            sql,
            "INSERT INTO suspension (singleton, reason, suspended_at, lifted_at) VALUES (1, ?, ?, NULL)
               ON CONFLICT (singleton) DO UPDATE SET reason = excluded.reason, suspended_at = excluded.suspended_at, lifted_at = NULL",
            vec![reason.name().into(), now.into()],
        )?;
        // A room holds the name: its claim starts ending at once, and the room is owed a notice until it answers.
        if let (Some(room), Some((claim, _, _))) = (plan.tell_room, &before.claim) {
            if after.ending {
                exec(
                    sql,
                    "UPDATE claim SET state = 'ending', end_reason = 'hostname_suspended', updated_at = ? WHERE id = ? AND state = 'live'",
                    vec![now.into(), claim.as_str().into()],
                )?;
            }
            exec(
                sql,
                "INSERT INTO notice (workspace_id, claim_id, kind, created_at, next_attempt_at) VALUES (?, ?, 'hostname_suspended', ?, ?)",
                vec![room.into(), claim.as_str().into(), now.into(), now.into()],
            )?;
        }
    } else {
        let after = lift(&record, now);
        exec(
            sql,
            "UPDATE hostname SET generation = ?, last_lifted_at = ?",
            vec![stored(after.generation).into(), after.last_lifted_at.into()],
        )?;
        exec(sql, "UPDATE suspension SET lifted_at = ?", vec![now.into()])?;
    }
    suspension(sql)
}

/// The notices still owed: unanswered, for a claim this object has. Both the sender and the alarm's due time read
/// exactly this, so nothing can be due that the sender would pass over.
const OWED_NOTICES: &str =
    "FROM notice n JOIN claim c ON c.id = n.claim_id WHERE n.answered_at IS NULL";

/// When a notice is next due to be sent, if any is owed.
fn next_notice(sql: &SqlStorage) -> R<Option<i64>> {
    if !initialized(sql)? {
        return Ok(None);
    }
    Ok(rows(
        sql,
        &format!("SELECT min(coalesce(n.next_attempt_at, 0)) AS due, count(*) AS n {OWED_NOTICES}"),
        vec![],
    )?
    .first()
    .filter(|row| int(&row["n"]) > 0)
    .map(|row| int(&row["due"])))
}

#[durable_object]
pub struct HostnameClaim {
    state: State,
    env: Env,
    /// Test builds only: a test's direct call of the alarm waits out a run the runtime started, as the room's does.
    #[cfg(feature = "failpoints")]
    test_alarm_turn: futures_util::lock::Mutex<()>,
}

impl HostnameClaim {
    /// Sets the alarm for the next notice that is due, if one is unanswered.
    async fn arm(&self) -> R<()> {
        let sql = self.state.storage().sql();
        let Some(due) = next_notice(&sql)? else {
            return Ok(());
        };
        let now = now_ms();
        let due = due.max(now + 10);
        let current = self.state.storage().get_alarm().await?;
        if current.is_none_or(|at| at > due) {
            self.state
                .storage()
                .set_alarm(crate::store::alarm_at(due))
                .await?;
        }
        Ok(())
    }

    /// Sends each unanswered notice that is due to the room it is owed to. One the room answers is done. Anything
    /// else, no answer among them, is kept and sent again after a wait, 5 seconds doubling to 5 minutes, for ever.
    async fn send_notices(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !initialized(&sql)? {
            return Ok(());
        }
        let store = sql.clone();
        transaction_sync(&self.state, move || migrate(&store))?;
        let hostname = rows(&sql, "SELECT name FROM hostname", vec![])?
            .first()
            .and_then(|row| text(&row["name"]));
        let Some(hostname) = hostname else {
            return Ok(());
        };
        let due = rows(
            &sql,
            &format!(
                "SELECT n.seq, n.workspace_id, n.attempts, c.request_id, c.generation {OWED_NOTICES}
                   AND coalesce(n.next_attempt_at, 0) <= ? ORDER BY n.seq LIMIT ?"
            ),
            vec![now_ms().into(), BATCH.into()],
        )?;
        for notice in due {
            // Both are columns that can't be empty. If one ever were, the notice counts as an attempt that failed,
            // and waits like any other: it is never passed over while still being due.
            let room = text(&notice["workspace_id"]).unwrap_or_default();
            let request = text(&notice["request_id"]).unwrap_or_default();
            let body = json!({ "hostname": hostname, "request_id": request, "generation": int(&notice["generation"]) });
            let sent = async {
                let stub = self
                    .env
                    .durable_object("WORKSPACE")?
                    .id_from_name(&room)?
                    .get_stub()?;
                forward(
                    stub,
                    crate::workspace::INTERNAL_HOSTNAME_NOTICE,
                    "",
                    Headers::new(),
                    Method::Post,
                    Some(body.to_string()),
                )
                .await
            };
            let answered = sent
                .await
                .is_ok_and(|response| response.status_code() == 200);
            let now = now_ms();
            if answered {
                exec(
                    &sql,
                    "UPDATE notice SET answered_at = ?, attempts = attempts + 1, next_attempt_at = NULL WHERE seq = ?",
                    vec![now.into(), int(&notice["seq"]).into()],
                )?;
            } else {
                exec(
                    &sql,
                    "UPDATE notice SET attempts = attempts + 1, next_attempt_at = ? WHERE seq = ?",
                    vec![
                        (now + wait_ms(int(&notice["attempts"]))).into(),
                        int(&notice["seq"]).into(),
                    ],
                )?;
                if int(&notice["attempts"]) + 1 >= NOTICE_REPORT_AFTER {
                    // The room hasn't answered for over half an hour: it can't be reached, or it refuses, as a room
                    // whose only host is this one must. The name may still be served. An operator is told, in the
                    // operators' own record, which is state and no log. If the telling fails, the next try tells again.
                    let finding =
                        json!({ "code": "hostname_notice_unanswered", "subject": hostname });
                    let told = crate::moderation::call(
                        &self.env,
                        crate::reconcile::FINDING_PATH,
                        Method::Post,
                        Some(finding),
                    )
                    .await
                    .is_ok_and(|response| response.status_code() == 200);
                    if !told {
                        console_error!(
                            "hostname claim: operators weren't told of an unanswered notice: code=finding_not_kept"
                        );
                    }
                }
            }
        }
        Ok(())
    }

    async fn dispatch(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        let url = req.url()?;
        match (req.method(), url.path()) {
            (Method::Get, "/internal/state") => read(&sql),
            // The reconcile found an entry for this name. It is told what the object holds, and the object's alarm is
            // set if a notice is owed, which corrects a wake that was lost. For a name nobody asked about, nothing
            // is owed and nothing is written.
            (Method::Post, INTERNAL_WAKE) => {
                self.arm().await?;
                read(&sql)
            }
            // A room's ask for the claim, its withdrawal of a request it never committed (M6 step 8), and the long end
            // of a claim it committed: marked ending, then freed (8b). Each is one transaction here, and answers what it
            // decided.
            (
                Method::Post,
                path @ (INTERNAL_CLAIM | INTERNAL_WITHDRAW | INTERNAL_END | INTERNAL_FREE),
            ) => {
                let body: Value = serde_json::from_str(&req.text().await?)
                    .map_err(|_| ApiError::invalid_argument())?;
                let decide: fn(&SqlStorage, &Value, i64) -> R<Value> = match path {
                    INTERNAL_CLAIM => ask_claim,
                    INTERNAL_WITHDRAW => withdraw_request,
                    INTERNAL_END => end_request,
                    _ => free_request,
                };
                let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
                let slot = out.clone();
                let store = sql.clone();
                transaction_sync(&self.state, move || {
                    *slot.borrow_mut() = Some(decide(&store, &body, now_ms())?);
                    Ok(())
                })?;
                let answer = out.borrow_mut().take();
                answer.ok_or_else(|| ApiError::internal("the claim object answered nothing"))
            }
            (Method::Post, INTERNAL_SUSPENSION) => {
                let body: Value = serde_json::from_str(&req.text().await?)
                    .map_err(|_| ApiError::invalid_argument())?;
                let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
                let slot = out.clone();
                let store = sql.clone();
                transaction_sync(&self.state, move || {
                    *slot.borrow_mut() = Some(set_suspension(&store, &body, now_ms())?);
                    Ok(())
                })?;
                // A notice may be owed from now. A failed wake fails the answer: asking again changes nothing here
                // and arms again.
                self.arm().await?;
                let answer = out.borrow_mut().take();
                answer.ok_or_else(|| ApiError::internal("suspension answered nothing"))
            }
            // Test builds only: applies the schema, so a test can show what it holds and refuses.
            #[cfg(feature = "failpoints")]
            (Method::Post, "/internal/test-migrate") => {
                crate::store::transaction_sync(&self.state, move || migrate(&sql))?;
                Ok(json!({ "migrated": true }))
            }
            _ => Err(ApiError::not_found()),
        }
    }
}

impl DurableObject for HostnameClaim {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            #[cfg(feature = "failpoints")]
            test_alarm_turn: futures_util::lock::Mutex::new(()),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        match self.dispatch(req).await {
            Ok(value) => Response::from_json(&value),
            Err(error) => error.into_response(),
        }
    }

    /// The object's only job on an alarm: sending the notices it owes.
    async fn alarm(&self) -> Result<Response> {
        #[cfg(feature = "failpoints")]
        let _turn = self.test_alarm_turn.lock().await;
        if let Err(error) = self.send_notices().await {
            console_error!(
                "hostname claim: notices weren't sent: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
        if let Err(error) = self.arm().await {
            console_error!(
                "hostname claim: couldn't set the next alarm: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
        Response::ok("ok")
    }
}
