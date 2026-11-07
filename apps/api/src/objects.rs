//! The Worker's side of an upload: it streams the bytes to R2, and the room decides everything else. A Durable Object would
//! hold up the whole room while a file arrived, so the bytes never go through one.
//!
//! The room says how long the file must be and what its hash must be, from `create_upload`, so a declared length is never
//! trusted or needed. A chunked upload works the same as any other. Bytes are counted and hashed here, R2 checks the hash again
//! before it keeps anything, and each attempt has its own key, so nothing can overwrite a file once the room accepts it.
//!
//! Logs carry IDs, sizes and timing only. A file's name and the upload token stay out of them.
use crate::error::ApiError;
use futures_util::StreamExt;
use podster_core::files::{
    complete_upload, Arrival, FileEnds, FileRefusal, FileSample, ObjectState,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::rc::Rc;
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

pub const BUCKET: &str = "ASSETS";

/// What a refusal looks like to whoever asked.
pub fn refusal(refused: FileRefusal) -> ApiError {
    let status = match refused {
        FileRefusal::RoomArchived | FileRefusal::QuotaExceeded | FileRefusal::InvalidTransition => {
            409
        }
        FileRefusal::TooLarge => 413,
        FileRefusal::Mismatch | FileRefusal::BadName => 422,
        FileRefusal::Executable
        | FileRefusal::PasswordProtected
        | FileRefusal::MacroEnabled
        | FileRefusal::CannotInspect
        | FileRefusal::NotOnList => 415,
    };
    ApiError::api(status, refused.code())
}

/// One answer for an upload that doesn't exist, has expired or was asked for with the wrong token.
pub fn upload_not_found() -> ApiError {
    ApiError::api(404, "upload_not_found")
}

/// What has passed so far. It holds the file's ends and its hash, never the file.
#[derive(Default)]
struct Arrived {
    bytes: u64,
    chunks: u64,
    hash: Sha256,
    ends: FileEnds,
}

impl Arrived {
    fn add(&mut self, chunk: &[u8]) {
        self.bytes += chunk.len() as u64;
        self.chunks += 1;
        self.hash.update(chunk);
        self.ends.add(chunk);
    }

    fn sha256(&self) -> String {
        hex(&self.hash.clone().finalize())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks(2)
        .filter_map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}

fn bearer(req: &Request) -> R<String> {
    req.headers()
        .get("authorization")?
        .and_then(|value| value.strip_prefix("Bearer ").map(str::to_string))
        .filter(|token| !token.is_empty())
        .ok_or_else(upload_not_found)
}

/// Asks the room, which reads the upload's own record. There's no assertion here, so the caller passed is empty, and the
/// token is what the room checks.
async fn ask_room(env: &Env, room: &str, path: &str, body: &Value) -> R<Response> {
    let stub = env
        .durable_object("WORKSPACE")?
        .id_from_name(room)?
        .get_stub()?;
    let nobody = crate::Caller {
        id: String::new(),
        kind: "person".to_string(),
        org: String::new(),
        orgs: vec![],
        admin_orgs: vec![],
        org_since: std::collections::HashMap::new(),
        target_member: None,
        gen: None,
        workspace_id: room.to_string(),
    };
    let headers = Headers::new();
    headers.set(crate::CALLER_HEADER, &serde_json::to_string(&nobody)?)?;
    crate::forward(
        stub,
        path,
        "",
        headers,
        Method::Post,
        Some(body.to_string()),
    )
    .await
}

/// What only the uploader's Principal knows, read fresh. An agent's connection may have ended, and a person may have left the
/// organization they uploaded through, since the token was issued. Rooms hear of both later.
async fn uploader_still_here(env: &Env, begun: &Value) -> R<()> {
    let uploader = begun["uploader"].as_str().unwrap_or_default();
    if begun["agent"].as_bool() == Some(true) {
        crate::principal::check_active(env, uploader, begun["gen"].as_u64(), None).await
    } else {
        crate::principal::check_not_departed(
            env,
            uploader,
            begun["org"].as_str().unwrap_or_default(),
            begun["asked_at"].as_i64().unwrap_or(0),
        )
        .await
    }
}

/// Takes the bytes of one upload. Only the room's answer decides whether they stay.
pub async fn stream_upload(mut req: Request, env: Env, room: &str, id: &str) -> R<Response> {
    if !crate::valid_id(room) || !crate::valid_id(id) {
        return Err(upload_not_found());
    }
    let token = bearer(&req)?;
    let started = Date::now().as_millis();
    let mut begun = ask_room(
        &env,
        room,
        crate::INTERNAL_UPLOAD_BEGIN,
        &json!({ "id": id, "token": token }),
    )
    .await?;
    if begun.status_code() >= 400 {
        return Ok(begun);
    }
    let begun: Value = begun.json().await?;
    uploader_still_here(&env, &begun).await?;
    let key = begun["key"].as_str().unwrap_or_default().to_string();
    let attempt = begun["attempt"].as_str().unwrap_or_default().to_string();
    let announced_sha256 = begun["sha256"].as_str().unwrap_or_default().to_string();
    let announced_size = begun["size"].as_u64().unwrap_or(0);

    let bucket = env.bucket(BUCKET)?;
    let arrived = Rc::new(RefCell::new(Arrived::default()));
    // A request with no body at all has nothing to read, and arrives as an empty stream would.
    let stored = match req.stream() {
        Ok(stream) => {
            let counted = arrived.clone();
            let body = stream.map(move |chunk| {
                let chunk = chunk?;
                let mut seen = counted.borrow_mut();
                seen.add(&chunk);
                // The length the room was told is what's enforced. Stop now, not at the end of a longer file.
                if seen.bytes > announced_size {
                    return Err(Error::RustError("longer than announced".into()));
                }
                Ok(chunk)
            });
            bucket
                .put(
                    &key,
                    Data::Stream(FixedLengthStream::wrap(body, announced_size)),
                )
                .sha256(unhex(&announced_sha256))
                .execute()
                .await
                .map(|_| ())
                .map_err(|_| ())
        }
        Err(_) => Err(()),
    };

    // The stream has ended, so nothing else holds this now.
    let seen = arrived.take();
    let received_sha256 = seen.sha256();
    let log = |at: &str, code: &str| {
        console_log!(
            "{}",
            json!({ "at": at, "room": room, "object": id, "code": code, "bytes": seen.bytes, "chunks": seen.chunks,
                    "ms": Date::now().as_millis() - started })
        );
    };
    if stored.is_err() {
        // A failed put keeps nothing, and this is cheap to be sure of.
        if let Err(problem) = bucket.delete(&key).await {
            console_error!(
                "{}",
                json!({ "at": "upload.cleanup_failed", "room": room, "object": id, "kind": problem.to_string().len() })
            );
        }
        // All of the right bytes arrived, so it's storage that failed, and the sender can try again.
        if seen.bytes == announced_size && received_sha256 == announced_sha256 {
            log("upload.storage_failed", "storage_unavailable");
            return Err(ApiError::api(502, "storage_unavailable"));
        }
        log("upload.refused", FileRefusal::Mismatch.code());
        return Err(refusal(FileRefusal::Mismatch));
    }

    let sample = FileSample {
        head: seen.ends.head(),
        tail: seen.ends.tail(),
        total_size: seen.bytes,
    };
    let checked = complete_upload(
        ObjectState::Uploading,
        &Arrival {
            announced_size,
            announced_sha256: &announced_sha256,
            received_size: seen.bytes,
            received_sha256: &received_sha256,
            sample,
        },
    );
    let completed = match checked {
        Ok(completed) => completed,
        Err(refused) => {
            bucket.delete(&key).await?;
            log("upload.refused", refused.code());
            return Err(refusal(refused));
        }
    };
    // The room checks what it knows when it answers below. Failing to ask counts as a no, because nothing here may keep a file
    // on a guess.
    if let Err(refused) = uploader_still_here(&env, &begun).await {
        bucket.delete(&key).await?;
        log("upload.refused", "uploader_gone");
        return Err(refused);
    }
    let mut answer = ask_room(
        &env,
        room,
        crate::INTERNAL_UPLOAD_COMPLETE,
        &json!({ "id": id, "attempt": attempt, "size": seen.bytes, "sha256": received_sha256,
                 "media_type": completed.kind.media_type() }),
    )
    .await?;
    if answer.status_code() >= 400 {
        // The room said no, so nothing will ever refer to these bytes.
        bucket.delete(&key).await?;
        log("upload.refused", "room_refused");
        return Ok(answer);
    }
    log("upload.stored", "ok");
    let body: Value = answer.json().await?;
    Ok(Response::from_json(&body)?)
}
