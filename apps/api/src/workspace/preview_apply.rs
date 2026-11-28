//! The preview applier, the preview namespace's script-delete job, and the reconciles' questions about previews (M8 step
//! 6; the preview plan's 3.1, 3.2 and 3.4; ADR 0010's revision on previews, item 2). Production's applier and delete job
//! (`takedown`) stay exactly as they were for production's hosts and scripts; these are their preview twins, and the
//! two never meet:
//!
//! - **Only preview entries, only on preview hosts.** A preview host is `<preview label>.<content domain>`, one of the
//!   room's preview labels (`app_label.kind = 'preview'`); its entry is only ever `preview:<slot>:<epoch>:...`
//!   (`podster_core::serve_entry::preview_entry_value`), written through `Provider::write_preview_entry`, which refuses
//!   any other form and any script of another label. A production host's entry is never written or removed here:
//!   labels are unique across both kinds, so a preview host is never a production host.
//! - **Only the preview namespace.** A preview label's script is deleted only through the preview provider
//!   (`Provider::for_previews`), and production's delete job leaves every preview label's script alone.
//! - **The same rules as production's,** each by its own reason: a host's entry is written only for a release recorded
//!   live or served; while the app is suspended or held, the host serves nothing; before any write the stop for the
//!   whole content domain is asked, and a removal never asks; every write and removal is read back, and recorded only
//!   if the room still wants the same; a script is deleted only once no slot names it and every preview host's entry is
//!   confirmed; a wait after a failure grows, to five minutes, and never gives up.
//!
//! **With no preview provider configured, which is every deployment** (the preview namespace is the owner's to make,
//! decision 258), nothing here asks the provider anything, and the work stays owed.
//!
//! Logs carry the room's ID, counts and codes. Never a host, a label or a script's name.
use super::preview::{by_id, Stored};
use super::*;
use crate::content_provider::{Provider, Raw};
use crate::content_stop::{self, Stop};
use podster_core::release::{
    reconcile_script, script_owner, RoomClaim, ScriptOwner, ScriptReconcile,
};
use podster_core::serve_entry::preview_entry_value;

/// Hosts and scripts handled in one alarm.
const BATCH: usize = 8;
/// How long one pass may go on starting new steps, as production's.
const PASS_BUDGET_MS: i64 = 10_000;
const FIRST_WAIT_MS: i64 = 5_000;
const LONGEST_WAIT_MS: i64 = 5 * 60 * 1000;

/// The wait before attempt `attempts + 1`: 5 seconds, doubling, to 5 minutes at most. It never gives up.
fn wait_ms(attempts: i64) -> i64 {
    let doublings = attempts.clamp(0, 6) as u32;
    FIRST_WAIT_MS
        .saturating_mul(1_i64 << doublings)
        .min(LONGEST_WAIT_MS)
}

/// The preview provider this room may use, or `None`. Test builds also read `test_content_provider_off`, as
/// production's does, and `test_preview_provider_off`, so the unconfigured case can be shown beside the configured one.
pub(super) fn provider(env: &Env, sql: &SqlStorage) -> Option<Provider> {
    #[cfg(feature = "failpoints")]
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('test_content_provider_off', 'test_preview_provider_off')",
        vec![],
    )
    .is_ok_and(|found| !found.is_empty())
    {
        return None;
    }
    let _ = sql;
    Provider::for_previews(env)
}

/// What the room wants at one preview host, from its slot now.
struct Wanted {
    /// The entry the host must hold, or `None` for no entry.
    value: Option<String>,
    /// A script the slot names whose release isn't recorded live or served yet: nothing is written for it, and what
    /// the host has is left, as production's applier leaves a staged host.
    unconfirmed: bool,
    /// The slot's label, which is the only label a script on this host may be under.
    label: String,
}

/// Whether a preview release with this script is recorded live or served.
fn release_confirmed(sql: &SqlStorage, script: &str) -> R<bool> {
    Ok(!rows(
        sql,
        &format!(
            "SELECT 1 AS confirmed FROM release WHERE script_name = ? AND state IN ('live', 'served') AND {} LIMIT 1",
            super::preview::IS_PREVIEW
        ),
        vec![script.into()],
    )?
    .is_empty())
}

/// What the room wants at `host`, or `None` when the host isn't one of the room's preview hosts.
fn wanted(sql: &SqlStorage, host: &str) -> R<Option<Wanted>> {
    let Some(slot_id) = rows(
        sql,
        "SELECT slot_id FROM preview_apply WHERE host = ?",
        vec![host.into()],
    )?
    .first()
    .and_then(|row| text(&row["slot_id"])) else {
        return Ok(None);
    };
    let Some(Stored {
        slot, deleted_at, ..
    }) = by_id(sql, &slot_id)?
    else {
        return Ok(None);
    };
    let label = slot.label().to_owned();
    // The default host is the slot's first; only it has an applier row in this step.
    let script = slot.serve().hosts().first().and_then(|h| h.script.clone());
    let down = deleted_at.is_some()
        || takedown::app_suspended(sql)?
        || super::releasers::hold_state(sql)?.0;
    let Some(script) = script.filter(|_| !down) else {
        return Ok(Some(Wanted {
            value: None,
            unconfirmed: false,
            label,
        }));
    };
    if !release_confirmed(sql, &script)? {
        return Ok(Some(Wanted {
            value: None,
            unconfirmed: true,
            label,
        }));
    }
    let kind = release_commit::script_kind(sql, &script)?;
    let value = preview_entry_value(slot.id(), slot.access_epoch(), kind, &script)
        .ok_or_else(|| ApiError::internal("a preview entry core wouldn't write"))?;
    Ok(Some(Wanted {
        value: Some(value),
        unconfirmed: false,
        label,
    }))
}

/// Whether the applier has confirmed `host`'s entry exactly as the room wants it now.
pub(super) fn confirmed_as_wanted(sql: &SqlStorage, host: &str) -> R<bool> {
    let Some(want) = wanted(sql, host)? else {
        return Ok(false);
    };
    if want.unconfirmed {
        return Ok(false);
    }
    Ok(rows(
        sql,
        "SELECT applied_value FROM preview_apply WHERE host = ? AND confirmed = 1",
        vec![host.into()],
    )?
    .first()
    .is_some_and(|row| text(&row["applied_value"]) == want.value))
}

/// The room's preview hosts whose entry isn't confirmed as the room wants it, with when each is due.
fn pending(sql: &SqlStorage) -> R<Vec<(String, i64)>> {
    let mut found = Vec::new();
    for row in rows(
        sql,
        "SELECT host, next_attempt_at FROM preview_apply ORDER BY host",
        vec![],
    )? {
        let Some(host) = text(&row["host"]) else {
            continue;
        };
        if !confirmed_as_wanted(sql, &host)? {
            found.push((host, row["next_attempt_at"].as_i64().unwrap_or(0)));
        }
    }
    Ok(found)
}

/// Every script any of the room's slots names, on a host or in a flight: none of them may be deleted.
fn named(sql: &SqlStorage) -> R<Vec<String>> {
    let mut found = Vec::new();
    for row in rows(
        sql,
        "SELECT label, default_release_id, default_flight_before, custom_release_id, custom_flight_before, in_flight_release FROM preview_slot",
        vec![],
    )? {
        let label = text(&row["label"]).unwrap_or_default();
        for column in [
            "default_release_id",
            "default_flight_before",
            "custom_release_id",
            "custom_flight_before",
            "in_flight_release",
        ] {
            if let Some(release) = text(&row[column]) {
                found.push(format!("{label}.{release}"));
            }
        }
    }
    Ok(found)
}

/// Whether a preview script may be deleted now: no slot names it, and every preview host's entry is confirmed as the
/// room wants it, so no entry can still name it.
fn may_delete(sql: &SqlStorage, script: &str) -> R<bool> {
    Ok(!named(sql)?.iter().any(|n| n == script) && pending(sql)?.is_empty())
}

/// The preview labels' scripts owed a deletion and due.
fn due_scripts(sql: &SqlStorage, now: i64) -> R<Vec<String>> {
    Ok(rows(
        sql,
        "SELECT d.script_name FROM script_delete d JOIN app_label l ON l.label = d.label
           WHERE l.kind = 'preview' AND d.gone_at IS NULL AND d.next_attempt_at <= ? ORDER BY d.queued_at, d.script_name LIMIT ?",
        vec![now.into(), (BATCH as i64).into()],
    )?
    .iter()
    .filter_map(|row| text(&row["script_name"]))
    .collect())
}

/// When the preview applier or the preview delete job next has something to do, or `None`: nothing is owed, or no
/// preview provider is configured, in which case the work waits without waking the room.
pub(super) fn next_due(sql: &SqlStorage, env: &Env, now: i64) -> R<Option<i64>> {
    if provider(env, sql).is_none() {
        return Ok(None);
    }
    let hosts = pending(sql)?;
    if let Some(due) = hosts.iter().map(|(_, at)| *at).min() {
        return Ok(Some(due.max(now + 10)));
    }
    let scripts = rows(
        sql,
        "SELECT min(d.next_attempt_at) AS due FROM script_delete d JOIN app_label l ON l.label = d.label
           WHERE l.kind = 'preview' AND d.gone_at IS NULL",
        vec![],
    )?;
    Ok(scripts
        .first()
        .and_then(|row| row["due"].as_i64())
        .map(|due| due.max(now + 10)))
}

fn applied(sql: &SqlStorage, host: &str, value: Option<&str>, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE preview_apply SET applied_value = ?, confirmed = 1, applied_at = ?, attempts = 0, next_attempt_at = NULL, last_code = NULL,
           updated_at = ? WHERE host = ?",
        vec![value.into(), now.into(), now.into(), host.into()],
    )
}

fn not_applied(sql: &SqlStorage, host: &str, code: &str, now: i64) -> R<()> {
    let attempts = rows(
        sql,
        "SELECT attempts FROM preview_apply WHERE host = ?",
        vec![host.into()],
    )?
    .first()
    .map_or(0, |row| int(&row["attempts"]));
    exec(
        sql,
        "UPDATE preview_apply SET attempts = ?, next_attempt_at = ?, last_code = ?, updated_at = ? WHERE host = ?",
        vec![
            (attempts + 1).into(),
            (now + wait_ms(attempts)).into(),
            code.into(),
            now.into(),
            host.into(),
        ],
    )
}

/// Removes a host's entry and reads it back: `true` only when the provider says the host has none.
async fn remove(provider: &Provider, host: &str) -> bool {
    provider.delete_entry(host).await;
    provider.read_raw_entry(host).await == Raw::Absent
}

/// One preview host, made to match what the room wants now, then recorded only if the room still wants the same.
async fn apply_host(sql: &SqlStorage, env: &Env, provider: &Provider, host: &str) -> R<()> {
    let Some(want) = wanted(sql, host)? else {
        return Ok(());
    };
    // A preview host is its own preview label's default host on the content domain, and nothing else.
    let own = provider.default_host_label(host) == Some(want.label.as_str())
        && super::preview::label_kind(sql, &want.label)?
            == Some(podster_core::preview::Environment::Preview);
    let outcome: Result<(), &'static str> = if !own {
        Err("host_not_a_preview_host")
    } else if want.unconfirmed {
        // A staged release: nothing is asked, what the host has is left, and the confirm makes it due again.
        Err(release_commit::NOT_CONFIRMED)
    } else {
        match &want.value {
            Some(value) => match content_stop::read_from(env).await {
                Stop::Stopped => Err("content_domain_stopped"),
                Stop::Unreadable => Err("stop_unreadable"),
                Stop::Clear => {
                    let written = provider.write_preview_entry(host, value).await;
                    let found = provider.read_raw_entry(host).await;
                    match (written, found) {
                        (true, Raw::Value(found)) if &found == value => Ok(()),
                        (false, _) => Err("write_not_confirmed"),
                        _ => Err("read_back_differs"),
                    }
                }
            },
            None if remove(provider, host).await => Ok(()),
            None => Err("delete_not_confirmed"),
        }
    };
    let now = now_ms();
    let again = wanted(sql, host)?;
    let same = again
        .as_ref()
        .is_some_and(|again| again.value == want.value && again.unconfirmed == want.unconfirmed);
    match outcome {
        Ok(()) if same => applied(sql, host, want.value.as_deref(), now),
        Ok(()) => not_applied(sql, host, "wanted_moved", now),
        Err(code) => not_applied(sql, host, code, now),
    }
}

/// The preview applier, then the preview delete job, from the room's alarm. Each host and each script is its own small
/// step, and one failing holds up no other.
pub(super) async fn upkeep(state: &State, env: &Env) -> R<()> {
    let sql = state.storage().sql();
    if !store::is_initialized(&sql)? || store::needs_migration(&sql)? {
        return Ok(());
    }
    let now = now_ms();
    let hosts: Vec<String> = pending(&sql)?
        .into_iter()
        .filter(|(_, at)| *at <= now)
        .map(|(host, _)| host)
        .take(BATCH)
        .collect();
    let scripts = due_scripts(&sql, now)?;
    if hosts.is_empty() && scripts.is_empty() {
        return Ok(());
    }
    let Some(provider) = provider(env, &sql) else {
        console_log!(
            "preview: no preview provider is configured, so nothing was applied or deleted: room={} hosts={} scripts={}",
            super::release_driver::room_id(&sql),
            hosts.len(),
            scripts.len()
        );
        return Ok(());
    };
    let deadline = now + PASS_BUDGET_MS;
    for host in &hosts {
        if now_ms() > deadline {
            break;
        }
        if let Err(error) = apply_host(&sql, env, &provider, host).await {
            console_error!(
                "preview: a host wasn't applied: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
    }
    for script in &due_scripts(&sql, now_ms())? {
        if now_ms() > deadline {
            break;
        }
        if let Err(error) = takedown::delete_script(&sql, &provider, script, may_delete).await {
            console_error!(
                "preview: a script wasn't deleted: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
    }
    Ok(())
}

/// Whether anything can still reach a preview label's store: one of its slot's hosts or its flight names a script of
/// it, or one of its slot's hosts isn't confirmed with no entry. Read beside production's hosts by
/// `store_delete::store_unreachable`.
pub(super) fn label_reachable(sql: &SqlStorage, label: &str) -> R<bool> {
    let of_label = |script: &str| matches!(script_owner(script), ScriptOwner::Podster { label: owner, .. } if owner == label);
    if named(sql)?.iter().any(|script| of_label(script)) {
        return Ok(true);
    }
    Ok(!rows(
        sql,
        "SELECT 1 AS open FROM preview_apply a JOIN preview_slot s ON s.id = a.slot_id
           WHERE s.label = ? AND NOT (a.confirmed = 1 AND a.applied_value IS NULL)",
        vec![label.into()],
    )?
    .is_empty())
}

/// The 5-minute reconcile found `host`'s entry holding `found` (`None` when it couldn't be read), and the host is one of
/// the room's preview hosts. `(known, changed)`. **The reconcile never writes or removes an entry:** where what is there
/// differs from what the applier last confirmed, the room forgets it confirmed the host, and its own applier, still the
/// only writer, makes it right.
pub(super) fn check_entry(
    sql: &SqlStorage,
    host: &str,
    found: Option<&str>,
    now: i64,
) -> R<(bool, bool)> {
    let row = rows(
        sql,
        "SELECT applied_value, confirmed FROM preview_apply WHERE host = ?",
        vec![host.into()],
    )?;
    let Some(row) = row.first() else {
        return Ok((false, false));
    };
    if int(&row["confirmed"]) != 1 {
        return Ok((true, false));
    }
    if found.is_some() && row["applied_value"].as_str() == found {
        return Ok((true, false));
    }
    exec(
        sql,
        "UPDATE preview_apply SET confirmed = 0, attempts = 0, next_attempt_at = NULL, last_code = 'reconcile_differs', updated_at = ?
           WHERE host = ?",
        vec![now.into(), host.into()],
    )?;
    Ok((true, true))
}

/// The hourly reconcile found `script` in the preview namespace. `(known, changed)`: whether its label is one of the
/// room's preview labels, and whether the room queued it for deletion just now, by core's `reconcile_script`, from what
/// the room's slots and releases say of it.
pub(super) fn check_script(
    sql: &SqlStorage,
    script: &str,
    listed_at: Option<i64>,
    now: i64,
) -> R<(bool, bool)> {
    let ScriptOwner::Podster { label, release_id } = script_owner(script) else {
        return Ok((false, false));
    };
    if super::preview::label_kind(sql, label)? != Some(podster_core::preview::Environment::Preview)
    {
        return Ok((false, false));
    }
    let claim = if named(sql)?.iter().any(|n| n == script) {
        RoomClaim::Claims
    } else {
        rows(
            sql,
            "SELECT coalesce(upload_started_at, updated_at) AS since FROM release WHERE id = ? AND state IN ('uploading', 'uncertain')",
            vec![release_id.into()],
        )?
        .first()
        .map_or(RoomClaim::Disowns, |row| RoomClaim::Uploading {
            since: int(&row["since"]),
        })
    };
    if reconcile_script(script, claim, super::release_recheck::release_now(sql))
        != ScriptReconcile::Delete
    {
        return Ok((true, false));
    }
    let queued_or_gone_since = !rows(
        sql,
        "SELECT 1 AS q FROM script_delete WHERE script_name = ?1 AND (gone_at IS NULL OR gone_at >= ?2)",
        vec![script.into(), listed_at.unwrap_or(i64::MAX).into()],
    )?
    .is_empty();
    if queued_or_gone_since {
        return Ok((true, false));
    }
    exec(
        sql,
        "INSERT INTO script_delete (script_name, label, queued_at, next_attempt_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (script_name) DO UPDATE SET gone_at = NULL, next_attempt_at = excluded.next_attempt_at, last_code = 'reconcile_found',
             queued_at = excluded.queued_at",
        vec![script.into(), label.into(), now.into(), now.into()],
    )?;
    Ok((true, true))
}
