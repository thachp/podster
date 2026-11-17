//! Deleting an app's data (M6 stage 1, S4 of the store plan; ADR 0010's revision, section 3.3 and row 7 of its
//! summary, and decision 220 (7): "may be deleted by an operator and also by the room's owner or an admin, as a
//! person"). What it decides is pure, in `podster_core::app_store` ([`owe`], [`delete_step`], [`after_read`],
//! [`after_list`]) and `podster_policy::release::authorize_app_data_delete`; here is what it reads, asks and calls. Every
//! write of the room's record of its store is in `release_store.rs`, still its only writer.
//!
//! - **Two commands.** A Podster operator's, through the operators' route, which suspends the app when the label is
//!   current (exactly an operator's suspension, committed in its own transaction first, review standard 4) and then owes
//!   the deletion. And the room's owner's or an admin's, as a person (decision 220 (7)): it owes the deletion only once
//!   nothing can reach the store ([`store_unreachable`], by what the edge was last confirmed to serve), so until then it
//!   answers `app_still_served`. With data left and no store provider configured, both refuse
//!   `data_delete_unavailable`: nothing would delete it. Each owes it in its own transaction (`delete_owed_at`, a cause
//!   from core's closed set), and from then nothing is bound to the store (rule 3(a)), and a release already bound to it
//!   can't go live. **Idempotent:** a record owed or gone is left as it is. The answer carries the owner's words,
//!   `podster_core::app_store::DATA_DELETED_NOTICE`, exactly, and only once they are true.
//! - **Not behind the release path's gate.** Deleting is the takedown direction, and a store exists only where the
//!   create's gate (`RELEASE_PATH_COMPLETE`) once let one be made, so the commands and the job work whenever a store is
//!   recorded and, for the job, a store provider is configured. The routes are behind `RELEASES`, as every M6 route.
//! - **The job,** from the room's alarm, after the applier and the script deletes: a record owed a deletion is deleted at
//!   D1 by its ID, **the delete's answer never trusted,** then read; it counts gone only on D1's own not-found, read twice
//!   at least ten minutes apart (`GONE_SPAN_MS`). A record with a name and no ID is resolved by a whole list read by its
//!   name before anything is decided: listed, its ID is recorded and it is deleted by it. Not listed on two whole lists
//!   ten minutes apart, the first no sooner than ten minutes after its create, it was never made, or is gone. A try that
//!   decides nothing, or writes nothing, waits longer each time, up to five minutes, and never gives up. **The delete is
//!   held while anything can reach the store,** whatever the cause. **Only a store the room's own record names is ever
//!   deleted:** never one the reconcile tells as an orphan (`store_orphan`), which no room records.
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
/// holds no store for the app, `deleting` once owed, and `deleted` once D1 said gone twice. **`notice` is the owner's
/// words, exactly, only when they are true** (the coordinator's ruling D on PR #424's review): the data is deleted, or
/// it is owed a deletion, nothing can reach the store any more ([`store_unreachable`]), and a store provider is
/// configured, so the job will delete it. Otherwise it is null.
fn answer(sql: &SqlStorage, label: &str, provider_on: bool) -> R<Value> {
    let kept = kept(sql, label)?;
    let state = data_state(kept.as_ref().map(Kept::record).as_ref());
    let true_now = match state {
        DataState::None => false,
        DataState::Deleted => true,
        DataState::Deleting => provider_on && store_unreachable(sql, label)?,
    };
    Ok(json!({
        "label": label,
        "data": state.code(),
        "cause": kept.as_ref().and_then(|kept| kept.delete_cause.clone()),
        "owed_at": kept.as_ref().and_then(|kept| kept.delete_owed_at),
        "deleted_at": kept.as_ref().and_then(|kept| kept.gone_at),
        "notice": true_now.then_some(DATA_DELETED_NOTICE),
    }))
}

/// The refusal of a command with a store to delete and no store provider configured: nothing would delete it, so it
/// isn't owed, and the owner's words are never shown for it.
fn unavailable() -> ApiError {
    // error-codes: data_delete_unavailable
    ApiError::api(409, "data_delete_unavailable")
}

/// Whether a record holds data a deletion would still have to remove: any record but one gone.
fn data_left(record: Option<&Kept>) -> bool {
    record.is_some_and(|kept| kept.gone_at.is_none())
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

/// **Whether nothing can reach this label's store any more** (the coordinator's rulings B and C on PR #424's review),
/// read from what the edge was last confirmed to serve, not only from what the room wants:
///
/// - **every host, retired ones included, is down for the label by applied state:** it wants none of the label's
///   scripts, the applier last wrote none of them, and, where an applier has ever written it, its entry is confirmed
///   at the host's current version (applied as wanted, or refused there), as `release_approval`'s `host_down` reads a
///   host. A host whose entry isn't confirmed may still route anywhere, so it counts as reaching;
/// - no kept script for a rollback and no commit in flight is one of the label's;
/// - **no release of the label whose script was bound to the store** (`release_store_binding`, written just before the
///   script is) is still queued, uploading, uncertain, live or served.
///
/// The owner's command owes nothing until this holds, the job deletes nothing at D1 until it does, and the owner's words
/// are shown only once it does.
fn store_unreachable(sql: &SqlStorage, label: &str) -> R<bool> {
    let of_label = |script: &Value| {
        script.as_str().is_some_and(|script| {
            matches!(script_owner(script), ScriptOwner::Podster { label: owner, .. } if owner == label)
        })
    };
    for row in rows(
        sql,
        "SELECT s.script_name, s.flight_before, s.version, a.host AS apply_host, a.applied_script, a.applied_version, a.refused_version
           FROM serve_state s LEFT JOIN serve_apply a ON a.host = s.host",
        vec![],
    )? {
        if of_label(&row["script_name"])
            || of_label(&row["flight_before"])
            || of_label(&row["applied_script"])
        {
            return Ok(false);
        }
        let version = row["version"].as_i64();
        let confirmed = row["apply_host"].is_null()
            || (row["applied_version"].as_i64() == version
                && row["applied_script"] == row["script_name"])
            || row["refused_version"].as_i64() == version;
        if !confirmed {
            return Ok(false);
        }
    }
    for row in rows(
        sql,
        "SELECT kept_previous, in_flight_script FROM release_config",
        vec![],
    )? {
        if of_label(&row["kept_previous"]) || of_label(&row["in_flight_script"]) {
            return Ok(false);
        }
    }
    let bound = !rows(
        sql,
        "SELECT 1 AS bound FROM release_store_binding b JOIN release r ON r.id = b.release_id
           WHERE b.label = ? AND r.state IN ('queued', 'uploading', 'uncertain', 'live', 'served')",
        vec![label.into()],
    )?
    .is_empty();
    Ok(!bound)
}

/// Who may ask, by the room's rows alone, before anything outside the room is read: the owner or an admin, as a person.
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

/// `POST apps/{label}/delete-data`, the room's owner's or an admin's, as a person, in the room's transaction, after the
/// caller's standing was read (`config_reads`), with whether a store provider is configured (`provider_on`). Who
/// first, then the body, then the label, then the record: no store answers `none`, and one gone `deleted`, writing
/// nothing; with data left and no store provider, `data_delete_unavailable`; one owed answers as it stands; otherwise,
/// once nothing can reach the store ([`store_unreachable`]), it is owed now, and until then `app_still_served`.
pub(super) fn handle_owner_delete(
    sql: &SqlStorage,
    who: &Participant,
    label: &str,
    body: &Value,
    reads: &release_config::ConfigReads,
    provider_on: bool,
    now: i64,
) -> R<Value> {
    may_ask(who)?;
    let holds = release_config::caller_holds(sql, reads, &who.caller.id)?;
    podster_policy::release::authorize_app_data_delete(&who.caller, holds)
        .map_err(release_config::denial)?;
    confirmed(body, label)?;
    own_label(sql, label)?;
    let record = kept(sql, label)?;
    if data_left(record.as_ref()) && !provider_on {
        return Err(unavailable());
    }
    if owe(record.as_ref().map(Kept::record).as_ref()) != Owe::Owe {
        return answer(sql, label, provider_on);
    }
    if !store_unreachable(sql, label)? {
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
    answer(sql, label, provider_on)
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

/// Whether a store provider is configured, for the owner's command, which reads it before its transaction.
pub(super) fn provider_configured(env: &Env, sql: &SqlStorage) -> bool {
    provider(env, sql).is_some()
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
        DeleteStep::Delete(_) if !store_unreachable(sql, label)? => {
            // Held, whatever the cause: never deleted while the edge may still route to a script bound to the store, or
            // a release bound to it is under way (the coordinator's ruling C on PR #424's review).
            let now = release_now(sql);
            delete_write(sql, label, record.id.as_deref(), &retry(now), now)?;
            log(sql, "store_delete_held");
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
    if written {
        log(sql, code);
        return Ok(());
    }
    // Nothing written (an ID found by the name that another record holds, or the record changed meanwhile): the step
    // still waits its turn, so the room isn't woken again at once (the coordinator's ruling F on PR #424's review). A
    // record that changed is left to whoever changed it, which sets its own wait.
    delete_write(sql, label, record.id.as_deref(), &retry(now), now)?;
    log(sql, "store_record_changed");
    Ok(())
}

/// After a step that failed outright: the record waits its backoff, as after any try that decided nothing, so a step
/// that keeps failing never wakes the room at once (the coordinator's ruling F on PR #424's review).
fn retry_after_failure(sql: &SqlStorage, label: &str) -> R<()> {
    let Some(record) = kept(sql, label)? else {
        return Ok(());
    };
    let now = release_now(sql);
    let next = now.saturating_add(delete_wait_ms(record.delete_attempts));
    delete_write(
        sql,
        label,
        record.id.as_deref(),
        &DeleteWrite::Retry { next },
        now,
    )
    .map(|_| ())
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
                if let Err(error) = retry_after_failure(&sql, label) {
                    log(&sql, error.code().unwrap_or("internal_error"));
                }
            }
        }
        Ok(())
    }

    /// An operator deletes an app's data (S4). The Worker has checked the operator. With data left to delete and no
    /// store provider configured, it refuses `data_delete_unavailable` and does nothing. **For the room's current label
    /// the app is suspended first,** in a transaction of its own, exactly as an operator's suspension, so nothing serves
    /// or writes, and that holds whatever follows (review standard 4); **a retired label serves nothing,** so the room's
    /// current app isn't suspended for it (the coordinator's ruling H). Then the deletion is owed, in a second
    /// transaction, audited and told as Podster's act; the job still deletes nothing until nothing can reach the store.
    /// The answer carries the owner's words only once they are true. Asking again changes nothing.
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
        let provider_on = provider(&self.env, &sql).is_some();
        if data_left(kept(&sql, &label)?.as_ref()) && !provider_on {
            return Err(unavailable());
        }
        if release_commit::label_current(&sql, &label)? {
            let (store, suspended) = (sql.clone(), label.clone());
            transaction_sync(&self.state, move || {
                takedown::set(
                    &store,
                    &json!({ "label": suspended, "suspended": true, "reason": reason.name() }),
                    now_ms(),
                )
                .map(|_| ())
            })?;
            // The suspension has committed: the releases that hadn't gone live end in their own transaction.
            release_commit::bookkeeping(&self.state);
        }
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
            *slot.borrow_mut() = Some(answer(&store, &owed_label, provider_on)?);
            Ok(())
        })?;
        // The suspension moved each host's version, so the applier is due now, and the deletion is due at once.
        self.arm(false, false).await?;
        let answer = out.borrow_mut().take();
        answer.ok_or_else(|| ApiError::internal("an app's data deletion answered nothing"))
    }
}
