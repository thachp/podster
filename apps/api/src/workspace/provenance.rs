//! A task's provenance for Runner's run policy (M7 step 4; decision 228; the M7 security review's S-29): the requester's
//! organization, the room's visibility, and who last wrote each prompt input, with that author's organization, each marked
//! `external` for the reader. Which inputs a command wrote is `podster_core::task_inputs`, and who may read this is
//! `podster_policy::provenance`.
//!
//! Every author is the actor of the command that wrote the input, written in that command's transaction. Nothing a client
//! sends names one. A title, instructions or criteria author is shown only while the input's words still hash to what they
//! wrote, so a change by any path that records no author reads as unknown, never as the earlier author's. Unknown counts
//! as external.
//!
//! It's a read only: nothing in the room authorizes from it. The texts themselves are never in it, an event or a log.
use super::*;
use podster_core::task_inputs::{written, PromptInput};
use podster_core::Decision;
use podster_policy::provenance::{is_external, sees_provenance};

fn sha256_hex(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// The words of a text input as the task holds them now. `None` for criteria the task doesn't have, and for a change
/// request, whose words are its event's.
fn current_text(task: &Task, input: PromptInput) -> Option<&str> {
    match input {
        PromptInput::Title => Some(&task.title),
        PromptInput::Instructions => Some(&task.instructions),
        PromptInput::AcceptanceCriteria => task.acceptance_criteria.as_deref(),
        PromptInput::ChangeRequest => None,
    }
}

/// Records `actor` as the author of each input `decision` wrote. `before` is the task as it was, or `None` for one this
/// decision created. Runs in the command's transaction, after `record_decision`, so a change request names its own event.
pub(super) fn record(
    sql: &SqlStorage,
    before: Option<&Task>,
    decision: &Decision,
    actor: &str,
    now: i64,
) -> R<()> {
    let inputs = written(before, decision);
    if inputs.is_empty() {
        return Ok(());
    }
    let org = store::principal_org(sql, actor)?;
    let task = &decision.task;
    for input in inputs {
        let (hash, event) = match input {
            PromptInput::ChangeRequest => {
                let latest = rows(
                    sql,
                    "SELECT id FROM event WHERE task_id = ? AND type = ? ORDER BY seq DESC LIMIT 1",
                    vec![
                        task.id.as_str().into(),
                        podster_core::EventKind::TaskChangesRequested.name().into(),
                    ],
                )?;
                let id = latest
                    .first()
                    .and_then(|r| text(&r["id"]))
                    .ok_or_else(|| ApiError::internal("change request without its event"))?;
                (None, Some(id))
            }
            _ => (current_text(task, input).map(sha256_hex), None),
        };
        exec(sql, "INSERT OR REPLACE INTO task_input_author (task_id, input, author_id, author_org, text_sha256, event_id, written_at) VALUES (?, ?, ?, ?, ?, ?, ?)", vec![
            task.id.as_str().into(), input.name().into(), actor.into(), opt(&org), opt(&hash), opt(&event), now.into(),
        ])?;
    }
    Ok(())
}

/// What `get_task` shows of the task's provenance, or null for someone who may not read the task.
pub(super) fn of_task(sql: &SqlStorage, who: &Participant, task: &Task) -> R<Value> {
    if !sees_provenance(&who.caller, task) {
        return Ok(Value::Null);
    }
    let requester_org = store::principal_org(sql, &task.requester)?;
    let visibility = rows(sql, "SELECT visibility FROM workspace", vec![])?
        .first()
        .and_then(|r| text(&r["visibility"]))
        .ok_or_else(|| ApiError::internal("room without visibility"))?;
    let recorded = rows(sql, "SELECT input, author_id, author_org, text_sha256, event_id, written_at FROM task_input_author WHERE task_id = ?",
        vec![task.id.as_str().into()])?;
    let row_of = |input: PromptInput| {
        recorded
            .iter()
            .find(|r| r["input"].as_str() == Some(input.name()))
    };
    let mut inputs = Vec::new();
    for input in PromptInput::ALL {
        let row = row_of(input);
        // A change request is shown once the task has one. The others are shown while the task has the input.
        let words = match input {
            PromptInput::ChangeRequest if row.is_none() => continue,
            PromptInput::ChangeRequest => None,
            _ => match current_text(task, input) {
                Some(words) => Some(words),
                None => continue,
            },
        };
        // An author counts only while the words are still the ones they wrote.
        let author = row.filter(|r| match words {
            Some(words) => r["text_sha256"].as_str() == Some(sha256_hex(words).as_str()),
            None => true,
        });
        let org = author.and_then(|r| text(&r["author_org"]));
        let mut entry = json!({
            "input": input.name(),
            "from": author.map(|r| json!({ "id": r["author_id"], "org": org })),
            "external": is_external(org.as_deref(), &who.org),
            "written_at": author.map(|r| r["written_at"].clone()),
        });
        if input == PromptInput::ChangeRequest {
            entry["event_id"] = row.map_or(Value::Null, |r| r["event_id"].clone());
        }
        inputs.push(entry);
    }
    Ok(json!({
        "room_visibility": visibility,
        "requester": { "id": task.requester, "org": requester_org, "external": is_external(requester_org.as_deref(), &who.org) },
        "inputs": inputs,
    }))
}
