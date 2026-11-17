//! The release job's driver (M6 step 5, the third PR; ADR 0010's "The release job"): the room's alarm takes a release
//! through the room's own commands, one step at a time, start, upload and commit, and takes it up again after a crash
//! or an eviction. **Behind `RELEASES`, exactly `true`, and the gate on the release path.** What it decides is pure,
//! in `podster_core::release_driver`; here is only what it reads, writes and calls.
//!
//! **One release at a time,** the room's oldest that is queued, uploading or `uncertain`, as ADR 0010 has the room run
//! its release jobs in the order it committed them. An `uncertain` one is at its upload step, which settles it by the
//! provider's read of its script (`release_settle`), by its own bounds, taking no upload slot, its reads not counted
//! by the cap. The rest wait behind it. **Beside it, the release in flight's marker**
//! (`release_marker`): once a release is committed live, the alarm waits for its switch and fetches its marker until
//! it is served or set back, before the head's next step. A head that reaches its commit while another release's
//! flight is open waits `release_in_flight`, counting no attempt and taking no upload slot, and that flight's end
//! wakes it (the driver's ruling 7).
//!
//! **A pass of the alarm** ([`Workspace::release_drive_pass`]):
//!
//! 1. Uploads past their hour are ended, in a transaction of their own (`release_commit::bookkeeping`). The room's
//!    alarm is set for the hour's end of every upload under way ([`next_due`]), so nothing waits for someone to ask.
//! 2. Only if the release at the head is due: whether the deployment allows release, exactly `true`, the gate on the
//!    release path is open, and a content provider is configured to upload to. Any not, and the driver does nothing,
//!    counts no attempt and looks again after `DRIVE_IDLE_MS`, with the reason as the job's code.
//! 3. **The read share, while the head is queued** ([`Workspace::read_share`]): the deployment's budget is asked, read
//!    only, whether a full attempt would fit the room's owner's share and the hour now. If not, the release waits as
//!    `queued` under `release_reads_share` until the time it named, and the lease below counts no attempt and takes no
//!    upload slot for it (`waits_uncounted`), so a starved release is never ended by the cap, and its upload's hour
//!    hasn't begun. **The answer authorizes nothing:** the reservation decides again, in the budget's own transaction,
//!    and a race lost there waits `release_reads_budget` as before. Only the room's own row names the owner.
//! 4. **The lease,** one room transaction ([`lease`]): everything is read again, the head included, since the pass
//!    awaited. The step comes from the release's state now. For an upload, the room's hourly upload attempts
//!    (`upload_slot`) must leave room for it, or the release waits for one. The attempt is counted, and the release is
//!    not due again until the lease runs out, `DRIVE_LEASE_MS` on: so a pass that finds the step still out does nothing,
//!    and a step that died with the object is taken up again then. A release with every attempt made ends here,
//!    `release_attempts_exhausted`.
//! 5. **The step is handed to a request of the room's own** (`/internal/release-drive`), kept alive by the alarm's
//!    `wait_until`, and the alarm returns. **So the alarm never waits on an upload,** and a takedown's applier, which the
//!    alarm runs, never waits behind a release job (ADR 0010).
//!
//! **A step** ([`Workspace::release_drive_step`]): the lease must still be its own. The step is the room's own command,
//! [`Workspace::start_upload_of`], [`Workspace::upload_of`] or [`Workspace::commit_live_of`], each of which reads the
//! outside facts afresh and rechecks everything, epoch included, in its own transactions, as when it is asked alone.
//! **The step carries its lease** ([`StepLease`]): before each thing it asks outside the room, and in each transaction
//! that would write, the command checks the lease is still its own and hasn't run out by the release commands' clock.
//! Once it has, the step asks nothing more and writes nothing, and answers `release_drive_lease_lost`; a later pass
//! may have leased the release again by then.
//! Then **the record,** one room transaction ([`record`]): the lease, the release epoch and the app's hold are each
//! compared with what they were at the lease; if any moved, nothing of the step is recorded and the release is looked
//! at afresh. Otherwise what came of it is core's, from the release's state now: the next step at once, done, a wait
//! that grows with the attempts in a row that left the release where it was (`stalls`), or the end.
//!
//! **Passes that fail** are counted in `release_drive_failure`, so the alarm backs off from them across a restart of
//! the object, and the count ends with the first pass that doesn't fail.
//!
//! Logs carry the room's and the release's IDs, the step and codes.
use super::release_commit::{bookkeeping, end_stale, fail, uploaded};
use super::release_recheck::{release_now, release_row, state_of};
use super::release_upload::NO_PROVIDER;
use super::*;
use podster_core::release::{
    is_release_id, window_start, ReleaseState, IN_FLIGHT_EXEMPTION_MS, READ_WINDOW_MS,
};
use podster_core::release_driver::{
    drive_outcome, drive_step, drive_wait_ms, in_flight_due, lease_holds, may_lease,
    read_owner_key, read_share_due, stalls_after, step_still_current, uncounted_outcome,
    upload_slot, waits_in_flight, waits_uncounted, DriveOutcome, DriveStep, ATTEMPTS_EXHAUSTED,
    DRIVE_FIRST_WAIT_MS, DRIVE_IDLE_MS, DRIVE_LEASE_MS, IN_FLIGHT_WAITING, MAX_ATTEMPT_READS,
    READ_SHARE_WAITING,
};
use podster_core::release_uncertain::{
    counted_attempts, may_settle, settle_outcome, SettleDrive, SETTLE_UNKNOWN, UNSETTLED,
};

/// The room's path for one step of the driver. Nothing outside the Worker reaches it: the room's alarm sends it to the
/// room itself.
pub(crate) const INTERNAL_RELEASE_DRIVE: &str = "/internal/release-drive";

/// `last_code` while the driver does nothing: the deployment doesn't allow release, or the release path is closed.
const IDLE: &str = "release_driver_idle";
/// `last_code` while an upload waits for the room's hourly upload attempts to leave room for it.
const UPLOAD_ATTEMPTS: &str = "release_upload_attempts";
/// What a step answers, as `waiting`, when its lease ran out before it was done: it asked nothing more and wrote
/// nothing from there.
pub(super) const LEASE_LOST: &str = "release_drive_lease_lost";
/// `last_code` when the room moved under a step, and the release is looked at afresh.
pub(super) const MOVED: &str = "release_driver_moved";
/// `last_code` for a step that left the release where it was and gave no code of its own.
const NO_PROGRESS: &str = "release_step_no_progress";

/// Test builds only: the driver runs in a room a test gave `test_release_driver (from_alarm)`, and from the room's
/// alarm only while `from_alarm` is 1. Every other test's room is as it was before the driver, and a test drives a
/// room's release one pass at a time, when it says (`/internal/test-release-drive`). Always on in a deployment.
pub(super) fn enabled(sql: &SqlStorage, from_alarm: bool) -> bool {
    #[cfg(feature = "failpoints")]
    {
        let opted = rows(
            sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_release_driver'",
            vec![],
        )
        .is_ok_and(|found| !found.is_empty());
        if !opted {
            return false;
        }
        !from_alarm
            || rows(sql, "SELECT from_alarm FROM test_release_driver", vec![])
                .ok()
                .and_then(|found| found.first().map(|row| int(&row["from_alarm"])))
                == Some(1)
    }
    #[cfg(not(feature = "failpoints"))]
    {
        let _ = (sql, from_alarm);
        true
    }
}

/// Test builds only: a test changes the room at a named point of a step, by leaving statements for the room to run
/// there, in `test_release_at (point, statement)`: `reserved` (an upload's tree reads reserved, before GitHub's token
/// is asked for), `opened` (the token minted, before the trees are read), `staged` (a commit staged, before its
/// outside reads), `store_first` (an upload's recheck held, before its store's settle-first reads the record) and
/// `store_listed` (a store's list read, before anything of it is written). Each runs once. A statement that fails is logged by its code, and the step goes on.
#[cfg(feature = "failpoints")]
pub(super) fn test_at(sql: &SqlStorage, point: &str) {
    let found = rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_release_at'",
        vec![],
    )
    .is_ok_and(|found| !found.is_empty());
    if !found {
        return;
    }
    let ran = rows(
        sql,
        "SELECT statement FROM test_release_at WHERE point = ? ORDER BY rowid",
        vec![point.into()],
    )
    .and_then(|statements| {
        for row in statements {
            exec(sql, row["statement"].as_str().unwrap_or_default(), vec![])?;
        }
        exec(
            sql,
            "DELETE FROM test_release_at WHERE point = ?",
            vec![point.into()],
        )
    });
    if ran.is_err() {
        console_error!("release: a test's statement failed: code=test_release_at_failed");
    }
}

/// The release at the head of the room's line: its oldest that is queued, uploading or `uncertain`. An `uncertain` one
/// holds the line until it is settled or ends: nothing behind it is started or committed meanwhile.
struct Head {
    id: String,
    state: ReleaseState,
    uploaded: bool,
    attempts: u32,
    next_attempt_at: Option<i64>,
}

fn head(sql: &SqlStorage) -> R<Option<Head>> {
    let Some(release) = rows(
        sql,
        "SELECT r.id, r.state, r.script_name, j.attempts, j.next_attempt_at FROM release r LEFT JOIN release_job j ON j.release_id = r.id
           WHERE r.state IN ('queued', 'uploading', 'uncertain') ORDER BY r.seq LIMIT 1",
        vec![],
    )?
    .into_iter()
    .next() else {
        return Ok(None);
    };
    let id = text(&release["id"]).ok_or_else(|| ApiError::internal("a release with no ID"))?;
    let state = state_of(&release)?;
    let uploaded = match release["script_name"].as_str() {
        Some(script) => uploaded(sql, &id, script)?,
        None => false,
    };
    Ok(Some(Head {
        id,
        state,
        uploaded,
        attempts: u32::try_from(int(&release["attempts"]).max(0)).unwrap_or(u32::MAX),
        next_attempt_at: release["next_attempt_at"].as_i64(),
    }))
}

/// The room's release epoch and its app's hold generation, which a step's record compares with the lease's.
pub(super) fn epoch_and_hold(sql: &SqlStorage) -> R<(i64, i64)> {
    let epoch = rows(sql, "SELECT release_epoch FROM release_config", vec![])?
        .first()
        .map_or(0, |row| int(&row["release_epoch"]));
    Ok((epoch, releasers::hold_state(sql)?.1))
}

/// The lease a step was given, which the step's command checks before each thing it asks outside the room and in each
/// transaction that would write. A command asked alone, not by the driver, has none.
#[derive(Clone)]
pub(super) struct StepLease {
    pub(super) release_id: String,
    pub(super) attempt: u32,
}

impl StepLease {
    /// Whether the lease is still this step's: the job's current lease, not run out by the release commands' clock. A
    /// lease that can't be read doesn't hold.
    pub(super) fn holds(&self, sql: &SqlStorage) -> bool {
        rows(
            sql,
            "SELECT attempts, next_attempt_at FROM release_job WHERE release_id = ? AND leased_step IS NOT NULL",
            vec![self.release_id.as_str().into()],
        )
        .ok()
        .and_then(|found| found.into_iter().next())
        .is_some_and(|job| {
            int(&job["attempts"]) == i64::from(self.attempt)
                && job["next_attempt_at"]
                    .as_i64()
                    .is_some_and(|until| lease_holds(until, release_now(sql)))
        })
    }
}

/// Whether a command may go on: it was asked alone, or its step's lease still holds.
pub(super) fn may_go_on(sql: &SqlStorage, lease: Option<&StepLease>) -> bool {
    lease.is_none_or(|lease| lease.holds(sql))
}

/// What a command answers when its step's lease ran out: the release as it is, `waiting` [`LEASE_LOST`].
pub(super) fn lease_lost(sql: &SqlStorage, release_id: &str) -> R<Value> {
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let mut out = super::release_recheck::answer(&release, false, None);
    out["waiting"] = LEASE_LOST.into();
    console_log!(
        "release: a step's lease ran out: release={} code={}",
        release_id,
        LEASE_LOST
    );
    Ok(out)
}

/// How many passes of the driver have failed in a row, as recorded.
fn drive_failures(sql: &SqlStorage) -> R<u32> {
    Ok(
        rows(sql, "SELECT failures FROM release_drive_failure", vec![])?
            .first()
            .map_or(0, |row| {
                u32::try_from(int(&row["failures"]).max(0)).unwrap_or(u32::MAX)
            }),
    )
}

/// Records what came of a pass of the driver: a failure counts one more, and a pass that didn't fail ends the count.
pub(super) fn record_pass(sql: &SqlStorage, failed: bool, now: i64) -> R<()> {
    if failed {
        exec(
            sql,
            "INSERT INTO release_drive_failure (singleton, failures, last_failed_at) VALUES (1, 1, ?)
               ON CONFLICT (singleton) DO UPDATE SET failures = failures + 1, last_failed_at = excluded.last_failed_at",
            vec![now.into()],
        )
    } else {
        exec(sql, "DELETE FROM release_drive_failure", vec![])
    }
}

/// Writes the job's row for a release, made if it isn't there: when it is next due and why it waits. Any lease is
/// cleared.
pub(super) fn set_job(
    sql: &SqlStorage,
    release_id: &str,
    next_attempt_at: Option<i64>,
    code: Option<&str>,
    now: i64,
) -> R<()> {
    exec(
        sql,
        "INSERT INTO release_job (release_id, next_attempt_at, last_code, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (release_id) DO UPDATE SET next_attempt_at = excluded.next_attempt_at, last_code = excluded.last_code,
             leased_step = NULL, leased_epoch = NULL, leased_hold = NULL, updated_at = excluded.updated_at",
        vec![
            release_id.into(),
            next_attempt_at.map_or(V::Null, V::from),
            code.map_or(V::Null, V::from),
            now.into(),
        ],
    )
}

/// The owner a room's release reads are charged to, from the room's own row: its organization, else its owner person,
/// else the room (`read_owner_key`). **Never from a request.** One that can't be read refuses, and nothing is reserved.
pub(super) fn read_owner(sql: &SqlStorage) -> R<String> {
    let room = rows(
        sql,
        "SELECT id, owner_org_id, owner_person_id FROM workspace",
        vec![],
    )?;
    let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
    read_owner_key(
        room["owner_org_id"].as_str(),
        room["owner_person_id"].as_str(),
        room["id"].as_str().unwrap_or_default(),
    )
    .ok_or_else(|| ApiError::internal("a room with no owner to charge its reads to"))
}

pub(super) fn room_id(sql: &SqlStorage) -> String {
    rows(sql, "SELECT id FROM workspace", vec![])
        .ok()
        .and_then(|found| found.first().and_then(|row| text(&row["id"])))
        .unwrap_or_default()
}

/// When the driver next needs the room's alarm, by the Worker's clock at `real_now`, or `None`.
///
/// - The head's next attempt, or now if it has none on record; and the same for the release in flight's marker
///   (`release_marker`), whichever is sooner.
/// - **The hour's end of every upload under way,** so an upload that outlives it is ended then, whoever asks. After a
///   failed bookkeeping run, not before its next try is due (`DRIVE_FIRST_WAIT_MS`), so a run that keeps failing doesn't
///   bring the alarm straight back.
/// - After passes in a row that failed, as `release_drive_failure` records them, not before `drive_wait_ms` of how many.
///   The count is the room's, not the object's, so a restart doesn't bring the alarm back sooner.
///
/// The times are kept by the release commands' clock (`release_now`), which a test sets; the alarm is set the same
/// distance from the Worker's own clock, so it is never in the past by one and the future by the other.
pub(super) fn next_due(sql: &SqlStorage, real_now: i64) -> R<Option<i64>> {
    if !enabled(sql, true) {
        return Ok(None);
    }
    due(sql, real_now)
}

/// [`next_due`], whether or not the driver runs from this room's alarm.
pub(super) fn due(sql: &SqlStorage, real_now: i64) -> R<Option<i64>> {
    let failures = drive_failures(sql)?;
    let now = release_now(sql);
    let mut due: Option<i64> = head(sql)?.map(|head| head.next_attempt_at.unwrap_or(now));
    // The release in flight's marker, beside the head's steps.
    if let Some(flight) = release_marker::flight(sql)? {
        let at = flight.next_attempt_at.unwrap_or(now);
        due = Some(due.map_or(at, |head| head.min(at)));
    }
    let started = rows(
        sql,
        "SELECT min(coalesce(upload_started_at, updated_at)) AS since FROM release WHERE state IN ('uploading', 'uncertain')",
        vec![],
    )?;
    if let Some(since) = started.first().and_then(|row| row["since"].as_i64()) {
        let failed = rows(
            sql,
            "SELECT last_failed_at FROM release_bookkeeping",
            vec![],
        )?
        .first()
        .map(|row| int(&row["last_failed_at"]).saturating_add(DRIVE_FIRST_WAIT_MS));
        let expiry = since
            .saturating_add(IN_FLIGHT_EXEMPTION_MS)
            .max(failed.unwrap_or(i64::MIN));
        due = Some(due.map_or(expiry, |at| at.min(expiry)));
    }
    let floor = if failures == 0 {
        10
    } else {
        drive_wait_ms(failures)
    };
    Ok(due.map(|at| real_now.saturating_add(at.saturating_sub(now).max(floor))))
}

/// What a lease came to.
enum Leased {
    /// The step is the driver's to run now, as this attempt.
    Step {
        release_id: String,
        step: DriveStep,
        attempt: u32,
    },
    /// Nothing to run: this answer says why.
    Nothing(Value),
}

/// The lease, in the room's transaction: see the module's note, step 4. `idle` is why the driver may do nothing now,
/// read before the transaction: the deployment doesn't allow release or the release path is closed ([`IDLE`]), or no
/// content provider is configured ([`NO_PROVIDER`]). `uncounted` is a wait read before the transaction that counts no
/// attempt, with when the release is next due: the read share's, for a queued release.
fn lease(
    sql: &SqlStorage,
    idle: Option<&'static str>,
    uncounted: Option<(&'static str, i64)>,
    now: i64,
) -> R<Leased> {
    end_stale(sql, now)?;
    let Some(head) = head(sql)? else {
        return Ok(Leased::Nothing(
            json!({ "release_id": null, "outcome": "none" }),
        ));
    };
    let answer = |outcome: &str, code: Option<&str>, next: Option<i64>| {
        Leased::Nothing(
            json!({ "release_id": head.id, "outcome": outcome, "code": code, "next_attempt_at": next }),
        )
    };
    if head.next_attempt_at.is_some_and(|at| at > now) {
        return Ok(answer("not_due", None, head.next_attempt_at));
    }
    if let Some(code) = idle {
        let next = now.saturating_add(DRIVE_IDLE_MS);
        set_job(sql, &head.id, Some(next), Some(code), now)?;
        return Ok(answer("idle", Some(code), Some(next)));
    }
    let Some(step) = drive_step(head.state, head.uploaded) else {
        return Ok(answer("none", None, None));
    };
    // Before the cap: another release's flight is waited for, counting no attempt (the driver's ruling 7). It ends by
    // its own marker's bounds, and its end wakes this release.
    let flight = rows(sql, "SELECT in_flight_release FROM release_config", vec![])?
        .first()
        .and_then(|row| text(&row["in_flight_release"]));
    if waits_in_flight(&head.id, flight.as_deref(), step) {
        let at = in_flight_due(now);
        set_job(sql, &head.id, Some(at), Some(IN_FLIGHT_WAITING), now)?;
        console_log!(
            "release: a commit waits for another release's flight: room={} release={} code={}",
            room_id(sql),
            head.id,
            IN_FLIGHT_WAITING
        );
        return Ok(answer("waiting", Some(IN_FLIGHT_WAITING), Some(at)));
    }
    // Before the cap: a wait that counts no attempt never ends a release, and takes no upload slot.
    if let Some((code, at)) =
        uncounted.filter(|(code, _)| step == DriveStep::Start && waits_uncounted(code))
    {
        set_job(sql, &head.id, Some(at), Some(code), now)?;
        console_log!(
            "release: a queued release waits: room={} release={} code={}",
            room_id(sql),
            head.id,
            code
        );
        return Ok(answer("waiting", Some(code), Some(at)));
    }
    // An `uncertain` release is settled by its own bounds: past them it ends here, and nothing is read.
    let kept = release_settle::uncertain_of(sql, &head.id)?;
    let settling = head.state == ReleaseState::Uncertain;
    if settling {
        let kept = kept
            .as_ref()
            .ok_or_else(|| ApiError::internal("an uncertain release with nothing kept of it"))?;
        if !may_settle(kept.settles, kept.since, now) {
            release_settle::unsettled(sql, &head.id, now)?;
            set_job(sql, &head.id, None, Some(UNSETTLED), now)?;
            return Ok(answer("gave_up", Some(UNSETTLED), None));
        }
    }
    // The cap counts every attempt but the reads that settled, or tried to settle, the release.
    let settles = kept.map_or(0, |kept| kept.settles);
    if !may_lease(counted_attempts(head.attempts, settles)) {
        fail(sql, &head.id, ATTEMPTS_EXHAUSTED, None, now)?;
        set_job(sql, &head.id, None, Some(ATTEMPTS_EXHAUSTED), now)?;
        return Ok(answer("gave_up", Some(ATTEMPTS_EXHAUSTED), None));
    }
    // A settling read reads nothing from GitHub, so it takes no upload slot; nor does settling the app's store's create
    // outstanding, which the upload step does first and alone (`release_store`).
    if step == DriveStep::Upload && !settling && !release_store::settles_first_for(sql, &head.id)? {
        exec(
            sql,
            "DELETE FROM release_upload_attempt WHERE at < ?",
            vec![window_start(now, READ_WINDOW_MS).into()],
        )?;
        let began: Vec<i64> = rows(sql, "SELECT at FROM release_upload_attempt", vec![])?
            .iter()
            .map(|row| int(&row["at"]))
            .collect();
        if let Err(at) = upload_slot(&began, now) {
            set_job(sql, &head.id, Some(at), Some(UPLOAD_ATTEMPTS), now)?;
            return Ok(answer("waiting", Some(UPLOAD_ATTEMPTS), Some(at)));
        }
        exec(
            sql,
            "INSERT INTO release_upload_attempt (release_id, at) VALUES (?, ?)",
            vec![head.id.as_str().into(), now.into()],
        )?;
    }
    let attempt = head.attempts.saturating_add(1);
    let (epoch, hold) = epoch_and_hold(sql)?;
    exec(
        sql,
        "INSERT INTO release_job (release_id, attempts, next_attempt_at, leased_step, leased_epoch, leased_hold, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (release_id) DO UPDATE SET attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at,
             leased_step = excluded.leased_step, leased_epoch = excluded.leased_epoch, leased_hold = excluded.leased_hold,
             updated_at = excluded.updated_at",
        vec![
            head.id.as_str().into(),
            i64::from(attempt).into(),
            now.saturating_add(DRIVE_LEASE_MS).into(),
            step.code().into(),
            epoch.into(),
            hold.into(),
            now.into(),
        ],
    )?;
    Ok(Leased::Step {
        release_id: head.id,
        step,
        attempt,
    })
}

/// The record of a step, in the room's transaction: see the module's note. `code` is why the step's command said the
/// release waits, or the code it refused with; `retry_at` a time it named, the read budget's.
#[allow(clippy::too_many_arguments)]
fn record(
    sql: &SqlStorage,
    release_id: &str,
    attempt: u32,
    before: DriveStep,
    was_uncertain: bool,
    code: Option<&str>,
    retry_at: Option<i64>,
    now: i64,
) -> R<Value> {
    end_stale(sql, now)?;
    let job = rows(
        sql,
        "SELECT attempts, stalls, leased_epoch, leased_hold FROM release_job WHERE release_id = ? AND leased_step IS NOT NULL",
        vec![release_id.into()],
    )?;
    let Some(job) = job.first() else {
        return Ok(json!({ "release_id": release_id, "outcome": "stale" }));
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
            return Ok(json!({ "release_id": release_id, "outcome": "stale" }));
        }
        // The room moved under the step: what it answered is about a room that no longer is. Looked at afresh.
        set_job(sql, release_id, Some(now), Some(MOVED), now)?;
        return Ok(json!({ "release_id": release_id, "outcome": "moved", "code": MOVED }));
    }
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let state = state_of(&release)?;
    let recorded = match release["script_name"].as_str() {
        Some(script) => uploaded(sql, release_id, script)?,
        None => false,
    };
    let after = drive_step(state, recorded);
    let stalled = u32::try_from(int(&job["stalls"]).max(0)).unwrap_or(u32::MAX);
    let kept = release_settle::uncertain_of(sql, release_id)?;
    let settles = kept.as_ref().map_or(0, |kept| kept.settles);
    // A release that was, or now is, `uncertain` is settled by its own bounds, and its reads aren't stalls.
    let now_uncertain = state == ReleaseState::Uncertain;
    let settling = match &kept {
        Some(kept) => settle_outcome(
            was_uncertain,
            now_uncertain,
            after,
            kept.settles,
            kept.since,
            now,
        ),
        None if now_uncertain => {
            return Err(ApiError::internal(
                "an uncertain release with nothing kept of it",
            ))
        }
        None => None,
    };
    // A wait that counts no attempt, answered by the step itself (another release's flight opened after the lease), is
    // never ended by the cap; anything else is the cap's and the backoff's.
    let uncounted = uncounted_outcome(before, after, code, retry_at, now);
    let counted = counted_attempts(attempts, settles);
    let (name, code, next) = match settling {
        Some(SettleDrive::Next) => ("next", None, Some(now)),
        Some(SettleDrive::Retry { at }) => {
            ("retry", Some(code.unwrap_or(SETTLE_UNKNOWN)), Some(at))
        }
        Some(SettleDrive::Unsettled) => {
            release_settle::unsettled(sql, release_id, now)?;
            ("gave_up", Some(UNSETTLED), None)
        }
        None => match uncounted
            .unwrap_or_else(|| drive_outcome(before, after, counted, stalled, retry_at, now))
        {
            DriveOutcome::Next => ("next", None, Some(now)),
            DriveOutcome::Done => ("done", None, None),
            DriveOutcome::Retry { at } => ("retry", Some(code.unwrap_or(NO_PROGRESS)), Some(at)),
            DriveOutcome::GiveUp => {
                fail(sql, release_id, ATTEMPTS_EXHAUSTED, None, now)?;
                ("gave_up", Some(ATTEMPTS_EXHAUSTED), None)
            }
        },
    };
    set_job(sql, release_id, next, code, now)?;
    let stalls = match settling {
        Some(SettleDrive::Next) => 0,
        Some(_) => stalled,
        None if uncounted.is_some() => stalled,
        None => stalls_after(before, after, stalled),
    };
    exec(
        sql,
        "UPDATE release_job SET stalls = ? WHERE release_id = ?",
        vec![i64::from(stalls).into(), release_id.into()],
    )?;
    console_log!(
        "release: a drive step: room={} release={} step={} outcome={} code={}",
        room_id(sql),
        release_id,
        before.code(),
        name,
        code.unwrap_or("none")
    );
    let after = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    Ok(
        json!({ "release_id": release_id, "outcome": name, "code": code, "next_attempt_at": next, "state": after["state"] }),
    )
}

/// How a pass runs its step.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Pass {
    /// The alarm's way: the step is handed to a request of the room's own, and the pass returns.
    HandOff,
    /// Test builds only: the step runs in the pass, which answers what came of it.
    #[cfg(feature = "failpoints")]
    Inline,
}

impl Workspace {
    /// One pass of the driver: see the module's note.
    pub(super) async fn release_drive_pass(&self, how: Pass) -> R<Value> {
        let sql = self.state.storage().sql();
        // The alarm doesn't migrate a room: a request does, and then arms.
        if !store::is_initialized(&sql)? || store::needs_migration(&sql)? {
            return Ok(json!({ "release_id": null, "outcome": "none" }));
        }
        let now = release_now(&sql);
        // Uploads past their hour, ended in a transaction of their own, whatever else this pass does.
        let expired = rows(
            &sql,
            "SELECT 1 AS expired FROM release WHERE state IN ('uploading', 'uncertain') AND coalesce(upload_started_at, updated_at) <= ?",
            vec![now.saturating_sub(IN_FLIGHT_EXEMPTION_MS).into()],
        )?;
        if !expired.is_empty() {
            bookkeeping(&self.state);
        }
        // The release in flight's marker goes first, when it is due: it is what ends the flight others wait on.
        let flight_due = release_marker::flight(&sql)?
            .is_some_and(|flight| flight.next_attempt_at.is_none_or(|at| at <= now));
        let head_due = head(&sql)?.filter(|head| head.next_attempt_at.is_none_or(|at| at <= now));
        if !flight_due && head_due.is_none() {
            return Ok(json!({ "outcome": "not_due" }));
        }
        // Behind `RELEASES`, exactly `true`, and the gate on the release path. With release allowed, a deployment with no
        // content provider idles too: every upload would wait for one, and none would be worth an attempt.
        let idle = if !(crate::releases::setting(&self.env).await.allows_release()
            && self.release_path_open().await.is_ok())
        {
            Some(IDLE)
        } else if self.upload_provider().is_none() {
            Some(NO_PROVIDER)
        } else {
            None
        };
        if flight_due {
            // The stop for the whole content domain, read from its home before the transaction: set, it ends the
            // flight with its own cause (`release_marker::lease`). An answer that can't be read decides nothing.
            let stopped = idle.is_none()
                && matches!(
                    crate::content_stop::read_from(&self.env).await,
                    crate::content_stop::Stop::Stopped
                );
            let leased: Rc<RefCell<Option<release_marker::Leased>>> = Rc::new(RefCell::new(None));
            let slot = leased.clone();
            let store = sql.clone();
            transaction_sync(&self.state, move || {
                *slot.borrow_mut() = Some(release_marker::lease(
                    &store,
                    idle,
                    stopped,
                    release_now(&store),
                )?);
                Ok(())
            })?;
            let leased = leased.borrow_mut().take();
            return match leased {
                Some(Ok((release_id, attempt))) => {
                    self.run_leased(how, &release_id, DriveStep::Marker, attempt)
                        .await
                }
                Some(Err(answer)) => Ok(answer),
                None => Ok(json!({ "outcome": "none" })),
            };
        }
        let Some(due) = head_due else {
            return Ok(json!({ "outcome": "not_due" }));
        };
        // The read share, only for a queued release the driver would otherwise start. A question that can't be answered
        // fails the pass, which writes nothing and is asked again after its backoff.
        let uncounted = if idle.is_none() && due.state == ReleaseState::Queued {
            self.read_share(&sql)
                .await?
                .map(|retry_at| (READ_SHARE_WAITING, read_share_due(retry_at, now)))
        } else {
            None
        };
        let leased: Rc<RefCell<Option<Leased>>> = Rc::new(RefCell::new(None));
        let slot = leased.clone();
        let store = sql.clone();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(lease(&store, idle, uncounted, release_now(&store))?);
            Ok(())
        })?;
        let leased = leased.borrow_mut().take();
        let Some(Leased::Step {
            release_id,
            step,
            attempt,
        }) = leased
        else {
            return Ok(match leased {
                Some(Leased::Nothing(answer)) => answer,
                _ => json!({ "outcome": "none" }),
            });
        };
        self.run_leased(how, &release_id, step, attempt).await
    }

    /// A step just leased: handed to a request of the room's own, or, in test builds, run in the pass.
    async fn run_leased(
        &self,
        how: Pass,
        release_id: &str,
        step: DriveStep,
        attempt: u32,
    ) -> R<Value> {
        match how {
            Pass::HandOff => {
                self.hand_off(release_id, attempt)?;
                Ok(
                    json!({ "release_id": release_id, "outcome": "handed_off", "step": step.code(), "attempt": attempt }),
                )
            }
            #[cfg(feature = "failpoints")]
            Pass::Inline => self.drive(release_id, attempt).await,
        }
    }

    /// The read share's question for this room's owner and one full attempt (`MAX_ATTEMPT_READS`): `None` when it would
    /// fit now, or the time the budget named. **Read only, and it authorizes nothing.** An answer that isn't exactly
    /// one of the two is no answer: an error, so nothing is written.
    async fn read_share(&self, sql: &SqlStorage) -> R<Option<i64>> {
        let owner = read_owner(sql)?;
        let mut response = crate::moderation::call(
            &self.env,
            crate::moderation::RELEASE_READS_SHARE_PATH,
            Method::Post,
            Some(json!({ "owner_key": owner, "reads": MAX_ATTEMPT_READS })),
        )
        .await?;
        if response.status_code() != 200 {
            return Err(ApiError::internal("the read share wasn't answered"));
        }
        let answer: Value = response.json().await?;
        match (answer["fits"].as_bool(), answer["retry_at"].as_i64()) {
            (Some(true), None) => Ok(None),
            (Some(false), Some(at)) => Ok(Some(at)),
            _ => Err(ApiError::internal(
                "the read share answered in another shape",
            )),
        }
    }

    /// Sends one step to the room itself, as a request the alarm doesn't wait for. If it never arrives, the lease runs
    /// out and a later pass takes the release up again.
    fn hand_off(&self, release_id: &str, attempt: u32) -> R<()> {
        let id = self.state.id().to_string();
        let stub = self
            .env
            .durable_object("WORKSPACE")?
            .id_from_string(&id)?
            .get_stub()?;
        let body = json!({ "release_id": release_id, "attempt": attempt }).to_string();
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_body(Some(JsValue::from_str(&body)));
        let request =
            Request::new_with_init(&format!("https://workspace{INTERNAL_RELEASE_DRIVE}"), &init)?;
        let release = release_id.to_owned();
        self.state.wait_until(async move {
            if stub.fetch_with_request(request).await.is_err() {
                console_error!(
                    "release: a drive step wasn't handed off: release={} code=hand_off_failed",
                    release
                );
            }
        });
        Ok(())
    }

    /// `{ release_id, attempt }`: one step of the driver, sent by the room's own alarm. Answers what came of it.
    pub(super) async fn release_drive_step(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Err(ApiError::not_found());
        }
        self.migrate_if_needed()?;
        let body: Value =
            serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
        let release_id = body["release_id"]
            .as_str()
            .filter(|id| is_release_id(id))
            .ok_or_else(ApiError::invalid_argument)?
            .to_owned();
        let attempt = body["attempt"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(ApiError::invalid_argument)?;
        self.drive(&release_id, attempt).await
    }

    /// The step leased as `attempt`, run and recorded.
    async fn drive(&self, release_id: &str, attempt: u32) -> R<Value> {
        let sql = self.state.storage().sql();
        let lease = StepLease {
            release_id: release_id.to_owned(),
            attempt,
        };
        let leased = rows(
            &sql,
            "SELECT attempts, leased_step FROM release_job WHERE release_id = ? AND leased_step IS NOT NULL",
            vec![release_id.into()],
        )?;
        let before = match leased.first() {
            // Its own lease, not run out: one that ran out is a later pass's to lease again.
            Some(job) if int(&job["attempts"]) == i64::from(attempt) && lease.holds(&sql) => {
                match job["leased_step"].as_str() {
                    Some("start") => DriveStep::Start,
                    Some("upload") => DriveStep::Upload,
                    Some("commit") => DriveStep::Commit,
                    Some("marker") => DriveStep::Marker,
                    _ => return Err(ApiError::internal("a lease with no step")),
                }
            }
            // Another lease, none, or its own run out: this step is someone else's now, or done.
            _ => return Ok(json!({ "release_id": release_id, "outcome": "stale" })),
        };
        // The marker's fetch is a step of its own, with a record of its own (`release_marker`).
        if before == DriveStep::Marker {
            return self.marker_step(release_id, attempt, &lease).await;
        }
        let release = release_row(&sql, release_id)?.ok_or_else(ApiError::not_found)?;
        let state = state_of(&release)?;
        let was_uncertain = state == ReleaseState::Uncertain;
        let recorded = match release["script_name"].as_str() {
            Some(script) => uploaded(&sql, release_id, script)?,
            None => false,
        };
        // The step the release is at now. If it isn't the one leased, nothing is asked and the record says so.
        let answer = match drive_step(state, recorded) {
            Some(step) if step == before => {
                let id = release_id.to_owned();
                // Each command asks the gate on the release path again, after the pass's awaits.
                match self.release_path_open().await {
                    Err(error) => Err(error),
                    // The gate's read took time: the lease is asked again before the command asks anything.
                    Ok(()) if !lease.holds(&sql) => lease_lost(&sql, &id),
                    Ok(()) => match step {
                        DriveStep::Start => self.start_upload_of(id, release, Some(&lease)).await,
                        DriveStep::Upload => self.upload_of(id, release, Some(&lease)).await,
                        DriveStep::Commit => self.commit_live_of(id, release, Some(&lease)).await,
                        DriveStep::Marker => {
                            Err(ApiError::internal("a marker step run as a command"))
                        }
                    },
                }
            }
            _ => Ok(Value::Null),
        };
        let (code, retry_at): (Option<String>, Option<i64>) = match &answer {
            Ok(value) => (
                value["waiting"].as_str().map(str::to_owned),
                value["retry_at"].as_i64(),
            ),
            Err(error) => (
                Some(error.code().unwrap_or("internal_error").to_owned()),
                None,
            ),
        };
        let id = release_id.to_owned();
        self.release_transaction(move |sql| {
            record(
                sql,
                &id,
                attempt,
                before,
                was_uncertain,
                code.as_deref(),
                retry_at,
                release_now(sql),
            )
        })
        .await
    }
}
