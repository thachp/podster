//! What a room says about its files when asked: who gets to know one exists, and who gets its bytes. These are reads, from
//! current state, on every use. Nothing here is remembered, so there's no token or link that could go on working after someone's
//! access ends. A file's name is agent content, so it goes to whoever may see it and never into a log.
use super::*;
use podster_core::files::ObjectState;
use podster_policy::files::{input_asset_view, may_download, FileView};

pub(super) fn file_not_found() -> ApiError {
    ApiError::api(404, "file_not_found")
}

pub(super) fn file_row(sql: &SqlStorage, id: &str) -> R<Value> {
    rows(
        sql,
        "SELECT id, name, size, sha256, media_type, state, object_key, removed_at, removed_by FROM stored_object WHERE id = ?",
        vec![id.into()],
    )?
    .into_iter()
    .next()
    .ok_or_else(file_not_found)
}

/// How much of a file the caller gets. A file can't be linked to a task until step 5, so `linked_tasks` is empty, and someone
/// limited to their own tasks sees nothing. When links arrive they go here, read from current state.
pub(super) fn view_of(caller: &Caller) -> FileView {
    input_asset_view(caller, &[])
}

/// An unknown state answers no, so a later state, such as a removed file, can't be downloaded by being new.
fn can_download(view: FileView, row: &Value) -> bool {
    row["state"]
        .as_str()
        .and_then(ObjectState::from_name)
        .is_some_and(|state| may_download(view, state))
}

pub(super) fn read_file(sql: &SqlStorage, who: &Participant, id: &str) -> R<Value> {
    let row = file_row(sql, id)?;
    let view = view_of(&who.caller);
    if view == FileView::Hidden {
        return Err(file_not_found());
    }
    let download_path = can_download(view, &row)
        .then(|| objects::room_id(sql).map(|room| format!("/v1/files/{room}/{id}")));
    Ok(json!({
        "id": row["id"], "name": row["name"], "size": row["size"], "sha256": row["sha256"], "media_type": row["media_type"],
        "state": row["state"], "download_path": download_path.transpose()?,
        "removed_at": row["removed_at"], "removed_by": row["removed_by"],
    }))
}

/// An organization's admin gets the name and status of a file its agent can see, and no way to the bytes (decision 58). Being in the
/// room, or having no agent here, is answered as the room's other oversight routes answer it.
pub(super) fn read_overseen(
    sql: &SqlStorage,
    identity: &Identity,
    agent: &str,
    id: &str,
) -> R<Value> {
    let Some(view) = oversight_view(sql, identity, agent)? else {
        resolve_caller(sql, identity)?;
        return Err(ApiError::not_allowed());
    };
    let row = file_row(sql, id)?;
    match view_of(&view.caller).for_oversight() {
        FileView::Hidden => Err(file_not_found()),
        FileView::NameAndStatus | FileView::Full => {
            Ok(json!({ "id": row["id"], "name": row["name"], "state": row["state"] }))
        }
    }
}

/// The check at the start of every download, and the only way to a file's key. `resolve_caller`, not `oversight_view`, is what
/// reaches this, so oversight never gets here. This answers the Worker alone, through a path no client can name.
pub(super) fn begin(sql: &SqlStorage, who: &Participant, body: &Value) -> R<Value> {
    let id = body["id"].as_str().ok_or_else(file_not_found)?;
    let row = file_row(sql, id)?;
    let view = view_of(&who.caller);
    if view == FileView::Hidden {
        return Err(file_not_found());
    }
    if row["state"].as_str() == Some(ObjectState::Removed.name()) {
        return Err(ApiError::api(410, "file_removed"));
    }
    let key = row["object_key"].as_str().filter(|key| !key.is_empty());
    if !can_download(view, &row) || key.is_none() {
        return Err(ApiError::api(409, "file_not_available"));
    }
    Ok(json!({
        "key": key, "name": row["name"], "size": row["size"], "sha256": row["sha256"], "media_type": row["media_type"],
    }))
}
