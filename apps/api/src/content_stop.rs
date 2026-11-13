//! The stop for the whole content domain (M6 step 4(a), second PR; ADR 0010's "Takedown").
//!
//! One switch for the deployment. An operator sets it, for a compromise of the namespace or of a publishing
//! credential, or a block of the whole domain, and lifts it. No room's state changes.
//!
//! **Its home is the `Moderation` object,** the one object for the deployment, which already keeps every operator
//! action. That row is the authority:
//!
//! - **Every room reads it there before it writes a default host's serve entry,** by asking the object, never a
//!   read model ([`read_from`]). If the answer is that it is set, or there is no answer, nothing is written.
//! - **The object makes the provider match it:** one key in the serve entries' namespace, which the content Worker
//!   (step 4(b)) reads to refuse every host. The key is written or removed, read back, and the row's version asked
//!   again; if it moved, it starts over. A failure is retried, 5 seconds doubling to 5 minutes, and a wait belongs to
//!   the version that failed, so a new stop never sits behind an old failure's wait.
//!
//! **With no provider configured, which is every deployment, the key isn't touched, and that is said:** the row keeps
//! the stop, rooms still obey it, and one log line says the key is owed.
//!
//! Logs carry codes only.
use crate::content_provider::{Provider, StopKey};
use crate::error::ApiError;
use crate::forward;
use crate::store::{exec, int, rows};
use serde_json::{json, Value};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// The `Moderation` object's table for the stop. One row at most. `version` goes up on every change, and the
/// `applied_*` and attempt columns are the object's own record of the provider's key.
pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS content_stop (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), stopped INTEGER NOT NULL CHECK (stopped IN (0, 1)),
  reason TEXT, at INTEGER, version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  applied_version INTEGER CHECK (applied_version IS NULL OR (typeof(applied_version) = 'integer' AND applied_version >= 1)), applied_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts >= 0), attempt_version INTEGER, next_attempt_at INTEGER,
  last_code TEXT CHECK (last_code IS NULL OR length(last_code) BETWEEN 1 AND 64), updated_at INTEGER NOT NULL,
  CHECK ((stopped = 1) = (reason IS NOT NULL)), CHECK ((stopped = 1) = (at IS NOT NULL)), CHECK ((applied_version IS NULL) = (applied_at IS NULL)),
  CHECK ((attempts = 0) = (attempt_version IS NULL)), CHECK (next_attempt_at IS NULL OR attempt_version IS NOT NULL));
";

/// The object's paths for the stop. Nothing outside the Worker reaches them.
pub(crate) const PATH: &str = "/content-stop";

const FIRST_WAIT_MS: i64 = 5_000;
const LONGEST_WAIT_MS: i64 = 5 * 60 * 1000;
/// How many times one alarm starts over when the row's version keeps moving.
const APPLY_PASSES: usize = 3;

fn wait_ms(attempts: i64) -> i64 {
    FIRST_WAIT_MS
        .saturating_mul(1_i64 << attempts.clamp(0, 6) as u32)
        .min(LONGEST_WAIT_MS)
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

/// The stop now: `{ stopped, reason, at }`. With no row, it was never set.
pub(crate) fn read(sql: &SqlStorage) -> R<Value> {
    Ok(
        rows(sql, "SELECT stopped, reason, at FROM content_stop", vec![])?
            .first()
            .map_or(
                json!({ "stopped": false, "reason": null, "at": null }),
                |row| json!({ "stopped": int(&row["stopped"]) == 1, "reason": row["reason"], "at": row["at"] }),
            ),
    )
}

/// `{ stopped, reason }`: sets the stop or lifts it, inside the caller's transaction. Doing what's already so
/// changes nothing, not even the reason. Answers as [`read`] does.
pub(crate) fn set(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let stopped = body["stopped"]
        .as_bool()
        .ok_or_else(ApiError::invalid_argument)?;
    let reason = body["reason"]
        .as_str()
        .and_then(podster_policy::moderation::Reason::from_name)
        .ok_or_else(ApiError::invalid_argument)?;
    let was = read(sql)?["stopped"] == true;
    if was != stopped {
        let (reason, at): (Option<&str>, Option<i64>) = if stopped {
            (Some(reason.name()), Some(now))
        } else {
            (None, None)
        };
        exec(
            sql,
            "INSERT INTO content_stop (singleton, stopped, reason, at, version, updated_at) VALUES (1, ?, ?, ?, 1, ?)
               ON CONFLICT (singleton) DO UPDATE SET stopped = excluded.stopped, reason = excluded.reason, at = excluded.at,
                 version = version + 1, updated_at = excluded.updated_at",
            vec![
                i64::from(stopped).into(),
                reason.into(),
                at.into(),
                now.into(),
            ],
        )?;
    }
    read(sql)
}

/// What a room learns when it asks whether the content domain is stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stop {
    /// The object answered, and the domain isn't stopped.
    Clear,
    /// The object answered, and it is.
    Stopped,
    /// No answer that says either. A caller treats it as stopped.
    Unreadable,
}

/// Asks the `Moderation` object, the stop's own home, whether the content domain is stopped. Never a read model.
pub(crate) async fn read_from(env: &Env) -> Stop {
    let asked = async {
        let stub = env
            .durable_object("MODERATION")?
            .id_from_name("moderation")?
            .get_stub()?;
        let mut response = forward(stub, PATH, "", Headers::new(), Method::Get, None).await?;
        if response.status_code() != 200 {
            return Err(ApiError::internal("stop not read"));
        }
        Ok::<Value, ApiError>(response.json().await?)
    };
    match asked.await.ok().map(|answer| answer["stopped"].clone()) {
        Some(Value::Bool(false)) => Stop::Clear,
        Some(Value::Bool(true)) => Stop::Stopped,
        _ => Stop::Unreadable,
    }
}

/// The provider the object may use. Test builds also read a table a test makes in the object,
/// `test_content_provider_off`, as a room does.
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

struct Pending {
    stopped: bool,
    version: i64,
}

/// The row, if the provider's key isn't known to match it. `due` is when it may next be tried.
fn pending(sql: &SqlStorage) -> R<Option<(Pending, i64)>> {
    Ok(rows(
        sql,
        "SELECT stopped, version, CASE WHEN attempt_version = version THEN coalesce(next_attempt_at, 0) ELSE 0 END AS due
           FROM content_stop WHERE applied_version IS NULL OR applied_version != version",
        vec![],
    )?
    .first()
    .map(|row| {
        (
            Pending {
                stopped: int(&row["stopped"]) == 1,
                version: int(&row["version"]),
            },
            int(&row["due"]),
        )
    }))
}

/// When the object next has the key to write or remove, or `None`: it matches, or no provider is configured.
pub(crate) fn next_due(sql: &SqlStorage, env: &Env, now: i64) -> R<Option<i64>> {
    if provider(env, sql).is_none() {
        return Ok(None);
    }
    Ok(pending(sql)?.map(|(_, due)| due.max(now + 10)))
}

fn failed(sql: &SqlStorage, version: i64, code: &str, now: i64) -> R<()> {
    let attempts = rows(
        sql,
        "SELECT attempts FROM content_stop WHERE attempt_version = ?",
        vec![version.into()],
    )?
    .first()
    .map_or(0, |row| int(&row["attempts"]));
    exec(
        sql,
        "UPDATE content_stop SET attempts = ?, attempt_version = ?, next_attempt_at = ?, last_code = ?, updated_at = ?",
        vec![
            (attempts + 1).into(),
            version.into(),
            (now + wait_ms(attempts)).into(),
            code.into(),
            now.into(),
        ],
    )
}

/// Makes the provider's key match the row, from the object's alarm.
pub(crate) async fn apply(sql: &SqlStorage, env: &Env) -> R<()> {
    let Some((_, due)) = pending(sql)? else {
        return Ok(());
    };
    if due > now_ms() {
        return Ok(());
    }
    let Some(provider) = provider(env, sql) else {
        console_log!(
            "content stop: no provider is configured, so the stop key wasn't written or removed"
        );
        return Ok(());
    };
    let mut last = None;
    for _ in 0..APPLY_PASSES {
        let Some((want, _)) = pending(sql)? else {
            return Ok(());
        };
        let outcome = if want.stopped {
            let written = provider.write_stop().await;
            match provider.read_stop().await {
                StopKey::Set if written => Ok(()),
                _ if !written => Err("write_not_confirmed"),
                _ => Err("read_back_differs"),
            }
        } else {
            let deleted = provider.delete_stop().await;
            match provider.read_stop().await {
                // Absent is the point, whether this delete or an earlier one did it.
                StopKey::Absent => Ok(()),
                _ if !deleted => Err("delete_not_confirmed"),
                _ => Err("read_back_differs"),
            }
        };
        // The operator may have changed it while the provider was asked. If so, what was written is already stale.
        let now = now_ms();
        let again = rows(sql, "SELECT version FROM content_stop", vec![])?
            .first()
            .map(|row| int(&row["version"]));
        if again != Some(want.version) {
            last = again;
            continue;
        }
        return match outcome {
            Ok(()) => exec(
                sql,
                "UPDATE content_stop SET applied_version = ?, applied_at = ?, attempts = 0, attempt_version = NULL, next_attempt_at = NULL,
                   last_code = NULL, updated_at = ?",
                vec![want.version.into(), now.into(), now.into()],
            ),
            Err(code) => failed(sql, want.version, code, now),
        };
    }
    match last {
        Some(version) => failed(sql, version, "version_kept_moving", now_ms()),
        None => Ok(()),
    }
}
