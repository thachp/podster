//! Reading a release's files and uploading them as its own script (M6 step 5; ADR 0010's "The release job", steps 1
//! to 4). *Since S2 of the store plan (2026-11-17):* a release whose manifest asks for its app's store has the store
//! made after the first pass of its read and before anything is sent to the provider; and a release whose own last
//! step waited on its store settles its label's create outstanding before anything is read (`release_store`). A
//! release that asks for no store is never held by one.
//!
//! *Since S3 (2026-11-17):* **a release that carries code** (`podster_core::app_code::upload_form`) uploads its static
//! files as files, its modules as the script's parts (fetched a second time before the token is revoked, and held for
//! the write), and its manifest as neither; one that carries code and fails core's checks fails by the problem's code
//! and nothing is sent. Its script is bound to exactly what the room's record of its store gives (rule 3(a)), read in
//! the transaction of step 5, which also records the script's kind before it is written (`write_check`). A static
//! release is uploaded exactly as before.
//!
//! *Since 2026-11-23:* **the gate for apps with code** (`podster_core::app_code::CODE_RELEASES_COMPLETE`, false) is
//! apart from the release path's. While it is closed, a release that carries code, or whose tree tries to, fails
//! `release_code_not_available` at the same point, before its store or anything else is asked for, so the release
//! path can open for static sites alone (`code_releases_open`).
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
//!    room's rows and epoch now. If it doesn't hold, nothing is written. If it does, the same transaction reads the
//!    store's binding from the room's record and records the script's kind (S3).
//! 6. **The script is written,** from the provider's completion token, which it gives only once it holds every file
//!    the manifest names. So a script is never part of a release.
//! 7. **The room records the upload,** or, if the release ended while the script was being written, owes the script
//!    its deletion again (`release_commit::record_uploaded`). An answer that may follow a write that went through, and
//!    isn't the one that says written, makes the release `uncertain` (`release_settle`).
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
//! **An upload whose answer was lost** at the script's write leaves the release `uncertain` (step 7), and the same
//! command, asked again, settles it by the provider's own read of the script instead of uploading (`release_settle`).
//! The marker's wait is `release_marker`'s.
//!
//! Logs carry the room's and the release's IDs and codes. No token, path or file name is logged.
use super::release_commit::{
    record_script_kind, record_uploaded, upload_answer, upload_failed, upload_ready, UploadReady,
    SCRIPT_KIND_CHANGED,
};
use super::release_recheck::{release_now, state_of, Reads};
use super::release_store::StoreOutcome;
use super::*;
use crate::content_provider::upload::ScriptCode;
use crate::content_provider::upload::{BucketBody, ManifestFile, Sent};
use crate::content_provider::Provider;
use crate::github::release_read::{
    hash_of, reserve, Attempt, ReadFailure, ReadFile, ReadPlan, ReleaseApp, ReleaseReader,
};
use podster_core::app_code::{
    admit, upload_form, CodeProblem, UploadForm, MANIFEST_PATH, MAX_MANIFEST_BYTES,
};
use podster_core::app_requests::HostKind;
use podster_core::app_store::Binding;
use podster_core::release::{
    fetch_batches, file_reads, upload_requests, ReleaseState, FETCH_PASSES, TREE_READS,
};
use podster_core::release_tree::{
    marker_body, FetchMismatch, PlannedFile, ReadProblem, ReleasePlan, MARKER_PATH, MARKER_TYPE,
};
use podster_core::release_uncertain::{script_write_outcome, WriteOutcome};

/// The room's path for uploading a release's files. Nothing outside the Worker reaches it; the job's driver asks the
/// same command directly.
pub(crate) const INTERNAL_RELEASE_UPLOAD: &str = "/internal/release-upload";
/// `waiting`, when the deployment has no provider to upload to; and the driver's code while it idles for that.
pub(super) const NO_PROVIDER: &str = podster_core::release_driver::NO_CONTENT_PROVIDER;
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
    /// The app's store said the upload doesn't go on (`release_store`).
    Store(StoreOutcome),
    /// The release carries code and fails core's checks (`podster_core::app_code::upload_form`): it fails by the
    /// problem's code, and is never uploaded as static files.
    Code(&'static str),
    /// The room couldn't be read or written.
    Room(ApiError),
}

impl From<ReadFailure> for Stop {
    fn from(failure: ReadFailure) -> Stop {
        Stop::Read(failure)
    }
}

/// Everything the provider holds for one release, ready to be written as its script, with the modules of one that
/// carries code.
struct Complete {
    token: String,
    files: i64,
    bytes: i64,
    code: Option<CodeParts>,
}

/// A release's code, held from its second fetch to the script's write: at most `MAX_MODULES_BYTES` of modules.
struct CodeParts {
    main: String,
    modules: Vec<(String, Vec<u8>)>,
    wants_store: bool,
}

/// What the room said just before the script's write.
enum WriteReady {
    /// Write it, bound to this, or to nothing.
    Go(Option<Binding>),
    /// The command ends with this answer: the recheck ended the release, it is no longer uploading, or it failed here.
    Answer(Value),
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

/// The first pass's yield: the plan, every file's hash, and the app's manifest's bytes if the release has one.
struct FirstPass {
    plan: ReadPlan,
    hashes: Vec<String>,
    manifest: Option<Vec<u8>>,
}

impl FirstPass {
    /// How the release is uploaded, or why it fails (`podster_core::app_code::upload_form`), from the tree and the
    /// manifest's bytes as fetched and checked. A release that carries code and fails core's checks fails by the
    /// problem's code (S2's question 2).
    fn form(&self) -> Result<UploadForm, CodeProblem> {
        let plan = ReleasePlan {
            files: self
                .plan
                .files
                .iter()
                .map(|file| PlannedFile {
                    path: file.path.clone(),
                    size: file.size,
                    sha: file.sha.clone(),
                })
                .collect(),
            total_bytes: self.plan.total_bytes,
        };
        upload_form(&plan, self.manifest.as_deref())
    }
}

/// Whether a release's script carries code, and whether it asks for its store.
fn kind_of(form: &UploadForm) -> (HostKind, bool) {
    match form {
        UploadForm::Static => (HostKind::Static, false),
        UploadForm::Code(release) => (HostKind::Code, release.wants_store),
    }
}

/// Step 2: the read, and the first pass, which hashes every file and keeps only the manifest's bytes (at most
/// `MAX_MANIFEST_BYTES`). The reader is the caller's to close. `go_on` is asked before each thing asked of the read
/// budget; once it says no, nothing more is (the driver's lease).
async fn read_files(
    env: &Env,
    reader: &ReleaseReader<'_>,
    attempt: &Attempt,
    release_id: &str,
    owner: &str,
    commit_sha: &str,
    go_on: &dyn Fn() -> bool,
) -> std::result::Result<FirstPass, Stop> {
    let check = || if go_on() { Ok(()) } else { Err(Stop::Lease) };
    // The token's mint took time: no tree is read once the step's lease has run out.
    check()?;
    let plan = reader.plan(commit_sha).await?;
    check()?;
    reserve(
        env,
        release_id,
        owner,
        file_reads(plan.count(), FETCH_PASSES),
        attempt,
    )
    .await?;
    // The first pass: every file's hash, from its own bytes. The bytes are dropped as each is hashed, but the
    // manifest's, which say whether the app asks for its store.
    let all: Vec<&ReadFile> = plan.files.iter().collect();
    let mut hashes: Vec<String> = Vec::with_capacity(all.len());
    let mut manifest = None;
    fetch_each(reader, &all, |place, hash, bytes| {
        let is_manifest = all
            .get(place)
            .is_some_and(|file| file.path == MANIFEST_PATH);
        if is_manifest && bytes.len() as u64 <= MAX_MANIFEST_BYTES {
            manifest = Some(bytes);
        }
        hashes.push(hash);
        Ok(())
    })
    .await?;
    Ok(FirstPass {
        plan,
        hashes,
        manifest,
    })
}

/// Step 3: the session and the buckets, after the first pass. The reader is the caller's to close. `go_on` is asked
/// before each thing asked of the provider; once it says no, nothing more is (the driver's lease).
#[allow(clippy::too_many_arguments)]
async fn send_files(
    provider: &Provider,
    reader: &ReleaseReader<'_>,
    attempt: &Attempt,
    release_id: &str,
    script: &str,
    commit_sha: &str,
    first: FirstPass,
    form: &UploadForm,
    go_on: &dyn Fn() -> bool,
) -> std::result::Result<Complete, Stop> {
    let check = || if go_on() { Ok(()) } else { Err(Stop::Lease) };
    let marker = marker_body(release_id, commit_sha).ok_or(Stop::Provider)?;
    let marker_hash = hash_of(MARKER_TYPE, marker.as_bytes()).ok_or(Stop::Provider)?;
    let FirstPass { plan, hashes, .. } = first;
    // Which of the plan's files are served as files: every one of a static release; only the static files of one that
    // carries code, so a module or the manifest is never a file anyone is served.
    let served = |path: &str| match form {
        UploadForm::Static => true,
        UploadForm::Code(release) => release.static_files.iter().any(|file| file.path == path),
    };
    let mut manifest: Vec<ManifestFile> = plan
        .files
        .iter()
        .zip(&hashes)
        .filter(|(file, _)| served(&file.path))
        .map(|(file, hash)| ManifestFile {
            path: format!("/{}", file.path),
            hash: hash.clone(),
            size: file.size,
        })
        .collect();
    let served_bytes = manifest
        .iter()
        .map(|file| file.size)
        .fold(0_u64, u64::saturating_add);
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
    let token = completion.ok_or(Stop::Provider)?;
    // A release that carries code: its modules, fetched a second time before the read's token is revoked, each
    // checked against the tree again and hashing as it did in the first pass, and held for the script's write.
    let code = match form {
        UploadForm::Static => None,
        UploadForm::Code(release) => {
            check()?;
            let mut places = Vec::with_capacity(release.modules.len());
            for module in &release.modules {
                let place = plan
                    .files
                    .iter()
                    .position(|file| file.path == module.file.path)
                    .ok_or(Stop::Provider)?;
                places.push(place);
            }
            let files: Vec<&ReadFile> = places
                .iter()
                .map(|place| plan.files.get(*place).ok_or(Stop::Provider))
                .collect::<std::result::Result<_, Stop>>()?;
            let mut modules: Vec<(String, Vec<u8>)> = Vec::with_capacity(files.len());
            fetch_each(reader, &files, |at, hash, bytes| {
                let (Some(module), Some(place)) = (release.modules.get(at), places.get(at)) else {
                    return Err(Stop::Provider);
                };
                if hashes.get(*place) != Some(&hash) {
                    return Err(Stop::Read(ReadFailure::Mismatch(FetchMismatch::Sha)));
                }
                modules.push((module.name.clone(), bytes));
                Ok(())
            })
            .await?;
            Some(CodeParts {
                main: release.main.clone(),
                modules,
                wants_store: release.wants_store,
            })
        }
    };
    let module_bytes = code.as_ref().map_or(0_u64, |code| {
        code.modules
            .iter()
            .map(|(_, bytes)| bytes.len() as u64)
            .fold(0, u64::saturating_add)
    });
    let module_count = code.as_ref().map_or(0, |code| code.modules.len());
    Ok(Complete {
        token,
        files: i64::try_from(manifest.len().saturating_add(module_count)).unwrap_or(i64::MAX),
        bytes: i64::try_from(
            served_bytes
                .saturating_add(module_bytes)
                .saturating_add(marker.len() as u64),
        )
        .unwrap_or(i64::MAX),
        code,
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

    /// **The gate for apps with code** (`podster_core::app_code::CODE_RELEASES_COMPLETE`), alone: closed everywhere while
    /// it is false, whatever the providers, `RELEASES` and the release path's own gate say, so a release that carries
    /// code fails `release_code_not_available` before any store is made or anything is sent. Test builds only: a room a
    /// test gave the table `test_code_release_open` has it open. A build without the `failpoints` feature never reads
    /// that table.
    fn code_releases_open(&self) -> bool {
        if podster_core::app_code::CODE_RELEASES_COMPLETE {
            return true;
        }
        #[cfg(feature = "failpoints")]
        {
            rows(
                &self.state.storage().sql(),
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_code_release_open'",
                vec![],
            )
            .is_ok_and(|found| !found.is_empty())
        }
        #[cfg(not(feature = "failpoints"))]
        {
            false
        }
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

    /// **The room's transaction just before the script is written** (step 5): the whole recheck again, on outside facts
    /// read afresh; and, if it holds, in the same transaction, **the binding, from the room's own record of its store
    /// and nothing else** (rule 3(a); `release_store::script_binding_for`), and **the record of the script's kind**
    /// (`release_commit::record_script_kind`), so no script with code is ever written that the room doesn't know as
    /// code. A release that asks for its store and whose record binds nothing fails by that code, and nothing is
    /// written.
    async fn write_check(
        &self,
        release_id: &str,
        label: &str,
        script: &str,
        reads: Reads,
        form: (HostKind, bool),
    ) -> R<WriteReady> {
        let found: Rc<RefCell<Option<WriteReady>>> = Rc::new(RefCell::new(None));
        let slot = found.clone();
        let (id, label, script) = (release_id.to_owned(), label.to_owned(), script.to_owned());
        let (kind, wants_store) = form;
        self.release_transaction(move |sql| {
            let now = release_now(sql);
            let ready = match upload_ready(sql, &id, &reads, true, now)? {
                UploadReady::Answer(answer) => WriteReady::Answer(answer),
                UploadReady::Go { .. } => {
                    match release_store::script_binding_for(sql, &id, &label, wants_store)? {
                        Err(why) => WriteReady::Answer(upload_failed(sql, &id, why.code(), now)?),
                        Ok(_) if !record_script_kind(sql, &id, &script, kind, now)? => {
                            WriteReady::Answer(upload_failed(sql, &id, SCRIPT_KIND_CHANGED, now)?)
                        }
                        Ok(binding) => WriteReady::Go(binding),
                    }
                }
            };
            *slot.borrow_mut() = Some(ready);
            Ok(Value::Null)
        })
        .await?;
        let ready = found.borrow_mut().take();
        ready.ok_or_else(|| ApiError::internal("a write check that answered nothing"))
    }

    /// Whether the step may go on after the reservation: its lease still holds. Test builds only: a test changes the
    /// room here first (`release_driver::test_at`, at `reserved`).
    fn may_open(&self, sql: &SqlStorage, go_on: &dyn Fn() -> bool) -> bool {
        #[cfg(feature = "failpoints")]
        release_driver::test_at(sql, "reserved");
        let _ = sql;
        go_on()
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

    /// What the app's store step said, as the upload's answer: a wait, or the release failed by its code, or the
    /// recheck's own answer.
    async fn store_answer(&self, release_id: &str, outcome: StoreOutcome) -> R<Value> {
        match outcome {
            StoreOutcome::Answer(answer) => Ok(answer),
            StoreOutcome::Wait(code, retry_at) => self.upload_waiting(release_id, code, retry_at),
            StoreOutcome::Fail(code) => {
                let id = release_id.to_owned();
                self.release_transaction(move |sql| upload_failed(sql, &id, code, release_now(sql)))
                    .await
            }
            StoreOutcome::Go => Err(ApiError::internal(
                "a store step that goes on, answered as if it stopped",
            )),
        }
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
        match state_of(&release)? {
            ReleaseState::Uploading => {}
            // An upload whose answer was lost is settled by the provider's read, and nothing is uploaded.
            ReleaseState::Uncertain => return self.settle_of(release_id, release, lease).await,
            _ => return upload_answer(&sql, &release, false),
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
        // The app's store first, for a release whose last step waited on it: its label's create outstanding is settled
        // by the list, and nothing is read from GitHub in this step (`release_store`).
        let label = text(&release["label"]).unwrap_or_default();
        if let Some(outcome) = self.store_settle_first(&release_id, &label, lease).await? {
            return self.store_answer(&release_id, outcome).await;
        }
        let Some(provider) = self.upload_provider() else {
            return self.upload_waiting(&release_id, NO_PROVIDER, None);
        };
        let Some(app) = ReleaseApp::from_env(&self.env) else {
            return self.upload_waiting(&release_id, ReadProblem::NotConfigured.code(), None);
        };
        // The owner the reads are charged to, from the room's own row: never from a request.
        let owner = release_driver::read_owner(&sql)?;
        let attempt = self.upload_attempt();
        if !go_on() {
            return self.upload_waiting(&release_id, release_driver::LEASE_LOST, None);
        }
        // The two tree reads are reserved before the token is asked for, so a read that ends at them is counted.
        let sent = match reserve(&self.env, &release_id, &owner, TREE_READS, &attempt).await {
            Err(failure) => Err(Stop::Read(failure)),
            // The reservation took time: no token is asked of GitHub once the step's lease has run out.
            Ok(()) if !self.may_open(&sql, &go_on) => Err(Stop::Lease),
            Ok(()) => match ReleaseReader::open(&app, repo_id, &attempt).await {
                Err(failure) => Err(Stop::Read(failure)),
                Ok(reader) => {
                    #[cfg(feature = "failpoints")]
                    release_driver::test_at(&sql, "opened");
                    let sent = match read_files(
                        &self.env,
                        &reader,
                        &attempt,
                        &release_id,
                        &owner,
                        &commit_sha,
                        &go_on,
                    )
                    .await
                    {
                        Err(stop) => Err(stop),
                        // What is uploaded, from the tree and the manifest: while the gate for apps with code is
                        // closed, a release that carries code, or tries to, fails `release_code_not_available`; with
                        // it open, one that fails core's checks fails by the problem's code. Either way nothing is
                        // sent and no store is made.
                        Ok(first) => match admit(first.form(), self.code_releases_open()) {
                            Err(problem) => Err(Stop::Code(problem.code())),
                            // The app's store, for a release that asks for one, before anything is sent to the
                            // provider.
                            Ok(form) => match self
                                .store_before_upload(&release_id, &label, kind_of(&form).1, lease)
                                .await
                            {
                                Err(error) => Err(Stop::Room(error)),
                                Ok(StoreOutcome::Go) => {
                                    send_files(
                                        &provider,
                                        &reader,
                                        &attempt,
                                        &release_id,
                                        &script,
                                        &commit_sha,
                                        first,
                                        &form,
                                        &go_on,
                                    )
                                    .await
                                }
                                Ok(outcome) => Err(Stop::Store(outcome)),
                            },
                        },
                    };
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
            Err(Stop::Store(outcome)) => return self.store_answer(&release_id, outcome).await,
            Err(Stop::Code(code)) => {
                let id = release_id.clone();
                return self
                    .release_transaction(move |sql| upload_failed(sql, &id, code, release_now(sql)))
                    .await;
            }
            Err(Stop::Room(error)) => return Err(error),
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
        let form = match &complete.code {
            None => (HostKind::Static, false),
            Some(code) => (HostKind::Code, code.wants_store),
        };
        let binding = match self
            .write_check(&release_id, &label, &script, reads, form)
            .await?
        {
            WriteReady::Answer(answer) => return Ok(answer),
            WriteReady::Go(binding) => binding,
        };
        #[cfg(feature = "failpoints")]
        self.test_between_reads().await?;
        if !go_on() {
            return self.upload_waiting(&release_id, release_driver::LEASE_LOST, None);
        }
        // A part boundary drawn for this write alone: a module's bytes are agent content.
        let boundary = match &complete.code {
            None => String::new(),
            Some(_) => {
                let drawn = super::hostname::random_32()?;
                let hex: String = drawn
                    .iter()
                    .take(16)
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                format!("podster-script-{hex}")
            }
        };
        let code = complete.code.as_ref().map(|code| ScriptCode {
            main: &code.main,
            modules: &code.modules,
            binding: binding.as_ref(),
            boundary: &boundary,
        });
        let written = script_write_outcome(
            provider
                .write_script(&script, &complete.token, code.as_ref(), &attempt)
                .await,
        );
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
        if written == WriteOutcome::NotWritten
            && recorded["state"] == ReleaseState::Uploading.name()
        {
            return self.upload_waiting(&release_id, UPLOAD_UNAVAILABLE, None);
        }
        Ok(recorded)
    }
}
