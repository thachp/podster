//! A room's plan: how long each task should take, in working days, and which tasks come first. It's for planning, so nothing
//! here wakes anyone, changes who holds a task or holds back a lifecycle command.
//!
//! Plan edits move one `plan_revision` for the room and leave `task.version` alone, so an estimate can't fail an accept or an
//! approval in progress. A loop can run through any task, which is why a stale writer conflicts on the whole room's revision.
use super::*;
use podster_core::baseline::{
    baseline, validate_plan_start, BaselineInput, BaselineTask, CalendarDate, Withheld,
    BASELINE_ASSUMPTIONS, BASELINE_LABEL,
};
use podster_core::{
    plan_change_allowed, plan_would_cycle, validate_task_plan, PlanChange, MAX_PLAN_EDGES,
    MAX_PLAN_TASKS, MAX_PLAN_WALK_EDGES,
};
use podster_policy::{sees_plan_forecast, TASK_PLAN_CHANGED};
use std::collections::{BTreeSet, HashSet};
use wasm_bindgen::JsCast;

const UNFINISHED: &str = "('open', 'offered', 'accepted', 'submitted')";
const FINISHED: &str = "('completed', 'canceled')";
const SLIM: &str = "id, title, status, assignee_id, reviewer_id, duration_days";

fn string_list(body: &Value, name: &str) -> R<Vec<String>> {
    body.get(name)
        .and_then(Value::as_array)
        .ok_or_else(ApiError::invalid_argument)?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(ApiError::invalid_argument)
        })
        .collect()
}

/// Blank means Not estimated. Anything else has to be a whole number, so 1.5 can't round its way in.
fn duration(body: &Value) -> R<Option<i64>> {
    match body.get("duration_days") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(ApiError::invalid_argument),
    }
}

fn plan_state(sql: &SqlStorage) -> R<(i64, Value)> {
    let room = rows(
        sql,
        "SELECT plan_revision, plan_changed_at FROM workspace",
        vec![],
    )?;
    let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
    Ok((int(&room["plan_revision"]), room["plan_changed_at"].clone()))
}

pub(super) fn handle_set(
    sql: &SqlStorage,
    caller: &Caller,
    task_id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    require_id(task_id)?;
    let task = store::load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    ApiError::from_verdict(authorize_task(caller, &task, TaskAction::SetPlan))?;
    let revision = body
        .get("plan_revision")
        .and_then(Value::as_i64)
        .ok_or_else(ApiError::invalid_argument)?;
    let days = duration(body)?;
    let predecessors = string_list(body, "predecessors")?;
    validate_task_plan(task_id, days, &predecessors).map_err(|e| ApiError::from_core(&e))?;
    let (current, changed_at) = plan_state(sql)?;
    if revision != current {
        return Err(ApiError::plan_conflict());
    }
    let wanted: BTreeSet<&str> = predecessors.iter().map(String::as_str).collect();
    let held: BTreeSet<String> = rows(
        sql,
        "SELECT predecessor_id FROM task_dependency WHERE successor_id = ?",
        vec![task_id.into()],
    )?
    .iter()
    .filter_map(|row| text(&row["predecessor_id"]))
    .collect();
    let old_days = rows(
        sql,
        "SELECT duration_days FROM task WHERE id = ?",
        vec![task_id.into()],
    )?
    .first()
    .and_then(|row| row["duration_days"].as_i64());
    let added: Vec<&str> = wanted
        .iter()
        .copied()
        .filter(|id| !held.contains(*id))
        .collect();
    let removed: Vec<&str> = held
        .iter()
        .map(String::as_str)
        .filter(|id| !wanted.contains(id))
        .collect();
    let answer = |revision: i64, changed_at: Value| {
        json!({
            "task_id": task_id, "duration_days": days, "predecessors": wanted,
            "plan_revision": revision, "plan_changed_at": changed_at,
        })
    };
    // Saving what's already there changes nothing, so it can't make someone else's edit conflict.
    if added.is_empty() && removed.is_empty() && old_days == days {
        return Ok(answer(current, changed_at));
    }
    let mut removes_only_canceled = !removed.is_empty();
    for id in &removed {
        let gone = store::load_task(sql, id)?;
        removes_only_canceled &= gone.is_some_and(|t| t.status == TaskStatus::Canceled);
    }
    plan_change_allowed(
        task.status,
        PlanChange {
            adds_predecessors: !added.is_empty(),
            changes_duration: old_days != days,
            removes_only_canceled,
        },
    )
    .map_err(|e| ApiError::from_core(&e))?;
    for id in &added {
        require_id(id)?;
        if store::load_task(sql, id)?.is_none() {
            return Err(ApiError::task_not_found());
        }
    }
    if !added.is_empty() {
        // Only what comes before these predecessors can close a loop, so this walks that and not the room's whole history.
        let edges: Vec<(String, String)> = rows(
            sql,
            EDGES_BEFORE,
            vec![
                json!(predecessors).to_string().as_str().into(),
                (MAX_PLAN_WALK_EDGES + 1).into(),
            ],
        )?
        .iter()
        .filter_map(|row| Some((text(&row["predecessor_id"])?, text(&row["successor_id"])?)))
        .collect();
        // A long history of finished work can't be walked for ever, and canceling frees the count that would have limited it.
        if edges.len() as i64 > MAX_PLAN_WALK_EDGES {
            return Err(ApiError::limit_exceeded());
        }
        if plan_would_cycle(task_id, &predecessors, &edges) {
            return Err(ApiError::dependency_cycle());
        }
        // Only unfinished tasks count, because a finished task's edges can't be edited, and they'd fill the room for good.
        let count = rows(sql, &edges_of(UNFINISHED, "count(*) AS n"), vec![])?
            .first()
            .map_or(0, |row| int(&row["n"]));
        if count + added.len() as i64 - removed.len() as i64 > MAX_PLAN_EDGES {
            return Err(ApiError::limit_exceeded());
        }
    }
    for id in &removed {
        exec(
            sql,
            "DELETE FROM task_dependency WHERE successor_id = ? AND predecessor_id = ?",
            vec![task_id.into(), (*id).into()],
        )?;
    }
    for id in &added {
        exec(sql, "INSERT INTO task_dependency (successor_id, predecessor_id, created_by, created_at) VALUES (?, ?, ?, ?)", vec![
            task_id.into(), (*id).into(), caller.id.as_str().into(), now.into(),
        ])?;
    }
    exec(
        sql,
        "UPDATE task SET duration_days = ? WHERE id = ?",
        vec![days.map_or(V::Null, V::from), task_id.into()],
    )?;
    let next = current + 1;
    exec(
        sql,
        "UPDATE workspace SET plan_revision = ?, plan_changed_at = ?",
        vec![next.into(), now.into()],
    )?;
    exec(sql, "INSERT INTO task_plan_change (task_id, actor_id, plan_revision, old_duration_days, new_duration_days, added, removed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", vec![
        task_id.into(), caller.id.as_str().into(), next.into(), old_days.map_or(V::Null, V::from), days.map_or(V::Null, V::from),
        json!(added).to_string().as_str().into(), json!(removed).to_string().as_str().into(), now.into(),
    ])?;
    // Nobody is told, because a plan asks nothing of anyone.
    record_event(
        sql,
        TASK_PLAN_CHANGED,
        &caller.id,
        Some(task_id),
        &Transition::NONE,
        Vec::<String>::new(),
        now,
    )?;
    Ok(answer(next, json!(now)))
}

/// Whether the runtime's timezone database knows this name. Core checks its shape first, so an offset never gets here. `Intl` takes
/// a name in any case, and what's stored is what was sent, since it's what the person chose.
fn is_known_timezone(name: &str) -> bool {
    let options = js_sys::Object::new();
    let set = js_sys::Reflect::set(&options, &"timeZone".into(), &name.into());
    let intl = js_sys::Reflect::get(&js_sys::global(), &"Intl".into());
    let format = intl.and_then(|intl| js_sys::Reflect::get(&intl, &"DateTimeFormat".into()));
    let (Ok(_), Ok(format)) = (set, format) else {
        return false;
    };
    let format: js_sys::Function = format.unchecked_into();
    let arguments = js_sys::Array::new();
    arguments.push(&"en-US".into());
    arguments.push(&options);
    js_sys::Reflect::construct(&format, &arguments).is_ok()
}

fn start_of(sql: &SqlStorage) -> R<Option<(String, String)>> {
    let room = rows(
        sql,
        "SELECT plan_start_date, plan_timezone FROM workspace",
        vec![],
    )?;
    let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
    Ok(text(&room["plan_start_date"]).zip(text(&room["plan_timezone"])))
}

/// Sets the room's one start date and timezone. A forecast moves with them, so this moves the plan's revision and time like any
/// other plan edit. It wakes nobody, and only a person who runs the room or a member coordinating its plan can do it.
pub(super) fn handle_set_start(
    sql: &SqlStorage,
    caller: &Caller,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::SetPlanStart))?;
    let revision = body
        .get("plan_revision")
        .and_then(Value::as_i64)
        .ok_or_else(ApiError::invalid_argument)?;
    let field = |name: &str| {
        body.get(name)
            .and_then(Value::as_str)
            .ok_or_else(ApiError::invalid_argument)
    };
    let (date, timezone) = (field("start_date")?, field("timezone")?);
    validate_plan_start(date, timezone).map_err(|e| ApiError::from_core(&e))?;
    if !is_known_timezone(timezone) {
        return Err(ApiError::invalid_argument());
    }
    let (current, changed_at) = plan_state(sql)?;
    if revision != current {
        return Err(ApiError::plan_conflict());
    }
    let answer = |revision: i64, changed_at: Value| {
        json!({
            "start": { "date": date, "timezone": timezone },
            "plan_revision": revision, "plan_changed_at": changed_at,
        })
    };
    let old = start_of(sql)?;
    // Saving what's already there changes nothing, so it can't make someone else's edit conflict.
    if old
        .as_ref()
        .is_some_and(|(d, z)| d == date && z == timezone)
    {
        return Ok(answer(current, changed_at));
    }
    let next = current + 1;
    exec(
        sql,
        "UPDATE workspace SET plan_start_date = ?, plan_timezone = ?, plan_revision = ?, plan_changed_at = ?",
        vec![date.into(), timezone.into(), next.into(), now.into()],
    )?;
    audit(
        sql,
        caller,
        "workspace.plan_start_changed",
        "workspace",
        None,
        Some(
            json!({
                "old": old.map(|(date, timezone)| json!({ "date": date, "timezone": timezone })),
                "new": { "date": date, "timezone": timezone },
            })
            .to_string(),
        ),
        now,
    )?;
    // Nobody is told, because a plan asks nothing of anyone.
    record_event(
        sql,
        "workspace.plan_start_changed",
        &caller.id,
        None,
        &Transition::NONE,
        Vec::<String>::new(),
        now,
    )?;
    Ok(answer(next, json!(now)))
}

/// Why there's no forecast, in words anyone who sees the whole room can act on. None of these names a task.
fn withheld_words(reason: Withheld) -> &'static str {
    match reason {
        Withheld::NoStart => "Set the room's start date and timezone.",
        Withheld::NoTasks => "There are no tasks to plan.",
        Withheld::MissingEstimates => {
            "A task still needs an estimate, or follows a finished task that has none."
        }
        Withheld::CanceledPredecessor => {
            "A task still has a canceled task before it. Remove or replace that link."
        }
        Withheld::Cycle => "The plan's links form a loop.",
        Withheld::Incomplete => "This read doesn't hold the room's whole plan.",
    }
}

/// What everyone who can't have a forecast gets, whatever the room holds, so it can't tell them anything about what they can't see.
fn forecast_not_available() -> Value {
    json!({
        "label": BASELINE_LABEL, "available": false, "reasons": ["not_available"],
        "explanation": "A baseline plan needs the room's whole plan, and this view doesn't show one.",
    })
}

fn forecast_withheld(reasons: &[Withheld]) -> Value {
    let words: Vec<&str> = reasons.iter().map(|&r| withheld_words(r)).collect();
    let codes: Vec<&str> = reasons.iter().map(|r| r.code()).collect();
    json!({
        "label": BASELINE_LABEL, "available": false, "reasons": codes,
        "explanation": format!("No baseline plan yet. {}", words.join(" ")),
    })
}

/// The forecast for someone who sees the whole plan, from exactly what this read returns.
fn forecast(
    tasks: &[Value],
    edges: &[(String, String)],
    start: Option<&(String, String)>,
    (revision, changed_at): (i64, &Value),
) -> Value {
    let input = BaselineInput {
        start: start.and_then(|(date, _)| CalendarDate::parse(date)),
        tasks: tasks
            .iter()
            .filter_map(|row| {
                Some(BaselineTask {
                    id: text(&row["id"])?,
                    status: row["status"].as_str().and_then(TaskStatus::from_name)?,
                    duration_days: row["duration_days"]
                        .is_number()
                        .then(|| int(&row["duration_days"])),
                })
            })
            .collect(),
        edges: edges.to_vec(),
    };
    let found = match baseline(&input) {
        Ok(found) => found,
        Err(reasons) => return forecast_withheld(&reasons),
    };
    let scheduled: Vec<Value> = found
        .tasks
        .iter()
        .map(|t| {
            json!({
                "id": t.id, "duration_days": t.duration_days,
                "earliest_start": t.earliest_start.to_string(), "earliest_finish": t.earliest_finish.to_string(),
                "latest_start": t.latest_start.to_string(), "latest_finish": t.latest_finish.to_string(),
                "slack_days": t.slack_days, "critical": t.critical,
            })
        })
        .collect();
    json!({
        "label": BASELINE_LABEL, "available": true,
        "plan_revision": revision, "plan_changed_at": changed_at,
        "start_date": start.map(|(date, _)| date), "begins_on": found.begins_on.to_string(), "timezone": start.map(|(_, zone)| zone), "calendar": "mon_fri",
        "assumptions": BASELINE_ASSUMPTIONS,
        "duration_days": found.duration_days, "finish_date": found.finish.to_string(),
        "tasks": scheduled,
        "critical_paths": found.critical_paths, "critical_paths_cut": found.critical_paths_cut,
        "left_out": found.left_out,
    })
}

const EDGES_BEFORE: &str = "WITH RECURSIVE before(id) AS (SELECT value FROM json_each(?1) UNION SELECT d.predecessor_id FROM before CROSS JOIN task_dependency d ON d.successor_id = before.id)
    SELECT d.predecessor_id, d.successor_id FROM before CROSS JOIN task_dependency d ON d.successor_id = before.id LIMIT ?2";

fn edges_of(statuses: &str, columns: &str) -> String {
    format!("SELECT {columns} FROM task t JOIN task_dependency d ON d.successor_id = t.id WHERE t.status IN {statuses}")
}

/// From the edges, so it stops at the limit and doesn't read every finished task the room has ever had to find them. An edge's
/// successor is a primary key seek.
const FINISHED_EDGES: &str = "SELECT d.predecessor_id, d.successor_id FROM task_dependency d CROSS JOIN task t ON t.id = d.successor_id WHERE t.status IN ('completed', 'canceled') LIMIT ?1";

fn unfinished_tasks() -> String {
    format!("SELECT {SLIM} FROM task WHERE status IN {UNFINISHED} ORDER BY seq DESC")
}

/// Newest first by primary key, so it stops once it has enough, and doesn't read the room's whole history to sort it.
fn finished_tasks() -> String {
    format!(
        "SELECT {SLIM} FROM task NOT INDEXED WHERE status IN {FINISHED} ORDER BY seq DESC LIMIT ?1"
    )
}

/// Each role's index, newest first and stopping at the limit, so someone named on everything still reads a bounded number.
fn own_tasks() -> String {
    let newest = |column: &str| {
        format!(
            "SELECT seq FROM (SELECT seq FROM task WHERE {column} = ?1 ORDER BY seq DESC LIMIT ?2)"
        )
    };
    format!(
        "SELECT {SLIM} FROM task WHERE seq IN ({} UNION {} UNION {}) ORDER BY status IN {FINISHED}, seq DESC LIMIT ?2",
        newest("requester_id"), newest("assignee_id"), newest("reviewer_id"),
    )
}

/// From the status index, which holds at most what a room lets stay unfinished, however many finished tasks name this viewer.
fn own_unfinished_tasks() -> String {
    format!(
        "SELECT {SLIM} FROM task INDEXED BY task_status WHERE status IN {UNFINISHED} AND (requester_id = ?1 OR assignee_id = ?1 OR reviewer_id = ?1) ORDER BY seq DESC"
    )
}

const EDGES_FROM: &str = "SELECT predecessor_id, successor_id FROM task_dependency WHERE successor_id IN (SELECT value FROM json_each(?1)) AND +predecessor_id IN (SELECT value FROM json_each(?1)) LIMIT ?2";

fn pair(row: &Value) -> Option<(String, String)> {
    Some((text(&row["predecessor_id"])?, text(&row["successor_id"])?))
}

/// One read of the plan, for one viewer. It holds unfinished tasks first, then the newest finished ones, so every task whose
/// plan can still change is here, with its whole predecessor list even if one of those is too old to be listed. That makes
/// `set_task_plan`, which replaces a task's plan, safe to send from what this says.
///
/// Rows returned have a limit: at most `MAX_PLAN_TASKS` tasks and, for edges, `MAX_PLAN_EDGES` of each kind, however large the
/// room's history gets. Rows read are bounded too, though not by those: someone narrowed can have up to about 150,000 edges
/// examined, at 50 per task on 3,000 tasks, because the query filters out hidden predecessors before the limit counts. That
/// doesn't depend on the room's history. Someone limited to their own tasks gets those, with the edges between them, and no
/// revision or time, because those move with tasks they can't see.
///
/// `scope=unfinished` leaves out finished tasks, so `complete` is always false, though someone who sees the whole room still
/// gets what's needed to edit: every unfinished task, each one's whole predecessor list, and the revision.
pub(super) fn read(sql: &SqlStorage, caller: &Caller, url: &Url) -> R<Value> {
    let whole = sees_whole_plan(caller);
    let room = MAX_PLAN_TASKS + 1;
    // Smaller, for a reader such as an agent's tool. Someone narrowed still gets only tasks they're named on, and edges with both
    // ends among those. It has no per-column cut, so it can list an old task of theirs the full read's newest rows left out.
    let unfinished_only = match query_str(url, "scope").as_deref() {
        None => false,
        Some("unfinished") => true,
        Some(_) => return Err(ApiError::invalid_argument()),
    };
    let found = if unfinished_only && whole {
        rows(sql, &unfinished_tasks(), vec![])?
    } else if unfinished_only {
        rows(
            sql,
            &own_unfinished_tasks(),
            vec![caller.id.as_str().into()],
        )?
    } else if whole {
        let mut found = rows(sql, &unfinished_tasks(), vec![])?;
        let left = (room - found.len() as i64).max(0);
        found.extend(rows(sql, &finished_tasks(), vec![left.into()])?);
        found
    } else {
        rows(
            sql,
            &own_tasks(),
            vec![caller.id.as_str().into(), room.into()],
        )?
    };
    let over = found.len() as i64 > MAX_PLAN_TASKS;
    let tasks: Vec<Value> = found
        .iter()
        .take(MAX_PLAN_TASKS as usize)
        .map(|row| {
            json!({
                "id": row["id"], "title": row["title"], "status": row["status"], "assignee": row["assignee_id"],
                "reviewer": row["reviewer_id"], "duration_days": row["duration_days"],
            })
        })
        .collect();
    let shown: HashSet<&str> = tasks.iter().filter_map(|t| t["id"].as_str()).collect();
    let edge_limit = MAX_PLAN_EDGES + 1;
    let (mut listed, cut): (Vec<(String, String)>, bool) = if whole {
        let columns = "d.predecessor_id, d.successor_id";
        let unfinished = rows(sql, &edges_of(UNFINISHED, columns), vec![])?;
        let finished = if unfinished_only {
            vec![]
        } else {
            rows(sql, FINISHED_EDGES, vec![edge_limit.into()])?
        };
        let cut = finished.len() as i64 > MAX_PLAN_EDGES;
        // Someone who sees the whole room can have a predecessor too old to be listed, because it's still part of this plan.
        let edges = unfinished
            .iter()
            .chain(finished.iter().take(MAX_PLAN_EDGES as usize))
            .filter_map(pair);
        (
            edges
                .filter(|(_, to)| shown.contains(to.as_str()))
                .collect(),
            cut,
        )
    } else {
        let ids = json!(shown.iter().collect::<Vec<_>>()).to_string();
        let found = rows(
            sql,
            EDGES_FROM,
            vec![ids.as_str().into(), edge_limit.into()],
        )?;
        let edges = found.iter().take(MAX_PLAN_EDGES as usize).filter_map(pair);
        (
            edges
                .filter(|(from, to)| shown.contains(from.as_str()) && shown.contains(to.as_str()))
                .collect(),
            false,
        )
    };
    listed.sort();
    let edges: Vec<Value> = listed
        .iter()
        .map(|(from, to)| json!({ "predecessor": from, "successor": to }))
        .collect();
    let complete = whole && !over && !cut && !unfinished_only;
    let mut plan = json!({ "complete": complete, "tasks": tasks, "edges": edges });
    if whole {
        let (revision, changed_at) = plan_state(sql)?;
        plan["plan_revision"] = json!(revision);
        plan["plan_changed_at"] = changed_at.clone();
        if sees_plan_forecast(caller) {
            let start = start_of(sql)?;
            plan["start"] = start.as_ref().map_or(
                Value::Null,
                |(date, timezone)| json!({ "date": date, "timezone": timezone }),
            );
            plan["forecast"] = if complete {
                forecast(&tasks, &listed, start.as_ref(), (revision, &changed_at))
            } else {
                forecast_withheld(&[Withheld::Incomplete])
            };
        }
    }
    if plan.get("forecast").is_none() {
        plan["forecast"] = forecast_not_available();
    }
    Ok(plan)
}

/// What the plan read and write cost, from the queries they really run. Only tests can reach this.
#[cfg(feature = "failpoints")]
pub(super) fn read_costs(sql: &SqlStorage, who: &Participant, url: &Url) -> R<Value> {
    let cost = |query: &str, bindings: Vec<V>| -> R<Value> {
        let plan = rows(
            sql,
            &format!("EXPLAIN QUERY PLAN {query}"),
            bindings.clone(),
        )?;
        let plan: Vec<String> = plan.iter().filter_map(|row| text(&row["detail"])).collect();
        let cursor = sql.exec(query, bindings)?;
        let found = cursor.to_array::<Value>()?;
        Ok(
            json!({ "plan": plan.join(" | "), "rows": found.len(), "rows_read": cursor.rows_read() }),
        )
    };
    let id = who.caller.id.as_str();
    let room = MAX_PLAN_TASKS + 1;
    let ids = query_str(url, "ids").unwrap_or_else(|| "[]".into());
    Ok(json!({
        "unfinished": cost(&unfinished_tasks(), vec![])?,
        "finished": cost(&finished_tasks(), vec![room.into()])?,
        "own": cost(&own_tasks(), vec![id.into(), room.into()])?,
        "own_unfinished": cost(&own_unfinished_tasks(), vec![id.into()])?,
        "edges_unfinished": cost(&edges_of(UNFINISHED, "d.predecessor_id, d.successor_id"), vec![])?,
        "edges_finished": cost(FINISHED_EDGES, vec![(MAX_PLAN_EDGES + 1).into()])?,
        "edges_from": cost(EDGES_FROM, vec![ids.as_str().into(), (MAX_PLAN_EDGES + 1).into()])?,
        "edges_before": cost(EDGES_BEFORE, vec![ids.as_str().into(), (MAX_PLAN_WALK_EDGES + 1).into()])?,
        "edges_count": cost(&edges_of(UNFINISHED, "count(*) AS n"), vec![])?,
    }))
}
