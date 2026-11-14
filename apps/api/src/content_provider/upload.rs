//! Uploading a release's static files to the provider, as that release's own script (M6 step 5, the release job's
//! step 4; ADR 0010, "The release job").
//!
//! Three calls, **exactly as spike A recorded wrangler making them** (`spikes/m6-namespace-app/README.md`, "The
//! upload's calls"), and nothing the spike didn't see:
//!
//! 1. **The upload session,** with the scripts token: the manifest, every path with its hash and size. The answer
//!    is a session token and the hashes the provider wants, in buckets. For files it already has under this script's
//!    name the buckets are empty and the token is already the completion token, which is what makes a retry cheap.
//! 2. **The files,** one call for each bucket, with the session token and no other: each file a part named by its
//!    hash, as base64, with the type it is served with. `202` while buckets remain, then `201` with the completion
//!    token.
//! 3. **The script,** with the scripts token: one `metadata` part naming the completion token, and no module, no
//!    binding and no store. **A release is static files only.** The script exists from this call on, and nothing
//!    serves it: no serve entry names it until the room has committed the release live.
//!
//! **Nothing partial is ever a script.** The provider gives the completion token only once it holds every file the
//!   manifest names, and the script is written from that token alone.
//!
//! **Strict on every answer.** A session counts only on `200`, `"success": true`, a token of a token's form, and
//! buckets that name only hashes the manifest holds, each once. A bucket counts only on the two answers above. The
//! script counts as written only on `200`, `"success": true` and the script's own name in the answer. Anything else
//! is no answer, and the room tries again: an upload is never recorded on a guess.
//!
//! **What no spike has shown,** and a wrong assumption here leaves the room retrying, which shows: what any of the
//! three answers on an error; whether the script's call needs wrangler's two query parameters, which are sent as
//! wrangler sent them; how the provider sizes a bucket; and whether it checks a hash against the bytes.
//!
//! **No rule file is sent.** The metadata's `assets.config` is the empty object, as wrangler sent it for a directory
//! with no `_headers` and no `_redirects`: the platform's rules arrive only there, and nothing from the repository
//! is ever put in it.
//!
//! The session and completion tokens stay in this module and the caller's hands for one attempt, and are never
//! stored or logged. Logs carry nothing from here.
use super::*;
use crate::github::release_read::Attempt;
use js_sys::Uint8Array;
use serde_json::json;

/// How long one of the three calls may take. A bucket carries files.
const UPLOAD_TIMEOUT_MS: u64 = 30_000;
/// No answer here is longer: a session's token and its buckets, at most a thousand hashes.
const MAX_UPLOAD_ANSWER_BYTES: usize = 1024 * 1024;
/// A token the provider gave, as it goes back in a header or a body: printable ASCII, and no longer than this.
const MAX_TOKEN_BYTES: usize = 256 * 1024;
/// The compatibility date every release's script is written with. Nothing of a release runs, so it decides nothing
/// but how the platform serves files, and it is the one spike A's uploads carried.
const COMPATIBILITY_DATE: &str = "2026-11-01";
/// What separates the parts of a body. Base64 holds no `-`, and no part's name or type holds a line break, so no
/// part can hold it.
const BOUNDARY: &str = "podster-release-upload";

/// One file as the manifest names it.
pub(crate) struct ManifestFile {
    /// The path it is served at, beginning with `/`.
    pub(crate) path: String,
    /// 32 hexadecimal characters.
    pub(crate) hash: String,
    pub(crate) size: u64,
}

/// An upload session: its token, and the hashes the provider wants, in the buckets it wants them in.
pub(crate) struct Session {
    pub(crate) token: String,
    pub(crate) buckets: Vec<Vec<String>>,
}

/// What the provider said of one bucket.
pub(crate) enum Sent {
    /// Taken, and buckets remain.
    More,
    /// Taken, and it was the last: the completion token.
    Done(String),
}

/// What the provider said of the script's write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Written {
    /// It said, in so many words, that this script is written.
    Yes,
    /// Anything else: no answer, an error, or an answer that doesn't name the script. It may or may not exist.
    Unknown,
}

fn token_form(token: &str) -> bool {
    (1..=MAX_TOKEN_BYTES).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_graphic())
}

/// Standard base64, padded, as the files' call takes it.
fn base64_into(out: &mut Vec<u8>, bytes: &[u8]) {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let letter = |index: u32| ALPHABET.get((index & 63) as usize).copied().unwrap_or(b'=');
    out.reserve(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let mut group = 0_u32;
        for (i, byte) in chunk.iter().enumerate() {
            group |= u32::from(*byte) << (16 - 8 * i);
        }
        out.push(letter(group >> 18));
        out.push(letter(group >> 12));
        out.push(if chunk.len() > 1 {
            letter(group >> 6)
        } else {
            b'='
        });
        out.push(if chunk.len() > 2 { letter(group) } else { b'=' });
    }
}

/// One bucket's body, built a file at a time so no file is held twice: each file's bytes go in as base64 and are the
/// caller's to drop.
pub(crate) struct BucketBody {
    body: Vec<u8>,
}

impl BucketBody {
    pub(crate) fn new() -> BucketBody {
        BucketBody { body: Vec::new() }
    }

    /// Adds one file. `false`, and nothing added, unless the hash is a hash and the type is one line of printable
    /// ASCII: both go into the part's headers.
    pub(crate) fn add(&mut self, hash: &str, served_type: &str, bytes: &[u8]) -> bool {
        let plain = |text: &str| text.bytes().all(|b| b.is_ascii_graphic() || b == b' ');
        if !hex32(hash) || served_type.is_empty() || !plain(served_type) {
            return false;
        }
        self.body.extend_from_slice(
            format!(
                "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{hash}\"; filename=\"{hash}\"\r\nContent-Type: {served_type}\r\n\r\n"
            )
            .as_bytes(),
        );
        base64_into(&mut self.body, bytes);
        self.body.extend_from_slice(b"\r\n");
        true
    }

    fn finish(mut self) -> Vec<u8> {
        self.body
            .extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
        self.body
    }
}

/// One call with a body, under the attempt's deadline. `None` when there was no answer to read: unreachable, timed
/// out, the deadline already passed, or longer than any answer expected. A redirect is never followed.
async fn send(
    method: Method,
    url: String,
    bearer: &str,
    content_type: &str,
    body: Vec<u8>,
    attempt: &Attempt,
) -> Option<Answer> {
    let wait_ms = attempt.call_ms(UPLOAD_TIMEOUT_MS)?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let bearer = bearer.to_owned();
    let content_type = content_type.to_owned();
    let call = async move {
        let headers = Headers::new();
        headers.set("authorization", &format!("Bearer {bearer}"))?;
        headers.set("accept", "application/json")?;
        headers.set("content-type", &content_type)?;
        let mut init = RequestInit::new();
        init.with_method(method)
            .with_headers(headers)
            .with_redirect(RequestRedirect::Manual)
            .with_body(Some(Uint8Array::from(body.as_slice()).into()));
        drop(body);
        let mut response = Fetch::Request(Request::new_with_init(&url, &init)?)
            .send_with_signal(&signal)
            .await?;
        let status = response.status_code();
        let body = crate::github::bounded_body(&mut response, MAX_UPLOAD_ANSWER_BYTES).await?;
        Ok::<_, Error>(body.map(|body| Answer { status, body }))
    };
    let timeout = Delay::from(Duration::from_millis(wait_ms));
    let answer = match select(Box::pin(call), timeout).await {
        Either::Left((Ok(answer), _)) => answer,
        Either::Left((Err(_), _)) | Either::Right(_) => None,
    };
    controller.abort();
    answer
}

impl Provider {
    /// Opens an upload session for a script, with its manifest. `None` unless the provider answered with exactly a
    /// session: a token, and buckets naming only the manifest's own hashes, each once.
    pub(crate) async fn upload_session(
        &self,
        script: &str,
        manifest: &[ManifestFile],
        attempt: &Attempt,
    ) -> Option<Session> {
        let url = format!("{}/assets-upload-session", self.script_url(script)?);
        let mut files = serde_json::Map::new();
        for file in manifest {
            if !file.path.starts_with('/') || !hex32(&file.hash) {
                return None;
            }
            files.insert(
                file.path.clone(),
                json!({ "hash": file.hash, "size": file.size }),
            );
        }
        // Two files at one path would be one entry: the manifest must hold as many as it was given.
        if files.len() != manifest.len() {
            return None;
        }
        let body = json!({ "manifest": files }).to_string().into_bytes();
        let answer = send(
            Method::Post,
            url,
            &self.scripts_token,
            "application/json",
            body,
            attempt,
        )
        .await?;
        let body = answer.json();
        if answer.status != 200 || body["success"] != true {
            return None;
        }
        let token = body["result"]["jwt"]
            .as_str()
            .filter(|token| token_form(token))?
            .to_owned();
        let mut wanted: Vec<&str> = Vec::new();
        let mut buckets = Vec::new();
        for bucket in body["result"]["buckets"].as_array()? {
            let mut hashes = Vec::new();
            for hash in bucket.as_array()? {
                let hash = hash.as_str()?;
                if wanted.contains(&hash) || !manifest.iter().any(|file| file.hash == hash) {
                    return None;
                }
                wanted.push(hash);
                hashes.push(hash.to_owned());
            }
            if hashes.is_empty() {
                return None;
            }
            buckets.push(hashes);
        }
        Some(Session { token, buckets })
    }

    /// Sends one bucket's files, with the session's token. `None` unless the provider answered that it took them.
    pub(crate) async fn upload_bucket(
        &self,
        session_token: &str,
        bucket: BucketBody,
        attempt: &Attempt,
    ) -> Option<Sent> {
        if !token_form(session_token) {
            return None;
        }
        let url = format!(
            "{API}/accounts/{}/workers/assets/upload?base64=true",
            self.account
        );
        let answer = send(
            Method::Post,
            url,
            session_token,
            &format!("multipart/form-data; boundary={BOUNDARY}"),
            bucket.finish(),
            attempt,
        )
        .await?;
        let body = answer.json();
        if body["success"] != true {
            return None;
        }
        match answer.status {
            202 => Some(Sent::More),
            201 => body["result"]["jwt"]
                .as_str()
                .filter(|token| token_form(token))
                .map(|token| Sent::Done(token.to_owned())),
            _ => None,
        }
    }

    /// Writes the script from a completion token: static files, and nothing else. The script may exist after this
    /// whatever it answers; only `Yes` says it does.
    pub(crate) async fn write_script(
        &self,
        script: &str,
        completion_token: &str,
        attempt: &Attempt,
    ) -> Written {
        let Some(url) = self.script_url(script) else {
            return Written::Unknown;
        };
        if !token_form(completion_token) {
            return Written::Unknown;
        }
        let metadata = json!({
            "assets": { "jwt": completion_token, "config": {} },
            "compatibility_date": COMPATIBILITY_DATE,
            "compatibility_flags": [],
        });
        let body = format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{metadata}\r\n--{BOUNDARY}--\r\n"
        )
        .into_bytes();
        let answer = send(
            Method::Put,
            format!("{url}?excludeScript=true&bindings_inherit=strict"),
            &self.scripts_token,
            &format!("multipart/form-data; boundary={BOUNDARY}"),
            body,
            attempt,
        )
        .await;
        match answer {
            Some(answer)
                if answer.status == 200
                    && answer.json()["success"] == true
                    && answer.json()["result"]["id"].as_str() == Some(script) =>
            {
                Written::Yes
            }
            _ => Written::Unknown,
        }
    }
}
