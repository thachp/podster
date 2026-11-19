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
//!
//! M7 step 13 adds a delivery mode, `nudge`, which sends IDs only (`podster_egress::nudge`, **Proposed**). A nudge endpoint
//! sends nothing until it has proved control, by answering a signed challenge with an HMAC under its own signing secret, and
//! a person who administers the agent's organization has switched it on for that exact registration version. Any new
//! signing secret clears both. That person leaving the organization switches it off again, as a claim finds.
use super::*;
use podster_egress::endpoint::{
    check_endpoint_url, decide_report, open, parse_key, seal, valid_bearer_token, ReportOutcome,
    TokenChange, NONCE_BYTES,
};
use podster_egress::nudge::{
    decide_nudge, decide_opt_in, decide_set_for, decide_verify, decide_verify_result,
    proof_matches, valid_challenge, Delivery, NudgeState, Refusal as NudgeRefusal, Registration,
    VerifyResult, VerifyStart,
};

/// One endpoint per agent. A delete blanks the row rather than removing it, so `version` only ever goes up and an attempt
/// pinned to an old registration never matches a new one.
pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS a2a_endpoint (id INTEGER PRIMARY KEY CHECK (id = 1), url TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
  signing_secret TEXT NOT NULL DEFAULT '', token_sealed TEXT, enabled INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  set_at INTEGER, last_report_at INTEGER, set_by TEXT, set_by_org TEXT, set_by_since INTEGER, delivery TEXT NOT NULL DEFAULT 'offers',
  verified_at INTEGER, challenge TEXT, verify_attempts INTEGER NOT NULL DEFAULT 0, nudge_version INTEGER, nudge_by TEXT,
  nudge_by_org TEXT, nudge_by_since INTEGER, nudge_set_at INTEGER);
";

/// The nudge's own audit, IDs and reason codes only (M7 step 13): each challenge's outcome and each switch.
const AUDIT_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS a2a_nudge_audit (seq INTEGER PRIMARY KEY, type TEXT NOT NULL, actor_id TEXT NOT NULL,
  version INTEGER NOT NULL, reason TEXT, created_at INTEGER NOT NULL);";
/// Audit rows kept, so a flood of challenges can't grow the object without end.
const AUDIT_KEPT: i64 = 200;

/// Who set the endpoint: a person, the organization it's for, and since when that person's link or membership counts, in
/// milliseconds. A departure from that organization at or after `since` ends the endpoint.
pub(super) struct Setter<'a> {
    pub person: &'a str,
    pub org: &'a str,
    pub since: i64,
}

/// Creates the table, and adds step 12's and M7 step 13's columns to one made before them. Forward-only.
fn ensure_schema(sql: &SqlStorage) -> R<()> {
    exec(sql, SCHEMA, vec![])?;
    exec(sql, AUDIT_SCHEMA, vec![])?;
    let has_delivery = !rows(
        sql,
        "SELECT name FROM pragma_table_info('a2a_endpoint') WHERE name = 'delivery'",
        vec![],
    )?
    .is_empty();
    if !has_delivery {
        exec(
            sql,
            "ALTER TABLE a2a_endpoint ADD COLUMN delivery TEXT NOT NULL DEFAULT 'offers'; ALTER TABLE a2a_endpoint ADD COLUMN verified_at INTEGER;
             ALTER TABLE a2a_endpoint ADD COLUMN challenge TEXT; ALTER TABLE a2a_endpoint ADD COLUMN verify_attempts INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE a2a_endpoint ADD COLUMN nudge_version INTEGER; ALTER TABLE a2a_endpoint ADD COLUMN nudge_by TEXT;
             ALTER TABLE a2a_endpoint ADD COLUMN nudge_by_org TEXT; ALTER TABLE a2a_endpoint ADD COLUMN nudge_by_since INTEGER;
             ALTER TABLE a2a_endpoint ADD COLUMN nudge_set_at INTEGER;",
            vec![],
        )?;
    }
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
            let delivery = delivery_of(&row);
            let mut out = json!({
                "url": row["url"], "version": row["version"], "enabled": int(&row["enabled"]) == 1,
                "consecutive_failures": row["consecutive_failures"], "has_token": token_state != "none",
                "token_state": token_state, "set_at": row["set_at"], "delivery": delivery.name(),
            });
            // A nudge endpoint also says whether it proved control, and whether the owner switched it on for this version.
            if delivery == Delivery::Nudge {
                let state = nudge_state(&row);
                out["control"] = json!(if state.verified {
                    "verified"
                } else {
                    "unverified"
                });
                out["nudge_on"] = json!(decide_nudge(state).is_ok());
                out["nudge_set_at"] = row["nudge_set_at"].clone();
            }
            out
        }
        None => Value::Null,
    })
}

/// The row's delivery mode. A row made before M7 step 13, or one that says anything else, is `offers`.
fn delivery_of(row: &Value) -> Delivery {
    row["delivery"]
        .as_str()
        .and_then(Delivery::from_name)
        .unwrap_or(Delivery::Offers)
}

fn nudge_state(row: &Value) -> NudgeState {
    NudgeState {
        version: int(&row["version"]).max(0) as u64,
        verified: row["verified_at"].as_i64().is_some(),
        opted_in_version: row["nudge_version"].as_i64().map(|v| v.max(0) as u64),
    }
}

fn registration(row: &Value) -> Registration {
    Registration {
        version: int(&row["version"]).max(0) as u64,
        delivery: delivery_of(row),
        enabled: int(&row["enabled"]) == 1,
        verified: row["verified_at"].as_i64().is_some(),
        verify_attempts: int(&row["verify_attempts"]),
    }
}

fn refused(refusal: NudgeRefusal) -> ApiError {
    let (status, code) = refusal.code();
    // error-codes: no_endpoint, not_a_nudge_endpoint, endpoint_switched_off, verify_attempts_exhausted, endpoint_unverified, endpoint_changed
    ApiError::api(status, code)
}

fn audit(
    sql: &SqlStorage,
    kind: &str,
    actor: &str,
    version: i64,
    reason: Option<&str>,
    now: i64,
) -> R<()> {
    exec(sql, AUDIT_SCHEMA, vec![])?;
    exec(
        sql,
        "INSERT INTO a2a_nudge_audit (type, actor_id, version, reason, created_at) VALUES (?, ?, ?, ?, ?)",
        vec![
            kind.into(),
            actor.into(),
            version.into(),
            reason.map_or(SqlStorageValue::Null, SqlStorageValue::from),
            now.into(),
        ],
    )?;
    exec(
        sql,
        "DELETE FROM a2a_nudge_audit WHERE seq <= (SELECT max(seq) FROM a2a_nudge_audit) - ?",
        vec![AUDIT_KEPT.into()],
    )
}

/// The nudge's audit, newest first, for the agent's organization's admins: IDs, versions and reason codes only.
pub(super) fn audit_json(sql: &SqlStorage) -> R<Value> {
    if !has_table(sql, "a2a_nudge_audit")? {
        return Ok(json!([]));
    }
    Ok(json!(rows(
        sql,
        "SELECT type, actor_id, version, reason, created_at FROM a2a_nudge_audit ORDER BY seq DESC LIMIT 50",
        vec![],
    )?))
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
        .any(|k| !matches!(k.as_str(), "url" | "token" | "rotate_secret" | "delivery"))
    {
        return Err(ApiError::invalid_argument());
    }
    let rotate_secret = match body.get("rotate_secret") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(rotate)) => *rotate,
        Some(_) => return Err(ApiError::invalid_argument()),
    };
    // Left out, it's `offers`, as every endpoint was before M7 step 13.
    let delivery = match body.get("delivery") {
        None | Some(Value::Null) => Delivery::Offers,
        Some(Value::String(name)) => {
            Delivery::from_name(name).ok_or_else(ApiError::invalid_argument)?
        }
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
    let current_delivery = row.as_ref().map_or(Delivery::Offers, delivery_of);
    let outcome = decide_set_for(
        current_url,
        current_delivery,
        highest,
        &url,
        delivery,
        change,
        rotate_secret,
    );
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
    exec(
        sql,
        "UPDATE a2a_endpoint SET delivery = ?",
        vec![delivery.name().into()],
    )?;
    // A new signing secret is a new proof to make, and a new opt-in to give: neither carries over (M7 step 13).
    if outcome.new_secret {
        clear_nudge(sql)?;
    }
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
        clear_nudge(sql)?;
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
    // A nudge endpoint sends only once it has proved control and the owner switched it on for this version (M7 step 13).
    let delivery = delivery_of(&row);
    if delivery == Delivery::Nudge {
        if let Err(hold) = decide_nudge(nudge_state(&row)) {
            return Ok(skip(hold.code()));
        }
    }
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
    let mut out = json!({
        "send": true, "agent_id": conn["id"], "org_id": conn["org_id"], "generation": conn["generation"], "url": url, "version": version,
        "signing_secret": row["signing_secret"], "token": token,
        "setter": { "person": set_by, "org": set_by_org, "since": set_by_since },
    });
    if delivery == Delivery::Nudge {
        // Who switched it on, so the route can check they're still in the agent's organization, as for the setter.
        out["delivery"] = json!(delivery.name());
        out["nudge_by"] = json!({ "person": row["nudge_by"], "org": row["nudge_by_org"], "since": row["nudge_by_since"] });
    }
    Ok(out)
}

/// Clears the proof of control and the owner's opt-in, and any challenge out. Called for every new signing secret, on
/// delete and on disconnect.
fn clear_nudge(sql: &SqlStorage) -> R<()> {
    exec(
        sql,
        "UPDATE a2a_endpoint SET verified_at = NULL, challenge = NULL, verify_attempts = 0, nudge_version = NULL, nudge_by = NULL,
           nudge_by_org = NULL, nudge_by_since = NULL, nudge_set_at = NULL",
        vec![],
    )
}

/// Switches the nudge off if it's still on for `version`, because whoever switched it on has left the agent's
/// organization. The endpoint stays, unverified for nothing: its owner can switch it on again.
pub(super) fn owner_departed(sql: &SqlStorage, version: i64, now: i64) -> R<()> {
    let Some(row) = current(sql)? else {
        return Ok(());
    };
    if int(&row["version"]) != version || row["nudge_version"].as_i64() != Some(version) {
        return Ok(());
    }
    let by = text(&row["nudge_by"]).unwrap_or_default();
    exec(
        sql,
        "UPDATE a2a_endpoint SET nudge_version = NULL, nudge_by = NULL, nudge_by_org = NULL, nudge_by_since = NULL, nudge_set_at = ?",
        vec![now.into()],
    )?;
    audit(sql, "nudge_off", &by, version, Some("owner_departed"), now)
}

/// The first half of `POST .../a2a-endpoint/verify`: whether to send a challenge, and if so the one to send, made and
/// counted here. A verified endpoint answers its status and sends nothing.
pub(super) fn verify_begin(
    sql: &SqlStorage,
    key: Option<&[u8]>,
    actor: &str,
    now: i64,
) -> R<Value> {
    connection(sql)?
        .filter(|c| c["status"].as_str() == Some(ACTIVE))
        .ok_or_else(ApiError::agent_disconnected)?;
    let row = current(sql)?;
    match decide_verify(row.as_ref().map(registration)).map_err(refused)? {
        VerifyStart::AlreadyVerified => {
            let mut out = status_json(sql, key)?;
            out["verified"] = json!(true);
            return Ok(json!({ "send": false, "answer": out }));
        }
        VerifyStart::Challenge => {}
    }
    let row = row.ok_or_else(|| refused(NudgeRefusal::NoEndpoint))?;
    let url = text(&row["url"]).unwrap_or_default();
    if check_endpoint_url(&url).is_err() {
        exec(sql, "UPDATE a2a_endpoint SET enabled = 0", vec![])?;
        return Err(refused(NudgeRefusal::SwitchedOff));
    }
    ensure_schema(sql)?;
    let challenge = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    exec(
        sql,
        "UPDATE a2a_endpoint SET challenge = ?, verify_attempts = verify_attempts + 1",
        vec![challenge.as_str().into()],
    )?;
    let version = int(&row["version"]);
    audit(sql, "challenge_sent", actor, version, None, now)?;
    let agent = connection(sql)?
        .and_then(|c| text(&c["id"]))
        .unwrap_or_default();
    Ok(json!({
        "send": true, "url": url, "version": version, "challenge": challenge, "agent_id": agent,
        "signing_secret": row["signing_secret"],
    }))
}

/// The second half: records how the challenge was answered, if the registration and its challenge are still the ones it
/// was sent for. `proof` is what the endpoint answered, if it answered usably.
pub(super) fn verify_end(
    sql: &SqlStorage,
    key: Option<&[u8]>,
    actor: &str,
    sent: &Value,
    proof: Option<&str>,
    now: i64,
) -> R<Value> {
    let version = sent["version"].as_i64().unwrap_or(-1);
    let challenge = sent["challenge"].as_str().unwrap_or_default();
    let row = current(sql)?;
    let proof_ok = row.as_ref().is_some_and(|row| {
        let secret = row["signing_secret"].as_str().unwrap_or_default();
        let agent = sent["agent_id"].as_str().unwrap_or_default();
        valid_challenge(challenge)
            && proof
                .is_some_and(|p| proof_matches(secret, agent, version.max(0) as u64, challenge, p))
    });
    let result = decide_verify_result(
        version.max(0) as u64,
        challenge,
        row.as_ref().map(|r| int(&r["version"]).max(0) as u64),
        row.as_ref().and_then(|r| r["challenge"].as_str()),
        proof_ok,
    );
    let reason = match (result, proof) {
        (VerifyResult::Verified, _) => None,
        (VerifyResult::Stale, _) => Some("endpoint_changed"),
        (VerifyResult::Failed, None) => Some("no_answer"),
        (VerifyResult::Failed, Some(_)) => Some("wrong_proof"),
    };
    match result {
        VerifyResult::Verified => exec(
            sql,
            "UPDATE a2a_endpoint SET verified_at = ?, challenge = NULL",
            vec![now.into()],
        )?,
        VerifyResult::Failed => exec(sql, "UPDATE a2a_endpoint SET challenge = NULL", vec![])?,
        VerifyResult::Stale => {}
    }
    let kind = if result == VerifyResult::Verified {
        "verified"
    } else {
        "verify_failed"
    };
    audit(sql, kind, actor, version, reason, now)?;
    let mut out = status_json(sql, key)?;
    if out.is_null() {
        out = json!({});
    }
    out["verified"] = json!(result == VerifyResult::Verified);
    if let Some(reason) = reason {
        out["reason"] = json!(reason);
    }
    Ok(out)
}

/// `PUT /v1/agents/{agent}/a2a-endpoint/nudge` with `{ "on": bool, "version"?: n }`: the owner's opt-in, by a person who
/// administers the agent's organization, which the route has checked. On names the verified version the owner was shown.
pub(super) fn switch_nudge(
    sql: &SqlStorage,
    key: Option<&[u8]>,
    by: &Setter<'_>,
    body: &Value,
    now: i64,
) -> R<Value> {
    let object = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if object
        .keys()
        .any(|k| !matches!(k.as_str(), "on" | "version"))
    {
        return Err(ApiError::invalid_argument());
    }
    let on = body["on"]
        .as_bool()
        .ok_or_else(ApiError::invalid_argument)?;
    let version = match body.get("version") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_u64().ok_or_else(ApiError::invalid_argument)?),
    };
    let row = current(sql)?;
    decide_opt_in(row.as_ref().map(registration), on, version).map_err(refused)?;
    if let Some(row) = row {
        ensure_schema(sql)?;
        let current_version = int(&row["version"]);
        if on {
            exec(
                sql,
                "UPDATE a2a_endpoint SET nudge_version = ?, nudge_by = ?, nudge_by_org = ?, nudge_by_since = ?, nudge_set_at = ?",
                vec![current_version.into(), by.person.into(), by.org.into(), by.since.into(), now.into()],
            )?;
        } else {
            exec(
                sql,
                "UPDATE a2a_endpoint SET nudge_version = NULL, nudge_by = NULL, nudge_by_org = NULL, nudge_by_since = NULL, nudge_set_at = ?",
                vec![now.into()],
            )?;
        }
        audit(
            sql,
            if on { "nudge_on" } else { "nudge_off" },
            by.person,
            current_version,
            None,
            now,
        )?;
    }
    status_json(sql, key)
}

/// `/internal/a2a-endpoint-pin`: the endpoint's URL and version, and whether it's usable now, with no secret or token, so a
/// room can check a held response's endpoint is still the one in force before submitting it (decision 174). It also names
/// who set it, so the route can check they're still in the agent's organization, as a claim does. The route strips that.
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
    Ok(json!({
        "active": active, "url": url, "version": int(&row["version"]).max(0),
        "setter": { "person": row["set_by"], "org": row["set_by_org"], "since": row["set_by_since"] },
    }))
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
