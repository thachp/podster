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
//! 1. who, by the room's rows ([`may_decide`]);
//! 2. the gate on the release path (`Workspace::release_path_open`), before anything outside the room is read: while
//!    `RELEASE_PATH_COMPLETE` is false, a deployment with release on and a provider configured answers
//!    `release_not_available` and nothing is read or written;
//! 3. **the approver's own record, before anything else is read or written** ([`Workspace::approval_reads`]): someone
//!    whose `Principal` says they left is `not_allowed`, and one that gives no answer `standing_unknown`, before the
//!    deployment's setting or the organization's switch is read and applied, and before D1 is written;
//! 4. **every outside fact, read again for this approval** (`Workspace::release_reads_as`): the content domain's stop,
//!    the deployment's setting, the organization's release switch and provisioning delegation, and the approver's,
//!    the requester's and the grant giver's own records. Nothing is taken from what the request read; the request
//!    kept none of it. Then the label's row in D1's lookup table, written if the room hasn't recorded it;
//! 5. in the room's transaction, the standing above, on this attempt's reads; then the release, which must be awaiting
//!    approval (`invalid_transition` otherwise; the room's bookkeeping ends one from before an unpublish first); then
//!    **core's whole recheck** (`release_recheck::judge_as`, with the caller as approver), on the room's rows now and
//!    those reads, which asserts among the rest that the release's configuration version and release epoch are still
//!    the room's current ones. **A fact that was read and fails ends the release `failed` with its code,** as the job
//!    would, and the answer is the release so ended; **a fact that couldn't be read, with nothing read failing, is
//!    `standing_unknown`, which writes nothing;**
//! 6. **the app's address, only once every check holds** ([`address`]): the label's lookup row must be this room's
//!    (`app_label.indexed_at`), and the room's default host gets its serve row, with no script. A lookup row not yet
//!    confirmed, or an earlier address still serving, is `release_address_pending` (503); a label whose row names
//!    another room is `release_label_taken` (409), which no retry changes, and operators are told. Each writes nothing;
//! 7. then, and only then, the release is `queued`, with its approver, the label is marked approved
//!    (`app_label_approval`), and the driver takes it.
//!
//! **Why the address can't do harm when an approval fails or is refused.** The lookup row is written to D1 before the
//! transaction, so a refusal after it leaves it there; but it only routes a question to this room, which answers from
//! its own rows, and a row is never taken from another room. The serve row is written in the approval's own
//! transaction, only once every check holds, and it names no script, so it serves nothing until a release is committed
//! live. **An earlier default host is kept,** marked retired (`serve_retired`), never deleted: the applier goes on
//! answering for it, so a write to it that lands late is still put right. **A retired host is taken back, not inserted
//! again,** when the address names it once more, as after the content domain is changed and changed back
//! (2026-11-23, owed from the re-review of #411).
//!
//! **A label another room's lookup row holds** stays refused until an operator retires it (`label_retire`); operators
//! are told by the finding `app_label_taken`, with this room's ID in its `detail`.
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
//! **The upkeep** ([`Workspace::label_index_upkeep`]), from the room's alarm, **only where release is switched on and
//! the gate on the release path is open**: every label of the room's not in the lookup table yet is written there, the
//! labels a request made before approval existed among them, and every label an approval held for is marked approved
//! there, which is what the repository-unpublish ceiling counts as a room with an app. A row naming another room is
//! never taken: the label is marked `0`, operators are told (`app_label_taken`), and its approval refuses for good. A
//! row not read back stays unmarked and is tried again.
use super::release_commit::{end_stale, fail_told};
use super::release_recheck::{
    judge_as, release_now, room_facts, settled, standing_unknown, Asked, Reads, Verdict,
};
use super::release_request::{full_row, view};
use super::*;
use podster_core::release::{is_release_id, next_state, ReleaseEvent, ReleaseState};
use podster_policy::release::{authorize_approval, authorize_decline, ReleaseRoom};

/// What an approval answers, writing nothing, while the app's address isn't ready: its lookup row couldn't be
/// confirmed, or an earlier address of the room's still serves. Asked again, it may hold.
const ADDRESS_PENDING: &str = "release_address_pending";
/// The operators' finding for a label whose lookup row names another room, by the label.
const LABEL_TAKEN_FINDING: &str = "app_label_taken";
/// The most labels the upkeep writes to the lookup table in one alarm.
const INDEX_BATCH: i64 = 10;

/// Whose a label's lookup row is, as D1 answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Holder {
    /// This room's: written now or found so.
    Ours,
    /// Another room's. A label is one room's for ever, so this never changes.
    Taken,
    /// No answer: D1 failed, or the row wasn't read back. Asked again later.
    Unknown,
}

/// What an approval read outside the room before its transaction. Never taken from a request.
pub(super) struct ApprovalReads {
    /// Every fact the job's recheck reads, with the caller asked about as the approver.
    recheck: Reads,
    /// Whose the release's label's lookup row is, if the room hadn't recorded it; `None` when it had, and nothing was
    /// asked.
    holder: Option<Holder>,
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

/// The decider's own record, about whoever the rows name now: `Some(true)` they hold, `Some(false)` they read as
/// having left, `None` it gave no answer.
fn decider_holds(sql: &SqlStorage, caller_id: &str, asked: &Asked) -> R<Option<bool>> {
    settled(sql, asked, Some(caller_id), true)
}

/// A decider's record as policy takes it: left is `not_allowed`, no answer `standing_unknown`.
fn decider_standing(caller: &Caller, holds: Option<bool>) -> R<()> {
    authorize_approval(caller, holds.unwrap_or(true), &ReleaseRoom::OPEN)
        .map_err(super::release_config::denial)?;
    holds.map(|_| ()).ok_or_else(standing_unknown)
}

/// **The standing of an approval,** on every attempt, a replay included: [`may_decide`] on the rows, then the
/// approver's own record as read for this attempt. Left is `not_allowed`; no answer is `standing_unknown`.
pub(super) fn approve_standing(
    sql: &SqlStorage,
    who: &Participant,
    reads: &ApprovalReads,
) -> R<()> {
    may_decide(who)?;
    let holds = decider_holds(sql, &who.caller.id, reads.recheck.approver())?;
    decider_standing(&who.caller, holds)
}

/// **The standing of a decline,** on every attempt: [`may_decide`], then `authorize_decline` with the decider's own
/// record as read for this attempt, wherever the room is still there.
pub(super) fn decline_standing(sql: &SqlStorage, who: &Participant, reads: &DeclineReads) -> R<()> {
    may_decide(who)?;
    let holds = decider_holds(sql, &who.caller.id, &reads.decider)?;
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

fn label_taken(sql: &SqlStorage, release_id: &str) -> ApiError {
    console_error!(
        "release: an approval's label is another room's: room={} release={} code=app_label_taken",
        room_id(sql),
        release_id
    );
    // error-codes: release_label_taken
    ApiError::api(409, "release_label_taken")
}

/// The content domain, as the approval names the address on it. Test builds only: a room a test gives
/// `test_content_domain_unset` has none, as a deployment that configures none.
fn domain_for(sql: &SqlStorage, domain: Option<&str>) -> Option<String> {
    #[cfg(feature = "failpoints")]
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_content_domain_unset'",
        vec![],
    )
    .is_ok_and(|found| !found.is_empty())
    {
        return None;
    }
    // Test builds only: a room a test gives `test_content_domain` names its address on that domain instead, as a
    // deployment whose content domain was changed.
    #[cfg(feature = "failpoints")]
    if let Some(changed) = rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_content_domain'",
        vec![],
    )
    .ok()
    .filter(|found| !found.is_empty())
    .and_then(|_| rows(sql, "SELECT domain FROM test_content_domain", vec![]).ok())
    .and_then(|found| found.first().and_then(|row| text(&row["domain"])))
    {
        return Some(changed);
    }
    let _ = sql;
    domain.map(str::to_owned)
}

/// Whether the room's earlier default host serves nothing: nothing is wanted there, and either the applier confirmed
/// that version with no script, or the provider refused that version, or no applier ever wrote it, as in a room with
/// no provider.
fn host_down(row: &Value) -> bool {
    row["script_name"].is_null()
        && (row["apply_host"].is_null()
            || (row["applied_script"].is_null()
                && row["applied_version"].as_i64() == row["version"].as_i64())
            || row["refused_version"].as_i64() == row["version"].as_i64())
}

/// **The app's address,** inside the approval's transaction, once every check holds: the label's lookup row this
/// room's, and the default host's serve row, naming no script. An earlier default host, under a label an unpublish
/// retired, is kept and marked retired once it serves nothing ([`host_down`]); until then the approval waits.
fn address(
    sql: &SqlStorage,
    release_id: &str,
    label: &str,
    holder: Option<Holder>,
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
    match (row["indexed_at"].as_i64(), holder) {
        (Some(at), _) if at > 0 => {}
        (Some(_), _) | (None, Some(Holder::Taken)) => return Err(label_taken(sql, release_id)),
        (None, Some(Holder::Ours)) => exec(
            sql,
            "UPDATE app_label SET indexed_at = ? WHERE label = ? AND indexed_at IS NULL",
            vec![now.into(), label.into()],
        )?,
        (None, _) => return Err(pending(sql, release_id, "app_label_not_indexed")),
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
        "SELECT s.host, s.script_name, s.version, a.host AS apply_host, a.applied_version, a.applied_script, a.refused_version
           FROM serve_state s LEFT JOIN serve_apply a ON a.host = s.host
          WHERE s.kind = 'default' AND s.host NOT IN (SELECT host FROM serve_retired)",
        vec![],
    )?;
    // The host on the domain now. **A host the room retired is taken back, never inserted again** (owed from the
    // re-review of #411): a content domain changed and then changed back names an address the room already has, kept
    // retired, and its rows are reused as they are. It serves nothing: it was retired only once it was down, and nothing
    // gives a retired host a script.
    let insert = || -> R<()> {
        let kept = rows(
            sql,
            "SELECT s.kind, s.script_name FROM serve_retired r JOIN serve_state s ON s.host = r.host WHERE r.host = ?",
            vec![host.as_str().into()],
        )?;
        if let Some(row) = kept.first() {
            if row["kind"].as_str() != Some("default") || !row["script_name"].is_null() {
                return Err(ApiError::internal(
                    "a retired host isn't a default host serving nothing",
                ));
            }
            return exec(
                sql,
                "DELETE FROM serve_retired WHERE host = ?",
                vec![host.as_str().into()],
            );
        }
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
            if !host_down(row) {
                return Err(pending(sql, release_id, "previous_host_not_down"));
            }
            // Kept, never deleted: the applier goes on answering for it.
            exec(
                sql,
                "INSERT INTO serve_retired (host, retired_at) VALUES (?, ?)",
                vec![row["host"].as_str().unwrap_or_default().into(), now.into()],
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
    let domain = domain_for(sql, domain);
    address(
        sql,
        release_id,
        &label,
        reads.holder,
        domain.as_deref(),
        now,
    )?;
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
    // The label has had an approval that held: the repository-unpublish ceiling counts its room as one with an app,
    // once the upkeep has marked it in the lookup table.
    exec(
        sql,
        "INSERT OR IGNORE INTO app_label_approval (label, approved_at) VALUES (?, ?)",
        vec![label.as_str().into(), now.into()],
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

/// Whether the room has a label not yet in D1's lookup table, or an approval not yet marked there, for the alarm.
pub(super) fn label_index_due(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT 1 AS due FROM app_label WHERE indexed_at IS NULL
         UNION ALL SELECT 1 AS due FROM app_label_approval WHERE indexed_at IS NULL LIMIT 1",
        vec![],
    )?
    .is_empty())
}

/// Writes a label's row in D1's lookup table, if none is there, and reads back whose it is. A row another room holds
/// is never replaced: a label is one room's for ever. A row not read back is [`Holder::Unknown`].
async fn index_label(db: &D1Database, room: &str, label: &str, now: i64) -> R<Holder> {
    db.prepare("INSERT INTO app_label_index (label, workspace_id, created_at) VALUES (?, ?, ?) ON CONFLICT (label) DO NOTHING")
        .bind(&[label.into(), room.into(), JsValue::from_f64(now as f64)])?
        .run()
        .await?;
    let holder = db
        .prepare("SELECT workspace_id FROM app_label_index WHERE label = ?")
        .bind(&[label.into()])?
        .first::<Value>(None)
        .await?;
    Ok(
        match holder.as_ref().and_then(|row| row["workspace_id"].as_str()) {
            Some(found) if found == room => Holder::Ours,
            Some(_) => Holder::Taken,
            None => Holder::Unknown,
        },
    )
}

/// Marks a label approved in its lookup row, writing the row if it isn't there, and reads back whose it is and
/// whether the mark is there. Another room's row is never touched.
async fn mark_approved(
    db: &D1Database,
    room: &str,
    label: &str,
    approved_at: i64,
    now: i64,
) -> R<Holder> {
    db.prepare(
        "INSERT INTO app_label_index (label, workspace_id, created_at, approved_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (label) DO UPDATE SET approved_at = coalesce(app_label_index.approved_at, excluded.approved_at)
           WHERE app_label_index.workspace_id = excluded.workspace_id",
    )
    .bind(&[
        label.into(),
        room.into(),
        JsValue::from_f64(now as f64),
        JsValue::from_f64(approved_at as f64),
    ])?
    .run()
    .await?;
    let found = db
        .prepare("SELECT workspace_id, approved_at FROM app_label_index WHERE label = ?")
        .bind(&[label.into()])?
        .first::<Value>(None)
        .await?;
    Ok(match found {
        Some(row)
            if row["workspace_id"].as_str() == Some(room) && !row["approved_at"].is_null() =>
        {
            Holder::Ours
        }
        Some(row)
            if row["workspace_id"]
                .as_str()
                .is_some_and(|found| found != room) =>
        {
            Holder::Taken
        }
        _ => Holder::Unknown,
    })
}

impl Workspace {
    /// Everything an approval reads outside the room, before its transaction, in the module's order: the gate, then the
    /// approver's own record, which must hold before anything else is read or written, then every fact the job's
    /// recheck reads, afresh, with the caller asked about as the approver, then the label's lookup row.
    pub(super) async fn approval_reads(
        &self,
        release_id: &str,
        caller: &Caller,
    ) -> R<ApprovalReads> {
        self.release_path_open().await?;
        let own = self.still_holds(Some(&caller.id), true).await?;
        let sql = self.state.storage().sql();
        decider_standing(caller, decider_holds(&sql, &caller.id, &own)?)?;
        let recheck = self.release_reads_as(release_id, Some(&caller.id)).await?;
        let unindexed = rows(
            &sql,
            "SELECT r.label FROM release r JOIN app_label l ON l.label = r.label WHERE r.id = ? AND l.indexed_at IS NULL",
            vec![release_id.into()],
        )?
        .first()
        .and_then(|row| text(&row["label"]));
        let holder = match unindexed {
            Some(label) => {
                let asked = match self.env.d1("DB") {
                    Ok(db) => index_label(&db, &objects::room_id(&sql)?, &label, release_now(&sql))
                        .await
                        .unwrap_or(Holder::Unknown),
                    Err(_) => Holder::Unknown,
                };
                if asked == Holder::Taken {
                    self.tell_label_taken(&label).await;
                }
                Some(asked)
            }
            None => None,
        };
        Ok(ApprovalReads { recheck, holder })
    }

    /// What a decline reads outside the room: the decider's own record. No gate: declining only takes away.
    pub(super) async fn decline_reads(&self, caller_id: &str) -> R<DeclineReads> {
        Ok(DeclineReads {
            decider: self.still_holds(Some(caller_id), true).await?,
        })
    }

    /// Operators are told, by the label, that its lookup row names another room, with this room's ID in `detail`: the
    /// lookup table can't route an operator here, and retiring the label (`retireAppLabel`) needs to name this room.
    /// If the telling fails, the next approval or alarm tells again. **A room ID that can't be read is never sent as an
    /// empty one:** the finding is still raised, with no `detail`, and the failure is logged by its code, so an operator
    /// who can't route to the room sees why.
    async fn tell_label_taken(&self, label: &str) {
        let room = match objects::room_id(&self.state.storage().sql()) {
            Ok(room) => Some(room),
            Err(error) => {
                console_error!(
                    "release: a label taken couldn't name its room: code={}",
                    error.code().unwrap_or("internal_error")
                );
                None
            }
        };
        let finding = json!({ "code": LABEL_TAKEN_FINDING, "subject": label, "detail": room });
        let told = crate::moderation::call(
            &self.env,
            crate::reconcile::FINDING_PATH,
            Method::Post,
            Some(finding),
        )
        .await
        .is_ok_and(|response| response.status_code() == 200);
        if !told {
            console_error!(
                "release: operators weren't told of a label taken: code=finding_not_kept"
            );
        }
    }

    /// Whether the labels' upkeep may run: only where release is switched on and the gate on the release path is
    /// open, as for every release command. Says nothing when it isn't: the alarm asks this on every pass.
    pub(super) async fn label_index_open(&self, sql: &SqlStorage) -> bool {
        (super::release_commit::RELEASE_PATH_COMPLETE
            || takedown::provider(&self.env, sql).is_none())
            && crate::releases::switched_on(&self.env).await
    }

    /// The alarm's part for the app's labels, only while [`Workspace::label_index_open`]: each label not yet in D1's
    /// lookup table is written there, and each label an approval held for is marked approved there, a few of each at a
    /// time, stamped by the release commands' clock. A row naming another room is left: the label is marked `0`,
    /// and operators are told. A row not read back is left unmarked, tried again, and fails the pass so the alarm
    /// waits before it does.
    pub(super) async fn label_index_upkeep(&self, sql: &SqlStorage) -> R<()> {
        if !store::is_initialized(sql)?
            || store::needs_migration(sql)?
            || !label_index_due(sql)?
            || !self.label_index_open(sql).await
        {
            return Ok(());
        }
        let db = self.env.d1("DB")?;
        let room = objects::room_id(sql)?;
        let mut unread = false;
        let labels: Vec<String> = rows(
            sql,
            "SELECT label FROM app_label WHERE indexed_at IS NULL ORDER BY created_at, label LIMIT ?",
            vec![INDEX_BATCH.into()],
        )?
        .iter()
        .filter_map(|row| text(&row["label"]))
        .collect();
        for label in labels {
            let holder = index_label(&db, &room, &label, release_now(sql)).await?;
            let mark = match holder {
                Holder::Ours => release_now(sql),
                Holder::Taken => {
                    console_error!(
                        "release: a label's lookup row is another room's: room={} code=app_label_taken",
                        room
                    );
                    self.tell_label_taken(&label).await;
                    0
                }
                Holder::Unknown => {
                    unread = true;
                    continue;
                }
            };
            exec(
                sql,
                "UPDATE app_label SET indexed_at = ? WHERE label = ? AND indexed_at IS NULL",
                vec![mark.into(), label.as_str().into()],
            )?;
        }
        let approved: Vec<(String, i64)> = rows(
            sql,
            "SELECT label, approved_at FROM app_label_approval WHERE indexed_at IS NULL ORDER BY approved_at, label LIMIT ?",
            vec![INDEX_BATCH.into()],
        )?
        .iter()
        .filter_map(|row| Some((text(&row["label"])?, int(&row["approved_at"]))))
        .collect();
        for (label, approved_at) in approved {
            let mark = match mark_approved(&db, &room, &label, approved_at, release_now(sql))
                .await?
            {
                Holder::Ours => release_now(sql),
                Holder::Taken => {
                    console_error!(
                        "release: an approved label's lookup row is another room's: room={} code=app_label_taken",
                        room
                    );
                    self.tell_label_taken(&label).await;
                    0
                }
                Holder::Unknown => {
                    unread = true;
                    continue;
                }
            };
            exec(
                sql,
                "UPDATE app_label_approval SET indexed_at = ? WHERE label = ? AND indexed_at IS NULL",
                vec![mark.into(), label.as_str().into()],
            )?;
        }
        if unread {
            return Err(ApiError::internal("a label's lookup row wasn't read back"));
        }
        Ok(())
    }
}
