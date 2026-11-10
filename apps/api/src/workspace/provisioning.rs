//! Provisioning the room's managed repository (M5 step 4, ADR 0009, which is proposed).
//!
//! - **Two person commands**, for the room's owner: ask for the repository, and retry a setup that failed or whose
//!   outcome is unknown. Each needs the organization's provisioning delegation as well, which the organization's own
//!   `Principal` holds and a Podster operator gives (AC-10). Each commits its state, audit entry, event and stored answer
//!   in one transaction, and calls nothing outside.
//! - **One job**, run by the room's alarm while a request is `pending`. It rechecks authority, then talks to the provider
//!   through `crate::github::Provider`, and commits each thing it learns in a transaction of its own. The repository is
//!   linked, and the request made `ready`, only after everything readiness needs was read back and judged by
//!   `podster_core::provisioning`. Anything else leaves the request `failed` or `uncertain` with a reason code.
//!
//! The organization, the App and its installation come from the Worker's configuration, never from a caller. A
//! repository is known by the ID in the provider's answer to this room's own creation call, never by a name. Nothing here
//! deletes a repository or falls back to another organization. Logs and events carry IDs, reason codes and HTTP statuses.
use super::*;
use crate::github::{Config, CreateAnswer, GitHubApp, Provider};
use podster_core::provisioning::{missing_steps, retry_name, verify_ready, Expected};
use podster_core::repositories::{
    decide_retry, valid_repo_name, RepoVisibility, RequestState, RetryPlan, RetryRefusal,
};

const PROVIDER: &str = "github";

fn refuse<T>(status: u16, code: &'static str) -> R<T> {
    Err(ApiError::api(status, code))
}

/// Only the room's owner, as a person, asks for or retries the room's repository.
pub(super) fn may_request(sql: &SqlStorage, caller: &Caller) -> R<()> {
    if caller.kind == PrincipalKind::Person && is_owner(sql, &caller.id)? {
        Ok(())
    } else {
        Err(ApiError::not_allowed())
    }
}

fn request_row(sql: &SqlStorage) -> R<Option<Value>> {
    Ok(rows(
        sql,
        "SELECT id, state, name, visibility, attempt, provider_name, provider_repo_id, reason, requested_by FROM repo_request",
        vec![],
    )?
    .into_iter()
    .next())
}

/// Whether a request is waiting for the job.
pub(super) fn due(sql: &SqlStorage) -> R<bool> {
    Ok(request_row(sql)?
        .is_some_and(|request| request["state"].as_str() == Some(RequestState::Pending.name())))
}

/// `POST repository { name, visibility }`: records the room's one request for a repository. `delegated` is what the
/// organization's `Principal` said just before this transaction, and the job asks again before it calls the provider.
pub(super) fn request(
    sql: &SqlStorage,
    who: &Participant,
    body: &Value,
    delegated: bool,
    now: i64,
) -> R<Value> {
    may_request(sql, &who.caller)?;
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
    // On the organization's plan a private repository can't carry the rules, so it's unavailable, never quietly made public.
    if visibility != RepoVisibility::Public {
        return refuse(409, "private_unavailable");
    }
    if !delegated {
        return refuse(403, "not_delegated");
    }
    if request_row(sql)?.is_some() {
        return refuse(409, "repo_request_exists");
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
    repositories::read(sql, who)
}

/// `POST repository/retry {}`: puts a failed or uncertain setup back to `pending`. With a repository ID held, setup
/// resumes on that repository. Without one, the next creation call goes out under a name the server made from `suffix`,
/// never a name already sent, so nothing can come to be adopted by its name.
pub(super) fn retry(
    sql: &SqlStorage,
    who: &Participant,
    body: &Value,
    delegated: bool,
    suffix: &str,
    now: i64,
) -> R<Value> {
    may_request(sql, &who.caller)?;
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
    let sent: Vec<String> = rows(
        sql,
        "SELECT provider_name FROM repo_request_attempt WHERE request_id = ?",
        vec![id.as_str().into()],
    )?
    .iter()
    .filter_map(|attempt| text(&attempt["provider_name"]))
    .collect();
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
            "UPDATE repo_request SET state = ?, reason = NULL, updated_at = ? WHERE id = ?",
            vec![RequestState::Pending.name().into(), now.into(), id.as_str().into()],
        )?,
        RetryPlan::CreateUnderNewName => exec(
            sql,
            "UPDATE repo_request SET state = ?, reason = NULL, provider_repo_id = NULL, provider_name = ?, attempt = attempt + ?, updated_at = ? WHERE id = ?",
            vec![
                RequestState::Pending.name().into(),
                new_name.unwrap_or_default().as_str().into(),
                i64::from(!never_sent).into(),
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
    repositories::read(sql, who)
}

/// Ends the job's turn: the request leaves `pending` with a reason code, and the room's managers are told. Only if it's
/// still the pending request the job started on.
fn finish(
    sql: &SqlStorage,
    request_id: &str,
    state: RequestState,
    reason: &str,
    now: i64,
) -> R<()> {
    let pending = rows(
        sql,
        "SELECT requested_by FROM repo_request WHERE id = ? AND state = ?",
        vec![request_id.into(), RequestState::Pending.name().into()],
    )?;
    let Some(requester) = pending.first().and_then(|r| text(&r["requested_by"])) else {
        return Ok(());
    };
    exec(
        sql,
        "UPDATE repo_request SET state = ?, reason = ?, updated_at = ? WHERE id = ?",
        vec![
            state.name().into(),
            reason.into(),
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
}

fn failed(reason: &'static str, status: u16) -> Ended {
    Ended {
        state: RequestState::Failed,
        reason,
        status,
    }
}

impl Workspace {
    fn in_transaction<T: 'static>(&self, work: impl FnOnce(&SqlStorage) -> R<T> + 'static) -> R<T> {
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
        let org = rows(&sql, "SELECT owner_org_id FROM workspace", vec![])
            .ok()?
            .first()
            .and_then(|room| text(&room["owner_org_id"]))?;
        principal::org_delegation(&self.env, &org, PROVIDER)
            .await
            .ok()
            .map(|held| held["granted"].as_bool() == Some(true))
    }

    /// The alarm's part: runs the job for a pending request, and makes sure it never stays pending behind an error.
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
        let request_id = text(&request["id"]).unwrap_or_default();
        let room = objects::room_id(&sql)?;
        let ended = match self.run_provisioning(&request, &request_id).await {
            Ok(None) => {
                console_log!(
                    "{}",
                    json!({ "at": "provision", "room": room, "request": request_id, "outcome": "ready" })
                );
                return Ok(());
            }
            Ok(Some(ended)) => ended,
            Err(error) => failed(error.code().unwrap_or("internal_error"), 0),
        };
        console_log!(
            "{}",
            json!({ "at": "provision", "room": room, "request": request_id, "outcome": ended.state.name(), "reason": ended.reason, "status": ended.status })
        );
        self.in_transaction(move |sql| {
            finish(sql, &request_id, ended.state, ended.reason, now_ms())
        })
    }

    /// One run. `Ok(None)` means the repository is linked and ready. Every other way out names how the request ends.
    async fn run_provisioning(&self, request: &Value, request_id: &str) -> R<Option<Ended>> {
        // Test builds only: a room holding this table stands for a deployment whose key the owner hasn't set yet.
        #[cfg(feature = "failpoints")]
        if !rows(
            &self.state.storage().sql(),
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_no_provisioning_key'",
            vec![],
        )?
        .is_empty()
        {
            return Ok(Some(failed("provisioning_not_configured", 0)));
        }
        // Authority first, from current state: the configuration, the delegation, the room and the person who asked.
        let Some(config) = Config::from_env(&self.env) else {
            return Ok(Some(failed("provisioning_not_configured", 0)));
        };
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
            if room_archived(sql)? {
                return Ok(Some("room_archived"));
            }
            if !is_owner(sql, &asker)? {
                return Ok(Some("requester_not_owner"));
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
                "INSERT INTO repo_request_attempt (request_id, attempt, provider_name, outcome, at) VALUES (?, ?, ?, 'started', ?)",
                vec![id.as_str().into(), attempt.into(), name.as_str().into(), now_ms().into()],
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
                reason,
                status: 0,
            }));
        }

        let provider = GitHubApp::new(config);
        let config = provider.config();
        let repo_id = match held {
            Some(repo_id) => repo_id,
            None => {
                let name = text(&request["provider_name"]).unwrap_or_default();
                let answer = provider.create_repository(&name, public).await;
                let id = request_id.to_string();
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
                    CreateAnswer::Unknown => (
                        "uncertain",
                        Some(Ended {
                            state: RequestState::Uncertain,
                            reason: "creation_outcome_unknown",
                            status: 0,
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
            Err(failure) => return Ok(Some(failed("read_back_failed", failure.status()))),
        };
        let steps = match missing_steps(&expected, &observed) {
            Ok(steps) => steps,
            Err(not_ready) => return Ok(Some(failed(not_ready.code(), 0))),
        };
        for step in steps {
            if let Err(failure) = provider.apply(repo_id, step).await {
                return Ok(Some(failed("setup_call_failed", failure.status())));
            }
        }
        let (observed, described) = match provider.read_back(repo_id).await {
            Ok(read) => read,
            Err(failure) => return Ok(Some(failed("read_back_failed", failure.status()))),
        };
        if let Err(not_ready) = verify_ready(&expected, &observed) {
            return Ok(Some(failed(not_ready.code(), 0)));
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
                || !is_owner(sql, &requester)?
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
                "UPDATE repo_request SET state = ?, reason = NULL, updated_at = ? WHERE id = ?",
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
