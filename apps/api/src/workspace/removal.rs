//! Removing a file, and the room's sweep of what nobody needs: uploads that never finished, and bytes in storage that no file
//! refers to. The rules are `podster_core::removal`, and who may remove is `podster_policy::files`.
//!
//! Removing commits the record first and leaves deleting the bytes to the sweep, which the same transaction makes due at once.
//! That keeps every delete from storage in one place, where a failure is simply tried again.
//!
//! A file's name is agent content, and a key names the room and the file, so neither goes into a log, an audit entry or an event.
use super::*;
use podster_core::files::ObjectState;
use podster_core::removal::{
    delete_stored_bytes, is_abandoned, remove_file, room_prefix, KeyHolder, Removal,
    ABANDONED_UPLOAD_GRACE_MS, UNREFERENCED_BYTES_GRACE_MS,
};
use podster_policy::files::authorize_file_removal;
use podster_policy::Verdict;
use std::collections::HashMap;

/// How many keys one listing returns, and how many listings one alarm makes. A room past this continues on the next alarm.
const SWEEP_PAGE_KEYS: u32 = 1000;
const SWEEP_PAGES_PER_PASS: usize = 3;
/// How soon a sweep that failed is tried again.
const SWEEP_RETRY_MS: i64 = 60 * 1000;
/// At most this many abandoned rows go in one alarm, so a room with many can't hold the alarm up.
const ABANDONED_PER_PASS: i64 = 200;

/// Who removes. An operator or the system would be another kind, recorded the same way, so a ruling that adds either only adds a
/// caller of `remove`.
pub(super) struct Remover<'a> {
    pub id: &'a str,
    pub kind: &'a str,
}

fn state_of(row: &Value) -> R<ObjectState> {
    row["state"]
        .as_str()
        .and_then(ObjectState::from_name)
        .ok_or_else(|| ApiError::internal("unknown object state"))
}

fn answer(sql: &SqlStorage, id: &str) -> R<Value> {
    let row = downloads::file_row(sql, id)?;
    Ok(json!({
        "id": row["id"], "state": row["state"], "size": row["size"], "sha256": row["sha256"],
        "removed_at": row["removed_at"], "removed_by": row["removed_by"],
    }))
}

/// Ends a file in `removed`, keeping its record and hash, and makes the sweep due so its bytes go. Removing twice changes nothing.
/// The caller has already decided this remover may.
pub(super) fn remove(sql: &SqlStorage, remover: &Remover<'_>, id: &str, now: i64) -> R<Value> {
    let row = downloads::file_row(sql, id)?;
    let Removal::Removed { was } = remove_file(state_of(&row)?) else {
        return answer(sql, id);
    };
    // The token goes too, though no upload step accepts a removed file anyway.
    exec(
        sql,
        "UPDATE stored_object SET state = ?, removed_at = ?, removed_by = ?, removed_by_kind = ?, removed_from = ?, uploader_json = NULL, token_hash = '' WHERE id = ?",
        vec![
            ObjectState::Removed.name().into(),
            now.into(),
            remover.id.into(),
            remover.kind.into(),
            was.name().into(),
            id.into(),
        ],
    )?;
    audit_file(
        sql,
        remover.id,
        remover.kind,
        "object.removed",
        id,
        Some(json!({ "state": was.name() }).to_string()),
        Some(json!({ "state": ObjectState::Removed.name() }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "object.removed",
        remover.id,
        None,
        &Transition::NONE,
        Vec::<String>::new(),
        now,
    )?;
    sweep_after(sql, now)?;
    answer(sql, id)
}

/// `POST /v1/workspaces/{ws}/files/{file}/remove`: the room's owner or a human admin (decision 57). Someone who can't see the file
/// is answered as if it didn't exist.
pub(super) fn handle_remove(sql: &SqlStorage, caller: &Caller, id: &str, now: i64) -> R<Value> {
    downloads::file_row(sql, id)?;
    match authorize_file_removal(caller, downloads::view_of(caller)) {
        Verdict::Allow => {}
        Verdict::Hidden => return Err(downloads::file_not_found()),
        other => ApiError::from_verdict(other)?,
    }
    let kind = kind_name(caller);
    remove(
        sql,
        &Remover {
            id: &caller.id,
            kind,
        },
        id,
        now,
    )
}

/// Makes the storage sweep due by `at`, never later than it already is.
pub(super) fn sweep_after(sql: &SqlStorage, at: i64) -> R<()> {
    exec(
        sql,
        "UPDATE storage_sweep SET due_at = CASE WHEN due_at IS NULL OR due_at > ? THEN ? ELSE due_at END",
        vec![at.into(), at.into()],
    )
}

/// When the room next has something to clear: the storage sweep, or the first unfinished upload to be abandoned. A room still
/// waiting to migrate has nothing here yet: its next request migrates it, and the alarm mustn't fail on its older tables.
pub(super) fn next_due(sql: &SqlStorage) -> R<Option<i64>> {
    if store::needs_migration(sql)? {
        return Ok(None);
    }
    let sweep = rows(sql, "SELECT due_at FROM storage_sweep", vec![])?
        .first()
        .and_then(|r| r["due_at"].as_f64())
        .map(|d| d as i64);
    let abandoned = rows(
        sql,
        "SELECT MIN(upload_expires_at) AS first FROM stored_object WHERE state = 'uploading'",
        vec![],
    )?
    .first()
    .and_then(|r| r["first"].as_f64())
    .map(|first| (first as i64).saturating_add(ABANDONED_UPLOAD_GRACE_MS));
    Ok(match (sweep, abandoned) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    })
}

/// Deletes rows of uploads that never finished, well after their grant ended. Each is audited by ID. Bytes an attempt left go with
/// the storage sweep, made due here.
fn drop_abandoned(sql: &SqlStorage, now: i64) -> R<()> {
    let found = rows(
        sql,
        "SELECT id, upload_expires_at FROM stored_object WHERE state = 'uploading' AND upload_expires_at <= ? ORDER BY upload_expires_at LIMIT ?",
        vec![now.saturating_sub(ABANDONED_UPLOAD_GRACE_MS).into(), ABANDONED_PER_PASS.into()],
    )?;
    let mut dropped = false;
    for row in &found {
        if !is_abandoned(ObjectState::Uploading, int(&row["upload_expires_at"]), now) {
            continue;
        }
        let id = text(&row["id"]).unwrap_or_default();
        exec(
            sql,
            "DELETE FROM stored_object WHERE id = ? AND state = 'uploading'",
            vec![id.as_str().into()],
        )?;
        audit_file(
            sql,
            "podster",
            "system",
            "object.upload_abandoned",
            &id,
            None,
            None,
            now,
        )?;
        dropped = true;
    }
    if dropped {
        sweep_after(sql, now)?;
    }
    Ok(())
}

impl Workspace {
    /// The alarm's part: abandoned rows in a transaction, then storage. Neither failing holds up the rest of the alarm.
    pub(super) async fn sweep_files(&self) {
        let sql = self.state.storage().sql();
        // A room waiting to migrate is left to its next request, which migrates it, as the rest of the alarm does.
        match store::is_initialized(&sql)
            .and_then(|ready| Ok(ready && !store::needs_migration(&sql)?))
        {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                console_error!("couldn't check the room for a sweep: {:?}", error.code());
                return;
            }
        }
        let dropping = sql.clone();
        if let Err(error) = transaction_sync(&self.state, move || {
            drop_abandoned(&dropping, Date::now().as_millis() as i64)
        }) {
            console_error!("couldn't clear abandoned uploads: {:?}", error.code());
        }
        if let Err(error) = self.sweep_storage().await {
            console_error!("couldn't sweep storage: {:?}", error.code());
            let retry = Date::now().as_millis() as i64 + SWEEP_RETRY_MS;
            if let Err(error) = sweep_after(&sql, retry) {
                console_error!("couldn't schedule the sweep again: {:?}", error.code());
            }
        }
    }

    /// Lists the room's keys in storage and deletes what `delete_stored_bytes` says to.
    ///
    /// The listing comes before reading which keys files hold, and that order is what keeps a file's bytes safe: a key is recorded
    /// before any of its bytes are written, so a key that's listed already has its row. Keys are never reused, so a decision made
    /// here stays right while the deletes run.
    async fn sweep_storage(&self) -> R<()> {
        let sql = self.state.storage().sql();
        let now = Date::now().as_millis() as i64;
        let Some(sweep) = rows(&sql, "SELECT due_at, cursor FROM storage_sweep", vec![])?
            .into_iter()
            .next()
        else {
            return Ok(());
        };
        if sweep["due_at"].as_f64().is_none_or(|due| due as i64 > now) {
            return Ok(());
        }
        // Taken now, so anything that makes the sweep due while this runs, such as a removal, gets a pass of its own.
        exec(&sql, "UPDATE storage_sweep SET due_at = NULL", vec![])?;
        let room = objects::room_id(&sql)?;
        let prefix = room_prefix(&room);
        let bucket = self.env.bucket(crate::objects::BUCKET)?;
        let mut cursor = text(&sweep["cursor"]);
        let mut found: Vec<(String, i64)> = Vec::new();
        let mut more = false;
        for _ in 0..SWEEP_PAGES_PER_PASS {
            let mut listing = bucket.list().prefix(prefix.clone()).limit(SWEEP_PAGE_KEYS);
            if let Some(after) = &cursor {
                listing = listing.cursor(after.clone());
            }
            let page = listing.execute().await?;
            found.extend(
                page.objects()
                    .iter()
                    .map(|object| (object.key(), object.uploaded().as_millis() as i64)),
            );
            more = page.truncated();
            cursor = page.cursor().filter(|_| more);
            if !more {
                break;
            }
        }
        // Read after the listing, in one go, from current state.
        let holders: HashMap<String, ObjectState> = rows(
            &sql,
            "SELECT object_key, state FROM stored_object WHERE object_key IS NOT NULL",
            vec![],
        )?
        .iter()
        .filter_map(|row| {
            Some((
                text(&row["object_key"])?,
                row["state"].as_str().and_then(ObjectState::from_name)?,
            ))
        })
        .collect();
        let now = Date::now().as_millis() as i64;
        let mut deleted = 0usize;
        let mut kept_until: Option<i64> = None;
        for (key, stored_at) in &found {
            let holder = holders
                .get(key)
                .map_or(KeyHolder::Nobody, |state| KeyHolder::File(*state));
            if delete_stored_bytes(&room, key, holder, *stored_at, now) {
                bucket.delete(key).await?;
                deleted += 1;
            } else if holder == KeyHolder::Nobody {
                let ready = stored_at.saturating_add(UNREFERENCED_BYTES_GRACE_MS);
                kept_until = Some(kept_until.map_or(ready, |k| k.min(ready)));
            }
        }
        // More pages wait for the next alarm, soon. Otherwise the sweep is due again only when something kept becomes old enough.
        let due = if more { Some(now) } else { kept_until };
        let saved_cursor = if more { cursor } else { None };
        let cursor_value = saved_cursor.as_deref().map_or(V::Null, V::from);
        exec(
            &sql,
            "UPDATE storage_sweep SET cursor = ?",
            vec![cursor_value],
        )?;
        if let Some(due) = due {
            sweep_after(&sql, due)?;
        }
        console_log!(
            "{}",
            json!({ "at": "storage.swept", "room": room, "listed": found.len(), "deleted": deleted, "more": more })
        );
        Ok(())
    }
}
