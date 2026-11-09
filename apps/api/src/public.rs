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
use podster_egress::endpoint::{open_labeled, parse_key, seal_labeled, NONCE_BYTES};
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

/// The secret holding the Explore cursor's sealing key, 64 hex characters (M4 step 14). The owner sets it with
/// `wrangler secret put EXPLORE_CURSOR_KEY`.
const CURSOR_KEY_SECRET: &str = "EXPLORE_CURSOR_KEY";
/// What a sealed cursor is bound to, so nothing else sealed under the key opens as one.
const CURSOR_LABEL: &str = "explore-cursor";
/// Longer than any cursor this writes: a 12-byte nonce, the position and a 16-byte tag, in hex.
const MAX_CURSOR_CHARS: usize = 200;

/// The cursor's key, or why there isn't one: `explore.cursor_key_unset`, or `explore.cursor_key_invalid` for a value that isn't
/// 64 hex characters. Either fails closed. The caller logs the code only when it matters, when a cursor arrives or a next page
/// would have been offered, and nothing of the value is ever in it.
fn cursor_key(env: &Env, req: &Request) -> Result<Vec<u8>, &'static str> {
    const UNSET: &str = "explore.cursor_key_unset";
    // Test builds only: a request can ask to be served as if the key were unset, empty or the wrong length.
    #[cfg(feature = "failpoints")]
    let secret = match req
        .headers()
        .get("x-test-cursor-key")
        .ok()
        .flatten()
        .as_deref()
    {
        Some("unset") => return Err(UNSET),
        Some("empty") => String::new(),
        Some("short") => "ab".repeat(16),
        _ => env
            .secret(CURSOR_KEY_SECRET)
            .map_err(|_| UNSET)?
            .to_string(),
    };
    #[cfg(not(feature = "failpoints"))]
    let secret = {
        let _ = req;
        env.secret(CURSOR_KEY_SECRET)
            .map_err(|_| UNSET)?
            .to_string()
    };
    if secret.trim().is_empty() {
        return Err(UNSET);
    }
    parse_key(&secret).ok_or("explore.cursor_key_invalid")
}

/// Logs a missing or invalid cursor key at most once per isolate, so a deployment without it isn't a log line per request.
fn log_key_problem(code: &str) {
    static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        console_error!("{}", code);
    }
}

/// A fresh nonce from the Worker's own `crypto.getRandomValues`. Without one, no cursor is written.
fn fresh_nonce() -> Option<[u8; NONCE_BYTES]> {
    use wasm_bindgen::JsCast;
    let crypto = js_sys::Reflect::get(&js_sys::global(), &"crypto".into()).ok()?;
    let fill: js_sys::Function = js_sys::Reflect::get(&crypto, &"getRandomValues".into())
        .ok()?
        .dyn_into()
        .ok()?;
    let array = js_sys::Uint8Array::new_with_length(NONCE_BYTES as u32);
    fill.call1(&crypto, &array).ok()?;
    array.to_vec().try_into().ok()
}

/// An Explore cursor names the last candidate a page took: its publish time and handle. It's sealed (M4 step 14), so whoever
/// holds it can't read the handle, which may be a room suspended since, or change the position. Without a key, none is
/// written: there's no unsealed fallback.
fn encode_cursor(key: &[u8], published_at: i64, handle: &str) -> Option<String> {
    seal_labeled(
        key,
        &fresh_nonce()?,
        CURSOR_LABEL,
        &format!("{published_at}.{handle}"),
    )
    .ok()
}

/// A cursor this wrote under the same key, or `None`. With no key every cursor is refused, an old unsealed one included, and
/// the reason is logged.
fn decode_cursor(key: Result<&[u8], &str>, cursor: &str) -> Option<(i64, String)> {
    let key = match key {
        Ok(key) => key,
        Err(code) => {
            log_key_problem(code);
            return None;
        }
    };
    if cursor.len() > MAX_CURSOR_CHARS {
        return None;
    }
    let text = open_labeled(key, CURSOR_LABEL, cursor).ok()?;
    let (written, handle) = text.split_once('.')?;
    let at: i64 = written.parse().ok()?;
    // Only the form `encode_cursor` writes, so one position has one meaning.
    (is_public_handle(handle) && written == at.to_string()).then(|| (at, handle.to_owned()))
}

struct Filters {
    topic: Option<Topic>,
    open: bool,
    after: Option<(i64, String)>,
}

fn filters(url: &Url, sealing: Result<&[u8], &str>) -> R<Filters> {
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
                found.after =
                    Some(decode_cursor(sealing, &value).ok_or_else(ApiError::invalid_argument)?)
            }
            _ => return Err(ApiError::invalid_argument()),
        }
    }
    Ok(found)
}

/// Explore: a page of candidates from the index's `listed` rows, newest published first, each confirmed and read from its
/// room. A candidate its room doesn't confirm, or that doesn't answer in time, is left out, and the cursor still moves on.
pub async fn explore(env: &Env, caller: &Caller, url: &Url, req: &Request) -> R<Response> {
    // Off answers the same empty page whatever was asked, before anything reads the key or the filters.
    if !enabled(env, req)? {
        return Ok(Response::from_json(
            &json!({ "workrooms": [], "next_cursor": null }),
        )?);
    }
    let key = cursor_key(env, req);
    let filters = filters(url, key.as_deref().map_err(|code| *code))?;
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
            (Some(at), Some(handle)) => match &key {
                Ok(key) => encode_cursor(key, at as i64, handle),
                Err(code) => {
                    // Fails closed: Explore shows its first page and no more until the owner sets a valid key.
                    log_key_problem(code);
                    None
                }
            },
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

// ---------------------------------------------------------------------------------------------------------------------
// Public claims (M4 step 8)

/// A Principal's count to reserve on: whose it is, the Principal, and the claim's key there.
#[derive(Clone)]
struct Count {
    whose: &'static str,
    principal: String,
    key: String,
}

/// What a room says about an agent's public claim there.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Held {
    Yes,
    No,
    /// The room didn't answer. A count already here is then counted afresh, and kept if the claim is refused, and a count
    /// is only ever freed on the room's word.
    Unknown,
}

impl Held {
    fn word(self) -> &'static str {
        match self {
            Held::Yes => "yes",
            Held::No => "no",
            Held::Unknown => "unknown",
        }
    }
}

async fn held(env: &Env, workspace: &str, agent: &str) -> Held {
    let read = async {
        let path = format!(
            "{}?principal={agent}",
            crate::workspace::INTERNAL_PUBLIC_CLAIM_STATUS
        );
        let mut response = forward(
            room(env, workspace)?,
            &path,
            "",
            Headers::new(),
            Method::Get,
            None,
        )
        .await?;
        if response.status_code() != 200 {
            return Ok::<_, ApiError>(Held::Unknown);
        }
        Ok(match response.json::<Value>().await?["state"].as_str() {
            Some("held") => Held::Yes,
            Some("not_held") => Held::No,
            _ => Held::Unknown,
        })
    };
    read.await.unwrap_or(Held::Unknown)
}

/// Reserves one count under this request's `reservation`, and at an "at once" limit checks each claim it counted with
/// its room, ending only the ones the room says it doesn't hold, then asks once more. `Ok(retry)` says it counted nothing
/// because the room said the claim is held, and `Err` carries the refusal.
async fn reserve(
    env: &Env,
    count: &Count,
    workspace: &str,
    agent: &str,
    reservation: &str,
    here: Held,
) -> R<bool> {
    let mut checked = false;
    loop {
        let refused = principal::reserve_public_claim(
            env,
            &count.principal,
            count.whose,
            &count.key,
            workspace,
            reservation,
            here.word(),
        )
        .await?;
        let (code, active) = match refused {
            Ok(retry) => return Ok(retry),
            Err(refusal) => refusal,
        };
        // Only an "at once" limit can be freed by a claim that ended. An hourly one can't.
        let freeable = count.whose != "org" && !active.is_empty() && !checked;
        if !freeable {
            return Err(if code == "not_allowed" {
                ApiError::not_allowed()
            } else {
                ApiError::limit_exceeded()
            });
        }
        checked = true;
        let mut freed = false;
        // At most 3 are listed, so this asks at most 3 rooms.
        for (key, room_id) in active
            .iter()
            .take(podster_core::public_claims::MAX_PERSON_ACTIVE_PUBLIC_CLAIMS as usize)
        {
            // A person's key is `agent:room`, since their count spans every agent they linked.
            let holder = match count.whose {
                "person" => match key.split_once(':') {
                    Some((holder, _)) => holder.to_string(),
                    None => continue,
                },
                _ => agent.to_string(),
            };
            if held(env, room_id, &holder).await == Held::No {
                principal::settle_public_claim(
                    env,
                    &count.principal,
                    count.whose,
                    key,
                    room_id,
                    reservation,
                    "end",
                )
                .await?;
                freed = true;
            }
        }
        if !freed {
            return Err(ApiError::limit_exceeded());
        }
    }
}

/// `POST /v1/public/workrooms/{handle}/claim { role_id }`: an agent whose owner allows it joins a public room as a guest
/// and claims an opening (decision 159). The agent's, its linking person's and its organization's counts are reserved on
/// their Principals under this request's own reservation, the room decides, and each count is confirmed or given back by
/// its answer. Settling runs past the response, so a client that goes away can't stop it.
pub async fn claim(
    env: &Env,
    ctx: &Context,
    caller: &Caller,
    handle: &str,
    body: Option<&str>,
    req: &Request,
) -> R<Response> {
    if caller.kind != "agent" {
        return Err(ApiError::not_allowed());
    }
    // Every agent credential has a linker. One without can't be counted against a person, so it can't claim publicly.
    let person = caller
        .linker
        .as_ref()
        .map(|l| l.person.clone())
        .ok_or_else(ApiError::not_allowed)?;
    let parsed: Value =
        serde_json::from_str(body.unwrap_or("")).map_err(|_| ApiError::invalid_argument())?;
    let fields = parsed.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields.keys().any(|k| k != "role_id") {
        return Err(ApiError::invalid_argument());
    }
    let role_id = parsed["role_id"]
        .as_str()
        .filter(|id| crate::valid_id(id))
        .ok_or_else(ApiError::invalid_argument)?
        .to_string();
    if !enabled(env, req)? || !is_public_handle(handle) {
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
    let agent = caller.id.clone();
    // The owner's consent is checked first, and the room recorded on the agent, as any join does.
    let generation = principal::register_room(env, &agent, &caller.org, &workspace, true).await?;
    let pair = format!("{agent}:{workspace}");
    let counts = vec![
        Count {
            whose: "agent",
            principal: agent.clone(),
            key: workspace.clone(),
        },
        Count {
            whose: "person",
            principal: person,
            key: pair.clone(),
        },
        Count {
            whose: "org",
            principal: caller.org.clone(),
            key: pair,
        },
    ];
    let reservation = format!("rsv_{}", uuid::Uuid::new_v4().simple());
    // Every request reserves. The room's word on whether the agent holds this claim now tells each Principal a retry,
    // which counts nothing, from a claim asked for again after it ended, which counts afresh.
    let here = held(env, &workspace, &agent).await;
    #[cfg(feature = "failpoints")]
    let here = test_force_held(env, &agent, here).await;
    let mut reserved: Vec<Count> = vec![];
    let mut retry_only = false;
    for count in &counts {
        match reserve(env, count, &workspace, &agent, &reservation, here).await {
            Ok(retry) => retry_only |= retry,
            Err(error) => {
                settle_later(
                    ctx,
                    env,
                    reserved,
                    workspace.clone(),
                    reservation.clone(),
                    "release",
                );
                return Err(error);
            }
        }
        reserved.push(count.clone());
    }
    let mut asking = caller.clone();
    asking.workspace_id = workspace.clone();
    let headers = caller_header(&asking)?;
    test_headers(req, &headers)?;
    // A request some count took as a retry may only be a retry in the room. If the claim ended in the meantime, the room
    // refuses it rather than make a claim nothing counted, and asking again counts it.
    let request = json!({ "handle": handle, "role_id": role_id, "generation": generation, "retry_only": retry_only })
        .to_string();
    let answer = forward(
        room(env, &workspace)?,
        crate::workspace::INTERNAL_PUBLIC_CLAIM,
        "",
        headers,
        Method::Post,
        Some(request),
    )
    .await;
    match &answer {
        // A claim that stands is confirmed, a retry's included, so a confirm lost earlier can't leave it unsettled.
        Ok(response) if response.status_code() == 200 => {
            settle_later(ctx, env, counts, workspace, reservation, "confirm");
        }
        Ok(_) => settle_later(ctx, env, reserved, workspace, reservation, "release"),
        // The room's answer was lost: the counts stay pending, then active, until the room says the claim isn't held.
        Err(_) => {}
    }
    answer
}

/// Settles counts after the response, in `wait_until`.
fn settle_later(
    ctx: &Context,
    env: &Env,
    counts: Vec<Count>,
    workspace: String,
    reservation: String,
    outcome: &'static str,
) {
    if counts.is_empty() {
        return;
    }
    let env = env.clone();
    ctx.wait_until(async move {
        for count in &counts {
            #[cfg(feature = "failpoints")]
            test_hold_settle(&env, &count.principal).await;
            #[cfg(feature = "failpoints")]
            if outcome == "confirm" && test_fail_confirm(&env, &count.principal).await {
                continue;
            }
            if let Err(error) = principal::settle_public_claim(
                &env,
                &count.principal,
                count.whose,
                &count.key,
                &workspace,
                &reservation,
                outcome,
            )
            .await
            {
                console_error!(
                    "public claim count not settled: {} {:?}",
                    count.whose,
                    error.code()
                );
            }
        }
    });
}

/// Test builds only: a test can make one confirm fail, by naming the Principal in D1's test table.
#[cfg(feature = "failpoints")]
async fn test_fail_confirm(env: &Env, principal: &str) -> bool {
    let Ok(db) = env.d1("DB") else { return false };
    let found = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_fail_confirm'",
        )
        .first::<Value>(None)
        .await;
    if !matches!(found, Ok(Some(_))) {
        return false;
    }
    match db
        .prepare("DELETE FROM test_fail_confirm WHERE principal = ? RETURNING principal")
        .bind(&[principal.into()])
    {
        Ok(q) => matches!(q.first::<Value>(None).await, Ok(Some(_))),
        Err(_) => false,
    }
}

/// Test builds only: a test can force the room's word on whether the agent holds its claim, by naming the agent in D1's
/// `test_force_held`, `test_force_unknown` or `test_force_not_held` table, to reach a race or a room that doesn't answer on demand.
#[cfg(feature = "failpoints")]
async fn test_force_held(env: &Env, agent: &str, here: Held) -> Held {
    let Ok(db) = env.d1("DB") else { return here };
    for (table, forced) in [
        ("test_force_held", Held::Yes),
        ("test_force_unknown", Held::Unknown),
        ("test_force_not_held", Held::No),
    ] {
        let Ok(exists) = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind(&[table.into()])
        else {
            continue;
        };
        if !matches!(exists.first::<Value>(None).await, Ok(Some(_))) {
            continue;
        }
        let Ok(named) = db
            .prepare(format!("SELECT principal FROM {table} WHERE principal = ?"))
            .bind(&[agent.into()])
        else {
            continue;
        };
        if matches!(named.first::<Value>(None).await, Ok(Some(_))) {
            return forced;
        }
    }
    here
}

/// Test builds only: a test can hold a Principal's settling back, by naming it in D1's `test_hold_settle` table, until it
/// deletes the row or five seconds pass.
#[cfg(feature = "failpoints")]
async fn test_hold_settle(env: &Env, principal: &str) {
    let Ok(db) = env.d1("DB") else { return };
    for _ in 0..250 {
        let Ok(exists) = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_hold_settle'",
            )
            .first::<Value>(None)
            .await
        else {
            return;
        };
        if exists.is_none() {
            return;
        }
        let Ok(named) = db
            .prepare("SELECT principal FROM test_hold_settle WHERE principal = ?")
            .bind(&[principal.into()])
        else {
            return;
        };
        if !matches!(named.first::<Value>(None).await, Ok(Some(_))) {
            return;
        }
        worker::Delay::from(std::time::Duration::from_millis(20)).await;
    }
}
