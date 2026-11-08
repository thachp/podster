//! Expected outputs (M2 step 7): results the room means to produce. The owner and admins define them, a task's requester names
//! one on the task, and approving a submission of that task makes it the output's current version, so the output is Ready
//! (decisions 54 and 135 to 140). The rules are `podster_core::expected_outputs` and `podster_policy::outputs`. This reads the
//! room's rows for them and writes what they decide.
//!
//! An output's title and description are someone's text: shown to participants, never acted on, and never in an event, audit
//! entry or log. Events carry the output's ID only.
//!
//! The status a listing shows is computed on each read from current state, and nothing authorizes from it.
use super::*;
use podster_core::expected_outputs::{
    current_files_available, decide_define, decide_edit, decide_link, decide_remove, output_status,
    ready_count, version_from_approval, LinkChange, OutputRefusal,
};
use podster_core::submission_files::RoomFile;
use podster_policy::outputs::{
    authorize_manage_outputs, authorize_output_link, sees_output_task, sees_outputs,
    sees_submission_files,
};

const DEFINED: &str = "output.defined";
const UPDATED: &str = "output.updated";
const REMOVED: &str = "output.removed";
const TASK_OUTPUT_CHANGED: &str = "task.output_changed";

fn refusal(refused: OutputRefusal) -> ApiError {
    match refused {
        OutputRefusal::RoomArchived => ApiError::workspace_archived(),
        OutputRefusal::InvalidArgument(_) => ApiError::invalid_argument(),
        OutputRefusal::NotFound => ApiError::api(404, refused.code()),
        OutputRefusal::TooMany
        | OutputRefusal::InUse
        | OutputRefusal::VersionConflict
        | OutputRefusal::InvalidTransition => ApiError::api(409, refused.code()),
    }
}

fn output_not_found() -> ApiError {
    refusal(OutputRefusal::NotFound)
}

/// Refuses a body with any key not named here, as the contract's `additionalProperties: false` says.
fn only_keys(body: &Value, allowed: &[&str]) -> R<()> {
    let object = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if object.keys().all(|key| allowed.contains(&key.as_str())) {
        Ok(())
    } else {
        Err(ApiError::invalid_argument())
    }
}

/// A title and an optional description from a body, and nothing else. A description that's present and not a string is
/// refused.
fn text_fields(body: &Value) -> R<(String, Option<String>)> {
    only_keys(body, &["title", "description"])?;
    Ok((required(body, "title")?, field(body, "description")?))
}

/// An output that hasn't been removed, by ID.
fn live_output(sql: &SqlStorage, id: &str) -> R<Option<Value>> {
    if !crate::valid_id(id) {
        return Ok(None);
    }
    Ok(rows(
        sql,
        "SELECT * FROM expected_output WHERE id = ? AND removed_at IS NULL",
        vec![id.into()],
    )?
    .into_iter()
    .next())
}

/// The output a task names, if any.
fn named_by(sql: &SqlStorage, task_id: &str) -> R<Option<String>> {
    Ok(rows(
        sql,
        "SELECT expected_output_id FROM task WHERE id = ?",
        vec![task_id.into()],
    )?
    .first()
    .and_then(|row| text(&row["expected_output_id"])))
}

/// Room-level events go to nobody's inbox, only to activity (decision 139), and carry the output's ID as their subject.
fn record_room_event(sql: &SqlStorage, kind: &str, actor: &str, output: &str, now: i64) -> R<()> {
    store::record_event_about(
        sql,
        kind,
        actor,
        Some(output),
        None,
        &Transition::NONE,
        Vec::<String>::new(),
        now,
    )
}

fn output_json(row: &Value) -> Value {
    json!({
        "id": row["id"], "title": row["title"], "description": row["description"], "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    })
}

pub(super) fn handle_define(sql: &SqlStorage, caller: &Caller, body: &Value, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_manage_outputs(caller))?;
    let (title, description) = text_fields(body)?;
    let counts = rows(
        sql,
        "SELECT count(*) AS ever, COALESCE(SUM(CASE WHEN removed_at IS NULL THEN 1 ELSE 0 END), 0) AS live FROM expected_output",
        vec![],
    )?;
    let count = |name: &str| counts.first().map_or(0, |row| int(&row[name])).max(0) as usize;
    decide_define(
        room_archived(sql)?,
        count("live"),
        count("ever"),
        &title,
        description.as_deref(),
    )
    .map_err(refusal)?;
    let id = format!("out_{}", uuid::Uuid::new_v4().simple());
    exec(sql, "INSERT INTO expected_output (id, title, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", vec![
        id.as_str().into(), title.as_str().into(), opt(&description), caller.id.as_str().into(), now.into(), now.into(),
    ])?;
    record_room_event(sql, DEFINED, &caller.id, &id, now)?;
    Ok(json!({
        "id": id, "title": title, "description": description, "status": "not_started", "created_at": now, "updated_at": now,
    }))
}

/// Replaces an output's title and description. Leaving the description out, or null, clears it.
pub(super) fn handle_update(
    sql: &SqlStorage,
    caller: &Caller,
    id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_manage_outputs(caller))?;
    let (title, description) = text_fields(body)?;
    let row = live_output(sql, id)?.ok_or_else(output_not_found)?;
    decide_edit(room_archived(sql)?, &title, description.as_deref()).map_err(refusal)?;
    // The same text again records nothing, so activity shows only real changes.
    if row["title"].as_str() == Some(title.as_str())
        && row["description"].as_str() == description.as_deref()
    {
        return Ok(output_json(&row));
    }
    exec(
        sql,
        "UPDATE expected_output SET title = ?, description = ?, updated_at = ? WHERE id = ?",
        vec![
            title.as_str().into(),
            opt(&description),
            now.into(),
            id.into(),
        ],
    )?;
    record_room_event(sql, UPDATED, &caller.id, id, now)?;
    let row = live_output(sql, id)?.ok_or_else(|| ApiError::internal("output vanished"))?;
    Ok(output_json(&row))
}

/// Removes an output, keeping its row so a finished task that named it still points at something (decision 136).
pub(super) fn handle_remove(sql: &SqlStorage, caller: &Caller, id: &str, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_manage_outputs(caller))?;
    let row = live_output(sql, id)?.ok_or_else(output_not_found)?;
    let live = rows(
        sql,
        "SELECT count(*) AS n FROM task WHERE expected_output_id = ? AND status NOT IN ('completed', 'canceled')",
        vec![id.into()],
    )?
    .first()
    .map_or(0, |row| int(&row["n"]))
    .max(0) as usize;
    let has_version = !row["current_task_id"].is_null();
    decide_remove(room_archived(sql)?, live, has_version).map_err(refusal)?;
    exec(
        sql,
        "UPDATE expected_output SET removed_at = ?, removed_by = ? WHERE id = ?",
        vec![now.into(), caller.id.as_str().into(), id.into()],
    )?;
    record_room_event(sql, REMOVED, &caller.id, id, now)?;
    Ok(json!({ "id": id, "removed_at": now }))
}

/// `expected_output_id` from a `create_task` body: a string, or nothing. Anything else is refused.
fn requested_output(body: &Value, name: &str) -> R<Option<String>> {
    match body.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) => Ok(Some(id.clone())),
        Some(_) => Err(ApiError::invalid_argument()),
    }
}

/// Names an output on a task being created, in its transaction. The creator is its requester, so creating it is authority
/// enough. Records no event of its own: `task.created` says the task exists, and the task says what it names.
pub(super) fn name_on_create(sql: &SqlStorage, task: &Task, body: &Value) -> R<()> {
    let Some(requested) = requested_output(body, "expected_output_id")? else {
        return Ok(());
    };
    let exists = live_output(sql, &requested)?.is_some();
    match decide_link(
        room_archived(sql)?,
        task.status,
        task.version,
        None,
        None,
        Some(&requested),
        exists,
    )
    .map_err(refusal)?
    {
        LinkChange::Set(id) => exec(
            sql,
            "UPDATE task SET expected_output_id = ? WHERE id = ?",
            vec![id.as_str().into(), task.id.as_str().into()],
        ),
        LinkChange::Unchanged | LinkChange::Cleared => Ok(()),
    }
}

/// `PUT /tasks/:id/expected-output` with `{ "version": n, "output_id": "out_…" | null }`. `version` is the task version the
/// caller last read, as `update_task` takes it. Whether the version moves is core's `LinkChange::next_version`: a real change
/// does, so an assignee acting on what they read before it gets `version_conflict` and rereads which output they're working
/// toward.
pub(super) fn handle_set_task_output(
    sql: &SqlStorage,
    who: &Participant,
    task_id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    let caller = &who.caller;
    let task = load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    // Authority first, so a malformed body can't tell someone a hidden task exists.
    ApiError::from_verdict(authorize_output_link(caller, &task))?;
    only_keys(body, &["version", "output_id"])?;
    if body.get("output_id").is_none() {
        return Err(ApiError::invalid_argument());
    }
    let expected = version(body)?;
    let requested = requested_output(body, "output_id")?;
    let current = named_by(sql, task_id)?;
    let exists = match &requested {
        Some(id) => live_output(sql, id)?.is_some(),
        None => false,
    };
    let change = decide_link(
        room_archived(sql)?,
        task.status,
        task.version,
        Some(expected),
        current.as_deref(),
        requested.as_deref(),
        exists,
    )
    .map_err(refusal)?;
    let subject = match &change {
        LinkChange::Unchanged => return task_with_output(sql, &task),
        LinkChange::Set(id) => Some(id.clone()),
        LinkChange::Cleared => None,
    };
    let next = change.next_version(task.version);
    exec(
        sql,
        "UPDATE task SET expected_output_id = ?, version = ?, updated_at = ? WHERE id = ?",
        vec![
            opt(&subject),
            (next as i64).into(),
            now.into(),
            task_id.into(),
        ],
    )?;
    let task = load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    let mut parties = vec![task.requester.clone(), task.reviewer.clone()];
    parties.extend(task.assignee.clone());
    parties.sort();
    parties.dedup();
    let mut recipients = Vec::new();
    for party in parties {
        if party != caller.id && participant(sql, &party)?.is_some() {
            recipients.push(party);
        }
    }
    let transition = Transition {
        task_version: Some(task.version),
        ..Transition::NONE
    };
    store::record_event_about(
        sql,
        TASK_OUTPUT_CHANGED,
        &caller.id,
        subject.as_deref(),
        Some(task_id),
        &transition,
        recipients,
        now,
    )?;
    task_with_output(sql, &task)
}

fn task_with_output(sql: &SqlStorage, task: &Task) -> R<Value> {
    let mut out = task_json(task);
    out["expected_output"] = of_task(sql, &task.id, false)?;
    Ok(out)
}

/// Records the version an approval makes, in the approval's transaction. Runs only after `decide` approved, which is after
/// step 6's file check, and an idempotent replay returns its stored answer without reaching here, so nothing records twice.
/// `approver` is the reviewer who approved, kept with the version, since the task's reviewer can change later.
pub(super) fn record_approval(sql: &SqlStorage, task: &Task, approver: &str, now: i64) -> R<()> {
    let Some(output) = named_by(sql, &task.id)? else {
        return Ok(());
    };
    let Some(submission_no) = task.approved_submission_no else {
        return Ok(());
    };
    // `submission_files` is the latest submission's, and only the latest can be approved.
    let links = rows(
        sql,
        "SELECT count(*) AS n FROM artifact WHERE task_id = ? AND submission_no = ?",
        vec![task.id.as_str().into(), i64::from(submission_no).into()],
    )?
    .first()
    .map_or(0, |row| int(&row["n"]))
    .max(0) as usize;
    let artifacts = links.saturating_add(task.submission_files as usize);
    let Some(version) = version_from_approval(task, Some(&output), artifacts, now) else {
        return Ok(());
    };
    exec(sql, "UPDATE expected_output SET current_task_id = ?, current_submission_no = ?, current_approved_at = ? WHERE id = ?", vec![
        version.task_id.as_str().into(), i64::from(version.submission_no).into(), version.approved_at.into(), version.output_id.as_str().into(),
    ])?;
    exec(sql, "INSERT OR IGNORE INTO expected_output_version (output_id, task_id, submission_no, approved_at, approved_by) VALUES (?, ?, ?, ?, ?)", vec![
        version.output_id.as_str().into(), version.task_id.as_str().into(), i64::from(version.submission_no).into(), version.approved_at.into(),
        approver.into(),
    ])
}

/// What `get_task` shows of the output a task names: its ID and title, and whether it was removed since. Anyone who can read
/// the task is in the room and can see every output's title anyway. An organization's admin overseeing its agent isn't in the
/// room, so through oversight it gets the ID and `removed`, never the title.
pub(super) fn of_task(sql: &SqlStorage, task_id: &str, oversight: bool) -> R<Value> {
    let Some(id) = named_by(sql, task_id)? else {
        return Ok(Value::Null);
    };
    Ok(rows(
        sql,
        "SELECT id, title, removed_at FROM expected_output WHERE id = ?",
        vec![id.as_str().into()],
    )?
    .first()
    .map_or(Value::Null, |row| {
        let mut out = json!({ "id": row["id"], "removed": !row["removed_at"].is_null() });
        if !oversight {
            out["title"] = row["title"].clone();
        }
        out
    }))
}

/// Whether every stored file of a submission can still be downloaded.
fn submission_files_available(sql: &SqlStorage, task_id: &str, submission_no: i64) -> R<bool> {
    let named = rows(
        sql,
        "SELECT object_id FROM submission_file WHERE task_id = ? AND submission_no = ?",
        vec![task_id.into(), submission_no.into()],
    )?;
    let ids: Vec<&str> = named
        .iter()
        .filter_map(|row| row["object_id"].as_str())
        .collect();
    let found = submission_files::object_rows(sql, &ids)?;
    let files: Vec<RoomFile<'_>> = found.iter().map(submission_files::room_file).collect();
    Ok(current_files_available(&ids, &files))
}

/// `GET /outputs`: every live output, with its status, for every participant (decision 54). Which task delivered the current
/// version shows only to someone who can see that task, and whether its files can still be downloaded only to someone who
/// may read that submission's files (decision 138).
pub(super) fn read(sql: &SqlStorage, who: &Participant) -> R<Value> {
    let caller = &who.caller;
    if !sees_outputs(caller) {
        return Err(ApiError::workspace_not_found());
    }
    let outputs = rows(
        sql,
        "SELECT * FROM expected_output INDEXED BY expected_output_shown WHERE removed_at IS NULL ORDER BY created_at, id",
        vec![],
    )?;
    let in_review: Vec<String> = rows(
        sql,
        "SELECT DISTINCT expected_output_id FROM task WHERE expected_output_id IS NOT NULL AND status = 'submitted'",
        vec![],
    )?
    .iter()
    .filter_map(|row| text(&row["expected_output_id"]))
    .collect();
    let mut listed = Vec::with_capacity(outputs.len());
    let mut ready = Vec::with_capacity(outputs.len());
    for row in &outputs {
        let id = row["id"].as_str().unwrap_or_default();
        let current_task = row["current_task_id"].as_str();
        let reviewing = in_review.iter().any(|o| o == id);
        let naming = if reviewing {
            vec![TaskStatus::Submitted]
        } else {
            vec![]
        };
        let status = output_status(current_task.is_some(), &naming);
        ready.push(current_task.is_some());
        let mut out = output_json(row);
        out["status"] = json!(status.name());
        // A Ready output can have a newer submission waiting for review. Like the status, it comes from every task naming the
        // output, which decision 54 lets every participant see, and it names none of them.
        out["in_review"] = json!(reviewing);
        out["current"] = Value::Null;
        if let Some(task) = current_task
            .map(|t| load_task(sql, t))
            .transpose()?
            .flatten()
        {
            if sees_output_task(caller, &task) {
                let submission_no = int(&row["current_submission_no"]);
                out["current"] = json!({
                    "task_id": task.id, "submission_no": submission_no, "approved_at": row["current_approved_at"],
                });
                let submitted_by = rows(
                    sql,
                    "SELECT submitted_by FROM submission WHERE task_id = ? AND submission_no = ?",
                    vec![task.id.as_str().into(), submission_no.into()],
                )?
                .first()
                .and_then(|r| text(&r["submitted_by"]))
                .unwrap_or_default();
                if sees_submission_files(caller, &task, &submitted_by) {
                    out["current"]["files_available"] =
                        json!(submission_files_available(sql, &task.id, submission_no)?);
                }
            }
        }
        listed.push(out);
    }
    let (ready, total) = ready_count(&ready);
    Ok(json!({ "outputs": listed, "ready": ready, "total": total }))
}

/// The most versions one read returns, newest first. `complete` says whether there were more.
const VERSIONS_LISTED: i64 = 200;

/// `GET /outputs/:id/versions`: every approval that made this output Ready, newest first by the order they were recorded, so
/// two in the same millisecond still come out in order, for every participant. Each is gated
/// like `current`: the source task and the reviewer who approved only for someone who can see that task, and otherwise only its
/// submission number and time, as the output's status already tells everyone it was approved. Nothing here is about files:
/// the submission's links and files are read through `get_task`, under `task_view` and the file views.
pub(super) fn read_versions(sql: &SqlStorage, who: &Participant, id: &str) -> R<Value> {
    let caller = &who.caller;
    if !sees_outputs(caller) {
        return Err(ApiError::workspace_not_found());
    }
    live_output(sql, id)?.ok_or_else(output_not_found)?;
    let found = rows(
        sql,
        "SELECT task_id, submission_no, approved_at, approved_by FROM expected_output_version INDEXED BY expected_output_history
            WHERE output_id = ? ORDER BY seq DESC LIMIT ?",
        vec![id.into(), (VERSIONS_LISTED + 1).into()],
    )?;
    let complete = found.len() as i64 <= VERSIONS_LISTED;
    let mut versions = Vec::with_capacity(found.len());
    for row in found.iter().take(VERSIONS_LISTED as usize) {
        let mut version =
            json!({ "submission_no": row["submission_no"], "approved_at": row["approved_at"] });
        let task = row["task_id"]
            .as_str()
            .map(|task| load_task(sql, task))
            .transpose()?
            .flatten();
        if task.is_some_and(|task| sees_output_task(caller, &task)) {
            version["task_id"] = row["task_id"].clone();
            version["approved_by"] = row["approved_by"].clone();
        }
        versions.push(version);
    }
    Ok(json!({ "output_id": id, "versions": versions, "complete": complete }))
}
