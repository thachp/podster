//! Reading a release from the room's repository (M6 step 5, the release job's steps 2 to 4; ADR 0010, "The release
//! job" and "How the tree is read").
//!
//! **The read half of the job, and only that.** It reads the release directory, `site`, at one exact commit, with a
//! token for that one repository, and gives back what may be published: each file's path, size, type and manifest
//! hash, and then each file's bytes, checked against the tree. It uploads nothing and changes nothing in any room.
//! **Nothing calls it yet** but a test-only path (`probe`): the upload that will drive it is the next PR.
//!
//! - **Its own App.** A fourth GitHub App, read-only, with Contents read and Metadata read, named in the Worker's
//!   configuration as `GITHUB_RELEASE_APP_ID`, `GITHUB_RELEASE_INSTALLATION_ID` and `GITHUB_RELEASE_APP_KEY`. **None
//!   of the three is set in any deployment, and the App doesn't exist:** each is the owner's. Unconfigured, a read is
//!   refused as `release_read_not_configured` before anything is asked of anyone. Its ID, installation and key must
//!   differ from the other three Apps', or it is treated as unconfigured.
//! - **One token, for one repository, for the two permissions,** and revoked when the read is over, on every way out
//!   that the caller takes through [`ReleaseReader::close`]. A token whose answer doesn't name exactly that
//!   repository and exactly those permissions is revoked and never used.
//! - **Two tree reads, then one read for each file.** The commit's top tree, where the directory's entry must be a
//!   directory; then that entry's own tree, recursively. Never `{commit}:{path}`, which would follow a submodule.
//!   Both answers are capped before they are parsed. `podster_core::release_tree` judges the entries.
//! - **The reads are reserved from the deployment's budget before any file is fetched,** from the tree: the two
//!   already made and one for each file. A release that doesn't fit waits; it isn't failed.
//! - **Each file is fetched by itself, as raw bytes,** capped at one file's size, and checked: its length against the
//!   tree's size, and its git blob sha against the tree's. GitHub's `Content-Type` is never read.
//! - **Nothing in the repository configures any of this.** Agent content is data.
//!
//! Tokens and the key stay here. A failure carries a code and none of the provider's text. Logs carry codes.
// In the build a deployment gets, nothing calls this yet: its only caller is the test-only `probe`. The allowance
// goes with the PR that adds the upload, which calls it.
#![cfg_attr(not(feature = "failpoints"), allow(dead_code))]
use super::*;
use podster_core::release::{reads_for_release, ReleaseCapRefusal};
use podster_core::release_tree::{
    check_fetched, check_release_tree, git_blob_header, manifest_hash, manifest_hash_input,
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
    /// Its hash in the upload's manifest: 32 hexadecimal characters, from the blob sha and the type.
    pub hash: String,
}

/// What a release holds, from the two tree reads: its files in path order, and their bytes in all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReadPlan {
    pub files: Vec<ReadFile>,
    pub total_bytes: u64,
}

impl ReadPlan {
    /// The reads this release costs in all: the two trees and one for each file.
    pub(crate) fn reads(&self) -> u32 {
        reads_for_release(u32::try_from(self.files.len()).unwrap_or(u32::MAX))
    }
}

/// The read-only App's configuration, if all three values are set, well formed, and its own.
struct ReleaseApp {
    app_id: i64,
    installation_id: i64,
    key_pem: String,
}

impl ReleaseApp {
    fn from_env(env: &Env) -> Option<ReleaseApp> {
        let get = |name: &str| lookup(env, name);
        let (app, installation, key) = RELEASE_APP_NAMES;
        let positive = |name: &str| get(name)?.parse::<i64>().ok().filter(|n| *n > 0);
        let key_pem = get(key)?;
        let own = AppRole {
            app_id: positive(app),
            installation_id: positive(installation),
            key: pkcs8_from_pem(&key_pem),
        };
        // Its own App, installation and key: shared with none of the other three (the M5 security review's F7).
        let others: Vec<AppRole> = Role::ALL.into_iter().map(|role| role.read(&get)).collect();
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

/// One read of one release's repository: a token for it, held here and nowhere else.
pub(crate) struct ReleaseReader {
    repo_id: i64,
    token: String,
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

impl ReleaseReader {
    /// Mints the read's token for `repo_id`. `not_configured` with no App; `unavailable` for anything else that
    /// doesn't end with exactly the token asked for.
    pub(crate) async fn open(
        env: &Env,
        repo_id: i64,
    ) -> std::result::Result<ReleaseReader, ReadFailure> {
        let app = ReleaseApp::from_env(env).ok_or(ReadFailure::Read(ReadProblem::NotConfigured))?;
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
        let reader = ReleaseReader { repo_id, token };
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

    /// One tree, by its sha or a commit's, capped before it is parsed. A tree that isn't there is
    /// `commit_unreadable`; an answer too long to parse fails the release as a tree too large.
    async fn tree(&self, sha: &str, recursive: bool) -> std::result::Result<Value, ReadFailure> {
        let path = format!(
            "/repositories/{}/git/trees/{}{}",
            self.repo_id,
            sha,
            if recursive { "?recursive=1" } else { "" }
        );
        let cap = usize::try_from(MAX_TREE_ANSWER_BYTES).unwrap_or(usize::MAX);
        match call_within(Method::Get, &path, &self.token, None, cap).await {
            // An answer past the cap reads as no body at all: the release never publishes part of a directory.
            Ok((200, Value::Null)) => Err(ReadFailure::Content(vec![ContentProblem::TreeTooLarge])),
            Ok((200, answer)) => Ok(answer),
            Ok((404 | 409 | 422, _)) => Err(ReadFailure::Read(ReadProblem::CommitUnreadable)),
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
            .map(|file| {
                let served_type = served_type(&file.path);
                let digest = format!(
                    "{:x}",
                    Sha256::digest(manifest_hash_input(&file.sha, served_type))
                );
                Some(ReadFile {
                    hash: manifest_hash(&digest)?,
                    served_type,
                    path: file.path,
                    size: file.size,
                    sha: file.sha,
                })
            })
            .collect::<Option<Vec<ReadFile>>>()
            .ok_or(UNAVAILABLE)?;
        Ok(ReadPlan {
            files,
            total_bytes: plan.total_bytes,
        })
    }

    /// One file's bytes, fetched raw and capped at one file's size, and checked against its tree entry: its length,
    /// and its git blob sha. Bytes that don't match fail the release; a fetch with no answer leaves it to wait.
    pub(crate) async fn fetch(&self, file: &ReadFile) -> std::result::Result<Vec<u8>, ReadFailure> {
        if !valid_commit_sha(&file.sha) {
            return Err(UNAVAILABLE);
        }
        let url = format!("{API}/repositories/{}/git/blobs/{}", self.repo_id, file.sha);
        let controller = AbortController::default();
        let signal = controller.signal();
        let bearer = self.token.clone();
        let attempt = async move {
            let headers = Headers::new();
            // The file's own bytes. Whatever type the provider gives them is never read.
            headers.set("accept", "application/vnd.github.raw+json")?;
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
            let cap = usize::try_from(MAX_FILE_BYTES).unwrap_or(usize::MAX);
            let bytes = bounded_body(&mut response, cap).await?;
            Ok::<_, Error>((status, bytes))
        };
        let timeout = Delay::from(Duration::from_millis(CALL_TIMEOUT_MS));
        let answer = match select(Box::pin(attempt), timeout).await {
            Either::Left((Ok(answer), _)) => Some(answer),
            _ => None,
        };
        controller.abort();
        let planned = PlannedFile {
            path: file.path.clone(),
            size: file.size,
            sha: file.sha.clone(),
        };
        match answer {
            // Longer than one file may be: longer than the tree said, whatever it said.
            Some((200, None)) => Err(ReadFailure::Mismatch(FetchMismatch::Size)),
            Some((200, Some(bytes))) => {
                let length = bytes.len() as u64;
                let mut named = git_blob_header(length);
                named.extend_from_slice(&bytes);
                let sha = sha1_hex(&named).await.ok_or(UNAVAILABLE)?;
                check_fetched(&planned, length, &sha).map_err(ReadFailure::Mismatch)?;
                Ok(bytes)
            }
            _ => Err(UNAVAILABLE),
        }
    }

    /// Revokes the read's token. Only GitHub's `204` counts. A token that couldn't be revoked is logged by a code,
    /// reads two things only, and lasts an hour at most.
    pub(crate) async fn close(self) {
        if !matches!(
            call(Method::Delete, "/installation/token", &self.token, None).await,
            Ok((204, _))
        ) {
            console_error!("release read: a token wasn't revoked: code=revoke_not_confirmed");
        }
    }
}

/// Reserves a release's reads from the deployment's budget, in the `Moderation` object, which is its home. Asked again
/// for the same release it answers the same reservation. `Budget` when there isn't room now.
pub(crate) async fn reserve(
    env: &Env,
    release_id: &str,
    plan: &ReadPlan,
) -> std::result::Result<(), ReadFailure> {
    let asked = async {
        let stub = env
            .durable_object("MODERATION")?
            .id_from_name("moderation")?
            .get_stub()?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post).with_body(Some(
            json!({ "release_id": release_id, "reads": plan.reads() })
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

/// **Test builds only.** Runs one whole read for a test and says what came of it: the plan, the reservation, every
/// file fetched and checked, ten at a time, and the token revoked. It publishes nothing and writes nothing to a room.
/// It is how the read is exercised before the upload that will drive it exists.
#[cfg(feature = "failpoints")]
pub(crate) async fn probe(env: &Env, body: &Value) -> Value {
    use podster_core::release::FETCH_CONCURRENCY;
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
    let reader = match ReleaseReader::open(env, repo_id).await {
        Ok(reader) => reader,
        Err(failure) => return failed(&failure),
    };
    let outcome = async {
        let plan = reader.plan(commit).await?;
        reserve(env, release_id, &plan).await?;
        let mut fetched = 0_u64;
        for batch in plan.files.chunks(FETCH_CONCURRENCY) {
            let results =
                futures_util::future::join_all(batch.iter().map(|file| reader.fetch(file))).await;
            for bytes in results {
                fetched += bytes?.len() as u64;
            }
        }
        Ok::<_, ReadFailure>((plan, fetched))
    }
    .await;
    reader.close().await;
    match outcome {
        Ok((plan, fetched)) => json!({
            "files": plan.files.iter().map(|file| json!({ "path": file.path, "size": file.size, "type": file.served_type, "hash": file.hash })).collect::<Vec<Value>>(),
            "total_bytes": plan.total_bytes,
            "reads": plan.reads(),
            "fetched_bytes": fetched,
        }),
        Err(failure) => failed(&failure),
    }
}
