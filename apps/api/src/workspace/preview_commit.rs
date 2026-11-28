//! A preview release's commit, its marker's flight and its set-back (M8 step 6; the preview plan's 3.2, "A replacement
//! goes live only when its marker comes back", and 3.4). **The release job's order unchanged** (`release_commit`'s
//! stage, outside reads and confirm; `release_marker`'s switch, fetch and record), on the preview slot's own serve state
//! through core's preview commands (`podster_core::preview`): `preview_commit_live`, `preview_confirm_served`,
//! `preview_set_back`. Production's are never called on it, and these never on production's.
//!
//! - **Stage** ([`stage`]): the slot's open hosts name the release's script and its flight opens; nothing is served on
//!   it until the confirm records it live, since the applier writes a preview host's entry only for a release recorded
//!   live or served (`preview_apply`). Refused, never queued, while another preview's flight is open: it waits
//!   `release_in_flight`, as production's commit waits, counting no attempt. **The slot's own flight is apart from
//!   production's,** so a preview never waits on a production flight, or the reverse.
//! - **Confirm** ([`confirm`]): production's whole recheck again, on the reads made after the stage.
//! - **Served** ([`serve`]): the marker came back through the preview host; the release before it is `replaced` and its
//!   script deleted, since a preview keeps nothing for a rollback (the plan's 3.1).
//! - **Set back** ([`set_back`]): any failure of a staged or live preview release puts each host back where its version
//!   is still what the commit wrote. **So a failed replacement leaves the last working preview serving.**
//!
//! Logs carry the room's and the release's IDs and codes.
use super::preview::{current, write};
use super::release_commit::{failed, queue_script, rechecked_failed, uploaded, Staged};
use super::release_recheck::{
    answer, judge, release_row, standing_unknown, state_of, Reads, Verdict,
};
use super::*;
use podster_core::preview::{
    preview_commit_live, preview_confirm_served, preview_set_back, PreviewCommitRefusal,
};
use podster_core::release::{
    next_state, CommitLiveRefusal, ReleaseEvent, ReleaseState, UploadFailure,
};
use podster_core::release_uncertain::{commit_waits_on_uncertain, COMMIT_WAITS_UNCERTAIN};

/// Whether `label` is the room's live preview label: the current slot's, not retired. A preview release under any other
/// label, its slot deleted among them, can never be uploaded, staged or committed.
pub(super) fn label_live(sql: &SqlStorage, label: &str) -> R<bool> {
    Ok(current(sql)?.is_some_and(|stored| stored.slot.label() == label)
        && !rows(
            sql,
            "SELECT 1 AS live FROM app_label WHERE label = ? AND kind = 'preview' AND retired_at IS NULL",
            vec![label.into()],
        )?
        .is_empty())
}

/// The first transaction of a preview release's commit: production's [`release_commit::stage`], on the slot.
pub(super) fn stage(sql: &SqlStorage, release_id: &str, now: i64) -> R<Staged> {
    release_commit::end_stale(sql, now)?;
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let state = state_of(&release)?;
    if state != ReleaseState::Uploading {
        return Ok(Staged::Answer(answer(&release, false, None)));
    }
    if release["script_release_id"].as_str() != Some(release_id) {
        return Err(ApiError::internal(
            "a preview release whose script isn't its own isn't committed",
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
    let label = text(&release["label"]).unwrap_or_default();
    if !label_live(sql, &label)? {
        let reason = UploadFailure::LabelRetired.code();
        return Ok(Staged::Answer(failed(sql, release_id, reason, now)?));
    }
    if super::release_store::bound_to_owed(sql, release_id)? {
        let reason = podster_core::app_store::NoBinding::DeleteOwed.code();
        return Ok(Staged::Answer(failed(sql, release_id, reason, now)?));
    }
    if !uploaded(sql, release_id, &script)? {
        let mut waiting = answer(&release, false, None);
        waiting["waiting"] = release_commit::NOT_UPLOADED.into();
        return Ok(Staged::Answer(waiting));
    }
    let stored =
        current(sql)?.ok_or_else(|| ApiError::internal("a live preview label with no slot"))?;
    let own_flight = stored
        .slot
        .serve()
        .in_flight()
        .is_some_and(|flight| flight.release_id == release_id);
    // While another preview release is `uncertain`, no preview goes live: whether its script stands is unsettled.
    // Production's uncertain releases don't hold a preview, nor the reverse: their scripts are in another namespace.
    let uncertain: Vec<String> = rows(
        sql,
        &format!(
            "SELECT id FROM release WHERE state = 'uncertain' AND {}",
            super::preview::IS_PREVIEW
        ),
        vec![],
    )?
    .iter()
    .filter_map(|row| text(&row["id"]))
    .collect();
    let uncertain: Vec<&str> = uncertain.iter().map(String::as_str).collect();
    if !own_flight && commit_waits_on_uncertain(release_id, &uncertain) {
        let mut waiting = answer(&release, false, None);
        waiting["waiting"] = COMMIT_WAITS_UNCERTAIN.into();
        return Ok(Staged::Answer(waiting));
    }
    // The slot's own serve epoch, which only a deletion raises; the release's label is the slot's, checked above, and a
    // deleted slot is never current again, so a release asked before a deletion can never commit after it.
    let epoch = stored.slot.serve().epoch();
    match preview_commit_live(&stored.slot, epoch, &script, release_id, state) {
        Ok((after, _)) => {
            if after != stored.slot {
                write(sql, &after, now)?;
            }
            Ok(Staged::Staged)
        }
        // Waited for as production's commit waits for its flight, counting no attempt: the code is production's own.
        Err(PreviewCommitRefusal::Commit(CommitLiveRefusal::InFlight)) => {
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

/// The second transaction of a preview release's commit, after the outside reads: production's
/// [`release_commit::confirm`], on the slot's flight.
pub(super) fn confirm(sql: &SqlStorage, release_id: &str, reads: &Reads, now: i64) -> R<Value> {
    release_commit::end_stale(sql, now)?;
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let state = state_of(&release)?;
    if state != ReleaseState::Uploading {
        return Ok(answer(&release, false, None));
    }
    let staged = current(sql)?.is_some_and(|stored| {
        stored.slot.serve().in_flight().is_some_and(|flight| {
            flight.release_id == release_id
                && Some(flight.script.as_str()) == release["script_name"].as_str()
        })
    });
    if !staged || reads.age(now) > release_commit::MAX_READ_AGE_MS {
        return Err(standing_unknown());
    }
    if super::release_store::bound_to_owed(sql, release_id)? {
        let reason = podster_core::app_store::NoBinding::DeleteOwed.code();
        return failed(sql, release_id, reason, now);
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
            exec(
                sql,
                "INSERT INTO release_job (release_id, live_at, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT (release_id) DO UPDATE SET live_at = excluded.live_at, switched_at = NULL",
                vec![release_id.into(), now.into(), now.into()],
            )?;
            // The preview hosts that waited for this are due at once.
            exec(
                sql,
                "UPDATE preview_apply SET attempts = 0, next_attempt_at = NULL, last_code = NULL, updated_at = ? WHERE last_code = ?",
                vec![now.into(), release_commit::NOT_CONFIRMED.into()],
            )?;
            release_commit::record(
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

/// The preview release in flight, while it is `live`: its marker's job, beside production's (`release_marker`).
pub(super) fn flight_release(sql: &SqlStorage) -> R<Option<String>> {
    let Some(stored) = current(sql)? else {
        return Ok(None);
    };
    let Some(flight) = stored.slot.serve().in_flight() else {
        return Ok(None);
    };
    let live = !rows(
        sql,
        "SELECT 1 AS live FROM release WHERE id = ? AND state = 'live'",
        vec![flight.release_id.as_str().into()],
    )?
    .is_empty();
    Ok(live.then(|| flight.release_id.clone()))
}

/// The preview release whose flight is open, whatever its state: what a preview commit waits for.
pub(super) fn flight_any(sql: &SqlStorage) -> R<Option<String>> {
    Ok(current(sql)?.and_then(|stored| {
        stored
            .slot
            .serve()
            .in_flight()
            .map(|f| f.release_id.clone())
    }))
}

/// Whether the preview applier has switched the default preview host to the flight: the slot wants exactly the
/// flight's script there, and the applier confirmed exactly that entry written (`preview_apply::wanted_value`).
pub(super) fn switched(sql: &SqlStorage) -> R<bool> {
    let Some(stored) = current(sql)? else {
        return Ok(false);
    };
    let Some(flight) = stored.slot.serve().in_flight() else {
        return Ok(false);
    };
    let default = stored.slot.serve().hosts().first();
    if default.and_then(|h| h.script.as_deref()) != Some(flight.script.as_str()) {
        return Ok(false);
    }
    let Some(host) = stored.host.as_deref() else {
        return Ok(false);
    };
    super::preview_apply::confirmed_as_wanted(sql, host)
}

/// Where to fetch the live preview release's marker, its commit and the release it must name: the slot's default host.
pub(super) fn target(sql: &SqlStorage, release_id: &str) -> R<Option<(String, String, String)>> {
    let Some(release) = release_row(sql, release_id)? else {
        return Ok(None);
    };
    if state_of(&release)? != ReleaseState::Live {
        return Ok(None);
    }
    let (Some(label), Some(commit)) = (text(&release["label"]), text(&release["commit_sha"]))
    else {
        return Ok(None);
    };
    Ok(current(sql)?
        .filter(|stored| stored.slot.label() == label)
        .and_then(|stored| stored.host)
        .map(|host| (host, commit, release_id.to_owned())))
}

/// The preview release is recorded served, in the caller's transaction, if core's `preview_confirm_served` takes it: the
/// release before it is `replaced`, and every script nothing names any more is queued for deletion. `false` and nothing
/// written otherwise. Only preview releases are ever replaced here: production's are never read.
pub(super) fn serve(sql: &SqlStorage, release_id: &str, now: i64) -> R<bool> {
    let Some(stored) = current(sql)? else {
        return Ok(false);
    };
    let Some(flight) = stored
        .slot
        .serve()
        .in_flight()
        .filter(|flight| flight.release_id == release_id)
        .cloned()
    else {
        return Ok(false);
    };
    let Ok(confirmed) = preview_confirm_served(stored.slot.serve(), &flight.mark, &flight.script)
    else {
        return Ok(false);
    };
    let served = next_state(ReleaseState::Live, ReleaseEvent::MarkerSeen)
        .map_err(|_| ApiError::internal("a live release that can't be served"))?;
    write(sql, &stored.slot.with_serve(confirmed.serve), now)?;
    exec(
        sql,
        "UPDATE release SET state = ?, served_at = ?, updated_at = ? WHERE id = ?",
        vec![
            served.name().into(),
            now.into(),
            now.into(),
            release_id.into(),
        ],
    )?;
    release_commit::record(
        sql,
        "release.served",
        release_id,
        ReleaseState::Live.name(),
        served.name(),
        now,
    )?;
    for other in rows(
        sql,
        &format!(
            "SELECT id, state FROM release WHERE state IN ('live', 'served') AND id != ? AND label = ? AND {} ORDER BY seq",
            super::preview::IS_PREVIEW
        ),
        vec![release_id.into(), stored.slot.label().into()],
    )? {
        let (Some(id), Ok(from)) = (text(&other["id"]), state_of(&other)) else {
            continue;
        };
        if let Ok(to) = next_state(from, ReleaseEvent::Replace) {
            exec(
                sql,
                "UPDATE release SET state = ?, finished_at = ?, updated_at = ? WHERE id = ?",
                vec![to.name().into(), now.into(), now.into(), id.as_str().into()],
            )?;
            release_commit::record(sql, "release.replaced", &id, from.name(), to.name(), now)?;
        }
    }
    for script in &confirmed.delete {
        queue_script(sql, script, None, now)?;
    }
    Ok(true)
}

/// **A failed preview release's hosts go back** (core's `preview_set_back`), in the failing release's own transaction
/// (`release_commit::end_failed`): only when the slot's flight is exactly this release's, host by host where the
/// commit's version still stands. A release whose slot was deleted, or whose flight is another's, changes nothing here.
pub(super) fn set_back(sql: &SqlStorage, release_id: &str, now: i64) -> R<()> {
    let Some(stored) = current(sql)? else {
        return Ok(());
    };
    let Some(flight) = stored
        .slot
        .serve()
        .in_flight()
        .filter(|flight| flight.release_id == release_id)
        .cloned()
    else {
        return Ok(());
    };
    let back = preview_set_back(stored.slot.serve(), &flight.mark, &flight.script)
        .map_err(|_| ApiError::internal("the slot's own flight was stale"))?;
    write(sql, &stored.slot.with_serve(back.serve), now)
}
