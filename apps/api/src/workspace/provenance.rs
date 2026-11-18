//! A task's provenance for Runner's run policy (M7 step 4; decision 228; the M7 security review's S-29): the requester's
//! organization, the room's visibility, and every author of each prompt input, with their organization, each marked
//! `external` for the reader and `active` while still held here in that organization. Which inputs a command wrote is
//! `podster_core::task_inputs`; who may read this, what counts as external and who is active is `podster_policy::provenance`.
//!
//! Every author is the actor of a command that wrote the input, recorded in that command's transaction. Nothing a client
//! sends names one. Every author and organization pair is kept, so a later writer can't hide an earlier one (the
//! architect's rulings F1 and G3 on #443's reviews). A write over words nobody recorded first adds a lasting unknown author
//! (G1), and a read over such words shows one too: the latest write counts only while the input's words still hash to what
//! it wrote, or for a change request while its event is the task's latest (F2). An input or requester is external to a
//! reader if any author is external, unknown or no longer active (G2). The requester's organization is the one recorded
//! when they took the part (F3).
//!
//! It's a read only: nothing in the room authorizes from it. The texts themselves are never in it, an event or a log.
use super::*;
use podster_core::task_inputs::{recordable_author, requester_set, written, PromptInput};
use podster_core::{Decision, EventKind};
use podster_policy::provenance::{
    author_active, input_external, is_external, requester_external, sees_provenance,
};

fn sha256_hex(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// The words of a text input as `task` holds them. `None` for criteria the task doesn't have, and for a change request,
/// whose words are its event's.
fn current_text(task: &Task, input: PromptInput) -> Option<&str> {
    match input {
        PromptInput::Title => Some(&task.title),
        PromptInput::Instructions => Some(&task.instructions),
        PromptInput::AcceptanceCriteria => task.acceptance_criteria.as_deref(),
        PromptInput::ChangeRequest => None,
    }
}

/// The task's change requests' events, latest first, at most `n`.
fn change_requests(sql: &SqlStorage, task: &str, n: i64) -> R<Vec<String>> {
    Ok(rows(
        sql,
        "SELECT id FROM event WHERE task_id = ? AND type = ? ORDER BY seq DESC LIMIT ?",
        vec![
            task.into(),
            EventKind::TaskChangesRequested.name().into(),
            n.into(),
        ],
    )?
    .iter()
    .filter_map(|r| text(&r["id"]))
    .collect())
}

/// The latest recorded write of an input: its words' hash, or a change request's event.
fn recorded_text(sql: &SqlStorage, task: &str, input: PromptInput) -> R<Option<Value>> {
    Ok(rows(
        sql,
        "SELECT text_sha256, event_id FROM task_input_text WHERE task_id = ? AND input = ?",
        vec![task.into(), input.name().into()],
    )?
    .into_iter()
    .next())
}

/// Adds the lasting unknown author to an input, once (G1).
fn add_unknown(sql: &SqlStorage, task: &str, input: PromptInput, now: i64) -> R<()> {
    exec(sql, "INSERT OR IGNORE INTO task_input_author (task_id, input, author_id, author_org, unknown, first_written_at, written_at) VALUES (?, ?, '', '', 1, ?, ?)",
        vec![task.into(), input.name().into(), now.into(), now.into()])
}

/// Records `actor` as an author of each input `decision` wrote, and the requester's organization when the decision made
/// someone requester. `before` is the task as it was, or `None` for one this decision created. Runs in the command's
/// transaction, after `record_decision`, so a change request names its own event. A write over words whose author isn't
/// recorded first adds the lasting unknown author, so a recorded edit can't wash out an unrecorded change (G1). An author
/// the room can't record refuses the command before anything here is written, and the whole command with it.
pub(super) fn record(
    sql: &SqlStorage,
    before: Option<&Task>,
    decision: &Decision,
    actor: &str,
    now: i64,
) -> R<()> {
    let task = &decision.task;
    let inputs = written(before, decision);
    let requester = requester_set(before, decision);
    if inputs.is_empty() && !requester {
        return Ok(());
    }
    let org = store::principal_org(sql, actor)?.filter(|o| !o.is_empty());
    let requester_org = if requester {
        store::principal_org(sql, &task.requester)?.filter(|o| !o.is_empty())
    } else {
        None
    };
    if (!inputs.is_empty() && !recordable_author(actor, org.as_deref()))
        || (requester && !recordable_author(&task.requester, requester_org.as_deref()))
    {
        return Err(ApiError::invalid_argument());
    }
    for input in inputs {
        let recorded = recorded_text(sql, &task.id, input)?;
        let (hash, event) = match input {
            PromptInput::ChangeRequest => {
                let events = change_requests(sql, &task.id, 2)?;
                let id = events
                    .first()
                    .cloned()
                    .ok_or_else(|| ApiError::internal("change request without its event"))?;
                // The request before this one, if any, must be the one recorded.
                if let Some(prior) = events.get(1) {
                    if recorded.as_ref().and_then(|r| r["event_id"].as_str()) != Some(prior) {
                        add_unknown(sql, &task.id, input, now)?;
                    }
                }
                (None, Some(id))
            }
            _ => {
                // The words before this write, if the task had any, must be the ones recorded.
                if let Some(prior) = before.and_then(|b| current_text(b, input)) {
                    let hash = sha256_hex(prior);
                    if recorded.as_ref().and_then(|r| r["text_sha256"].as_str())
                        != Some(hash.as_str())
                    {
                        add_unknown(sql, &task.id, input, now)?;
                    }
                }
                (current_text(task, input).map(sha256_hex), None)
            }
        };
        exec(sql, "INSERT INTO task_input_author (task_id, input, author_id, author_org, first_written_at, written_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (task_id, input, author_id, author_org) DO UPDATE SET written_at = excluded.written_at", vec![
            task.id.as_str().into(), input.name().into(), actor.into(), org.as_deref().unwrap_or("").into(), now.into(), now.into(),
        ])?;
        exec(sql, "INSERT OR REPLACE INTO task_input_text (task_id, input, text_sha256, event_id, written_at) VALUES (?, ?, ?, ?, ?)", vec![
            task.id.as_str().into(), input.name().into(), opt(&hash), opt(&event), now.into(),
        ])?;
    }
    if requester {
        exec(sql, "INSERT OR REPLACE INTO task_requester_org (task_id, requester_id, org, recorded_at) VALUES (?, ?, ?, ?)", vec![
            task.id.as_str().into(), task.requester.as_str().into(), opt(&requester_org), now.into(),
        ])?;
    }
    Ok(())
}

/// Whether someone is active: a current participant, held now in the organization recorded for them.
fn active(sql: &SqlStorage, id: &str, recorded_org: Option<&str>) -> R<bool> {
    let participant = participant(sql, id)?.is_some();
    let held = store::principal_org(sql, id)?;
    Ok(author_active(participant, held.as_deref(), recorded_org))
}

/// An author the room has no record of: always external, never active.
fn unknown_author() -> Value {
    json!({ "id": null, "org": null, "external": true, "active": false, "written_at": null })
}

/// What `get_task` shows of the task's provenance, or null for someone who may not read the task.
pub(super) fn of_task(sql: &SqlStorage, who: &Participant, task: &Task) -> R<Value> {
    if !sees_provenance(&who.caller, task) {
        return Ok(Value::Null);
    }
    let visibility = rows(sql, "SELECT visibility FROM workspace", vec![])?
        .first()
        .and_then(|r| text(&r["visibility"]))
        .ok_or_else(|| ApiError::internal("room without visibility"))?;
    // The requester's organization as recorded when they took the part, and only for the requester the task has now.
    let requester_org = rows(
        sql,
        "SELECT org FROM task_requester_org WHERE task_id = ? AND requester_id = ?",
        vec![task.id.as_str().into(), task.requester.as_str().into()],
    )?
    .first()
    .and_then(|r| text(&r["org"]));
    let requester_active = active(sql, &task.requester, requester_org.as_deref())?;
    let authors = rows(sql, "SELECT input, author_id, author_org, unknown, written_at FROM task_input_author WHERE task_id = ? ORDER BY first_written_at, author_id, author_org",
        vec![task.id.as_str().into()])?;
    let latest_request = change_requests(sql, &task.id, 1)?.into_iter().next();
    let mut inputs = Vec::new();
    for input in PromptInput::ALL {
        let text_row = recorded_text(sql, &task.id, input)?;
        // Whether the latest recorded write is what the task holds now.
        let counted = match input {
            PromptInput::ChangeRequest => match &latest_request {
                // A change request is shown once the task has one.
                None => continue,
                Some(latest) => text_row
                    .as_ref()
                    .is_some_and(|r| r["event_id"].as_str() == Some(latest.as_str())),
            },
            _ => match current_text(task, input) {
                None => continue,
                Some(words) => text_row
                    .as_ref()
                    .is_some_and(|r| r["text_sha256"].as_str() == Some(sha256_hex(words).as_str())),
            },
        };
        let mut listed = Vec::new();
        let mut flags = Vec::new();
        let mut unknown = !counted;
        let mut unknown_listed = false;
        for row in authors
            .iter()
            .filter(|r| r["input"].as_str() == Some(input.name()))
        {
            if int(&row["unknown"]) == 1 {
                unknown = true;
                unknown_listed = true;
                listed.push(unknown_author());
                continue;
            }
            let id = text(&row["author_id"]).unwrap_or_default();
            let org = text(&row["author_org"]).filter(|o| !o.is_empty());
            let external = is_external(org.as_deref(), &who.org);
            let is_active = active(sql, &id, org.as_deref())?;
            flags.push((external, is_active));
            listed.push(json!({
                "id": id, "org": org, "external": external, "active": is_active, "written_at": row["written_at"],
            }));
        }
        if (unknown || listed.is_empty()) && !unknown_listed {
            unknown = true;
            listed.push(unknown_author());
        }
        let mut entry = json!({
            "input": input.name(),
            "external": input_external(&flags, unknown),
            "authors": listed,
        });
        if input == PromptInput::ChangeRequest {
            entry["event_id"] = json!(latest_request);
        }
        inputs.push(entry);
    }
    Ok(json!({
        "room_visibility": visibility,
        "requester": {
            "id": task.requester, "org": requester_org,
            "external": requester_external(requester_org.as_deref(), &who.org, requester_active),
            "active": requester_active,
        },
        "inputs": inputs,
    }))
}
