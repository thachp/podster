//! A room's files. The room owns each file's record: who may upload, how much space is reserved, and whether what arrived is
//! accepted. The bytes go past it, through `crate::objects`, because a large file would hold up the whole room.
//!
//! A stored file waits in `scanning`. Only the scanner's clean verdict, with the secret, makes it `ready`, which is the one state
//! `downloads` serves. A file's name is agent content, so it's never in an event, an audit entry or a log.
use super::*;
use crate::objects::{refusal, upload_not_found};
use podster_core::files::{
    check_upload, expire_scan, fits_participant_quota, fits_room_quota, is_sha256, record_scan,
    scan_database_fits, scan_send_backoff_ms, scans_to_queue, FileRefusal, ObjectState,
    ScanOutcome, UploadRequest, ROOM_SCANS_QUEUED, SCAN_DEADLINE_MS, SCAN_WAIT_LIMIT_MS,
};

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
/// before it's cleared away, and a removed file holds nothing. This is `podster_core::removal::holds_space` in SQL.
pub(super) fn room_used(sql: &SqlStorage, now: i64, except: &str) -> R<u64> {
    let found = rows(
        sql,
        "SELECT COALESCE(SUM(size), 0) AS used FROM stored_object WHERE ((state <> 'uploading' AND state <> 'removed') OR (state = 'uploading' AND upload_expires_at > ?)) AND id <> ?",
        vec![now.into(), except.into()],
    )?;
    Ok(found.first().map_or(0, |row| int(&row["used"])).max(0) as u64)
}

/// What one uploader holds of the room's files, counted as `room_used` counts the room, leaving out `except`.
fn held_by(sql: &SqlStorage, uploader: &str, now: i64, except: &str) -> R<u64> {
    let found = rows(
        sql,
        "SELECT COALESCE(SUM(size), 0) AS used FROM stored_object WHERE uploaded_by = ? AND ((state <> 'uploading' AND state <> 'removed') OR (state = 'uploading' AND upload_expires_at > ?)) AND id <> ?",
        vec![uploader.into(), now.into(), except.into()],
    )?;
    Ok(found.first().map_or(0, |row| int(&row["used"])).max(0) as u64)
}

/// Decision 161: a public participant may hold at most 1 GB of the room's files. Asked beside the room's 5 GB, when an upload
/// starts and again when it finishes, as that is. Everyone else is limited only by the room's.
fn check_participant_quota(
    sql: &SqlStorage,
    uploader: &str,
    size: u64,
    now: i64,
    except: &str,
) -> R<()> {
    if super::public_claims::is_public_participant(sql, uploader)?
        && !fits_participant_quota(held_by(sql, uploader, now, except)?, size)
    {
        return Err(refusal(FileRefusal::ParticipantQuotaExceeded));
    }
    Ok(())
}

pub(super) fn room_id(sql: &SqlStorage) -> R<String> {
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
    let for_task = super::submission_files::upload_target(body)?;
    super::submission_files::may_upload(sql, caller, for_task.as_deref())?;
    if let Some(task_id) = &for_task {
        super::submission_files::require_room_for_another(sql, &caller.id, task_id, now)?;
    }
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
    check_participant_quota(sql, &caller.id, accepted.size, now, "")?;
    let id = format!("obj_{}", uuid::Uuid::new_v4().simple());
    let token = format!(
        "upl_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let expires_at = now + UPLOAD_GRANT_MS;
    exec(
        sql,
        "INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, uploader_json, created_at, upload_expires_at, for_task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        vec![
            id.as_str().into(), accepted.name.as_str().into(), (accepted.size as i64).into(), sha256.as_str().into(),
            ObjectState::Uploading.name().into(), token_hash(&token).as_str().into(), caller.id.as_str().into(),
            identity_json.into(), now.into(), expires_at.into(), opt(&for_task),
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
    // Each upload is judged alone: losing the right to add input assets doesn't end an upload for their own task, or the reverse.
    for row in &found {
        if uploader(sql, row).is_err() {
            drop_upload(
                sql,
                actor,
                actor_kind,
                row["id"].as_str().unwrap_or_default(),
                now,
            )?;
        }
    }
    Ok(())
}

/// Drops every unfinished upload for a task, when it stops being accepted, so its space comes back at once and its token dies.
pub(super) fn drop_uploads_for_task(
    sql: &SqlStorage,
    actor: &str,
    actor_kind: &str,
    task_id: &str,
    now: i64,
) -> R<()> {
    let found = rows(
        sql,
        "SELECT id FROM stored_object WHERE for_task = ? AND state = 'uploading'",
        vec![task_id.into()],
    )?;
    for row in &found {
        drop_upload(
            sql,
            actor,
            actor_kind,
            row["id"].as_str().unwrap_or_default(),
            now,
        )?;
    }
    Ok(())
}

/// Drops one unfinished upload, recording who ended it. Only an upload still arriving goes, so a stored file is never touched.
fn drop_upload(sql: &SqlStorage, actor: &str, actor_kind: &str, id: &str, now: i64) -> R<()> {
    // A file's own audit entry, which doesn't move the room's policy version.
    audit_file(
        sql,
        actor,
        actor_kind,
        "object.upload_dropped",
        id,
        None,
        None,
        now,
    )?;
    exec(
        sql,
        "DELETE FROM stored_object WHERE id = ? AND state = 'uploading'",
        vec![id.into()],
    )?;
    // An attempt may still be writing, and its row is gone, so the sweep looks again once that attempt can't be.
    removal::row_dropped(sql, now)
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
    )?;
    // An attempt of theirs may still be writing, and its row is gone now, so the sweep looks again once that attempt has ended.
    if !found.is_empty() {
        removal::row_dropped(sql, now)?;
    }
    Ok(())
}

/// The uploader as they were when they asked, for what only the room can check again: whether they're still here and may
/// still upload. A token is no more authority than the person holding it.
fn uploader(sql: &SqlStorage, row: &Value) -> R<(Identity, Participant)> {
    let identity: Identity = serde_json::from_str(row["uploader_json"].as_str().unwrap_or(""))
        .map_err(|_| upload_not_found())?;
    let who = resolve_caller(sql, &identity)?;
    super::submission_files::may_upload(sql, &who.caller, row["for_task"].as_str())?;
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
        "UPDATE stored_object SET attempt_id = ?, object_key = ?, attempt_started_at = ? WHERE id = ?",
        vec![attempt.as_str().into(), key.as_str().into(), now.into(), id.into()],
    )?;
    // Every way bytes can be left with nothing referring to them starts with an attempt, so this is when to look again.
    removal::attempt_began(sql, now)?;
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
    // An attempt can only start before the grant ends, and runs at most `TOTAL_LIMIT_MS`, so nothing can finish later than both.
    // The Worker checks that limit only now and then, so this is what makes it exact, and keeps the cap's count exact with it.
    if now > int(&row["upload_expires_at"]).saturating_add(crate::objects::TOTAL_LIMIT_MS as i64) {
        return Err(upload_not_found());
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
    check_participant_quota(
        sql,
        &who.caller.id,
        int(&row["size"]).max(0) as u64,
        now,
        id,
    )?;
    let media_type = body["media_type"]
        .as_str()
        .ok_or_else(ApiError::invalid_argument)?;
    let state = ObjectState::Scanning.name();
    // It waits for the room's turn on the scan queue: `scanning_since` is set when the room puts it there, and its hour starts
    // then (M4 step 14).
    exec(
        sql,
        "UPDATE stored_object SET state = ?, media_type = ?, stored_at = ?, scanning_since = NULL, uploader_json = NULL, token_hash = '' WHERE id = ?",
        vec![state.into(), media_type.into(), now.into(), id.into()],
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
    // A verdict for a file still waiting its turn, such as an old job sent again, counts from now: it isn't late.
    let since = row["scanning_since"].as_i64().unwrap_or(now);
    let next = record_scan(state, outcome, since, now).map_err(refusal)?;
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

/// A room's files on the shared scan queue now, and those waiting for its turn.
fn scan_counts(sql: &SqlStorage) -> R<(usize, usize)> {
    let found = rows(
        sql,
        "SELECT COUNT(scanning_since) AS queued, COUNT(*) - COUNT(scanning_since) AS waiting FROM stored_object WHERE state = 'scanning'",
        vec![],
    )?;
    let count = |name: &str| found.first().map_or(0, |r| int(&r[name]).max(0) as usize);
    Ok((count("queued"), count("waiting")))
}

/// Whether the room has a file waiting that it could put on the queue now.
pub(super) fn scan_turn_due(sql: &SqlStorage) -> R<bool> {
    let (queued, waiting) = scan_counts(sql)?;
    Ok(scans_to_queue(queued, waiting) > 0)
}

/// One scan to send: no name or claimed type, as the queue's message carries.
pub(super) struct QueuedScan {
    pub id: String,
    pub key: String,
    pub size: u64,
    pub sha256: String,
    /// When its hour started. A scan sent again carries its first time, so the scanner's too-late skip matches the room's hour.
    pub queued_at: i64,
}

/// Takes the room's next turns on the scan queue, oldest arrival first, up to `ROOM_SCANS_QUEUED` there at once, and starts
/// each one's hour. The caller sends them after this commits, and gives back any it couldn't send.
pub(super) fn take_scan_turns(sql: &SqlStorage, now: i64) -> R<Vec<QueuedScan>> {
    let (queued, waiting) = scan_counts(sql)?;
    let take = scans_to_queue(queued, waiting).min(ROOM_SCANS_QUEUED);
    if take == 0 {
        return Ok(Vec::new());
    }
    let found = rows(
        sql,
        "SELECT id, object_key, size, sha256 FROM stored_object WHERE state = 'scanning' AND scanning_since IS NULL ORDER BY stored_at, id LIMIT ?",
        vec![(take as i64).into()],
    )?;
    let mut turns = Vec::new();
    for row in &found {
        let id = text(&row["id"]).unwrap_or_default();
        exec(
            sql,
            "UPDATE stored_object SET scanning_since = ? WHERE id = ? AND state = 'scanning' AND scanning_since IS NULL",
            vec![now.into(), id.as_str().into()],
        )?;
        turns.push(QueuedScan {
            id,
            key: text(&row["object_key"]).unwrap_or_default(),
            size: int(&row["size"]).max(0) as u64,
            sha256: text(&row["sha256"]).unwrap_or_default(),
            queued_at: now,
        });
    }
    Ok(turns)
}

/// How long a queued scan may go without a verdict before it's sent once more. Long, since a room can't tell a send that
/// never arrived from one waiting behind others, and a duplicate is scanned in full.
pub(super) const SCAN_RESEND_AFTER_MS: i64 = 30 * 60 * 1000;
/// The room's key-value storage marks a scan already sent once more, so as a rule it isn't sent a third time. A crash between
/// the send and the mark, or a mark that keeps failing, can send it again, once each backoff period.
const SCAN_RESENT_PREFIX: &str = "scan_resent:";

/// Queued scans with no verdict after `SCAN_RESEND_AFTER_MS`, oldest first, up to the room's share.
fn stale_scan_turns(sql: &SqlStorage, now: i64) -> R<Vec<QueuedScan>> {
    let found = rows(
        sql,
        "SELECT id, object_key, size, sha256, scanning_since FROM stored_object INDEXED BY stored_object_scanning WHERE state = 'scanning' AND scanning_since <= ? ORDER BY scanning_since, id LIMIT ?",
        vec![(now - SCAN_RESEND_AFTER_MS).into(), (ROOM_SCANS_QUEUED as i64).into()],
    )?;
    Ok(found
        .iter()
        .map(|row| QueuedScan {
            id: text(&row["id"]).unwrap_or_default(),
            key: text(&row["object_key"]).unwrap_or_default(),
            size: int(&row["size"]).max(0) as u64,
            sha256: text(&row["sha256"]).unwrap_or_default(),
            queued_at: int(&row["scanning_since"]),
        })
        .collect())
}

/// When the next queued scan reaches `SCAN_RESEND_AFTER_MS` with no verdict, for the alarm. Only scans not there yet count,
/// so one already past it, sent again or not, never brings the alarm back in a loop.
pub(super) fn next_scan_resend(sql: &SqlStorage, now: i64) -> R<Option<i64>> {
    Ok(rows(
        sql,
        "SELECT MIN(scanning_since) AS first FROM stored_object INDEXED BY stored_object_scanning WHERE state = 'scanning' AND scanning_since > ?",
        vec![(now - SCAN_RESEND_AFTER_MS).into()],
    )?
    .first()
    .filter(|row| row["first"].is_number())
    .map(|row| int(&row["first"]) + SCAN_RESEND_AFTER_MS))
}

/// A turn whose message couldn't be sent waits again, so the next alarm tries it.
pub(super) fn give_back_scan_turn(sql: &SqlStorage, id: &str, at: i64) -> R<()> {
    exec(
        sql,
        "UPDATE stored_object SET scanning_since = NULL WHERE id = ? AND state = 'scanning' AND scanning_since = ?",
        vec![id.into(), at.into()],
    )
}

/// Ends scans with no verdict after the hour. No verdict sends nothing, so this is what makes a stuck scan fail closed. A file
/// that waited a day for its room's turn fails closed the same way.
fn expire_overdue_scans(sql: &SqlStorage, now: i64) -> R<()> {
    let mut overdue = rows(
        sql,
        "SELECT id, scanning_since FROM stored_object INDEXED BY stored_object_scanning WHERE state = 'scanning' AND scanning_since <= ? ORDER BY scanning_since LIMIT ?",
        vec![(now - SCAN_DEADLINE_MS).into(), EXPIRED_SCANS_PER_ALARM.into()],
    )?;
    overdue.extend(rows(
        sql,
        "SELECT id, NULL AS scanning_since FROM stored_object WHERE state = 'scanning' AND scanning_since IS NULL AND stored_at <= ? ORDER BY stored_at LIMIT ?",
        vec![(now - SCAN_WAIT_LIMIT_MS).into(), EXPIRED_SCANS_PER_ALARM.into()],
    )?);
    for row in &overdue {
        let id = text(&row["id"]).unwrap_or_default();
        // A file that never got its turn has no hour of its own, and is late by the day it waited.
        let next = match row["scanning_since"].as_i64() {
            Some(since) => expire_scan(ObjectState::Scanning, since, now),
            None => ObjectState::Failed,
        };
        exec(
            sql,
            "UPDATE stored_object SET state = ?, scanned_at = ? WHERE id = ?",
            // When it was found to have run out of time is its verdict, so a scan noticed late still gets its full 7 days.
            vec![next.name().into(), now.into(), id.as_str().into()],
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

/// When the room next has a scan to end, if any: an hour after the first file went on the queue, or a day after the first
/// still waiting arrived.
pub(super) fn next_scan_expiry(sql: &SqlStorage, now: i64) -> R<Option<i64>> {
    let first = |query: &str| -> R<Option<i64>> {
        Ok(rows(sql, query, vec![])?
            .first()
            .filter(|row| row["first"].is_number())
            .map(|row| int(&row["first"])))
    };
    let queued = first("SELECT MIN(scanning_since) AS first FROM stored_object INDEXED BY stored_object_scanning WHERE state = 'scanning'")?
        .map(|at| at + SCAN_DEADLINE_MS);
    let waiting = first("SELECT MIN(stored_at) AS first FROM stored_object WHERE state = 'scanning' AND scanning_since IS NULL")?
        .map(|at| at + SCAN_WAIT_LIMIT_MS);
    Ok(match (queued, waiting) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
    .map(|at| at.max(now + EXPIRY_REARM_MS)))
}

impl Workspace {
    /// Leaves a room that hasn't migrated alone. Ending scans doesn't migrate one, though writing held refusals in the same alarm
    /// may. A request migrates it otherwise, and the alarm it arms then ends what's overdue.
    pub(super) fn expire_scans(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? || store::needs_migration(&sql)? {
            return Ok(());
        }
        transaction_sync(&self.state, move || expire_overdue_scans(&sql, now_ms()))
    }

    /// Puts the room's next files on the scan queue, as many as its share allows, after the turns commit. One that couldn't be
    /// sent waits again. Logs IDs only.
    pub(super) async fn queue_scan_turns(&self) {
        let sql = self.state.storage().sql();
        if !matches!(store::is_initialized(&sql), Ok(true))
            || !matches!(store::needs_migration(&sql), Ok(false))
        {
            return;
        }
        self.clear_settled_resend_markers(&sql).await;
        let now = now_ms();
        #[cfg(feature = "failpoints")]
        let now = crate::test_clock::scan_now(&sql)
            .ok()
            .flatten()
            .unwrap_or(now);
        // After a send failed, the queue gets a rest before the room asks again.
        if now < self.scan_send_retry_at.get() {
            return;
        }
        let out: Rc<RefCell<Vec<QueuedScan>>> = Rc::new(RefCell::new(Vec::new()));
        let slot = out.clone();
        let taken = {
            let sql = sql.clone();
            transaction_sync(&self.state, move || {
                *slot.borrow_mut() = take_scan_turns(&sql, now)?;
                Ok(())
            })
        };
        if let Err(error) = taken {
            // A pass that can't even take its turns rests like a failed send, or the alarm would come straight back.
            console_error!("couldn't take scan turns: {:?}", error.code());
            self.scan_send_failed(
                &room_id(&sql).unwrap_or_default(),
                now,
                "upload.scan_turns_not_taken",
            );
            return;
        }
        let turns = out.take();
        let room = room_id(&sql).unwrap_or_default();
        let mut turns = turns.into_iter();
        while let Some(turn) = turns.next() {
            if self.send_scan(&room, &turn).await {
                continue;
            }
            // The first failure ends the pass: this turn and the ones not yet sent wait again, and the queue gets a rest.
            for back in std::iter::once(turn).chain(turns.by_ref()) {
                let sql = sql.clone();
                let id = back.id.clone();
                if let Err(error) =
                    transaction_sync(&self.state, move || give_back_scan_turn(&sql, &id, now))
                {
                    console_error!("couldn't give back a scan turn: {:?}", error.code());
                }
            }
            self.scan_send_failed(&room, now, "upload.scan_not_queued");
            return;
        }
        // A turn held a while with no verdict may never have reached the queue, as when the room was evicted between taking
        // it and sending it. It's sent once more, and a second verdict for it changes nothing.
        let stale = stale_scan_turns(&sql, now).unwrap_or_default();
        for turn in stale {
            let marker = format!("{SCAN_RESENT_PREFIX}{}", turn.id);
            if self
                .state
                .storage()
                .get::<i64>(&marker)
                .await
                .ok()
                .flatten()
                .is_some()
            {
                continue;
            }
            if !self.send_scan(&room, &turn).await {
                self.scan_send_failed(&room, now, "upload.scan_not_queued");
                return;
            }
            if self.state.storage().put(&marker, now).await.is_err() {
                // Sent, but with nothing to say so, the re-send would look pending again: rest first, as after a failure.
                console_error!("scan.resend_mark_failed");
                self.scan_send_failed(&room, now, "upload.scan_not_queued");
                return;
            }
        }
        self.scan_send_failures.set(0);
        self.scan_send_retry_at.set(0);
    }

    /// Whether a queued scan is past `SCAN_RESEND_AFTER_MS` with no re-send yet, so the alarm comes back for it rather than
    /// waiting for another reason to run.
    pub(super) async fn scan_resend_pending(&self, sql: &SqlStorage, now: i64) -> bool {
        let Ok(stale) = stale_scan_turns(sql, now) else {
            return false;
        };
        for turn in stale {
            let marker = format!("{SCAN_RESENT_PREFIX}{}", turn.id);
            if self
                .state
                .storage()
                .get::<i64>(&marker)
                .await
                .ok()
                .flatten()
                .is_none()
            {
                return true;
            }
        }
        false
    }

    /// Deletes the re-send marker of every file that's settled, by a verdict or an expiry, so markers don't pile up.
    async fn clear_settled_resend_markers(&self, sql: &SqlStorage) {
        let Ok(found) = self
            .state
            .storage()
            .list_with_options(ListOptions::new().prefix(SCAN_RESENT_PREFIX))
            .await
        else {
            return;
        };
        for key in found.keys() {
            let Some(key) = key.ok().and_then(|k| k.as_string()) else {
                continue;
            };
            let id = key.trim_start_matches(SCAN_RESENT_PREFIX);
            // Only a file known to have settled loses its mark: a lookup that fails keeps it, so that doesn't cause a third send.
            let settled = matches!(
                rows(
                    sql,
                    "SELECT 1 FROM stored_object WHERE id = ? AND state = 'scanning'",
                    vec![id.into()],
                ),
                Ok(found) if found.is_empty()
            );
            if settled && self.state.storage().delete(&key).await.is_err() {
                console_error!("scan.resend_mark_clear_failed");
            }
        }
    }

    /// Sends one scan job. Test builds can make every send fail, to check what a failed send leaves.
    async fn send_scan(&self, room: &str, turn: &QueuedScan) -> bool {
        #[cfg(feature = "failpoints")]
        {
            let sql = self.state.storage().sql();
            let failing = rows(&sql, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_scan_send_fails'", vec![])
                .is_ok_and(|found| !found.is_empty());
            if failing {
                return false;
            }
        }
        crate::objects::queue_scan(
            &self.env,
            room,
            &turn.id,
            &turn.key,
            turn.size,
            &turn.sha256,
            turn.queued_at,
        )
        .await
    }

    /// Backs off after a failed send: 5 seconds, doubling to 5 minutes. A restart forgets it, as it forgets sweep failures.
    fn scan_send_failed(&self, room: &str, now: i64, code: &str) {
        let failures = self.scan_send_failures.get().saturating_add(1);
        self.scan_send_failures.set(failures);
        let wait = scan_send_backoff_ms(failures);
        self.scan_send_retry_at.set(now + wait);
        console_error!(
            "{}",
            json!({ "at": code, "room": room, "failures": failures })
        );
    }

    /// When the room may next send a scan, for the alarm.
    pub(super) fn scan_send_allowed_at(&self) -> i64 {
        self.scan_send_retry_at.get()
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
