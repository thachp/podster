//! Removing a file, and the room's sweep of what nobody needs: uploads that never finished, and bytes in storage that no file
//! refers to. The rules are `podster_core::removal`, and who may remove is `podster_policy::files`.
//!
//! Removing commits the record first and marks the file's bytes for a purge, which the alarm runs right after: it lists only that
//! file's own prefix, so a room's size can't delay it, and a failure is tried again a minute later. The room-wide sweep is the
//! backstop, for bytes nothing refers to.
//!
//! A file's name is agent content, and a key names the room and the file, so neither goes into a log, an audit entry or an event.
use super::*;
use podster_core::files::{ObjectState, SCAN_DEADLINE_MS};
use podster_core::removal::{
    delete_stored_bytes, is_abandoned, remove_file, room_prefix, unsubmitted_file_due,
    unusable_file_due, KeyHolder, Removal, ABANDONED_UPLOAD_GRACE_MS, UNREFERENCED_BYTES_GRACE_MS,
    UNSUBMITTED_FILE_RETENTION_MS, UNUSABLE_FILE_RETENTION_MS,
};
use podster_policy::files::authorize_file_removal;
use podster_policy::Verdict;
use std::collections::HashMap;

/// How many keys one listing returns, and how many listings one alarm makes. A room past this continues on the next alarm. A test
/// build lists ten at a time, so the limits can be run.
const SWEEP_PAGE_KEYS: u32 = if cfg!(feature = "failpoints") {
    10
} else {
    1000
};
const SWEEP_PAGES_PER_PASS: usize = 3;
/// How soon a sweep that failed is tried again.
const SWEEP_RETRY_MS: i64 = 60 * 1000;
/// At most this many abandoned rows go in one alarm, so a room with many can't hold the alarm up.
const ABANDONED_PER_PASS: i64 = 200;
/// At most this many removed files are purged in one alarm.
const PURGES_PER_PASS: i64 = 20;
/// The soonest anything overdue here wakes the room again, so work that keeps failing can't spin the alarm.
const REARM_MS: i64 = 1_000;
/// How many listings one file's purge makes in one alarm. A file with more keys than that continues on the next.
const PURGE_PAGES_PER_PASS: usize = 2;
/// At most this many files are removed by the system in one alarm, for each of its two reasons.
const SYSTEM_REMOVALS_PER_PASS: i64 = 100;
/// The longest a sweep that keeps failing waits before its next try.
const MAX_BACKOFF_MS: i64 = 5 * 60 * 1000;
/// Who removes a file by the rules, rather than by a person's choice (decisions 94 and 98).
const SYSTEM: Remover<'static> = Remover {
    id: "podster",
    kind: "system",
};

/// Deletes keys in one batch, and when that fails, one at a time, so one key that won't delete can't hold up the rest. Answers how
/// many went and how many are stuck. Keys are logged only as the object they belong to.
///
/// A test build fails a batch holding a key with `failbatch` in it, and any delete of a key with `stuck` in it.
async fn delete_keys(bucket: &Bucket, room: &str, keys: Vec<String>) -> (usize, usize) {
    if keys.is_empty() {
        return (0, 0);
    }
    let fails_batch = cfg!(feature = "failpoints")
        && keys
            .iter()
            .any(|key| key.contains("failbatch") || key.contains("stuck"));
    if !fails_batch && bucket.delete_multiple(keys.clone()).await.is_ok() {
        return (keys.len(), 0);
    }
    let (mut deleted, mut stuck) = (0, 0);
    for key in keys {
        let fails = cfg!(feature = "failpoints") && key.contains("stuck");
        if !fails && bucket.delete(key.clone()).await.is_ok() {
            deleted += 1;
        } else {
            stuck += 1;
            let object = key.rsplit('/').nth(1).unwrap_or_default();
            console_error!(
                "{}",
                json!({ "at": "storage.delete_failed", "room": room, "object": object })
            );
        }
    }
    (deleted, stuck)
}

/// What one purge pass left: nothing, more to list, or keys that wouldn't delete.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Purge {
    Done,
    More,
    Stuck,
}

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

/// Ends a file in `removed`, keeping its record and hash, and marks its bytes for a purge. Removing twice changes nothing. The
/// caller has already decided this remover may.
pub(super) fn remove(sql: &SqlStorage, remover: &Remover<'_>, id: &str, now: i64) -> R<Value> {
    let row = downloads::file_row(sql, id)?;
    let Removal::Removed { was } = remove_file(state_of(&row)?) else {
        return answer(sql, id);
    };
    // The token goes too, though no upload step accepts a removed file anyway.
    exec(
        sql,
        "UPDATE stored_object SET state = ?, removed_at = ?, removed_by = ?, removed_by_kind = ?, removed_from = ?, uploader_json = NULL, token_hash = '', purge_due_at = ? WHERE id = ?",
        vec![
            ObjectState::Removed.name().into(),
            now.into(),
            remover.id.into(),
            remover.kind.into(),
            was.name().into(),
            now.into(),
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
    answer(sql, id)
}

/// Whether this caller may remove this file now: the room's owner or a human admin (decision 57), and only a file they can see.
/// Someone who can't see the file, an owner or admin included, is answered as if it didn't exist. `command_checked` runs this
/// before replaying a stored answer too, so an answer can't reach someone who has since lost the right.
pub(super) fn authorize_removal(sql: &SqlStorage, caller: &Caller, id: &str) -> R<()> {
    let row = downloads::file_row(sql, id)?;
    match authorize_file_removal(caller, downloads::view_of(sql, caller, &row)?) {
        Verdict::Allow => Ok(()),
        Verdict::Hidden => Err(downloads::file_not_found()),
        other => ApiError::from_verdict(other),
    }
}

/// `POST /v1/workspaces/{ws}/files/{file}/remove`.
pub(super) fn handle_remove(sql: &SqlStorage, caller: &Caller, id: &str, now: i64) -> R<Value> {
    authorize_removal(sql, caller, id)?;
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

/// When the room next has something to clear: the storage sweep, a removed file's purge, the first unfinished upload to be
/// abandoned, or the first file the system removes by the rules. Nothing overdue wakes it sooner than `REARM_MS` from now, doubled
/// for each sweep in a row that failed, up to five minutes, so a step that keeps failing can't spin the alarm. A room still waiting
/// to migrate has nothing here yet: its next request migrates it, and the alarm mustn't fail on its older tables.
pub(super) fn next_due(sql: &SqlStorage, now: i64, failures: u32) -> R<Option<i64>> {
    if store::needs_migration(sql)? {
        return Ok(None);
    }
    let first = |query: &str, bindings: Vec<V>| -> R<Option<i64>> {
        Ok(rows(sql, query, bindings)?
            .first()
            .and_then(|r| r["first"].as_f64())
            .map(|d| d as i64))
    };
    let sweep = first("SELECT due_at AS first FROM storage_sweep", vec![])?;
    let purge = first(
        "SELECT MIN(purge_due_at) AS first FROM stored_object WHERE purge_due_at IS NOT NULL",
        vec![],
    )?;
    let abandoned = first(
        "SELECT MIN(upload_expires_at) AS first FROM stored_object WHERE state = 'uploading'",
        vec![],
    )?
    .map(|first| first.saturating_add(ABANDONED_UPLOAD_GRACE_MS));
    let unusable = first(UNUSABLE_FIRST, vec![SCAN_DEADLINE_MS.into()])?
        .map(|first| first.saturating_add(UNUSABLE_FILE_RETENTION_MS));
    let unsubmitted = first(UNSUBMITTED_FIRST, vec![])?
        .map(|first| first.saturating_add(UNSUBMITTED_FILE_RETENTION_MS));
    let floor = REARM_MS
        .saturating_mul(1i64 << failures.min(20))
        .min(MAX_BACKOFF_MS);
    Ok([sweep, purge, abandoned, unusable, unsubmitted]
        .into_iter()
        .flatten()
        .min()
        .map(|due| due.max(now.saturating_add(floor))))
}

/// A blocked or failed file's verdict: when the scanner reported or the scan ran out of time. A row from before scans recorded
/// that has none, so the end of its scan's hour stands in.
const VERDICT_AT: &str = "COALESCE(scanned_at, scanning_since + ?)";
const UNUSABLE_FIRST: &str = "SELECT MIN(COALESCE(scanned_at, scanning_since + ?)) AS first FROM stored_object WHERE state IN ('blocked', 'failed')";
/// Files uploaded for a task that no submission has named, on a task that has left Accepted, through the partial index that holds
/// only unsubmitted task files still here, so it doesn't grow with every file ever submitted.
const UNSUBMITTED: &str = "FROM stored_object o INDEXED BY stored_object_unsubmitted JOIN task t ON t.id = o.for_task WHERE o.for_task IS NOT NULL AND o.submitted_at IS NULL AND o.state <> 'removed' AND t.left_accepted_at IS NOT NULL";
const UNSUBMITTED_FIRST: &str = "SELECT MIN(t.left_accepted_at) AS first FROM stored_object o INDEXED BY stored_object_unsubmitted JOIN task t ON t.id = o.for_task WHERE o.for_task IS NOT NULL AND o.submitted_at IS NULL AND o.state <> 'removed' AND t.left_accepted_at IS NOT NULL";

/// Which rule a file is up for removal under.
#[derive(Clone, Copy)]
enum Rule {
    Unusable,
    Unsubmitted,
}

/// The files due for removal by the rules now, at most `SYSTEM_REMOVALS_PER_PASS` for each. Each is checked again, alone, before
/// it's removed.
fn due_by_rule(sql: &SqlStorage, now: i64) -> R<Vec<(String, Rule)>> {
    let unusable = rows(
        sql,
        &format!("SELECT id FROM stored_object WHERE state IN ('blocked', 'failed') AND {VERDICT_AT} <= ? ORDER BY {VERDICT_AT} LIMIT ?"),
        vec![
            SCAN_DEADLINE_MS.into(),
            now.saturating_sub(UNUSABLE_FILE_RETENTION_MS).into(),
            SCAN_DEADLINE_MS.into(),
            SYSTEM_REMOVALS_PER_PASS.into(),
        ],
    )?;
    let unsubmitted = rows(
        sql,
        &format!("SELECT o.id AS id {UNSUBMITTED} AND t.left_accepted_at <= ? ORDER BY t.left_accepted_at LIMIT ?"),
        vec![
            now.saturating_sub(UNSUBMITTED_FILE_RETENTION_MS).into(),
            SYSTEM_REMOVALS_PER_PASS.into(),
        ],
    )?;
    Ok(unusable
        .iter()
        .map(|row| (text(&row["id"]).unwrap_or_default(), Rule::Unusable))
        .chain(
            unsubmitted
                .iter()
                .map(|row| (text(&row["id"]).unwrap_or_default(), Rule::Unsubmitted)),
        )
        .collect())
}

/// Removes one file as the system if its rule says so now, reading it afresh: blocked and failed files 7 days after their verdict
/// (decision 94), and files uploaded for a task but never submitted, 24 hours after the task left Accepted (decision 98).
///
/// Whether a submission names the file is read from `submission_file` itself, never from the flag. A file it names that wasn't
/// flagged gets its flag here instead of being removed, so the cheap query stops finding it.
fn remove_if_due(sql: &SqlStorage, id: &str, rule: Rule, now: i64) -> R<()> {
    // A test build fails a file whose ID says so, to show one bad row can't stop the rest.
    if cfg!(feature = "failpoints") && id.contains("failrule") {
        return Err(ApiError::internal("injected rule failure"));
    }
    let Some(row) = rows(
        sql,
        &format!("SELECT o.state AS state, {VERDICT_AT} AS verdict_at, t.left_accepted_at AS left_at, (SELECT MIN(s.created_at) FROM submission_file s WHERE s.object_id = o.id) AS named_at FROM stored_object o LEFT JOIN task t ON t.id = o.for_task WHERE o.id = ?"),
        vec![SCAN_DEADLINE_MS.into(), id.into()],
    )?
    .into_iter()
    .next() else {
        return Ok(());
    };
    let Some(state) = row["state"].as_str().and_then(ObjectState::from_name) else {
        return Ok(());
    };
    let due = match rule {
        Rule::Unusable => row["verdict_at"]
            .as_f64()
            .and_then(|verdict| unusable_file_due(state, verdict as i64)),
        Rule::Unsubmitted => {
            let named_at = row["named_at"].as_f64().map(|at| at as i64);
            if let Some(named_at) = named_at {
                exec(
                    sql,
                    "UPDATE stored_object SET submitted_at = COALESCE(submitted_at, ?) WHERE id = ?",
                    vec![named_at.into(), id.into()],
                )?;
            }
            unsubmitted_file_due(
                state,
                named_at.is_some(),
                row["left_at"].as_f64().map(|at| at as i64),
            )
        }
    };
    if due.is_some_and(|due| due <= now) {
        remove(sql, &SYSTEM, id, now)?;
    }
    Ok(())
}

/// Raises the room's high-water mark: the latest time an upload attempt that's begun could still leave bytes nothing refers to. It
/// only ever rises, and outlives the rows, so a row dropped while its attempt is writing can't take the sweep's schedule with it.
fn raise_settles(sql: &SqlStorage, at: i64) -> R<()> {
    exec(
        sql,
        "UPDATE storage_sweep SET settles_at = CASE WHEN settles_at IS NULL OR settles_at < ? THEN ? ELSE settles_at END",
        vec![at.into(), at.into()],
    )
}

/// An upload attempt has begun: its bytes may land any time until the grace has passed, so a sweep is due then, and no pass may be
/// put off past it.
pub(super) fn attempt_began(sql: &SqlStorage, now: i64) -> R<()> {
    let settles = now.saturating_add(UNREFERENCED_BYTES_GRACE_MS);
    raise_settles(sql, settles)?;
    sweep_after(sql, settles)
}

/// An unfinished upload's row is gone, but one of its attempts may still be writing. The same as an attempt beginning now.
pub(super) fn row_dropped(sql: &SqlStorage, now: i64) -> R<()> {
    attempt_began(sql, now)
}

fn settles_at(sql: &SqlStorage) -> R<Option<i64>> {
    Ok(rows(sql, "SELECT settles_at FROM storage_sweep", vec![])?
        .first()
        .and_then(|r| r["settles_at"].as_f64())
        .map(|at| at as i64))
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
        // Their attempts ended long ago, so storage is looked at now, and the mark rises as it does for every other drop.
        raise_settles(sql, now.saturating_add(UNREFERENCED_BYTES_GRACE_MS))?;
        sweep_after(sql, now)?;
    }
    Ok(())
}

impl Workspace {
    /// The alarm's part: abandoned rows and removals by rule in a transaction, then purges, then storage. None failing holds up the
    /// rest of the alarm, and a run where any failed backs off the next.
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
        let mut failed = false;
        let dropping = sql.clone();
        if let Err(error) = transaction_sync(&self.state, move || {
            drop_abandoned(&dropping, Date::now().as_millis() as i64)
        }) {
            console_error!("couldn't clear abandoned uploads: {:?}", error.code());
            failed = true;
        }
        // Each file is removed in its own transaction, so one that errors can't hold up the rest. It's logged by ID and tried on the
        // next run.
        match due_by_rule(&sql, Date::now().as_millis() as i64) {
            Ok(due) => {
                for (id, rule) in due {
                    let removing = sql.clone();
                    let one = id.clone();
                    if let Err(error) = transaction_sync(&self.state, move || {
                        remove_if_due(&removing, &one, rule, Date::now().as_millis() as i64)
                    }) {
                        console_error!(
                            "{}",
                            json!({ "at": "storage.rule_removal_failed", "object": id, "kind": error.code() })
                        );
                        failed = true;
                    }
                }
            }
            Err(error) => {
                console_error!("couldn't read files due for removal: {:?}", error.code());
                failed = true;
            }
        }
        failed |= !self.purge_removed().await;
        if let Err(error) = self.sweep_storage().await {
            console_error!("couldn't sweep storage: {:?}", error.code());
            failed = true;
            let retry = Date::now().as_millis() as i64 + SWEEP_RETRY_MS;
            if let Err(error) = sweep_after(&sql, retry) {
                console_error!("couldn't schedule the sweep again: {:?}", error.code());
            }
        }
        let failures = if failed {
            self.sweep_failures.get().saturating_add(1)
        } else {
            0
        };
        self.sweep_failures.set(failures);
    }

    /// Deletes removed files' bytes, listing only each file's own prefix, which holds every attempt it had. An attempt may still be
    /// writing when its file is removed, so a file whose last attempt could still land is purged again once it can't.
    async fn purge_removed(&self) -> bool {
        let sql = self.state.storage().sql();
        let mut ok = true;
        let now = Date::now().as_millis() as i64;
        let due = match rows(
            &sql,
            "SELECT id, attempt_started_at FROM stored_object WHERE state = 'removed' AND purge_due_at <= ? ORDER BY purge_due_at LIMIT ?",
            vec![now.into(), PURGES_PER_PASS.into()],
        ) {
            Ok(due) => due,
            Err(error) => {
                console_error!("couldn't read files to purge: {:?}", error.code());
                return false;
            }
        };
        if due.is_empty() {
            return true;
        }
        let room = match objects::room_id(&sql) {
            Ok(room) => room,
            Err(error) => {
                console_error!("couldn't read the room to purge: {:?}", error.code());
                return false;
            }
        };
        for row in &due {
            let id = text(&row["id"]).unwrap_or_default();
            // Claimed before listing, so if recording the result keeps failing, this file is listed again a minute on, not every
            // second. A claim that fails lists nothing.
            if let Err(error) = exec(
                &sql,
                "UPDATE stored_object SET purge_due_at = ? WHERE id = ? AND state = 'removed'",
                vec![
                    now.saturating_add(SWEEP_RETRY_MS).into(),
                    id.as_str().into(),
                ],
            ) {
                console_error!("couldn't claim a purge: {:?}", error.code());
                ok = false;
                continue;
            }
            let next = match self.purge_one(&room, &id).await {
                Ok(Purge::More) => V::from(now.saturating_add(REARM_MS)),
                // A key that won't delete is tried again a minute on, as the claim already says. It has its own retry, so it doesn't
                // count as a failed sweep, which would slow every other removal in the room.
                Ok(Purge::Stuck) => V::from(now.saturating_add(SWEEP_RETRY_MS)),
                Ok(Purge::Done) => {
                    let settles = row["attempt_started_at"]
                        .as_f64()
                        .map(|at| (at as i64).saturating_add(UNREFERENCED_BYTES_GRACE_MS))
                        .filter(|at| *at > now);
                    settles.map_or(V::Null, V::from)
                }
                Err(error) => {
                    console_error!(
                        "{}",
                        json!({ "at": "storage.purge_failed", "room": room, "object": id, "kind": error.code() })
                    );
                    ok = false;
                    V::from(now.saturating_add(SWEEP_RETRY_MS))
                }
            };
            if let Err(error) = exec(
                &sql,
                "UPDATE stored_object SET purge_due_at = ? WHERE id = ? AND state = 'removed'",
                vec![next, id.as_str().into()],
            ) {
                console_error!("couldn't record a purge: {:?}", error.code());
                ok = false;
            }
        }
        ok
    }

    /// Deletes up to `PURGE_PAGES_PER_PASS` listings of one file's keys, answering what's left. A key that won't delete is skipped, so
    /// the rest still go.
    async fn purge_one(&self, room: &str, id: &str) -> R<Purge> {
        if !crate::valid_id(id) {
            return Ok(Purge::Done);
        }
        let bucket = self.env.bucket(crate::objects::BUCKET)?;
        let prefix = format!("{}{id}/", room_prefix(room));
        let (mut deleted, mut stuck) = (0usize, 0usize);
        let mut cursor: Option<String> = None;
        let mut more = true;
        for _ in 0..PURGE_PAGES_PER_PASS {
            let mut listing = bucket.list().prefix(prefix.clone()).limit(SWEEP_PAGE_KEYS);
            // Within a pass the cursor moves past keys that wouldn't delete. The next pass starts over, finding what's left.
            if let Some(after) = &cursor {
                listing = listing.cursor(after.clone());
            }
            let page = listing.execute().await?;
            // The prefix holds only this file, so everything here is its bytes, and the rule agrees.
            let keys: Vec<String> = page
                .objects()
                .iter()
                .map(|object| object.key())
                .filter(|key| {
                    delete_stored_bytes(room, key, KeyHolder::File(ObjectState::Removed), 0, 0)
                })
                .collect();
            let (went, left) = delete_keys(&bucket, room, keys).await;
            deleted += went;
            stuck += left;
            more = page.truncated();
            cursor = page.cursor().filter(|_| more);
            if !more {
                break;
            }
        }
        console_log!(
            "{}",
            json!({ "at": "storage.purged", "room": room, "object": id, "deleted": deleted, "stuck": stuck, "more": more })
        );
        Ok(if stuck > 0 {
            Purge::Stuck
        } else if more {
            Purge::More
        } else {
            Purge::Done
        })
    }

    /// Lists the room's keys in storage and deletes what `delete_stored_bytes` says to.
    ///
    /// The listing comes before reading which keys files hold, and that order is what keeps a file's bytes safe: a key is recorded
    /// before any of its bytes are written, so a key that's listed already has its row. Keys are never reused, so a decision made
    /// here stays right while the deletes run.
    async fn sweep_storage(&self) -> R<()> {
        let sql = self.state.storage().sql();
        let now = Date::now().as_millis() as i64;
        let Some(sweep) = rows(
            &sql,
            "SELECT due_at, cursor, cycle_due_at FROM storage_sweep",
            vec![],
        )?
        .into_iter()
        .next() else {
            return Ok(());
        };
        if sweep["due_at"].as_f64().is_none_or(|due| due as i64 > now) {
            return Ok(());
        }
        // Taken now, a minute on rather than cleared, so a pass that dies midway still has one coming. Anything made due sooner while
        // this runs stays, and anything later is either in the high-water mark or after this pass's own.
        let provisional = now.saturating_add(SWEEP_RETRY_MS);
        exec(
            &sql,
            "UPDATE storage_sweep SET due_at = ?",
            vec![provisional.into()],
        )?;
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
        let holders: HashMap<String, KeyHolder> = rows(
            &sql,
            "SELECT object_key, state FROM stored_object WHERE object_key IS NOT NULL",
            vec![],
        )?
        .iter()
        .filter_map(|row| {
            // A state that doesn't read still holds its key, so its bytes stay.
            let holder = row["state"]
                .as_str()
                .and_then(ObjectState::from_name)
                .map_or(KeyHolder::Unreadable, KeyHolder::File);
            Some((text(&row["object_key"])?, holder))
        })
        .collect();
        let now = Date::now().as_millis() as i64;
        let mut deleted = 0usize;
        let mut kept_until: Option<i64> = None;
        let mut keep = |at: i64| kept_until = Some(kept_until.map_or(at, |k: i64| k.min(at)));
        let mut doomed: Vec<String> = Vec::new();
        for (key, stored_at) in &found {
            let holder = holders.get(key).copied().unwrap_or(KeyHolder::Nobody);
            if delete_stored_bytes(&room, key, holder, *stored_at, now) {
                doomed.push(key.clone());
            } else if holder == KeyHolder::Nobody {
                keep(stored_at.saturating_add(UNREFERENCED_BYTES_GRACE_MS));
            }
        }
        for batch in doomed.chunks(SWEEP_PAGE_KEYS as usize) {
            // One key that won't delete mustn't stall the rest, and any that's left is tried again a minute on.
            let (went, stuck) = delete_keys(&bucket, &room, batch.to_vec()).await;
            deleted += went;
            if stuck > 0 {
                keep(now.saturating_add(SWEEP_RETRY_MS));
            }
        }
        // This pass's own claim goes, unless something made the sweep due sooner while it ran.
        exec(
            &sql,
            "UPDATE storage_sweep SET due_at = NULL WHERE due_at = ?",
            vec![provisional.into()],
        )?;
        // What this pass kept is carried through the cycle, so a key on an early page still gets its turn after the last page.
        let carried = sweep["cycle_due_at"].as_f64().map(|d| d as i64);
        let cycle_due = [carried, kept_until].into_iter().flatten().min();
        if more {
            // More pages wait for the next alarm, soon.
            exec(
                &sql,
                "UPDATE storage_sweep SET cursor = ?, cycle_due_at = ?",
                vec![
                    cursor.as_deref().map_or(V::Null, V::from),
                    cycle_due.map_or(V::Null, V::from),
                ],
            )?;
            sweep_after(&sql, now)?;
        } else {
            exec(
                &sql,
                "UPDATE storage_sweep SET cursor = NULL, cycle_due_at = NULL",
                vec![],
            )?;
            if let Some(due) = cycle_due {
                sweep_after(&sql, due)?;
            }
        }
        // An attempt that's begun may still leave bytes after this pass looked, so the sweep is never put off past when the newest
        // attempt has settled. A pass made early, by a removal, can't lose that.
        if let Some(settles) = settles_at(&sql)?.filter(|at| *at > now) {
            sweep_after(&sql, settles)?;
        }
        console_log!(
            "{}",
            json!({ "at": "storage.swept", "room": room, "listed": found.len(), "deleted": deleted, "more": more })
        );
        Ok(())
    }
}
