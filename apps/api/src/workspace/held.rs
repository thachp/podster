//! What a room does when its migration fails, so removing someone's access still reaches it.
//!
//! A failed migration rolls back, and every request tries it again, so until a fixed release ships the room answers each one
//! with an error and nobody can act in it. Before this, a disconnect's fence and an organization departure failed the same way:
//! the agent stayed disconnecting everywhere and the departure retried without end. Their own code reads tables and columns
//! from every migration, so it can't safely run against a schema whose migration just failed.
//!
//! So instead they're held. The room records each one durably, outside the migrations, and answers that it has it. The next
//! time the room migrates, it applies everything held, in order, through the same code, before it does anything else. Every
//! migration goes through `migrate_and_replay`, so no request can act in the room between its recovery and the replay. If
//! the replay fails, the room keeps failing closed, and holds what comes next behind it.
//!
//! What's held is IDs and numbers only. Each failure logs a code, never the error's text, and counts toward a durable total.
use super::*;

/// Kept outside `store::MIGRATIONS`, like `schema_version`, so they exist whatever state the room's schema is in.
const HELD_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS held_access (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, body_json TEXT NOT NULL, held_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS migration_failure (id INTEGER PRIMARY KEY CHECK (id = 1), failures INTEGER NOT NULL, last_failed_at INTEGER NOT NULL, failing INTEGER NOT NULL DEFAULT 1);
";
/// More than any real backlog: each fence or departure is held once, because the sender stops once it's answered. Past this the
/// room refuses with an error and drops nothing, so the sender keeps retrying, and the room stays failing closed.
const MAX_HELD: i64 = 1_000;

pub(super) const HELD_FENCE: &str = "fence";
pub(super) const HELD_DEPARTURE: &str = "org_departure";

fn held_table_exists(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'held_access'",
        vec![],
    )?
    .is_empty())
}

/// Whether two held changes are the same one, so the later can take the earlier's place: a fence for the same agent, or a
/// departure of the same person from the same organization. Both effects are monotonic, so keeping one is the same as
/// applying both in order.
fn same_change(kind: &str, held: &Value, body: &Value) -> bool {
    match kind {
        HELD_FENCE => held["principal"] == body["principal"],
        HELD_DEPARTURE => held["person"] == body["person"] && held["org"] == body["org"],
        _ => false,
    }
}

/// The later of two of the same held change: the higher fence floor, or the later departure.
fn merged(kind: &str, held: &Value, body: &Value) -> Value {
    let field = if kind == HELD_FENCE {
        "floor"
    } else {
        "left_at"
    };
    if body[field].as_i64() > held[field].as_i64() {
        body.clone()
    } else {
        held.clone()
    }
}

impl Workspace {
    /// Whether the room can't yet be trusted to say who's in it: changes to access are held, or its migration has failed and
    /// hasn't succeeded since. A migration that's only due isn't either: the room's next request runs it, and until then what
    /// it holds is as true as before. The alarm never migrates, so waiting on that alone would hold a quiet room's outbox for good.
    pub(super) fn access_changes_pending(&self, sql: &SqlStorage) -> R<bool> {
        if self.held_clear.get() || !held_table_exists(sql)? {
            return Ok(false);
        }
        let held = !rows(sql, "SELECT seq FROM held_access LIMIT 1", vec![])?.is_empty();
        let failing = !rows(
            sql,
            "SELECT id FROM migration_failure WHERE failing = 1",
            vec![],
        )?
        .is_empty();
        Ok(held || failing)
    }

    /// The one way a room migrates after it's created: migrate if it needs to, then apply what was held while it couldn't.
    pub(super) fn migrate_and_replay(&self) -> R<()> {
        let sql = self.state.storage().sql();
        let result = self.migrate_then_replay(&sql);
        if let Err(error) = &result {
            self.note_migration_failure(&sql, error);
        }
        result
    }

    fn migrate_then_replay(&self, sql: &SqlStorage) -> R<()> {
        if store::needs_migration(sql)? {
            let migrating = sql.clone();
            transaction_sync(&self.state, move || store::migrate(&migrating))?;
        }
        if self.held_clear.get() {
            return Ok(());
        }
        if held_table_exists(sql)? {
            let held = rows(
                sql,
                "SELECT seq, kind, body_json FROM held_access ORDER BY seq",
                vec![],
            )?;
            for entry in held {
                let kind = entry["kind"].clone();
                let replaying = sql.clone();
                transaction_sync(&self.state, move || {
                    let body: Value =
                        serde_json::from_str(entry["body_json"].as_str().unwrap_or_default())?;
                    let now = now_ms();
                    match entry["kind"].as_str() {
                        Some(HELD_FENCE) => fence_effect(
                            &replaying,
                            &required(&body, "principal")?,
                            body["floor"].as_i64().unwrap_or_default(),
                            now,
                        )?,
                        Some(HELD_DEPARTURE) => departure_effect(&replaying, &body, now)?,
                        _ => return Err(ApiError::internal("unknown held access change")),
                    }
                    exec(
                        &replaying,
                        "DELETE FROM held_access WHERE seq = ?",
                        vec![int(&entry["seq"]).into()],
                    )
                })?;
                console_log!(
                    "{}",
                    json!({ "at": "room.held_access_applied", "kind": kind })
                );
            }
            // Migrated and replayed, so the room can be trusted to say who's in it again.
            exec(
                sql,
                "UPDATE migration_failure SET failing = 0 WHERE failing = 1",
                vec![],
            )?;
        }
        self.held_clear.set(true);
        Ok(())
    }

    /// Answers a fence or a departure the room couldn't apply, once it's held where a restart can't lose it.
    pub(super) fn hold(&self, kind: &'static str, body: Value, answer: Value) -> R<Value> {
        let sql = self.state.storage().sql();
        transaction_sync(&self.state, move || {
            exec(&sql, HELD_SCHEMA, vec![])?;
            // One entry for each agent's fence and each person's departure from an organization, so repeated disconnects
            // can't fill the cap and push someone else's departure out. It keeps its place in the order.
            let same = rows(
                &sql,
                "SELECT seq, body_json FROM held_access WHERE kind = ?",
                vec![kind.into()],
            )?;
            for entry in &same {
                let held: Value =
                    serde_json::from_str(entry["body_json"].as_str().unwrap_or_default())?;
                if same_change(kind, &held, &body) {
                    return exec(
                        &sql,
                        "UPDATE held_access SET body_json = ? WHERE seq = ?",
                        vec![
                            merged(kind, &held, &body).to_string().into(),
                            int(&entry["seq"]).into(),
                        ],
                    );
                }
            }
            let count = rows(&sql, "SELECT count(*) AS n FROM held_access", vec![])?;
            if count.first().map_or(0, |row| int(&row["n"])) >= MAX_HELD {
                // Refused, never dropped: the sender sees no acknowledgment and keeps retrying, and the room stays closed.
                console_error!(
                    "{}",
                    json!({ "at": "room.held_access_full", "kind": kind, "held": MAX_HELD })
                );
                return Err(ApiError::internal("too many held access changes"));
            }
            exec(
                &sql,
                "INSERT INTO held_access (kind, body_json, held_at) VALUES (?, ?, ?)",
                vec![kind.into(), body.to_string().into(), now_ms().into()],
            )
        })?;
        self.held_clear.set(false);
        console_error!("{}", json!({ "at": "room.access_held", "kind": kind }));
        Ok(answer)
    }

    /// A code and a count, never the error's text, which can name a table or quote a statement. Its own write, after the
    /// failed one rolled back. If this fails too, the log line is all there is.
    fn note_migration_failure(&self, sql: &SqlStorage, error: &ApiError) {
        // The next success has to look again, to clear this and replay anything held meanwhile.
        self.held_clear.set(false);
        let counting = sql.clone();
        let failures = transaction_sync(&self.state, move || {
            exec(&counting, HELD_SCHEMA, vec![])?;
            exec(&counting, "INSERT INTO migration_failure (id, failures, last_failed_at, failing) VALUES (1, 1, ?, 1)
              ON CONFLICT (id) DO UPDATE SET failures = failures + 1, last_failed_at = excluded.last_failed_at, failing = 1", vec![now_ms().into()])
        })
        .and_then(|()| rows(sql, "SELECT failures FROM migration_failure", vec![]))
        .ok()
        .and_then(|found| found.first().map(|row| int(&row["failures"])));
        let room = rows(sql, "SELECT id FROM workspace", vec![])
            .ok()
            .and_then(|found| found.first().and_then(|row| text(&row["id"])));
        console_error!(
            "{}",
            json!({ "at": "room.migration_failed", "room": room, "code": error.code().unwrap_or("internal"), "failures": failures })
        );
    }
}
