//! Taking a room's app down (M6 step 4(a), ADR 0010's "Takedown" and "Publishing and unpublishing, in order").
//!
//! Three things, all the room's own:
//!
//! - **An operator's suspension of the app, and its lifting.** One room transaction records it on the app's label,
//!   and, through `podster_core::release::unpublish`, raises the release epoch, sets every host's desired serve state
//!   to nothing, forgets the kept script and ends any commit in flight. A release that started before it can never be
//!   committed live after it. Lifting restores nothing: it only clears the suspension, and the app serves again when
//!   a new release is asked for and approved.
//! - **The applier,** the only thing that writes or removes a serve entry. For each host it reads the desired state
//!   and its version, writes or deletes the entry, reads it back, and asks the room for the version again; if it
//!   moved, it starts over. It runs from the room's alarm and never behind a job. **A wait after a failure belongs to
//!   the version that failed:** when a host's version moves, as a takedown moves it, the wait is void and the host is
//!   due at once. A default host's entry is written only for a script under that host's own label.
//! - **One pass is bounded.** The alarm runs this before everything else it does, so a provider that is slow must
//!   not hold the room's deliveries: no new step starts once [`PASS_BUDGET_MS`] is spent, and what is left is due
//!   again at once, after the rest of the alarm has had its turn.
//! - **The script-delete job.** A script is deleted only once no host's entry can still name it, and counts as gone
//!   only on one of the provider's two answers that mean gone (`podster_core::release::script_gone`). Anything else
//!   is retried, with a wait that grows.
//!
//! **With no provider configured, which is every deployment, the applier and the job do nothing, and say so:** the
//! work stays recorded as owed, in `serve_apply` and `script_delete`, and one log line counts it.
//!
//! What this step leaves out, on purpose:
//! - Only `app_suspended` unpublishes here. Decision 218's release switch unpublishes through [`unpublish_app`] from
//!   `release_switch`. The other nine triggers are step 6's.
//! - **A custom hostname's entry** (step 8c) is written only while routing holds, the hostname's own object asked
//!   last, just before the write ([`custom_write`]); what was read and fails takes the entry down. It is written in
//!   the custom form, naming its host (`podster_core::hostnames::custom_entry_value`).
//! - **A custom hostname suspended while this room holds it** ([`hostname_suspended`]): the hostname's own object
//!   tells the room, and the room clears and closes that host through `podster_core::release::clear_host`, in its own
//!   transaction. The epoch doesn't move and the default host is untouched. The applier then removes the entry.
//! - **Before it writes a default host's entry the applier asks the `Moderation` object whether the whole content
//!   domain is stopped** (`content_stop`). Stopped, or no answer, and nothing is written. A removal never asks.
//! - A release that was still waiting, queued or uploading ends right after the unpublish, in a transaction of its
//!   own (`release_commit::bookkeeping`, step 5): the epoch has moved, so it could never go live. If that fails, the
//!   unpublish has still committed. *Before step 5 it was left for the job's next pass.*
//!
//! Logs carry the room's ID, counts and codes. Never a host, a label or a script's name.
use super::*;
use crate::content_provider::{Entry, Provider};
use crate::content_stop::{self, Stop};
use podster_core::app_requests::HostKind;
use podster_core::hostname_requests::{CustomRoute, HostnameRequestState};
use podster_core::release::{
    clear_host, next_state, reconcile_script, script_gone, script_owner, unpublish, upload_expired,
    CommitMark, DesiredServe, InFlight, ReleaseEvent, ReleaseState, RoomClaim, ScriptAnswer,
    ScriptOwner, ScriptReconcile, ServeState, UnpublishTrigger, IN_FLIGHT_EXEMPTION_MS,
};
use podster_core::serve_entry::{entry_is, kind_named};

/// The Worker's call, for a verified operator. Nothing outside the Worker reaches it.
pub(crate) const INTERNAL_APP_SUSPENSION: &str = "/internal/app-suspension";

/// The hostname's claim object's call: the name was suspended while this room held it. Nothing outside the Worker
/// reaches it.
pub(crate) const INTERNAL_HOSTNAME_NOTICE: &str = "/internal/hostname-notice";

/// The reconcile's call (third PR): one question about one entry or one script, or only a wake. Nothing outside the
/// Worker reaches it.
pub(crate) const INTERNAL_TAKEDOWN_CHECK: &str = "/internal/takedown-check";

/// The finding for a room whose release bookkeeping keeps failing, told from the room's own record of it.
const BOOKKEEPING_FAILING: &str = "release_bookkeeping_failing";
/// Hosts the applier refused that one answer carries. A room has two hosts at most.
const HOST_FINDINGS: i64 = 7;
// One answer never holds more than the reconcile takes from it, whatever the room holds: the bookkeeping's one, the
// hosts, the failing script deletes, the failing store deletions and the queued ones. So no finding is dropped for want
// of room in an answer.
const _: () = assert!(
    1 + HOST_FINDINGS + FINDINGS + STORE_FINDINGS + QUEUED_FINDINGS
        <= crate::reconcile::ROOM_FINDINGS_TAKEN as i64
);
/// Store deletions that keep failing that one answer carries: a room has one store for each label it ever had, a
/// handful at most, and the deletion job takes as many in one alarm.
const STORE_FINDINGS: i64 = 4;
/// A script's delete is told to operators once it has failed this many times: with the waits, over half an hour.
const DELETE_REPORT_AFTER: i64 = 12;
/// Findings of one kind one answer carries. A room has two hosts at most and a handful of scripts.
const FINDINGS: i64 = 8;
/// Deletions a reconcile started that one answer carries, the newest first.
const QUEUED_FINDINGS: i64 = 32;
/// How long the room goes on telling of a deletion a reconcile started: as long as the operators' record keeps a
/// finding nothing has seen again.
const QUEUED_TOLD_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// The refusals that mean a host isn't this room's to touch at all. The room can do nothing about such an entry.
const NOT_THIS_ROOMS: [&str; 3] = [
    "host_not_a_default_host",
    "host_not_this_rooms",
    "custom_host_on_content_domain",
];

/// The highest epoch or version the room stores. SQLite holds 64-bit integers, but they cross to Rust as JavaScript
/// numbers, which are exact only to 2^53 - 1. Core's own ceiling is `u64::MAX`, the state it never moves from. So
/// this value and anything above it is read as core's ceiling, and written as this: a room that ever got here fails
/// closed, as core means it to, about 9 * 10^15 unpublishes early.
const STORED_MAX: i64 = 9_007_199_254_740_991;

pub(super) fn from_stored(value: i64) -> u64 {
    if value >= STORED_MAX {
        u64::MAX
    } else {
        value.max(0) as u64
    }
}

pub(super) fn to_stored(value: u64) -> i64 {
    i64::try_from(value).map_or(STORED_MAX, |v| v.min(STORED_MAX))
}

/// How many times the applier starts over on one host in one pass, when its version keeps moving.
const APPLY_PASSES: usize = 3;
/// Hosts and scripts handled in one alarm. A room has two hosts at most and three scripts.
const BATCH: usize = 8;
const FIRST_WAIT_MS: i64 = 5_000;
/// How long one alarm's pass may go on starting new steps. A step is at most two provider calls of 5 seconds each, so
/// a pass ends within about 20 seconds whatever the provider does.
const PASS_BUDGET_MS: i64 = 10_000;
const LONGEST_WAIT_MS: i64 = 5 * 60 * 1000;

/// The wait before attempt `attempts + 1`: 5 seconds, doubling, to 5 minutes at most. It never gives up.
fn wait_ms(attempts: i64) -> i64 {
    let doublings = attempts.clamp(0, 6) as u32;
    FIRST_WAIT_MS
        .saturating_mul(1_i64 << doublings)
        .min(LONGEST_WAIT_MS)
}

/// The room's serve state as core reads it, rebuilt from the room's rows, with each host's name beside it.
pub(super) struct Loaded {
    pub(super) state: ServeState,
    /// The hosts' names, in the state's order: the default host first.
    pub(super) hosts: Vec<String>,
}

/// Reads the room's serve state. `None` if release was never configured in this room: there is no epoch to raise and
/// nothing to serve. The mark of a commit in flight is rebuilt from the rows that hold it, never taken from a caller.
pub(super) fn load(sql: &SqlStorage) -> R<Option<Loaded>> {
    let config = rows(
        sql,
        "SELECT release_epoch, kept_previous, in_flight_release, in_flight_script, in_flight_epoch FROM release_config",
        vec![],
    )?;
    let Some(config) = config.first() else {
        return Ok(None);
    };
    let found = rows(
        sql,
        "SELECT host, script_name, version, closed, flight_version, flight_before FROM serve_state
           WHERE host NOT IN (SELECT host FROM serve_retired) ORDER BY (kind = 'default') DESC, host",
        vec![],
    )?;
    let mut hosts = Vec::with_capacity(found.len());
    let mut desired = Vec::with_capacity(found.len());
    let mut versions = Vec::with_capacity(found.len());
    let mut before = Vec::with_capacity(found.len());
    for row in &found {
        hosts.push(text(&row["host"]).ok_or_else(|| ApiError::internal("serve state host"))?);
        desired.push(DesiredServe {
            script: text(&row["script_name"]),
            version: from_stored(int(&row["version"])),
            closed: int(&row["closed"]) == 1,
        });
        versions.push(
            (!row["flight_version"].is_null()).then(|| from_stored(int(&row["flight_version"]))),
        );
        before.push(text(&row["flight_before"]));
    }
    let in_flight = match (
        text(&config["in_flight_release"]),
        text(&config["in_flight_script"]),
    ) {
        (Some(release_id), Some(script)) => Some(InFlight {
            release_id,
            script,
            mark: CommitMark {
                epoch: from_stored(int(&config["in_flight_epoch"])),
                versions,
                before,
            },
        }),
        _ => None,
    };
    Ok(Some(Loaded {
        state: ServeState {
            epoch: from_stored(int(&config["release_epoch"])),
            hosts: desired,
            kept_previous: text(&config["kept_previous"]),
            in_flight,
        },
        hosts,
    }))
}

/// Whether a label is one of this room's production labels, current or retired.
fn own_label(sql: &SqlStorage, label: &str) -> R<bool> {
    // Production's labels only (M8 step 6): everything here is about production's hosts and scripts, and a preview
    // label's host or script is never one of them.
    Ok(!rows(
        sql,
        "SELECT label FROM app_label WHERE label = ? AND kind = 'production'",
        vec![label.into()],
    )?
    .is_empty())
}

/// Whether an operator's suspension holds on the room's app: on any label it ever had.
pub(super) fn app_suspended(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT label FROM app_label WHERE suspended_at IS NOT NULL LIMIT 1",
        vec![],
    )?
    .is_empty())
}

/// One of ADR 0010's unpublish triggers fired for the whole room, inside the caller's transaction (M6 step 6): the
/// app is unpublished ([`unpublish_app`]), and if there was a configuration to unpublish, audited as `app.unpublished`
/// by Podster with `{ reason, ..details }` and told to the room's managers as the event `app.unpublished` with the
/// trigger's code as its reason. **The unpublish is Podster's act,** whoever's command fired it: that command's own
/// audit row records who acted. A room with no release configuration has nothing to unpublish and records nothing
/// here. Answers whether it unpublished.
///
/// Every trigger about the whole room goes through here, decision 218's release switch included, so the record of an
/// unpublish is the same whatever fired it. After the transaction commits, the room's `fetch` runs the release
/// bookkeeping, since the epoch moved, and arms, as it does after every request that isn't a read.
pub(super) fn unpublish_for(
    sql: &SqlStorage,
    trigger: UnpublishTrigger,
    details: Value,
    now: i64,
) -> R<bool> {
    // The room's preview goes with every such trigger but the room made private (M8 step 6; the preview plan's 3.3), in
    // this same transaction, whether or not there is anything of production's to unpublish.
    super::preview::on_unpublish(sql, trigger, now)?;
    if !unpublish_app(sql, trigger, None, now)? {
        return Ok(false);
    }
    // Every trigger here is for good, so the label goes with the app ([`retire_current_label`]).
    retire_current_label(sql, now)?;
    // Test builds only: a test adds details of its own, a `reason` among them, to show the trigger's reason wins.
    #[cfg(feature = "failpoints")]
    let details = test_details(sql, details)?;
    // The trigger's own reason goes in last, so no caller's details can ever stand in for it.
    let mut record = match details {
        Value::Object(details) => details,
        _ => serde_json::Map::new(),
    };
    record.insert("reason".into(), Value::from(trigger.code()));
    let record = Value::Object(record);
    audit_as(
        sql,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        "app.unpublished",
        "app",
        None,
        Some(record.to_string()),
        now,
    )?;
    record_event(
        sql,
        "app.unpublished",
        moderation::PODSTER,
        None,
        &Transition {
            reason: Some(trigger.code()),
            ..Transition::NONE
        },
        roles::room_managers(sql, moderation::PODSTER)?,
        now,
    )?;
    // Test builds only: the command fails right after its unpublish, to show the unpublish goes with it, never alone.
    #[cfg(feature = "failpoints")]
    if !rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_fail_after_unpublish'",
        vec![],
    )?
    .is_empty()
    {
        return Err(ApiError::internal("test: the command failed after its unpublish"));
    }
    Ok(true)
}

/// Test builds only: `details` with whatever `test_unpublish_details` holds merged over it.
#[cfg(feature = "failpoints")]
fn test_details(sql: &SqlStorage, details: Value) -> R<Value> {
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_unpublish_details'",
        vec![],
    )?
    .is_empty()
    {
        return Ok(details);
    }
    let mut merged = match details {
        Value::Object(details) => details,
        _ => serde_json::Map::new(),
    };
    for row in rows(sql, "SELECT details FROM test_unpublish_details", vec![])? {
        if let Some(Value::Object(extra)) = row["details"]
            .as_str()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
        {
            merged.extend(extra);
        }
    }
    Ok(Value::Object(merged))
}

/// The room's release epoch now, or `None` with no release configuration (or none readable yet).
pub(super) fn release_epoch(sql: &SqlStorage) -> Option<i64> {
    rows(sql, "SELECT release_epoch FROM release_config", vec![])
        .ok()
        .and_then(|found| found.first().map(|config| int(&config["release_epoch"])))
}

/// Unpublishes the room's app, inside the caller's transaction: core's `unpublish` on the room's own state, written
/// back whole. The epoch goes up, every host goes to nothing with its version up, the kept script and any commit in
/// flight are forgotten, the trigger is recorded with the epoch it raised to, each release that was live or served
/// becomes unpublished, and every script core names is queued for deletion. It never refuses: a room with no release
/// configuration has nothing to unpublish, and that is all it does there. Answers whether there was a configuration to
/// unpublish. `label` is the app's label the trigger is about, or none for a trigger about the whole room, such as
/// decision 218's release switch.
///
/// **Ending the releases that hadn't gone live is not done here.** It is release bookkeeping, and a takedown never
/// fails or waits because of it: the caller runs `release_commit::bookkeeping` after this transaction has committed.
pub(super) fn unpublish_app(
    sql: &SqlStorage,
    trigger: UnpublishTrigger,
    label: Option<&str>,
    now: i64,
) -> R<bool> {
    let Some(loaded) = load(sql)? else {
        return Ok(false);
    };
    // A hold on the app ends with it (step 6): nothing is left to serve again, and its window can't unpublish twice.
    super::releasers::end_after_unpublish(sql)?;
    let (after, delete) = unpublish(&loaded.state);
    let epoch = to_stored(after.epoch);
    exec(
        sql,
        "UPDATE release_config SET release_epoch = ?, kept_previous = NULL, in_flight_release = NULL, in_flight_script = NULL,
           in_flight_epoch = NULL, in_flight_at = NULL, updated_at = ?",
        vec![epoch.into(), now.into()],
    )?;
    for (host, desired) in loaded.hosts.iter().zip(&after.hosts) {
        if desired.script.is_some() {
            return Err(ApiError::internal("an unpublish left a host serving"));
        }
        exec(
            sql,
            "UPDATE serve_state SET label = NULL, label_current = NULL, release_id = NULL, script_name = NULL, version = ?,
               flight_version = NULL, flight_before = NULL, updated_at = ? WHERE host = ?",
            vec![
                to_stored(desired.version).into(),
                now.into(),
                host.as_str().into(),
            ],
        )?;
    }
    // One row for each epoch. At the ceiling the epoch can't go up again, and the row that names it is already there.
    exec(
        sql,
        "INSERT INTO unpublish (cause, label, release_epoch, at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM unpublish WHERE release_epoch = ?)",
        vec![
            trigger.code().into(),
            label.into(),
            epoch.into(),
            now.into(),
            epoch.into(),
        ],
    )?;
    for release in rows(
        sql,
        &format!(
            "SELECT id, state FROM release WHERE state IN ('live', 'served') AND {}",
            super::preview::NOT_PREVIEW
        ),
        vec![],
    )? {
        let from = release["state"]
            .as_str()
            .and_then(|name| ReleaseState::ALL.into_iter().find(|s| s.name() == name));
        let (Some(id), Some(from)) = (text(&release["id"]), from) else {
            continue;
        };
        if let Ok(to) = next_state(from, ReleaseEvent::Unpublish) {
            exec(
                sql,
                "UPDATE release SET state = ?, finished_at = ?, updated_at = ? WHERE id = ?",
                vec![to.name().into(), now.into(), now.into(), id.into()],
            )?;
        }
    }
    for script in delete {
        // Only a name Rust made, under a label this room has. Anything else in the room's own state would be a
        // fault, and is never handed to the provider.
        let owned = match script_owner(&script) {
            ScriptOwner::Podster { label, .. } if own_label(sql, label)? => Some(label.to_owned()),
            _ => None,
        };
        let Some(owner) = owned else {
            console_error!(
                "takedown: a script outside the room's labels wasn't queued: code=foreign_script"
            );
            continue;
        };
        exec(
            sql,
            "INSERT INTO script_delete (script_name, label, unpublish_epoch, queued_at, next_attempt_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (script_name) DO NOTHING",
            vec![
                script.into(),
                owner.into(),
                epoch.into(),
                now.into(),
                now.into(),
            ],
        )?;
    }
    Ok(true)
}

/// **Every unpublish for good retires the room's current label** (the architect's ruling of 2026-11-23, on the security
/// review of PR #564; ADR 0010, "Unpublishing", and its rule that a label is never used again). Every trigger that goes
/// through [`unpublish_for`] is one: whatever undoes its cause restores nothing. In the unpublish's own transaction the
/// label stops being current (`retired_at` now), and its store, if it has one, is owed its deletion as `label_retired`,
/// audited and told as Podster's act (S4 of the store plan). So the room's next request draws a new label and host, an
/// old shared link never meets a later release, and the store and its data go. The retired label stays in the room's
/// table, so it is never drawn again. A room with no current label retires nothing.
///
/// **What retires nothing:**
/// - **an operator's suspension of the app** ([`set`], `app_suspended`), which keeps the label and its store, so a false
///   suspension can be lifted with the app's data intact (the architect's ruling of 2026-11-16, on review of rule 3(b));
///   an operator deletes the data by its own command;
/// - **a reversible hold:** nobody left to release, while its window is open; a repository's unpublish held at the
///   deployment's ceiling. Neither unpublishes; the unpublish that may follow retires the label;
/// - **the stop for the whole content domain,** which unpublishes nothing.
///
/// **A permanent cause with nothing up still retires the label** (the review of PR #567, 2026-11-23): an app an
/// operator suspended, or one whose only release failed before it went live, has nothing to unpublish but still has a
/// current label. The deployment's switch read as `false` and a repository's link off ready (once the ceiling grants
/// it) call this directly then, with no unpublish recorded.
pub(super) fn retire_current_label(sql: &SqlStorage, now: i64) -> R<()> {
    for row in rows(sql, "SELECT label FROM app_label WHERE current = 1", vec![])? {
        let Some(label) = text(&row["label"]) else {
            continue;
        };
        exec(
            sql,
            "UPDATE app_label SET current = NULL, retired_at = ? WHERE label = ? AND current = 1",
            vec![now.into(), label.as_str().into()],
        )?;
        super::store_delete::owed(
            sql,
            &label,
            podster_core::app_store::DeleteCause::LabelRetired,
            moderation::PODSTER,
            moderation::PODSTER_KIND,
            now,
        )?;
    }
    if !rows(
        sql,
        "SELECT 1 AS current FROM app_label WHERE current = 1",
        vec![],
    )?
    .is_empty()
    {
        return Err(ApiError::internal("an unpublish left a label current"));
    }
    Ok(())
}

/// `{ label, suspended, reason }`: an operator suspends the room's app, or lifts that. The room acts only if the
/// label is one of its own, so a lookup table that named the wrong room can't suspend it. Suspending unpublishes, in
/// this same transaction. Doing what's already so changes nothing. Audited as Podster, as the room's own suspension
/// is. Answers `{ label, suspended, reason, at }`.
pub(super) fn set(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let suspended = body["suspended"]
        .as_bool()
        .ok_or_else(ApiError::invalid_argument)?;
    let reason = body["reason"]
        .as_str()
        .and_then(podster_policy::moderation::Reason::from_name)
        .ok_or_else(ApiError::invalid_argument)?;
    let label = body["label"]
        .as_str()
        .filter(|label| podster_core::release::is_label(label))
        .ok_or_else(ApiError::invalid_argument)?;
    let read = |sql: &SqlStorage| -> R<Option<Value>> {
        Ok(rows(
            sql,
            "SELECT suspended_at, suspension_reason FROM app_label WHERE label = ?",
            vec![label.into()],
        )?
        .into_iter()
        .next())
    };
    let Some(prior) = read(sql)? else {
        return Err(ApiError::not_found());
    };
    let was = !prior["suspended_at"].is_null();
    if was != suspended {
        if suspended {
            exec(
                sql,
                "UPDATE app_label SET suspended_at = ?, suspension_reason = ? WHERE label = ?",
                vec![now.into(), reason.name().into(), label.into()],
            )?;
            unpublish_app(sql, UnpublishTrigger::AppSuspended, Some(label), now)?;
            // An app suspended, on any of its labels, deletes its preview too (M8 step 6; the preview plan's 3.3).
            super::preview::on_unpublish(sql, UnpublishTrigger::AppSuspended, now)?;
        } else {
            exec(
                sql,
                "UPDATE app_label SET suspended_at = NULL, suspension_reason = NULL WHERE label = ?",
                vec![label.into()],
            )?;
        }
        let kind = if suspended {
            "app.suspended"
        } else {
            "app.suspension_lifted"
        };
        audit_as(
            sql,
            moderation::PODSTER,
            moderation::PODSTER_KIND,
            kind,
            "app",
            Some(json!({ "suspended": was }).to_string()),
            Some(json!({ "suspended": suspended, "reason": reason.name() }).to_string()),
            now,
        )?;
        record_event(
            sql,
            kind,
            moderation::PODSTER,
            None,
            &Transition::NONE,
            roles::room_managers(sql, moderation::PODSTER)?,
            now,
        )?;
    }
    let after = read(sql)?.unwrap_or(Value::Null);
    Ok(json!({
        "label": label,
        "suspended": !after["suspended_at"].is_null(),
        "reason": after["suspension_reason"],
        "at": after["suspended_at"],
    }))
}

/// Clears and closes a custom hostname's host, in the caller's transaction, through core's `clear_host`: the room stops
/// serving on the name, and its applier then removes the entry. Its default host, its epoch and its scripts are
/// untouched. Answers whether there was an open host to close. A suspension's notice and the room's own removal of its
/// custom hostname (M6 step 8) both end serving this way.
pub(super) fn close_custom_host(sql: &SqlStorage, hostname: &str, now: i64) -> R<bool> {
    let open_custom = !rows(
        sql,
        "SELECT 1 AS open FROM serve_state WHERE host = ? AND kind = 'custom' AND closed = 0",
        vec![hostname.into()],
    )?
    .is_empty();
    if !open_custom {
        return Ok(false);
    }
    let loaded = load(sql)?.ok_or_else(|| ApiError::internal("a host with no release state"))?;
    let index = loaded
        .hosts
        .iter()
        .position(|host| host == hostname)
        .ok_or_else(|| ApiError::internal("a host that isn't in the serve state"))?;
    // Core never clears the first host, which is the default one. A room whose only host is a custom hostname has no
    // default host to keep, which no command makes: refused, and the caller's transaction rolls back.
    let after = clear_host(&loaded.state, index)
        .ok_or_else(|| ApiError::internal("the host can't be cleared"))?;
    let cleared = after
        .hosts
        .get(index)
        .filter(|host| host.script.is_none() && host.closed)
        .ok_or_else(|| ApiError::internal("the host wasn't cleared"))?;
    exec(
        sql,
        "UPDATE serve_state SET label = NULL, label_current = NULL, release_id = NULL, script_name = NULL, version = ?,
           closed = 1, updated_at = ? WHERE host = ?",
        vec![to_stored(cleared.version).into(), now.into(), hostname.into()],
    )?;
    Ok(true)
}

/// `{ hostname, request_id, generation }`: the hostname's own object says the name was suspended while this room's
/// request held it. In the caller's transaction the room clears and closes that host, so its applier removes the entry
/// and no commit, rollback or set-back writes to it again, and marks its request as ending.
///
/// **Which request a notice is for is decided by its ID, which is unique.**
/// - A request the room doesn't have for that hostname, or one that has ended: a late notice. The room may since
///   hold the name again under a new request, whose host a late notice must never close. It changes nothing and
///   still answers, so the object stops asking.
/// - The room's own open request, under the generation the notice carries: it acts. Telling it twice changes nothing
///   more.
/// - The room's own open request, under another generation: **refused, never acknowledged.** The object keeps the
///   notice and sends it again, and the room logs it by its IDs. A fault here must be loud: acknowledging it would
///   leave a suspended name served with nothing owed.
///
/// The claim itself ends as any claim does, in the step that builds claims. Audited as Podster. Answers
/// `{ known, acted }`.
pub(super) fn hostname_suspended(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let (Some(hostname), Some(request), Some(generation)) = (
        body["hostname"].as_str(),
        body["request_id"].as_str(),
        body["generation"].as_i64(),
    ) else {
        return Err(ApiError::invalid_argument());
    };
    let found = rows(
        sql,
        "SELECT state, generation FROM hostname_request WHERE id = ? AND hostname = ?",
        vec![request.into(), hostname.into()],
    )?;
    let Some(row) = found.first() else {
        return Ok(json!({ "known": false, "acted": false }));
    };
    let state = row["state"].as_str().and_then(HostnameRequestState::parse);
    let Some(state) = state.filter(|state| state.is_open()) else {
        // Late: the request has ended. Nothing of the room's is its to close.
        return Ok(json!({ "known": true, "acted": false }));
    };
    if int(&row["generation"]) != generation {
        // The request is the room's own and still open, so this notice is about a host it may be serving, and the
        // generations disagree: a fault, in whatever gave the claim or in the room's own record. It is never
        // acknowledged and dropped. The room refuses, so the object keeps the notice and sends it again, and says so.
        let room = rows(sql, "SELECT id FROM workspace", vec![])?
            .first()
            .and_then(|row| text(&row["id"]))
            .unwrap_or_default();
        console_error!(
            "takedown: a hostname notice was refused: room={} request={} code=hostname_generation_mismatch",
            room,
            request
        );
        return Err(ApiError::internal(
            "hostname notice under another generation",
        ));
    }
    let mut acted = false;
    if state != HostnameRequestState::Ending {
        exec(
            sql,
            "UPDATE hostname_request SET state = ?, end_reason = 'hostname_suspended', updated_at = ? WHERE id = ?",
            vec![
                HostnameRequestState::Ending.name().into(),
                now.into(),
                request.into(),
            ],
        )?;
        acted = true;
    }
    if close_custom_host(sql, hostname, now)? {
        acted = true;
    }
    if acted {
        audit_as(
            sql,
            moderation::PODSTER,
            moderation::PODSTER_KIND,
            "app_hostname.suspended",
            "app_hostname",
            None,
            Some(json!({ "suspended": true }).to_string()),
            now,
        )?;
        record_event(
            sql,
            "app_hostname.suspended",
            moderation::PODSTER,
            None,
            &Transition::NONE,
            roles::room_managers(sql, moderation::PODSTER)?,
            now,
        )?;
    }
    Ok(json!({ "known": true, "acted": acted }))
}

/// What the room has to tell operators, read from its own rows: each host the applier refused at the version it has
/// now, and each script whose delete keeps failing. The reconcile carries these to the operators' record.
///
/// **A deletion a reconcile started is told from the room's own row, every time the room is asked, for 7 days.** A
/// delete can't be taken back, so its record must not depend on one answer arriving: if an answer is lost, or the
/// operators' record couldn't keep it then, the next question to this room carries it again, whether or not the
/// script is still there to be listed.
///
/// **The delete may run before its finding lands, and that is safe.** The row that says a reconcile started the
/// deletion commits in the same transaction that queues it, before any call to the provider. The room's delete job
/// may then run at once, ahead of the pass writing the finding down. Nothing is lost by that: the row stays, gone or
/// not, and is what the room tells from, again and again, for 7 days.
///
/// Which rows are a reconcile's: one queued under no unpublish, or one queued later than its unpublish's own
/// time, which is a script the room had counted gone and a pass found. **Not a release's own script queued when the
/// release failed** (step 5): that row is queued at the very time its release ended, and is the room's own act,
/// already on record as the release's failure. If a pass later finds that script again, the row's time moves, and
/// it is told like any other. An unpublish queues its scripts at its own
/// time, in its own transaction, so the two times are equal for a row the unpublish queued.
///
/// **One exception, at the epoch's ceiling.** There the epoch can't go up, so a further unpublish adds no row of its
/// own and its scripts are queued under the last one, later than that row's time. Those read here as a pass's and
/// are told to operators as such. That errs toward telling, never toward silence, and a room reaches the ceiling
/// only after about 9 * 10^15 unpublishes.
///
/// **Owed:** only the 32 newest are told in one answer. And a room is told from only while something asks it: one
/// that leaves the lookup table, or that nothing asks for 7 days, never tells again.
fn findings(sql: &SqlStorage, now: i64) -> R<Vec<Value>> {
    // First, so it is never the one left out: the room's release bookkeeping, once it has failed enough times in a
    // row, from the room's own record. By the app's label, which is how an operator names the app, and the last
    // code. No room's ID and no error's text. A room with no app has no label, and nothing to keep.
    let mut found: Vec<Value> = rows(
        sql,
        "SELECT (SELECT label FROM app_label WHERE kind = 'production' ORDER BY (current IS NOT NULL) DESC, created_at DESC LIMIT 1) AS subject, last_code AS detail
           FROM release_bookkeeping WHERE failures >= ?",
        vec![release_commit::BOOKKEEPING_TOLD.into()],
    )?
    .iter()
    .filter(|row| row["subject"].is_string())
    .map(|row| json!({ "code": BOOKKEEPING_FAILING, "subject": row["subject"], "detail": row["detail"] }))
    .collect();
    found.extend(
        rows(
            sql,
            "SELECT s.host AS subject, a.last_code AS detail FROM serve_state s JOIN serve_apply a ON a.host = s.host
               WHERE a.refused_version = s.version ORDER BY s.host LIMIT ?",
            vec![HOST_FINDINGS.into()],
        )?
        .iter()
        .map(|row| json!({ "code": "host_refused", "subject": row["subject"], "detail": row["detail"] })),
    );
    found.extend(
        rows(
            sql,
            "SELECT script_name AS subject, last_code AS detail FROM script_delete WHERE gone_at IS NULL AND attempts >= ?
               ORDER BY script_name LIMIT ?",
            vec![DELETE_REPORT_AFTER.into(), FINDINGS.into()],
        )?
        .iter()
        .map(|row| json!({ "code": "script_delete_failing", "subject": row["subject"], "detail": row["detail"] })),
    );
    // A store deletion whose tries have decided nothing `DELETE_TOLD_AFTER` times in a row (S4's question 7), by the
    // store's name, as the store reconcile's findings are. `detail` says whether it is held because something can
    // still reach the store, or tried and not yet read gone. The job goes on trying either way.
    for row in rows(
        sql,
        "SELECT label, store_name, delete_attempts FROM app_store
           WHERE delete_owed_at IS NOT NULL AND gone_at IS NULL AND delete_attempts >= ?
           ORDER BY store_name LIMIT ?",
        vec![
            podster_core::app_store::DELETE_TOLD_AFTER.into(),
            STORE_FINDINGS.into(),
        ],
    )? {
        let (Some(label), Some(name)) = (text(&row["label"]), text(&row["store_name"])) else {
            continue;
        };
        if !podster_core::app_store::delete_told(int(&row["delete_attempts"])) {
            continue;
        }
        let detail = if store_delete::store_unreachable(sql, &label)? {
            "unconfirmed"
        } else {
            "held"
        };
        found.push(json!({
            "code": podster_core::app_store::STORE_DELETE_FAILING,
            "subject": name,
            "detail": detail,
        }));
    }
    found.extend(
        rows(
            sql,
            "SELECT script_name AS subject, CASE WHEN gone_at IS NULL THEN 'queued' ELSE 'gone' END AS detail FROM script_delete
               WHERE (unpublish_epoch IS NULL OR queued_at > (SELECT u.at FROM unpublish u WHERE u.release_epoch = script_delete.unpublish_epoch))
                 AND NOT EXISTS (SELECT 1 FROM release r WHERE r.script_name = script_delete.script_name AND r.state = 'failed' AND r.finished_at = script_delete.queued_at)
                 AND queued_at >= ? ORDER BY queued_at DESC, script_name LIMIT ?",
            vec![(now - QUEUED_TOLD_MS).into(), QUEUED_FINDINGS.into()],
        )?
        .iter()
        .map(|row| json!({ "code": "script_delete_queued", "subject": row["subject"], "detail": row["detail"] })),
    );
    Ok(found)
}

/// Whether the hostname's object, as the reconcile read it (`{ request_id, live }`), holds this room's open request for
/// `host`, claimed, live. Anything else, an answer of another shape among it, is no.
fn claim_live_for(sql: &SqlStorage, host: &str, claim: &Value) -> R<bool> {
    let (Some(request), Some(true)) = (claim["request_id"].as_str(), claim["live"].as_bool())
    else {
        return Ok(false);
    };
    Ok(!rows(
        sql,
        "SELECT 1 AS held FROM hostname_request WHERE id = ? AND hostname = ? AND open = 1 AND state = 'claimed'",
        vec![request.into(), host.into()],
    )?
    .is_empty())
}

/// Whether the applier has confirmed `host` has no entry at the version the room wants now (the review of PR #404, S1):
/// the host wants nothing and was applied at exactly its version with nothing written. A host the room never had a row
/// for was never written by it. Before a custom hostname's claim is freed, so no other room can be served the entry.
pub(super) fn entry_confirmed_absent(sql: &SqlStorage, host: &str) -> R<bool> {
    let found = rows(
        sql,
        "SELECT s.script_name, s.version, a.applied_version, a.applied_script FROM serve_state s
           LEFT JOIN serve_apply a ON a.host = s.host WHERE s.host = ?",
        vec![host.into()],
    )?;
    let Some(row) = found.first() else {
        return Ok(true);
    };
    Ok(row["script_name"].is_null()
        && !row["applied_version"].is_null()
        && int(&row["applied_version"]) == int(&row["version"])
        && row["applied_script"].is_null())
}

/// The 5-minute reconcile found an entry for `host` naming `found`, or one it couldn't read (`None`). `(known,
/// changed)`: whether the host is this room's to answer for, and whether the room now owes it a new pass.
///
/// **The reconcile never writes or removes an entry.** Where what is there differs from what the room wants, the room
/// forgets that it applied the host, so its own applier, still the only writer, does it again.
///
/// **A custom hostname's entry stands only while both agree** (step 8c; ADR 0010's "Two scheduled reconciles"): the
/// room's desired state, and `claim`, what the hostname's own object answered the pass, `{ request_id, live }`. Unless
/// the object holds the room's own claimed request for that name, live, the room forgets it applied the host, and its
/// applier, which asks the object again before any write, takes the entry down.
fn check_entry(
    sql: &SqlStorage,
    host: &str,
    found: Option<(HostKind, &str)>,
    claim: &Value,
    now: i64,
) -> R<(bool, bool)> {
    let row = rows(
        sql,
        "SELECT s.kind, s.script_name, s.version, a.applied_version, a.refused_version, a.last_code FROM serve_state s
           LEFT JOIN serve_apply a ON a.host = s.host WHERE s.host = ?",
        vec![host.into()],
    )?;
    let Some(row) = row.first() else {
        return Ok((false, false));
    };
    let version = int(&row["version"]);
    let at = |value: &Value| !value.is_null() && int(value) == version;
    let (is_applied, is_refused) = (at(&row["applied_version"]), at(&row["refused_version"]));
    if is_refused
        && row["last_code"]
            .as_str()
            .is_some_and(|code| NOT_THIS_ROOMS.contains(&code))
    {
        // The room has a row for it and may not touch it. To the reconcile that is an entry with no room.
        return Ok((false, false));
    }
    let custom = row["kind"].as_str() != Some("default");
    if !is_applied && !is_refused {
        // Already owed: the applier will make it right. A custom host whose object's claim isn't live is due at once
        // (the review of PR #404, S2): its applier asks the object before anything that only waits, and takes the
        // entry down.
        if custom && !claim_live_for(sql, host, claim)? {
            exec(
                sql,
                "UPDATE serve_apply SET next_attempt_at = 0, updated_at = ? WHERE host = ? AND next_attempt_at IS NOT NULL",
                vec![now.into(), host.into()],
            )?;
            return Ok((true, true));
        }
        return Ok((true, false));
    }
    // The entry is there, since the pass listed it. It matches only when the room wants a script for this host and
    // the entry was read as exactly that script, **of exactly the kind the room recorded for it** (S3 of the store
    // plan): a static entry for a script with code, or a marked one for a static script, differs as another script
    // does, and the applier writes it again. A host that wants nothing never matches an entry that exists, and a value
    // that couldn't be read, isn't a script's name Rust made, or whose kind wasn't said, never equals anything.
    let wanted = match row["script_name"].as_str() {
        Some(script) => Some((release_commit::script_kind(sql, script)?, script.to_owned())),
        None => None,
    };
    let matches = entry_is(
        wanted
            .as_ref()
            .map(|(kind, script)| (*kind, script.as_str())),
        found,
    );
    let matches = matches && (!custom || claim_live_for(sql, host, claim)?);
    if is_applied && matches {
        return Ok((true, false));
    }
    exec(
        sql,
        "UPDATE serve_apply SET applied_version = NULL, applied_script = NULL, applied_at = NULL, refused_version = NULL, attempts = 0,
           attempt_version = NULL, next_attempt_at = NULL, last_code = 'reconcile_differs', updated_at = ? WHERE host = ?",
        vec![now.into(), host.into()],
    )?;
    Ok((true, true))
}

/// The hourly reconcile found `script` in the namespace. `(known, changed)`: whether its label is this room's, and
/// whether the room queued it for deletion just now. `podster_core::release::reconcile_script` decides, from what the
/// room's own state says of it: named by a host, the kept script or a commit in flight, it is kept; uploading, or
/// `uncertain` and being settled, within its upload's hour, it is kept; anything else no row claims is deleted, by the
/// room's own delete job. An `uncertain` release's script is kept while settling may still find it written
/// (`release_settle`); once the release ends, its own failure queues the script.
fn check_script(
    sql: &SqlStorage,
    script: &str,
    listed_at: Option<i64>,
    now: i64,
) -> R<(bool, bool)> {
    let ScriptOwner::Podster { label, release_id } = script_owner(script) else {
        return Ok((false, false));
    };
    // Only a production label's script is this question's: a preview label's is never in production's namespace, and
    // is never queued from it (M8 step 6).
    if super::preview::label_kind(sql, label)?
        != Some(podster_core::preview::Environment::Production)
    {
        return Ok((false, false));
    }
    let named = !rows(
        sql,
        "SELECT 1 AS named FROM serve_state WHERE script_name = ?1 OR flight_before = ?1
           UNION ALL SELECT 1 FROM release_config WHERE kept_previous = ?1 OR in_flight_script = ?1",
        vec![script.into()],
    )?
    .is_empty();
    let claim = if named {
        RoomClaim::Claims
    } else {
        rows(
            sql,
            "SELECT coalesce(upload_started_at, updated_at) AS since FROM release WHERE id = ? AND state IN (?, ?)",
            vec![
                release_id.into(),
                ReleaseState::Uploading.name().into(),
                ReleaseState::Uncertain.name().into(),
            ],
        )?
        .first()
        .map_or(RoomClaim::Disowns, |row| RoomClaim::Uploading {
            since: int(&row["since"]),
        })
    };
    // Whether an upload has outlived its hour is asked of the same clock that ends the release for it
    // (`release_commit::expire_uploads`), so the script is deleted exactly when its release would be ended.
    if reconcile_script(script, claim, release_recheck::release_now(sql)) != ScriptReconcile::Delete
    {
        return Ok((true, false));
    }
    let queued = !rows(
        sql,
        "SELECT 1 AS queued FROM script_delete WHERE script_name = ? AND gone_at IS NULL",
        vec![script.into()],
    )?
    .is_empty();
    if queued {
        return Ok((true, false));
    }
    // Counted gone since the pass read its list: the list is older than the deletion, and nothing is owed. The room's
    // own delete job can run between the pass's list and its question, as when the question before this one ended a
    // release and woke the room (M6 step 6's review). Only one counted gone before the list was read is there after
    // all.
    if let Some(listed_at) = listed_at {
        let gone_since = !rows(
            sql,
            "SELECT 1 AS gone FROM script_delete WHERE script_name = ? AND gone_at IS NOT NULL AND gone_at >= ?",
            vec![script.into(), listed_at.into()],
        )?
        .is_empty();
        if gone_since {
            return Ok((true, false));
        }
    }
    // Queued under no unpublish: nothing in the room's state named it. One the room had counted as gone is there
    // after all, so it is owed again. It keeps the unpublish it was queued under, and that unpublish is no longer
    // done with its files: "scripts gone" is taken back until this one is gone again, when the delete job sets it.
    // Its `queued_at` moves to now, which is how the room knows to tell of it as a pass's deletion.
    //
    // **A release's own script goes under the unpublish that owes it,** when one does: an unpublish that came after
    // the release began (`release_commit::owing_unpublish`). An upload that outlived its hour while the room's
    // bookkeeping was failing is found here before the room has ended its release, and it must still count against
    // that unpublish's files.
    let under = release_commit::owing_unpublish(sql, script)?;
    exec(
        sql,
        "INSERT INTO script_delete (script_name, label, unpublish_epoch, queued_at, next_attempt_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (script_name) DO UPDATE SET gone_at = NULL, next_attempt_at = excluded.next_attempt_at, last_code = 'reconcile_found',
             queued_at = excluded.queued_at",
        vec![
            script.into(),
            label.into(),
            under.map_or(V::Null, V::from),
            now.into(),
            now.into(),
        ],
    )?;
    exec(
        sql,
        "UPDATE unpublish SET scripts_gone_at = NULL WHERE release_epoch = (SELECT unpublish_epoch FROM script_delete WHERE script_name = ?)",
        vec![script.into()],
    )?;
    Ok((true, true))
}

/// `{ kind: "wake" }`, `{ kind: "entry", host, found }` or `{ kind: "script", script }`: the reconcile's one question,
/// inside the caller's transaction. Answers `{ known, changed, findings }`. The caller arms the room's alarm after it,
/// whatever was asked, which is also what corrects a wake that was lost.
pub(super) fn check(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let (known, changed) = match body["kind"].as_str() {
        Some("wake") => (true, false),
        // A preview host's entry, as written (M8 step 6): the preview applier's record is asked, never production's.
        Some("entry") if body["preview"] == true => super::preview_apply::check_entry(
            sql,
            body["host"]
                .as_str()
                .ok_or_else(ApiError::invalid_argument)?,
            body["found_value"].as_str(),
            now,
        )?,
        // A script listed in the preview namespace (M8 step 6).
        Some("script") if body["namespace"] == "preview" => super::preview_apply::check_script(
            sql,
            body["script"]
                .as_str()
                .ok_or_else(ApiError::invalid_argument)?,
            body["listed_at"].as_i64(),
            now,
        )?,
        Some("entry") => check_entry(
            sql,
            body["host"]
                .as_str()
                .ok_or_else(ApiError::invalid_argument)?,
            body["found"]
                .as_str()
                .zip(body["found_kind"].as_str().and_then(kind_named))
                .map(|(script, kind)| (kind, script)),
            &body["claim"],
            now,
        )?,
        Some("script") => check_script(
            sql,
            body["script"]
                .as_str()
                .ok_or_else(ApiError::invalid_argument)?,
            body["listed_at"].as_i64(),
            now,
        )?,
        _ => return Err(ApiError::invalid_argument()),
    };
    // After the change, so a deletion queued just now is in this same answer.
    Ok(json!({ "known": known, "changed": changed, "findings": findings(sql, now)? }))
}

/// The provider this room may use, or `None`. Test builds also read a table a test makes in one room,
/// `test_content_provider_off`, so the unconfigured case can be shown beside the configured one.
pub(super) fn provider(env: &Env, sql: &SqlStorage) -> Option<Provider> {
    #[cfg(feature = "failpoints")]
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_content_provider_off'",
        vec![],
    )
    .is_ok_and(|found| !found.is_empty())
    {
        return None;
    }
    let _ = sql;
    Provider::from_env(env)
}

/// Hosts whose serve entry isn't known to match what the room wants: never applied, or applied at another version.
/// A host refused at the version it has now isn't one of them: there is nothing more the applier will do for it until
/// the room moves its version, so it neither wakes the room nor holds the room's script deletes back.
const PENDING_HOSTS: &str = "FROM serve_state s LEFT JOIN serve_apply a ON a.host = s.host WHERE (a.applied_version IS NULL OR a.applied_version != s.version) AND (a.refused_version IS NULL OR a.refused_version != s.version)";
/// Scripts whose delete nothing in the room's own state forbids: no host, kept script or flight names them. **Only a
/// production label's:** a preview label's script is in the preview namespace, and only `preview_apply`'s job, through
/// the preview provider, ever deletes it (M8 step 6).
const UNNAMED: &str = "d.label IN (SELECT label FROM app_label WHERE kind = 'production')
    AND NOT EXISTS (SELECT 1 FROM serve_state n WHERE n.script_name = d.script_name OR n.flight_before = d.script_name)
    AND NOT EXISTS (SELECT 1 FROM release_config c WHERE c.kept_previous = d.script_name OR c.in_flight_script = d.script_name)";
/// When a pending host is next due. A wait counts only for the version whose attempt failed: once the room has moved
/// the host's version, whoever moved it and why, the host is due at once. So no writer has to remember to clear a
/// wait, and a takedown never sits behind one left by an earlier failure.
const HOST_DUE: &str =
    "CASE WHEN a.attempt_version = s.version THEN coalesce(a.next_attempt_at, 0) ELSE 0 END";

/// When the applier or the delete job next has something to do, or `None`: nothing is owed, or no provider is
/// configured, in which case the work waits without waking the room.
pub(super) fn next_due(sql: &SqlStorage, env: &Env, now: i64) -> R<Option<i64>> {
    if provider(env, sql).is_none() {
        return Ok(None);
    }
    let hosts = rows(
        sql,
        &format!("SELECT min({HOST_DUE}) AS due, count(*) AS n {PENDING_HOSTS}"),
        vec![],
    )?;
    let pending = hosts.first().filter(|row| int(&row["n"]) > 0);
    if let Some(pending) = pending {
        // While any host is pending no script may be deleted, so the scripts ask for no wake of their own: the room
        // sleeps until the earliest host is due, by that host's own backoff, and the scripts go in the pass that
        // applies the last host.
        return Ok(Some(int(&pending["due"]).max(now + 10)));
    }
    let scripts = rows(
        sql,
        &format!("SELECT min(d.next_attempt_at) AS due, count(*) AS n FROM script_delete d WHERE d.gone_at IS NULL AND {UNNAMED}"),
        vec![],
    )?;
    Ok(scripts
        .first()
        .filter(|row| int(&row["n"]) > 0)
        .map(|row| int(&row["due"]).max(now + 10)))
}

struct Wanted {
    script: Option<String>,
    /// The script's kind, from the room's record of it, written before the script was (`release_commit::script_kind`).
    /// Static when the room wants no script.
    kind: HostKind,
    version: i64,
    custom: bool,
    /// Whether the room's app is held, and the hold's generation (step 6). A pass is stale if either the version or
    /// the generation moved while the provider was asked, since a hold and a lift leave the host's version alone.
    held: bool,
    hold_generation: i64,
}

fn wanted(sql: &SqlStorage, host: &str) -> R<Option<Wanted>> {
    let (held, hold_generation) = super::releasers::hold_state(sql)?;
    let Some(row) = rows(
        sql,
        "SELECT script_name, version, kind FROM serve_state WHERE host = ?",
        vec![host.into()],
    )?
    .into_iter()
    .next() else {
        return Ok(None);
    };
    let script = text(&row["script_name"]);
    let kind = match &script {
        Some(script) => release_commit::script_kind(sql, script)?,
        None => HostKind::Static,
    };
    Ok(Some(Wanted {
        script,
        kind,
        version: int(&row["version"]),
        custom: row["kind"].as_str() != Some("default"),
        held,
        hold_generation,
    }))
}

fn applied(sql: &SqlStorage, host: &str, want: &Wanted, now: i64) -> R<()> {
    exec(
        sql,
        "INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, attempts, attempt_version, next_attempt_at, last_code, updated_at)
           VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, ?)
           ON CONFLICT (host) DO UPDATE SET applied_version = excluded.applied_version, applied_script = excluded.applied_script,
             applied_at = excluded.applied_at, attempts = 0, attempt_version = NULL, next_attempt_at = NULL, refused_version = NULL, last_code = NULL, updated_at = excluded.updated_at",
        vec![
            host.into(),
            want.version.into(),
            opt(&want.script),
            now.into(),
            now.into(),
        ],
    )
}

/// Records a failed attempt at `version`, and the wait before the next. Attempts are counted for one version: the
/// first failure at a new version starts the count, and its wait, again.
fn not_applied(sql: &SqlStorage, host: &str, version: i64, code: &str, now: i64) -> R<()> {
    let attempts = rows(
        sql,
        "SELECT attempts FROM serve_apply WHERE host = ? AND attempt_version = ?",
        vec![host.into(), version.into()],
    )?
    .first()
    .map_or(0, |row| int(&row["attempts"]));
    exec(
        sql,
        "INSERT INTO serve_apply (host, attempts, attempt_version, next_attempt_at, last_code, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (host) DO UPDATE SET attempts = excluded.attempts, attempt_version = excluded.attempt_version,
             next_attempt_at = excluded.next_attempt_at, refused_version = NULL, last_code = excluded.last_code, updated_at = excluded.updated_at",
        vec![
            host.into(),
            (attempts + 1).into(),
            version.into(),
            (now + wait_ms(attempts)).into(),
            code.into(),
            now.into(),
        ],
    )
}

/// Records that the applier will do nothing more for a host at `version`, and why: the host isn't this room's to
/// touch, or what the room asks for it can't be confirmed and its entry is known to be absent. It counts no attempt
/// and sets no wait. It is logged once for each version, by the room's ID and the code. Telling an operator is the
/// reconcile's.
fn refused(sql: &SqlStorage, host: &str, version: i64, code: &str, now: i64) -> R<()> {
    // A custom host refused while routing last saw it may serve (the review of PR #404, S3): its request changes now,
    // so routing reads again at the shortest wait, never the six hours of a routed name, and reopens the host once the
    // cause has cleared. Only when it was last applied cleanly: a host refused again after routing reopened it keeps
    // the wait doubling from that first refusal, so a cause routing can't see never wakes the room every minute.
    exec(
        sql,
        "UPDATE hostname_request SET updated_at = ?, checked_at = ? WHERE hostname = ? AND open = 1 AND state = 'claimed'
           AND EXISTS (SELECT 1 FROM serve_state WHERE host = ? AND kind = 'custom')
           AND NOT EXISTS (SELECT 1 FROM serve_apply WHERE host = ? AND last_code IS NOT NULL)",
        vec![
            now.into(),
            now.into(),
            host.into(),
            host.into(),
            host.into(),
        ],
    )?;
    let known = !rows(
        sql,
        "SELECT 1 AS known FROM serve_apply WHERE host = ? AND refused_version = ? AND last_code = ?",
        vec![host.into(), version.into(), code.into()],
    )?
    .is_empty();
    exec(
        sql,
        "INSERT INTO serve_apply (host, refused_version, last_code, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (host) DO UPDATE SET refused_version = excluded.refused_version, attempts = 0, attempt_version = NULL,
             next_attempt_at = NULL, last_code = excluded.last_code, updated_at = excluded.updated_at",
        vec![host.into(), version.into(), code.into(), now.into()],
    )?;
    if !known {
        let room = rows(sql, "SELECT id FROM workspace", vec![])?
            .first()
            .and_then(|row| text(&row["id"]))
            .unwrap_or_default();
        console_error!("takedown: a host was refused: room={} code={}", room, code);
    }
    Ok(())
}

/// Removes a host's entry and reads it back. `true` only when the provider says the host has none.
async fn remove_entry(provider: &Provider, host: &str) -> (bool, bool) {
    let deleted = provider.delete_entry(host).await;
    (deleted, provider.read_entry(host).await == Entry::Absent)
}

/// Whether this room's applier may touch a host's entry at all, and under which label a script may be written to it.
/// A default host is `<label>.<content domain>` for a label that is the room's own, or it is refused outright: the
/// room's rows alone never send a write or a delete to another app's host. A custom hostname has no label of its own
/// and is only ever removed here.
fn host_label(
    sql: &SqlStorage,
    provider: &Provider,
    host: &str,
    custom: bool,
) -> R<Result<Option<String>, &'static str>> {
    if custom {
        // Nothing on the content domain is a custom hostname: not an app's host, not a deeper name, not the domain.
        return Ok(if provider.on_content_domain(host) {
            Err("custom_host_on_content_domain")
        } else {
            Ok(None)
        });
    }
    let Some(label) = provider.default_host_label(host) else {
        return Ok(Err("host_not_a_default_host"));
    };
    if !own_label(sql, label)? {
        return Ok(Err("host_not_this_rooms"));
    }
    Ok(Ok(Some(label.to_owned())))
}

/// One host, made to match what the room wants now. See the module's note for the four steps. `deadline` is when the
/// pass stops starting new steps.
async fn apply_host(
    sql: &SqlStorage,
    env: &Env,
    provider: &Provider,
    host: &str,
    deadline: i64,
) -> R<()> {
    let mut last = None;
    for _ in 0..APPLY_PASSES {
        // A custom host's check that was read and failed, with its entry known absent: refused, not retried.
        let mut refused_code: Option<&'static str> = None;
        let Some(want) = wanted(sql, host)? else {
            return Ok(());
        };
        if now_ms() > deadline {
            // Not an attempt: nothing was asked. The host stays due, for the next alarm.
            return Ok(());
        }
        let label = match host_label(sql, provider, host, want.custom)? {
            Ok(label) => label,
            // Not this room's host to touch. No call is made, and none will be until the room moves its version.
            Err(code) => return refused(sql, host, want.version, code, now_ms()),
        };
        let outcome = match &want.script {
            // The room's state never names a script while its app is suspended. While the app is held because nobody
            // who may release remains (step 6), the room keeps the script it serves, and the host serves nothing. In
            // each case nothing is written, and an entry that is there is removed: what can't be confirmed isn't left
            // serving.
            Some(_) if app_suspended(sql)? || want.held => {
                let (_, absent) = remove_entry(provider, host).await;
                Err(match (app_suspended(sql)? || !want.held, absent) {
                    (true, true) => "app_suspended",
                    (true, false) => "app_suspended_entry_remains",
                    (false, true) => "app_held",
                    (false, false) => "app_held_entry_remains",
                })
            }
            // A custom hostname's entry (step 8c): only while every check of routing holds, the hostname's object
            // asked last. What was read and fails takes the entry down and refuses the host at this version.
            Some(script) if want.custom => {
                match custom_write(sql, env, provider, host, script, want.kind).await? {
                    Ok(()) => Ok(()),
                    Err(CustomFail::Retry(code)) => Err(code),
                    Err(CustomFail::Refuse(code)) => {
                        let (_, absent) = remove_entry(provider, host).await;
                        if absent {
                            refused_code = Some(code);
                            Err(code)
                        } else {
                            Err("custom_host_entry_remains")
                        }
                    }
                }
            }
            // A default host serves only a script under its own label. Anything else is a fault in the room's rows:
            // it is never written, and whatever the host has is removed.
            Some(script) if !matches!(script_owner(script), ScriptOwner::Podster { label: l, .. } if Some(l) == label.as_deref()) =>
            {
                let (_, absent) = remove_entry(provider, host).await;
                Err(if absent {
                    "script_not_this_hosts"
                } else {
                    "script_not_this_hosts_entry_remains"
                })
            }
            // Only a release the room has recorded live or served is ever written to a host. A commit stages its
            // script on the host first and confirms after its outside reads (step 5): until then nothing is asked
            // of the provider, what the host already serves is left, and the host waits like any failed attempt.
            Some(script) if !release_confirmed(sql, script)? => Err(release_commit::NOT_CONFIRMED),
            // Before any write: the stop for the whole content domain, asked of its own home. While it is set, or
            // can't be read, nothing is written. What is already there is left: the stop itself is what refuses every
            // host, and no room's state changes for it. A removal never asks: taking an entry out is always allowed.
            Some(script) => match content_stop::read_from(env).await {
                Stop::Stopped => Err("content_domain_stopped"),
                Stop::Unreadable => Err("stop_unreadable"),
                // The entry is written in the kind the room recorded for the script (S3 of the store plan), and read
                // back as exactly that script of exactly that kind: one of the other kind differs, as one naming another
                // script does, and is written again.
                Stop::Clear => {
                    let written = provider.write_entry_as(host, script, want.kind).await;
                    let found = provider.read_entry(host).await;
                    if written && entry_is(Some((want.kind, script)), found.named()) {
                        Ok(())
                    } else if !written {
                        Err("write_not_confirmed")
                    } else {
                        Err("read_back_differs")
                    }
                }
            },
            None => match remove_entry(provider, host).await {
                // Absent is the point, whether this delete or an earlier one did it.
                (_, true) => Ok(()),
                (false, false) => Err("delete_not_confirmed"),
                (true, false) => Err("read_back_differs"),
            },
        };
        // The room may have changed its mind while the provider was asked. If it did, what was just written is
        // already stale: start over from what the room wants now.
        let now = now_ms();
        match wanted(sql, host)? {
            Some(again)
                if again.version == want.version
                    && again.hold_generation == want.hold_generation =>
            {
                return match outcome {
                    Ok(()) => applied(sql, host, &want, now),
                    // What the room asks can't be confirmed, and the host's entry is known to be absent: there is
                    // nothing left to do or to retry for this version.
                    Err(code @ ("app_suspended" | "app_held" | "script_not_this_hosts")) => {
                        refused(sql, host, want.version, code, now)
                    }
                    Err(code) if refused_code == Some(code) => {
                        refused(sql, host, want.version, code, now)
                    }
                    Err(code) => not_applied(sql, host, want.version, code, now),
                };
            }
            Some(again) => last = Some(again.version),
            None => return Ok(()),
        }
    }
    // The version moved on every pass. What the entry holds now is unknown to the room, so nothing is recorded as
    // applied, and the host is tried again after a wait counted against the version it has now.
    match last {
        Some(version) => not_applied(sql, host, version, "version_kept_moving", now_ms()),
        None => Ok(()),
    }
}

/// Why a custom host's entry wasn't written (step 8c).
enum CustomFail {
    /// Something couldn't be read, or isn't confirmed yet: nothing is written, what is there is left, and it is tried
    /// again after a wait.
    Retry(&'static str),
    /// A check was read and fails: the entry comes down, and the host is refused at this version.
    Refuse(&'static str),
}

/// **A custom hostname's entry, written only while routing holds** (M6 step 8c; ADR 0010's "Custom domains", step 5;
/// the deep review's D6 on PR #403). In order, each failing closed:
///
/// 1. The script is a name Rust made, under one of the room's own labels.
/// 2. Routing's local checks, from the room's own rows (`custom_hostname::route_local_for`): the gate on claims, the
///    room's request for the name `claimed`, no unpublish since it was made, the room's own facts, and Cloudflare's
///    last read `active`. Read and failing refuses; a fact that couldn't be read waits.
/// 3. **The hostname's own object:** it must hold exactly this room's and this request's claim, live, on a name that
///    isn't suspended. No answer waits; anything else refuses. Asked before anything that only waits, so a claim that
///    isn't live takes the entry down whatever else holds (the review of PR #404, S2).
/// 4. The release is served: its marker came back through the default host. A custom host never takes a release
///    before that. While it waits, an ordinary commit's flight keeps the release last served; anything else that
///    isn't the release it wants is taken down, what a rollback rolls away from included ([`stale_taken_down`]).
/// 5. The stop for the whole content domain, as for a default host.
///
/// Then the entry is written in the custom form, naming the host (`podster_core::hostnames::custom_entry_value`), and
/// read back.
async fn custom_write(
    sql: &SqlStorage,
    env: &Env,
    provider: &Provider,
    host: &str,
    script: &str,
    kind: HostKind,
) -> R<Result<(), CustomFail>> {
    let own = match script_owner(script) {
        ScriptOwner::Podster { label, .. } => own_label(sql, label)?,
        ScriptOwner::Foreign => false,
    };
    if !own {
        return Ok(Err(CustomFail::Refuse("script_not_this_rooms")));
    }
    let (local, request) =
        super::custom_hostname::route_local_for(sql, host, super::hostname::claims_open(sql))?;
    match local {
        CustomRoute::Serve => {}
        CustomRoute::Wait(code) => return Ok(Err(CustomFail::Retry(code))),
        CustomRoute::Refuse(code) => return Ok(Err(CustomFail::Refuse(code))),
    }
    let Some(request) = request else {
        return Ok(Err(CustomFail::Refuse("hostname_not_claimed")));
    };
    // The object before anything that only waits (the review of PR #404, S2): a claim that isn't live takes the entry
    // down even while the release waits for its marker or the domain is stopped.
    let room = rows(sql, "SELECT id FROM workspace", vec![])?
        .first()
        .and_then(|row| text(&row["id"]))
        .unwrap_or_default();
    match super::custom_hostname::route_at_object(env, sql, host, &room, &request).await {
        CustomRoute::Serve => {}
        CustomRoute::Wait(code) => return Ok(Err(CustomFail::Retry(code))),
        CustomRoute::Refuse(code) => return Ok(Err(CustomFail::Refuse(code))),
    }
    let served = !rows(
        sql,
        "SELECT 1 AS served FROM release WHERE script_name = ? AND state = 'served' LIMIT 1",
        vec![script.into()],
    )?
    .is_empty();
    if !served {
        return Ok(Err(stale_taken_down(sql, provider, host, script).await?));
    }
    match content_stop::read_from(env).await {
        Stop::Stopped => return Ok(Err(CustomFail::Retry("content_domain_stopped"))),
        Stop::Unreadable => return Ok(Err(CustomFail::Retry("stop_unreadable"))),
        Stop::Clear => {}
    }
    let written = provider.write_entry_as(host, script, kind).await;
    let found = provider.read_entry(host).await;
    Ok(
        if written && entry_is(Some((kind, script)), found.named()) {
            Ok(())
        } else if !written {
            Err(CustomFail::Retry("write_not_confirmed"))
        } else {
            Err(CustomFail::Retry("read_back_differs"))
        },
    )
}

/// **While a custom host waits for the release it wants to be served** (the review of PR #404, S2, and its security
/// re-check): what is there stays only as `podster_core::release::waiting_entry_keeps` decides. The release it wants
/// stays; during an ordinary commit's flight, so does the release last confirmed served, so a release never darkens a
/// custom host while its marker is out. Anything else is taken down and the host serves nothing until the release it
/// wants is served: the release a rollback rolls away from, an earlier one, and an entry that couldn't be read alike. A
/// stale release is worse than none. Either way it is tried again.
async fn stale_taken_down(
    sql: &SqlStorage,
    provider: &Provider,
    host: &str,
    wanted: &str,
) -> R<CustomFail> {
    let state = load(sql)?.map(|loaded| loaded.state);
    // A rollback's flight, switched back or uploaded again, keeps nothing it rolls away from (the review of #412, S1).
    let rollback = match state.as_ref().and_then(|state| state.in_flight.as_ref()) {
        Some(flight) => super::release_rollback::target_of(sql, &flight.release_id)?.is_some(),
        None => false,
    };
    let entry = provider.read_entry(host).await;
    if entry == Entry::Absent {
        return Ok(CustomFail::Retry("release_not_served"));
    }
    // Kept only while it names a script the rule keeps, in the kind the room recorded for that script: an entry of the
    // other kind is taken down, as one naming any other script is. The kind is read only for an entry the rule keeps,
    // and a read that fails takes it down too: nothing that can't be read ever stops a stale entry coming down (the
    // review of #418).
    if let Some((kind, found)) = entry.named() {
        let keeps = state.as_ref().is_some_and(|state| {
            podster_core::release::waiting_entry_keeps(state, wanted, found, rollback)
        });
        if keeps {
            let recorded = super::release_commit::script_kind(sql, found).ok();
            if recorded
                .is_some_and(|recorded| entry_is(Some((recorded, found)), Some((kind, found))))
            {
                return Ok(CustomFail::Retry("release_not_served"));
            }
        }
    }
    let (_, absent) = remove_entry(provider, host).await;
    Ok(CustomFail::Retry(if absent {
        "release_not_served_taken_down"
    } else {
        "custom_host_entry_remains"
    }))
}

/// Whether the room has recorded a release with this script as live or served. A rollback's own record names the
/// script it rolls back to, so it counts as that script's too.
fn release_confirmed(sql: &SqlStorage, script: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT 1 AS confirmed FROM release WHERE script_name = ? AND state IN ('live', 'served') LIMIT 1",
        vec![script.into()],
    )?
    .is_empty())
}

/// Until when a script is kept from the delete job because its release is still uploading, or `uncertain`, within its
/// hour, if it is. **Asked at the moment of the delete,** and not only when the script was queued: a script queued while its
/// release's upload was uncertain may belong to a release that is uploading again by now. Such a release can't be
/// committed either, since its script is queued, but the delete waits for its hour, or for the room to end it.
fn upload_keeps_until(sql: &SqlStorage, script: &str, now: i64) -> R<Option<i64>> {
    Ok(rows(
        sql,
        "SELECT coalesce(upload_started_at, updated_at) AS since FROM release WHERE script_name = ? AND state IN (?, ?)",
        vec![
            script.into(),
            ReleaseState::Uploading.name().into(),
            ReleaseState::Uncertain.name().into(),
        ],
    )?
    .iter()
    .map(|row| int(&row["since"]))
    .filter(|since| !upload_expired(*since, now))
    .map(|since| since.saturating_add(IN_FLIGHT_EXEMPTION_MS))
    .max())
}

/// Whether a script may be deleted now: nothing in the room's state names it, and every host's entry is known to
/// match what the room wants, so no entry can still name it. The entry goes first; the files come behind.
fn may_delete(sql: &SqlStorage, script: &str) -> R<bool> {
    let named = rows(
        sql,
        "SELECT 1 AS named FROM serve_state WHERE script_name = ?1 OR flight_before = ?1
           UNION ALL SELECT 1 FROM release_config WHERE kept_previous = ?1 OR in_flight_script = ?1",
        vec![script.into()],
    )?;
    let pending = rows(
        sql,
        &format!("SELECT 1 AS pending {PENDING_HOSTS} LIMIT 1"),
        vec![],
    )?;
    Ok(named.is_empty() && pending.is_empty())
}

fn answer_code(prefix: &str, answer: Option<ScriptAnswer>) -> String {
    match answer {
        None => format!("{prefix}_no_answer"),
        Some(ScriptAnswer::Read { status, .. }) | Some(ScriptAnswer::Delete { status, .. }) => {
            format!("{prefix}_{status}")
        }
    }
}

/// One queued script: deleted, and counted as gone only on the provider's own word. `may` says whether nothing can still
/// name it: production's [`may_delete`] for a production label's script, with production's provider; the preview
/// applier's own for a preview label's, with the preview provider (`preview_apply`, M8 step 6).
pub(super) async fn delete_script(
    sql: &SqlStorage,
    provider: &Provider,
    script: &str,
    may: fn(&SqlStorage, &str) -> R<bool>,
) -> R<()> {
    let retry = |code: &str| -> R<()> {
        let attempts = rows(
            sql,
            "SELECT attempts FROM script_delete WHERE script_name = ?",
            vec![script.into()],
        )?
        .first()
        .map_or(0, |row| int(&row["attempts"]));
        exec(
            sql,
            "UPDATE script_delete SET attempts = attempts + 1, next_attempt_at = ?, last_code = ? WHERE script_name = ?",
            vec![
                (now_ms() + wait_ms(attempts)).into(),
                code.into(),
                script.into(),
            ],
        )
    };
    if let Some(until) = upload_keeps_until(sql, script, release_recheck::release_now(sql))? {
        // Nothing was asked of the provider, so no attempt is counted. The row waits until the upload's hour is
        // over, by its own time, so the room isn't woken for it before then.
        return exec(
            sql,
            "UPDATE script_delete SET next_attempt_at = ?, last_code = 'release_uploading' WHERE script_name = ? AND gone_at IS NULL",
            vec![until.into(), script.into()],
        );
    }
    if !may(sql, script)? {
        // Nothing was asked of the provider, so no attempt is counted and no wait is set. It asks for no wake
        // either ([`next_due`]): the pass that applies the last pending host deletes it.
        return exec(
            sql,
            "UPDATE script_delete SET last_code = 'entry_not_removed_yet' WHERE script_name = ? AND gone_at IS NULL",
            vec![script.into()],
        );
    }
    let deleted = provider.delete_script(script).await;
    let mut gone = deleted.is_some_and(script_gone);
    let mut code = answer_code("delete", deleted);
    if !gone {
        // A first delete that worked answers 200, which isn't one of the two answers that mean gone. The read is.
        let read = provider.read_script(script).await;
        gone = read.is_some_and(script_gone);
        code = answer_code("read", read);
    }
    if !gone {
        return retry(&code);
    }
    let now = now_ms();
    exec(
        sql,
        "UPDATE script_delete SET gone_at = ?, attempts = attempts + 1, last_code = NULL WHERE script_name = ? AND gone_at IS NULL",
        vec![now.into(), script.into()],
    )?;
    // An unpublish is done with its files when the last of them is gone, **and no script that it owes a deletion is
    // still unqueued.** A release that had begun its upload before the unpublish has a script of its own, and that
    // script is queued only when the room's release bookkeeping ends the release, in a transaction after the
    // unpublish's. Until then it is queued nowhere, and the unpublish isn't done: it still exists at the provider.
    //
    // The mark is looked at for this script's own unpublish and for every earlier one that has files. A script queued
    // late goes under the room's newest unpublish, and an earlier one that only it was holding open is done with it.
    exec(
        sql,
        "UPDATE unpublish SET scripts_gone_at = ? WHERE scripts_gone_at IS NULL
           AND release_epoch <= (SELECT unpublish_epoch FROM script_delete WHERE script_name = ?)
           AND EXISTS (SELECT 1 FROM script_delete d WHERE d.unpublish_epoch = unpublish.release_epoch)
           AND NOT EXISTS (SELECT 1 FROM script_delete d WHERE d.unpublish_epoch = unpublish.release_epoch AND d.gone_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM release r WHERE r.state IN ('uploading', 'uncertain') AND r.script_name IS NOT NULL
             AND r.script_release_id = r.id AND r.release_epoch < unpublish.release_epoch
             AND r.id NOT IN (SELECT release_id FROM release_environment WHERE environment = 'preview')
             AND NOT EXISTS (SELECT 1 FROM script_delete q WHERE q.script_name = r.script_name))",
        vec![now.into(), script.into()],
    )
}

/// The applier, then the delete job, from the room's alarm. Each host and each script is its own small step, and one
/// failing holds up no other.
pub(super) async fn upkeep(state: &State, env: &Env) -> R<()> {
    let sql = state.storage().sql();
    if !store::is_initialized(&sql)? || store::needs_migration(&sql)? {
        return Ok(());
    }
    let now = now_ms();
    // A release whose upload is an hour old ends here too, so a release that was staged and then abandoned doesn't
    // keep its host waiting, and every script delete in the room behind it, for longer than its hour. In a
    // transaction of its own, and never in the way: if it fails, the applier and the delete job run all the same.
    release_commit::bookkeeping(state);
    let hosts: Vec<String> = rows(
        &sql,
        &format!(
            "SELECT s.host AS host {PENDING_HOSTS} AND {HOST_DUE} <= ? ORDER BY s.host LIMIT ?"
        ),
        vec![now.into(), (BATCH as i64).into()],
    )?
    .iter()
    .filter_map(|row| text(&row["host"]))
    .collect();
    let due_scripts = |sql: &SqlStorage, now: i64| -> R<Vec<String>> {
        Ok(rows(
            sql,
            "SELECT script_name FROM script_delete WHERE gone_at IS NULL AND next_attempt_at <= ?
               AND label IN (SELECT label FROM app_label WHERE kind = 'production') ORDER BY queued_at, script_name LIMIT ?",
            vec![now.into(), (BATCH as i64).into()],
        )?
        .iter()
        .filter_map(|row| text(&row["script_name"]))
        .collect())
    };
    let scripts = due_scripts(&sql, now)?;
    if hosts.is_empty() && scripts.is_empty() {
        return Ok(());
    }
    let Some(provider) = provider(env, &sql) else {
        let room = rows(&sql, "SELECT id FROM workspace", vec![])?
            .first()
            .and_then(|row| text(&row["id"]))
            .unwrap_or_default();
        console_log!(
            "takedown: no provider is configured, so nothing was applied or deleted: room={} hosts={} scripts={}",
            room,
            hosts.len(),
            scripts.len()
        );
        return Ok(());
    };
    let deadline = now + PASS_BUDGET_MS;
    for host in &hosts {
        if let Err(error) = apply_host(&sql, env, &provider, host, deadline).await {
            console_error!(
                "takedown: a host wasn't applied: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
    }
    // Read again after the hosts: a script whose host was applied just now goes in this same pass.
    for script in &due_scripts(&sql, now_ms())? {
        if now_ms() > deadline {
            break;
        }
        if let Err(error) = delete_script(&sql, &provider, script, may_delete).await {
            console_error!(
                "takedown: a script wasn't deleted: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
    }
    Ok(())
}

impl Workspace {
    /// The reconcile asks the room about one entry or one script, or only wakes it (M6 step 4(a), third PR). The
    /// alarm is armed whatever the answer: a room that owes work and lost its wake gets it back here.
    pub(super) async fn takedown_check(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Ok(json!({ "known": false, "changed": false, "findings": [] }));
        }
        self.migrate_if_needed()?;
        let body: Value =
            serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
        // The store reconcile's question (S5 of the store plan, its second PR): the room's record of one label's store,
        // and, when the pass's whole list shows a name the record holds with no ID, that ID recorded made by the store's
        // own module. Nothing else of the reconcile's question runs for it.
        if body["kind"] == "store" {
            #[cfg(feature = "failpoints")]
            if !rows(
                &sql,
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_store_question_fails'",
                vec![],
            )?
            .is_empty()
            {
                return Err(ApiError::internal("test: the store question failed"));
            }
            // Test builds only: while this question's pass waits on this answer, a test runs as many more passes as
            // `test_reenter_store_pass` holds, one after another, so store passes overlap in a known order.
            #[cfg(feature = "failpoints")]
            if let Some(row) = rows(
                &sql,
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_reenter_store_pass'",
                vec![],
            )?
            .first()
            .and_then(|_| {
                rows(&sql, "SELECT passes FROM test_reenter_store_pass", vec![])
                    .ok()
                    .and_then(|found| found.into_iter().next())
            }) {
                exec(&sql, "DROP TABLE test_reenter_store_pass", vec![])?;
                for _ in 0..int(&row["passes"]) {
                    let _ = crate::moderation::call(
                        &self.env,
                        crate::reconcile::SCRIPTS_PATH,
                        Method::Post,
                        None,
                    )
                    .await;
                }
            }
            let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
            let (slot, store) = (out.clone(), sql.clone());
            transaction_sync(&self.state, move || {
                let now = release_recheck::release_now(&store);
                *slot.borrow_mut() = Some(release_store::store_question(&store, &body, now)?);
                Ok(())
            })?;
            let answer = out.borrow_mut().take();
            return answer.ok_or_else(|| ApiError::internal("the store question answered nothing"));
        }
        // Rule 3(b), first and in a transaction of its own (S5 of the store plan): a script whose bindings the reconcile
        // read is judged against the room's record of its store, and a binding it may not hold suspends the app
        // before anything slower runs (review standard 4). Only a script question that carries a read asks it. **A
        // failure here is logged by its code and answered `unknown`, and everything after it still runs** (the review
        // of PR #420): nothing committed, so nothing is decided, and the reconcile asks again next hour.
        let bindings = if body["kind"] == "script" && body.get("bindings").is_some() {
            let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
            let (slot, store, asked) = (out.clone(), sql.clone(), body.clone());
            let judged = transaction_sync(&self.state, move || {
                *slot.borrow_mut() = script_bindings::check_script(&store, &asked, now_ms())?;
                Ok(())
            });
            match judged {
                Ok(()) => out.borrow_mut().take(),
                Err(error) => {
                    console_error!(
                        "takedown: a script's bindings couldn't be judged: code={}",
                        error.code().unwrap_or("internal_error")
                    );
                    Some(
                        json!({ "verdict": "unknown", "foreign": null, "suspended": false, "held": false }),
                    )
                }
            }
        } else {
            None
        };
        // With the verdict, the latest time any of the room's labels was suspended, or null if none is: the reconcile
        // frees a slot of the ceiling it kept for a lost answer only when no suspension at or after the slot's time is
        // reported (the review of PR #423, 2). Unreadable, it is left out, and the slot stays.
        let bindings = bindings.map(|mut judged| {
            let since = rows(
                &sql,
                "SELECT max(suspended_at) AS since FROM app_label",
                vec![],
            )
            .ok()
            .and_then(|found| found.into_iter().next())
            .map(|row| row["since"].clone());
            if let (Some(since), Value::Object(fields)) = (since, &mut judged) {
                fields.insert("suspended_since".into(), since);
            }
            judged
        });
        // Test builds only, after the bindings' check has committed: a test runs a second scripts pass while this
        // question's pass waits on this answer (two passes overlapping, deterministically), or loses this answer, to
        // show the ceiling counts a suspension from when it was asked (the deep review of PR #420, items a and b).
        #[cfg(feature = "failpoints")]
        if bindings.is_some() {
            let table = |name: &str| {
                rows(
                    &sql,
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                    vec![name.into()],
                )
                .is_ok_and(|found| !found.is_empty())
            };
            if table("test_reenter_scripts_pass") {
                exec(&sql, "DROP TABLE test_reenter_scripts_pass", vec![])?;
                let _ = crate::moderation::call(
                    &self.env,
                    crate::reconcile::SCRIPTS_PATH,
                    Method::Post,
                    None,
                )
                .await;
            }
            if table("test_takedown_answer_lost") {
                exec(&sql, "DROP TABLE test_takedown_answer_lost", vec![])?;
                return Err(ApiError::internal("test: the room's answer was lost"));
            }
        }
        match self.takedown_rest(&sql, body).await {
            Ok(mut answer) => {
                if let (Some(judged), Value::Object(fields)) = (bindings, &mut answer) {
                    fields.insert("bindings".into(), judged);
                }
                Ok(answer)
            }
            Err(error) => {
                let Some(judged) = bindings else {
                    return Err(error);
                };
                // The bindings' verdict has committed, a suspension with it. It is answered all the same, so operators
                // are told this pass, with the failure named, which the reconcile counts against the script. The
                // alarm is set for the applier, whose work a suspension made due; if that fails too, the next pass
                // sets it.
                let code = error.code().unwrap_or("internal_error");
                console_error!("takedown: a step after the bindings' check failed: code={code}");
                if let Err(armed) = self.arm(false, false).await {
                    console_error!(
                        "takedown: the alarm wasn't set after a failed check: code={}",
                        armed.code().unwrap_or("internal_error")
                    );
                }
                Ok(
                    json!({ "known": true, "changed": false, "findings": [], "bindings": judged, "failed": code }),
                )
            }
        }
    }

    /// Everything the reconcile's question does after rule 3(b)'s check: the switch, the bookkeeping, the question
    /// itself and the alarm.
    async fn takedown_rest(&self, sql: &SqlStorage, body: Value) -> R<Value> {
        // Test builds only: a test makes every step after the bindings' check fail, to show that check's outcome still
        // stands and reaches operators.
        #[cfg(feature = "failpoints")]
        if !rows(
            sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_takedown_check_fails'",
            vec![],
        )?
        .is_empty()
        {
            return Err(ApiError::internal("test: the takedown check failed after the bindings' check"));
        }
        // Whatever was asked, the walk's wake included: the room reads its organization's release switch and applies
        // it (decision 218's backstop, `release_switch`), so a room no notice reached comes down here. A read that
        // fails changes nothing, and the question is answered all the same.
        self.read_and_apply_switch().await;
        // Whatever was asked: a release past its upload's hour ends first, before its script is looked at, so the
        // script a pass is about to delete never belongs to a release that could still go live. In a transaction
        // of its own: if it fails, the reconcile's question is answered all the same, and the failure is kept in
        // the room's own row, which the answer's findings are read from.
        release_commit::bookkeeping(&self.state);
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        let store = sql.clone();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(check(&store, &body, now_ms())?);
            Ok(())
        })?;
        // Whether an unpublish is owed for the repository's link: the room's alarm, which `arm` sets while one is, asks
        // the deployment's ceiling, and the walk takes `false` from a room it holds as the cause cleared there
        // (`crate::repo_ceiling`). One that couldn't be read is left out of the answer, so it can never release a hold.
        let owed = super::repo_unpublish::owed(sql).map(|owed| owed.is_some());
        self.arm(false, false).await?;
        let mut answer = out
            .borrow_mut()
            .take()
            .ok_or_else(|| ApiError::internal("takedown check answered nothing"))?;
        if let (Ok(owed), Value::Object(fields)) = (owed, &mut answer) {
            fields.insert("repo_unpublish_wanted".into(), Value::Bool(owed));
        }
        Ok(answer)
    }

    /// The hostname's claim object tells the room its custom hostname was suspended (M6 step 4(a)). The applier is
    /// woken by the alarm this arms.
    pub(super) async fn hostname_notice(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            // No such room, so nothing of its is being served. Answered, so the object stops asking.
            return Ok(json!({ "known": false, "acted": false }));
        }
        self.migrate_if_needed()?;
        // Test builds only: a test makes the room fail to answer, to show the object keeps the notice and asks again.
        #[cfg(feature = "failpoints")]
        if !rows(
            &sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_refuse_hostname_notice'",
            vec![],
        )?
        .is_empty()
        {
            return Err(ApiError::internal("test: the room didn't answer"));
        }
        let body: Value =
            serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        let store = sql.clone();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(hostname_suspended(&store, &body, now_ms())?);
            Ok(())
        })?;
        self.arm(false, false).await?;
        let answer = out.borrow_mut().take();
        answer.ok_or_else(|| ApiError::internal("hostname notice answered nothing"))
    }

    /// An operator suspends the room's app or lifts that (M6 step 4(a)). The Worker has checked the operator. The
    /// applier is woken by the alarm this arms, for now, so the entries go without waiting for anything else.
    pub(super) async fn app_suspension(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            // The lookup table named a room that doesn't exist. To the operator that is a label no room has.
            return Err(ApiError::not_found());
        }
        self.migrate_if_needed()?;
        let body: Value =
            serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        let store = sql.clone();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(set(&store, &body, now_ms())?);
            Ok(())
        })?;
        // The suspension has committed. Only now are the releases that hadn't gone live ended, in a transaction of
        // their own, with nothing awaited between the two: whether or not that works, the app is unpublished.
        release_commit::bookkeeping(&self.state);
        // The transaction moved each host's version, which voids any wait, so the applier is due now. If the alarm
        // can't be set the suspension has still committed, and the operator is told it failed: asking again changes
        // nothing in the room and arms again. Nothing else corrects a lost wake until the reconcile exists.
        self.arm(false, false).await?;
        let answer = out.borrow_mut().take();
        answer.ok_or_else(|| ApiError::internal("app suspension answered nothing"))
    }
}
