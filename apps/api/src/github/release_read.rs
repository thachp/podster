//! Reading a release from the room's repository (M6 step 5, the release job's steps 2 to 4; ADR 0010, "The release
//! job" and "How the tree is read").
//!
//! **The read half of the job, and only that.** It reads the release directory, `site`, at one exact commit, with a
//! token for that one repository, and gives back what may be published: each file's path, size, type and manifest
//! hash, and then each file's bytes, checked against the tree. It uploads nothing and changes nothing in any room.
//! The room's upload command drives it (`workspace/release_upload.rs`), and a test-only path runs it alone (`probe`).
//!
//! - **Its own App.** A fourth GitHub App, read-only, with Contents read and Metadata read, named in the Worker's
//!   configuration as `GITHUB_RELEASE_APP_ID`, `GITHUB_RELEASE_INSTALLATION_ID` and `GITHUB_RELEASE_APP_KEY`. **None
//!   of the three is set in any deployment, and the App doesn't exist:** each is the owner's. Unconfigured, a read is
//!   refused as `release_read_not_configured` before anything is asked of anyone. Its ID, installation and key must
//!   differ from the other three Apps', or it is treated as unconfigured.
//! - **One token, for one repository, for the two permissions,** and revoked when the read is over, on every way out:
//!   [`ReleaseReader::close`] is the caller's last step whatever came of the read, and it has its own time, apart
//!   from the attempt's deadline. A token whose answer doesn't name exactly that repository and exactly those
//!   permissions is revoked and never used. **A mint whose answer never arrived can't be revoked, and that can
//!   happen:** GitHub revokes a token only when the call carries that token, and a token Podster never received is
//!   one it can't present. No ID stands in for it. Such a token was sent to nobody else, can read two things in one
//!   repository, and ends within the hour.
//! - **Two tree reads, then one read for each file.** The commit's top tree, where the directory's entry must be a
//!   directory; then that entry's own tree, recursively. Never `{commit}:{path}`, which would follow a submodule.
//!   Both answers are capped before they are parsed. `podster_core::release_tree` judges the entries. An answer past
//!   the cap fails the release; a `200` that isn't JSON is no answer, and the read is tried again.
//! - **Every read is reserved from the deployment's budget before it is made** ([`reserve`]): the two tree reads
//!   before the token is asked for, so a read that ends at the trees is still counted, and the file reads from the
//!   tree, before any file is fetched. Each attempt reserves its own. A release that doesn't fit waits; it isn't
//!   failed.
//! - **Each file is fetched by itself, as raw bytes,** capped at one file's size, and checked: its length against the
//!   tree's size, and its git blob sha against the tree's. GitHub's `Content-Type` is never read. **Its manifest
//!   hash is a SHA-256 over its type and its own bytes,** taken as it is fetched, and never over the blob sha.
//! - **One attempt has one deadline,** by a clock it is given ([`Attempt`]). Past it nothing more is asked, and the
//!   release waits. Each call's own time is the shorter of its limit and what the attempt has left.
//! - **Nothing in the repository configures any of this.** Agent content is data.
//!
//! Tokens and the key stay here. A failure carries a code and none of the provider's text. Logs carry codes.
use super::*;
use podster_core::release::{attempt_left_ms, ReleaseCapRefusal};
use podster_core::release_tree::{
    check_fetched, check_release_tree, git_blob_header, manifest_hash, manifest_hash_prefix,
    release_directory, served_type, ContentProblem, EntryKind, FetchMismatch, PlannedFile,
    ReadProblem, TreeEntry, MAX_FILE_BYTES, MAX_TREE_ANSWER_BYTES,
};
use sha2::{Digest, Sha256};

/// The names of the read-only App's ID, installation ID and key in the Worker's configuration. None is set anywhere.
pub(crate) const RELEASE_APP_NAMES: (&str, &str, &str) = (
    "GITHUB_RELEASE_APP_ID",
    "GITHUB_RELEASE_INSTALLATION_ID",
    "GITHUB_RELEASE_APP_KEY",
);
/// What the read's token may do: read contents and metadata. Nothing else is asked for, and nothing else is accepted.
pub(crate) const READ_PERMISSIONS: [(&str, &str); 2] = [("contents", "read"), ("metadata", "read")];

/// Why a read gave nothing to publish.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReadFailure {
    /// No answer to go on, no App to read with, or a commit that isn't there.
    Read(ReadProblem),
    /// The directory's contents fail the release: every problem found, in order.
    Content(Vec<ContentProblem>),
    /// A fetched file isn't what the tree said it was.
    Mismatch(FetchMismatch),
    /// The deployment's read budget doesn't have room now. `retry_at` is when it would, if known.
    Budget { retry_at: Option<i64> },
}

impl ReadFailure {
    /// The code a release is failed or held with.
    // codes: reasons
    pub(crate) fn code(&self) -> &'static str {
        match self {
            ReadFailure::Read(problem) => problem.code(),
            ReadFailure::Content(problems) => problems
                .first()
                .map_or("release_tree_too_large", ContentProblem::code),
            ReadFailure::Mismatch(mismatch) => mismatch.code(),
            ReadFailure::Budget { .. } => ReleaseCapRefusal::ReadBudget.code(),
        }
    }

    /// Whether it ends the release. Otherwise the release waits and the read is tried again.
    pub(crate) fn fails_release(&self) -> bool {
        match self {
            ReadFailure::Read(problem) => problem.fails_release(),
            ReadFailure::Content(_) | ReadFailure::Mismatch(_) => true,
            ReadFailure::Budget { .. } => false,
        }
    }
}

const UNAVAILABLE: ReadFailure = ReadFailure::Read(ReadProblem::Unavailable);

/// One attempt's time: when it started, and the clock it is read by, which the caller passes in. Everything an
/// attempt asks of GitHub and of the provider is asked under it.
pub(crate) struct Attempt {
    started: i64,
    now: Box<dyn Fn() -> i64>,
}

impl Attempt {
    /// An attempt starting now, by `now`.
    pub(crate) fn starting(now: Box<dyn Fn() -> i64>) -> Attempt {
        Attempt {
            started: now(),
            now,
        }
    }

    /// An attempt by the Worker's own clock.
    pub(crate) fn by_the_clock() -> Attempt {
        Attempt::starting(Box::new(|| Date::now().as_millis() as i64))
    }

    /// How long one call may take: the shorter of its own limit and what the attempt has left. `None` once the
    /// attempt's deadline has passed: the call isn't made.
    pub(crate) fn call_ms(&self, limit_ms: u64) -> Option<u64> {
        let left = u64::try_from(attempt_left_ms(self.started, (self.now)())).unwrap_or(0);
        // Test builds only: a room's shorter timeout for calls, as every other call here takes it.
        #[cfg(feature = "failpoints")]
        let limit_ms = crate::test_clock::call_timeout_ms(limit_ms);
        (left > 0).then(|| left.min(limit_ms))
    }
}

/// One file a release will publish, known from the tree alone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReadFile {
    /// Relative to the release directory, as the tree gave it.
    pub path: String,
    pub size: u64,
    /// Its git blob sha, which its bytes are checked against when they are fetched.
    pub sha: String,
    /// The type it is served with, by Podster's own list.
    pub served_type: &'static str,
}

/// One file as it was fetched: its bytes, checked against the tree, and its hash in the upload's manifest.
pub(crate) struct Fetched {
    pub bytes: Vec<u8>,
    /// 32 hexadecimal characters: a SHA-256 over the file's type and these bytes, cut.
    pub hash: String,
}

/// A file's hash in the upload's manifest, from its type and its bytes.
pub(crate) fn hash_of(served_type: &str, bytes: &[u8]) -> Option<String> {
    let mut hasher = Sha256::new();
    hasher.update(manifest_hash_prefix(served_type));
    hasher.update(bytes);
    manifest_hash(&format!("{:x}", hasher.finalize()))
}

/// What a release holds, from the two tree reads: its files in path order, and their bytes in all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReadPlan {
    pub files: Vec<ReadFile>,
    pub total_bytes: u64,
}

impl ReadPlan {
    /// How many files it holds, as the budget counts them.
    pub(crate) fn count(&self) -> u32 {
        u32::try_from(self.files.len()).unwrap_or(u32::MAX)
    }
}

/// The read-only App's configuration, if all three values are set, well formed, and its own.
pub(crate) struct ReleaseApp {
    app_id: i64,
    installation_id: i64,
    key_pem: String,
}

impl ReleaseApp {
    /// The App this deployment is configured with, or `None`: `release_read_not_configured`.
    pub(crate) fn from_env(env: &Env) -> Option<ReleaseApp> {
        ReleaseApp::from_settings(&|name: &str| lookup(env, name))
    }

    /// The same, from any reading of the settings.
    fn from_settings(get: &dyn Fn(&str) -> Option<String>) -> Option<ReleaseApp> {
        let (app, installation, key) = RELEASE_APP_NAMES;
        let positive = |name: &str| get(name)?.parse::<i64>().ok().filter(|n| *n > 0);
        let key_pem = get(key)?;
        let own = AppRole {
            app_id: positive(app),
            installation_id: positive(installation),
            key: pkcs8_from_pem(&key_pem),
        };
        // Its own App, installation and key: shared with none of the other three (the M5 security review's F7).
        let others: Vec<AppRole> = Role::ALL.into_iter().map(|role| role.read(get)).collect();
        if own.key.is_none() || !role_is_distinct(&own, &others) {
            return None;
        }
        Some(ReleaseApp {
            app_id: own.app_id?,
            installation_id: own.installation_id?,
            key_pem,
        })
    }
}

/// One read of one release's repository: a token for it, held here and nowhere else, and the attempt it is made in.
pub(crate) struct ReleaseReader<'a> {
    repo_id: i64,
    token: String,
    attempt: &'a Attempt,
}

/// A tree answer's entries, as core takes them. `None` if the answer isn't a tree.
fn entries(answer: &Value) -> Option<Vec<TreeEntry<'_>>> {
    answer["tree"]
        .as_array()?
        .iter()
        .map(|entry| {
            Some(TreeEntry {
                path: entry["path"].as_str()?,
                mode: entry["mode"].as_str()?,
                kind: EntryKind::parse(entry["type"].as_str()?),
                size: entry["size"].as_u64(),
                sha: entry["sha"].as_str()?,
            })
        })
        .collect()
}

/// SHA-1 of `bytes`, by the runtime's own, as lower-case hexadecimal. Git names a blob by it.
async fn sha1_hex(bytes: &[u8]) -> Option<String> {
    let subtle = Reflect::get(
        &Reflect::get(&js_sys::global(), &"crypto".into()).ok()?,
        &"subtle".into(),
    )
    .ok()?;
    let digest = Reflect::get(&subtle, &"digest".into())
        .ok()?
        .dyn_into::<Function>()
        .ok()?;
    let promise = digest
        .call2(&subtle, &"SHA-1".into(), &Uint8Array::from(bytes))
        .ok()?
        .dyn_into::<Promise>()
        .ok()?;
    let out = JsFuture::from(promise).await.ok()?;
    Some(
        Uint8Array::new(&out)
            .to_vec()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

impl<'a> ReleaseReader<'a> {
    /// Mints the read's token for `repo_id`, with the App. `unavailable` for anything that doesn't end with exactly
    /// the token asked for, and once the attempt's deadline has passed.
    pub(crate) async fn open(
        app: &ReleaseApp,
        repo_id: i64,
        attempt: &'a Attempt,
    ) -> std::result::Result<ReleaseReader<'a>, ReadFailure> {
        if attempt.call_ms(CALL_TIMEOUT_MS).is_none() {
            return Err(UNAVAILABLE);
        }
        let jwt = app_jwt(app.app_id, &app.key_pem)
            .await
            .map_err(|_| UNAVAILABLE)?;
        let wanted: serde_json::Map<String, Value> = READ_PERMISSIONS
            .iter()
            .map(|(name, level)| ((*name).to_string(), Value::from(*level)))
            .collect();
        let path = format!("/app/installations/{}/access_tokens", app.installation_id);
        let body = json!({ "repository_ids": [repo_id], "permissions": wanted });
        let (status, answer) = call(Method::Post, &path, &jwt, Some(body))
            .await
            .map_err(|_| UNAVAILABLE)?;
        if status != 201 {
            return Err(UNAVAILABLE);
        }
        let token = answer["token"]
            .as_str()
            .filter(|token| !token.is_empty() && token.len() <= 512 && token.is_ascii())
            .ok_or(UNAVAILABLE)?
            .to_string();
        let reader = ReleaseReader {
            repo_id,
            token,
            attempt,
        };
        // Exactly this repository and exactly these permissions, or the token is revoked and never used.
        let repositories: Vec<i64> = answer["repositories"]
            .as_array()
            .map(|repos| {
                repos
                    .iter()
                    .filter_map(|repo| repo["id"].as_i64())
                    .collect()
            })
            .unwrap_or_default();
        let mut granted: Vec<(String, String)> = answer["permissions"]
            .as_object()
            .map(|granted| {
                granted
                    .iter()
                    .map(|(name, level)| (name.clone(), level.as_str().unwrap_or("").to_string()))
                    .collect()
            })
            .unwrap_or_default();
        granted.sort();
        let exact = repositories == [repo_id]
            && granted
                .iter()
                .map(|(name, level)| (name.as_str(), level.as_str()))
                .eq(READ_PERMISSIONS);
        if !exact {
            reader.close().await;
            return Err(UNAVAILABLE);
        }
        Ok(reader)
    }

    /// One `GET` with the read's token, its answer capped at `cap` bytes, under the attempt's deadline. `None` when
    /// there was no answer: unreachable, timed out, or the deadline already passed. `Some((status, None))` for an
    /// answer longer than the cap. A redirect is never followed.
    async fn get(&self, path: &str, accept: &str, cap: usize) -> Option<(u16, Option<Vec<u8>>)> {
        let wait_ms = self.attempt.call_ms(CALL_TIMEOUT_MS)?;
        let url = format!("{API}{path}");
        let controller = AbortController::default();
        let signal = controller.signal();
        let bearer = self.token.clone();
        let accept = accept.to_string();
        let attempt = async move {
            let headers = Headers::new();
            headers.set("accept", &accept)?;
            headers.set("x-github-api-version", "2022-11-28")?;
            headers.set("user-agent", USER_AGENT)?;
            headers.set("authorization", &format!("Bearer {bearer}"))?;
            let mut init = RequestInit::new();
            init.with_method(Method::Get)
                .with_headers(headers)
                .with_redirect(RequestRedirect::Manual);
            let mut response = Fetch::Request(Request::new_with_init(&url, &init)?)
                .send_with_signal(&signal)
                .await?;
            let status = response.status_code();
            let bytes = bounded_body(&mut response, cap).await?;
            Ok::<_, Error>((status, bytes))
        };
        let timeout = Delay::from(Duration::from_millis(wait_ms));
        let answer = match select(Box::pin(attempt), timeout).await {
            Either::Left((Ok(answer), _)) => Some(answer),
            _ => None,
        };
        controller.abort();
        answer
    }

    /// One tree, by its sha or a commit's, capped before it is parsed. A tree that isn't there is
    /// `commit_unreadable`. An answer too long to parse fails the release as a tree too large. **A `200` that isn't
    /// JSON is no answer at all:** something between GitHub and here answered in its place, and the read is tried
    /// again.
    async fn tree(&self, sha: &str, recursive: bool) -> std::result::Result<Value, ReadFailure> {
        let path = format!(
            "/repositories/{}/git/trees/{}{}",
            self.repo_id,
            sha,
            if recursive { "?recursive=1" } else { "" }
        );
        let cap = usize::try_from(MAX_TREE_ANSWER_BYTES).unwrap_or(usize::MAX);
        match self.get(&path, "application/vnd.github+json", cap).await {
            // An answer past the cap: the release never publishes part of a directory.
            Some((200, None)) => Err(ReadFailure::Content(vec![ContentProblem::TreeTooLarge])),
            Some((200, Some(bytes))) => serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE),
            Some((404 | 409 | 422, _)) => Err(ReadFailure::Read(ReadProblem::CommitUnreadable)),
            _ => Err(UNAVAILABLE),
        }
    }

    /// What the release holds, from two reads: the commit's top tree, then the release directory's own, recursively.
    pub(crate) async fn plan(
        &self,
        commit_sha: &str,
    ) -> std::result::Result<ReadPlan, ReadFailure> {
        if !valid_commit_sha(commit_sha) {
            return Err(ReadFailure::Read(ReadProblem::CommitUnreadable));
        }
        let top = self.tree(commit_sha, false).await?;
        let top_entries = entries(&top).ok_or(UNAVAILABLE)?;
        // The top tree is never read recursively, so a truncated one would be the provider's fault, not the room's.
        if top["truncated"] == true {
            return Err(ReadFailure::Content(vec![ContentProblem::TreeTooLarge]));
        }
        let directory = release_directory(&top_entries)
            .map_err(|problem| ReadFailure::Content(vec![problem]))?
            .to_string();
        if !valid_commit_sha(&directory) {
            return Err(UNAVAILABLE);
        }
        let tree = self.tree(&directory, true).await?;
        let tree_entries = entries(&tree).ok_or(UNAVAILABLE)?;
        let plan = check_release_tree(&tree_entries, tree["truncated"] == true)
            .map_err(ReadFailure::Content)?;
        let files = plan
            .files
            .into_iter()
            .map(|file| ReadFile {
                served_type: served_type(&file.path),
                path: file.path,
                size: file.size,
                sha: file.sha,
            })
            .collect();
        Ok(ReadPlan {
            files,
            total_bytes: plan.total_bytes,
        })
    }

    /// One file's bytes, fetched raw and capped at one file's size, and checked against its tree entry: its length,
    /// and its git blob sha. Bytes that don't match fail the release; a fetch with no answer leaves it to wait. Its
    /// manifest hash is taken over the bytes here.
    pub(crate) async fn fetch(&self, file: &ReadFile) -> std::result::Result<Fetched, ReadFailure> {
        if !valid_commit_sha(&file.sha) {
            return Err(UNAVAILABLE);
        }
        let path = format!("/repositories/{}/git/blobs/{}", self.repo_id, file.sha);
        let cap = usize::try_from(MAX_FILE_BYTES).unwrap_or(usize::MAX);
        let planned = PlannedFile {
            path: file.path.clone(),
            size: file.size,
            sha: file.sha.clone(),
        };
        // The file's own bytes. Whatever type the provider gives them is never read.
        match self
            .get(&path, "application/vnd.github.raw+json", cap)
            .await
        {
            // Longer than one file may be: longer than the tree said, whatever it said.
            Some((200, None)) => Err(ReadFailure::Mismatch(FetchMismatch::Size)),
            Some((200, Some(bytes))) => {
                let length = bytes.len() as u64;
                let mut named = git_blob_header(length);
                named.extend_from_slice(&bytes);
                let sha = sha1_hex(&named).await.ok_or(UNAVAILABLE)?;
                drop(named);
                check_fetched(&planned, length, &sha).map_err(ReadFailure::Mismatch)?;
                let hash = hash_of(file.served_type, &bytes).ok_or(UNAVAILABLE)?;
                Ok(Fetched { bytes, hash })
            }
            _ => Err(UNAVAILABLE),
        }
    }

    /// Revokes the read's token. Only GitHub's `204` counts. A token that couldn't be revoked is logged by a code,
    /// reads two things only, and lasts an hour at most. **It has its own time, whatever the attempt has left:** a
    /// read that ran out of time still revokes.
    pub(crate) async fn close(self) {
        if !matches!(
            call(Method::Delete, "/installation/token", &self.token, None).await,
            Ok((204, _))
        ) {
            console_error!("release read: a token wasn't revoked: code=revoke_not_confirmed");
        }
    }
}

/// Reserves `reads` more of a release's reads from the deployment's budget, in the `Moderation` object, which is its
/// home, **before they are made.** Each attempt reserves its own: the two tree reads, then the file reads. `Budget`
/// when there isn't room now, and nothing is reserved.
pub(crate) async fn reserve(
    env: &Env,
    release_id: &str,
    reads: u32,
) -> std::result::Result<(), ReadFailure> {
    if reads == 0 {
        return Ok(());
    }
    let asked = async {
        let stub = env
            .durable_object("MODERATION")?
            .id_from_name("moderation")?
            .get_stub()?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post).with_body(Some(
            json!({ "release_id": release_id, "reads": reads, "more": true })
                .to_string()
                .into(),
        ));
        let mut response = stub
            .fetch_with_request(Request::new_with_init(
                &format!("https://do{}", crate::moderation::RELEASE_READS_PATH),
                &init,
            )?)
            .await?;
        if response.status_code() != 200 {
            return Err(Error::RustError("release reads not answered".into()));
        }
        response.json::<Value>().await
    };
    let answer = asked.await.map_err(|_| UNAVAILABLE)?;
    match answer["fits"].as_bool() {
        Some(true) => Ok(()),
        Some(false) => Err(ReadFailure::Budget {
            retry_at: answer["retry_at"].as_i64(),
        }),
        None => Err(UNAVAILABLE),
    }
}

/// **Test builds only.** Runs one whole read for a test and says what came of it: the plan, the reservations, every
/// file fetched and checked, ten at a time, and the token revoked. It publishes nothing and writes nothing to a room.
///
/// A test may pass in what a deployment's configuration can't be changed to show: `settings`, values that stand in
/// for the Worker's own by name, `null` for one that is unset; and `clock_step_ms`, a clock that moves on by that
/// much each time it is read, so a deadline is reached without waiting for one.
#[cfg(feature = "failpoints")]
pub(crate) async fn probe(env: &Env, body: &Value) -> Value {
    use podster_core::release::{file_reads, FETCH_CONCURRENCY, TREE_READS};
    use std::cell::Cell;
    let (Some(release_id), Some(repo_id), Some(commit)) = (
        body["release_id"].as_str(),
        body["repo_id"].as_i64(),
        body["commit_sha"].as_str(),
    ) else {
        return json!({ "failed": "invalid_argument" });
    };
    let failed = |failure: &ReadFailure| {
        let problems: Vec<&str> = match failure {
            ReadFailure::Content(problems) => problems.iter().map(ContentProblem::code).collect(),
            _ => Vec::new(),
        };
        let retry_at = match failure {
            ReadFailure::Budget { retry_at } => *retry_at,
            _ => None,
        };
        json!({ "failed": failure.code(), "fails_release": failure.fails_release(), "problems": problems, "retry_at": retry_at })
    };
    let settings = body["settings"].as_object().cloned().unwrap_or_default();
    let get = |name: &str| match settings.get(name) {
        Some(Value::String(value)) => Some(value.clone()),
        Some(_) => None,
        None => lookup(env, name),
    };
    let Some(app) = ReleaseApp::from_settings(&get) else {
        return failed(&ReadFailure::Read(ReadProblem::NotConfigured));
    };
    let attempt = match body["clock_step_ms"].as_i64() {
        Some(step) => {
            let read = Cell::new(0_i64);
            let base = Date::now().as_millis() as i64;
            Attempt::starting(Box::new(move || {
                read.set(read.get() + 1);
                base + step * (read.get() - 1)
            }))
        }
        None => Attempt::by_the_clock(),
    };
    if let Err(failure) = reserve(env, release_id, TREE_READS).await {
        return failed(&failure);
    }
    let reader = match ReleaseReader::open(&app, repo_id, &attempt).await {
        Ok(reader) => reader,
        Err(failure) => return failed(&failure),
    };
    let outcome = async {
        let plan = reader.plan(commit).await?;
        reserve(env, release_id, file_reads(plan.count(), 1)).await?;
        let mut fetched = 0_u64;
        let mut hashes = Vec::new();
        for batch in plan.files.chunks(FETCH_CONCURRENCY) {
            let results =
                futures_util::future::join_all(batch.iter().map(|file| reader.fetch(file))).await;
            for file in results {
                let file = file?;
                fetched += file.bytes.len() as u64;
                hashes.push(file.hash);
            }
        }
        Ok::<_, ReadFailure>((plan, fetched, hashes))
    }
    .await;
    reader.close().await;
    match outcome {
        Ok((plan, fetched, hashes)) => json!({
            "files": plan.files.iter().zip(&hashes).map(|(file, hash)| json!({ "path": file.path, "size": file.size, "type": file.served_type, "hash": hash })).collect::<Vec<Value>>(),
            "total_bytes": plan.total_bytes,
            "reads": TREE_READS + file_reads(plan.count(), 1),
            "fetched_bytes": fetched,
        }),
        Err(failure) => failed(&failure),
    }
}
