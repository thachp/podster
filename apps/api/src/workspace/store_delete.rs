//! Deleting an app's data (M6 stage 1, S4 of the store plan; ADR 0010's revision, section 3.3 and row 7 of its
//! summary). What it decides is pure, in `podster_core::app_store` ([`owe`], [`delete_step`], [`after_read`],
//! [`after_list`]) and `podster_policy::release::authorize_app_data_delete`; here is what it reads, asks and calls. Every
//! write of the room's record of its store is in `release_store.rs`, still its only writer.
//!
//! - **Two commands.** A Podster operator's, through the operators' route, which suspends the app (exactly an
//!   operator's suspension, committed in its own transaction first, review standard 4) and then owes the deletion. And
//!   the room's owner's, as a person, alone: it owes the deletion only while nothing of the app could still run with the
//!   store, so an app still served answers `app_still_served` and the owner switches release off or waits for the
//!   unpublish first. Each owes it in its own transaction (`delete_owed_at`, a cause from core's closed set), and from then
//!   nothing is bound to the store (rule 3(a)). **Idempotent:** a record owed or gone is left as it is, and the answer is
//!   the same. The answer carries the owner's words, `podster_core::app_store::DATA_DELETED_NOTICE`, exactly.
//! - **Not behind the release path's gate.** Deleting is the takedown direction, and a store exists only where the
//!   create's gate (`RELEASE_PATH_COMPLETE`) once let one be made, so the commands and the job work whenever a store is
//!   recorded and, for the job, a store provider is configured. The routes are behind `RELEASES`, as every M6 route.
//! - **The job,** from the room's alarm, after the applier and the script deletes: a record owed a deletion is deleted at
//!   D1 by its ID, **the delete's answer never trusted,** then read; it counts gone only on D1's own not-found, read twice
//!   at least ten minutes apart (`GONE_SPAN_MS`). A record with a name and no ID is resolved by a whole list read by its
//!   name before anything is decided: listed, its ID is recorded and it is deleted by it. Not listed on two whole lists
//!   ten minutes apart, the first no sooner than ten minutes after its create, it was never made, or is gone. A try that
//!   decides nothing waits longer each time, up to five minutes, and never gives up. **Only a store the room's own record
//!   names is ever deleted:** never one the reconcile tells as an orphan (`store_orphan`), which no room records.
//! - **The record is kept,** `gone_at` set, so the label never has another store made (rule 3(a) refuses it).
//!
//! Logs carry the room's ID and codes: never a label, a store's name or ID, or a token.
use super::release_recheck::release_now;
use super::release_store::{delete_write, kept, owe_delete, DeleteWrite, Kept};
use super::*;
use crate::app_stores::StoreProvider;
use podster_core::app_store::{
    after_list, after_read, data_state, delete_step, delete_wait_ms, owe, DataState, DeleteCause,
    DeleteOutcome, DeleteStep, Owe, DATA_DELETED_NOTICE,
};
use podster_core::release::{is_label, script_owner, ScriptOwner};

/// The Worker's call, for a verified operator: delete an app's data. Nothing outside the Worker reaches it.
pub(crate) const INTERNAL_APP_DATA_DELETE: &str = "/internal/app-data-delete";

/// Records the job takes in one alarm. A room has one store for each label it ever had, a handful at most.
const BATCH: i64 = 4;
/// How long one alarm's pass may go on starting a new record's step. A step is at most two calls of 5 seconds each.
const PASS_BUDGET_MS: i64 = 10_000;

fn log(sql: &SqlStorage, code: &str) {
    console_log!(
        "store delete: room={} code={}",
        release_driver::room_id(sql),
        code
    );
}

/// The answer both commands give: `{ label, data, cause, owed_at, deleted_at, notice }`. `data` is `none` when the room
/// holds no store for the app, `deleting` once owed, and `deleted` once D1 said gone twice. `notice` is the owner's
/// words, exactly, whenever there is data being or been deleted.
fn answer(sql: &SqlStorage, label: &str) -> R<Value> {
    let kept = kept(sql, label)?;
    let state = data_state(kept.as_ref().map(Kept::record).as_ref());
    Ok(json!({
        "label": label,
        "data": state.code(),
        "cause": kept.as_ref().and_then(|kept| kept.delete_cause.clone()),
        "owed_at": kept.as_ref().and_then(|kept| kept.delete_owed_at),
        "deleted_at": kept.as_ref().and_then(|kept| kept.gone_at),
        "notice": (state != DataState::None).then_some(DATA_DELETED_NOTICE),
    }))
}

/// A label of this room's, current or retired, of the label's form. Anything else is a label no room has.
fn own_label(sql: &SqlStorage, label: &str) -> R<()> {
    if !is_label(label)
        || rows(
            sql,
            "SELECT label FROM app_label WHERE label = ?",
            vec![label.into()],
        )?
        .is_empty()
    {
        return Err(ApiError::not_found());
    }
    Ok(())
}

/// Whether anything of the room's app could still run with this label's store: a host the room wants serving one of
/// the label's scripts, the script kept for a rollback, or a commit in flight to one. A release still uploading can't
/// bind a store owed a deletion (rule 3(a)), so it isn't counted.
fn label_serves(sql: &SqlStorage, label: &str) -> R<bool> {
    let of_label = |script: Option<String>| {
        script.is_some_and(|script| {
            matches!(script_owner(&script), ScriptOwner::Podster { label: owner, .. } if owner == label)
        })
    };
    for row in rows(
        sql,
        "SELECT script_name, flight_before FROM serve_state WHERE host NOT IN (SELECT host FROM serve_retired)",
        vec![],
    )? {
        if of_label(text(&row["script_name"])) || of_label(text(&row["flight_before"])) {
            return Ok(true);
        }
    }
    for row in rows(
        sql,
        "SELECT kept_previous, in_flight_script FROM release_config",
        vec![],
    )? {
        if of_label(text(&row["kept_previous"])) || of_label(text(&row["in_flight_script"])) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Who may ask, by the room's rows alone, before anything outside the room is read: the owner, as a person.
pub(super) fn may_ask(who: &Participant) -> R<()> {
    podster_policy::release::authorize_app_data_delete(&who.caller, true)
        .map_err(release_config::denial)
}

/// The owner's body: `{ confirm }`, the app's label again, and nothing else, so the data isn't deleted by a request
/// that didn't name it twice.
fn confirmed(body: &Value, label: &str) -> R<()> {
    let fields = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields.len() != 1 || body["confirm"].as_str() != Some(label) {
        return Err(ApiError::invalid_argument());
    }
    Ok(())
}

/// `POST apps/{label}/delete-data`, the room's owner's, in the room's transaction, after the caller's standing was
/// read (`config_reads`). Who first, then the body, then the label, then the record: no store answers `none` and writes
/// nothing; one owed or gone answers as it stands; otherwise, while nothing serves the app, it is owed now.
pub(super) fn handle_owner_delete(
    sql: &SqlStorage,
    who: &Participant,
    label: &str,
    body: &Value,
    reads: &release_config::ConfigReads,
    now: i64,
) -> R<Value> {
    may_ask(who)?;
    let holds = release_config::caller_holds(sql, reads, &who.caller.id)?;
    podster_policy::release::authorize_app_data_delete(&who.caller, holds)
        .map_err(release_config::denial)?;
    confirmed(body, label)?;
    own_label(sql, label)?;
    let record = kept(sql, label)?;
    if owe(record.as_ref().map(Kept::record).as_ref()) != Owe::Owe {
        return answer(sql, label);
    }
    if label_serves(sql, label)? {
        // error-codes: app_still_served
        return Err(ApiError::api(409, "app_still_served"));
    }
    owed(
        sql,
        label,
        DeleteCause::OwnerDeleted,
        &who.caller.id,
        kind_name(&who.caller),
        now,
    )?;
    answer(sql, label)
}

/// Owes the deletion, with its audit row and its event, in the caller's transaction.
fn owed(
    sql: &SqlStorage,
    label: &str,
    cause: DeleteCause,
    actor: &str,
    actor_kind: &str,
    now: i64,
) -> R<()> {
    if !owe_delete(sql, label, cause, now)? {
        return Ok(());
    }
    audit_as(
        sql,
        actor,
        actor_kind,
        "app_data.delete_owed",
        "app",
        None,
        Some(json!({ "cause": cause.code() }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "app_data.delete_owed",
        actor,
        None,
        &Transition {
            reason: Some(cause.code()),
            ..Transition::NONE
        },
        roles::room_managers(sql, actor)?,
        now,
    )
}

/// Test builds only: the store provider is off in a room a test gave `test_app_store_provider_off`, as the release
/// job's is.
fn provider(env: &Env, sql: &SqlStorage) -> Option<StoreProvider> {
    #[cfg(feature = "failpoints")]
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_app_store_provider_off'",
        vec![],
    )
    .is_ok_and(|found| !found.is_empty())
    {
        return None;
    }
    let _ = sql;
    StoreProvider::from_env(env)
}

/// When the deletion job next has something to do, by the release commands' clock, or `None`: nothing is owed, or no
/// store provider is configured, in which case the work waits, recorded as owed, without waking the room.
pub(super) fn next_due(sql: &SqlStorage, env: &Env) -> R<Option<i64>> {
    if provider(env, sql).is_none() {
        return Ok(None);
    }
    Ok(rows(
        sql,
        "SELECT min(delete_next_at) AS due FROM app_store WHERE delete_next_at IS NOT NULL",
        vec![],
    )?
    .first()
    .and_then(|row| row["due"].as_i64()))
}

/// One record's step: what D1 says, then what core makes of it, written only while the record is as it was read.
async fn delete_one(sql: &SqlStorage, provider: &StoreProvider, label: &str) -> R<()> {
    let Some(record) = kept(sql, label)? else {
        return Ok(());
    };
    let name = record.name.clone().unwrap_or_default();
    let step = delete_step(Some(&record.record()), record.first_gone_at);
    let retry = |now: i64| DeleteWrite::Retry {
        next: now.saturating_add(delete_wait_ms(record.delete_attempts)),
    };
    let outcome = match &step {
        DeleteStep::Nothing => return Ok(()),
        DeleteStep::Malformed => {
            log(sql, "store_record_malformed");
            let now = release_now(sql);
            delete_write(sql, label, record.id.as_deref(), &retry(now), now)?;
            return Ok(());
        }
        DeleteStep::Delete(id) => {
            // Its answer isn't trusted: only the read says gone.
            provider.delete(id).await;
            log(sql, "store_delete_sent");
            let read = provider.read(id, &name).await;
            after_read(read, record.first_gone_at, release_now(sql))
        }
        DeleteStep::Read(id) => {
            let read = provider.read(id, &name).await;
            after_read(read, record.first_gone_at, release_now(sql))
        }
        DeleteStep::List => {
            let list = provider.list().await;
            after_list(
                list.as_deref(),
                &name,
                record.create_sent_at,
                record.first_gone_at,
                release_now(sql),
            )
        }
    };
    let now = release_now(sql);
    let (write, code) = match outcome {
        DeleteOutcome::NoteGone { at } => (DeleteWrite::NoteGone { next: at }, "store_gone_noted"),
        DeleteOutcome::WaitGone { at } => (DeleteWrite::Until { next: at }, "store_gone_wait"),
        DeleteOutcome::TooSoon { at } => (DeleteWrite::Until { next: at }, "store_list_too_soon"),
        DeleteOutcome::Gone => (DeleteWrite::Gone, "store_gone"),
        DeleteOutcome::Present => (
            DeleteWrite::Present {
                next: now.saturating_add(delete_wait_ms(record.delete_attempts)),
            },
            "store_still_there",
        ),
        DeleteOutcome::Found(id) => (DeleteWrite::Found { id }, "store_found_by_name"),
        DeleteOutcome::Unknown => (
            retry(now),
            if step == DeleteStep::List {
                "store_list_unknown"
            } else {
                "store_read_unknown"
            },
        ),
    };
    let written = delete_write(sql, label, record.id.as_deref(), &write, now)?;
    log(
        sql,
        if written {
            code
        } else {
            "store_record_changed"
        },
    );
    Ok(())
}

impl Workspace {
    /// The deletion job, from the room's alarm, after the applier and the script deletes: the records owed a deletion
    /// and due now, each its own small step, and one failing holds up no other. With no store provider configured,
    /// which is every deployment, it does nothing and says so, and the work stays recorded as owed.
    pub(super) async fn store_delete_upkeep(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? || store::needs_migration(&sql)? {
            return Ok(());
        }
        let due: Vec<String> = rows(
            &sql,
            "SELECT label FROM app_store WHERE delete_next_at IS NOT NULL AND delete_next_at <= ? ORDER BY delete_next_at, label LIMIT ?",
            vec![release_now(&sql).into(), BATCH.into()],
        )?
        .iter()
        .filter_map(|row| text(&row["label"]))
        .collect();
        if due.is_empty() {
            return Ok(());
        }
        let Some(provider) = provider(&self.env, &sql) else {
            log(&sql, "store_provider_missing");
            return Ok(());
        };
        let deadline = now_ms() + PASS_BUDGET_MS;
        for label in &due {
            if now_ms() > deadline {
                break;
            }
            let store = sql.clone();
            let step = delete_one(&store, &provider, label).await;
            if let Err(error) = step {
                log(&sql, error.code().unwrap_or("internal_error"));
            }
        }
        Ok(())
    }

    /// An operator deletes an app's data (S4). The Worker has checked the operator. **The app is suspended first,** in a
    /// transaction of its own, exactly as an operator's suspension, so nothing serves or writes, and that holds whatever
    /// follows (review standard 4). Then the deletion is owed, in a second transaction, audited and told as Podster's
    /// act. Asking again changes nothing and answers the same.
    pub(super) async fn app_data_delete(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            // The lookup table named a room that doesn't exist. To the operator that is a label no room has.
            return Err(ApiError::not_found());
        }
        self.migrate_if_needed()?;
        let body: Value =
            serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
        let label = body["label"].as_str().unwrap_or_default().to_owned();
        let reason = body["reason"]
            .as_str()
            .and_then(podster_policy::moderation::Reason::from_name)
            .ok_or_else(ApiError::invalid_argument)?;
        own_label(&sql, &label)?;
        let (store, suspended) = (sql.clone(), label.clone());
        transaction_sync(&self.state, move || {
            takedown::set(
                &store,
                &json!({ "label": suspended, "suspended": true, "reason": reason.name() }),
                now_ms(),
            )
            .map(|_| ())
        })?;
        // The suspension has committed: the releases that hadn't gone live end in their own transaction, as after any.
        release_commit::bookkeeping(&self.state);
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let (slot, store, owed_label) = (out.clone(), sql.clone(), label.clone());
        transaction_sync(&self.state, move || {
            owed(
                &store,
                &owed_label,
                DeleteCause::OperatorTakedown,
                moderation::PODSTER,
                moderation::PODSTER_KIND,
                release_now(&store),
            )?;
            *slot.borrow_mut() = Some(answer(&store, &owed_label)?);
            Ok(())
        })?;
        // The suspension moved each host's version, so the applier is due now, and the deletion is due at once.
        self.arm(false, false).await?;
        let answer = out.borrow_mut().take();
        answer.ok_or_else(|| ApiError::internal("an app's data deletion answered nothing"))
    }
}
