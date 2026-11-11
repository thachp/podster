//! The private Rust API: verifies the gateway's assertion and routes to Durable Objects.

// This crate indexes only `serde_json::Value` by string, which returns null for a missing key and can't panic.
#![allow(clippy::indexing_slicing)]

mod a2a_out;
mod downloads;
mod error;
mod github;
mod moderation;
mod objects;
mod principal;
mod provider;
mod public;
mod store;
mod wake;
mod workspace;

use error::ApiError;
use futures_util::future::{join_all, select, Either};
use podster_assertion::{verify, KeySet, Kind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use worker::*;

pub const CALLER_HEADER: &str = "x-podster-caller";
const CARDS_PER_PAGE: u32 = 20;
const CARD_TIMEOUT_MS: u64 = if cfg!(feature = "failpoints") {
    300
} else {
    3_000
};
pub const INTERNAL_INIT_PATH: &str = "/internal/init";
pub const INTERNAL_ACCEPT_PATH: &str = "/internal/accept";
pub const INTERNAL_PREVIEW_PATH: &str = "/internal/invitation-preview";
pub const INTERNAL_UPLOAD_BEGIN: &str = "/internal/upload-begin";
pub const INTERNAL_UPLOAD_COMPLETE: &str = "/internal/upload-complete";
pub const INTERNAL_SCAN_RESULT: &str = "/internal/scan-result";
pub const INTERNAL_DOWNLOAD: &str = "/internal/download";
pub const INTERNAL_A2A_BEGIN: &str = "/internal/a2a-begin";
pub const INTERNAL_A2A_FINISH: &str = "/internal/a2a-finish";
pub const INTERNAL_A2A_READ_BEGIN: &str = "/internal/a2a-read-begin";
pub const INTERNAL_A2A_READ_END: &str = "/internal/a2a-read-end";
pub const INTERNAL_A2A_READ_FAILED: &str = "/internal/a2a-read-failed";
pub const INTERNAL_A2A_READ_APPLY: &str = "/internal/a2a-read-apply";
pub const INTERNAL_A2A_CANCEL_BEGIN: &str = "/internal/a2a-cancel-begin";
pub const INTERNAL_A2A_CANCEL_FINISH: &str = "/internal/a2a-cancel-finish";
pub const AGENT_ID_PREFIX: &str = "agt_";
const MAX_ID_BYTES: usize = 128;
const OVERSIGHT_ORGS: usize = 50;
const OVERSIGHT_ROOMS: i32 = 200;

/// The verified caller, passed to Durable Objects. It says who they are, never what they may do.
#[derive(Clone, Serialize, Deserialize)]
pub struct Caller {
    pub id: String,
    pub kind: String,
    pub org: String,
    #[serde(default)]
    pub orgs: Vec<String>,
    #[serde(default)]
    pub admin_orgs: Vec<String>,
    #[serde(default)]
    pub org_since: std::collections::HashMap<String, i64>,
    #[serde(default)]
    pub target_member: Option<podster_assertion::TargetMember>,
    pub gen: Option<u64>,
    /// For an agent, who linked the credential this request came with. Recorded when it sets an A2A endpoint.
    #[serde(default)]
    pub linker: Option<podster_assertion::Linker>,
    #[serde(default)]
    pub workspace_id: String,
}

/// IDs are used as URL path segments, so they must always be addressable.
pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn caller_header(caller: &Caller) -> std::result::Result<Headers, ApiError> {
    let headers = Headers::new();
    headers.set(CALLER_HEADER, &serde_json::to_string(caller)?)?;
    Ok(headers)
}

async fn forward(
    stub: Stub,
    path: &str,
    query: &str,
    headers: Headers,
    method: Method,
    body: Option<String>,
) -> std::result::Result<Response, ApiError> {
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        init.with_body(Some(body.into()));
    }
    Ok(stub
        .fetch_with_request(Request::new_with_init(
            &format!("https://do{path}{query}"),
            &init,
        )?)
        .await?)
}

/// Tests share a few organizations across many rooms, so in test builds the limit only applies where a test asks for it.
fn room_limit_applies(org: &str) -> bool {
    !cfg!(feature = "failpoints") || org.starts_with("org_limit_")
}

async fn list_workspaces(env: &Env, caller: &Caller) -> std::result::Result<Response, ApiError> {
    let db = env.d1("DB")?;
    let found = db
        .prepare("SELECT workspace_id, workspace_name, role, org_id, workspace_status FROM membership_index WHERE principal_id = ? AND removed = 0 AND owner_left_at IS NULL ORDER BY workspace_name")
        .bind(&[caller.id.as_str().into()])?
        .all()
        .await?
        .results::<Value>()?;
    // A person who has left an organization isn't told about its rooms. Removal can't reach this index. An owner the room
    // knows has left isn't told either, even after rejoining, because the room is no longer theirs until recovery says so.
    let current: Vec<Value> = found
        .into_iter()
        .filter(|row| {
            row["org_id"]
                .as_str()
                .is_some_and(|org| org == caller.org || caller.orgs.iter().any(|o| o == org))
        })
        .map(|row| json!({ "workspace_id": row["workspace_id"], "workspace_name": row["workspace_name"], "role": row["role"], "status": row["workspace_status"] }))
        .collect();
    Ok(Response::from_json(&json!({ "workspaces": current }))?)
}

/// A page of the directory. The listing says which rooms to ask about, and each room decides what this person sees of it,
/// so the read model authorizes nothing. A page is capped, because each row wakes a room.
async fn list_workspace_cards(
    env: &Env,
    caller: &Caller,
    url: &Url,
) -> std::result::Result<Response, ApiError> {
    let offset = match url.query_pairs().find(|(key, _)| key == "offset") {
        Some((_, value)) => value
            .parse::<u32>()
            .map_err(|_| ApiError::invalid_argument())?,
        None => 0,
    };
    let found = env
        .d1("DB")?
        .prepare("SELECT workspace_id, workspace_name, role, org_id, workspace_status FROM membership_index WHERE principal_id = ? AND removed = 0 AND owner_left_at IS NULL ORDER BY workspace_name, workspace_id LIMIT ? OFFSET ?")
        .bind(&[caller.id.as_str().into(), (CARDS_PER_PAGE + 1).into(), offset.into()])?
        .all()
        .await?
        .results::<Value>()?;
    let more = found.len() > CARDS_PER_PAGE as usize;
    let cards = found
        .iter()
        .take(CARDS_PER_PAGE as usize)
        .filter(|row| {
            row["org_id"]
                .as_str()
                .is_some_and(|org| org == caller.org || caller.orgs.iter().any(|o| o == org))
        })
        .map(|row| workspace_card(env, caller, row));
    let cards: Vec<Value> = join_all(cards).await.into_iter().flatten().collect();
    let mut body = json!({ "workspaces": cards });
    if more {
        body["next_offset"] = json!(offset + CARDS_PER_PAGE);
    }
    Ok(Response::from_json(&body)?)
}

/// `None` if the room says this person isn't in it, because the listing can lag. If the room can't answer in time, the row
/// stays with no card, since the listing is all that's known, and one stuck room doesn't cost the others theirs.
async fn workspace_card(env: &Env, caller: &Caller, row: &Value) -> Option<Value> {
    let workspace = row["workspace_id"].as_str()?;
    let mut listed = json!({ "workspace_id": workspace, "workspace_name": row["workspace_name"], "role": row["role"], "status": row["workspace_status"], "card": null });
    let read = async {
        // Tests can't otherwise make a room hang.
        #[cfg(feature = "failpoints")]
        if workspace.starts_with("ws_hang_") {
            Delay::from(Duration::from_millis(CARD_TIMEOUT_MS * 20)).await;
        }
        let mut caller = caller.clone();
        caller.workspace_id = workspace.to_string();
        let stub = env
            .durable_object("WORKSPACE")?
            .id_from_name(workspace)?
            .get_stub()?;
        let path = format!("/v1/workspaces/{workspace}/card");
        let mut response =
            forward(stub, &path, "", caller_header(&caller)?, Method::Get, None).await?;
        let card = match response.status_code() {
            200 => Some(response.json::<Value>().await?),
            _ => None,
        };
        Ok::<_, ApiError>((response.status_code(), card))
    };
    let timeout = Delay::from(Duration::from_millis(CARD_TIMEOUT_MS));
    match select(Box::pin(read), timeout).await {
        Either::Left((Ok((_, Some(card))), _)) => listed["card"] = card,
        Either::Left((Ok((403 | 404, None)), _)) => return None,
        Either::Left((Ok((status, None)), _)) => {
            console_error!("room {workspace} answered {status} for its card");
        }
        Either::Left((Err(error), _)) => {
            console_error!("couldn't read room {workspace}'s card: {:?}", error.code());
        }
        Either::Right(_) => console_error!("room {workspace}'s card timed out"),
    }
    Some(listed)
}

/// Rooms the agents of the organizations this person administers are in. It only shows them, and each read of a task
/// asks the room, which decides from its own state.
async fn list_oversight_rooms(
    env: &Env,
    caller: &Caller,
) -> std::result::Result<Response, ApiError> {
    let db = env.d1("DB")?;
    let mut rooms = Vec::new();
    let mut truncated = caller.admin_orgs.len() > OVERSIGHT_ORGS;
    for org in caller.admin_orgs.iter().take(OVERSIGHT_ORGS) {
        let found = db
            .prepare("SELECT workspace_id, workspace_name, workspace_status, principal_id, org_id FROM membership_index WHERE org_id = ? AND removed = 0 AND principal_id LIKE 'agt\\_%' ESCAPE '\\' ORDER BY workspace_name LIMIT ?")
            .bind(&[org.as_str().into(), (OVERSIGHT_ROOMS + 1).into()])?
            .all()
            .await?
            .results::<Value>()?;
        truncated |= found.len() > OVERSIGHT_ROOMS as usize;
        rooms.extend(found.into_iter().take(OVERSIGHT_ROOMS as usize).map(|row| json!({
            "workspace_id": row["workspace_id"], "workspace_name": row["workspace_name"], "status": row["workspace_status"],
            "agent_id": row["principal_id"], "org_id": row["org_id"],
        })));
    }
    Ok(Response::from_json(
        &json!({ "rooms": rooms, "truncated": truncated }),
    )?)
}

/// Rooms of the organizations this person administers whose owner left, so they can run recovery. It only shows them,
/// and each room decides for itself when recovery runs. It's for rooms in their own organization, and has no content.
async fn list_ownerless_rooms(
    env: &Env,
    caller: &Caller,
) -> std::result::Result<Response, ApiError> {
    let db = env.d1("DB")?;
    let mut rooms = Vec::new();
    let mut truncated = caller.admin_orgs.len() > OVERSIGHT_ORGS;
    for org in caller.admin_orgs.iter().take(OVERSIGHT_ORGS) {
        let found = db
            .prepare("SELECT workspace_id, workspace_name, principal_id, owner_left_at FROM membership_index WHERE org_id = ? AND removed = 0 AND role = 'owner' AND owner_left_at IS NOT NULL ORDER BY workspace_name LIMIT ?")
            .bind(&[org.as_str().into(), (OVERSIGHT_ROOMS + 1).into()])?
            .all()
            .await?
            .results::<Value>()?;
        truncated |= found.len() > OVERSIGHT_ROOMS as usize;
        rooms.extend(found.into_iter().take(OVERSIGHT_ROOMS as usize).map(|row| {
            json!({
                "workspace_id": row["workspace_id"], "workspace_name": row["workspace_name"],
                "owner": row["principal_id"], "left_at": row["owner_left_at"],
            })
        }));
    }
    Ok(Response::from_json(
        &json!({ "rooms": rooms, "truncated": truncated }),
    )?)
}

async fn me(env: &Env, caller: &Caller) -> std::result::Result<Response, ApiError> {
    if caller.kind == "agent" {
        let stub = env
            .durable_object("PRINCIPAL")?
            .id_from_name(&caller.id)?
            .get_stub()?;
        return forward(
            stub,
            &format!("/v1/agents/{}", caller.id),
            "",
            caller_header(caller)?,
            Method::Get,
            None,
        )
        .await;
    }
    let unread = principal::unread(env, &caller.id).await?;
    Ok(Response::from_json(
        &json!({ "id": caller.id, "kind": caller.kind, "org_id": caller.org, "orgs": caller.orgs, "admin_orgs": caller.admin_orgs, "inbox_unread": unread }),
    )?)
}

async fn route(
    mut req: Request,
    env: Env,
    ctx: &Context,
) -> std::result::Result<Response, ApiError> {
    let path = req.path();
    if path == "/health" {
        return Ok(Response::ok("ok")?);
    }
    // The test pool can't run a queue consumer, so test builds reach the same work here.
    #[cfg(feature = "failpoints")]
    if path == "/test/consume-wake" {
        let body: Value = req.json().await?;
        let retry = wake::process(&env, body["agent"].as_str().unwrap_or_default()).await?;
        return Ok(Response::from_json(&json!({ "retry": retry }))?);
    }

    #[cfg(feature = "failpoints")]
    if path == "/test/consume-a2a" {
        let body: Value = req.json().await?;
        let outcome = match a2a_out::process(&env, &body).await? {
            a2a_out::Outcome::Ack => json!("ack"),
            a2a_out::Outcome::Retry(delay) => json!({ "retry": delay }),
        };
        return Ok(Response::from_json(&json!({ "outcome": outcome }))?);
    }

    #[cfg(feature = "failpoints")]
    if path == "/test/dead-letter-a2a" {
        let body: Value = req.json().await?;
        a2a_out::dead_letter(&env, &body).await?;
        return Ok(Response::from_json(&json!({ "outcome": "ack" }))?);
    }

    // The scanner has no identity in any room, and only its secret lets it say anything.
    if path == INTERNAL_SCAN_RESULT && req.method() == Method::Post {
        return objects::scan_result(req, env).await;
    }
    // The bytes of an upload carry its token, not an assertion, and the room checks that against who asked for the upload.
    if req.method() == Method::Put {
        if let ["v1", "uploads", room, id] = path
            .trim_start_matches('/')
            .split('/')
            .collect::<Vec<_>>()
            .as_slice()
        {
            return objects::stream_upload(req, env, room, id).await;
        }
    }

    // The public room page is the one route that takes the public assertion, so it's verified on its own, before the
    // identity every other route needs (M4 step 7).
    {
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        if let Some(handle) = public::room_page_handle(&req.method(), &parts) {
            let handle = handle.to_string();
            return public::room_page(req, env, &handle).await;
        }
    }

    // A provider's webhook delivery names no one, so it has its own assertion, taken on this one route (M5 step 5).
    if provider::is_delivery_route(&req.method(), &path) {
        return provider::delivery(req, env).await;
    }

    let token = req
        .headers()
        .get("x-podster-assertion")?
        .ok_or(ApiError::invalid_assertion())?;
    let keys = KeySet::from_json(&env.secret("ASSERTION_KEYS")?.to_string())
        .map_err(|_| ApiError::internal("bad ASSERTION_KEYS"))?;
    let now = (Date::now().as_millis() / 1000) as i64;
    let identity = verify(&token, &keys, now).map_err(|_| ApiError::invalid_assertion())?;
    let is_agent = identity.kind == Kind::Agent;
    let departure = identity.departure.clone();
    let identity_replay = identity.agent_jti.clone();
    let identity_replay_exp = identity.agent_jti_exp.unwrap_or(identity.exp);
    let mut caller = Caller {
        id: identity.sub,
        kind: if is_agent { "agent" } else { "person" }.to_string(),
        org: identity.org,
        orgs: identity.orgs,
        admin_orgs: identity.admin_orgs,
        org_since: identity.org_since,
        target_member: identity.target_member,
        gen: identity.gen,
        // Only an agent's credential has a linker.
        linker: identity.linker.filter(|_| is_agent),
        workspace_id: String::new(),
    };

    // Every agent request checks its connection first, so an assertion minted before a disconnect stops working.
    if is_agent {
        let spent = identity_replay
            .as_deref()
            .map(|key| (key, identity_replay_exp));
        principal::check_active(&env, &caller.id, caller.gen, spent).await?;
    }

    let method = req.method();
    let url = req.url()?;
    let query = url.query().map(|q| format!("?{q}")).unwrap_or_default();
    let segments: Vec<String> = path
        .trim_start_matches('/')
        .split('/')
        .map(str::to_string)
        .collect();
    let parts: Vec<&str> = segments.iter().map(String::as_str).collect();
    let body = if matches!(method, Method::Post | Method::Put | Method::Delete) {
        Some(req.text().await?)
    } else {
        None
    };

    let (workspace_id, forward_path) = match parts.as_slice() {
        ["v1", "me"] if method == Method::Get => return me(&env, &caller).await,
        ["v1", "files", ws, id] if method == Method::Get => {
            return downloads::stream_download(&env, caller, ws, id).await;
        }
        // Addressed by the verified caller, so nobody can name another principal's inbox here.
        ["v1", "inbox", ..] => {
            let stub = env
                .durable_object("PRINCIPAL")?
                .id_from_name(&caller.id)?
                .get_stub()?;
            return forward(stub, &path, &query, caller_header(&caller)?, method, body).await;
        }
        // Explore needs sign-in (decision 155), so it takes only an identity.
        ["v1", "public", "explore"] if method == Method::Get => {
            return public::explore(&env, &caller, &url, &req).await;
        }
        // A public claim (M4 step 8): agents only, with their identity like any command.
        ["v1", "public", "workrooms", handle, "claim"] if method == Method::Post => {
            return public::claim(&env, ctx, &caller, handle, body.as_deref(), &req).await;
        }
        // An organization's provisioning delegation (M5 step 4): a Podster operator gives it, and its admins may read it.
        ["v1", "orgs", org, "provisioning-delegation"]
            if matches!(method, Method::Get | Method::Put) =>
        {
            return principal::provisioning_delegation(
                &env,
                &caller,
                org,
                (method == Method::Put).then_some(body.as_deref().unwrap_or("")),
            )
            .await;
        }
        // Reports and operator actions (M4 step 10). People only: an agent is refused in each, by its kind.
        ["v1", "reports"] if method == Method::Post => {
            return moderation::report(&env, &caller, body.as_deref(), &req).await;
        }
        ["v1", "moderation", "reports"] if method == Method::Get => {
            return moderation::list_reports(&env, &caller, &url).await;
        }
        ["v1", "moderation", "reports", report, verb @ ("suspend-room" | "lift-room")]
            if method == Method::Post =>
        {
            return moderation::suspend_room_by_report(
                &env,
                &caller,
                report,
                *verb == "suspend-room",
                body.as_deref(),
            )
            .await;
        }
        ["v1", "moderation", "repositories", workspace, "recheck"] if method == Method::Post => {
            let key = req.headers().get("idempotency-key")?;
            return moderation::recheck_repository(&env, &caller, workspace, key).await;
        }
        ["v1", "moderation", "rooms", handle, verb @ ("suspend" | "lift")]
            if method == Method::Post =>
        {
            return moderation::set_room_suspension(
                &env,
                &caller,
                handle,
                *verb == "suspend",
                body.as_deref(),
            )
            .await;
        }
        ["v1", "moderation", "agents", agent, verb @ ("suspend" | "lift")]
            if method == Method::Post =>
        {
            return moderation::set_agent_suspension(
                &env,
                &caller,
                agent,
                *verb == "suspend",
                body.as_deref(),
            )
            .await;
        }
        ["v1", "workspaces"] if method == Method::Get => {
            return list_workspaces(&env, &caller).await
        }
        ["v1", "workspaces", "cards"] if method == Method::Get => {
            return list_workspace_cards(&env, &caller, &url).await
        }
        ["v1", "oversight", "rooms"] if method == Method::Get => {
            if is_agent {
                return Err(ApiError::not_allowed());
            }
            return list_oversight_rooms(&env, &caller).await;
        }
        ["v1", "oversight", "ownerless"] if method == Method::Get => {
            if is_agent {
                return Err(ApiError::not_allowed());
            }
            return list_ownerless_rooms(&env, &caller).await;
        }
        ["v1", "org-departures"] if method == Method::Post => {
            // Only the gateway's own removal states a departure. The person who left may have made the request.
            let departure = departure
                .filter(|d| !is_agent && valid_id(&d.person) && valid_id(&d.org))
                .ok_or_else(ApiError::not_allowed)?;
            return principal::record_org_departure(&env, &departure, &caller.id).await;
        }
        ["v1", "agents", agent, ..] => {
            if !valid_id(agent) {
                return Err(ApiError::agent_not_found());
            }
            let stub = env
                .durable_object("PRINCIPAL")?
                .id_from_name(agent)?
                .get_stub()?;
            let headers = caller_header(&caller)?;
            if cfg!(feature = "failpoints") {
                if let Some(value) = req.headers().get("x-test-hold-fan-out")? {
                    headers.set("x-test-hold-fan-out", &value)?;
                }
            }
            return forward(stub, &path, &query, headers, method, body).await;
        }
        ["v1", "workspaces"] if method == Method::Post => {
            if is_agent {
                return Err(ApiError::not_allowed());
            }
            let workspace = format!("ws_{}", uuid::Uuid::new_v4().simple());
            // Someone who can't create takes no slot, and the room gives their refusal.
            let counted =
                caller.admin_orgs.contains(&caller.org) && room_limit_applies(&caller.org);
            if counted {
                principal::reserve_org_room(&env, &caller.org, &workspace).await?;
            }
            caller.workspace_id = workspace.clone();
            let stub = env
                .durable_object("WORKSPACE")?
                .id_from_name(&workspace)?
                .get_stub()?;
            let created = forward(
                stub,
                INTERNAL_INIT_PATH,
                &query,
                caller_header(&caller)?,
                method,
                body,
            )
            .await;
            // A failure here can come after the room committed, so only a definite refusal gives the slot back. Keeping it
            // when in doubt can only make the count too high, never let an organization pass the limit.
            #[cfg(feature = "failpoints")]
            let created = if req.headers().get("x-test-fail")?.is_some() {
                Err(ApiError::internal("injected failure after creating"))
            } else {
                created
            };
            let refused = created
                .as_ref()
                .is_ok_and(|response| (400..500).contains(&response.status_code()));
            if counted && refused {
                if let Err(error) = principal::release_org_room(&env, &caller.org, &workspace).await
                {
                    console_error!("couldn't give back a room slot: {:?}", error.code());
                }
            }
            return created;
        }
        ["v1", "invitations", "preview"] if method == Method::Post => {
            if is_agent {
                return Err(ApiError::not_allowed());
            }
            let parsed: Value = serde_json::from_str(body.as_deref().unwrap_or(""))
                .map_err(|_| ApiError::invalid_argument())?;
            let workspace = parsed["token"]
                .as_str()
                .and_then(workspace::workspace_of_token)
                .ok_or_else(ApiError::invitation_not_found)?;
            (workspace, INTERNAL_PREVIEW_PATH.to_string())
        }
        ["v1", "invitations", "accept"] if method == Method::Post => {
            if is_agent {
                return Err(ApiError::not_allowed());
            }
            let parsed: Value = serde_json::from_str(body.as_deref().unwrap_or(""))
                .map_err(|_| ApiError::invalid_argument())?;
            let token = parsed["token"]
                .as_str()
                .ok_or_else(ApiError::invalid_argument)?;
            let workspace =
                workspace::workspace_of_token(token).ok_or_else(ApiError::invitation_not_found)?;
            (workspace, INTERNAL_ACCEPT_PATH.to_string())
        }
        ["v1", "workspaces", ws, ..] => ((*ws).to_string(), path.clone()),
        _ => return Err(ApiError::not_found()),
    };

    let stub = env
        .durable_object("WORKSPACE")?
        .id_from_name(&workspace_id)?
        .get_stub()?;
    caller.workspace_id = workspace_id;
    let headers = caller_header(&caller)?;
    let forwarded: &[&str] = if cfg!(feature = "failpoints") {
        &[
            "idempotency-key",
            "x-test-fail",
            "x-test-join-generation",
            "x-test-public-rooms",
        ]
    } else {
        &["idempotency-key"]
    };
    for name in forwarded {
        if let Some(value) = req.headers().get(name)? {
            headers.set(name, &value)?;
        }
    }
    forward(stub, &forward_path, &query, headers, method, body).await
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
    match route(req, env, &ctx).await {
        Ok(response) => Ok(response),
        Err(error) => error.into_response(),
    }
}
