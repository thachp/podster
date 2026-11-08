//! Input assets linked to tasks (decision 53). Whoever sees the whole room sees every input asset, and someone limited to their
//! own tasks sees an asset only while it's linked to one of their tasks. So the links are read from current state on every use,
//! and unlinking ends that view at once. A link grants nothing else, and it changes nothing about the task.
//!
//! A link is a fact about the room, not a decision about access, so like assigning a task it doesn't move the policy version. Its
//! events carry the task's ID and nothing about the file, whose name is agent content.
use super::*;
use podster_core::asset_links::{check_link, LinkRefusal};
use podster_core::files::{ObjectState, ROOM_QUOTA_BYTES};
use podster_core::submission_files::RoomFile;
use podster_policy::files::authorize_input_upload;

const LINKED: &str = "asset.linked";
const UNLINKED: &str = "asset.unlinked";

fn file_not_found() -> ApiError {
    ApiError::api(404, "file_not_found")
}

fn refusal(refused: LinkRefusal) -> ApiError {
    match refused {
        LinkRefusal::NotInputAsset => file_not_found(),
        LinkRefusal::TooMany => ApiError::limit_exceeded(),
        LinkRefusal::NotAvailable | LinkRefusal::Removed | LinkRefusal::TaskClosed => {
            ApiError::api(409, refused.code())
        }
    }
}

/// Every task the file is linked to now. A link's task is always in the room, as tasks are never deleted.
pub(super) fn linked_tasks(sql: &SqlStorage, object_id: &str) -> R<Vec<Task>> {
    rows(
        sql,
        "SELECT t.* FROM asset_link l JOIN task t ON t.id = l.task_id WHERE l.object_id = ? ORDER BY l.linked_at, l.task_id",
        vec![object_id.into()],
    )?
    .iter()
    .map(store::task_from_row)
    .collect()
}

/// The linked tasks the caller may know about, by ID, so a link never names a task someone can't see.
pub(super) fn visible_links(caller: &Caller, tasks: &[Task]) -> Vec<String> {
    tasks
        .iter()
        .filter(|task| can_see_task(caller, task))
        .map(|task| task.id.clone())
        .collect()
}

/// The file as the link rules see it. Step 6 tells input assets from submission files, and step 8 adds removal. Until they
/// land, every file is an input asset that hasn't been removed.
fn room_file(row: &Value) -> Option<RoomFile<'_>> {
    Some(RoomFile {
        id: row["id"].as_str()?,
        uploaded_by: row["uploaded_by"].as_str()?,
        for_task: None,
        state: ObjectState::from_name(row["state"].as_str()?)?,
        removed: false,
        sha256: row["sha256"].as_str().unwrap_or_default(),
        size: row["size"].as_u64().unwrap_or_default(),
    })
}

/// The file and task a link names, once the caller may link or unlink. Both must be ones the caller can see, and a task or file
/// they can't see answers as one that doesn't exist, so linking can never expose a file to an assignee that the linker couldn't
/// read. Only then is it asked whether they may link at all: someone who may upload input assets.
fn target(sql: &SqlStorage, caller: &Caller, file_id: &str, task_id: &str) -> R<(Value, Task)> {
    if caller.role == Role::None {
        return Err(ApiError::workspace_not_found());
    }
    require_id(file_id)?;
    require_id(task_id)?;
    let task = store::load_task(sql, task_id)?
        .filter(|task| can_see_task(caller, task))
        .ok_or_else(ApiError::task_not_found)?;
    let file = rows(
        sql,
        "SELECT id, uploaded_by, state, sha256, size FROM stored_object WHERE id = ?",
        vec![file_id.into()],
    )?
    .into_iter()
    .next()
    .ok_or_else(file_not_found)?;
    if !downloads::can_see(sql, caller, file_id)? {
        return Err(file_not_found());
    }
    ApiError::from_verdict(authorize_input_upload(caller))?;
    Ok((file, task))
}

fn is_linked(sql: &SqlStorage, file_id: &str, task_id: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT 1 FROM asset_link WHERE object_id = ? AND task_id = ?",
        vec![file_id.into(), task_id.into()],
    )?
    .is_empty())
}

/// Who hears about a link: the task's assignee, who is the one it's for, while they're still in the room. Nobody else's work
/// changes, and someone who has left hears nothing more about the room, as with any notice.
fn recipients(sql: &SqlStorage, caller: &Caller, task: &Task) -> R<Vec<String>> {
    let mut found = Vec::new();
    for assignee in task
        .assignee
        .iter()
        .filter(|assignee| **assignee != caller.id)
    {
        if store::participant(sql, assignee)?.is_some() {
            found.push(assignee.clone());
        }
    }
    Ok(found)
}

fn link_json(file_id: &str, task_id: &str, linked: bool) -> Value {
    json!({ "file_id": file_id, "task_id": task_id, "linked": linked })
}

pub(super) fn handle_link(
    sql: &SqlStorage,
    caller: &Caller,
    file_id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    let task_id = required(body, "task_id")?;
    let (row, task) = target(sql, caller, file_id, &task_id)?;
    // Linking what's already linked changes nothing, so it answers as done.
    if is_linked(sql, file_id, &task.id)? {
        return Ok(link_json(file_id, &task.id, true));
    }
    let linked_now = rows(
        sql,
        "SELECT count(*) AS n FROM asset_link WHERE task_id = ?",
        vec![task.id.as_str().into()],
    )?
    .first()
    .map_or(0, |row| int(&row["n"]).max(0) as usize);
    // A row whose state no rule knows can't be linked, like any file nobody could have.
    let file = room_file(&row).ok_or_else(|| refusal(LinkRefusal::NotAvailable))?;
    check_link(&file, task.status, linked_now).map_err(refusal)?;
    exec(
        sql,
        "INSERT INTO asset_link (task_id, object_id, linked_by, linked_at) VALUES (?, ?, ?, ?)",
        vec![
            task.id.as_str().into(),
            file_id.into(),
            caller.id.as_str().into(),
            now.into(),
        ],
    )?;
    record_event(
        sql,
        LINKED,
        &caller.id,
        Some(&task.id),
        &Transition::NONE,
        recipients(sql, caller, &task)?,
        now,
    )?;
    Ok(link_json(file_id, &task.id, true))
}

/// Unlinking works whatever the file's or task's state, since it only ever narrows who sees the file.
pub(super) fn handle_unlink(
    sql: &SqlStorage,
    caller: &Caller,
    file_id: &str,
    task_id: &str,
    now: i64,
) -> R<Value> {
    let (_, task) = target(sql, caller, file_id, task_id)?;
    if !is_linked(sql, file_id, &task.id)? {
        return Ok(link_json(file_id, &task.id, false));
    }
    exec(
        sql,
        "DELETE FROM asset_link WHERE object_id = ? AND task_id = ?",
        vec![file_id.into(), task.id.as_str().into()],
    )?;
    record_event(
        sql,
        UNLINKED,
        &caller.id,
        Some(&task.id),
        &Transition::NONE,
        recipients(sql, caller, &task)?,
        now,
    )?;
    Ok(link_json(file_id, &task.id, false))
}

/// The input assets the caller can see, oldest first, a page at a time, or only those linked to `task_id`. Someone limited to their
/// own tasks only ever receives assets linked to one of them, so the query is narrowed before each row is checked again.
/// A file that hasn't finished arriving is a reservation, not a file, so it isn't listed.
pub(super) fn list(sql: &SqlStorage, who: &Participant, url: &Url) -> R<Value> {
    let caller = &who.caller;
    if caller.role == Role::None {
        return Err(ApiError::workspace_not_found());
    }
    let cursor = query_int(url, "cursor")?.unwrap_or(0);
    let task_id = query_str(url, "task_id");
    if let Some(task_id) = &task_id {
        require_id(task_id)?;
        store::load_task(sql, task_id)?
            .filter(|task| can_see_task(caller, task))
            .ok_or_else(ApiError::task_not_found)?;
    }
    let narrow = !sees_whole_room(caller);
    let found = rows(
        sql,
        "SELECT o.rowid AS seq, o.id, o.name, o.size, o.sha256, o.media_type, o.state FROM stored_object o
        WHERE o.rowid > ? AND o.state <> 'uploading'
        AND (? IS NULL OR EXISTS (SELECT 1 FROM asset_link l WHERE l.object_id = o.id AND l.task_id = ?))
        AND (? = 0 OR EXISTS (SELECT 1 FROM asset_link l JOIN task t ON t.id = l.task_id WHERE l.object_id = o.id
            AND (t.requester_id = ? OR t.assignee_id = ? OR t.reviewer_id = ?)))
        ORDER BY o.rowid LIMIT ?",
        vec![
            cursor.into(), opt(&task_id), opt(&task_id), i64::from(narrow).into(), caller.id.as_str().into(),
            caller.id.as_str().into(), caller.id.as_str().into(), (PAGE_SIZE + 1).into(),
        ],
    )?;
    let more = found.len() as i64 > PAGE_SIZE;
    let page = || found.iter().take(PAGE_SIZE as usize);
    let mut files = Vec::new();
    for row in page() {
        if let Some(file) = downloads::file_json(sql, caller, row)? {
            files.push(file);
        }
    }
    let next = more
        .then(|| page().next_back().map(|row| int(&row["seq"])))
        .flatten();
    let mut answer = json!({ "files": files, "next_cursor": next });
    // The room's total counts files someone limited to their own tasks can't see, so only whoever sees the whole room gets it.
    if !narrow {
        answer["quota"] =
            json!({ "used": objects::room_used(sql, now_ms(), "")?, "limit": ROOM_QUOTA_BYTES });
    }
    Ok(answer)
}
