//! `POST /v1/preview-access` (M8 step 7; the preview plan, `docs/m8-preview-plan.md`, 5.3 to 5.7; decisions 252, 255
//! and 258): a signed-in person asks to open a preview host, and gets where to send their browser, with a ticket and the
//! session it is exchanged for **only in the URL fragment**.
//!
//! In this order, each answered before anything after it is asked:
//!
//! 1. **The route exists only while previews are on and the owner's key is set**: `RELEASES` and `PREVIEWS` each
//!    exactly `true`, and `PREVIEW_TICKET_KEY` a key of its form (`podster_egress::preview_key`). Otherwise it is a path
//!    nobody defined (`not_found`), whoever asks, and no object is asked anything.
//! 2. **Never an agent** (decision 253): `not_allowed`.
//! 3. **The body**: exactly `host`, `st` and `r`, each a string; `st` a canonical state hash and `r` a return path on
//!    the host (`podster_core::preview_access`). Anything else is `invalid_argument`.
//! 4. **The person's 30 a minute**, counted in their own `Principal`: `preview_access_limit` (429) with `Retry-After`.
//!    Every ask that gets this far counts, granted or not.
//! 5. **The host to a room**: `<label>.<content domain>` exactly, and the label to its room by the label index, a read
//!    model that only routes. A custom preview hostname isn't built yet (M8 step 10), so any other host, like an
//!    unknown label, is `preview_access_refused` (404).
//! 6. **The room decides and signs** (`crate::workspace::INTERNAL_PREVIEW_ACCESS`), from its own state alone.
//!
//! **Nothing here is logged.** The answer holds a ticket and a session token, so it goes back to the gateway and no
//! further on this side; the host, the state hash and the return path aren't credentials, and aren't logged either.
use crate::error::ApiError;
use crate::{secret, Caller, Setting, CALLER_HEADER};
use podster_core::preview_access::{is_state_hash, return_path_ok};
use podster_egress::preview_key::PreviewKey;
use serde_json::{json, Value};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// The API secret holding the ticket key, the owner's to set through the wizard (decision 258). Never set by Podster.
const KEY_SECRET: &str = "PREVIEW_TICKET_KEY";

/// The longest host a request may name, as the contract's `PreviewAccessRequest.host` allows.
const MAX_HOST_LEN: usize = 253;

/// The owner's signing key, or `None` while it isn't set or isn't of its form, which answers as previews off. Test
/// builds also read it as absent while D1 holds a table named `test_preview_key_off`, which a test makes and drops.
pub(crate) async fn signing_key(env: &Env) -> Option<PreviewKey> {
    #[cfg(feature = "failpoints")]
    if let Ok(db) = env.d1("DB") {
        let off = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_preview_key_off'")
            .first::<Value>(None)
            .await
            .ok()
            .flatten()
            .is_some();
        if off {
            return None;
        }
    }
    match secret(env, KEY_SECRET) {
        Setting::Text(text) => PreviewKey::parse(&text),
        Setting::Absent | Setting::Unreadable => None,
    }
}

/// Whether the route exists now: release and previews each switched on exactly, and the key set.
async fn route_exists(env: &Env) -> bool {
    crate::releases::switched_on(env).await
        && crate::previews::setting(env).await.allows_previews()
        && signing_key(env).await.is_some()
}

/// The body's three fields, checked for their forms, and nothing else in it.
fn parse(body: Option<&str>) -> R<(String, String, String)> {
    let value: Value =
        serde_json::from_str(body.unwrap_or("")).map_err(|_| ApiError::invalid_argument())?;
    let fields = value.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields.len() != 3 {
        return Err(ApiError::invalid_argument());
    }
    let field = |name: &str| {
        fields
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(ApiError::invalid_argument)
    };
    let (host, st, r) = (field("host")?, field("st")?, field("r")?);
    if host.is_empty() || host.len() > MAX_HOST_LEN || !is_state_hash(&st) || !return_path_ok(&r) {
        return Err(ApiError::invalid_argument());
    }
    Ok((host, st, r))
}

/// `POST /v1/preview-access`, for a verified caller.
pub(crate) async fn request(env: &Env, caller: &Caller, body: Option<&str>) -> R<Response> {
    if !route_exists(env).await {
        return Err(ApiError::not_found());
    }
    if caller.kind != "person" {
        return Err(ApiError::not_allowed());
    }
    let (host, st, r) = parse(body)?;
    if let Some(wait_ms) = crate::principal::count_preview_access(env, &caller.id).await? {
        // error-codes: preview_access_limit
        return Err(ApiError::api(429, "preview_access_limit")
            .retry_after(wait_ms.saturating_add(999) / 1000));
    }
    let refused = crate::workspace::preview_access_refused;
    let domain = crate::content_provider::content_domain(env).ok_or_else(refused)?;
    let label = crate::content_provider::default_host_label_on(&domain, &host)
        .ok_or_else(refused)?
        .to_owned();
    let room = crate::releases::room_for_label(env, &label)
        .await?
        .ok_or_else(refused)?;
    let mut forwarded = caller.clone();
    forwarded.workspace_id = room.clone();
    let headers = Headers::new();
    headers.set(CALLER_HEADER, &serde_json::to_string(&forwarded)?)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(
            json!({ "label": label, "st": st, "r": r })
                .to_string()
                .into(),
        ));
    let stub = env
        .durable_object("WORKSPACE")?
        .id_from_name(&room)?
        .get_stub()?;
    Ok(stub
        .fetch_with_request(Request::new_with_init(
            &format!(
                "https://do{}",
                crate::workspace::INTERNAL_PREVIEW_ACCESS_PATH
            ),
            &init,
        )?)
        .await?)
}
