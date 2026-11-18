//! A custom hostname's marker (M6 step 8e; ADR 0010's "Custom domains", step 5, and "The release job", step 6): once
//! the room's applier has written a custom host's entry for a release its default host's marker confirmed, the room's
//! alarm fetches that release's marker through the custom host itself, and records the release served there only on
//! that host's own marker. **Behind `RELEASES`, exactly `true`, the gate on the release path and a content provider,**
//! as the release job's driver is. What it decides is pure, in `podster_core::custom_marker`; here is only what it reads,
//! writes and fetches. Each host's check is a row of `custom_marker` (room schema step 56).
//!
//! - **Until a custom host's own marker confirms, it serves only a release its default host's marker confirmed**
//!   (step 8c's rule, kept): the applier writes a custom host's entry only for a release recorded `served`, and this job
//!   fetches nothing for any other ([`plan`]: core's `custom_switched`).
//! - **The switch:** the host is open, the app isn't held, and the applier has recorded exactly the script it wants
//!   written at exactly its version, not refused there. When the room first sees a switch, it keeps the time: the
//!   marker's wait, ADR 0010's provisional 30 seconds, runs from it.
//! - **The fetch,** in the alarm after the applier, under a lease of its own: one `GET` of the marker's path on the
//!   custom host, as for the default host (`content_provider::fetch_marker`), and nothing while the content domain is
//!   stopped.
//! - **The record** ([`record`]), in the room's transaction: the lease must be its own, and the host still exactly what
//!   the fetch was for. **A host that moved meanwhile, closed when its claim ended among them, records nothing, seen or
//!   not** (spike D, item 12: the edge answered for a deleted custom hostname 282 ms after its delete). What stops a name
//!   serving after its claim ends is the room clearing its host, the applier confirming the entry gone before the claim
//!   is freed (8b's S1), and the content Worker refusing a host with no entry; never this marker, and never Cloudflare's
//!   deletion alone. Otherwise: **served** on its own marker; fetched again after the poll; or, at the wait's end,
//!   **set back:** that host alone goes to nothing, so its applier takes the entry down, and the release stays served
//!   on its default host.
//! - **Again:** a set-back host, if nothing moved since, is opened on the release last confirmed served after a wait
//!   that doubles from a minute to an hour (`reopen_wait_ms`), while routing's local checks hold and no rollback is in
//!   flight (the architect's ruling L1 on #448), and checked again.
//! - **What `served_at` means** (the architect's ruling I1 on #448, 2026-11-18): only that something answering at this
//!   name returned the public marker. It never authorizes anything, and is never shown as proof that the room serves
//!   the name.
//!
//! Logs carry the room's and the hostname request's IDs and codes. The host is never logged.
use super::release_recheck::release_now;
use super::*;
use podster_core::custom_marker::{
    custom_plan, custom_record, custom_reopen, custom_set_back, custom_switched, reopen_wait_ms,
    CustomHost, CustomPlan, CustomRecord, AWAITING_CUSTOM_MARKER, CUSTOM_MARKER_MISSING,
};
use podster_core::hostname_requests::CustomRoute;
use podster_core::release_driver::DRIVE_IDLE_MS;
use podster_core::release_marker::{marker_seen, MARKER_LEASE_MS};
use podster_core::release_rollback::marker_release;

/// `last_code` when a fetch's host moved while it was out, and nothing was kept.
const MOVED: &str = "custom_marker_moved";
/// `last_code` when a set-back host was opened again.
const REOPENED: &str = "custom_marker_reopened";
/// `last_code` when a set-back host's reopening waits: routing's local checks don't hold, or a rollback is in flight.
const REOPEN_WAITING: &str = "custom_marker_reopen_waiting";
/// `last_code` on a pending switch while the job may not run: on resuming, its wait starts again (ruling I2 on #448).
const IDLE: &str = "custom_marker_idle";

/// Test builds only: the job runs in a room a test gave `test_custom_marker`, which also stands for the gate on the
/// release path being open for it. Every other test's room is as it was before 8e. Always on in a deployment, where
/// the gate is the release path's own.
fn test_opened(sql: &SqlStorage) -> Option<bool> {
    #[cfg(feature = "failpoints")]
    {
        Some(
            rows(
                sql,
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_custom_marker'",
                vec![],
            )
            .is_ok_and(|found| !found.is_empty()),
        )
    }
    #[cfg(not(feature = "failpoints"))]
    {
        let _ = sql;
        None
    }
}

/// One fetch the plan leased: the host, the attempt, and the release and commit its marker must name.
pub(super) struct Leased {
    host: String,
    attempt: i64,
    release_id: String,
    commit: String,
}

/// Each of the room's custom hosts, with what its applier recorded and its marker's row.
fn hosts(sql: &SqlStorage, host: Option<&str>) -> R<Vec<Value>> {
    rows(
        sql,
        "SELECT s.host, s.closed, s.version, s.script_name, a.applied_version, a.applied_script, a.applied_at, a.refused_version,
           m.version AS m_version, m.script_name AS m_script, m.applied_at AS m_applied_at, m.switched_at, m.attempts,
           m.next_at, m.leased_until, m.served_at, m.set_back_at, m.set_backs, m.last_code
         FROM serve_state s LEFT JOIN serve_apply a ON a.host = s.host LEFT JOIN custom_marker m ON m.host = s.host
         WHERE s.kind = 'custom' AND s.host NOT IN (SELECT host FROM serve_retired) AND (? IS NULL OR s.host = ?)",
        vec![
            host.map_or(V::Null, V::from),
            host.map_or(V::Null, V::from),
        ],
    )
}

/// The commit of the release recorded `served` with this script, if one is: its marker came back through the default
/// host. A rollback's own record names the script it rolled back to, and the commit with it.
fn served_commit(sql: &SqlStorage, script: &str) -> R<Option<String>> {
    Ok(rows(
        sql,
        "SELECT commit_sha FROM release WHERE script_name = ? AND state = 'served' ORDER BY seq DESC LIMIT 1",
        vec![script.into()],
    )?
    .first()
    .and_then(|row| text(&row["commit_sha"])))
}

/// Core's view of one host's row.
fn custom_host<'a>(row: &'a Value, served_on_default: bool, held: bool) -> CustomHost<'a> {
    CustomHost {
        closed: int(&row["closed"]) == 1,
        version: int(&row["version"]),
        script: row["script_name"].as_str(),
        applied_version: row["applied_version"].as_i64(),
        applied_script: row["applied_script"].as_str(),
        refused_version: row["refused_version"].as_i64(),
        served_on_default,
        held,
    }
}

/// Whether the marker's row is for exactly the switch the host shows now: its version, its script, and the apply that
/// wrote it.
fn same_switch(row: &Value) -> bool {
    !row["m_version"].is_null()
        && row["m_version"].as_i64() == row["version"].as_i64()
        && row["m_script"].as_str() == row["script_name"].as_str()
        && row["m_applied_at"].as_i64() == row["applied_at"].as_i64()
}

/// The open hostname request for a host, for the logs: its ID, never the name.
fn request_of(sql: &SqlStorage, host: &str) -> String {
    rows(
        sql,
        "SELECT id FROM hostname_request WHERE hostname = ? AND open = 1",
        vec![host.into()],
    )
    .ok()
    .and_then(|found| found.first().and_then(|row| text(&row["id"])))
    .unwrap_or_else(|| "none".to_owned())
}

fn log(sql: &SqlStorage, host: &str, outcome: &str, code: Option<&str>) {
    console_log!(
        "release: a custom host's marker: room={} request={} outcome={} code={}",
        super::release_driver::room_id(sql),
        request_of(sql, host),
        outcome,
        code.unwrap_or("none")
    );
}

/// Sets the marker's row for a host, its lease and its wait, keeping the rest.
fn set_row(
    sql: &SqlStorage,
    host: &str,
    next_at: Option<i64>,
    code: Option<&str>,
    now: i64,
) -> R<()> {
    exec(
        sql,
        "UPDATE custom_marker SET leased_until = NULL, next_at = ?, last_code = ?, updated_at = ? WHERE host = ?",
        vec![
            next_at.map_or(V::Null, V::from),
            code.map_or(V::Null, V::from),
            now.into(),
            host.into(),
        ],
    )
}

/// The set-back of a custom host checked at `version` for `script`, in the caller's transaction: core's
/// `custom_set_back`, then the wait before it is opened again. A host that moved is left as it is.
fn set_back(
    sql: &SqlStorage,
    host: &str,
    version: i64,
    script: &str,
    set_backs: i64,
    now: i64,
) -> R<()> {
    let loaded = takedown::load(sql)?;
    let after = loaded.as_ref().and_then(|loaded| {
        let index = loaded.hosts.iter().position(|name| name == host)?;
        custom_set_back(&loaded.state, index, takedown::from_stored(version), script)
    });
    let (Some(loaded), Some(after)) = (loaded, after) else {
        set_row(sql, host, None, Some(MOVED), now)?;
        log(sql, host, "moved", Some(MOVED));
        return Ok(());
    };
    release_commit::write_state(sql, &loaded.hosts, &after, now)?;
    let count = set_backs.saturating_add(1).max(1);
    exec(
        sql,
        "UPDATE custom_marker SET set_back_at = ?, set_backs = ?, leased_until = NULL, next_at = ?, last_code = ?, updated_at = ?
           WHERE host = ?",
        vec![
            now.into(),
            count.into(),
            now.saturating_add(reopen_wait_ms(u32::try_from(count).unwrap_or(u32::MAX)))
                .into(),
            CUSTOM_MARKER_MISSING.into(),
            now.into(),
            host.into(),
        ],
    )?;
    log(sql, host, "set_back", Some(CUSTOM_MARKER_MISSING));
    Ok(())
}

/// A set-back host whose wait is over, in the caller's transaction: opened again through core's `custom_reopen` while
/// routing's local checks hold and nothing moved since; otherwise its wait starts again, or, if it moved, the set-back
/// is over.
fn reopen(sql: &SqlStorage, row: &Value, claims_open: bool, now: i64) -> R<()> {
    let host = row["host"].as_str().unwrap_or_default();
    let set_backs = u32::try_from(int(&row["set_backs"]).max(1)).unwrap_or(u32::MAX);
    let (route, _) = super::custom_hostname::route_local_for(sql, host, claims_open)?;
    let loaded = takedown::load(sql)?;
    // During a rollback's flight the release last confirmed is the one rolled away from: the reopening waits until the
    // flight settles (the architect's ruling L1 on #448, 2026-11-18).
    let rollback = match &loaded {
        Some(loaded) => release_rollback::flight_is_rollback(sql, &loaded.state)?,
        None => false,
    };
    if route != CustomRoute::Serve || rollback {
        set_row(
            sql,
            host,
            Some(now.saturating_add(reopen_wait_ms(set_backs))),
            Some(REOPEN_WAITING),
            now,
        )?;
        log(sql, host, "reopen_waiting", Some(REOPEN_WAITING));
        return Ok(());
    }
    let after = loaded.as_ref().and_then(|loaded| {
        let index = loaded.hosts.iter().position(|name| name == host)?;
        custom_reopen(
            &loaded.state,
            index,
            takedown::from_stored(int(&row["m_version"])),
            rollback,
        )
    });
    exec(
        sql,
        "UPDATE custom_marker SET set_back_at = NULL, next_at = NULL, leased_until = NULL, last_code = ?, updated_at = ? WHERE host = ?",
        vec![
            if after.is_some() { REOPENED } else { MOVED }.into(),
            now.into(),
            host.into(),
        ],
    )?;
    if let (Some(loaded), Some(after)) = (loaded, after) {
        release_commit::write_state(sql, &loaded.hosts, &after, now)?;
        log(sql, host, "reopened", Some(REOPENED));
    }
    Ok(())
}

/// Whether a set-back is still waiting on this host: recorded, and the host still where the set-back left it, open
/// and serving nothing at one version past what was checked.
fn set_back_holds(row: &Value) -> bool {
    !row["set_back_at"].is_null()
        && int(&row["closed"]) == 0
        && row["script_name"].is_null()
        && row["m_version"]
            .as_i64()
            .is_some_and(|checked| row["version"].as_i64() == checked.checked_add(1))
}

/// The plan, in the room's transaction: see the module's note. Answers the fetches leased.
pub(super) fn plan(sql: &SqlStorage, claims_open: bool, now: i64) -> R<Vec<Leased>> {
    let held = releasers::hold_state(sql)?.0;
    let mut leased = Vec::new();
    for row in hosts(sql, None)? {
        let Some(host) = text(&row["host"]) else {
            continue;
        };
        if set_back_holds(&row) {
            if row["next_at"].as_i64().is_none_or(|at| at <= now) {
                reopen(sql, &row, claims_open, now)?;
            }
            continue;
        }
        let script = text(&row["script_name"]);
        let commit = match &script {
            Some(script) => served_commit(sql, script)?,
            None => None,
        };
        let Some(script) =
            script.filter(|_| custom_switched(&custom_host(&row, commit.is_some(), held)))
        else {
            // Not switched: nothing is fetched or waited for, so no wait is left due for the alarm to come back to.
            if !row["next_at"].is_null() || !row["leased_until"].is_null() {
                set_row(sql, &host, None, row["last_code"].as_str(), now)?;
            }
            continue;
        };
        let (Some(commit), Some(release_id)) = (commit, marker_release(&script).map(str::to_owned))
        else {
            continue;
        };
        let (switched_at, attempts, set_backs) = if same_switch(&row) {
            let waiting = !row["served_at"].is_null()
                || row["leased_until"].as_i64().is_some_and(|at| at > now)
                || row["next_at"].as_i64().is_some_and(|at| at > now);
            if waiting {
                continue;
            }
            // Resumed from idle: the switch's wait starts again from now (ruling I2 on #448).
            let switched_at = if row["last_code"].as_str() == Some(IDLE) {
                exec(
                    sql,
                    "UPDATE custom_marker SET switched_at = ?, last_code = NULL, updated_at = ? WHERE host = ?",
                    vec![now.into(), now.into(), host.as_str().into()],
                )?;
                now
            } else {
                int(&row["switched_at"])
            };
            (switched_at, int(&row["attempts"]), int(&row["set_backs"]))
        } else {
            // A switch the room sees for the first time: the marker's wait runs from now. A set-back count in a row is
            // kept, so a host that keeps failing waits longer each time.
            exec(
                sql,
                "INSERT INTO custom_marker (host, version, script_name, applied_at, switched_at, attempts, next_at, leased_until,
                   served_at, set_back_at, set_backs, last_code, updated_at)
                 VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, 0, NULL, ?)
                 ON CONFLICT (host) DO UPDATE SET version = excluded.version, script_name = excluded.script_name,
                   applied_at = excluded.applied_at, switched_at = excluded.switched_at, attempts = 0, next_at = NULL,
                   leased_until = NULL, served_at = NULL, set_back_at = NULL, last_code = NULL, updated_at = excluded.updated_at",
                vec![
                    host.as_str().into(),
                    int(&row["version"]).into(),
                    script.as_str().into(),
                    row["applied_at"].as_i64().map_or(V::Null, V::from),
                    now.into(),
                    now.into(),
                ],
            )?;
            (now, 0, int(&row["set_backs"]))
        };
        match custom_plan(switched_at, now) {
            CustomPlan::SetBack { .. } => {
                set_back(sql, &host, int(&row["version"]), &script, set_backs, now)?;
            }
            CustomPlan::Fetch => {
                let attempt = attempts.saturating_add(1);
                let until = now.saturating_add(MARKER_LEASE_MS);
                exec(
                    sql,
                    "UPDATE custom_marker SET attempts = ?, leased_until = ?, next_at = ?, updated_at = ? WHERE host = ?",
                    vec![
                        attempt.into(),
                        until.into(),
                        until.into(),
                        now.into(),
                        host.as_str().into(),
                    ],
                )?;
                leased.push(Leased {
                    host,
                    attempt,
                    release_id,
                    commit,
                });
            }
        }
    }
    Ok(leased)
}

/// The record of one fetch, in the room's transaction: see the module's note. `seen` is whether that release's own
/// marker came back through the custom host.
pub(super) fn record(sql: &SqlStorage, host: &str, attempt: i64, seen: bool, now: i64) -> R<()> {
    let Some(row) = hosts(sql, Some(host))?.into_iter().next() else {
        return Ok(());
    };
    // Another lease, or none: this fetch is someone else's now, or done.
    if row["attempts"].as_i64() != Some(attempt) || row["leased_until"].is_null() {
        return Ok(());
    }
    let held = releasers::hold_state(sql)?.0;
    let served = match row["script_name"].as_str() {
        Some(script) => served_commit(sql, script)?.is_some(),
        None => false,
    };
    let still = same_switch(&row) && custom_switched(&custom_host(&row, served, held));
    match custom_record(still, seen, int(&row["switched_at"]), now) {
        CustomRecord::Served => {
            exec(
                sql,
                "UPDATE custom_marker SET served_at = ?, set_backs = 0, leased_until = NULL, next_at = NULL, last_code = NULL,
                   updated_at = ? WHERE host = ?",
                vec![now.into(), now.into(), host.into()],
            )?;
            log(sql, host, "served", None);
        }
        CustomRecord::Retry { at } => {
            set_row(sql, host, Some(at), Some(AWAITING_CUSTOM_MARKER), now)?
        }
        CustomRecord::SetBack { .. } => {
            let script = text(&row["script_name"]).unwrap_or_default();
            set_back(
                sql,
                host,
                int(&row["version"]),
                &script,
                int(&row["set_backs"]),
                now,
            )?;
        }
        CustomRecord::Moved => {
            set_row(sql, host, None, Some(MOVED), now)?;
            log(sql, host, "moved", Some(MOVED));
        }
    }
    Ok(())
}

/// When the job is next due, by the Worker's clock: the soonest fetch or reopening a row waits for. The times are kept
/// by the release commands' clock (`release_now`), which a test sets; the alarm is set the same distance from the
/// Worker's own.
pub(super) fn next_due(sql: &SqlStorage, real_now: i64) -> R<Option<i64>> {
    if test_opened(sql) == Some(false) {
        return Ok(None);
    }
    let now = release_now(sql);
    Ok(rows(
        sql,
        "SELECT min(m.next_at) AS due FROM custom_marker m JOIN serve_state s ON s.host = m.host
           WHERE s.kind = 'custom' AND s.closed = 0 AND m.next_at IS NOT NULL",
        vec![],
    )?
    .first()
    .and_then(|row| row["due"].as_i64())
    .map(|at| real_now.saturating_add(at.saturating_sub(now).max(DUE_FLOOR_MS))))
}

/// The soonest the alarm comes back for this job, so a pass that keeps failing never brings it straight back.
const DUE_FLOOR_MS: i64 = 1_000;

/// While the job may not run (release off for the deployment, no content provider, the gate closed), every wait due
/// now is put off by the driver's idle wait, so the alarm doesn't keep coming back for it. A switch still waiting for
/// its marker is marked idle, so on resuming its wait starts again and it is fetched before any set-back: a host is
/// never set back on a wait that ran out while nothing could fetch (the architect's ruling I2 on #448, 2026-11-18).
fn idle(sql: &SqlStorage, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE custom_marker SET last_code = ? WHERE next_at IS NOT NULL AND next_at <= ? AND served_at IS NULL AND set_back_at IS NULL",
        vec![IDLE.into(), now.into()],
    )?;
    exec(
        sql,
        "UPDATE custom_marker SET next_at = ?, leased_until = NULL, updated_at = ? WHERE next_at IS NOT NULL AND next_at <= ?",
        vec![
            now.saturating_add(DRIVE_IDLE_MS).into(),
            now.into(),
            now.into(),
        ],
    )
}

impl Workspace {
    /// One pass of the custom hosts' markers, from the alarm after the applier: see the module's note.
    pub(super) async fn custom_marker_upkeep(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? || store::needs_migration(&sql)? {
            return Ok(());
        }
        let opened = test_opened(&sql);
        if opened == Some(false) {
            return Ok(());
        }
        // Nothing to look at: no custom host, so nothing is read from outside the room either.
        if rows(
            &sql,
            "SELECT 1 AS c FROM serve_state WHERE kind = 'custom' AND closed = 0 LIMIT 1",
            vec![],
        )?
        .is_empty()
        {
            return Ok(());
        }
        // Behind `RELEASES`, exactly `true`, a content provider, and the gate on the release path.
        if !crate::releases::setting(&self.env).await.allows_release()
            || takedown::provider(&self.env, &sql).is_none()
            || (opened != Some(true) && self.release_path_open().await.is_err())
        {
            let store = sql.clone();
            return transaction_sync(&self.state, move || idle(&store, release_now(&store)));
        }
        let claims_open = super::hostname::claims_open(&sql);
        let slot: Rc<RefCell<Vec<Leased>>> = Rc::new(RefCell::new(Vec::new()));
        let (out, store) = (slot.clone(), sql.clone());
        transaction_sync(&self.state, move || {
            *out.borrow_mut() = plan(&store, claims_open, release_now(&store))?;
            Ok(())
        })?;
        let leased = slot.take();
        for fetch in leased {
            // Nothing is fetched while the content domain is stopped: nothing is served then.
            let stopped = matches!(
                crate::content_stop::read_from(&self.env).await,
                crate::content_stop::Stop::Stopped
            );
            let seen = !stopped && {
                let answer = crate::content_provider::fetch_marker(&fetch.host).await;
                marker_seen(
                    answer
                        .as_ref()
                        .map(|(status, body)| (*status, body.as_slice())),
                    &fetch.release_id,
                    &fetch.commit,
                )
            };
            let store = sql.clone();
            transaction_sync(&self.state, move || {
                record(
                    &store,
                    &fetch.host,
                    fetch.attempt,
                    seen,
                    release_now(&store),
                )
            })?;
        }
        Ok(())
    }
}
