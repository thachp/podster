//! The one place the API talks to Cloudflare about rooms' app stores (M6 stage 1; ADR 0010's revision, section 3.3).
//! It makes a D1 database, reads one by ID, deletes one and lists them all. It decides nothing: whether an answer means
//! made, present or gone is `podster_core::app_store`'s, and when to make or delete a store is the room's.
//!
//! **Its own credential** (the architect's ruling on the store, 2026-11-16, item 2): `CONTENT_STORE_TOKEN`, meant to
//! hold D1 Edit alone, on the account that holds the dispatch namespace, `CONTENT_ACCOUNT_ID`, since a script can be
//! bound only to a database in its own account. It is never the scripts token or the routing token: a store token
//! equal to either is no store token, so the credential that uploads scripts and the one that writes serve entries
//! are never the one that makes and deletes stores. **Whether a token with D1 Edit alone can do all four calls is owed
//! to the second account's repeat of the spike** (item 7).
//!
//! **Nothing is configured anywhere.** The release job makes a store through [`StoreProvider::create`] and settles a
//! lost create through [`StoreProvider::list`] (`workspace/release_store.rs`, S2 of the store plan); the read and the
//! delete wait for S4 and are reached only by a test-only route. [`StoreProvider::from_env`] answers `None` unless both
//! settings are bound and well-formed, and no environment binds `CONTENT_STORE_TOKEN`.
//!
//! **What was seen and what is assumed.** The store spike (`spikes/m6-store`) saw a create (`POST`, `{"name": …}`,
//! answered `200` with `result.uuid` and `result.name`), the list (`GET`, `page` and `per_page=100`, entries with
//! `uuid` and `name`), a delete (`200`), and a read and a second delete of a deleted database (`404`, code `7404`). It
//! didn't record a read of a database that is there, or the list's `result_info`: those follow Cloudflare's usual
//! envelope and are read strictly, so a wrong assumption leaves a caller retrying, which shows, and never lets it
//! record a store made or gone that isn't.
//!
//! - **A create** counts only as `podster_core::app_store::created` allows, and is refused only as
//!   `podster_core::app_store::create_answer` allows. Anything else, no answer among them, may or may not have made
//!   it, and only the list settles that, by the name the room chose.
//! - **A read** is present or gone only as `podster_core::app_store::read` allows.
//! - **A delete's answer is never trusted:** only a read says gone.
//! - **The list** is every page, as `podster_core::app_store::ListRead` allows, or no list.
//!
//! A client never names an account, an ID or a name here: the account comes from configuration, a name from the room's
//! own record, and an ID from Cloudflare's own answer, each checked against its form before it goes into a path or a
//! body. Logs carry nothing from this module: no name, no ID, no account and no token.

use crate::{setting, Setting};
use futures_util::future::{select, Either};
use podster_core::app_store::{
    create_answer, d1_id_form, is_store_name, read, CreateAnswer, Described, Envelope, ListPage,
    ListRead, ListStep, StoreRead, LIST_PAGE, MAX_LIST_PAGES,
};
use serde_json::{json, Value};
use std::time::Duration;
use worker::*;

const API: &str = "https://api.cloudflare.com/client/v4";
/// How long one call may take.
const CALL_TIMEOUT_MS: u64 = 5_000;
/// No answer read here is longer. A page of the list holds at most [`LIST_PAGE`] short entries.
const MAX_ANSWER_BYTES: usize = 256 * 1024;

/// The settings a store provider needs. The account is the content provider's; the token is this module's alone.
const ACCOUNT: &str = "CONTENT_ACCOUNT_ID";
const TOKEN: &str = "CONTENT_STORE_TOKEN";
/// The content provider's two tokens, read only to refuse a store token equal to either.
const OTHER_TOKENS: [&str; 2] = ["CONTENT_SCRIPTS_TOKEN", "CONTENT_ROUTING_TOKEN"];

/// A configured store provider. Its fields never leave this module.
pub(crate) struct StoreProvider {
    account: String,
    token: String,
}

/// What the list found: every database in the account, by ID and name, or `None` when there was no whole list.
pub(crate) type StoreList = Option<Vec<(String, String)>>;

fn hex32(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn token(value: &str) -> bool {
    (20..=256).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

fn text_setting(env: &Env, name: &str, well_formed: fn(&str) -> bool) -> Option<String> {
    match setting(env, name) {
        Setting::Text(value) if well_formed(&value) => Some(value),
        _ => None,
    }
}

/// The envelope as `podster_core::app_store` reads it: `success` only if a boolean, and the errors' codes only if
/// every entry has an integer `code`.
fn envelope(status: u16, answer: &Value) -> Envelope {
    let errors = answer["errors"].as_array().and_then(|errors| {
        errors
            .iter()
            .map(|error| error["code"].as_i64())
            .collect::<Option<Vec<i64>>>()
    });
    Envelope {
        status,
        success: answer["success"].as_bool(),
        errors,
    }
}

fn described(value: &Value) -> Described<'_> {
    Described {
        id: value["uuid"].as_str(),
        name: value["name"].as_str(),
    }
}

/// One call. `None` when there was no answer to read: unreachable, timed out, or longer than any answer expected. A
/// redirect is never followed. A body that isn't JSON reads as `null`, which no rule accepts.
async fn call(
    method: Method,
    url: String,
    bearer: &str,
    body: Option<Value>,
) -> Option<(u16, Value)> {
    let controller = AbortController::default();
    let signal = controller.signal();
    let bearer = bearer.to_owned();
    let attempt = async move {
        let headers = Headers::new();
        headers.set("authorization", &format!("Bearer {bearer}"))?;
        headers.set("accept", "application/json")?;
        if body.is_some() {
            headers.set("content-type", "application/json")?;
        }
        let mut init = RequestInit::new();
        init.with_method(method)
            .with_headers(headers)
            .with_redirect(RequestRedirect::Manual);
        if let Some(body) = body {
            init.with_body(Some(body.to_string().into()));
        }
        let mut response = Fetch::Request(Request::new_with_init(&url, &init)?)
            .send_with_signal(&signal)
            .await?;
        let status = response.status_code();
        let body = crate::github::bounded_body(&mut response, MAX_ANSWER_BYTES).await?;
        Ok::<_, Error>(body.map(|body| {
            (
                status,
                serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null),
            )
        }))
    };
    let timeout = Delay::from(Duration::from_millis(CALL_TIMEOUT_MS));
    let answer = match select(Box::pin(attempt), timeout).await {
        Either::Left((Ok(answer), _)) => answer,
        Either::Left((Err(_), _)) | Either::Right(_) => None,
    };
    controller.abort();
    answer
}

impl StoreProvider {
    /// The store provider this deployment is configured with, or `None`. Both settings must be bound as text and
    /// well-formed, and the token must be neither of the content provider's tokens, nor either of them unreadable.
    pub(crate) fn from_env(env: &Env) -> Option<StoreProvider> {
        StoreProvider::from_settings(env, ACCOUNT, TOKEN, OTHER_TOKENS)
    }

    /// The same, read from the settings of these names. Only [`StoreProvider::from_env`] and the test-only route call
    /// it; the route names other settings to show each refusal.
    fn from_settings(
        env: &Env,
        account: &str,
        token_name: &str,
        others: [&str; 2],
    ) -> Option<StoreProvider> {
        let account = text_setting(env, account, hex32)?;
        let token = text_setting(env, token_name, token)?;
        for other in others {
            match setting(env, other) {
                Setting::Absent => {}
                Setting::Text(value) if value != token => {}
                Setting::Text(_) | Setting::Unreadable => return None,
            }
        }
        Some(StoreProvider { account, token })
    }

    fn base(&self) -> String {
        format!("{API}/accounts/{}/d1/database", self.account)
    }

    /// Makes a database of this name, which must be a store's name: made, with its ID, when Cloudflare said in so many
    /// words that it made exactly this one; refused when it said in so many words that it didn't; anything else, no
    /// answer among them, is unknown, which [`StoreProvider::list`] settles by the name. A name not of a store's form is
    /// never sent, and is unknown.
    pub(crate) async fn create(&self, name: &str) -> CreateAnswer {
        if !is_store_name(name) {
            return CreateAnswer::Unknown;
        }
        let Some((status, answer)) = call(
            Method::Post,
            self.base(),
            &self.token,
            Some(json!({ "name": name })),
        )
        .await
        else {
            return CreateAnswer::Unknown;
        };
        create_answer(
            &envelope(status, &answer),
            &described(&answer["result"]),
            name,
        )
    }

    /// Reads the database with this ID, which the room recorded under this name. Only the test-only route reads one
    /// until S4 deletes stores.
    #[cfg_attr(not(feature = "failpoints"), allow(dead_code))]
    pub(crate) async fn read(&self, id: &str, name: &str) -> StoreRead {
        if !d1_id_form(id) || !is_store_name(name) {
            return StoreRead::Unknown;
        }
        let Some((status, answer)) = call(
            Method::Get,
            format!("{}/{id}", self.base()),
            &self.token,
            None,
        )
        .await
        else {
            return StoreRead::Unknown;
        };
        read(
            &envelope(status, &answer),
            &described(&answer["result"]),
            id,
            name,
        )
    }

    /// Deletes the database with this ID. Its answer isn't trusted: only a read says gone. Only the test-only route
    /// deletes one until S4.
    #[cfg_attr(not(feature = "failpoints"), allow(dead_code))]
    pub(crate) async fn delete(&self, id: &str) {
        if !d1_id_form(id) {
            return;
        }
        let _ = call(
            Method::Delete,
            format!("{}/{id}", self.base()),
            &self.token,
            None,
        )
        .await;
    }

    /// Every database in the account, by ID and name, or `None` when there was no whole list. Names that aren't a
    /// store's are kept: what to make of them is the caller's.
    pub(crate) async fn list(&self) -> StoreList {
        let mut list = ListRead::default();
        for page in 1..=MAX_LIST_PAGES {
            let url = format!("{}?page={page}&per_page={LIST_PAGE}", self.base());
            let (status, answer) = call(Method::Get, url, &self.token, None).await?;
            let entries = answer["result"]
                .as_array()
                .map(|entries| entries.iter().map(described).collect());
            let step = list.take(&ListPage {
                envelope: envelope(status, &answer),
                entries,
                total: answer["result_info"]["total_count"].as_u64(),
            });
            match step {
                ListStep::More => {}
                ListStep::Done => return Some(list.found),
                ListStep::Unknown => return None,
            }
        }
        None
    }
}

/// Test builds only: one call of the client, chosen by the test, and what it made of the answer. The answers are the
/// stand-in's, so nothing real is read or returned. A test may have the settings read under other names, from a fixed
/// list of the test Worker's own bindings, to show each way a configuration is refused; with none named, it is
/// exactly [`StoreProvider::from_env`].
#[cfg(feature = "failpoints")]
pub(crate) async fn test_route(env: &Env, body: Value) -> Result<Response> {
    const NAMES: &[&str] = &[
        ACCOUNT,
        TOKEN,
        "CONTENT_SCRIPTS_TOKEN",
        "CONTENT_ROUTING_TOKEN",
        "CONTENT_KV_NAMESPACE_ID",
        "TEST_SETTING_NUMBER",
        "TEST_SETTING_NULL",
        "TEST_SETTING_TEXT_TRUE",
        "TEST_STORE_UNBOUND",
    ];
    let named = |key: &str, default: &'static str| -> Option<&'static str> {
        match body[key].as_str() {
            None => Some(default),
            Some(name) => NAMES.iter().copied().find(|known| *known == name),
        }
    };
    let (Some(account), Some(token), Some(first), Some(second)) = (
        named("account_from", ACCOUNT),
        named("token_from", TOKEN),
        named("scripts_from", OTHER_TOKENS[0]),
        named("routing_from", OTHER_TOKENS[1]),
    ) else {
        return Response::error("unknown setting", 400);
    };
    let Some(provider) = StoreProvider::from_settings(env, account, token, [first, second]) else {
        return Response::from_json(&json!({ "configured": false }));
    };
    let name = body["name"].as_str().unwrap_or_default();
    let id = body["id"].as_str().unwrap_or_default();
    let answer = match body["op"].as_str() {
        Some("create") => json!({ "id": match provider.create(name).await {
            CreateAnswer::Made(id) => Some(id),
            CreateAnswer::Refused | CreateAnswer::Unknown => None,
        } }),
        Some("read") => json!({ "read": match provider.read(id, name).await {
            StoreRead::Present => "present",
            StoreRead::Gone => "gone",
            StoreRead::Unknown => "unknown",
        } }),
        Some("delete") => {
            provider.delete(id).await;
            json!({ "sent": true })
        }
        Some("list") => json!({ "list": provider.list().await }),
        _ => return Response::error("unknown op", 400),
    };
    Response::from_json(&answer)
}
