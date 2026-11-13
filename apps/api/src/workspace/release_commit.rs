//! Starting a release's upload, committing it live, and ending one that can't go on (M6 step 5, second PR; ADR 0010's
//! "The release job", steps 1 and 5, and "Publishing and unpublishing, in order").
//!
//! Three room commands' worth, all behind the recheck in [`release_recheck`]. Nothing calls them yet: the release job
//! will. Nothing here reads a repository, uploads a file or asks the provider anything.
//!
//! - **Start an upload** ([`start_upload`]). A queued release whose recheck holds becomes `uploading`: the room names
//!   its script, from its label and its own ID, and records when the upload began, which is what the hourly reconcile
//!   keeps the script by.
//! - **Commit live,** in two room transactions with the outside reads between them.
//!   1. *Stage* ([`stage`]): on the room's own rows alone, core's `commit_live` sets every open host's desired script
//!      to this release's and opens the flight. The release stays `uploading`. **Nothing is served on it:** the
//!      applier writes a host's entry only for a release the room has recorded live
//!      (`takedown::apply_host`), so a staged host waits.
//!   2. *The outside reads,* made by this same command, after the stage: the deployment's switch, the stop, the
//!      organization's delegation, and each person's own record.
//!   3. *Confirm* ([`confirm`]): the whole recheck again, on those reads and the room's rows now. If it holds, the
//!      release becomes `live` and its hosts are due at once. If a fact that was read fails, the release ends failed
//!      and its hosts go back ([`fail`]). If nothing fails and something couldn't be read, nothing is decided: the
//!      stage stays, still unserved, and the command is asked again.
//!
//!   **Why the reads come after the stage.** A fact in another object can change at any moment, and the room can't
//!   read it inside its own transaction. So the order is what closes the window: from the stage on, the release is in
//!   the room's own state, where anything that unpublishes finds it and raises the epoch, which the confirm compares.
//!   And every outside fact is read after that point and before anything is served. A change before the reads is seen
//!   by them. A change after them is one that happened while the release was already staged in the room, which is
//!   the unpublish triggers' to act on: an unpublish clears the stage, and the stop is asked again by the applier
//!   itself before each write.
//!
//!   **What that leaves is owed to step 6, and it is most of the list.** Only an operator's suspension of the app
//!   unpublishes today. Until the other triggers are built, nothing acts on a change made after this command read
//!   the fact, and nothing at all once the release is `live`: the room archived, made private or suspended; release
//!   switched off; the repository's link lost; a grant revoked or a place in the room changed; a person's departure;
//!   the organization's delegation taken back. The outside reads are made one after another, the stop first and the
//!   two that nothing asks again last, so each one's window is as wide as the reads after it. **So `RELEASES` and a
//!   provider must not both be configured before step 6 has merged** (`docs/m6-plan.md`).
//!
//!   **The stage writes no event and no audit record.** It is half of one command: it ends as `release.live` or as
//!   `release.failed`, and until then it is in the room's serve state and nowhere else.
//!
//!   A commit never trusts an earlier pass: `rechecked: true` from the recheck or from starting the upload is an
//!   answer about then, and this command asks everything again itself.
//! - **Ending a release** ([`fail`]), for every command that does: the recheck, a refused commit, an upload past its
//!   hour ([`expire_uploads`]), and an unpublish, which ends every release that hadn't gone live under the epoch it
//!   raised from. The release's row, its hosts set back if it had been staged, the flight closed, and its script
//!   queued for deletion, in the caller's transaction, audited and told to the room's managers as Podster's act.
//!
//! **What this leaves for the job's own PR:** reading the tree, fetching and uploading; an upload whose answer was
//! lost and its settling (`uncertain`); waiting for the marker, recording a release served, and the set-back when the
//! marker never comes; and running a room's release jobs one at a time. A release that is `live` and never confirmed
//! served stays as it is until that is built or the room is unpublished. A stage nobody comes back to is ended when
//! its upload's hour is over, by the next release command, the reconcile's next question or the room's own alarm.
//!
//! Logs carry the room's and the release's IDs and codes.
use super::release_recheck::{
    answer, job_owns, judge, release_row, standing_unknown, state_of, Reads, Verdict,
};
use super::*;
use podster_core::release::{
    commit_live, next_state, script_name, script_owner, set_back, upload_expired,
    CommitLiveRefusal, ReleaseEvent, ReleaseState, ScriptOwner, ServeState, UploadFailure,
};

/// The room's path for starting a release's upload. Nothing outside the Worker reaches it, and nothing calls it yet.
pub(crate) const INTERNAL_RELEASE_START_UPLOAD: &str = "/internal/release-start-upload";
/// The room's path for committing a release live. Nothing outside the Worker reaches it, and nothing calls it yet.
pub(crate) const INTERNAL_RELEASE_COMMIT_LIVE: &str = "/internal/release-commit-live";

/// The applier's code for a host whose script belongs to a release the room hasn't recorded live.
pub(super) const NOT_CONFIRMED: &str = "release_not_confirmed";

/// Whether a label is the room's current one. Only a current label's script can be set on a host.
fn label_current(sql: &SqlStorage, label: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT 1 AS current FROM app_label WHERE label = ? AND current = 1",
        vec![label.into()],
    )?
    .is_empty())
}

/// Writes the room's serve state back whole, as core decided it: each host's script and version, the flight's mark
/// beside each host, the kept script and the flight. `names` are the hosts in the state's order, as `takedown::load`
/// gave them.
///
/// A script under a label that isn't the room's current one is never set on a host: that host is written as serving
/// nothing, at the version core gave it, and it is logged by its code. Nothing makes such a state today.
fn write_state(sql: &SqlStorage, names: &[String], state: &ServeState, now: i64) -> R<()> {
    let flight = state.in_flight.as_ref();
    for (i, (name, host)) in names.iter().zip(&state.hosts).enumerate() {
        let script = match host.script.as_deref().map(script_owner) {
            Some(ScriptOwner::Podster { label, release_id }) if label_current(sql, label)? => {
                Some((label, release_id))
            }
            Some(_) => {
                console_error!(
                    "release: a host's script wasn't under the room's current label, so the host serves nothing: code=script_label_not_current"
                );
                None
            }
            None => None,
        };
        let flight_version = flight
            .and_then(|f| f.mark.versions.get(i).copied().flatten())
            .map(takedown::to_stored);
        let flight_before = flight.and_then(|f| f.mark.before.get(i).cloned().flatten());
        exec(
            sql,
            "UPDATE serve_state SET label = ?, label_current = ?, release_id = ?, script_name = ?, version = ?, flight_version = ?,
               flight_before = ?, updated_at = ? WHERE host = ?",
            vec![
                script.map_or(V::Null, |(label, _)| label.into()),
                script.map_or(V::Null, |_| 1.into()),
                script.map_or(V::Null, |(_, release)| release.into()),
                script.map_or(V::Null, |(label, release)| {
                    format!("{label}.{release}").into()
                }),
                takedown::to_stored(host.version).into(),
                flight_version.map_or(V::Null, V::from),
                opt(&flight_before),
                now.into(),
                name.as_str().into(),
            ],
        )?;
    }
    match flight {
        Some(flight) => exec(
            sql,
            "UPDATE release_config SET kept_previous = ?, in_flight_release = ?, in_flight_script = ?, in_flight_epoch = ?,
               in_flight_at = coalesce(in_flight_at, ?), updated_at = ?",
            vec![
                opt(&state.kept_previous),
                flight.release_id.as_str().into(),
                flight.script.as_str().into(),
                takedown::to_stored(flight.mark.epoch).into(),
                now.into(),
                now.into(),
            ],
        ),
        None => exec(
            sql,
            "UPDATE release_config SET kept_previous = ?, in_flight_release = NULL, in_flight_script = NULL, in_flight_epoch = NULL,
               in_flight_at = NULL, updated_at = ?",
            vec![opt(&state.kept_previous), now.into()],
        ),
    }
}

/// Queues a release's own script for deletion at `now`, under the unpublish that ended it if one did. A script
/// already queued stays as it was queued. Only a name Rust made is ever queued.
fn queue_script(sql: &SqlStorage, script: &str, under: Option<i64>, now: i64) -> R<()> {
    let ScriptOwner::Podster { label, .. } = script_owner(script) else {
        console_error!("release: a release's script wasn't queued: code=foreign_script");
        return Ok(());
    };
    exec(
        sql,
        "INSERT INTO script_delete (script_name, label, unpublish_epoch, queued_at, next_attempt_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (script_name) DO NOTHING",
        vec![
            script.into(),
            label.into(),
            under.map_or(V::Null, V::from),
            now.into(),
            now.into(),
        ],
    )
}

/// Ends a release as failed, with a reason's code, inside the caller's transaction. Everything a failed release
/// leaves behind is undone here, so no caller has to remember part of it:
///
/// - the release's row: failed, the reason, and when;
/// - **if it had been staged or committed,** which is when the room's flight is this release's: each host goes back to
///   what it served before, by core's `set_back`, host by host and only where the host is still what the commit
///   wrote, and the flight is closed;
/// - **if it has a script of its own,** which is from the moment its upload started: the script is queued for
///   deletion, whether or not anything was ever uploaded under that name, under the unpublish that ended the release
///   (`under`) if one did. The delete job waits for every host's entry to match first. **Only a script named after
///   this release is queued:** a rollback's record (step 6) names the script of the release it rolls back to, which
///   is the room's kept script and not the failed record's to delete, as core's `set_back` says of it;
/// - an audit record and an event, `release.failed`, naming the release and the reason, as Podster's act.
///
/// A release that has already ended is left as it is, and so is one that is served: neither can fail.
pub(super) fn fail(
    sql: &SqlStorage,
    release_id: &str,
    reason: &str,
    under: Option<i64>,
    now: i64,
) -> R<()> {
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let state = state_of(&release)?;
    let Ok(failed) = next_state(state, ReleaseEvent::Fail) else {
        return Ok(());
    };
    exec(
        sql,
        "UPDATE release SET state = ?, failure_code = ?, finished_at = ?, updated_at = ? WHERE id = ?",
        vec![
            failed.name().into(),
            reason.into(),
            now.into(),
            now.into(),
            release_id.into(),
        ],
    )?;
    if let Some(script) = text(&release["script_name"]) {
        if let Some(loaded) = takedown::load(sql)? {
            let flight = loaded
                .state
                .in_flight
                .as_ref()
                .filter(|flight| flight.release_id == release_id);
            if let Some(flight) = flight {
                // The flight is the state's own, so core can't call this stale.
                let back = set_back(&loaded.state, &flight.mark, &flight.script)
                    .map_err(|_| ApiError::internal("the room's own flight was stale"))?;
                write_state(sql, &loaded.hosts, &back.state, now)?;
            }
        }
        if release["script_release_id"].as_str() == Some(release_id) {
            queue_script(sql, &script, under, now)?;
        }
    }
    audit_as(
        sql,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        "release.failed",
        release_id,
        Some(json!({ "state": state.name() }).to_string()),
        Some(json!({ "state": failed.name(), "reason": reason }).to_string()),
        now,
    )?;
    // The event names the release it is about, by its ID, and the reason, by its code.
    store::record_event_about(
        sql,
        "release.failed",
        moderation::PODSTER,
        Some(release_id),
        None,
        &Transition {
            reason: Some(reason),
            ..Transition::NONE
        },
        roles::room_managers(sql, moderation::PODSTER)?,
        now,
    )
}

/// Ends every release still uploading, or whose upload is still uncertain, an hour after its upload began
/// (`podster_core::release::upload_expired`): the bound the hourly reconcile keeps its script by. Past it the script
/// is no longer kept, so the release must never go live. Run at the start of every release command's transaction and
/// whenever the reconcile asks the room anything. Answers how many it ended.
pub(super) fn expire_uploads(sql: &SqlStorage, now: i64) -> R<usize> {
    let mut ended = 0;
    for release in rows(
        sql,
        "SELECT id, coalesce(upload_started_at, updated_at) AS since FROM release WHERE state IN ('uploading', 'uncertain') ORDER BY seq",
        vec![],
    )? {
        let Some(id) = text(&release["id"]) else {
            continue;
        };
        if upload_expired(int(&release["since"]), now) {
            fail(sql, &id, UploadFailure::Expired.code(), None, now)?;
            ended += 1;
        }
    }
    Ok(ended)
}

/// Ends every release that hadn't gone live and started under an epoch below `epoch`, the one an unpublish just
/// raised to: awaiting approval, queued, uploading or uncertain. None of them can ever be committed, so none is left
/// for someone to approve or for a job that may never come back. A script one of them had is queued under this
/// unpublish, so the unpublish isn't done with its files until that script is gone too.
///
/// **At the epoch's ceiling** the epoch can't go up, so a release started at the ceiling isn't ended here. It can
/// never go live either: core refuses every commit at the ceiling.
///
/// **How many.** Each one ended writes an audit record and an event in the unpublish's own transaction. A room takes
/// 20 requests a day (`MAX_RELEASES_PER_ROOM_PER_DAY`), which step 6 enforces where it takes them, and each is ended
/// by the first unpublish after it, so one unpublish ends at most what was asked for since the last.
pub(super) fn end_at_unpublish(sql: &SqlStorage, epoch: i64, now: i64) -> R<()> {
    for release in rows(
        sql,
        "SELECT id FROM release WHERE state IN ('awaiting_approval', 'queued', 'uploading', 'uncertain') AND release_epoch < ? ORDER BY seq",
        vec![epoch.into()],
    )? {
        if let Some(id) = text(&release["id"]) {
            fail(sql, &id, CommitLiveRefusal::EpochMoved.code(), Some(epoch), now)?;
        }
    }
    Ok(())
}

fn record(sql: &SqlStorage, kind: &str, release_id: &str, from: &str, to: &str, now: i64) -> R<()> {
    audit_as(
        sql,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        kind,
        release_id,
        Some(json!({ "state": from }).to_string()),
        Some(json!({ "state": to }).to_string()),
        now,
    )?;
    store::record_event_about(
        sql,
        kind,
        moderation::PODSTER,
        Some(release_id),
        None,
        &Transition::NONE,
        roles::room_managers(sql, moderation::PODSTER)?,
        now,
    )
}

/// The answer after a failure, from the release's row as it now is.
fn failed(sql: &SqlStorage, release_id: &str, reason: &str, now: i64) -> R<Value> {
    fail(sql, release_id, reason, None, now)?;
    let after = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    Ok(answer(&after, true, Some(reason)))
}

/// Starts a release's upload, inside the room's transaction: the recheck, and, if it holds, a queued release becomes
/// `uploading`, with its script's name and the time. Asked again for one already uploading, or whose upload is
/// uncertain, it is the recheck and the same script's name, and nothing changes. Any other release is answered as it
/// is. Answers `{ release_id, state, rechecked, reason, script }`.
pub(super) fn start_upload(
    sql: &SqlStorage,
    release_id: &str,
    reads: &Reads,
    now: i64,
) -> R<Value> {
    expire_uploads(sql, now)?;
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let state = state_of(&release)?;
    let with_script = |mut answer: Value, script: Option<String>| {
        answer["script"] = script.map_or(Value::Null, Value::from);
        answer
    };
    if !job_owns(state) {
        return Ok(with_script(answer(&release, false, None), None));
    }
    match judge(sql, &release, reads, now)? {
        Verdict::Unknown => return Err(standing_unknown()),
        Verdict::Fails(reason) => {
            return Ok(with_script(failed(sql, release_id, reason, now)?, None))
        }
        Verdict::Holds => {}
    }
    if state != ReleaseState::Queued {
        return Ok(with_script(
            answer(&release, true, None),
            text(&release["script_name"]),
        ));
    }
    let label = text(&release["label"]).unwrap_or_default();
    if !label_current(sql, &label)? {
        let reason = UploadFailure::LabelRetired.code();
        return Ok(with_script(failed(sql, release_id, reason, now)?, None));
    }
    let script = script_name(&label, release_id)
        .map_err(|_| ApiError::internal("a release whose script can't be named"))?;
    let uploading = next_state(state, ReleaseEvent::StartUpload)
        .map_err(|_| ApiError::internal("a queued release that can't start"))?;
    exec(
        sql,
        "UPDATE release SET state = ?, script_name = ?, script_release_id = ?, upload_started_at = ?, updated_at = ? WHERE id = ?",
        vec![
            uploading.name().into(),
            script.as_str().into(),
            release_id.into(),
            now.into(),
            now.into(),
            release_id.into(),
        ],
    )?;
    record(
        sql,
        "release.upload_started",
        release_id,
        state.name(),
        uploading.name(),
        now,
    )?;
    let after = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    Ok(with_script(answer(&after, true, None), Some(script)))
}

/// What the first of a commit's two transactions did.
pub(super) enum Staged {
    /// The release's hosts name its script and the flight is its own. The outside reads and the confirm come next.
    Staged,
    /// The command ends here, with this answer: the release isn't uploading, it failed, or another flight is open.
    Answer(Value),
}

/// The first transaction of a commit: on the room's own rows alone, stage the release on its hosts.
///
/// - A release that isn't `uploading` is answered as it is.
/// - The recheck, with every outside fact unknown: a fact of the room's own that fails ends the release here, before
///   anything is asked of anyone.
/// - A script queued for deletion never goes on a host, whatever queued it and whether or not it is gone yet.
/// - Core's `commit_live`, under the epoch the release started under. Its retry, for the release whose flight is
///   already open, changes nothing. While another release's flight is open the answer is `waiting`, and nothing is
///   decided: the job asks again. Any other refusal ends the release.
pub(super) fn stage(sql: &SqlStorage, release_id: &str, now: i64) -> R<Staged> {
    expire_uploads(sql, now)?;
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let state = state_of(&release)?;
    if state != ReleaseState::Uploading {
        return Ok(Staged::Answer(answer(&release, false, None)));
    }
    if let Verdict::Fails(reason) = judge(sql, &release, &Reads::nothing(), now)? {
        return Ok(Staged::Answer(failed(sql, release_id, reason, now)?));
    }
    let script = text(&release["script_name"])
        .ok_or_else(|| ApiError::internal("an uploading release with no script"))?;
    let queued = !rows(
        sql,
        "SELECT 1 AS queued FROM script_delete WHERE script_name = ?",
        vec![script.as_str().into()],
    )?
    .is_empty();
    if queued {
        let reason = UploadFailure::ScriptDeleted.code();
        return Ok(Staged::Answer(failed(sql, release_id, reason, now)?));
    }
    if !label_current(sql, &text(&release["label"]).unwrap_or_default())? {
        let reason = UploadFailure::LabelRetired.code();
        return Ok(Staged::Answer(failed(sql, release_id, reason, now)?));
    }
    let loaded =
        takedown::load(sql)?.ok_or_else(|| ApiError::internal("a release with no serve state"))?;
    let started_under = takedown::from_stored(int(&release["release_epoch"]));
    match commit_live(&loaded.state, started_under, &script, release_id, state) {
        Ok((after, _)) => {
            // A retry of the release whose flight is open gets the same state back, and writes nothing.
            if after != loaded.state {
                write_state(sql, &loaded.hosts, &after, now)?;
            }
            Ok(Staged::Staged)
        }
        Err(CommitLiveRefusal::InFlight) => {
            let mut waiting = answer(&release, false, None);
            waiting["waiting"] = CommitLiveRefusal::InFlight.code().into();
            Ok(Staged::Answer(waiting))
        }
        Err(refusal) => Ok(Staged::Answer(failed(
            sql,
            release_id,
            refusal.code(),
            now,
        )?)),
    }
}

/// The second transaction of a commit, after the outside reads: the whole recheck on those reads and the room's rows
/// now, and then the release is `live`, failed, or undecided.
///
/// - A release that isn't `uploading` any more is answered as it is: an unpublish between the two transactions ended
///   it, and set its hosts to nothing.
/// - One whose flight isn't its own any more isn't staged, and nothing is committed on it: `standing_unknown`, and
///   the command starts over.
/// - **Holds:** the release becomes `live`, and each host that waited for this is due at once.
/// - **A fact that was read fails:** the release ends failed, and its hosts go back.
/// - **Nothing fails and a fact couldn't be read:** `standing_unknown`. The stage stays, and nothing serves it.
pub(super) fn confirm(sql: &SqlStorage, release_id: &str, reads: &Reads, now: i64) -> R<Value> {
    expire_uploads(sql, now)?;
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let state = state_of(&release)?;
    if state != ReleaseState::Uploading {
        return Ok(answer(&release, false, None));
    }
    let staged = takedown::load(sql)?.is_some_and(|loaded| {
        loaded.state.in_flight.is_some_and(|flight| {
            flight.release_id == release_id
                && Some(flight.script.as_str()) == release["script_name"].as_str()
        })
    });
    if !staged {
        return Err(standing_unknown());
    }
    match judge(sql, &release, reads, now)? {
        Verdict::Unknown => Err(standing_unknown()),
        Verdict::Fails(reason) => failed(sql, release_id, reason, now),
        Verdict::Holds => {
            let live = next_state(state, ReleaseEvent::CommitLive)
                .map_err(|_| ApiError::internal("an uploading release that can't go live"))?;
            exec(
                sql,
                "UPDATE release SET state = ?, updated_at = ? WHERE id = ?",
                vec![live.name().into(), now.into(), release_id.into()],
            )?;
            // The hosts that waited for this: their wait is void, so the applier takes them on its next pass.
            exec(
                sql,
                "UPDATE serve_apply SET attempts = 0, attempt_version = NULL, next_attempt_at = NULL, last_code = NULL, updated_at = ?
                   WHERE last_code = ?",
                vec![now.into(), NOT_CONFIRMED.into()],
            )?;
            record(
                sql,
                "release.live",
                release_id,
                state.name(),
                live.name(),
                now,
            )?;
            let after = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
            Ok(answer(&after, true, None))
        }
    }
}

impl Workspace {
    /// `{ release_id }`: starts one release's upload (M6 step 5). Nothing calls it yet. The release's own state is
    /// read first, with no outside read for one that isn't the job's; then every outside fact; then the room's
    /// transaction. Nothing goes live on this, so one round of reads before the transaction is all it makes.
    pub(super) async fn release_start_upload(&self, mut req: Request) -> R<Value> {
        let (release_id, release) = self.named_release(&mut req).await?;
        if !job_owns(state_of(&release)?) {
            let mut as_is = answer(&release, false, None);
            as_is["script"] = Value::Null;
            return Ok(as_is);
        }
        let reads = self.release_reads(&release_id).await?;
        #[cfg(feature = "failpoints")]
        self.test_between_reads()?;
        self.release_transaction(move |sql| start_upload(sql, &release_id, &reads, now_ms()))
            .await
    }

    /// `{ release_id }`: commits one release live (M6 step 5). Nothing calls it yet. See the module's note for the
    /// order: the release's own state, the stage, the outside reads, the confirm.
    pub(super) async fn release_commit_live(&self, mut req: Request) -> R<Value> {
        let (release_id, release) = self.named_release(&mut req).await?;
        if state_of(&release)? != ReleaseState::Uploading {
            return Ok(answer(&release, false, None));
        }
        let staged: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = staged.clone();
        let id = release_id.clone();
        self.release_transaction(move |sql| {
            if let Staged::Answer(answer) = stage(sql, &id, now_ms())? {
                *slot.borrow_mut() = Some(answer);
            }
            Ok(Value::Null)
        })
        .await?;
        if let Some(answer) = staged.borrow_mut().take() {
            return Ok(answer);
        }
        // Asked only now, with the release already staged in the room's own state.
        let reads = self.release_reads(&release_id).await?;
        #[cfg(feature = "failpoints")]
        self.test_between_reads()?;
        self.release_transaction(move |sql| confirm(sql, &release_id, &reads, now_ms()))
            .await
    }
}
