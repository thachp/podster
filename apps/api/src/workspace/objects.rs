//! A room's files. The room owns each file's record: who may upload, how much space is reserved, and whether what arrived is
//! accepted. The bytes go past it, through `crate::objects`, because a large file would hold up the whole room.
//!
//! Nothing here makes a file available. It moves to `scanning` and stays there until the scanner exists, and there's no
//! download route. A file's name is agent content, so it's never in an event, an audit entry or a log.
use super::*;
use crate::objects::{refusal, upload_not_found};
use podster_core::files::{check_upload, is_sha256, FileRefusal, ObjectState, UploadRequest};
use podster_policy::files::authorize_input_upload;

/// How long an upload may be started after it's created. An attempt already under way finishes. Space comes back when it ends.
const UPLOAD_GRANT_MS: i64 = 60 * 60 * 1000;

fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

/// Every file kept, and every upload still able to arrive. One that expired reserves nothing, even before it's cleared away.
fn room_used(sql: &SqlStorage, now: i64) -> R<u64> {
    let found = rows(
        sql,
        "SELECT COALESCE(SUM(size), 0) AS used FROM stored_object WHERE state <> 'uploading' OR upload_expires_at > ?",
        vec![now.into()],
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
/// The token is returned once, and `store_answer` keeps it out of what a retry gets.
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
        room_used: room_used(sql, now)?,
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
    audit(
        sql,
        caller,
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
    let media_type = body["media_type"]
        .as_str()
        .ok_or_else(ApiError::invalid_argument)?;
    let state = ObjectState::Scanning.name();
    exec(
        sql,
        "UPDATE stored_object SET state = ?, media_type = ?, stored_at = ?, scanning_since = ?, uploader_json = NULL, token_hash = '' WHERE id = ?",
        vec![state.into(), media_type.into(), now.into(), now.into(), id.into()],
    )?;
    audit(
        sql,
        &who.caller,
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

impl Workspace {
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
