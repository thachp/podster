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
//!   moved, it starts over. It runs from the room's alarm and never behind a job.
//! - **The script-delete job.** A script is deleted only once no host's entry can still name it, and counts as gone
//!   only on one of the provider's two answers that mean gone (`podster_core::release::script_gone`). Anything else
//!   is retried, with a wait that grows.
//!
//! **With no provider configured, which is every deployment, the applier and the job do nothing, and say so:** the
//! work stays recorded as owed, in `serve_apply` and `script_delete`, and one log line counts it.
//!
//! What this step leaves out, on purpose:
//! - Only `app_suspended` unpublishes here. The other ten triggers are step 6's.
//! - A custom hostname's entry is never written here, only removed: writing one needs the hostname's claim to agree,
//!   and the stop for the whole content domain to be read first, which are the next PR's.
//! - A release that was still waiting, queued or uploading is left as it is. The epoch has moved, so it can never go
//!   live, and the job that owns it (step 5) fails it on its next pass.
//!
//! Logs carry the room's ID, counts and codes. Never a host, a label or a script's name.
use super::*;
use crate::content_provider::{Entry, Provider};
use podster_core::release::{
    next_state, script_gone, script_owner, unpublish, CommitMark, DesiredServe, InFlight,
    ReleaseEvent, ReleaseState, ScriptAnswer, ScriptOwner, ServeState, UnpublishTrigger,
};

/// The Worker's call, for a verified operator. Nothing outside the Worker reaches it.
pub(crate) const INTERNAL_APP_SUSPENSION: &str = "/internal/app-suspension";

/// The highest epoch or version the room stores. SQLite holds 64-bit integers, but they cross to Rust as JavaScript
/// numbers, which are exact only to 2^53 - 1. Core's own ceiling is `u64::MAX`, the state it never moves from. So
/// this value and anything above it is read as core's ceiling, and written as this: a room that ever got here fails
/// closed, as core means it to, about 9 * 10^15 unpublishes early.
const STORED_MAX: i64 = 9_007_199_254_740_991;

fn from_stored(value: i64) -> u64 {
    if value >= STORED_MAX {
        u64::MAX
    } else {
        value.max(0) as u64
    }
}

fn to_stored(value: u64) -> i64 {
    i64::try_from(value).map_or(STORED_MAX, |v| v.min(STORED_MAX))
}

/// How many times the applier starts over on one host in one pass, when its version keeps moving.
const APPLY_PASSES: usize = 3;
/// Hosts and scripts handled in one alarm. A room has two hosts at most and three scripts.
const BATCH: usize = 8;
const FIRST_WAIT_MS: i64 = 5_000;
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
        "SELECT host, script_name, version, closed, flight_version, flight_before FROM serve_state ORDER BY (kind = 'default') DESC, host",
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

/// Whether a label is one of this room's, current or retired.
fn own_label(sql: &SqlStorage, label: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT label FROM app_label WHERE label = ?",
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

/// Unpublishes the room's app, inside the caller's transaction: core's `unpublish` on the room's own state, written
/// back whole. The epoch goes up, every host goes to nothing with its version up, the kept script and any commit in
/// flight are forgotten, the trigger is recorded with the epoch it raised to, each release that was live or served
/// becomes unpublished, and every script core names is queued for deletion. It never refuses: a room with no release
/// configuration has nothing to unpublish, and that is all it does there.
fn unpublish_app(sql: &SqlStorage, trigger: UnpublishTrigger, label: &str, now: i64) -> R<()> {
    let Some(loaded) = load(sql)? else {
        return Ok(());
    };
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
        "SELECT id, state FROM release WHERE state IN ('live', 'served')",
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
            unpublish_app(sql, UnpublishTrigger::AppSuspended, label, now)?;
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

/// The provider this room may use, or `None`. Test builds also read a table a test makes in one room,
/// `test_content_provider_off`, so the unconfigured case can be shown beside the configured one.
fn provider(env: &Env, sql: &SqlStorage) -> Option<Provider> {
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
const PENDING_HOSTS: &str = "FROM serve_state s LEFT JOIN serve_apply a ON a.host = s.host WHERE a.applied_version IS NULL OR a.applied_version != s.version";

/// When the applier or the delete job next has something to do, or `None`: nothing is owed, or no provider is
/// configured, in which case the work waits without waking the room.
pub(super) fn next_due(sql: &SqlStorage, env: &Env, now: i64) -> R<Option<i64>> {
    if provider(env, sql).is_none() {
        return Ok(None);
    }
    let hosts = rows(
        sql,
        &format!(
            "SELECT min(coalesce(a.next_attempt_at, 0)) AS due, count(*) AS n {PENDING_HOSTS}"
        ),
        vec![],
    )?;
    let scripts = rows(
        sql,
        "SELECT min(next_attempt_at) AS due, count(*) AS n FROM script_delete WHERE gone_at IS NULL",
        vec![],
    )?;
    let due = [hosts.first(), scripts.first()]
        .into_iter()
        .flatten()
        .filter(|row| int(&row["n"]) > 0)
        .map(|row| int(&row["due"]).max(now + 10))
        .min();
    Ok(due)
}

struct Wanted {
    script: Option<String>,
    version: i64,
    custom: bool,
}

fn wanted(sql: &SqlStorage, host: &str) -> R<Option<Wanted>> {
    Ok(rows(
        sql,
        "SELECT script_name, version, kind FROM serve_state WHERE host = ?",
        vec![host.into()],
    )?
    .first()
    .map(|row| Wanted {
        script: text(&row["script_name"]),
        version: int(&row["version"]),
        custom: row["kind"].as_str() != Some("default"),
    }))
}

fn applied(sql: &SqlStorage, host: &str, want: &Wanted, now: i64) -> R<()> {
    exec(
        sql,
        "INSERT INTO serve_apply (host, applied_version, applied_script, applied_at, attempts, next_attempt_at, last_code, updated_at)
           VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)
           ON CONFLICT (host) DO UPDATE SET applied_version = excluded.applied_version, applied_script = excluded.applied_script,
             applied_at = excluded.applied_at, attempts = 0, next_attempt_at = NULL, last_code = NULL, updated_at = excluded.updated_at",
        vec![
            host.into(),
            want.version.into(),
            opt(&want.script),
            now.into(),
            now.into(),
        ],
    )
}

fn not_applied(sql: &SqlStorage, host: &str, code: &str, now: i64) -> R<()> {
    let attempts = rows(
        sql,
        "SELECT attempts FROM serve_apply WHERE host = ?",
        vec![host.into()],
    )?
    .first()
    .map_or(0, |row| int(&row["attempts"]));
    exec(
        sql,
        "INSERT INTO serve_apply (host, attempts, next_attempt_at, last_code, updated_at) VALUES (?, 1, ?, ?, ?)
           ON CONFLICT (host) DO UPDATE SET attempts = attempts + 1, next_attempt_at = excluded.next_attempt_at,
             last_code = excluded.last_code, updated_at = excluded.updated_at",
        vec![
            host.into(),
            (now + wait_ms(attempts)).into(),
            code.into(),
            now.into(),
        ],
    )
}

/// One host, made to match what the room wants now. See the module's note for the four steps.
async fn apply_host(sql: &SqlStorage, provider: &Provider, host: &str) -> R<()> {
    for _ in 0..APPLY_PASSES {
        let Some(want) = wanted(sql, host)? else {
            return Ok(());
        };
        let outcome = match &want.script {
            // A custom hostname's entry needs its claim to agree, which this step can't ask yet.
            Some(_) if want.custom => Err("claim_check_not_built"),
            // The room's state never names a script while its app is suspended. If it ever did, nothing is written.
            Some(_) if app_suspended(sql)? => Err("app_suspended"),
            Some(script) => {
                let written = provider.write_entry(host, script).await;
                match provider.read_entry(host).await {
                    Entry::Present(found) if written && &found == script => Ok(()),
                    _ if !written => Err("write_not_confirmed"),
                    _ => Err("read_back_differs"),
                }
            }
            None => {
                let deleted = provider.delete_entry(host).await;
                match provider.read_entry(host).await {
                    // Absent is the point, whether this delete or an earlier one did it.
                    Entry::Absent => Ok(()),
                    _ if !deleted => Err("delete_not_confirmed"),
                    _ => Err("read_back_differs"),
                }
            }
        };
        // The room may have changed its mind while the provider was asked. If it did, what was just written is
        // already stale: start over from what the room wants now.
        let now = now_ms();
        match wanted(sql, host)? {
            Some(again) if again.version == want.version => {
                return match outcome {
                    Ok(()) => applied(sql, host, &want, now),
                    Err(code) => not_applied(sql, host, code, now),
                };
            }
            Some(_) => continue,
            None => return Ok(()),
        }
    }
    not_applied(sql, host, "version_kept_moving", now_ms())
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

/// One queued script: deleted, and counted as gone only on the provider's own word.
async fn delete_script(sql: &SqlStorage, provider: &Provider, script: &str) -> R<()> {
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
    if !may_delete(sql, script)? {
        return retry("entry_not_removed_yet");
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
    // The unpublish is done with its files when the last of them is gone.
    exec(
        sql,
        "UPDATE unpublish SET scripts_gone_at = ? WHERE scripts_gone_at IS NULL
           AND release_epoch = (SELECT unpublish_epoch FROM script_delete WHERE script_name = ?)
           AND NOT EXISTS (SELECT 1 FROM script_delete d WHERE d.unpublish_epoch = unpublish.release_epoch AND d.gone_at IS NULL)",
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
    let hosts: Vec<String> = rows(
        &sql,
        &format!("SELECT s.host AS host {PENDING_HOSTS} AND coalesce(a.next_attempt_at, 0) <= ? ORDER BY s.host LIMIT ?"),
        vec![now.into(), (BATCH as i64).into()],
    )?
    .iter()
    .filter_map(|row| text(&row["host"]))
    .collect();
    let scripts: Vec<String> = rows(
        &sql,
        "SELECT script_name FROM script_delete WHERE gone_at IS NULL AND next_attempt_at <= ? ORDER BY queued_at, script_name LIMIT ?",
        vec![now.into(), (BATCH as i64).into()],
    )?
    .iter()
    .filter_map(|row| text(&row["script_name"]))
    .collect();
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
    for host in &hosts {
        if let Err(error) = apply_host(&sql, &provider, host).await {
            console_error!(
                "takedown: a host wasn't applied: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
    }
    for script in &scripts {
        if let Err(error) = delete_script(&sql, &provider, script).await {
            console_error!(
                "takedown: a script wasn't deleted: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
    }
    Ok(())
}

impl Workspace {
    /// An operator suspends the room's app or lifts that (M6 step 4(a)). The Worker has checked the operator. The
    /// applier is woken by the alarm this arms, so the entries go without waiting for anything else.
    pub(super) async fn app_suspension(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Err(ApiError::workspace_not_found());
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
        if let Err(error) = self.arm(false, false).await {
            console_error!(
                "takedown: couldn't wake the applier: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
        let answer = out.borrow_mut().take();
        answer.ok_or_else(|| ApiError::internal("app suspension answered nothing"))
    }
}
