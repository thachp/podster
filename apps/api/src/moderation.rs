//! Reports and operator actions (M4 step 10, decisions 158 and 160).
//!
//! One `Moderation` Durable Object keeps every report and every operator action, so the daily report limit is exact.
//! Operators are person IDs in the `OPERATORS` variable, checked here in Rust against the verified caller. They see
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
use std::cell::RefCell;
use std::rc::Rc;
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// Reports an operator reads in one page.
const PAGE: i64 = 50;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS report (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, reporter TEXT NOT NULL,
  request_key TEXT NOT NULL, handle TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT, reason TEXT NOT NULL,
  note TEXT, created_at INTEGER NOT NULL, UNIQUE (reporter, request_key));
CREATE INDEX IF NOT EXISTS report_by_reporter ON report (reporter, created_at);
CREATE TABLE IF NOT EXISTS operator_action (seq INTEGER PRIMARY KEY, operator TEXT NOT NULL, subject_kind TEXT NOT NULL,
  subject TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);
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

/// Refuses anyone who isn't a configured operator. An agent never is.
fn require_operator(env: &Env, caller: &Caller) -> R<()> {
    let configured = env
        .var("OPERATORS")
        .map(|v| v.to_string())
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
    if !crate::workspace::public_rooms_enabled(env, req)? {
        return Err(ApiError::workspace_not_found());
    }
    let Some(workspace) = room_for_handle(env, handle, true).await? else {
        return Err(ApiError::workspace_not_found());
    };
    let request = json!({
        "reporter": caller.id, "request_key": key, "handle": handle, "workspace_id": workspace, "agent_id": agent,
        "reason": reason, "note": note,
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

async fn log(env: &Env, operator: &str, kind: &str, subject: &str, action: &str, reason: Reason) {
    let entry = json!({ "operator": operator, "subject_kind": kind, "subject": subject, "action": action, "reason": reason.name() });
    let logged = match call(env, "/action", Method::Post, Some(entry)).await {
        Ok(response) => response.status_code() == 200,
        Err(_) => false,
    };
    if !logged {
        console_error!("operator action not logged: kind={kind} action={action}");
    }
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
    let request = json!({ "suspended": suspended, "reason": reason.name(), "operator": caller.id });
    let stub = env
        .durable_object("WORKSPACE")?
        .id_from_name(&workspace)?
        .get_stub()?;
    let mut response = forward(
        stub,
        crate::workspace::INTERNAL_SUSPENSION,
        "",
        Headers::new(),
        Method::Post,
        Some(request.to_string()),
    )
    .await?;
    if response.status_code() != 200 {
        return Ok(response);
    }
    let mut answer: Value = response.json().await?;
    let action = if suspended { "suspend" } else { "lift" };
    log(env, &caller.id, "room", handle, action, reason).await;
    answer["handle"] = json!(handle);
    Ok(Response::from_json(&answer)?)
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
    let mut answer =
        principal::set_public_claims_suspension(env, agent, suspended, reason.name(), &caller.id)
            .await?;
    let action = if suspended { "suspend" } else { "lift" };
    log(env, &caller.id, "agent", agent, action, reason).await;
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
            (Method::Post, "/action") => {
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
                Ok(json!({ "logged": true }))
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
    let earlier = rows(
        sql,
        "SELECT id, created_at FROM report WHERE reporter = ? AND request_key = ?",
        vec![reporter.as_str().into(), key.as_str().into()],
    )?;
    if let Some(row) = earlier.first() {
        return Ok(json!({ "id": row["id"], "created_at": row["created_at"] }));
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
        "INSERT INTO report (id, reporter, request_key, handle, workspace_id, agent_id, reason, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        vec![
            id.as_str().into(),
            reporter.as_str().into(),
            key.as_str().into(),
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
