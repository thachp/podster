//! The Principal Durable Object: one per agent. It owns the connection state and generation, and an authoritative
//! list of rooms, so a global disconnect can reach every room the agent could have joined. It also holds each agent's
//! or person's inbox, and the agent tokens already spent. A person's object has an inbox and no connection.

use crate::error::ApiError;
use crate::store::{exec, int, rows, text, transaction_sync};
use crate::{Caller, CALLER_HEADER};
use futures_util::future::{select, Either};
use podster_core::release::ReleaseSwitch;
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
const PUBLIC_CLAIMS_SUSPENDED: &str = "public_claims_suspended";
const DISCONNECTING: &str = "disconnecting";
const DISCONNECTED: &str = "disconnected";
const RETRY_SECS: u64 = 5;

fn has_table(sql: &SqlStorage, name: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        vec![name.into()],
    )?
    .is_empty())
}

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

/// Where the agent's A2A endpoint points now, with no secret or token: `{ active, url, version }`. `active` is false unless the
/// agent is connected and the endpoint is set, switched on and still passes egress policy (decision 174). An error is an error.
pub async fn a2a_endpoint_pin_for(env: &Env, agent: &str) -> R<Value> {
    let mut response = internal(env, agent, "/internal/a2a-endpoint-pin", &json!({})).await?;
    if response.status_code() != 200 {
        return Err(ApiError::internal("a2a endpoint pin unavailable"));
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
/// (decision 159), and with `public_claims_suspended` while an operator has suspended its public claims (decision 158).
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
        for code in [PUBLIC_CLAIMS_NOT_ALLOWED, PUBLIC_CLAIMS_SUSPENDED] {
            if body["error"]["code"].as_str() == Some(code) {
                // error-codes: public_claims_not_allowed, public_claims_suspended
                return Err(ApiError::api(403, code));
            }
        }
        return Err(ApiError::not_allowed());
    }
    if response.status_code() != 200 {
        return Err(ApiError::not_allowed());
    }
    let body: Value = response.json().await?;
    Ok(int(&body["generation"]) as u64)
}

/// Reserves a public claim on one Principal's count (M4 step 8). `held` is the room's word on whether the agent holds
/// this claim now: `yes`, `no` or `unknown`. `Ok(Ok(retry))` when reserved, `retry` saying it counted nothing because the
/// room said the claim is held, or `Ok(Err(..))` with the limit's code and the claims it counted as active, each as its
/// key and room.
#[allow(clippy::too_many_arguments)]
pub async fn reserve_public_claim(
    env: &Env,
    principal: &str,
    whose: &str,
    key: &str,
    workspace: &str,
    reservation: &str,
    held: &str,
) -> R<Result<bool, (String, Vec<(String, String)>)>> {
    let body = json!({ "whose": whose, "key": key, "workspace_id": workspace, "reservation": reservation, "held": held });
    let mut response = internal(env, principal, "/internal/public-claim-reserve", &body).await?;
    if response.status_code() != 200 {
        return Err(ApiError::internal("couldn't reserve a public claim"));
    }
    let answer: Value = response.json().await?;
    if answer["reserved"].as_bool() == Some(true) {
        return Ok(Ok(answer["retry"].as_bool() != Some(false)));
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
    Ok(Err((code, active)))
}

/// Suspends or lifts an agent's public claims, for a verified operator (M4 step 10).
pub async fn set_public_claims_suspension(
    env: &Env,
    agent: &str,
    suspended: bool,
    reason: &str,
) -> R<Value> {
    let body = json!({ "suspended": suspended, "reason": reason });
    let mut response = internal(env, agent, "/internal/public-claims-suspension", &body).await?;
    if response.status_code() == 404 {
        return Err(ApiError::agent_not_found());
    }
    if response.status_code() != 200 {
        return Err(ApiError::internal(
            "couldn't set a public claims suspension",
        ));
    }
    Ok(response.json().await?)
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

/// An organization's delegations from Podster's platform, in the `Principal` named for the organization (M5 step 4). For
/// a managed repository Podster's platform is the resource owner, so only a Podster operator gives or takes this back,
/// and a room's owner can ask for a repository only while their organization holds it (AC-10). Every change is kept.
const ORG_DELEGATION_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS org_provider_delegation (provider TEXT PRIMARY KEY, granted INTEGER NOT NULL, set_by TEXT NOT NULL, set_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS org_provider_delegation_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, granted INTEGER NOT NULL, set_by TEXT NOT NULL, set_at INTEGER NOT NULL);
";

/// An organization's release switch (decision 218), in the `Principal` named for the organization: one row, as
/// `podster_core::release::ReleaseSwitch` shapes it, written only through its `set`. Only a Podster operator sets it.
/// No row is `ReleaseSwitch::UNSET`: held, generation 0, never taken. Every change is kept in the log.
///
/// **What a set does, by build.** From PR B on, a taken switch refuses the organization's releases at every release
/// command's recheck. From PR C on, each set also writes a notice for every room in `org_room`, in the same transaction,
/// which this object's alarm sends until the room acknowledges it (`org_release_notice`); a room that hears of a take
/// since what it last applied unpublishes its app. A room the list doesn't name reads the switch itself at its release
/// commands and whenever the reconcile asks it anything. Giving release back restores nothing, in every build.
///
/// **The generation's cap is `i64::MAX`, what storage holds,** where core's `set` would allow `u64::MAX`. A set past it
/// is refused with `internal_error` and writes nothing: no switch, no log row, no notice. At one set a second that is
/// about 292 billion years of sets, so it has no code of its own.
const ORG_RELEASE_SWITCH_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS org_release_switch (id INTEGER PRIMARY KEY CHECK (id = 1), granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
  generation INTEGER NOT NULL CHECK (generation >= 1), last_take INTEGER NOT NULL CHECK (last_take >= 0 AND last_take <= generation),
  set_by TEXT NOT NULL, set_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS org_release_switch_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, granted INTEGER NOT NULL, generation INTEGER NOT NULL,
  last_take INTEGER NOT NULL, set_by TEXT NOT NULL, set_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS org_release_notice (workspace_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK (generation >= 1),
  tries INTEGER NOT NULL DEFAULT 0 CHECK (tries >= 0), next_attempt_at INTEGER NOT NULL);
";
/// Notices sent in one alarm. An organization holds at most `MAX_ROOMS_PER_ORG` rooms, so one alarm sends them all.
const RELEASE_NOTICE_CALLS: i64 = 50;
/// The finding operators read for a notice no room acknowledged, by the organization it is about (decision 218).
const RELEASE_NOTICE_UNANSWERED: &str = "release_switch_notice_unanswered";
/// The finding operators read, once for each notice, when a room the organization's list names says it is another
/// organization's (decision 218).
const RELEASE_NOTICE_MISDIRECTED: &str = "release_switch_notice_misdirected";

/// How a room answered one release switch notice.
#[derive(Clone, Copy, PartialEq, Eq)]
enum NoticeAnswer {
    /// 200: applied, already held a newer switch, or the room doesn't exist.
    Acknowledged,
    /// 403: the room is another organization's, and will say so at every try.
    NotThisOrganization,
    /// Anything else, or nothing in time.
    Unanswered,
}

/// The switch as this object holds it, with who set it last and when: `ReleaseSwitch::UNSET` and nobody, with no row.
/// A row that isn't well formed is an error, never read as held.
fn release_switch_row(sql: &SqlStorage) -> R<(ReleaseSwitch, Option<String>, Option<i64>)> {
    let held = rows(
        sql,
        "SELECT granted, generation, last_take, set_by, set_at FROM org_release_switch WHERE id = 1",
        vec![],
    )?;
    let Some(row) = held.first() else {
        return Ok((ReleaseSwitch::UNSET, None, None));
    };
    let switch = ReleaseSwitch {
        granted: int(&row["granted"]) != 0,
        generation: u64::try_from(int(&row["generation"])).unwrap_or(0),
        last_take: u64::try_from(int(&row["last_take"])).unwrap_or(u64::MAX),
    };
    if !switch.well_formed() {
        return Err(ApiError::internal("the release switch isn't well formed"));
    }
    Ok((
        switch,
        row["set_by"].as_str().map(str::to_owned),
        Some(int(&row["set_at"])),
    ))
}

/// The switch's answer: `{ granted, generation, last_take, set_by, set_at }`.
fn release_switch_json(switch: ReleaseSwitch, by: Option<String>, at: Option<i64>) -> Value {
    json!({ "granted": switch.granted, "generation": switch.generation, "last_take": switch.last_take, "set_by": by, "set_at": at })
}

/// Reads an answer about a release switch, as the organization's object gives it: `None` unless it has the three
/// facts, each of its type. Anything else is no answer, never "held" or "taken". Whether the three agree is core's to
/// judge, in `release_switch_now`, which the recheck asks: one place decides it.
pub fn release_switch_of(answer: &Value) -> Option<ReleaseSwitch> {
    Some(ReleaseSwitch {
        granted: answer["granted"].as_bool()?,
        generation: answer["generation"].as_u64()?,
        last_take: answer["last_take"].as_u64()?,
    })
}

/// The organization's release switch, from its own object: `None` if the object didn't answer, or answered something
/// that isn't a switch. Never from a read model.
pub async fn org_release_switch(env: &Env, org: &str) -> Option<ReleaseSwitch> {
    let mut response = internal(env, org, "/internal/org-release-switch", &json!({}))
        .await
        .ok()?;
    if response.status_code() != 200 {
        return None;
    }
    let answer: Value = response.json().await.ok()?;
    release_switch_of(&answer)
}

/// The rooms this object has counted a request for a repository in: for an organization, its rooms; for a person, the
/// rooms they asked in. One row per room, stamped with when it was last counted, and never given back: a request that
/// fails after it was counted leaves its room counted until the stamp ages out of the window. So a count can only be too
/// high, never too low. A room has one request in its life, so rooms counted in the window is what the cap is on.
const REPO_REQUESTS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS repo_request_room (workspace_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
";

/// What an organization's object, or a person's, said to a room about to record a request for a repository.
pub struct RepoRequestReserved {
    /// The organization holds the provisioning delegation. Always `true` from a person's object, which holds none.
    pub granted: bool,
    /// The room holds a place in this object's count, stamped now.
    pub held: bool,
}

/// Counts a room's request for a repository against the cap of the organization or the person named by `holder`, and,
/// with `delegation`, reads the organization's delegation in the same transaction. Nothing is counted when the
/// delegation was taken back or the cap is reached. A room that already holds a place keeps it, stamped again with now.
/// There is nothing to give back: a place stays until it ages out.
pub async fn reserve_repo_request(
    env: &Env,
    holder: &str,
    workspace: &str,
    delegation: bool,
) -> R<RepoRequestReserved> {
    let body = json!({ "provider": "github", "workspace": workspace, "delegation": delegation });
    let mut response = internal(env, holder, "/internal/repo-request-reserve", &body).await?;
    if response.status_code() != 200 {
        return Err(ApiError::internal("couldn't count the request"));
    }
    let answer: Value = response.json().await?;
    Ok(RepoRequestReserved {
        granted: answer["granted"].as_bool() == Some(true),
        held: answer["held"].as_bool() == Some(true),
    })
}

/// Whether an organization holds the provisioning delegation for a provider: `{ provider, granted, set_by, set_at }`.
/// Every organization holds it unless a Podster operator took it back (the owner's decision of 2026-11-11, "No gate,
/// with limits"), so an organization with no record holds it.
pub async fn org_delegation(env: &Env, org: &str, provider: &str) -> R<Value> {
    let body = json!({ "provider": provider });
    let mut response = internal(env, org, "/internal/org-delegation", &body).await?;
    if response.status_code() != 200 {
        return Err(ApiError::internal("couldn't read the delegation"));
    }
    Ok(response.json().await?)
}

/// `GET` or `PUT /v1/orgs/{org}/release-delegation`, the operator's release switch (decision 218). Reached only from
/// `releases::answer`, so only while release is switched on: switched off, which is every deployment, this route is
/// answered where an unknown path is, for everyone, operators included. An agent was refused there by its kind.
/// Reading is for a Podster operator or a person who administers that organization; setting, `{ granted }`, is for a
/// Podster operator alone. A take raises the generation and is the new last take; a give-back keeps the last take and
/// restores nothing. Taking release away unpublishes the organization's rooms' apps once each room hears or reads it,
/// which is PR C's; until then it refuses their releases at the recheck.
pub async fn release_delegation(
    env: &Env,
    caller: &Caller,
    org: &str,
    set: Option<&str>,
) -> R<Response> {
    if !crate::valid_id(org) {
        return Err(ApiError::not_found());
    }
    let operator = crate::moderation::require_operator(env, caller).is_ok();
    let kind = if caller.kind == "person" {
        podster_policy::PrincipalKind::Person
    } else {
        podster_policy::PrincipalKind::Agent
    };
    let Some(raw) = set else {
        let admin =
            podster_policy::repositories::administers_org(kind, &caller.admin_orgs, Some(org));
        podster_policy::release::authorize_release_switch_read(kind, operator, admin)
            .map_err(|_| ApiError::not_allowed())?;
        let mut response = internal(env, org, "/internal/org-release-switch", &json!({})).await?;
        if response.status_code() != 200 {
            return Err(ApiError::internal("couldn't read the release switch"));
        }
        let answer: Value = response.json().await?;
        return Ok(Response::from_json(&answer)?);
    };
    podster_policy::release::authorize_release_switch_set(kind, operator)
        .map_err(|_| ApiError::not_allowed())?;
    let body: Value = serde_json::from_str(raw).map_err(|_| ApiError::invalid_argument())?;
    let granted = body
        .as_object()
        .filter(|fields| fields.len() == 1)
        .and_then(|fields| fields.get("granted"))
        .and_then(Value::as_bool)
        .ok_or_else(ApiError::invalid_argument)?;
    let change = json!({ "granted": granted, "by": caller.id, "org": org });
    let mut response = internal(env, org, "/internal/org-release-switch-set", &change).await?;
    match response.status_code() {
        200 => {}
        404 => return Err(ApiError::api(404, "organization_not_found")),
        _ => return Err(ApiError::internal("couldn't set the release switch")),
    }
    let answer: Value = response.json().await?;
    crate::moderation::record_operator_action(
        env,
        &caller.id,
        "organization",
        org,
        if granted {
            "release_switch.granted"
        } else {
            "release_switch.revoked"
        },
    )
    .await;
    console_log!(
        "{}",
        json!({ "at": "org.release_switch_set", "org": org, "granted": granted, "generation": answer["generation"], "by": caller.id })
    );
    Ok(Response::from_json(&answer)?)
}

/// Rooms from before the limit are counted once, from the listing, into `org_room`. After that this table decides.
async fn seed_org_rooms(env: &Env, sql: &SqlStorage, org: &str) -> R<()> {
    exec(sql, ORG_ROOMS_SCHEMA, vec![])?;
    if !rows(sql, "SELECT id FROM org_room_seeded", vec![])?.is_empty() {
        return Ok(());
    }
    let existing = env
        .d1("DB")?
        .prepare("SELECT DISTINCT workspace_id FROM membership_index WHERE org_id = ? AND role = 'owner' LIMIT ?")
        .bind(&[org.into(), ((MAX_ROOMS_PER_ORG + 1) as i32).into()])?
        .all()
        .await?
        .results::<Value>()?;
    for room in &existing {
        exec(
            sql,
            "INSERT OR IGNORE INTO org_room (workspace_id) VALUES (?)",
            vec![room["workspace_id"].as_str().unwrap_or_default().into()],
        )?;
    }
    exec(
        sql,
        "INSERT OR IGNORE INTO org_room_seeded (id) VALUES (1)",
        vec![],
    )
}

/// Whether the API has seen a room of this organization: this object's own record of its rooms, and, for rooms from
/// before it kept one, the listing, which here only says whether the organization is known and decides nothing else.
async fn org_known(env: &Env, sql: &SqlStorage, org: &str) -> R<bool> {
    exec(sql, ORG_ROOMS_SCHEMA, vec![])?;
    if !rows(sql, "SELECT workspace_id FROM org_room LIMIT 1", vec![])?.is_empty() {
        return Ok(true);
    }
    Ok(env
        .d1("DB")?
        .prepare("SELECT 1 AS known FROM membership_index WHERE org_id = ? LIMIT 1")
        .bind(&[org.into()])?
        .first::<Value>(None)
        .await?
        .is_some())
}

/// Whether managed repositories are switched on, for an organization's own routes. A deployment reads the Worker's
/// `MANAGED_REPOSITORIES`. Test builds can also switch one organization on, in its own object, as they switch on a room.
async fn managed_switch_on_for_org(env: &Env, org: &str) -> R<bool> {
    if env
        .var("MANAGED_REPOSITORIES")
        .is_ok_and(|value| value.to_string() == "true")
    {
        return Ok(true);
    }
    #[cfg(feature = "failpoints")]
    {
        let mut response = internal(env, org, "/internal/managed-switch", &json!({})).await?;
        let answer: Value = response.json().await?;
        Ok(answer["on"].as_bool() == Some(true))
    }
    #[cfg(not(feature = "failpoints"))]
    {
        let _ = org;
        Ok(false)
    }
}

/// `GET` or `PUT /v1/orgs/{org}/provisioning-delegation`. Reading is for a Podster operator or an admin of that
/// organization. Setting, `{ granted }`, is for a Podster operator alone, and matters only to take the delegation back
/// from an organization or to restore it: an organization holds it until then. An agent is refused in both.
///
/// A Podster operator's read and write answer whatever the switch says, so an operator can take an organization's
/// ability away, or restore it, before managed repositories are switched on (ruled 2026-11-11). Anyone else, an
/// organization's admin included, is answered exactly as a route that doesn't exist while the switch is off, before
/// anything else is decided: an ordinary person doesn't learn from it that the feature exists (narrowed 2026-11-11
/// after M5's security review, A5).
pub async fn provisioning_delegation(
    env: &Env,
    caller: &Caller,
    org: &str,
    set: Option<&str>,
) -> R<Response> {
    if !crate::valid_id(org) {
        return Err(ApiError::not_found());
    }
    let operator = crate::moderation::require_operator(env, caller).is_ok();
    if !operator && !managed_switch_on_for_org(env, org).await? {
        return Err(ApiError::not_found());
    }
    let kind = if caller.kind == "person" {
        podster_policy::PrincipalKind::Person
    } else {
        podster_policy::PrincipalKind::Agent
    };
    let Some(raw) = set else {
        let admin =
            podster_policy::repositories::administers_org(kind, &caller.admin_orgs, Some(org));
        podster_policy::repositories::authorize_delegation_read(kind, operator, admin)
            .map_err(|_| ApiError::not_allowed())?;
        return Ok(Response::from_json(
            &org_delegation(env, org, "github").await?,
        )?);
    };
    podster_policy::repositories::authorize_delegation_set(kind, operator)
        .map_err(|_| ApiError::not_allowed())?;
    let body: Value = serde_json::from_str(raw).map_err(|_| ApiError::invalid_argument())?;
    let granted = body
        .as_object()
        .filter(|fields| fields.len() == 1)
        .and_then(|fields| fields.get("granted"))
        .and_then(Value::as_bool)
        .ok_or_else(ApiError::invalid_argument)?;
    let change = json!({ "provider": "github", "granted": granted, "by": caller.id, "org": org });
    let mut response = internal(env, org, "/internal/org-delegation-set", &change).await?;
    match response.status_code() {
        200 => {}
        // The organization's own object has never held a room for it.
        404 => return Err(ApiError::api(404, "organization_not_found")),
        _ => return Err(ApiError::internal("couldn't set the delegation")),
    }
    let answer: Value = response.json().await?;
    // In the operators' own record too, beside their other actions. The organization's object already holds the change.
    crate::moderation::record_operator_action(
        env,
        &caller.id,
        "organization",
        org,
        if granted {
            "provisioning_delegation.granted"
        } else {
            "provisioning_delegation.revoked"
        },
    )
    .await;
    console_log!(
        "{}",
        json!({ "at": "org.delegation_set", "org": org, "provider": "github", "granted": granted, "by": caller.id })
    );
    Ok(Response::from_json(&answer)?)
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
    /// Test builds only: one alarm at a time, as the platform runs them. See `alarm`.
    #[cfg(feature = "failpoints")]
    test_alarm_turn: futures_util::lock::Mutex<()>,
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

    /// Sets the alarm for whichever departure or release switch notice is due first, or clears it when none are left.
    async fn arm_next_sweep(&self) -> R<()> {
        let sql = self.state.storage().sql();
        let mut due = vec![rows(
            &sql,
            "SELECT MIN(next_sweep_at) AS next FROM org_departure",
            vec![],
        )?];
        if has_table(&sql, "org_release_notice")? {
            due.push(rows(
                &sql,
                "SELECT MIN(next_attempt_at) AS next FROM org_release_notice",
                vec![],
            )?);
        }
        let next = due
            .iter()
            .filter_map(|found| found.first().and_then(|row| row["next"].as_i64()))
            .min();
        let Some(next) = next else {
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

    /// Sends each release switch notice that is due (decision 218), from the alarm. A notice carries the switch as this
    /// object holds it now, which is the newest. A room that answers 200 has applied it, or holds a newer one, or
    /// doesn't exist: the notice is done. Any other answer, or none in time, is a try that failed: it is sent again,
    /// later each time, by core's `switch_notice_unanswered`, and from the twelfth unanswered try on, operators are told
    /// by a finding that names the organization, kept in their own record. If that telling fails, the next try tells
    /// again. The count of tries carries across sets, so setting the switch again doesn't put the telling off. A
    /// notice is given up only for a room that says it is another organization's, once operators are told of it.
    async fn send_release_notices(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !has_table(&sql, "org_release_notice")? {
            return self.arm_next_sweep().await;
        }
        let due = rows(
            &sql,
            "SELECT workspace_id, org_id, tries FROM org_release_notice WHERE next_attempt_at <= ? ORDER BY next_attempt_at, workspace_id LIMIT ?",
            vec![now_ms().into(), RELEASE_NOTICE_CALLS.into()],
        )?;
        if !due.is_empty() {
            self.state
                .storage()
                .set_alarm(Duration::from_secs(DEPARTURE_REARM_SECS))
                .await?;
        }
        for notice in &due {
            let (Some(workspace), Some(org)) =
                (text(&notice["workspace_id"]), text(&notice["org_id"]))
            else {
                continue;
            };
            // Read for each notice, so one set made during these awaits is the one sent from then on.
            let (switch, _, _) = release_switch_row(&sql)?;
            let mut body = release_switch_json(switch, None, None);
            body["org"] = Value::from(org.as_str());
            let sent = i64::try_from(switch.generation).unwrap_or(i64::MAX);
            let answer = self.room_answered(&workspace, &body).await;
            if answer == NoticeAnswer::Acknowledged {
                // Done, unless a newer set replaced it during the call: that one is still owed.
                exec(
                    &sql,
                    "DELETE FROM org_release_notice WHERE workspace_id = ? AND generation <= ?",
                    vec![workspace.as_str().into(), sent.into()],
                )?;
                continue;
            }
            // A room that says it belongs to another organization will say so to every try: the list named a room
            // that isn't this organization's. Operators are told once, and only once they have it is the notice
            // dropped; until then it is a try that failed like any other. The room still reads its own
            // organization's switch itself. A later set writes a notice for it again, and is settled the same way.
            if answer == NoticeAnswer::NotThisOrganization {
                let finding = json!({ "code": RELEASE_NOTICE_MISDIRECTED, "subject": org });
                let told = crate::moderation::call(
                    &self.env,
                    crate::reconcile::FINDING_PATH,
                    Method::Post,
                    Some(finding),
                )
                .await
                .is_ok_and(|response| response.status_code() == 200);
                console_error!(
                    "release switch: a listed room is another organization's: org={} room={} generation={} told={}",
                    org,
                    workspace,
                    sent,
                    told
                );
                if told {
                    exec(
                        &sql,
                        "DELETE FROM org_release_notice WHERE workspace_id = ? AND generation <= ?",
                        vec![workspace.as_str().into(), sent.into()],
                    )?;
                    continue;
                }
            }
            let tries = int(&notice["tries"]).saturating_add(1);
            let rule = podster_core::release::switch_notice_unanswered(
                u32::try_from(tries).unwrap_or(u32::MAX),
            );
            let wait = i64::try_from(rule.wait_ms).unwrap_or(i64::MAX);
            exec(
                &sql,
                "UPDATE org_release_notice SET tries = ?, next_attempt_at = ? WHERE workspace_id = ? AND generation <= ?",
                vec![tries.into(), now_ms().saturating_add(wait).into(), workspace.as_str().into(), sent.into()],
            )?;
            console_error!(
                "release switch: a room didn't acknowledge its notice: org={} room={} generation={} tries={}",
                org,
                workspace,
                sent,
                tries
            );
            if rule.tell {
                let finding = json!({ "code": RELEASE_NOTICE_UNANSWERED, "subject": org });
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
                        "release switch: operators weren't told of an unanswered notice: org={} code=finding_not_kept",
                        org
                    );
                }
            }
        }
        self.arm_next_sweep().await
    }

    /// How a room answered a release switch notice. A hung room is `Unanswered`, so it can't hold up the ones after
    /// it.
    async fn room_answered(&self, workspace_id: &str, body: &Value) -> NoticeAnswer {
        let Ok(namespace) = self.env.durable_object("WORKSPACE") else {
            return NoticeAnswer::Unanswered;
        };
        let Ok(stub) = namespace
            .id_from_name(workspace_id)
            .and_then(|id| id.get_stub())
        else {
            return NoticeAnswer::Unanswered;
        };
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_body(Some(body.to_string().into()));
        let Ok(request) = Request::new_with_init(
            &format!(
                "https://workspace{}",
                crate::workspace::INTERNAL_RELEASE_SWITCH_NOTICE
            ),
            &init,
        ) else {
            return NoticeAnswer::Unanswered;
        };
        let call = Box::pin(stub.fetch_with_request(request));
        let deadline = Box::pin(Delay::from(Duration::from_secs(
            DEPARTURE_ROOM_TIMEOUT_SECS,
        )));
        // Only the room's own refusal of another organization's notice answers 403: see
        // `Workspace::release_switch_notice`.
        let answered = match select(call, deadline).await {
            Either::Left((Ok(response), _)) => match response.status_code() {
                200 => NoticeAnswer::Acknowledged,
                403 => NoticeAnswer::NotThisOrganization,
                _ => NoticeAnswer::Unanswered,
            },
            _ => NoticeAnswer::Unanswered,
        };
        answered
    }

    async fn dispatch(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        let path = req.path();
        match path.as_str() {
            "/internal/org-room-reserve" => {
                let body: Value = req.json().await?;
                let org = body["org"].as_str().unwrap_or_default().to_string();
                let workspace = body["workspace"].as_str().unwrap_or_default().to_string();
                seed_org_rooms(&self.env, &sql, &org).await?;
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
            // Test builds only: whether a test switched managed repositories on for this organization alone.
            #[cfg(feature = "failpoints")]
            "/internal/managed-switch" => {
                let on = !rows(
                    &sql,
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_managed_repositories_on'",
                    vec![],
                )?
                .is_empty();
                return Ok(json!({ "on": on }));
            }
            "/internal/org-release-switch" | "/internal/org-release-switch-set" => {
                // Test builds only: an organization whose own object doesn't answer, by its ID's prefix.
                #[cfg(feature = "failpoints")]
                if path == "/internal/org-release-switch"
                    && self
                        .state
                        .id()
                        .name()
                        .is_some_and(|name| name.starts_with("org_unavailable_"))
                {
                    return Err(ApiError::internal("test: the organization didn't answer"));
                }
                // Test builds only: this organization's switch alone doesn't answer, while its delegation does.
                #[cfg(feature = "failpoints")]
                if path == "/internal/org-release-switch"
                    && has_table(&sql, "test_release_switch_unreadable")?
                {
                    return Err(ApiError::internal("test: the release switch didn't answer"));
                }
                exec(&sql, ORG_RELEASE_SWITCH_SCHEMA, vec![])?;
                // Test builds only: a read of the switch held after it is read, until the test lets it go, so a test
                // can set the switch and send its notices while a room being made waits for that read.
                #[cfg(feature = "failpoints")]
                if path == "/internal/org-release-switch"
                    && has_table(&sql, "test_release_switch_read_hold")?
                {
                    let answer = release_switch_row(&sql)?;
                    exec(
                        &sql,
                        "UPDATE test_release_switch_read_hold SET arrived = 1",
                        vec![],
                    )?;
                    // At most 20 seconds, so a test that forgets to let go fails and doesn't hang.
                    for _ in 0..4000 {
                        if !has_table(&sql, "test_release_switch_read_hold")? {
                            break;
                        }
                        Delay::from(Duration::from_millis(5)).await;
                    }
                    let (switch, by, at) = answer;
                    return Ok(release_switch_json(switch, by, at));
                }
                if path == "/internal/org-release-switch-set" {
                    let body: Value = req.json().await?;
                    let org = body["org"].as_str().unwrap_or_default().to_string();
                    if !org_known(&self.env, &sql, &org).await? {
                        return Err(ApiError::api(404, "organization_not_found"));
                    }
                    let granted = body["granted"]
                        .as_bool()
                        .ok_or_else(ApiError::invalid_argument)?;
                    let by = body["by"].as_str().unwrap_or_default().to_string();
                    // The rooms to tell are this object's list. Rooms from before it kept one are taken from the
                    // listing once, as a room's creation does; a room missing from both reads the switch itself.
                    seed_org_rooms(&self.env, &sql, &org).await?;
                    let state = self.state.storage().sql();
                    transaction_sync(&self.state, move || {
                        let (now_held, _, _) = release_switch_row(&state)?;
                        // Core's set alone writes it. Past the last generation it is refused, never written at one no
                        // room would take as newer.
                        let next = now_held.set(granted).ok_or_else(|| {
                            ApiError::internal("the release switch can't go further")
                        })?;
                        let generation = i64::try_from(next.generation).map_err(|_| {
                            ApiError::internal("the release switch can't go further")
                        })?;
                        let last_take = i64::try_from(next.last_take).map_err(|_| {
                            ApiError::internal("the release switch can't go further")
                        })?;
                        let now = now_ms();
                        exec(&state, "INSERT INTO org_release_switch (id, granted, generation, last_take, set_by, set_at) VALUES (1, ?, ?, ?, ?, ?)
                            ON CONFLICT (id) DO UPDATE SET granted = excluded.granted, generation = excluded.generation, last_take = excluded.last_take,
                            set_by = excluded.set_by, set_at = excluded.set_at",
                            vec![i64::from(next.granted).into(), generation.into(), last_take.into(), by.as_str().into(), now.into()])?;
                        exec(&state, "INSERT INTO org_release_switch_log (granted, generation, last_take, set_by, set_at) VALUES (?, ?, ?, ?, ?)",
                            vec![i64::from(next.granted).into(), generation.into(), last_take.into(), by.as_str().into(), now.into()])?;
                        // A notice for every room the list names, in this same transaction, due now. One owed for an
                        // earlier set is replaced: the room acts only on the newest, and that carries every take. Its
                        // count of unanswered tries is kept, so a room that never answers is told to operators on
                        // time however often the switch is set: the count is of tries since the room last answered.
                        exec(&state, "INSERT INTO org_release_notice (workspace_id, org_id, generation, tries, next_attempt_at)
                            SELECT workspace_id, ?, ?, 0, ? FROM org_room WHERE true
                            ON CONFLICT (workspace_id) DO UPDATE SET org_id = excluded.org_id, generation = excluded.generation,
                              next_attempt_at = excluded.next_attempt_at",
                            vec![org.as_str().into(), generation.into(), now.into()])
                    })?;
                    // The notices go from the alarm, straight away. If it can't be set, the set has still committed and
                    // the operator is told it failed; asking again writes the notices again and arms again.
                    self.state
                        .storage()
                        .set_alarm(Duration::from_millis(1))
                        .await?;
                }
                let (switch, by, at) = release_switch_row(&sql)?;
                return Ok(release_switch_json(switch, by, at));
            }
            "/internal/org-delegation" | "/internal/org-delegation-set" => {
                let body: Value = req.json().await?;
                let provider = body["provider"].as_str().unwrap_or_default().to_string();
                // Test builds only: an organization whose own object doesn't answer the read, by its ID's prefix,
                // as a person's doesn't answer the departure question.
                #[cfg(feature = "failpoints")]
                if path == "/internal/org-delegation"
                    && self
                        .state
                        .id()
                        .name()
                        .is_some_and(|name| name.starts_with("org_unavailable_"))
                {
                    return Err(ApiError::internal("test: the organization didn't answer"));
                }
                exec(&sql, ORG_DELEGATION_SCHEMA, vec![])?;
                if path == "/internal/org-delegation-set" {
                    // An organization the API has never seen a room of isn't one to delegate to. This object records
                    // each room as it's made. Rooms from before it kept that record are in the listing, which here
                    // only says whether the organization is known.
                    let org = body["org"].as_str().unwrap_or_default().to_string();
                    if !org_known(&self.env, &sql, &org).await? {
                        return Err(ApiError::api(404, "organization_not_found"));
                    }
                    let granted = body["granted"]
                        .as_bool()
                        .ok_or_else(ApiError::invalid_argument)?;
                    let by = body["by"].as_str().unwrap_or_default().to_string();
                    let state = self.state.storage().sql();
                    let name = provider.clone();
                    transaction_sync(&self.state, move || {
                        let now = now_ms();
                        exec(&state, "INSERT INTO org_provider_delegation (provider, granted, set_by, set_at) VALUES (?, ?, ?, ?)
                            ON CONFLICT (provider) DO UPDATE SET granted = excluded.granted, set_by = excluded.set_by, set_at = excluded.set_at",
                            vec![name.as_str().into(), i64::from(granted).into(), by.as_str().into(), now.into()])?;
                        exec(&state, "INSERT INTO org_provider_delegation_log (provider, granted, set_by, set_at) VALUES (?, ?, ?, ?)",
                            vec![name.as_str().into(), i64::from(granted).into(), by.as_str().into(), now.into()])
                    })?;
                }
                let held = rows(&sql, "SELECT granted, set_by, set_at FROM org_provider_delegation WHERE provider = ?", vec![provider.as_str().into()])?;
                return Ok(match held.first() {
                    Some(row) => {
                        json!({ "provider": provider, "granted": int(&row["granted"]) != 0, "set_by": row["set_by"], "set_at": row["set_at"] })
                    }
                    // No record: held, as every organization is until an operator takes it back.
                    None => {
                        json!({ "provider": provider, "granted": podster_core::provisioning::organization_delegated(None), "set_by": null, "set_at": null })
                    }
                });
            }
            "/internal/repo-request-reserve" => {
                let body: Value = req.json().await?;
                let workspace = body["workspace"].as_str().unwrap_or_default().to_string();
                let provider = body["provider"].as_str().unwrap_or_default().to_string();
                let delegation = body["delegation"].as_bool() == Some(true);
                // Tests can't otherwise make a person's own count fail to answer.
                #[cfg(feature = "failpoints")]
                if !delegation
                    && self
                        .state
                        .id()
                        .name()
                        .is_some_and(|name| name.starts_with("per_unavailable_"))
                {
                    return Err(ApiError::api(503, "unavailable"));
                }
                if workspace.is_empty() {
                    return Err(ApiError::invalid_argument());
                }
                let state = self.state.storage().sql();
                let answer = Rc::new(RefCell::new((false, false)));
                let slot = answer.clone();
                // The delegation, the count and the room's place in one transaction, by this object's own clock: so
                // two rooms asking at once can't both take the last place.
                transaction_sync(&self.state, move || {
                    let granted = if delegation {
                        exec(&state, ORG_DELEGATION_SCHEMA, vec![])?;
                        let recorded = rows(
                            &state,
                            "SELECT granted FROM org_provider_delegation WHERE provider = ?",
                            vec![provider.as_str().into()],
                        )?
                        .first()
                        .map(|row| int(&row["granted"]) != 0);
                        podster_core::provisioning::organization_delegated(recorded)
                    } else {
                        true
                    };
                    if !granted {
                        return Ok(());
                    }
                    let now = now_ms();
                    exec(&state, REPO_REQUESTS_SCHEMA, vec![])?;
                    // Places that left the window count for nothing, this room's own included: it's then asked as new.
                    // The window's one edge is crates/core's, as the count uses it.
                    exec(
                        &state,
                        "DELETE FROM repo_request_room WHERE at < ?",
                        vec![
                            podster_core::provisioning::repository_request_window_start(now).into(),
                        ],
                    )?;
                    let holds = !rows(
                        &state,
                        "SELECT 1 FROM repo_request_room WHERE workspace_id = ?",
                        vec![workspace.as_str().into()],
                    )?
                    .is_empty();
                    let others: Vec<i64> = rows(
                        &state,
                        "SELECT at FROM repo_request_room WHERE workspace_id != ?",
                        vec![workspace.as_str().into()],
                    )?
                    .iter()
                    .map(|row| int(&row["at"]))
                    .collect();
                    let held =
                        podster_core::provisioning::repository_place_held(holds, &others, now);
                    if held {
                        // Insert if absent, otherwise stamp again: a place left by an earlier attempt must not age out
                        // just after a later attempt records.
                        exec(
                            &state,
                            "INSERT INTO repo_request_room (workspace_id, at) VALUES (?1, ?2)
                               ON CONFLICT (workspace_id) DO UPDATE SET at = excluded.at",
                            vec![workspace.as_str().into(), now.into()],
                        )?;
                    }
                    *slot.borrow_mut() = (true, held);
                    Ok(())
                })?;
                let (granted, held) = *answer.borrow();
                return Ok(json!({ "granted": granted, "held": held }));
            }
            "/internal/org-room-release" => {
                let body: Value = req.json().await?;
                exec(&sql, ORG_ROOMS_SCHEMA, vec![])?;
                exec(
                    &sql,
                    "DELETE FROM org_room WHERE workspace_id = ?",
                    vec![body["workspace"].as_str().unwrap_or_default().into()],
                )?;
                // A room whose creation was refused is owed no notice.
                if has_table(&sql, "org_release_notice")? {
                    exec(
                        &sql,
                        "DELETE FROM org_release_notice WHERE workspace_id = ?",
                        vec![body["workspace"].as_str().unwrap_or_default().into()],
                    )?;
                }
                return Ok(json!({ "released": true }));
            }
            "/internal/org-departure" => {
                let body: Value = req.json().await?;
                exec(&sql, DEPARTURE_SCHEMA, vec![])?;
                // Test builds only: a person whose ID says so has their rooms swept a day from now, so a test can act while
                // the departure is known here and no room has heard of it yet.
                let first_sweep_at: i64 = if cfg!(feature = "failpoints")
                    && body["person"]
                        .as_str()
                        .is_some_and(|p| p.starts_with("per_unswept_"))
                {
                    now_ms() + 24 * 60 * 60 * 1000
                } else {
                    0
                };
                // A retry of one the gateway already sent changes nothing, because rooms ignore what they've applied.
                exec(&sql, "INSERT OR IGNORE INTO org_departure (org_id, left_at, person_id, actor_id, sweeps_left, next_sweep_at) VALUES (?, ?, ?, ?, ?, ?)", vec![
                    body["org"].as_str().unwrap_or_default().into(),
                    body["left_at"].as_i64().ok_or_else(ApiError::invalid_argument)?.into(),
                    body["person"].as_str().unwrap_or_default().into(),
                    body["actor"].as_str().unwrap_or_default().into(),
                    DEPARTURE_SWEEPS.into(),
                    first_sweep_at.into(),
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
            "/internal/a2a-endpoint-pin" => {
                #[cfg(feature = "failpoints")]
                if !rows(&sql, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_fail_pin'", vec![])?.is_empty() {
                    return Err(ApiError::internal("injected pin failure"));
                }
                let pin = a2a_endpoint::pin(&sql)?;
                let answer = |active: bool, reason: Option<&str>| {
                    let mut out =
                        json!({ "active": active, "url": pin["url"], "version": pin["version"] });
                    if let Some(reason) = reason {
                        out["reason"] = json!(reason);
                    }
                    out
                };
                if pin["active"] != Value::Bool(true) {
                    return Ok(answer(false, None));
                }
                // As a claim does: whoever set the endpoint must still be in the agent's organization, and if that can't be
                // told, the endpoint isn't in force. Deleting the registration is left to the next claim, which does it.
                let setter = &pin["setter"];
                let (person, org) = (
                    setter["person"].as_str().unwrap_or_default(),
                    setter["org"].as_str().unwrap_or_default(),
                );
                if !crate::valid_id(person) || !crate::valid_id(org) {
                    return Ok(answer(false, Some("setter_unknown")));
                }
                return Ok(
                    match departed_since(
                        &self.env,
                        person,
                        org,
                        setter["since"].as_i64().unwrap_or(0),
                    )
                    .await
                    {
                        Ok(false) => answer(true, None),
                        Ok(true) => answer(false, Some("setter_departed")),
                        Err(_) => answer(false, Some("setter_unknown")),
                    },
                );
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
            "/internal/public-claims-suspension" => {
                // Only an agent that was ever registered: an operator's typo mustn't make a Principal.
                if connection(&sql)?.is_none() {
                    return Err(ApiError::agent_not_found());
                }
                let body: Value = req.json().await?;
                let (store, now) = (sql.clone(), now_ms());
                return self
                    .in_transaction(move || public_claims::set_suspension(&store, &body, now));
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
                // An operator's suspension refuses every public claim (M4 step 10). Invited ones are unaffected.
                if body["public_claim"].as_bool() == Some(true) && public_claims::suspended(&sql)? {
                    return Err(ApiError::api(403, PUBLIC_CLAIMS_SUSPENDED));
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

    async fn alarm(&self) -> Result<Response> {
        // The platform never runs two alarms of one object at once. A test calls this handler directly, beside a run the
        // runtime started itself, so in test builds a direct call waits its turn, as the room's does.
        #[cfg(feature = "failpoints")]
        let _turn = self.test_alarm_turn.lock().await;
        // A person has departures and an agent has a fan-out, so neither clears the other's alarm.
        let sql = self.state.storage().sql();
        let is_agent = matches!(connection(&sql), Ok(Some(_)));
        let outcome = if is_agent {
            self.fan_out().await
        } else {
            // An organization's object has release switch notices and no departures; a person's, the reverse. Each
            // runs whatever it has, and the last arms for whichever of both is due first.
            match self.sweep_departures().await {
                Ok(()) => self.send_release_notices().await,
                Err(error) => Err(error),
            }
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
