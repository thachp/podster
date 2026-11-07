//! The Worker's side of an upload: it streams the bytes to R2, and the room decides everything else. A Durable Object would
//! hold up the whole room while a file arrived, so the bytes never go through one.
//!
//! The room says how long the file must be and what its hash must be, from `create_upload`, so a declared length is never
//! trusted or needed. A chunked upload works the same as any other. Bytes are counted and hashed here, R2 checks the hash again
//! before it keeps anything, and each attempt has its own key, so nothing can overwrite a file once the room accepts it.
//!
//! Logs carry IDs, sizes and timing only. A file's name and the upload token stay out of them.
use crate::error::ApiError;
use futures_util::future::{join, select, Either};
use futures_util::StreamExt;
use podster_core::files::{
    complete_upload, Arrival, FileEnds, FileRefusal, FileSample, ObjectState,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::WritableStreamDefaultWriter;
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// How long an attempt may go with no bytes arriving, and how long it may take at all. 100 MB in 30 minutes is about 55 KB/s. These
/// are what stop a stalled sender holding an attempt open, and a test build shortens them so they can be run.
const IDLE_LIMIT_MS: u64 = if cfg!(feature = "failpoints") {
    3_000
} else {
    60_000
};
const TOTAL_LIMIT_MS: u64 = if cfg!(feature = "failpoints") {
    8_000
} else {
    30 * 60 * 1000
};
const DEADLINE_CHECK_MS: u64 = IDLE_LIMIT_MS / 4;

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
    last_chunk_at: u64,
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

/// Only what `create_upload` can have issued. The gateway refuses anything else first, and this doesn't rely on it.
fn bearer(req: &Request) -> R<String> {
    req.headers()
        .get("authorization")?
        .and_then(|value| value.strip_prefix("Bearer ").map(str::to_string))
        .filter(|token| {
            token.strip_prefix("upl_").is_some_and(|secret| {
                secret.len() == 64
                    && secret
                        .bytes()
                        .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            })
        })
        .ok_or_else(upload_not_found)
}

/// Feeds the bytes to R2, through a stream we hold both ends of. `Data::Stream` would do this, but it drops the promise of its pipe,
/// so every refused upload would leave a rejection nothing handles. A refusal here is normal. Failing tells R2 to keep nothing.
async fn pump(
    mut body: impl futures_util::Stream<Item = Result<Vec<u8>>> + Unpin,
    writer: &WritableStreamDefaultWriter,
    arrived: &Rc<RefCell<Arrived>>,
    announced_size: u64,
) {
    while let Some(chunk) = body.next().await {
        let Ok(chunk) = chunk else {
            abort(writer).await;
            return;
        };
        let too_long = {
            let mut seen = arrived.borrow_mut();
            seen.last_chunk_at = Date::now().as_millis();
            seen.add(&chunk);
            // The length the room was told is what's enforced. Stop now, not at the end of a longer file.
            seen.bytes > announced_size
        };
        if too_long {
            abort(writer).await;
            return;
        }
        let data = js_sys::Uint8Array::from(chunk.as_slice());
        if JsFuture::from(writer.write_with_chunk(&data))
            .await
            .is_err()
        {
            abort(writer).await;
            return;
        }
    }
    // Too few bytes fail here, as the stream knows its length.
    if JsFuture::from(writer.close()).await.is_err() {
        abort(writer).await;
    }
}

async fn abort(writer: &WritableStreamDefaultWriter) {
    let _ = JsFuture::from(writer.abort()).await;
}

/// Runs the write to R2 until it ends, or until a deadline passes, when it answers `None`. Going quiet only counts until every byte
/// has arrived, because after that the wait is for storage and not the sender.
async fn within_deadlines<T>(
    put: impl std::future::Future<Output = T>,
    arrived: &Rc<RefCell<Arrived>>,
    announced_size: u64,
    started: u64,
) -> Option<T> {
    let mut put = Box::pin(put);
    loop {
        let tick = Box::pin(Delay::from(Duration::from_millis(DEADLINE_CHECK_MS)));
        match select(put, tick).await {
            Either::Left((done, _)) => return Some(done),
            Either::Right((_, still_going)) => put = still_going,
        }
        let now = Date::now().as_millis();
        let (bytes, last) = {
            let seen = arrived.borrow();
            (seen.bytes, seen.last_chunk_at)
        };
        let idle = bytes < announced_size && now.saturating_sub(last) > IDLE_LIMIT_MS;
        if idle || now.saturating_sub(started) > TOTAL_LIMIT_MS {
            return None;
        }
    }
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
    let arrived = Rc::new(RefCell::new(Arrived {
        last_chunk_at: started,
        ..Arrived::default()
    }));
    let mut timed_out = false;
    // A request with no body at all has nothing to read, and arrives as an empty stream would.
    let stored = match req.stream() {
        Ok(body) => {
            let channel = worker::worker_sys::FixedLengthStream::new(announced_size as u32)
                .map_err(|_| ApiError::internal("couldn't make a stream"))?;
            let writer = channel
                .writable()
                .get_writer()
                .map_err(|_| ApiError::internal("couldn't write to a stream"))?;
            let put = bucket
                .put(&key, Data::ReadableStream(channel.readable()))
                .sha256(unhex(&announced_sha256))
                .execute();
            let both = join(put, pump(body, &writer, &arrived, announced_size));
            match within_deadlines(both, &arrived, announced_size, started).await {
                Some((result, ())) => result.map(|_| ()).map_err(|_| ()),
                None => {
                    // Dropping the write above left R2 waiting on this stream, and this ends it with nothing kept.
                    abort(&writer).await;
                    timed_out = true;
                    Err(())
                }
            }
        }
        Err(_) => Err(()),
    };

    // The bytes have stopped, so nothing else holds this now.
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
        if timed_out {
            log("upload.refused", "upload_timed_out");
            return Err(ApiError::api(408, "upload_timed_out"));
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
