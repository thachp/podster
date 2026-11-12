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
//!   paths. **No spike has run these.** The write's body, its answer and a missing key's answer here are assumptions
//!   that spike G must confirm before a provider is configured. They are strict on purpose: an entry counts as written
//!   only on `200` with `"success": true`, and as absent only on `404` with code `10009`, so a wrong assumption leaves
//!   the applier retrying, which shows, and never lets it record a removal that didn't happen.
//!
//! A client never names an account, a namespace, a script or a host here: all come from configuration or from the
//! room's own state, and each name is checked against its form before it goes into a path. Logs carry nothing from
//! this module: no host, no script, no ID of the account or the namespaces, and no token.
use crate::{setting, Setting};
use futures_util::future::{select, Either};
use podster_core::release::{is_label, script_owner, ScriptAnswer, ScriptOwner};
use serde_json::Value;
use std::time::Duration;
use worker::*;

const API: &str = "https://api.cloudflare.com/client/v4";
/// How long one call may take. The room's alarm waits on it.
const CALL_TIMEOUT_MS: u64 = 5_000;
/// No answer this module reads is longer: a script's read, an error, or a serve entry of at most 63 characters.
const MAX_ANSWER_BYTES: usize = 64 * 1024;
/// The code Cloudflare's delete gave for a script that isn't there, as spike A recorded it, is core's to judge. This
/// one is the KV read's for a key that isn't there, which no spike has seen: see the module's note.
const KV_KEY_NOT_FOUND: i64 = 10009;

/// The settings a provider needs. None is set in any environment.
const ACCOUNT: &str = "CONTENT_ACCOUNT_ID";
const NAMESPACE: &str = "CONTENT_DISPATCH_NAMESPACE";
const KV_NAMESPACE: &str = "CONTENT_KV_NAMESPACE_ID";
const DOMAIN: &str = "CONTENT_DOMAIN";
const SCRIPTS_TOKEN: &str = "CONTENT_SCRIPTS_TOKEN";
const ROUTING_TOKEN: &str = "CONTENT_ROUTING_TOKEN";
/// A configured provider. Its fields never leave this module, except the content domain's name.
pub(crate) struct Provider {
    account: String,
    namespace: String,
    kv_namespace: String,
    domain: String,
    scripts_token: String,
    routing_token: String,
}

/// What a read of a serve entry found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Entry {
    /// The host's entry names this script.
    Present(String),
    /// The provider said, in so many words, that the host has no entry.
    Absent,
    /// Anything else: no answer, an error, or an answer that isn't one of the two above. Never read as absent.
    Unknown,
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

fn text_setting(env: &Env, name: &str, well_formed: fn(&str) -> bool) -> Option<String> {
    match setting(env, name) {
        Setting::Text(value) if well_formed(&value) => Some(value),
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
        let body = crate::github::bounded_body(&mut response, MAX_ANSWER_BYTES).await?;
        Ok::<_, Error>(body.map(|body| Answer { status, body }))
    };
    let timeout = Delay::from(Duration::from_millis(CALL_TIMEOUT_MS));
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
        let domain = text_setting(env, DOMAIN, plain_host)?;
        if podster_core::hostnames::normalize(&domain).ok().as_deref() != Some(domain.as_str()) {
            return None;
        }
        Some(Provider {
            account: text_setting(env, ACCOUNT, hex32)?,
            namespace: text_setting(env, NAMESPACE, namespace_name)?,
            kv_namespace: text_setting(env, KV_NAMESPACE, hex32)?,
            domain,
            scripts_token: text_setting(env, SCRIPTS_TOKEN, token)?,
            routing_token: text_setting(env, ROUTING_TOKEN, token)?,
        })
    }

    /// The label of the app whose default host this is: `<label>.<content domain>`, exactly one label deep. `None`
    /// for any other host, a custom hostname among them.
    pub(crate) fn default_host_label<'a>(&self, host: &'a str) -> Option<&'a str> {
        host.strip_suffix(self.domain.as_str())
            .and_then(|rest| rest.strip_suffix('.'))
            .filter(|label| is_label(label))
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
        let answer = call(
            Method::Get,
            self.script_url(name)?,
            &self.scripts_token,
            None,
        )
        .await?;
        if answer.status != 200 {
            return Some(ScriptAnswer::Read {
                status: answer.status,
                script_null: false,
            });
        }
        // The read answers the namespace's own fields and the script: `null` for one that isn't there, an object
        // for one that is. A `200` with neither says nothing.
        let body = answer.json();
        let script = body["result"].as_object()?.get("script")?;
        match script {
            Value::Null => Some(ScriptAnswer::Read {
                status: 200,
                script_null: true,
            }),
            Value::Object(_) => Some(ScriptAnswer::Read {
                status: 200,
                script_null: false,
            }),
            _ => None,
        }
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

    /// Writes a host's serve entry, naming one script. `true` only when the provider said it was written.
    pub(crate) async fn write_entry(&self, host: &str, script: &str) -> bool {
        let ScriptOwner::Podster { label, .. } = script_owner(script) else {
            return false;
        };
        // A host on the content domain is one app's default host, and takes only that app's scripts: the label in
        // the host and the label in the script's name must be the same one. A host two labels deep is nobody's.
        if host.ends_with(self.domain.as_str()) && self.default_host_label(host) != Some(label) {
            return false;
        }
        let Some(url) = self.entry_url(host) else {
            return false;
        };
        call(
            Method::Put,
            url,
            &self.routing_token,
            Some(script.to_owned()),
        )
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

    /// Reads a host's serve entry back.
    pub(crate) async fn read_entry(&self, host: &str) -> Entry {
        let Some(url) = self.entry_url(host) else {
            return Entry::Unknown;
        };
        let Some(answer) = call(Method::Get, url, &self.routing_token, None).await else {
            return Entry::Unknown;
        };
        match answer.status {
            200 => match String::from_utf8(answer.body) {
                Ok(script) if matches!(script_owner(&script), ScriptOwner::Podster { .. }) => {
                    Entry::Present(script)
                }
                _ => Entry::Unknown,
            },
            404 if answer.first_code() == Some(KV_KEY_NOT_FOUND) => Entry::Absent,
            _ => Entry::Unknown,
        }
    }
}
