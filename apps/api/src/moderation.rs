//! Reports and operator actions (M4 step 10, decisions 158 and 160).
//!
//! One `Moderation` Durable Object keeps every report and every operator action, so the daily report limit is exact.
//! Operators are person IDs in the `OPERATORS` secret, checked here in Rust against the verified caller. They see
//! reports, never a room's private state, and their only powers are suspending and lifting a room's public surface, which
//! the room itself records and decides from, and an agent's public claims, which the agent's `Principal` keeps.
//!
//! Logs carry IDs and codes only, never a report's note.
use crate::error::ApiError;
use crate::store::{exec, int, rows, transaction_sync};
use crate::{forward, principal, valid_id, Caller};
use podster_policy::moderation::{
    check_report, is_operator, parse_operators, Reason, REPORT_WINDOW_MS,
};
use podster_policy::public::is_public_handle;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::rc::Rc;
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// Reports an operator reads in one page.
const PAGE: i64 = 50;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS report (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, reporter TEXT NOT NULL,
  request_key TEXT NOT NULL, request_hash TEXT NOT NULL, handle TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT,
  reason TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, UNIQUE (reporter, request_key));
CREATE INDEX IF NOT EXISTS report_by_reporter ON report (reporter, created_at);
CREATE TABLE IF NOT EXISTS operator_action (seq INTEGER PRIMARY KEY, operator TEXT NOT NULL, subject_kind TEXT NOT NULL,
  subject TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending', ended_at INTEGER);
";

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

fn moderation(env: &Env) -> R<Stub> {
    Ok(env
        .durable_object("MODERATION")?
        .id_from_name("moderation")?
        .get_stub()?)
}

async fn call(env: &Env, path: &str, method: Method, body: Option<Value>) -> R<Response> {
    forward(
        moderation(env)?,
        path,
        "",
        Headers::new(),
        method,
        body.map(|b| b.to_string()),
    )
    .await
}

/// Writes an operator's action that has already happened into the operators' record. The action stands whether or not
/// this does, so a failure is logged by ID and goes no further.
pub(crate) async fn record_operator_action(
    env: &Env,
    operator: &str,
    subject_kind: &str,
    subject: &str,
    action: &str,
) {
    let begin = json!({ "operator": operator, "subject_kind": subject_kind, "subject": subject, "action": action, "reason": "other" });
    let recorded = async {
        let mut begun = call(env, "/action-begin", Method::Post, Some(begin)).await?;
        let seq: Value = begun.json().await?;
        call(
            env,
            "/action-end",
            Method::Post,
            Some(json!({ "seq": seq["seq"], "outcome": "done" })),
        )
        .await?;
        Ok::<_, ApiError>(())
    };
    if recorded.await.is_err() {
        console_error!(
            "{}",
            json!({ "at": "operator_action.not_recorded", "operator": operator, "subject": subject, "action": action })
        );
    }
}

/// Refuses anyone who isn't a configured operator. An agent never is.
pub(crate) fn require_operator(env: &Env, caller: &Caller) -> R<()> {
    // A secret on staging, which the owner sets (docs/staging.md), or a plain binding in tests.
    let configured = env
        .secret("OPERATORS")
        .map(|v| v.to_string())
        .or_else(|_| env.var("OPERATORS").map(|v| v.to_string()))
        .unwrap_or_default();
    if is_operator(&caller.kind, &caller.id, &parse_operators(&configured)) {
        Ok(())
    } else {
        Err(ApiError::not_allowed())
    }
}

fn object(body: Option<&str>) -> R<serde_json::Map<String, Value>> {
    let parsed: Value =
        serde_json::from_str(body.unwrap_or("")).map_err(|_| ApiError::invalid_argument())?;
    match parsed {
        Value::Object(fields) => Ok(fields),
        _ => Err(ApiError::invalid_argument()),
    }
}

/// The room a handle names in the discovery index, by any row: a suspended or unpublished room keeps its last handle on
/// its tombstone, so an operator can still lift what they suspended. `resolvable` asks for a room public now.
async fn room_for_handle(env: &Env, handle: &str, resolvable: bool) -> R<Option<String>> {
    if !is_public_handle(handle) {
        return Ok(None);
    }
    let query = if resolvable {
        "SELECT workspace_id FROM public_workroom_index WHERE public_handle = ? AND resolvable = 1"
    } else {
        "SELECT workspace_id FROM public_workroom_index WHERE public_handle = ?"
    };
    let found = env
        .d1("DB")?
        .prepare(query)
        .bind(&[handle.into()])?
        .first::<Value>(None)
        .await?;
    Ok(found.and_then(|row| row["workspace_id"].as_str().map(str::to_owned)))
}

/// `POST /v1/reports { handle, agent_id?, reason, note? }`: a signed-in person reports a public room, or an agent seen in
/// one. 10 a day per person. A retry with the same idempotency key answers with the same report.
pub async fn report(env: &Env, caller: &Caller, body: Option<&str>, req: &Request) -> R<Response> {
    if caller.kind != "person" {
        return Err(ApiError::not_allowed());
    }
    let key = req
        .headers()
        .get("idempotency-key")?
        .filter(|k| !k.is_empty() && k.len() <= 200)
        .ok_or_else(ApiError::idempotency_required)?;
    let fields = object(body)?;
    if fields
        .keys()
        .any(|k| !matches!(k.as_str(), "handle" | "agent_id" | "reason" | "note"))
    {
        return Err(ApiError::invalid_argument());
    }
    let handle = fields
        .get("handle")
        .and_then(Value::as_str)
        .ok_or_else(ApiError::invalid_argument)?;
    let agent = match fields.get("agent_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if valid_id(id) && id.starts_with("agt_") => Some(id.clone()),
        Some(_) => return Err(ApiError::invalid_argument()),
    };
    let reason = fields
        .get("reason")
        .and_then(Value::as_str)
        .ok_or_else(ApiError::invalid_argument)?;
    let note = match fields.get("note") {
        None | Some(Value::Null) => None,
        Some(Value::String(note)) => Some(note.clone()),
        Some(_) => return Err(ApiError::invalid_argument()),
    };
    // The checks that need no count first, so a bad request doesn't reach the room or the queue.
    check_report(&caller.kind, reason, note.as_deref(), 0)
        .map_err(|refusal| ApiError::api(status_of(refusal.code()), refusal.code()))?;
    // The same request, by its parsed fields, so a retry with reordered keys is still the same one.
    let hash = format!(
        "{:x}",
        Sha256::digest(
            json!({ "handle": handle, "agent_id": agent, "reason": reason, "note": note })
                .to_string()
                .as_bytes()
        )
    );
    // A retry answers with the report it made before the room is looked up, so one made private or suspended since still
    // gets its answer. The same key with a different request is refused.
    let mut earlier = call(
        env,
        "/report-lookup",
        Method::Post,
        Some(json!({ "reporter": caller.id, "request_key": key, "request_hash": hash })),
    )
    .await?;
    if earlier.status_code() != 200 {
        return Ok(earlier);
    }
    let found: Value = earlier.json().await?;
    if !found["report"].is_null() {
        return Ok(Response::from_json(&found["report"])?);
    }
    if !crate::workspace::public_rooms_enabled(env, req)? {
        return Err(ApiError::workspace_not_found());
    }
    let Some(workspace) = room_for_handle(env, handle, true).await? else {
        return Err(ApiError::workspace_not_found());
    };
    let request = json!({
        "reporter": caller.id, "request_key": key, "request_hash": hash, "handle": handle, "workspace_id": workspace,
        "agent_id": agent, "reason": reason, "note": note,
    });
    call(env, "/report", Method::Post, Some(request)).await
}

fn status_of(code: &str) -> u16 {
    match code {
        "not_allowed" => 403,
        "limit_exceeded" => 409,
        _ => 400,
    }
}

/// `GET /v1/moderation/reports?cursor=`: the operator's queue, newest first.
pub async fn list_reports(env: &Env, caller: &Caller, url: &Url) -> R<Response> {
    require_operator(env, caller)?;
    let cursor = url
        .query_pairs()
        .find(|(k, _)| k == "cursor")
        .map(|(_, v)| v.into_owned());
    let path = match cursor {
        Some(c) if c.chars().all(|ch| ch.is_ascii_digit()) && !c.is_empty() && c.len() < 20 => {
            format!("/reports?before={c}")
        }
        Some(_) => return Err(ApiError::invalid_argument()),
        None => "/reports".to_string(),
    };
    call(env, &path, Method::Get, None).await
}

fn reason_of(body: Option<&str>) -> R<Reason> {
    let fields = object(body)?;
    if fields.keys().any(|k| k != "reason") {
        return Err(ApiError::invalid_argument());
    }
    fields
        .get("reason")
        .and_then(Value::as_str)
        .and_then(Reason::from_name)
        .ok_or_else(ApiError::invalid_argument)
}

/// Writes the operator's action as intent before it's carried out, so no action happens without a row. `Err` refuses the
/// action. Answers the row's number, for [`finish`].
async fn begin(
    env: &Env,
    operator: &str,
    kind: &str,
    subject: &str,
    action: &str,
    reason: Reason,
) -> R<i64> {
    let entry = json!({ "operator": operator, "subject_kind": kind, "subject": subject, "action": action, "reason": reason.name() });
    let mut response = call(env, "/action-begin", Method::Post, Some(entry)).await?;
    if response.status_code() != 200 {
        return Err(ApiError::internal("operator action not recorded"));
    }
    let body: Value = response.json().await?;
    body["seq"]
        .as_i64()
        .ok_or_else(|| ApiError::internal("operator action not recorded"))
}

/// Marks how the action ended: `done`, or the refusal's code. A row left `pending` is an action whose outcome was lost.
async fn finish(env: &Env, seq: i64, outcome: &str) {
    let marked = match call(
        env,
        "/action-end",
        Method::Post,
        Some(json!({ "seq": seq, "outcome": outcome })),
    )
    .await
    {
        Ok(response) => response.status_code() == 200,
        Err(_) => false,
    };
    if !marked {
        console_error!("operator action outcome not recorded: seq={seq}");
    }
}

/// Asks the room to suspend or lift, recorded as intent first and its outcome after. `handle` is checked by the room; a
/// report's action names the room itself and sends none.
#[allow(clippy::too_many_arguments)]
async fn suspend_room(
    env: &Env,
    operator: &str,
    workspace: &str,
    handle: Option<&str>,
    subject_kind: &str,
    subject: &str,
    suspended: bool,
    reason: Reason,
) -> R<std::result::Result<Value, Response>> {
    let action = if suspended { "suspend" } else { "lift" };
    let seq = begin(env, operator, subject_kind, subject, action, reason).await?;
    let request = json!({ "suspended": suspended, "reason": reason.name(), "handle": handle });
    let stub = env
        .durable_object("WORKSPACE")?
        .id_from_name(workspace)?
        .get_stub()?;
    let answered = forward(
        stub,
        crate::workspace::INTERNAL_SUSPENSION,
        "",
        Headers::new(),
        Method::Post,
        Some(request.to_string()),
    )
    .await;
    #[cfg(feature = "failpoints")]
    let answered = lose_answer(env, subject, answered).await;
    let mut response = match answered {
        Ok(response) => response,
        Err(error) => {
            // The room's answer was lost: the action may have committed, so it's no refusal.
            finish(env, seq, "unknown").await;
            return Err(error);
        }
    };
    if response.status_code() != 200 {
        finish(env, seq, &format!("refused_{}", response.status_code())).await;
        return Ok(Err(response));
    }
    let answer: Value = response.json().await?;
    finish(env, seq, "done").await;
    Ok(Ok(answer))
}

/// `POST /v1/moderation/rooms/{handle}/suspend` or `/lift`, `{ reason }`: an operator suspends or lifts a room's public
/// surface. The room records it, audited as the operator, and decides from it.
pub async fn set_room_suspension(
    env: &Env,
    caller: &Caller,
    handle: &str,
    suspended: bool,
    body: Option<&str>,
) -> R<Response> {
    require_operator(env, caller)?;
    let reason = reason_of(body)?;
    let Some(workspace) = room_for_handle(env, handle, false).await? else {
        return Err(ApiError::workspace_not_found());
    };
    match suspend_room(
        env,
        &caller.id,
        &workspace,
        Some(handle),
        "room",
        handle,
        suspended,
        reason,
    )
    .await?
    {
        Ok(mut answer) => {
            answer["handle"] = json!(handle);
            Ok(Response::from_json(&answer)?)
        }
        Err(refused) => Ok(refused),
    }
}

/// `POST /v1/moderation/reports/{report}/suspend-room` or `/lift-room`, `{ reason }`: an operator suspends or lifts the
/// room a report was about, found from the report on the server, so it works after the owner made the room private or
/// published it again under a new handle. Neither the room's internal ID nor its handle is shown.
pub async fn suspend_room_by_report(
    env: &Env,
    caller: &Caller,
    report: &str,
    suspended: bool,
    body: Option<&str>,
) -> R<Response> {
    require_operator(env, caller)?;
    let reason = reason_of(body)?;
    if !report.starts_with("rpt_") || !valid_id(report) {
        return Err(ApiError::not_found());
    }
    let mut found = call(env, &format!("/report-room?id={report}"), Method::Get, None).await?;
    if found.status_code() != 200 {
        return Ok(found);
    }
    let room: Value = found.json().await?;
    let workspace = room["workspace_id"]
        .as_str()
        .ok_or_else(ApiError::not_found)?
        .to_string();
    match suspend_room(
        env, &caller.id, &workspace, None, "report", report, suspended, reason,
    )
    .await?
    {
        Ok(mut answer) => {
            answer["report_id"] = json!(report);
            Ok(Response::from_json(&answer)?)
        }
        Err(refused) => Ok(refused),
    }
}

/// `POST /v1/moderation/agents/{agent}/suspend` or `/lift`, `{ reason }`: an operator suspends or lifts an agent's public
/// claims. Claims it already holds stay.
pub async fn set_agent_suspension(
    env: &Env,
    caller: &Caller,
    agent: &str,
    suspended: bool,
    body: Option<&str>,
) -> R<Response> {
    require_operator(env, caller)?;
    let reason = reason_of(body)?;
    if !valid_id(agent) || !agent.starts_with("agt_") {
        return Err(ApiError::agent_not_found());
    }
    let action = if suspended { "suspend" } else { "lift" };
    let seq = begin(env, &caller.id, "agent", agent, action, reason).await?;
    let answered =
        principal::set_public_claims_suspension(env, agent, suspended, reason.name()).await;
    #[cfg(feature = "failpoints")]
    let answered = lose_answer(env, agent, answered).await;
    let mut answer = match answered {
        Ok(answer) => answer,
        Err(error) => {
            // Only the Principal's own refusal is one. Anything else may have landed.
            let outcome = match error.code() {
                Some("agent_not_found") => "agent_not_found",
                _ => "unknown",
            };
            finish(env, seq, outcome).await;
            return Err(error);
        }
    };
    finish(env, seq, "done").await;
    answer["agent_id"] = json!(agent);
    Ok(Response::from_json(&answer)?)
}

#[durable_object]
pub struct Moderation {
    state: State,
}

impl Moderation {
    fn in_transaction(&self, f: impl FnOnce() -> R<Value> + 'static) -> R<Value> {
        let outcome = Rc::new(RefCell::new(None));
        let slot = outcome.clone();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(f()?);
            Ok(())
        })?;
        let value = outcome.borrow_mut().take();
        value.ok_or_else(|| ApiError::internal("no transaction result"))
    }

    async fn dispatch(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        exec(&sql, SCHEMA, vec![])?;
        match (req.method(), req.path().as_str()) {
            (Method::Post, "/report") => {
                let body: Value = req.json().await?;
                self.in_transaction(move || keep_report(&sql, &body, now_ms()))
            }
            (Method::Get, "/reports") => {
                let before = req
                    .url()?
                    .query_pairs()
                    .find(|(k, _)| k == "before")
                    .and_then(|(_, v)| v.parse::<i64>().ok());
                list(&sql, before)
            }
            (Method::Post, "/report-lookup") => {
                let body: Value = req.json().await?;
                Ok(json!({ "report": earlier_report(&sql, &body)? }))
            }
            // The room a report was about, for an operator's action. The Worker never answers with it.
            (Method::Get, "/report-room") => {
                let id = req
                    .url()?
                    .query_pairs()
                    .find(|(k, _)| k == "id")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default();
                rows(
                    &sql,
                    "SELECT workspace_id FROM report WHERE id = ?",
                    vec![id.into()],
                )?
                .first()
                .map(|row| json!({ "workspace_id": row["workspace_id"] }))
                .ok_or_else(ApiError::not_found)
            }
            (Method::Post, "/action-begin") => {
                let body: Value = req.json().await?;
                exec(
                    &sql,
                    "INSERT INTO operator_action (operator, subject_kind, subject, action, reason, at) VALUES (?, ?, ?, ?, ?, ?)",
                    vec![
                        body["operator"].as_str().unwrap_or_default().into(),
                        body["subject_kind"].as_str().unwrap_or_default().into(),
                        body["subject"].as_str().unwrap_or_default().into(),
                        body["action"].as_str().unwrap_or_default().into(),
                        body["reason"].as_str().unwrap_or_default().into(),
                        now_ms().into(),
                    ],
                )?;
                let seq = rows(&sql, "SELECT last_insert_rowid() AS seq", vec![])?
                    .first()
                    .map_or(0, |row| int(&row["seq"]));
                Ok(json!({ "seq": seq }))
            }
            (Method::Post, "/action-end") => {
                let body: Value = req.json().await?;
                exec(
                    &sql,
                    "UPDATE operator_action SET outcome = ?, ended_at = ? WHERE seq = ? AND outcome = 'pending'",
                    vec![
                        body["outcome"].as_str().unwrap_or("unknown").into(),
                        now_ms().into(),
                        body["seq"].as_i64().unwrap_or(0).into(),
                    ],
                )?;
                Ok(json!({ "marked": true }))
            }
            _ => Err(ApiError::not_found()),
        }
    }
}

/// Keeps a report, counting the reporter's reports in the last day, in one transaction. A retry with the same key answers
/// with the report it made.
fn keep_report(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let text = |name: &str| body[name].as_str().unwrap_or_default().to_string();
    let (reporter, key) = (text("reporter"), text("request_key"));
    // Asked again while the first was being kept.
    let earlier = earlier_report(sql, body)?;
    if !earlier.is_null() {
        return Ok(earlier);
    }
    let made = rows(
        sql,
        "SELECT COUNT(*) AS n FROM report WHERE reporter = ? AND created_at > ?",
        vec![reporter.as_str().into(), (now - REPORT_WINDOW_MS).into()],
    )?
    .first()
    .map_or(0, |row| int(&row["n"]));
    let note = body["note"].as_str();
    check_report(
        "person",
        body["reason"].as_str().unwrap_or_default(),
        note,
        u32::try_from(made).unwrap_or(u32::MAX),
    )
    .map_err(|refusal| ApiError::api(status_of(refusal.code()), refusal.code()))?;
    let id = format!("rpt_{}", uuid::Uuid::new_v4().simple());
    exec(
        sql,
        "INSERT INTO report (id, reporter, request_key, request_hash, handle, workspace_id, agent_id, reason, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        vec![
            id.as_str().into(),
            reporter.as_str().into(),
            key.as_str().into(),
            text("request_hash").into(),
            text("handle").into(),
            text("workspace_id").into(),
            body["agent_id"].as_str().map(str::to_owned).into(),
            text("reason").into(),
            note.map(str::to_owned).into(),
            now.into(),
        ],
    )?;
    Ok(json!({ "id": id, "created_at": now }))
}

/// The report this reporter made with this key, as its answer, or null. The same key with a different request is
/// refused with `idempotency_mismatch`, as every other command does.
fn earlier_report(sql: &SqlStorage, body: &Value) -> R<Value> {
    let found = rows(
        sql,
        "SELECT id, created_at, request_hash FROM report WHERE reporter = ? AND request_key = ?",
        vec![
            body["reporter"].as_str().unwrap_or_default().into(),
            body["request_key"].as_str().unwrap_or_default().into(),
        ],
    )?;
    let Some(row) = found.first() else {
        return Ok(Value::Null);
    };
    if row["request_hash"].as_str() != body["request_hash"].as_str() {
        return Err(ApiError::idempotency_mismatch());
    }
    Ok(json!({ "id": row["id"], "created_at": row["created_at"] }))
}

/// A page of reports, newest first. Neither the reporter nor the room's internal ID is shown: an operator sees the handle,
/// the agent named, the reason and the note.
fn list(sql: &SqlStorage, before: Option<i64>) -> R<Value> {
    let found = rows(
        sql,
        "SELECT seq, id, handle, agent_id, reason, note, created_at FROM report WHERE seq < ? ORDER BY seq DESC LIMIT ?",
        vec![before.unwrap_or(i64::MAX).into(), (PAGE + 1).into()],
    )?;
    let more = found.len() as i64 > PAGE;
    let page: Vec<&Value> = found.iter().take(PAGE as usize).collect();
    let next = if more {
        page.last().map(|row| int(&row["seq"]).to_string())
    } else {
        None
    };
    let reports: Vec<Value> = page
        .iter()
        .map(|row| {
            json!({
                "id": row["id"], "handle": row["handle"], "agent_id": row["agent_id"], "reason": row["reason"],
                "note": row["note"], "created_at": row["created_at"],
            })
        })
        .collect();
    Ok(json!({ "reports": reports, "next_cursor": next }))
}

impl DurableObject for Moderation {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        match self.dispatch(req).await {
            Ok(value) => Response::from_json(&value),
            Err(error) => error.into_response(),
        }
    }
}

/// Test builds only: a test can lose the answer to an operator's action after it was carried out, as a dropped connection
/// would, by naming its subject in D1's `test_lose_operator_answer` table.
#[cfg(feature = "failpoints")]
async fn lose_answer<T>(env: &Env, subject: &str, answered: R<T>) -> R<T> {
    let Ok(db) = env.d1("DB") else {
        return answered;
    };
    let exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_lose_operator_answer'")
        .first::<Value>(None)
        .await;
    if !matches!(exists, Ok(Some(_))) {
        return answered;
    }
    let Ok(named) = db
        .prepare("SELECT subject FROM test_lose_operator_answer WHERE subject = ?")
        .bind(&[subject.into()])
    else {
        return answered;
    };
    if matches!(named.first::<Value>(None).await, Ok(Some(_))) {
        return Err(ApiError::internal("test: answer lost"));
    }
    answered
}
