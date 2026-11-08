//! The wake queue's consumer: a signed nudge to an agent's URL. It carries no content, and the inbox stays the source of
//! truth, so an agent that's never woken still finds every event.

use crate::principal::{claim_wake_for, report_wake_for};
use futures_util::future::{join_all, select, Either};
use serde_json::{json, Value};
use std::time::Duration;
use worker::*;

const SEND_TIMEOUT_MS: u64 = 10_000;
const USER_AGENT: &str = "Podster-Wake/1 (+https://podster.dev)";
// Short in test builds, so retries can be watched.
const RETRY_DELAY_SECS: u32 = if cfg!(feature = "failpoints") { 1 } else { 60 };

/// Sends one wake. Redirects count as failures, so a URL that passed the policy can't forward the request elsewhere.
async fn send(url: &str, secret: &str, body: &str) -> bool {
    let signature = podster_egress::sign(secret, (Date::now().as_millis() / 1000) as i64, body);
    let controller = AbortController::default();
    let signal = controller.signal();
    let attempt = async move {
        let headers = Headers::new();
        headers.set("content-type", "application/json")?;
        headers.set("user-agent", USER_AGENT)?;
        headers.set("x-podster-signature", &signature)?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_redirect(RequestRedirect::Manual)
            .with_body(Some(body.into()));
        Fetch::Request(Request::new_with_init(url, &init)?)
            .send_with_signal(&signal)
            .await
    };
    // In test builds only the hook that never answers gets a short wait. A real timeout on a slow machine is a failed send, and a false one.
    let wait = if cfg!(feature = "failpoints") && url.contains("/hang") {
        300
    } else {
        SEND_TIMEOUT_MS
    };
    let timeout = Delay::from(Duration::from_millis(wait));
    let delivered = match select(Box::pin(attempt), timeout).await {
        Either::Left((result, _)) => {
            let result: Result<Response> = result;
            result.is_ok_and(|response| (200..300).contains(&response.status_code()))
        }
        Either::Right(_) => false,
    };
    // Ends the connection either way: a hung one would hold a slot, and nobody reads a response body.
    controller.abort();
    delivered
}

/// One message's work. Returns how long to wait before retrying, if it should be retried.
pub async fn process(
    env: &Env,
    agent: &str,
) -> std::result::Result<Option<u32>, crate::error::ApiError> {
    let claim: Value = claim_wake_for(env, agent).await?;
    if claim["send"] != Value::Bool(true) {
        // Queued early because of the delay cap, so wait out the rest of the window.
        return Ok(claim["retry_after"].as_u64().map(|secs| secs as u32));
    }
    let body = json!({ "agent_id": claim["agent_id"], "unread": claim["unread"], "at": Date::now().as_millis() as i64 }).to_string();
    let ok = send(
        claim["url"].as_str().unwrap_or_default(),
        claim["secret"].as_str().unwrap_or_default(),
        &body,
    )
    .await;
    let report = report_wake_for(env, agent, ok, &claim).await?;
    Ok((report["retry"] == Value::Bool(true)).then_some(RETRY_DELAY_SECS))
}

async fn handle(env: &Env, message: Message<Value>) {
    let Some(agent) = message.body()["agent"]
        .as_str()
        .filter(|agent| !agent.is_empty())
    else {
        // Nothing to retry: a message like this can't become valid. It's logged so a bad sender can't fail silently.
        console_error!("wake message without an agent");
        message.ack();
        return;
    };
    match process(env, agent).await {
        Ok(None) => message.ack(),
        Ok(Some(delay)) => message.retry_with_options(
            &QueueRetryOptionsBuilder::new()
                .with_delay_seconds(delay)
                .build(),
        ),
        Err(error) => {
            console_error!("wake failed: {:?}", error);
            message.retry_with_options(
                &QueueRetryOptionsBuilder::new()
                    .with_delay_seconds(RETRY_DELAY_SECS)
                    .build(),
            );
        }
    }
}

/// One consumer per Worker, so the A2A queue and its dead-letter queue are dispatched by name. Everything else is wake's.
#[event(queue)]
pub async fn consume(batch: MessageBatch<Value>, env: Env, _ctx: Context) -> Result<()> {
    let queue = batch.queue();
    if queue.starts_with("podster-a2a-dlq") {
        return crate::a2a_out::consume_dead(batch, &env).await;
    }
    if queue.starts_with("podster-a2a") {
        return crate::a2a_out::consume(batch, &env).await;
    }
    // Handles a batch together, so a slow receiver doesn't hold up the others in it.
    join_all(
        batch
            .messages()?
            .into_iter()
            .map(|message| handle(&env, message)),
    )
    .await;
    Ok(())
}
