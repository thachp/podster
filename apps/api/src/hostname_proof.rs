//! Reading a custom hostname's challenge from DNS (M6 step 8, ADR 0010's "Custom domains", step 3).
//!
//! A room's proof job asks a resolver over HTTPS for the TXT records at `_podster-challenge.<hostname>`, and Rust
//! compares them with the request's own value (`podster_core::hostnames::proof_matches`). This module only asks and
//! reads; it decides nothing.
//!
//! **No resolver is configured anywhere.** Which resolver, and what trusting it means, is a spike the ADR leaves open
//! (spike D). [`Resolver::from_env`] answers `None` unless `HOSTNAME_RESOLVER_URL` is bound to an `https` URL on a
//! public name, which no environment does. With none, no proof is ever read, so no request is ever claimed, and the
//! room's job says so by a code.
//!
//! **The answer's form is DNS over HTTPS's JSON form** (`application/dns-json`), which Cloudflare's and Google's public
//! resolvers both give: `Status`, the DNS response code, and `Answer`, the records, each with its `type` and `data`.
//! The resolver follows a CNAME for us, so every TXT record in `Answer` counts. **No spike has run this against a real
//! resolver,** so the shape read here is the documented one, read strictly: anything that isn't exactly it is no answer.
//!
//! The name asked for is the room's own normalized hostname, checked again here. Logs carry nothing from this module:
//! no hostname, no value and no resolver's address.
use crate::{setting, Setting};
use futures_util::future::{select, Either};
use serde_json::Value;
use std::time::Duration;
use worker::*;

/// The setting that names the resolver. Bound in no environment.
const RESOLVER: &str = "HOSTNAME_RESOLVER_URL";
/// How long one lookup may take. The room's alarm waits on it.
const LOOKUP_TIMEOUT_MS: u64 = 5_000;
/// No answer this module reads is longer.
const MAX_ANSWER_BYTES: usize = 64 * 1024;
/// A TXT record's type number.
const TXT: i64 = 16;
/// The DNS response codes read: no error, and no such name.
const NOERROR: i64 = 0;
const NXDOMAIN: i64 = 3;

/// A configured resolver.
pub(crate) struct Resolver {
    url: String,
}

impl Resolver {
    /// The deployment's resolver, if one is configured and its address is an `https` URL on a public name, with no
    /// query of its own. `None` otherwise, which is every environment.
    pub(crate) fn from_env(env: &Env) -> Option<Resolver> {
        let Setting::Text(raw) = setting(env, RESOLVER) else {
            return None;
        };
        let url = podster_egress::check_wake_url(&raw).ok()?;
        (!url.contains('?')).then_some(Resolver { url })
    }

    /// The TXT values at `name`, each one record's text with its strings joined. An empty list when the resolver said
    /// there are none, or that the name doesn't exist. `None` when there was no answer to read: unreachable, timed
    /// out, too long, truncated, any other response code, or any answer that isn't exactly the documented form.
    pub(crate) async fn txt(&self, name: &str) -> Option<Vec<String>> {
        if !plain_name(name) {
            return None;
        }
        let url = format!("{}?name={}&type=TXT", self.url, name);
        let controller = AbortController::default();
        let signal = controller.signal();
        let attempt = async move {
            let headers = Headers::new();
            headers.set("accept", "application/dns-json")?;
            let mut init = RequestInit::new();
            init.with_method(Method::Get)
                .with_headers(headers)
                .with_redirect(RequestRedirect::Manual);
            let mut response = Fetch::Request(Request::new_with_init(&url, &init)?)
                .send_with_signal(&signal)
                .await?;
            let status = response.status_code();
            let body = crate::github::bounded_body(&mut response, MAX_ANSWER_BYTES).await?;
            Ok::<_, Error>(body.map(|body| (status, body)))
        };
        let timeout = Delay::from(Duration::from_millis(LOOKUP_TIMEOUT_MS));
        let answer = match select(Box::pin(attempt), timeout).await {
            Either::Left((Ok(answer), _)) => answer,
            Either::Left((Err(_), _)) | Either::Right(_) => None,
        };
        controller.abort();
        let (status, body) = answer?;
        if status != 200 {
            return None;
        }
        read_answer(&serde_json::from_slice(&body).ok()?)
    }
}

/// A DNS-over-HTTPS JSON answer's TXT values. A record that can't be read as text is passed over: it can't be the
/// request's value, and the others may still be. **A truncated answer (`TC` true) is no answer:** it may be missing
/// records, so it can't be read as what the name holds; a `TC` of any other form than a boolean is no answer either.
fn read_answer(answer: &Value) -> Option<Vec<String>> {
    match &answer["TC"] {
        Value::Null | Value::Bool(false) => {}
        _ => return None,
    }
    match answer["Status"].as_i64()? {
        NXDOMAIN => return Some(Vec::new()),
        NOERROR => {}
        _ => return None,
    }
    let records = match &answer["Answer"] {
        Value::Null => return Some(Vec::new()),
        Value::Array(records) => records,
        _ => return None,
    };
    let mut values = Vec::new();
    for record in records {
        if record["type"].as_i64()? != TXT {
            continue;
        }
        if let Some(text) = podster_core::hostnames::txt_rdata_text(record["data"].as_str()?) {
            values.push(text);
        }
    }
    Some(values)
}

/// A name as it goes into the query: the challenge's prefix, then a hostname Podster wrote. Nothing else.
fn plain_name(name: &str) -> bool {
    name.strip_prefix(podster_core::hostnames::CHALLENGE_PREFIX)
        .and_then(|rest| rest.strip_prefix('.'))
        .is_some_and(|host| podster_core::hostnames::normalize(host).ok().as_deref() == Some(host))
}
