//! The public read surface's two API routes (M4 step 7, ADR 0008).
//!
//! - **`GET /v1/public/workrooms/{handle}`**, the room page, is the only route that takes the gateway's public assertion.
//!   It's verified here with `verify_room_page_caller`, before and apart from the identity every other route verifies, so
//!   no other route can be handed a public caller.
//! - **`GET /v1/public/explore`** needs sign-in (decision 155), so it's routed after the identity check like any route.
//!
//! `public_workroom_index` only says which room to ask. The room decides from its current state, and anything not public
//! now, a missing or malformed handle, `PUBLIC_ROOMS` off, or an index row that isn't resolvable, gets the same not-found
//! without reaching a room. Logs carry room IDs and error codes only, never a handle someone typed.
use crate::error::ApiError;
use crate::{caller_header, forward, principal, Caller};
use futures_util::future::{join_all, select, Either};
use podster_assertion::{verify_room_page_caller, KeySet, Kind, RoomPageCaller};
use podster_policy::public::{is_public_handle, parse_topic, Topic};
use serde_json::{json, Value};
use std::time::Duration;
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// Explore pages hold 20 rooms at most, so a page wakes at most 20 rooms.
pub const EXPLORE_PAGE: usize = 20;
/// A room that can't answer in time is left off the page, so one stuck room doesn't hold the rest.
const ROOM_TIMEOUT_MS: u64 = if cfg!(feature = "failpoints") {
    300
} else {
    3_000
};

/// The handle, if this is the room page's route.
pub fn room_page_handle<'a>(method: &Method, parts: &[&'a str]) -> Option<&'a str> {
    match parts {
        ["v1", "public", "workrooms", handle] if *method == Method::Get => Some(handle),
        _ => None,
    }
}

fn not_found<T>() -> R<T> {
    Err(ApiError::workspace_not_found())
}

fn enabled(env: &Env, req: &Request) -> R<bool> {
    crate::workspace::public_rooms_enabled(env, req)
}

fn room(env: &Env, workspace: &str) -> R<Stub> {
    Ok(env
        .durable_object("WORKSPACE")?
        .id_from_name(workspace)?
        .get_stub()?)
}

/// Test builds can switch public rooms on for one request, and the room needs to see that too.
fn test_headers(req: &Request, headers: &Headers) -> R<()> {
    if cfg!(feature = "failpoints") {
        if let Some(value) = req.headers().get("x-test-public-rooms")? {
            headers.set("x-test-public-rooms", &value)?;
        }
    }
    Ok(())
}

/// The room page. Nobody signed in, or anyone who is, gets the same view.
pub async fn room_page(req: Request, env: Env, handle: &str) -> R<Response> {
    let token = req
        .headers()
        .get("x-podster-assertion")?
        .ok_or(ApiError::invalid_assertion())?;
    let keys = KeySet::from_json(&env.secret("ASSERTION_KEYS")?.to_string())
        .map_err(|_| ApiError::internal("bad ASSERTION_KEYS"))?;
    let now = (Date::now().as_millis() / 1000) as i64;
    let reader =
        verify_room_page_caller(&token, &keys, now).map_err(|_| ApiError::invalid_assertion())?;
    let caller = match reader {
        RoomPageCaller::Public(_) => None,
        RoomPageCaller::SignedIn(identity) => {
            let is_agent = identity.kind == Kind::Agent;
            // An agent's connection is checked, and its token spent, as on every other route.
            if is_agent {
                let exp = identity.agent_jti_exp.unwrap_or(identity.exp);
                let spent = identity.agent_jti.as_deref().map(|key| (key, exp));
                principal::check_active(&env, &identity.sub, identity.gen, spent).await?;
            }
            Some(Caller {
                id: identity.sub,
                kind: if is_agent { "agent" } else { "person" }.to_string(),
                org: identity.org,
                orgs: vec![],
                admin_orgs: vec![],
                org_since: Default::default(),
                target_member: None,
                gen: identity.gen,
                linker: None,
                workspace_id: String::new(),
            })
        }
    };
    if !enabled(&env, &req)? || !is_public_handle(handle) {
        return not_found();
    }
    let found = env
        .d1("DB")?
        .prepare("SELECT workspace_id FROM public_workroom_index WHERE public_handle = ? AND resolvable = 1")
        .bind(&[handle.into()])?
        .first::<Value>(None)
        .await?;
    let Some(workspace) = found.and_then(|row| row["workspace_id"].as_str().map(str::to_owned))
    else {
        return not_found();
    };
    let headers = match &caller {
        Some(caller) => {
            let mut caller = caller.clone();
            caller.workspace_id = workspace.clone();
            caller_header(&caller)?
        }
        None => Headers::new(),
    };
    test_headers(&req, &headers)?;
    let path = format!("{}?handle={handle}", crate::workspace::INTERNAL_PUBLIC_PAGE);
    let response = forward(
        room(&env, &workspace)?,
        &path,
        "",
        headers,
        Method::Get,
        None,
    )
    .await?;
    if response.status_code() != 200 {
        // The room refused: not public now. Its answer is the one not-found, whatever it said.
        return not_found();
    }
    Ok(response)
}

/// An Explore cursor names the last candidate a page took: its publish time and handle, both public. It's hex so it reads
/// as opaque, and anything that doesn't parse back is refused.
fn encode_cursor(published_at: i64, handle: &str) -> String {
    format!("{published_at}.{handle}")
        .bytes()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn decode_cursor(cursor: &str) -> Option<(i64, String)> {
    if !cursor.len().is_multiple_of(2) || cursor.len() > 160 {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..cursor.len())
        .step_by(2)
        .map(|i| {
            cursor
                .get(i..i + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
        })
        .collect();
    let text = String::from_utf8(bytes?).ok()?;
    let (written, handle) = text.split_once('.')?;
    let at: i64 = written.parse().ok()?;
    // Only the form `encode_cursor` writes, so one position has one cursor.
    (is_public_handle(handle) && written == at.to_string()).then(|| (at, handle.to_owned()))
}

struct Filters {
    topic: Option<Topic>,
    open: bool,
    after: Option<(i64, String)>,
}

fn filters(url: &Url) -> R<Filters> {
    let mut found = Filters {
        topic: None,
        open: false,
        after: None,
    };
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "topic" => {
                found.topic =
                    parse_topic(Some(value.as_ref())).map_err(|_| ApiError::invalid_argument())?
            }
            "open" => {
                found.open = match value.as_ref() {
                    "true" => true,
                    "false" => false,
                    _ => return Err(ApiError::invalid_argument()),
                }
            }
            "cursor" => {
                found.after = Some(decode_cursor(&value).ok_or_else(ApiError::invalid_argument)?)
            }
            _ => return Err(ApiError::invalid_argument()),
        }
    }
    Ok(found)
}

/// Explore: a page of candidates from the index's `listed` rows, newest published first, each confirmed and read from its
/// room. A candidate its room doesn't confirm, or that doesn't answer in time, is left out, and the cursor still moves on.
pub async fn explore(env: &Env, caller: &Caller, url: &Url, req: &Request) -> R<Response> {
    let filters = filters(url)?;
    if !enabled(env, req)? {
        return Ok(Response::from_json(
            &json!({ "workrooms": [], "next_cursor": null }),
        )?);
    }
    let mut sql = String::from(
        "SELECT workspace_id, public_handle, published_at FROM public_workroom_index WHERE listed = 1",
    );
    let mut args: Vec<wasm_bindgen::JsValue> = vec![];
    if let Some(topic) = filters.topic {
        sql.push_str(" AND topic = ?");
        args.push(topic.name().into());
    }
    if filters.open {
        sql.push_str(" AND has_open_opening = 1");
    }
    if let Some((at, handle)) = &filters.after {
        sql.push_str(" AND (published_at < ? OR (published_at = ? AND public_handle > ?))");
        args.push((*at as f64).into());
        args.push((*at as f64).into());
        args.push(handle.as_str().into());
    }
    sql.push_str(" ORDER BY published_at DESC, public_handle LIMIT ?");
    args.push(((EXPLORE_PAGE + 1) as f64).into());
    let found = env
        .d1("DB")?
        .prepare(&sql)
        .bind(&args)?
        .all()
        .await?
        .results::<Value>()?;
    let more = found.len() > EXPLORE_PAGE;
    let page: Vec<&Value> = found.iter().take(EXPLORE_PAGE).collect();
    let next_cursor = match (more, page.last()) {
        (true, Some(last)) => match (
            last["published_at"].as_f64(),
            last["public_handle"].as_str(),
        ) {
            (Some(at), Some(handle)) => Some(encode_cursor(at as i64, handle)),
            _ => None,
        },
        _ => None,
    };
    let entries = page.iter().map(|row| entry(env, caller, row, req));
    let workrooms: Vec<Value> = join_all(entries).await.into_iter().flatten().collect();
    Ok(Response::from_json(
        &json!({ "workrooms": workrooms, "next_cursor": next_cursor }),
    )?)
}

/// One candidate, confirmed by its room, or `None`.
async fn entry(env: &Env, caller: &Caller, row: &Value, req: &Request) -> Option<Value> {
    let workspace = row["workspace_id"].as_str()?;
    let handle = row["public_handle"]
        .as_str()
        .filter(|h| is_public_handle(h))?;
    let read = async {
        #[cfg(feature = "failpoints")]
        if workspace.starts_with("ws_hang_") {
            Delay::from(Duration::from_millis(ROOM_TIMEOUT_MS * 20)).await;
        }
        let mut caller = caller.clone();
        caller.workspace_id = workspace.to_string();
        let headers = caller_header(&caller)?;
        test_headers(req, &headers)?;
        let path = format!(
            "{}?handle={handle}",
            crate::workspace::INTERNAL_EXPLORE_ENTRY
        );
        let mut response =
            forward(room(env, workspace)?, &path, "", headers, Method::Get, None).await?;
        Ok::<_, ApiError>(match response.status_code() {
            200 => Some(response.json::<Value>().await?),
            _ => None,
        })
    };
    let timeout = Delay::from(Duration::from_millis(ROOM_TIMEOUT_MS));
    let outcome = match select(Box::pin(read), timeout).await {
        Either::Left((Ok(view), _)) => view,
        Either::Left((Err(error), _)) => {
            console_error!("explore: room {workspace} failed: {:?}", error.code());
            None
        }
        Either::Right(_) => {
            console_error!("explore: room {workspace} timed out");
            None
        }
    };
    outcome
}
