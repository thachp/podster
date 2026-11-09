//! M3 step 12, the room's half of outbound offers (ADR 0007, decisions 117, 118 and 129). An offer to an agent records an
//! attempt in the offer's own transaction (`store::record_offer_attempt`). Here the alarm puts each new attempt on the A2A
//! queue, holding IDs only, and the consumer asks the room twice: once to begin, which rechecks the task and the agent's
//! access and only then reads the text, and once to record how the send went.
//!
//! Whether the agent has an endpoint, is still connected, and whoever set it is still in its organization is the agent's
//! Principal's to say, and the consumer asks it before beginning. Logs carry IDs only.
use super::*;
use podster_core::a2a::{may_send, valid_remote_task_id, AttemptState, NoSend};

const QUEUE_BATCH: i64 = 50;
const QUEUE_MAX_BACKOFF_MS: i64 = 5 * 60 * 1000;
/// Longer than a send can take, so a second delivery of the same job waits, and a crash mid-send only delays a retry.
pub(super) const SEND_LEASE_MS: i64 = 60_000;

/// What crosses the queue: IDs only (decision 118).
#[derive(serde::Serialize)]
struct Job<'a> {
    ws: &'a str,
    attempt: &'a str,
    agent: &'a str,
}

/// Puts attempts not yet queued on the A2A queue, oldest first. One that fails waits with backoff, and the others go on.
pub(super) async fn drain(env: &Env, sql: &SqlStorage, workspace_id: &str, now: i64) -> R<()> {
    let pending = rows(
        sql,
        "SELECT id, agent_id, queue_failures FROM a2a_attempt WHERE queued = 0 AND state = 'queued' AND next_queue_at <= ? ORDER BY created_at LIMIT ?",
        vec![now.into(), QUEUE_BATCH.into()],
    )?;
    if pending.is_empty() {
        return Ok(());
    }
    let queue = env.queue("A2A");
    let mut failed = false;
    for row in &pending {
        let attempt = text(&row["id"]).unwrap_or_default();
        let agent = text(&row["agent_id"]).unwrap_or_default();
        let sent = match &queue {
            Ok(queue) => queue
                .send(Job {
                    ws: workspace_id,
                    attempt: &attempt,
                    agent: &agent,
                })
                .await
                .map_err(ApiError::from),
            Err(_) => Err(ApiError::internal("no A2A queue")),
        };
        match sent {
            Ok(()) => exec(
                sql,
                "UPDATE a2a_attempt SET queued = 1, updated_at = ? WHERE id = ?",
                vec![now.into(), attempt.as_str().into()],
            )?,
            Err(_) => {
                failed = true;
                let failures = int(&row["queue_failures"]) + 1;
                let delay = (1000_i64 << failures.min(9)).min(QUEUE_MAX_BACKOFF_MS);
                exec(sql, "UPDATE a2a_attempt SET queue_failures = ?, next_queue_at = ?, updated_at = ? WHERE id = ?", vec![
                    failures.into(), (now + delay).into(), now.into(), attempt.as_str().into(),
                ])?;
            }
        }
    }
    if failed {
        console_error!(
            "{}",
            json!({ "event": "a2a.queue_failed", "workspace": workspace_id })
        );
    }
    Ok(())
}

/// When the next attempt is due to be queued, if any.
pub(super) fn next_due(sql: &SqlStorage) -> R<Option<i64>> {
    Ok(rows(
        sql,
        "SELECT min(next_queue_at) AS due FROM a2a_attempt WHERE queued = 0 AND state = 'queued'",
        vec![],
    )?
    .first()
    .and_then(|r| r["due"].as_f64())
    .map(|due| due as i64))
}

fn attempt_row(sql: &SqlStorage, id: &str) -> R<Option<Value>> {
    Ok(rows(
        sql,
        "SELECT * FROM a2a_attempt WHERE id = ?",
        vec![id.into()],
    )?
    .into_iter()
    .next())
}

/// The offer a task is on now: its latest `task.offered` event. An attempt belongs to the offer it was recorded with.
fn current_offer(sql: &SqlStorage, task: &str) -> R<Option<String>> {
    Ok(rows(
        sql,
        "SELECT id FROM event WHERE task_id = ? AND type = 'task.offered' ORDER BY seq DESC LIMIT 1",
        vec![task.into()],
    )?
    .first()
    .and_then(|r| text(&r["id"])))
}

fn stop(sql: &SqlStorage, id: &str, reason: &str, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE a2a_attempt SET state = 'stopped', ended_reason = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'queued'",
        vec![reason.into(), now.into(), id.into()],
    )
}

fn no_send(reason: &str) -> Value {
    json!({ "send": false, "reason": reason })
}

/// `/internal/a2a-begin`, as the agent the consumer says, with the generation its Principal gave. Rechecks everything from
/// the room's current state, in one transaction, and only then reads the text: the agent is still a participant here and
/// sees the task, the room isn't archived, and the task is still offered to it on this attempt's offer. Anything that
/// moved on ends the attempt. On success the attempt is leased, so another delivery of the same job sends nothing.
pub(super) fn begin(sql: &SqlStorage, identity: &Identity, body: &Value, now: i64) -> R<Value> {
    let id = body["attempt"].as_str().unwrap_or_default();
    let Some(attempt) = attempt_row(sql, id)? else {
        return Ok(no_send("no_attempt"));
    };
    if identity.kind != "agent" || attempt["agent_id"].as_str() != Some(identity.id.as_str()) {
        return Ok(no_send("no_attempt"));
    }
    let Some(state) = attempt["state"].as_str().and_then(AttemptState::from_name) else {
        return Err(ApiError::internal("unknown attempt state"));
    };
    // A retry of a job whose send was already recorded skips straight to what's left: reporting it to the Principal.
    if state == AttemptState::Sent {
        return Ok(
            json!({ "send": false, "reason": "already_sent", "sent": true, "version": attempt["endpoint_version"] }),
        );
    }
    if state != AttemptState::Queued {
        return Ok(no_send("ended"));
    }
    if room_archived(sql)? {
        stop(sql, id, "room_archived", now)?;
        return Ok(no_send("room_archived"));
    }
    // The agent's place here, as any of its own requests would be checked, fence and revocation included. A refusal ends the
    // attempt, and anything else fails the begin so the job is retried.
    let who = match resolve_caller(sql, identity) {
        Ok(who) => who,
        Err(error) if error.status_and_code().0 < 500 => {
            stop(sql, id, "no_access", now)?;
            return Ok(no_send("no_access"));
        }
        Err(error) => return Err(error),
    };
    let task_id = attempt["task_id"].as_str().unwrap_or_default();
    let Some(task) = load_task(sql, task_id)?.filter(|task| can_see_task(&who.caller, task)) else {
        stop(sql, id, "no_access", now)?;
        return Ok(no_send("no_access"));
    };
    let offer = attempt["offer_id"].as_str().unwrap_or_default();
    let leased = attempt["lease_until"]
        .as_i64()
        .is_some_and(|until| until > now);
    match may_send(
        &task,
        current_offer(sql, task_id)?.as_deref(),
        &identity.id,
        offer,
        state,
        leased,
    ) {
        Ok(()) => {}
        Err(NoSend::Busy) => return Ok(json!({ "send": false, "reason": "busy", "retry": true })),
        Err(NoSend::OfferMovedOn) => {
            stop(sql, id, "offer_moved_on", now)?;
            return Ok(no_send("offer_moved_on"));
        }
        Err(NoSend::AlreadySent) => return Ok(no_send("already_sent")),
        Err(NoSend::Ended) => return Ok(no_send("ended")),
    }
    exec(
        sql,
        "UPDATE a2a_attempt SET lease_until = ?, tries = tries + 1, updated_at = ? WHERE id = ?",
        vec![(now + SEND_LEASE_MS).into(), now.into(), id.into()],
    )?;
    Ok(json!({
        "send": true, "task_id": task.id, "title": task.title, "instructions": task.instructions,
        "acceptance_criteria": task.acceptance_criteria, "files": input_files(sql, &who.caller, &task.id)?,
    }))
}

/// The task's input files as this agent may see them now (M3 step 14, decision 121): each one's ID, name, and download path
/// once it's ready. A file hidden from the agent, or blocked, failed or removed, isn't named.
fn input_files(sql: &SqlStorage, caller: &Caller, task: &str) -> R<Vec<Value>> {
    let linked = rows(
        sql,
        "SELECT object_id FROM asset_link WHERE task_id = ? ORDER BY linked_at, object_id",
        vec![task.into()],
    )?;
    let mut files = Vec::new();
    for row in &linked {
        let id = row["object_id"].as_str().unwrap_or_default();
        if let Some(file) =
            super::downloads::file_json(sql, caller, &super::downloads::file_row(sql, id)?)?
        {
            // Only a ready file, with its link, or one still scanning, without. Blocked, failed and removed files aren't named.
            match file["state"].as_str() {
                Some("ready") => files.push(json!({ "id": file["id"], "name": file["name"], "download_path": file["download_path"] })),
                Some("scanning") => files.push(json!({ "id": file["id"], "name": file["name"], "download_path": null })),
                _ => {}
            }
        }
    }
    Ok(files)
}

/// `/internal/a2a-finish`: how one send went. `sent` stores the one remote task the endpoint answered with, `retry` puts the
/// attempt back for the queue's retry, and `stopped` ends it. Every outcome pins the endpoint it was for, when there was one.
/// Only a queued attempt changes, so a late report can't reopen an ended one.
pub(super) fn finish(sql: &SqlStorage, identity: &Identity, body: &Value, now: i64) -> R<Value> {
    let id = body["attempt"].as_str().unwrap_or_default();
    // Only for the agent the attempt is for, so a job naming another agent can't end or change this one.
    let Some(attempt) = attempt_row(sql, id)? else {
        return Ok(json!({ "state": null }));
    };
    if identity.kind != "agent" || attempt["agent_id"].as_str() != Some(identity.id.as_str()) {
        return Ok(json!({ "state": null }));
    }
    let url = body["url"].as_str();
    let version = body["version"].as_i64();
    let pin = |sql: &SqlStorage| -> R<()> {
        if let (Some(url), Some(version)) = (url, version) {
            exec(sql, "UPDATE a2a_attempt SET endpoint_url = ?, endpoint_version = ? WHERE id = ? AND state = 'queued'", vec![
                url.into(), version.into(), id.into(),
            ])?;
        }
        Ok(())
    };
    match body["outcome"].as_str() {
        Some("sent") => {
            // Checked again here, since it's what step 13 reads, and an ID that fails counts as no answer.
            let remote = body["remote_task_id"].as_str();
            if remote.is_some_and(|r| !valid_remote_task_id(r)) {
                return Err(ApiError::invalid_argument());
            }
            // Recording a send is the first thing done once the endpoint answers, so it's idempotent: the same answer again
            // changes nothing, and a different remote task for an attempt already sent is refused.
            if attempt["state"].as_str() == Some("sent") {
                if attempt["remote_task_id"].as_str() == remote {
                    return Ok(json!({ "state": "sent" }));
                }
                return Err(ApiError::api(409, "already_sent"));
            }
            pin(sql)?;
            exec(sql, "UPDATE a2a_attempt SET state = 'sent', remote_task_id = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'queued'", vec![
                remote.map_or(V::Null, V::from), now.into(), id.into(),
            ])?;
            // A remote task is read back from a minute on (step 13). A message with no task has nothing to read.
            if remote.is_some() && attempt["state"].as_str() == Some("queued") {
                super::a2a_read::start_reading(sql, id, now)?;
            }
        }
        Some("retry") => {
            pin(sql)?;
            exec(sql, "UPDATE a2a_attempt SET lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'queued'", vec![now.into(), id.into()])?;
        }
        Some("stopped") => {
            let reason = body["reason"].as_str().filter(|r| {
                r.len() <= 40 && r.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            });
            pin(sql)?;
            stop(sql, id, reason.unwrap_or("stopped"), now)?;
        }
        _ => return Err(ApiError::invalid_argument()),
    }
    let state = attempt_row(sql, id)?.and_then(|r| text(&r["state"]));
    Ok(json!({ "state": state }))
}

impl Workspace {
    /// The consumer's two calls, each in a transaction of its own.
    pub(super) fn a2a_step(&self, path: &str, identity: &Identity, body: Value) -> R<Value> {
        let sql = self.state.storage().sql();
        let beginning = path == crate::INTERNAL_A2A_BEGIN;
        let identity = identity.clone();
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        transaction_sync(&self.state, move || {
            let now = now_ms();
            let answer = if beginning {
                begin(&sql, &identity, &body, now)?
            } else {
                finish(&sql, &identity, &body, now)?
            };
            *slot.borrow_mut() = Some(answer);
            Ok(())
        })?;
        let value = out.borrow_mut().take();
        value.ok_or_else(|| ApiError::internal("a2a step produced no result"))
    }
}
