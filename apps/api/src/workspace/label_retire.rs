//! An operator retires a room's current app label that another room's lookup row holds (`retireAppLabel`,
//! `POST /v1/moderation/apps/{label}/retire`; M6 step 6, 6f's open item 3, owed before `RELEASE_PATH_COMPLETE` flips).
//!
//! **Why.** A label is one room's for ever, and D1's lookup table never gives another room's row away. So when a
//! room's current label is found there under another room (`app_label_taken`), its approvals refuse
//! `release_label_taken` for good, and nothing else gives the room a new label. Labels are drawn from 128 random bits,
//! so this is a corruption case, not an expected one, and a person looks at it: the operator.
//!
//! **What may be retired, narrowly** (the architect's to widen):
//! - the room's **current** label, named by the operator and checked here, so the lookup table that named the other room
//!   can never point this command at the wrong one; a label that isn't the room's is `not_found`;
//! - **only while no approval ever held for it:** the room hasn't recorded it as its own in the lookup table
//!   (`app_label.indexed_at` is unset, or `0`, the upkeep's mark for a row another room holds), no approval is recorded
//!   for it (`app_label_approval`), and no release under it ever got past awaiting approval. An approval writes all of
//!   that before anything is queued, so under such a label nothing was ever uploaded, served, kept or given a store, and
//!   retiring it takes nothing down. Otherwise it is `app_label_not_taken` (409);
//! - **and only while D1's row for it names another room,** read for this attempt. A row that is this room's, or none,
//!   is `app_label_not_taken` too: the room's approvals would hold, so nothing needs retiring.
//!
//! **What it writes,** in one transaction, after the checks above are made again on the room's rows: the label retired
//! (`current` cleared, `retired_at` now), each release under it still awaiting approval ended `failed` with
//! `release_label_retired`, as the job ends a release whose label is no longer current, told as `release.failed`; and
//! the audit record `app.label_retired`, as Podster, with the operator's reason, never the operator's ID, which stays in
//! the `Moderation` object's log, and the event of the same name to the room's managers, as a suspension is told. **No epoch moves and nothing is unpublished,** since nothing was served: the room's
//! next request draws a new label, as after an unpublish. The retired label stays in the room's table, so it is never
//! drawn again. Asking again for a label already retired changes nothing and answers the same.
//!
//! Behind the gate on the release path, as approving is: while `RELEASE_PATH_COMPLETE` is false, a deployment with
//! release on and a provider configured answers `release_not_available` and nothing is read or written. The route
//! exists only while release is switched on, as every M6 route. Logs carry the room's ID and codes, never a label.
use super::release_commit::{fail, label_current};
use super::release_recheck::release_now;
use super::*;
use podster_core::release::{is_label, UploadFailure};

/// The Worker's call, for a verified operator. Nothing outside the Worker reaches it.
pub(crate) const INTERNAL_LABEL_RETIRE: &str = "/internal/app-label-retire";

/// The refusal of a label the room may still release under, or one an approval held for.
fn not_taken() -> ApiError {
    // error-codes: app_label_not_taken
    ApiError::api(409, "app_label_not_taken")
}

/// The label's row in the room, if it is the room's own, current or retired.
fn label_row(sql: &SqlStorage, label: &str) -> R<Option<Value>> {
    Ok(rows(
        sql,
        "SELECT label, kind, current, retired_at, indexed_at FROM app_label WHERE label = ?",
        vec![label.into()],
    )?
    .into_iter()
    .next())
}

/// Whether the room's own rows say no approval ever held for the label: the room hasn't recorded it as its own in the
/// lookup table (unset, or `0`, another room's), recorded no approval for it, and no release under it went past
/// awaiting approval.
fn never_approved(sql: &SqlStorage, row: &Value, label: &str) -> R<bool> {
    let indexed_as_ours = row["indexed_at"].as_i64().is_some_and(|at| at > 0);
    let approved = !rows(
        sql,
        "SELECT 1 AS approved FROM app_label_approval WHERE label = ?
         UNION ALL SELECT 1 AS approved FROM release WHERE label = ? AND (approved_by IS NOT NULL
           OR state NOT IN ('awaiting_approval', 'declined', 'failed')) LIMIT 1",
        vec![label.into(), label.into()],
    )?
    .is_empty();
    Ok(!indexed_as_ours && !approved)
}

/// The answer: `{ label, retired, retired_at }`.
fn answer(row: &Value) -> Value {
    // Retired is `retired_at` set, for either kind: a preview label is never current, and is live until then.
    json!({ "label": row["label"], "retired": !row["retired_at"].is_null(), "retired_at": row["retired_at"] })
}

/// In the room's transaction, with what D1 said of the label read just before it: the checks again on the room's rows,
/// then the retirement. Answers as [`answer`].
fn retire(sql: &SqlStorage, label: &str, taken: bool, reason: &str, now: i64) -> R<Value> {
    let row = label_row(sql, label)?.ok_or_else(ApiError::not_found)?;
    // **A preview label is never current and is live until retired** (M8 step 6; room schema step 64), so "not current"
    // doesn't mean retired for it. This command retires production's current label only: a preview label is retired by
    // deleting the preview, its owner's or a trigger's, and is answered here as not taken while it is live.
    if row["kind"].as_str() == Some("preview") {
        if row["retired_at"].is_null() {
            return Err(not_taken());
        }
        return Ok(answer(&row));
    }
    if row["current"].is_null() {
        return Ok(answer(&row));
    }
    if !taken || !never_approved(sql, &row, label)? {
        return Err(not_taken());
    }
    exec(
        sql,
        "UPDATE app_label SET current = NULL, retired_at = ? WHERE label = ? AND current = 1",
        vec![now.into(), label.into()],
    )?;
    if label_current(sql, label)? {
        return Err(ApiError::internal("a label wasn't retired"));
    }
    for release in rows(
        sql,
        "SELECT id FROM release WHERE label = ? AND state = 'awaiting_approval' ORDER BY seq",
        vec![label.into()],
    )? {
        if let Some(id) = text(&release["id"]) {
            fail(sql, &id, UploadFailure::LabelRetired.code(), None, now)?;
        }
    }
    audit_as(
        sql,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        "app.label_retired",
        "app",
        Some(json!({ "current": true }).to_string()),
        Some(json!({ "current": false, "reason": reason }).to_string()),
        now,
    )?;
    // Told to the room's managers, as an operator's suspension of the app is, by Podster and with no label.
    record_event(
        sql,
        "app.label_retired",
        moderation::PODSTER,
        None,
        &Transition::NONE,
        roles::room_managers(sql, moderation::PODSTER)?,
        now,
    )?;
    let after = label_row(sql, label)?.ok_or_else(ApiError::not_found)?;
    Ok(answer(&after))
}

/// Whose D1's lookup row for the label is: `Some(true)` another room's, `Some(false)` this room's or none.
async fn held_elsewhere(db: &D1Database, room: &str, label: &str) -> R<bool> {
    let holder = db
        .prepare("SELECT workspace_id FROM app_label_index WHERE label = ?")
        .bind(&[label.into()])?
        .first::<Value>(None)
        .await?;
    Ok(holder
        .as_ref()
        .and_then(|row| row["workspace_id"].as_str())
        .is_some_and(|found| found != room))
}

impl Workspace {
    /// `{ label, reason }`, from the Worker for a verified operator: retires the room's current label, as the module
    /// says. A room that doesn't exist, or a label that isn't the room's, is `not_found`.
    pub(super) async fn label_retire(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Err(ApiError::not_found());
        }
        self.migrate_if_needed()?;
        let body: Value =
            serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
        let label = body["label"]
            .as_str()
            .filter(|label| is_label(label))
            .ok_or_else(ApiError::invalid_argument)?
            .to_owned();
        let reason = body["reason"]
            .as_str()
            .and_then(podster_policy::moderation::Reason::from_name)
            .ok_or_else(ApiError::invalid_argument)?;
        self.release_path_open().await?;
        let Some(row) = label_row(&sql, &label)? else {
            return Err(ApiError::not_found());
        };
        // A preview label (M8 step 6): retired only by deleting the preview, so a live one is not taken here.
        if row["kind"].as_str() == Some("preview") {
            return if row["retired_at"].is_null() {
                Err(not_taken())
            } else {
                Ok(answer(&row))
            };
        }
        if row["current"].is_null() {
            return Ok(answer(&row));
        }
        // Refused on the room's rows before D1 is read; asked again in the transaction.
        if !never_approved(&sql, &row, &label)? {
            return Err(not_taken());
        }
        let room = objects::room_id(&sql)?;
        let taken = held_elsewhere(&self.env.d1("DB")?, &room, &label).await?;
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let (slot, store, retired) = (out.clone(), sql.clone(), label.clone());
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(retire(
                &store,
                &retired,
                taken,
                reason.name(),
                release_now(&store),
            )?);
            Ok(())
        })?;
        console_log!(
            "release: an operator retired the room's label: room={} code=app_label_retired",
            room
        );
        // A release it ended has events to deliver.
        self.arm(false, false).await?;
        let answer = out.borrow_mut().take();
        answer.ok_or_else(|| ApiError::internal("a label's retirement answered nothing"))
    }
}
