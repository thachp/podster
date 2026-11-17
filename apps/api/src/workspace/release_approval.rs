//! A person approves or declines a release awaiting approval (`approveRelease`, `declineRelease`,
//! `POST /v1/workspaces/{ws}/releases/{release}/approve|decline`; M6 step 6, 6f; ADR 0010's "Authority, approval and
//! triggers"). This is the second half of "a `deploy_release` command, then a person's approval": an approval that
//! holds queues the release for the room's driver (`release_driver`), which reruns policy and rechecks on every pass;
//! a decline ends it `declined`, and nothing is uploaded.
//!
//! **Who** decides is the same people for both, by the room's rows first ([`may_decide`]): a person who is the room's
//! owner or one of its admins (decision 215), never an agent, whatever role is stored for it. A person who asked for a
//! release may approve it themselves (decided on the review of PR #309, for the owner to review). Then their own
//! `Principal`, read for this attempt, must say they are still in the organization their place here is held in: one
//! that says they left is `not_allowed`, one that gives no answer is `standing_unknown` (503), and neither writes
//! anything. **This is the command's standing, run by `command_checked` on every attempt, a first one and a replay
//! alike,** so a stored answer goes back only to someone who may still decide, on what was read for that retry.
//!
//! **Approval, in order:**
//! 1. the gate on the release path (`Workspace::release_path_open`), before anything is read: while
//!    `RELEASE_PATH_COMPLETE` is false, a deployment with release on and a provider configured answers
//!    `release_not_available` and nothing is read or written;
//! 2. **every outside fact, read again for this approval** (`Workspace::release_reads_as`): the content domain's stop,
//!    the deployment's setting, the organization's release switch and provisioning delegation, and the approver's,
//!    the requester's and the grant giver's own records. Nothing is taken from what the request read; the request
//!    kept none of it;
//! 3. in the room's transaction, the standing above; then the release, which must be awaiting approval
//!    (`invalid_transition` otherwise; the room's bookkeeping ends one from before an unpublish first); then **core's
//!    whole recheck** (`release_recheck::judge_as`, with the caller as approver), on the room's rows now and those
//!    reads, which asserts among the rest that the release's configuration version and release epoch are still the
//!    room's current ones. **A fact that was read and fails ends the release `failed` with its code,** as the job
//!    would, and the answer is the release so ended; **a fact that couldn't be read, with nothing read failing, is
//!    `standing_unknown`, which writes nothing;**
//! 4. **the app's address, only once every check holds:** the label's row in D1's lookup table must be confirmed
//!    (`app_label.indexed_at`), and the room's default host gets its serve row, with no script. Either missing is
//!    `release_address_pending` (503), which writes nothing and is asked again;
//! 5. then, and only then, the release is `queued`, with its approver, and the driver takes it.
//!
//! **Why the address can't do harm when an approval fails or is refused.** The lookup row is written to D1 before the
//! transaction, so a refusal after it leaves it there; but it only routes a question to this room, which answers from
//! its own rows, and the label is this room's for ever. The serve row is written in the approval's own transaction,
//! only once every check holds, and it names no script, so it serves nothing until a release is committed live.
//!
//! **Decline** passes no gate, since it only takes away: `podster_policy::release::authorize_decline` allows it
//! wherever the room is still there. It needs the same standing, then a release awaiting approval, and it writes
//! `declined`, the decliner and the time.
//!
//! **What each writes,** in one transaction with its idempotency record: the release; the audit record
//! `release.approved` or `release.declined` by the person; and the event of the same name about the release, by its ID,
//! **to people only**: the room's owner and its admins who are people (`roles::room_approvers`), and whoever asked
//! for it if that is a person still in the room, the actor left out. A release an approval found failing is audited
//! `release.failed` as Podster's act, and told to the same people. Logs carry IDs and codes only.
//!
//! **The upkeep** ([`Workspace::label_index_upkeep`]), from the room's alarm: every label of the room's that isn't in
//! the lookup table yet is written there, the labels a request made before approval existed among them. A row another
//! room holds is never taken: the label is marked refused with a zero and logged by its code.
use super::release_commit::{end_stale, fail_told};
use super::release_recheck::{
    judge_as, release_now, room_facts, settled, standing_unknown, Asked, Reads, Verdict,
};
use super::release_request::{full_row, view};
use super::*;
use podster_core::release::{is_release_id, next_state, ReleaseEvent, ReleaseState};
use podster_policy::release::{authorize_approval, authorize_decline, ReleaseRoom};

/// What an approval answers, writing nothing, while the app's address isn't ready: its lookup row couldn't be
/// confirmed, or an earlier address of the room's isn't yet confirmed taken down. Asked again, it may hold.
const ADDRESS_PENDING: &str = "release_address_pending";
/// The most labels the upkeep writes to the lookup table in one alarm.
const INDEX_BATCH: i64 = 10;

/// What an approval read outside the room before its transaction. Never taken from a request.
pub(super) struct ApprovalReads {
    /// Every fact the job's recheck reads, with the caller asked about as the approver.
    recheck: Reads,
    /// Whether the release's label is in D1's lookup table as this room's: `Some(true)` it was written or found
    /// there, `Some(false)` another room's row is there, `None` not asked, because the room already recorded it, or
    /// D1 didn't answer.
    indexed: Option<bool>,
}

/// What a decline read outside the room: the decider's own record.
pub(super) struct DeclineReads {
    decider: Asked,
}

/// Whether someone may approve or decline at all, by the room's rows alone: a person who is the room's owner or an
/// admin. Asked before anything outside the room is read, and again in the transaction on every attempt.
pub(super) fn may_decide(who: &Participant) -> R<()> {
    authorize_approval(&who.caller, true, &ReleaseRoom::OPEN).map_err(super::release_config::denial)
}

/// The release a path names, if it has a release's form. Anything else is a release this room doesn't have.
pub(super) fn named(release: &str) -> R<String> {
    is_release_id(release)
        .then(|| release.to_owned())
        .ok_or_else(ApiError::not_found)
}

/// The decider's own record, about whoever the rows name now: `Ok(true)` they hold, `Ok(false)` they read as having
/// left, `Err(standing_unknown)` it gave no answer.
fn decider_holds(sql: &SqlStorage, who: &Participant, asked: &Asked) -> R<Option<bool>> {
    settled(sql, asked, Some(&who.caller.id), true)
}

/// **The standing of an approval,** on every attempt, a replay included: [`may_decide`] on the rows, then the
/// approver's own record as read for this attempt. Left is `not_allowed`; no answer is `standing_unknown`.
pub(super) fn approve_standing(
    sql: &SqlStorage,
    who: &Participant,
    reads: &ApprovalReads,
) -> R<()> {
    may_decide(who)?;
    let holds = decider_holds(sql, who, reads.recheck.approver())?;
    authorize_approval(&who.caller, holds.unwrap_or(true), &ReleaseRoom::OPEN)
        .map_err(super::release_config::denial)?;
    holds.map(|_| ()).ok_or_else(standing_unknown)
}

/// **The standing of a decline,** on every attempt: [`may_decide`], then `authorize_decline` with the decider's own
/// record as read for this attempt, wherever the room is still there.
pub(super) fn decline_standing(sql: &SqlStorage, who: &Participant, reads: &DeclineReads) -> R<()> {
    may_decide(who)?;
    let holds = decider_holds(sql, who, &reads.decider)?;
    // Only a deleted room or organization refuses a decline; the rest of what the room's rows say doesn't.
    let facts = room_facts(sql, true, true)?;
    let room = ReleaseRoom {
        deleted: facts.deleted,
        organization_exists: facts.organization_exists,
        ..ReleaseRoom::OPEN
    };
    authorize_decline(&who.caller, holds.unwrap_or(true), &room)
        .map_err(super::release_config::denial)?;
    holds.map(|_| ()).ok_or_else(standing_unknown)
}

/// The release, which must be awaiting approval. One the room doesn't have is `not_found`; one in any other state,
/// ended by the room's bookkeeping included, is `invalid_transition`.
fn awaiting(sql: &SqlStorage, release_id: &str) -> R<Value> {
    let found = rows(
        sql,
        "SELECT id, state, task_id, commit_sha, config_version, release_epoch, label, script_name, script_release_id,
           failure_code, requested_by FROM release WHERE id = ?",
        vec![release_id.into()],
    )?;
    let release = found.into_iter().next().ok_or_else(ApiError::not_found)?;
    if release["state"].as_str() != Some(ReleaseState::AwaitingApproval.name()) {
        // error-codes: invalid_transition
        return Err(ApiError::api(409, "invalid_transition"));
    }
    Ok(release)
}

/// Who hears of a decision on a release: those who may approve, who are people, and whoever asked if they are a person
/// still in the room. Never the actor, and never an agent.
fn told(sql: &SqlStorage, actor: &str, requester: &str) -> R<Vec<String>> {
    let mut people = roles::room_approvers(sql, actor)?;
    let requester_is_person = repositories::recorded_giver(sql, requester)?
        .is_some_and(|record| record.kind == PrincipalKind::Person);
    if requester != actor && requester_is_person && !people.iter().any(|p| p == requester) {
        people.push(requester.to_owned());
    }
    Ok(people)
}

fn room_id(sql: &SqlStorage) -> String {
    rows(sql, "SELECT id FROM workspace", vec![])
        .ok()
        .and_then(|found| found.first().and_then(|row| text(&row["id"])))
        .unwrap_or_default()
}

fn pending(sql: &SqlStorage, release_id: &str, code: &str) -> ApiError {
    console_error!(
        "release: an approval waits for the app's address: room={} release={} code={}",
        room_id(sql),
        release_id,
        code
    );
    ApiError::api(503, ADDRESS_PENDING)
}

/// **The app's address,** inside the approval's transaction, once every check holds: the label's lookup row confirmed,
/// and the default host's serve row, naming no script. An earlier default host, under a label an unpublish retired,
/// is replaced only once the room's applier has confirmed it serves nothing; until then the approval waits.
fn address(
    sql: &SqlStorage,
    release_id: &str,
    label: &str,
    indexed: Option<bool>,
    domain: Option<&str>,
    now: i64,
) -> R<()> {
    let row = rows(
        sql,
        "SELECT current, indexed_at FROM app_label WHERE label = ?",
        vec![label.into()],
    )?;
    let row = row
        .first()
        .ok_or_else(|| ApiError::internal("a release's label isn't there"))?;
    if row["current"].is_null() {
        // A retired label means an unpublish, which moved the epoch: the recheck refuses before this.
        return Err(ApiError::internal("a release's label isn't current"));
    }
    match (row["indexed_at"].as_i64(), indexed) {
        (Some(at), _) if at > 0 => {}
        (None, Some(true)) => exec(
            sql,
            "UPDATE app_label SET indexed_at = ? WHERE label = ? AND indexed_at IS NULL",
            vec![now.into(), label.into()],
        )?,
        _ => return Err(pending(sql, release_id, "app_label_not_indexed")),
    }
    let Some(domain) = domain else {
        console_error!(
            "release: an approval found no content domain: room={} release={} code=content_domain_unset",
            room_id(sql),
            release_id
        );
        return Err(crate::releases::release_not_available());
    };
    let host = format!("{label}.{domain}");
    let found = rows(
        sql,
        "SELECT s.host, s.script_name, s.version, a.applied_version, a.applied_script FROM serve_state s
           LEFT JOIN serve_apply a ON a.host = s.host WHERE s.kind = 'default'",
        vec![],
    )?;
    let insert = || {
        exec(
            sql,
            "INSERT INTO serve_state (host, kind, version, updated_at) VALUES (?, 'default', 1, ?)",
            vec![host.as_str().into(), now.into()],
        )
    };
    match found.first() {
        None => insert(),
        Some(row) if row["host"].as_str() == Some(host.as_str()) => Ok(()),
        Some(row) => {
            // The room's earlier address: down only once nothing is wanted there and the applier confirmed it.
            let down = row["script_name"].is_null()
                && row["applied_script"].is_null()
                && row["applied_version"].as_i64() == row["version"].as_i64();
            if !down {
                return Err(pending(sql, release_id, "previous_host_not_down"));
            }
            let old = text(&row["host"]).unwrap_or_default();
            exec(
                sql,
                "DELETE FROM serve_apply WHERE host = ?",
                vec![old.as_str().into()],
            )?;
            exec(
                sql,
                "DELETE FROM serve_state WHERE host = ?",
                vec![old.as_str().into()],
            )?;
            insert()
        }
    }
}

/// `POST releases/{release}/approve`, in the room's transaction, after [`Workspace::approval_reads`]. **Run only as
/// the handler of `command_checked` whose recheck is [`approve_standing`].**
pub(super) fn approve(
    sql: &SqlStorage,
    who: &Participant,
    release_id: &str,
    reads: &ApprovalReads,
    domain: Option<&str>,
) -> R<Value> {
    let now = release_now(sql);
    // Release bookkeeping first, as at the start of every release command: one from before an unpublish is ended.
    end_stale(sql, now)?;
    let caller = &who.caller;
    let release = awaiting(sql, release_id)?;
    let requester = text(&release["requested_by"]).unwrap_or_default();
    match judge_as(sql, &release, &reads.recheck, Some(&caller.id), now)? {
        // Nothing that was read fails, and something couldn't be read: nothing is written.
        Verdict::Unknown => return Err(standing_unknown()),
        // A fact that was read fails: the release ends, as the job would end it, and the answer says so.
        Verdict::Fails(failure) => {
            fail_told(
                sql,
                release_id,
                failure,
                told(sql, &caller.id, &requester)?,
                now,
            )?;
            console_log!(
                "release: an approval found the release failing: room={} release={} code={}",
                room_id(sql),
                release_id,
                failure.code()
            );
            return Ok(view(&full_row(sql, release_id)?));
        }
        Verdict::Holds => {}
    }
    let label = text(&release["label"]).unwrap_or_default();
    address(sql, release_id, &label, reads.indexed, domain, now)?;
    let queued = next_state(ReleaseState::AwaitingApproval, ReleaseEvent::Approve)
        .map_err(|_| ApiError::internal("approval isn't a transition"))?;
    exec(
        sql,
        "UPDATE release SET state = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND state = ?",
        vec![
            queued.name().into(),
            caller.id.as_str().into(),
            now.into(),
            now.into(),
            release_id.into(),
            ReleaseState::AwaitingApproval.name().into(),
        ],
    )?;
    audit(
        sql,
        caller,
        "release.approved",
        release_id,
        Some(json!({ "state": ReleaseState::AwaitingApproval.name() }).to_string()),
        Some(json!({ "state": queued.name() }).to_string()),
        now,
    )?;
    store::record_event_about(
        sql,
        "release.approved",
        &caller.id,
        Some(release_id),
        None,
        &Transition::NONE,
        told(sql, &caller.id, &requester)?,
        now,
    )?;
    Ok(view(&full_row(sql, release_id)?))
}

/// `POST releases/{release}/decline`, in the room's transaction, after [`Workspace::decline_reads`]. **Run only as
/// the handler of `command_checked` whose recheck is [`decline_standing`].**
pub(super) fn decline(sql: &SqlStorage, who: &Participant, release_id: &str) -> R<Value> {
    let now = release_now(sql);
    end_stale(sql, now)?;
    let caller = &who.caller;
    let release = awaiting(sql, release_id)?;
    let requester = text(&release["requested_by"]).unwrap_or_default();
    let declined = next_state(ReleaseState::AwaitingApproval, ReleaseEvent::Decline)
        .map_err(|_| ApiError::internal("declining isn't a transition"))?;
    exec(
        sql,
        "UPDATE release SET state = ?, declined_by = ?, declined_at = ?, finished_at = ?, updated_at = ? WHERE id = ? AND state = ?",
        vec![
            declined.name().into(),
            caller.id.as_str().into(),
            now.into(),
            now.into(),
            now.into(),
            release_id.into(),
            ReleaseState::AwaitingApproval.name().into(),
        ],
    )?;
    audit(
        sql,
        caller,
        "release.declined",
        release_id,
        Some(json!({ "state": ReleaseState::AwaitingApproval.name() }).to_string()),
        Some(json!({ "state": declined.name() }).to_string()),
        now,
    )?;
    store::record_event_about(
        sql,
        "release.declined",
        &caller.id,
        Some(release_id),
        None,
        &Transition::NONE,
        told(sql, &caller.id, &requester)?,
        now,
    )?;
    Ok(view(&full_row(sql, release_id)?))
}

/// Whether the room has a label not yet in D1's lookup table, for the alarm to write.
pub(super) fn label_index_due(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT 1 AS due FROM app_label WHERE indexed_at IS NULL LIMIT 1",
        vec![],
    )?
    .is_empty())
}

/// Writes a label's row in D1's lookup table, if none is there, and reads back whose it is: `true` this room's.
/// A row another room holds is never replaced: a label is one room's for ever.
async fn index_label(db: &D1Database, room: &str, label: &str, now: i64) -> R<bool> {
    db.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, ?) ON CONFLICT (label) DO NOTHING")
        .bind(&[label.into(), room.into(), JsValue::from_f64(now as f64)])?
        .run()
        .await?;
    let holder = db
        .prepare("SELECT workspace_id FROM app_label_index WHERE label = ?")
        .bind(&[label.into()])?
        .first::<Value>(None)
        .await?;
    Ok(holder.as_ref().and_then(|row| row["workspace_id"].as_str()) == Some(room))
}

impl Workspace {
    /// Everything an approval reads outside the room, before its transaction: the gate first, then every fact the
    /// job's recheck reads, afresh, with the caller asked about as the approver, then the label's lookup row.
    pub(super) async fn approval_reads(
        &self,
        release_id: &str,
        caller_id: &str,
    ) -> R<ApprovalReads> {
        self.release_path_open().await?;
        let recheck = self.release_reads_as(release_id, Some(caller_id)).await?;
        let sql = self.state.storage().sql();
        let unindexed = rows(
            &sql,
            "SELECT r.label FROM release r JOIN app_label l ON l.label = r.label WHERE r.id = ? AND l.indexed_at IS NULL",
            vec![release_id.into()],
        )?
        .first()
        .and_then(|row| text(&row["label"]));
        let indexed = match unindexed {
            Some(label) => match self.env.d1("DB") {
                Ok(db) => index_label(&db, &objects::room_id(&sql)?, &label, release_now(&sql))
                    .await
                    .ok(),
                Err(_) => None,
            },
            None => None,
        };
        Ok(ApprovalReads { recheck, indexed })
    }

    /// What a decline reads outside the room: the decider's own record. No gate: declining only takes away.
    pub(super) async fn decline_reads(&self, caller_id: &str) -> R<DeclineReads> {
        Ok(DeclineReads {
            decider: self.still_holds(Some(caller_id), true).await?,
        })
    }

    /// The alarm's part for the app's labels: each label not yet in D1's lookup table is written there, a few at a
    /// time. A row another room holds is left, and the label marked refused with a zero, logged by its code.
    pub(super) async fn label_index_upkeep(&self, sql: &SqlStorage) -> R<()> {
        if !store::is_initialized(sql)? || store::needs_migration(sql)? {
            return Ok(());
        }
        let due: Vec<String> = rows(
            sql,
            "SELECT label FROM app_label WHERE indexed_at IS NULL ORDER BY created_at, label LIMIT ?",
            vec![INDEX_BATCH.into()],
        )?
        .iter()
        .filter_map(|row| text(&row["label"]))
        .collect();
        if due.is_empty() {
            return Ok(());
        }
        let db = self.env.d1("DB")?;
        let room = objects::room_id(sql)?;
        for label in due {
            let ours = index_label(&db, &room, &label, now_ms()).await?;
            if !ours {
                console_error!(
                    "release: a label's lookup row is another room's: room={} code=app_label_held_by_another_room",
                    room
                );
            }
            exec(
                sql,
                "UPDATE app_label SET indexed_at = ? WHERE label = ? AND indexed_at IS NULL",
                vec![
                    if ours { now_ms() } else { 0 }.into(),
                    label.as_str().into(),
                ],
            )?;
        }
        Ok(())
    }
}
