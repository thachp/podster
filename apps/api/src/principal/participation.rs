//! An agent's participation policy (M4 step 4), on its Principal: whether its owner allows public claims. The default,
//! with no row, is invitations only (decision 159). Only a person who administers the agent's organization sets it, never
//! the agent, which can't vouch for itself (`podster_policy::public::may_set_participation_policy`).
//!
//! `register_room` checks it before a public claim. It's a pre-check, as the generation is: tightening the policy later
//! doesn't end a claim already made. A disconnect resets it to invitations only, so an owner's consent never outlives the
//! connection it was given for. Every change, the reset included, leaves an audit row with IDs and policy names only.
use super::*;
use podster_policy::public::ParticipationPolicy;

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS participation (id INTEGER PRIMARY KEY CHECK (id = 1), policy TEXT NOT NULL, set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS participation_audit (seq INTEGER PRIMARY KEY, prior TEXT NOT NULL, policy TEXT NOT NULL,
  actor_id TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
";

/// Audit rows kept per agent. Older ones go first, so a flood of changes can't grow the object without end.
const AUDIT_KEPT: i64 = 200;
/// The actor recorded when Podster itself resets the policy.
const SYSTEM: &str = "system";

fn has_tables(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'participation'",
        vec![],
    )?
    .is_empty())
}

fn row(sql: &SqlStorage) -> R<Option<Value>> {
    if !has_tables(sql)? {
        return Ok(None);
    }
    Ok(
        rows(sql, "SELECT policy, set_at FROM participation", vec![])?
            .into_iter()
            .next(),
    )
}

/// The policy now. A missing row, or a value Podster doesn't know, is invitations only, so it fails closed.
pub(super) fn current(sql: &SqlStorage) -> R<ParticipationPolicy> {
    Ok(row(sql)?
        .and_then(|r| {
            r["policy"]
                .as_str()
                .and_then(ParticipationPolicy::from_name)
        })
        .unwrap_or_default())
}

pub(super) fn json(sql: &SqlStorage) -> R<Value> {
    let set_at = row(sql)?.map_or(Value::Null, |r| r["set_at"].clone());
    Ok(json!({ "policy": current(sql)?.name(), "set_at": set_at }))
}

fn write(
    sql: &SqlStorage,
    policy: ParticipationPolicy,
    actor: &str,
    reason: &str,
    now: i64,
) -> R<()> {
    exec(sql, SCHEMA, vec![])?;
    let prior = current(sql)?;
    exec(
        sql,
        "INSERT OR REPLACE INTO participation (id, policy, set_by, set_at) VALUES (1, ?, ?, ?)",
        vec![policy.name().into(), actor.into(), now.into()],
    )?;
    exec(
        sql,
        "INSERT INTO participation_audit (prior, policy, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?)",
        vec![prior.name().into(), policy.name().into(), actor.into(), reason.into(), now.into()],
    )?;
    exec(
        sql,
        "DELETE FROM participation_audit WHERE seq <= (SELECT MAX(seq) FROM participation_audit) - ?",
        vec![AUDIT_KEPT.into()],
    )?;
    Ok(())
}

/// Sets the policy from `{ "policy": "invitations_only" | "public_claims" }` and nothing else. The caller has already
/// checked who may, and that the connection is active. Setting the same value again still records who confirmed it.
pub(super) fn set(sql: &SqlStorage, actor: &str, body: &Value, now: i64) -> R<Value> {
    let fields = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields.keys().any(|k| k != "policy") {
        return Err(ApiError::invalid_argument());
    }
    let policy = body["policy"]
        .as_str()
        .and_then(ParticipationPolicy::from_name)
        .ok_or_else(ApiError::invalid_argument)?;
    write(sql, policy, actor, "owner.set", now)?;
    json(sql)
}

/// Back to invitations only, on a disconnect. Nothing is written for an agent that never had a policy set.
pub(super) fn reset(sql: &SqlStorage, now: i64) -> R<()> {
    if current(sql)? == ParticipationPolicy::InvitationsOnly {
        return Ok(());
    }
    write(
        sql,
        ParticipationPolicy::InvitationsOnly,
        SYSTEM,
        "disconnect",
        now,
    )
}

/// The audit rows, newest first, for the agent's organization's admins.
pub(super) fn audit(sql: &SqlStorage) -> R<Value> {
    if !has_tables(sql)? {
        return Ok(json!({ "entries": [] }));
    }
    let entries = rows(
        sql,
        "SELECT prior, policy, actor_id, reason, created_at FROM participation_audit ORDER BY seq DESC",
        vec![],
    )?;
    Ok(json!({ "entries": entries }))
}
