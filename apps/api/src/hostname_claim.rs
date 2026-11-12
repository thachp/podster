//! Who holds a custom hostname (M6 step 2, ADR 0010's "Custom domains", decision 201).
//!
//! One object for each normalized hostname, named by it. It holds at most one claim that isn't ended, which is what
//! makes one hostname one room's: a D1 row must never decide that. A hostname's suspension lives here too, with no
//! room, so it outlives every claim.
//!
//! **This step adds the class and its state, and nothing else.** Nothing in the API calls it, no route reaches it, and
//! it calls nothing. Its one read answers what it holds, and for a hostname nobody has asked about it answers empty and
//! leaves no state behind. Custom domains (M6 step 8) add the commands: giving a claim to the first room whose proof
//! passed, ending one, and suspending a name.
//!
//! - `hostname`: the name this object is for, written once.
//! - `claim`: every claim there has been. `held` is 1 while a claim is `live` or `ending` and null once `ended`, and it
//!   is unique, so two claims can't hold the name at once. A claim that is `ending` still holds the name: it is freed
//!   only after the custom hostname is read as gone at Cloudflare.
//! - `suspension`: an operator's suspension of the name. While it holds, nobody gets a claim or starts a challenge.
//! - `notice`: what the object owes a room, kept and sent again until the room has answered: that the name was
//!   suspended while that room held it.
//!
//! Logs carry IDs only, and never a hostname.
use crate::error::ApiError;
use crate::store::{exec, int, rows};
use serde_json::{json, Value};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// Forward-only, as the room's are: a change is a new entry, never an edit.
const MIGRATIONS: &[&str] = &["
CREATE TABLE hostname (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE claim (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('live', 'ending', 'ended')),
  held INTEGER UNIQUE CHECK (held = 1), claimed_at INTEGER NOT NULL, proved_at INTEGER, ended_at INTEGER, end_reason TEXT, updated_at INTEGER NOT NULL,
  CHECK ((state = 'ended') = (held IS NULL)), UNIQUE (workspace_id, request_id));
CREATE TABLE suspension (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), reason TEXT NOT NULL, suspended_at INTEGER NOT NULL, lifted_at INTEGER);
CREATE TABLE notice (seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, claim_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, answered_at INTEGER);
"];

/// Whether this object holds anything. This only reads, so asking about an unknown hostname leaves no state.
fn initialized(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
        vec![],
    )?
    .is_empty())
}

/// Applies pending migrations. Callers run this inside a transaction. Nothing but a test calls it until the commands
/// that write a claim exist (M6 step 8).
#[cfg_attr(not(feature = "failpoints"), allow(dead_code))]
fn migrate(sql: &SqlStorage) -> R<()> {
    exec(
        sql,
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
        vec![],
    )?;
    let found = rows(sql, "SELECT version FROM schema_version", vec![])?;
    let current = found.first().map_or(0, |row| int(&row["version"])) as usize;
    for migration in MIGRATIONS.iter().skip(current) {
        exec(sql, migration, vec![])?;
    }
    if found.is_empty() {
        exec(
            sql,
            "INSERT INTO schema_version (version) VALUES (0)",
            vec![],
        )?;
    }
    exec(
        sql,
        "UPDATE schema_version SET version = ?",
        vec![(MIGRATIONS.len() as i64).into()],
    )
}

/// What the object holds: the claim that holds the name, if any, by its IDs, and whether the name is suspended. Never
/// the hostname itself.
fn read(sql: &SqlStorage) -> R<Value> {
    if !initialized(sql)? {
        return Ok(json!({ "claim": null, "suspended": false }));
    }
    let claim = rows(
        sql,
        "SELECT id, workspace_id, request_id, state, claimed_at FROM claim WHERE held = 1",
        vec![],
    )?
    .into_iter()
    .next()
    .unwrap_or(Value::Null);
    let suspended = !rows(
        sql,
        "SELECT 1 AS held FROM suspension WHERE lifted_at IS NULL",
        vec![],
    )?
    .is_empty();
    Ok(json!({ "claim": claim, "suspended": suspended }))
}

#[durable_object]
pub struct HostnameClaim {
    state: State,
}

impl HostnameClaim {
    fn dispatch(&self, req: &Request) -> R<Value> {
        let sql = self.state.storage().sql();
        let url = req.url()?;
        match (req.method(), url.path()) {
            (Method::Get, "/internal/state") => read(&sql),
            // Test builds only: applies the schema, so a test can show what it holds and refuses. A deployment's object
            // gets its schema from the first command that writes a claim, which doesn't exist yet.
            #[cfg(feature = "failpoints")]
            (Method::Post, "/internal/test-migrate") => {
                crate::store::transaction_sync(&self.state, move || migrate(&sql))?;
                Ok(json!({ "migrated": true }))
            }
            _ => Err(ApiError::not_found()),
        }
    }
}

impl DurableObject for HostnameClaim {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        match self.dispatch(&req) {
            Ok(value) => Response::from_json(&value),
            Err(error) => error.into_response(),
        }
    }
}
