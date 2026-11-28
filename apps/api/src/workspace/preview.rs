//! The room's preview (M8 step 6; the preview plan, `docs/m8-preview-plan.md`, sections 2, 3 and 9; ADR 0010's revision
//! on previews; decisions 250 to 259): its slot as the room stores it, what `getPreview` and a task's release status show
//! of it, deleting it, and every trigger that deletes it without anyone asking (the plan's 3.3).
//!
//! **A preview is a release record whose environment is `preview`** (`release_environment`, Workspace step 59), run by
//! the release job's own steps (`release_driver`, `release_upload`, `release_commit`, `release_marker`), under the room's
//! **preview label**, a row of `app_label` of kind `preview` that is never `current` (step 64), with its **own serve
//! state** in `preview_slot` (step 60), which is `podster_core::preview::PreviewServe` and never production's
//! `ServeState`. So nothing a preview does can write `serve_state`, `serve_apply` or `release_config`'s flight: the
//! types and the tables are apart (the plan's 3.2). Its scripts go only to the preview namespace (`Provider::for_previews`),
//! its entries are only of the `preview:` form (`preview_apply`), and its store is its own label's.
//!
//! **What production keeps unchanged.** Every production read of the room's releases that could meet a preview names
//! production's releases only ([`NOT_PREVIEW`]): the release a served one replaces, an unpublish's releases, a
//! request's pending commit, the task's release part, what is up. The cap is shared on purpose (decision 257).
//!
//! **Behind three switches,** each read where it is asked: `RELEASES` (a preview is a release record), the release path's
//! gate, and `PREVIEWS` (`crate::previews`), on only when exactly `true`. Nothing sets `PREVIEWS` in any environment.
//!
//! Logs carry the room's, the slot's and the release's IDs and codes. Never a host, a label or a script's name.
use super::release_commit::{fail, queue_script};
use super::release_recheck::release_now;
use super::*;
use podster_core::preview::{
    delete_preview, recorded_environment, DeploymentPreviews, Environment, PreviewDeleteTrigger,
    PreviewServe, PreviewSlot, SlotStatus,
};
use podster_core::release::{
    next_state, script_owner, CommitMark, DesiredServe, InFlight, ReleaseEvent, ReleaseState,
    ScriptOwner,
};
use podster_policy::preview::PreviewDenial;

/// A release that isn't a preview, as a condition on `release`'s own `id`. Every production read that could meet a
/// preview release carries it, so production's decisions never count one.
pub(super) const NOT_PREVIEW: &str =
    "id NOT IN (SELECT release_id FROM release_environment WHERE environment = 'preview')";
/// [`NOT_PREVIEW`] for a query that names the release `r`.
pub(super) const NOT_PREVIEW_R: &str =
    "r.id NOT IN (SELECT release_id FROM release_environment WHERE environment = 'preview')";
/// A preview release, as a condition on `release`'s own `id`.
pub(super) const IS_PREVIEW: &str =
    "id IN (SELECT release_id FROM release_environment WHERE environment = 'preview')";

/// A release's environment, as the room recorded it (`podster_core::preview::recorded_environment`): no row is
/// production. A row naming anything else is a fault, refused, so the caller fails closed and serves it nowhere.
pub(super) fn environment_of(sql: &SqlStorage, release_id: &str) -> R<Environment> {
    let found = rows(
        sql,
        "SELECT environment FROM release_environment WHERE release_id = ?",
        vec![release_id.into()],
    )?;
    recorded_environment(found.first().and_then(|row| row["environment"].as_str()))
        .ok_or_else(|| ApiError::internal("a release in no environment"))
}

/// Whether a release is a preview.
pub(super) fn is_preview(sql: &SqlStorage, release_id: &str) -> R<bool> {
    Ok(environment_of(sql, release_id)? == Environment::Preview)
}

/// A label's kind, by its row: `None` for a label that isn't the room's.
pub(super) fn label_kind(sql: &SqlStorage, label: &str) -> R<Option<Environment>> {
    Ok(rows(
        sql,
        "SELECT kind FROM app_label WHERE label = ?",
        vec![label.into()],
    )?
    .first()
    .and_then(|row| row["kind"].as_str().and_then(Environment::parse)))
}

/// The room's preview slot as stored, with what isn't in core's type: its default host, when it was deleted, and its
/// flight's time.
pub(super) struct Stored {
    pub(super) slot: PreviewSlot,
    /// The default preview host, from the slot's applier row; `None` before one was written.
    pub(super) host: Option<String>,
    pub(super) deleted_at: Option<i64>,
}

/// The room's current slot, or `None`. A row core refuses (an ID or a label not of its form, an epoch past its
/// ceiling, a serve state of another shape) is a fault: an error, never served.
pub(super) fn current(sql: &SqlStorage) -> R<Option<Stored>> {
    slot_where(sql, "current = 1")
}

/// A deleted slot of the room's whose takedown isn't done yet, the newest such first, if any. Slots made and deleted
/// within one clock tick are told apart by takedown, not by time.
fn taking_down(sql: &SqlStorage) -> R<Option<Stored>> {
    let ids: Vec<String> = rows(
        sql,
        "SELECT id FROM preview_slot WHERE current IS NULL ORDER BY deleted_at DESC, created_at DESC",
        vec![],
    )?
    .iter()
    .filter_map(|row| text(&row["id"]))
    .collect();
    for id in ids {
        if let Some(stored) = by_id(sql, &id)? {
            if !takedown_done(sql, &stored)? {
                return Ok(Some(stored));
            }
        }
    }
    Ok(None)
}

/// One of the room's slots by its ID, current or deleted. Only an ID of its form is ever asked for.
pub(super) fn by_id(sql: &SqlStorage, id: &str) -> R<Option<Stored>> {
    if !podster_core::preview::is_slot_id(id) {
        return Ok(None);
    }
    slot_where(sql, &format!("id = '{id}'"))
}

fn slot_where(sql: &SqlStorage, condition: &str) -> R<Option<Stored>> {
    let Some(row) = rows(
        sql,
        &format!(
            "SELECT id, label, access_epoch, serve_epoch, default_release_id, default_version, default_flight_version,
               default_flight_before, custom_host, custom_release_id, custom_version, custom_closed, custom_flight_version,
               custom_flight_before, in_flight_release, in_flight_epoch, deleted_at,
               (SELECT host FROM preview_apply a WHERE a.slot_id = preview_slot.id ORDER BY host LIMIT 1) AS host
             FROM preview_slot WHERE {condition}"
        ),
        vec![],
    )?
    .into_iter()
    .next() else {
        return Ok(None);
    };
    let label = text(&row["label"]).unwrap_or_default();
    let script = |release: &Value| text(release).map(|id| format!("{label}.{id}"));
    let mut hosts = vec![DesiredServe {
        script: script(&row["default_release_id"]),
        version: takedown::from_stored(int(&row["default_version"])),
        closed: false,
    }];
    let mut versions = vec![row["default_flight_version"]
        .as_i64()
        .map(takedown::from_stored)];
    let mut before = vec![script(&row["default_flight_before"])];
    if !row["custom_host"].is_null() {
        hosts.push(DesiredServe {
            script: script(&row["custom_release_id"]),
            version: takedown::from_stored(int(&row["custom_version"])),
            closed: int(&row["custom_closed"]) == 1,
        });
        versions.push(
            row["custom_flight_version"]
                .as_i64()
                .map(takedown::from_stored),
        );
        before.push(script(&row["custom_flight_before"]));
    }
    let in_flight = text(&row["in_flight_release"]).map(|release_id| InFlight {
        script: format!("{label}.{release_id}"),
        release_id,
        mark: CommitMark {
            epoch: takedown::from_stored(int(&row["in_flight_epoch"])),
            versions,
            before,
        },
    });
    let serve = PreviewServe::from_stored(
        takedown::from_stored(int(&row["serve_epoch"])),
        hosts,
        in_flight,
    )
    .ok_or_else(|| ApiError::internal("a preview slot's serve state isn't of its shape"))?;
    let access_epoch = u64::try_from(int(&row["access_epoch"]).max(0)).unwrap_or(u64::MAX);
    let slot = PreviewSlot::from_stored(
        row["id"].as_str().unwrap_or_default(),
        &label,
        access_epoch,
        serve,
    )
    .ok_or_else(|| ApiError::internal("a preview slot not of its form"))?;
    Ok(Some(Stored {
        slot,
        host: text(&row["host"]),
        deleted_at: row["deleted_at"].as_i64(),
    }))
}

/// The release a host's script names, if it is a script of the slot's own label. Anything else is never written: the
/// host is stored as serving nothing, and the fault is logged by its code.
fn own_release(slot: &PreviewSlot, script: Option<&str>) -> Option<String> {
    match script.map(script_owner) {
        Some(ScriptOwner::Podster { label, release_id }) if label == slot.label() => {
            Some(release_id.to_owned())
        }
        Some(_) => {
            console_error!(
                "preview: a host's script wasn't under the slot's own label, so it serves nothing: slot={} code=preview_script_mismatch",
                slot.id()
            );
            None
        }
        None => None,
    }
}

/// Writes a slot's access epoch and serve state back whole, as core decided them, in the caller's transaction. Its ID
/// and label never change. **Only `preview_slot` is written:** nothing here can name a production host.
pub(super) fn write(sql: &SqlStorage, slot: &PreviewSlot, now: i64) -> R<()> {
    let serve = slot.serve();
    let hosts = serve.hosts();
    let flight = serve.in_flight();
    let mark = flight.map(|f| &f.mark);
    let version_at = |i: usize| {
        mark.and_then(|m| m.versions.get(i).copied().flatten())
            .map(takedown::to_stored)
    };
    let before_at = |i: usize| {
        own_release(
            slot,
            mark.and_then(|m| m.before.get(i).cloned().flatten())
                .as_deref(),
        )
    };
    let default = hosts
        .first()
        .ok_or_else(|| ApiError::internal("a preview slot with no default host"))?;
    let custom = hosts.get(1);
    exec(
        sql,
        "UPDATE preview_slot SET access_epoch = ?, serve_epoch = ?, default_release_id = ?, default_version = ?, default_flight_version = ?,
           default_flight_before = ?, custom_release_id = ?, custom_version = coalesce(?, custom_version), custom_closed = coalesce(?, custom_closed),
           custom_flight_version = ?, custom_flight_before = ?, in_flight_release = ?, in_flight_epoch = ?,
           in_flight_at = CASE WHEN ? IS NULL THEN NULL ELSE coalesce(in_flight_at, ?) END, updated_at = ? WHERE id = ?",
        vec![
            takedown::to_stored(slot.access_epoch()).into(),
            takedown::to_stored(serve.epoch()).into(),
            opt(&own_release(slot, default.script.as_deref())),
            takedown::to_stored(default.version).into(),
            version_at(0).map_or(V::Null, V::from),
            opt(&before_at(0)),
            opt(&custom.and_then(|h| own_release(slot, h.script.as_deref()))),
            custom.map_or(V::Null, |h| takedown::to_stored(h.version).into()),
            custom.map_or(V::Null, |h| flag(h.closed)),
            version_at(1).map_or(V::Null, V::from),
            opt(&before_at(1)),
            opt(&flight.map(|f| f.release_id.clone())),
            mark.map_or(V::Null, |m| takedown::to_stored(m.epoch).into()),
            opt(&flight.map(|f| f.release_id.clone())),
            now.into(),
            now.into(),
            slot.id().into(),
        ],
    )
}

/// Whether a deleted slot's takedown is done: every host it held confirmed with no entry, and every script of its label
/// counted gone. Until then the room's preview reads `deleting`, and a new one waits ([`slot_status`]).
fn takedown_done(sql: &SqlStorage, stored: &Stored) -> R<bool> {
    let pending = rows(
        sql,
        "SELECT 1 AS pending FROM preview_apply WHERE slot_id = ?1 AND NOT (confirmed = 1 AND applied_value IS NULL)
         UNION ALL SELECT 1 FROM script_delete WHERE label = ?2 AND gone_at IS NULL LIMIT 1",
        vec![stored.slot.id().into(), stored.slot.label().into()],
    )?;
    Ok(pending.is_empty())
}

/// Where the room's slot stands, for core's `preview_request`: none; active; or deleting, while a deleted slot's
/// takedown isn't done, which a new preview waits for (`preview_in_flight`).
pub(super) fn slot_status(sql: &SqlStorage) -> R<SlotStatus> {
    if current(sql)?.is_some() {
        return Ok(SlotStatus::Active);
    }
    Ok(match taking_down(sql)? {
        Some(_) => SlotStatus::Deleting,
        None => SlotStatus::None,
    })
}

/// Who hears of a preview: the room's owner and its admins who are people (the plan's 9.3), never an agent.
pub(super) fn told(sql: &SqlStorage, actor: &str) -> R<Vec<String>> {
    roles::room_approvers(sql, actor)
}

// ---------------------------------------------------------------------------------------------------------------------
// What the room shows of its preview (`getPreview`, the plan's 9.1; a task's release status, the plan's 9.2)
// ---------------------------------------------------------------------------------------------------------------------

/// A preview release as the contract's `PreviewRelease` gives it. The build ID and the storage warning are recorded by
/// the job once it has fetched the build (M8 step 9, `release_build`), so each is null until then.
fn release_view(sql: &SqlStorage, release_id: &str) -> R<Value> {
    let row = rows(
        sql,
        "SELECT id, task_id, commit_sha, state, requested_by, requested_at, served_at, failure_code, finished_at,
           (SELECT build_id FROM release_build WHERE release_id = release.id) AS build_id,
           (SELECT names_storage FROM release_build_storage WHERE release_id = release.id) AS names_storage
         FROM release WHERE id = ?",
        vec![release_id.into()],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| ApiError::internal("a preview release isn't there"))?;
    Ok(json!({
        "id": row["id"], "task_id": row["task_id"], "commit_sha": row["commit_sha"], "state": row["state"],
        "build_id": row["build_id"],
        "storage_warning": row["names_storage"].as_i64().map_or(Value::Null, |flag| Value::from(flag == 1)), "requested_by": row["requested_by"],
        "requested_at": row["requested_at"], "served_at": row["served_at"],
        "failure_code": if row["state"] == "failed" { row["failure_code"].clone() } else { Value::Null },
        "finished_at": row["finished_at"],
    }))
}

/// `PreviewRelease`, for the release a request just recorded.
pub(super) fn view_release(sql: &SqlStorage, release_id: &str) -> R<Value> {
    release_view(sql, release_id)
}

/// The preview release the room's current slot serves, confirmed by its marker; `None` with no slot or none served.
/// What an approval of a release made from a preview compares its own preview release with (M8 step 9).
pub(super) fn serving_now(sql: &SqlStorage) -> R<Option<String>> {
    match current(sql)? {
        Some(stored) => serving_release(sql, &stored.slot),
        None => Ok(None),
    }
}

/// The release the slot's hosts serve, confirmed by its marker: the last working preview (core's `serving`), and only
/// while it is recorded `served`.
fn serving_release(sql: &SqlStorage, slot: &PreviewSlot) -> R<Option<String>> {
    let Some(script) = slot.serve().serving() else {
        return Ok(None);
    };
    Ok(rows(
        sql,
        &format!(
            "SELECT id FROM release WHERE script_name = ? AND state = 'served' AND {IS_PREVIEW}"
        ),
        vec![script.into()],
    )?
    .first()
    .and_then(|row| text(&row["id"])))
}

/// The contract's `RoomPreview`: `{ preview }`, null while the room has none.
pub(super) fn view(sql: &SqlStorage, domain: Option<&str>) -> R<Value> {
    let stored = match current(sql)? {
        Some(stored) => Some(stored),
        None => taking_down(sql)?,
    };
    let Some(stored) = stored else {
        return Ok(json!({ "preview": null }));
    };
    let slot = &stored.slot;
    let deleting = stored.deleted_at.is_some();
    let serving = if deleting {
        None
    } else {
        serving_release(sql, slot)?
    };
    // The latest attempt while it isn't the one serving: in flight, or failed until the next request.
    let latest_attempt = rows(
        sql,
        &format!("SELECT id, state FROM release WHERE label = ? AND {IS_PREVIEW} ORDER BY seq DESC LIMIT 1"),
        vec![slot.label().into()],
    )?;
    let replacement = match latest_attempt.first() {
        Some(row) if !deleting && text(&row["id"]) != serving => {
            let state = row["state"].as_str().unwrap_or_default();
            matches!(
                state,
                "queued" | "uploading" | "uncertain" | "live" | "failed"
            )
            .then(|| text(&row["id"]))
            .flatten()
        }
        _ => None,
    };
    Ok(json!({ "preview": {
        "state": if deleting { "deleting" } else { "active" },
        "serving": serving.as_deref().map(|id| release_view(sql, id)).transpose()?,
        "replacement": replacement.as_deref().map(|id| release_view(sql, id)).transpose()?,
        "default_host": domain.map(|domain| format!("{}.{domain}", slot.label())),
        // M8 step 10's: no custom preview hostname is built yet.
        "custom_host": Value::Null,
    }}))
}

/// The preview part of a task's release status (the plan's 9.2): the latest preview release of the task's merged
/// commit, its state and commit and nothing else, **never a host or a link**. `{ exists: false }` for everyone while
/// release or previews are off; null for a caller who isn't shown the task's change; `{ exists: false }` while no
/// preview of the commit was asked for.
pub(super) fn task_part(
    sql: &SqlStorage,
    task_id: &str,
    commit: Option<&str>,
    on: bool,
    whole: bool,
) -> R<Value> {
    let none = json!({ "exists": false });
    if !on {
        return Ok(none);
    }
    if !whole {
        return Ok(Value::Null);
    }
    let Some(commit) = commit else {
        return Ok(none);
    };
    let Some(row) = rows(
        sql,
        &format!(
            "SELECT id, state, script_name, updated_at, failure_code FROM release
              WHERE task_id = ? AND commit_sha = ? AND {IS_PREVIEW} ORDER BY seq DESC LIMIT 1"
        ),
        vec![task_id.into(), commit.into()],
    )?
    .into_iter()
    .next() else {
        return Ok(none);
    };
    let state = row["state"].as_str().unwrap_or_default();
    let served = state == "served"
        && current(sql)?.is_some_and(|stored| {
            stored.slot.serve().serving().as_deref() == row["script_name"].as_str()
        });
    Ok(json!({
        "exists": true, "release_id": row["id"], "commit_sha": commit,
        // As `TaskRelease.state`: a release live and waiting for its marker is awaiting confirmation.
        "state": if state == "live" { "awaiting_confirmation" } else { state },
        "observed_at": row["updated_at"],
        "failure_code": if state == "failed" { row["failure_code"].clone() } else { Value::Null },
        "served": served,
    }))
}

// ---------------------------------------------------------------------------------------------------------------------
// Deleting the preview (the plan's 3.2, "Deleting the preview", and 3.3)
// ---------------------------------------------------------------------------------------------------------------------

/// A policy refusal of a preview action, as the API answers it: who is asking is 403; `previews_off` and release's room
/// facts are 409.
pub(super) fn denied(denial: PreviewDenial) -> ApiError {
    match denial {
        PreviewDenial::NotParticipant | PreviewDenial::NotAllowed => {
            let code = denial.code();
            // error-codes: not_a_participant, not_allowed
            ApiError::api(403, code)
        }
        PreviewDenial::PublicParticipant => {
            // error-codes: public_participant
            ApiError::api(403, "public_participant")
        }
        PreviewDenial::PreviewsOff => {
            // error-codes: previews_off
            ApiError::api(409, "previews_off")
        }
        PreviewDenial::Release(denial) => super::release_config::denial(denial),
    }
}

/// **Deletes the room's preview, in the caller's transaction** (core's `delete_preview`, the plan's 3.2): every preview
/// host to nothing, the slot's serve epoch and access epoch up and its flight closed, so nothing begun before can ever go
/// live after; the slot no longer current; the preview label retired, never drawn again; every script core names
/// queued for deletion from the preview namespace; the label's store owed its deletion; every preview release that
/// served unpublished, and every one still on its way failed with the trigger's code. Audited by `actor` and told to
/// the room's owner and its admins who are people, as `preview.deleted` with the trigger's code. **Production is
/// untouched:** nothing here reads or writes `serve_state`, `serve_apply`, `release_config` or a production label.
/// Answers whether there was a preview to delete.
pub(super) fn delete_for(
    sql: &SqlStorage,
    trigger: PreviewDeleteTrigger,
    actor: &str,
    actor_kind: &str,
    now: i64,
) -> R<bool> {
    let Some(stored) = current(sql)? else {
        return Ok(false);
    };
    let deletion = delete_preview(&stored.slot);
    let after = stored
        .slot
        .with_serve(deletion.serve.clone())
        .raise_access_epoch()
        // At the ceiling the access epoch stays: the hosts serve nothing either way.
        .unwrap_or_else(|_| stored.slot.with_serve(deletion.serve.clone()));
    write(sql, &after, now)?;
    exec(
        sql,
        "UPDATE preview_slot SET current = NULL, deleted_at = ?, updated_at = ? WHERE id = ? AND current = 1",
        vec![now.into(), now.into(), deletion.retire_slot.as_str().into()],
    )?;
    exec(
        sql,
        "UPDATE app_label SET retired_at = ? WHERE label = ? AND kind = 'preview' AND retired_at IS NULL",
        vec![now.into(), deletion.retire_label.as_str().into()],
    )?;
    // Every host's entry is owed again at once: the applier removes it.
    exec(
        sql,
        "UPDATE preview_apply SET attempts = 0, next_attempt_at = NULL, updated_at = ? WHERE slot_id = ?",
        vec![now.into(), deletion.retire_slot.as_str().into()],
    )?;
    for script in &deletion.delete_scripts {
        queue_script(sql, script, None, now)?;
    }
    super::store_delete::owed(
        sql,
        &deletion.retire_label,
        podster_core::app_store::DeleteCause::LabelRetired,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        now,
    )?;
    let code = trigger.code();
    for release in rows(
        sql,
        &format!("SELECT id, state FROM release WHERE label = ? AND {IS_PREVIEW} ORDER BY seq"),
        vec![deletion.retire_label.as_str().into()],
    )? {
        let (Some(id), Some(from)) = (
            text(&release["id"]),
            release["state"]
                .as_str()
                .and_then(|name| ReleaseState::ALL.into_iter().find(|s| s.name() == name)),
        ) else {
            continue;
        };
        if from.serves() {
            if let Ok(to) = next_state(from, ReleaseEvent::Unpublish) {
                exec(
                    sql,
                    "UPDATE release SET state = ?, finished_at = ?, updated_at = ? WHERE id = ?",
                    vec![to.name().into(), now.into(), now.into(), id.as_str().into()],
                )?;
            }
        } else if !from.is_final() {
            fail(sql, &id, code, None, now)?;
        }
    }
    audit_as(
        sql,
        actor,
        actor_kind,
        "preview.deleted",
        &deletion.retire_slot,
        None,
        Some(json!({ "reason": code }).to_string()),
        now,
    )?;
    store::record_event_about(
        sql,
        "preview.deleted",
        actor,
        Some(&deletion.retire_slot),
        None,
        &Transition {
            reason: Some(code),
            ..Transition::NONE
        },
        told(sql, actor)?,
        now,
    )?;
    console_log!(
        "preview: deleted: room={} slot={} code={}",
        super::release_driver::room_id(sql),
        deletion.retire_slot,
        code
    );
    Ok(true)
}

/// One of decision 204's unpublish triggers fired: the preview is deleted too, **unless it is the room made private**,
/// which a private room's preview survives (decision 251; the plan's 3.3). As Podster's act, in the trigger's own
/// transaction.
pub(super) fn on_unpublish(
    sql: &SqlStorage,
    trigger: podster_core::release::UnpublishTrigger,
    now: i64,
) -> R<()> {
    if let Some(trigger) = podster_core::preview::preview_delete_trigger(trigger) {
        delete_for(
            sql,
            trigger,
            moderation::PODSTER,
            moderation::PODSTER_KIND,
            now,
        )?;
    }
    Ok(())
}

/// The deployment's `PREVIEWS` read as exactly `false`, applied: the preview is deleted (the plan's 3.3, "Added for
/// previews"). On or undecided, nothing happens here: undecided refuses new previews and deletes nothing.
pub(super) fn apply_deployment(sql: &SqlStorage, previews: DeploymentPreviews, now: i64) -> R<()> {
    if previews.deletes_previews() {
        delete_for(
            sql,
            PreviewDeleteTrigger::PreviewsOffForDeployment,
            moderation::PODSTER,
            moderation::PODSTER_KIND,
            now,
        )?;
    }
    Ok(())
}

/// `DELETE preview`, in the room's transaction. **Run only as the handler of `command_checked` whose recheck is
/// [`delete_standing`],** which runs first on every attempt, a replay too. A room with no preview answers
/// `{ preview: null }`.
pub(super) fn handle_delete(sql: &SqlStorage, who: &Participant, domain: Option<&str>) -> R<Value> {
    let now = release_now(sql);
    delete_for(
        sql,
        PreviewDeleteTrigger::Requested,
        &who.caller.id,
        kind_name(&who.caller),
        now,
    )?;
    view(sql, domain)
}

/// Who may delete, on every attempt and before a stored answer is given back: the room's owner or an admin, as a person,
/// still in the organization their place here is held in. A record that couldn't be read is `standing_unknown`.
pub(super) fn delete_standing(sql: &SqlStorage, who: &Participant, holds: Option<bool>) -> R<()> {
    let _ = sql;
    // Deleting passes no gate, so no room fact is asked: the policy reads none of these for it.
    podster_policy::preview::authorize_preview_change(
        &who.caller,
        holds.unwrap_or(true),
        DeploymentPreviews::Undecided,
        &podster_policy::release::ReleaseRoom::OPEN,
        podster_policy::preview::PreviewChange::Delete,
    )
    .map_err(denied)?;
    if holds.is_none() {
        return Err(super::release_recheck::standing_unknown());
    }
    Ok(())
}
