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
use podster_core::a2a::{offer_text, valid_remote_task_id};
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
fn answered(bytes: &[u8]) -> Sent {
    let Ok(body) = serde_json::from_slice::<Value>(bytes) else {
        return Sent::Failed;
    };
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

async fn send(url: &str, secret: &str, token: Option<&str>, body: &str) -> Sent {
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
            return Ok::<_, Error>(Sent::Failed);
        }
        Ok(match bounded(&mut response).await {
            Some(bytes) => answered(&bytes),
            None => Sent::Failed,
        })
    };
    // In test builds only the endpoint that never answers gets a short wait.
    let wait = if cfg!(feature = "failpoints") && url.contains("/hang") {
        300
    } else {
        SEND_TIMEOUT_MS
    };
    let timeout = Delay::from(Duration::from_millis(wait));
    let sent = match select(Box::pin(attempt), timeout).await {
        Either::Left((Ok(sent), _)) => sent,
        Either::Left((Err(_), _)) | Either::Right(_) => Sent::Failed,
    };
    controller.abort();
    sent
}

/// The exact JSON-RPC body: one text part, and the A2A task ID and attempt as metadata.
fn request_body(ws: &str, attempt: &str, task: &Value, link: Option<&str>) -> String {
    let text = offer_text(
        task["title"].as_str().unwrap_or_default(),
        task["instructions"].as_str().unwrap_or_default(),
        task["acceptance_criteria"].as_str(),
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
    let body = request_body(ws, attempt, &begun, link(env, ws).as_deref());
    let sent = send(
        url,
        claim["signing_secret"].as_str().unwrap_or_default(),
        claim["token"].as_str(),
        &body,
    )
    .await;
    let ok = matches!(sent, Sent::Answered(_));
    // Counted first, so three failures switch the endpoint off even if the room can't be reached to record this one.
    report_a2a_for(env, agent, version, ok).await?;
    let pinned = json!({ "attempt": attempt, "url": url, "version": version });
    match sent {
        Sent::Answered(remote) => {
            let mut finish = pinned;
            finish["outcome"] = json!("sent");
            finish["remote_task_id"] = json!(remote);
            room(env, ws, crate::INTERNAL_A2A_FINISH, agent, &claim, &finish).await?;
            log("a2a.send", ws, attempt, agent, "sent");
            Ok(Outcome::Ack)
        }
        Sent::Failed => {
            let mut finish = pinned;
            finish["outcome"] = json!("retry");
            room(env, ws, crate::INTERNAL_A2A_FINISH, agent, &claim, &finish).await?;
            log("a2a.send", ws, attempt, agent, "failed");
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

/// The dead-letter queue: jobs whose retries ran out. It logs their IDs and acknowledges them. The attempt stays as the room
/// last recorded it.
pub fn consume_dead(batch: MessageBatch<Value>) -> Result<()> {
    for message in batch.messages()? {
        let body = message.body();
        let id = |name: &str| {
            body[name]
                .as_str()
                .filter(|v| crate::valid_id(v))
                .unwrap_or("")
                .to_string()
        };
        console_error!(
            "{}",
            json!({ "event": "a2a.dead_letter", "workspace": id("ws"), "attempt": id("attempt"), "agent": id("agent") })
        );
        message.ack();
    }
    Ok(())
}
