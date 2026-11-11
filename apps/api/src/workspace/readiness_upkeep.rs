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
use super::merges::{degrade, Readiness};
use super::*;
use podster_core::provisioning::readiness_due_at;

/// The ready link, as this job needs it: its repository, whether it's public, its default branch and when it was last
/// found exactly right.
struct Linked {
    repo_id: i64,
    public: bool,
    default_branch: String,
    verified_at: i64,
    /// When the repository was first seen gone, if a second look is owed.
    gone_seen_at: Option<i64>,
}

fn ready_link(sql: &SqlStorage) -> R<Option<Linked>> {
    Ok(rows(
        sql,
        "SELECT provider_repo_id, visibility, default_branch, verified_at, created_at, gone_seen_at FROM repo_link WHERE provider = 'github' AND status = 'ready'",
        vec![],
    )?
    .first()
    .map(|row| Linked {
        repo_id: int(&row["provider_repo_id"]),
        public: row["visibility"].as_str() == Some("public"),
        default_branch: text(&row["default_branch"]).unwrap_or_default(),
        verified_at: row["verified_at"]
            .as_i64()
            .unwrap_or_else(|| int(&row["created_at"])),
        gone_seen_at: row["gone_seen_at"].as_i64(),
    }))
}

/// When the room's ready link is next due its scheduled read, or `None` without one, with the switch off, or without
/// provisioning's configuration, when no read could be made. Never a time a pass that does nothing would leave in the
/// past: with the hour's read cap used up, not before the oldest counted read is an hour old.
pub(super) fn next_due(sql: &SqlStorage, env: &Env, now: i64) -> R<Option<i64>> {
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
    /// The alarm's part: reads a ready link back once it's due, within the read cap, and degrades it only on a definite
    /// difference. Before token upkeep in the alarm, so tokens on a link it degrades are revoked in the same pass.
    pub(super) async fn readiness_upkeep(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? || store::needs_migration(&sql)? {
            return Ok(());
        }
        let now = now_ms();
        match next_due(&sql, &self.env, now)? {
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
}
