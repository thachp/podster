//! The Worker's side of a download: the room decides, and the bytes come straight from R2, because a large file would hold up the
//! whole room. Every download starts here with the caller's current assertion. There's no download token or signed URL, and the
//! bucket has no public access, so there's nothing that could outlive the room's answer except a response already being sent.
//!
//! Logs carry IDs and sizes only. A file's name and key stay out of them.
use crate::error::ApiError;
use podster_core::files::{attachment_header, served_media_type};
use serde_json::{json, Value};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn log_problem(room: &str, id: &str, code: &str) {
    console_error!(
        "{}",
        json!({ "at": "download.refused", "room": room, "object": id, "code": code })
    );
}

/// The room's answer to whether this caller may have this file now, with its key when they may.
async fn ask_room(env: &Env, caller: &crate::Caller, room: &str, id: &str) -> R<Response> {
    let stub = env
        .durable_object("WORKSPACE")?
        .id_from_name(room)?
        .get_stub()?;
    crate::forward(
        stub,
        crate::INTERNAL_DOWNLOAD,
        "",
        crate::caller_header(caller)?,
        Method::Post,
        Some(json!({ "id": id }).to_string()),
    )
    .await
}

pub async fn stream_download(
    env: &Env,
    mut caller: crate::Caller,
    room: &str,
    id: &str,
) -> R<Response> {
    // Answered as the room answers anyone who isn't in it, since no room has such an ID, so a bad ID doesn't tell an outsider apart.
    if !crate::valid_id(room) {
        return Err(ApiError::workspace_not_found());
    }
    // The room checks the caller first, so an outsider gets its usual answer and a member learns there's no such file. A malformed
    // ID goes as one that can't match, so it never reaches the room's SQL as it came.
    let id = if crate::valid_id(id) { id } else { "" };
    caller.workspace_id = room.to_string();
    let mut allowed = ask_room(env, &caller, room, id).await?;
    if allowed.status_code() != 200 {
        return Ok(allowed);
    }
    let file: Value = allowed.json().await?;
    let key = file["key"].as_str().unwrap_or_default();
    let bucket = env.bucket(crate::objects::BUCKET)?;
    let found = bucket.get(key).execute().await.map_err(|_| {
        log_problem(room, id, "storage_unavailable");
        ApiError::api(502, "storage_unavailable")
    })?;
    let Some(object) = found else {
        // The room said it's here and storage says it isn't, as when a file is removed just now. Asking again gives the room's
        // answer for that, `file_removed`.
        let again = ask_room(env, &caller, room, id).await?;
        if again.status_code() != 200 {
            return Ok(again);
        }
        log_problem(room, id, "file_not_available");
        return Err(ApiError::api(409, "file_not_available"));
    };
    // The key never changes once accepted, so these only differ if something's wrong with what's stored. Serving it would hand out
    // bytes nobody scanned.
    let sha256 = object.checksum().sha256.as_deref().map(hex);
    if file["size"].as_u64() != Some(object.size()) || sha256.as_deref() != file["sha256"].as_str()
    {
        log_problem(room, id, "stored_bytes_differ");
        return Err(ApiError::api(409, "file_not_available"));
    }
    let Some(body) = object.body() else {
        log_problem(room, id, "storage_unavailable");
        return Err(ApiError::api(502, "storage_unavailable"));
    };
    let headers = Headers::new();
    headers.set(
        "content-type",
        served_media_type(file["media_type"].as_str()),
    )?;
    headers.set(
        "content-disposition",
        &attachment_header(file["name"].as_str().unwrap_or_default()),
    )?;
    headers.set("content-length", &object.size().to_string())?;
    headers.set("x-content-type-options", "nosniff")?;
    headers.set("cache-control", "private, no-store")?;
    headers.set("content-security-policy", "default-src 'none'; sandbox")?;
    headers.set("cross-origin-resource-policy", "same-origin")?;
    headers.set("referrer-policy", "no-referrer")?;
    console_log!(
        "{}",
        json!({ "at": "download.started", "room": room, "object": id, "bytes": object.size() })
    );
    Ok(Response::from_body(body.response_body()?)?.with_headers(headers))
}
