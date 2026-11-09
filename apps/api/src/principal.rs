//! The Principal Durable Object: one per agent. It owns the connection state and generation, and an authoritative
//! list of rooms, so a global disconnect can reach every room the agent could have joined. It also holds each agent's
//! or person's inbox, and the agent tokens already spent. A person's object has an inbox and no connection.

use crate::error::ApiError;
use crate::store::{exec, int, rows, text, transaction_sync};
use crate::{Caller, CALLER_HEADER};
use futures_util::future::{select, Either};
use serde::Serialize;
use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc, time::Duration};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

mod a2a_endpoint;
mod participation;
mod public_claims;

const SCHEMA: &str = "
CREATE TABLE connection (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, generation INTEGER NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE room_registry (workspace_id TEXT PRIMARY KEY, registered_at INTEGER NOT NULL, revoke_acked_floor INTEGER);
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE seen_jti (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX seen_jti_expiry ON seen_jti (expires_at);
";

/// Inbox events are thin: identifiers, type and actor only. Content comes from reads that check current authority.
const INBOX_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS inbox_event (seq INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, workspace_id TEXT NOT NULL,
  type TEXT NOT NULL, task_id TEXT, actor_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS inbox_event_workspace ON inbox_event (workspace_id);
CREATE TABLE IF NOT EXISTS inbox_floor (workspace_id TEXT PRIMARY KEY, event_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inbox_state (id INTEGER PRIMARY KEY CHECK (id = 1), acked_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, dropped INTEGER NOT NULL);
INSERT OR IGNORE INTO inbox_state (id, acked_seq, last_seq, dropped) VALUES (1, 0, 0, 0);
";

/// One wake URL per agent. The secret signs each request, and is shown only when it's set.
const WAKE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS wake (id INTEGER PRIMARY KEY CHECK (id = 1), url TEXT NOT NULL, secret TEXT NOT NULL, debounce_s INTEGER NOT NULL,
  last_sent_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, queued_until INTEGER, sending_until INTEGER);
";
const WAKE_MAX_FAILURES: i64 = 3;
// Longer than a send can take, so a second consumer can't send the same wake, and a crash mid-send only delays the next.
const WAKE_SEND_LEASE_MS: i64 = 30_000;
const WAKE_QUEUE_MAX_DELAY_SECS: i64 = 12 * 60 * 60;
// If a queued wake is lost, the next event can queue another after this long.
const WAKE_QUEUE_STALE_MS: i64 = 60 * 60 * 1000;

/// Departures from an organization still being carried to the person's rooms, and which rooms have applied each.
const DEPARTURE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS org_departure (org_id TEXT NOT NULL, left_at INTEGER NOT NULL, person_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  sweeps_left INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, next_sweep_at INTEGER NOT NULL, PRIMARY KEY (org_id, left_at));
CREATE TABLE IF NOT EXISTS org_departure_room (org_id TEXT NOT NULL, left_at INTEGER NOT NULL, workspace_id TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (org_id, left_at, workspace_id));
";
/// Every departure from an organization, kept for good. `org_departure` above goes once its rooms have all heard, but a
/// send to an A2A endpoint someone set can come much later, and must still see that they left (ADR 0007, step 12).
const LEFT_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS org_left (org_id TEXT NOT NULL, left_at INTEGER NOT NULL, PRIMARY KEY (org_id, left_at));
";
/// The room index lags behind commits, so a room joined just before a removal can be missing from the first sweep, and
/// a failing index write can keep it missing for much longer. A room that never hears can't reach recovery, so sweeps
/// carry on for about 30 days, further and further apart. An upper bound keeps a departure from running forever.
const DEPARTURE_SWEEPS: i64 = 40;
const DEPARTURE_SWEEP_GAP_MS: i64 = 60_000;
const DEPARTURE_SWEEP_GAP_MAX_MS: i64 = 24 * 60 * 60 * 1000;
const DEPARTURE_INDEX_PAGE: i32 = 500;
/// Room calls in one alarm. Anything left goes in the next one, which runs straight away.
const DEPARTURE_ROOM_CALLS: usize = 100;
const DEPARTURE_ROOM_TIMEOUT_SECS: u64 = 10;
const DEPARTURE_RETRY_MIN_MS: i64 = 5_000;
const DEPARTURE_RETRY_MAX_MS: i64 = 60 * 60 * 1000;
/// Long enough for one alarm's calls, so an eviction partway still comes back.
const DEPARTURE_REARM_SECS: u64 = 300;

/// An organization's rooms, in a Principal named for the organization, so a limit has one writer. Rooms can't be deleted
/// yet, so this only grows, apart from a creation that failed.
const ORG_ROOMS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS org_room (workspace_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS org_room_seeded (id INTEGER PRIMARY KEY CHECK (id = 1));
";
const MAX_ROOMS_PER_ORG: i64 = 20;
const AGENT_ROOMS_LISTED: i32 = 200;
const REMOVAL_NOTICE: &str = "member.revoked";
const INBOX_CAPACITY: i64 = 10_000;
const UNREAD_KEPT_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const ACKED_KEPT_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const PAGE_DEFAULT: i64 = 10;
const PAGE_MAX: i64 = 50;
const MAX_REPLAY_KEY_BYTES: usize = 512;

const ACTIVE: &str = "active";
const PUBLIC_CLAIMS_NOT_ALLOWED: &str = "public_claims_not_allowed";
const DISCONNECTING: &str = "disconnecting";
const DISCONNECTED: &str = "disconnected";
const RETRY_SECS: u64 = 5;

fn is_initialized(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connection'",
        vec![],
    )?
    .is_empty())
}

fn connection(sql: &SqlStorage) -> R<Option<Value>> {
    if !is_initialized(sql)? {
        return Ok(None);
    }
    Ok(rows(
        sql,
        "SELECT id, org_id, name, generation, status FROM connection",
        vec![],
    )?
    .into_iter()
    .next())
}

fn connection_json(c: &Value) -> Value {
    json!({ "id": c["id"], "org_id": c["org_id"], "name": c["name"], "generation": c["generation"], "status": c["status"] })
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

/// Asks the agent's Principal whether a request with this generation may proceed, and spends the agent token it came
/// with. Both happen in that one object's single thread, so concurrent replays can't both pass.
pub async fn check_active(
    env: &Env,
    agent: &str,
    generation: Option<u64>,
    spent: Option<(&str, i64)>,
) -> R<()> {
    let Some(generation) = generation else {
        return Err(ApiError::agent_disconnected());
    };
    let mut body = json!({ "gen": generation });
    if let Some((key, expires_at)) = spent {
        body["replay_key"] = json!(key);
        body["replay_exp"] = json!(expires_at);
    }
    let response = internal(env, agent, "/internal/check", &body).await?;
    match response.status_code() {
        200 => Ok(()),
        401 => Err(ApiError::jwt_replay()),
        _ => Err(ApiError::agent_disconnected()),
    }
}

/// Refuses a person who has left this organization since `since`, in milliseconds. A departure reaches their Principal as soon as
/// the gateway delivers it, which is before any room hears, and it's kept for longer than an upload can last. Someone who left
/// before `since` had rejoined by then, or wouldn't have been let in.
pub async fn check_not_departed(env: &Env, person: &str, org: &str, since: i64) -> R<()> {
    let body = json!({ "org": org, "since": since });
    let mut response = internal(env, person, "/internal/departed", &body).await?;
    let answer: Value = response.json().await?;
    if answer["departed"].as_bool() == Some(false) {
        Ok(())
    } else {
        Err(ApiError::access_revoked())
    }
}

/// Whether a person has left an organization since `since`, in milliseconds, from their own Principal. Unlike
/// [`check_not_departed`], an answer that isn't a clear yes or no is an error, never a departure, so the caller can refuse to
/// act without treating an outage as a departure.
pub async fn departed_since(env: &Env, person: &str, org: &str, since: i64) -> R<bool> {
    let body = json!({ "org": org, "since": since, "person": person });
    let mut response = internal(env, person, "/internal/departed", &body).await?;
    if response.status_code() != 200 {
        return Err(ApiError::internal("departure check unavailable"));
    }
    let answer: Value = response.json().await?;
    answer["departed"]
        .as_bool()
        .ok_or_else(|| ApiError::internal("departure check unavailable"))
}

/// Asks the agent's Principal whether, and where, to send it an A2A offer. An answer that isn't 200 is an error.
pub async fn claim_a2a_for(env: &Env, agent: &str) -> R<Value> {
    let mut response = internal(env, agent, "/internal/a2a-endpoint-claim", &json!({})).await?;
    if response.status_code() != 200 {
        return Err(ApiError::internal("a2a claim unavailable"));
    }
    Ok(response.json().await?)
}

/// Counts one A2A send toward switching the agent's endpoint off.
pub async fn report_a2a_for(env: &Env, agent: &str, version: u64, ok: bool) -> R<Value> {
    let body = json!({ "version": version, "ok": ok });
    let mut response = internal(env, agent, "/internal/a2a-endpoint-report", &body).await?;
    if response.status_code() != 200 {
        return Err(ApiError::internal("a2a report unavailable"));
    }
    Ok(response.json().await?)
}

/// Asks the agent's Principal what to send.
pub async fn claim_wake_for(env: &Env, agent: &str) -> R<Value> {
    let mut response = internal(env, agent, "/internal/wake-claim", &json!({})).await?;
    Ok(response.json().await?)
}

/// Tells the agent's Principal how a send went.
pub async fn report_wake_for(env: &Env, agent: &str, ok: bool, claim: &Value) -> R<Value> {
    let body = json!({ "ok": ok, "secret": claim["secret"], "last_seq": claim["last_seq"] });
    let mut response = internal(env, agent, "/internal/wake-report", &body).await?;
    Ok(response.json().await?)
}

/// How many inbox events this principal hasn't acknowledged.
pub async fn unread(env: &Env, principal: &str) -> R<i64> {
    let mut response = internal(env, principal, "/internal/unread", &json!({})).await?;
    let body: Value = response.json().await?;
    Ok(int(&body["unread"]))
}

fn inbox_exists(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbox_state'",
        vec![],
    )?
    .is_empty())
}

/// The current cursor, newest sequence and drop count, for any principal, with or without an inbox yet.
fn inbox_state(sql: &SqlStorage) -> R<(i64, i64, i64)> {
    if !inbox_exists(sql)? {
        return Ok((0, 0, 0));
    }
    let state = rows(
        sql,
        "SELECT acked_seq, last_seq, dropped FROM inbox_state",
        vec![],
    )?;
    let state = state
        .first()
        .ok_or_else(|| ApiError::internal("no inbox state"))?;
    Ok((
        int(&state["acked_seq"]),
        int(&state["last_seq"]),
        int(&state["dropped"]),
    ))
}

/// Events still within retention count, so an expired one stops counting before anything clears it.
fn unread_count(sql: &SqlStorage, acked: i64, now: i64) -> R<i64> {
    if !inbox_exists(sql)? {
        return Ok(0);
    }
    let found = rows(
        sql,
        "SELECT count(*) AS n FROM inbox_event WHERE seq > ? AND created_at >= ?",
        vec![acked.into(), (now - UNREAD_KEPT_MS).into()],
    )?;
    Ok(found.first().map_or(0, |row| int(&row["n"])))
}

/// Unread events past retention that nothing has cleared yet.
fn expired_unread(sql: &SqlStorage, acked: i64, now: i64) -> R<i64> {
    if !inbox_exists(sql)? {
        return Ok(0);
    }
    let lost = rows(
        sql,
        "SELECT count(*) AS n FROM inbox_event WHERE seq > ? AND created_at < ?",
        vec![acked.into(), (now - UNREAD_KEPT_MS).into()],
    )?;
    Ok(lost.first().map_or(0, |row| int(&row["n"])))
}

/// Clears expired events. Lost unread work is counted, because the reader needs to know. Acked events aren't.
/// This must run before the cursor moves, or moving it over expired events would hide that they were lost.
fn expire_inbox(sql: &SqlStorage, now: i64) -> R<()> {
    if !inbox_exists(sql)? {
        return Ok(());
    }
    let (acked, _, _) = inbox_state(sql)?;
    let lost = expired_unread(sql, acked, now)?;
    exec(
        sql,
        "DELETE FROM inbox_event WHERE (seq > ? AND created_at < ?) OR (seq <= ? AND created_at < ?)",
        vec![
            acked.into(),
            (now - UNREAD_KEPT_MS).into(),
            acked.into(),
            (now - ACKED_KEPT_MS).into(),
        ],
    )?;
    if lost > 0 {
        exec(
            sql,
            "UPDATE inbox_state SET dropped = dropped + ?",
            vec![lost.into()],
        )?;
    }
    Ok(())
}

/// Stores one event, once, in the caller's transaction, so a failure leaves nothing behind and the retry starts clean.
/// A removal notice first clears
/// everything from that room, read or not, so the notice is all that remains. It also sets a floor in the room's own
/// event order, because a send that timed out can still arrive afterward, and the clearing makes it look new.
fn deliver(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let field = |name: &str| {
        body[name]
            .as_str()
            .map(str::to_string)
            .ok_or_else(ApiError::invalid_argument)
    };
    let (event_id, workspace_id, kind, actor) = (
        field("event_id")?,
        field("workspace_id")?,
        field("type")?,
        field("actor_id")?,
    );
    exec(sql, INBOX_SCHEMA, vec![])?;
    let seen = rows(
        sql,
        "SELECT seq FROM inbox_event WHERE event_id = ?",
        vec![event_id.as_str().into()],
    )?;
    if !seen.is_empty() {
        return Ok(json!({ "delivered": false }));
    }
    let event_seq = body["event_seq"]
        .as_i64()
        .ok_or_else(ApiError::invalid_argument)?;
    let floor = rows(
        sql,
        "SELECT event_seq FROM inbox_floor WHERE workspace_id = ?",
        vec![workspace_id.as_str().into()],
    )?;
    if floor
        .first()
        .is_some_and(|f| event_seq <= int(&f["event_seq"]))
    {
        return Ok(json!({ "delivered": false }));
    }
    expire_inbox(sql, now)?;
    if kind == REMOVAL_NOTICE {
        exec(
            sql,
            "INSERT OR REPLACE INTO inbox_floor (workspace_id, event_seq) VALUES (?, ?)",
            vec![workspace_id.as_str().into(), event_seq.into()],
        )?;
        exec(
            sql,
            "DELETE FROM inbox_event WHERE workspace_id = ?",
            vec![workspace_id.as_str().into()],
        )?;
    }
    let (acked, last, _) = inbox_state(sql)?;
    let held = rows(
        sql,
        "SELECT count(*) AS n, min(seq) AS oldest FROM inbox_event",
        vec![],
    )?;
    let held = held.first().ok_or_else(|| ApiError::internal("no count"))?;
    if int(&held["n"]) >= INBOX_CAPACITY {
        let oldest = int(&held["oldest"]);
        exec(
            sql,
            "DELETE FROM inbox_event WHERE seq = ?",
            vec![oldest.into()],
        )?;
        if oldest > acked {
            exec(sql, "UPDATE inbox_state SET dropped = dropped + 1", vec![])?;
        }
    }
    let seq = last + 1;
    exec(sql, "INSERT INTO inbox_event (seq, event_id, workspace_id, type, task_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", vec![
        seq.into(),
        event_id.as_str().into(),
        workspace_id.as_str().into(),
        kind.as_str().into(),
        body["task_id"].as_str().map_or(worker::SqlStorageValue::Null, |task| task.into()),
        actor.as_str().into(),
        body["created_at"].as_i64().unwrap_or(now).into(),
    ])?;
    exec(sql, "UPDATE inbox_state SET last_seq = ?", vec![seq.into()])?;
    Ok(json!({ "delivered": true, "seq": seq }))
}

fn wake_row(sql: &SqlStorage) -> R<Option<Value>> {
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wake'",
        vec![],
    )?
    .is_empty()
    {
        return Ok(None);
    }
    Ok(rows(sql, "SELECT * FROM wake WHERE url != ''", vec![])?
        .into_iter()
        .next())
}

/// What identity shows. The secret never appears here.
fn wake_json(sql: &SqlStorage) -> R<Value> {
    Ok(match wake_row(sql)? {
        Some(w) => {
            json!({ "url": w["url"], "debounce": w["debounce_s"], "enabled": int(&w["enabled"]) == 1, "last_sent_at": w["last_sent_at"], "consecutive_failures": w["consecutive_failures"] })
        }
        None => Value::Null,
    })
}

/// Sets the URL and a new secret, and turns wake back on. The secret is returned only here.
fn set_wake(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let url = body["url"]
        .as_str()
        .ok_or_else(ApiError::invalid_argument)?;
    let url = podster_egress::check_wake_url(url).map_err(|_| ApiError::invalid_wake_url())?;
    let debounce = match body.get("debounce") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_i64().ok_or_else(ApiError::invalid_argument)?),
    };
    let debounce =
        podster_egress::check_debounce(debounce).ok_or_else(ApiError::invalid_argument)?;
    let secret = format!(
        "whsec_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    exec(sql, WAKE_SCHEMA, vec![])?;
    // Keeps when it last sent and anything queued, so setting it again can't be used to skip the debounce window.
    // A send that failed or never reported recorded no time, so it counts from now.
    exec(
        sql,
        "INSERT INTO wake (id, url, secret, debounce_s, enabled) VALUES (1, ?, ?, ?, 1)
          ON CONFLICT (id) DO UPDATE SET url = excluded.url, secret = excluded.secret, debounce_s = excluded.debounce_s, enabled = 1, consecutive_failures = 0,
            last_sent_at = CASE WHEN consecutive_failures > 0 OR sending_until IS NOT NULL THEN ? ELSE last_sent_at END,
            queued_until = CASE WHEN debounce_s = excluded.debounce_s THEN queued_until ELSE NULL END",
        vec![url.as_str().into(), secret.as_str().into(), debounce.into(), now.into()],
    )?;
    Ok(json!({ "url": url, "debounce": debounce, "enabled": true, "secret": secret }))
}

/// Blanks the row rather than deleting it, so the time of the last send survives and deleting then setting a URL can't
/// skip the debounce window.
fn delete_wake(sql: &SqlStorage, now: i64) -> R<Value> {
    if wake_row(sql)?.is_some() {
        exec(
            sql,
            "UPDATE wake SET url = '', secret = '', enabled = 0, consecutive_failures = 0, queued_until = NULL, sending_until = NULL,
              last_sent_at = CASE WHEN consecutive_failures > 0 OR sending_until IS NOT NULL THEN ? ELSE last_sent_at END",
            vec![now.into()],
        )?;
    }
    Ok(json!({ "deleted": true }))
}

/// Notices that ask nothing of an agent, so they reach its inbox without a wake: an input asset linked to or unlinked from its
/// task (decision 104). They never queue a wake, and no check of whether to send or resend one counts them, though they still
/// count as unread. The next wake for anything else still finds them there.
const QUIET_EVENTS: &[&str] = &["asset.linked", "asset.unlinked"];

/// Unread events that call for a wake: those within retention, leaving out quiet notices.
fn waking_unread(sql: &SqlStorage, acked: i64, now: i64) -> R<i64> {
    waking_after(sql, acked, now - UNREAD_KEPT_MS)
}

/// How many events after `seq`, created at or after `since`, call for a wake.
fn waking_after(sql: &SqlStorage, seq: i64, since: i64) -> R<i64> {
    if !inbox_exists(sql)? {
        return Ok(0);
    }
    let quiet = vec!["?"; QUIET_EVENTS.len()].join(", ");
    let mut values: Vec<worker::SqlStorageValue> = vec![seq.into(), since.into()];
    values.extend(QUIET_EVENTS.iter().map(|kind| (*kind).into()));
    let found = rows(
        sql,
        &format!("SELECT count(*) AS n FROM inbox_event WHERE seq > ? AND created_at >= ? AND type NOT IN ({quiet})"),
        values,
    )?;
    Ok(found.first().map_or(0, |row| int(&row["n"])))
}

/// Whether a wake should be queued for a new event, and with what delay. A wake inside the debounce window is delayed to
/// its end instead of dropped, so the last event in a burst still gets a nudge.
fn wake_to_queue(sql: &SqlStorage, now: i64) -> R<Option<i64>> {
    let Some(wake) = wake_row(sql)? else {
        return Ok(None);
    };
    let active = connection(sql)?.is_some_and(|c| c["status"].as_str() == Some(ACTIVE));
    if !active || int(&wake["enabled"]) != 1 {
        return Ok(None);
    }
    if wake["queued_until"]
        .as_i64()
        .is_some_and(|until| until > now)
    {
        return Ok(None);
    }
    let due = wake["last_sent_at"]
        .as_i64()
        .map_or(now, |sent| sent + int(&wake["debounce_s"]) * 1000);
    let delay = ((due - now).max(0) / 1000).min(WAKE_QUEUE_MAX_DELAY_SECS);
    exec(
        sql,
        "UPDATE wake SET queued_until = ?",
        vec![(now + delay * 1000 + WAKE_QUEUE_STALE_MS).into()],
    )?;
    Ok(Some(delay))
}

/// What the consumer should send, rechecked at send time because anything could have changed while it was queued.
/// Takes a short lease, so a second consumer holding the same wake sends nothing.
fn claim_wake(sql: &SqlStorage, now: i64) -> R<Value> {
    let skip = |reason: &str| json!({ "send": false, "reason": reason });
    let Some(wake) = wake_row(sql)? else {
        return Ok(skip("no_wake"));
    };
    let Some(conn) = connection(sql)? else {
        return Ok(skip("no_connection"));
    };
    let clear = || exec(sql, "UPDATE wake SET queued_until = NULL", vec![]);
    if conn["status"].as_str() != Some(ACTIVE) || int(&wake["enabled"]) != 1 {
        clear()?;
        return Ok(skip("inactive"));
    }
    let url = text(&wake["url"]).unwrap_or_default();
    if podster_egress::check_wake_url(&url).is_err() {
        exec(
            sql,
            "UPDATE wake SET enabled = 0, queued_until = NULL",
            vec![],
        )?;
        return Ok(skip("url_refused"));
    }
    let (acked, last_seq, _) = inbox_state(sql)?;
    // Quiet notices alone are nothing to wake for, but a wake that is sent says how many are unread in all.
    if waking_unread(sql, acked, now)? == 0 {
        clear()?;
        return Ok(skip("nothing_unread"));
    }
    let unread = unread_count(sql, acked, now)?;
    let due = wake["last_sent_at"]
        .as_i64()
        .map_or(now, |sent| sent + int(&wake["debounce_s"]) * 1000);
    if due > now {
        return Ok(
            json!({ "send": false, "reason": "debounce", "retry_after": ((due - now) / 1000 + 1).min(WAKE_QUEUE_MAX_DELAY_SECS) }),
        );
    }
    // Waits rather than being dropped: if that send crashed, this message is the only one left.
    if let Some(until) = wake["sending_until"].as_i64().filter(|until| *until > now) {
        return Ok(
            json!({ "send": false, "reason": "sending", "retry_after": (until - now) / 1000 + 1 }),
        );
    }
    exec(
        sql,
        "UPDATE wake SET sending_until = ?",
        vec![(now + WAKE_SEND_LEASE_MS).into()],
    )?;
    Ok(
        json!({ "send": true, "url": url, "secret": wake["secret"], "unread": unread, "agent_id": conn["id"], "last_seq": last_seq }),
    )
}

/// Records how a send went. Three failures in a row turn wake off until it's set again. A send that was attempted always
/// counts against the debounce window, even if the URL was replaced or deleted meanwhile, or re-setting a URL during each
/// send could trigger another at once. Whether it worked says nothing about the new URL, so that part is ignored.
fn report_wake(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let Some(wake) = wake_row(sql)? else {
        // Deleted during the send. The row is still there, blanked, because a report only follows a claim.
        exec(sql, "UPDATE wake SET last_sent_at = ?", vec![now.into()])?;
        return Ok(json!({ "retry": false, "requeue": false }));
    };
    if body["secret"].as_str() != wake["secret"].as_str() {
        // Its message is finished, so the flags it left would keep the new URL quiet.
        exec(
            sql,
            "UPDATE wake SET last_sent_at = ?, queued_until = NULL, sending_until = NULL",
            vec![now.into()],
        )?;
        let (acked, _, _) = inbox_state(sql)?;
        return Ok(json!({ "retry": false, "requeue": waking_unread(sql, acked, now)? > 0 }));
    }
    if body["ok"].as_bool().unwrap_or(false) {
        exec(
            sql,
            "UPDATE wake SET last_sent_at = ?, consecutive_failures = 0, queued_until = NULL, sending_until = NULL",
            vec![now.into()],
        )?;
        // An event during the send was held back by the queued flag, and this wake's count didn't include it. A quiet notice
        // isn't one to wake for, so only another kind requeues.
        let (_, last_seq, _) = inbox_state(sql)?;
        let sent_at = body["last_seq"].as_i64().unwrap_or(last_seq);
        return Ok(json!({ "retry": false, "requeue": waking_after(sql, sent_at, i64::MIN)? > 0 }));
    }
    let failures = int(&wake["consecutive_failures"]) + 1;
    if failures >= WAKE_MAX_FAILURES {
        exec(sql, "UPDATE wake SET consecutive_failures = ?, enabled = 0, queued_until = NULL, sending_until = NULL", vec![failures.into()])?;
        return Ok(json!({ "retry": false, "requeue": false, "disabled": true }));
    }
    exec(
        sql,
        "UPDATE wake SET consecutive_failures = ?, sending_until = NULL",
        vec![failures.into()],
    )?;
    Ok(json!({ "retry": true, "requeue": false, "failures": failures }))
}

/// A struct and not `json!`: the queue's serializer turns a JSON map into a JS `Map`, which arrives as `{}`.
#[derive(Serialize)]
struct WakeMessage<'a> {
    agent: &'a str,
}

struct InboxQuery {
    after: Option<i64>,
    limit: i64,
    ack: bool,
}

fn parse_inbox_query(url: &Url) -> R<InboxQuery> {
    let mut query = InboxQuery {
        after: None,
        limit: PAGE_DEFAULT,
        ack: false,
    };
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "after" => {
                let after = value
                    .parse::<i64>()
                    .ok()
                    .filter(|after| *after >= 0)
                    .ok_or_else(ApiError::invalid_argument)?;
                query.after = Some(after);
            }
            "limit" => {
                query.limit = value
                    .parse::<i64>()
                    .ok()
                    .filter(|limit| (1..=PAGE_MAX).contains(limit))
                    .ok_or_else(ApiError::invalid_argument)?;
            }
            "ack" => {
                query.ack = value
                    .parse::<bool>()
                    .map_err(|_| ApiError::invalid_argument())?;
            }
            _ => {}
        }
    }
    Ok(query)
}

/// Reads a page. With `ack`, it also advances the cursor over that page, which is the documented command exception.
/// Reading from past the cursor with `ack` is refused, because it would acknowledge the events it skipped.
fn read_inbox(sql: &SqlStorage, query: &InboxQuery, now: i64) -> R<Value> {
    if query.ack {
        expire_inbox(sql, now)?;
    }
    let (acked, _, dropped) = inbox_state(sql)?;
    // A plain read only reads, so it adds what expiry will count later. The total doesn't change when that happens.
    let dropped = dropped + expired_unread(sql, acked, now)?;
    let after = query.after.unwrap_or(acked);
    if query.ack && after > acked {
        return Err(ApiError::invalid_argument());
    }
    let events = if inbox_exists(sql)? {
        rows(sql, "SELECT seq, event_id, workspace_id, type, task_id, actor_id, created_at FROM inbox_event
          WHERE seq > ? AND ((seq > ? AND created_at >= ?) OR (seq <= ? AND created_at >= ?)) ORDER BY seq LIMIT ?", vec![
            after.into(),
            acked.into(),
            (now - UNREAD_KEPT_MS).into(),
            acked.into(),
            (now - ACKED_KEPT_MS).into(),
            query.limit.into(),
        ])?
    } else {
        vec![]
    };
    let mut cursor = acked;
    if query.ack {
        if let Some(newest) = events.last() {
            cursor = cursor.max(int(&newest["seq"]));
            exec(
                sql,
                "UPDATE inbox_state SET acked_seq = ?",
                vec![cursor.into()],
            )?;
        }
    }
    Ok(
        json!({ "events": events, "acked_seq": cursor, "unread": unread_count(sql, cursor, now)?, "dropped": dropped }),
    )
}

/// Advances the cursor. Going backward does nothing, so it's safe to retry. Past the newest event is refused,
/// because it means acknowledging events nobody has read.
fn ack_inbox(sql: &SqlStorage, up_to: i64, now: i64) -> R<Value> {
    if up_to < 0 {
        return Err(ApiError::invalid_argument());
    }
    let (acked, last, _) = inbox_state(sql)?;
    if up_to > last {
        return Err(ApiError::ack_beyond_inbox());
    }
    expire_inbox(sql, now)?;
    let cursor = acked.max(up_to);
    if cursor != acked {
        exec(
            sql,
            "UPDATE inbox_state SET acked_seq = ?",
            vec![cursor.into()],
        )?;
    }
    Ok(json!({ "acked_seq": cursor, "unread": unread_count(sql, cursor, now)? }))
}

/// Records a room before a join commits, so a later disconnect always reaches it. Refused unless the agent is
/// active and belongs to `org`. Entries are never removed: a stale one costs only a harmless extra revoke, while
/// removing one could let a disconnect miss a room.
///
/// A `public_claim` is also refused, with `public_claims_not_allowed`, unless the agent's owner allows public claims
/// (decision 159). Nothing claims publicly yet: M4 step 8 does.
pub async fn register_room(
    env: &Env,
    agent: &str,
    org: &str,
    workspace_id: &str,
    public_claim: bool,
) -> R<u64> {
    let mut response = internal(
        env,
        agent,
        "/internal/register-room",
        &json!({ "workspace_id": workspace_id, "org_id": org, "public_claim": public_claim }),
    )
    .await?;
    if response.status_code() == 403 {
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if body["error"]["code"].as_str() == Some(PUBLIC_CLAIMS_NOT_ALLOWED) {
            return Err(ApiError::api(403, PUBLIC_CLAIMS_NOT_ALLOWED));
        }
        return Err(ApiError::not_allowed());
    }
    if response.status_code() != 200 {
        return Err(ApiError::not_allowed());
    }
    let body: Value = response.json().await?;
    Ok(int(&body["generation"]) as u64)
}

/// Reserves a public claim on one Principal's count (M4 step 8). `Ok(None)` when reserved, or the limit's code and the
/// claims it counted as active, each as its key and room.
pub async fn reserve_public_claim(
    env: &Env,
    principal: &str,
    whose: &str,
    key: &str,
    workspace: &str,
    reservation: &str,
) -> R<Option<(String, Vec<(String, String)>)>> {
    let body = json!({ "whose": whose, "key": key, "workspace_id": workspace, "reservation": reservation });
    let mut response = internal(env, principal, "/internal/public-claim-reserve", &body).await?;
    if response.status_code() != 200 {
        return Err(ApiError::internal("couldn't reserve a public claim"));
    }
    let answer: Value = response.json().await?;
    if answer["reserved"].as_bool() == Some(true) {
        return Ok(None);
    }
    let code = answer["code"]
        .as_str()
        .unwrap_or("limit_exceeded")
        .to_string();
    let active = answer["active"]
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|e| {
                    Some((
                        e["key"].as_str()?.to_owned(),
                        e["workspace_id"].as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Some((code, active)))
}

/// Confirms, releases or ends a public claim on one Principal's count. `release` gives back only `reservation`.
pub async fn settle_public_claim(
    env: &Env,
    principal: &str,
    whose: &str,
    key: &str,
    workspace: &str,
    reservation: &str,
    outcome: &str,
) -> R<()> {
    let body = json!({ "key": key, "outcome": outcome, "whose": whose, "workspace_id": workspace, "reservation": reservation });
    let response = internal(env, principal, "/internal/public-claim-settle", &body).await?;
    if response.status_code() != 200 {
        return Err(ApiError::internal("couldn't settle a public claim"));
    }
    Ok(())
}

/// The wait after a sweep with this many left: it doubles from a minute up to a day.
fn sweep_gap_ms(sweeps_left: i64) -> i64 {
    let done = (DEPARTURE_SWEEPS - sweeps_left).clamp(0, 20) as u32;
    DEPARTURE_SWEEP_GAP_MS
        .saturating_mul(1 << done)
        .min(DEPARTURE_SWEEP_GAP_MAX_MS)
}

/// Doubles from the minimum with each failure, up to the maximum.
fn retry_delay_ms(failures: i64) -> i64 {
    let doublings = (failures - 1).clamp(0, 20) as u32;
    (DEPARTURE_RETRY_MIN_MS << doublings).min(DEPARTURE_RETRY_MAX_MS)
}

/// Takes one of an organization's room slots, or refuses at the limit.
pub async fn reserve_org_room(env: &Env, org: &str, workspace: &str) -> R<()> {
    let body = json!({ "org": org, "workspace": workspace });
    let response = internal(env, org, "/internal/org-room-reserve", &body).await?;
    match response.status_code() {
        200 => Ok(()),
        409 => Err(ApiError::limit_exceeded()),
        _ => Err(ApiError::internal("couldn't reserve a room")),
    }
}

/// Gives a slot back when the room wasn't created.
pub async fn release_org_room(env: &Env, org: &str, workspace: &str) -> R<()> {
    let body = json!({ "org": org, "workspace": workspace });
    internal(env, org, "/internal/org-room-release", &body).await?;
    Ok(())
}

/// Hands a departure to the person's Principal, which carries it to their rooms until each has answered.
pub async fn record_org_departure(
    env: &Env,
    departure: &podster_assertion::Departure,
    actor: &str,
) -> R<Response> {
    let body = json!({ "person": departure.person, "org": departure.org, "left_at": departure.left_at, "actor": actor });
    internal(env, &departure.person, "/internal/org-departure", &body).await
}

async fn internal(env: &Env, agent: &str, path: &str, body: &Value) -> R<Response> {
    let stub = env
        .durable_object("PRINCIPAL")?
        .id_from_name(agent)?
        .get_stub()?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some(body.to_string().into()));
    Ok(stub
        .fetch_with_request(Request::new_with_init(
            &format!("https://principal{path}"),
            &init,
        )?)
        .await?)
}

#[durable_object]
pub struct Principal {
    state: State,
    env: Env,
}

impl Principal {
    /// Runs writes that belong together, so a failure partway leaves nothing behind and a retry starts clean.
    fn in_transaction(&self, f: impl FnOnce() -> R<Value> + 'static) -> R<Value> {
        let outcome = Rc::new(RefCell::new(None));
        let slot = outcome.clone();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(f()?);
            Ok(())
        })?;
        let value = outcome.borrow_mut().take();
        value.ok_or_else(|| ApiError::internal("no transaction result"))
    }

    async fn wake_command(&self, method: Method, req: &mut Request) -> R<Value> {
        let sql = self.state.storage().sql();
        match method {
            Method::Put => {
                // The body is read first, because a disconnect can land while it arrives. Checking and setting then run with no
                // wait between them, so nothing can be set after a disconnect and survive a reconnect.
                let body: Value = serde_json::from_str(&req.text().await?)
                    .map_err(|_| ApiError::invalid_argument())?;
                let active =
                    connection(&sql)?.is_some_and(|c| c["status"].as_str() == Some(ACTIVE));
                if !active {
                    return Err(ApiError::agent_disconnected());
                }
                set_wake(&sql, &body, now_ms())
            }
            Method::Delete => delete_wake(&sql, now_ms()),
            _ => Err(ApiError::not_found()),
        }
    }

    /// The agent's A2A endpoint: read, set or delete, for the agent or its organization's admin (decision 119). Setting needs an
    /// active connection, as wake does, so nothing can be set to survive a disconnect.
    async fn endpoint_command(
        &self,
        method: Method,
        req: &mut Request,
        caller: &Caller,
    ) -> R<Value> {
        let sql = self.state.storage().sql();
        match method {
            Method::Get => a2a_endpoint::status_json(&sql, a2a_endpoint::key(&self.env).as_deref()),
            Method::Put => {
                // A disconnect can land while the body arrives, so the connection is checked inside the transaction that sets.
                let body: Value = serde_json::from_str(&req.text().await?)
                    .map_err(|_| ApiError::invalid_argument())?;
                let key = a2a_endpoint::key(&self.env);
                let (store, now) = (sql.clone(), now_ms());
                let caller = caller.clone();
                self.in_transaction(move || {
                    let conn = connection(&store)?
                        .filter(|c| c["status"].as_str() == Some(ACTIVE))
                        .ok_or_else(ApiError::agent_disconnected)?;
                    let agent = text(&conn["id"]).unwrap_or_default();
                    let org = text(&conn["org_id"]).unwrap_or_default();
                    // Who set it, so a send stops once they've left (step 12): the agent's linker, or the admin, from their
                    // current membership. Without one, nothing is set.
                    let (person, since) = match caller.kind.as_str() {
                        "agent" => caller.linker.as_ref().map(|l| (l.person.clone(), l.since)),
                        _ => caller
                            .org_since
                            .get(&org)
                            .map(|since| (caller.id.clone(), *since)),
                    }
                    .filter(|(person, _)| crate::valid_id(person))
                    .ok_or_else(ApiError::not_allowed)?;
                    let setter = a2a_endpoint::Setter {
                        person: &person,
                        org: &org,
                        since,
                    };
                    a2a_endpoint::set(&store, key.as_deref(), &agent, &setter, &body, now)
                })
            }
            Method::Delete => a2a_endpoint::delete(&sql),
            _ => Err(ApiError::not_found()),
        }
    }

    async fn queue_wake(&self, now: i64) -> R<()> {
        let sql = self.state.storage().sql();
        let Some(delay) = wake_to_queue(&sql, now)? else {
            return Ok(());
        };
        let agent = connection(&sql)?
            .and_then(|c| text(&c["id"]))
            .unwrap_or_default();
        let sent = async {
            let queue = self.env.queue("WAKE")?;
            let message = MessageBuilder::new(WakeMessage { agent: &agent })
                .delay_seconds(delay as u32)
                .build();
            queue.send(message).await
        };
        if let Err(error) = sent.await {
            exec(&sql, "UPDATE wake SET queued_until = NULL", vec![])?;
            return Err(error.into());
        }
        Ok(())
    }

    /// Whether this fan-out still speaks for the current disconnect. Awaits can outlast it.
    fn is_current(sql: &SqlStorage, floor: i64) -> R<bool> {
        Ok(connection(sql)?.is_some_and(|c| {
            c["status"].as_str() == Some(DISCONNECTING) && int(&c["generation"]) == floor
        }))
    }

    /// Sends the current floor to every room that hasn't acknowledged it. Only then is the agent disconnected.
    async fn fan_out(&self) -> R<()> {
        let sql = self.state.storage().sql();
        let Some(conn) = connection(&sql)? else {
            return Ok(());
        };
        if conn["status"].as_str() != Some(DISCONNECTING) {
            return Ok(());
        }
        // Armed before the first await, so an eviction mid-way still retries.
        self.state
            .storage()
            .set_alarm(Duration::from_secs(RETRY_SECS))
            .await?;
        #[cfg(feature = "failpoints")]
        if !rows(
            &sql,
            "SELECT key FROM setting WHERE key = 'hold_fan_out'",
            vec![],
        )?
        .is_empty()
        {
            return Ok(());
        }
        let floor = int(&conn["generation"]);
        let agent = text(&conn["id"]).unwrap_or_default();
        let pending = rows(&sql, "SELECT workspace_id FROM room_registry WHERE revoke_acked_floor IS NULL OR revoke_acked_floor < ?", vec![floor.into()])?;
        for room in &pending {
            let workspace_id = text(&room["workspace_id"]).unwrap_or_default();
            let stub = self
                .env
                .durable_object("WORKSPACE")?
                .id_from_name(&workspace_id)?
                .get_stub()?;
            let mut init = RequestInit::new();
            init.with_method(Method::Post).with_body(Some(
                json!({ "principal": agent, "floor": floor })
                    .to_string()
                    .into(),
            ));
            let acked = match Request::new_with_init("https://workspace/internal/revoke", &init) {
                Ok(request) => matches!(
                    stub.fetch_with_request(request)
                        .await
                        .map(|r| r.status_code()),
                    Ok(200)
                ),
                Err(_) => false,
            };
            #[cfg(feature = "failpoints")]
            let acked = acked
                && rows(
                    &sql,
                    "SELECT key FROM setting WHERE key = 'fail_acks'",
                    vec![],
                )?
                .is_empty();
            if acked {
                exec(&sql, "UPDATE room_registry SET revoke_acked_floor = max(coalesce(revoke_acked_floor, 0), ?) WHERE workspace_id = ?", vec![floor.into(), workspace_id.as_str().into()])?;
            }
        }
        // A later disconnect or reconnect may have started during those awaits. It finishes its own fan-out.
        if !Self::is_current(&sql, floor)? {
            return Ok(());
        }
        let unacked = rows(&sql, "SELECT workspace_id FROM room_registry WHERE revoke_acked_floor IS NULL OR revoke_acked_floor < ? LIMIT 1", vec![floor.into()])?;
        if unacked.is_empty() {
            exec(
                &sql,
                "UPDATE connection SET status = ?",
                vec![DISCONNECTED.into()],
            )?;
            self.state.storage().delete_alarm().await?;
        }
        Ok(())
    }

    /// Runs only from the alarm, so sweeps don't overlap. Each sweep learns the person's rooms from the index, then asks
    /// the ones that haven't applied this departure yet. A room that fails is retried alone, with backoff. Once every
    /// known room has applied it the sweep counts, and the last sweep ends the departure.
    async fn sweep_departures(&self) -> R<()> {
        let sql = self.state.storage().sql();
        exec(&sql, DEPARTURE_SCHEMA, vec![])?;
        let now = now_ms();
        let due = rows(
            &sql,
            "SELECT org_id, left_at, person_id, actor_id, sweeps_left, failures FROM org_departure WHERE next_sweep_at <= ?",
            vec![now.into()],
        )?;
        if !due.is_empty() {
            self.state
                .storage()
                .set_alarm(Duration::from_secs(DEPARTURE_REARM_SECS))
                .await?;
        }
        let mut calls_left = DEPARTURE_ROOM_CALLS;
        for departure in &due {
            let org = text(&departure["org_id"]).unwrap_or_default();
            let left_at = int(&departure["left_at"]);
            let person = text(&departure["person_id"]).unwrap_or_default();
            let actor = text(&departure["actor_id"]).unwrap_or_default();
            self.learn_rooms(&org, left_at, &person).await?;
            let key =
                || -> Vec<worker::SqlStorageValue> { vec![org.as_str().into(), left_at.into()] };
            let waiting = rows(&sql, "SELECT workspace_id FROM org_departure_room WHERE org_id = ? AND left_at = ? AND applied = 0", key())?;
            let body = json!({ "person": person, "org": org, "left_at": left_at, "actor": actor });
            let mut failed = false;
            let mut unasked = false;
            for room in &waiting {
                if calls_left == 0 {
                    unasked = true;
                    break;
                }
                calls_left -= 1;
                let workspace_id = room["workspace_id"].as_str().unwrap_or_default();
                if self.room_applied(workspace_id, &body).await {
                    exec(&sql, "UPDATE org_departure_room SET applied = 1 WHERE org_id = ? AND left_at = ? AND workspace_id = ?",
                        vec![org.as_str().into(), left_at.into(), workspace_id.into()])?;
                } else {
                    failed = true;
                }
            }
            let now = now_ms();
            if failed {
                let failures = int(&departure["failures"]) + 1;
                console_error!("departure not applied in every room: {}", person);
                exec(&sql, "UPDATE org_departure SET failures = ?, next_sweep_at = ? WHERE org_id = ? AND left_at = ?", vec![
                    failures.into(), (now + retry_delay_ms(failures)).into(), org.as_str().into(), left_at.into(),
                ])?;
            } else if unasked {
                // Stays due, so the next alarm carries on.
            } else if int(&departure["sweeps_left"]) <= 1 {
                exec(
                    &sql,
                    "DELETE FROM org_departure WHERE org_id = ? AND left_at = ?",
                    key(),
                )?;
                exec(
                    &sql,
                    "DELETE FROM org_departure_room WHERE org_id = ? AND left_at = ?",
                    key(),
                )?;
            } else {
                let gap = sweep_gap_ms(int(&departure["sweeps_left"]));
                exec(&sql, "UPDATE org_departure SET sweeps_left = sweeps_left - 1, failures = 0, next_sweep_at = ? WHERE org_id = ? AND left_at = ?", vec![
                    (now + gap).into(), org.as_str().into(), left_at.into(),
                ])?;
            }
        }
        self.arm_next_sweep().await
    }

    /// Adds rooms the index lists for this person and organization, including ones that already removed them, because a
    /// room invitation they made can outlive their role there.
    async fn learn_rooms(&self, org: &str, left_at: i64, person: &str) -> R<()> {
        let sql = self.state.storage().sql();
        let db = self.env.d1("DB")?;
        let mut after = String::new();
        loop {
            let page = db
                .prepare("SELECT workspace_id FROM membership_index WHERE principal_id = ? AND org_id = ? AND workspace_id > ? ORDER BY workspace_id LIMIT ?")
                .bind(&[person.into(), org.into(), after.as_str().into(), DEPARTURE_INDEX_PAGE.into()])?
                .all()
                .await?
                .results::<Value>()?;
            let Some(last) = page
                .last()
                .and_then(|row| row["workspace_id"].as_str())
                .map(str::to_string)
            else {
                return Ok(());
            };
            for row in &page {
                let workspace_id = row["workspace_id"].as_str().unwrap_or_default();
                exec(&sql, "INSERT OR IGNORE INTO org_departure_room (org_id, left_at, workspace_id) VALUES (?, ?, ?)",
                    vec![org.into(), left_at.into(), workspace_id.into()])?;
            }
            if page.len() < DEPARTURE_INDEX_PAGE as usize {
                return Ok(());
            }
            after = last;
        }
    }

    /// Whether the room answered in time. A hung room counts as a failure, so it can't hold up the ones after it.
    async fn room_applied(&self, workspace_id: &str, body: &Value) -> bool {
        #[cfg(feature = "failpoints")]
        if workspace_id == "ws_fail_departure" {
            return false;
        }
        let Ok(namespace) = self.env.durable_object("WORKSPACE") else {
            return false;
        };
        let Ok(stub) = namespace
            .id_from_name(workspace_id)
            .and_then(|id| id.get_stub())
        else {
            return false;
        };
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_body(Some(body.to_string().into()));
        let Ok(request) = Request::new_with_init("https://workspace/internal/org-departure", &init)
        else {
            return false;
        };
        let call = Box::pin(stub.fetch_with_request(request));
        let deadline = Box::pin(Delay::from(Duration::from_secs(
            DEPARTURE_ROOM_TIMEOUT_SECS,
        )));
        let applied = match select(call, deadline).await {
            Either::Left((Ok(response), _)) => response.status_code() == 200,
            _ => false,
        };
        applied
    }

    /// Sets the alarm for whichever departure is due first, or clears it when none are left.
    async fn arm_next_sweep(&self) -> R<()> {
        let sql = self.state.storage().sql();
        let next = rows(
            &sql,
            "SELECT MIN(next_sweep_at) AS next FROM org_departure",
            vec![],
        )?;
        let Some(next) = next.first().and_then(|row| row["next"].as_i64()) else {
            self.state.storage().delete_alarm().await?;
            return Ok(());
        };
        let wait = (next - now_ms()).max(1) as u64;
        self.state
            .storage()
            .set_alarm(Duration::from_millis(wait))
            .await?;
        Ok(())
    }

    async fn dispatch(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        let path = req.path();
        match path.as_str() {
            "/internal/org-room-reserve" => {
                let body: Value = req.json().await?;
                let org = body["org"].as_str().unwrap_or_default().to_string();
                let workspace = body["workspace"].as_str().unwrap_or_default().to_string();
                exec(&sql, ORG_ROOMS_SCHEMA, vec![])?;
                // Rooms from before this limit are counted once, from the listing. After that this table decides.
                if rows(&sql, "SELECT id FROM org_room_seeded", vec![])?.is_empty() {
                    let existing = self.env.d1("DB")?
                        .prepare("SELECT DISTINCT workspace_id FROM membership_index WHERE org_id = ? AND role = 'owner' LIMIT ?")
                        .bind(&[org.as_str().into(), ((MAX_ROOMS_PER_ORG + 1) as i32).into()])?
                        .all()
                        .await?
                        .results::<Value>()?;
                    for room in &existing {
                        exec(
                            &sql,
                            "INSERT OR IGNORE INTO org_room (workspace_id) VALUES (?)",
                            vec![room["workspace_id"].as_str().unwrap_or_default().into()],
                        )?;
                    }
                    exec(
                        &sql,
                        "INSERT OR IGNORE INTO org_room_seeded (id) VALUES (1)",
                        vec![],
                    )?;
                }
                let held = rows(&sql, "SELECT count(*) AS n FROM org_room", vec![])?
                    .first()
                    .map_or(0, |row| int(&row["n"]));
                if held >= MAX_ROOMS_PER_ORG {
                    return Err(ApiError::limit_exceeded());
                }
                exec(
                    &sql,
                    "INSERT OR IGNORE INTO org_room (workspace_id) VALUES (?)",
                    vec![workspace.as_str().into()],
                )?;
                return Ok(json!({ "reserved": true }));
            }
            "/internal/org-room-release" => {
                let body: Value = req.json().await?;
                exec(&sql, ORG_ROOMS_SCHEMA, vec![])?;
                exec(
                    &sql,
                    "DELETE FROM org_room WHERE workspace_id = ?",
                    vec![body["workspace"].as_str().unwrap_or_default().into()],
                )?;
                return Ok(json!({ "released": true }));
            }
            "/internal/org-departure" => {
                let body: Value = req.json().await?;
                exec(&sql, DEPARTURE_SCHEMA, vec![])?;
                // A retry of one the gateway already sent changes nothing, because rooms ignore what they've applied.
                exec(&sql, "INSERT OR IGNORE INTO org_departure (org_id, left_at, person_id, actor_id, sweeps_left, next_sweep_at) VALUES (?, ?, ?, ?, ?, 0)", vec![
                    body["org"].as_str().unwrap_or_default().into(),
                    body["left_at"].as_i64().ok_or_else(ApiError::invalid_argument)?.into(),
                    body["person"].as_str().unwrap_or_default().into(),
                    body["actor"].as_str().unwrap_or_default().into(),
                    DEPARTURE_SWEEPS.into(),
                ])?;
                exec(&sql, LEFT_SCHEMA, vec![])?;
                exec(
                    &sql,
                    "INSERT OR IGNORE INTO org_left (org_id, left_at) VALUES (?, ?)",
                    vec![
                        body["org"].as_str().unwrap_or_default().into(),
                        body["left_at"]
                            .as_i64()
                            .ok_or_else(ApiError::invalid_argument)?
                            .into(),
                    ],
                )?;
                // The alarm does the rooms, so answering the gateway doesn't depend on how many there are.
                self.arm_next_sweep().await?;
                return Ok(json!({ "recorded": true }));
            }
            "/internal/departed" => {
                let body: Value = req.json().await?;
                // Tests can't otherwise make this Principal fail to answer.
                #[cfg(feature = "failpoints")]
                if body["person"]
                    .as_str()
                    .is_some_and(|p| p.starts_with("per_unavailable_"))
                {
                    return Err(ApiError::api(503, "unavailable"));
                }
                exec(&sql, DEPARTURE_SCHEMA, vec![])?;
                exec(&sql, LEFT_SCHEMA, vec![])?;
                let found = rows(
                    &sql,
                    "SELECT 1 FROM org_departure WHERE org_id = ?1 AND left_at >= ?2 UNION ALL SELECT 1 FROM org_left WHERE org_id = ?1 AND left_at >= ?2 LIMIT 1",
                    vec![
                        body["org"].as_str().unwrap_or_default().into(),
                        body["since"].as_i64().unwrap_or(0).into(),
                    ],
                )?;
                return Ok(json!({ "departed": !found.is_empty() }));
            }
            "/internal/check" => {
                let body: Value = req.json().await?;
                let conn = connection(&sql)?.ok_or_else(ApiError::agent_disconnected)?;
                if conn["status"].as_str() != Some(ACTIVE)
                    || body["gen"].as_i64() != Some(int(&conn["generation"]))
                {
                    return Err(ApiError::agent_disconnected());
                }
                if let Some(key) = body["replay_key"].as_str() {
                    if key.len() > MAX_REPLAY_KEY_BYTES {
                        return Err(ApiError::invalid_argument());
                    }
                    let now = now_ms() / 1000;
                    exec(
                        &sql,
                        "DELETE FROM seen_jti WHERE expires_at < ?",
                        vec![now.into()],
                    )?;
                    let seen = rows(
                        &sql,
                        "SELECT key FROM seen_jti WHERE key = ?",
                        vec![key.into()],
                    )?;
                    if !seen.is_empty() {
                        return Err(ApiError::jwt_replay());
                    }
                    exec(
                        &sql,
                        "INSERT INTO seen_jti (key, expires_at) VALUES (?, ?)",
                        vec![
                            key.into(),
                            body["replay_exp"].as_i64().unwrap_or(now).into(),
                        ],
                    )?;
                }
                return Ok(json!({ "ok": true }));
            }
            "/internal/deliver" => {
                #[cfg(feature = "failpoints")]
                if !rows(
                    &sql,
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_fail_deliver'",
                    vec![],
                )?
                .is_empty()
                {
                    return Err(ApiError::internal("injected delivery failure"));
                }
                #[cfg(feature = "failpoints")]
                if !rows(
                    &sql,
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_hang_deliver'",
                    vec![],
                )?
                .is_empty()
                {
                    Delay::from(Duration::from_secs(30)).await;
                }
                let body: Value = req.json().await?;
                let quiet = body["type"]
                    .as_str()
                    .is_some_and(|kind| QUIET_EVENTS.contains(&kind));
                let (store, now) = (sql.clone(), now_ms());
                let outcome = self.in_transaction(move || deliver(&store, &body, now))?;
                // The event is safe already, and a wake is only a nudge, so a problem here can't fail delivery.
                if outcome["delivered"] == Value::Bool(true) && !quiet {
                    if let Err(error) = self.queue_wake(now).await {
                        console_error!("couldn't queue wake: {:?}", error);
                    }
                }
                return Ok(outcome);
            }
            "/internal/wake-claim" => return claim_wake(&sql, now_ms()),
            "/internal/wake-report" => {
                let body: Value = req.json().await?;
                let now = now_ms();
                let outcome = report_wake(&sql, &body, now)?;
                if outcome["requeue"] == Value::Bool(true) {
                    if let Err(error) = self.queue_wake(now).await {
                        console_error!("couldn't queue wake: {:?}", error);
                    }
                }
                return Ok(outcome);
            }
            "/internal/a2a-endpoint-claim" => {
                let claim = a2a_endpoint::claim(&sql, a2a_endpoint::key(&self.env).as_deref())?;
                if claim["send"] != Value::Bool(true) {
                    return Ok(claim);
                }
                // Whoever set the endpoint must still be in the agent's organization. Their own Principal knows. If it can't
                // say, this fails and nothing is sent.
                let setter = &claim["setter"];
                let (person, org) = (
                    setter["person"].as_str().unwrap_or_default(),
                    setter["org"].as_str().unwrap_or_default(),
                );
                let since = setter["since"].as_i64().unwrap_or(0);
                if !crate::valid_id(person) || !crate::valid_id(org) {
                    return Ok(json!({ "send": false, "reason": "setter_unknown" }));
                }
                if departed_since(&self.env, person, org, since).await? {
                    let store = sql.clone();
                    // Only the registration the claim read, so a set that landed during the check isn't undone.
                    let version = claim["version"].as_i64().unwrap_or(-1);
                    self.in_transaction(move || a2a_endpoint::delete_version(&store, version))?;
                    console_log!(
                        "{}",
                        json!({ "event": "a2a.endpoint_setter_left", "agent": claim["agent_id"], "version": version })
                    );
                    return Ok(json!({ "send": false, "reason": "setter_departed" }));
                }
                return Ok(claim);
            }
            "/internal/a2a-endpoint-report" => {
                let body: Value = req.json().await?;
                // Tests can't otherwise make a report fail after a send. It fails once, then the table is gone.
                #[cfg(feature = "failpoints")]
                if !rows(&sql, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_fail_report'", vec![])?.is_empty() {
                    exec(&sql, "DROP TABLE test_fail_report", vec![])?;
                    return Err(ApiError::api(503, "unavailable"));
                }
                let (store, now) = (sql.clone(), now_ms());
                return self.in_transaction(move || a2a_endpoint::report(&store, &body, now));
            }
            "/internal/unread" => {
                let (acked, _, _) = inbox_state(&sql)?;
                return Ok(json!({ "unread": unread_count(&sql, acked, now_ms())? }));
            }
            "/internal/public-claim-reserve" => {
                let body: Value = req.json().await?;
                let (store, now) = (sql.clone(), now_ms());
                return self.in_transaction(move || public_claims::reserve(&store, &body, now));
            }
            "/internal/public-claim-settle" => {
                let body: Value = req.json().await?;
                let (store, now) = (sql.clone(), now_ms());
                return self.in_transaction(move || public_claims::settle(&store, &body, now));
            }
            "/internal/register-room" => {
                let body: Value = req.json().await?;
                let conn = connection(&sql)?.ok_or_else(ApiError::agent_disconnected)?;
                if conn["status"].as_str() != Some(ACTIVE)
                    || conn["org_id"].as_str() != body["org_id"].as_str()
                {
                    return Err(ApiError::agent_disconnected());
                }
                // Checked before the room is recorded, so a refused public claim leaves nothing behind.
                if body["public_claim"].as_bool() == Some(true)
                    && !participation::current(&sql)?.allows_public_claims()
                {
                    return Err(ApiError::api(403, PUBLIC_CLAIMS_NOT_ALLOWED));
                }
                exec(&sql, "INSERT OR IGNORE INTO room_registry (workspace_id, registered_at) VALUES (?, ?)",
                    vec![body["workspace_id"].as_str().unwrap_or("").into(), now_ms().into()])?;
                return Ok(json!({ "generation": conn["generation"] }));
            }
            _ => {}
        }

        let caller: Caller = req
            .headers()
            .get(CALLER_HEADER)?
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .ok_or_else(|| ApiError::internal("missing caller"))?;
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        match (segments.as_slice(), req.method()) {
            (["v1", "inbox"], Method::Get) => {
                let query = parse_inbox_query(&req.url()?)?;
                let (store, now) = (sql.clone(), now_ms());
                return self.in_transaction(move || read_inbox(&store, &query, now));
            }
            (["v1", "inbox", "ack"], Method::Post) => {
                let body: Value = serde_json::from_str(&req.text().await?)
                    .map_err(|_| ApiError::invalid_argument())?;
                let up_to = body["up_to"]
                    .as_i64()
                    .ok_or_else(ApiError::invalid_argument)?;
                let (store, now) = (sql.clone(), now_ms());
                return self.in_transaction(move || ack_inbox(&store, up_to, now));
            }
            (["v1", "inbox", "wake"], method) if caller.kind == "agent" => {
                return self.wake_command(method, &mut req).await;
            }
            (["v1", "inbox", "a2a-endpoint"], method) if caller.kind == "agent" => {
                return self.endpoint_command(method, &mut req, &caller).await;
            }
            (["v1", "inbox", ..], _) => return Err(ApiError::not_found()),
            _ => {}
        }
        let (agent_id, verb) = match segments.as_slice() {
            ["v1", "agents", id] => ((*id).to_string(), None),
            ["v1", "agents", id, verb] => ((*id).to_string(), Some((*verb).to_string())),
            _ => return Err(ApiError::not_found()),
        };
        let method = req.method();

        if method == Method::Put && verb.is_none() {
            let body: Value = serde_json::from_str(&req.text().await?)
                .map_err(|_| ApiError::invalid_argument())?;
            let org = body["org_id"]
                .as_str()
                .ok_or_else(ApiError::invalid_argument)?
                .to_string();
            let name = match body.get("name") {
                None | Some(Value::Null) => "agent".to_string(),
                Some(Value::String(name)) if !name.trim().is_empty() => name.clone(),
                Some(_) => return Err(ApiError::invalid_argument()),
            };
            if caller.kind != "person"
                || !caller.admin_orgs.contains(&org)
                || !crate::valid_id(&agent_id)
                || !agent_id.starts_with(crate::AGENT_ID_PREFIX)
                || !crate::valid_id(&org)
                || name.len() > 200
            {
                return Err(ApiError::not_allowed());
            }
            if let Some(existing) = connection(&sql)? {
                if existing["org_id"].as_str() != Some(org.as_str()) {
                    return Err(ApiError::not_allowed());
                }
                return Ok(connection_json(&existing));
            }
            let (store, id, created) = (sql.clone(), agent_id.clone(), now_ms());
            // Together, because a schema with no connection row could never be registered again.
            return self.in_transaction(move || {
                exec(&store, SCHEMA, vec![])?;
                exec(&store, "INSERT INTO connection (id, org_id, name, generation, status, created_at) VALUES (?, ?, ?, 1, ?, ?)",
                    vec![id.as_str().into(), org.as_str().into(), name.as_str().into(), ACTIVE.into(), created.into()])?;
                Ok(connection_json(
                    &connection(&store)?.ok_or_else(|| ApiError::internal("no connection"))?,
                ))
            });
        }

        // Reads are limited to the agent and its organization's admins. The gateway calls PUT only after a claim, so
        // PUT's answer reveals nothing to clients.
        let conn = connection(&sql)?.ok_or_else(ApiError::agent_not_found)?;
        let org = conn["org_id"].as_str().unwrap_or_default();
        let is_org_admin = caller.kind == "person" && caller.admin_orgs.iter().any(|o| o == org);
        let is_self = caller.kind == "agent" && caller.id == agent_id;
        if !is_org_admin && !is_self {
            return Err(ApiError::agent_not_found());
        }
        match (method, verb.as_deref()) {
            (Method::Get, None) => {
                let (acked, _, _) = inbox_state(&sql)?;
                let mut identity = connection_json(&conn);
                identity["inbox_unread"] = json!(unread_count(&sql, acked, now_ms())?);
                identity["wake"] = wake_json(&sql)?;
                identity["a2a_endpoint"] =
                    a2a_endpoint::status_json(&sql, a2a_endpoint::key(&self.env).as_deref())?;
                identity["participation_policy"] = participation::json(&sql)?["policy"].clone();
                Ok(identity)
            }
            // The agent and its organization's admins can read it, and the admins see its history.
            (Method::Get, Some("participation-policy")) => {
                let mut policy = participation::json(&sql)?;
                if is_org_admin {
                    policy["history"] = participation::audit(&sql)?["entries"].clone();
                }
                Ok(policy)
            }
            // Only a person who administers the agent's organization sets it: never the agent itself (decision 159).
            (Method::Put, Some("participation-policy")) => {
                let kind = if caller.kind == "person" {
                    podster_policy::PrincipalKind::Person
                } else {
                    podster_policy::PrincipalKind::Agent
                };
                let administers = caller.admin_orgs.iter().any(|o| o == org);
                if !podster_policy::public::may_set_participation_policy(kind, administers) {
                    return Err(ApiError::not_allowed());
                }
                // The body is read first, because a disconnect, and even a reconnect, can land while it arrives. The connection
                // is then checked again in the transaction that writes, against the generation seen before the wait, so a
                // consent given before a disconnect can never be written after it and survive a reconnect (decision 159).
                let body: Value = serde_json::from_str(&req.text().await?)
                    .map_err(|_| ApiError::invalid_argument())?;
                let seen_generation = int(&conn["generation"]);
                let (store, actor, now) = (sql.clone(), caller.id.clone(), now_ms());
                self.in_transaction(move || {
                    let still = connection(&store)?.is_some_and(|c| {
                        c["status"].as_str() == Some(ACTIVE)
                            && int(&c["generation"]) == seen_generation
                    });
                    if !still {
                        return Err(ApiError::agent_disconnected());
                    }
                    participation::set(&store, &actor, &body, now)
                })
            }
            (method @ (Method::Put | Method::Delete), Some("wake")) => {
                self.wake_command(method, &mut req).await
            }
            (method, Some("a2a-endpoint")) => {
                self.endpoint_command(method, &mut req, &caller).await
            }
            // Oversight: the agent or an authorized person can look, and looking never moves the cursor.
            // Rooms this agent is in or has left, from the listing read model. This shows them and decides nothing.
            (Method::Get, Some("rooms")) => {
                let found = self.env.d1("DB")?
                    .prepare("SELECT workspace_id, workspace_name, role, removed, workspace_status FROM membership_index WHERE principal_id = ? AND org_id = ? ORDER BY removed, workspace_name LIMIT ?")
                    .bind(&[agent_id.as_str().into(), org.into(), (AGENT_ROOMS_LISTED + 1).into()])?
                    .all()
                    .await?
                    .results::<Value>()?;
                let truncated = found.len() > AGENT_ROOMS_LISTED as usize;
                // A room it has left shows the name it knew, and nothing about the room's state since.
                let rooms: Vec<Value> = found.iter().take(AGENT_ROOMS_LISTED as usize).map(|row| {
                    let left = row["removed"].as_i64() == Some(1);
                    json!({
                        "workspace_id": row["workspace_id"], "workspace_name": row["workspace_name"], "role": row["role"],
                        "status": if left { Value::Null } else { row["workspace_status"].clone() }, "left": left,
                    })
                }).collect();
                Ok(json!({ "rooms": rooms, "truncated": truncated }))
            }
            (Method::Get, Some("inbox")) => {
                let query = parse_inbox_query(&req.url()?)?;
                if query.ack {
                    return Err(ApiError::invalid_argument());
                }
                read_inbox(&sql, &query, now_ms())
            }
            (Method::Post, Some("disconnect")) if is_org_admin => {
                if conn["status"].as_str() == Some(ACTIVE) {
                    #[cfg(feature = "failpoints")]
                    if let Some(mode) = req.headers().get("x-test-hold-fan-out")? {
                        let key = if mode == "acks" {
                            "fail_acks"
                        } else {
                            "hold_fan_out"
                        };
                        exec(
                            &sql,
                            "INSERT OR REPLACE INTO setting (key, value) VALUES (?, '1')",
                            vec![key.into()],
                        )?;
                    }
                    exec(
                        &sql,
                        "UPDATE connection SET status = ?, generation = generation + 1",
                        vec![DISCONNECTING.into()],
                    )?;
                    // A reconnect starts over, like its credentials: a leaked URL and secret shouldn't come back.
                    delete_wake(&sql, now_ms())?;
                    // So does the A2A endpoint, with its signing secret and token (ADR 0007).
                    a2a_endpoint::delete(&sql)?;
                    // And the owner's consent to public claims, which was given for this connection (decision 159).
                    participation::reset(&sql, now_ms())?;
                }
                self.fan_out().await?;
                Ok(connection_json(
                    &connection(&sql)?.ok_or_else(|| ApiError::internal("no connection"))?,
                ))
            }
            #[cfg(feature = "failpoints")]
            (Method::Post, Some("test-release-fan-out")) if is_org_admin => {
                exec(&sql, "DELETE FROM setting", vec![])?;
                self.fan_out().await?;
                Ok(connection_json(
                    &connection(&sql)?.ok_or_else(|| ApiError::internal("no connection"))?,
                ))
            }
            (Method::Post, Some("reconnect")) if is_org_admin => {
                if conn["status"].as_str() != Some(DISCONNECTED) {
                    return Err(ApiError::from_core(
                        &podster_core::CoreError::InvalidTransition,
                    ));
                }
                exec(
                    &sql,
                    "UPDATE connection SET status = ?, generation = generation + 1",
                    vec![ACTIVE.into()],
                )?;
                Ok(connection_json(
                    &connection(&sql)?.ok_or_else(|| ApiError::internal("no connection"))?,
                ))
            }
            (_, Some("disconnect" | "reconnect")) => Err(ApiError::not_allowed()),
            _ => Err(ApiError::not_found()),
        }
    }
}

impl DurableObject for Principal {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        match self.dispatch(req).await {
            Ok(value) => Response::from_json(&value),
            Err(error) => error.into_response(),
        }
    }

    async fn alarm(&self) -> Result<Response> {
        // A person has departures and an agent has a fan-out, so neither clears the other's alarm.
        let sql = self.state.storage().sql();
        let is_agent = matches!(connection(&sql), Ok(Some(_)));
        let outcome = if is_agent {
            self.fan_out().await
        } else {
            self.sweep_departures().await
        };
        if let Err(error) = outcome {
            console_error!("alarm failed: {:?}", error);
            self.state
                .storage()
                .set_alarm(Duration::from_secs(RETRY_SECS))
                .await?;
        }
        Response::ok("ok")
    }
}
