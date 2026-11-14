//! Reading a release's files and uploading them as its own script (M6 step 5; ADR 0010's "The release job", steps 1
//! to 4). **Static files only:** no Worker code, no binding and no store is ever uploaded here.
//!
//! One room command, `{ release_id }`, for a release that is `uploading`. The job's driver (`release_driver`) calls
//! it, after it has started the upload and before it commits the release live. In order:
//!
//! 1. **The recheck, whole,** in the room's transaction, on fresh outside reads and the room's rows, the release
//!    epoch included (`release_commit::upload_ready`). A fact that fails ends the release before anything is asked
//!    of GitHub or the provider. A fact that couldn't be read leaves it undecided.
//! 2. **The read** (`github::release_read`): a token for the room's one repository, the two trees, and every file
//!    fetched once to hash it. Every read is reserved from the deployment's budget before it is made.
//! 3. **The upload session** (`content_provider::upload`), with the manifest: every file's path, hash and size, and
//!    the job's own marker file. Then each bucket the provider asks for: its files fetched again, checked again, and
//!    sent. **No file is held between the two fetches,** so a release is never in memory whole.
//! 4. **The read's token is revoked,** whatever came of it, before the script is written.
//! 5. **The room again,** in its transaction: the whole recheck once more, on outside facts read afresh and the
//!    room's rows and epoch now. If it doesn't hold, nothing is written.
//! 6. **The script is written,** from the provider's completion token, which it gives only once it holds every file
//!    the manifest names. So a script is never part of a release.
//! 7. **The room records the upload,** or, if the release ended while the script was being written, owes the script
//!    its deletion again (`release_commit::record_uploaded`).
//!
//! **Nothing is served by any of this.** The script exists and no serve entry names it. A commit stages a release
//! only once step 7 has recorded it (`release_commit::stage`), and the applier writes a host's entry only for a
//! release the room has recorded live.
//!
//! **A retry is the same command again, and it is safe at every point.** Before step 6 nothing exists under the
//! script's name that anything could serve. The provider remembers the files it holds under the script's name, so a
//! second session asks for none of them. Writing the script twice writes the same script. A release already recorded
//! is answered as such and nothing is asked of anyone.
//!
//! **What waits and what fails.** A release fails on what its repository holds: the commit unreadable, the directory
//! missing or refused, a file that isn't what the tree said. It waits, answered with `waiting` and a code, on
//! everything else: no provider or no read-only App configured, the read budget, GitHub or the provider giving no
//! answer to go on, the attempt's deadline. A release that waits past its upload's hour is ended by the room's own
//! bookkeeping, and its script deleted.
//!
//! **Still owed:** an upload whose answer was lost, as the state `uncertain` and
//! its settling by the provider's own answer; the marker's wait.
//!
//! Logs carry the room's and the release's IDs and codes. No token, path or file name is logged.
use super::release_commit::{
    record_uploaded, upload_answer, upload_failed, upload_ready, UploadReady,
};
use super::release_recheck::{release_now, state_of, Reads};
use super::*;
use crate::content_provider::upload::{BucketBody, ManifestFile, Sent, Written};
use crate::content_provider::Provider;
use crate::github::release_read::{
    hash_of, reserve, Attempt, ReadFailure, ReadFile, ReleaseApp, ReleaseReader,
};
use podster_core::release::{
    fetch_batches, file_reads, upload_requests, ReleaseState, FETCH_PASSES, TREE_READS,
};
use podster_core::release_tree::{
    marker_body, FetchMismatch, ReadProblem, MARKER_PATH, MARKER_TYPE,
};

/// The room's path for uploading a release's files. Nothing outside the Worker reaches it; the job's driver asks the
/// same command directly.
pub(crate) const INTERNAL_RELEASE_UPLOAD: &str = "/internal/release-upload";
/// `waiting`, when the deployment has no provider to upload to; and the driver's code while it idles for that.
pub(super) const NO_PROVIDER: &str = "content_provider_not_configured";
/// `waiting`, when the provider gave no answer to go on, at the session, a bucket or the script.
const UPLOAD_UNAVAILABLE: &str = "release_upload_unavailable";

/// Why an attempt stopped before the script could be written.
enum Stop {
    /// The read: its own code, and whether it ends the release.
    Read(ReadFailure),
    /// The provider gave no answer to go on.
    Provider,
    /// The driver's lease on the step ran out: nothing more is asked of anyone.
    Lease,
}

impl From<ReadFailure> for Stop {
    fn from(failure: ReadFailure) -> Stop {
        Stop::Read(failure)
    }
}

/// Everything the provider holds for one release, ready to be written as its script.
struct Complete {
    token: String,
    files: i64,
    bytes: i64,
}

/// Every file of the plan fetched in batches, in order, each checked against the tree as it arrives. `take` is given
/// each file's place in `files`, its hash and its bytes, and keeps what it needs.
async fn fetch_each(
    reader: &ReleaseReader<'_>,
    files: &[&ReadFile],
    mut take: impl FnMut(usize, String, Vec<u8>) -> std::result::Result<(), Stop>,
) -> std::result::Result<(), Stop> {
    let sizes: Vec<u64> = files.iter().map(|file| file.size).collect();
    let mut at = 0_usize;
    for length in fetch_batches(&sizes) {
        let batch = files.get(at..at + length).unwrap_or_default();
        let fetched =
            futures_util::future::join_all(batch.iter().map(|file| reader.fetch(file))).await;
        for (offset, file) in fetched.into_iter().enumerate() {
            let file = file?;
            take(at + offset, file.hash, file.bytes)?;
        }
        at += length;
    }
    Ok(())
}

/// Steps 2 and 3: the read, the session and the buckets. The reader is the caller's to close. `go_on` is asked before
/// each thing asked of the read budget or the provider; once it says no, nothing more is (the driver's lease).
#[allow(clippy::too_many_arguments)]
async fn send_files(
    env: &Env,
    provider: &Provider,
    reader: &ReleaseReader<'_>,
    attempt: &Attempt,
    release_id: &str,
    script: &str,
    commit_sha: &str,
    go_on: &dyn Fn() -> bool,
) -> std::result::Result<Complete, Stop> {
    let check = || if go_on() { Ok(()) } else { Err(Stop::Lease) };
    let marker = marker_body(release_id, commit_sha).ok_or(Stop::Provider)?;
    let marker_hash = hash_of(MARKER_TYPE, marker.as_bytes()).ok_or(Stop::Provider)?;
    let plan = reader.plan(commit_sha).await?;
    check()?;
    reserve(
        env,
        release_id,
        file_reads(plan.count(), FETCH_PASSES),
        attempt,
    )
    .await?;
    // The first pass: every file's hash, from its own bytes. The bytes are dropped as each is hashed.
    let all: Vec<&ReadFile> = plan.files.iter().collect();
    let mut hashes: Vec<String> = Vec::with_capacity(all.len());
    fetch_each(reader, &all, |_, hash, _| {
        hashes.push(hash);
        Ok(())
    })
    .await?;
    let mut manifest: Vec<ManifestFile> = plan
        .files
        .iter()
        .zip(&hashes)
        .map(|(file, hash)| ManifestFile {
            path: format!("/{}", file.path),
            hash: hash.clone(),
            size: file.size,
        })
        .collect();
    manifest.push(ManifestFile {
        path: format!("/{MARKER_PATH}"),
        hash: marker_hash.clone(),
        size: marker.len() as u64,
    });
    check()?;
    let session = provider
        .upload_session(script, &manifest, attempt)
        .await
        .ok_or(Stop::Provider)?;
    // No bucket: the provider holds every file under this script's name already, and the token completes it.
    let mut completion = session.buckets.is_empty().then(|| session.token.clone());
    // **One request carries at most `UPLOAD_REQUEST_BYTES` of files,** however large the provider made a bucket: a
    // bucket over that goes in several requests, in its own order.
    let size_of = |hash: &String| -> std::result::Result<u64, Stop> {
        if *hash == marker_hash {
            return Ok(marker.len() as u64);
        }
        let place = hashes
            .iter()
            .position(|known| known == hash)
            .ok_or(Stop::Provider)?;
        Ok(plan.files.get(place).ok_or(Stop::Provider)?.size)
    };
    let mut requests: Vec<&[String]> = Vec::new();
    for bucket in &session.buckets {
        let sizes = bucket
            .iter()
            .map(size_of)
            .collect::<std::result::Result<Vec<u64>, Stop>>()?;
        let mut at = 0_usize;
        for length in upload_requests(&sizes) {
            requests.push(bucket.get(at..at + length).unwrap_or_default());
            at += length;
        }
    }
    let last = requests.len().saturating_sub(1);
    for (index, bucket) in requests.iter().copied().enumerate() {
        check()?;
        let mut body = BucketBody::new();
        // The second pass, for this bucket's files: fetched again, checked against the tree again, and each must
        // hash as it did in the manifest.
        let mut wanted: Vec<&ReadFile> = Vec::new();
        for hash in bucket {
            if *hash == marker_hash {
                if !body.add(hash, MARKER_TYPE, marker.as_bytes()) {
                    return Err(Stop::Provider);
                }
                continue;
            }
            // Two files with the same bytes and type share a hash, and the provider asks for it once.
            let place = hashes
                .iter()
                .position(|known| known == hash)
                .ok_or(Stop::Provider)?;
            wanted.push(plan.files.get(place).ok_or(Stop::Provider)?);
        }
        let expected: Vec<&String> = bucket.iter().filter(|hash| **hash != marker_hash).collect();
        let files = wanted.clone();
        fetch_each(reader, &wanted, |place, hash, bytes| {
            let (Some(file), Some(expect)) = (files.get(place), expected.get(place)) else {
                return Err(Stop::Provider);
            };
            if hash != **expect {
                return Err(Stop::Read(ReadFailure::Mismatch(FetchMismatch::Sha)));
            }
            if !body.add(&hash, file.served_type, &bytes) {
                return Err(Stop::Provider);
            }
            Ok(())
        })
        .await?;
        check()?;
        match provider.upload_bucket(&session.token, body, attempt).await {
            Some(Sent::More) if index < last => {}
            Some(Sent::Done(token)) if index == last => completion = Some(token),
            // Done before the last request, more after it, or no answer: nothing to go on.
            _ => return Err(Stop::Provider),
        }
    }
    Ok(Complete {
        token: completion.ok_or(Stop::Provider)?,
        files: i64::try_from(manifest.len()).unwrap_or(i64::MAX),
        bytes: i64::try_from(plan.total_bytes.saturating_add(marker.len() as u64))
            .unwrap_or(i64::MAX),
    })
}

impl Workspace {
    /// The attempt's clock. Test builds only: a room a test gave `test_release_upload_clock (step_ms)` runs its
    /// attempts by a clock that moves on by that much each time it is read, so a deadline is reached without waiting.
    fn upload_attempt(&self) -> Attempt {
        #[cfg(feature = "failpoints")]
        {
            let sql = self.state.storage().sql();
            let stepped = rows(
                &sql,
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_release_upload_clock'",
                vec![],
            )
            .is_ok_and(|found| !found.is_empty());
            if stepped {
                let step = rows(
                    &sql,
                    "SELECT step_ms FROM test_release_upload_clock",
                    vec![],
                )
                .ok()
                .and_then(|found| found.first().map(|row| int(&row["step_ms"])))
                .unwrap_or(0);
                let read = std::cell::Cell::new(0_i64);
                let base = Date::now().as_millis() as i64;
                return Attempt::starting(Box::new(move || {
                    read.set(read.get() + 1);
                    base + step * (read.get() - 1)
                }));
            }
        }
        Attempt::by_the_clock()
    }

    /// The provider to upload to. Test builds only: a room a test gave `test_release_upload_provider` uploads to the
    /// test Worker's provider though the room's applier and delete job have none (`test_content_provider_off`), so an
    /// upload's test asks the stand-in for nothing but the upload.
    pub(super) fn upload_provider(&self) -> Option<Provider> {
        let sql = self.state.storage().sql();
        #[cfg(feature = "failpoints")]
        if rows(
            &sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_release_upload_provider'",
            vec![],
        )
        .is_ok_and(|found| !found.is_empty())
        {
            return Provider::from_env(&self.env);
        }
        takedown::provider(&self.env, &sql)
    }

    /// Test builds only: a test changes the room after the files are sent and before the room is asked again, by
    /// leaving statements for the room to run here, in `test_release_upload_before_check (statement)`.
    #[cfg(feature = "failpoints")]
    fn test_before_check(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if rows(
            &sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_release_upload_before_check'",
            vec![],
        )?
        .is_empty()
        {
            return Ok(());
        }
        for row in rows(
            &sql,
            "SELECT statement FROM test_release_upload_before_check ORDER BY rowid",
            vec![],
        )? {
            exec(&sql, row["statement"].as_str().unwrap_or_default(), vec![])?;
        }
        exec(&sql, "DROP TABLE test_release_upload_before_check", vec![])
    }

    /// One transaction of the upload's own, answering what the room decided.
    async fn upload_check(&self, release_id: &str, reads: Reads, whole: bool) -> R<UploadReady> {
        let found: Rc<RefCell<Option<UploadReady>>> = Rc::new(RefCell::new(None));
        let slot = found.clone();
        let id = release_id.to_owned();
        self.release_transaction(move |sql| {
            *slot.borrow_mut() = Some(upload_ready(sql, &id, &reads, whole, release_now(sql))?);
            Ok(Value::Null)
        })
        .await?;
        let ready = found.borrow_mut().take();
        ready.ok_or_else(|| ApiError::internal("an upload check that answered nothing"))
    }

    /// The release as it is, with why its upload waits.
    fn upload_waiting(&self, release_id: &str, code: &str, retry_at: Option<i64>) -> R<Value> {
        let sql = self.state.storage().sql();
        let release =
            release_recheck::release_row(&sql, release_id)?.ok_or_else(ApiError::not_found)?;
        // Only a release still uploading, with nothing on record, waits. One that ended meanwhile, or that another
        // attempt recorded, is answered as it is.
        let recorded = release_commit::uploaded(
            &sql,
            release_id,
            release["script_name"].as_str().unwrap_or_default(),
        )?;
        if state_of(&release)? != ReleaseState::Uploading || recorded {
            return upload_answer(&sql, &release, false);
        }
        let mut out = upload_answer(&sql, &release, true)?;
        out["waiting"] = code.into();
        if let Some(at) = retry_at {
            out["retry_at"] = at.into();
        }
        console_log!(
            "release: an upload waits: release={} code={}",
            release_id,
            code
        );
        Ok(out)
    }

    /// `{ release_id }`: reads one release's files and uploads them as its script (M6 step 5).
    /// Answers `{ release_id, state, rechecked, reason, uploaded }`, with `waiting` and a code when nothing was
    /// decided and the command is to be asked again. See the module's note for the order.
    pub(super) async fn release_upload(&self, mut req: Request) -> R<Value> {
        let (release_id, release) = self.named_release(&mut req).await?;
        self.upload_of(release_id, release, None).await
    }

    /// [`Workspace::release_upload`] for a release already read, as the release job's driver asks it, with the step's
    /// lease: asked before each thing asked outside the room, the reads, the read budget, GitHub's token, the session,
    /// each bucket and the script's write. Once it has run out, nothing more is asked and the release waits,
    /// `release_driver::LEASE_LOST`. A script already written is still recorded: that is the provider's fact.
    pub(super) async fn upload_of(
        &self,
        release_id: String,
        release: Value,
        lease: Option<&release_driver::StepLease>,
    ) -> R<Value> {
        let sql = self.state.storage().sql();
        if state_of(&release)? != ReleaseState::Uploading {
            return upload_answer(&sql, &release, false);
        }
        let go_on = || release_driver::may_go_on(&sql, lease);
        if !go_on() {
            return self.upload_waiting(&release_id, release_driver::LEASE_LOST, None);
        }
        let reads = self.release_reads(&release_id).await?;
        let (script, repo_id, commit_sha) =
            match self.upload_check(&release_id, reads, true).await? {
                UploadReady::Answer(answer) => return Ok(answer),
                UploadReady::Go {
                    script,
                    repo_id,
                    commit_sha,
                } => (script, repo_id, commit_sha),
            };
        let Some(provider) = self.upload_provider() else {
            return self.upload_waiting(&release_id, NO_PROVIDER, None);
        };
        let Some(app) = ReleaseApp::from_env(&self.env) else {
            return self.upload_waiting(&release_id, ReadProblem::NotConfigured.code(), None);
        };
        let attempt = self.upload_attempt();
        if !go_on() {
            return self.upload_waiting(&release_id, release_driver::LEASE_LOST, None);
        }
        // The two tree reads are reserved before the token is asked for, so a read that ends at them is counted.
        let sent = match reserve(&self.env, &release_id, TREE_READS, &attempt).await {
            Err(failure) => Err(Stop::Read(failure)),
            Ok(()) => match ReleaseReader::open(&app, repo_id, &attempt).await {
                Err(failure) => Err(Stop::Read(failure)),
                Ok(reader) => {
                    let sent = send_files(
                        &self.env,
                        &provider,
                        &reader,
                        &attempt,
                        &release_id,
                        &script,
                        &commit_sha,
                        &go_on,
                    )
                    .await;
                    // Every way out of the read ends here: the token is revoked before anything else is done.
                    reader.close().await;
                    sent
                }
            },
        };
        let complete = match sent {
            Ok(complete) => complete,
            Err(Stop::Read(failure)) if failure.fails_release() => {
                let id = release_id.clone();
                return self
                    .release_transaction(move |sql| {
                        upload_failed(sql, &id, failure.code(), release_now(sql))
                    })
                    .await;
            }
            Err(Stop::Read(failure)) => {
                let retry_at = match failure {
                    ReadFailure::Budget { retry_at } => retry_at,
                    _ => None,
                };
                return self.upload_waiting(&release_id, failure.code(), retry_at);
            }
            Err(Stop::Provider) => {
                return self.upload_waiting(&release_id, UPLOAD_UNAVAILABLE, None)
            }
            Err(Stop::Lease) => {
                return self.upload_waiting(&release_id, release_driver::LEASE_LOST, None)
            }
        };
        #[cfg(feature = "failpoints")]
        self.test_before_check()?;
        // The room again, before anything exists under the script's name: **the whole recheck, on outside facts read
        // afresh,** the stop for the whole content domain, the organization's switch and the deployment's setting
        // among them, and the room's rows and epoch now. A stop set while the files were sent ends the release
        // here, with no script written; a fact that can't be read leaves it undecided, and nothing is written.
        if !go_on() {
            return self.upload_waiting(&release_id, release_driver::LEASE_LOST, None);
        }
        let reads = self.release_reads(&release_id).await?;
        if let UploadReady::Answer(answer) = self.upload_check(&release_id, reads, true).await? {
            return Ok(answer);
        }
        #[cfg(feature = "failpoints")]
        self.test_between_reads().await?;
        if !go_on() {
            return self.upload_waiting(&release_id, release_driver::LEASE_LOST, None);
        }
        let written = provider
            .write_script(&script, &complete.token, &attempt)
            .await
            == Written::Yes;
        let id = release_id.clone();
        let recorded = self
            .release_transaction(move |sql| {
                record_uploaded(
                    sql,
                    &id,
                    &script,
                    written,
                    complete.files,
                    complete.bytes,
                    release_now(sql),
                )
            })
            .await?;
        if !written && recorded["state"] == ReleaseState::Uploading.name() {
            return self.upload_waiting(&release_id, UPLOAD_UNAVAILABLE, None);
        }
        Ok(recorded)
    }
}
