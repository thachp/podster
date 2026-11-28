//! A release whose upload's answer was lost, and its settling by the provider's own answer (M6 step 5; ADR 0010's
//! "The release job"; `m6-plan.md`, "`uncertain` settling"). **Behind `RELEASES`, exactly `true`, and the gate on the
//! release path,** as every release command is. What is decided is pure, in `podster_core::release_uncertain`.
//!
//! **When a release becomes `uncertain`** ([`enter_uncertain`]): its script's write was asked for and what came back
//! may follow a write that went through: no answer, a `5xx`, or a `200` that isn't the answer that says written. It is
//! the one call whose lost answer leaves a release `uncertain`. Every other provider call is retried as it is, since a
//! repeat does no harm and its effect is read back before anything is recorded (`on_lost_answer`). What the attempt
//! sent, its files and bytes, is kept beside the release in `release_uncertain`, with since when, so the upload can be
//! recorded on the provider's word alone.
//!
//! **How it settles** ([`Workspace::settle_of`], the release's upload step while it is `uncertain`): one read of the
//! release's script, by name, with the scripts token, and nothing else asked of anyone. A script object counts only
//! when its `id` is the name read, so no other script is taken for this one. In one room transaction, with the
//! step's lease checked again ([`settle`]):
//!
//! - **There,** a script object named as read: its upload is recorded as written whole, and the release is uploading again, ready to
//!   commit: `release.settled` with `release_settled_written`, then `release.uploaded`.
//! - **Not there,** `"script": null`: the release is uploading again, and its upload is tried as a whole:
//!   `release.settled` with `release_settled_absent`.
//! - **Anything else:** it stays `uncertain`, `release_settle_unknown`, and is read again after a wait that doubles from
//!   5 seconds to a minute. Past its sixth read in its life, or 10 minutes after it became `uncertain`, it ends,
//!   `release_upload_unsettled`, and its script, which may exist, is queued for deletion as any failed release's is.
//!
//! **Meanwhile nothing new goes live in the room:** a commit of any other release waits `release_uncertain`, counting no
//! driver attempt (`release_commit::stage`). The hourly reconcile keeps an `uncertain` release's script within its
//! upload's hour, as an uploading one's (`takedown::check_script`). The upload's hour still ends it, and an unpublish
//! ends it at once.
//!
//! **An overlapping attempt** whose write comes back written while the release is `uncertain` settles it as written: it
//! is the provider's own word, as the read's would be ([`settle_written`], from `record_uploaded`).
//!
//! Logs carry the room's and the release's IDs and codes, never the script's name.
use super::release_commit::{fail, record_upload, upload_answer, uploaded};
use super::release_driver::{lease_lost, may_go_on, room_id, StepLease};
use super::release_recheck::{release_now, release_row, state_of};
use super::release_upload::NO_PROVIDER;
use super::*;
use podster_core::release::{next_state, ReleaseEvent, ReleaseState, UploadFailure};
use podster_core::release_uncertain::{
    settle_next, settle_read, SettleNext, SettleRead, SETTLED_ABSENT, SETTLED_WRITTEN,
    SETTLE_UNKNOWN, UNCERTAIN, UNSETTLED,
};

/// What the room keeps of a release while it is, or once was, `uncertain`.
pub(super) struct Uncertain {
    /// Since when it is `uncertain` this time.
    pub(super) since: i64,
    /// The reads made to settle it, over its whole life.
    pub(super) settles: u32,
}

/// The release's row in `release_uncertain`, if it has one.
pub(super) fn uncertain_of(sql: &SqlStorage, release_id: &str) -> R<Option<Uncertain>> {
    Ok(rows(
        sql,
        "SELECT since, settles FROM release_uncertain WHERE release_id = ?",
        vec![release_id.into()],
    )?
    .first()
    .map(|row| Uncertain {
        since: int(&row["since"]),
        settles: u32::try_from(int(&row["settles"]).max(0)).unwrap_or(u32::MAX),
    }))
}

/// The release's change on its trail, with its code: an audit record and an event, as Podster's act.
fn trail(
    sql: &SqlStorage,
    kind: &str,
    release_id: &str,
    from: ReleaseState,
    to: ReleaseState,
    code: &str,
    now: i64,
) -> R<()> {
    // A preview release's trail is `preview.*`, told to people only (M8 step 6).
    let (action, event, told) = release_commit::names_for(sql, kind, release_id)?;
    audit_as(
        sql,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        &action,
        release_id,
        Some(json!({ "state": from.name() }).to_string()),
        Some(json!({ "state": to.name(), "reason": code }).to_string()),
        now,
    )?;
    let Some(event) = event else {
        return Ok(());
    };
    store::record_event_about(
        sql,
        &event,
        moderation::PODSTER,
        Some(release_id),
        None,
        &Transition {
            reason: Some(code),
            ..Transition::NONE
        },
        told,
        now,
    )
}

fn moved(sql: &SqlStorage, release_id: &str, to: ReleaseState, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE release SET state = ?, updated_at = ? WHERE id = ?",
        vec![to.name().into(), now.into(), release_id.into()],
    )
}

/// An uploading release whose script's write may have gone through: it becomes `uncertain`, in the caller's
/// transaction, with what the attempt sent and since when. Its reads made before are kept: they are counted over its
/// life. Answers the release as it now is, `waiting` [`UNCERTAIN`].
pub(super) fn enter_uncertain(
    sql: &SqlStorage,
    release_id: &str,
    script: &str,
    files: i64,
    bytes: i64,
    now: i64,
) -> R<Value> {
    let to = next_state(ReleaseState::Uploading, ReleaseEvent::UploadUnknown)
        .map_err(|_| ApiError::internal("an uploading release that can't be uncertain"))?;
    moved(sql, release_id, to, now)?;
    exec(
        sql,
        "INSERT INTO release_uncertain (release_id, script_name, files, bytes, since, last_code) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (release_id) DO UPDATE SET files = excluded.files, bytes = excluded.bytes, since = excluded.since,
             settled_at = NULL, last_code = excluded.last_code",
        vec![
            release_id.into(),
            script.into(),
            files.into(),
            bytes.into(),
            now.into(),
            UNCERTAIN.into(),
        ],
    )?;
    trail(
        sql,
        "release.uncertain",
        release_id,
        ReleaseState::Uploading,
        to,
        UNCERTAIN,
        now,
    )?;
    console_log!(
        "release: an upload's outcome is unknown: room={} release={} code={}",
        room_id(sql),
        release_id,
        UNCERTAIN
    );
    let after = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let mut out = upload_answer(sql, &after, false)?;
    out["waiting"] = UNCERTAIN.into();
    Ok(out)
}

/// Marks the release's row settled, with its code.
fn settled(sql: &SqlStorage, release_id: &str, code: &str, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE release_uncertain SET settled_at = ?, last_code = ? WHERE release_id = ?",
        vec![now.into(), code.into(), release_id.into()],
    )
}

/// An `uncertain` release whose script the provider says is there: it is uploading again, and its upload is recorded
/// with `files` and `bytes`, in the caller's transaction. A script queued for deletion is never recorded: the release
/// ends, as a commit would end it. Answers the release as it now is, `settled` [`SETTLED_WRITTEN`].
pub(super) fn settle_written(
    sql: &SqlStorage,
    release_id: &str,
    script: &str,
    files: i64,
    bytes: i64,
    now: i64,
) -> R<Value> {
    let queued = !rows(
        sql,
        "SELECT 1 AS queued FROM script_delete WHERE script_name = ?",
        vec![script.into()],
    )?
    .is_empty();
    if queued {
        let reason = UploadFailure::ScriptDeleted.code();
        settled(sql, release_id, reason, now)?;
        fail(sql, release_id, reason, None, now)?;
        return answered(sql, release_id, None);
    }
    let to = next_state(ReleaseState::Uncertain, ReleaseEvent::UploadConfirmed)
        .map_err(|_| ApiError::internal("an uncertain release that can't be confirmed"))?;
    moved(sql, release_id, to, now)?;
    settled(sql, release_id, SETTLED_WRITTEN, now)?;
    trail(
        sql,
        "release.settled",
        release_id,
        ReleaseState::Uncertain,
        to,
        SETTLED_WRITTEN,
        now,
    )?;
    if !uploaded(sql, release_id, script)? {
        record_upload(sql, release_id, script, files, bytes, now)?;
    }
    log_settled(sql, release_id, SETTLED_WRITTEN);
    answered(sql, release_id, Some(SETTLED_WRITTEN))
}

fn log_settled(sql: &SqlStorage, release_id: &str, code: &str) {
    console_log!(
        "release: an uncertain upload is settled: room={} release={} code={}",
        room_id(sql),
        release_id,
        code
    );
}

/// The release as it now is, with what settled it, if anything did.
fn answered(sql: &SqlStorage, release_id: &str, settled: Option<&str>) -> R<Value> {
    let after = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let mut out = upload_answer(sql, &after, false)?;
    if let Some(code) = settled {
        out["settled"] = code.into();
    }
    Ok(out)
}

/// The room's transaction after a read of an `uncertain` release's script: see the module's note. A release that isn't
/// `uncertain` any more, settled by another attempt or ended, is answered as it is, and the read counts for nothing.
pub(super) fn settle(
    sql: &SqlStorage,
    release_id: &str,
    script: &str,
    read: SettleRead,
    now: i64,
) -> R<Value> {
    release_commit::end_stale(sql, now)?;
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    if state_of(&release)? != ReleaseState::Uncertain {
        return upload_answer(sql, &release, false);
    }
    if release["script_name"].as_str() != Some(script)
        || release["script_release_id"].as_str() != Some(release_id)
    {
        return Err(ApiError::internal(
            "a settling read of another release's script",
        ));
    }
    let kept = rows(
        sql,
        "SELECT files, bytes, since, settles FROM release_uncertain WHERE release_id = ?",
        vec![release_id.into()],
    )?;
    let kept = kept
        .first()
        .ok_or_else(|| ApiError::internal("an uncertain release with nothing kept of it"))?;
    exec(
        sql,
        "UPDATE release_uncertain SET settles = settles + 1 WHERE release_id = ?",
        vec![release_id.into()],
    )?;
    match read {
        SettleRead::Written => settle_written(
            sql,
            release_id,
            script,
            int(&kept["files"]),
            int(&kept["bytes"]),
            now,
        ),
        SettleRead::Absent => {
            let to = next_state(ReleaseState::Uncertain, ReleaseEvent::UploadAbsent)
                .map_err(|_| ApiError::internal("an uncertain release that can't go back"))?;
            moved(sql, release_id, to, now)?;
            settled(sql, release_id, SETTLED_ABSENT, now)?;
            trail(
                sql,
                "release.settled",
                release_id,
                ReleaseState::Uncertain,
                to,
                SETTLED_ABSENT,
                now,
            )?;
            log_settled(sql, release_id, SETTLED_ABSENT);
            answered(sql, release_id, Some(SETTLED_ABSENT))
        }
        SettleRead::Unknown => {
            exec(
                sql,
                "UPDATE release_uncertain SET last_code = ? WHERE release_id = ?",
                vec![SETTLE_UNKNOWN.into(), release_id.into()],
            )?;
            let settles = u32::try_from(int(&kept["settles"]).max(0))
                .unwrap_or(u32::MAX)
                .saturating_add(1);
            if settle_next(settles, int(&kept["since"]), now) == SettleNext::GiveUp {
                return unsettled(sql, release_id, now);
            }
            console_log!(
                "release: an uncertain upload is still unsettled: room={} release={} code={}",
                room_id(sql),
                release_id,
                SETTLE_UNKNOWN
            );
            let mut out = answered(sql, release_id, None)?;
            out["waiting"] = SETTLE_UNKNOWN.into();
            Ok(out)
        }
    }
}

/// Ends an `uncertain` release that its reads or its time ran out on, in the caller's transaction: failed,
/// [`UNSETTLED`], its script queued for deletion as any failed release's is. Answers the release as it now is.
pub(super) fn unsettled(sql: &SqlStorage, release_id: &str, now: i64) -> R<Value> {
    exec(
        sql,
        "UPDATE release_uncertain SET last_code = ? WHERE release_id = ?",
        vec![UNSETTLED.into(), release_id.into()],
    )?;
    fail(sql, release_id, UNSETTLED, None, now)?;
    console_log!(
        "release: an uncertain upload was never settled: room={} release={} code={}",
        room_id(sql),
        release_id,
        UNSETTLED
    );
    answered(sql, release_id, None)
}

impl Workspace {
    /// The upload step of a release that is `uncertain`: one read of its script, then [`settle`]. The step's lease is
    /// asked before the read and again in the transaction; once it has run out nothing more is asked or written, and the
    /// release waits `release_drive_lease_lost`. With no provider to ask, it waits `content_provider_not_configured`,
    /// and nothing is counted.
    pub(super) async fn settle_of(
        &self,
        release_id: String,
        release: Value,
        lease: Option<&StepLease>,
    ) -> R<Value> {
        let sql = self.state.storage().sql();
        let script = text(&release["script_name"])
            .ok_or_else(|| ApiError::internal("an uncertain release with no script"))?;
        if !may_go_on(&sql, lease) {
            return lease_lost(&sql, &release_id);
        }
        let Some(provider) = self.upload_provider_for(&release_id)? else {
            let mut out = upload_answer(&sql, &release, false)?;
            out["waiting"] = NO_PROVIDER.into();
            return Ok(out);
        };
        #[cfg(feature = "failpoints")]
        release_driver::test_at(&sql, "settling");
        if !may_go_on(&sql, lease) {
            return lease_lost(&sql, &release_id);
        }
        let answer = provider.read_script_named(&script).await;
        let read = settle_read(
            answer.as_ref().map(|(read, _)| *read),
            answer.as_ref().and_then(|(_, id)| id.as_deref()),
            &script,
        );
        let lease = lease.cloned();
        self.release_transaction(move |sql| {
            if !may_go_on(sql, lease.as_ref()) {
                return lease_lost(sql, &release_id);
            }
            settle(sql, &release_id, &script, read, release_now(sql))
        })
        .await
    }
}
