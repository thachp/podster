//! Starting a release's upload, committing it live, and ending one that can't go on (M6 step 5, second PR; ADR 0010's
//! "The release job", steps 1 and 5, and "Publishing and unpublishing, in order").
//!
//! Three room commands' worth, all behind the recheck in [`release_recheck`]. The release job's driver
//! (`release_driver`) calls them. Nothing here reads a repository, uploads a file or asks the provider anything: the upload command that does
//! is `release_upload`, and what the room decides for it is here ([`upload_ready`], [`record_uploaded`]).
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
//!   **What that leaves is owed to step 6, and it is most of the list.** Only an operator's suspension of the app,
//!   and an operator's take of the organization's release switch (decision 218, `release_switch`), unpublish today. Until the other triggers are built, nothing acts on a change made after this command read
//!   the fact, and nothing at all once the release is `live`: the room archived, made private or suspended; release
//!   switched off; the repository's link lost; a grant revoked or a place in the room changed; a person's departure;
//!   the organization's delegation taken back. The outside reads are made one after another, the stop first and the
//!   two that nothing asks again last, so each one's window is as wide as the reads after it. **So `RELEASES` and a
//!   provider must not both be configured before step 6 has merged** (`docs/m6-plan.md`).
//!
//!   **The window between the outside reads and the confirm is accepted as built** (the architect's ruling,
//!   2026-11-13). No transaction spans two objects, so some window always exists. The stop is covered: the applier
//!   asks it again before every entry it writes. The delegation, or a departure, changing in the window gives the
//!   same result as a commit made a moment before the change, which nothing would reverse either: the delegation
//!   only refuses new releases and commits (decision 218), and a demotion is a room row, read again inside the
//!   confirm. **The reads' age is bounded:** more than [`MAX_READ_AGE_MS`] old at the confirm, by the room's clock,
//!   and the confirm decides nothing and writes nothing.
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
    answer, job_owns, judge, release_now, release_row, standing_unknown, state_of, Reads, Verdict,
};
use super::*;
use podster_core::release::{
    commit_live, next_state, script_name, script_owner, set_back, upload_expired,
    CommitLiveRefusal, RecheckFailure, ReleaseEvent, ReleaseState, ScriptOwner, ServeState,
    UploadFailure,
};

/// The room's path for starting a release's upload. Nothing outside the Worker reaches it.
pub(crate) const INTERNAL_RELEASE_START_UPLOAD: &str = "/internal/release-start-upload";
/// The room's path for committing a release live. Nothing outside the Worker reaches it.
pub(crate) const INTERNAL_RELEASE_COMMIT_LIVE: &str = "/internal/release-commit-live";
/// What a commit is answered with, as `waiting`, for a release whose upload the room hasn't recorded: nothing is
/// staged on a script that may hold nothing, or part of a release.
pub(super) const NOT_UPLOADED: &str = "release_not_uploaded";

/// **Whether the release path is complete.** False until the PR that completes it flips this, and that is the only
/// place it is set. While false, a deployment with release switched on and a provider configured refuses every
/// release command (`Workspace::release_path_open`). What must be true before it is flipped is in `docs/m6-plan.md`,
/// under "The gate on the release path".
pub(crate) const RELEASE_PATH_COMPLETE: bool = false;

/// How old a commit's outside reads may be when its confirm runs. Older, and the confirm decides nothing: the reads
/// are an answer about too long ago, and the command asks again.
pub(super) const MAX_READ_AGE_MS: i64 = 5_000;

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
    // Whichever path ends the release, an unpublish that came after it began owes this script's deletion.
    let under = match under {
        Some(epoch) => Some(epoch),
        None => owing_unpublish(sql, script)?,
    };
    if let Some(epoch) = under {
        // That unpublish isn't done with its files until this one is gone too.
        exec(
            sql,
            "UPDATE unpublish SET scripts_gone_at = NULL WHERE release_epoch = ?
               AND NOT EXISTS (SELECT 1 FROM script_delete WHERE script_name = ?)",
            vec![epoch.into(), script.into()],
        )?;
    }
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

/// The unpublish that owes a release's own script its deletion, by its epoch: the room's newest unpublish that came
/// after the release began. The release was there to be taken down by it, so the unpublish isn't done with its files
/// until this script is gone, **whichever path queues the script:** the unpublish's own bookkeeping, an upload past
/// its hour, a failed recheck, or the reconcile finding it. `None` for a release that began after the room's last
/// unpublish, and for a script no release of this room is named after.
pub(super) fn owing_unpublish(sql: &SqlStorage, script: &str) -> R<Option<i64>> {
    Ok(rows(
        sql,
        "SELECT max(u.release_epoch) AS epoch FROM unpublish u JOIN release r ON r.release_epoch < u.release_epoch
           WHERE r.script_name = ? AND r.script_release_id = r.id",
        vec![script.into()],
    )?
    .first()
    .filter(|row| !row["epoch"].is_null())
    .map(|row| int(&row["epoch"])))
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
    end_failed(sql, release_id, reason, None, under, now)
}

/// [`fail`], for core's recheck failure: its code, and, for `release_not_delegated`, which of the organization's two
/// facts refused, `release_switch` or `provisioning_delegation`, kept in the audit record only (decision 218). The
/// event and the release's row carry the code alone, as for every other reason.
pub(super) fn fail_because(
    sql: &SqlStorage,
    release_id: &str,
    failure: RecheckFailure,
    under: Option<i64>,
    now: i64,
) -> R<()> {
    end_failed(
        sql,
        release_id,
        failure.code(),
        failure.not_delegated_cause().map(|cause| cause.code()),
        under,
        now,
    )
}

fn end_failed(
    sql: &SqlStorage,
    release_id: &str,
    reason: &str,
    cause: Option<&str>,
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
        Some(
            match cause {
                Some(cause) => json!({ "state": failed.name(), "reason": reason, "cause": cause }),
                None => json!({ "state": failed.name(), "reason": reason }),
            }
            .to_string(),
        ),
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

/// **Release bookkeeping, all of it:** every upload past its hour ended, and every release that hadn't gone live and
/// started under an epoch the room has since left ended. Run at the start of each release command's transaction.
/// Around a takedown it runs in a transaction of its own ([`bookkeeping`]), never in the takedown's.
pub(super) fn end_stale(sql: &SqlStorage, now: i64) -> R<()> {
    // Test builds only: a test makes this fail, to show that no takedown fails or waits with it.
    #[cfg(feature = "failpoints")]
    if !rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_release_bookkeeping_fails'",
        vec![],
    )?
    .is_empty()
    {
        return Err(ApiError::internal("test: release bookkeeping failed"));
    }
    expire_uploads(sql, now)?;
    let epoch = rows(sql, "SELECT release_epoch FROM release_config", vec![])?
        .first()
        .map(|config| int(&config["release_epoch"]));
    if let Some(epoch) = epoch {
        end_at_unpublish(sql, epoch, now)?;
    }
    // It worked: whatever was on record of it failing is cleared, in this same transaction.
    exec(sql, "DELETE FROM release_bookkeeping", vec![])
}

/// [`end_stale`] in a transaction of its own, from the room's takedown code: after an unpublish has committed, before
/// the reconcile's question, and at the start of the room's alarm. **It never fails its caller and never holds it
/// up:** an error is logged by its code and the caller goes on. A suspension has committed by then, and the applier
/// and the delete job run all the same. What it would have ended is ended by the next run of it, and until then
/// can't go live: the epoch has moved, which the recheck and core's `commit_live` both refuse.
///
/// **A failure is kept in the room's own row,** `release_bookkeeping`: when it first failed, when it last failed, how
/// many times in a row, and the last code. It is written here, where the failure is caught, in a transaction of its
/// own, and cleared by the first run that works ([`end_stale`]). The room tells operators from that row once it has
/// failed [`BOOKKEEPING_TOLD`] times in a row (`takedown::findings`), on every question the reconcile asks, until it
/// is cleared. So nothing rests on the bookkeeping happening to fail at the moment the reconcile asks.
pub(super) fn bookkeeping(state: &State) {
    let sql = state.storage().sql();
    let now = release_now(&sql);
    let store = sql.clone();
    let Err(error) = transaction_sync(state, move || end_stale(&store, now)) else {
        return;
    };
    // Only a code this file can name is kept: an error's own text never is.
    let code = if error.code().is_none_or(|code| code == "internal_error") {
        "internal_error"
    } else {
        "refused"
    };
    console_error!("release: bookkeeping failed and was skipped: code={}", code);
    let kept = transaction_sync(state, move || {
        exec(
            &sql,
            "INSERT INTO release_bookkeeping (singleton, failures, first_failed_at, last_failed_at, last_code) VALUES (1, 1, ?, ?, ?)
               ON CONFLICT (singleton) DO UPDATE SET failures = failures + 1, last_failed_at = max(last_failed_at, excluded.last_failed_at),
                 last_code = excluded.last_code",
            vec![now.into(), now.into(), code.into()],
        )
    });
    if kept.is_err() {
        console_error!("release: a bookkeeping failure couldn't be kept: code=record_failed");
    }
}

/// How many times in a row a room's release bookkeeping fails before operators are told: the third. It runs after
/// every unpublish, at the start of every alarm and before every question of the reconcile's, so one failure, or two
/// close together, can be a moment's trouble with the room's storage. Three in a row, with nothing working between
/// them, is a room that isn't ending its releases. The same figure the reconcile uses for a key that keeps failing.
pub(super) const BOOKKEEPING_TOLD: i64 = 3;

/// Ends every release that hadn't gone live and started under an epoch below `epoch`, the room's own now, which an
/// unpublish raised it to: awaiting approval, queued, uploading or uncertain. None of them can ever be committed, so none is left
/// for someone to approve or for a job that may never come back. A script one of them had is queued under this
/// unpublish, so the unpublish isn't done with its files until that script is gone too.
///
/// **At the epoch's ceiling** the epoch can't go up, so a release started at the ceiling isn't ended here. It can
/// never go live either: core refuses every commit at the ceiling.
///
/// **How many.** Each one ended writes an audit record and an event in the unpublish's own transaction. A room takes
/// 20 requests a day (`MAX_RELEASES_PER_ROOM_PER_DAY`), which step 6 enforces where it takes them, and each is ended
/// by the first unpublish after it, so one unpublish ends at most what was asked for since the last.
fn end_at_unpublish(sql: &SqlStorage, epoch: i64, now: i64) -> R<()> {
    // The unpublish that raised the room to this epoch, if its row is there: the scripts are queued under it.
    let under = (!rows(
        sql,
        "SELECT 1 AS found FROM unpublish WHERE release_epoch = ?",
        vec![epoch.into()],
    )?
    .is_empty())
    .then_some(epoch);
    for release in rows(
        sql,
        "SELECT id FROM release WHERE state IN ('awaiting_approval', 'queued', 'uploading', 'uncertain') AND release_epoch < ? ORDER BY seq",
        vec![epoch.into()],
    )? {
        if let Some(id) = text(&release["id"]) {
            fail(sql, &id, CommitLiveRefusal::EpochMoved.code(), under, now)?;
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

/// [`failed`], for the recheck's own failure, with which fact refused kept in the audit record.
fn rechecked_failed(
    sql: &SqlStorage,
    release_id: &str,
    failure: RecheckFailure,
    now: i64,
) -> R<Value> {
    fail_because(sql, release_id, failure, None, now)?;
    let after = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    Ok(answer(&after, true, Some(failure.code())))
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
    end_stale(sql, now)?;
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
        Verdict::Fails(failure) => {
            return Ok(with_script(
                rechecked_failed(sql, release_id, failure, now)?,
                None,
            ))
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

/// Whether the room has recorded this release's script as written whole (`record_uploaded`).
pub(super) fn uploaded(sql: &SqlStorage, release_id: &str, script: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT 1 AS uploaded FROM release_upload WHERE release_id = ? AND script_name = ?",
        vec![release_id.into(), script.into()],
    )?
    .is_empty())
}

/// What the room says of a release before anything is read for it or written under its name.
pub(super) enum UploadReady {
    /// It is uploading, under the epoch it started under, and everything the room knows of it holds: its script's
    /// name, and the repository and the commit to read.
    Go {
        script: String,
        repo_id: i64,
        commit_sha: String,
    },
    /// The command ends here, with this answer: the release isn't uploading, it failed, or it is uploaded already.
    Answer(Value),
}

/// The upload's answer for a release as it is: the recheck's answer, and whether its upload is recorded.
pub(super) fn upload_answer(sql: &SqlStorage, release: &Value, rechecked: bool) -> R<Value> {
    let mut out = answer(release, rechecked, None);
    let recorded = match (release["id"].as_str(), release["script_name"].as_str()) {
        (Some(id), Some(script)) => uploaded(sql, id, script)?,
        _ => false,
    };
    out["uploaded"] = recorded.into();
    Ok(out)
}

/// The room's check before an upload reads a file, and again before it writes the script, inside the room's
/// transaction: the recheck, the epoch included, on `reads` and the room's rows now.
///
/// - A release that isn't `uploading` is answered as it is.
/// - A fact that fails ends the release here, before anything more is asked of anyone. With `whole`, a fact that
///   couldn't be read leaves it undecided, `standing_unknown`; without it, `reads` hold nothing from outside, and
///   only the room's own facts are judged, as a commit's stage does.
/// - A script queued for deletion is never written, and neither is one under a label that isn't the room's current.
/// - One already recorded as uploaded is answered as such: a retry writes nothing again.
pub(super) fn upload_ready(
    sql: &SqlStorage,
    release_id: &str,
    reads: &Reads,
    whole: bool,
    now: i64,
) -> R<UploadReady> {
    end_stale(sql, now)?;
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let state = state_of(&release)?;
    if state != ReleaseState::Uploading {
        return Ok(UploadReady::Answer(upload_answer(sql, &release, false)?));
    }
    if release["script_release_id"].as_str() != Some(release_id) {
        return Err(ApiError::internal(
            "a release whose script isn't its own isn't uploaded",
        ));
    }
    let ended = |answer: Value| {
        let mut answer = answer;
        answer["uploaded"] = false.into();
        Ok(UploadReady::Answer(answer))
    };
    match judge(sql, &release, reads, now)? {
        Verdict::Fails(failure) => return ended(rechecked_failed(sql, release_id, failure, now)?),
        Verdict::Unknown if whole => return Err(standing_unknown()),
        Verdict::Unknown | Verdict::Holds => {}
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
        return ended(failed(sql, release_id, reason, now)?);
    }
    if !label_current(sql, &text(&release["label"]).unwrap_or_default())? {
        let reason = UploadFailure::LabelRetired.code();
        return ended(failed(sql, release_id, reason, now)?);
    }
    if uploaded(sql, release_id, &script)? {
        return Ok(UploadReady::Answer(upload_answer(sql, &release, whole)?));
    }
    let repo_id = rows(
        sql,
        "SELECT provider_repo_id FROM repo_link WHERE provider = 'github'",
        vec![],
    )?
    .first()
    .map(|row| int(&row["provider_repo_id"]))
    .ok_or_else(|| ApiError::internal("an uploading release with no repository"))?;
    let commit_sha = text(&release["commit_sha"])
        .ok_or_else(|| ApiError::internal("a release with no commit"))?;
    Ok(UploadReady::Go {
        script,
        repo_id,
        commit_sha,
    })
}

/// Ends a release whose read failed it, with the read's code, and answers it as it now is.
///
/// **Only a release still uploading, with no upload on record.** An attempt's failure is an answer about when it
/// read, and two attempts can overlap: one records the upload and the release goes live while the other is still
/// reading. The late one's failure then ends nothing: a release that is live, or whose upload another attempt
/// recorded whole, is answered as it is.
pub(super) fn upload_failed(
    sql: &SqlStorage,
    release_id: &str,
    reason: &str,
    now: i64,
) -> R<Value> {
    end_stale(sql, now)?;
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let recorded = match release["script_name"].as_str() {
        Some(script) => uploaded(sql, release_id, script)?,
        None => false,
    };
    if state_of(&release)? != ReleaseState::Uploading || recorded {
        return upload_answer(sql, &release, false);
    }
    let mut out = failed(sql, release_id, reason, now)?;
    out["uploaded"] = false.into();
    Ok(out)
}

/// The room's transaction after the script's write was asked for. `written` is whether the provider said, in so many
/// words, that the script is written.
///
/// - **Still uploading, and written:** the upload is recorded, with how many files and bytes it holds, audited and
///   told to the room's managers as `release.uploaded`. From here a commit may stage it. Asked again, nothing changes.
/// - **Still uploading, and not known to be written:** nothing is recorded. The script may exist; the release's own
///   state keeps it for the upload's hour, a retry writes it again, and the hour's end deletes it.
/// - **No longer uploading:** it ended while its script was being written, by an unpublish, an expiry or a failed
///   recheck. Whatever ended it queued its script for deletion, and that deletion may already have been counted
///   done, before the write landed. **So the script is owed its deletion again, now:** queued, or queued again if it
///   had been counted gone, under the unpublish that owes it, which isn't done with its files until this is gone.
pub(super) fn record_uploaded(
    sql: &SqlStorage,
    release_id: &str,
    script: &str,
    written: bool,
    files: i64,
    bytes: i64,
    now: i64,
) -> R<Value> {
    end_stale(sql, now)?;
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let own = release["script_name"].as_str() == Some(script)
        && release["script_release_id"].as_str() == Some(release_id);
    if !own {
        return Err(ApiError::internal("an upload for another release's script"));
    }
    if state_of(&release)? == ReleaseState::Uploading {
        let queued = !rows(
            sql,
            "SELECT 1 AS queued FROM script_delete WHERE script_name = ?",
            vec![script.into()],
        )?
        .is_empty();
        // Recorded once: a second attempt that writes the script again finds it on record, and records nothing more.
        if written && !queued && !uploaded(sql, release_id, script)? {
            exec(
                sql,
                "INSERT INTO release_upload (release_id, script_name, files, bytes, uploaded_at) VALUES (?, ?, ?, ?, ?)",
                vec![
                    release_id.into(),
                    script.into(),
                    files.into(),
                    bytes.into(),
                    now.into(),
                ],
            )?;
            // The release's trail: `release.upload_started`, this, then `release.live` or `release.failed`. Its state
            // doesn't change, so the audit record says what was recorded: how many files and bytes, never their names.
            audit_as(
                sql,
                moderation::PODSTER,
                moderation::PODSTER_KIND,
                "release.uploaded",
                release_id,
                None,
                Some(json!({ "state": ReleaseState::Uploading.name(), "files": files, "bytes": bytes }).to_string()),
                now,
            )?;
            store::record_event_about(
                sql,
                "release.uploaded",
                moderation::PODSTER,
                Some(release_id),
                None,
                &Transition::NONE,
                roles::room_managers(sql, moderation::PODSTER)?,
                now,
            )?;
        }
        return upload_answer(sql, &release, false);
    }
    let ScriptOwner::Podster { label, .. } = script_owner(script) else {
        return Err(ApiError::internal(
            "an upload under a name Podster didn't make",
        ));
    };
    let under = owing_unpublish(sql, script)?;
    exec(
        sql,
        "INSERT INTO script_delete (script_name, label, unpublish_epoch, queued_at, next_attempt_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (script_name) DO UPDATE SET next_attempt_at = excluded.next_attempt_at, attempts = 0, last_code = 'written_after_end',
             queued_at = CASE WHEN gone_at IS NULL THEN queued_at ELSE excluded.queued_at END, gone_at = NULL",
        vec![
            script.into(),
            label.into(),
            under.map_or(V::Null, V::from),
            now.into(),
            now.into(),
        ],
    )?;
    exec(
        sql,
        "UPDATE unpublish SET scripts_gone_at = NULL WHERE release_epoch = (SELECT unpublish_epoch FROM script_delete WHERE script_name = ?)",
        vec![script.into()],
    )?;
    upload_answer(sql, &release, false)
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
    end_stale(sql, now)?;
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let state = state_of(&release)?;
    if state != ReleaseState::Uploading {
        return Ok(Staged::Answer(answer(&release, false, None)));
    }
    // Only a release's own script is ever staged here. A rollback's record (step 6) names the script of the release
    // it rolls back to, and must go through core's `rollback`, which asks whether that kept script still exists.
    if release["script_release_id"].as_str() != Some(release_id) {
        return Err(ApiError::internal(
            "a release whose script isn't its own isn't committed here",
        ));
    }
    if let Verdict::Fails(failure) = judge(sql, &release, &Reads::nothing(), now)? {
        return Ok(Staged::Answer(rechecked_failed(
            sql, release_id, failure, now,
        )?));
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
    // Only a script the room has recorded as written whole is ever set on a host.
    if !uploaded(sql, release_id, &script)? {
        let mut waiting = answer(&release, false, None);
        waiting["waiting"] = NOT_UPLOADED.into();
        return Ok(Staged::Answer(waiting));
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
    end_stale(sql, now)?;
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
    // Reads older than the bound are an answer about too long ago: nothing is decided on them.
    if reads.age(now) > MAX_READ_AGE_MS {
        return Err(standing_unknown());
    }
    match judge(sql, &release, reads, now)? {
        Verdict::Unknown => Err(standing_unknown()),
        Verdict::Fails(failure) => rechecked_failed(sql, release_id, failure, now),
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
    /// `{ release_id }`: starts one release's upload (M6 step 5). The release's own state is
    /// read first, with no outside read for one that isn't the job's; then every outside fact; then the room's
    /// transaction. Nothing goes live on this, so one round of reads before the transaction is all it makes.
    pub(super) async fn release_start_upload(&self, mut req: Request) -> R<Value> {
        let (release_id, release) = self.named_release(&mut req).await?;
        self.start_upload_of(release_id, release).await
    }

    /// [`Workspace::release_start_upload`] for a release already read, as the release job's driver asks it.
    pub(super) async fn start_upload_of(&self, release_id: String, release: Value) -> R<Value> {
        if !job_owns(state_of(&release)?) {
            let mut as_is = answer(&release, false, None);
            as_is["script"] = Value::Null;
            return Ok(as_is);
        }
        let reads = self.release_reads(&release_id).await?;
        #[cfg(feature = "failpoints")]
        self.test_between_reads().await?;
        self.release_transaction(move |sql| {
            start_upload(sql, &release_id, &reads, release_now(sql))
        })
        .await
    }

    /// `{ release_id }`: commits one release live (M6 step 5). See the module's note for the
    /// order: the release's own state, the stage, the outside reads, the confirm.
    pub(super) async fn release_commit_live(&self, mut req: Request) -> R<Value> {
        let (release_id, release) = self.named_release(&mut req).await?;
        self.commit_live_of(release_id, release).await
    }

    /// [`Workspace::release_commit_live`] for a release already read, as the release job's driver asks it.
    pub(super) async fn commit_live_of(&self, release_id: String, release: Value) -> R<Value> {
        if state_of(&release)? != ReleaseState::Uploading {
            // A retry may find the release already `live` with its hosts still owed, as when the alarm couldn't be
            // set after the confirm committed. It needs nothing here: the room sets its alarm for whatever it owes
            // after every command it is sent, this one included, whatever the command answers (`Workspace::fetch`).
            return Ok(answer(&release, false, None));
        }
        let staged: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = staged.clone();
        let id = release_id.clone();
        self.release_transaction(move |sql| {
            if let Staged::Answer(answer) = stage(sql, &id, release_now(sql))? {
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
        self.test_between_reads().await?;
        self.release_transaction(move |sql| confirm(sql, &release_id, &reads, release_now(sql)))
            .await
    }
}
