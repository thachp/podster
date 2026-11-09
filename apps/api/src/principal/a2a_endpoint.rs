//! An agent's A2A endpoint (M3 step 11), on its Principal: set, delete and status, plus what the outbound consumer (step 12)
//! reads to send and reports back. The rules are `podster_egress::endpoint`. ADR 0007 and decisions 119, 122 and 134.
//!
//! The signing secret is shown once, when a registration version is made. The bearer token is write-only: sealed when set,
//! opened only for a send, and never in a read, an event, the inbox or a log. Both go when the URL changes, on delete and on
//! disconnect. Logs carry IDs only, never the URL or either credential.
//!
//! Each set records who set it: the person who linked the agent's credential, or the admin. A send stops, and the endpoint
//! is deleted, once that person has left the agent's organization since (ADR 0007, step 12). Their own Principal records
//! the departure, so a claim asks it, and refuses to send if it can't tell.
use super::*;
use podster_egress::endpoint::{
    check_endpoint_url, decide_report, decide_set, open, parse_key, seal, valid_bearer_token,
    ReportOutcome, TokenChange, NONCE_BYTES,
};

/// One endpoint per agent. A delete blanks the row rather than removing it, so `version` only ever goes up and an attempt
/// pinned to an old registration never matches a new one.
pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS a2a_endpoint (id INTEGER PRIMARY KEY CHECK (id = 1), url TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
  signing_secret TEXT NOT NULL DEFAULT '', token_sealed TEXT, enabled INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  set_at INTEGER, last_report_at INTEGER, set_by TEXT, set_by_org TEXT, set_by_since INTEGER);
";

/// Who set the endpoint: a person, the organization it's for, and since when that person's link or membership counts, in
/// milliseconds. A departure from that organization at or after `since` ends the endpoint.
pub(super) struct Setter<'a> {
    pub person: &'a str,
    pub org: &'a str,
    pub since: i64,
}

/// Creates the table, and adds step 12's columns to one made before them. Forward-only.
fn ensure_schema(sql: &SqlStorage) -> R<()> {
    exec(sql, SCHEMA, vec![])?;
    let has_setter = !rows(
        sql,
        "SELECT name FROM pragma_table_info('a2a_endpoint') WHERE name = 'set_by'",
        vec![],
    )?
    .is_empty();
    if !has_setter {
        exec(
            sql,
            "ALTER TABLE a2a_endpoint ADD COLUMN set_by TEXT; ALTER TABLE a2a_endpoint ADD COLUMN set_by_org TEXT;
             ALTER TABLE a2a_endpoint ADD COLUMN set_by_since INTEGER;",
            vec![],
        )?;
    }
    Ok(())
}

/// The Worker secret holding the sealing key, 64 hex characters. The owner sets it (decision 122).
pub(super) const KEY_SECRET: &str = "A2A_TOKEN_KEY";

fn invalid_url() -> ApiError {
    ApiError::api(400, "invalid_endpoint_url")
}

fn no_token_storage() -> ApiError {
    ApiError::api(503, "token_storage_unavailable")
}

fn stored(sql: &SqlStorage) -> R<Option<Value>> {
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'a2a_endpoint'",
        vec![],
    )?
    .is_empty()
    {
        return Ok(None);
    }
    Ok(rows(sql, "SELECT * FROM a2a_endpoint", vec![])?
        .into_iter()
        .next())
}

/// The registered endpoint, if one is set now.
fn current(sql: &SqlStorage) -> R<Option<Value>> {
    Ok(stored(sql)?.filter(|row| row["url"].as_str().is_some_and(|url| !url.is_empty())))
}

/// Whether the stored token can be used now: `none`, `stored`, or `unreadable` when it can't be opened, because the key was
/// changed or isn't set. Never the token itself.
fn token_state(row: &Value, key: Option<&[u8]>, agent: &str) -> &'static str {
    let Some(sealed) = row["token_sealed"].as_str() else {
        return "none";
    };
    let version = int(&row["version"]).max(0) as u64;
    match key.map(|key| open(key, agent, version, sealed)) {
        Some(Ok(_)) => "stored",
        _ => "unreadable",
    }
}

/// What a read shows: never the signing secret or the token, only whether a token is stored and can be used.
pub(super) fn status_json(sql: &SqlStorage, key: Option<&[u8]>) -> R<Value> {
    let agent = connection(sql)?
        .and_then(|c| text(&c["id"]))
        .unwrap_or_default();
    Ok(match current(sql)? {
        Some(row) => {
            let token_state = token_state(&row, key, &agent);
            json!({
                "url": row["url"], "version": row["version"], "enabled": int(&row["enabled"]) == 1,
                "consecutive_failures": row["consecutive_failures"], "has_token": token_state != "none",
                "token_state": token_state, "set_at": row["set_at"],
            })
        }
        None => Value::Null,
    })
}

/// A fresh 96-bit nonce from the Worker's own `crypto.getRandomValues`. If that isn't there, nothing is sealed.
fn fresh_nonce() -> R<[u8; NONCE_BYTES]> {
    use wasm_bindgen::JsCast;
    let unavailable = |_| no_token_storage();
    let crypto = js_sys::Reflect::get(&js_sys::global(), &"crypto".into()).map_err(unavailable)?;
    let fill: js_sys::Function = js_sys::Reflect::get(&crypto, &"getRandomValues".into())
        .map_err(unavailable)?
        .dyn_into()
        .map_err(unavailable)?;
    let array = js_sys::Uint8Array::new_with_length(NONCE_BYTES as u32);
    fill.call1(&crypto, &array).map_err(unavailable)?;
    // Built from the filled array, so no buffer of fixed bytes ever stands in for the nonce.
    array.to_vec().try_into().map_err(|_| no_token_storage())
}

fn new_secret() -> String {
    format!(
        "a2asec_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// `PUT`: `{ "url": "https://…", "token"?: "…" | null, "rotate_secret"?: true }`. `rotate_secret` makes a new signing secret for
/// the same URL, returned once, so a lost secret needs no delete. A new URL, or one set after a delete, makes a new registration
/// version and signing secret, returned here once, and clears any token not given in the same request. The same URL keeps
/// its version and secret, keeps the token unless it's replaced or cleared, and turns a switched-off endpoint back on.
/// `key` is the sealing key, if the owner has set it: without it a token can't be stored, and the endpoint can still be set.
pub(super) fn set(
    sql: &SqlStorage,
    key: Option<&[u8]>,
    agent: &str,
    setter: &Setter<'_>,
    body: &Value,
    now: i64,
) -> R<Value> {
    let object = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if object
        .keys()
        .any(|k| !matches!(k.as_str(), "url" | "token" | "rotate_secret"))
    {
        return Err(ApiError::invalid_argument());
    }
    let rotate_secret = match body.get("rotate_secret") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(rotate)) => *rotate,
        Some(_) => return Err(ApiError::invalid_argument()),
    };
    let url = body["url"]
        .as_str()
        .ok_or_else(ApiError::invalid_argument)?;
    let url = check_endpoint_url(url).map_err(|_| invalid_url())?;
    let (change, token) = match body.get("token") {
        None => (TokenChange::Unchanged, None),
        Some(Value::Null) => (TokenChange::Clear, None),
        Some(Value::String(token)) if valid_bearer_token(token) => {
            (TokenChange::Replace, Some(token.as_str()))
        }
        Some(_) => return Err(ApiError::invalid_argument()),
    };
    if token.is_some() && key.is_none() {
        return Err(no_token_storage());
    }
    ensure_schema(sql)?;
    let row = stored(sql)?;
    let current_url = row
        .as_ref()
        .and_then(|r| r["url"].as_str())
        .filter(|u| !u.is_empty());
    let highest = row.as_ref().map_or(0, |r| int(&r["version"]).max(0) as u64);
    let outcome = decide_set(current_url, highest, &url, change, rotate_secret);
    let secret = if outcome.new_secret {
        new_secret()
    } else {
        row.as_ref()
            .and_then(|r| text(&r["signing_secret"]))
            .unwrap_or_default()
    };
    let sealed = match (token, key) {
        (Some(token), Some(key)) => Some(
            seal(key, &fresh_nonce()?, agent, outcome.version, token)
                .map_err(|_| no_token_storage())?,
        ),
        _ if outcome.keep_token => row.as_ref().and_then(|r| text(&r["token_sealed"])),
        _ => None,
    };
    exec(
        sql,
        "INSERT INTO a2a_endpoint (id, url, version, signing_secret, token_sealed, enabled, consecutive_failures, set_at, set_by, set_by_org, set_by_since)
          VALUES (1, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET url = excluded.url, version = excluded.version, signing_secret = excluded.signing_secret,
            token_sealed = excluded.token_sealed, enabled = 1, consecutive_failures = 0, set_at = excluded.set_at,
            set_by = excluded.set_by, set_by_org = excluded.set_by_org, set_by_since = excluded.set_by_since",
        vec![
            url.as_str().into(),
            (outcome.version as i64).into(),
            secret.as_str().into(),
            sealed.as_deref().map_or(SqlStorageValue::Null, SqlStorageValue::from),
            now.into(),
            setter.person.into(),
            setter.org.into(),
            setter.since.into(),
        ],
    )?;
    let mut out = status_json(sql, key)?;
    if outcome.new_secret {
        out["signing_secret"] = json!(secret);
    }
    Ok(out)
}

/// `DELETE`, and what a disconnect does: blanks the URL, signing secret and token, keeping the version so the next set moves
/// past it. Deleting nothing is fine.
pub(super) fn delete(sql: &SqlStorage) -> R<Value> {
    if stored(sql)?.is_some() {
        ensure_schema(sql)?;
        exec(
            sql,
            "UPDATE a2a_endpoint SET url = '', signing_secret = '', token_sealed = NULL, enabled = 0, consecutive_failures = 0, set_by = NULL",
            vec![],
        )?;
    }
    Ok(json!({ "deleted": true }))
}

/// Deletes the endpoint only if it's still at `version`, as `delete` does. A newer registration, set since the caller looked,
/// is someone else's to end.
pub(super) fn delete_version(sql: &SqlStorage, version: i64) -> R<Value> {
    match current(sql)? {
        Some(row) if int(&row["version"]) == version => delete(sql),
        _ => Ok(json!({ "deleted": false })),
    }
}

/// `/internal/a2a-endpoint-claim`, for the outbound consumer: what it needs to send, if it may. Only for an active agent with
/// an endpoint that's on and still passes the egress rules, which are checked again here as before each send. A token that
/// can't be opened, because the key changed or is missing, sends nothing and says so, without the token.
pub(super) fn claim(sql: &SqlStorage, key: Option<&[u8]>) -> R<Value> {
    let skip = |reason: &str| json!({ "send": false, "reason": reason });
    let Some(conn) = connection(sql)? else {
        return Ok(skip("no_agent"));
    };
    if conn["status"].as_str() != Some(ACTIVE) {
        return Ok(skip("disconnected"));
    }
    let Some(row) = current(sql)? else {
        return Ok(skip("no_endpoint"));
    };
    if int(&row["enabled"]) != 1 {
        return Ok(skip("switched_off"));
    }
    let url = text(&row["url"]).unwrap_or_default();
    if check_endpoint_url(&url).is_err() {
        exec(sql, "UPDATE a2a_endpoint SET enabled = 0", vec![])?;
        return Ok(skip("refused_url"));
    }
    // Set before step 12 recorded who set it: it sends nothing until it's set again.
    let (Some(set_by), Some(set_by_org), Some(set_by_since)) = (
        text(&row["set_by"]),
        text(&row["set_by_org"]),
        row["set_by_since"].as_i64(),
    ) else {
        return Ok(skip("setter_unknown"));
    };
    let version = int(&row["version"]).max(0) as u64;
    let token = match row["token_sealed"].as_str() {
        None => Value::Null,
        Some(sealed) => {
            let agent = conn["id"].as_str().unwrap_or_default();
            match key.map(|key| open(key, agent, version, sealed)) {
                Some(Ok(token)) => json!(token),
                _ => return Ok(skip("token_unavailable")),
            }
        }
    };
    Ok(json!({
        "send": true, "agent_id": conn["id"], "org_id": conn["org_id"], "generation": conn["generation"], "url": url, "version": version,
        "signing_secret": row["signing_secret"], "token": token,
        "setter": { "person": set_by, "org": set_by_org, "since": set_by_since },
    }))
}

/// `/internal/a2a-endpoint-pin`: the endpoint's URL and version, and whether it's usable now, with no secret or token, so a
/// room can check a held response's endpoint is still the one in force before submitting it (decision 174).
pub(super) fn pin(sql: &SqlStorage) -> R<Value> {
    let inactive = json!({ "active": false });
    let Some(conn) = connection(sql)? else {
        return Ok(inactive);
    };
    let Some(row) = current(sql)? else {
        return Ok(inactive);
    };
    let url = text(&row["url"]).unwrap_or_default();
    let active = conn["status"].as_str() == Some(ACTIVE)
        && int(&row["enabled"]) == 1
        && check_endpoint_url(&url).is_ok();
    Ok(json!({ "active": active, "url": url, "version": int(&row["version"]).max(0) }))
}

/// `/internal/a2a-endpoint-report` with `{ "version": n, "ok": bool }`: counts one request's result toward switching the
/// endpoint off. A report for an older version, or a deleted or switched-off endpoint, changes nothing.
pub(super) fn report(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let version = body["version"]
        .as_u64()
        .ok_or_else(ApiError::invalid_argument)?;
    let ok = body["ok"]
        .as_bool()
        .ok_or_else(ApiError::invalid_argument)?;
    let row = current(sql)?;
    let outcome = decide_report(
        row.as_ref().map(|r| int(&r["version"]).max(0) as u64),
        row.as_ref().is_some_and(|r| int(&r["enabled"]) == 1),
        row.as_ref().map_or(0, |r| int(&r["consecutive_failures"])),
        version,
        ok,
    );
    let name =
        match outcome {
            ReportOutcome::Ignored => "ignored",
            ReportOutcome::Reset => {
                exec(
                    sql,
                    "UPDATE a2a_endpoint SET consecutive_failures = 0, last_report_at = ?",
                    vec![now.into()],
                )?;
                "reset"
            }
            ReportOutcome::Counted(failures) => {
                exec(
                    sql,
                    "UPDATE a2a_endpoint SET consecutive_failures = ?, last_report_at = ?",
                    vec![failures.into(), now.into()],
                )?;
                "counted"
            }
            ReportOutcome::SwitchedOff => {
                exec(
                sql,
                "UPDATE a2a_endpoint SET consecutive_failures = ?, enabled = 0, last_report_at = ?",
                vec![podster_egress::endpoint::MAX_ENDPOINT_FAILURES.into(), now.into()],
            )?;
                "switched_off"
            }
        };
    Ok(json!({ "outcome": name }))
}

/// The sealing key from the Worker's environment, if the owner has set a valid one. A value that's set but isn't 64 hex
/// characters fails closed, as if unset, and logs one code with nothing of the value in it.
pub(super) fn key(env: &Env) -> Option<Vec<u8>> {
    let secret = env.secret(KEY_SECRET).ok()?.to_string();
    let key = parse_key(&secret);
    if key.is_none() {
        console_error!("a2a.token_key_invalid");
    }
    key
}
