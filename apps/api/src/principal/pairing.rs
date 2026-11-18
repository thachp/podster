//! Runner pairing sessions (M7 step 5(a); decision 222; RUNNER.md "Proposed one-agent pairing proof of concept"; M7
//! security review S-07). Each session lives on the Principal of the new agent it would make, so its one effective
//! outcome, the agent's connection, is written in the same transaction that closes it.
//!
//! - **Start:** a person who administers the organization starts a session for a new agent. The gateway (step 5(b))
//!   passes the Agent Auth plugin's one-time enrollment token as the code; this keeps only its SHA-256, never the code.
//!   A person starts at most `podster_core::pairing::MAX_STARTS` an hour, counted on their own Principal before the
//!   session is made; a count that can't be read refuses the start.
//! - **Redeem:** Runner's code, with the thumbprint of a key whose proof of possession the gateway checked, under the
//!   gateway's `pairing_redeem` assertion and nothing else, which names this session's agent. The proof's ID is checked
//!   on every redemption of a session and spent there; a session that doesn't exist writes nothing, so nothing is kept for
//!   it. Every refusal, a replay and a proof for another session included, answers the same `not_allowed`, wrong codes are
//!   counted, and the fifth locks the session for good.
//! - **Activate:** the starter confirms the thumbprint they were shown, while they still administer the organization in a
//!   membership older than the session. Only then does the agent's connection exist.
//!
//! - **Link** (M7 step 5(c)): the same confirmation names the one plugin agent the binding rule allows on the session's own
//!   plugin host (`podster_core::pairing::link_target`), from facts the gateway read, and the session records it in the
//!   transaction that activates it. The gateway then writes the directory's `podster_agent` and `identity_link`, as the
//!   claim does after `registerAgent`. No agent of a session that isn't activated is ever linked.
//! - **Sweep** (M7 step 5(c)): each start is also listed on the starter's own Principal (`pairing_due`) until the gateway
//!   says it has ended the session's plugin host. The gateway's cron asks, as the starter, for the sessions past their
//!   expiry, ends the host of each that wasn't activated, and settles them, so a redeemed session nobody touches still
//!   loses its host.
//!
//! Every step leaves an audit row with IDs and reason codes only. Nothing here logs, and no code is stored or answered.
use super::*;
use podster_core::pairing::{self as decide, Decision, Outcome, Refusal, Session, Status};
use podster_policy::pairing::{self as policy, Person};
use podster_policy::PrincipalKind;
use sha2::{Digest, Sha256};

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS pairing_session (id INTEGER PRIMARY KEY CHECK (id = 1), agent_id TEXT NOT NULL, org_id TEXT NOT NULL,
  person_id TEXT NOT NULL, name TEXT NOT NULL, plugin_host_id TEXT NOT NULL, code_verifier TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL, key_thumbprint TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pairing_event (seq INTEGER PRIMARY KEY, type TEXT NOT NULL, actor_id TEXT NOT NULL, reason TEXT,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pairing_proof (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pairing_link (id INTEGER PRIMARY KEY CHECK (id = 1), plugin_agent_id TEXT NOT NULL, linked_at INTEGER NOT NULL);
";
/// On a person's Principal: the sessions they started, for the hourly limit.
const STARTS_SCHEMA: &str =
    "CREATE TABLE IF NOT EXISTS pairing_start (agent_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL);";
/// On a person's Principal too: each session they started, with its plugin host, until the gateway's sweep settles it.
const DUE_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS pairing_due (agent_id TEXT PRIMARY KEY, plugin_host_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL);";
/// How long a session stays on its starter's list unsettled before a later start drops it.
const DUE_KEPT_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Sessions one sweep answers, and settles, at most.
pub const SWEEP_BATCH: usize = 50;

/// Audit rows kept per session, so a flood of refusals can't grow the object without end.
const EVENTS_KEPT: i64 = 200;
const MAX_NAME_BYTES: usize = 200;
const DEFAULT_NAME: &str = "agent";

pub(super) const START: &str = "/internal/pairing-start";
pub(super) const COUNT_START: &str = "/internal/pairing-count-start";
pub(super) const READ: &str = "/internal/pairing-read";
pub(super) const CANCEL: &str = "/internal/pairing-cancel";
pub(super) const ACTIVATE: &str = "/internal/pairing-activate";
pub(super) const REDEEM: &str = "/internal/pairing-redeem";
pub(super) const DUE: &str = "/internal/pairing-due";
pub(super) const SETTLED: &str = "/internal/pairing-settled";

/// Whether a path is one of this module's, on any Principal.
pub(super) fn handles(path: &str) -> bool {
    [
        START,
        COUNT_START,
        READ,
        CANCEL,
        ACTIVATE,
        REDEEM,
        DUE,
        SETTLED,
    ]
    .contains(&path)
}

fn verifier(code: &str) -> String {
    Sha256::digest(code.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn is_agent_id(value: &str) -> bool {
    crate::valid_id(value) && value.starts_with(crate::AGENT_ID_PREFIX)
}

fn person_of<'a>(caller: &'a Caller, org: &str) -> Person<'a> {
    Person {
        kind: if caller.kind == "person" {
            PrincipalKind::Person
        } else {
            PrincipalKind::Agent
        },
        id: &caller.id,
        administers: caller.admin_orgs.iter().any(|o| o == org),
        member_since: caller.org_since.get(org).copied(),
    }
}

async fn call(
    env: &Env,
    name: &str,
    path: &str,
    body: &Value,
    caller: Option<&Caller>,
) -> R<Response> {
    let stub = env
        .durable_object("PRINCIPAL")?
        .id_from_name(name)?
        .get_stub()?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some(body.to_string().into()));
    if let Some(caller) = caller {
        init.with_headers(crate::caller_header(caller)?);
    }
    Ok(stub
        .fetch_with_request(Request::new_with_init(
            &format!("https://principal{path}"),
            &init,
        )?)
        .await?)
}

/// `POST /v1/pairing`: a person starts a session for a new agent.
pub async fn start(env: &Env, caller: &Caller, body: Option<&str>) -> R<Response> {
    let body: Value =
        serde_json::from_str(body.unwrap_or("")).map_err(|_| ApiError::invalid_argument())?;
    let field = |name: &str| body[name].as_str().filter(|v| crate::valid_id(v));
    let (Some(org), Some(host)) = (field("org_id"), field("plugin_host_id")) else {
        return Err(ApiError::invalid_argument());
    };
    let Some(code) = body["code"].as_str().filter(|c| decide::valid_code(c)) else {
        return Err(ApiError::invalid_argument());
    };
    let name = match body.get("name") {
        None | Some(Value::Null) => DEFAULT_NAME.to_string(),
        Some(Value::String(name)) if !name.trim().is_empty() && name.len() <= MAX_NAME_BYTES => {
            name.trim().to_string()
        }
        Some(_) => return Err(ApiError::invalid_argument()),
    };
    if !policy::may_start(&person_of(caller, org)) {
        return Err(ApiError::not_allowed());
    }
    let agent = format!(
        "{}{}",
        crate::AGENT_ID_PREFIX,
        uuid::Uuid::new_v4().simple()
    );
    let now = now_ms();
    // Counted first, on the person's own Principal, so a refused or failed count makes no session. The same write lists
    // it for the sweep, so no session can exist that the sweep doesn't know of.
    let mut counted = call(
        env,
        &caller.id,
        COUNT_START,
        &json!({ "agent_id": agent, "now": now, "plugin_host_id": host, "expires_at": decide::expires_at(now) }),
        None,
    )
    .await?;
    if counted.status_code() != 200 {
        return Err(ApiError::internal("pairing start count unavailable"));
    }
    let counted: Value = counted.json().await?;
    match counted["allowed"].as_bool() {
        Some(true) => {}
        Some(false) => return Err(ApiError::limit_exceeded()),
        None => return Err(ApiError::internal("pairing start count unavailable")),
    }
    let session = json!({
        "agent_id": agent, "org_id": org, "person_id": caller.id, "name": name, "plugin_host_id": host,
        "code_verifier": verifier(code), "now": now,
    });
    relay(call(env, &agent, START, &session, Some(caller)).await?).await
}

/// `GET /v1/pairing/{agent}`, and `POST` to its `cancel` and `activate`: the starter's own, through the agent's Principal.
pub async fn person_route(
    env: &Env,
    caller: &Caller,
    rest: &[&str],
    method: &Method,
    body: Option<&str>,
) -> R<Response> {
    let (agent, path, body) = match (rest, method) {
        (["sweep"], Method::Post) => return sweep(env, caller).await,
        (["sweep", "settled"], Method::Post) => return settle(env, caller, body).await,
        ([agent], Method::Get) => (*agent, READ, json!({})),
        ([agent, "cancel"], Method::Post) => (*agent, CANCEL, json!({})),
        ([agent, "activate"], Method::Post) => {
            let body: Value = serde_json::from_str(body.unwrap_or(""))
                .map_err(|_| ApiError::invalid_argument())?;
            let thumbprint = body["key_thumbprint"]
                .as_str()
                .filter(|t| decide::valid_thumbprint(t))
                .ok_or_else(ApiError::invalid_argument)?;
            let plugin = plugin_facts(&body["plugin"]).ok_or_else(ApiError::invalid_argument)?;
            (
                *agent,
                ACTIVATE,
                json!({ "key_thumbprint": thumbprint, "plugin": facts_json(&plugin) }),
            )
        }
        _ => return Err(ApiError::not_found()),
    };
    if !is_agent_id(agent) {
        return Err(ApiError::not_found());
    }
    relay(call(env, agent, path, &body, Some(caller)).await?).await
}

/// What the gateway read of the plugin for a confirmation, in shape, or None. Shape only: `link_target` decides.
fn plugin_facts(value: &Value) -> Option<decide::PluginFacts> {
    let agents = value["agents"].as_array()?;
    if agents.len() > decide::MAX_HOST_AGENTS + 1 {
        return None;
    }
    let agents = agents
        .iter()
        .map(|a| {
            Some(decide::PluginAgent {
                id: a["id"].as_str().filter(|s| crate::valid_id(s))?.to_string(),
                active: a["active"].as_bool()?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(decide::PluginFacts {
        host_id: value["host_id"]
            .as_str()
            .filter(|s| crate::valid_id(s))?
            .to_string(),
        host_owner: value["host_owner"]
            .as_str()
            .filter(|s| s.is_empty() || crate::valid_id(s))?
            .to_string(),
        host_active: value["host_active"].as_bool()?,
        host_thumbprint: value["host_thumbprint"]
            .as_str()
            .filter(|t| t.is_empty() || decide::valid_thumbprint(t))?
            .to_string(),
        hosts_holding_key: value["hosts_holding_key"].as_i64().filter(|n| *n >= 0)?,
        agents,
    })
}

fn facts_json(facts: &decide::PluginFacts) -> Value {
    json!({
        "host_id": facts.host_id, "host_owner": facts.host_owner, "host_active": facts.host_active,
        "host_thumbprint": facts.host_thumbprint, "hosts_holding_key": facts.hosts_holding_key,
        "agents": facts.agents.iter().map(|a| json!({ "id": a.id, "active": a.active })).collect::<Vec<_>>(),
    })
}

/// `POST /v1/pairing/sweep`: the starter's sessions past their expiry, each with its state as the starter would read it,
/// so the gateway can end the plugin host of each that wasn't activated. A session listed but never made reads `missing`.
/// It changes nothing: [`settle`] does, once the gateway has acted.
async fn sweep(env: &Env, caller: &Caller) -> R<Response> {
    if caller.kind != "person" {
        return Err(ApiError::not_allowed());
    }
    let mut due = call(env, &caller.id, DUE, &json!({ "now": now_ms() }), None).await?;
    if due.status_code() != 200 {
        return Err(ApiError::internal("pairing sweep unavailable"));
    }
    let due: Value = due.json().await?;
    let mut sessions = Vec::new();
    for row in due["due"].as_array().into_iter().flatten() {
        let Some(agent) = row["agent_id"].as_str().filter(|a| is_agent_id(a)) else {
            continue;
        };
        let mut read = call(env, agent, READ, &json!({}), Some(caller)).await?;
        match read.status_code() {
            200 => {
                let view: Value = read.json().await?;
                sessions.push(json!({ "agent_id": agent, "plugin_host_id": view["plugin_host_id"], "status": view["status"], "key_thumbprint": view["key_thumbprint"] }));
            }
            404 => sessions.push(json!({ "agent_id": agent, "plugin_host_id": row["plugin_host_id"], "status": "missing", "key_thumbprint": null })),
            // Unreadable now: it stays listed, for the next sweep.
            _ => {}
        }
    }
    Ok(Response::from_json(&json!({ "sessions": sessions }))?)
}

/// `POST /v1/pairing/sweep/settled`: the gateway has ended these sessions' plugin hosts, or found nothing to end, so the
/// starter's list forgets them. Only sessions past their expiry are forgotten, so a live one stays listed whatever is sent.
async fn settle(env: &Env, caller: &Caller, body: Option<&str>) -> R<Response> {
    if caller.kind != "person" {
        return Err(ApiError::not_allowed());
    }
    let body: Value =
        serde_json::from_str(body.unwrap_or("")).map_err(|_| ApiError::invalid_argument())?;
    let ids = body["agent_ids"]
        .as_array()
        .filter(|ids| ids.len() <= SWEEP_BATCH)
        .and_then(|ids| {
            ids.iter()
                .map(|id| id.as_str().filter(|a| is_agent_id(a)).map(str::to_string))
                .collect::<Option<Vec<_>>>()
        })
        .ok_or_else(ApiError::invalid_argument)?;
    relay(
        call(
            env,
            &caller.id,
            SETTLED,
            &json!({ "agent_ids": ids, "now": now_ms() }),
            None,
        )
        .await?,
    )
    .await
}

/// The redemption route, `POST /v1/pairing/{agent}/redeem`, if this is it. It takes the gateway's `pairing_redeem`
/// assertion and nothing else, so it's matched before any identity is asked for.
pub fn redeem_route<'a>(method: &Method, parts: &[&'a str]) -> Option<&'a str> {
    match parts {
        ["v1", "pairing", agent, "redeem"] if *method == Method::Post => Some(agent),
        _ => None,
    }
}

/// `POST /v1/pairing/{agent}/redeem`: Runner's code, with the key the gateway checked.
pub async fn redeem(mut req: Request, env: Env, agent: &str) -> R<Response> {
    let token = req
        .headers()
        .get("x-podster-assertion")?
        .ok_or(ApiError::invalid_assertion())?;
    let keys = podster_assertion::KeySet::from_json(&env.secret("ASSERTION_KEYS")?.to_string())
        .map_err(|_| ApiError::internal("bad ASSERTION_KEYS"))?;
    let now_s = (Date::now().as_millis() / 1000) as i64;
    let proof = podster_assertion::verify_pairing_redeem(&token, &keys, now_s)
        .map_err(|_| ApiError::invalid_assertion())?;
    let text = req.text().await?;
    if verifier(&text) != proof.body_sha256 {
        return Err(ApiError::invalid_assertion());
    }
    // A proof is for the one session it names (M2): sent to any other, it's refused like every other refusal.
    if !is_agent_id(agent) || proof.agent_id != agent {
        return Err(ApiError::not_allowed());
    }
    let body: Value = serde_json::from_str(&text).map_err(|_| ApiError::invalid_argument())?;
    let code = body["code"]
        .as_str()
        .filter(|c| decide::valid_code(c))
        .ok_or_else(ApiError::invalid_argument)?;
    let offered = json!({
        "agent_id": proof.agent_id, "verifier": verifier(code), "key_thumbprint": proof.key_thumbprint, "proof_jti": proof.proof_jti,
        "proof_expires_at": proof.proof_exp.saturating_mul(1000),
    });
    relay(call(&env, agent, REDEEM, &offered, None).await?).await
}

/// Passes a Principal's answer on as it came: a refusal keeps its status and code.
async fn relay(mut response: Response) -> R<Response> {
    let status = response.status_code();
    let value: Value = response.json().await?;
    Ok(Response::from_json(&value)?.with_status(status))
}

fn session_row(sql: &SqlStorage) -> R<Option<Value>> {
    if !has_table(sql, "pairing_session")? {
        return Ok(None);
    }
    Ok(rows(sql, "SELECT * FROM pairing_session", vec![])?
        .into_iter()
        .next())
}

/// Whether this Principal holds a pairing session, whatever its state. Its agent is made only by activating it.
pub(super) fn holds_session(sql: &SqlStorage) -> R<bool> {
    Ok(session_row(sql)?.is_some())
}

fn session_of(row: &Value) -> R<Session> {
    Ok(Session {
        status: row["status"]
            .as_str()
            .and_then(Status::parse)
            .ok_or_else(|| ApiError::internal("bad pairing status"))?,
        attempts: int(&row["attempts"]),
        expires_at: int(&row["expires_at"]),
        key_thumbprint: text(&row["key_thumbprint"]),
    })
}

fn save(sql: &SqlStorage, session: &Session, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE pairing_session SET status = ?, attempts = ?, key_thumbprint = ?, updated_at = ?",
        vec![
            session.status.code().into(),
            session.attempts.into(),
            session.key_thumbprint.as_deref().into(),
            now.into(),
        ],
    )
}

fn record(sql: &SqlStorage, kind: &str, actor: &str, reason: Option<&str>, now: i64) -> R<()> {
    exec(
        sql,
        "INSERT INTO pairing_event (type, actor_id, reason, created_at) VALUES (?, ?, ?, ?)",
        vec![kind.into(), actor.into(), reason.into(), now.into()],
    )?;
    exec(
        sql,
        "DELETE FROM pairing_event WHERE seq <= (SELECT max(seq) FROM pairing_event) - ?",
        vec![EVENTS_KEPT.into()],
    )
}

/// What the starter sees: the session's state and history, with no verifier.
fn view(sql: &SqlStorage, now: i64) -> R<Value> {
    let row = session_row(sql)?.ok_or_else(ApiError::not_found)?;
    let session = session_of(&row)?;
    let history: Vec<Value> = rows(
        sql,
        "SELECT type, actor_id, reason, created_at FROM pairing_event ORDER BY seq",
        vec![],
    )?
    .into_iter()
    .map(|e| json!({ "type": e["type"], "actor_id": e["actor_id"], "reason": e["reason"], "at": e["created_at"] }))
    .collect();
    let mut answer = json!({
        "agent_id": row["agent_id"], "org_id": row["org_id"], "name": row["name"], "plugin_host_id": row["plugin_host_id"],
        "status": decide::shown_status(&session, now), "key_thumbprint": session.key_thumbprint,
        "attempts_left": (decide::MAX_ATTEMPTS - session.attempts).max(0), "created_at": row["created_at"],
        "expires_at": session.expires_at, "history": history,
    });
    if session.status == Status::Activated {
        answer["connection"] = connection(sql)?
            .map(|c| connection_json(&c))
            .ok_or_else(|| ApiError::internal("activated without a connection"))?;
        answer["plugin_agent_id"] = json!(linked(sql)?);
    }
    Ok(answer)
}

/// The plugin agent a confirmation linked, if any.
fn linked(sql: &SqlStorage) -> R<Option<String>> {
    if !has_table(sql, "pairing_link")? {
        return Ok(None);
    }
    Ok(
        rows(sql, "SELECT plugin_agent_id FROM pairing_link", vec![])?
            .first()
            .and_then(|r| text(&r["plugin_agent_id"])),
    )
}

/// A refusal on the way out of a transaction that committed what it counted.
fn refused(value: Value, refusal: Option<Refusal>) -> R<Value> {
    match refusal {
        None => Ok(value),
        Some(Refusal::KeyMismatch | Refusal::BindingMismatch) => Err(ApiError::not_allowed()),
        Some(_) => Err(ApiError::from_core(
            &podster_core::CoreError::InvalidTransition,
        )),
    }
}

impl Principal {
    pub(super) async fn pairing(&self, path: &str, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        let body: Value = req.json().await?;
        let now = now_ms();
        if path == COUNT_START {
            let agent = text(&body["agent_id"]).ok_or_else(ApiError::invalid_argument)?;
            let host = text(&body["plugin_host_id"]).ok_or_else(ApiError::invalid_argument)?;
            let expires_at = int(&body["expires_at"]);
            let now = int(&body["now"]);
            let store = sql.clone();
            return self.in_transaction(move || {
                exec(&store, STARTS_SCHEMA, vec![])?;
                exec(&store, DUE_SCHEMA, vec![])?;
                // Bounded: a session the sweep hasn't settled in a month is dropped, whatever became of it.
                exec(
                    &store,
                    "DELETE FROM pairing_due WHERE expires_at <= ?",
                    vec![now.saturating_sub(DUE_KEPT_MS).into()],
                )?;
                exec(
                    &store,
                    "DELETE FROM pairing_start WHERE started_at <= ?",
                    vec![now.saturating_sub(decide::STARTS_WINDOW_MS).into()],
                )?;
                let starts: Vec<i64> =
                    rows(&store, "SELECT started_at FROM pairing_start", vec![])?
                        .iter()
                        .map(|r| int(&r["started_at"]))
                        .collect();
                if !decide::may_start(&starts, now) {
                    return Ok(json!({ "allowed": false }));
                }
                exec(
                    &store,
                    "INSERT INTO pairing_start (agent_id, started_at) VALUES (?, ?)",
                    vec![agent.as_str().into(), now.into()],
                )?;
                exec(
                    &store,
                    "INSERT INTO pairing_due (agent_id, plugin_host_id, expires_at) VALUES (?, ?, ?)",
                    vec![agent.as_str().into(), host.as_str().into(), expires_at.into()],
                )?;
                Ok(json!({ "allowed": true }))
            });
        }
        if path == DUE {
            if !has_table(&sql, "pairing_due")? {
                return Ok(json!({ "due": [] }));
            }
            let due = rows(
                &sql,
                "SELECT agent_id, plugin_host_id FROM pairing_due WHERE expires_at <= ? ORDER BY expires_at, agent_id LIMIT ?",
                vec![int(&body["now"]).into(), (SWEEP_BATCH as i64).into()],
            )?;
            return Ok(json!({ "due": due }));
        }
        if path == SETTLED {
            let now = int(&body["now"]);
            let ids: Vec<String> = body["agent_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|id| id.as_str().map(str::to_string))
                .collect();
            if !has_table(&sql, "pairing_due")? {
                return Ok(json!({ "settled": 0 }));
            }
            let store = sql.clone();
            return self.in_transaction(move || {
                let mut settled = 0;
                for id in &ids {
                    let before = rows(
                        &store,
                        "SELECT agent_id FROM pairing_due WHERE agent_id = ? AND expires_at <= ?",
                        vec![id.as_str().into(), now.into()],
                    )?;
                    if !before.is_empty() {
                        exec(
                            &store,
                            "DELETE FROM pairing_due WHERE agent_id = ?",
                            vec![id.as_str().into()],
                        )?;
                        settled += 1;
                    }
                }
                Ok(json!({ "settled": settled }))
            });
        }
        if path == REDEEM {
            return self.redeem(body, now);
        }
        let caller: Caller = req
            .headers()
            .get(CALLER_HEADER)?
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .ok_or_else(|| ApiError::internal("missing caller"))?;
        if path == START {
            // The ID is new, so anything already here means it isn't, and nothing is made over it.
            if connection(&sql)?.is_some() || holds_session(&sql)? {
                return Err(ApiError::internal("pairing agent id in use"));
            }
            let store = sql.clone();
            let actor = caller.id.clone();
            return self.in_transaction(move || {
                exec(&store, SCHEMA, vec![])?;
                let session = decide::start(int(&body["now"]));
                exec(&store, "INSERT INTO pairing_session (id, agent_id, org_id, person_id, name, plugin_host_id, code_verifier, status, attempts, key_thumbprint, created_at, expires_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)",
                    vec![body["agent_id"].as_str().into(), body["org_id"].as_str().into(), body["person_id"].as_str().into(),
                        body["name"].as_str().into(), body["plugin_host_id"].as_str().into(), body["code_verifier"].as_str().into(),
                        session.status.code().into(), int(&body["now"]).into(), session.expires_at.into(), int(&body["now"]).into()])?;
                record(&store, "pairing.started", &actor, None, now)?;
                view(&store, now)
            });
        }
        // The starter's own reads and commands. Anyone else learns nothing, not even that the session exists.
        let row = session_row(&sql)?.ok_or_else(ApiError::not_found)?;
        let org = row["org_id"].as_str().unwrap_or_default().to_string();
        let starter = row["person_id"].as_str().unwrap_or_default().to_string();
        let person = person_of(&caller, &org);
        if !policy::may_read_or_cancel(&person, &starter) {
            return Err(ApiError::not_found());
        }
        match path {
            READ => view(&sql, now),
            CANCEL => {
                let store = sql.clone();
                let actor = caller.id.clone();
                let done = self.in_transaction(move || {
                    let row = session_row(&store)?.ok_or_else(ApiError::not_found)?;
                    let Decision { next, outcome } = decide::cancel(&session_of(&row)?);
                    match outcome {
                        Outcome::Canceled => {
                            save(&store, &next, now)?;
                            record(&store, "pairing.canceled", &actor, None, now)?;
                            Ok(json!({ "answer": view(&store, now)? }))
                        }
                        Outcome::AlreadyCanceled => Ok(json!({ "answer": view(&store, now)? })),
                        _ => Ok(json!({ "refused": true })),
                    }
                })?;
                refused(
                    done["answer"].clone(),
                    done.get("refused").map(|_| Refusal::Closed),
                )
            }
            ACTIVATE => {
                let thumbprint =
                    text(&body["key_thumbprint"]).ok_or_else(ApiError::invalid_argument)?;
                let facts = plugin_facts(&body["plugin"]).ok_or_else(ApiError::invalid_argument)?;
                let started_at = int(&row["created_at"]);
                let may = policy::may_activate(&person, &starter, started_at);
                let store = sql.clone();
                let actor = caller.id.clone();
                let starter_id = starter.clone();
                let done = self.in_transaction(move || {
                    if !may {
                        record(&store, "pairing.refused", &actor, Some("authority"), now)?;
                        return Ok(json!({ "authority": false }));
                    }
                    // Read again inside the transaction, so two confirmations at once have one outcome.
                    let row = session_row(&store)?.ok_or_else(ApiError::not_found)?;
                    let Decision { next, outcome } = decide::activate(&session_of(&row)?, now, &thumbprint);
                    // The binding rule, for a confirmation that would activate or that repeats one: the plugin agent it links.
                    let target = || {
                        decide::link_target(&facts, row["plugin_host_id"].as_str().unwrap_or_default(), &starter_id, &thumbprint)
                            .map(str::to_string)
                    };
                    match outcome {
                        Outcome::Activated | Outcome::AlreadyActivated => {
                            let plugin_agent = match target() {
                                Ok(agent) => agent,
                                Err(refusal) => {
                                    record(&store, "pairing.refused", &actor, Some(refusal.code()), now)?;
                                    return Ok(json!({ "refused": refusal.code() }));
                                }
                            };
                            exec(&store, SCHEMA, vec![])?;
                            if outcome == Outcome::AlreadyActivated {
                                // A repeat names the agent it linked, or links one if it hadn't (activated before step 5(c)).
                                match linked(&store)? {
                                    Some(agent) if agent != plugin_agent => {
                                        record(&store, "pairing.refused", &actor, Some(Refusal::BindingMismatch.code()), now)?;
                                        return Ok(json!({ "refused": Refusal::BindingMismatch.code() }));
                                    }
                                    Some(_) => return Ok(json!({ "answer": view(&store, now)? })),
                                    None => {}
                                }
                            } else {
                                // The one effective outcome: the agent's connection, written with the session's close.
                                exec(&store, super::SCHEMA, vec![])?;
                                exec(&store, "INSERT INTO connection (id, org_id, name, generation, status, created_at) VALUES (?, ?, ?, 1, ?, ?)",
                                    vec![row["agent_id"].as_str().into(), row["org_id"].as_str().into(), row["name"].as_str().into(), ACTIVE.into(), now.into()])?;
                                save(&store, &next, now)?;
                                record(&store, "pairing.activated", &actor, None, now)?;
                            }
                            // The plugin agent it links, in the same transaction, for the gateway's directory to follow.
                            exec(&store, "INSERT INTO pairing_link (id, plugin_agent_id, linked_at) VALUES (1, ?, ?)",
                                vec![plugin_agent.as_str().into(), now.into()])?;
                            record(&store, "pairing.linked", &actor, None, now)?;
                            Ok(json!({ "answer": view(&store, now)? }))
                        }
                        Outcome::Refused(refusal) => {
                            record(&store, "pairing.refused", &actor, Some(refusal.code()), now)?;
                            Ok(json!({ "refused": refusal.code() }))
                        }
                        _ => Err(ApiError::internal("unexpected pairing outcome")),
                    }
                })?;
                if done["authority"].as_bool() == Some(false) {
                    return Err(ApiError::not_allowed());
                }
                let refusal = match done["refused"].as_str() {
                    None => None,
                    Some("key_mismatch") => Some(Refusal::KeyMismatch),
                    Some("binding_mismatch") => Some(Refusal::BindingMismatch),
                    Some(_) => Some(Refusal::Closed),
                };
                refused(done["answer"].clone(), refusal)
            }
            _ => Err(ApiError::not_found()),
        }
    }

    fn redeem(&self, body: Value, now: i64) -> R<Value> {
        let sql = self.state.storage().sql();
        // No session, no trace: a guess at an agent ID writes nothing.
        if !holds_session(&sql)? {
            return Err(ApiError::not_allowed());
        }
        let named = text(&body["agent_id"]).ok_or_else(ApiError::invalid_argument)?;
        let offered = text(&body["verifier"]).ok_or_else(ApiError::invalid_argument)?;
        let thumbprint = text(&body["key_thumbprint"]).ok_or_else(ApiError::invalid_argument)?;
        let proof = text(&body["proof_jti"]).ok_or_else(ApiError::invalid_argument)?;
        let proof_expires_at = int(&body["proof_expires_at"]);
        let store = sql.clone();
        let done = self.in_transaction(move || {
            // Spent proofs go once they expire, on every redemption, and the assertion keeps that within five minutes (L2).
            exec(&store, "DELETE FROM pairing_proof WHERE expires_at < ?", vec![now.into()])?;
            let row = session_row(&store)?.ok_or_else(ApiError::not_allowed)?;
            let actor = format!("key:{thumbprint}");
            // A replay is refused like every other refusal, and its pruning still commits (L1).
            if !rows(&store, "SELECT jti FROM pairing_proof WHERE jti = ?", vec![proof.as_str().into()])?.is_empty() {
                record(&store, "pairing.refused", &actor, Some("proof_replayed"), now)?;
                return Ok(json!({ "refused": true }));
            }
            exec(&store, "INSERT INTO pairing_proof (jti, expires_at) VALUES (?, ?)", vec![proof.as_str().into(), proof_expires_at.into()])?;
            // The Worker checked this already; the session checks it again against its own agent.
            if row["agent_id"].as_str() != Some(named.as_str()) {
                record(&store, "pairing.refused", &actor, Some("other_session"), now)?;
                return Ok(json!({ "refused": true }));
            }
            let stored = row["code_verifier"].as_str().unwrap_or_default();
            let matches = decide::verifiers_match(stored.as_bytes(), offered.as_bytes());
            let Decision { next, outcome } = decide::redeem(&session_of(&row)?, now, matches, &thumbprint);
            match outcome {
                Outcome::Redeemed => {
                    save(&store, &next, now)?;
                    record(&store, "pairing.redeemed", &actor, None, now)?;
                }
                Outcome::AlreadyRedeemed => {}
                Outcome::Refused(refusal) => {
                    if next != session_of(&row)? {
                        save(&store, &next, now)?;
                    }
                    record(&store, "pairing.refused", &actor, Some(refusal.code()), now)?;
                    return Ok(json!({ "refused": true }));
                }
                _ => return Err(ApiError::internal("unexpected pairing outcome")),
            }
            Ok(json!({
                "agent_id": row["agent_id"], "status": Status::Redeemed.code(), "plugin_host_id": row["plugin_host_id"],
                "key_thumbprint": thumbprint, "expires_at": next.expires_at,
            }))
        })?;
        // Every refusal looks the same from outside: wrong, spent, locked, expired, closed or another key.
        if done.get("refused").is_some() {
            return Err(ApiError::not_allowed());
        }
        Ok(done)
    }
}
