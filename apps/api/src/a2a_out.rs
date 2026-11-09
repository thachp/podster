//! The A2A queue's consumer: one offer to an agent's registered A2A endpoint (M3 step 12, ADR 0007, decisions 117, 118, 122,
//! 123 and 129). The job holds IDs only. For each one:
//!
//! 1. the agent's Principal says whether to send, and where: the agent is still connected, its endpoint is on and still passes
//!    `crates/egress`'s rules, and whoever set it hasn't left the agent's organization. It answers with the signing secret
//!    and the token, which stay in memory here;
//! 2. the room rechecks the task and the agent's access from its own state, and only then gives the text;
//! 3. `SendMessage` goes out with `returnImmediately`, signed as wake's requests are, with the bearer token if one is stored,
//!    a timeout, and no redirects. Its `messageId` is the attempt's ID, so a retry is the same message;
//! 4. the result counts toward switching the endpoint off, and the room records the one remote task it answered with.
//!
//! The text is the one thing that leaves Podster with content in it. It, the URL, the token, the secret and the remote's
//! answer are never logged: logs carry IDs and outcomes only.

use crate::error::ApiError;
use crate::principal::{claim_a2a_for, report_a2a_for};
use futures_util::{
    future::{join_all, select, Either},
    StreamExt,
};
use podster_core::a2a::{
    offer_text_with_files, valid_remote_task_id, InputFile, MAX_REMOTE_ARTIFACTS, MAX_REMOTE_PARTS,
    MAX_REMOTE_TEXT_BYTES,
};
use serde_json::{json, Value};
use std::time::Duration;
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

const SEND_TIMEOUT_MS: u64 = 10_000;
const USER_AGENT: &str = "Podster-A2A/1 (+https://podster.dev)";
/// ADR 0007: a remote answer over this is refused unread past it, and counts as a failed send.
const MAX_ANSWER_BYTES: usize = 64 * 1024;
// Short in test builds, so retries can be watched.
const RETRY_DELAY_SECS: u32 = if cfg!(feature = "failpoints") { 1 } else { 60 };
/// Where the A2A task ID and attempt go in the message's metadata. Both are IDs.
const TASK_KEY: &str = "podster.dev/task";
const ATTEMPT_KEY: &str = "podster.dev/attempt";

/// What to do with the job.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Ack,
    Retry(u32),
}

fn log(event: &str, ws: &str, attempt: &str, agent: &str, outcome: &str) {
    console_log!(
        "{}",
        json!({ "event": event, "workspace": ws, "attempt": attempt, "agent": agent, "outcome": outcome })
    );
}

/// One room call, as the agent the Principal vouched for, with the generation it gave, so the room's fence still applies.
async fn room(
    env: &Env,
    ws: &str,
    path: &str,
    agent: &str,
    claim: &Value,
    body: &Value,
) -> R<Value> {
    let caller = crate::Caller {
        id: agent.to_string(),
        kind: "agent".to_string(),
        org: claim["org_id"].as_str().unwrap_or_default().to_string(),
        orgs: vec![],
        admin_orgs: vec![],
        org_since: Default::default(),
        target_member: None,
        gen: claim["generation"].as_u64(),
        linker: None,
        workspace_id: ws.to_string(),
    };
    let stub = env
        .durable_object("WORKSPACE")?
        .id_from_name(ws)?
        .get_stub()?;
    let mut response = crate::forward(
        stub,
        path,
        "",
        crate::caller_header(&caller)?,
        Method::Post,
        Some(body.to_string()),
    )
    .await?;
    if response.status_code() != 200 {
        return Err(ApiError::internal("room unavailable"));
    }
    Ok(response.json().await?)
}

/// What the endpoint said.
enum Sent {
    /// It answered with a task, whose ID is valid, or with a message and no task.
    Answered(Option<String>),
    /// Anything else: a refusal, a redirect, a timeout, a JSON-RPC error, an answer too big or that can't be read.
    Failed,
}

/// Reads at most `MAX_ANSWER_BYTES`, stopping there.
async fn bounded(response: &mut Response) -> Option<Vec<u8>> {
    if response
        .headers()
        .get("content-length")
        .ok()
        .flatten()
        .and_then(|n| n.parse::<usize>().ok())
        .is_some_and(|n| n > MAX_ANSWER_BYTES)
    {
        return None;
    }
    let mut stream = response.stream().ok()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.ok()?);
        if bytes.len() > MAX_ANSWER_BYTES {
            return None;
        }
    }
    Some(bytes)
}

/// The A2A 1.0 answer to `SendMessage`: `result.task` with an ID, or `result.message`. Anything else is a failure.
fn answered(body: &Value) -> Sent {
    if body.get("error").is_some_and(|e| !e.is_null()) {
        return Sent::Failed;
    }
    let result = &body["result"];
    match result["task"]["id"].as_str() {
        Some(id) if valid_remote_task_id(id) => Sent::Answered(Some(id.to_string())),
        Some(_) => Sent::Failed,
        None if result["message"].is_object() => Sent::Answered(None),
        None => Sent::Failed,
    }
}

/// One signed JSON-RPC request to the endpoint, with the token if there is one, a timeout and no redirects. Answers the parsed
/// body of a 2xx response read to at most `MAX_ANSWER_BYTES`, or `None` for anything else.
async fn rpc(url: &str, secret: &str, token: Option<&str>, body: &str) -> Option<Value> {
    let signature = podster_egress::sign(secret, (Date::now().as_millis() / 1000) as i64, body);
    let controller = AbortController::default();
    let signal = controller.signal();
    let attempt = async move {
        let headers = Headers::new();
        headers.set("content-type", "application/json")?;
        headers.set("a2a-version", "1.0")?;
        headers.set("user-agent", USER_AGENT)?;
        headers.set("x-podster-signature", &signature)?;
        if let Some(token) = token {
            headers.set("authorization", &format!("Bearer {token}"))?;
        }
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_redirect(RequestRedirect::Manual)
            .with_body(Some(body.into()));
        let mut response = Fetch::Request(Request::new_with_init(url, &init)?)
            .send_with_signal(&signal)
            .await?;
        if !(200..300).contains(&response.status_code()) {
            return Ok::<_, Error>(None);
        }
        Ok(bounded(&mut response)
            .await
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()))
    };
    // In test builds only the endpoint that never answers gets a short wait.
    let wait = if cfg!(feature = "failpoints") && url.contains("/hang") {
        300
    } else {
        SEND_TIMEOUT_MS
    };
    let timeout = Delay::from(Duration::from_millis(wait));
    let answer = match select(Box::pin(attempt), timeout).await {
        Either::Left((Ok(answer), _)) => answer,
        Either::Left((Err(_), _)) | Either::Right(_) => None,
    };
    controller.abort();
    answer
}

async fn send(url: &str, secret: &str, token: Option<&str>, body: &str) -> Sent {
    rpc(url, secret, token, body)
        .await
        .map_or(Sent::Failed, |body| answered(&body))
}

/// The exact JSON-RPC body: one text part, and the A2A task ID and attempt as metadata.
fn request_body(
    ws: &str,
    attempt: &str,
    task: &Value,
    link: Option<&str>,
    gateway: Option<&str>,
) -> String {
    // Input files are Podster links on the gateway's A2A resource, opened with the agent's `/a2a` token. Never bytes, never a
    // public URL.
    let listed = task["files"].as_array().cloned().unwrap_or_default();
    let links: Vec<Option<String>> = listed
        .iter()
        .map(|f| match (gateway, f["download_path"].as_str()) {
            // The same file under the A2A resource, which takes the agent's `/a2a` token. Only the API's own path is rewritten.
            (Some(gateway), Some(path)) => path
                .strip_prefix("/v1/files/")
                .map(|rest| format!("{gateway}/a2a/files/{rest}")),
            _ => None,
        })
        .collect();
    let files: Vec<InputFile> = listed
        .iter()
        .zip(&links)
        .map(|(f, link)| InputFile {
            id: f["id"].as_str().unwrap_or_default(),
            name: f["name"].as_str().unwrap_or_default(),
            link: link.as_deref(),
        })
        .collect();
    // The host the links are on, named in the offer as the only place to send the download credential.
    let host = gateway
        .and_then(|g| g.split("://").nth(1))
        .map(|rest| rest.split('/').next().unwrap_or(rest));
    let text = offer_text_with_files(
        task["title"].as_str().unwrap_or_default(),
        task["instructions"].as_str().unwrap_or_default(),
        task["acceptance_criteria"].as_str(),
        &files,
        host,
        link,
    );
    let task_id = task["task_id"].as_str().unwrap_or_default();
    json!({
        "jsonrpc": "2.0", "id": attempt, "method": "SendMessage",
        "params": {
            "message": {
                "messageId": attempt, "role": "ROLE_USER",
                "parts": [{ "text": text, "mediaType": "text/markdown" }],
                "metadata": { TASK_KEY: format!("{ws}:{task_id}"), ATTEMPT_KEY: attempt },
            },
            "configuration": { "returnImmediately": true },
        },
    })
    .to_string()
}

/// The gateway's public address, where an agent downloads a file with its own credential, if the API knows it.
fn gateway_url(env: &Env) -> Option<String> {
    let base = env.var("GATEWAY_URL").ok()?.to_string();
    let base = base.trim_end_matches('/').to_string();
    (base.starts_with("https://") || base.starts_with("http://")).then_some(base)
}

/// The room's task page, if the API knows the application's address. A link the agent opens needs its own sign-in.
fn link(env: &Env, ws: &str) -> Option<String> {
    let base = env.var("APP_URL").ok()?.to_string();
    let base = base.trim_end_matches('/');
    (base.starts_with("https://") || base.starts_with("http://"))
        .then(|| format!("{base}/w/{ws}/tasks"))
}

/// One job's work.
pub async fn process(env: &Env, job: &Value) -> R<Outcome> {
    let (ws, attempt, agent) = (
        job["ws"].as_str().unwrap_or_default(),
        job["attempt"].as_str().unwrap_or_default(),
        job["agent"].as_str().unwrap_or_default(),
    );
    if !crate::valid_id(ws) || !crate::valid_id(attempt) || !crate::valid_id(agent) {
        // A job like this can't become valid, so it isn't retried. It's logged so a bad sender can't fail silently.
        console_error!("{}", json!({ "event": "a2a.bad_job" }));
        return Ok(Outcome::Ack);
    }
    match job.get("kind").and_then(Value::as_str) {
        None => {}
        Some("read") => {
            return process_read(env, ws, attempt, agent, job["read"].as_i64().unwrap_or(-1)).await
        }
        Some("cancel") => return process_cancel(env, ws, attempt, agent).await,
        Some(_) => {
            console_error!("{}", json!({ "event": "a2a.bad_job" }));
            return Ok(Outcome::Ack);
        }
    }
    // The claim checks the URL against the endpoint's current registration, one call before the send. The URL and version
    // the room keeps on the attempt are a record of where it went, not the check. A retry claims again.
    let claim = claim_a2a_for(env, agent).await?;
    if claim["send"] != Value::Bool(true) {
        let reason = claim["reason"].as_str().unwrap_or("not_sent");
        room(
            env,
            ws,
            crate::INTERNAL_A2A_FINISH,
            agent,
            &claim,
            &json!({ "attempt": attempt, "outcome": "stopped", "reason": reason }),
        )
        .await?;
        log("a2a.send", ws, attempt, agent, reason);
        return Ok(Outcome::Ack);
    }
    let begun = room(
        env,
        ws,
        crate::INTERNAL_A2A_BEGIN,
        agent,
        &claim,
        &json!({ "attempt": attempt }),
    )
    .await?;
    if begun["sent"] == Value::Bool(true) {
        // Already recorded as sent by an earlier delivery whose later steps failed: only the report is left.
        if let Some(version) = begun["version"].as_u64() {
            report_a2a_for(env, agent, version, true).await?;
        }
        log("a2a.send", ws, attempt, agent, "already_sent");
        return Ok(Outcome::Ack);
    }
    if begun["send"] != Value::Bool(true) {
        let reason = begun["reason"].as_str().unwrap_or("not_sent");
        log("a2a.send", ws, attempt, agent, reason);
        return Ok(if begun["retry"] == Value::Bool(true) {
            Outcome::Retry(RETRY_DELAY_SECS)
        } else {
            Outcome::Ack
        });
    }
    let url = claim["url"].as_str().unwrap_or_default();
    let version = claim["version"].as_u64().unwrap_or(0);
    let body = request_body(
        ws,
        attempt,
        &begun,
        link(env, ws).as_deref(),
        gateway_url(env).as_deref(),
    );
    let sent = send(
        url,
        claim["signing_secret"].as_str().unwrap_or_default(),
        claim["token"].as_str(),
        &body,
    )
    .await;
    let pinned = json!({ "attempt": attempt, "url": url, "version": version });
    match sent {
        Sent::Answered(remote) => {
            // Recorded before anything else, so a failure after this can't send the offer again: a retry finds it sent and
            // only reports it.
            let mut finish = pinned;
            finish["outcome"] = json!("sent");
            finish["remote_task_id"] = json!(remote);
            room(env, ws, crate::INTERNAL_A2A_FINISH, agent, &claim, &finish).await?;
            report_a2a_for(env, agent, version, true).await?;
            log("a2a.send", ws, attempt, agent, "sent");
            Ok(Outcome::Ack)
        }
        Sent::Failed => {
            // Counted first, so three failures switch the endpoint off even if the room can't be reached to record this one.
            report_a2a_for(env, agent, version, false).await?;
            let mut finish = pinned;
            finish["outcome"] = json!("retry");
            room(env, ws, crate::INTERNAL_A2A_FINISH, agent, &claim, &finish).await?;
            log("a2a.send", ws, attempt, agent, "failed");
            Ok(Outcome::Retry(RETRY_DELAY_SECS))
        }
    }
}

/// Text parts only, joined, under decision 123's caps. `None` if there are more parts than the cap or the text is too long,
/// so the whole answer is refused rather than cut. Other parts are dropped.
fn texts_of(parts: &Value) -> Option<String> {
    let parts = match parts {
        Value::Null => return Some(String::new()),
        Value::Array(parts) => parts,
        _ => return None,
    };
    if parts.len() > MAX_REMOTE_PARTS {
        return None;
    }
    let text = parts
        .iter()
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    (text.len() <= MAX_REMOTE_TEXT_BYTES).then_some(text)
}

/// A message's URL parts, appended to its text as external links, one a line (M3 step 14, decision 121). Only a URL that passes
/// the same check as a submission's links is kept, and nothing is ever fetched. The link is the URL alone, so a label the
/// remote wrote can't dress it up.
fn with_links(text: String, parts: &Value) -> String {
    let links: Vec<&str> = parts
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["url"].as_str())
        .filter(|uri| {
            podster_core::require_artifact(&podster_core::Artifact {
                uri: uri.to_string(),
                label: "Link".to_string(),
            })
            .is_ok()
        })
        .collect();
    if links.is_empty() {
        return text;
    }
    let listed = links
        .iter()
        .map(|uri| format!("Link from the agent: {uri}"))
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        listed
    } else {
        format!("{text}\n\n{listed}")
    }
}

/// What Podster keeps of a `GetTask` answer: the task's ID and state, its status message's text, and its artifacts' text as
/// a note and URL parts as links. It's data. `None` if it isn't a task, or anything is past a cap.
fn remote_of(body: &Value) -> Option<Value> {
    if body.get("error").is_some_and(|e| !e.is_null()) {
        return None;
    }
    let result = &body["result"];
    let id = result["id"]
        .as_str()
        .filter(|id| valid_remote_task_id(id))?;
    let state = result["status"]["state"].as_str().unwrap_or_default();
    if state.len() > 64 {
        return None;
    }
    // A status message's text over 16 KB isn't refused: the room posts a fixed note in its place (ADR 0007). Too many parts
    // still refuses the whole answer.
    let status_parts = &result["status"]["message"]["parts"];
    if status_parts
        .as_array()
        .is_some_and(|p| p.len() > MAX_REMOTE_PARTS)
        || !(status_parts.is_null() || status_parts.is_array())
    {
        return None;
    }
    let (message, message_too_long) =
        match texts_of(status_parts).map(|text| with_links(text, status_parts)) {
            Some(text) if text.len() <= MAX_REMOTE_TEXT_BYTES => (text, false),
            _ => (String::new(), true),
        };
    let artifacts = match &result["artifacts"] {
        Value::Null => vec![],
        Value::Array(items) if items.len() <= MAX_REMOTE_ARTIFACTS => items.clone(),
        _ => return None,
    };
    let mut notes = Vec::new();
    let mut links = Vec::new();
    for artifact in &artifacts {
        let parts = artifact["parts"].as_array()?;
        notes.push(texts_of(&artifact["parts"])?);
        for part in parts {
            if let Some(uri) = part["url"].as_str() {
                let label = part["filename"]
                    .as_str()
                    .or(artifact["name"].as_str())
                    .unwrap_or("Result");
                links.push(json!({ "uri": uri, "label": label }));
            }
        }
    }
    let note = notes
        .into_iter()
        .filter(|n| !n.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if note.len() > MAX_REMOTE_TEXT_BYTES || links.len() > MAX_REMOTE_ARTIFACTS {
        return None;
    }
    Some(json!({
        "id": id, "state": state,
        "message": (!message.is_empty()).then_some(message),
        "message_too_long": message_too_long,
        "note": (!note.is_empty()).then_some(note),
        "links": links,
    }))
}

/// A read job (step 13): the same checks as a send, the endpoint still the one the offer went to, then `GetTask`, and the
/// room applies what it says. A read the endpoint didn't answer usably isn't retried by the queue: the room schedules the next.
async fn process_read(env: &Env, ws: &str, attempt: &str, agent: &str, read: i64) -> R<Outcome> {
    let claim = claim_a2a_for(env, agent).await?;
    let end = |reason: &str| json!({ "attempt": attempt, "read": read, "reason": reason });
    if claim["send"] != Value::Bool(true) {
        let reason = claim["reason"].as_str().unwrap_or("not_sent");
        room(
            env,
            ws,
            crate::INTERNAL_A2A_READ_END,
            agent,
            &claim,
            &end(reason),
        )
        .await?;
        log("a2a.read", ws, attempt, agent, reason);
        return Ok(Outcome::Ack);
    }
    let begun = room(
        env,
        ws,
        crate::INTERNAL_A2A_READ_BEGIN,
        agent,
        &claim,
        &json!({ "attempt": attempt, "read": read }),
    )
    .await?;
    if begun["read"] != Value::Bool(true) {
        log(
            "a2a.read",
            ws,
            attempt,
            agent,
            begun["reason"].as_str().unwrap_or("not_read"),
        );
        return Ok(Outcome::Ack);
    }
    // Pinned: a re-pointed or re-registered endpoint is never asked about a task it wasn't sent.
    if begun["url"] != claim["url"] || begun["version"].as_u64() != claim["version"].as_u64() {
        room(
            env,
            ws,
            crate::INTERNAL_A2A_READ_END,
            agent,
            &claim,
            &end("endpoint_changed"),
        )
        .await?;
        log("a2a.read", ws, attempt, agent, "endpoint_changed");
        return Ok(Outcome::Ack);
    }
    let url = claim["url"].as_str().unwrap_or_default();
    let version = claim["version"].as_u64().unwrap_or(0);
    let body = json!({
        "jsonrpc": "2.0", "id": format!("{attempt}:{read}"), "method": "GetTask",
        "params": { "id": begun["remote_task_id"], "historyLength": 0 },
    })
    .to_string();
    let answer = rpc(
        url,
        claim["signing_secret"].as_str().unwrap_or_default(),
        claim["token"].as_str(),
        &body,
    )
    .await;
    let remote = answer.as_ref().and_then(remote_of);
    report_a2a_for(env, agent, version, remote.is_some()).await?;
    match remote {
        Some(remote) => {
            let applied = room(env, ws, crate::INTERNAL_A2A_READ_APPLY, agent, &claim, &json!({
                "attempt": attempt, "read": read, "url": url, "version": version, "remote": remote,
            }))
            .await?;
            log(
                "a2a.read",
                ws,
                attempt,
                agent,
                applied["effect"].as_str().unwrap_or("nothing"),
            );
        }
        None => {
            room(
                env,
                ws,
                crate::INTERNAL_A2A_READ_FAILED,
                agent,
                &claim,
                &json!({ "attempt": attempt, "read": read }),
            )
            .await?;
            log("a2a.read", ws, attempt, agent, "failed");
        }
    }
    Ok(Outcome::Ack)
}

/// A2A's `TaskNotCancelableError`.
const TASK_NOT_CANCELABLE: i64 = -32002;

/// A cancel job (step 13): `CancelTask` once, to the endpoint the offer went to. A remote that says it can't cancel is recorded
/// and not retried, and a failure to send is retried by the queue.
async fn process_cancel(env: &Env, ws: &str, attempt: &str, agent: &str) -> R<Outcome> {
    let claim = claim_a2a_for(env, agent).await?;
    let finish = |outcome: &str| json!({ "attempt": attempt, "outcome": outcome });
    if claim["send"] != Value::Bool(true) {
        room(
            env,
            ws,
            crate::INTERNAL_A2A_CANCEL_FINISH,
            agent,
            &claim,
            &finish("skipped"),
        )
        .await?;
        log("a2a.cancel", ws, attempt, agent, "skipped");
        return Ok(Outcome::Ack);
    }
    let begun = room(
        env,
        ws,
        crate::INTERNAL_A2A_CANCEL_BEGIN,
        agent,
        &claim,
        &json!({ "attempt": attempt }),
    )
    .await?;
    if begun["cancel"] != Value::Bool(true) {
        return Ok(Outcome::Ack);
    }
    if begun["url"] != claim["url"] || begun["version"].as_u64() != claim["version"].as_u64() {
        room(
            env,
            ws,
            crate::INTERNAL_A2A_CANCEL_FINISH,
            agent,
            &claim,
            &finish("skipped"),
        )
        .await?;
        log("a2a.cancel", ws, attempt, agent, "endpoint_changed");
        return Ok(Outcome::Ack);
    }
    let version = claim["version"].as_u64().unwrap_or(0);
    let body = json!({ "jsonrpc": "2.0", "id": format!("{attempt}:cancel"), "method": "CancelTask", "params": { "id": begun["remote_task_id"] } }).to_string();
    let answer = rpc(
        claim["url"].as_str().unwrap_or_default(),
        claim["signing_secret"].as_str().unwrap_or_default(),
        claim["token"].as_str(),
        &body,
    )
    .await;
    let outcome = match &answer {
        Some(body) if body["error"]["code"].as_i64() == Some(TASK_NOT_CANCELABLE) => {
            Some("refused")
        }
        Some(body)
            if body.get("error").is_none_or(Value::is_null) && body["result"].is_object() =>
        {
            Some("sent")
        }
        _ => None,
    };
    match outcome {
        Some(outcome) => {
            // Recorded before the report, so a failure after this can't send the cancel again.
            room(
                env,
                ws,
                crate::INTERNAL_A2A_CANCEL_FINISH,
                agent,
                &claim,
                &finish(outcome),
            )
            .await?;
            report_a2a_for(env, agent, version, true).await?;
            log("a2a.cancel", ws, attempt, agent, outcome);
            Ok(Outcome::Ack)
        }
        None => {
            report_a2a_for(env, agent, version, false).await?;
            log("a2a.cancel", ws, attempt, agent, "failed");
            Ok(Outcome::Retry(RETRY_DELAY_SECS))
        }
    }
}

async fn handle(env: &Env, message: Message<Value>) {
    match process(env, message.body()).await {
        Ok(Outcome::Ack) => message.ack(),
        Ok(Outcome::Retry(delay)) => message.retry_with_options(
            &QueueRetryOptionsBuilder::new()
                .with_delay_seconds(delay)
                .build(),
        ),
        Err(error) => {
            console_error!(
                "{}",
                json!({ "event": "a2a.consume_failed", "code": error.code() })
            );
            message.retry_with_options(
                &QueueRetryOptionsBuilder::new()
                    .with_delay_seconds(RETRY_DELAY_SECS)
                    .build(),
            );
        }
    }
}

/// The A2A queue's batch, each job on its own, so a slow endpoint doesn't hold up the others.
pub async fn consume(batch: MessageBatch<Value>, env: &Env) -> Result<()> {
    join_all(
        batch
            .messages()?
            .into_iter()
            .map(|message| handle(env, message)),
    )
    .await;
    Ok(())
}

/// One dead-lettered job: the room ends its attempt as `dead_lettered`, unless it was already sent or stopped. Errors if the
/// room can't be reached, so the dead-letter queue retries it.
pub async fn dead_letter(env: &Env, job: &Value) -> R<()> {
    let id = |name: &str| {
        job[name]
            .as_str()
            .filter(|v| crate::valid_id(v))
            .unwrap_or("")
            .to_string()
    };
    let (ws, attempt, agent) = (id("ws"), id("attempt"), id("agent"));
    console_error!(
        "{}",
        json!({ "event": "a2a.dead_letter", "workspace": ws, "attempt": attempt, "agent": agent })
    );
    if ws.is_empty() || attempt.is_empty() || agent.is_empty() {
        return Ok(());
    }
    // A read needs nothing: the room queues a lost read again by itself. A cancel ends as dead_lettered.
    let (path, end) = match job.get("kind").and_then(Value::as_str) {
        Some("read") => return Ok(()),
        Some("cancel") => (
            crate::INTERNAL_A2A_CANCEL_FINISH,
            json!({ "attempt": attempt, "outcome": "dead_lettered" }),
        ),
        _ => (
            crate::INTERNAL_A2A_FINISH,
            json!({ "attempt": attempt, "outcome": "stopped", "reason": "dead_lettered" }),
        ),
    };
    room(env, &ws, path, &agent, &json!({}), &end).await?;
    Ok(())
}

/// The dead-letter queue: jobs whose retries ran out. Each ends its attempt, logs its IDs and is acknowledged. One whose room
/// can't be reached isn't acknowledged, so it's retried.
pub async fn consume_dead(batch: MessageBatch<Value>, env: &Env) -> Result<()> {
    for message in batch.messages()? {
        match dead_letter(env, message.body()).await {
            Ok(()) => message.ack(),
            Err(error) => {
                console_error!(
                    "{}",
                    json!({ "event": "a2a.dead_letter_failed", "code": error.code() })
                );
                message.retry();
            }
        }
    }
    Ok(())
}
