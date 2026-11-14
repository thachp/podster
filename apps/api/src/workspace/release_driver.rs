//! The release job's driver (M6 step 5, the third PR; ADR 0010's "The release job"): the room's alarm takes a release
//! through the room's own commands, one step at a time, start, upload and commit, and takes it up again after a crash
//! or an eviction. **Behind `RELEASES`, exactly `true`, and the gate on the release path.** What it decides is pure,
//! in `podster_core::release_driver`; here is only what it reads, writes and calls.
//!
//! **One release at a time,** the room's oldest that is queued or uploading, as ADR 0010 has the room run its release
//! jobs in the order it committed them. The rest wait behind it.
//!
//! **A pass of the alarm** ([`Workspace::release_drive_pass`]):
//!
//! 1. Uploads past their hour are ended, in a transaction of their own (`release_commit::bookkeeping`). The room's
//!    alarm is set for the hour's end of every upload under way ([`next_due`]), so nothing waits for someone to ask.
//! 2. Only if the release at the head is due: whether the deployment allows release, exactly `true`, and the gate on
//!    the release path is open. Neither, and the driver does nothing, counts no attempt and looks again after
//!    `DRIVE_IDLE_MS`.
//! 3. **The lease,** one room transaction ([`lease`]): everything is read again, the head included, since the pass
//!    awaited. The step comes from the release's state now. For an upload, the room's hourly upload attempts
//!    (`upload_slot`) must leave room for it, or the release waits for one. The attempt is counted, and the release is
//!    not due again until the lease runs out, `DRIVE_LEASE_MS` on: so a pass that finds the step still out does nothing,
//!    and a step that died with the object is taken up again then. A release with every attempt made ends here,
//!    `release_attempts_exhausted`.
//! 4. **The step is handed to a request of the room's own** (`/internal/release-drive`), kept alive by the alarm's
//!    `wait_until`, and the alarm returns. **So the alarm never waits on an upload,** and a takedown's applier, which the
//!    alarm runs, never waits behind a release job (ADR 0010).
//!
//! **A step** ([`Workspace::release_drive_step`]): the lease must still be its own. The step is the room's own command,
//! [`Workspace::start_upload_of`], [`Workspace::upload_of`] or [`Workspace::commit_live_of`], each of which reads the
//! outside facts afresh and rechecks everything, epoch included, in its own transactions, as when it is asked alone.
//! Then **the record,** one room transaction ([`record`]): the lease, the release epoch and the app's hold are each
//! compared with what they were at the lease; if any moved, nothing of the step is recorded and the release is looked
//! at afresh. Otherwise what came of it is core's, from the release's state now: the next step at once, done, a wait
//! that grows, or the end.
//!
//! Logs carry the room's and the release's IDs, the step and codes.
use super::release_commit::{bookkeeping, end_stale, fail, uploaded};
use super::release_recheck::{release_now, release_row, state_of};
use super::*;
use podster_core::release::{
    is_release_id, window_start, ReleaseState, IN_FLIGHT_EXEMPTION_MS, READ_WINDOW_MS,
};
use podster_core::release_driver::{
    drive_outcome, drive_step, drive_wait_ms, may_lease, step_still_current, upload_slot,
    DriveOutcome, DriveStep, ATTEMPTS_EXHAUSTED, DRIVE_FIRST_WAIT_MS, DRIVE_IDLE_MS,
    DRIVE_LEASE_MS,
};

/// The room's path for one step of the driver. Nothing outside the Worker reaches it: the room's alarm sends it to the
/// room itself.
pub(crate) const INTERNAL_RELEASE_DRIVE: &str = "/internal/release-drive";

/// `last_code` while the driver does nothing: the deployment doesn't allow release, or the release path is closed.
const IDLE: &str = "release_driver_idle";
/// `last_code` while an upload waits for the room's hourly upload attempts to leave room for it.
const UPLOAD_ATTEMPTS: &str = "release_upload_attempts";
/// `last_code` when the room moved under a step, and the release is looked at afresh.
const MOVED: &str = "release_driver_moved";
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

/// The release at the head of the room's line: its oldest that is queued or uploading.
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
           WHERE r.state IN ('queued', 'uploading') ORDER BY r.seq LIMIT 1",
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
fn epoch_and_hold(sql: &SqlStorage) -> R<(i64, i64)> {
    let epoch = rows(sql, "SELECT release_epoch FROM release_config", vec![])?
        .first()
        .map_or(0, |row| int(&row["release_epoch"]));
    Ok((epoch, releasers::hold_state(sql)?.1))
}

/// Writes the job's row for a release, made if it isn't there: when it is next due and why it waits. Any lease is
/// cleared.
fn set_job(
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

fn room_id(sql: &SqlStorage) -> String {
    rows(sql, "SELECT id FROM workspace", vec![])
        .ok()
        .and_then(|found| found.first().and_then(|row| text(&row["id"])))
        .unwrap_or_default()
}

/// When the driver next needs the room's alarm, by the Worker's clock at `real_now`, or `None`.
///
/// - The head's next attempt, or now if it has none on record.
/// - **The hour's end of every upload under way,** so an upload that outlives it is ended then, whoever asks. After a
///   failed bookkeeping run, not before its next try is due (`DRIVE_FIRST_WAIT_MS`), so a run that keeps failing doesn't
///   bring the alarm straight back.
/// - After `failures` passes in a row that failed, not before `drive_wait_ms(failures)`.
///
/// The times are kept by the release commands' clock (`release_now`), which a test sets; the alarm is set the same
/// distance from the Worker's own clock, so it is never in the past by one and the future by the other.
pub(super) fn next_due(sql: &SqlStorage, real_now: i64, failures: u32) -> R<Option<i64>> {
    if !enabled(sql, true) {
        return Ok(None);
    }
    due(sql, real_now, failures)
}

/// [`next_due`], whether or not the driver runs from this room's alarm.
pub(super) fn due(sql: &SqlStorage, real_now: i64, failures: u32) -> R<Option<i64>> {
    let now = release_now(sql);
    let mut due: Option<i64> = head(sql)?.map(|head| head.next_attempt_at.unwrap_or(now));
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

/// The lease, in the room's transaction: see the module's note, step 3. `allowed` is whether the deployment allows
/// release and the release path is open, read before the transaction.
fn lease(sql: &SqlStorage, allowed: bool, now: i64) -> R<Leased> {
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
    if !allowed {
        let next = now.saturating_add(DRIVE_IDLE_MS);
        set_job(sql, &head.id, Some(next), Some(IDLE), now)?;
        return Ok(answer("idle", Some(IDLE), Some(next)));
    }
    let Some(step) = drive_step(head.state, head.uploaded) else {
        return Ok(answer("none", None, None));
    };
    if !may_lease(head.attempts) {
        fail(sql, &head.id, ATTEMPTS_EXHAUSTED, None, now)?;
        set_job(sql, &head.id, None, Some(ATTEMPTS_EXHAUSTED), now)?;
        return Ok(answer("gave_up", Some(ATTEMPTS_EXHAUSTED), None));
    }
    if step == DriveStep::Upload {
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
fn record(
    sql: &SqlStorage,
    release_id: &str,
    attempt: u32,
    before: DriveStep,
    code: Option<&str>,
    retry_at: Option<i64>,
    now: i64,
) -> R<Value> {
    end_stale(sql, now)?;
    let job = rows(
        sql,
        "SELECT attempts, leased_epoch, leased_hold FROM release_job WHERE release_id = ? AND leased_step IS NOT NULL",
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
    let outcome = drive_outcome(before, drive_step(state, recorded), attempts, retry_at, now);
    let (name, code, next) = match outcome {
        DriveOutcome::Next => ("next", None, Some(now)),
        DriveOutcome::Done => ("done", None, None),
        DriveOutcome::Retry { at } => ("retry", Some(code.unwrap_or(NO_PROGRESS)), Some(at)),
        DriveOutcome::GiveUp => {
            fail(sql, release_id, ATTEMPTS_EXHAUSTED, None, now)?;
            ("gave_up", Some(ATTEMPTS_EXHAUSTED), None)
        }
    };
    set_job(sql, release_id, next, code, now)?;
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
        if !head(&sql)?.is_some_and(|head| head.next_attempt_at.is_none_or(|at| at <= now)) {
            return Ok(json!({ "outcome": "not_due" }));
        }
        // Behind `RELEASES`, exactly `true`, and the gate on the release path.
        let allowed = crate::releases::setting(&self.env).await.allows_release()
            && self.release_path_open().await.is_ok();
        let leased: Rc<RefCell<Option<Leased>>> = Rc::new(RefCell::new(None));
        let slot = leased.clone();
        let store = sql.clone();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(lease(&store, allowed, release_now(&store))?);
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
        match how {
            Pass::HandOff => {
                self.hand_off(&release_id, attempt)?;
                Ok(
                    json!({ "release_id": release_id, "outcome": "handed_off", "step": step.code(), "attempt": attempt }),
                )
            }
            #[cfg(feature = "failpoints")]
            Pass::Inline => self.drive(&release_id, attempt).await,
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
        let leased = rows(
            &sql,
            "SELECT attempts, leased_step FROM release_job WHERE release_id = ? AND leased_step IS NOT NULL",
            vec![release_id.into()],
        )?;
        let before = match leased.first() {
            Some(job) if int(&job["attempts"]) == i64::from(attempt) => {
                match job["leased_step"].as_str() {
                    Some("start") => DriveStep::Start,
                    Some("upload") => DriveStep::Upload,
                    Some("commit") => DriveStep::Commit,
                    _ => return Err(ApiError::internal("a lease with no step")),
                }
            }
            // Another lease, or none: this step is someone else's now, or done.
            _ => return Ok(json!({ "release_id": release_id, "outcome": "stale" })),
        };
        let release = release_row(&sql, release_id)?.ok_or_else(ApiError::not_found)?;
        let state = state_of(&release)?;
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
                    Ok(()) => match step {
                        DriveStep::Start => self.start_upload_of(id, release).await,
                        DriveStep::Upload => self.upload_of(id, release).await,
                        DriveStep::Commit => self.commit_live_of(id, release).await,
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
                code.as_deref(),
                retry_at,
                release_now(sql),
            )
        })
        .await
    }
}
