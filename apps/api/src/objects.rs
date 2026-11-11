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
use serde::Serialize;
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
/// are what stop a stalled sender holding an attempt open. Test builds wait as long: a shorter wait there turned any step a busy
/// machine was slow to take, while a test's bytes were held, into a timed-out upload. A test that means a limit to run out sets
/// that one limit for its own request (see `Limits::for_request`).
const IDLE_LIMIT_MS: u64 = 60_000;
pub(crate) const TOTAL_LIMIT_MS: u64 = 30 * 60 * 1000;
/// How long the room gets to answer, since a stuck room shouldn't hold a finished upload open for ever.
const ROOM_ANSWER_LIMIT_MS: u64 = 30_000;

/// The waits one upload gets: on the sender, and on the room before and after the bytes.
#[derive(Clone, Copy)]
struct Limits {
    idle_ms: u64,
    total_ms: u64,
    begin_ms: u64,
    complete_ms: u64,
}

impl Limits {
    /// Production's waits. Only a test build reads `x-test-upload-limits` (`idle=…,total=…,begin=…,complete=…`, each in ms),
    /// so a test that means one of them to run out shortens just that one, and only for its own request.
    fn for_request(req: &Request) -> Self {
        let mut limits = Limits {
            idle_ms: IDLE_LIMIT_MS,
            total_ms: TOTAL_LIMIT_MS,
            begin_ms: ROOM_ANSWER_LIMIT_MS,
            complete_ms: ROOM_ANSWER_LIMIT_MS,
        };
        if !cfg!(feature = "failpoints") {
            return limits;
        }
        let Ok(Some(given)) = req.headers().get("x-test-upload-limits") else {
            return limits;
        };
        for part in given.split(',') {
            let Some((name, ms)) = part.split_once('=') else {
                continue;
            };
            let Ok(ms) = ms.trim().parse::<u64>() else {
                continue;
            };
            match name.trim() {
                "idle" => limits.idle_ms = ms,
                "total" => limits.total_ms = ms,
                "begin" => limits.begin_ms = ms,
                "complete" => limits.complete_ms = ms,
                _ => {}
            }
        }
        limits
    }

    /// How often the sender's two limits are checked.
    fn check_ms(&self) -> u64 {
        (self.idle_ms.min(self.total_ms) / 4).max(1)
    }
}

pub const BUCKET: &str = "ASSETS";

/// What a refusal looks like to whoever asked.
pub fn refusal(refused: FileRefusal) -> ApiError {
    let status = match refused {
        FileRefusal::RoomArchived
        | FileRefusal::QuotaExceeded
        | FileRefusal::ParticipantQuotaExceeded
        | FileRefusal::InvalidTransition => 409,
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
    limits: Limits,
) -> Option<T> {
    let mut put = Box::pin(put);
    loop {
        let tick = Box::pin(Delay::from(Duration::from_millis(limits.check_ms())));
        match select(put, tick).await {
            Either::Left((done, _)) => return Some(done),
            Either::Right((_, still_going)) => put = still_going,
        }
        let now = Date::now().as_millis();
        let (bytes, last) = {
            let seen = arrived.borrow();
            (seen.bytes, seen.last_chunk_at)
        };
        let idle = bytes < announced_size && now.saturating_sub(last) > limits.idle_ms;
        if idle || now.saturating_sub(started) > limits.total_ms {
            return None;
        }
    }
}

/// Waits for a call for only so long. `None` means nobody knows yet how it went.
async fn within_room_limit<T>(call: impl std::future::Future<Output = T>) -> Option<T> {
    within(ROOM_ANSWER_LIMIT_MS, call).await
}

async fn within<T>(limit_ms: u64, call: impl std::future::Future<Output = T>) -> Option<T> {
    let call = Box::pin(call);
    let limit = Box::pin(Delay::from(Duration::from_millis(limit_ms)));
    match select(call, limit).await {
        Either::Left((done, _)) => Some(done),
        Either::Right(_) => None,
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
        linker: None,
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

/// What the scanner is asked to look at, with no name or claimed type. A struct, because a `serde_json::Value` reaches the queue as `{}`.
#[derive(Serialize)]
struct ScanJob<'a> {
    v: u8,
    workspace_id: &'a str,
    object_id: &'a str,
    key: &'a str,
    size: u64,
    sha256: &'a str,
    /// When the file's hour on the queue started, which is when it was first sent, a re-send included. The scanner skips a job
    /// its room has already failed after the hour, so the turn goes to a file still waiting.
    queued_at: i64,
}

/// Sends one scan to the shared queue. The room calls this when it's that room's turn, so false only means it waits again.
pub(crate) async fn queue_scan(
    env: &Env,
    room: &str,
    id: &str,
    key: &str,
    size: u64,
    sha256: &str,
    queued_at: i64,
) -> bool {
    let job = ScanJob {
        v: 1,
        workspace_id: room,
        object_id: id,
        key,
        size,
        sha256,
        queued_at,
    };
    match env.queue("SCAN") {
        Ok(queue) => within_room_limit(queue.send(&job))
            .await
            .is_some_and(|sent| sent.is_ok()),
        Err(_) => false,
    }
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

/// A scanner's verdict. Only the secret lets anything through, and everything without it gets the same answer as a route that doesn't
/// exist, including when no secret is set, so a forged clean report has nowhere to go. The verdict's own words decide nothing here.
pub async fn scan_result(mut req: Request, env: Env) -> R<Response> {
    // A header can't carry a value with whitespace at either end, so such a secret could never match. It counts as unset.
    let expected = env
        .secret("SCANNER_SECRET")
        .map(|secret| secret.to_string())
        .ok()
        .filter(|secret| podster_core::files::scanner_secret_usable(secret));
    let Some(expected) = expected else {
        console_error!("{}", json!({ "at": "scan.secret_unset" }));
        return Err(ApiError::not_found());
    };
    let given = req
        .headers()
        .get("x-podster-scanner")?
        .ok_or_else(ApiError::not_found)?;
    // Compared as hashes, so a comparison that stops early says nothing about the secret.
    if Sha256::digest(given.as_bytes()) != Sha256::digest(expected.as_bytes()) {
        return Err(ApiError::not_found());
    }
    let body: Value =
        serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
    let room = body["workspace_id"]
        .as_str()
        .filter(|room| crate::valid_id(room))
        .ok_or_else(ApiError::not_found)?;
    within_room_limit(ask_room(&env, room, crate::INTERNAL_SCAN_RESULT, &body))
        .await
        .ok_or(ApiError::api(504, "room_unavailable"))?
}

/// Takes the bytes of one upload. Only the room's answer decides whether they stay.
pub async fn stream_upload(mut req: Request, env: Env, room: &str, id: &str) -> R<Response> {
    if !crate::valid_id(room) || !crate::valid_id(id) {
        return Err(upload_not_found());
    }
    let token = bearer(&req)?;
    let limits = Limits::for_request(&req);
    let started = Date::now().as_millis();
    let mut begun = within(
        limits.begin_ms,
        ask_room(
            &env,
            room,
            crate::INTERNAL_UPLOAD_BEGIN,
            &json!({ "id": id, "token": token }),
        ),
    )
    .await
    .ok_or(ApiError::api(504, "room_unavailable"))??;
    if begun.status_code() >= 400 {
        return Ok(begun);
    }
    let begun: Value = begun.json().await?;
    uploader_still_here(&env, &begun).await?;
    // Test builds tell the test runtime's outbound fake when an attempt is past the room's begin step and the uploader's first
    // check, so a test acts while its bytes arrive, not after a guess at how long getting here takes. Nothing else answers it.
    if cfg!(feature = "failpoints") {
        if let Ok(url) = Url::parse(&format!("https://upload-gate.example.com/receiving/{id}")) {
            let _ = Fetch::Url(url).send().await;
        }
    }
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
            match within_deadlines(both, &arrived, announced_size, started, limits).await {
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
    let asked = within(
        limits.complete_ms,
        ask_room(
            &env,
            room,
            crate::INTERNAL_UPLOAD_COMPLETE,
            &json!({ "id": id, "attempt": attempt, "size": seen.bytes, "sha256": received_sha256,
                 "media_type": completed.kind.media_type() }),
        ),
    )
    .await;
    // The room may have accepted the file without saying so, and deleting the bytes then would lose a file it holds. If it didn't,
    // these bytes stay unreferenced until the sweep in step 8, and the sender's retry starts a new attempt.
    let Some(Ok(mut answer)) = asked else {
        log("upload.outcome_unknown", "upload_outcome_unknown");
        return Err(ApiError::api(504, "upload_outcome_unknown"));
    };
    if answer.status_code() >= 400 {
        // The room said no, so nothing will ever refer to these bytes.
        bucket.delete(&key).await?;
        log("upload.refused", "room_refused");
        return Ok(answer);
    }
    log("upload.stored", "ok");
    // The room puts the file on the scan queue itself, from its alarm, when it's the room's turn (M4 step 14).
    let body: Value = answer.json().await?;
    Ok(Response::from_json(&body)?)
}
