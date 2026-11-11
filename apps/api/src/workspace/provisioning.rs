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
use crate::github::{Config, CreateAnswer, GitHubApp, Provider};
use podster_core::provisioning::{
    job_backoff_ms, missing_steps, reserved_name, retry_allowed, retry_name, retry_wait_ms,
    verify_ready, Expected, RequestLimitReached, MAX_SETUP_RUNS,
};
use podster_core::repositories::{
    decide_retry, valid_repo_name, RepoVisibility, RequestState, RetryPlan, RetryRefusal,
};
use podster_policy::repositories::authorize_repository_admin;

const PROVIDER: &str = "github";
const SWITCH_VAR: &str = "MANAGED_REPOSITORIES";
/// The attempt outcomes that say a creation call may have gone out under the attempt's name.
const NOT_SENT: &str = "not_sent";
const STARTED: &str = "started";

/// Whether managed repositories are switched on for this deployment. Test builds can switch them on for one room, by a
/// table only a test can make, so every other test runs with them off, as every deployment does today.
pub(super) fn enabled(env: &Env, sql: &SqlStorage) -> R<bool> {
    let set = env
        .var(SWITCH_VAR)
        .is_ok_and(|value| value.to_string() == "true");
    #[cfg(feature = "failpoints")]
    if !rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_managed_repositories_on'",
        vec![],
    )?
    .is_empty()
    {
        return Ok(true);
    }
    #[cfg(not(feature = "failpoints"))]
    let _ = sql;
    Ok(set)
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

/// Only a person who is the room's owner or a room admin asks for or retries the room's repository.
pub(super) fn may_request(caller: &Caller) -> R<()> {
    authorize_repository_admin(caller).map_err(repositories::denied)
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
pub(super) fn worth_counting(sql: &SqlStorage, who: &Participant, body: &Value) -> R<bool> {
    may_request(&who.caller)?;
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

/// What a request was counted as, before the command's transaction: for which person, in which organization, and whose
/// counts hold a place for it. Never taken from the request.
#[derive(Clone, Debug)]
pub(super) struct Counted {
    pub(super) person: String,
    pub(super) org: String,
    /// The organization and, once theirs is taken too, the person: whose places to give back.
    pub(super) holders: Vec<String>,
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
/// `counted` is what that same call counted against the daily caps. A request is recorded only if it was counted for
/// exactly the caller this transaction resolved, in the organization the room is in now: someone who came to hold
/// authority, or a room that changed hands, between the count and here records nothing, and asks again.
pub(super) fn request(
    sql: &SqlStorage,
    who: &Participant,
    body: &Value,
    switched_on: bool,
    delegated: bool,
    counted: Option<&Counted>,
    now: i64,
) -> R<Value> {
    may_request(&who.caller)?;
    // Switched off, the route isn't there, for the owner as for anyone.
    if !switched_on {
        return Err(ApiError::not_found());
    }
    let (name, visibility) = requested(body)?;
    if !delegated {
        return refuse(403, "not_delegated");
    }
    if request_row(sql)?.is_some() {
        return refuse(409, "repo_request_exists");
    }
    // Last, and in this transaction: both caps were asked for this caller and this organization, by this very call.
    let org = room_org(sql)?;
    if !counted.is_some_and(|c| {
        c.person == who.caller.id && Some(&c.org) == org.as_ref() && c.holders.len() == 2
    }) {
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
    repositories::read(sql, who)
}

/// `POST repository/retry {}`: puts a failed or uncertain setup back to `pending`. With a repository ID held, setup
/// resumes on that repository. Without one, the next creation call goes out under a name the server made from `suffix`,
/// never a name already sent, so nothing can come to be adopted by its name.
pub(super) fn retry(
    sql: &SqlStorage,
    who: &Participant,
    body: &Value,
    switched_on: bool,
    delegated: bool,
    suffix: &str,
    now: i64,
) -> R<Value> {
    may_request(&who.caller)?;
    if !switched_on {
        return Err(ApiError::not_found());
    }
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
            "UPDATE repo_request SET state = ?, reason = NULL, updated_at = ? WHERE id = ?",
            vec![RequestState::Pending.name().into(), now.into(), id.as_str().into()],
        )?,
        RetryPlan::CreateUnderNewName => exec(
            sql,
            "UPDATE repo_request SET state = ?, reason = NULL, provider_repo_id = NULL, provider_name = ?, attempt = attempt + ?, updated_at = ? WHERE id = ?",
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
    repositories::read(sql, who)
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
        "UPDATE repo_request SET state = ?, reason = ?, retry_after = ?, job_failures = 0, job_not_before = NULL, updated_at = ? WHERE id = ?",
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
}

fn failed(reason: &'static str, status: u16) -> Ended {
    Ended {
        state: RequestState::Failed,
        reason,
        status,
    }
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
    /// delegation and, in that same call, has the request counted against the organization's daily cap; then against the
    /// asker's own. Returns whether the organization holds the delegation, and what was counted, for whom. The command's
    /// transaction records a request only if this call counted it for the caller it resolves and the organization the
    /// room is in then: what this decides, outside the transaction, is only whether to count. A request the room would
    /// refuse anyway, or one for a room that already has its request, is never counted: so a replay, and asking again,
    /// count once. At either cap it's refused here, by name.
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
        if !matches!(worth_counting(&sql, &who, body), Ok(true)) {
            let delegated = self.org_delegated().await == Some(true);
            // A test holds this call here, after it decided not to count, to change the room before its transaction.
            #[cfg(feature = "failpoints")]
            self.test_hold_uncounted(&sql).await;
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
        // An organization that can't answer is one that didn't say yes, as it was before the caps.
        let Ok(said) = principal::reserve_repo_request(&self.env, &org, &room, &person, true).await
        else {
            return Ok((false, None));
        };
        if !said.granted {
            return Ok((false, None));
        }
        if !said.allowed {
            return Err(limit());
        }
        // One person can make any number of organizations, so the same cap holds for whoever asks, in their own object.
        let counted = Counted {
            person: person.clone(),
            org: org.clone(),
            holders: vec![org],
        };
        match principal::reserve_repo_request(&self.env, &person, &room, &person, false).await {
            Ok(theirs) if theirs.allowed => Ok((
                true,
                Some(Counted {
                    holders: vec![counted.org.clone(), person],
                    ..counted
                }),
            )),
            Ok(_) => {
                self.uncount_repository_request(&counted).await;
                Err(limit())
            }
            Err(_) => {
                self.uncount_repository_request(&counted).await;
                Err(ApiError::api(503, NOT_COUNTED))
            }
        }
    }

    /// Gives back the places [`Workspace::count_repository_request`] took for this caller, when their command recorded
    /// no request. Each place is the caller's own claim, so one another caller took for the same room stays.
    pub(super) async fn uncount_repository_request(&self, counted: &Counted) {
        let sql = self.state.storage().sql();
        let Ok(room) = objects::room_id(&sql) else {
            return;
        };
        for holder in &counted.holders {
            if principal::release_repo_request(&self.env, holder, &room, &counted.person)
                .await
                .is_err()
            {
                console_error!(
                    "{}",
                    json!({ "at": "provision.count_not_released", "room": room })
                );
            }
        }
    }

    /// For a test: waits, if the room has `test_hold_uncounted`, until the test lets go, at the fake's gate for the
    /// number in that table. So a test can change the room between this call's look and its transaction.
    #[cfg(feature = "failpoints")]
    async fn test_hold_uncounted(&self, sql: &SqlStorage) {
        let gate = rows(
            sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_hold_uncounted'",
            vec![],
        )
        .ok()
        .filter(|found| !found.is_empty())
        .and_then(|_| rows(sql, "SELECT gate FROM test_hold_uncounted", vec![]).ok())
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
        let id = request_id.clone();
        let finished = self.in_transaction(move |sql| {
            finish(sql, &id, ended.state, ended.reason, now_ms())?;
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
                reason,
                status: 0,
            }));
        }

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
                    // No token, so no call: the name wasn't sent, and a retry may send it.
                    CreateAnswer::NotSent(status) => {
                        (NOT_SENT, Some(failed("token_refused", status)), None)
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
                "UPDATE repo_request SET state = ?, reason = NULL, job_failures = 0, job_not_before = NULL, updated_at = ? WHERE id = ?",
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
