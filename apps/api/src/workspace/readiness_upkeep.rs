//! The scheduled read-back of a linked repository (ADR 0009's drift check "on a schedule", the M5 security review's F8).
//!
//! A merge reads the repository's protections back before it's asked for, and an operator's recheck reads them for a
//! degraded link. Nothing read them otherwise, so a rule someone removed in a quiet room stayed unseen while agents held
//! push tokens. This job reads a ready link back once a day from the room's alarm, with the same read and the same
//! judgement as the merge job's (`Workspace::readiness`), counted against the repository's hourly read cap.
//!
//! - **Only a definite difference degrades the link**, and degrading marks every token agents hold on it for revocation
//!   in that same transaction. The alarm takes them back in the same pass, since token upkeep runs after this job.
//! - **A read that couldn't be made changes nothing.** That covers no configuration, no answer, a server's error, a
//!   rate limit, or an answer that couldn't be read. The next attempt waits an hour.
//! - Logs carry the room's ID, a fixed word and an HTTP status, never anything GitHub wrote.
//!
//! **While an agent holds a token.** A mint reads the rules back first, but a token lives an hour, so a rule removed
//! after the mint would stay unseen until the next mint or the daily read. So while any unexpired token is held on the
//! ready link, the alarm also reads it back every `HELD_TOKEN_READ_MS` (proposed), when `core` says one is due
//! (`held_token_read_due_at`). That read goes through the same path as a mint's (`Workspace::token_read_back`), so a
//! read-back that passed in the last minute stands instead of a new one, and one this read passes stands for the next
//! mint. A definite difference degrades through `merges::degrade`, which marks the held tokens for revocation, and token
//! upkeep later in the same alarm takes them back. A read that couldn't be made changes nothing, and the next waits an
//! interval. No token held, no read. Each attempt is counted in `repo_read` as `kind = 'held'`, apart from the refresh
//! job's cap, and `core` allows at most `HELD_TOKEN_READS_PER_HOUR` in an hour.
use super::merges::{degrade, Readiness};
use super::repo_tokens::TokenReadBack;
use super::*;
use podster_core::provisioning::{held_token_read_due_at, readiness_due_at};

/// The `repo_read` kind of a read while a token is held. Not `job`, so it doesn't use up the refresh job's cap.
const HELD_KIND: &str = "held";
const HOUR_MS: i64 = 60 * 60 * 1000;

/// The ready link, as this job needs it: its repository, whether it's public, its default branch and when it was last
/// found exactly right.
struct Linked {
    repo_id: i64,
    /// Its `updated_at`, which a degrade or a return to `ready` moves: the stamp a kept read-back is held to.
    stamp: i64,
    public: bool,
    default_branch: String,
    verified_at: i64,
    /// When the repository was first seen gone, if a second look is owed.
    gone_seen_at: Option<i64>,
}

fn ready_link(sql: &SqlStorage) -> R<Option<Linked>> {
    Ok(rows(
        sql,
        "SELECT provider_repo_id, visibility, default_branch, verified_at, created_at, updated_at, gone_seen_at FROM repo_link WHERE provider = 'github' AND status = 'ready'",
        vec![],
    )?
    .first()
    .map(|row| Linked {
        repo_id: int(&row["provider_repo_id"]),
        stamp: int(&row["updated_at"]),
        public: row["visibility"].as_str() == Some("public"),
        default_branch: text(&row["default_branch"]).unwrap_or_default(),
        verified_at: row["verified_at"]
            .as_i64()
            .unwrap_or_else(|| int(&row["created_at"])),
        gone_seen_at: row["gone_seen_at"].as_i64(),
    }))
}

/// When the room's ready link is next due a read: its daily one, or one while an agent holds a token for it, whichever
/// is sooner. `None` without a ready link, with the switch off, or without provisioning's configuration, when no read
/// could be made.
pub(super) fn next_due(sql: &SqlStorage, env: &Env, now: i64) -> R<Option<i64>> {
    let daily = daily_due(sql, env, now)?;
    let held = held_due(sql, env, now)?;
    Ok(match (daily, held) {
        (Some(daily), Some(held)) => Some(daily.min(held)),
        (daily, held) => daily.or(held),
    })
}

/// Whether test builds read while a token is held: only in a room holding this table, so specs that mint tokens and
/// check the alarm stays quiet don't each get an unasked-for read. Deployed builds always do.
fn held_reads_on(sql: &SqlStorage) -> R<bool> {
    #[cfg(feature = "failpoints")]
    return Ok(!rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_held_token_reads'",
        vec![],
    )?
    .is_empty());
    #[cfg(not(feature = "failpoints"))]
    {
        let _ = sql;
        Ok(true)
    }
}

/// When the ready link is next due a read because an agent holds an unexpired token on it, or `None` when none is
/// held: `core::held_token_read_due_at` on the newest held token's mint, the last time the link was found right and
/// this hour's attempts.
fn held_due(sql: &SqlStorage, env: &Env, now: i64) -> R<Option<i64>> {
    if !provisioning::enabled(env, sql)?
        || !provisioning::configured(env, sql)
        || !held_reads_on(sql)?
    {
        return Ok(None);
    }
    let Some(link) = ready_link(sql)? else {
        return Ok(None);
    };
    held_due_for(sql, &link, now)
}

fn held_due_for(sql: &SqlStorage, link: &Linked, now: i64) -> R<Option<i64>> {
    let latest_mint = rows(
        sql,
        "SELECT max(created_at) AS at FROM repo_token WHERE state = 'held' AND expires_at > ? AND provider_repo_id = ?",
        vec![now.into(), link.repo_id.into()],
    )?
    .first()
    .and_then(|row| row["at"].as_i64());
    let attempts: Vec<i64> = rows(
        sql,
        "SELECT at FROM repo_read WHERE kind = ? AND at > ?",
        vec![HELD_KIND.into(), (now - HOUR_MS).into()],
    )?
    .iter()
    .map(|row| int(&row["at"]))
    .collect();
    Ok(held_token_read_due_at(
        latest_mint,
        link.verified_at,
        &attempts,
        now,
    ))
}

/// When the ready link is next due its daily read, or `None` without one. Never a time a pass that does nothing would
/// leave in the past: with the hour's read cap used up, not before the oldest counted read is an hour old.
fn daily_due(sql: &SqlStorage, env: &Env, now: i64) -> R<Option<i64>> {
    if !provisioning::enabled(env, sql)? || !provisioning::configured(env, sql) {
        return Ok(None);
    }
    // Test builds read back on a schedule only in a room holding this table, so the many specs that write a ready link
    // by hand, with a check time long past, don't each get an unasked-for read in their alarms. Deployed builds always do.
    #[cfg(feature = "failpoints")]
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_readiness_schedule'",
        vec![],
    )?
    .is_empty()
    {
        return Ok(None);
    }
    let Some(link) = ready_link(sql)? else {
        return Ok(None);
    };
    let due = readiness_due_at(
        link.verified_at,
        changes::last_readiness_read(sql, now)?,
        link.gone_seen_at,
    );
    Ok(Some(match changes::read_cap_frees_at(sql, now)? {
        Some(frees) => due.max(frees),
        None => due,
    }))
}

impl Workspace {
    /// The alarm's part: reads a ready link back once it's due, daily or while a token is held, within each one's cap,
    /// and degrades it only on a definite difference. Before token upkeep in the alarm, so tokens on a link it degrades
    /// are revoked in the same pass.
    pub(super) async fn readiness_upkeep(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? || store::needs_migration(&sql)? {
            return Ok(());
        }
        self.daily_read().await?;
        // After the daily read, which may have found the link right or degraded it: either way this one isn't due then.
        self.held_token_read().await
    }

    async fn daily_read(&self) -> R<()> {
        let sql = self.state.storage().sql();
        let now = now_ms();
        match daily_due(&sql, &self.env, now)? {
            Some(due) if due <= now => {}
            _ => return Ok(()),
        }
        // Without the provisioning App's configuration nothing can be read, so nothing is counted either. `next_due` then
        // says nothing is due, so the alarm doesn't come back for it.
        if !provisioning::configured(&self.env, &sql) {
            return Ok(());
        }
        let Some(link) = ready_link(&sql)? else {
            return Ok(());
        };
        // Counted against the repository's hourly read cap, as the refresh job's reads are. Over it, it waits.
        if !self.in_transaction(move |sql| changes::count_readiness_read(sql, now))? {
            return Ok(());
        }
        let room = rows(&sql, "SELECT id FROM workspace", vec![])?
            .first()
            .and_then(|row| text(&row["id"]))
            .unwrap_or_default();
        let repo_id = link.repo_id;
        match self
            .readiness(repo_id, link.public, &link.default_branch, &room)
            .await
        {
            Readiness::Ready => self.in_transaction(move |sql| {
                exec(
                    sql,
                    "UPDATE repo_link SET verified_at = ? WHERE provider_repo_id = ? AND status = 'ready'",
                    vec![now_ms().into(), repo_id.into()],
                )
            }),
            Readiness::Mismatch(code) => {
                console_log!(
                    "{}",
                    json!({ "event": "repository.readiness", "ws": room, "outcome": "degraded", "reason": code })
                );
                self.in_transaction(move |sql| degrade(sql, repo_id, code, now_ms()))
            }
            Readiness::CouldNotRead(status) => {
                console_error!(
                    "{}",
                    json!({ "event": "repository.readiness", "ws": room, "outcome": "unread", "status": status })
                );
                Ok(())
            }
        }
    }

    /// A read of the ready link while an agent holds a token on it, when `core` says one is due. The attempt is counted
    /// first, in the transaction that checks it's still due, so the hourly cap holds whatever the read comes to.
    async fn held_token_read(&self) -> R<()> {
        let sql = self.state.storage().sql();
        let now = now_ms();
        match held_due(&sql, &self.env, now)? {
            Some(due) if due <= now => {}
            _ => return Ok(()),
        }
        let Some(link) = ready_link(&sql)? else {
            return Ok(());
        };
        let counted = self.in_transaction(move |sql| {
            let Some(link) = ready_link(sql)? else {
                return Ok(false);
            };
            if !held_due_for(sql, &link, now)?.is_some_and(|due| due <= now) {
                return Ok(false);
            }
            exec(
                sql,
                "INSERT INTO repo_read (at, kind, caller) VALUES (?, ?, NULL)",
                vec![now.into(), HELD_KIND.into()],
            )?;
            Ok(true)
        })?;
        if !counted {
            return Ok(());
        }
        let room = rows(&sql, "SELECT id FROM workspace", vec![])?
            .first()
            .and_then(|row| text(&row["id"]))
            .unwrap_or_default();
        let repo_id = link.repo_id;
        let read = self
            .token_read_back(
                &sql,
                &room,
                repo_id,
                link.public,
                &link.default_branch,
                link.stamp,
            )
            .await;
        // A read that passed moves the time the link was last found right, which puts the next read an interval on
        // (and the daily one a day on). A kept read counts from when it was made.
        let found_right = |at: i64| {
            self.in_transaction(move |sql| {
                exec(
                    sql,
                    "UPDATE repo_link SET verified_at = max(COALESCE(verified_at, 0), ?) WHERE provider_repo_id = ? AND status = 'ready'",
                    vec![at.into(), repo_id.into()],
                )
            })
        };
        match read {
            TokenReadBack::Kept { at } => found_right(at),
            TokenReadBack::Read(Readiness::Ready) => found_right(now),
            TokenReadBack::Read(Readiness::Mismatch(code)) => {
                console_log!(
                    "{}",
                    json!({ "event": "repository.readiness", "ws": room, "by": "held_token", "outcome": "degraded", "reason": code })
                );
                self.in_transaction(move |sql| degrade(sql, repo_id, code, now_ms()))
            }
            TokenReadBack::Read(Readiness::CouldNotRead(status)) => {
                console_error!(
                    "{}",
                    json!({ "event": "repository.readiness", "ws": room, "by": "held_token", "outcome": "unread", "status": status })
                );
                Ok(())
            }
        }
    }
}
