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
use js_sys::{Array, Function, Object, Promise, Reflect, Uint8Array};
use podster_core::provisioning::{
    classify_creation, Bypass, Creation, Observed, Ruleset, SetupStep, DEFAULT_BRANCH_REF,
    STATUS_CONTEXT,
};
use podster_egress::app_key::{app_jwt_signing_input, base64url, pkcs8_from_pem};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::time::Duration;
use wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::*;

const API: &str = "https://api.github.com";
const USER_AGENT: &str = "podster-provisioning";
const CALL_TIMEOUT_MS: u64 = if cfg!(feature = "failpoints") {
    400
} else {
    10_000
};
/// No answer this job reads is anywhere near this long.
const MAX_ANSWER_BYTES: usize = 256 * 1024;
/// A repository Podster made has two rulesets. Reading a few more is enough to see that something else is there.
const MAX_RULESETS_READ: usize = 5;
pub const REVIEW_RULESET_NAME: &str = "podster-review";
pub const UPDATE_RULESET_NAME: &str = "podster-update";

/// Where provisioning happens and as whom. All of it is the Worker's configuration, set by the owner.
pub struct Config {
    org_login: String,
    pub org_id: i64,
    app_id: i64,
    installation_id: i64,
    pub merge_app_id: i64,
    key_pem: String,
}

impl Config {
    /// `None` unless every variable and the key are set and well-formed. The caller says only that provisioning isn't
    /// configured, never which part.
    pub fn from_env(env: &Env) -> Option<Config> {
        let number = |name: &str| {
            env.var(name)
                .ok()
                .and_then(|v| v.to_string().parse::<i64>().ok())
                .filter(|n| *n > 0)
        };
        let org_login = env.var("GITHUB_ORG_LOGIN").ok()?.to_string();
        let plain = !org_login.is_empty()
            && org_login.len() <= 39
            && org_login
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-');
        let key_pem = env.secret("GITHUB_PROVISION_APP_KEY").ok()?.to_string();
        (plain && pkcs8_from_pem(&key_pem).is_some()).then_some(())?;
        Some(Config {
            org_login,
            org_id: number("GITHUB_ORG_ID")?,
            app_id: number("GITHUB_PROVISION_APP_ID")?,
            installation_id: number("GITHUB_PROVISION_INSTALLATION_ID")?,
            merge_app_id: number("GITHUB_MERGE_APP_ID")?,
            key_pem,
        })
    }
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
}

impl Failure {
    /// The provider's HTTP status, for the log. Zero when there was none.
    pub fn status(self) -> u16 {
        match self {
            Failure::Status(status) => status,
            Failure::Unreachable | Failure::Unreadable => 0,
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
        let bytes = response.bytes().await?;
        let parsed = if bytes.is_empty() || bytes.len() > MAX_ANSWER_BYTES {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        Ok::<_, Error>((status, parsed))
    };
    let timeout = Delay::from(Duration::from_millis(CALL_TIMEOUT_MS));
    let answer = match select(Box::pin(attempt), timeout).await {
        Either::Left((Ok(answer), _)) => Ok(answer),
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
    /// installation, which only the creation call needs.
    async fn mint(&self, repo_id: Option<i64>) -> std::result::Result<String, Failure> {
        let jwt = app_jwt(self.config.app_id, &self.config.key_pem).await?;
        let path = format!(
            "/app/installations/{}/access_tokens",
            self.config.installation_id
        );
        let narrowed = repo_id.map(|id| json!({ "repository_ids": [id] }));
        let (status, body) = self.send(Method::Post, &path, &jwt, narrowed).await?;
        if status != 201 {
            return Err(Failure::Status(status));
        }
        Ok(body["token"]
            .as_str()
            .filter(|token| !token.is_empty() && token.len() <= 512 && token.is_ascii())
            .ok_or(Failure::Unreadable)?
            .to_string())
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
            Err(failure) => return CreateAnswer::NotSent(failure.status()),
        };
        let path = format!("/orgs/{}/repos", self.config.org_login);
        let body = json!({ "name": name, "private": !public, "auto_init": true });
        let sent = self.send(Method::Post, &path, &token, Some(body)).await;
        // The broad token has done the one thing it was for, however that went. If it can't be revoked it lives out its
        // hour with authority over every repository, so that is counted and reported, never dropped.
        if !self.revoke(&token).await {
            self.unrevoked.set(self.unrevoked.get().saturating_add(1));
        }
        let (status, answer) = match sent {
            Ok(answer) => answer,
            Err(_) => return CreateAnswer::Unknown,
        };
        let name_error = answer["errors"]
            .as_array()
            .is_some_and(|errors| errors.iter().any(|e| e["field"].as_str() == Some("name")));
        let created = id(&answer["id"]).zip(id(&answer["owner"]["id"]));
        match classify_creation(Some(status), name_error, created.is_some()) {
            Creation::Created => match created {
                Some((repo_id, owner_id)) => CreateAnswer::Created(Created { repo_id, owner_id }),
                None => CreateAnswer::Unknown,
            },
            Creation::NameTaken => CreateAnswer::NameTaken,
            Creation::Refused => CreateAnswer::Refused(status),
            Creation::Unknown => CreateAnswer::Unknown,
        }
    }

    async fn read_back(&self, repo_id: i64) -> std::result::Result<(Observed, Described), Failure> {
        let base = format!("/repositories/{repo_id}");
        let (status, repo) = self.get(repo_id, &base).await?;
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
        let actions_enabled = (status == 200)
            .then(|| actions["enabled"].as_bool())
            .flatten();
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
                repo_id: id(&repo["id"]).ok_or(Failure::Unreadable)?,
                owner_id: id(&repo["owner"]["id"]).ok_or(Failure::Unreadable)?,
                private,
                archived,
                default_branch_has_commit,
                actions_enabled,
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
    /// `None` unless all three are set and well-formed. The caller says only that tokens aren't configured.
    pub fn from_env(env: &Env) -> Option<AgentConfig> {
        let number = |name: &str| {
            env.var(name)
                .ok()
                .and_then(|v| v.to_string().parse::<i64>().ok())
                .filter(|n| *n > 0)
        };
        let key_pem = env.secret("GITHUB_AGENT_APP_KEY").ok()?.to_string();
        pkcs8_from_pem(&key_pem).is_some().then_some(())?;
        Some(AgentConfig {
            app_id: number("GITHUB_AGENT_APP_ID")?,
            installation_id: number("GITHUB_AGENT_INSTALLATION_ID")?,
            key_pem,
        })
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
    /// GitHub took it back, or no longer accepts it: `204`, or `401` for a token already revoked or expired.
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
        Ok(Minted {
            token,
            expires_at,
            repo_ids,
            permissions,
        })
    }

    async fn revoke_token(&self, token: &str) -> Revoked {
        match call(Method::Delete, "/installation/token", token, None).await {
            Ok((204 | 401, _)) => Revoked::Gone,
            _ => Revoked::Failed,
        }
    }
}
