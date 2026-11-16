//! The one place the API talks to Cloudflare for SaaS about a room's custom hostname (M6 step 8b; ADR 0010's "Custom
//! domains", steps 5 and 6). It creates one, reads what Cloudflare holds for a name, and deletes one. It decides
//! nothing: when to create, what a read means and when a claim may be freed are the room's, by
//! `podster_core::hostname_requests`.
//!
//! **Nothing is configured anywhere.** [`HostnameProvider::from_env`] answers `None` unless both settings are bound and
//! well-formed, and no environment binds either: the zone that serves custom hostnames and a token for its custom
//! hostnames are the owner's to make and choose. With none, nothing is created, and a claim for which a create was once
//! sent can't be read gone, so it stays held, which fails closed.
//!
//! **Every answer read here is an assumption, from Cloudflare's documented API: no spike has made a custom hostname.**
//! The paths are `/zones/<zone>/custom_hostnames`, with `?hostname=` to read by name, and `/<id>` to delete. They are
//! read strictly, so a wrong assumption leaves the job retrying, which shows, and never lets it record a hostname gone
//! that isn't:
//!
//! - **A create** counts only on `200` or `201` with `"success": true` and a `result` naming exactly this hostname, with
//!   an ID of the documented form and a status. Anything else, no answer among them, may or may not have made it, and
//!   only a later read settles that.
//! - **A read** is a page of the list, filtered by name. The documentation says the filter searches, so only entries
//!   naming exactly this hostname count. It counts as an answer only on `200` with `"success": true`, `result` an array
//!   whose every entry has an ID of the documented form, a hostname and a status, and `result_info.total_count` equal to
//!   the entries on the page: anything that hints at another page is no answer. **Gone is only such an answer with no
//!   entry of this name.** A read by ID, and its `404` with code `1436`, isn't used.
//! - **A delete's answer is never trusted:** the room reads again, and only a read says gone.
//!
//! A client never names a zone, an ID or a hostname here: the zone comes from configuration, the hostname from the
//! room's own state and an ID from Cloudflare's own answer, each checked against its form before it goes into a path.
//! Logs carry nothing from this module: no hostname, no ID, no zone and no token.
use crate::{setting, Setting};
use futures_util::future::{select, Either};
use podster_core::hostname_requests::{provider_id_form, provider_status_form, ProviderRead};
use serde_json::{json, Value};
use std::time::Duration;
use worker::*;

const API: &str = "https://api.cloudflare.com/client/v4";
/// How long one call may take. The room's alarm waits on it.
const CALL_TIMEOUT_MS: u64 = 5_000;
/// No answer read here is longer. A name's page holds one entry, or a few that the search also matched.
const MAX_ANSWER_BYTES: usize = 256 * 1024;
/// Entries asked for in the one page read. More than that matching one name is no answer.
const PAGE: usize = 50;

/// The settings a provider for custom hostnames needs. Neither is set in any environment.
const ZONE: &str = "CUSTOM_HOSTNAME_ZONE_ID";
const TOKEN: &str = "CUSTOM_HOSTNAME_TOKEN";

/// What a read found, with what the room keeps of it.
pub(crate) struct Read {
    pub(crate) read: ProviderRead,
    /// Each custom hostname of exactly this name, by ID, with its status. Empty unless `read` is `Present`.
    pub(crate) found: Vec<(String, String)>,
}

impl Read {
    fn unknown() -> Read {
        Read {
            read: ProviderRead::Unknown,
            found: Vec::new(),
        }
    }
}

/// A configured provider. Its fields never leave this module.
pub(crate) struct HostnameProvider {
    zone: String,
    token: String,
}

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

/// A hostname as it goes into a query and a body: normalized, so lower-case letters, digits, `-` and `.` only.
fn plain_host(host: &str) -> bool {
    podster_core::hostnames::normalize(host).ok().as_deref() == Some(host)
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
}

fn text_setting(env: &Env, name: &str, well_formed: fn(&str) -> bool) -> Option<String> {
    match setting(env, name) {
        Setting::Text(value) if well_formed(&value) => Some(value),
        _ => None,
    }
}

/// One call. `None` when there was no answer to read: unreachable, timed out, or longer than any answer expected. A
/// redirect is never followed.
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

/// One entry of Cloudflare's answer, as `(id, hostname, status)`, or `None` if any of the three isn't of its form.
fn entry(value: &Value) -> Option<(String, String, String)> {
    let id = value["id"].as_str().filter(|id| provider_id_form(id))?;
    let hostname = value["hostname"].as_str()?;
    let status = value["status"]
        .as_str()
        .filter(|status| provider_status_form(status))?;
    Some((id.to_owned(), hostname.to_owned(), status.to_owned()))
}

impl HostnameProvider {
    /// The provider this deployment is configured with, or `None`. Both settings must be bound as text and
    /// well-formed; one missing or malformed means no provider at all.
    pub(crate) fn from_env(env: &Env) -> Option<HostnameProvider> {
        Some(HostnameProvider {
            zone: text_setting(env, ZONE, hex32)?,
            token: text_setting(env, TOKEN, token)?,
        })
    }

    fn base(&self) -> String {
        format!("{API}/zones/{}/custom_hostnames", self.zone)
    }

    /// Creates the custom hostname, validated over HTTP as the documentation's own example is. Its ID and status when
    /// Cloudflare said, in so many words, that it made exactly this one; `None` for anything else, which a read settles.
    pub(crate) async fn create(&self, hostname: &str) -> Option<(String, String)> {
        if !plain_host(hostname) {
            return None;
        }
        let body = json!({ "hostname": hostname, "ssl": { "method": "http", "type": "dv" } });
        let (status, answer) = call(Method::Post, self.base(), &self.token, Some(body)).await?;
        if !matches!(status, 200 | 201) || answer["success"] != true {
            return None;
        }
        let (id, named, status) = entry(&answer["result"])?;
        (named == hostname).then_some((id, status))
    }

    /// Reads what Cloudflare holds of exactly this hostname. Anything but a whole, well-formed page is `Unknown`.
    pub(crate) async fn read(&self, hostname: &str) -> Read {
        if !plain_host(hostname) {
            return Read::unknown();
        }
        // The name is lower-case letters, digits, `-` and `.`, so it goes into the query as it is.
        let url = format!("{}?hostname={hostname}&per_page={PAGE}", self.base());
        let Some((status, answer)) = call(Method::Get, url, &self.token, None).await else {
            return Read::unknown();
        };
        if status != 200 || answer["success"] != true {
            return Read::unknown();
        }
        let Some(entries) = answer["result"]
            .as_array()
            .and_then(|entries| entries.iter().map(entry).collect::<Option<Vec<_>>>())
        else {
            return Read::unknown();
        };
        // The whole list is on this page, said in so many words. Anything else may hide this name on another.
        let whole = answer["result_info"]["total_count"]
            .as_u64()
            .is_some_and(|total| total == entries.len() as u64)
            && entries.len() <= PAGE;
        if !whole {
            return Read::unknown();
        }
        let found: Vec<(String, String)> = entries
            .into_iter()
            .filter(|(_, named, _)| named == hostname)
            .map(|(id, _, status)| (id, status))
            .collect();
        let read = if found.is_empty() {
            ProviderRead::Gone
        } else {
            ProviderRead::Present {
                moved: found.iter().any(|(_, status)| status == "moved"),
            }
        };
        Read { read, found }
    }

    /// Deletes one custom hostname, by an ID Cloudflare's own read gave. Its answer isn't trusted: only a read says gone.
    pub(crate) async fn delete(&self, id: &str) {
        if !provider_id_form(id) {
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
}
