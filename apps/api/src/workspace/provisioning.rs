//! Provisioning the room's managed repository (M5 step 4, ADR 0009, which is proposed).
//!
//! - **Two person commands**, for a person who is the room's owner or a room admin (the owner's decision of 2026-11-11,
//!   "Owner and admins"): ask for the repository, and retry a setup that failed or whose outcome is unknown. Each needs
//!   the organization's provisioning delegation as well, which the organization's own `Principal` holds. Every
//!   organization holds it unless a Podster operator took it back ("No gate, with limits"), and a request is counted
//!   against a daily cap for the organization and for the person asking. Each commits its state, audit entry, event and
//!   stored answer in one transaction, and calls nothing outside.
//! - **One job**, run by the room's alarm while a request is `pending`. It rechecks authority, then talks to the provider
//!   through `crate::github::Provider`, and commits each thing it learns in a transaction of its own. The repository is
//!   linked, and the request made `ready`, only after everything readiness needs was read back and judged by
//!   `podster_core::provisioning`. Anything else leaves the request `failed` or `uncertain` with a reason code.
//!
//! Managed repositories have a switch of their own, the Worker variable `MANAGED_REPOSITORIES`, off unless it is exactly
//! `true`. Both commands and the job check it. Setting an App's key isn't the owner's yes to public repositories under
//! Podster's organization. This variable is.
//!
//! The organization, the App and its installation come from the Worker's configuration, never from a caller. A
//! repository is known by the ID in the provider's answer to this room's own creation call, never by a name. Nothing here
//! deletes a repository or falls back to another organization. Logs and events carry IDs, reason codes and HTTP statuses.
use super::*;
use crate::github::{Config, CreateAnswer, Failure, GitHubApp, Provider};
use podster_core::provisioning::{
    job_backoff_ms, missing_steps, rate_limited_run_waits, reserved_name, retry_allowed,
    retry_name, retry_wait_ms, verify_ready, Configured, Expected, RepositoryRequesters,
    RequestLimitReached, MAX_SETUP_RUNS, RATE_LIMITED_REASON, SETUP_GONE_WAITS, SETUP_GONE_WAIT_MS,
};
use podster_core::rate_limit::limit_repeated_after_reset;
use podster_core::repositories::{
    decide_retry, valid_repo_name, RepoVisibility, RequestState, RetryPlan, RetryRefusal,
};
use podster_policy::moderation::parse_operators;
use podster_policy::repositories::{
    authorize_repository_admin, authorize_repository_request, RepoDenial,
};

const PROVIDER: &str = "github";
const SWITCH_VAR: &str = "MANAGED_REPOSITORIES";
/// The Worker variable that names who this deployment lets ask for a room's repository: see [`requesters`].
const REQUESTERS_VAR: &str = "REPOSITORY_REQUESTERS";
/// The setup job's reason when whoever asked isn't someone this deployment lets ask, now.
const REQUESTS_CLOSED: &str = "repository_requests_closed";
/// The attempt outcomes that say a creation call may have gone out under the attempt's name.
const NOT_SENT: &str = "not_sent";
const STARTED: &str = "started";

/// The organization Podster's repositories are made in, for the room's repository read: the configured
/// `GITHUB_ORG_LOGIN`, or `None` while provisioning isn't configured. Display only. Test builds stand for a deployment
/// whose key isn't set yet with the same table the job reads.
pub(super) fn organization(env: &Env, sql: &SqlStorage) -> Option<String> {
    #[cfg(feature = "failpoints")]
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_no_provisioning_key'",
        vec![],
    )
    .is_ok_and(|found| !found.is_empty())
    {
        return None;
    }
    #[cfg(not(feature = "failpoints"))]
    let _ = sql;
    Config::from_env(env).map(|config| config.org_login().to_string())
}

/// Whether provisioning's App is configured, so a read-back can be made at all. Test builds stand for a deployment
/// whose key isn't set yet with the same table the job reads.
pub(super) fn configured(env: &Env, sql: &SqlStorage) -> bool {
    organization(env, sql).is_some()
}

/// A test build reads a setting from another binding's name, if the room holds a table of that name with the binding's
/// name in it: so a test can put a list, a number or an object where a deployment has the setting.
#[cfg(feature = "failpoints")]
fn test_binding(sql: &SqlStorage, table: &str) -> R<Option<String>> {
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        vec![table.into()],
    )?
    .is_empty()
    {
        return Ok(None);
    }
    Ok(rows(sql, &format!("SELECT name FROM {table}"), vec![])?
        .first()
        .and_then(|row| text(&row["name"])))
}

/// Whether managed repositories are switched on for this deployment: only if the binding is the string `true`,
/// exactly. Absent, any other string, and anything that isn't a string, such as the boolean `true`, are off. Test
/// builds can switch them on for one room, by a table only a test can make, so every other test runs with them off,
/// as every deployment does today.
pub(super) fn enabled(env: &Env, sql: &SqlStorage) -> R<bool> {
    let on = |name: &str| matches!(crate::setting(env, name), crate::Setting::Text(value) if value == "true");
    #[cfg(feature = "failpoints")]
    {
        if let Some(name) = test_binding(sql, "test_switch_binding")? {
            return Ok(on(&name));
        }
        if !rows(
            sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_managed_repositories_on'",
            vec![],
        )?
        .is_empty()
        {
            return Ok(true);
        }
    }
    #[cfg(not(feature = "failpoints"))]
    let _ = sql;
    Ok(on(SWITCH_VAR))
}

/// Who this deployment lets ask for a room's repository or retry its setup: the list in the Worker variable
/// `REPOSITORY_REQUESTERS`, and the deployment's own operators, which the list's `operators` entry stands for. Both are
/// the deployment's configuration, never a caller's word, and the ID they're held against is the verified caller's.
#[derive(Clone, Debug)]
pub(super) struct Requesters {
    list: RepositoryRequesters,
    /// `OPERATORS` as configured, the source `moderation` reads. Empty when unset, which names nobody.
    operators: String,
}

impl Requesters {
    /// Whether the caller may ask or retry: the room's rule, then the list. An agent never passes the first.
    pub(super) fn authorize(&self, caller: &Caller) -> Result<(), RepoDenial> {
        authorize_repository_request(caller, &self.list, &parse_operators(&self.operators))
    }

    /// Whether this person may ask, as far as the list goes: for the job, about the person who asked, whose place in
    /// the room it checks for itself.
    fn allows(&self, person: &str) -> bool {
        self.list.allows(person, &parse_operators(&self.operators))
    }
}

/// Reads [`Requesters`] from the Worker's configuration. `REPOSITORY_REQUESTERS`, read from the raw binding by
/// `RepositoryRequesters::read`: with nothing bound, everyone the room's own rule lets; a string is the listed person
/// IDs, with `test-people` the test sign-up's people, and with `operators` the people `OPERATORS` names; an empty or
/// malformed string, and anything bound that isn't a string, nobody. So only a setting that is truly absent leaves
/// requests open. Both commands and the job check it. A test build can give one room a setting of its own, read
/// either setting from another binding, and take the operators away, by tables only a test can make.
pub(super) fn requesters(env: &Env, sql: &SqlStorage) -> R<Requesters> {
    let read = |name: &str| match crate::setting(env, name) {
        crate::Setting::Absent => RepositoryRequesters::read(Configured::Absent),
        crate::Setting::Text(value) => RepositoryRequesters::read(Configured::Text(&value)),
        crate::Setting::Unreadable => RepositoryRequesters::read(Configured::Unreadable),
    };
    #[cfg(feature = "failpoints")]
    {
        let has = |table: &str| -> R<bool> {
            Ok(!rows(
                sql,
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                vec![table.into()],
            )?
            .is_empty())
        };
        // A room holding the first table stands for a deployment whose OPERATORS is unset, and one holding the second
        // for a deployment whose OPERATORS is whatever is bound under the name in it.
        let operators = if has("test_no_operators")? {
            String::new()
        } else if let Some(name) = test_binding(sql, "test_operators_binding")? {
            crate::moderation::operators_under(env, &name)
        } else {
            crate::moderation::configured_operators(env)
        };
        if let Some(name) = test_binding(sql, "test_requesters_binding")? {
            return Ok(Requesters {
                list: read(&name),
                operators,
            });
        }
        if has("test_repository_requesters")? {
            let set = rows(sql, "SELECT value FROM test_repository_requesters", vec![])?;
            let value = set.first().and_then(|row| text(&row["value"]));
            return Ok(Requesters {
                list: RepositoryRequesters::parse(Some(value.as_deref().unwrap_or_default())),
                operators,
            });
        }
    }
    #[cfg(not(feature = "failpoints"))]
    let _ = sql;
    Ok(Requesters {
        list: read(REQUESTERS_VAR),
        operators: crate::moderation::configured_operators(env),
    })
}

/// What this deployment's configuration says to a request or a retry: whether managed repositories are switched on, and
/// who may ask. Read by the route just before the command's transaction, never from a caller.
#[derive(Clone, Debug)]
pub(super) struct Deployment {
    pub(super) switched_on: bool,
    pub(super) requesters: Requesters,
}

impl Deployment {
    pub(super) fn read(env: &Env, sql: &SqlStorage) -> R<Self> {
        Ok(Deployment {
            switched_on: enabled(env, sql)?,
            requesters: requesters(env, sql)?,
        })
    }

    /// Whether the caller may ask or retry at all, for the check that comes before a stored answer is replayed: the
    /// room's rule, then this deployment's list. Switched off, only the room's rule is asked, so the command answers
    /// as a missing route whoever is listed.
    pub(super) fn may_ask(&self, caller: &Caller) -> R<()> {
        authorize_repository_admin(caller).map_err(repositories::denied)?;
        if self.switched_on {
            may_request(caller, &self.requesters)?;
        }
        Ok(())
    }
}

/// The room's managed-repository routes for people: the read and request, the retry, and the grants. While the switch
/// is off each answers as a route that doesn't exist. An agent's token route keeps its own check, in `repo_tokens`.
pub(super) fn is_managed_route(tail: &[&str]) -> bool {
    matches!(
        tail,
        ["repository"]
            | ["repository", "retry"]
            | ["repository", "grants"]
            | ["repository", "grants", _]
    )
}

/// How many more times setup may run for the room's request: the cap less the runs so far, never below 0.
pub(super) fn attempts_left(runs: i64) -> i64 {
    (MAX_SETUP_RUNS - runs).max(0)
}

fn refuse<T>(status: u16, code: &'static str) -> R<T> {
    Err(ApiError::api(status, code))
}

/// Whether the caller runs the room's repository: a person the room resolved as its owner or as a room admin.
/// `resolve_caller` gives a role only while it stands, so one who left their organization has none here.
pub(super) fn runs_repository(caller: &Caller) -> bool {
    authorize_repository_admin(caller).is_ok()
}

/// Only a person who is the room's owner or a room admin asks for or retries the room's repository, and only one this
/// deployment lets ask. The room's rule answers first.
pub(super) fn may_request(caller: &Caller, requesters: &Requesters) -> R<()> {
    requesters.authorize(caller).map_err(repositories::denied)
}

/// A request's two fields, checked: the chosen name and visibility. Nothing else is accepted.
fn requested(body: &Value) -> R<(&str, RepoVisibility)> {
    let fields = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields.keys().any(|k| k != "name" && k != "visibility") {
        return Err(ApiError::invalid_argument());
    }
    let name = body["name"]
        .as_str()
        .filter(|name| valid_repo_name(name))
        .ok_or_else(ApiError::invalid_argument)?;
    let visibility = body["visibility"]
        .as_str()
        .and_then(RepoVisibility::from_name)
        .ok_or_else(ApiError::invalid_argument)?;
    // Names that would read as Podster's own in the organization every room shares.
    if reserved_name(name) {
        return refuse(409, "name_reserved");
    }
    // On the organization's plan a private repository can't carry the rules, so it's unavailable, never quietly made public.
    if visibility != RepoVisibility::Public {
        return refuse(409, "private_unavailable");
    }
    Ok((name, visibility))
}

/// Whether a request, as far as the room alone can tell, would be recorded if the organization holds the delegation
/// and the caps allow it: so the room knows whether to have it counted. `Ok(false)` when the room already has its one
/// request, which the command then answers for itself.
pub(super) fn worth_counting(
    sql: &SqlStorage,
    who: &Participant,
    body: &Value,
    requesters: &Requesters,
) -> R<bool> {
    may_request(&who.caller, requesters)?;
    requested(body)?;
    Ok(request_row(sql)?.is_none())
}

fn request_row(sql: &SqlStorage) -> R<Option<Value>> {
    Ok(rows(
        sql,
        "SELECT id, state, name, visibility, attempt, provider_name, provider_repo_id, reason, requested_by, runs, retry_after, job_not_before FROM repo_request",
        vec![],
    )?
    .into_iter()
    .next())
}

/// For whom this call got "held" from both counts, before the command's transaction: which person, in which
/// organization. Never taken from the request.
#[derive(Clone, Debug)]
pub(super) struct Counted {
    pub(super) person: String,
    pub(super) org: String,
}

/// `delegation_unavailable`: the organization's answer and the caps' counts aren't in hand for this caller, as the room
/// resolves them now. Nothing was recorded, and asking again is safe.
const NOT_COUNTED: &str = "delegation_unavailable";

/// The organization the room is in now.
fn room_org(sql: &SqlStorage) -> R<Option<String>> {
    Ok(rows(sql, "SELECT owner_org_id FROM workspace", vec![])?
        .first()
        .and_then(|room| text(&room["owner_org_id"])))
}

/// `POST repository { name, visibility }`: records the room's one request for a repository. `delegated` is what the
/// organization's `Principal` said just before this transaction, and the job asks again before it calls the provider.
/// `counted` says for whom that same call got "held" from both daily counts. A request is recorded only if that is
/// exactly the caller this transaction resolved, in the organization the room is in now: someone who came to hold
/// authority, or a room that changed hands, between the count and here records nothing, and asks again.
pub(super) fn request(
    sql: &SqlStorage,
    who: &Participant,
    body: &Value,
    deployment: &Deployment,
    delegated: bool,
    counted: Option<&Counted>,
    now: i64,
) -> R<Value> {
    let requesters = &deployment.requesters;
    // The room's rule alone first: switched off, the route isn't there, for the owner as for anyone, whoever is listed.
    authorize_repository_admin(&who.caller).map_err(repositories::denied)?;
    if !deployment.switched_on {
        return Err(ApiError::not_found());
    }
    may_request(&who.caller, requesters)?;
    let (name, visibility) = requested(body)?;
    if !delegated {
        return refuse(403, "not_delegated");
    }
    if request_row(sql)?.is_some() {
        return refuse(409, "repo_request_exists");
    }
    // Last, and in this transaction: both caps were asked for this caller and this organization, by this very call.
    let org = room_org(sql)?;
    if !counted.is_some_and(|c| c.person == who.caller.id && Some(&c.org) == org.as_ref()) {
        return refuse(503, NOT_COUNTED);
    }
    let id = format!("rr_{}", uuid::Uuid::new_v4().simple());
    exec(
        sql,
        "INSERT INTO repo_request (id, state, name, visibility, attempt, provider_name, requested_by, requested_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
        vec![
            id.as_str().into(),
            RequestState::Pending.name().into(),
            name.into(),
            visibility.name().into(),
            name.into(),
            who.caller.id.as_str().into(),
            now.into(),
            now.into(),
        ],
    )?;
    audit(
        sql,
        &who.caller,
        "repository.requested",
        &id,
        None,
        Some(json!({ "visibility": visibility.name() }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "repository.requested",
        &who.caller.id,
        None,
        &Transition::NONE,
        roles::room_managers(sql, &who.caller.id)?,
        now,
    )?;
    repositories::read(sql, who, requesters)
}

/// `POST repository/retry {}`: puts a failed or uncertain setup back to `pending`. With a repository ID held, setup
/// resumes on that repository. Without one, the next creation call goes out under a name the server made from `suffix`,
/// never a name already sent, so nothing can come to be adopted by its name.
pub(super) fn retry(
    sql: &SqlStorage,
    who: &Participant,
    body: &Value,
    deployment: &Deployment,
    delegated: bool,
    suffix: &str,
    now: i64,
) -> R<Value> {
    let requesters = &deployment.requesters;
    authorize_repository_admin(&who.caller).map_err(repositories::denied)?;
    if !deployment.switched_on {
        return Err(ApiError::not_found());
    }
    may_request(&who.caller, requesters)?;
    if !body.as_object().is_some_and(|fields| fields.is_empty()) {
        return Err(ApiError::invalid_argument());
    }
    if !delegated {
        return refuse(403, "not_delegated");
    }
    let request = request_row(sql)?;
    let state = request
        .as_ref()
        .and_then(|r| r["state"].as_str())
        .and_then(RequestState::from_name);
    let holds_repo_id = request
        .as_ref()
        .is_some_and(|r| r["provider_repo_id"].as_i64().is_some());
    let id = request
        .as_ref()
        .and_then(|r| text(&r["id"]))
        .unwrap_or_default();
    // Every name a creation call may have carried. An attempt that never got a token sent nothing, so its name isn't one.
    let attempts = rows(
        sql,
        "SELECT attempt, provider_name, outcome FROM repo_request_attempt WHERE request_id = ?",
        vec![id.as_str().into()],
    )?;
    let sent: Vec<String> = attempts
        .iter()
        .filter(|attempt| attempt["outcome"].as_str() != Some(NOT_SENT))
        .filter_map(|attempt| text(&attempt["provider_name"]))
        .collect();
    let number = request.as_ref().map_or(0, |r| int(&r["attempt"]));
    // An attempt already on record keeps its number, so the next call gets a new one.
    let recorded = attempts
        .iter()
        .any(|attempt| int(&attempt["attempt"]) == number);
    let current = request.as_ref().and_then(|r| text(&r["provider_name"]));
    // A name no call has carried yet is still the one to send. Otherwise the server makes a new one.
    let never_sent = current.as_ref().is_some_and(|name| !sent.contains(name));
    let new_name = if never_sent {
        current.clone()
    } else {
        request
            .as_ref()
            .and_then(|r| r["name"].as_str())
            .and_then(|chosen| retry_name(chosen, suffix))
    };
    let attempted: Vec<&str> = sent.iter().map(String::as_str).collect();
    // The limit and the wait come after the state, so a request that's ready or under way says that first.
    let held = request.as_ref().and_then(|r| {
        matches!(state, Some(RequestState::Failed | RequestState::Uncertain))
            .then(|| retry_allowed(int(&r["runs"]), r["retry_after"].as_i64(), now).err())
            .flatten()
    });
    if let Some(held) = held {
        // error-codes: type RetryHeld
        return refuse(
            if held.code() == "retry_too_soon" {
                429
            } else {
                409
            },
            held.code(),
        );
    }
    let plan = match decide_retry(state, holds_repo_id, &attempted, new_name.as_deref()) {
        Ok(plan) => plan,
        Err(refusal) => {
            return refuse(
                match refusal {
                    RetryRefusal::NoRequest => 404,
                    RetryRefusal::InvalidName => 400,
                    _ => 409,
                },
                refusal.code(),
            )
        }
    };
    match plan {
        RetryPlan::ResumeHeldRepository => exec(
            sql,
            "UPDATE repo_request SET state = ?, reason = NULL, limited_since = NULL, limited_call = NULL, updated_at = ? WHERE id = ?",
            vec![RequestState::Pending.name().into(), now.into(), id.as_str().into()],
        )?,
        RetryPlan::CreateUnderNewName => exec(
            sql,
            "UPDATE repo_request SET state = ?, reason = NULL, limited_since = NULL, limited_call = NULL, provider_repo_id = NULL, provider_name = ?, attempt = attempt + ?, updated_at = ? WHERE id = ?",
            vec![
                RequestState::Pending.name().into(),
                new_name.unwrap_or_default().as_str().into(),
                i64::from(recorded).into(),
                now.into(),
                id.as_str().into(),
            ],
        )?,
    }
    audit(
        sql,
        &who.caller,
        "repository.retry_requested",
        &id,
        None,
        None,
        now,
    )?;
    record_event(
        sql,
        "repository.retry_requested",
        &who.caller.id,
        None,
        &Transition::NONE,
        roles::room_managers(sql, &who.caller.id)?,
        now,
    )?;
    repositories::read(sql, who, requesters)
}

/// Ends the job's turn: the request leaves `pending` with a reason code and the time a retry may next be taken, and the
/// room's managers are told. Only if it's still the pending request the job started on.
///
/// If this attempt's row still says `started`, a creation call may have gone out and nobody recorded how it ended, so a
/// repository may exist. Whatever the job thought went wrong, the request then ends `uncertain`, and the attempt keeps the
/// name an operator would look for.
fn finish(
    sql: &SqlStorage,
    request_id: &str,
    state: RequestState,
    reason: &str,
    now: i64,
) -> R<()> {
    let pending = rows(
        sql,
        "SELECT requested_by, attempt, runs FROM repo_request WHERE id = ? AND state = ?",
        vec![request_id.into(), RequestState::Pending.name().into()],
    )?;
    let Some(request) = pending.first() else {
        return Ok(());
    };
    let requester = text(&request["requested_by"]).unwrap_or_default();
    let attempt = int(&request["attempt"]);
    let unrecorded = !rows(
        sql,
        "SELECT 1 AS open FROM repo_request_attempt WHERE request_id = ? AND attempt = ? AND outcome = ?",
        vec![request_id.into(), attempt.into(), STARTED.into()],
    )?
    .is_empty();
    let (state, reason) = if unrecorded {
        set_attempt(sql, request_id, attempt, "uncertain", now)?;
        (RequestState::Uncertain, "creation_outcome_unknown")
    } else {
        (state, reason)
    };
    exec(
        sql,
        "UPDATE repo_request SET state = ?, reason = ?, retry_after = ?, job_failures = 0, job_not_before = NULL, limited_since = NULL, limited_call = NULL, updated_at = ? WHERE id = ?",
        vec![
            state.name().into(),
            reason.into(),
            (now + retry_wait_ms(int(&request["runs"]))).into(),
            now.into(),
            request_id.into(),
        ],
    )?;
    record_event(
        sql,
        "repository.setup_failed",
        &requester,
        None,
        &Transition::NONE,
        roles::room_managers(sql, "")?,
        now,
    )
}

fn set_attempt(sql: &SqlStorage, request_id: &str, attempt: i64, outcome: &str, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE repo_request_attempt SET outcome = ?, at = ? WHERE request_id = ? AND attempt = ?",
        vec![
            outcome.into(),
            now.into(),
            request_id.into(),
            attempt.into(),
        ],
    )
}

/// How one run of the job ended, for the log.
struct Ended {
    state: RequestState,
    reason: &'static str,
    /// The provider's HTTP status, when one decided it.
    status: u16,
    /// GitHub rate-limited this run, and said to wait this long. The run is given back and the request stays pending,
    /// for up to `core::RATE_LIMITED_FOR_MS` from its first limit.
    limited: Option<i64>,
    /// The limit was only a spent-limit `403` (`core::rate_limit::primary_403`). If one comes again after the last
    /// limit's wait is over, it's a refusal, and the run ends as `otherwise`.
    primary_403: bool,
    /// The reason this run ends with if what looked like a limit is a refusal.
    otherwise: &'static str,
    /// A repository this run created read back as not there. Setup waits and reads again, and never fails on that alone.
    gone_wait: bool,
}

fn failed(reason: &'static str, status: u16) -> Ended {
    Ended {
        state: RequestState::Failed,
        reason,
        status,
        limited: None,
        primary_403: false,
        otherwise: reason,
        gone_wait: false,
    }
}

/// How a run ends when a call to GitHub failed: a rate limit waits, anything else is `reason`.
fn failed_call(reason: &'static str, failure: Failure) -> Ended {
    match failure.rate_limit_wait_ms() {
        Some(wait_ms) => Ended {
            limited: Some(wait_ms),
            primary_403: failure.primary_403(),
            otherwise: reason,
            ..failed(RATE_LIMITED_REASON, failure.status())
        },
        None => failed(reason, failure.status()),
    }
}

/// How a run ends when a repository it holds read back as not there: it waits and reads again.
fn gone_at_setup() -> Ended {
    Ended {
        gone_wait: true,
        ..failed("read_back_failed", 404)
    }
}

/// What became of a run GitHub rate-limited, in the request's own transaction.
enum Limited {
    /// It waits for GitHub's time, with the run given back.
    Waits,
    /// It has been limited for a day: it ends `provider_rate_limited`, with the run given back, and a retry's first call
    /// waits for this reset.
    Ends(i64),
    /// A spent-limit 403 again after the last limit's wait: GitHub is refusing, so it ends as the refusal it is.
    Refused,
}

impl Workspace {
    pub(super) fn in_transaction<T: 'static>(
        &self,
        work: impl FnOnce(&SqlStorage) -> R<T> + 'static,
    ) -> R<T> {
        let sql = self.state.storage().sql();
        let out: Rc<RefCell<Option<T>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(work(&sql)?);
            Ok(())
        })?;
        let value = out.borrow_mut().take();
        value.ok_or_else(|| ApiError::internal("transaction produced no result"))
    }

    /// Whether the room's organization holds the provisioning delegation now. `None` if its `Principal` couldn't say.
    pub(super) async fn org_delegated(&self) -> Option<bool> {
        let sql = self.state.storage().sql();
        // A test can make the organization's record unreadable for one room.
        #[cfg(feature = "failpoints")]
        if rows(
            &sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_delegation_unreadable'",
            vec![],
        )
        .is_ok_and(|found| !found.is_empty())
        {
            return None;
        }
        let org = rows(&sql, "SELECT owner_org_id FROM workspace", vec![])
            .ok()?
            .first()
            .and_then(|room| text(&room["owner_org_id"]))?;
        principal::org_delegation(&self.env, &org, PROVIDER)
            .await
            .ok()
            .map(|held| held["granted"].as_bool() == Some(true))
    }

    /// Before a request for the room's repository is recorded: asks the room's organization whether it holds the
    /// delegation and, in that same transaction of the organization's, has the room hold a place in its daily count; then
    /// the same in the asker's own object. Returns whether the organization holds the delegation, and for whom both
    /// places are held. The command's transaction records a request only if this call got "held" from both for the
    /// caller it resolves and the organization the room is in then: what this decides, outside the transaction, is only
    /// whether to ask. A request the room would refuse anyway, or one for a room that already has its request, asks
    /// nothing: so a replay, and asking again, count once. At either cap it's refused here, by name.
    ///
    /// **Nothing is ever given back.** A place is the room's, one per room in each object, stamped when it was last
    /// asked for. A call that fails after it leaves the room counted until the stamp ages out, in the organization's
    /// object and, if it got that far, the person's. So the counts can only be too high.
    pub(super) async fn count_repository_request(
        &self,
        identity: &Identity,
        body: &Value,
    ) -> R<(bool, Option<Counted>)> {
        let sql = self.state.storage().sql();
        // Whoever the command would refuse costs no count. The command refuses them itself, in its transaction.
        let Ok(who) = resolve_caller(&sql, identity) else {
            return Ok((false, None));
        };
        // That includes someone this deployment doesn't let ask: no place is taken for them, in either object.
        let requesters = requesters(&self.env, &sql)?;
        if !matches!(worth_counting(&sql, &who, body, &requesters), Ok(true)) {
            let delegated = self.org_delegated().await == Some(true);
            // A test holds this call here, after it decided not to count, to change the room before its transaction.
            #[cfg(feature = "failpoints")]
            self.test_hold(&sql, "test_hold_uncounted").await;
            return Ok((delegated, None));
        }
        #[cfg(feature = "failpoints")]
        if rows(
            &sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_delegation_unreadable'",
            vec![],
        )
        .is_ok_and(|found| !found.is_empty())
        {
            return Ok((false, None));
        }
        let room = objects::room_id(&sql)?;
        let Some(org) = room_org(&sql)? else {
            return Ok((false, None));
        };
        let person = who.caller.id.clone();
        let limit = || ApiError::api(429, RequestLimitReached.code());
        // The organization first. One that can't answer is one that didn't say yes, as it was before the caps.
        let Ok(said) = principal::reserve_repo_request(&self.env, &org, &room, true).await else {
            return Ok((false, None));
        };
        if !said.granted {
            return Ok((false, None));
        }
        if !said.held {
            return Err(limit());
        }
        // Then the person: one person can make any number of organizations, so the same cap holds for whoever asks, in
        // their own object. If it refuses or can't answer, the organization's place for this room stays where it is.
        match principal::reserve_repo_request(&self.env, &person, &room, false).await {
            Ok(theirs) if theirs.held => {
                // A test holds this call here, counted against both caps, to change the room before its transaction.
                #[cfg(feature = "failpoints")]
                self.test_hold(&sql, "test_hold_counted").await;
                Ok((true, Some(Counted { person, org })))
            }
            Ok(_) => Err(limit()),
            Err(_) => Err(ApiError::api(503, NOT_COUNTED)),
        }
    }

    /// For a test: waits, if the room has a table of that name, until the test lets go, at the fake's gate for the
    /// number in that table. So a test can change the room between this call's look and its transaction.
    #[cfg(feature = "failpoints")]
    async fn test_hold(&self, sql: &SqlStorage, table: &str) {
        let gate = rows(
            sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            vec![table.into()],
        )
        .ok()
        .filter(|found| !found.is_empty())
        .and_then(|_| rows(sql, &format!("SELECT gate FROM {table}"), vec![]).ok())
        .and_then(|held| held.first().map(|row| int(&row["gate"])));
        if let Some(gate) = gate {
            if let Ok(request) = Request::new(
                &format!("https://github-fake.example.com/hold?repo={gate}"),
                Method::Get,
            ) {
                let _ = Fetch::Request(request).send().await;
            }
        }
    }

    /// When the alarm should next come for a pending request, if there is one: at once, or after the wait a job that
    /// couldn't finish left behind.
    pub(super) fn provisioning_due_at(&self, sql: &SqlStorage, now: i64) -> R<Option<i64>> {
        Ok(request_row(sql)?
            .filter(|r| r["state"].as_str() == Some(RequestState::Pending.name()))
            .map(|r| self.not_before(&r).max(now + 50)))
    }

    /// When the job may next run for this request. The wait is kept in the room, so a restart doesn't forget it. The
    /// copy in memory only stands in when even that couldn't be written.
    fn not_before(&self, request: &Value) -> i64 {
        request["job_not_before"]
            .as_i64()
            .unwrap_or(0)
            .max(self.provision_not_before.get())
    }

    /// The alarm's part: runs the job for a pending request, and makes sure it never stays pending behind an error. If
    /// even ending the request fails, the alarm stays away for longer each time, so a room that can't write doesn't spin.
    pub(super) async fn provision(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? || store::needs_migration(&sql)? {
            return Ok(());
        }
        let Some(request) = request_row(&sql)?
            .filter(|r| r["state"].as_str() == Some(RequestState::Pending.name()))
        else {
            return Ok(());
        };
        if now_ms() < self.not_before(&request) {
            return Ok(());
        }
        let request_id = text(&request["id"]).unwrap_or_default();
        let room = objects::room_id(&sql)?;
        let ended = match self.run_provisioning(&request, &request_id, &room).await {
            Ok(None) => {
                self.provision_not_before.set(0);
                console_log!(
                    "{}",
                    json!({ "at": "provision", "room": room, "request": request_id, "outcome": "ready" })
                );
                return Ok(());
            }
            Ok(Some(ended)) => ended,
            Err(error) => failed(error.code().unwrap_or("internal_error"), 0),
        };
        if ended.gone_wait {
            // A repository this request created didn't show by its ID: the run is given back, and setup reads again in a
            // minute, up to `SETUP_GONE_WAITS` times, counted in `job_failures`. Past that it ends `read_back_failed`.
            let id = request_id.clone();
            let waited = self.in_transaction(move |sql| {
                let now = now_ms();
                let Some(waits) = rows(
                    sql,
                    "SELECT job_failures FROM repo_request WHERE id = ? AND state = ?",
                    vec![id.as_str().into(), RequestState::Pending.name().into()],
                )?
                .first()
                .map(|r| int(&r["job_failures"])) else {
                    return Ok(false);
                };
                if waits >= SETUP_GONE_WAITS {
                    return Ok(false);
                }
                exec(
                    sql,
                    "UPDATE repo_request SET runs = max(runs - 1, 0), job_failures = ?, job_not_before = ?, limited_since = NULL, limited_call = NULL WHERE id = ?",
                    vec![(waits + 1).into(), (now + SETUP_GONE_WAIT_MS).into(), id.as_str().into()],
                )?;
                Ok(true)
            });
            if let Ok(true) = waited {
                self.provision_not_before.set(0);
                console_log!(
                    "{}",
                    json!({ "at": "provision", "room": room, "request": request_id, "outcome": "not_found_yet" })
                );
                return Ok(());
            }
        }
        let mut limited_end: Option<i64> = None;
        let mut reason = ended.reason;
        if let Some(wait_ms) = ended.limited {
            // GitHub limited the rate: the run is given back, and the request waits for the time GitHub gave, for up to a
            // day from its first limit. Then it ends, still without spending the run.
            let id = request_id.clone();
            let primary_403 = ended.primary_403;
            // Which call was limited, by the refusal it would be: the creation token, the creation call, a setup call or
            // the read-back. Only that same call answering a spent limit again counts as a refusal.
            let call = ended.otherwise;
            let decided = self.in_transaction(move |sql| {
                let now = now_ms();
                let Some(row) = rows(
                    sql,
                    "SELECT limited_since, limited_call, job_not_before FROM repo_request WHERE id = ? AND state = ?",
                    vec![id.as_str().into(), RequestState::Pending.name().into()],
                )?
                .into_iter()
                .next() else {
                    return Ok(None);
                };
                let since = row["limited_since"].as_i64();
                // The last limit's wait, if this run follows a limit of this same call: it's over, since the job ran.
                let same_call = row["limited_call"].as_str() == Some(call);
                let held = since
                    .filter(|_| same_call)
                    .and(row["job_not_before"].as_i64());
                if limit_repeated_after_reset(primary_403, held, now) {
                    return Ok(Some(Limited::Refused));
                }
                exec(
                    sql,
                    "UPDATE repo_request SET runs = max(runs - 1, 0) WHERE id = ?",
                    vec![id.as_str().into()],
                )?;
                if !rate_limited_run_waits(since, now) {
                    return Ok(Some(Limited::Ends(now + wait_ms)));
                }
                exec(
                    sql,
                    "UPDATE repo_request SET limited_since = COALESCE(limited_since, ?1), limited_call = ?2, job_not_before = ?3 WHERE id = ?4",
                    vec![now.into(), call.into(), (now + wait_ms).into(), id.as_str().into()],
                )?;
                Ok(Some(Limited::Waits))
            });
            match decided {
                Ok(Some(Limited::Waits)) => {
                    self.provision_not_before.set(0);
                    console_log!(
                        "{}",
                        json!({ "at": "provision", "room": room, "request": request_id, "outcome": "rate_limited", "wait_ms": wait_ms })
                    );
                    return Ok(());
                }
                Ok(Some(Limited::Ends(reset))) => limited_end = Some(reset),
                Ok(Some(Limited::Refused)) => reason = ended.otherwise,
                Ok(None) | Err(_) => {}
            }
        }
        let id = request_id.clone();
        let finished = self.in_transaction(move |sql| {
            finish(sql, &id, ended.state, reason, now_ms())?;
            // A request that ended rate-limited takes a retry once GitHub's last reset has passed, and answers
            // `retry_too_soon` with that time until then. `job_not_before` keeps it too, so even a retry taken right at it
            // never calls GitHub sooner.
            if let Some(reset) = limited_end {
                exec(
                    sql,
                    "UPDATE repo_request SET retry_after = ?1, job_not_before = ?1 WHERE id = ?2",
                    vec![reset.into(), id.as_str().into()],
                )?;
            }
            Ok(rows(
                sql,
                "SELECT state, reason FROM repo_request WHERE id = ?",
                vec![id.as_str().into()],
            )?
            .into_iter()
            .next())
        });
        match finished {
            Ok(now) => {
                self.provision_not_before.set(0);
                // What the request ended as, which is `uncertain` if a creation call's outcome was never recorded.
                let state = now
                    .as_ref()
                    .and_then(|r| text(&r["state"]))
                    .unwrap_or_default();
                let reason = now
                    .as_ref()
                    .and_then(|r| text(&r["reason"]))
                    .unwrap_or_default();
                console_log!(
                    "{}",
                    json!({ "at": "provision", "room": room, "request": request_id, "outcome": state, "reason": reason, "status": ended.status })
                );
                Ok(())
            }
            Err(error) => {
                // The request couldn't be ended, so it's still pending. The wait before the job comes back is written to
                // the room, in a transaction that touches nothing else, so it outlives a restart.
                let id = request_id.clone();
                let stored = self.in_transaction(move |sql| {
                    let failures = rows(
                        sql,
                        "SELECT job_failures FROM repo_request WHERE id = ?",
                        vec![id.as_str().into()],
                    )?
                    .first()
                    .map_or(0, |r| int(&r["job_failures"]))
                        + 1;
                    exec(
                        sql,
                        "UPDATE repo_request SET job_failures = ?, job_not_before = ? WHERE id = ?",
                        vec![
                            failures.into(),
                            (now_ms() + job_backoff_ms(failures.clamp(1, 64) as u32)).into(),
                            id.as_str().into(),
                        ],
                    )
                });
                if stored.is_err() {
                    // Not even that could be written. Until a restart, memory holds the longest wait there is.
                    self.provision_not_before
                        .set(now_ms() + job_backoff_ms(u32::MAX));
                }
                Err(error)
            }
        }
    }

    /// One run, with the provider's tokens revoked on every way out.
    async fn run_provisioning(
        &self,
        request: &Value,
        request_id: &str,
        room: &str,
    ) -> R<Option<Ended>> {
        let sql = self.state.storage().sql();
        if !enabled(&self.env, &sql)? {
            return Ok(Some(failed("managed_repositories_off", 0)));
        }
        // Whoever asked must still be someone this deployment lets ask, before anything goes to the provider: a request
        // recorded under an earlier setting doesn't run under a narrower one.
        let asked_by = text(&request["requested_by"]).unwrap_or_default();
        if !requesters(&self.env, &sql)?.allows(&asked_by) {
            return Ok(Some(failed(REQUESTS_CLOSED, 0)));
        }
        // Test builds only: a room holding this table stands for a deployment whose key the owner hasn't set yet.
        #[cfg(feature = "failpoints")]
        if !rows(
            &sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_no_provisioning_key'",
            vec![],
        )?
        .is_empty()
        {
            return Ok(Some(failed("provisioning_not_configured", 0)));
        }
        let Some(config) = Config::from_env(&self.env) else {
            return Ok(Some(failed("provisioning_not_configured", 0)));
        };
        let provider = GitHubApp::new(config);
        let outcome = self.provision_with(&provider, request, request_id).await;
        let unrevoked = provider.release().await;
        if unrevoked > 0 {
            // Each lives out its hour: the one narrowed to this repository, or the installation's own. IDs and a count
            // only, and nothing here can change how the job ended.
            console_error!(
                "{}",
                json!({ "at": "provision.token_not_revoked", "room": room, "request": request_id, "count": unrevoked })
            );
        }
        outcome
    }

    /// `Ok(None)` means the repository is linked and ready. Every other way out names how the request ends.
    async fn provision_with(
        &self,
        provider: &GitHubApp,
        request: &Value,
        request_id: &str,
    ) -> R<Option<Ended>> {
        let config = provider.config();
        // Authority first, from current state: the delegation, the room and the person who asked.
        match self.org_delegated().await {
            Some(true) => {}
            Some(false) => return Ok(Some(failed("not_delegated", 0))),
            None => return Ok(Some(failed("delegation_unavailable", 0))),
        }
        let attempt = int(&request["attempt"]);
        let name = text(&request["provider_name"]).unwrap_or_default();
        let public = request["visibility"].as_str() == Some(RepoVisibility::Public.name());
        let requester = text(&request["requested_by"]).unwrap_or_default();
        let held = request["provider_repo_id"].as_i64();
        let (id, asker) = (request_id.to_string(), requester.clone());
        // In one transaction: the room and the asker are still what they were, and, if a creation call is about to go
        // out, the attempt is on record before it does. So a job that dies mid-call leaves a row that says a call may
        // have gone out.
        let begun: Option<&'static str> = self.in_transaction(move |sql| {
            // The job holds itself to the limit too. A request can come back here without a retry, when the room
            // couldn't write how the last run ended, and then nothing more goes to the provider.
            let runs = rows(
                sql,
                "SELECT runs FROM repo_request WHERE id = ?",
                vec![id.as_str().into()],
            )?
            .first()
            .map_or(0, |r| int(&r["runs"]));
            if runs >= MAX_SETUP_RUNS {
                return Ok(Some("retry_limit_reached"));
            }
            // This run counts, whatever becomes of it.
            exec(
                sql,
                "UPDATE repo_request SET runs = runs + 1 WHERE id = ?",
                vec![id.as_str().into()],
            )?;
            if room_archived(sql)? {
                return Ok(Some("room_archived"));
            }
            // Whoever asked must still be a person the room records as its owner or an admin.
            if !repositories::still_runs_repository(sql, &asker)? {
                return Ok(Some("requester_lost_authority"));
            }
            if held.is_some() {
                return Ok(None);
            }
            let prior = rows(
                sql,
                "SELECT outcome FROM repo_request_attempt WHERE request_id = ? AND attempt = ?",
                vec![id.as_str().into(), attempt.into()],
            )?;
            if !prior.is_empty() {
                // This attempt's call may already have gone out, and nobody recorded how it ended.
                return Ok(Some("creation_outcome_unknown"));
            }
            exec(
                sql,
                "INSERT INTO repo_request_attempt (request_id, attempt, provider_name, outcome, at) VALUES (?, ?, ?, ?, ?)",
                vec![id.as_str().into(), attempt.into(), name.as_str().into(), STARTED.into(), now_ms().into()],
            )?;
            Ok(None)
        })?;
        if let Some(reason) = begun {
            let state = if reason == "creation_outcome_unknown" {
                RequestState::Uncertain
            } else {
                RequestState::Failed
            };
            return Ok(Some(Ended {
                state,
                ..failed(reason, 0)
            }));
        }

        let repo_id = match held {
            Some(repo_id) => repo_id,
            None => {
                let name = text(&request["provider_name"]).unwrap_or_default();
                let answer = provider.create_repository(&name, public).await;
                let id = request_id.to_string();
                if let CreateAnswer::RateLimited { failure, at_mint } = answer {
                    // A definite refusal for the rate alone: nothing was made, so the record that a call may have gone
                    // out under this attempt's name is taken back, and the next run sends the same name.
                    self.in_transaction(move |sql| {
                        exec(
                            sql,
                            "DELETE FROM repo_request_attempt WHERE request_id = ? AND attempt = ? AND outcome = ?",
                            vec![id.as_str().into(), attempt.into(), STARTED.into()],
                        )
                    })?;
                    let otherwise = if at_mint {
                        "token_refused"
                    } else {
                        "provider_refused"
                    };
                    return Ok(Some(failed_call(otherwise, failure)));
                }
                let (outcome, ended, created) = match answer {
                    // A repository under anyone else isn't ours, whatever its ID is. It isn't held.
                    CreateAnswer::Created(made) if made.owner_id != config.org_id => {
                        ("wrong_owner", Some(failed("wrong_owner", 201)), None)
                    }
                    CreateAnswer::Created(made) => ("created", None, Some(made.repo_id)),
                    CreateAnswer::NameTaken => {
                        ("name_taken", Some(failed("name_taken", 422)), None)
                    }
                    CreateAnswer::Refused(status) => {
                        ("refused", Some(failed("provider_refused", status)), None)
                    }
                    // No token, so no call: the name wasn't sent, and a retry may send it.
                    CreateAnswer::NotSent(status) => {
                        (NOT_SENT, Some(failed("token_refused", status)), None)
                    }
                    CreateAnswer::Unknown | CreateAnswer::RateLimited { .. } => (
                        "uncertain",
                        Some(Ended {
                            state: RequestState::Uncertain,
                            reason: "creation_outcome_unknown",
                            status: 0,
                            limited: None,
                            primary_403: false,
                            otherwise: "creation_outcome_unknown",
                            gone_wait: false,
                        }),
                        None,
                    ),
                };
                self.in_transaction(move |sql| {
                    let now = now_ms();
                    set_attempt(sql, &id, attempt, outcome, now)?;
                    if let Some(repo_id) = created {
                        exec(
                            sql,
                            "UPDATE repo_request SET provider_repo_id = ?, updated_at = ? WHERE id = ? AND state = ?",
                            vec![repo_id.into(), now.into(), id.as_str().into(), RequestState::Pending.name().into()],
                        )?;
                    }
                    Ok(())
                })?;
                match (ended, created) {
                    (Some(ended), _) => return Ok(Some(ended)),
                    (None, Some(repo_id)) => repo_id,
                    (None, None) => return Ok(Some(failed("internal_error", 0))),
                }
            }
        };

        // Setup adds only what's missing, and then everything is read again and judged. Nothing is taken on trust from
        // the calls that made it.
        let expected = Expected {
            repo_id,
            org_id: config.org_id,
            merge_app_id: config.merge_app_id,
            public,
        };
        let (observed, _) = match provider.read_back(repo_id).await {
            Ok(read) => read,
            Err(failure) => return Ok(Some(failed_call("read_back_failed", failure))),
        };
        // A repository this request just created may not show by its ID yet: setup waits and reads again.
        if !observed.present {
            return Ok(Some(gone_at_setup()));
        }
        let steps = match missing_steps(&expected, &observed) {
            Ok(steps) => steps,
            Err(not_ready) => return Ok(Some(failed(not_ready.code(), 0))),
        };
        for step in steps {
            if let Err(failure) = provider.apply(repo_id, step).await {
                return Ok(Some(failed_call("setup_call_failed", failure)));
            }
        }
        let (observed, described) = match provider.read_back(repo_id).await {
            Ok(read) => read,
            Err(failure) => return Ok(Some(failed_call("read_back_failed", failure))),
        };
        if !observed.present {
            return Ok(Some(gone_at_setup()));
        }
        if let Err(not_ready) = verify_ready(&expected, &observed) {
            return Ok(Some(failed(not_ready.code(), 0)));
        }
        // The delegation once more, as late as it can be asked: the organization's object answers outside this room's
        // transaction, so this is the last word before the link is written.
        match self.org_delegated().await {
            Some(true) => {}
            Some(false) => return Ok(Some(failed("not_delegated", 0))),
            None => return Ok(Some(failed("delegation_unavailable", 0))),
        }

        let id = request_id.to_string();
        let org_id = config.org_id;
        let visibility = if public {
            RepoVisibility::Public
        } else {
            RepoVisibility::Private
        };
        let linked: bool = self.in_transaction(move |sql| {
            let now = now_ms();
            // Still this request, still pending, still this repository, and the room hasn't got a link meanwhile.
            let still = rows(
                sql,
                "SELECT 1 AS ok FROM repo_request WHERE id = ? AND state = ? AND provider_repo_id = ?",
                vec![id.as_str().into(), RequestState::Pending.name().into(), repo_id.into()],
            )?;
            if still.is_empty()
                || !rows(sql, "SELECT id FROM repo_link", vec![])?.is_empty()
                || room_archived(sql)?
                || !repositories::still_runs_repository(sql, &requester)?
            {
                return Ok(false);
            }
            let link = format!("rl_{}", uuid::Uuid::new_v4().simple());
            exec(
                sql,
                "INSERT INTO repo_link (id, request_id, provider, provider_repo_id, provider_org_id, full_name, visibility, default_branch, status, created_by, created_at, verified_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)",
                vec![
                    link.as_str().into(), id.as_str().into(), PROVIDER.into(), repo_id.into(), org_id.into(),
                    described.full_name.as_str().into(), visibility.name().into(), described.default_branch.as_str().into(),
                    requester.as_str().into(), now.into(), now.into(), now.into(),
                ],
            )?;
            exec(
                sql,
                "UPDATE repo_request SET state = ?, reason = NULL, job_failures = 0, job_not_before = NULL, limited_since = NULL, limited_call = NULL, updated_at = ? WHERE id = ?",
                vec![RequestState::Ready.name().into(), now.into(), id.as_str().into()],
            )?;
            audit_as(
                sql,
                &requester,
                "person",
                "repository.linked",
                &link,
                None,
                Some(json!({ "provider_repo_id": repo_id }).to_string()),
                now,
            )?;
            record_event(
                sql,
                "repository.ready",
                &requester,
                None,
                &Transition::NONE,
                roles::room_managers(sql, "")?,
                now,
            )?;
            Ok(true)
        })?;
        Ok((!linked).then(|| failed("authority_lost", 0)))
    }
}
