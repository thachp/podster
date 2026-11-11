//! Every call Podster makes to GitHub for provisioning goes through here (M5 step 4, ADR 0009, which is proposed).
//!
//! [`Provider`] is the boundary: three calls, in the provider's terms and no HTTP. [`GitHubApp`] is the one real
//! implementation. It signs a short-lived App JWT with the provisioning App's private key, trades it for an installation
//! token, and makes the REST calls. Nothing outside this file builds a GitHub URL or holds a token.
//!
//! - **Nothing a client sends reaches here.** The organization, the App, its installation and the merge App's ID come from
//!   the Worker's configuration, and a repository is addressed by the numeric ID from GitHub's own answer, never by a name.
//! - **Tokens and the key stay here.** They are never returned, logged, stored or put in an error. A failure carries an
//!   HTTP status or a fixed word, and none of GitHub's text.
//! - **A token is as narrow and as short-lived as its work.** The installation's own token, which can administer every
//!   repository, is minted for the creation call alone and revoked as soon as that call ends. Setup and the read-back use
//!   a second token, narrowed to the one repository, revoked when the job ends, on every way out.
//! - **Unverified against GitHub:** addressing a repository as `/repositories/{id}`, switching Actions off per repository
//!   and reading that back. The spike made its calls by name and never switched Actions off. Both are owed before staging.
use futures_util::future::{select, Either};
use futures_util::StreamExt;
use js_sys::{Array, Function, Object, Promise, Reflect, Uint8Array};
use podster_core::provisioning::{
    classify_creation, gone, repository_gone, token_answer_matches, Bypass, Creation, Observed,
    RepoSettings, Ruleset, SetupStep, WorkflowPermissions, DEFAULT_BRANCH_REF,
    PRESENCE_PERMISSIONS, PROVISIONING_PERMISSIONS, STATUS_CONTEXT,
};
use podster_core::rate_limit::{has_secondary_marker, rate_limit_wait_ms, LimitSignals};
use podster_core::repo_access::{minted_token_matches, TokenPermissions};
use podster_core::repo_merge::PullState;
use podster_core::repositories::valid_commit_sha;
use podster_core::task_change::PullSeen;
use podster_egress::app_key::{
    app_jwt_signing_input, base64url, pkcs8_from_pem, role_is_distinct, AppRole,
};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::time::Duration;
use wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::*;

#[cfg(not(feature = "rehearsal"))]
const API: &str = "https://api.github.com";
/// The local rehearsal's fake GitHub (`e2e/run-local.mjs`). The address is fixed when that build is made, and the build
/// fails unless it is on this machine. No variable, secret or request can point a deployed Worker anywhere but GitHub.
#[cfg(feature = "rehearsal")]
const API: &str = env!("PODSTER_REHEARSAL_GITHUB_URL");
#[cfg(feature = "rehearsal")]
const _: () = assert!(
    is_loopback(API),
    "PODSTER_REHEARSAL_GITHUB_URL must be http://127.0.0.1:<port>"
);

/// Whether an address is plain HTTP to this machine's loopback, with a port and nothing after it.
#[cfg(feature = "rehearsal")]
const fn is_loopback(url: &str) -> bool {
    let (url, prefix) = (url.as_bytes(), b"http://127.0.0.1:");
    if url.len() <= prefix.len() || url.len() > prefix.len() + 5 {
        return false;
    }
    let mut at = 0;
    while at < url.len() {
        let ok = if at < prefix.len() {
            url[at] == prefix[at]
        } else {
            url[at].is_ascii_digit()
        };
        if !ok {
            return false;
        }
        at += 1;
    }
    true
}
const USER_AGENT: &str = "podster-provisioning";
/// Test builds wait as long. A shorter wait there turned any call a busy machine was slow to answer into "no answer",
/// which a test then read as GitHub failing. The tests that mean "no answer" hold the call at the fake until this is over.
const CALL_TIMEOUT_MS: u64 = 10_000;
/// No answer this job reads is anywhere near this long.
const MAX_ANSWER_BYTES: usize = 256 * 1024;
/// A pull request's answer carries its whole description, which its author writes and Podster never keeps. This is room
/// for the longest GitHub allows, so a long description can't make a pull request unreadable.
const MAX_PULL_ANSWER_BYTES: usize = 1024 * 1024;
/// The longest base branch name read out of a pull request. A longer one is kept as no name at all.
const MAX_BRANCH_NAME_BYTES: usize = 255;
/// A repository Podster made has two rulesets. Reading a few more is enough to see that something else is there.
const MAX_RULESETS_READ: usize = 5;
pub const REVIEW_RULESET_NAME: &str = "podster-review";
pub const UPDATE_RULESET_NAME: &str = "podster-update";

/// Where provisioning happens and as whom. All of it is the Worker's configuration, set by the owner.
/// A positive number from a variable, or `None`.
fn number(env: &Env, name: &str) -> Option<i64> {
    env.var(name)
        .ok()
        .and_then(|v| v.to_string().parse::<i64>().ok())
        .filter(|n| *n > 0)
}

/// A variable's or secret's value by name, or `None`.
pub fn lookup(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|v| v.to_string())
        .or_else(|| secret(env, name))
}

/// A secret's value, or `None`.
fn secret(env: &Env, name: &str) -> Option<String> {
    env.secret(name).ok().map(|v| v.to_string())
}

pub struct Config {
    org_login: String,
    pub org_id: i64,
    app_id: i64,
    installation_id: i64,
    pub merge_app_id: i64,
    key_pem: String,
}

impl Config {
    /// The organization Podster's repositories are made in, as the Worker's configuration names it: checked to be
    /// letters, digits and hyphens of GitHub's length when it was read. Never anything from GitHub's answers.
    pub fn org_login(&self) -> &str {
        &self.org_login
    }

    /// `None` unless every variable and the key are set and well-formed. The caller says only that provisioning isn't
    /// configured, never which part.
    pub fn from_env(env: &Env) -> Option<Config> {
        let number = |name: &str| number(env, name);
        let org_login = env.var("GITHUB_ORG_LOGIN").ok()?.to_string();
        let plain = !org_login.is_empty()
            && org_login.len() <= 39
            && org_login
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-');
        let key_pem = env.secret("GITHUB_PROVISION_APP_KEY").ok()?.to_string();
        (plain && pkcs8_from_pem(&key_pem).is_some()).then_some(())?;
        let config = Config {
            org_login,
            org_id: number("GITHUB_ORG_ID")?,
            app_id: number("GITHUB_PROVISION_APP_ID")?,
            installation_id: number("GITHUB_PROVISION_INSTALLATION_ID")?,
            merge_app_id: number("GITHUB_MERGE_APP_ID")?,
            key_pem,
        };
        // Three roles, three Apps: provisioning shares its App, installation and key with neither other role.
        let distinct = roles_distinct(Role::Provision, &|name: &str| lookup(env, name));
        if !distinct {
            console_error!("provision.app_not_distinct");
        }
        distinct.then_some(config)
    }
}

/// The three GitHub App roles, each with an App, an installation and a key of its own (ADR 0009).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    Provision,
    Agent,
    Merge,
}

impl Role {
    const ALL: [Role; 3] = [Role::Provision, Role::Agent, Role::Merge];

    /// The names of its App ID, installation ID and key in the Worker's configuration.
    fn names(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Role::Provision => (
                "GITHUB_PROVISION_APP_ID",
                "GITHUB_PROVISION_INSTALLATION_ID",
                "GITHUB_PROVISION_APP_KEY",
            ),
            Role::Agent => (
                "GITHUB_AGENT_APP_ID",
                "GITHUB_AGENT_INSTALLATION_ID",
                "GITHUB_AGENT_APP_KEY",
            ),
            Role::Merge => (
                "GITHUB_MERGE_APP_ID",
                "GITHUB_MERGE_INSTALLATION_ID",
                "GITHUB_MERGE_APP_KEY",
            ),
        }
    }

    fn read(self, get: &dyn Fn(&str) -> Option<String>) -> AppRole {
        let (app, installation, key) = self.names();
        let number = |name: &str| {
            get(name)
                .and_then(|v| v.parse::<i64>().ok())
                .filter(|n| *n > 0)
        };
        AppRole {
            app_id: number(app),
            installation_id: number(installation),
            key: get(key).and_then(|pem| pkcs8_from_pem(&pem)),
        }
    }
}

/// Whether `own` shares its App ID, installation ID or key with neither of the other two roles (the M5 security
/// review's F7). Keys are compared as parsed key material, so the same key written two ways is caught.
pub(crate) fn roles_distinct(own: Role, get: &dyn Fn(&str) -> Option<String>) -> bool {
    let others: Vec<AppRole> = Role::ALL
        .into_iter()
        .filter(|role| *role != own)
        .map(|role| role.read(get))
        .collect();
    role_is_distinct(&own.read(get), &others)
}

/// Why a call gave nothing to go on. Neither carries any of the provider's text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// No answer: the network, a timeout, or a token that couldn't be had.
    Unreachable,
    /// An answer with this status, where another was needed.
    Status(u16),
    /// An answer of the right status that doesn't hold what it must.
    Unreadable,
    /// GitHub limited how fast Podster may call it, by its documented signals (`podster_core::rate_limit`). The call
    /// was refused for that alone: it says nothing about the credential, the installation or what was asked, and
    /// nothing was done. `wait_ms` is how long GitHub said to wait, bounded.
    RateLimited { status: u16, wait_ms: i64 },
}

impl Failure {
    /// The provider's HTTP status, for the log. Zero when there was none.
    pub fn status(self) -> u16 {
        match self {
            Failure::Status(status) | Failure::RateLimited { status, .. } => status,
            Failure::Unreachable | Failure::Unreadable => 0,
        }
    }

    /// How long to wait, if this was a rate limit.
    pub fn rate_limit_wait_ms(self) -> Option<i64> {
        match self {
            Failure::RateLimited { wait_ms, .. } => Some(wait_ms),
            _ => None,
        }
    }
}

/// A repository GitHub says it just made.
pub struct Created {
    pub repo_id: i64,
    pub owner_id: i64,
}

pub enum CreateAnswer {
    Created(Created),
    NameTaken,
    Refused(u16),
    /// No token could be had, so no creation call went out and the name was never sent.
    NotSent(u16),
    /// GitHub limited the rate, for the token or for the call. Nothing was made, and the wait is GitHub's, bounded.
    RateLimited(i64),
    /// Nobody knows whether a repository was made.
    Unknown,
}

/// What a repository is called and where its default branch is, for display. Read back, never sent by a client.
pub struct Described {
    pub full_name: String,
    pub default_branch: String,
}

/// The provider, as provisioning needs it.
pub(crate) trait Provider {
    /// Asks for a new repository in the configured organization, with an initial commit.
    async fn create_repository(&self, name: &str, public: bool) -> CreateAnswer;
    /// Reads everything readiness depends on, by the repository's ID.
    async fn read_back(&self, repo_id: i64) -> std::result::Result<(Observed, Described), Failure>;
    /// Adds one missing piece of setup. It never changes or removes anything that's there.
    async fn apply(&self, repo_id: i64, step: SetupStep) -> std::result::Result<(), Failure>;
    /// Revokes every token still held. Answers how many couldn't be revoked in this job, whenever their work ended:
    /// those live out their hour.
    async fn release(&self) -> u32;
}

pub struct GitHubApp {
    config: Config,
    /// The token narrowed to one repository, for this job only, with that repository's ID. Never leaves this struct.
    scoped: RefCell<Option<(i64, String)>>,
    /// Tokens that couldn't be revoked when their work ended, the broad one included. `release` reports them.
    unrevoked: std::cell::Cell<u32>,
}

fn js<T>(result: std::result::Result<T, JsValue>) -> std::result::Result<T, Failure> {
    result.map_err(|_| Failure::Unreachable)
}

/// RS256 over `input` with the runtime's own RSA. The key is imported as not extractable and used once.
async fn sign_rs256(pkcs8: &[u8], input: &str) -> std::result::Result<String, Failure> {
    let subtle = js(Reflect::get(
        &js(Reflect::get(&js_sys::global(), &"crypto".into()))?,
        &"subtle".into(),
    ))?;
    let method = |name: &str| -> std::result::Result<Function, Failure> {
        js(js(Reflect::get(&subtle, &name.into()))?.dyn_into::<Function>())
    };
    let algorithm = Object::new();
    js(Reflect::set(
        &algorithm,
        &"name".into(),
        &"RSASSA-PKCS1-v1_5".into(),
    ))?;
    js(Reflect::set(&algorithm, &"hash".into(), &"SHA-256".into()))?;
    let import = Array::new();
    import.push(&"pkcs8".into());
    import.push(&Uint8Array::from(pkcs8));
    import.push(&algorithm);
    import.push(&JsValue::FALSE);
    import.push(&Array::of1(&"sign".into()));
    let key = js(JsFuture::from(js(
        js(method("importKey")?.apply(&subtle, &import))?.dyn_into::<Promise>()
    )?)
    .await)?;
    let sign = Array::new();
    sign.push(&"RSASSA-PKCS1-v1_5".into());
    sign.push(&key);
    sign.push(&Uint8Array::from(input.as_bytes()));
    let signature = js(JsFuture::from(js(
        js(method("sign")?.apply(&subtle, &sign))?.dyn_into::<Promise>()
    )?)
    .await)?;
    Ok(base64url(&Uint8Array::new(&signature).to_vec()))
}

/// One request, with a timeout and no redirects. Answers the status and the body as JSON, null if it had none.
async fn call(
    method: Method,
    path: &str,
    bearer: &str,
    body: Option<Value>,
) -> std::result::Result<(u16, Value), Failure> {
    call_within(method, path, bearer, body, MAX_ANSWER_BYTES).await
}

/// Reads at most `max_bytes` of an answer, stopping there and never buffering more (the M5 security review's F5). `None`
/// for a longer one, whether its length says so up front or it only shows while reading.
async fn bounded_body(response: &mut Response, max_bytes: usize) -> Result<Option<Vec<u8>>> {
    let declared = response
        .headers()
        .get("content-length")?
        .and_then(|n| n.trim().parse::<usize>().ok());
    if declared.is_some_and(|n| n > max_bytes) {
        return Ok(None);
    }
    // An answer with no body, such as a `204`, has nothing to stream. One the runtime already holds whole is read as it is.
    let Ok(mut stream) = response.stream() else {
        let bytes = response.bytes().await?;
        return Ok((bytes.len() <= max_bytes).then_some(bytes));
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(bytes))
}

/// The same, reading an answer of up to `max_bytes`. A longer one reads as having no body. A rate limit, by GitHub's
/// documented status, headers and message, is `Failure::RateLimited`, never a status a caller could read as a refusal.
async fn call_within(
    method: Method,
    path: &str,
    bearer: &str,
    body: Option<Value>,
    max_bytes: usize,
) -> std::result::Result<(u16, Value), Failure> {
    let controller = AbortController::default();
    let signal = controller.signal();
    let url = format!("{API}{path}");
    let bearer = bearer.to_string();
    let attempt = async move {
        let headers = Headers::new();
        headers.set("accept", "application/vnd.github+json")?;
        headers.set("x-github-api-version", "2022-11-28")?;
        headers.set("user-agent", USER_AGENT)?;
        headers.set("authorization", &format!("Bearer {bearer}"))?;
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
        let header = |name: &str| response.headers().get(name).ok().flatten();
        let signals = LimitSignals {
            status,
            retry_after: header("retry-after"),
            remaining: header("x-ratelimit-remaining"),
            reset: header("x-ratelimit-reset"),
            secondary_marker: false,
        };
        let parsed = match bounded_body(&mut response, max_bytes).await? {
            Some(bytes) if !bytes.is_empty() => {
                serde_json::from_slice(&bytes).unwrap_or(Value::Null)
            }
            _ => Value::Null,
        };
        let signals = LimitSignals {
            secondary_marker: parsed["message"].as_str().is_some_and(has_secondary_marker),
            ..signals
        };
        let limited = rate_limit_wait_ms(&signals, Date::now().as_millis() as i64);
        Ok::<_, Error>((status, parsed, limited))
    };
    let timeout = Delay::from(Duration::from_millis(CALL_TIMEOUT_MS));
    let answer = match select(Box::pin(attempt), timeout).await {
        Either::Left((Ok((status, _, Some(wait_ms))), _)) => {
            Err(Failure::RateLimited { status, wait_ms })
        }
        Either::Left((Ok((status, parsed, None)), _)) => Ok((status, parsed)),
        Either::Left((Err(_), _)) | Either::Right(_) => Err(Failure::Unreachable),
    };
    controller.abort();
    answer
}

/// A fresh App JWT for `app_id`, signed with its key, to trade for an installation token.
async fn app_jwt(app_id: i64, key_pem: &str) -> std::result::Result<String, Failure> {
    let pkcs8 = pkcs8_from_pem(key_pem).ok_or(Failure::Unreachable)?;
    let input = app_jwt_signing_input(app_id, (Date::now().as_millis() / 1000) as i64);
    Ok(format!("{input}.{}", sign_rs256(&pkcs8, &input).await?))
}

fn id(value: &Value) -> Option<i64> {
    value.as_i64().filter(|n| *n > 0)
}

/// A name GitHub gave back, kept only if it's plain enough to show and to put in a path.
fn plain(value: &Value, max: usize) -> Option<String> {
    value
        .as_str()
        .filter(|text| {
            !text.is_empty()
                && text.len() <= max
                && !text.contains("..")
                && text
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/'))
        })
        .map(str::to_string)
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| item.as_str().unwrap_or("?").to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// One ruleset as GitHub describes it, in the terms `podster_core` judges.
fn ruleset(detail: &Value) -> Ruleset {
    let rules = detail["rules"].as_array().cloned().unwrap_or_default();
    let required_statuses = rules
        .iter()
        .filter(|rule| rule["type"].as_str() == Some("required_status_checks"))
        .flat_map(|rule| {
            rule["parameters"]["required_status_checks"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .map(|check| {
            (
                check["context"].as_str().unwrap_or("?").to_string(),
                id(&check["integration_id"]),
            )
        })
        .collect();
    Ruleset {
        enforcement: detail["enforcement"].as_str().unwrap_or("?").to_string(),
        target: detail["target"].as_str().unwrap_or("?").to_string(),
        include: strings(&detail["conditions"]["ref_name"]["include"]),
        exclude: strings(&detail["conditions"]["ref_name"]["exclude"]),
        rule_types: rules
            .iter()
            .map(|rule| rule["type"].as_str().unwrap_or("?").to_string())
            .collect(),
        required_statuses,
        // A token that can't see the bypass list gets an answer without one. That reads as unseen, never as empty.
        bypass: detail["bypass_actors"].as_array().map(|actors| {
            actors
                .iter()
                .map(|actor| Bypass {
                    actor_id: id(&actor["actor_id"]),
                    actor_type: actor["actor_type"].as_str().unwrap_or("?").to_string(),
                    mode: actor["bypass_mode"].as_str().unwrap_or("?").to_string(),
                })
                .collect()
        }),
    }
}

impl GitHubApp {
    pub fn new(config: Config) -> GitHubApp {
        GitHubApp {
            config,
            scoped: RefCell::new(None),
            unrevoked: std::cell::Cell::new(0),
        }
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// One request, with a timeout and no redirects. Answers the status and the body as JSON, null if it had none.
    async fn send(
        &self,
        method: Method,
        path: &str,
        bearer: &str,
        body: Option<Value>,
    ) -> std::result::Result<(u16, Value), Failure> {
        call(method, path, bearer, body).await
    }

    /// Mints an installation token from a fresh App JWT: for one repository, or, with `None`, for the whole
    /// installation, which only the creation call needs. Either way it asks for provisioning's two permissions by
    /// name, and uses the token only if GitHub's answer is exactly that, for exactly that repository, and expires within
    /// the hour (the M5 security review's F4). A token that came back otherwise is revoked unused.
    async fn mint(&self, repo_id: Option<i64>) -> std::result::Result<String, Failure> {
        self.mint_with(repo_id, &PROVISIONING_PERMISSIONS).await
    }

    /// The same, asking for `asked` and accepting nothing else back.
    async fn mint_with(
        &self,
        repo_id: Option<i64>,
        asked: &[(&str, &str)],
    ) -> std::result::Result<String, Failure> {
        let jwt = app_jwt(self.config.app_id, &self.config.key_pem).await?;
        let path = format!(
            "/app/installations/{}/access_tokens",
            self.config.installation_id
        );
        let permissions: serde_json::Map<String, Value> = asked
            .iter()
            .map(|(name, level)| ((*name).to_string(), Value::from(*level)))
            .collect();
        let body = match repo_id {
            Some(id) => json!({ "repository_ids": [id], "permissions": permissions }),
            None => json!({ "permissions": permissions }),
        };
        let (status, answer) = self.send(Method::Post, &path, &jwt, Some(body)).await?;
        if status != 201 {
            return Err(Failure::Status(status));
        }
        let token = answer["token"]
            .as_str()
            .filter(|token| !token.is_empty() && token.len() <= 512 && token.is_ascii())
            .ok_or(Failure::Unreadable)?
            .to_string();
        let (repo_ids, granted) = granted(&answer);
        let granted: Vec<(&str, &str)> = granted
            .iter()
            .map(|(name, level)| (name.as_str(), level.as_str()))
            .collect();
        let expires_at = parse_time(&answer["expires_at"]);
        if !token_answer_matches(
            repo_id,
            &repo_ids,
            &granted,
            asked,
            expires_at,
            Date::now().as_millis() as i64,
        ) {
            if !self.revoke(&token).await {
                self.unrevoked.set(self.unrevoked.get().saturating_add(1));
            }
            console_error!("{}", json!({ "event": "provision.token_mismatch" }));
            return Err(Failure::Unreadable);
        }
        Ok(token)
    }

    /// Whether a repository GitHub wouldn't mint a narrowed token for is gone, by `core::repository_gone`: asked with a
    /// token for the whole installation that can read metadata and nothing else, revoked as soon as it's answered.
    /// `Err` when that token can't be had or the read gets no answer, which says nothing about the repository.
    async fn presence(&self, base: &str) -> std::result::Result<bool, Failure> {
        let token = self.mint_with(None, &PRESENCE_PERMISSIONS).await?;
        let read = self.send(Method::Get, base, &token, None).await;
        if !self.revoke(&token).await {
            self.unrevoked.set(self.unrevoked.get().saturating_add(1));
        }
        let (status, _) = read?;
        Ok(repository_gone(true, status))
    }

    /// Revokes a token. Whether it worked is all that comes back.
    async fn revoke(&self, token: &str) -> bool {
        matches!(
            self.send(Method::Delete, "/installation/token", token, None)
                .await,
            Ok((204, _))
        )
    }

    /// The token for one repository, minted on first use and kept until `release`.
    async fn token_for(&self, repo_id: i64) -> std::result::Result<String, Failure> {
        if let Some((held, token)) = self.scoped.borrow().as_ref() {
            if *held == repo_id {
                return Ok(token.clone());
            }
        }
        // One job is about one repository. A token for another is revoked before a new one is held.
        self.release().await;
        let token = self.mint(Some(repo_id)).await?;
        *self.scoped.borrow_mut() = Some((repo_id, token.clone()));
        Ok(token)
    }

    async fn get(&self, repo_id: i64, path: &str) -> std::result::Result<(u16, Value), Failure> {
        let token = self.token_for(repo_id).await?;
        self.send(Method::Get, path, &token, None).await
    }

    fn ruleset_body(&self, review: bool) -> Value {
        let rules = if review {
            json!([
                { "type": "pull_request", "parameters": { "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false,
                    "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": false } },
                { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false,
                    "required_status_checks": [{ "context": STATUS_CONTEXT, "integration_id": self.config.merge_app_id }] } },
            ])
        } else {
            json!([{ "type": "update" }])
        };
        let bypass = if review {
            json!([])
        } else {
            json!([{ "actor_id": self.config.merge_app_id, "actor_type": "Integration", "bypass_mode": "always" }])
        };
        json!({
            "name": if review { REVIEW_RULESET_NAME } else { UPDATE_RULESET_NAME },
            "target": "branch",
            "enforcement": "active",
            "conditions": { "ref_name": { "include": [DEFAULT_BRANCH_REF], "exclude": [] } },
            "bypass_actors": bypass,
            "rules": rules,
        })
    }
}

impl Provider for GitHubApp {
    async fn create_repository(&self, name: &str, public: bool) -> CreateAnswer {
        // Without a token no creation call goes out, so nothing can have been made and the name was never sent.
        let token = match self.mint(None).await {
            Ok(token) => token,
            Err(Failure::RateLimited { wait_ms, .. }) => return CreateAnswer::RateLimited(wait_ms),
            Err(failure) => return CreateAnswer::NotSent(failure.status()),
        };
        let path = format!("/orgs/{}/repos", self.config.org_login);
        // Everything a stranger or an agent could use that Podster doesn't, off from the start (the M5 security review's
        // F7): issues, wiki and projects, and auto-merge. Discussions can't be set here and start off. Branches stay after
        // a merge, which is GitHub's default and needs no organization owner. A public repository can always be forked:
        // GitHub has no setting that forbids it, so nothing here pretends to.
        let expected = RepoSettings::EXPECTED;
        let body = json!({
            "name": name,
            "private": !public,
            "auto_init": true,
            "has_issues": expected.has_issues,
            "has_wiki": expected.has_wiki,
            "has_projects": expected.has_projects,
            "allow_auto_merge": expected.allow_auto_merge,
            "delete_branch_on_merge": expected.delete_branch_on_merge,
        });
        let sent = self.send(Method::Post, &path, &token, Some(body)).await;
        // The broad token has done the one thing it was for, however that went. If it can't be revoked it lives out its
        // hour with authority over every repository, so that is counted and reported, never dropped.
        if !self.revoke(&token).await {
            self.unrevoked.set(self.unrevoked.get().saturating_add(1));
        }
        let (status, answer) = match sent {
            Ok(answer) => answer,
            // A definite answer, and a refusal for the rate alone: `core` reads it, and nothing was made.
            Err(Failure::RateLimited { status, wait_ms }) => {
                return match classify_creation(Some(status), false, false, true) {
                    Creation::RateLimited => CreateAnswer::RateLimited(wait_ms),
                    _ => CreateAnswer::Refused(status),
                };
            }
            Err(_) => return CreateAnswer::Unknown,
        };
        let name_error = answer["errors"]
            .as_array()
            .is_some_and(|errors| errors.iter().any(|e| e["field"].as_str() == Some("name")));
        let created = id(&answer["id"]).zip(id(&answer["owner"]["id"]));
        match classify_creation(Some(status), name_error, created.is_some(), false) {
            Creation::Created => match created {
                Some((repo_id, owner_id)) => CreateAnswer::Created(Created { repo_id, owner_id }),
                None => CreateAnswer::Unknown,
            },
            Creation::NameTaken => CreateAnswer::NameTaken,
            Creation::Refused => CreateAnswer::Refused(status),
            // Not reached: a limit came back as `Failure::RateLimited` above.
            Creation::RateLimited | Creation::Unknown => CreateAnswer::Unknown,
        }
    }

    async fn read_back(&self, repo_id: i64) -> std::result::Result<(Observed, Described), Failure> {
        let base = format!("/repositories/{repo_id}");
        // A repository that's gone is a definite answer, never "couldn't read" (`core::repository_gone`).
        let gone_back = || {
            let nothing = Described {
                full_name: String::new(),
                default_branch: String::new(),
            };
            Ok((gone(repo_id), nothing))
        };
        let (status, repo) = match self.get(repo_id, &base).await {
            Ok(answer) => answer,
            // GitHub refused a token narrowed to this repository with `422`, its answer for a repository the
            // installation doesn't reach. Whether it's there at all is asked once more, with a token for metadata alone.
            Err(Failure::Status(422)) => {
                return match self.presence(&base).await? {
                    true => gone_back(),
                    false => Err(Failure::Status(422)),
                };
            }
            Err(failure) => return Err(failure),
        };
        // The token for this repository was just minted, so a `404` for it by its ID is the repository gone.
        if repository_gone(true, status) {
            return gone_back();
        }
        if status != 200 {
            return Err(Failure::Status(status));
        }
        let described = Described {
            full_name: plain(&repo["full_name"], 140).ok_or(Failure::Unreadable)?,
            default_branch: plain(&repo["default_branch"], 100).ok_or(Failure::Unreadable)?,
        };
        let (private, archived) = repo["private"]
            .as_bool()
            .zip(repo["archived"].as_bool())
            .ok_or(Failure::Unreadable)?;
        let flag = |name: &str| repo[name].as_bool().ok_or(Failure::Unreadable);
        let settings = RepoSettings {
            has_issues: flag("has_issues")?,
            has_wiki: flag("has_wiki")?,
            has_projects: flag("has_projects")?,
            has_discussions: flag("has_discussions")?,
            // GitHub documents these as shown only to a token that can read and write contents, which this one can't.
            allow_auto_merge: repo["allow_auto_merge"].as_bool(),
            delete_branch_on_merge: repo["delete_branch_on_merge"].as_bool(),
        };
        // The default branch has a commit if the branch can be read and names one.
        let (status, branch) = self
            .get(
                repo_id,
                &format!("{base}/branches/{}", described.default_branch),
            )
            .await?;
        let default_branch_has_commit = match status {
            200 => branch["commit"]["sha"]
                .as_str()
                .is_some_and(podster_core::repositories::valid_commit_sha),
            404 => false,
            other => return Err(Failure::Status(other)),
        };
        let (status, actions) = self
            .get(repo_id, &format!("{base}/actions/permissions"))
            .await?;
        // Anything but a definite answer is a read that couldn't be made, never "Actions may be on": a server error
        // or a limit must not read as the repository having drifted.
        if status != 200 {
            return Err(Failure::Status(status));
        }
        let actions_enabled = Some(actions["enabled"].as_bool().ok_or(Failure::Unreadable)?);
        // The one settings read beyond the repository's own answer: what a workflow's token may do by default.
        let (status, workflow) = self
            .get(repo_id, &format!("{base}/actions/permissions/workflow"))
            .await?;
        if status != 200 {
            return Err(Failure::Status(status));
        }
        let workflow = WorkflowPermissions {
            default: workflow["default_workflow_permissions"]
                .as_str()
                .filter(|word| word.len() <= 16)
                .ok_or(Failure::Unreadable)?
                .to_string(),
            can_approve_pull_request_reviews: workflow["can_approve_pull_request_reviews"]
                .as_bool()
                .ok_or(Failure::Unreadable)?,
        };
        let (status, listed) = self
            .get(repo_id, &format!("{base}/rulesets?per_page=100"))
            .await?;
        if status != 200 {
            return Err(Failure::Status(status));
        }
        let listed = listed.as_array().ok_or(Failure::Unreadable)?;
        let mut rulesets = vec![];
        for entry in listed.iter().take(MAX_RULESETS_READ) {
            let ruleset_id = id(&entry["id"]).ok_or(Failure::Unreadable)?;
            let (status, detail) = self
                .get(repo_id, &format!("{base}/rulesets/{ruleset_id}"))
                .await?;
            if status != 200 {
                return Err(Failure::Status(status));
            }
            rulesets.push(ruleset(&detail));
        }
        Ok((
            Observed {
                present: true,
                repo_id: id(&repo["id"]).ok_or(Failure::Unreadable)?,
                owner_id: id(&repo["owner"]["id"]).ok_or(Failure::Unreadable)?,
                private,
                archived,
                default_branch_has_commit,
                actions_enabled,
                settings,
                workflow,
                rulesets,
            },
            described,
        ))
    }

    async fn apply(&self, repo_id: i64, step: SetupStep) -> std::result::Result<(), Failure> {
        let token = self.token_for(repo_id).await?;
        let base = format!("/repositories/{repo_id}");
        let (method, path, body, expected) = match step {
            SetupStep::DisableActions => (
                Method::Put,
                format!("{base}/actions/permissions"),
                json!({ "enabled": false }),
                204,
            ),
            SetupStep::RestrictWorkflowPermissions => (
                Method::Put,
                format!("{base}/actions/permissions/workflow"),
                json!({ "default_workflow_permissions": "read", "can_approve_pull_request_reviews": false }),
                204,
            ),
            SetupStep::CreateReviewRuleset => (
                Method::Post,
                format!("{base}/rulesets"),
                self.ruleset_body(true),
                201,
            ),
            SetupStep::CreateUpdateRuleset => (
                Method::Post,
                format!("{base}/rulesets"),
                self.ruleset_body(false),
                201,
            ),
        };
        let (status, _) = self.send(method, &path, &token, Some(body)).await?;
        if status == expected {
            Ok(())
        } else {
            Err(Failure::Status(status))
        }
    }

    async fn release(&self) -> u32 {
        let held = self.scoped.borrow_mut().take();
        if let Some((_, token)) = held {
            if !self.revoke(&token).await {
                self.unrevoked.set(self.unrevoked.get().saturating_add(1));
            }
        }
        self.unrevoked.get()
    }
}

/// The agent-token App's configuration (M5 step 6, ADR 0009's second App). It can push branches and open pull requests,
/// and nothing else: no administration, no workflows, no statuses. Its App ID and installation ID are variables and its
/// key is a secret, all set by the owner, and none of them comes from a request.
pub struct AgentConfig {
    app_id: i64,
    installation_id: i64,
    key_pem: String,
}

impl AgentConfig {
    /// `None` unless all three are set and well-formed, and the App is its own: not the provisioning App or the merge
    /// App, not provisioning's installation, and not signed with provisioning's key. The caller says only that tokens
    /// aren't configured.
    pub fn from_env(env: &Env) -> Option<AgentConfig> {
        AgentConfig::from_lookup(&|name: &str| lookup(env, name))
    }

    /// The same, from any source of the Worker's variables and secrets by name.
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> Option<AgentConfig> {
        let number = |name: &str| {
            get(name)
                .and_then(|v| v.parse::<i64>().ok())
                .filter(|n| *n > 0)
        };
        let key_pem = get("GITHUB_AGENT_APP_KEY")?;
        pkcs8_from_pem(&key_pem).is_some().then_some(())?;
        let config = AgentConfig {
            app_id: number("GITHUB_AGENT_APP_ID")?,
            installation_id: number("GITHUB_AGENT_INSTALLATION_ID")?,
            key_pem,
        };
        let distinct = roles_distinct(Role::Agent, get);
        if !distinct {
            console_error!("repo_token.app_not_distinct");
        }
        distinct.then_some(config)
    }
}

/// What GitHub says it minted. The token goes to the room to be sealed and to the agent, and nowhere else.
pub struct Minted {
    pub token: String,
    /// Milliseconds.
    pub expires_at: i64,
    /// The repositories the answer says the token reaches. Empty if it named none.
    pub repo_ids: Vec<i64>,
    /// The permissions the answer says the token carries, as GitHub names them.
    pub permissions: Vec<(String, String)>,
}

/// How a revocation went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Revoked {
    /// GitHub took it back: `204`, the only answer its documentation gives for this call.
    Gone,
    /// Anything else. The token may still be live, so the room tries again.
    Failed,
}

/// The provider, as an agent's repository token needs it: mint one for one repository, and take one back.
pub(crate) trait TokenIssuer {
    /// Asks for a token on this one repository with these permissions only. A token that came back but can't be read
    /// whole is revoked here before the failure is returned, so it never stays live unheld.
    async fn mint_agent_token(
        &self,
        repo_id: i64,
        permissions: &[(&str, &str)],
    ) -> std::result::Result<Minted, Failure>;
    async fn revoke_token(&self, token: &str) -> Revoked;
}

pub struct AgentTokens {
    config: AgentConfig,
}

impl AgentTokens {
    pub fn new(config: AgentConfig) -> AgentTokens {
        AgentTokens { config }
    }
}

/// The repositories and permissions a token answer names. Empty for either it didn't name.
fn granted(answer: &Value) -> (Vec<i64>, Vec<(String, String)>) {
    let repo_ids = answer["repositories"]
        .as_array()
        .map(|repos| {
            repos
                .iter()
                .map(|r| r["id"].as_i64().unwrap_or(0))
                .collect()
        })
        .unwrap_or_default();
    let permissions = answer["permissions"]
        .as_object()
        .map(|granted| {
            granted
                .iter()
                .map(|(name, level)| (name.clone(), level.as_str().unwrap_or("").to_string()))
                .collect()
        })
        .unwrap_or_default();
    (repo_ids, permissions)
}

/// GitHub's ISO 8601 time, in milliseconds. `None` unless it's a time the runtime reads.
fn parse_time(value: &Value) -> Option<i64> {
    let millis = js_sys::Date::parse(value.as_str()?);
    millis.is_finite().then_some(millis as i64)
}

impl TokenIssuer for AgentTokens {
    async fn mint_agent_token(
        &self,
        repo_id: i64,
        permissions: &[(&str, &str)],
    ) -> std::result::Result<Minted, Failure> {
        let jwt = app_jwt(self.config.app_id, &self.config.key_pem).await?;
        let path = format!(
            "/app/installations/{}/access_tokens",
            self.config.installation_id
        );
        let wanted: serde_json::Map<String, Value> = permissions
            .iter()
            .map(|(name, level)| ((*name).to_string(), Value::from(*level)))
            .collect();
        let body = json!({ "repository_ids": [repo_id], "permissions": wanted });
        let (status, answer) = call(Method::Post, &path, &jwt, Some(body)).await?;
        if status != 201 {
            return Err(Failure::Status(status));
        }
        let Some(token) = answer["token"]
            .as_str()
            .filter(|token| !token.is_empty() && token.len() <= 512 && token.is_ascii())
            .map(str::to_string)
        else {
            return Err(Failure::Unreadable);
        };
        let Some(expires_at) = parse_time(&answer["expires_at"]) else {
            self.revoke_token(&token).await;
            return Err(Failure::Unreadable);
        };
        let (repo_ids, permissions) = granted(&answer);
        Ok(Minted {
            token,
            expires_at,
            repo_ids,
            permissions,
        })
    }

    async fn revoke_token(&self, token: &str) -> Revoked {
        // Only `204` counts (the M5 security review's F6). GitHub's documentation for "Revoke an installation access
        // token" gives no other answer, none for a token that's already invalid, so a `401` is no proof: it may be GitHub
        // refusing for another reason while the token still works. The row is kept and tried again, and a token past
        // its expiry is dropped by the room's upkeep without asking.
        match call(Method::Delete, "/installation/token", token, None).await {
            Ok((204, _)) => Revoked::Gone,
            _ => Revoked::Failed,
        }
    }
}

/// What a read of one pull request came to.
pub enum PullAnswer {
    Found(PullSeen),
    /// The repository has no pull request of that number.
    Missing,
}

/// A read, and whether the token made for it is gone. `revoked` is false only when a token was minted and GitHub
/// didn't confirm taking it back, so it lives out its hour: read-only, on the one repository.
pub struct PullRead {
    pub answer: std::result::Result<PullAnswer, Failure>,
    /// Whether a failure came from asking for the token, before any pull request was asked about.
    pub failed_at_mint: bool,
    pub revoked: bool,
}

/// The provider, as the room's own read of a task's pull request needs it (M5 step 7a).
pub(crate) trait PullReader {
    /// Reads one pull request of one repository, by the repository's ID and the pull request's number, with a token
    /// minted for this read alone and revoked when it ends.
    async fn read_pull(&self, repo_id: i64, number: i64) -> PullRead;
}

/// A pull request as GitHub describes it, keeping IDs, commit IDs, the base branch, the state and the draft flag. Its title, body,
/// head branch name, labels and author are never read out of the answer.
fn pull_seen(answer: &Value) -> Option<PullSeen> {
    let sha = |value: &Value| {
        value
            .as_str()
            .filter(|sha| valid_commit_sha(sha))
            .map(str::to_string)
    };
    let state = match (answer["state"].as_str()?, answer["merged"].as_bool()) {
        ("open", _) => PullState::Open,
        ("closed", Some(true)) => PullState::Merged,
        ("closed", Some(false)) => PullState::Closed,
        _ => return None,
    };
    let merged = state == PullState::Merged;
    Some(PullSeen {
        number: id(&answer["number"])?,
        repo_id: id(&answer["base"]["repo"]["id"]),
        head_repo_id: id(&answer["head"]["repo"]["id"]),
        head_sha: sha(&answer["head"]["sha"])?,
        // A name too long to be a branch of ours isn't the default branch. That's a pull request on the wrong base,
        // not one that can't be read.
        base_ref: Some(answer["base"]["ref"].as_str()?)
            .filter(|name| !name.is_empty() && name.len() <= MAX_BRANCH_NAME_BYTES)
            .map(str::to_string),
        base_sha: sha(&answer["base"]["sha"])?,
        state,
        draft: answer["draft"].as_bool()?,
        repo_default_branch: plain(
            &answer["base"]["repo"]["default_branch"],
            MAX_BRANCH_NAME_BYTES,
        ),
        merge_sha: merged.then(|| sha(&answer["merge_commit_sha"])).flatten(),
        merged_by_id: merged.then(|| id(&answer["merged_by"]["id"])).flatten(),
    })
}

impl PullReader for AgentTokens {
    /// **Which App reads (ruled by the architect, 2026-11-10):** the agent-token App, with a token for this one
    /// repository that can read its pull requests and metadata, and nothing else: not its contents. Never the provisioning App, which holds Administration, and never the merge App,
    /// which is kept for marking and merging. A token that came back wider than asked is revoked unused.
    async fn read_pull(&self, repo_id: i64, number: i64) -> PullRead {
        let wanted = TokenPermissions::READER.pairs();
        let minted = match self.mint_agent_token(repo_id, &wanted).await {
            Ok(minted) => minted,
            Err(failure) => {
                return PullRead {
                    answer: Err(failure),
                    failed_at_mint: true,
                    revoked: true,
                }
            }
        };
        let granted: Vec<(&str, &str)> = minted
            .permissions
            .iter()
            .map(|(name, level)| (name.as_str(), level.as_str()))
            .collect();
        let narrow = minted_token_matches(
            repo_id,
            &minted.repo_ids,
            &granted,
            TokenPermissions::READER,
        );
        let answer = if narrow {
            let path = format!("/repositories/{repo_id}/pulls/{number}");
            match call_within(
                Method::Get,
                &path,
                &minted.token,
                None,
                MAX_PULL_ANSWER_BYTES,
            )
            .await
            {
                Ok((200, body)) => pull_seen(&body)
                    .map(PullAnswer::Found)
                    .ok_or(Failure::Unreadable),
                Ok((404, _)) => Ok(PullAnswer::Missing),
                Ok((status, _)) => Err(Failure::Status(status)),
                Err(failure) => Err(failure),
            }
        } else {
            Err(Failure::Unreadable)
        };
        let revoked = self.revoke_token(&minted.token).await == Revoked::Gone;
        PullRead {
            answer,
            failed_at_mint: false,
            revoked,
        }
    }
}

/// A commit's statuses and check runs, as states only: a status's `state`, or a check run's `status` with its
/// `conclusion`. A context, a name, a description or a URL is never read out of the answers.
pub type ChecksSeen = Vec<(String, Option<String>)>;

/// The provider, as the room's read of a head commit's checks needs it (M5 step 8).
pub(crate) trait ChecksReader {
    /// Reads one commit's combined status and its check runs, with a token minted for this read alone, for the one
    /// repository, that can read statuses and checks and nothing else, revoked when the read ends.
    async fn read_checks(
        &self,
        repo_id: i64,
        sha: &str,
    ) -> MergeStepRead<std::result::Result<ChecksSeen, Failure>>;
}

/// At most this many statuses and check runs are counted for one commit. More than a managed repository would have.
const MAX_CHECKS_READ: usize = 100;

impl ChecksReader for AgentTokens {
    async fn read_checks(
        &self,
        repo_id: i64,
        sha: &str,
    ) -> MergeStepRead<std::result::Result<ChecksSeen, Failure>> {
        let wanted = TokenPermissions::CHECKS_READER;
        let minted = match self.mint_agent_token(repo_id, &wanted.pairs()).await {
            Ok(minted) => minted,
            Err(failure) => {
                return MergeStepRead {
                    answer: Err(failure),
                    failed_at_mint: true,
                    revoked: true,
                }
            }
        };
        let granted: Vec<(&str, &str)> = minted
            .permissions
            .iter()
            .map(|(name, level)| (name.as_str(), level.as_str()))
            .collect();
        let narrow = minted_token_matches(repo_id, &minted.repo_ids, &granted, wanted);
        let answer = if narrow && valid_commit_sha(sha) {
            Self::checks_of(&minted.token, repo_id, sha).await
        } else {
            Err(Failure::Unreadable)
        };
        let revoked = self.revoke_token(&minted.token).await == Revoked::Gone;
        MergeStepRead {
            answer,
            failed_at_mint: false,
            revoked,
        }
    }
}

impl AgentTokens {
    async fn checks_of(
        token: &str,
        repo_id: i64,
        sha: &str,
    ) -> std::result::Result<ChecksSeen, Failure> {
        let word = |value: &Value| {
            value
                .as_str()
                .filter(|word| !word.is_empty() && word.len() <= 32)
                .map(str::to_string)
        };
        let base = format!("/repositories/{repo_id}/commits/{sha}");
        let mut seen = vec![];
        let (status, combined) = call_within(
            Method::Get,
            &format!("{base}/status?per_page=100"),
            token,
            None,
            MAX_PULL_ANSWER_BYTES,
        )
        .await?;
        if status != 200 {
            return Err(Failure::Status(status));
        }
        for one in combined["statuses"]
            .as_array()
            .ok_or(Failure::Unreadable)?
            .iter()
            .take(MAX_CHECKS_READ)
        {
            seen.push((word(&one["state"]).ok_or(Failure::Unreadable)?, None));
        }
        let (status, runs) = call_within(
            Method::Get,
            &format!("{base}/check-runs?per_page=100"),
            token,
            None,
            MAX_PULL_ANSWER_BYTES,
        )
        .await?;
        if status != 200 {
            return Err(Failure::Status(status));
        }
        for one in runs["check_runs"]
            .as_array()
            .ok_or(Failure::Unreadable)?
            .iter()
            .take(MAX_CHECKS_READ)
        {
            seen.push((
                word(&one["status"]).ok_or(Failure::Unreadable)?,
                word(&one["conclusion"]),
            ));
        }
        Ok(seen)
    }
}

/// The merge App's configuration (M5 step 7b, ADR 0009's third App). It marks a reviewed commit and merges it, and is
/// the one actor the repository's rules let update the default branch. Its App ID and installation ID are variables and
/// its key is a secret, all set by the owner, and none of them comes from a request.
pub struct MergeConfig(AgentConfig);

impl MergeConfig {
    /// `None` unless all three are set and well-formed, and the App is its own: not the provisioning App or the
    /// agent-token App, not either's installation, and not signed with either's key. The caller says only that merging
    /// isn't configured.
    pub fn from_env(env: &Env) -> Option<MergeConfig> {
        MergeConfig::from_lookup(&|name: &str| lookup(env, name))
    }

    /// The same, from any source of the Worker's variables and secrets by name.
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> Option<MergeConfig> {
        let number = |name: &str| {
            get(name)
                .and_then(|v| v.parse::<i64>().ok())
                .filter(|n| *n > 0)
        };
        let key_pem = get("GITHUB_MERGE_APP_KEY")?;
        pkcs8_from_pem(&key_pem).is_some().then_some(())?;
        let config = AgentConfig {
            app_id: number("GITHUB_MERGE_APP_ID")?,
            installation_id: number("GITHUB_MERGE_INSTALLATION_ID")?,
            key_pem,
        };
        let distinct = roles_distinct(Role::Merge, get);
        if !distinct {
            console_error!("merge.app_not_distinct");
        }
        distinct.then_some(MergeConfig(config))
    }
}

/// What a read of a task's pull request and of the default branch showed.
pub struct MergeSeen {
    pub pull: PullAnswer,
    /// Whether the default branch contains the commit asked about. `None` if that couldn't be told.
    pub default_branch_has: Option<bool>,
    /// The repository's default branch as GitHub reports it now. `None` if that couldn't be read.
    pub default_branch: Option<String>,
}

/// One call by the merge App, and whether the token made for it is gone.
pub struct MergeStepRead<T> {
    pub answer: T,
    /// Whether a failure came from asking for the token, so nothing was sent about the repository.
    pub failed_at_mint: bool,
    pub revoked: bool,
}

/// The provider, as the merge job needs it (M5 step 7b). Each call mints its own token for the one repository, checks
/// it's exactly as narrow as asked, and revokes it on every way out.
pub(crate) trait Merger {
    /// Sets the review status on exactly this commit, with a token that can set statuses and nothing else.
    async fn mark(
        &self,
        repo_id: i64,
        sha: &str,
    ) -> MergeStepRead<std::result::Result<(), Failure>>;
    /// Asks GitHub to merge the pull request as a merge commit, only if its head is still `sha`, then reads the pull
    /// request and the default branch with the same token. The call's status is `None` when no answer came. What it
    /// says is never taken as the outcome: the reads are.
    async fn merge(
        &self,
        repo_id: i64,
        number: i64,
        sha: &str,
        default_branch: &str,
    ) -> MergeStepRead<(Option<u16>, std::result::Result<MergeSeen, Failure>)>;
    /// Reads the pull request and whether the default branch contains `sha`, with a token that can only read.
    async fn observe(
        &self,
        repo_id: i64,
        number: i64,
        sha: &str,
        default_branch: &str,
    ) -> MergeStepRead<std::result::Result<MergeSeen, Failure>>;
}

pub struct MergeApp {
    tokens: AgentTokens,
}

impl MergeApp {
    pub fn new(config: MergeConfig) -> MergeApp {
        MergeApp {
            tokens: AgentTokens::new(config.0),
        }
    }

    /// A token for the one repository with exactly these permissions, or the failure. One that came back wider or
    /// for another repository is revoked here and never used.
    async fn narrow(
        &self,
        repo_id: i64,
        wanted: TokenPermissions,
    ) -> std::result::Result<String, (Failure, bool)> {
        let minted = self
            .tokens
            .mint_agent_token(repo_id, &wanted.pairs())
            .await
            .map_err(|failure| (failure, true))?;
        let granted: Vec<(&str, &str)> = minted
            .permissions
            .iter()
            .map(|(name, level)| (name.as_str(), level.as_str()))
            .collect();
        if minted_token_matches(repo_id, &minted.repo_ids, &granted, wanted) {
            return Ok(minted.token);
        }
        let revoked = self.tokens.revoke_token(&minted.token).await == Revoked::Gone;
        Err((Failure::Unreadable, revoked))
    }

    /// The pull request, and whether the default branch contains `sha`, read with `token`.
    async fn read_state(
        token: &str,
        repo_id: i64,
        number: i64,
        sha: &str,
        default_branch: &str,
    ) -> std::result::Result<MergeSeen, Failure> {
        let path = format!("/repositories/{repo_id}/pulls/{number}");
        let pull = match call_within(Method::Get, &path, token, None, MAX_PULL_ANSWER_BYTES).await?
        {
            (200, body) => PullAnswer::Found(pull_seen(&body).ok_or(Failure::Unreadable)?),
            (404, _) => PullAnswer::Missing,
            (status, _) => return Err(Failure::Status(status)),
        };
        let reported = Self::default_branch(token, repo_id).await;
        // `behind` or `identical` is the default branch holding everything the commit has. Only a branch name that's
        // plain enough to put in a path is asked about, slashes included, and a commit ID is hex.
        let plain_branch = plain(&Value::from(default_branch), 255);
        let default_branch_has = match plain_branch.filter(|_| valid_commit_sha(sha)) {
            Some(branch) => {
                let path = format!("/repositories/{repo_id}/compare/{branch}...{sha}");
                match call(Method::Get, &path, token, None).await? {
                    (200, body) => match body["status"].as_str() {
                        Some("behind" | "identical") => Some(true),
                        Some("ahead" | "diverged") => Some(false),
                        _ => None,
                    },
                    _ => None,
                }
            }
            None => None,
        };
        Ok(MergeSeen {
            pull,
            default_branch_has,
            default_branch: reported,
        })
    }

    /// The repository's default branch as GitHub reports it now, or `None` if it couldn't be read.
    async fn default_branch(token: &str, repo_id: i64) -> Option<String> {
        match call(
            Method::Get,
            &format!("/repositories/{repo_id}"),
            token,
            None,
        )
        .await
        {
            Ok((200, repo)) => plain(&repo["default_branch"], 255),
            _ => None,
        }
    }
}

impl Merger for MergeApp {
    async fn mark(
        &self,
        repo_id: i64,
        sha: &str,
    ) -> MergeStepRead<std::result::Result<(), Failure>> {
        let token = match self.narrow(repo_id, TokenPermissions::MARKER).await {
            Ok(token) => token,
            Err((failure, revoked)) => {
                return MergeStepRead {
                    answer: Err(failure),
                    failed_at_mint: true,
                    revoked,
                }
            }
        };
        let answer = if valid_commit_sha(sha) {
            let path = format!("/repositories/{repo_id}/statuses/{sha}");
            let body = json!({ "state": "success", "context": STATUS_CONTEXT });
            match call(Method::Post, &path, &token, Some(body)).await {
                Ok((201, _)) => Ok(()),
                Ok((status, _)) => Err(Failure::Status(status)),
                Err(failure) => Err(failure),
            }
        } else {
            Err(Failure::Unreadable)
        };
        let revoked = self.tokens.revoke_token(&token).await == Revoked::Gone;
        MergeStepRead {
            answer,
            failed_at_mint: false,
            revoked,
        }
    }

    async fn merge(
        &self,
        repo_id: i64,
        number: i64,
        sha: &str,
        default_branch: &str,
    ) -> MergeStepRead<(Option<u16>, std::result::Result<MergeSeen, Failure>)> {
        let token = match self.narrow(repo_id, TokenPermissions::MERGER).await {
            Ok(token) => token,
            Err((failure, revoked)) => {
                return MergeStepRead {
                    answer: (None, Err(failure)),
                    failed_at_mint: true,
                    revoked,
                }
            }
        };
        // Immediately before the call: the default branch GitHub reports must be the one the room's link holds. The
        // rules protect whichever branch is the default now, so if it isn't, or can't be read, no merge is asked for.
        let default_now = Self::default_branch(&token, repo_id).await;
        let status = if default_now.as_deref() == Some(default_branch) {
            let path = format!("/repositories/{repo_id}/pulls/{number}/merge");
            let body = json!({ "sha": sha, "merge_method": "merge" });
            // A rate limit is still an answer with a status, as it was before limits were told apart: the merge job
            // reads what GitHub did either way.
            match call(Method::Put, &path, &token, Some(body)).await {
                Ok((status, _)) | Err(Failure::RateLimited { status, .. }) => Some(status),
                Err(_) => None,
            }
        } else {
            None
        };
        let seen = Self::read_state(&token, repo_id, number, sha, default_branch).await;
        let revoked = self.tokens.revoke_token(&token).await == Revoked::Gone;
        MergeStepRead {
            answer: (status, seen),
            failed_at_mint: false,
            revoked,
        }
    }

    async fn observe(
        &self,
        repo_id: i64,
        number: i64,
        sha: &str,
        default_branch: &str,
    ) -> MergeStepRead<std::result::Result<MergeSeen, Failure>> {
        let token = match self.narrow(repo_id, TokenPermissions::OBSERVER).await {
            Ok(token) => token,
            Err((failure, revoked)) => {
                return MergeStepRead {
                    answer: Err(failure),
                    failed_at_mint: true,
                    revoked,
                }
            }
        };
        let answer = Self::read_state(&token, repo_id, number, sha, default_branch).await;
        let revoked = self.tokens.revoke_token(&token).await == Revoked::Gone;
        MergeStepRead {
            answer,
            failed_at_mint: false,
            revoked,
        }
    }
}
