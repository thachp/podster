//! Rolling back to an earlier release (`rollbackRelease`, `POST /v1/workspaces/{ws}/releases/{release}/rollback`; M6
//! step 6, 6h; ADR 0010's "Rollback", decision 203). What is decided is pure, in `podster_core::release_rollback`;
//! here is what the room reads, writes and asks.
//!
//! **A rollback is its own release record,** asked for by a person exactly as a release is (`release_request`): the
//! same standing on every attempt, a replay included (who is asking and where, their own live `deploy` grant from
//! someone who still holds, and their own record), the same gate on the release path before anything outside the room
//! is read, and core's same order, so it is one of the room's 20 asks a rolling day and is refused `release_pending`
//! while a release of the same commit is on its way. Its record names the release it rolls back to
//! (`release_rollback`), which must be one the room served once and has left (`rollback_target_invalid`, 409
//! otherwise), and it releases that release's commit, for that release's task, which the caller must be able to see.
//! It is approved, declined and rechecked as any release is (`release_approval`, `release_driver`).
//!
//! **What the job does with it,** once approved:
//! - **At its start** ([`script_at_start`]), by the room's own rows: if the release it rolls back to is the one whose
//!   script the room keeps, under the room's current label, with nothing suspended and nothing queued to delete it, the
//!   record names that kept script, and its next step is the switch, with nothing read from GitHub or uploaded.
//!   Otherwise it names its own script and is uploaded as any release is: its upload takes one of the room's upload
//!   attempts and the deployment's read budget.
//! - **At the switch** ([`stage`]), after two fresh reads made for this attempt and no other ([`Workspace::switch_reads`]):
//!   Cloudflare's own read of the kept script, and the operators' record of takedown findings against it. Core's
//!   `rollback_path` decides: the switch, through core's `rollback` under the epoch the rollback was asked under; or a
//!   new release of that commit, its own script uploaded again; or nothing, while a read gives no answer, and the step
//!   is asked again. The rest is the commit's: the same outside reads after the stage, the whole recheck at the confirm
//!   (`release_commit::confirm`), the marker, served or set back. The marker the host must serve is the kept script's
//!   own release's (`podster_core::release_rollback::marker_release`).
//! - **A failed or set-back switch never deletes the kept script:** only a release's own script is ever queued for
//!   deletion (`release_commit::fail`), and core's `set_back` keeps it.
//!
//! Logs carry IDs and codes only; the script's name is sent only to the `Moderation` object, which keeps names.
use super::release_commit::{
    end_stale, failed, label_current, rechecked_failed, write_state, Staged,
};
use super::release_driver::{lease_lost, may_go_on, StepLease};
use super::release_recheck::{answer, judge, release_now, release_row, state_of, Reads, Verdict};
use super::release_request::{record, AskedFor, RequestReads};
use super::release_upload::NO_PROVIDER;
use super::*;
use podster_core::release::{
    rollback, script_name, script_owner, CommitLiveRefusal, ReleaseState, RollbackRefusal,
    ScriptOwner, UploadFailure,
};
use podster_core::release_rollback::{
    aims_at_kept, rollback_path, rollback_target, KeptFacts, RollbackPath, SwitchReads,
};
use podster_core::release_uncertain::{commit_waits_on_uncertain, COMMIT_WAITS_UNCERTAIN};

/// The release a rollback rolls back to, if `release_id` is a rollback's record.
pub(super) fn target_of(sql: &SqlStorage, release_id: &str) -> R<Option<String>> {
    Ok(rows(
        sql,
        "SELECT rollback_to FROM release_rollback WHERE release_id = ?",
        vec![release_id.into()],
    )?
    .first()
    .and_then(|row| text(&row["rollback_to"])))
}

/// Whether the room's flight, if one is open, is a rollback's: its own record names a release it rolls back to. For
/// `podster_core::release::open_host`, which opens no custom host then (the architect's ruling L1 on #448).
pub(super) fn flight_is_rollback(
    sql: &SqlStorage,
    state: &podster_core::release::ServeState,
) -> R<bool> {
    match &state.in_flight {
        Some(flight) => Ok(target_of(sql, &flight.release_id)?.is_some()),
        None => Ok(false),
    }
}

/// `POST releases/{release}/rollback`, in the room's transaction, after `Workspace::release_request_reads`. **Run only
/// as the handler of `command_checked` whose recheck is `release_request::standing`,** as a request is.
pub(super) fn handle(
    sql: &SqlStorage,
    who: &Participant,
    target_id: &str,
    reads: &RequestReads,
) -> R<Value> {
    let now = release_now(sql);
    end_stale(sql, now)?;
    let target = rows(
        sql,
        // Production's own releases only (M8 step 6): a preview release is never one production rolls back to.
        &format!(
            "SELECT state, task_id, commit_sha, environment, served_at FROM release WHERE id = ? AND {}",
            super::preview::NOT_PREVIEW
        ),
        vec![target_id.into()],
    )?
    .into_iter()
    .next()
    .ok_or_else(ApiError::not_found)?;
    if let Err(refusal) = rollback_target(state_of(&target)?, !target["served_at"].is_null()) {
        // error-codes: rollback_target_invalid
        return Err(ApiError::api(409, refusal.code()));
    }
    let task_id = text(&target["task_id"]);
    if let Some(task) = &task_id {
        load_task(sql, task)?
            .filter(|task| can_see_task(&who.caller, task))
            .ok_or_else(ApiError::task_not_found)?;
    }
    let commit_sha = text(&target["commit_sha"]).unwrap_or_default();
    let environment = text(&target["environment"]).unwrap_or_default();
    record(
        sql,
        who,
        &AskedFor {
            task_id: task_id.as_deref(),
            commit_sha: &commit_sha,
            environment: &environment,
            rollback_to: Some(target_id),
            from_preview: None,
        },
        reads,
        now,
    )
}

/// What the room's rows say of the kept script, for core's `KeptFacts`.
struct KeptRows {
    kept: Option<String>,
    target_script: Option<String>,
    current_label: Option<String>,
    app_suspended: bool,
    queued_for_delete: bool,
}

impl KeptRows {
    fn read(sql: &SqlStorage, target: &str) -> R<KeptRows> {
        let kept = rows(sql, "SELECT kept_previous FROM release_config", vec![])?
            .first()
            .and_then(|row| text(&row["kept_previous"]));
        let target_script = rows(
            sql,
            "SELECT script_name FROM release WHERE id = ?",
            vec![target.into()],
        )?
        .first()
        .and_then(|row| text(&row["script_name"]));
        let current_label = rows(sql, "SELECT label FROM app_label WHERE current = 1", vec![])?
            .first()
            .and_then(|row| text(&row["label"]));
        let queued_for_delete = match &kept {
            Some(kept) => !rows(
                sql,
                "SELECT 1 AS queued FROM script_delete WHERE script_name = ?",
                vec![kept.as_str().into()],
            )?
            .is_empty(),
            None => false,
        };
        Ok(KeptRows {
            kept,
            target_script,
            current_label,
            app_suspended: takedown::app_suspended(sql)?,
            queued_for_delete,
        })
    }

    fn facts<'a>(&'a self, rollback_label: &'a str) -> KeptFacts<'a> {
        KeptFacts {
            kept: self.kept.as_deref(),
            target_script: self.target_script.as_deref(),
            current_label: self.current_label.as_deref(),
            rollback_label,
            app_suspended: self.app_suspended,
            queued_for_delete: self.queued_for_delete,
        }
    }
}

/// The script a release names when its job starts it, and the release that script is named after: its own, or, for a
/// rollback that may switch back by the room's rows now, the kept script, named after the release it rolls back to.
pub(super) fn script_at_start(
    sql: &SqlStorage,
    release_id: &str,
    label: &str,
) -> R<(String, String)> {
    let own = || {
        script_name(label, release_id)
            .map(|script| (script, release_id.to_owned()))
            .map_err(|_| ApiError::internal("a release whose script can't be named"))
    };
    let Some(target) = target_of(sql, release_id)? else {
        return own();
    };
    let kept = KeptRows::read(sql, &target)?;
    match aims_at_kept(&kept.facts(label)) {
        Ok(script) => match script_owner(script) {
            ScriptOwner::Podster { release_id: of, .. } => Ok((script.to_owned(), of.to_owned())),
            ScriptOwner::Foreign => own(),
        },
        Err(_) => own(),
    }
}

/// Whether `release_id` is a rollback whose record names `script`, another release's: the kept script it is to switch
/// back to, which the job commits with no upload of its own (`release_commit::uploaded`).
pub(super) fn switches(sql: &SqlStorage, release_id: &str, script: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT 1 AS switches FROM release_rollback b JOIN release r ON r.id = b.release_id
           WHERE b.release_id = ? AND r.script_name = ? AND r.script_release_id != r.id",
        vec![release_id.into(), script.into()],
    )?
    .is_empty())
}

/// A rollback that can't switch becomes a new release of its commit: its own script, under its own label, which must
/// still be the room's current one, uploaded from now, as any upload. `code` is why, kept in the audit record.
fn upload_again(sql: &SqlStorage, release_id: &str, label: &str, code: &str, now: i64) -> R<Value> {
    if !label_current(sql, label)? {
        return failed(sql, release_id, UploadFailure::LabelRetired.code(), now);
    }
    let script = script_name(label, release_id)
        .map_err(|_| ApiError::internal("a release whose script can't be named"))?;
    exec(
        sql,
        "UPDATE release SET script_name = ?, script_release_id = ?, upload_started_at = ?, updated_at = ? WHERE id = ? AND state = ?",
        vec![
            script.as_str().into(),
            release_id.into(),
            now.into(),
            now.into(),
            release_id.into(),
            ReleaseState::Uploading.name().into(),
        ],
    )?;
    audit_as(
        sql,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        "release.rollback_uploads",
        release_id,
        None,
        Some(json!({ "state": ReleaseState::Uploading.name(), "reason": code }).to_string()),
        now,
    )?;
    console_log!(
        "release: a rollback is uploaded again: room={} release={} code={}",
        super::release_driver::room_id(sql),
        release_id,
        code
    );
    let after = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let mut out = answer(&after, true, None);
    out["rollback"] = code.into();
    Ok(out)
}

fn waiting(release: &Value, code: &str) -> Value {
    let mut out = answer(release, false, None);
    out["waiting"] = code.into();
    out
}

/// The first transaction of a rollback's switch, on the room's rows and `reads`, made for this attempt: core's
/// `rollback_path`, then, to switch, core's `rollback` under the epoch the rollback was asked under. The outside reads
/// and the confirm are the commit's (`release_commit`). A switch already staged by this rollback is only replayed; if
/// what was read now says it can't stand, the rollback ends failed and its hosts go back.
pub(super) fn stage(
    sql: &SqlStorage,
    release_id: &str,
    reads: &SwitchReads,
    now: i64,
) -> R<Staged> {
    end_stale(sql, now)?;
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let state = state_of(&release)?;
    if state != ReleaseState::Uploading {
        return Ok(Staged::Answer(answer(&release, false, None)));
    }
    if release["script_release_id"].as_str() == Some(release_id) {
        return Err(ApiError::internal(
            "a release with its own script isn't switched",
        ));
    }
    if let Verdict::Fails(failure) = judge(sql, &release, &Reads::nothing(), now)? {
        return Ok(Staged::Answer(rechecked_failed(
            sql, release_id, failure, now,
        )?));
    }
    let label = text(&release["label"]).unwrap_or_default();
    let target = target_of(sql, release_id)?
        .ok_or_else(|| ApiError::internal("a switch that isn't a rollback"))?;
    let kept = KeptRows::read(sql, &target)?;
    let loaded =
        takedown::load(sql)?.ok_or_else(|| ApiError::internal("a release with no serve state"))?;
    let own_flight = loaded
        .state
        .in_flight
        .as_ref()
        .is_some_and(|flight| flight.release_id == release_id);
    match rollback_path(&kept.facts(&label), reads) {
        RollbackPath::Switch => {}
        // Staged already, on an earlier attempt: what holds now says it can't stand, so its hosts go back.
        RollbackPath::Upload(code) if own_flight => {
            return Ok(Staged::Answer(failed(sql, release_id, code, now)?))
        }
        RollbackPath::Upload(code) => {
            return Ok(Staged::Answer(upload_again(
                sql, release_id, &label, code, now,
            )?))
        }
        RollbackPath::Undecided(code) => return Ok(Staged::Answer(waiting(&release, code))),
    }
    let uncertain: Vec<String> = rows(
        sql,
        &format!(
            "SELECT id FROM release WHERE state = ? AND {}",
            super::preview::NOT_PREVIEW
        ),
        vec![ReleaseState::Uncertain.name().into()],
    )?
    .iter()
    .filter_map(|row| text(&row["id"]))
    .collect();
    let uncertain: Vec<&str> = uncertain.iter().map(String::as_str).collect();
    if !own_flight && commit_waits_on_uncertain(release_id, &uncertain) {
        return Ok(Staged::Answer(waiting(&release, COMMIT_WAITS_UNCERTAIN)));
    }
    let started_under = takedown::from_stored(int(&release["release_epoch"]));
    match rollback(&loaded.state, started_under, true, release_id, state) {
        Ok((after, _)) => {
            if after != loaded.state {
                write_state(sql, &loaded.hosts, &after, now)?;
            }
            Ok(Staged::Staged)
        }
        Err(RollbackRefusal::Commit(CommitLiveRefusal::InFlight)) => Ok(Staged::Answer(waiting(
            &release,
            CommitLiveRefusal::InFlight.code(),
        ))),
        Err(RollbackRefusal::NotKept) => Ok(Staged::Answer(upload_again(
            sql,
            release_id,
            &label,
            RollbackRefusal::NotKept.code(),
            now,
        )?)),
        Err(refusal) => Ok(Staged::Answer(failed(
            sql,
            release_id,
            refusal.code(),
            now,
        )?)),
    }
}

impl Workspace {
    /// What a rollback's switch reads outside the room, made for this attempt, after its lease is asked: the
    /// operators' record of takedown findings against the kept script, then Cloudflare's own read of it. `Err` is the
    /// answer when nothing is read: no provider to ask (`content_provider_not_configured`), or the lease ran out.
    pub(super) async fn switch_reads(
        &self,
        release_id: &str,
        release: &Value,
        lease: Option<&StepLease>,
    ) -> R<std::result::Result<SwitchReads, Value>> {
        let sql = self.state.storage().sql();
        let Some(provider) = self.upload_provider() else {
            return Ok(Err(waiting(release, NO_PROVIDER)));
        };
        if !may_go_on(&sql, lease) {
            return Ok(Err(lease_lost(&sql, release_id)?));
        }
        let script = text(&release["script_name"])
            .ok_or_else(|| ApiError::internal("a switch with no script"))?;
        let finding_open = self.finding_open(&script).await;
        let script = provider.read_script(&script).await;
        Ok(Ok(SwitchReads {
            finding_open,
            script,
        }))
    }

    /// Whether the operators' record holds a takedown finding against `script`: exactly `{ "open": true|false }`, or
    /// no answer.
    async fn finding_open(&self, script: &str) -> Option<bool> {
        let mut response = crate::moderation::call(
            &self.env,
            crate::reconcile::FINDING_OPEN_PATH,
            Method::Post,
            Some(json!({ "subject": script })),
        )
        .await
        .ok()?;
        if response.status_code() != 200 {
            return None;
        }
        let body: Value = response.json().await.ok()?;
        let fields = body.as_object()?;
        if fields.len() != 1 {
            return None;
        }
        fields.get("open")?.as_bool()
    }
}
