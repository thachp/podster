//! Files on a submission (M2 step 6): who may upload one for a task, which files a submission names, the check approval runs
//! against exactly those, and who may see them. The rules are in `podster_core::submission_files` and
//! `podster_policy::files`. This reads the room's rows for them and writes what they decide.
//!
//! A file's name and label are agent content, so they go to whoever may see the file and never into an event, audit entry or
//! log.
//!
//! **For step 8's sweep (decision 98):** a file uploaded for a task that no submission names is cleared 24 hours after the task
//! leaves `accepted`. Those are `stored_object` rows with `for_task` set and no `submission_file` row with their `object_id`,
//! found through the `stored_object_task` index, and `task.left_accepted_at` says when the clock started. `store::save_task`
//! keeps that column, so every status change sets or clears it. Removal is the `removed` state, which `room_file` reads.
use super::*;
use podster_core::files::ObjectState;
use podster_core::submission_files::{
    accepts_submission_uploads, check_approval, check_file_label, fits_unsubmitted_cap,
    pin_submission_files, ApprovalFileRefusal, ApprovedFiles, PinnedFile, RoomFile,
    SubmissionFileRefusal,
};
use podster_policy::files::{
    authorize_input_upload, authorize_submission_upload, input_asset_view, may_download,
    task_file_view, FileView,
};

fn submission_refusal(refused: SubmissionFileRefusal) -> ApiError {
    let status = match refused {
        SubmissionFileRefusal::TooMany | SubmissionFileRefusal::Duplicate => 400,
        SubmissionFileRefusal::NotFound => 404,
        SubmissionFileRefusal::NotReady | SubmissionFileRefusal::Removed => 409,
    };
    ApiError::api(status, refused.code())
}

fn approval_refusal(refused: ApprovalFileRefusal) -> ApiError {
    ApiError::api(409, refused.code())
}

/// Whether someone may upload, or go on uploading, a file: an input asset by the room's rule, and a file for a task's
/// submission only while they may submit it and it's waiting for one. Runs when the upload is created and at the start and end
/// of every attempt, so a task released, reassigned or canceled meanwhile stops the upload.
pub(super) fn may_upload(sql: &SqlStorage, caller: &Caller, for_task: Option<&str>) -> R<()> {
    let Some(task_id) = for_task else {
        return ApiError::from_verdict(authorize_input_upload(caller));
    };
    let task = load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    ApiError::from_verdict(authorize_submission_upload(caller, &task))?;
    if !accepts_submission_uploads(task.status) {
        return Err(ApiError::from_core(
            &podster_core::CoreError::InvalidTransition,
        ));
    }
    Ok(())
}

/// Refuses another upload for a task once the uploader holds as many for it as a submission could name (decision 99): files
/// no submission names yet, and uploads that can still arrive. Without it, an assignee could fill the room's quota while the
/// task stays accepted.
///
/// An upload can still arrive until its grant ends, or, once an attempt has started, until that attempt's own limit after the
/// grant, since an attempt started near the end keeps going. A blocked or failed file can never be submitted, so it doesn't
/// count, though it still counts toward the room's quota. Nor does a removed one.
pub(super) fn require_room_for_another(
    sql: &SqlStorage,
    uploader: &str,
    task_id: &str,
    now: i64,
) -> R<()> {
    let held = rows(
        sql,
        "SELECT count(*) AS n FROM stored_object o WHERE o.for_task = ? AND o.uploaded_by = ?
            AND o.state NOT IN ('removed', 'blocked', 'failed')
            AND (o.state <> 'uploading' OR o.upload_expires_at > ? OR (o.attempt_id IS NOT NULL AND o.upload_expires_at + ? > ?))
            AND NOT EXISTS (SELECT 1 FROM submission_file f WHERE f.object_id = o.id)",
        vec![
            task_id.into(),
            uploader.into(),
            now.into(),
            (crate::objects::TOTAL_LIMIT_MS as i64).into(),
            now.into(),
        ],
    )?;
    let held = held.first().map_or(0, |row| int(&row["n"])).max(0) as usize;
    if fits_unsubmitted_cap(held) {
        Ok(())
    } else {
        Err(ApiError::limit_exceeded())
    }
}

/// `task_id` from `create_upload`, if the upload is for a submission. Anything but a string is refused, so a malformed body
/// can't fall back to an input asset.
pub(super) fn upload_target(body: &Value) -> R<Option<String>> {
    match body.get("task_id") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) => Ok(Some(id.clone())),
        Some(_) => Err(ApiError::invalid_argument()),
    }
}

/// The room's rows for these files, kept as read so `RoomFile` can borrow from them.
pub(super) fn object_rows(sql: &SqlStorage, ids: &[&str]) -> R<Vec<Value>> {
    let mut found = Vec::with_capacity(ids.len());
    for id in ids {
        found.extend(rows(
            sql,
            "SELECT id, uploaded_by, for_task, state, sha256, size FROM stored_object WHERE id = ?",
            vec![(*id).into()],
        )?);
    }
    Ok(found)
}

/// A row as the rules read it. An unknown state reads as `Failed`, which nothing accepts. Step 8 records removal as the state
/// `removed`, so a removed file reads as removed whether or not `ObjectState` knows that name yet.
pub(super) fn room_file(row: &Value) -> RoomFile<'_> {
    let state = row["state"].as_str();
    RoomFile {
        id: row["id"].as_str().unwrap_or_default(),
        uploaded_by: row["uploaded_by"].as_str().unwrap_or_default(),
        for_task: row["for_task"].as_str(),
        state: state
            .and_then(ObjectState::from_name)
            .unwrap_or(ObjectState::Failed),
        removed: state == Some("removed"),
        sha256: row["sha256"].as_str().unwrap_or_default(),
        size: int(&row["size"]).max(0) as u64,
    }
}

/// A file a submission names, checked and ready to record.
pub(super) struct NamedFile {
    pinned: PinnedFile,
    label: Option<String>,
}

/// Reads `files` from a `submit_task` body and checks each against the room, before `decide`. `links` is how many links the
/// same submission carries.
pub(super) fn prepare(
    sql: &SqlStorage,
    caller: &Caller,
    task: &Task,
    body: &Value,
    links: usize,
) -> R<Vec<NamedFile>> {
    let items = match body.get("files") {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(ApiError::invalid_argument()),
    };
    let mut ids = Vec::with_capacity(items.len());
    let mut labels = Vec::with_capacity(items.len());
    for item in items {
        let id = item["id"].as_str().ok_or_else(ApiError::invalid_argument)?;
        let label = match item.get("label") {
            None | Some(Value::Null) => None,
            Some(Value::String(label)) => Some(label.clone()),
            Some(_) => return Err(ApiError::invalid_argument()),
        };
        check_file_label(label.as_deref()).map_err(|e| ApiError::from_core(&e))?;
        ids.push(id);
        labels.push(label);
    }
    // The limit is checked before reading, so a long list costs nothing.
    if ids.len().saturating_add(links) > podster_core::MAX_ARTIFACTS {
        return Err(submission_refusal(SubmissionFileRefusal::TooMany));
    }
    let found = object_rows(sql, &ids)?;
    let files: Vec<RoomFile<'_>> = found.iter().map(room_file).collect();
    let pinned = pin_submission_files(&caller.id, &task.id, &ids, links, &files)
        .map_err(submission_refusal)?;
    Ok(pinned
        .into_iter()
        .zip(labels)
        .map(|(pinned, label)| NamedFile { pinned, label })
        .collect())
}

/// Records the files a submission named, in the transaction that records the submission. A missing label is the file's name.
pub(super) fn record(
    sql: &SqlStorage,
    who: &Participant,
    task_id: &str,
    submission_no: u32,
    files: Vec<NamedFile>,
    now: i64,
) -> R<()> {
    for file in files {
        let PinnedFile {
            object_id,
            sha256,
            size,
        } = file.pinned;
        exec(sql, "INSERT INTO submission_file (task_id, submission_no, object_id, sha256, size, label, submitted_by, submitted_org, created_at)
            VALUES (?, ?, ?, ?, ?, COALESCE(?, (SELECT name FROM stored_object WHERE id = ?)), ?, ?, ?)", vec![
            task_id.into(), i64::from(submission_no).into(), object_id.as_str().into(), sha256.as_str().into(), (size as i64).into(),
            opt(&file.label), object_id.as_str().into(), who.caller.id.as_str().into(), who.org.as_str().into(), now.into(),
        ])?;
    }
    Ok(())
}

/// The check approval needs, run before `decide` for the submission being approved, so `decide` gets its proof. Only the
/// latest submission of a task waiting for review is checked. Anything else gets no proof and `decide` refuses it for its
/// own reason, such as a stale number.
pub(super) fn approval(
    sql: &SqlStorage,
    task: &Task,
    submission_no: u32,
) -> R<Option<ApprovedFiles>> {
    if task.status != podster_core::TaskStatus::Submitted || submission_no != task.submission_no {
        return Ok(None);
    }
    let named = rows(
        sql,
        "SELECT object_id, sha256, size FROM submission_file WHERE task_id = ? AND submission_no = ? ORDER BY object_id",
        vec![task.id.as_str().into(), i64::from(submission_no).into()],
    )?;
    let pinned: Vec<PinnedFile> = named
        .iter()
        .map(|row| PinnedFile {
            object_id: text(&row["object_id"]).unwrap_or_default(),
            sha256: text(&row["sha256"]).unwrap_or_default(),
            size: int(&row["size"]).max(0) as u64,
        })
        .collect();
    let ids: Vec<&str> = pinned.iter().map(|file| file.object_id.as_str()).collect();
    let found = object_rows(sql, &ids)?;
    let current: Vec<RoomFile<'_>> = found.iter().map(room_file).collect();
    check_approval(&task.id, submission_no, &pinned, &current)
        .map(Some)
        .map_err(approval_refusal)
}

/// How much of a file the caller gets: an input asset by the room's rule, and a file uploaded for a task by that task's.
/// `None` for a file uploaded for a task that no longer exists, which nothing can see.
pub(super) fn file_view(sql: &SqlStorage, caller: &Caller, row: &Value) -> R<FileView> {
    let Some(task_id) = row["for_task"].as_str() else {
        // An input asset is seen through the tasks it's linked to now (decision 103), read from current state on every use.
        let linked = super::asset_links::linked_tasks(sql, row["id"].as_str().unwrap_or_default())?;
        let refs: Vec<&Task> = linked.iter().collect();
        return Ok(input_asset_view(caller, &refs));
    };
    let Some(task) = load_task(sql, task_id)? else {
        return Ok(FileView::Hidden);
    };
    let submitted = !rows(
        sql,
        "SELECT 1 AS named FROM submission_file WHERE object_id = ? AND task_id = ? LIMIT 1",
        vec![
            row["id"].as_str().unwrap_or_default().into(),
            task_id.into(),
        ],
    )?
    .is_empty();
    let uploaded_by = row["uploaded_by"].as_str().unwrap_or_default();
    Ok(task_file_view(caller, &task, uploaded_by, submitted))
}

/// The files of a task's submissions that the caller may read, for `get_task`. Each passes the same view a download does, so
/// files follow the artifact scope as submissions and links do, and the reviewer named on the task also gets them
/// (decision 97). A submission's note and links stay with the artifact scope.
///
/// Through oversight, `who` is the agent's view, narrowed to name and status (decision 58): no label, hash, size or path.
pub(super) fn for_task(
    sql: &SqlStorage,
    who: &Participant,
    task: &Task,
    oversight: bool,
) -> R<Vec<Value>> {
    let found = rows(sql, "SELECT f.task_id, f.submission_no, f.object_id, f.sha256, f.size, f.label, f.submitted_by, f.submitted_org, f.created_at,
        o.name, o.media_type, o.state FROM submission_file f LEFT JOIN stored_object o ON o.id = f.object_id
        WHERE f.task_id = ? ORDER BY f.submission_no, f.created_at, f.object_id", vec![task.id.as_str().into()])?;
    let room = objects::room_id(sql)?;
    let mut out = Vec::new();
    for row in &found {
        let id = row["object_id"].as_str().unwrap_or_default();
        let state = row["state"].as_str().and_then(ObjectState::from_name);
        let view = task_file_view(
            &who.caller,
            task,
            row["submitted_by"].as_str().unwrap_or_default(),
            true,
        );
        let view = if oversight {
            view.for_oversight()
        } else {
            view
        };
        match view {
            FileView::Hidden => continue,
            FileView::NameAndStatus => {
                out.push(json!({
                    "id": id, "submitted": true, "submission_no": row["submission_no"], "name": row["name"], "state": row["state"],
                    "download_path": null,
                }));
                continue;
            }
            FileView::Full => {}
        }
        let download_path = state
            .is_some_and(|state| may_download(view, state))
            .then(|| format!("/v1/files/{room}/{id}"));
        out.push(json!({
            "id": id, "submitted": true, "submission_no": row["submission_no"], "label": row["label"], "name": row["name"], "size": row["size"],
            "sha256": row["sha256"], "media_type": row["media_type"], "state": row["state"], "download_path": download_path,
            "from": { "id": row["submitted_by"], "org": row["submitted_org"] },
            "external": row["submitted_org"].as_str() != Some(who.org.as_str()), "created_at": row["created_at"],
        }));
    }
    out.extend(unsubmitted(sql, who, task, oversight, &room, now_ms())?);
    Ok(out)
}

/// The caller's own files for this task that no submission names yet, after the submitted ones: what counts toward their cap
/// (decision 99), plus blocked and failed files so they can see why, so a reload doesn't hide them. Only their uploader sees
/// one, by the same rule as a download, and oversight of that uploader gets its name and state. An upload that can no longer
/// arrive is left out, as the cap leaves it out.
fn unsubmitted(
    sql: &SqlStorage,
    who: &Participant,
    task: &Task,
    oversight: bool,
    room: &str,
    now: i64,
) -> R<Vec<Value>> {
    let found = rows(
        sql,
        "SELECT o.id, o.name, o.size, o.sha256, o.media_type, o.state, o.uploaded_by, o.created_at FROM stored_object o
            WHERE o.for_task = ? AND o.uploaded_by = ? AND o.state <> 'removed'
            AND (o.state <> 'uploading' OR o.upload_expires_at > ? OR (o.attempt_id IS NOT NULL AND o.upload_expires_at + ? > ?))
            AND NOT EXISTS (SELECT 1 FROM submission_file f WHERE f.object_id = o.id)
            ORDER BY o.created_at, o.id",
        vec![
            task.id.as_str().into(),
            who.caller.id.as_str().into(),
            now.into(),
            (crate::objects::TOTAL_LIMIT_MS as i64).into(),
            now.into(),
        ],
    )?;
    let mut out = Vec::new();
    for row in &found {
        let id = row["id"].as_str().unwrap_or_default();
        let view = task_file_view(
            &who.caller,
            task,
            row["uploaded_by"].as_str().unwrap_or_default(),
            false,
        );
        let view = if oversight {
            view.for_oversight()
        } else {
            view
        };
        match view {
            FileView::Hidden => {}
            FileView::NameAndStatus => out.push(json!({
                "id": id, "submitted": false, "submission_no": null, "name": row["name"], "state": row["state"], "download_path": null,
            })),
            FileView::Full => {
                let download_path = row["state"]
                    .as_str()
                    .and_then(ObjectState::from_name)
                    .is_some_and(|state| may_download(view, state))
                    .then(|| format!("/v1/files/{room}/{id}"));
                out.push(json!({
                    "id": id, "submitted": false, "submission_no": null, "label": null, "name": row["name"], "size": row["size"],
                    "sha256": row["sha256"], "media_type": row["media_type"], "state": row["state"], "download_path": download_path,
                    "created_at": row["created_at"],
                }));
            }
        }
    }
    Ok(out)
}
