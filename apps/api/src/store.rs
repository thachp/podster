//! SQLite access for a workspace: schema, row mapping and writes shared by commands.
use crate::error::ApiError;
use podster_core::{handoff_of, Decision, EventKind, HandoffKind, Task, TaskStatus};
use podster_policy::{ArtifactScope, ConversationScope, ReviewScope, Scopes, TaskScope};
use serde_json::Value;
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use worker::{SqlStorage, SqlStorageValue as V, State};

type R<T> = std::result::Result<T, ApiError>;

const MIGRATIONS: &[&str] = &["
CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_org_id TEXT NOT NULL, owner_person_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE member (principal_id TEXT PRIMARY KEY, kind TEXT NOT NULL, org_id TEXT NOT NULL, role TEXT NOT NULL,
  guest_can_create INTEGER NOT NULL DEFAULT 0, join_generation INTEGER, added_by TEXT NOT NULL, added_at INTEGER NOT NULL,
  revoked_at INTEGER, revocation_reason TEXT, owner_consented_at INTEGER);
CREATE TABLE principal_fence (principal_id TEXT PRIMARY KEY, min_generation INTEGER NOT NULL);
CREATE TABLE invitation (id TEXT PRIMARY KEY, invited_org_id TEXT, role TEXT NOT NULL, guest_can_create INTEGER NOT NULL DEFAULT 0, token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, accepted_by TEXT, accepted_request TEXT, accepted_response TEXT);
CREATE TABLE index_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, principal_id TEXT NOT NULL, org_id TEXT NOT NULL, role TEXT, removed INTEGER NOT NULL);
CREATE TABLE task (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL,
  acceptance_criteria TEXT, requester_id TEXT NOT NULL, assignee_id TEXT, reviewer_id TEXT NOT NULL, status TEXT NOT NULL,
  version INTEGER NOT NULL, due_at INTEGER, follow_up_of TEXT, has_linked_repository INTEGER NOT NULL DEFAULT 0,
  submission_no INTEGER NOT NULL DEFAULT 0, submission_commit TEXT, assignee_departed INTEGER NOT NULL DEFAULT 0,
  needs_reviewer INTEGER NOT NULL DEFAULT 0, needs_requester INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX task_status ON task (status);
CREATE TABLE submission (task_id TEXT NOT NULL, submission_no INTEGER NOT NULL, task_version INTEGER NOT NULL, note TEXT, commit_sha TEXT,
  submitted_by TEXT NOT NULL, submitted_org TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (task_id, submission_no));
CREATE TABLE artifact (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, submission_no INTEGER NOT NULL, uri TEXT NOT NULL, label TEXT NOT NULL,
  submitted_by TEXT NOT NULL, submitted_org TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX artifact_task ON artifact (task_id, submission_no);
CREATE TABLE message (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_org TEXT NOT NULL,
  body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX message_task ON message (task_id, seq);
CREATE TABLE event (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, type TEXT NOT NULL, actor_id TEXT NOT NULL, actor_org TEXT, task_id TEXT,
  reason TEXT, prior_status TEXT, new_status TEXT, task_version INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX event_task ON event (task_id, seq);
CREATE TABLE outbox (event_id TEXT NOT NULL, recipient_principal_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, recipient_principal_id));
CREATE TABLE idempotency (actor_id TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (actor_id, key));
CREATE TABLE audit_event (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL, outcome TEXT NOT NULL,
  reason_code TEXT, prior_json TEXT, new_json TEXT, policy_version INTEGER NOT NULL, created_at INTEGER NOT NULL);
", "
ALTER TABLE workspace ADD COLUMN owner_left_at INTEGER;
ALTER TABLE workspace ADD COLUMN owner_since INTEGER;
", "
CREATE TABLE org_revocation (org_id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL);
", "
CREATE TABLE denial (day INTEGER NOT NULL, actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL, action TEXT NOT NULL, code TEXT NOT NULL,
  count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, first_actor_id TEXT NOT NULL, last_actor_id TEXT NOT NULL,
  PRIMARY KEY (day, actor_id, actor_kind, action, code));
CREATE INDEX denial_last_at ON denial (last_at);
", "
UPDATE workspace SET owner_since = created_at WHERE owner_since IS NULL;
INSERT INTO index_outbox (principal_id, org_id, role, removed) SELECT owner_person_id, owner_org_id, 'owner', 0 FROM workspace WHERE owner_left_at IS NOT NULL;
", "
ALTER TABLE workspace ADD COLUMN goal TEXT;
ALTER TABLE workspace ADD COLUMN context TEXT;
ALTER TABLE workspace ADD COLUMN brief_by TEXT;
UPDATE member SET guest_can_create = 0 WHERE role <> 'guest';
UPDATE invitation SET guest_can_create = 0 WHERE role <> 'guest';
CREATE TABLE access_grant (principal_id TEXT PRIMARY KEY, tasks TEXT NOT NULL, artifacts TEXT NOT NULL, conversations TEXT NOT NULL, review TEXT NOT NULL,
  granted_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
INSERT INTO access_grant (principal_id, tasks, artifacts, conversations, review, granted_by, updated_at)
  SELECT principal_id,
    CASE WHEN role = 'guest' AND guest_can_create <> 0 THEN 'own_create' WHEN role = 'guest' THEN 'own' ELSE 'all_create' END,
    CASE WHEN role = 'guest' THEN 'own' ELSE 'all' END,
    CASE WHEN role = 'guest' THEN 'own' ELSE 'all' END,
    'when_named', added_by, added_at
  FROM member;
", "
CREATE TABLE work_role (id TEXT PRIMARY KEY, title TEXT NOT NULL, responsibilities TEXT NOT NULL, capacity INTEGER NOT NULL, preset TEXT NOT NULL,
  is_lead INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER);
CREATE UNIQUE INDEX one_lead ON work_role (is_lead) WHERE is_lead = 1 AND closed_at IS NULL;
CREATE TABLE role_claim (id TEXT PRIMARY KEY, role_id TEXT NOT NULL, principal_id TEXT NOT NULL, status TEXT NOT NULL, claimed_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT,
  copied_preset TEXT NOT NULL, grant_version INTEGER NOT NULL, prior_role TEXT NOT NULL, prior_tasks TEXT NOT NULL, prior_artifacts TEXT NOT NULL, prior_conversations TEXT NOT NULL, prior_review TEXT NOT NULL);
CREATE UNIQUE INDEX one_claim_per_principal ON role_claim (principal_id) WHERE status = 'active';
CREATE INDEX role_claim_role ON role_claim (role_id, status);
CREATE TABLE role_invite (role_id TEXT NOT NULL, principal_id TEXT NOT NULL, invited_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (role_id, principal_id));
CREATE INDEX role_invite_principal ON role_invite (principal_id);
ALTER TABLE invitation ADD COLUMN work_role_id TEXT;
", "
ALTER TABLE workspace ADD COLUMN require_person_review INTEGER NOT NULL DEFAULT 0;
", "
CREATE TABLE handoff (seq INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX handoff_edge ON handoff (from_id, to_id, kind, created_at);
CREATE INDEX handoff_line ON handoff (from_id, to_id, seq);
CREATE INDEX handoff_task ON handoff (task_id);
CREATE INDEX event_actor ON event (actor_id, created_at);
", "
CREATE TABLE relationship (id TEXT PRIMARY KEY, from_role_id TEXT NOT NULL, to_role_id TEXT NOT NULL, label TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER, ended_by TEXT, end_reason TEXT);
CREATE UNIQUE INDEX relationship_line ON relationship (from_role_id, to_role_id) WHERE ended_at IS NULL;
CREATE INDEX relationship_to ON relationship (to_role_id) WHERE ended_at IS NULL;
CREATE INDEX relationship_shown ON relationship (created_at, id) WHERE ended_at IS NULL;
", "
ALTER TABLE workspace ADD COLUMN plan_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace ADD COLUMN plan_changed_at INTEGER;
ALTER TABLE task ADD COLUMN duration_days INTEGER;
CREATE TABLE task_dependency (successor_id TEXT NOT NULL, predecessor_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (successor_id, predecessor_id)) WITHOUT ROWID;
CREATE INDEX task_requester ON task (requester_id);
CREATE INDEX task_assignee ON task (assignee_id);
CREATE INDEX task_reviewer ON task (reviewer_id);
CREATE TABLE task_plan_change (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, actor_id TEXT NOT NULL, plan_revision INTEGER NOT NULL, old_duration_days INTEGER, new_duration_days INTEGER, added TEXT NOT NULL, removed TEXT NOT NULL, created_at INTEGER NOT NULL);
", "
ALTER TABLE event ADD COLUMN subject_id TEXT;
", "
ALTER TABLE task ADD COLUMN approved_submission_no INTEGER;
UPDATE task SET approved_submission_no = submission_no WHERE status = 'completed' AND submission_no > 0;
", "
ALTER TABLE workspace ADD COLUMN plan_start_date TEXT;
ALTER TABLE workspace ADD COLUMN plan_timezone TEXT;
", "
CREATE TABLE stored_object (id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, state TEXT NOT NULL, media_type TEXT, object_key TEXT, attempt_id TEXT, token_hash TEXT NOT NULL, uploaded_by TEXT NOT NULL, uploader_json TEXT, created_at INTEGER NOT NULL, upload_expires_at INTEGER NOT NULL, stored_at INTEGER, scanning_since INTEGER);
CREATE INDEX stored_object_space ON stored_object (state, upload_expires_at, size);
", "
ALTER TABLE stored_object ADD COLUMN scan_reason TEXT;
ALTER TABLE stored_object ADD COLUMN scan_sha256 TEXT;
ALTER TABLE stored_object ADD COLUMN scan_database_json TEXT;
ALTER TABLE stored_object ADD COLUMN scanned_at INTEGER;
CREATE INDEX stored_object_scanning ON stored_object (state, scanning_since);
ALTER TABLE workspace ADD COLUMN audit_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE audit_event ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
UPDATE audit_event SET seq = policy_version;
UPDATE workspace SET audit_seq = COALESCE((SELECT MAX(seq) FROM audit_event), 0);
CREATE UNIQUE INDEX audit_event_seq ON audit_event (seq);
", "
ALTER TABLE task ADD COLUMN submission_files INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stored_object ADD COLUMN for_task TEXT;
CREATE INDEX stored_object_task ON stored_object (for_task) WHERE for_task IS NOT NULL;
CREATE TABLE submission_file (task_id TEXT NOT NULL, submission_no INTEGER NOT NULL, object_id TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  label TEXT NOT NULL, submitted_by TEXT NOT NULL, submitted_org TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (task_id, submission_no, object_id)) WITHOUT ROWID;
CREATE INDEX submission_file_object ON submission_file (object_id);
ALTER TABLE task ADD COLUMN left_accepted_at INTEGER;
", "
CREATE TABLE asset_link (task_id TEXT NOT NULL, object_id TEXT NOT NULL, linked_by TEXT NOT NULL, linked_at INTEGER NOT NULL, PRIMARY KEY (task_id, object_id)) WITHOUT ROWID;
CREATE INDEX asset_link_object ON asset_link (object_id, task_id);
", "
ALTER TABLE stored_object ADD COLUMN removed_at INTEGER;
ALTER TABLE stored_object ADD COLUMN removed_by TEXT;
ALTER TABLE stored_object ADD COLUMN removed_by_kind TEXT;
ALTER TABLE stored_object ADD COLUMN removed_from TEXT;
ALTER TABLE stored_object ADD COLUMN attempt_started_at INTEGER;
ALTER TABLE stored_object ADD COLUMN purge_due_at INTEGER;
CREATE INDEX stored_object_abandoned ON stored_object (upload_expires_at) WHERE state = 'uploading';
CREATE INDEX stored_object_purge ON stored_object (purge_due_at) WHERE purge_due_at IS NOT NULL;
CREATE TABLE storage_sweep (id INTEGER PRIMARY KEY CHECK (id = 1), due_at INTEGER, cursor TEXT, cycle_due_at INTEGER, settles_at INTEGER);
INSERT INTO storage_sweep (id, due_at, settles_at) SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM stored_object WHERE object_key IS NOT NULL) THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 3600000 END, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 3600000;
", "
CREATE TABLE expected_output (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, removed_at INTEGER, removed_by TEXT, current_task_id TEXT, current_submission_no INTEGER, current_approved_at INTEGER);
CREATE INDEX expected_output_shown ON expected_output (created_at, id) WHERE removed_at IS NULL;
CREATE TABLE expected_output_version (seq INTEGER PRIMARY KEY AUTOINCREMENT, output_id TEXT NOT NULL, task_id TEXT NOT NULL, submission_no INTEGER NOT NULL,
  approved_at INTEGER NOT NULL, approved_by TEXT NOT NULL, UNIQUE (output_id, task_id, submission_no));
CREATE INDEX expected_output_history ON expected_output_version (output_id, seq);
ALTER TABLE task ADD COLUMN expected_output_id TEXT;
CREATE INDEX task_expected_output ON task (expected_output_id) WHERE expected_output_id IS NOT NULL;
", "
ALTER TABLE stored_object ADD COLUMN submitted_at INTEGER;
UPDATE stored_object SET submitted_at = (SELECT MIN(s.created_at) FROM submission_file s WHERE s.object_id = stored_object.id) WHERE EXISTS (SELECT 1 FROM submission_file s WHERE s.object_id = stored_object.id);
CREATE INDEX stored_object_unsubmitted ON stored_object (for_task) WHERE for_task IS NOT NULL AND submitted_at IS NULL AND state <> 'removed';
"];

pub fn int(value: &Value) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|f| f as i64))
        .unwrap_or(0)
}

pub fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

pub fn opt(value: &Option<String>) -> V {
    match value {
        Some(v) => V::from(v.as_str()),
        None => V::Null,
    }
}

/// SQLite has no boolean type, and values bound as booleans don't read back as 0 or 1, so flags bind as integers.
pub fn flag(value: bool) -> V {
    V::from(i64::from(value))
}

fn opt_int(value: Option<i64>) -> V {
    value.map_or(V::Null, V::from)
}

pub fn rows(sql: &SqlStorage, query: &str, bindings: Vec<V>) -> R<Vec<Value>> {
    Ok(sql.exec(query, bindings)?.to_array::<Value>()?)
}

pub fn exec(sql: &SqlStorage, query: &str, bindings: Vec<V>) -> R<()> {
    sql.exec(query, bindings)?;
    Ok(())
}

/// Whether this object has been created. This only reads, so a request for an unknown room leaves no state.
pub fn is_initialized(sql: &SqlStorage) -> R<bool> {
    let tables = rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
        vec![],
    )?;
    Ok(!tables.is_empty())
}

/// Whether migrations are pending. This only reads, so queries stay read-only.
pub fn needs_migration(sql: &SqlStorage) -> R<bool> {
    let found = rows(sql, "SELECT version FROM schema_version", vec![])?;
    Ok(found.first().map_or(0, |r| int(&r["version"])) < MIGRATIONS.len() as i64)
}

/// Applies pending migrations. Callers run this inside a transaction, so a failed migration leaves nothing behind.
pub fn migrate(sql: &SqlStorage) -> R<()> {
    exec(
        sql,
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
        vec![],
    )?;
    let found = rows(sql, "SELECT version FROM schema_version", vec![])?;
    let current = found.first().map_or(0, |r| int(&r["version"])) as usize;
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

/// A current participant's kind and role, from authoritative state.
pub fn participant(sql: &SqlStorage, id: &str) -> R<Option<(String, String)>> {
    let room = rows(
        sql,
        "SELECT owner_person_id, owner_left_at FROM workspace",
        vec![],
    )?;
    if room.first().and_then(|r| r["owner_person_id"].as_str()) == Some(id) {
        // An owner who left the organization is told nothing and can't be given work. Only recovery changes that.
        if room.first().is_some_and(|r| !r["owner_left_at"].is_null()) {
            return Ok(None);
        }
        return Ok(Some(("person".to_string(), "owner".to_string())));
    }
    let found = rows(
        sql,
        "SELECT kind, role FROM member WHERE principal_id = ? AND revoked_at IS NULL",
        vec![id.into()],
    )?;
    Ok(found.first().map(|m| {
        (
            text(&m["kind"]).unwrap_or_default(),
            text(&m["role"]).unwrap_or_default(),
        )
    }))
}

/// Someone's stored access in this room. With no grant they get the narrowest, so a missing row can't widen anything.
pub fn granted_scopes(sql: &SqlStorage, id: &str) -> R<Scopes> {
    let found = rows(
        sql,
        "SELECT tasks, artifacts, conversations, review FROM access_grant WHERE principal_id = ?",
        vec![id.into()],
    )?;
    let Some(row) = found.first() else {
        return Ok(Scopes::PUBLIC_PARTICIPANT);
    };
    scopes_from(row, "")
}

/// Reads four scope columns from a row, under an optional prefix.
pub fn scopes_from(row: &Value, prefix: &str) -> R<Scopes> {
    let bad = || ApiError::internal("bad access grant");
    let column = |name: &str| row[format!("{prefix}{name}")].as_str().map(str::to_string);
    Ok(Scopes {
        tasks: column("tasks")
            .as_deref()
            .and_then(TaskScope::from_name)
            .ok_or_else(bad)?,
        artifacts: column("artifacts")
            .as_deref()
            .and_then(ArtifactScope::from_name)
            .ok_or_else(bad)?,
        conversations: column("conversations")
            .as_deref()
            .and_then(ConversationScope::from_name)
            .ok_or_else(bad)?,
        review: column("review")
            .as_deref()
            .and_then(ReviewScope::from_name)
            .ok_or_else(bad)?,
    })
}

/// Records a handoff with its event, so a collaboration line says what happened, whoever holds the task later.
pub fn record_handoff(
    sql: &SqlStorage,
    from: &str,
    to: &str,
    kind: HandoffKind,
    task: &str,
    now: i64,
) -> R<()> {
    exec(
        sql,
        "INSERT INTO handoff (from_id, to_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, ?)",
        vec![
            from.into(),
            to.into(),
            kind.name().into(),
            task.into(),
            now.into(),
        ],
    )
}

/// Whether this room requires a person to review (decision 5).
pub fn requires_person_review(sql: &SqlStorage) -> R<bool> {
    Ok(
        rows(sql, "SELECT require_person_review FROM workspace", vec![])?
            .first()
            .is_some_and(|room| int(&room["require_person_review"]) != 0),
    )
}

/// How many times someone's grant has been written, so a change can be noticed even if it ends on the same values.
pub fn grant_version(sql: &SqlStorage, id: &str) -> R<i64> {
    Ok(rows(
        sql,
        "SELECT version FROM access_grant WHERE principal_id = ?",
        vec![id.into()],
    )?
    .first()
    .map_or(0, |row| int(&row["version"])))
}

/// Sets someone's access in the caller's transaction, moving the grant's own version.
pub fn write_grant(
    sql: &SqlStorage,
    principal: &str,
    scopes: Scopes,
    granted_by: &str,
    now: i64,
) -> R<()> {
    exec(sql, "INSERT INTO access_grant (principal_id, tasks, artifacts, conversations, review, granted_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (principal_id) DO UPDATE SET tasks = excluded.tasks, artifacts = excluded.artifacts, conversations = excluded.conversations, review = excluded.review,
        granted_by = excluded.granted_by, version = version + 1, updated_at = excluded.updated_at", vec![
        principal.into(), scopes.tasks.name().into(), scopes.artifacts.name().into(), scopes.conversations.name().into(), scopes.review.name().into(), granted_by.into(), now.into(),
    ])
}

pub fn task_from_row(row: &Value) -> R<Task> {
    let status = row["status"]
        .as_str()
        .and_then(TaskStatus::from_name)
        .ok_or_else(|| ApiError::internal("bad task status"))?;
    Ok(Task {
        id: text(&row["id"]).unwrap_or_default(),
        title: text(&row["title"]).unwrap_or_default(),
        instructions: text(&row["instructions"]).unwrap_or_default(),
        acceptance_criteria: text(&row["acceptance_criteria"]),
        requester: text(&row["requester_id"]).unwrap_or_default(),
        assignee: text(&row["assignee_id"]),
        reviewer: text(&row["reviewer_id"]).unwrap_or_default(),
        status,
        version: int(&row["version"]) as u64,
        due_at: row["due_at"].is_number().then(|| int(&row["due_at"])),
        follow_up_of: text(&row["follow_up_of"]),
        has_linked_repository: int(&row["has_linked_repository"]) != 0,
        submission_no: int(&row["submission_no"]) as u32,
        submission_commit: text(&row["submission_commit"]),
        approved_submission_no: row["approved_submission_no"]
            .is_number()
            .then(|| int(&row["approved_submission_no"]) as u32),
        submission_files: int(&row["submission_files"]).max(0) as u32,
        assignee_departed: int(&row["assignee_departed"]) != 0,
        needs_reviewer: int(&row["needs_reviewer"]) != 0,
        needs_requester: int(&row["needs_requester"]) != 0,
    })
}

pub fn load_task(sql: &SqlStorage, id: &str) -> R<Option<Task>> {
    rows(sql, "SELECT * FROM task WHERE id = ?", vec![id.into()])?
        .first()
        .map(task_from_row)
        .transpose()
}

pub fn insert_task(sql: &SqlStorage, t: &Task, now: i64) -> R<()> {
    exec(sql, "INSERT INTO task (id, title, instructions, acceptance_criteria, requester_id, assignee_id, reviewer_id, status, version, due_at, follow_up_of, has_linked_repository, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", vec![
        t.id.as_str().into(), t.title.as_str().into(), t.instructions.as_str().into(), opt(&t.acceptance_criteria), t.requester.as_str().into(),
        opt(&t.assignee), t.reviewer.as_str().into(), t.status.name().into(), (t.version as i64).into(), opt_int(t.due_at), opt(&t.follow_up_of),
        flag(t.has_linked_repository), now.into(), now.into(),
    ])
}

/// Every change to a task's status goes through here. `left_accepted_at` is when it last moved out of `accepted`, and is cleared
/// when it moves back in, so changes requested restarts the clock. Step 8's sweep reads it to clear files uploaded for the task
/// that no submission named (decision 98). The `CASE` reads the row as it was before this update.
pub fn save_task(sql: &SqlStorage, t: &Task, now: i64) -> R<()> {
    exec(sql, "UPDATE task SET left_accepted_at = CASE WHEN ?1 = 'accepted' THEN NULL WHEN status = 'accepted' THEN ?2 ELSE left_accepted_at END WHERE id = ?3",
        vec![t.status.name().into(), now.into(), t.id.as_str().into()])?;
    exec(sql, "UPDATE task SET title = ?, instructions = ?, acceptance_criteria = ?, requester_id = ?, assignee_id = ?, reviewer_id = ?, status = ?, version = ?, due_at = ?,
      submission_no = ?, submission_commit = ?, approved_submission_no = ?, submission_files = ?, assignee_departed = ?, needs_reviewer = ?, needs_requester = ?, updated_at = ? WHERE id = ?", vec![
        t.title.as_str().into(), t.instructions.as_str().into(), opt(&t.acceptance_criteria), t.requester.as_str().into(), opt(&t.assignee), t.reviewer.as_str().into(),
        t.status.name().into(), (t.version as i64).into(), opt_int(t.due_at), i64::from(t.submission_no).into(), opt(&t.submission_commit), t.approved_submission_no.map_or(V::Null, |no| V::from(i64::from(no))), i64::from(t.submission_files).into(), flag(t.assignee_departed),
        flag(t.needs_reviewer), flag(t.needs_requester), now.into(), t.id.as_str().into(),
    ])
}

/// Details recorded with a task transition.
pub struct Transition<'a> {
    pub reason: Option<&'a str>,
    pub prior_status: Option<&'a str>,
    pub new_status: Option<&'a str>,
    pub task_version: Option<u64>,
}

impl Transition<'_> {
    pub const NONE: Transition<'static> = Transition {
        reason: None,
        prior_status: None,
        new_status: None,
        task_version: None,
    };
}

/// Records an event and queues delivery to exactly these recipients, in the caller's transaction.
pub fn record_event(
    sql: &SqlStorage,
    kind: &str,
    actor: &str,
    task_id: Option<&str>,
    transition: &Transition,
    recipients: impl IntoIterator<Item = String>,
    now: i64,
) -> R<()> {
    record_event_about(sql, kind, actor, None, task_id, transition, recipients, now)
}

/// The same, naming who the event is about, as an ID, which is what lets someone limited see a notice about themselves.
#[allow(clippy::too_many_arguments)]
pub fn record_event_about(
    sql: &SqlStorage,
    kind: &str,
    actor: &str,
    subject: Option<&str>,
    task_id: Option<&str>,
    transition: &Transition,
    recipients: impl IntoIterator<Item = String>,
    now: i64,
) -> R<()> {
    let event_id = format!("evt_{}", uuid::Uuid::new_v4().simple());
    let actor_org = {
        let room = rows(
            sql,
            "SELECT owner_person_id, owner_org_id FROM workspace",
            vec![],
        )?;
        match room.first() {
            Some(r) if r["owner_person_id"].as_str() == Some(actor) => text(&r["owner_org_id"]),
            _ => rows(
                sql,
                "SELECT org_id FROM member WHERE principal_id = ?",
                vec![actor.into()],
            )?
            .first()
            .and_then(|m| text(&m["org_id"])),
        }
    };
    exec(sql, "INSERT INTO event (id, type, actor_id, actor_org, task_id, reason, prior_status, new_status, task_version, created_at, subject_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", vec![
        event_id.as_str().into(), kind.into(), actor.into(), opt(&actor_org), task_id.map_or(V::Null, V::from), transition.reason.map_or(V::Null, V::from),
        transition.prior_status.map_or(V::Null, V::from), transition.new_status.map_or(V::Null, V::from),
        transition.task_version.map_or(V::Null, |v| V::from(v as i64)), now.into(), subject.map_or(V::Null, V::from),
    ])?;
    for recipient in recipients {
        exec(sql, "INSERT INTO outbox (event_id, recipient_principal_id, next_attempt_at) VALUES (?, ?, ?)",
            vec![event_id.as_str().into(), recipient.into(), now.into()])?;
    }
    Ok(())
}

/// Human owners and admins, who handle tasks a departure left needing attention.
pub fn room_admins(sql: &SqlStorage) -> R<Vec<String>> {
    let mut admins: Vec<String> = rows(
        sql,
        "SELECT owner_person_id FROM workspace WHERE owner_left_at IS NULL",
        vec![],
    )?
    .iter()
    .filter_map(|r| text(&r["owner_person_id"]))
    .collect();
    admins.extend(rows(sql, "SELECT principal_id FROM member WHERE role = 'admin' AND kind = 'person' AND revoked_at IS NULL", vec![])?.iter().filter_map(|r| text(&r["principal_id"])));
    Ok(admins)
}

/// Records a decision's events. Only current participants other than the actor get inbox events.
pub fn record_decision(
    sql: &SqlStorage,
    decision: &Decision,
    prior_status: TaskStatus,
    actor: &str,
    now: i64,
) -> R<()> {
    for draft in &decision.events {
        // Only to someone still here, as with a message: work can't be handed to someone who has left.
        if let Some((kind, to)) = handoff_of(draft.kind, actor, &decision.task) {
            if participant(sql, to)?.is_some() {
                record_handoff(sql, actor, to, kind, &decision.task.id, now)?;
            }
        }
        let mut recipients: Vec<String> = draft.recipients.iter().cloned().collect();
        if draft.kind == EventKind::TaskNeedsAttention {
            recipients.extend(room_admins(sql)?);
        }
        recipients.sort();
        recipients.dedup();
        let mut current = Vec::new();
        for recipient in recipients {
            if recipient != actor && participant(sql, &recipient)?.is_some() {
                current.push(recipient);
            }
        }
        let transition = Transition {
            reason: draft.reason.as_deref(),
            prior_status: Some(prior_status.name()),
            new_status: Some(decision.task.status.name()),
            task_version: Some(decision.task.version),
        };
        record_event(
            sql,
            draft.kind.name(),
            actor,
            Some(&decision.task.id),
            &transition,
            current,
            now,
        )?;
    }
    Ok(())
}

/// Calls the runtime's `storage.transactionSync`, which `worker` doesn't expose. Any error or trap rolls back.
pub fn transaction_sync(state: &State, f: impl FnOnce() -> R<()> + 'static) -> R<()> {
    let failure: Rc<RefCell<Option<ApiError>>> = Rc::new(RefCell::new(None));
    let slot = failure.clone();
    let storage: JsValue = state
        .as_raw()
        .storage()
        .map_err(|e| ApiError::internal(&format!("{e:?}")))?
        .into();
    let func: js_sys::Function =
        js_sys::Reflect::get(&storage, &JsValue::from_str("transactionSync"))
            .and_then(|f| f.dyn_into())
            .map_err(|e| ApiError::internal(&format!("{e:?}")))?;
    let cell = RefCell::new(Some(f));
    let body = Closure::<dyn FnMut() -> std::result::Result<JsValue, JsValue>>::new(move || {
        let f = cell
            .borrow_mut()
            .take()
            .ok_or_else(|| JsValue::from_str("transaction ran twice"))?;
        f().map(|()| JsValue::UNDEFINED).map_err(|e| {
            *slot.borrow_mut() = Some(e);
            JsValue::from_str("rollback")
        })
    });
    match func.call1(&storage, body.as_ref().unchecked_ref()) {
        Ok(_) => Ok(()),
        Err(e) => Err(failure
            .borrow_mut()
            .take()
            .unwrap_or_else(|| ApiError::internal(&format!("{e:?}")))),
    }
}
