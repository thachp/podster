//! A room's files. The room owns each file's record: who may upload, how much space is reserved, and whether what arrived is
//! accepted. The bytes go past it, through `crate::objects`, because a large file would hold up the whole room.
//!
//! Nothing here makes a file available. It moves to `scanning` and stays there until the scanner exists, and there's no
//! download route. A file's name is agent content, so it's never in an event, an audit entry or a log.
use super::*;
use crate::objects::{refusal, upload_not_found};
use podster_core::files::{
    check_upload, expire_scan, fits_room_quota, is_sha256, record_scan, scan_database_fits,
    FileRefusal, ObjectState, ScanOutcome, UploadRequest, SCAN_DEADLINE_MS,
};
use podster_policy::files::authorize_input_upload;

/// How long an upload may be started after it's created. Its reservation ends then too, whatever is under way. An attempt already
/// running can still finish, but only if the file still fits the room when it does.
const UPLOAD_GRANT_MS: i64 = 60 * 60 * 1000;
/// What the room stores of a scanner's words. A signature name comes from what's in the file, so it's never logged or put in an event.
const MAX_SCAN_REASON_BYTES: usize = 200;
/// Scans failed in one alarm. More go in the next, soon after.
const EXPIRED_SCANS_PER_ALARM: i64 = 500;
/// The soonest an overdue scan wakes the room again, so one that can't be cleared can't spin the alarm.
const EXPIRY_REARM_MS: i64 = 1_000;

fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

/// Every file kept, and every upload whose reservation hasn't ended, leaving out `except`. One that expired reserves nothing, even
/// before it's cleared away.
fn room_used(sql: &SqlStorage, now: i64, except: &str) -> R<u64> {
    let found = rows(
        sql,
        "SELECT COALESCE(SUM(size), 0) AS used FROM stored_object WHERE (state <> 'uploading' OR upload_expires_at > ?) AND id <> ?",
        vec![now.into(), except.into()],
    )?;
    Ok(found.first().map_or(0, |row| int(&row["used"])).max(0) as u64)
}

fn room_id(sql: &SqlStorage) -> R<String> {
    rows(sql, "SELECT id FROM workspace", vec![])?
        .first()
        .and_then(|row| text(&row["id"]))
        .ok_or_else(ApiError::workspace_not_found)
}

/// Reserves the space and records the upload, in one transaction, so two uploads can't both take the last of a room's quota.
/// The token is returned once, and `store_answer` keeps it out of what a retry gets. It works for any number of attempts until the
/// file arrives, the upload expires or the uploader goes.
pub(super) fn handle_create(
    sql: &SqlStorage,
    caller: &Caller,
    identity_json: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_input_upload(caller))?;
    let name = required(body, "name")?;
    let size = body["size"]
        .as_u64()
        .ok_or_else(ApiError::invalid_argument)?;
    let sha256 = required(body, "sha256")?;
    if !is_sha256(&sha256) {
        return Err(ApiError::invalid_argument());
    }
    let accepted = check_upload(UploadRequest {
        name: &name,
        size,
        room_used: room_used(sql, now, "")?,
        room_archived: room_archived(sql)?,
    })
    .map_err(refusal)?;
    let id = format!("obj_{}", uuid::Uuid::new_v4().simple());
    let token = format!(
        "upl_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let expires_at = now + UPLOAD_GRANT_MS;
    exec(
        sql,
        "INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, uploader_json, created_at, upload_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        vec![
            id.as_str().into(), accepted.name.as_str().into(), (accepted.size as i64).into(), sha256.as_str().into(),
            ObjectState::Uploading.name().into(), token_hash(&token).as_str().into(), caller.id.as_str().into(),
            identity_json.into(), now.into(), expires_at.into(),
        ],
    )?;
    audit_file(
        sql,
        &caller.id,
        kind_name(caller),
        "object.upload_created",
        &id,
        None,
        Some(json!({ "size": accepted.size }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "object.upload_created",
        &caller.id,
        None,
        &Transition::NONE,
        Vec::<String>::new(),
        now,
    )?;
    let room = room_id(sql)?;
    Ok(json!({
        "id": id, "name": accepted.name.as_str(), "size": accepted.size, "state": ObjectState::Uploading.name(),
        "expires_at": expires_at, "upload_path": format!("/v1/uploads/{room}/{id}"), "token": token,
    }))
}

/// Drops what someone may no longer finish after their access or role changed, as if they'd gone: narrowing them shouldn't leave
/// space held that nobody can release, and widening them again shouldn't bring an old token back.
pub(super) fn drop_uploads_no_longer_allowed(
    sql: &SqlStorage,
    actor: &str,
    actor_kind: &str,
    principal: &str,
    now: i64,
) -> R<()> {
    let found = rows(
        sql,
        "SELECT * FROM stored_object WHERE uploaded_by = ? AND state = 'uploading'",
        vec![principal.into()],
    )?;
    if found.iter().any(|row| uploader(sql, row).is_err()) {
        drop_uploads_of(sql, actor, actor_kind, principal, now)?;
    }
    Ok(())
}

/// Drops what someone was still uploading when they went, in the transaction that ends their place here, so their token dies with
/// it, coming back doesn't revive it, and the space is free at once. Bytes on their way get refused when they finish.
pub(super) fn drop_uploads_of(
    sql: &SqlStorage,
    actor: &str,
    actor_kind: &str,
    principal: &str,
    now: i64,
) -> R<()> {
    let found = rows(
        sql,
        "SELECT id FROM stored_object WHERE uploaded_by = ? AND state = 'uploading'",
        vec![principal.into()],
    )?;
    for row in &found {
        let id = text(&row["id"]).unwrap_or_default();
        audit_file(
            sql,
            actor,
            actor_kind,
            "object.upload_dropped",
            &id,
            None,
            None,
            now,
        )?;
    }
    exec(
        sql,
        "DELETE FROM stored_object WHERE uploaded_by = ? AND state = 'uploading'",
        vec![principal.into()],
    )
}

/// The uploader as they were when they asked, for what only the room can check again: whether they're still here and may
/// still upload. A token is no more authority than the person holding it.
fn uploader(sql: &SqlStorage, row: &Value) -> R<(Identity, Participant)> {
    let identity: Identity = serde_json::from_str(row["uploader_json"].as_str().unwrap_or(""))
        .map_err(|_| upload_not_found())?;
    let who = resolve_caller(sql, &identity)?;
    ApiError::from_verdict(authorize_input_upload(&who.caller))?;
    Ok((identity, who))
}

fn upload_row(sql: &SqlStorage, id: &str) -> R<Value> {
    rows(
        sql,
        "SELECT * FROM stored_object WHERE id = ?",
        vec![id.into()],
    )?
    .into_iter()
    .next()
    .ok_or_else(upload_not_found)
}

fn begin(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let id = body["id"].as_str().ok_or_else(upload_not_found)?;
    let token = body["token"].as_str().ok_or_else(upload_not_found)?;
    let row = upload_row(sql, id)?;
    if row["token_hash"].as_str() != Some(token_hash(token).as_str()) {
        return Err(upload_not_found());
    }
    if row["state"].as_str() != Some(ObjectState::Uploading.name()) {
        return Err(refusal(FileRefusal::InvalidTransition));
    }
    if int(&row["upload_expires_at"]) <= now {
        return Err(upload_not_found());
    }
    if room_archived(sql)? {
        return Err(refusal(FileRefusal::RoomArchived));
    }
    let (identity, who) = uploader(sql, &row)?;
    // The room can't read a person's organizations, and an agent's connection is its Principal's, so the Worker asks those.
    // Each attempt has its own key, and only the latest can complete, so two at once can't leave a file the room didn't check.
    let attempt = uuid::Uuid::new_v4().simple().to_string();
    let room = room_id(sql)?;
    let key = format!("rooms/{room}/objects/{id}/{attempt}");
    exec(
        sql,
        "UPDATE stored_object SET attempt_id = ?, object_key = ? WHERE id = ?",
        vec![attempt.as_str().into(), key.as_str().into(), id.into()],
    )?;
    Ok(json!({
        "key": key, "attempt": attempt, "size": row["size"], "sha256": row["sha256"],
        "agent": who.caller.kind == PrincipalKind::Agent, "uploader": identity.id, "gen": identity.gen,
        "org": who.org, "asked_at": row["created_at"],
    }))
}

fn complete(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let id = body["id"].as_str().ok_or_else(upload_not_found)?;
    let row = upload_row(sql, id)?;
    if row["state"].as_str() != Some(ObjectState::Uploading.name()) {
        return Err(refusal(FileRefusal::InvalidTransition));
    }
    // A newer attempt replaced this one, so these bytes aren't the upload any more.
    if body["attempt"].as_str().is_none() || body["attempt"] != row["attempt_id"] {
        return Err(refusal(FileRefusal::InvalidTransition));
    }
    if body["size"].as_i64() != Some(int(&row["size"])) || body["sha256"] != row["sha256"] {
        return Err(refusal(FileRefusal::Mismatch));
    }
    if room_archived(sql)? {
        return Err(refusal(FileRefusal::RoomArchived));
    }
    let (_, who) = uploader(sql, &row)?;
    // A reservation can lapse while the bytes arrive, and the room can fill up meanwhile. This counts the room as it is now, so a
    // finished upload can never take it past its quota, however long it took.
    if !fits_room_quota(room_used(sql, now, id)?, int(&row["size"]).max(0) as u64) {
        return Err(refusal(FileRefusal::QuotaExceeded));
    }
    let media_type = body["media_type"]
        .as_str()
        .ok_or_else(ApiError::invalid_argument)?;
    let state = ObjectState::Scanning.name();
    exec(
        sql,
        "UPDATE stored_object SET state = ?, media_type = ?, stored_at = ?, scanning_since = ?, uploader_json = NULL, token_hash = '' WHERE id = ?",
        vec![state.into(), media_type.into(), now.into(), now.into(), id.into()],
    )?;
    audit_file(
        sql,
        &who.caller.id,
        kind_name(&who.caller),
        "object.stored",
        id,
        None,
        Some(json!({ "size": row["size"], "media_type": media_type }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "object.stored",
        &who.caller.id,
        None,
        &Transition::NONE,
        Vec::<String>::new(),
        now,
    )?;
    Ok(
        json!({ "id": id, "state": state, "size": row["size"], "sha256": row["sha256"], "media_type": media_type }),
    )
}

/// The scan database, as decision 84 needs it stored, or nothing if the scanner didn't give all of it, or gave signatures
/// past their week.
fn scan_database(body: &Value, now: i64) -> Option<String> {
    let database = &body["database"];
    let engine = database["engine"].as_str()?;
    let version = database["version"].as_str()?;
    let built_at = database["built_at"].as_str()?;
    let parsed = js_sys::Date::parse(built_at);
    let built_at_ms = parsed.is_finite().then_some(parsed as i64);
    scan_database_fits(engine, version, built_at, built_at_ms, now)
        .then(|| json!({ "engine": engine, "version": version, "built_at": built_at }).to_string())
}

fn cut_reason(reason: &str) -> &str {
    let mut end = reason.len().min(MAX_SCAN_REASON_BYTES);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    reason.get(..end).unwrap_or_default()
}

/// Records a scanner's report on a file. It runs every time, because a report can only tighten: a later finding must still block a
/// file. It works in an archived room, since a scan already running still records its result.
fn record_verdict(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    if body["v"].as_i64() != Some(1) {
        return Err(ApiError::invalid_argument());
    }
    let id = body["object_id"].as_str().ok_or_else(upload_not_found)?;
    let row = upload_row(sql, id)?;
    let state = row["state"]
        .as_str()
        .and_then(ObjectState::from_name)
        .ok_or_else(|| ApiError::internal("unknown object state"))?;
    let outcome = ScanOutcome::from_report(body["report"].as_str().unwrap_or_default());
    // A clean report about other bytes says nothing about this file, so the hour limit ends it. A blocking one still blocks: the
    // scanner reports a stored size that differs from the upload's this way, and a block can only tighten.
    let mismatch = body["sha256"] != row["sha256"]
        || body["bytes"].as_i64() != Some(int(&row["size"]))
        || body["key"] != row["object_key"];
    if mismatch && outcome == ScanOutcome::NoKnownMalware {
        return Err(ApiError::api(409, "scan_mismatch"));
    }
    let database = scan_database(body, now);
    // Nothing is made available without knowing which signatures said so. A finding blocks regardless.
    if outcome == ScanOutcome::NoKnownMalware && database.is_none() {
        return Err(ApiError::invalid_argument());
    }
    let next = record_scan(state, outcome, int(&row["scanning_since"]), now).map_err(refusal)?;
    // A repeat of what's settled changes nothing, and keeps the report that settled it.
    if next == state && state != ObjectState::Scanning {
        return Ok(json!({ "state": state.name() }));
    }
    let reason = cut_reason(body["reason"].as_str().unwrap_or_default());
    exec(
        sql,
        "UPDATE stored_object SET state = ?, scan_reason = ?, scan_sha256 = ?, scan_database_json = ?, scanned_at = ? WHERE id = ?",
        vec![
            next.name().into(), reason.into(), row["sha256"].as_str().unwrap_or_default().into(),
            database.map_or(V::Null, |d| d.as_str().into()), now.into(), id.into(),
        ],
    )?;
    let new = json!({ "state": next.name() }).to_string();
    audit_file(
        sql,
        "scanner",
        "system",
        "object.scan_recorded",
        id,
        None,
        Some(new),
        now,
    )?;
    record_event(
        sql,
        "object.scan_recorded",
        "scanner",
        None,
        &Transition::NONE,
        Vec::<String>::new(),
        now,
    )?;
    Ok(json!({ "state": next.name() }))
}

/// Ends scans with no verdict after the hour. No verdict sends nothing, so this is what makes a stuck scan fail closed.
fn expire_overdue_scans(sql: &SqlStorage, now: i64) -> R<()> {
    let overdue = rows(
        sql,
        "SELECT id, scanning_since FROM stored_object INDEXED BY stored_object_scanning WHERE state = 'scanning' AND scanning_since <= ? ORDER BY scanning_since LIMIT ?",
        vec![(now - SCAN_DEADLINE_MS).into(), EXPIRED_SCANS_PER_ALARM.into()],
    )?;
    for row in &overdue {
        let id = text(&row["id"]).unwrap_or_default();
        let next = expire_scan(ObjectState::Scanning, int(&row["scanning_since"]), now);
        exec(
            sql,
            "UPDATE stored_object SET state = ? WHERE id = ?",
            vec![next.name().into(), id.as_str().into()],
        )?;
        let new = json!({ "state": next.name() }).to_string();
        audit_file(
            sql,
            "scanner",
            "system",
            "object.scan_expired",
            &id,
            None,
            Some(new),
            now,
        )?;
        record_event(
            sql,
            "object.scan_expired",
            "scanner",
            None,
            &Transition::NONE,
            Vec::<String>::new(),
            now,
        )?;
    }
    Ok(())
}

/// When the room next has a scan to end, if any.
pub(super) fn next_scan_expiry(sql: &SqlStorage, now: i64) -> R<Option<i64>> {
    let found = rows(
        sql,
        "SELECT MIN(scanning_since) AS first FROM stored_object INDEXED BY stored_object_scanning WHERE state = 'scanning'",
        vec![],
    )?;
    Ok(found
        .first()
        .filter(|row| row["first"].is_number())
        .map(|row| (int(&row["first"]) + SCAN_DEADLINE_MS).max(now + EXPIRY_REARM_MS)))
}

impl Workspace {
    pub(super) fn expire_scans(&self) -> R<()> {
        self.migrate_if_needed()?;
        let sql = self.state.storage().sql();
        transaction_sync(&self.state, move || expire_overdue_scans(&sql, now_ms()))
    }

    pub(super) fn scan_verdict(&self, body: Value) -> R<Value> {
        let sql = self.state.storage().sql();
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(record_verdict(&sql, &body, now_ms())?);
            Ok(())
        })?;
        let value = out.borrow_mut().take();
        value.ok_or_else(|| ApiError::internal("verdict produced no result"))
    }

    /// The room's two steps around the bytes, each in a transaction of its own.
    pub(super) fn upload_step(&self, path: &str, body: Value) -> R<Value> {
        let sql = self.state.storage().sql();
        let completing = path == crate::INTERNAL_UPLOAD_COMPLETE;
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        transaction_sync(&self.state, move || {
            let now = now_ms();
            let answer = if completing {
                complete(&sql, &body, now)?
            } else {
                begin(&sql, &body, now)?
            };
            *slot.borrow_mut() = Some(answer);
            Ok(())
        })?;
        let value = out.borrow_mut().take();
        value.ok_or_else(|| ApiError::internal("upload step produced no result"))
    }
}
