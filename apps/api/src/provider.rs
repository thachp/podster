//! A provider's webhook delivery, on its way to a room (M5 step 5, ADR 0009, which is proposed).
//!
//! The gateway verifies the provider's signature and sends on IDs and commit SHAs only, with an assertion that names no
//! one and binds that exact body. Here the assertion is verified, the body is checked against it and against the shape of
//! a nudge, and `repo_room_index` says which room to ask. That table is a read model and authorizes nothing: the room
//! checks the repository ID against its own link and drops anything else. A delivery is a nudge. It marks a task's change
//! as due a read of the provider and changes nothing else, and the read itself belongs to steps 6 to 8.
//!
//! Every delivery that gets past the assertion gets the same answer, whether a room took it or not, so the answer says
//! nothing about which repositories are managed. Logs carry the delivery ID, the room's ID and a fixed code.
use crate::error::ApiError;
use futures_util::future::{select, Either};
use podster_assertion::{verify_provider_delivery, KeySet};
use podster_core::provider_deliveries::{is_well_formed, EventKind, Nudge};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;
use wasm_bindgen::JsValue;
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// The room's side of this, reached only from here.
pub const INTERNAL_PROVIDER_DELIVERY: &str = "/internal/provider-delivery";
/// A nudge is a few IDs. Anything longer isn't one.
const MAX_BODY_BYTES: usize = 2048;
/// GitHub gives a delivery ten seconds, and the gateway waits less than that for this. Test builds wait as long: no test
/// times a room out here, and a shorter wait only failed deliveries on a busy machine.
const ROOM_TIMEOUT_MS: u64 = 3_000;

pub fn is_delivery_route(method: &Method, path: &str) -> bool {
    *method == Method::Post && path == "/v1/provider/github/deliveries"
}

/// Exactly what the gateway sends. An unknown field is refused, so a title or a branch name can't ride along.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sent {
    delivery_id: String,
    body_sha256: String,
    event: String,
    repository_id: i64,
    #[serde(default)]
    pull_requests: Vec<i64>,
    #[serde(default)]
    head_sha: Option<String>,
}

fn accepted() -> R<Response> {
    Ok(Response::from_json(&json!({ "accepted": true }))?.with_status(202))
}

pub async fn delivery(mut req: Request, env: Env) -> R<Response> {
    let token = req
        .headers()
        .get("x-podster-assertion")?
        .ok_or(ApiError::invalid_assertion())?;
    let keys = KeySet::from_json(&env.secret("ASSERTION_KEYS")?.to_string())
        .map_err(|_| ApiError::internal("bad ASSERTION_KEYS"))?;
    let now = (Date::now().as_millis() / 1000) as i64;
    let claim =
        verify_provider_delivery(&token, &keys, now).map_err(|_| ApiError::invalid_assertion())?;
    if claim.provider != "github" {
        return Err(ApiError::invalid_assertion());
    }
    let body = req.text().await?;
    // The assertion is for this body and no other.
    if body.len() > MAX_BODY_BYTES
        || format!("{:x}", Sha256::digest(body.as_bytes())) != claim.body_sha256
    {
        return Err(ApiError::invalid_assertion());
    }
    let sent: Sent = serde_json::from_str(&body).map_err(|_| ApiError::invalid_argument())?;
    let event = EventKind::from_name(&sent.event).ok_or_else(ApiError::invalid_argument)?;
    let nudge = Nudge {
        delivery_id: sent.delivery_id,
        body_sha256: sent.body_sha256,
        event,
        repository_id: sent.repository_id,
        pull_requests: sent.pull_requests,
        head_sha: sent.head_sha,
    };
    if nudge.delivery_id != claim.delivery || !is_well_formed(&nudge) {
        return Err(ApiError::invalid_argument());
    }

    let found = env
        .d1("DB")?
        .prepare("SELECT workspace_id FROM repo_room_index WHERE provider = 'github' AND provider_repo_id = ?")
        .bind(&[JsValue::from_f64(nudge.repository_id as f64)])?
        .first::<Value>(None)
        .await?;
    let Some(room) = found
        .as_ref()
        .and_then(|row| row["workspace_id"].as_str())
        .filter(|room| crate::valid_id(room))
    else {
        console_log!(
            "{}",
            json!({ "at": "provider.delivery", "delivery": nudge.delivery_id, "outcome": "no_room" })
        );
        return accepted();
    };

    let stub = env
        .durable_object("WORKSPACE")?
        .id_from_name(room)?
        .get_stub()?;
    let message = json!({
        "delivery_id": nudge.delivery_id,
        "body_sha256": nudge.body_sha256,
        "event": nudge.event.name(),
        "repository_id": nudge.repository_id,
        "pull_requests": nudge.pull_requests,
        "head_sha": nudge.head_sha,
    });
    let call = Box::pin(crate::forward(
        stub,
        INTERNAL_PROVIDER_DELIVERY,
        "",
        Headers::new(),
        Method::Post,
        Some(message.to_string()),
    ));
    let limit = Box::pin(Delay::from(Duration::from_millis(ROOM_TIMEOUT_MS)));
    let mut answer = match select(call, limit).await {
        Either::Left((answer, _)) => answer?,
        // Nobody knows how it went. The provider may send it again, and a second arrival of one the room took is refused there.
        Either::Right(_) => return Err(ApiError::api(504, "room_unavailable")),
    };
    if answer.status_code() >= 400 {
        console_log!(
            "{}",
            json!({ "at": "provider.delivery", "delivery": nudge.delivery_id, "room": room, "outcome": "room_error", "status": answer.status_code() })
        );
        return Err(ApiError::api(502, "room_unavailable"));
    }
    let outcome: Value = answer.json().await?;
    console_log!(
        "{}",
        json!({ "at": "provider.delivery", "delivery": nudge.delivery_id, "room": room, "outcome": outcome["outcome"] })
    );
    accepted()
}
