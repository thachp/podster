//! Reading a custom hostname's challenge from DNS (M6 step 8, ADR 0010's "Custom domains", steps 3 and 7).
//!
//! A room's proof job (8a) and its daily recheck (8d) ask a resolver over HTTPS for the TXT records at
//! `_podster-challenge.<hostname>`. This module only asks and reads the answer's shape; what the answer means, a match,
//! a definite no or no answer, is decided in Rust's core (`podster_core::hostname_recheck::read_challenge`).
//!
//! **No resolver is configured anywhere.** [`Resolver::from_env`] answers `None` unless `HOSTNAME_RESOLVER_URL` is
//! bound to an `https` URL on a public name, which no environment does. With none, no proof is ever read, so no request
//! is ever claimed, and the room's job says so by a code.
//!
//! **The answer's form is DNS over HTTPS's JSON form** (`application/dns-json`), as spike D saw Cloudflare's and
//! Google's resolvers give it (2026-11-18): `Status`, the DNS response code; `TC`; and `Answer`, the records, each with
//! its owner `name`, its `type` and its `data`. Anything that isn't exactly that shape is no answer. Which records
//! count, and how a TXT's quoting is read, is core's.
//!
//! The name asked for is the room's own normalized hostname, checked again here. Logs carry nothing from this module:
//! no hostname, no value and no resolver's address.
use crate::{setting, Setting};
use futures_util::future::{select, Either};
use podster_core::hostname_recheck::{read_challenge, DohAnswer, DohRecord};
use podster_core::hostnames::RecheckOutcome;
use serde_json::Value;
use std::time::Duration;
use worker::*;

/// The setting that names the resolver. Bound in no environment.
const RESOLVER: &str = "HOSTNAME_RESOLVER_URL";
/// How long one lookup may take. The room's alarm waits on it.
const LOOKUP_TIMEOUT_MS: u64 = 5_000;
/// No answer this module reads is longer.
const MAX_ANSWER_BYTES: usize = 64 * 1024;

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

    /// Asks for the TXT records at `name`, the challenge's name, and reads the answer against `expected`, the request's
    /// own value: a match, a definite no, or no answer (`ResolverError`), which is also what an answer that can't be
    /// had is: unreachable, timed out, too long, not `200`, or not the documented form.
    pub(crate) async fn look(&self, name: &str, expected: &str) -> RecheckOutcome {
        let Some(body) = self.ask(name).await else {
            return RecheckOutcome::ResolverError;
        };
        let Some((status, truncated, records)) = answer_shape(&body) else {
            return RecheckOutcome::ResolverError;
        };
        let records: Vec<DohRecord> = records
            .iter()
            .map(|(name, kind, data)| DohRecord {
                name,
                kind: *kind,
                data,
            })
            .collect();
        let answer = DohAnswer {
            status,
            truncated,
            records: &records,
        };
        read_challenge(name, &answer, expected)
    }

    /// The answer's body as JSON, or `None` when there was none to read.
    async fn ask(&self, name: &str) -> Option<Value> {
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
        serde_json::from_slice(&body).ok()
    }
}

/// One record of an answer as read: its owner name, its type and its data.
type Record = (String, i64, String);

/// A DNS-over-HTTPS JSON answer's shape: `Status`, an integer; `TC`, a boolean or absent; and `Answer`, absent or a list
/// of records, each with a string `name`, an integer `type` and a string `data`. `None` for anything else.
fn answer_shape(answer: &Value) -> Option<(i64, bool, Vec<Record>)> {
    let truncated = match &answer["TC"] {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        _ => return None,
    };
    let status = answer["Status"].as_i64()?;
    let records = match &answer["Answer"] {
        Value::Null => Vec::new(),
        Value::Array(records) => records
            .iter()
            .map(|record| {
                Some((
                    record["name"].as_str()?.to_owned(),
                    record["type"].as_i64()?,
                    record["data"].as_str()?.to_owned(),
                ))
            })
            .collect::<Option<Vec<_>>>()?,
        _ => return None,
    };
    Some((status, truncated, records))
}

/// A name as it goes into the query: the challenge's prefix, then a hostname Podster wrote. Nothing else.
fn plain_name(name: &str) -> bool {
    name.strip_prefix(podster_core::hostnames::CHALLENGE_PREFIX)
        .and_then(|rest| rest.strip_prefix('.'))
        .is_some_and(|host| podster_core::hostnames::normalize(host).ok().as_deref() == Some(host))
}
