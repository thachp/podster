//! The one place the API talks to the provider that serves rooms' apps (M6 step 4(a), ADR 0010).
//!
//! Two things live there, and both are derived: the dispatch namespace's scripts, one for each release, and the serve
//! entries, one for each host, which say which script a host serves. This module reads and deletes a script, and
//! writes, deletes and reads a serve entry. It decides nothing. What a host should serve is the room's state, and
//! whether an answer means a script is gone is `podster_core::release::script_gone`.
//!
//! **Nothing is configured anywhere.** [`Provider::from_env`] answers `None` unless all six settings are bound and
//! well-formed, and no environment binds any of them: the two tokens are the owner's to make, on an account that is
//! the owner's to choose. With no provider, the room's applier and its delete job do nothing, and say so.
//!
//! - **Scripts,** with the scripts token: `GET` and `DELETE` on the namespace's script. Spike A recorded what they
//!   answer (`spikes/m6-namespace-app`): a read of a deleted script is `200` with `"script": null`, and a second
//!   delete is `404` with code `10007`. Spike B recorded the delete's path, with `force=true`.
//! - **Serve entries,** with the routing token: the KV namespace's value for the host, by Cloudflare's documented REST
//!   paths. **Spike G confirmed these on 2026-11-23** (`spikes/m6-spike-g/RESULTS.md`): a write and a delete answer
//!   `200` with `"success": true`, a read answers `200` with the value, and a missing key's read answers `404` with
//!   code `10009`; a delete of a missing key answers `200` too. Every read back, from 0 to 65 seconds after a write or
//!   a delete, already matched it, from one location. They stay strict: an entry counts as written only on `200` with
//!   `"success": true`, and as absent only on `404` with code `10009`, so a changed answer leaves the applier retrying,
//!   which shows, and never lets it record a removal that didn't happen.
//!
//! - **The two lists, for the reconciles** (third PR). The namespace's scripts, with the scripts token: one `GET`, as
//!   spike A saw it, an array of objects of which only `id` is trusted. Spike G (2026-11-23) saw 8 scripts come back
//!   in one answer with `result_info.cursor` empty; `per_page` and `page` were ignored. How many one answer holds at
//!   most wasn't seen, so anything in the answer that hints at more makes the list incomplete, and the caller is
//!   told. The serve entries' keys, with the routing token: Cloudflare's documented KV list, a page at a time with a
//!   cursor. Spike G confirmed it: `result_info` holds `count` and `cursor`, the cursor is empty on the last page, a
//!   `limit` under 10 is refused, and a cursor still worked 10.5 minutes after it was given. Both are strict: an
//!   answer that isn't exactly the expected shape is no list at all.
//!
//! A client never names an account, a namespace, a script or a host here: all come from configuration or from the
//! room's own state, and each name is checked against its form before it goes into a path. Logs carry nothing from
//! this module: no host, no script, no ID of the account or the namespaces, and no token. Its one log line is a code:
//! a content domain refused as Podster's own ([`content_domain`]).
use crate::{secret, Setting};
use futures_util::future::{select, Either};
use podster_core::app_requests::HostKind;
use podster_core::release::{is_label, script_owner, ScriptAnswer, ScriptOwner};
use podster_core::serve_entry::{
    custom_entry_script_kind, custom_entry_value_kind, default_entry_script, default_entry_value,
};
use serde_json::Value;
use std::time::Duration;
use worker::*;

/// Uploading a release's static files, as its own script (M6 step 5).
pub(crate) mod upload;

const API: &str = "https://api.cloudflare.com/client/v4";
/// How long one call may take. The room's alarm waits on it.
const CALL_TIMEOUT_MS: u64 = 5_000;
/// No answer this module reads is longer: a script's read, an error, or a serve entry of at most 63 characters.
const MAX_ANSWER_BYTES: usize = 64 * 1024;
/// The code Cloudflare's delete gave for a script that isn't there, as spike A recorded it, is core's to judge. This
/// one is the KV read's for a key that isn't there, as spike G recorded it on 2026-11-23.
const KV_KEY_NOT_FOUND: i64 = 10009;

/// The settings a provider needs, each a Worker secret the owner sets (docs/staging.md, "Setting up release (M6)").
/// None is set in any environment's configuration.
const ACCOUNT: &str = "CONTENT_ACCOUNT_ID";
const NAMESPACE: &str = "CONTENT_DISPATCH_NAMESPACE";
const KV_NAMESPACE: &str = "CONTENT_KV_NAMESPACE_ID";
const DOMAIN: &str = "CONTENT_DOMAIN";
const SCRIPTS_TOKEN: &str = "CONTENT_SCRIPTS_TOKEN";
const ROUTING_TOKEN: &str = "CONTENT_ROUTING_TOKEN";
/// The preview dispatch namespace's name (M8 step 6; the preview plan's 3.1 and section 8; decision 258): a plain
/// setting, not a secret, since a name grants nothing. **Set nowhere:** the namespace is the owner's to make through a
/// wizard, and staging's `wrangler.jsonc` names this setting only in a comment until then. With it unset, or not a
/// namespace's name, or the same name as production's, there is no preview provider ([`Provider::for_previews`]), and
/// nothing is uploaded to, deleted from or listed in any namespace for a preview.
pub(crate) const PREVIEW_NAMESPACE: &str = "CONTENT_PREVIEW_NAMESPACE";

/// No list this module reads is longer. A longer one is no list: the reconcile says so and tries again later.
const MAX_LIST_BYTES: usize = 1024 * 1024;
/// Serve-entry keys asked for in one page.
pub(crate) const KEY_PAGE: usize = 50;

/// One page of the serve entries' keys, as the provider named them: hosts, the stop key, and anything else that is
/// there. Nothing about a key is trusted but its name.
pub(crate) struct KeyPage {
    pub(crate) keys: Vec<String>,
    /// Where the next page starts, or `None` at the end of the list.
    pub(crate) cursor: Option<String>,
}

/// The dispatch namespace's scripts, by name. Nothing else in the provider's list is trusted.
pub(crate) struct ScriptList {
    pub(crate) ids: Vec<String>,
    /// `false` when anything in the answer hinted at more than it held. How the list pages was never seen.
    pub(crate) complete: bool,
}

/// A cursor as it goes back into a query: printable ASCII, and not long. Anything else is no cursor.
fn cursor_form(cursor: &str) -> bool {
    (1..=2048).contains(&cursor.len()) && cursor.bytes().all(|b| b.is_ascii_graphic())
}

/// Percent-encodes everything but letters, digits, `-`, `_`, `.` and `~`.
fn escaped(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
/// The longest answer a script's bindings read may give: Podster writes at most one binding, so a list anywhere near
/// this is not one it wrote. Longer, from a `200`, is [`Bindings::Oversized`].
pub(crate) const MAX_BINDINGS_BYTES: usize = 256 * 1024;

/// What a script's bindings read gave (rule 3(b)).
pub(crate) enum Bindings {
    List(Vec<Value>),
    Oversized,
    Unread,
}

/// A configured provider. Its fields never leave this module, except the content domain's name and, for rule 3(b)'s
/// check in a room, the serve entries' namespace ID.
pub(crate) struct Provider {
    account: String,
    namespace: String,
    kv_namespace: String,
    domain: String,
    scripts_token: String,
    routing_token: String,
}

/// The key that stops the whole content domain, in the same KV namespace as the serve entries. A host is lower-case
/// letters, digits, `-` and `.`, so no host can ever be this key. **Proposed here, for step 4(b):** the content
/// Worker refuses every host while the key is there, and when it can't read it.
pub(crate) const STOP_KEY: &str = "_stop";
/// What the key holds while the domain is stopped. Its presence is the stop; the value says nothing more.
const STOP_VALUE: &str = "stopped";

/// What a read of the stop key found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StopKey {
    /// The key is there: every host is refused.
    Set,
    /// The provider said, in so many words, that the key isn't there.
    Absent,
    /// Anything else. Never read as either.
    Unknown,
}

/// The content domain this deployment is configured with, if it is: read alone, since telling an app's default host
/// from a custom hostname needs only this and neither token.
///
/// **A content domain that is Podster's own is no content domain** (the security review of PR #563, 2026-11-23):
/// `podster.dev` or a name under it, or the registrable domain of `APP_URL` or `GATEWAY_URL`, by
/// `podster_core::hostnames::content_domain_is_podsters`. Then there is no provider at all, which fails closed, and
/// the isolate logs one line with a code and nothing else.
pub(crate) fn content_domain(env: &Env) -> Option<String> {
    let domain = well_formed(secret(env, DOMAIN), plain_host)?;
    if podster_core::hostnames::normalize(&domain).ok().as_deref() != Some(domain.as_str()) {
        return None;
    }
    let own: Vec<String> = ["APP_URL", "GATEWAY_URL"]
        .into_iter()
        .filter_map(|name| match crate::setting(env, name) {
            Setting::Text(address) => Some(address),
            Setting::Absent | Setting::Unreadable => None,
        })
        .collect();
    let own: Vec<&str> = own.iter().map(String::as_str).collect();
    if podster_core::hostnames::content_domain_is_podsters(&domain, &own) {
        if !DOMAIN_REFUSAL_LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            console_error!("content_provider: no provider: code=content_domain_is_podsters");
        }
        return None;
    }
    Some(domain)
}

/// Whether this isolate has logged the content domain's refusal, so it is logged once and not on every read.
static DOMAIN_REFUSAL_LOGGED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// The label of the app whose default host this is on `domain`: `<label>.<domain>`, exactly one label deep.
pub(crate) fn default_host_label_on<'a>(domain: &str, host: &'a str) -> Option<&'a str> {
    host.strip_suffix(domain)
        .and_then(|rest| rest.strip_suffix('.'))
        .filter(|label| is_label(label))
}

/// Whether a host is `domain` itself or anything under it, at any depth.
pub(crate) fn on_domain(domain: &str, host: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|rest| rest.ends_with('.'))
}

/// What a read of a serve entry found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Entry {
    /// The host's entry names this script, with no mark: a static release's.
    Present(String),
    /// The host's entry names this script, marked as carrying code (`podster_core::serve_entry`, M6 stage 1). The
    /// applier writes one only for a script the room recorded as carrying code, and reads either back by its kind.
    Code(String),
    /// The provider said, in so many words, that the host has no entry.
    Absent,
    /// The provider answered with a value, and it isn't a script's name Rust made. Something else wrote it.
    Foreign,
    /// Anything else: no answer, an error, or an answer that isn't one of the three above. Never read as absent.
    Unknown,
}

/// A serve entry read back as written (M8 step 6), for a preview host, whose value the room compares whole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Raw {
    Value(String),
    /// The provider answered with a value that isn't text: something else wrote it.
    NotText,
    /// The provider said, in so many words, that the host has no entry.
    Absent,
    /// No answer that says either. Never read as absent.
    Unknown,
}

impl Entry {
    /// The kind and the script an entry names, for `podster_core::serve_entry::entry_is` to compare with what the room
    /// wants. `None` for an entry that names no script of Podster's.
    pub(crate) fn named(&self) -> Option<(HostKind, &str)> {
        match self {
            Entry::Present(script) => Some((HostKind::Static, script)),
            Entry::Code(script) => Some((HostKind::Code, script)),
            Entry::Absent | Entry::Foreign | Entry::Unknown => None,
        }
    }
}

fn hex32(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn namespace_name(value: &str) -> bool {
    (1..=63).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn token(value: &str) -> bool {
    (20..=256).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// A host as it goes into a path and a key: lower-case letters, digits, `-` and `.`, with a `.` inside it, and no
/// longer than a hostname may be. The room's state holds only such hosts; this is the guard at the door.
fn plain_host(host: &str) -> bool {
    (4..=253).contains(&host.len())
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
        && host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
}

/// A secret's text when it is bound as text and well-formed, or `None`.
fn well_formed(found: Setting, form: fn(&str) -> bool) -> Option<String> {
    match found {
        Setting::Text(value) if form(&value) => Some(value),
        _ => None,
    }
}

struct Answer {
    status: u16,
    body: Vec<u8>,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    /// The first error's code in Cloudflare's envelope, if there is one.
    fn first_code(&self) -> Option<i64> {
        self.json()["errors"]
            .as_array()
            .and_then(|errors| errors.first())
            .and_then(|error| error["code"].as_i64())
    }
}

/// One call. `None` when there was no answer to read: unreachable, timed out, or longer than any answer this module
/// expects. A redirect is never followed.
async fn call(method: Method, url: String, bearer: &str, body: Option<String>) -> Option<Answer> {
    call_bounded(method, url, bearer, body, MAX_ANSWER_BYTES).await
}

/// The same call, for an answer that may be as long as `max`: a list.
async fn call_bounded(
    method: Method,
    url: String,
    bearer: &str,
    body: Option<String>,
    max: usize,
) -> Option<Answer> {
    match call_sized(method, url, bearer, body, max).await? {
        Sized::Within(answer) => Some(answer),
        Sized::Longer(_) => None,
    }
}

/// An answer that came, told apart by whether its body fit the bound.
enum Sized {
    Within(Answer),
    /// The status of an answer whose body was longer than the bound. Nothing of the body is kept.
    Longer(u16),
}

/// The call itself: `None` when there was no answer at all (unreachable, timed out), and otherwise whether the body
/// fit `max`. A redirect is never followed.
async fn call_sized(
    method: Method,
    url: String,
    bearer: &str,
    body: Option<String>,
    max: usize,
) -> Option<Sized> {
    let controller = AbortController::default();
    let signal = controller.signal();
    let bearer = bearer.to_owned();
    let attempt = async move {
        let headers = Headers::new();
        headers.set("authorization", &format!("Bearer {bearer}"))?;
        headers.set("accept", "application/json")?;
        if body.is_some() {
            headers.set("content-type", "text/plain")?;
        }
        let mut init = RequestInit::new();
        init.with_method(method)
            .with_headers(headers)
            .with_redirect(RequestRedirect::Manual);
        if let Some(body) = body {
            init.with_body(Some(body.into()));
        }
        let mut response = Fetch::Request(Request::new_with_init(&url, &init)?)
            .send_with_signal(&signal)
            .await?;
        let status = response.status_code();
        let body = crate::github::bounded_body(&mut response, max).await?;
        Ok::<_, Error>(match body {
            Some(body) => Sized::Within(Answer { status, body }),
            None => Sized::Longer(status),
        })
    };
    let timeout = Delay::from(Duration::from_millis(CALL_TIMEOUT_MS));
    let answer = match select(Box::pin(attempt), timeout).await {
        Either::Left((Ok(answer), _)) => Some(answer),
        Either::Left((Err(_), _)) | Either::Right(_) => None,
    };
    controller.abort();
    answer
}

/// Fetches a release's marker through an app's own host, as a visitor would (M6 step 5; ADR 0010's "The release job",
/// step 6). `(status, body)`, or `None` when there was no answer to read: unreachable, timed out, or longer than any
/// marker. **No credential of any kind is sent,** no redirect is followed, and nothing is read but the status and at
/// most `MARKER_MAX_BYTES` of body. The host is the room's own, checked against its form here; it is never logged.
pub(crate) async fn fetch_marker(host: &str) -> Option<(u16, Vec<u8>)> {
    use podster_core::release_marker::{MARKER_FETCH_TIMEOUT_MS, MARKER_MAX_BYTES};
    use podster_core::release_tree::MARKER_PATH;
    if !plain_host(host) {
        return None;
    }
    let url = format!("https://{host}/{MARKER_PATH}");
    let controller = AbortController::default();
    let signal = controller.signal();
    let attempt = async move {
        let headers = Headers::new();
        headers.set("accept", "application/json")?;
        headers.set("cache-control", "no-cache")?;
        let mut init = RequestInit::new();
        init.with_method(Method::Get)
            .with_headers(headers)
            .with_redirect(RequestRedirect::Manual);
        let mut response = Fetch::Request(Request::new_with_init(&url, &init)?)
            .send_with_signal(&signal)
            .await?;
        let status = response.status_code();
        let body = crate::github::bounded_body(&mut response, MARKER_MAX_BYTES).await?;
        Ok::<_, Error>(body.map(|body| (status, body)))
    };
    let timeout = Delay::from(Duration::from_millis(
        u64::try_from(MARKER_FETCH_TIMEOUT_MS).unwrap_or(0),
    ));
    let answer = match select(Box::pin(attempt), timeout).await {
        Either::Left((Ok(answer), _)) => answer,
        Either::Left((Err(_), _)) | Either::Right(_) => None,
    };
    controller.abort();
    answer
}

impl Provider {
    /// The provider this deployment is configured with, or `None`. All six settings must be bound as text and
    /// well-formed. One missing or malformed means no provider at all, never half of one.
    pub(crate) fn from_env(env: &Env) -> Option<Provider> {
        let domain = content_domain(env)?;
        Some(Provider {
            account: well_formed(secret(env, ACCOUNT), hex32)?,
            namespace: well_formed(secret(env, NAMESPACE), namespace_name)?,
            kv_namespace: well_formed(secret(env, KV_NAMESPACE), hex32)?,
            domain,
            scripts_token: well_formed(secret(env, SCRIPTS_TOKEN), token)?,
            routing_token: well_formed(secret(env, ROUTING_TOKEN), token)?,
        })
    }

    /// **The preview provider** (M8 step 6; the preview plan's 3.1, "Namespace"): production's provider in every way
    /// but its dispatch namespace, which is the preview namespace named by [`PREVIEW_NAMESPACE`]. So a preview's script
    /// is uploaded, read, listed and deleted only there, and never in production's namespace. The tokens are shared,
    /// since neither can be scoped below the account (the plan's section 8). `None` when production's provider isn't
    /// configured, when the setting is unset or isn't a namespace's name, **and when it names production's own
    /// namespace,** which fails closed rather than ever mixing the two.
    pub(crate) fn for_previews(env: &Env) -> Option<Provider> {
        let production = Provider::from_env(env)?;
        let namespace = well_formed(crate::setting(env, PREVIEW_NAMESPACE), namespace_name)?;
        (namespace != production.namespace).then_some(Provider {
            namespace,
            ..production
        })
    }

    /// The label of the app whose default host this is: `<label>.<content domain>`, exactly one label deep. `None`
    /// for any other host, a custom hostname among them.
    pub(crate) fn default_host_label<'a>(&self, host: &'a str) -> Option<&'a str> {
        default_host_label_on(&self.domain, host)
    }

    /// Whether a host is the content domain itself or anything under it, at any depth. Only `<label>.<content domain>`
    /// is ever an app's host there ([`Provider::default_host_label`]); every other such name is nobody's.
    pub(crate) fn on_content_domain(&self, host: &str) -> bool {
        on_domain(&self.domain, host)
    }

    fn stop_url(&self) -> String {
        format!(
            "{API}/accounts/{}/storage/kv/namespaces/{}/values/{STOP_KEY}",
            self.account, self.kv_namespace
        )
    }

    /// Sets the stop key. `true` only when the provider said it was written.
    pub(crate) async fn write_stop(&self) -> bool {
        call(
            Method::Put,
            self.stop_url(),
            &self.routing_token,
            Some(STOP_VALUE.to_owned()),
        )
        .await
        .is_some_and(|answer| answer.status == 200 && answer.json()["success"] == true)
    }

    /// Removes the stop key. `true` only when the provider said it was done.
    pub(crate) async fn delete_stop(&self) -> bool {
        call(Method::Delete, self.stop_url(), &self.routing_token, None)
            .await
            .is_some_and(|answer| answer.status == 200 && answer.json()["success"] == true)
    }

    /// Reads the stop key back.
    pub(crate) async fn read_stop(&self) -> StopKey {
        let Some(answer) = call(Method::Get, self.stop_url(), &self.routing_token, None).await
        else {
            return StopKey::Unknown;
        };
        match answer.status {
            200 if answer.body == STOP_VALUE.as_bytes() => StopKey::Set,
            404 if answer.first_code() == Some(KV_KEY_NOT_FOUND) => StopKey::Absent,
            _ => StopKey::Unknown,
        }
    }

    /// One page of the serve entries' keys. `None` when there was no answer, or one that isn't exactly a page.
    pub(crate) async fn list_entries(&self, cursor: Option<&str>) -> Option<KeyPage> {
        let mut url = format!(
            "{API}/accounts/{}/storage/kv/namespaces/{}/keys?limit={KEY_PAGE}",
            self.account, self.kv_namespace
        );
        if let Some(cursor) = cursor {
            if !cursor_form(cursor) {
                return None;
            }
            url.push_str("&cursor=");
            url.push_str(&escaped(cursor));
        }
        let answer =
            call_bounded(Method::Get, url, &self.routing_token, None, MAX_LIST_BYTES).await?;
        let body = answer.json();
        if answer.status != 200 || body["success"] != true {
            return None;
        }
        let keys = body["result"]
            .as_array()?
            .iter()
            .map(|key| key["name"].as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()?;
        // The end of the list is said in so many words: `result_info` with an empty cursor. An answer with no
        // `result_info`, or none of that shape, is no page at all, and never read as the end.
        let cursor = match &body["result_info"].as_object()?.get("cursor")? {
            Value::String(next) if next.is_empty() => None,
            Value::String(next) if cursor_form(next) => Some(next.clone()),
            _ => return None,
        };
        Some(KeyPage { keys, cursor })
    }

    /// The namespace's scripts. `None` when there was no answer, or one that isn't exactly a list.
    pub(crate) async fn list_scripts(&self) -> Option<ScriptList> {
        let url = format!(
            "{API}/accounts/{}/workers/dispatch/namespaces/{}/scripts",
            self.account, self.namespace
        );
        let answer =
            call_bounded(Method::Get, url, &self.scripts_token, None, MAX_LIST_BYTES).await?;
        let body = answer.json();
        if answer.status != 200 || body["success"] != true {
            return None;
        }
        let ids = body["result"]
            .as_array()?
            .iter()
            .map(|script| script["id"].as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()?;
        // Spike A saw the whole list in one answer and never more than five scripts. Anything here that says there
        // is more than this answer holds makes the list incomplete, which the caller reports and never acts past.
        let info = &body["result_info"];
        let more = info["cursor"].as_str().is_some_and(|next| !next.is_empty())
            || info["total_count"]
                .as_u64()
                .is_some_and(|total| total > ids.len() as u64)
            || info["total_pages"].as_u64().is_some_and(|pages| pages > 1);
        Some(ScriptList {
            ids,
            complete: !more,
        })
    }

    fn script_url(&self, name: &str) -> Option<String> {
        // Only a name Rust made: nothing else goes into the path, so nothing needs escaping.
        matches!(script_owner(name), ScriptOwner::Podster { .. }).then(|| {
            format!(
                "{API}/accounts/{}/workers/dispatch/namespaces/{}/scripts/{name}",
                self.account, self.namespace
            )
        })
    }

    fn entry_url(&self, host: &str) -> Option<String> {
        plain_host(host).then(|| {
            format!(
                "{API}/accounts/{}/storage/kv/namespaces/{}/values/{host}",
                self.account, self.kv_namespace
            )
        })
    }

    /// Reads a script. `None` when there was no answer, or a `200` that doesn't say whether the script is there.
    pub(crate) async fn read_script(&self, name: &str) -> Option<ScriptAnswer> {
        self.read_script_named(name).await.map(|(answer, _)| answer)
    }

    /// Reads a script, with the `id` its script object answered, if it answered one: the name the provider gives the
    /// script it found, for settling to compare with the name it asked for (`settle_read`). `None` as [`read_script`].
    ///
    /// [`read_script`]: Self::read_script
    pub(crate) async fn read_script_named(
        &self,
        name: &str,
    ) -> Option<(ScriptAnswer, Option<String>)> {
        let answer = call(
            Method::Get,
            self.script_url(name)?,
            &self.scripts_token,
            None,
        )
        .await?;
        if answer.status != 200 {
            return Some((
                ScriptAnswer::Read {
                    status: answer.status,
                    script_null: false,
                },
                None,
            ));
        }
        // The read answers the namespace's own fields and the script: `null` for one that isn't there, an object
        // for one that is. A `200` with neither says nothing.
        let body = answer.json();
        let script = body["result"].as_object()?.get("script")?;
        match script {
            Value::Null => Some((
                ScriptAnswer::Read {
                    status: 200,
                    script_null: true,
                },
                None,
            )),
            Value::Object(found) => Some((
                ScriptAnswer::Read {
                    status: 200,
                    script_null: false,
                },
                found.get("id").and_then(Value::as_str).map(str::to_owned),
            )),
            _ => None,
        }
    }

    /// A script's bindings, with the scripts token (rule 3(b), S5 of the store plan): the entries of the list as the
    /// provider gave them; [`Bindings::Oversized`] for a `200` whose body is longer than [`MAX_BINDINGS_BYTES`], which
    /// no list Podster writes comes near, so padding can't hide a binding (the review of PR #420); and
    /// [`Bindings::Unread`] when there was no answer, or one that isn't a `200` with `"success": true` and an array.
    /// The store spike read this path with a read token and saw `{ type, name }` in each entry; a `404` (10007) or an
    /// empty list straight after an upload is the read lagging, which the room judges as core says. What each entry
    /// means is `podster_core::app_bindings`'s, in the room.
    pub(crate) async fn read_bindings(&self, name: &str) -> Bindings {
        let Some(url) = self.script_url(name).map(|url| format!("{url}/bindings")) else {
            return Bindings::Unread;
        };
        let answer = match call_sized(
            Method::Get,
            url,
            &self.scripts_token,
            None,
            MAX_BINDINGS_BYTES,
        )
        .await
        {
            Some(Sized::Within(answer)) => answer,
            Some(Sized::Longer(200)) => return Bindings::Oversized,
            Some(Sized::Longer(_)) | None => return Bindings::Unread,
        };
        let body = answer.json();
        if answer.status != 200 || body["success"] != true {
            return Bindings::Unread;
        }
        body["result"]
            .as_array()
            .cloned()
            .map_or(Bindings::Unread, Bindings::List)
    }

    /// The ID of the KV namespace that holds the serve entries, for rule 3(b) to tell a binding to it from any other.
    /// It goes only to a room's check, never into a log or an answer.
    pub(crate) fn serve_entries_namespace(&self) -> &str {
        &self.kv_namespace
    }

    /// Deletes a script. `None` when there was no answer: the delete may or may not have happened.
    pub(crate) async fn delete_script(&self, name: &str) -> Option<ScriptAnswer> {
        let url = format!("{}?force=true", self.script_url(name)?);
        let answer = call(Method::Delete, url, &self.scripts_token, None).await?;
        Some(ScriptAnswer::Delete {
            status: answer.status,
            code: answer.first_code(),
        })
    }

    /// What a host's serve entry holds for one script: on the content domain, an app's default host, the script's name
    /// alone; anywhere else, a custom hostname, the script's name and the host it is written under
    /// (`podster_core::hostnames::custom_entry_value`, M6 step 8c), so a value under any other key serves nothing.
    /// Either is after the mark that the script carries code when `kind` says so (`podster_core::serve_entry`).
    /// `None` for a script that isn't a name Podster makes, or a host on the content domain that isn't that script's
    /// app's default host: a host there takes only its own app's scripts, and a host two labels deep is nobody's.
    fn entry_value(&self, host: &str, script: &str, kind: HostKind) -> Option<String> {
        let ScriptOwner::Podster { label, .. } = script_owner(script) else {
            return None;
        };
        if self.on_content_domain(host) {
            return if self.default_host_label(host) == Some(label) {
                default_entry_value(kind, script)
            } else {
                None
            };
        }
        custom_entry_value_kind(kind, host, script)
    }

    /// Writes a host's serve entry, naming one script of `kind`, in the form [`Provider::entry_value`] gives: marked
    /// when it carries code, and exactly as every static entry has always been written when it doesn't. `true` only
    /// when the provider said it was written. **The applier is its only caller** (`workspace::takedown`), with the
    /// kind the room recorded for the script before it wrote it; and a test build's route. A test reads every source
    /// for any other.
    pub(crate) async fn write_entry_as(&self, host: &str, script: &str, kind: HostKind) -> bool {
        let Some(value) = self.entry_value(host, script, kind) else {
            return false;
        };
        let Some(url) = self.entry_url(host) else {
            return false;
        };
        call(Method::Put, url, &self.routing_token, Some(value))
            .await
            .is_some_and(|answer| answer.status == 200 && answer.json()["success"] == true)
    }

    /// Deletes a host's serve entry. `true` only when the provider said it was done. The applier still reads the
    /// entry back before it records anything.
    pub(crate) async fn delete_entry(&self, host: &str) -> bool {
        let Some(url) = self.entry_url(host) else {
            return false;
        };
        call(Method::Delete, url, &self.routing_token, None)
            .await
            .is_some_and(|answer| answer.status == 200 && answer.json()["success"] == true)
    }

    /// **Writes a default preview host's serve entry** (M8 step 6; the preview plan's 3.1, "Serve entry"), exactly
    /// `value`, which must be a preview entry ([`podster_core::serve_entry::preview_entry_script`]) whose script is
    /// under the host's own label: so this never writes a production form, and never a script of another label, under
    /// any host. `true` only when the provider said it was written. **The room's preview applier is its only caller**
    /// (`workspace::preview_apply`), with the value core wrote for the room's own slot.
    pub(crate) async fn write_preview_entry(&self, host: &str, value: &str) -> bool {
        let Some(label) = self.default_host_label(host) else {
            return false;
        };
        let own = podster_core::serve_entry::preview_entry_script(value).is_some_and(|entry| {
            matches!(script_owner(entry.script), ScriptOwner::Podster { label: owner, .. } if owner == label)
        });
        let Some(url) = self.entry_url(host).filter(|_| own) else {
            return false;
        };
        call(
            Method::Put,
            url,
            &self.routing_token,
            Some(value.to_owned()),
        )
        .await
        .is_some_and(|answer| answer.status == 200 && answer.json()["success"] == true)
    }

    /// Reads a host's serve entry back as written, for a preview host: [`Raw::Value`] with the text, which the caller
    /// compares whole with what it wants, [`Raw::Absent`] only on the provider's own word, and [`Raw::Unknown`]
    /// otherwise.
    pub(crate) async fn read_raw_entry(&self, host: &str) -> Raw {
        let Some(url) = self.entry_url(host) else {
            return Raw::Unknown;
        };
        let Some(answer) = call(Method::Get, url, &self.routing_token, None).await else {
            return Raw::Unknown;
        };
        match answer.status {
            200 => String::from_utf8(answer.body).map_or(Raw::NotText, Raw::Value),
            404 if answer.first_code() == Some(KV_KEY_NOT_FOUND) => Raw::Absent,
            _ => Raw::Unknown,
        }
    }

    /// Reads a host's serve entry back.
    pub(crate) async fn read_entry(&self, host: &str) -> Entry {
        let raw = self.read_raw_entry(host).await;
        self.entry_of(host, &raw)
    }

    /// A serve entry read back as written, read as production's forms for `host`: a default host's script alone, a
    /// custom hostname's naming that very host, either after the mark that it carries code. Anything else there is
    /// foreign, a value in the other form among it, a preview entry included, and so is anything that looks like a
    /// mark but isn't exactly it.
    pub(crate) fn entry_of(&self, host: &str, raw: &Raw) -> Entry {
        match raw {
            Raw::Value(value) => {
                let read = if self.on_content_domain(host) {
                    default_entry_script(value)
                } else {
                    custom_entry_script_kind(host, value)
                };
                match read {
                    Some((HostKind::Static, script)) => Entry::Present(script.to_owned()),
                    Some((HostKind::Code, script)) => Entry::Code(script.to_owned()),
                    None => Entry::Foreign,
                }
            }
            Raw::NotText => Entry::Foreign,
            Raw::Absent => Entry::Absent,
            Raw::Unknown => Entry::Unknown,
        }
    }
}

/// Test builds only: one write or read of a serve entry by the provider, against the stand-in, of either kind, so the
/// provider's own forms are shown apart from the applier (M6 stage 1). The answers are the stand-in's.
#[cfg(feature = "failpoints")]
pub(crate) async fn test_route(env: &Env, body: Value) -> Result<Response> {
    let Some(provider) = Provider::from_env(env) else {
        return Response::from_json(&serde_json::json!({ "configured": false }));
    };
    let host = body["host"].as_str().unwrap_or_default();
    let answer = match body["op"].as_str() {
        Some("write") => {
            let kind = if body["code"] == true {
                HostKind::Code
            } else {
                HostKind::Static
            };
            let script = body["script"].as_str().unwrap_or_default();
            serde_json::json!({ "written": provider.write_entry_as(host, script, kind).await })
        }
        Some("read") => {
            let (entry, script) = match provider.read_entry(host).await {
                Entry::Present(script) => ("present", Some(script)),
                Entry::Code(script) => ("code", Some(script)),
                Entry::Absent => ("absent", None),
                Entry::Foreign => ("foreign", None),
                Entry::Unknown => ("unknown", None),
            };
            serde_json::json!({ "entry": entry, "script": script })
        }
        _ => return Response::error("unknown op", 400),
    };
    Response::from_json(&answer)
}
