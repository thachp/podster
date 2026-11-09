//! M3 step 13, the room's half of reading remote tasks back (ADR 0007, decision 117). A sent attempt with a remote task is
//! read by `GetTask`, one queued job per read, each queued by this room's alarm once it's due, so the room alone decides
//! whether to read at all. Reads back off from 1 minute to 1 hour and end at a terminal state, after 7 days, or when the
//! endpoint, the agent's access or the task's offer moves on.
//!
//! What a read reports goes through step 5's `decide_remote`, and its one effect runs through the room's own command path as
//! the agent's act, so `crates/policy` and then `crates/core` decide against current state. Events and audit rows it makes are
//! marked `origin = 'a2a_remote'`, with the attempt's ID. What the remote agent wrote is data: it never becomes a command or a
//! reason. A canceled task's remote tasks are sent `CancelTask` once.
use super::*;
use podster_core::a2a::{
    decide_remote, read_delay_ms, reading_open, Attempt, Endpoint, RemoteEffect, RemoteRead,
    RemoteState, DECLINE_REASON, RELEASE_REASON,
};

pub(super) const ORIGIN: &str = "a2a_remote";
const READ_BATCH: i64 = 50;
/// A queued read that hasn't come back in this long was lost, and is queued again with the same number.
const READ_STALE_MS: i64 = 30 * 60 * 1000;
/// After a failed queue send, the read is tried again this much later.
const REQUEUE_MS: i64 = 60_000;

pub(super) const HELD_EVENT: &str = "task.a2a_response_held";
pub(super) const REMOTE_CANCELED_EVENT: &str = "task.a2a_remote_canceled";
pub(super) const REMOTE_FAILED_EVENT: &str = "task.a2a_remote_failed";
/// Posted in place of a remote status message over decision 123's 16 KB, which isn't shown (ADR 0007).
pub(super) const TOO_LONG_NOTE: &str =
    "The agent's A2A endpoint sent a message that was too long to show here.";

fn attempt_for(sql: &SqlStorage, identity: &Identity, body: &Value) -> R<Option<Value>> {
    let id = body["attempt"].as_str().unwrap_or_default();
    let found = rows(
        sql,
        "SELECT * FROM a2a_attempt WHERE id = ?",
        vec![id.into()],
    )?
    .into_iter()
    .next();
    Ok(found.filter(|a| {
        identity.kind == "agent" && a["agent_id"].as_str() == Some(identity.id.as_str())
    }))
}

fn reason_of(body: &Value) -> &str {
    body["reason"]
        .as_str()
        .filter(|r| r.len() <= 40 && r.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
        .unwrap_or("ended")
}

fn end_reading(sql: &SqlStorage, id: &str, reason: &str, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE a2a_attempt SET reading_ended = 1, read_queued = 0, read_ended_reason = ?, updated_at = ? WHERE id = ? AND reading_ended = 0",
        vec![reason.into(), now.into(), id.into()],
    )
}

/// A read or cancel job: IDs, its kind, and a read's number. A struct, so it crosses the queue as a plain object.
#[derive(serde::Serialize)]
struct Job<'a> {
    ws: &'a str,
    attempt: &'a str,
    agent: &'a str,
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    read: Option<i64>,
}

/// Called when a send is answered with a remote task: the first read is due a minute later, and reading lasts 7 days.
pub(super) fn start_reading(sql: &SqlStorage, id: &str, now: i64) -> R<()> {
    exec(sql, "UPDATE a2a_attempt SET reading_ended = 0, read_until = ?, next_read_at = ?, read_no = 0, read_queued = 0 WHERE id = ?", vec![
        (now + podster_core::a2a::READ_FOR_MS).into(), (now + read_delay_ms(1)).into(), id.into(),
    ])
}

/// Queues the reads and cancels that are due. Reading past its 7 days ends here. A read queued but lost is queued again with
/// its own number, so a late original is then stale.
pub(super) async fn drain(env: &Env, sql: &SqlStorage, workspace_id: &str, now: i64) -> R<()> {
    let expired = rows(
        sql,
        "SELECT id, read_until FROM a2a_attempt WHERE reading_ended = 0",
        vec![],
    )?;
    for row in &expired {
        let until = row["read_until"].as_i64().unwrap_or(0);
        if !reading_open(now, until, false) {
            end_reading(sql, row["id"].as_str().unwrap_or_default(), "expired", now)?;
        }
    }
    let due = rows(sql, "SELECT id, agent_id, read_no, read_queued FROM a2a_attempt WHERE reading_ended = 0
        AND ((read_queued = 0 AND next_read_at <= ?) OR (read_queued = 1 AND read_queued_at <= ?)) ORDER BY next_read_at LIMIT ?",
        vec![now.into(), (now - READ_STALE_MS).into(), READ_BATCH.into()])?;
    let cancels = rows(
        sql,
        "SELECT id, agent_id FROM a2a_attempt WHERE cancel_state = 'due' LIMIT ?",
        vec![READ_BATCH.into()],
    )?;
    if due.is_empty() && cancels.is_empty() {
        return Ok(());
    }
    let queue = env.queue("A2A").ok();
    let mut failed = false;
    for row in &due {
        let id = text(&row["id"]).unwrap_or_default();
        let read = if int(&row["read_queued"]) == 1 {
            int(&row["read_no"])
        } else {
            int(&row["read_no"]) + 1
        };
        let agent = text(&row["agent_id"]).unwrap_or_default();
        let job = Job {
            ws: workspace_id,
            attempt: &id,
            agent: &agent,
            kind: "read",
            read: Some(read),
        };
        let sent = match &queue {
            Some(queue) => queue.send(job).await.is_ok(),
            None => false,
        };
        if sent {
            exec(sql, "UPDATE a2a_attempt SET read_no = ?, read_queued = 1, read_queued_at = ? WHERE id = ? AND reading_ended = 0", vec![
                read.into(), now.into(), id.as_str().into(),
            ])?;
        } else {
            failed = true;
            exec(sql, "UPDATE a2a_attempt SET read_queued = 0, next_read_at = ? WHERE id = ? AND reading_ended = 0", vec![
                (now + REQUEUE_MS).into(), id.as_str().into(),
            ])?;
        }
    }
    for row in &cancels {
        let id = text(&row["id"]).unwrap_or_default();
        let agent = text(&row["agent_id"]).unwrap_or_default();
        let job = Job {
            ws: workspace_id,
            attempt: &id,
            agent: &agent,
            kind: "cancel",
            read: None,
        };
        let sent = match &queue {
            Some(queue) => queue.send(job).await.is_ok(),
            None => false,
        };
        if sent {
            exec(sql, "UPDATE a2a_attempt SET cancel_state = 'queued' WHERE id = ? AND cancel_state = 'due'", vec![id.as_str().into()])?;
        } else {
            failed = true;
        }
    }
    if failed {
        console_error!(
            "{}",
            json!({ "event": "a2a.read_queue_failed", "workspace": workspace_id })
        );
    }
    Ok(())
}

/// When the next read or cancel is due to be queued, if any.
pub(super) fn next_due(sql: &SqlStorage, now: i64) -> R<Option<i64>> {
    let row = rows(sql, "SELECT
        (SELECT min(next_read_at) FROM a2a_attempt WHERE reading_ended = 0 AND read_queued = 0) AS read_at,
        (SELECT min(read_queued_at) FROM a2a_attempt WHERE reading_ended = 0 AND read_queued = 1) AS queued_at,
        (SELECT min(read_until) FROM a2a_attempt WHERE reading_ended = 0) AS until_at,
        (SELECT count(*) FROM a2a_attempt WHERE cancel_state = 'due') AS cancels", vec![])?;
    let Some(row) = row.first() else {
        return Ok(None);
    };
    let at = |name: &str| row[name].as_f64().map(|v| v as i64);
    let mut due = [
        at("read_at"),
        at("queued_at").map(|q| q + READ_STALE_MS),
        at("until_at"),
    ]
    .into_iter()
    .flatten()
    .min();
    if int(&row["cancels"]) > 0 {
        due = Some(due.map_or(now, |d| d.min(now)));
    }
    Ok(due)
}

/// `/internal/a2a-read-begin` with `{ attempt, read }`: whether to read now. Only the read queued last, for a sent attempt
/// still being read, by an agent still here.
fn read_begin(sql: &SqlStorage, identity: &Identity, body: &Value, now: i64) -> R<Value> {
    let Some(attempt) = attempt_for(sql, identity, body)? else {
        return Ok(json!({ "read": false, "reason": "no_attempt" }));
    };
    let id = attempt["id"].as_str().unwrap_or_default();
    let read = body["read"].as_i64().unwrap_or(-1);
    if int(&attempt["reading_ended"]) == 1
        || int(&attempt["read_queued"]) != 1
        || int(&attempt["read_no"]) != read
    {
        return Ok(json!({ "read": false, "reason": "stale" }));
    }
    if room_archived(sql)? {
        end_reading(sql, id, "room_archived", now)?;
        return Ok(json!({ "read": false, "reason": "room_archived" }));
    }
    match resolve_caller(sql, identity) {
        Ok(_) => {}
        Err(error) if error.status_and_code().0 < 500 => {
            end_reading(sql, id, "no_access", now)?;
            return Ok(json!({ "read": false, "reason": "no_access" }));
        }
        Err(error) => return Err(error),
    }
    Ok(json!({
        "read": true, "remote_task_id": attempt["remote_task_id"], "url": attempt["endpoint_url"], "version": attempt["endpoint_version"],
    }))
}

/// `/internal/a2a-read-end`: reading ends for good, because the endpoint or the agent can't be read from.
fn read_end(sql: &SqlStorage, identity: &Identity, body: &Value, now: i64) -> R<Value> {
    if let Some(attempt) = attempt_for(sql, identity, body)? {
        end_reading(
            sql,
            attempt["id"].as_str().unwrap_or_default(),
            reason_of(body),
            now,
        )?;
    }
    Ok(json!({ "ended": true }))
}

/// `/internal/a2a-read-failed`: the read got no usable answer. It counts toward the endpoint's failures, which the consumer
/// reports, and the next read waits as it would have.
fn read_failed(sql: &SqlStorage, identity: &Identity, body: &Value, now: i64) -> R<Value> {
    if let Some(attempt) = attempt_for(sql, identity, body)? {
        let read = body["read"].as_i64().unwrap_or(-1);
        if int(&attempt["read_queued"]) == 1 && int(&attempt["read_no"]) == read {
            exec(sql, "UPDATE a2a_attempt SET read_queued = 0, next_read_at = ?, updated_at = ? WHERE id = ? AND reading_ended = 0", vec![
                (now + read_delay_ms(read as u32 + 1)).into(), now.into(), attempt["id"].as_str().unwrap_or_default().into(),
            ])?;
        }
    }
    Ok(json!({ "recorded": true }))
}

/// What the effect does when its command is refused by policy or `decide`, as when the task moved on: nothing, or, for a
/// submission, holding the response instead.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Fallback {
    /// Run the effect.
    Run,
    /// Its command was refused: record the read and do nothing.
    Nothing,
    /// A submission was refused: hold the response for the requester instead.
    Hold,
}

fn effect_name(effect: &RemoteEffect) -> &'static str {
    match effect {
        RemoteEffect::Nothing(_) => "nothing",
        RemoteEffect::Accept { .. } => "accept",
        RemoteEffect::Submit { .. } => "submit",
        RemoteEffect::Decline { .. } => "decline",
        RemoteEffect::Release { .. } => "release",
        RemoteEffect::Message => "message",
        RemoteEffect::Hold { .. } => "hold",
        RemoteEffect::RecordCanceled => "remote_canceled",
        RemoteEffect::RecordReportedFailure => "remote_failed",
    }
}

fn to_parties(sql: &SqlStorage, agent: &str, parties: &[&str]) -> R<Vec<String>> {
    let mut out = Vec::new();
    for party in parties {
        if *party != agent
            && !out.iter().any(|p: &String| p == party)
            && participant(sql, party)?.is_some()
        {
            out.push(party.to_string());
        }
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn hold(
    sql: &SqlStorage,
    attempt: &str,
    task: &Task,
    agent: &str,
    read: i64,
    remote: &Value,
    working_seen: bool,
    now: i64,
) -> R<()> {
    // Only links that pass the same check as a submission's are kept. The rest are dropped and counted.
    let offered = remote["links"].as_array().cloned().unwrap_or_default();
    let links: Vec<Value> = offered
        .iter()
        .filter(|link| {
            let artifact = podster_core::Artifact {
                uri: link["uri"].as_str().unwrap_or_default().to_string(),
                label: link["label"].as_str().unwrap_or_default().to_string(),
            };
            podster_core::require_artifact(&artifact).is_ok()
        })
        .map(|link| json!({ "uri": link["uri"], "label": link["label"] }))
        .collect();
    let dropped = (offered.len() - links.len()) as i64;
    exec(sql, "INSERT OR REPLACE INTO a2a_held (attempt_id, task_id, read_no, note, links_json, working_seen, created_at, dropped_links) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", vec![
        attempt.into(), task.id.as_str().into(), read.into(), remote["note"].as_str().map_or(V::Null, V::from), Value::Array(links).to_string().into(),
        i64::from(working_seen).into(), now.into(), dropped.into(),
    ])?;
    record_event(
        sql,
        HELD_EVENT,
        agent,
        Some(&task.id),
        &Transition::NONE,
        to_parties(sql, agent, &[&task.requester])?,
        now,
    )
}

/// Runs one effect as the agent's own command. A refusal comes back as an error, and the caller records the read without it.
#[allow(clippy::too_many_arguments)]
fn run_effect(
    sql: &SqlStorage,
    who: &Participant,
    task: &Task,
    effect: &RemoteEffect,
    attempt: &str,
    read: i64,
    remote: &Value,
    now: i64,
) -> R<()> {
    let agent = who.caller.id.as_str();
    let command = |verb: &str, body: Value| {
        handle_task_command(sql, who, &task.id, verb, &body, now).map(|_| ())
    };
    match *effect {
        RemoteEffect::Nothing(_) => Ok(()),
        RemoteEffect::Accept { version } => command("accept", json!({ "version": version })),
        RemoteEffect::Decline { version } => command(
            "decline",
            json!({ "version": version, "reason": DECLINE_REASON }),
        ),
        RemoteEffect::Release { version } => command(
            "release",
            json!({ "version": version, "reason": RELEASE_REASON }),
        ),
        RemoteEffect::Submit { version } => {
            let links = remote["links"].as_array().cloned().unwrap_or_default();
            let note = remote["note"].as_str().filter(|n| !n.trim().is_empty());
            // Nothing usable to submit is held, as before acceptance.
            if links.is_empty() && note.is_none() {
                return Err(ApiError::invalid_argument());
            }
            command(
                "submit",
                json!({ "version": version, "note": note, "artifacts": links }),
            )
        }
        RemoteEffect::Message => {
            // Over the cap, a fixed note says so, and the remote's text isn't shown.
            let text = if remote["message_too_long"] == Value::Bool(true) {
                Some(TOO_LONG_NOTE)
            } else {
                remote["message"].as_str().filter(|m| !m.trim().is_empty())
            };
            match text {
                Some(text) => {
                    let posted =
                        handle_send_message(sql, who, &task.id, &json!({ "body": text }), now)?;
                    // Marked on the message itself, so the thread can show where it came from.
                    exec(
                        sql,
                        "UPDATE message SET origin = ? WHERE id = ?",
                        vec![
                            ORIGIN.into(),
                            posted["id"].as_str().unwrap_or_default().into(),
                        ],
                    )
                }
                None => Ok(()),
            }
        }
        RemoteEffect::Hold { working_seen } => {
            hold(sql, attempt, task, agent, read, remote, working_seen, now)
        }
        RemoteEffect::RecordCanceled => record_event(
            sql,
            REMOTE_CANCELED_EVENT,
            agent,
            Some(&task.id),
            &Transition::NONE,
            to_parties(sql, agent, &[&task.requester])?,
            now,
        ),
        RemoteEffect::RecordReportedFailure => record_event(
            sql,
            REMOTE_FAILED_EVENT,
            agent,
            Some(&task.id),
            &Transition::NONE,
            to_parties(sql, agent, &[&task.reviewer, &task.requester])?,
            now,
        ),
    }
}

/// `/internal/a2a-read-apply` with `{ attempt, read, url, version, remote }`. `url` and `version` are the endpoint as the
/// Principal registered it at this read, and `remote` is what the consumer parsed under the caps: `id`, `state`, and the
/// optional `message`, `note` and `links`. One transaction: `decide_remote`, recording the read, and the effect.
pub(super) fn read_apply(
    sql: &SqlStorage,
    identity: &Identity,
    body: &Value,
    now: i64,
    fallback: Fallback,
) -> R<Value> {
    let Some(row) = attempt_for(sql, identity, body)? else {
        return Ok(json!({ "applied": false, "reason": "no_attempt" }));
    };
    let id = row["id"].as_str().unwrap_or_default();
    let read = body["read"].as_i64().unwrap_or(-1);
    if int(&row["reading_ended"]) == 1
        || int(&row["read_queued"]) != 1
        || int(&row["read_no"]) != read
        || read < 1
    {
        return Ok(json!({ "applied": false, "reason": "stale" }));
    }
    let who = match resolve_caller(sql, identity) {
        Ok(who) => who,
        Err(error) if error.status_and_code().0 < 500 => {
            end_reading(sql, id, "no_access", now)?;
            return Ok(json!({ "applied": false, "reason": "no_access" }));
        }
        Err(error) => return Err(error),
    };
    let task_id = row["task_id"].as_str().unwrap_or_default();
    let Some(task) = load_task(sql, task_id)? else {
        end_reading(sql, id, "no_task", now)?;
        return Ok(json!({ "applied": false, "reason": "no_task" }));
    };
    // The offer or change request this attempt was sent for, and the one the task is on now (step 13b).
    let kind = super::a2a_out::kind_of(&row);
    let current = super::a2a_out::current_for(sql, kind, task_id)?;
    // A change request that new work superseded is read no more, and nothing it reports applies (step 13b review).
    let superseded = kind == podster_core::a2a::AttemptKind::ChangeRequest
        && current.as_deref() != row["offer_id"].as_str();
    let remote = &body["remote"];
    let last_state = row["last_state"].as_str().map(RemoteState::from_name);
    let attempt = Attempt {
        agent: &identity.id,
        offer: row["offer_id"].as_str().unwrap_or_default(),
        endpoint_url: row["endpoint_url"].as_str().unwrap_or_default(),
        endpoint_version: row["endpoint_version"].as_i64().unwrap_or(-1).max(0) as u64,
        remote_task_id: row["remote_task_id"].as_str().unwrap_or_default(),
        working_seen: int(&row["working_seen"]) == 1,
        last_read_no: int(&row["last_read_no"]).max(0) as u32,
        last_state,
        ended: false,
    };
    let endpoint = Endpoint {
        url: body["url"].as_str().unwrap_or_default(),
        version: body["version"].as_u64().unwrap_or(0),
        active: true,
    };
    let state = RemoteState::from_name(remote["state"].as_str().unwrap_or_default());
    let decision = decide_remote(
        &task,
        current.as_deref(),
        &attempt,
        Some(&endpoint),
        &RemoteRead {
            read_no: read as u32,
            remote_task_id: remote["id"].as_str().unwrap_or_default(),
            state,
        },
    );
    if decision.applied {
        exec(sql, "UPDATE a2a_attempt SET last_read_no = ?, last_state = ?, working_seen = ? WHERE id = ?", vec![
            read.into(), state.name().into(), i64::from(decision.working_seen).into(), id.into(),
        ])?;
    }
    exec(
        sql,
        "UPDATE a2a_attempt SET read_queued = 0, next_read_at = ?, updated_at = ? WHERE id = ?",
        vec![
            (now + read_delay_ms(read as u32 + 1)).into(),
            now.into(),
            id.into(),
        ],
    )?;
    if decision.stop_reading {
        end_reading(
            sql,
            id,
            if superseded {
                "superseded"
            } else {
                "read_ended"
            },
            now,
        )?;
    }
    let mut effect = effect_name(&decision.effect);
    // The same guard every room command runs, inside this transaction, so an archive during the read still stops its
    // effect. The read is recorded, with no effect, and reading ends.
    if command_guard(sql).is_err() {
        end_reading(sql, id, "room_archived", now)?;
        return Ok(
            json!({ "applied": decision.applied, "effect": "nothing", "reason": "room_archived" }),
        );
    }
    if fallback != Fallback::Nothing {
        let events_before = rows(
            sql,
            "SELECT coalesce(max(seq), 0) AS seq FROM event",
            vec![],
        )?
        .first()
        .map_or(0, |r| int(&r["seq"]));
        let audit_before = rows(sql, "SELECT audit_seq FROM workspace", vec![])?
            .first()
            .map_or(0, |r| int(&r["audit_seq"]));
        match fallback {
            Fallback::Hold => {
                hold(
                    sql,
                    id,
                    &task,
                    &identity.id,
                    read,
                    remote,
                    decision.working_seen,
                    now,
                )?;
                effect = "hold";
            }
            _ => run_effect(sql, &who, &task, &decision.effect, id, read, remote, now)?,
        }
        // Commands that change the task are the agent's own, so they're audited as its own, with how they arrived.
        if matches!(
            decision.effect,
            RemoteEffect::Accept { .. }
                | RemoteEffect::Submit { .. }
                | RemoteEffect::Decline { .. }
                | RemoteEffect::Release { .. }
        ) && fallback == Fallback::Run
        {
            audit_row(
                sql,
                &identity.id,
                "agent",
                &format!("task.{effect}"),
                task_id,
                None,
                None,
                now,
            )?;
        }
        exec(
            sql,
            "UPDATE event SET origin = ?, origin_ref = ? WHERE seq > ?",
            vec![ORIGIN.into(), id.into(), events_before.into()],
        )?;
        exec(
            sql,
            "UPDATE audit_event SET origin = ?, origin_ref = ? WHERE seq > ?",
            vec![ORIGIN.into(), id.into(), audit_before.into()],
        )?;
    } else if !matches!(decision.effect, RemoteEffect::Nothing(_)) {
        effect = "refused";
    }
    Ok(
        json!({ "applied": decision.applied, "effect": effect, "stop_reading": decision.stop_reading }),
    )
}

/// `/internal/a2a-cancel-begin`: whether to send `CancelTask` for this attempt, and to which remote task and endpoint.
fn cancel_begin(sql: &SqlStorage, identity: &Identity, body: &Value) -> R<Value> {
    match attempt_for(sql, identity, body)? {
        Some(a) if a["cancel_state"].as_str() == Some("queued") => Ok(json!({
            "cancel": true, "remote_task_id": a["remote_task_id"], "url": a["endpoint_url"], "version": a["endpoint_version"],
        })),
        _ => Ok(json!({ "cancel": false })),
    }
}

/// `/internal/a2a-cancel-finish` with `outcome`: `sent`, `refused` when the remote said it can't be canceled, or `skipped`
/// when it couldn't be sent at all, or `dead_lettered` when its retries ran out. Each is final.
fn cancel_finish(sql: &SqlStorage, identity: &Identity, body: &Value) -> R<Value> {
    let outcome = match body["outcome"].as_str() {
        Some(o @ ("sent" | "refused" | "skipped" | "dead_lettered")) => o,
        _ => return Err(ApiError::invalid_argument()),
    };
    if let Some(a) = attempt_for(sql, identity, body)? {
        exec(
            sql,
            "UPDATE a2a_attempt SET cancel_state = ? WHERE id = ? AND cancel_state = 'queued'",
            vec![outcome.into(), a["id"].as_str().unwrap_or_default().into()],
        )?;
    }
    Ok(json!({ "recorded": true }))
}

/// The read and cancel calls, each in a transaction of its own. A read whose effect is refused by policy or `decide` is applied
/// again without it, so the read still counts and reading goes on.
pub(super) fn step(state: &State, path: &str, identity: &Identity, body: Value) -> R<Value> {
    let run = |fallback: Fallback| -> R<Value> {
        let sql = state.storage().sql();
        let (identity, body, path) = (identity.clone(), body.clone(), path.to_string());
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        transaction_sync(state, move || {
            let now = now_ms();
            let answer = match path.as_str() {
                crate::INTERNAL_A2A_READ_BEGIN => read_begin(&sql, &identity, &body, now)?,
                crate::INTERNAL_A2A_READ_END => read_end(&sql, &identity, &body, now)?,
                crate::INTERNAL_A2A_READ_FAILED => read_failed(&sql, &identity, &body, now)?,
                crate::INTERNAL_A2A_READ_APPLY => {
                    read_apply(&sql, &identity, &body, now, fallback)?
                }
                crate::INTERNAL_A2A_CANCEL_BEGIN => cancel_begin(&sql, &identity, &body)?,
                crate::INTERNAL_A2A_CANCEL_FINISH => cancel_finish(&sql, &identity, &body)?,
                _ => return Err(ApiError::not_found()),
            };
            *slot.borrow_mut() = Some(answer);
            Ok(())
        })?;
        let value = out.borrow_mut().take();
        value.ok_or_else(|| ApiError::internal("a2a read step produced no result"))
    };
    match run(Fallback::Run) {
        Err(error) if path == crate::INTERNAL_A2A_READ_APPLY && error.status_and_code().0 < 500 => {
            let submit = body["remote"]["state"].as_str() == Some(RemoteState::Completed.name());
            run(if submit {
                Fallback::Hold
            } else {
                Fallback::Nothing
            })
        }
        other => other,
    }
}
