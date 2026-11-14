//! The release job's marker (M6 step 5; ADR 0010's "The release job", step 6): for the release in flight, once the room
//! has committed it live, the room's alarm waits for its applier to switch the default host's entry, then fetches the
//! release's marker through that host. **Behind `RELEASES`, exactly `true`, and the gate on the release path,** as the
//! rest of the driver is (`release_driver`). What it decides is pure, in `podster_core::release_marker`; here is only
//! what it reads, writes and fetches.
//!
//! - **Which release:** the one the room's flight is for, while it is `live`. Only one flight is ever open
//!   (`podster_core::release::commit_live`). Its marker's wait runs beside the oldest queued or uploading release's
//!   steps: a later release may read and upload meanwhile, and its commit waits `release_in_flight`, counting no
//!   attempt (the driver's ruling 7), until this flight ends.
//! - **The switch** ([`lease`]), on the room's rows alone, in the room's transaction: the default host wants exactly the
//!   flight's script at the version its commit wrote, and the applier has recorded that entry written. Until it has,
//!   nothing is fetched and the room looks again; past the switch's bound from going live, the release is set back,
//!   `release_not_switched`. When the room first sees the switch, it keeps the time: the marker's wait runs from it.
//! - **The fetch** ([`Workspace::marker_step`]), as a step of the driver with a lease of its own, handed off from the
//!   alarm so the alarm never waits on it: the lease is asked first, then one `GET` of
//!   `/.well-known/podster-release.json` on the default host, with no credential. Besides the host, only the stop for
//!   the content domain is asked, at its home, before the fetch.
//! - **The record** ([`record`]), in the room's transaction: the lease, the release epoch and the hold's generation are
//!   each compared with the lease's, and the flight must still be this release's; if any moved, nothing is kept.
//!   Otherwise: **served** when this release's own marker came back (core's `confirm_served`: hosts opened meanwhile
//!   catch up, the release before becomes the kept one, the one kept before that is queued for deletion, and the
//!   release before is `replaced`); fetched again after a short wait; or, at the wait's end, **set back**: the release
//!   fails, `release_marker_missing`, and core's `set_back` puts each host back only where the epoch and the host's
//!   own version are still exactly what the commit wrote, so a failed check never brings back what an unpublish took
//!   down. Either way this release's script is queued for deletion by the room's `fail`.
//! - **A stop during the wait** ([`stop_cause`]): a hold because nobody may release, or the stop for the whole content
//!   domain, ends the release at once with that stop's own cause, `no_releaser` or `release_stopped`, never
//!   `release_marker_missing` or `release_not_switched` (the architect's ruling on the PR's question 9, 2026-11-14). A
//!   hold is read in the lease's transaction, so **no fetch is leased while the app is held**: a marker read then could
//!   be a stale entry's, and would record a held app's release served. The stop is read from its home before the lease
//!   and again before the fetch. An unpublish, a suspension among them, closes the flight itself, and the release ends
//!   `unpublished` under that unpublish's cause.
//! - **A marker that comes back after its release was set back** (its step's lease ran out, and a later pass set the
//!   release back) records nothing served. Its answer and log show the set-back it found, with its code.
//! - **A flight's end wakes** every release waiting `release_in_flight`.
//!
//! **Not shown, and not decided here:** whether 30 seconds is long enough at the real host. ADR 0010 calls it
//! provisional until spike G, and a false failure only sets back.
//!
//! Logs carry the room's and the release's IDs and codes. The host is never logged.
use super::release_commit::{end_stale, fail, queue_script, record as record_change, write_state};
use super::release_driver::{epoch_and_hold, room_id, set_job, StepLease, MOVED};
use super::release_recheck::{release_now, release_row, state_of};
use super::*;
use podster_core::release::{
    confirm_served, next_state, RecheckFailure, ReleaseEvent, ReleaseState, UnpublishTrigger,
};
use podster_core::release_driver::{step_still_current, DRIVE_IDLE_MS, IN_FLIGHT_WAITING};
use podster_core::release_marker::{
    marker_outcome, marker_plan, marker_seen, marker_switched, MarkerOutcome, MarkerPlan,
    AWAITING_MARKER, MARKER_LEASE_MS,
};

/// The release the room's flight is for, while it is `live`: the marker's job.
pub(super) struct Flight {
    pub(super) id: String,
    pub(super) next_attempt_at: Option<i64>,
    attempts: u32,
    live_at: Option<i64>,
    switched_at: Option<i64>,
}

pub(super) fn flight(sql: &SqlStorage) -> R<Option<Flight>> {
    let Some(row) = rows(
        sql,
        "SELECT r.id, j.attempts, j.next_attempt_at, j.live_at, j.switched_at FROM release_config c
           JOIN release r ON r.id = c.in_flight_release LEFT JOIN release_job j ON j.release_id = r.id WHERE r.state = 'live'",
        vec![],
    )?
    .into_iter()
    .next() else {
        return Ok(None);
    };
    Ok(Some(Flight {
        id: text(&row["id"]).ok_or_else(|| ApiError::internal("a flight with no release"))?,
        next_attempt_at: row["next_attempt_at"].as_i64(),
        attempts: u32::try_from(int(&row["attempts"]).max(0)).unwrap_or(u32::MAX),
        live_at: row["live_at"].as_i64(),
        switched_at: row["switched_at"].as_i64(),
    }))
}

/// Whether the room's applier has switched the default host to the flight: core's `marker_switched`, on the room's
/// rows. A room with no default host, or no flight, isn't switched.
fn switched(sql: &SqlStorage) -> R<bool> {
    let found = rows(
        sql,
        "SELECT s.version, s.script_name, s.flight_version, a.applied_version, a.applied_script, c.in_flight_script
           FROM serve_state s JOIN release_config c LEFT JOIN serve_apply a ON a.host = s.host WHERE s.kind = 'default'",
        vec![],
    )?;
    Ok(found.first().is_some_and(|row| {
        marker_switched(
            int(&row["version"]),
            row["script_name"].as_str(),
            row["flight_version"].as_i64(),
            row["in_flight_script"].as_str().unwrap_or_default(),
            row["applied_version"].as_i64(),
            row["applied_script"].as_str(),
        )
    }))
}

/// Wakes every release waiting for another's flight: the flight has ended.
fn wake_waiting(sql: &SqlStorage, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE release_job SET next_attempt_at = ?, updated_at = ? WHERE last_code = ? AND leased_step IS NULL",
        vec![now.into(), now.into(), IN_FLIGHT_WAITING.into()],
    )
}

/// The set-back, in the caller's transaction: the release fails with `code`, and the room's `fail` puts its hosts back
/// under core's `set_back` condition and queues its script. The job keeps the code, and those waiting are woken.
fn set_back(sql: &SqlStorage, release_id: &str, code: &str, now: i64) -> R<()> {
    fail(sql, release_id, code, None, now)?;
    set_job(sql, release_id, None, Some(code), now)?;
    wake_waiting(sql, now)?;
    console_log!(
        "release: a release was set back: room={} release={} code={}",
        room_id(sql),
        release_id,
        code
    );
    Ok(())
}

/// Why the flight must end now rather than wait or fetch, if a stop holds: a hold on the app because nobody may
/// release (`no_releaser`), read here, or the stop for the whole content domain (`release_stopped`, as the recheck
/// names it), which the caller read from its home before the transaction (`stopped`). `None` if neither holds.
fn stop_cause(sql: &SqlStorage, stopped: bool) -> R<Option<&'static str>> {
    if releasers::hold_state(sql)?.0 {
        return Ok(Some(UnpublishTrigger::NoReleaserLeft.code()));
    }
    Ok(stopped.then(|| RecheckFailure::DomainStopped.code()))
}

/// The release is recorded served, in the caller's transaction, if core's `confirm_served` takes it: the flight is
/// still exactly this release's, under its epoch, with the default host still at what its commit wrote. `false` and
/// nothing written otherwise.
fn serve(sql: &SqlStorage, release_id: &str, now: i64) -> R<bool> {
    let Some(loaded) = takedown::load(sql)? else {
        return Ok(false);
    };
    let Some(flight) = loaded
        .state
        .in_flight
        .clone()
        .filter(|flight| flight.release_id == release_id)
    else {
        return Ok(false);
    };
    let Ok(confirmed) = confirm_served(&loaded.state, &flight.mark, &flight.script) else {
        return Ok(false);
    };
    let served = next_state(ReleaseState::Live, ReleaseEvent::MarkerSeen)
        .map_err(|_| ApiError::internal("a live release that can't be served"))?;
    write_state(sql, &loaded.hosts, &confirmed.state, now)?;
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
    record_change(
        sql,
        "release.served",
        release_id,
        ReleaseState::Live.name(),
        served.name(),
        now,
    )?;
    // The release this one replaces, and any other still recorded as serving.
    for other in rows(
        sql,
        "SELECT id, state FROM release WHERE state IN ('live', 'served') AND id != ? ORDER BY seq",
        vec![release_id.into()],
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
            record_change(sql, "release.replaced", &id, from.name(), to.name(), now)?;
        }
    }
    // The script kept before the one now kept: nothing can roll back to it any more.
    if let Some(script) = confirmed.after.delete {
        queue_script(sql, &script, None, now)?;
    }
    Ok(true)
}

/// What the marker's lease came to: the release and the attempt leased for a fetch, or the answer when nothing is
/// to be fetched now.
pub(super) type Leased = std::result::Result<(String, u32), Value>;

/// The marker's lease, in the room's transaction: see the module's note. `idle` is why the driver may do nothing now,
/// and `stopped` whether the content domain's stop is set, both read before the transaction. `Ok` names the release
/// and the attempt leased for a fetch; `Err` is the answer when nothing is to be fetched now. **Nothing is leased while
/// the app is held or the domain stopped:** the release ends with that stop's cause instead.
pub(super) fn lease(
    sql: &SqlStorage,
    idle: Option<&'static str>,
    stopped: bool,
    now: i64,
) -> R<Leased> {
    end_stale(sql, now)?;
    let Some(flight) = flight(sql)? else {
        return Ok(Err(json!({ "release_id": null, "outcome": "none" })));
    };
    let answer = |outcome: &str, code: Option<&str>, next: Option<i64>| {
        Err(
            json!({ "release_id": flight.id, "outcome": outcome, "code": code, "next_attempt_at": next, "step": "marker" }),
        )
    };
    if flight.next_attempt_at.is_some_and(|at| at > now) {
        return Ok(answer("not_due", None, flight.next_attempt_at));
    }
    if let Some(code) = idle {
        let next = now.saturating_add(DRIVE_IDLE_MS);
        set_job(sql, &flight.id, Some(next), Some(code), now)?;
        return Ok(answer("idle", Some(code), Some(next)));
    }
    if let Some(code) = stop_cause(sql, stopped)? {
        set_back(sql, &flight.id, code, now)?;
        return Ok(answer("set_back", Some(code), None));
    }
    // A release that went live before its confirm kept the time is taken as live from now: its wait only starts later.
    let live_at = match flight.live_at {
        Some(at) => at,
        None => {
            exec(
                sql,
                "INSERT INTO release_job (release_id, live_at, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT (release_id) DO UPDATE SET live_at = coalesce(release_job.live_at, excluded.live_at)",
                vec![flight.id.as_str().into(), now.into(), now.into()],
            )?;
            now
        }
    };
    let switched_at = if switched(sql)? {
        Some(match flight.switched_at {
            Some(at) => at,
            None => {
                exec(
                    sql,
                    "UPDATE release_job SET switched_at = ? WHERE release_id = ?",
                    vec![now.into(), flight.id.as_str().into()],
                )?;
                now
            }
        })
    } else {
        None
    };
    match marker_plan(live_at, switched_at, now) {
        MarkerPlan::Wait { at, code } => {
            set_job(sql, &flight.id, Some(at), Some(code), now)?;
            Ok(answer("waiting", Some(code), Some(at)))
        }
        MarkerPlan::SetBack { code } => {
            set_back(sql, &flight.id, code, now)?;
            Ok(answer("set_back", Some(code), None))
        }
        MarkerPlan::Fetch => {
            let attempt = flight.attempts.saturating_add(1);
            let (epoch, hold) = epoch_and_hold(sql)?;
            exec(
                sql,
                "UPDATE release_job SET attempts = ?, next_attempt_at = ?, leased_step = 'marker', leased_epoch = ?, leased_hold = ?,
                   updated_at = ? WHERE release_id = ?",
                vec![
                    i64::from(attempt).into(),
                    now.saturating_add(MARKER_LEASE_MS).into(),
                    epoch.into(),
                    hold.into(),
                    now.into(),
                    flight.id.as_str().into(),
                ],
            )?;
            Ok(Ok((flight.id, attempt)))
        }
    }
}

/// Where to fetch a live release's marker, and the commit it must name: the room's default host, if it is this
/// release's label's host on the deployment's content domain. `None` otherwise, and nothing is fetched.
fn target(sql: &SqlStorage, env: &Env, release_id: &str) -> R<Option<(String, String)>> {
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
    let host = rows(
        sql,
        "SELECT host FROM serve_state WHERE kind = 'default'",
        vec![],
    )?
    .first()
    .and_then(|row| text(&row["host"]));
    let Some(domain) = crate::content_provider::content_domain(env) else {
        return Ok(None);
    };
    Ok(host
        .filter(|host| {
            crate::content_provider::default_host_label_on(&domain, host) == Some(label.as_str())
        })
        .map(|host| (host, commit)))
}

/// The answer for a step whose lease is no longer the job's: nothing is kept of it. If the release was set back
/// meanwhile, the answer and the log say so, with the set-back's code, and whether this late fetch saw the marker: a
/// marker that comes back after its release was set back is never recorded served.
fn stale(sql: &SqlStorage, release_id: &str, seen: bool) -> R<Value> {
    let release = release_row(sql, release_id)?;
    let failed = release
        .as_ref()
        .is_some_and(|row| row["state"].as_str() == Some(ReleaseState::Failed.name()));
    if !failed {
        return Ok(json!({ "release_id": release_id, "outcome": "stale" }));
    }
    let code = release.as_ref().and_then(|row| text(&row["failure_code"]));
    console_log!(
        "release: a marker step ended after its release was set back: room={} release={} code={} seen={}",
        room_id(sql),
        release_id,
        code.as_deref().unwrap_or("none"),
        seen
    );
    Ok(
        json!({ "release_id": release_id, "outcome": "stale", "set_back": true, "code": code, "seen": seen, "state": ReleaseState::Failed.name(), "step": "marker" }),
    )
}

/// The record of a marker step, in the room's transaction: see the module's note. `seen` is whether this release's
/// own marker came back; `stop` is the stop's cause when the step found the content domain stopped and fetched nothing.
fn record(
    sql: &SqlStorage,
    release_id: &str,
    attempt: u32,
    seen: bool,
    stop: Option<&'static str>,
    now: i64,
) -> R<Value> {
    end_stale(sql, now)?;
    let job = rows(
        sql,
        "SELECT attempts, leased_epoch, leased_hold, switched_at FROM release_job WHERE release_id = ? AND leased_step = 'marker'",
        vec![release_id.into()],
    )?;
    let Some(job) = job.first() else {
        return stale(sql, release_id, seen);
    };
    let attempts = u32::try_from(int(&job["attempts"]).max(0)).unwrap_or(u32::MAX);
    let (epoch, hold) = epoch_and_hold(sql)?;
    if !step_still_current(
        attempt,
        attempts,
        int(&job["leased_epoch"]),
        epoch,
        int(&job["leased_hold"]),
        hold,
    ) {
        if attempt != attempts {
            return stale(sql, release_id, seen);
        }
        // The room moved under the fetch: what came back is about a room that no longer is. Looked at afresh.
        set_job(sql, release_id, Some(now), Some(MOVED), now)?;
        return Ok(json!({ "release_id": release_id, "outcome": "moved", "code": MOVED }));
    }
    let still_flight = flight(sql)?.is_some_and(|flight| flight.id == release_id);
    let (name, code, next) = if !still_flight {
        // It is no longer the live release in flight: unpublished, or ended some other way. Nothing is the job's.
        set_job(sql, release_id, None, None, now)?;
        ("done", None, None)
    } else if let Some(code) = stop_cause(sql, stop.is_some())? {
        set_back(sql, release_id, code, now)?;
        ("set_back", Some(code), None)
    } else {
        let switched_at = job["switched_at"].as_i64().unwrap_or(now);
        let served = seen && serve(sql, release_id, now)?;
        match marker_outcome(served, switched_at, now) {
            MarkerOutcome::Served => {
                set_job(sql, release_id, None, None, now)?;
                wake_waiting(sql, now)?;
                ("served", None, None)
            }
            MarkerOutcome::Retry { at } => {
                set_job(sql, release_id, Some(at), Some(AWAITING_MARKER), now)?;
                ("retry", Some(AWAITING_MARKER), Some(at))
            }
            MarkerOutcome::SetBack { code } => {
                set_back(sql, release_id, code, now)?;
                ("set_back", Some(code), None)
            }
        }
    };
    console_log!(
        "release: a marker step: room={} release={} outcome={} code={}",
        room_id(sql),
        release_id,
        name,
        code.unwrap_or("none")
    );
    let after = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    Ok(
        json!({ "release_id": release_id, "outcome": name, "code": code, "next_attempt_at": next, "state": after["state"], "step": "marker" }),
    )
}

impl Workspace {
    /// One marker step, leased as `attempt`: the lease is asked, then the marker is fetched once through the default
    /// host, and what came of it is recorded. A step whose lease has run out fetches nothing, and its record finds the
    /// marker not seen, or finds the lease another's and keeps nothing.
    pub(super) async fn marker_step(
        &self,
        release_id: &str,
        attempt: u32,
        lease: &StepLease,
    ) -> R<Value> {
        let sql = self.state.storage().sql();
        // The stop for the whole content domain, read from its home before anything is fetched: while it is set,
        // nothing is fetched, and the record ends the release with its cause.
        let stopped = matches!(
            crate::content_stop::read_from(&self.env).await,
            crate::content_stop::Stop::Stopped
        );
        let seen = match target(&sql, &self.env, release_id)? {
            Some((host, commit)) if !stopped && lease.holds(&sql) => {
                let fetched = crate::content_provider::fetch_marker(&host).await;
                marker_seen(
                    fetched
                        .as_ref()
                        .map(|(status, body)| (*status, body.as_slice())),
                    release_id,
                    &commit,
                )
            }
            _ => false,
        };
        let id = release_id.to_owned();
        let stop = stopped.then(|| RecheckFailure::DomainStopped.code());
        self.release_transaction(move |sql| record(sql, &id, attempt, seen, stop, release_now(sql)))
            .await
    }
}
